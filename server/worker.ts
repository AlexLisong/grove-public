import {CronExpressionParser} from 'cron-parser';
import {query,withTransaction} from './core/db.js';
import {claimJob,enqueue,finishJob,failJob,stopJobHeartbeats} from './core/jobs.js';
import {runAsActor,currentAccess} from './core/access.js';
import {getEntity,updateEntity,listEntities} from './core/entities.js';
import {executeWorkflow,queueWorkflow} from './ai.js';
import {executeDeepResearch} from './workflow-engine.js';
import {executePublish,executeFollowup,checkPublication} from './publishing.js';
import {syncConnection} from './integrations.js';
import {deliverAutomation,sendDigest} from './extras.js';
import {httpError} from './core/security.js';

let timer:ReturnType<typeof setInterval>|undefined,busy=false,stopped=false,lastSchedule=0;
export function nextOccurrence(cron:string,timezone:string,from=new Date()){
 const interval=CronExpressionParser.parse(cron,{tz:timezone,currentDate:from});return interval.next().toDate();
}
export async function scheduleRoutines(now=new Date()){
 const routines=await query<any>("SELECT id,workspace_id,data,created_by FROM entities WHERE kind='routine' AND deleted_at IS NULL AND data->>'enabled'='true' LIMIT 1000");
 for(const row of routines){
  if(!row.created_by)continue;
  try{await runAsActor(row.workspace_id,row.created_by,async()=>{
   if(currentAccess()!.role==='viewer')throw httpError(403,'The routine owner no longer has editor access.');
   const routine=await getEntity(row.workspace_id,row.id);if(!routine)return;
   const data=routine.data,cron=data.cron||'0 9 * * 1',timezone=data.timezone||'UTC';
   const next=nextOccurrence(cron,timezone,now);
   const after=nextOccurrence(cron,timezone,next);
   if(after.getTime()-next.getTime()<15*60_000)throw httpError(400,'Routines must be at least 15 minutes apart');
   if(!data.nextRunAt){await updateEntity(row.workspace_id,row.id,{data:{...data,nextRunAt:next.toISOString()}});return;}
   if(Date.parse(data.nextRunAt)>now.getTime())return;
   // The job and next slot commit together. A crash cannot advance the clock
   // without leaving durable work, and two schedulers cannot claim one slot.
   await withTransaction(async client=>{
    const {rows:[locked]}=await client.query("SELECT data FROM entities WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL AND data->>'enabled'='true' FOR UPDATE",[row.id,row.workspace_id]);
    if(!locked || locked.data.nextRunAt!==data.nextRunAt)return;
    // The routine job only creates a child workflow. Its completion must not
    // release overlap protection while that child is pending/running. The
    // durable dedupe prefix also finds children created before lastJobId was
    // saved, including jobs from earlier releases or an interrupted parent.
    const {rows:active}=await client.query("SELECT id FROM jobs WHERE workspace_id=$1 AND status IN ('pending','running') AND (data->>'routineId'=$2 OR (kind='workflow' AND (dedupe_key LIKE $3 OR id::text=$4)))",[row.workspace_id,row.id,`routine-result:${row.id}:%`,locked.data.lastJobId||null]);
    if(active.length)return;
    await client.query("INSERT INTO jobs(workspace_id,kind,data,run_at,dedupe_key,max_attempts,actor_user_id) VALUES($1,'routine',$2,$3,$4,3,$5) ON CONFLICT(workspace_id,dedupe_key) DO NOTHING",[row.workspace_id,JSON.stringify({routineId:row.id,slot:data.nextRunAt}),now,`routine:${row.id}:${data.nextRunAt}`,currentAccess()!.userId]);
    await client.query("UPDATE entities SET data=jsonb_set(data,'{nextRunAt}',to_jsonb($3::text)),updated_at=now(),version=version+1 WHERE id=$1 AND workspace_id=$2",[row.id,row.workspace_id,next.toISOString()]);
   });
  });}catch(error){await query("UPDATE entities SET data=data||$2::jsonb WHERE id=$1",[row.id,JSON.stringify({enabled:false,error:(error as Error).message})]);console.error(JSON.stringify({event:'routine_schedule_failed',routineId:row.id,type:(error as Error).name}));}
 }
 // User-opted recurring feed/connector sync: never assumes a workspace owner.
 const connections=await query<any>("SELECT id,workspace_id,data FROM connections WHERE status='connected' AND data->'config'->>'autoSync'='true'");
 for(const connection of connections){
  if(!connection.data.createdBy)continue;
  const previous=Date.parse(connection.data.lastSyncAt||'');if(Number.isFinite(previous)&&now.getTime()-previous<86400000)continue;
  await runAsActor(connection.workspace_id,connection.data.createdBy,()=>enqueue(connection.workspace_id,'connector-sync',{connectionId:connection.id},now,`sync:${connection.id}:${now.toISOString().slice(0,10)}`));
 }
}
export async function executeJob(workspaceId:string,kind:string,data:any,jobId?:string){
 switch(kind){
  case 'workflow':return executeWorkflow(workspaceId,data);
  case 'publish':return executePublish(workspaceId,data);
  case 'first-comment':case 'repost':return executeFollowup(workspaceId,kind,data);
  case 'publish-status':return checkPublication(workspaceId,data);
  case 'connector-sync':return syncConnection(workspaceId,data.connectionId);
  case 'automation-deliver':return deliverAutomation(workspaceId,data);
  case 'send-digest':return sendDigest(workspaceId,data.connectionId,data.text);
  case 'routine':{
   const routine=await getEntity(workspaceId,data.routineId);if(!routine||!routine.data.enabled)return {cancelled:true};
   const rd=routine.data,input=typeof rd.input==='string'?rd.input:JSON.stringify(rd.input||{});
   const queued=await queueWorkflow(workspaceId,rd.workflowId||'idea-engine',{input:input||'Review the selected sources and prepare a useful brief.',sourceIds:rd.sourceIds,customAiId:rd.customAiId,researchEnabled:rd.researchAuthorized===true&&rd.researchEnabled!==false},`routine-result:${routine.id}:${data.slot}`);
   await updateEntity(workspaceId,routine.id,{data:{...rd,lastRunAt:new Date().toISOString(),lastRunId:queued.entity.id,lastJobId:queued.job.id}});
   if(rd.deliveryEnabled&&rd.deliveryConnectionId)await enqueue(workspaceId,'routine-digest',{runId:queued.entity.id,connectionId:rd.deliveryConnectionId},new Date(Date.now()+120000),`digest:${queued.entity.id}`);
   return {entityId:queued.entity.id,jobId:queued.job.id};
  }
  case 'routine-digest':{
   const run=await getEntity(workspaceId,data.runId);if(!run||run.data.status==='failed')return {cancelled:true};if(run.data.status!=='completed')throw httpError(409,'Routine output is still running');
   await enqueue(workspaceId,'send-digest',{connectionId:data.connectionId,text:`${run.title}\n\n${run.content.slice(0,3600)}`},undefined,`send-digest:${run.id}`);return {queued:true};
  }
  case 'deep-research':return executeDeepResearch(workspaceId,data,jobId);
  default:throw httpError(400,`Unsupported job kind: ${kind}`);
 }
}
export async function runWorkerOnce(){
 const job=await claimJob();if(!job)return false;
 try{
  if(!job.actorUserId)throw httpError(403,'This job has no authorized user. Recreate it while signed in.');
  const result=await runAsActor(job.workspaceId,job.actorUserId,()=>{if(currentAccess()!.role==='viewer')throw httpError(403,'The task owner no longer has editor access.');return executeJob(job.workspaceId,job.kind,job.data,job.id);});
  await finishJob(job.id,result,job.leaseToken);
  console.log(JSON.stringify({event:'job_completed',jobId:job.id,kind:job.kind}));
 }catch(error){await failJob(job.id,error as Error,job.leaseToken);console.error(JSON.stringify({event:'job_failed',jobId:job.id,kind:job.kind,type:(error as Error).name}));}
 return true;
}
async function tick(){
 if(busy||stopped)return;busy=true;
 try{if(Date.now()-lastSchedule>30000){lastSchedule=Date.now();await scheduleRoutines();}for(let i=0;i<3&&!stopped;i++){if(!await runWorkerOnce())break;}}
 catch(error){console.error(JSON.stringify({event:'worker_tick_failed',type:(error as Error).name}));}
 finally{busy=false;}
}
export function startWorker(){stopped=false;timer=setInterval(()=>void tick(),2500);timer.unref();void tick();}
export function stopWorker(){stopped=true;if(timer)clearInterval(timer);stopJobHeartbeats();}
