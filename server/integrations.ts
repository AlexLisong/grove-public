import {Router} from 'express';
import {z} from 'zod';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {requireAuth,requireEditor,requireScope,assertAccess} from './core/auth.js';
import {query} from './core/db.js';
import {createEntity,listEntities,getEntity,updateEntity} from './core/entities.js';
import {safeFetch,encryptSecret,decryptSecret,httpError} from './core/security.js';
import {connectors} from './catalog.js';
import {currentAccess,runAsActor} from './core/access.js';
import {parseSafeXml} from './core/archives.js';
import type {Connection,Entity} from '../shared/types.js';

export type Credentials=Record<string,string>;
export interface StoredConnection {id:string;workspace_id:string;provider:string;label:string;credentials:string;data:any;status:string;updated_at:string}
export async function providerRequest(url:string,options:{token?:string;method?:string;body?:unknown;headers?:Record<string,string>;rawBody?:BodyInit}={}){
 const headers:Record<string,string>={Accept:'application/json',...options.headers};
 if(options.token)headers.Authorization=`Bearer ${options.token}`;
 if(options.body)headers['Content-Type']='application/json';
 const response=await safeFetch(url,{method:options.method||'GET',headers,body:options.rawBody|| (options.body?JSON.stringify(options.body):undefined)});
 const raw=await response.text();
 let result:any;try{result=JSON.parse(raw);}catch{result={text:raw.slice(0,10000)};}
 if(!response.ok){
  // Provider bodies may echo credentials: do not persist or emit raw messages.
  const code=typeof result.error?.code==='string'?result.error.code:typeof result.code==='string'?result.code:String(response.status);
  throw httpError(response.status===401||response.status===403?424:502,`Provider request failed (${response.status}, ${code.slice(0,60)}). Check account permissions and reconnect.`, 'PROVIDER_REQUEST_FAILED');
 }
 return result;
}
export function publicConnection(c:StoredConnection):Connection{
 const definition=connectors.find(d=>d.id===c.provider);
 return {id:c.id,provider:c.provider,label:c.label,status:c.status as any,capabilities:definition?.capabilities||[],configured:c.status==='connected',lastSyncAt:c.data?.lastSyncAt,error:c.data?.error,data:{profile:c.data?.profile,config:redactConfig(c.data?.config),toolCount:c.data?.tools?.length}};
}
function redactConfig(value:any,depth=0):any {
 if(depth>12) return null;
 if(Array.isArray(value))return value.slice(0,1000).map(item=>redactConfig(item,depth+1));
 if(value && typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!/password|secret|token|credential|api.?key|authorization/i.test(key)).map(([key,item])=>[key,redactConfig(item,depth+1)]));
 return value;
}
export async function getConnection(workspaceId:string,id:string){const [c]=await query<StoredConnection>('SELECT * FROM connections WHERE id=$1 AND workspace_id=$2',[id,workspaceId]);if(!c)throw httpError(404,'Connection not found');return c;}
export function connectionCredentials(c:StoredConnection):Credentials{return JSON.parse(decryptSecret(c.credentials));}
const graph=()=>`https://graph.facebook.com/${process.env.META_GRAPH_VERSION||'v23.0'}`;
const token=(c:Credentials)=>c.accessToken||c.apiKey;

export async function verifyConnection(provider:string,c:Credentials):Promise<any>{
 switch(provider){
  case 'x':return providerRequest('https://api.x.com/2/users/me?user.fields=name,username,public_metrics',{token:token(c)});
  case 'linkedin':return providerRequest('https://api.linkedin.com/v2/userinfo',{token:token(c)});
  case 'threads':return providerRequest('https://graph.threads.net/v1.0/me?fields=id,username',{token:token(c)});
  case 'facebook':case 'instagram':return providerRequest(`${graph()}/${encodeURIComponent(c.accountId||'me')}?fields=id,name`,{token:token(c)});
  case 'youtube':return providerRequest('https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true',{token:token(c)});
  case 'youtube-data':return providerRequest(`https://www.googleapis.com/youtube/v3/videos?part=id&chart=mostPopular&maxResults=1&key=${encodeURIComponent(c.apiKey)}`);
  case 'tiktok':return providerRequest('https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url',{token:token(c)});
  case 'meta-ad-library':return providerRequest(`${graph()}/me?fields=id,name`,{token:token(c)});
  case 'notion':return providerRequest('https://api.notion.com/v1/users/me',{token:c.apiKey,headers:{'Notion-Version':'2025-09-03'}});
  case 'stripe':return providerRequest('https://api.stripe.com/v1/account',{token:c.apiKey});
  case 'kit':return providerRequest('https://api.kit.com/v4/account',{headers:{'X-Kit-Api-Key':c.apiKey}});
  case 'beehiiv':return providerRequest('https://api.beehiiv.com/v2/publications',{token:c.apiKey});
  case 'klaviyo':return providerRequest('https://a.klaviyo.com/api/accounts/',{headers:{Authorization:`Klaviyo-API-Key ${c.apiKey}`,revision:'2025-07-15'}});
  case 'whop':return providerRequest('https://api.whop.com/api/v5/me',{token:c.apiKey});
  case 'kajabi':return providerRequest('https://api.kajabi.com/v1/sites',{token:c.apiKey});
  case 'webflow':return providerRequest('https://api.webflow.com/v2/sites',{token:c.apiKey});
  case 'circle':return providerRequest('https://app.circle.so/api/admin/v2/community_members?per_page=1',{token:c.apiKey});
  case 'readwise':return providerRequest('https://readwise.io/api/v2/auth/',{headers:{Authorization:`Token ${c.apiKey}`}});
  case 'telegram':return providerRequest(`https://api.telegram.org/bot${c.botToken}/getMe`);
  case 'rss':{const r=await safeFetch(c.url);const t=await r.text();const parsed=parseSafeXml(t);if(!parsed.rss&&!parsed.feed)throw httpError(400,'The URL is not an RSS or Atom feed');return {name:parsed.rss?.channel?.title||parsed.feed?.title,url:c.url};}
  case 'substack':{const u=new URL(c.publicationUrl);if(u.protocol!=='https:')throw httpError(400,'Use an HTTPS publication URL');return {publicationUrl:u.origin,mode:'browser-handoff'};}
  case 'mcp':return (await import('./remote-mcp.js')).inspectRemote(c);
  default:throw httpError(400,'This provider supports import rather than a direct connection');
 }
}
function profileSummary(profile:any){
 const data=profile?.data||profile?.items?.[0]||profile;
 return {id:String(data?.id||data?.user?.open_id||''),name:String(data?.name||data?.username||data?.user?.display_name||data?.snippet?.title||data?.business_profile?.name||data?.name||'Connected account').slice(0,150)};
}
export async function saveConnection(workspaceId:string,provider:string,label:string,credentials:Credentials,config:any={}){
 const actor=currentAccess();if(!actor || actor.workspaceId!==workspaceId || !['owner','admin'].includes(actor.role))throw httpError(403,'A current workspace administrator must authorize this connection.');
 const def=connectors.find(d=>d.id===provider);if(!def)throw httpError(404,'Unknown provider');
 const profile=await verifyConnection(provider,credentials);
 const id=randomUUID(),data={profile:profileSummary(profile),config,createdBy:currentAccess()?.userId};
 await query('INSERT INTO connections(id,workspace_id,provider,label,credentials,data,status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,now(),now())',[id,workspaceId,provider,label||def.name,encryptSecret(JSON.stringify(credentials)),JSON.stringify(data),def.auth==='browser'?'unconfigured':'connected']);
 return publicConnection(await getConnection(workspaceId,id));
}

export function metricKey(platform:string,type?:string){return ['youtube','tiktok'].includes(platform)||(platform==='instagram'&&['reel','video','reels'].includes(type||''))?'views':'likes';}
export function median(values:number[]){const sorted=[...values].sort((a,b)=>a-b);return sorted.length?sorted.length%2?sorted[(sorted.length-1)/2]:(sorted[sorted.length/2-1]+sorted[sorted.length/2])/2:null;}
export function rankOutliers(posts:any[]){
 return posts.map(post=>{
  const key=metricKey(post.platform,post.contentType),created=Date.parse(post.publishedAt||'');
  const peers=posts.filter(p=>p!==post&&p.platform===post.platform&&p.creator===post.creator&&(post.platform!=='instagram'||p.contentType===post.contentType)&&typeof p.metrics?.[key]==='number'&&(!Number.isFinite(created)||Date.parse(p.publishedAt||'')<created)).sort((a,b)=>Date.parse(b.publishedAt)-Date.parse(a.publishedAt)).slice(0,20);
  const baseline=peers.length>=5?median(peers.map(p=>p.metrics[key])):null;
  const value=post.metrics?.[key];
  return {...post,outlier:baseline&&typeof value==='number'?Math.round(value/baseline*100)/100:null,baseline:baseline===null?null:{metric:key,median:baseline,sample:peers.length,window:'up to 20 earlier imported posts of matching platform and format'}};
 });
}
const researchSchema=z.object({externalId:z.string().max(200).optional(),title:z.string().max(500),content:z.string().max(60000).default(''),url:z.url().max(2000),platform:z.enum(['x','linkedin','threads','instagram','facebook','youtube','tiktok','substack','meta']),creator:z.string().max(200),contentType:z.string().max(60).default('post'),publishedAt:z.iso.datetime().optional(),followers:z.number().nonnegative().optional(),metrics:z.record(z.string(),z.number().nonnegative()).default({}),provenance:z.string().max(300).default('User-provided export'),isAd:z.boolean().default(false),startedAt:z.string().max(80).optional(),endedAt:z.string().max(80).optional(),brand:z.string().max(200).optional(),cta:z.string().max(500).optional()});
export async function importResearch(workspaceId:string,posts:z.infer<typeof researchSchema>[]){
 const existing=(await listEntities(workspaceId,{kind:'item'})).filter(e=>['social','ad'].includes(e.data.type));
 const all=[...existing.map(e=>({...e.data,title:e.title,content:e.content})),...posts];
 const ranked=rankOutliers(all),entities:Entity[]=[];
 for(const post of ranked.slice(existing.length)){
  const previous=existing.find(e=>e.data.url===post.url);
  if(previous){entities.push(await updateEntity(workspaceId,previous.id,{title:post.title,content:post.content,data:{...previous.data,...post,type:post.isAd?'ad':'social',lastSyncAt:new Date().toISOString()}}));}
  else entities.push(await createEntity(workspaceId,{kind:'item',title:post.title,content:post.content,tags:[post.platform,post.isAd?'ad-research':'research'],data:{...post,type:post.isAd?'ad':'social',lastSyncAt:new Date().toISOString()}}));
 }
 // Recompute existing baselines after a backfill too.
 for(let i=0;i<existing.length;i++)if(!posts.some(p=>p.url===existing[i].data.url))await updateEntity(workspaceId,existing[i].id,{data:{...existing[i].data,outlier:ranked[i].outlier,baseline:ranked[i].baseline}});
 return entities;
}
async function youtubeSearch(workspaceId:string,c:Credentials,search:string){
 const suffix=c.apiKey?`&key=${encodeURIComponent(c.apiKey)}`:'';
 const found=await providerRequest(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=25&q=${encodeURIComponent(search)}${suffix}`,{token:c.accessToken});
 const ids=(found.items||[]).map((v:any)=>v.id.videoId).filter(Boolean).join(',');if(!ids)return [];
 const videos=await providerRequest(`https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails&id=${encodeURIComponent(ids)}${suffix}`,{token:c.accessToken});
 return importResearch(workspaceId,(videos.items||[]).map((v:any)=>({externalId:v.id,title:v.snippet.title,content:v.snippet.description,url:`https://www.youtube.com/watch?v=${v.id}`,platform:'youtube',creator:v.snippet.channelTitle,contentType:'video',publishedAt:v.snippet.publishedAt,metrics:Object.fromEntries(Object.entries({views:v.statistics.viewCount,likes:v.statistics.likeCount,comments:v.statistics.commentCount}).filter(([,n])=>n!==undefined).map(([k,n])=>[k,Number(n)])),provenance:'YouTube Data API',isAd:false})));
}
export async function discover(workspaceId:string,body:{query:string;platform?:string;mode?:string;minOutlier?:number;maxFollowers?:number}){
 const warnings:string[]=[];let source='Your imported research';
 const actor=currentAccess(),canSync=!!actor && actor.role!=='viewer' && (!actor.scopes||actor.scopes.includes('workspace:write'));
 const connections=canSync ? await query<StoredConnection>("SELECT * FROM connections WHERE workspace_id=$1 AND status='connected'",[workspaceId]):[];
 if(!canSync) warnings.push('Searching your saved research. Live provider sync requires workspace write permission.');
 const youtube=connections.find(c=>['youtube-data','youtube'].includes(c.provider));
 if(body.query&&youtube&&(!body.platform||body.platform==='youtube')){try{await youtubeSearch(workspaceId,connectionCredentials(youtube),body.query);source='YouTube Data API and your imported research';}catch(e){warnings.push((e as Error).message);}}
 const x=connections.find(c=>c.provider==='x');
 if(body.query&&x&&body.platform==='x'){
  try{const data=await providerRequest(`https://api.x.com/2/tweets/search/recent?query=${encodeURIComponent(body.query)}&max_results=25&tweet.fields=created_at,public_metrics,author_id&expansions=author_id&user.fields=name,username,public_metrics`,{token:token(connectionCredentials(x))});
   await importResearch(workspaceId,(data.data||[]).map((p:any)=>{const u=data.includes?.users?.find((u:any)=>u.id===p.author_id);return {title:p.text.slice(0,100),content:p.text,url:`https://x.com/${u?.username||'i'}/status/${p.id}`,platform:'x',creator:u?.username||p.author_id,contentType:'post',publishedAt:p.created_at,followers:u?.public_metrics?.followers_count,metrics:{likes:p.public_metrics.like_count,views:p.public_metrics.impression_count||0,comments:p.public_metrics.reply_count,shares:p.public_metrics.retweet_count},provenance:'X API recent search',isAd:false};}));source='X API and your imported research';
  }catch(e){warnings.push((e as Error).message);}
 }
 const meta=connections.find(c=>c.provider==='meta-ad-library');
 if(body.query&&meta&&body.mode==='ads'){
  try{const c=connectionCredentials(meta),countries=(c.countries||'US').split(',').map(s=>s.trim().toUpperCase()).filter(s=>/^[A-Z]{2}$/.test(s));
   const data=await providerRequest(`${graph()}/ads_archive?search_terms=${encodeURIComponent(body.query)}&ad_reached_countries=${encodeURIComponent(JSON.stringify(countries))}&ad_type=ALL&fields=id,ad_creation_time,ad_creative_bodies,ad_creative_link_titles,ad_delivery_start_time,ad_delivery_stop_time,ad_snapshot_url,page_name&page_size=25`,{token:token(c)});
   await importResearch(workspaceId,(data.data||[]).map((p:any)=>({title:p.ad_creative_link_titles?.[0]||p.page_name,content:p.ad_creative_bodies?.join('\n')||'',url:p.ad_snapshot_url,platform:'meta',creator:p.page_name,brand:p.page_name,contentType:'ad',metrics:{},provenance:'Meta Ad Library API',isAd:true,startedAt:p.ad_delivery_start_time,endedAt:p.ad_delivery_stop_time})));source='Meta Ad Library API';
  }catch(e){warnings.push((e as Error).message);}
 }
 let entities=(await listEntities(workspaceId,{kind:'item'})).filter(e=>['social','ad'].includes(e.data.type));
 if(body.platform)entities=entities.filter(e=>e.data.platform===body.platform);
 if(body.mode==='ads')entities=entities.filter(e=>e.data.type==='ad');else entities=entities.filter(e=>e.data.type==='social');
 if(body.query){const words=body.query.toLowerCase().split(/\s+/);entities=entities.filter(e=>words.some(w=>`${e.title} ${e.content} ${e.data.creator}`.toLowerCase().includes(w)));}
 if(body.minOutlier)entities=entities.filter(e=>e.data.outlier!=null&&e.data.outlier>=body.minOutlier!);
 if(body.maxFollowers)entities=entities.filter(e=>e.data.followers!=null&&e.data.followers<=body.maxFollowers!);
 const now=Date.now();
 if(body.mode==='breakouts')entities=entities.filter(e=>e.data.followers<50000&&e.data.outlier>=5);
 if(body.mode==='hidden-gems')entities=entities.filter(e=>e.data.followers<20000&&e.data.outlier>=10);
 if(body.mode==='viral-now')entities=entities.filter(e=>Date.parse(e.data.publishedAt)>now-30*86400000&&((e.data.metrics?.likes||0)>=500||(e.data.metrics?.views||0)>=50000));
 entities.sort((a,b)=>(b.data.outlier||0)-(a.data.outlier||0));
 if(!entities.length)warnings.push('Connect a research provider or import an authorized research export to populate this view. No market metrics are generated.');
 return {entities,source,warnings};
}

function feedNodeText(value:unknown):string {
 if(typeof value==='string')return value;
 if(!value||typeof value!=='object')return '';
 const node=value as Record<string,unknown>;
 return [node.__cdata,node['#text']].find((text):text is string=>typeof text==='string'&&text.length>0)||'';
}
export function feedItemContent(item:any):string {
 const text=[item['content:encoded'],item.description,item.summary,item.content].map(feedNodeText).find(Boolean)||'';
 return text.replace(/<[^>]+>/g,' ').slice(0,60000);
}
export async function syncConnection(workspaceId:string,id:string){
 const connection=await getConnection(workspaceId,id),c=connectionCredentials(connection);let entities:Entity[]=[];
 try{
  if(connection.provider==='rss'){
   const r=await safeFetch(c.url);const xml=await r.text();const parsed=parseSafeXml(xml),feed=parsed.rss?.channel||parsed.feed;
   if(!feed)throw httpError(400,'Invalid feed');const raw=feed.item||feed.entry||[],items=Array.isArray(raw)?raw:[raw];
   const existing=await listEntities(workspaceId,{kind:'item'});
   for(const item of items.slice(0,50)){
    const url=typeof item.link==='string'?item.link:Array.isArray(item.link)?item.link.find((l:any)=>l['@_rel']==='alternate')?.['@_href']:item.link?.['@_href'];if(!url||existing.some(e=>e.data.url===url))continue;
    const content=feedItemContent(item);
    entities.push(await createEntity(workspaceId,{kind:'item',title:String(item.title?.['#text']||item.title||'Feed article').slice(0,500),content,tags:['rss'],data:{type:'link',url,feedId:id,source:feed.title,publishedAt:item.pubDate||item.published,provenance:'RSS feed'}}));
   }
  }else if(connection.provider==='readwise'){
   const result=await providerRequest('https://readwise.io/api/v2/export/',{headers:{Authorization:`Token ${c.apiKey}`}});const existing=await listEntities(workspaceId,{kind:'item'});
   for(const book of (result.results||[]).slice(0,100)){
    const content=(book.highlights||[]).map((h:any)=>`> ${h.text}\n${h.note||''}`).join('\n\n');const match=existing.find(e=>e.data.readwiseId===book.user_book_id);
    const data={type:'document',readwiseId:book.user_book_id,author:book.author,url:book.source_url,highlights:book.highlights,provenance:'Readwise export'};
    entities.push(match?await updateEntity(workspaceId,match.id,{content,data}):await createEntity(workspaceId,{kind:'item',title:book.title,content,tags:['readwise'],data}));
   }
  }else if(['x','youtube','tiktok','instagram','facebook','threads','linkedin'].includes(connection.provider)){
   entities=await syncAnalyticsConnection(workspaceId,connection);
  }else{
   const snapshot=await businessSnapshot(connection.provider,c);
   entities.push(await createEntity(workspaceId,{kind:'item',visibility:'private',title:`${connection.label} · ${new Date().toISOString().slice(0,10)}`,content:JSON.stringify(snapshot,null,2).slice(0,150000),tags:['connector'],data:{type:'document',connectionId:id,provenance:`${connection.provider} authorized API snapshot`}}));
  }
  await query("UPDATE connections SET data=data||$3::jsonb,status='connected',updated_at=now() WHERE id=$1 AND workspace_id=$2",[id,workspaceId,JSON.stringify({lastSyncAt:new Date().toISOString(),error:null})]);
  return {entities,count:entities.length};
 }catch(error){await query("UPDATE connections SET data=data||$3::jsonb,status='error',updated_at=now() WHERE id=$1 AND workspace_id=$2",[id,workspaceId,JSON.stringify({error:(error as Error).message})]);throw error;}
}
export async function businessSnapshot(provider:string,c:Credentials){
 switch(provider){
  case 'stripe':return providerRequest('https://api.stripe.com/v1/balance',{token:c.apiKey});
  case 'notion':return providerRequest('https://api.notion.com/v1/search',{token:c.apiKey,method:'POST',body:{page_size:50},headers:{'Notion-Version':'2025-09-03'}});
  case 'kit':return providerRequest('https://api.kit.com/v4/broadcasts?per_page=50',{headers:{'X-Kit-Api-Key':c.apiKey}});
  case 'beehiiv':return providerRequest(`https://api.beehiiv.com/v2/publications/${encodeURIComponent(c.publicationId)}/posts?limit=50`,{token:c.apiKey});
  case 'klaviyo':return providerRequest('https://a.klaviyo.com/api/campaigns/?filter=equals(messages.channel,%22email%22)',{headers:{Authorization:`Klaviyo-API-Key ${c.apiKey}`,revision:'2025-07-15'}});
  case 'whop':return providerRequest('https://api.whop.com/api/v5/products',{token:c.apiKey});
  case 'kajabi':return providerRequest('https://api.kajabi.com/v1/products',{token:c.apiKey});
  case 'webflow':return providerRequest('https://api.webflow.com/v2/sites',{token:c.apiKey});
  case 'circle':return providerRequest('https://app.circle.so/api/admin/v2/spaces',{token:c.apiKey});
  default:return verifyConnection(provider,c);
 }
}
export async function recordMetrics(workspaceId:string,metrics:any[]){
 const existing=await listEntities(workspaceId,{kind:'metric'}),entities=[];
 for(const m of metrics){const key=m.key||`${m.platform}:${m.postId||m.accountId||'account'}:${m.date}`;const prev=existing.find(e=>e.data.key===key);const data={...m,key};entities.push(prev?await updateEntity(workspaceId,prev.id,{data}):await createEntity(workspaceId,{kind:'metric',title:`${m.platform} · ${m.date}`,data}));}
 return entities;
}
export async function syncAnalyticsConnection(workspaceId:string,connection:StoredConnection){
 const c=connectionCredentials(connection),p=connection.provider,date=new Date().toISOString().slice(0,10);let metrics:any[]=[];
 if(p==='youtube'){
  const r=await providerRequest('https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true',{token:token(c)});
  metrics=(r.items||[]).map((v:any)=>({platform:p,accountId:v.id,date,followers:Number(v.statistics.subscriberCount),views:Number(v.statistics.viewCount),provenance:'YouTube channel statistics (lifetime snapshot)',snapshot:true}));
 }else if(p==='x'){
  const me=await providerRequest('https://api.x.com/2/users/me?user.fields=public_metrics',{token:token(c)});
  metrics.push({platform:p,accountId:me.data.id,date,followers:me.data.public_metrics.followers_count,provenance:'X account statistics',snapshot:true});
  const posts=await providerRequest(`https://api.x.com/2/users/${me.data.id}/tweets?max_results=100&tweet.fields=public_metrics,created_at`,{token:token(c)});
  metrics.push(...(posts.data||[]).map((v:any)=>({platform:p,postId:v.id,title:v.text.slice(0,100),date:v.created_at.slice(0,10),likes:v.public_metrics.like_count,views:v.public_metrics.impression_count,comments:v.public_metrics.reply_count,shares:v.public_metrics.retweet_count,provenance:'X owned posts API'})));
 }else if(p==='instagram'){
  const r=await providerRequest(`${graph()}/${encodeURIComponent(c.accountId)}/media?fields=id,caption,timestamp,like_count,comments_count,permalink&limit=100`,{token:token(c)});
  metrics=(r.data||[]).map((v:any)=>({platform:p,postId:v.id,title:v.caption?.slice(0,100),date:v.timestamp.slice(0,10),likes:v.like_count,comments:v.comments_count,url:v.permalink,provenance:'Instagram media API'}));
 }else if(p==='threads'){
  const r=await providerRequest('https://graph.threads.net/v1.0/me/threads?fields=id,text,timestamp,permalink&limit=50',{token:token(c)});
  for(const v of (r.data||[]).slice(0,20)){const stats=await providerRequest(`https://graph.threads.net/v1.0/${v.id}/insights?metric=views,likes,replies,reposts,quotes`,{token:token(c)});metrics.push({platform:p,postId:v.id,title:v.text?.slice(0,100),date:v.timestamp.slice(0,10),...Object.fromEntries((stats.data||[]).map((s:any)=>[s.name,s.values?.[0]?.value])),provenance:'Threads insights'});}
 }else if(p==='facebook'){
  const r=await providerRequest(`${graph()}/${encodeURIComponent(c.accountId)}/posts?fields=id,message,created_time,shares,likes.summary(true),comments.summary(true)&limit=50`,{token:token(c)});
  metrics=(r.data||[]).map((v:any)=>({platform:p,postId:v.id,title:v.message?.slice(0,100),date:v.created_time.slice(0,10),likes:v.likes?.summary?.total_count,comments:v.comments?.summary?.total_count,shares:v.shares?.count,provenance:'Facebook Page API'}));
 }else if(p==='tiktok'){
  const r=await providerRequest('https://open.tiktokapis.com/v2/video/list/?fields=id,title,create_time,like_count,comment_count,share_count,view_count',{token:token(c),method:'POST',body:{max_count:20}});
  metrics=(r.data?.videos||[]).map((v:any)=>({platform:p,postId:v.id,title:v.title,date:new Date(v.create_time*1000).toISOString().slice(0,10),likes:v.like_count,views:v.view_count,comments:v.comment_count,shares:v.share_count,provenance:'TikTok Display API'}));
 }else if(p==='linkedin'){
  if(!c.accountId)throw httpError(400,'Organization analytics requires an organization ID and approved LinkedIn permissions');
  const r=await providerRequest(`https://api.linkedin.com/rest/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${encodeURIComponent(c.accountId.startsWith('urn:')?c.accountId:`urn:li:organization:${c.accountId}`)}`,{token:token(c),headers:{'LinkedIn-Version':process.env.LINKEDIN_VERSION||'202508','X-Restli-Protocol-Version':'2.0.0'}});
  metrics=(r.elements||[]).map((v:any)=>({platform:p,accountId:c.accountId,date,views:v.totalShareStatistics?.impressionCount,likes:v.totalShareStatistics?.likeCount,comments:v.totalShareStatistics?.commentCount,shares:v.totalShareStatistics?.shareCount,snapshot:true,provenance:'LinkedIn organization aggregate'}));
 }
 return recordMetrics(workspaceId,metrics);
}
export async function analytics(workspaceId:string,from?:string,to?:string){
 let entities=await listEntities(workspaceId,{kind:'metric'});entities=entities.filter(e=>(!from||e.data.date>=from)&&(!to||e.data.date<=to));
 const rows=entities.map(e=>e.data),keys=['views','likes','comments','shares','saves','impressions','clicks','watchTime','opens'];
 const latestSnapshots=new Map<string,any>();for(const row of rows.filter(r=>r.snapshot)){const k=`${row.platform}:${row.accountId}`;if(!latestSnapshots.has(k)||latestSnapshots.get(k).date<row.date)latestSnapshots.set(k,row);}
 const additive=rows.filter(r=>!r.snapshot);const available=[...additive,...latestSnapshots.values()];
 const aggregate=(rs:any[]):Record<string,number|null>=>Object.fromEntries(keys.map(k=>[k,rs.some(r=>typeof r[k]==='number')?rs.reduce((s,r)=>s+(typeof r[k]==='number'?r[k]:0),0):null]));
 const totals:Record<string,number|null>={...aggregate(available),followers:[...latestSnapshots.values()].some(r=>typeof r.followers==='number')?[...latestSnapshots.values()].reduce((s,r)=>s+(r.followers||0),0):null};
 const dates=[...new Set(additive.map(r=>r.date))].sort();
 return {totals,series:dates.map(date=>({date,...aggregate(additive.filter(r=>r.date===date))})),platforms:[...new Set(rows.map(r=>r.platform))].map(platform=>({platform,...aggregate(available.filter(r=>r.platform===platform))})),topPosts:additive.sort((a,b)=>(b.views||b.likes||0)-(a.views||a.likes||0)).slice(0,20),hasData:rows.length>0,notice:'Metrics retain provider definitions. Lifetime snapshots use the most recent value and are excluded from daily activity.'};
}

// OAuth state is single-use, workspace/user-bound and uses PKCE where supported.
interface OAuthSpec {authorize:string;tokenUrl:string;scopes:string;pkce?:boolean}
const oauthSpecs:Record<string,OAuthSpec>={
 x:{authorize:'https://x.com/i/oauth2/authorize',tokenUrl:'https://api.x.com/2/oauth2/token',scopes:'tweet.read tweet.write users.read offline.access',pkce:true},
 linkedin:{authorize:'https://www.linkedin.com/oauth/v2/authorization',tokenUrl:'https://www.linkedin.com/oauth/v2/accessToken',scopes:'openid profile w_member_social'},
 youtube:{authorize:'https://accounts.google.com/o/oauth2/v2/auth',tokenUrl:'https://oauth2.googleapis.com/token',scopes:'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly',pkce:true},
 facebook:{authorize:'https://www.facebook.com/v23.0/dialog/oauth',tokenUrl:'https://graph.facebook.com/v23.0/oauth/access_token',scopes:'pages_show_list pages_manage_posts pages_read_engagement'},
 instagram:{authorize:'https://www.facebook.com/v23.0/dialog/oauth',tokenUrl:'https://graph.facebook.com/v23.0/oauth/access_token',scopes:'instagram_basic instagram_content_publish instagram_manage_insights instagram_manage_messages pages_show_list'},
 threads:{authorize:'https://threads.net/oauth/authorize',tokenUrl:'https://graph.threads.net/oauth/access_token',scopes:'threads_basic,threads_content_publish,threads_manage_insights'},
 tiktok:{authorize:'https://www.tiktok.com/v2/auth/authorize/',tokenUrl:'https://open.tiktokapis.com/v2/oauth/token/',scopes:'user.info.basic,video.list,video.publish',pkce:true},
};
const oauthEnv=(provider:string)=>{const name=provider.toUpperCase().replaceAll('-','_');return {clientId:process.env[`${name}_CLIENT_ID`],clientSecret:process.env[`${name}_CLIENT_SECRET`]};};

export const integrationRouter=Router();
integrationRouter.get('/connections',requireAuth,requireScope('connections:read'),async(req,res)=>res.json({connections:(await query<StoredConnection>('SELECT * FROM connections WHERE workspace_id=$1 ORDER BY created_at',[req.auth.workspaceId])).map(publicConnection)}));
integrationRouter.post('/connections/:provider',requireAuth,requireEditor,requireScope('workspace:write'),async(req,res)=>{if(!['owner','admin'].includes(req.auth.role))throw httpError(403,'Workspace administrators manage connections');const b=z.object({label:z.string().max(150).default(''),credentials:z.record(z.string().max(80),z.string().max(16000)),config:z.record(z.string(),z.unknown()).default({})}).parse(req.body);res.status(201).json({connection:await saveConnection(req.auth.workspaceId,String(req.params.provider),b.label,b.credentials,b.config)});});
integrationRouter.delete('/connections/:id',requireAuth,requireEditor,requireScope('workspace:write'),async(req,res)=>{if(!['owner','admin'].includes(req.auth.role))throw httpError(403,'Workspace administrators manage connections');await query('DELETE FROM connections WHERE id=$1 AND workspace_id=$2',[z.uuid().parse(req.params.id),req.auth.workspaceId]);res.json({ok:true});});
integrationRouter.post('/connections/:id/sync',requireAuth,requireEditor,requireScope('workspace:write'),async(req,res)=>res.json(await syncConnection(req.auth.workspaceId,z.uuid().parse(req.params.id))));
integrationRouter.post('/discover/search',requireAuth,requireScope('research:read'),async(req,res)=>{const b=z.object({query:z.string().max(500).default(''),platform:z.string().optional(),mode:z.string().optional(),minOutlier:z.number().optional(),maxFollowers:z.number().optional()}).parse(req.body);res.json(await discover(req.auth.workspaceId,b));});
integrationRouter.post('/discover/import',requireAuth,requireEditor,requireScope('workspace:write'),async(req,res)=>{const b=z.object({posts:z.array(researchSchema).min(1).max(300)}).parse(req.body);res.json({entities:await importResearch(req.auth.workspaceId,b.posts)});});
integrationRouter.get('/analytics',requireAuth,requireScope('analytics:read'),async(req,res)=>res.json(await analytics(req.auth.workspaceId,req.query.from as string,req.query.to as string)));
integrationRouter.post('/analytics/import',requireAuth,requireEditor,requireScope('workspace:write'),async(req,res)=>{const b=z.object({metrics:z.array(z.object({platform:z.string().max(30),date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),postId:z.string().max(200).optional(),accountId:z.string().max(200).optional(),title:z.string().max(500).optional(),provenance:z.string().max(300).default('User-provided metrics'),snapshot:z.boolean().default(false),...Object.fromEntries(['views','likes','comments','shares','saves','impressions','followers','clicks','watchTime','opens'].map(k=>[k,z.number().nonnegative().optional()]))})).min(1).max(1000)}).parse(req.body);res.json({entities:await recordMetrics(req.auth.workspaceId,b.metrics)});});
integrationRouter.post('/analytics/sync',requireAuth,requireEditor,requireScope('workspace:write'),async(req,res)=>{const cs=await query<StoredConnection>("SELECT * FROM connections WHERE workspace_id=$1 AND status='connected'",[req.auth.workspaceId]);const results=[];for(const c of cs.filter(c=>connectors.find(d=>d.id===c.provider)?.capabilities.includes('analytics'))){try{const e=await syncAnalyticsConnection(req.auth.workspaceId,c);results.push({id:c.id,count:e.length});}catch(error){results.push({id:c.id,error:(error as Error).message});}}res.json({results});});
integrationRouter.get('/oauth/:provider/start',requireAuth,requireScope('workspace:write'),async(req,res)=>{
 const workspaceId=req.query.workspaceId ? z.uuid().parse(req.query.workspaceId):req.auth.workspaceId;
 if(req.auth.scopes && workspaceId!==req.auth.workspaceId)throw httpError(403,'API tokens are bound to one workspace.');
 const role=await assertAccess(workspaceId,req.auth.userId);if(!['owner','admin'].includes(role))throw httpError(403,'Workspace administrators manage connections');
 const provider=String(req.params.provider),spec=oauthSpecs[provider],env=oauthEnv(provider);if(!spec||!env.clientId)throw httpError(503,'This OAuth provider needs a developer application configured by the administrator. You can connect an approved access token in Connections.','OAUTH_NOT_CONFIGURED');
 const state=randomBytes(32).toString('hex'),verifier=randomBytes(48).toString('base64url'),redirect=`${process.env.APP_URL}/api/oauth/${provider}/callback`;
 await query('INSERT INTO oauth_states(state,workspace_id,user_id,provider,verifier,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval \'10 minutes\')',[state,workspaceId,req.auth.userId,provider,encryptSecret(verifier)]);
 const url=new URL(spec.authorize);for(const [k,v] of Object.entries({client_id:env.clientId,redirect_uri:redirect,response_type:'code',scope:spec.scopes,state}))url.searchParams.set(k,v);
 if(provider==='tiktok'){url.searchParams.delete('client_id');url.searchParams.set('client_key',env.clientId);}
 if(spec.pkce){url.searchParams.set('code_challenge',createHash('sha256').update(verifier).digest('base64url'));url.searchParams.set('code_challenge_method','S256');}
 if(provider==='youtube'){url.searchParams.set('access_type','offline');url.searchParams.set('prompt','consent');}
 res.redirect(url.toString());
});
integrationRouter.get('/oauth/:provider/callback',requireAuth,async(req,res)=>{
 const provider=String(req.params.provider),spec=oauthSpecs[provider],env=oauthEnv(provider);
 const b=z.object({state:z.string().length(64),code:z.string().min(1).max(4000)}).parse(req.query);
 const [state]=await query<any>('DELETE FROM oauth_states WHERE state=$1 AND provider=$2 AND user_id=$3 AND expires_at>now() RETURNING *',[b.state,provider,req.auth.userId]);if(!state||!spec)throw httpError(400,'OAuth session expired or mismatched');
 await runAsActor(state.workspace_id,state.user_id,async()=>{if(!['owner','admin'].includes(currentAccess()!.role))throw httpError(403,'Workspace administrator access was revoked during OAuth.');});
 const form=new URLSearchParams({grant_type:'authorization_code',code:b.code,redirect_uri:`${process.env.APP_URL}/api/oauth/${provider}/callback`,client_id:env.clientId!,client_secret:env.clientSecret||''});
 if(spec.pkce)form.set('code_verifier',decryptSecret(state.verifier));if(provider==='tiktok'){form.delete('client_id');form.set('client_key',env.clientId!);}
 const creds=await providerRequest(spec.tokenUrl,{method:'POST',rawBody:form,headers:{'Content-Type':'application/x-www-form-urlencoded'}});
 if(!creds.access_token)throw httpError(502,'OAuth provider returned no access token');
 await runAsActor(state.workspace_id,state.user_id,()=>saveConnection(state.workspace_id,provider,connectors.find(c=>c.id===provider)?.name||provider,{accessToken:creds.access_token,refreshToken:creds.refresh_token||'',expiresAt:creds.expires_in?String(Date.now()+creds.expires_in*1000):'',accountId:creds.open_id||''}));
 res.redirect('/connections?connected='+encodeURIComponent(provider));
});
