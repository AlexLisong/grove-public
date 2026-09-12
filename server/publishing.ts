import {Router} from 'express';
import {z} from 'zod';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {requireAuth,requireEditor,requireScope} from './core/auth.js';
import {getEntity,updateEntity,createEntity} from './core/entities.js';
import {readFile,readGrantedFile} from './core/files.js';
import {query} from './core/db.js';
import {enqueue} from './core/jobs.js';
import {httpError,safeFetch} from './core/security.js';
import {getConnection,connectionCredentials,providerRequest,type StoredConnection} from './integrations.js';
import {generate} from './ai.js';
import type {Entity} from '../shared/types.js';
import {isExclusivePrivateTarget} from './core/access.js';

export const platformLimits:Record<string,number>={x:280,threads:500,linkedin:3000,instagram:2200,facebook:63206,tiktok:2200,youtube:100,substack:100000};
export function validateDraft(draft:Entity,connections:StoredConnection[]){
 if(!draft.content.trim()&&!Object.values(draft.data.variants||{}).some(v=>typeof v==='string'&&v.trim()))throw httpError(400,'Write a draft before requesting approval');
 if(!connections.length)throw httpError(400,'Choose at least one connected publishing account');
 for(const c of connections){
  if(c.status!=='connected')throw httpError(400,`${c.label} needs to be reconnected`);
  const content=String(draft.data.variants?.[c.provider]||draft.content);
  if(!platformLimits[c.provider])throw httpError(400,`${c.provider} is not a publishing destination`);
  if(c.provider==='substack')throw httpError(409,'Substack requires a signed-in browser handoff. Use Open in Substack and confirm the native draft there.');
  const posts=c.provider==='x'?content.split(/\n---\n/):[content];
  if(posts.some(p=>[...p].length>platformLimits[c.provider]))throw httpError(400,`${c.provider} copy exceeds its configured ${platformLimits[c.provider]} character limit`);
  if(['instagram','tiktok','youtube'].includes(c.provider)&&!draft.data.mediaIds?.length)throw httpError(400,`${c.provider} requires a media attachment`);
  if(draft.data.mediaIds?.length>10)throw httpError(400,'Attach at most 10 media files');
 }
}
async function selectedConnections(workspaceId:string,ids:string[]){const cs=[];for(const id of [...new Set(ids)])cs.push(await getConnection(workspaceId,id));return cs;}
export async function transitionDraft(workspaceId:string,id:string,body:{status:'draft'|'review'|'approved'|'scheduled';scheduledAt?:string;connectionIds?:string[]}){
 const draft=await getEntity(workspaceId,id);if(!draft||draft.kind!=='draft')throw httpError(404,'Draft not found');
 const status=draft.data.status||'draft';
 if(['publishing','published'].includes(status))throw httpError(409,'This post is already being delivered or has been published. Duplicate it to create a new draft.');
 const data={...draft.data};
 if(body.connectionIds)data.connectionIds=body.connectionIds;
 if(body.status==='review'&&!draft.content.trim())throw httpError(400,'Write draft content first');
 if(body.status==='approved'){
  if(data.deliveryUncertain || (data.receipts||[]).some((receipt:any)=>['published','processing'].includes(receipt.status))) throw httpError(409,'An earlier delivery may already exist. Check each destination, then duplicate only content you intend to send again.','DELIVERY_REVIEW_REQUIRED');
  // Approval is local and can precede connecting an account.
  if(!draft.content.trim())throw httpError(400,'Write draft content first');
  data.approvalId=randomUUID();data.approvedAt=new Date().toISOString();delete data.error;
 }
 if(body.status==='scheduled'){
  if(!['approved','scheduled'].includes(status)||!data.approvalId)throw httpError(409,'Approve the draft before scheduling');
  const at=Date.parse(body.scheduledAt||'');if(!Number.isFinite(at)||at<Date.now()+10000||at>Date.now()+366*86400000)throw httpError(400,'Choose a scheduled time between 10 seconds and one year from now');
  const cs=await selectedConnections(workspaceId,data.connectionIds||[]);validateDraft(draft,cs);
  data.scheduledAt=new Date(at).toISOString();
 }
 if(body.status==='draft'){delete data.approvalId;delete data.approvedAt;delete data.scheduledAt;}
 data.status=body.status;
 const entity=await updateEntity(workspaceId,id,{data,version:draft.version} as any);
 if(body.status==='scheduled')await enqueue(workspaceId,'publish',{draftId:id,approvalId:data.approvalId,scheduledAt:data.scheduledAt},new Date(data.scheduledAt),`publish:${id}:${data.approvalId}:${data.scheduledAt}`);
 return entity;
}
export async function queuePublish(workspaceId:string,id:string){
 const draft=await getEntity(workspaceId,id);if(!draft||draft.kind!=='draft')throw httpError(404,'Draft not found');
 if(draft.data.status!=='approved'||!draft.data.approvalId)throw httpError(409,'Approve this draft before publishing');
 validateDraft(draft,await selectedConnections(workspaceId,draft.data.connectionIds||[]));
 const job=await enqueue(workspaceId,'publish',{draftId:id,approvalId:draft.data.approvalId},undefined,`publish:${id}:${draft.data.approvalId}:now`);
 return {job};
}
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
export function verifiedUploadUrl(value:unknown,domains:string[]) {
 if(typeof value!=='string')throw httpError(502,'The provider did not return an upload URL.');
 let url:URL;try{url=new URL(value);}catch{throw httpError(502,'The provider returned an invalid upload URL.');}
 if(url.protocol!=='https:'||url.username||url.password||!domains.some(domain=>url.hostname===domain||url.hostname.endsWith('.'+domain)))throw httpError(502,'The provider upload URL is outside its trusted domains.');
 return url.toString();
}
export async function mediaUrl(workspaceId:string,id:string){
 const file=await readFile(workspaceId,id);
 if(!/^(image\/(png|jpeg|webp|gif)|video\/|audio\/)/.test(file.mime))throw httpError(400,'Only supported images, audio or videos can be attached for publishing');
 const token=randomBytes(32).toString('base64url');
 await query("INSERT INTO media_grants(token_hash,workspace_id,entity_id,expires_at) VALUES($1,$2,$3,now()+interval '24 hours')",[sha(token),workspaceId,id]);
 return {url:`${process.env.APP_URL}/api/media/${token}`,mime:file.mime,name:file.name,buffer:file.buffer};
}
async function waitGraphContainer(base:string,id:string,token:string){
 for(let i=0;i<12;i++){
  const r=await providerRequest(`${base}/${id}?fields=status_code,status`,{token});
  if(['FINISHED','PUBLISHED'].includes(r.status_code)||r.status==='FINISHED')return;
  if(r.status_code==='ERROR'||r.status==='ERROR')throw httpError(502,'The platform could not process this media');
  await new Promise(resolve=>setTimeout(resolve,5000));
 }
 throw httpError(504,'Media is still processing. Check the platform before retrying to avoid duplicate delivery.');
}
export async function publishToProvider(workspaceId:string,draft:Entity,connection:StoredConnection){
 const c=connectionCredentials(connection),text=String(draft.data.variants?.[connection.provider]||draft.content),media=[];
 for(const id of draft.data.mediaIds||[])media.push(await mediaUrl(workspaceId,id));
 const token=c.accessToken||c.apiKey,p=connection.provider;
 if(p==='x'){
  const mediaIds=[];
  for(const m of media){const form=new FormData();form.set('media',new Blob([new Uint8Array(m.buffer)],{type:m.mime}),m.name);form.set('media_category',m.mime.startsWith('video/')?'tweet_video':'tweet_image');const r=await providerRequest('https://api.x.com/2/media/upload',{token,method:'POST',rawBody:form});if(!r.data?.id)throw httpError(502,'X did not confirm the media upload');mediaIds.push(r.data.id);}
  const posts=text.split(/\n---\n/),ids:string[]=[];
  for(const [i,part] of posts.entries()){const r=await providerRequest('https://api.x.com/2/tweets',{token,method:'POST',body:{text:part,...(i===0&&mediaIds.length?{media:{media_ids:mediaIds}}:{}),...(i?{reply:{in_reply_to_tweet_id:ids[i-1]}}:{})}});if(!r.data?.id)throw httpError(502,'X did not confirm publication');ids.push(r.data.id);}
  return {provider:p,postId:ids[0],postIds:ids,url:`https://x.com/i/status/${ids[0]}`,status:'published'};
 }
 if(p==='threads'){
  const base='https://graph.threads.net/v1.0',account=encodeURIComponent(c.accountId||'me');
  const children=[];
  for(const m of media){const body={media_type:m.mime.startsWith('video/')?'VIDEO':'IMAGE',[m.mime.startsWith('video/')?'video_url':'image_url']:m.url,is_carousel_item:media.length>1};const r=await providerRequest(`${base}/${account}/threads`,{token,method:'POST',body});if(!r.id)throw httpError(502,'Threads did not create a media container');children.push(r.id);}
  let id=children[0];
  if(media.length!==1){const r=await providerRequest(`${base}/${account}/threads`,{token,method:'POST',body:{media_type:media.length?'CAROUSEL':'TEXT',text,...(media.length?{children:children.join(',')}:{})}});id=r.id;}
  else { // Single-media container needs the caption at creation.
   const m=media[0],r=await providerRequest(`${base}/${account}/threads`,{token,method:'POST',body:{media_type:m.mime.startsWith('video/')?'VIDEO':'IMAGE',text,[m.mime.startsWith('video/')?'video_url':'image_url']:m.url}});id=r.id;
  }
  if(!id)throw httpError(502,'Threads did not confirm a draft container');
  if(media.some(m=>m.mime.startsWith('video/')))await waitGraphContainer(base,id,token);
  const result=await providerRequest(`${base}/${account}/threads_publish`,{token,method:'POST',body:{creation_id:id}});if(!result.id)throw httpError(502,'Threads did not confirm publication');return {provider:p,postId:result.id,status:'published'};
 }
 if(p==='instagram'){
  if(!c.accountId)throw httpError(400,'Choose an Instagram professional account ID');
  const base=`https://graph.facebook.com/${process.env.META_GRAPH_VERSION||'v23.0'}`,children=[];
  for(const m of media){const video=m.mime.startsWith('video/'),result=await providerRequest(`${base}/${encodeURIComponent(c.accountId)}/media`,{token,method:'POST',body:{...(video?{media_type:media.length>1?'VIDEO':'REELS',video_url:m.url}:{image_url:m.url}),...(media.length>1?{is_carousel_item:true}:{caption:text})}});if(!result.id)throw httpError(502,'Instagram did not create a media container');if(video)await waitGraphContainer(base,result.id,token);children.push(result.id);}
  let id=children[0];if(children.length>1){const result=await providerRequest(`${base}/${encodeURIComponent(c.accountId)}/media`,{token,method:'POST',body:{media_type:'CAROUSEL',children:children.join(','),caption:text}});id=result.id;}
  const result=await providerRequest(`${base}/${encodeURIComponent(c.accountId)}/media_publish`,{token,method:'POST',body:{creation_id:id}});if(!result.id)throw httpError(502,'Instagram did not confirm publication');return {provider:p,postId:result.id,status:'published'};
 }
 if(p==='facebook'){
  if(!c.accountId)throw httpError(400,'Choose a Facebook Page ID');
  const base=`https://graph.facebook.com/${process.env.META_GRAPH_VERSION||'v23.0'}/${encodeURIComponent(c.accountId)}`;
  let result:any;
  if(media[0]?.mime.startsWith('video/'))result=await providerRequest(`${base}/videos`,{token,method:'POST',body:{file_url:media[0].url,description:text}});
  else if(media.length===1)result=await providerRequest(`${base}/photos`,{token,method:'POST',body:{url:media[0].url,message:text}});
  else if(media.length>1){const ids=[];for(const m of media){const r=await providerRequest(`${base}/photos`,{token,method:'POST',body:{url:m.url,published:false}});ids.push({media_fbid:r.id});}result=await providerRequest(`${base}/feed`,{token,method:'POST',body:{message:text,attached_media:ids}});}
  else result=await providerRequest(`${base}/feed`,{token,method:'POST',body:{message:text}});
  const id=result.post_id||result.id;if(!id)throw httpError(502,'Facebook did not confirm publication');return {provider:p,postId:id,status:'published',url:`https://www.facebook.com/${id}`};
 }
 if(p==='linkedin'){
  if(!c.accountId)throw httpError(400,'Choose a LinkedIn person or organization URN');
  const author=c.accountId.startsWith('urn:')?c.accountId:`urn:li:person:${c.accountId}`;
  const headers={'LinkedIn-Version':process.env.LINKEDIN_VERSION||'202508','X-Restli-Protocol-Version':'2.0.0','Content-Type':'application/json',Authorization:`Bearer ${token}`};
  let content:any;
  if(media.length){const m=media[0];if(!m.mime.startsWith('image/'))throw httpError(400,'This LinkedIn adapter currently accepts images or text. Upload video natively until video processing is configured.');const init=await providerRequest('https://api.linkedin.com/rest/images?action=initializeUpload',{token,method:'POST',headers,body:{initializeUploadRequest:{owner:author}}});const upload=await safeFetch(verifiedUploadUrl(init.value?.uploadUrl,['linkedin.com','licdn.com']),{method:'PUT',headers:{Authorization:`Bearer ${token}`,'Content-Type':m.mime},body:new Uint8Array(m.buffer)});if(!upload.ok)throw httpError(502,'LinkedIn image upload failed');content={media:{id:init.value.image,title:draft.title}};}
  const r=await safeFetch('https://api.linkedin.com/rest/posts',{method:'POST',headers,body:JSON.stringify({author,commentary:text,visibility:'PUBLIC',distribution:{feedDistribution:'MAIN_FEED',targetEntities:[],thirdPartyDistributionChannels:[]},lifecycleState:'PUBLISHED',isReshareDisabledByAuthor:false,...(content?{content}:{})})});
  if(!r.ok)throw httpError(502,`LinkedIn rejected publication (${r.status})`);const id=r.headers.get('x-restli-id');if(!id)throw httpError(502,'LinkedIn accepted the request without a confirmation ID. Check the account before retrying.');return {provider:p,postId:id,status:'published',url:`https://www.linkedin.com/feed/update/${encodeURIComponent(id)}`};
 }
 if(p==='youtube'){
  const m=media[0];if(!m?.mime.startsWith('video/'))throw httpError(400,'YouTube Shorts requires a video');
  const init=await safeFetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','X-Upload-Content-Type':m.mime,'X-Upload-Content-Length':String(m.buffer.length)},body:JSON.stringify({snippet:{title:text.slice(0,100),description:draft.data.description||draft.content,tags:['Shorts']},status:{privacyStatus:draft.data.privacyStatus||'private',selfDeclaredMadeForKids:false}})});
  if(!init.ok)throw httpError(502,`YouTube upload could not start (${init.status})`);const url=verifiedUploadUrl(init.headers.get('location'),['googleapis.com']);
  const result=await providerRequest(url,{method:'PUT',token,rawBody:new Uint8Array(m.buffer),headers:{'Content-Type':m.mime}});if(!result.id)throw httpError(502,'YouTube did not confirm the upload');return {provider:p,postId:result.id,status:'published',url:`https://www.youtube.com/shorts/${result.id}`,privacyStatus:draft.data.privacyStatus||'private'};
 }
 if(p==='tiktok'){
  const m=media[0];if(!m?.mime.startsWith('video/'))throw httpError(400,'TikTok requires a video');
  const creator=await providerRequest('https://open.tiktokapis.com/v2/post/publish/creator_info/query/',{token,method:'POST',body:{}});
  const privacy=draft.data.privacyStatus||'SELF_ONLY';if(!creator.data?.privacy_level_options?.includes(privacy))throw httpError(400,'Choose a TikTok privacy level allowed by this creator account');
  const result=await providerRequest('https://open.tiktokapis.com/v2/post/publish/video/init/',{token,method:'POST',body:{post_info:{title:text,privacy_level:privacy,disable_duet:true,disable_comment:false,disable_stitch:true},source_info:{source:'PULL_FROM_URL',video_url:m.url}}});
  if(result.error?.code!=='ok'||!result.data?.publish_id)throw httpError(502,'TikTok did not accept the video; check domain verification and app approval');return {provider:p,postId:result.data.publish_id,status:'processing',privacyStatus:privacy};
 }
 throw httpError(400,'This destination requires a browser handoff or another configured adapter');
}
export async function executePublish(workspaceId:string,data:any){
 let draft=await getEntity(workspaceId,data.draftId);if(!draft||draft.kind!=='draft')return {cancelled:true,reason:'Draft was removed'};
 if(!['approved','scheduled'].includes(draft.data.status)||draft.data.approvalId!==data.approvalId)return {cancelled:true,reason:'Approval changed or was withdrawn'};
 if(data.scheduledAt&&draft.data.scheduledAt!==data.scheduledAt)return {cancelled:true,reason:'Schedule changed'};
 const connections=await selectedConnections(workspaceId,draft.data.connectionIds||[]);validateDraft(draft,connections);
 draft=await updateEntity(workspaceId,draft.id,{data:{...draft.data,status:'publishing'},version:draft.version} as any);
 const receipts=[...(draft.data.receipts||[])];
 try{
  for(const c of connections){
   if(receipts.some(r=>r.connectionId===c.id&&r.approvalId===data.approvalId))continue;
   const receipt={...await publishToProvider(workspaceId,draft,c),connectionId:c.id,approvalId:data.approvalId,createdAt:new Date().toISOString()};receipts.push(receipt);
   draft=await updateEntity(workspaceId,draft.id,{data:{...draft.data,receipts}});
   if(draft.data.firstComment&&receipt.status==='published'&&['x','instagram','facebook'].includes(c.provider))await enqueue(workspaceId,'first-comment',{draftId:draft.id,connectionId:c.id,postId:receipt.postId,text:draft.data.firstComment},undefined,`comment:${c.id}:${receipt.postId}`);
   if(draft.data.autoRepostHours&&c.provider==='x')await enqueue(workspaceId,'repost',{connectionId:c.id,postId:receipt.postId},new Date(Date.now()+Number(draft.data.autoRepostHours)*3600000),`repost:${c.id}:${receipt.postId}`);
  }
  const processing=receipts.some(r=>r.status==='processing');
  await updateEntity(workspaceId,draft.id,{data:{...draft.data,status:processing?'publishing':'published',receipts,publishedAt:processing?undefined:new Date().toISOString()}});
  if(processing)await enqueue(workspaceId,'publish-status',{draftId:draft.id},new Date(Date.now()+30000),`publish-status:${draft.id}:${data.approvalId}`);
  return {draftId:draft.id,receipts};
 }catch(error){await updateEntity(workspaceId,draft.id,{data:{...draft.data,status:'failed',receipts,error:(error as Error).message,deliveryUncertain:true}});throw error;}
}
export async function checkPublication(workspaceId:string,data:any){
 const draft=await getEntity(workspaceId,data.draftId);if(!draft)return {cancelled:true};
 const receipts=[...(draft.data.receipts||[])];let pending=false;
 for(const r of receipts.filter(r=>r.status==='processing'&&r.provider==='tiktok')){const c=connectionCredentials(await getConnection(workspaceId,r.connectionId));const result=await providerRequest('https://open.tiktokapis.com/v2/post/publish/status/fetch/',{token:c.accessToken,method:'POST',body:{publish_id:r.postId}});if(result.data?.status==='PUBLISH_COMPLETE'){r.status='published';r.publicPostIds=result.data.publicaly_available_post_id;}else if(result.data?.status==='FAILED'){r.status='failed';r.error=result.data.fail_reason;}else pending=true;}
 await updateEntity(workspaceId,draft.id,{data:{...draft.data,receipts,status:receipts.some(r=>r.status==='failed')?'failed':pending?'publishing':'published'}});
 if(pending&&Number(data.check||0)<20)await enqueue(workspaceId,'publish-status',{draftId:draft.id,check:Number(data.check||0)+1},new Date(Date.now()+60000),`status:${draft.id}:${Number(data.check||0)+1}`);
 return {receipts,pending};
}
export async function executeFollowup(workspaceId:string,kind:string,data:any){
 const conn=await getConnection(workspaceId,data.connectionId),c=connectionCredentials(conn),token=c.accessToken;
 if(kind==='repost'){
  if(!c.accountId)throw httpError(400,'X account ID required for repost');
  return providerRequest(`https://api.x.com/2/users/${encodeURIComponent(c.accountId)}/retweets`,{token,method:'POST',body:{tweet_id:data.postId}});
 }
 if(conn.provider==='x')return providerRequest('https://api.x.com/2/tweets',{token,method:'POST',body:{text:data.text,reply:{in_reply_to_tweet_id:data.postId}}});
 return providerRequest(`https://graph.facebook.com/${process.env.META_GRAPH_VERSION||'v23.0'}/${encodeURIComponent(data.postId)}/comments`,{token,method:'POST',body:{message:data.text}});
}

export const publishingRouter=Router();
publishingRouter.get('/media/:token',async(req,res)=>{const tokenHash=sha(String(req.params.token)),[grant]=await query<any>('SELECT * FROM media_grants WHERE token_hash=$1 AND expires_at>now()',[tokenHash]);if(!grant)throw httpError(404,'Media link expired');const file=await readGrantedFile(grant.workspace_id,grant.entity_id,tokenHash);res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');res.type(file.mime).send(file.buffer);});
publishingRouter.post('/drafts/:id/transition',requireAuth,requireEditor,requireScope('publish:write'),async(req,res)=>{const b=z.object({status:z.enum(['draft','review','approved','scheduled']),scheduledAt:z.iso.datetime().optional(),connectionIds:z.array(z.uuid()).max(20).optional()}).parse(req.body);res.json({entity:await transitionDraft(req.auth.workspaceId,z.uuid().parse(req.params.id),b)});});
publishingRouter.post('/drafts/:id/publish',requireAuth,requireEditor,requireScope('publish:write'),async(req,res)=>res.status(202).json(await queuePublish(req.auth.workspaceId,z.uuid().parse(req.params.id))));
publishingRouter.post('/drafts/:id/variants',requireAuth,requireEditor,requireScope('ai:run'),async(req,res)=>{
 const b=z.object({platforms:z.array(z.string().refine(p=>Boolean(platformLimits[p]))).min(1).max(8)}).parse(req.body),id=z.uuid().parse(req.params.id),draft=await getEntity(req.auth.workspaceId,id);if(!draft||draft.kind!=='draft')throw httpError(404,'Draft not found');
 if(['publishing','published'].includes(draft.data.status))throw httpError(409,'Duplicate this post before generating new variants');
 const variants={...draft.data.variants};for(const platform of b.platforms){const result=await generate(req.auth.workspaceId,{input:draft.content,instruction:`Adapt this draft for ${platform}. Return only the copy, no preamble. Maximum ${platformLimits[platform]} characters. Preserve factual accuracy; do not invent examples or results.`,sourceIds:draft.data.sourceIds,action:'platform-variant'});variants[platform]=result.text;}
 const data:Record<string,any>={...draft.data,variants,platforms:b.platforms,status:'draft',approvalId:null,approvedAt:null,scheduledAt:null};
 if(await isExclusivePrivateTarget(req.auth.workspaceId,id))res.json({entity:await updateEntity(req.auth.workspaceId,id,{data,version:draft.version})});
 else {for(const key of ['receipts','publishedAt','publishingAt','publishJobId','deliveryUncertain','error'])delete data[key];res.json({entity:await createEntity(req.auth.workspaceId,{kind:'draft',title:`${draft.title} (private)`,content:draft.content,data,visibility:'private'}),forkedFrom:id});}
});
publishingRouter.post('/drafts/:id/handoff',requireAuth,requireEditor,requireScope('workspace:read'),async(req,res)=>{const draft=await getEntity(req.auth.workspaceId,z.uuid().parse(req.params.id));if(!draft||draft.kind!=='draft')throw httpError(404,'Draft not found');res.json({title:draft.title,content:draft.data.variants?.substack||draft.content,url:'https://substack.com/publish',status:'requires-browser-confirmation',instructions:'Open Substack in your signed-in browser, paste the draft, and review its native publish or schedule controls. Grove does not mark a handoff as published.'});});
