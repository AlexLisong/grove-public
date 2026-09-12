import {clientRateKey} from './core/rate-limit.js';
import {Router} from 'express';
import {z} from 'zod';
import rateLimit from 'express-rate-limit';
import {toFile} from 'openai';
import {requireAuth,requireEditor,requireScope} from './core/auth.js';
import {safeFetch,httpError} from './core/security.js';
import {saveFile,readFile} from './core/files.js';
import {createEntity,getEntity,updateEntity} from './core/entities.js';
import {mediaAiClient,aiStatus} from './ai.js';
import {meteredAiRequest} from './quota.js';

export async function transcribeMediaBuffer(workspaceId:string,buffer:Buffer,name:string,mime:string){
 const provider=mediaAiClient('transcription'),model=process.env.AZURE_OPENAI_TRANSCRIPTION_DEPLOYMENT||'gpt-4o-mini-transcribe';
 const file=await toFile(buffer,name,{type:mime});
 return meteredAiRequest(workspaceId,{kind:'transcription',amount:1,action:'transcription-url',model},()=>provider.audio.transcriptions.create({model,file}));
}

export const mediaToolsRouter=Router();
const guard=[requireAuth,requireEditor,requireScope('ai:run'),rateLimit({keyGenerator:clientRateKey,windowMs:60000,limit:6,standardHeaders:'draft-8',legacyHeaders:false})];
function stripCaptions(text:string){return text.replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/\s+/g,' ').trim();}
mediaToolsRouter.post('/tools/transcript',...guard,async(req,res)=>{
 const {url}=z.object({url:z.url().max(3000)}).parse(req.body),response=await safeFetch(url,{maxBytes:25*1024*1024,timeoutMs:30000}),mime=response.headers.get('content-type')||'';
 if(!response.ok)throw httpError(422,'The source is not publicly accessible. Upload media you are authorized to transcribe.');
 if(/^(audio|video)\//.test(mime)){
  if(!aiStatus().transcription)throw httpError(503,'Transcription is not configured');const buffer=Buffer.from(await response.arrayBuffer()),ext=mime.includes('audio')?'mp3':mime.includes('webm')?'webm':'mp4';
  const result=await transcribeMediaBuffer(req.auth.workspaceId,buffer,`source.${ext}`,mime);
  const entity=await createEntity(req.auth.workspaceId,{kind:'item',title:'Media transcript',content:result.text,visibility:'private',data:{type:'document',url,provenance:'Audio transcription'}});res.json({entity,text:result.text});return;
 }
 const html=await response.text(),host=new URL(url).hostname;
 if(host==='youtu.be'||host==='youtube.com'||host.endsWith('.youtube.com')){
  const match=html.match(/"captionTracks":\s*(\[.*?\])\s*[,}]/s);
  if(match){let tracks:any[]=[];try{tracks=JSON.parse(match[1]);}catch{}
   const track=tracks.find(t=>t.languageCode==='en')||tracks[0];if(track?.baseUrl){const captionUrl=new URL(track.baseUrl);if(captionUrl.hostname!=='youtube.com'&&!captionUrl.hostname.endsWith('.youtube.com'))throw httpError(422,'Caption source could not be verified');captionUrl.searchParams.set('fmt','json3');const captions=await safeFetch(captionUrl.toString(),{maxBytes:5*1024*1024});const raw=await captions.text();let text='';try{const json=JSON.parse(raw);text=(json.events||[]).flatMap((e:any)=>(e.segs||[]).map((s:any)=>s.utf8||'')).join(' ').replace(/\s+/g,' ').trim();}catch{text=stripCaptions(raw);}if(text){const entity=await createEntity(req.auth.workspaceId,{kind:'item',title:'YouTube transcript',content:text.slice(0,900000),visibility:'private',data:{type:'document',url,language:track.languageCode,provenance:'Publicly available YouTube captions'}});res.json({entity,text:entity.content});return;}}
  }
 }
 throw httpError(422,'No public transcript was available from this URL. Upload the original audio/video in Library, then choose Transcribe. Login-only media is not fetched from your browser session.','TRANSCRIPT_UNAVAILABLE');
});
mediaToolsRouter.post('/ai/image/edit',...guard,async(req,res)=>{
 const b=z.object({imageId:z.uuid(),prompt:z.string().min(1).max(4000)}).parse(req.body),original=await getEntity(req.auth.workspaceId,b.imageId);if(!original)throw httpError(404,'Image not found');const file=await readFile(req.auth.workspaceId,b.imageId);if(!file.mime.startsWith('image/'))throw httpError(400,'Choose an image');
 const provider=mediaAiClient('image'),model=process.env.AZURE_OPENAI_IMAGE_DEPLOYMENT||'gpt-image-1.5',image=await toFile(file.buffer,file.name,{type:file.mime});
 const result=await meteredAiRequest(req.auth.workspaceId,{kind:'image',amount:1,action:'image-edit',model},()=>provider.images.edit({model,image,prompt:b.prompt,n:1}));const encoded=result.data?.[0]?.b64_json;if(!encoded)throw httpError(502,'The image provider returned no image');
 const entity=await saveFile(req.auth.workspaceId,{buffer:Buffer.from(encoded,'base64'),name:`grove-edit-${Date.now()}.png`,mime:'image/png',visibility:'private'});res.json({entity:await updateEntity(req.auth.workspaceId,entity.id,{data:{...entity.data,sourceId:b.imageId,prompt:b.prompt,generated:true}})});
});
