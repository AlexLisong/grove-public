import {createHash} from 'node:crypto';
import {query} from './core/db.js';
import {currentAccess} from './core/access.js';
import {getConnection,connectionCredentials,providerRequest,type StoredConnection} from './integrations.js';
import type {Entity} from '../shared/types.js';
import type {Evidence} from './workflow-schema.js';

export interface ResearchQuery {id:string;query:string;purpose:'topic'|'audience'|'formats';provider?:{id:string;provider:string}}
export interface ResearchResult {query:ResearchQuery;evidence:Evidence[];gaps:string[];source:string;providerStatus:'not-requested'|'completed'|'unavailable';completedAt:string}
const now=()=>new Date().toISOString();
const knownNumber=(value:unknown):number|null=>{if(value===undefined||value===null||value==='')return null;const n=Number(value);return Number.isFinite(n)&&n>=0?n:null;};
const metrics=(value:any)=>Object.fromEntries(Object.entries(value&&typeof value==='object'&&!Array.isArray(value)?value:{}).slice(0,30).map(([key,n])=>[key,knownNumber(n)]));
const safeUrl=(value:unknown)=>{try{const u=new URL(String(value));return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password?u.href.slice(0,2000):undefined;}catch{return undefined;}};
export function snapshotEvidence(entity:Entity):Evidence{
 const type=entity.data.type,kind:Evidence['kind']=entity.kind==='metric'?'metric':entity.kind==='workflow-run'?'prior':entity.kind==='draft'?'draft':['social','ad'].includes(type)?'market':type==='format'||entity.tags.includes('format-reference')?'format':'knowledge';
 const extra=kind==='metric'?`\n${JSON.stringify(entity.data).slice(0,2500)}`:'';
 return {id:`entity:${entity.id}`,entityId:entity.id,kind,title:entity.title,excerpt:(entity.content+extra).slice(0,3000),url:safeUrl(entity.data.url),creator:entity.data.creator?String(entity.data.creator).slice(0,200):undefined,platform:entity.data.platform?String(entity.data.platform).slice(0,60):undefined,metrics:entity.data.metrics?metrics(entity.data.metrics):undefined,provenance:String(entity.data.provenance||'Saved workspace source').slice(0,300),capturedAt:now(),publishedAt:typeof entity.data.publishedAt==='string'?entity.data.publishedAt:undefined};
}
export async function researchProviders(workspaceId:string,allowed:boolean){
 const actor=currentAccess();
 if(!allowed||!actor||actor.workspaceId!==workspaceId||actor.itemOnly||actor.role==='viewer'||actor.scopes&&!actor.scopes.includes('research:read'))return [];
 const rows=await query<{id:string;provider:string}>("SELECT id,provider FROM connections WHERE workspace_id=$1 AND status='connected' AND provider IN ('youtube-data','youtube','x') ORDER BY created_at,id",[workspaceId]);
 // One already-authorized account for each available search API.
 const selected:{id:string;provider:string}[]=[];
 for(const row of rows)if(!selected.some(c=>(c.provider.startsWith('youtube')?'youtube':c.provider)===(row.provider.startsWith('youtube')?'youtube':row.provider)))selected.push(row);
 return selected.slice(0,2);
}
export function planResearch(input:string,providers:{id:string;provider:string}[]=[]):ResearchQuery[]{
 let topic=input;try{const fields=JSON.parse(input);if(fields&&typeof fields==='object')topic=String(fields.topic||fields.niche||fields.context||fields.goal||Object.values(fields).filter(v=>typeof v==='string').join(' '));}catch{}
 const words=topic.replace(/[^\p{L}\p{N}\s-]/gu,' ').trim().split(/\s+/).slice(0,16).join(' ').slice(0,160)||'content ideas';
 return [words,`${words} audience questions`,`${words} examples formats`].map((q,index)=>({id:`research-${index+1}`,query:q.slice(0,200),purpose:(['topic','audience','formats'] as const)[index],...(providers.length?{provider:providers[index%providers.length]}:{})}));
}
export function savedResearchMatches(corpus:Evidence[],query:ResearchQuery){
 const words=query.query.toLowerCase().split(/\s+/).filter(w=>w.length>2);
 return corpus.filter(e=>e.kind==='market'||e.kind==='format').map(e=>({e,score:words.reduce((n,w)=>n+(`${e.title} ${e.excerpt} ${e.creator||''}`.toLowerCase().includes(w)?1:0),0)})).filter(row=>row.score>0).sort((a,b)=>b.score-a.score).slice(0,8).map(row=>row.e);
}
function remoteEvidence(connection:StoredConnection,value:{id:string;title:string;content:string;url:string;creator:string;platform:string;metrics:any;publishedAt?:string}):Evidence|null{
 const url=safeUrl(value.url);if(!url||!value.id)return null;
 return {id:'remote:'+createHash('sha256').update(`${value.platform}:${value.id}`).digest('hex').slice(0,40),kind:'market',title:String(value.title||'Untitled result').slice(0,500),excerpt:String(value.content||'').slice(0,3000),url,creator:String(value.creator||'Unknown creator').slice(0,200),platform:value.platform,metrics:metrics(value.metrics),provenance:connection.provider.startsWith('youtube')?'YouTube Data API':'X API recent search',capturedAt:now(),publishedAt:value.publishedAt,connectionId:connection.id};
}
export async function executeResearchQuery(workspaceId:string,task:ResearchQuery,corpus:Evidence[],request:typeof providerRequest=providerRequest):Promise<ResearchResult>{
 const evidence=savedResearchMatches(corpus,task),gaps:string[]=[];
 let source='Actor-visible saved research',providerStatus:ResearchResult['providerStatus']='not-requested';
 if(task.provider){
  try{
   const c=await getConnection(workspaceId,task.provider.id);
   if(c.status!=='connected'||c.provider!==task.provider.provider||!['youtube','youtube-data','x'].includes(c.provider))throw new Error('Provider is no longer connected');
   const credentials=connectionCredentials(c);let values:any[]=[];
   if(c.provider.startsWith('youtube')){
    const suffix=credentials.apiKey?`&key=${encodeURIComponent(credentials.apiKey)}`:'';
    const found=await request(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=8&q=${encodeURIComponent(task.query)}${suffix}`,{token:credentials.accessToken});
    const ids=(found.items||[]).slice(0,8).map((v:any)=>v.id?.videoId).filter((id:unknown)=>typeof id==='string').join(',');
    if(ids){const videos=await request(`https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=${encodeURIComponent(ids)}${suffix}`,{token:credentials.accessToken});values=(videos.items||[]).slice(0,8).map((v:any)=>({id:v.id,title:v.snippet?.title,content:v.snippet?.description,url:`https://www.youtube.com/watch?v=${encodeURIComponent(v.id)}`,creator:v.snippet?.channelId||v.snippet?.channelTitle,platform:'youtube',publishedAt:v.snippet?.publishedAt,metrics:{views:v.statistics?.viewCount,likes:v.statistics?.likeCount,comments:v.statistics?.commentCount}}));}
   }else{
    const found=await request(`https://api.x.com/2/tweets/search/recent?query=${encodeURIComponent(task.query)}&max_results=10&tweet.fields=created_at,public_metrics,author_id&expansions=author_id&user.fields=username`,{token:credentials.accessToken||credentials.apiKey});
    values=(found.data||[]).slice(0,8).map((v:any)=>{const creator=found.includes?.users?.find((u:any)=>u.id===v.author_id)?.username||v.author_id;return {id:v.id,title:String(v.text||'').slice(0,150),content:v.text,url:`https://x.com/${encodeURIComponent(creator||'i')}/status/${encodeURIComponent(v.id)}`,creator,platform:'x',publishedAt:v.created_at,metrics:{likes:v.public_metrics?.like_count,views:v.public_metrics?.impression_count,comments:v.public_metrics?.reply_count,shares:v.public_metrics?.retweet_count}};});
   }
   for(const value of values){const item=remoteEvidence(c,value);if(item&&!evidence.some(e=>e.id===item.id||e.url===item.url))evidence.push(item);}
   source=`${c.provider} and actor-visible saved research`;providerStatus='completed';
   if(!values.length)gaps.push(`${c.provider} returned no results for this bounded query.`);
  }catch{providerStatus='unavailable';gaps.push('The selected research provider was unavailable or its permission changed. Only saved evidence is included.');}
 }
 if(!evidence.length)gaps.push('No matching market evidence was available for this query. No posts or metrics were generated.');
 return {query:task,evidence:evidence.slice(0,16),gaps,source,providerStatus,completedAt:now()};
}
