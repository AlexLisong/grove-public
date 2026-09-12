import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {withTransaction} from './core/db.js';
import {httpError} from './core/security.js';

export type QuotaKind='tokens'|'storage'|'image'|'transcription';
export interface QuotaReservation {id:string;workspaceId:string;kind:QuotaKind;amount:number}
type TokenUsage={inputTokens:number;outputTokens:number;estimated?:boolean};

function configuredLimit(name:string,fallback:number,multiplier=1){
 const value=Number(process.env[name]??fallback)*multiplier;
 if(!Number.isFinite(value)||value<0||!Number.isSafeInteger(Math.floor(value)))throw new Error(`${name} must be a nonnegative, finite limit.`);
 return Math.floor(value);
}
export function quotaLimits(){return {
 tokens:configuredLimit('DAILY_TOKEN_LIMIT',2_000_000),
 storage:configuredLimit('STORAGE_LIMIT_MB',10240,1024*1024),
 image:configuredLimit('DAILY_IMAGE_LIMIT',100),
 transcription:configuredLimit('DAILY_TRANSCRIPTION_LIMIT',100),
};}
async function lockWorkspace(client:PoolClient,workspaceId:string){
 await client.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',['grove-quota',workspaceId]);
}
async function currentUsage(client:PoolClient,workspaceId:string,kind:QuotaKind){
 // Duplicates refer to the same stored object. Trash still retains the bytes.
 const {rows:[used]}=kind==='storage'
  ? await client.query('SELECT COALESCE(SUM(size),0) AS amount FROM (SELECT MAX(size) AS size FROM files WHERE workspace_id=$1 GROUP BY backend,storage_key) stored',[workspaceId])
  : await client.query("SELECT COALESCE(SUM(CASE WHEN quota_kind='tokens' THEN input_tokens+output_tokens ELSE 1 END),0) AS amount FROM usage_events WHERE workspace_id=$1 AND quota_kind=$2 AND created_at>now()-interval '1 day'",[workspaceId,kind]);
 const {rows:[held]}=await client.query('SELECT COALESCE(SUM(amount),0) AS amount FROM quota_reservations WHERE workspace_id=$1 AND kind=$2 AND (expires_at IS NULL OR expires_at>now())',[workspaceId,kind]);
 return {used:Number(used.amount),reserved:Number(held.amount)};
}
export async function reserveQuota(workspaceId:string,kind:QuotaKind,amount:number,metadata:Record<string,unknown>={}):Promise<QuotaReservation>{
 if(!Number.isSafeInteger(amount)||amount<0)throw new Error('A quota reservation must be a nonnegative integer.');
 const limit=quotaLimits()[kind];
 return withTransaction(async client=>{
  await lockWorkspace(client,workspaceId);
  await client.query('DELETE FROM quota_reservations WHERE workspace_id=$1 AND expires_at<=now()',[workspaceId]);
  const {used,reserved}=await currentUsage(client,workspaceId,kind);
  if(amount>limit-used-reserved){
   const message=kind==='storage'
    ? 'This upload exceeds the workspace storage allowance. Retained files and uploads in progress count toward the limit.'
    : `This request exceeds the workspace rolling 24-hour ${kind==='tokens'?'AI token':kind==='image'?'image generation':'transcription'} allowance. Completed and in-progress requests count toward the limit.`;
   throw httpError(429,message,kind==='storage'?'STORAGE_QUOTA_EXCEEDED':'AI_QUOTA_EXCEEDED');
  }
  const reservation={id:randomUUID(),workspaceId,kind,amount};
  // An uncertain provider response remains reserved for the full usage window.
  // Storage never expires automatically: a crashed upload may still own bytes.
  await client.query("INSERT INTO quota_reservations(id,workspace_id,kind,amount,metadata,expires_at) VALUES($1,$2,$3,$4,$5,CASE WHEN $3='storage' THEN NULL ELSE now()+interval '1 day' END)",[reservation.id,workspaceId,kind,amount,JSON.stringify(metadata)]);
  return reservation;
 });
}
export async function releaseQuota(reservation:QuotaReservation){
 await withTransaction(async client=>{
  await lockWorkspace(client,reservation.workspaceId);
  await client.query('DELETE FROM quota_reservations WHERE id=$1 AND workspace_id=$2 AND kind=$3',[reservation.id,reservation.workspaceId,reservation.kind]);
 });
}
export async function settleAiQuota(reservation:QuotaReservation,details:{action:string;model:string},usage:TokenUsage={inputTokens:0,outputTokens:0}){
 if(reservation.kind==='storage')throw new Error('Use storage settlement for stored bytes.');
 if(![usage.inputTokens,usage.outputTokens].every(n=>Number.isSafeInteger(n)&&n>=0))throw new Error('Provider usage must contain nonnegative token counts.');
 await withTransaction(async client=>{
  await lockWorkspace(client,reservation.workspaceId);
  const {rows}=await client.query('DELETE FROM quota_reservations WHERE id=$1 AND workspace_id=$2 AND kind=$3 RETURNING id',[reservation.id,reservation.workspaceId,reservation.kind]);
  if(!rows.length){
   const {rows:existing}=await client.query('SELECT id FROM usage_events WHERE id=$1 AND workspace_id=$2',[reservation.id,reservation.workspaceId]);
   if(existing.length)return;
   throw new Error('AI quota reservation is missing.');
  }
  await client.query('INSERT INTO usage_events(id,workspace_id,action,model,input_tokens,output_tokens,quota_kind,usage_estimated) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[reservation.id,reservation.workspaceId,details.action,details.model,usage.inputTokens,usage.outputTokens,reservation.kind,Boolean(usage.estimated)]);
 });
}
export async function meteredAiRequest<T>(workspaceId:string,details:{kind:Exclude<QuotaKind,'storage'>;amount:number;action:string;model:string},request:()=>Promise<T>,usage?:(result:T)=>TokenUsage):Promise<T>{
 const reservation=await reserveQuota(workspaceId,details.kind,details.amount,{action:details.action,model:details.model});
 let result:T;
 try {result=await request();}
 catch(error:any){
  // A definitive rejected request did not run. Transport failures and 5xx
  // responses may have run, so retain those reservations until the window ends.
  if([400,401,403,404,413,415,422,429].includes(error?.status))await releaseQuota(reservation);
  throw error;
 }
 await settleAiQuota(reservation,details,usage?.(result)??{inputTokens:details.kind==='tokens'?details.amount:0,outputTokens:0,estimated:details.kind==='tokens'});
 return result;
}
export async function settleStorageQuota(reservation:QuotaReservation,file:{id:string;key:string;name:string;mime:string;size:number;backend:'azure'|'local'}){
 if(reservation.kind!=='storage'||file.size!==reservation.amount)throw new Error('Stored bytes do not match their quota reservation.');
 await withTransaction(async client=>{
  await lockWorkspace(client,reservation.workspaceId);
  const {rows}=await client.query("SELECT id FROM quota_reservations WHERE id=$1 AND workspace_id=$2 AND kind='storage' FOR UPDATE",[reservation.id,reservation.workspaceId]);
  if(!rows.length)throw new Error('Storage quota reservation is missing.');
  await client.query('INSERT INTO files(id,workspace_id,storage_key,original_name,mime,size,backend) VALUES($1,$2,$3,$4,$5,$6,$7)',[file.id,reservation.workspaceId,file.key,file.name,file.mime,file.size,file.backend]);
  await client.query('DELETE FROM quota_reservations WHERE id=$1',[reservation.id]);
 });
}
export async function quotaStatus(workspaceId:string){
 const limits=quotaLimits();
 return withTransaction(async client=>{
  await lockWorkspace(client,workspaceId);
  const result={} as Record<QuotaKind,{used:number;reserved:number;limit:number;remaining:number}>;
  for(const kind of ['tokens','storage','image','transcription'] as const){
   const usage=await currentUsage(client,workspaceId,kind);
   result[kind]={...usage,limit:limits[kind],remaining:Math.max(0,limits[kind]-usage.used-usage.reserved)};
  }
  return {window:'rolling-24-hours',...result};
 });
}

// UTF-8 bytes are a conservative bound for text tokens, including uncommon
// Unicode. Per-message framing and request metadata add a safety margin.
export function estimateTextTokens(text:string|object){return Buffer.byteLength(typeof text==='string'?text:JSON.stringify(text),'utf8')+1024;}
