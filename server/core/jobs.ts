import {randomUUID} from 'node:crypto';
import {Router} from 'express';
import {z} from 'zod';
import type {Job} from '../../shared/types.js';
import {query,withTransaction} from './db.js';
import {requireAuth,requireEditor,requireScope} from './auth.js';
import {httpError} from './security.js';
import {currentAccess} from './access.js';

export interface ClaimedJob extends Job {workspaceId:string;leaseToken:string;actorUserId:string|null}
const running = new Map<string,{token:string;heartbeat:ReturnType<typeof setInterval>}>();
const iso=(value:any) => value instanceof Date ? value.toISOString() : value;
function mapJob(row:any):Job & {workspaceId:string;leaseToken?:string} {
  return {id:row.id,workspaceId:row.workspace_id,actorUserId:row.actor_user_id,kind:row.kind,status:row.status,data:row.data,result:row.result || undefined,error:row.error || undefined,runAt:iso(row.run_at),attempts:row.attempts,createdAt:iso(row.created_at),...(row.lease_token ? {leaseToken:row.lease_token} : {})} as any;
}
const sideEffectKind = (kind:string) => /^publish$|send|deliver|automation|^first-comment$|^repost$/i.test(kind);
export async function enqueue(workspaceId:string,kind:string,data:Record<string,any>,runAt?:string|Date,dedupeKey?:string):Promise<Job> {
  z.string().min(1).max(100).parse(kind);
  z.record(z.string(),z.unknown()).refine(v => Buffer.byteLength(JSON.stringify(v))<=1_000_000,'Job data exceeds 1 MB.').parse(data);
  if (dedupeKey) z.string().max(300).parse(dedupeKey);
  const date=runAt ? new Date(runAt) : null;
  if (date && !Number.isFinite(date.getTime())) throw httpError(400,'Invalid scheduled time.');
  const actor=currentAccess();if(actor && actor.workspaceId!==workspaceId) throw httpError(403,'Job actor belongs to a different workspace.');
  const [row]=await query('INSERT INTO jobs(workspace_id,kind,data,run_at,dedupe_key,max_attempts,actor_user_id) VALUES($1,$2,$3,COALESCE($4,now()),$5,$6,$7) ON CONFLICT(workspace_id,dedupe_key) DO UPDATE SET dedupe_key=EXCLUDED.dedupe_key RETURNING *', [workspaceId,kind,JSON.stringify(data),date,dedupeKey || null,sideEffectKind(kind) ? 1 : 3,actor?.userId || null]);
  return mapJob(row);
}
export async function claimJob():Promise<ClaimedJob|null> {
  const token=randomUUID();
  const row=await withTransaction(async client => {
    // A process crash after a provider accepted a send cannot be distinguished
    // from a crash before the send. Mark those jobs for human inspection.
    await client.query("UPDATE jobs SET status='failed',error='The worker stopped during an external delivery. Verify the provider outcome before creating another publish attempt.',lease_until=NULL,lease_token=NULL,updated_at=now() WHERE status='running' AND lease_until<now() AND (kind ~* '^publish$|send|deliver|automation|^first-comment$|^repost$' OR attempts>=max_attempts)");
    const {rows:[candidate]}=await client.query("SELECT * FROM jobs WHERE ((status='pending' AND run_at<=now()) OR (status='running' AND lease_until<now())) AND attempts<max_attempts ORDER BY run_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1");
    if (!candidate) return null;
    const {rows:[claimed]}=await client.query("UPDATE jobs SET status='running',attempts=attempts+1,lease_until=now()+interval '5 minutes',lease_token=$2,updated_at=now() WHERE id=$1 RETURNING *", [candidate.id,token]);
    return claimed;
  });
  if (!row) return null;
  const existing=running.get(row.id);if(existing) clearInterval(existing.heartbeat);
  const heartbeat=setInterval(() => {
    query("UPDATE jobs SET lease_until=now()+interval '5 minutes',updated_at=now() WHERE id=$1 AND lease_token=$2 AND status='running'", [row.id,token]).catch(error => console.error('Job lease heartbeat failed',{jobId:row.id,message:error.message}));
  },60_000);
  heartbeat.unref();running.set(row.id,{token,heartbeat});
  return mapJob(row) as ClaimedJob;
}
function finishHeartbeat(id:string,token?:string) {
  const active=running.get(id);
  if (active && (!token || active.token===token)) {clearInterval(active.heartbeat);running.delete(id);}
}
export async function finishJob(id:string,result:Record<string,any> = {},leaseToken?:string) {
  const token=leaseToken || running.get(id)?.token;
  if (!token) throw httpError(409,'This process does not own the job lease.','JOB_LEASE');
  const rows=await query("UPDATE jobs SET status='completed',result=$2,error=NULL,lease_until=NULL,lease_token=NULL,updated_at=now() WHERE id=$1 AND status='running' AND lease_token=$3 RETURNING id", [id,JSON.stringify(result),token]);
  finishHeartbeat(id,token);
  if (!rows.length) throw httpError(409,'The job lease changed before completion.','JOB_LEASE');
}
export async function failJob(id:string,error:string|Error,leaseToken?:string) {
  const token=leaseToken || running.get(id)?.token;
  if (!token) throw httpError(409,'This process does not own the job lease.','JOB_LEASE');
  const message=(typeof error==='string' ? error : error.message).slice(0,4000);
  const rows=await query("UPDATE jobs SET status=CASE WHEN attempts<max_attempts AND kind !~* '^publish$|send|deliver|automation|^first-comment$|^repost$' THEN 'pending' ELSE 'failed' END,error=$2,run_at=now()+(LEAST(3600,30*power(2,attempts)) * interval '1 second'),lease_until=NULL,lease_token=NULL,updated_at=now() WHERE id=$1 AND status='running' AND lease_token=$3 RETURNING id", [id,message,token]);
  finishHeartbeat(id,token);
  if (!rows.length) throw httpError(409,'The job lease changed before failure was recorded.','JOB_LEASE');
}
export function stopJobHeartbeats() {for (const active of running.values()) clearInterval(active.heartbeat);running.clear();}

export const jobRouter=Router();
jobRouter.get('/jobs',requireAuth,requireScope('workspace:read'),async (req,res) => {
  const rows=await query('SELECT * FROM jobs WHERE workspace_id=$1 AND (actor_user_id=$2 OR actor_user_id IS NULL) ORDER BY created_at DESC LIMIT 200',[req.auth!.workspaceId,req.auth.userId]);
  res.json({jobs:rows.map(mapJob).map(({leaseToken,...job}) => job)});
});
jobRouter.get('/jobs/:id',requireAuth,requireScope('workspace:read'),async (req,res) => {
  const [row]=await query('SELECT * FROM jobs WHERE workspace_id=$1 AND id=$2 AND (actor_user_id=$3 OR actor_user_id IS NULL)',[req.auth!.workspaceId,z.uuid().parse(req.params.id),req.auth.userId]);
  if(!row) throw httpError(404,'Job not found.');
  const {leaseToken,...job}=mapJob(row);res.json({job});
});
jobRouter.post('/jobs/:id/cancel',requireAuth,requireEditor,requireScope('workspace:write'),async (req,res) => {
  const [row]=await query("UPDATE jobs SET status='cancelled',updated_at=now() WHERE workspace_id=$1 AND id=$2 AND status='pending' AND (actor_user_id=$3 OR actor_user_id IS NULL) RETURNING *",[req.auth!.workspaceId,z.uuid().parse(req.params.id),req.auth.userId]);
  if(!row) throw httpError(409,'Only a pending job can be cancelled.');res.json({job:mapJob(row)});
});
