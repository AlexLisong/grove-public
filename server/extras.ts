import {Router} from 'express';
import {z} from 'zod';
import {randomBytes,randomUUID,createHmac,timingSafeEqual,createHash} from 'node:crypto';
import {query,withTransaction} from './core/db.js';
import {requireAuth,requireEditor,requireScope} from './core/auth.js';
import {createEntity,getEntity,listEntities,updateEntity} from './core/entities.js';
import {saveFile} from './core/files.js';
import {enqueue} from './core/jobs.js';
import {httpError,validateRemoteUrl} from './core/security.js';
import {getConnection,connectionCredentials,providerRequest,type StoredConnection} from './integrations.js';
import {runAsActor,currentAccess,entityAccessPredicate} from './core/access.js';
import {quotaLimits,quotaStatus} from './quota.js';

export async function migrateExtras(){
 await query(`
 CREATE TABLE IF NOT EXISTS entity_embeddings(entity_id uuid PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,content_hash text NOT NULL,embedding jsonb NOT NULL);
 CREATE INDEX IF NOT EXISTS embedding_workspace ON entity_embeddings(workspace_id);
 CREATE TABLE IF NOT EXISTS oauth_states(state text PRIMARY KEY,workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,provider text NOT NULL,verifier text NOT NULL,expires_at timestamptz NOT NULL);
 CREATE TABLE IF NOT EXISTS media_grants(token_hash text PRIMARY KEY,workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,expires_at timestamptz NOT NULL);
 CREATE TABLE IF NOT EXISTS short_links(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,slug text UNIQUE NOT NULL,url text NOT NULL,title text NOT NULL DEFAULT '',clicks bigint NOT NULL DEFAULT 0,sends bigint NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS automation_deliveries(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,rule_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,recipient_hash text NOT NULL,event_id text NOT NULL,status text NOT NULL DEFAULT 'pending',receipt jsonb,error text,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(rule_id,event_id));
 CREATE INDEX IF NOT EXISTS automation_recipient ON automation_deliveries(rule_id,recipient_hash,created_at);
 ALTER TABLE automation_deliveries ADD COLUMN IF NOT EXISTS attempted_at timestamptz;
 UPDATE automation_deliveries SET attempted_at=created_at,status=CASE WHEN receipt->>'messageId' IS NOT NULL THEN 'sent' ELSE status END WHERE attempted_at IS NULL AND status IN ('sent','failed');
 CREATE INDEX IF NOT EXISTS automation_attempted ON automation_deliveries(workspace_id,attempted_at) WHERE attempted_at IS NOT NULL;
 CREATE TABLE IF NOT EXISTS billing_accounts(workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,customer_id text UNIQUE,subscription_id text,plan text NOT NULL DEFAULT 'self-hosted',status text NOT NULL DEFAULT 'active',data jsonb NOT NULL DEFAULT '{}');
 CREATE TABLE IF NOT EXISTS billing_events(id text PRIMARY KEY,event_type text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS mcp_clients(id text PRIMARY KEY,name text NOT NULL,redirect_uris jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS mcp_codes(code_hash text PRIMARY KEY,client_id text NOT NULL,redirect_uri text NOT NULL,challenge text NOT NULL,user_id uuid NOT NULL REFERENCES users(id),workspace_id uuid NOT NULL REFERENCES workspaces(id),scopes jsonb NOT NULL,expires_at timestamptz NOT NULL);
 `);
}
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
export function matchAutomation(rule:any,event:any){
 if(rule.enabled===false)return {matched:false,reason:'Rule is paused',actions:[]};
 const trigger=rule.trigger||'comment';
 if(trigger!==event.type)return {matched:false,reason:'Different trigger',actions:[]};
 if(rule.postId&&event.postId!==rule.postId)return {matched:false,reason:'Different post',actions:[]};
 const keywords=Array.isArray(rule.keywords)?rule.keywords:String(rule.keyword||'').split(',').filter(Boolean);
 const text=String(event.text||'').toLocaleLowerCase();
 const matched=keywords.length?keywords.some((k:any)=>{const needle=String(k).trim().toLocaleLowerCase();return needle&&text.includes(needle);}):Boolean(rule.matchAny);
 const actions=matched?[{type:'private-reply',text:rule.message||'',linkId:rule.linkId},...(rule.publicReply?[{type:'public-reply',text:rule.publicReply}]:[])]:[];
 return {matched,reason:matched?'Trigger and keyword match':'No matching keyword',actions};
}
function signatureValid(raw:Buffer,signature:string,secret:string,prefix='sha256='){
 const expected=prefix+createHmac('sha256',secret).update(raw).digest('hex');return signature.length===expected.length&&timingSafeEqual(Buffer.from(signature),Buffer.from(expected));
}
export async function processInstagramEvent(body:any){
 const cs=await query<StoredConnection>("SELECT * FROM connections WHERE provider='instagram' AND status='connected'");let queued=0;
 for(const entry of body.entry||[]){
  const connection=cs.find(c=>connectionCredentials(c).accountId===String(entry.id));if(!connection)continue;
  const changes=[...(entry.changes||[]).filter((c:any)=>c.field==='comments').map((c:any)=>({type:'comment',text:c.value.text,recipientId:c.value.from?.id,eventId:c.value.id,commentId:c.value.id,postId:c.value.media?.id})),...(entry.messaging||[]).map((m:any)=>({type:m.message?.reply_to?.story?'story-reply':'dm',text:m.message?.text||m.reaction?.emoji,recipientId:m.sender?.id,eventId:m.message?.mid||`${m.sender?.id}:${m.timestamp}`,postId:m.message?.reply_to?.mid}))];
  const candidates=await query<{id:string;created_by:string|null}>("SELECT id,created_by FROM entities WHERE workspace_id=$1 AND kind='automation' AND deleted_at IS NULL AND data->>'enabled'='true' AND data->>'connectionId'=$2",[connection.workspace_id,connection.id]);
  const rules=[];
  for(const candidate of candidates) {
   if(!candidate.created_by)continue;
   try {const rule=await runAsActor(connection.workspace_id,candidate.created_by,async()=>currentAccess()!.role==='viewer' ? null:await getEntity(connection.workspace_id,candidate.id));if(rule)rules.push(rule);}
   catch(error:any) {if(error.status!==403)throw error;}
  }
  for(const event of changes){if(!event.recipientId||!event.eventId)continue;
   for(const rule of rules){if(!matchAutomation(rule.data,event).matched)continue;
    const recipientHash=sha(event.recipientId),cutoff=new Date(Date.now()-7*86400000);
    const reserved=await withTransaction(async client=>{
     await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`${rule.id}:${recipientHash}`]);
     const {rows}=await client.query('SELECT id FROM automation_deliveries WHERE rule_id=$1 AND recipient_hash=$2 AND created_at>$3',[rule.id,recipientHash,cutoff]);if(rows.length)return null;
     const {rows:[row]}=await client.query('INSERT INTO automation_deliveries(workspace_id,rule_id,recipient_hash,event_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id',[connection.workspace_id,rule.id,recipientHash,event.eventId]);return row;
    });
    if(reserved&&rule.createdBy){await runAsActor(connection.workspace_id,rule.createdBy,()=>enqueue(connection.workspace_id,'automation-deliver',{ruleId:rule.id,connectionId:connection.id,deliveryId:reserved.id,event},new Date(Date.now()+Math.max(0,Math.min(3600,Number(rule.data.delaySeconds)||0))*1000),`dm:${reserved.id}`));queued++;}
   }
  }
 }
 return {queued};
}
function dmLimit(name:string,fallback:number){
 const limit=Number(process.env[name]??fallback);
 if(!Number.isSafeInteger(limit)||limit<0)throw new Error(`${name} must be a nonnegative integer.`);
 return limit;
}
async function reserveAutomationSend(workspaceId:string,deliveryId:string,ruleId:string){
 const hourlyLimit=dmLimit('DM_HOURLY_LIMIT',50),dailyLimit=dmLimit('DM_DAILY_LIMIT',200);
 return withTransaction(async client=>{
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',['grove-dm-rate',workspaceId]);
  const {rows:[delivery]}=await client.query('SELECT * FROM automation_deliveries WHERE id=$1 AND workspace_id=$2 AND rule_id=$3 FOR UPDATE',[deliveryId,workspaceId,ruleId]);
  if(!delivery)throw httpError(404,'Automation delivery not found');
  if(delivery.receipt?.messageId)return delivery.receipt;
  if(delivery.attempted_at)throw httpError(409,'This delivery was already attempted. Verify its provider outcome before creating another attempt.','DELIVERY_ALREADY_ATTEMPTED');
  // The timestamp is a durable reservation. A crash or uncertain response
  // remains counted for both rolling windows, even if no receipt was saved.
  const {rows:[counts]}=await client.query("SELECT count(*) FILTER(WHERE attempted_at>now()-interval '1 hour') AS hourly,count(*) AS daily FROM automation_deliveries WHERE workspace_id=$1 AND attempted_at>now()-interval '1 day'",[workspaceId]);
  if(Number(counts.hourly)>=hourlyLimit||Number(counts.daily)>=dailyLimit)throw httpError(429,'Automation sending limit reached. Completed and uncertain attempts count toward the rolling hourly and daily allowance.','DM_RATE_LIMIT');
  await client.query("UPDATE automation_deliveries SET status='sending',attempted_at=now(),error=NULL WHERE id=$1 AND workspace_id=$2",[deliveryId,workspaceId]);
  return null;
 });
}
export async function deliverAutomation(workspaceId:string,data:any,request:typeof providerRequest=providerRequest){
 const rule=await getEntity(workspaceId,data.ruleId);if(!rule||!rule.data.enabled)return {cancelled:true};
 const conn=await getConnection(workspaceId,data.connectionId),c=connectionCredentials(conn);if(conn.provider!=='instagram')throw httpError(400,'This automation requires Instagram');
 const event=data.event;let text=String(rule.data.message||'');
 if(rule.data.linkId){const [link]=await query<any>('SELECT * FROM short_links WHERE id=$1 AND workspace_id=$2',[rule.data.linkId,workspaceId]);if(link)text+=`\n${process.env.APP_URL}/r/${link.slug}`;}
 if(!text)throw httpError(400,'Automation message is empty');
 const previous=await reserveAutomationSend(workspaceId,data.deliveryId,rule.id);if(previous)return previous;
 let confirmed:any;
 try{
  const receipt=await request(`https://graph.facebook.com/${process.env.META_GRAPH_VERSION||'v23.0'}/${encodeURIComponent(c.accountId)}/messages`,{token:c.accessToken,method:'POST',body:{recipient:event.type==='comment'?{comment_id:event.commentId}:{id:event.recipientId},message:{text}}});
  if(!receipt.message_id)throw httpError(502,'Instagram did not confirm the message');
  confirmed={messageId:String(receipt.message_id),...(rule.data.publicReply&&event.commentId?{publicReply:{status:'pending'}}:{})};
 }catch(error){await query("UPDATE automation_deliveries SET status='uncertain',error=$3 WHERE id=$1 AND workspace_id=$2 AND status='sending'",[data.deliveryId,workspaceId,(error as Error).message]);throw error;}
 // Commit the private-message receipt and successful-send counter before any
 // public follow-up. Its failure must never turn a confirmed DM into a failure.
 await withTransaction(async client=>{
  const {rows}=await client.query("UPDATE automation_deliveries SET status='sent',receipt=$3,error=NULL WHERE id=$1 AND workspace_id=$2 AND receipt->>'messageId' IS NULL RETURNING id",[data.deliveryId,workspaceId,JSON.stringify(confirmed)]);
  if(rows.length&&rule.data.linkId)await client.query('UPDATE short_links SET sends=sends+1 WHERE id=$1 AND workspace_id=$2',[rule.data.linkId,workspaceId]);
 });
 if(rule.data.publicReply&&event.commentId){
  await query("UPDATE automation_deliveries SET receipt=jsonb_set(receipt,'{publicReply}','{\"status\":\"sending\"}'::jsonb) WHERE id=$1 AND workspace_id=$2",[data.deliveryId,workspaceId]);
  let publicReply:any;
  try{
   const result=await request(`https://graph.facebook.com/${process.env.META_GRAPH_VERSION||'v23.0'}/${encodeURIComponent(event.commentId)}/replies`,{token:c.accessToken,method:'POST',body:{message:rule.data.publicReply}});
   if(!result.id)throw httpError(502,'Instagram did not confirm the public reply');
   publicReply={status:'sent',id:String(result.id)};
  }catch(error){publicReply={status:'uncertain',error:(error as Error).message};}
  await query("UPDATE automation_deliveries SET receipt=jsonb_set(receipt,'{publicReply}',$3::jsonb),error=$4 WHERE id=$1 AND workspace_id=$2",[data.deliveryId,workspaceId,JSON.stringify(publicReply),publicReply.error?`Private message sent; public reply needs inspection: ${publicReply.error}`:null]);
  confirmed.publicReply=publicReply;
 }
 return confirmed;
}
export async function sendDigest(workspaceId:string,connectionId:string,text:string){const conn=await getConnection(workspaceId,connectionId);if(conn.provider!=='telegram')throw httpError(400,'Choose a Telegram delivery connection');const c=connectionCredentials(conn);return providerRequest(`https://api.telegram.org/bot${c.botToken}/sendMessage`,{method:'POST',body:{chat_id:c.chatId,text:text.slice(0,4000),disable_web_page_preview:true}});}

export const extrasRouter=Router();
extrasRouter.post('/notifications/:id/read',requireAuth,requireScope('workspace:read'),async(req,res)=>{
 z.object({}).strict().parse(req.body||{});
 const id=z.uuid().parse(req.params.id),entity=await getEntity(req.auth.workspaceId,id);
 if(!entity||entity.kind!=='notification')throw httpError(404,'Notification not found');
 const access=entityAccessPredicate('e',3);
 const rows=await query(`UPDATE entities e SET data=jsonb_set(data,'{read}','true'::jsonb),version=version+1,updated_at=now() WHERE workspace_id=$1 AND id=$2 AND kind='notification' AND deleted_at IS NULL AND ${access.sql} RETURNING id`,[req.auth.workspaceId,id,...access.params]);
 if(!rows.length)throw httpError(404,'Notification not found');
 res.json({entity:await getEntity(req.auth.workspaceId,id)});
});
extrasRouter.get('/usage',requireAuth,requireScope('workspace:read'),async(req,res)=>{
 const events=await query<any>('SELECT id,action,model,input_tokens AS "inputTokens",output_tokens AS "outputTokens",quota_kind AS "quotaKind",usage_estimated AS "usageEstimated",created_at AS "createdAt" FROM usage_events WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 200',[req.auth.workspaceId]);
 const quotas=await quotaStatus(req.auth.workspaceId);
 res.json({events,totalInputTokens:events.reduce((s,e)=>s+Number(e.inputTokens),0),totalOutputTokens:events.reduce((s,e)=>s+Number(e.outputTokens),0),dailyTokenLimit:quotas.tokens.limit,quotas,note:'Text and embedding tokens use provider usage, with conservative estimates if usage is missing. Image generation and transcription have separate daily request caps. Limits include in-progress requests; uncertain provider responses remain reserved for 24 hours. Totals below cover the latest 200 events; quotas cover the rolling 24-hour window.'});
});
extrasRouter.get('/links',requireAuth,requireScope('workspace:read'),async(req,res)=>res.json({links:await query<any>('SELECT id,slug,url,title,clicks,sends,created_at AS "createdAt" FROM short_links WHERE workspace_id=$1 ORDER BY created_at DESC',[req.auth.workspaceId])}));
extrasRouter.post('/links',requireAuth,requireEditor,requireScope('workspace:write'),async(req,res)=>{const b=z.object({url:z.url().max(2000),title:z.string().max(200).default(''),slug:z.string().regex(/^[a-zA-Z0-9_-]{4,60}$/).optional()}).parse(req.body);await validateRemoteUrl(b.url);const [link]=await query<any>('INSERT INTO short_links(workspace_id,slug,url,title) VALUES($1,$2,$3,$4) RETURNING *',[req.auth.workspaceId,b.slug||randomBytes(6).toString('base64url'),b.url,b.title]);res.status(201).json({link:{...link,shortUrl:`${process.env.APP_URL}/r/${link.slug}`}});});
extrasRouter.patch('/links/:id',requireAuth,requireEditor,requireScope('workspace:write'),async(req,res)=>{const b=z.object({url:z.url().max(2000),title:z.string().max(200).default('')}).parse(req.body);await validateRemoteUrl(b.url);const [link]=await query('UPDATE short_links SET url=$3,title=$4 WHERE id=$1 AND workspace_id=$2 RETURNING *',[z.uuid().parse(req.params.id),req.auth.workspaceId,b.url,b.title]);if(!link)throw httpError(404,'Link not found');res.json({link});});
extrasRouter.delete('/links/:id',requireAuth,requireEditor,requireScope('workspace:write'),async(req,res)=>{await query('DELETE FROM short_links WHERE id=$1 AND workspace_id=$2',[z.uuid().parse(req.params.id),req.auth.workspaceId]);res.json({ok:true});});
extrasRouter.post('/automations/:id/test',requireAuth,requireEditor,requireScope('workspace:write'),async(req,res)=>{const entity=await getEntity(req.auth.workspaceId,z.uuid().parse(req.params.id));if(!entity||entity.kind!=='automation')throw httpError(404,'Automation not found');const b=z.object({event:z.object({type:z.string(),text:z.string().max(5000),postId:z.string().optional()})}).parse(req.body);res.json({...matchAutomation({...entity.data,enabled:true},b.event),simulation:true,sent:false});});
extrasRouter.get('/automations/:id/deliveries',requireAuth,requireScope('workspace:read'),async(req,res)=>{const id=z.uuid().parse(req.params.id),rule=await getEntity(req.auth.workspaceId,id);if(!rule||rule.kind!=='automation')throw httpError(404,'Automation not found');res.json({deliveries:await query('SELECT id,event_id AS "eventId",status,error,receipt,attempted_at AS "attemptedAt",created_at AS "createdAt" FROM automation_deliveries WHERE workspace_id=$1 AND rule_id=$2 ORDER BY created_at DESC LIMIT 100',[req.auth.workspaceId,id])});});
extrasRouter.get('/webhooks/instagram',(req,res)=>{if(process.env.INSTAGRAM_VERIFY_TOKEN&&req.query['hub.verify_token']===process.env.INSTAGRAM_VERIFY_TOKEN)res.type('text/plain').send(String(req.query['hub.challenge']||''));else res.status(403).json({error:'Webhook verification failed'});});
extrasRouter.post('/webhooks/instagram',async(req,res)=>{if(!process.env.INSTAGRAM_APP_SECRET||!signatureValid((req as any).rawBody||Buffer.alloc(0),req.get('x-hub-signature-256')||'',process.env.INSTAGRAM_APP_SECRET))throw httpError(403,'Invalid webhook signature');res.json(await processInstagramEvent(req.body));});

const esc=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]!));
export function postImageSvg(input:{text:string;name:string;handle:string;background:string}){
 const lines:string[]=[];for(const p of input.text.split('\n')){const words=p.split(' ');let line='';for(const word of words){if((line+' '+word).length>42){lines.push(line);line=word;}else line+=(line?' ':'')+word;}lines.push(line);}
 const height=Math.max(630,260+Math.min(lines.length,22)*42),bg=/^#[0-9a-f]{6}$/i.test(input.background)?input.background:'#171b19';
 return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="${height}" viewBox="0 0 1080 ${height}"><rect width="1080" height="${height}" fill="${bg}"/><circle cx="100" cy="104" r="34" fill="#b9e6c5"/><text x="100" y="116" fill="#173721" font-family="Arial,sans-serif" font-size="32" text-anchor="middle">${esc(input.name.slice(0,1).toUpperCase())}</text><text x="160" y="98" fill="#f4f7f4" font-family="Arial,sans-serif" font-size="30" font-weight="700">${esc(input.name)}</text><text x="160" y="138" fill="#a7b0a9" font-family="Arial,sans-serif" font-size="24">${esc(input.handle)}</text>${lines.slice(0,22).map((line,i)=>`<text x="70" y="${230+i*42}" fill="#f4f7f4" font-family="Arial,sans-serif" font-size="32">${esc(line)}</text>`).join('')}<text x="70" y="${height-50}" fill="#8da193" font-family="Arial,sans-serif" font-size="20">Created with Grove</text></svg>`;
}
extrasRouter.post('/tools/post-image',requireAuth,requireEditor,requireScope('workspace:write'),async(req,res)=>{const b=z.object({text:z.string().min(1).max(1200),name:z.string().max(80).default('Your name'),handle:z.string().max(80).default(''),background:z.string().default('#171b19')}).parse(req.body);res.json({svg:postImageSvg(b),mime:'image/svg+xml'});});
extrasRouter.get('/billing/status',requireAuth,requireScope('workspace:read'),async(req,res)=>{const [account]=await query<any>('SELECT plan,status,data FROM billing_accounts WHERE workspace_id=$1',[req.auth.workspaceId]);const limits=quotaLimits();res.json({configured:Boolean(process.env.STRIPE_BILLING_KEY),plan:account?.plan||'self-hosted',status:account?.status||'active',dailyTokenLimit:limits.tokens,storageLimitMb:limits.storage/(1024*1024),dailyImageLimit:limits.image,dailyTranscriptionLimit:limits.transcription,message:'Grove is deployed as your private application. Azure and provider usage are billed to your connected cloud accounts.',plans:process.env.STRIPE_PRICE_ID?[{id:'pro',name:'Grove Pro',priceId:process.env.STRIPE_PRICE_ID}]:[]});});
extrasRouter.post('/billing/checkout',requireAuth,requireEditor,requireScope('workspace:write'),async(req,res)=>{
 if(req.auth.role!=='owner')throw httpError(403,'Only the workspace owner can manage billing');if(!process.env.STRIPE_BILLING_KEY||!process.env.STRIPE_PRICE_ID)throw httpError(503,'Configure Stripe billing credentials and a price before enabling subscriptions');
 const form=new URLSearchParams({mode:'subscription','line_items[0][price]':process.env.STRIPE_PRICE_ID,'line_items[0][quantity]':'1',success_url:`${process.env.APP_URL}/settings?checkout=success`,cancel_url:`${process.env.APP_URL}/settings?checkout=cancelled`,'metadata[workspaceId]':req.auth.workspaceId,'subscription_data[metadata][workspaceId]':req.auth.workspaceId,client_reference_id:req.auth.workspaceId});
 const session=await providerRequest('https://api.stripe.com/v1/checkout/sessions',{token:process.env.STRIPE_BILLING_KEY,method:'POST',rawBody:form,headers:{'Content-Type':'application/x-www-form-urlencoded'}});res.json({url:session.url});
});
extrasRouter.post('/billing/portal',requireAuth,requireEditor,requireScope('workspace:write'),async(req,res)=>{if(req.auth.role!=='owner')throw httpError(403,'Only the workspace owner can manage billing');const [account]=await query<any>('SELECT customer_id FROM billing_accounts WHERE workspace_id=$1',[req.auth.workspaceId]);if(!account?.customer_id||!process.env.STRIPE_BILLING_KEY)throw httpError(400,'No Stripe subscription is connected');const session=await providerRequest('https://api.stripe.com/v1/billing_portal/sessions',{token:process.env.STRIPE_BILLING_KEY,method:'POST',rawBody:new URLSearchParams({customer:account.customer_id,return_url:`${process.env.APP_URL}/settings`}),headers:{'Content-Type':'application/x-www-form-urlencoded'}});res.json({url:session.url});});
extrasRouter.post('/webhooks/stripe',async(req,res)=>{
 const secret=process.env.STRIPE_WEBHOOK_SECRET,header=req.get('stripe-signature')||'',parts=Object.fromEntries(header.split(',').map(p=>p.split('='))),raw=(req as any).rawBody||Buffer.alloc(0);
 if(!secret||!parts.t||!parts.v1||Math.abs(Date.now()/1000-Number(parts.t))>300)throw httpError(403,'Invalid Stripe signature');
 const expected=createHmac('sha256',secret).update(`${parts.t}.${raw.toString()}`).digest('hex');if(expected.length!==parts.v1.length||!timingSafeEqual(Buffer.from(expected),Buffer.from(parts.v1)))throw httpError(403,'Invalid Stripe signature');
 const event=req.body;
 await withTransaction(async client=>{const {rows}=await client.query('INSERT INTO billing_events(id,event_type) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING id',[event.id,event.type]);if(!rows.length)return;const obj=event.data.object,wid=obj.metadata?.workspaceId||obj.client_reference_id;if(!wid)return;
  if(event.type==='checkout.session.completed')await client.query("INSERT INTO billing_accounts(workspace_id,customer_id,subscription_id,plan,status) VALUES($1,$2,$3,'pro','active') ON CONFLICT(workspace_id) DO UPDATE SET customer_id=$2,subscription_id=$3,plan='pro',status='active'",[wid,obj.customer,obj.subscription]);
  if(event.type.startsWith('customer.subscription.'))await client.query('UPDATE billing_accounts SET status=$2,plan=$3 WHERE workspace_id=$1',[wid,obj.status,obj.status==='active'?'pro':'self-hosted']);
 });res.json({received:true});
});

export const extrasPublicRouter=Router();
extrasPublicRouter.get('/r/:slug',async(req,res)=>{const [link]=await query<any>('UPDATE short_links SET clicks=clicks+1 WHERE slug=$1 RETURNING url',[String(req.params.slug)]);if(!link)throw httpError(404,'Link not found');res.setHeader('Referrer-Policy','no-referrer');res.redirect(302,link.url);});
