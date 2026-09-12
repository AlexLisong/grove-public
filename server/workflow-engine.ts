import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {pool,query,withTransaction} from './core/db.js';
import {currentAccess,entityAccessPredicate,isExclusivePrivateTarget} from './core/access.js';
import {createEntity,entityInputSchema,getEntity,listEntities,mapEntity,updateEntity} from './core/entities.js';
import {httpError} from './core/security.js';
import {workflows} from './catalog.js';
import {generateStructured,resolveSources} from './ai.js';
import {executeResearchQuery,planResearch,researchProviders,snapshotEvidence,type ResearchQuery,type ResearchResult} from './workflow-research.js';
import {evidenceReferences,validateWorkflowOutput,workflowSchemas,type Evidence,type WorkflowName} from './workflow-schema.js';
import type {Entity,EntityInput,Job,Citation} from '../shared/types.js';
import type {providerRequest} from './integrations.js';

const stamp=()=>new Date().toISOString();
const settingsSchema=z.object({input:z.string().max(30000).default(''),sourceIds:z.array(z.uuid()).max(80).default([]),customAiId:z.uuid().nullable().default(null),researchEnabled:z.boolean().default(true)}).strict();
export type WorkflowInput={input?:string;sourceIds?:string[];customAiId?:string;researchEnabled?:boolean};
interface Context {evidence:Evidence[];corpus:Evidence[];queries:ResearchQuery[];gaps:string[];restricted:boolean;customInstruction:string;priorHooks:string[];capturedAt:string}
interface Step {id:string;title:string;status:'pending'|'running'|'completed'|'failed';attempts:number;startedAt?:string;completedAt?:string;error?:string;result?:any}
interface Execution {version:1;steps:Step[];startedAt:string;completedAt?:string}
export interface WorkflowDependencies {request?:typeof providerRequest;afterStep?:(id:string)=>Promise<void>}
function actorFor(workspaceId:string){const actor=currentAccess();if(!actor||actor.workspaceId!==workspaceId||actor.role==='viewer')throw httpError(403,'An authorized workspace editor is required.','ACTOR_REQUIRED');return actor;}
function named(id:string){const template=workflows.find(w=>w.id===id);if(!template)throw httpError(404,'Workflow not found');return template;}
function policy(workspaceId:string,requested=true){const actor=actorFor(workspaceId);return {liveResearch:requested&&!actor.itemOnly&&(!actor.scopes||actor.scopes.includes('research:read')),actorUserId:actor.userId};}

export async function getWorkflowSettings(workspaceId:string,id:string){
 named(id);const actor=currentAccess();if(!actor||actor.workspaceId!==workspaceId)throw httpError(403,'Sign in to read workflow settings.');
 const settings=(await listEntities(workspaceId,{kind:'item',tag:'workflow-settings'})).find(e=>e.createdBy===actor.userId&&e.data.workflowId===id);
 return {settings:settingsSchema.parse(settings?.data.settings||{}),entityId:settings?.id||null};
}
export async function saveWorkflowSettings(workspaceId:string,id:string,value:unknown){
 actorFor(workspaceId);const settings=settingsSchema.parse(value);await resolveSources(workspaceId,settings.sourceIds,settings.customAiId||undefined);
 const existing=await getWorkflowSettings(workspaceId,id);
 if(existing.entityId&&!await isExclusivePrivateTarget(workspaceId,existing.entityId))throw httpError(409,'Shared settings cannot receive private source selections. Create private settings instead.');
 const input={title:`${named(id).title} settings`,content:settings.input,data:{type:'workflow-settings',workflowId:id,settings},tags:['workflow-settings'],visibility:'private' as const};
 const entity=existing.entityId?await updateEntity(workspaceId,existing.entityId,input):await createEntity(workspaceId,{kind:'item',...input});
 return {settings,entityId:entity.id};
}
async function privateRow(client:PoolClient,workspaceId:string,actorId:string,input:EntityInput,id=randomUUID()){
 const clean=entityInputSchema.parse({...input,visibility:'private'});
 const {rows:[row]}=await client.query('INSERT INTO entities(id,workspace_id,kind,title,content,data,tags,visibility,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,\'private\',$8) RETURNING *',[id,workspaceId,clean.kind,clean.title||'Untitled',clean.content||'',JSON.stringify(clean.data||{}),clean.tags||[],actorId]);
 const entity=mapEntity(row);await client.query('INSERT INTO entity_history(entity_id,workspace_id,version,snapshot) VALUES($1,$2,$3,$4)',[id,workspaceId,entity.version,JSON.stringify(entity)]);return entity;
}
function jobResponse(row:any):Job{return {id:row.id,kind:row.kind,status:row.status,data:row.data,result:row.result||undefined,error:row.error||undefined,runAt:new Date(row.run_at).toISOString(),attempts:row.attempts,createdAt:new Date(row.created_at).toISOString()};}
async function queueRun(workspaceId:string,name:WorkflowName,input:WorkflowInput&{input:string;mode?:string;title?:string},dedupeKey?:string){
 const actor=actorFor(workspaceId);await resolveSources(workspaceId,input.sourceIds||[],input.customAiId);
 if(dedupeKey)z.string().max(300).parse(dedupeKey);
 const request={...input,workflowId:name,sourceIds:input.sourceIds||[],policy:policy(workspaceId,input.researchEnabled!==false)};
 return withTransaction(async client=>{
  if(dedupeKey){
   await client.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',[workspaceId,`workflow-queue:${dedupeKey}`]);
   const {rows:[existing]}=await client.query('SELECT * FROM jobs WHERE workspace_id=$1 AND dedupe_key=$2',[workspaceId,dedupeKey]);
   if(existing){if(existing.actor_user_id!==actor.userId)throw httpError(404,'Workflow run is unavailable.');const entity=await getEntity(workspaceId,existing.data.runId);if(!entity)throw httpError(409,'The previous workflow run was removed. Create a new run.');return {job:jobResponse(existing),entity};}
  }
  const jobId=randomUUID(),title=input.title||(name==='deep-research'?'Research synthesis':named(name).title)+` · ${stamp().slice(0,10)}`;
  const entity=await privateRow(client,workspaceId,actor.userId,{kind:'workflow-run',title,content:input.input,data:{workflowId:name,status:'pending',sourceIds:request.sourceIds,customAiId:input.customAiId,request,jobId}});
  const {rows:[job]}=await client.query('INSERT INTO jobs(id,workspace_id,kind,data,dedupe_key,max_attempts,actor_user_id) VALUES($1,$2,$3,$4,$5,3,$6) RETURNING *',[jobId,workspaceId,name==='deep-research'?'deep-research':'workflow',JSON.stringify({...request,runId:entity.id}),dedupeKey||null,actor.userId]);
  return {job:jobResponse(job),entity};
 });
}
export async function queueStructuredWorkflow(workspaceId:string,id:string,body:WorkflowInput,dedupeKey?:string){
 named(id);const saved=(await getWorkflowSettings(workspaceId,id)).settings;
 const input={input:body.input??saved.input,sourceIds:body.sourceIds??saved.sourceIds,customAiId:body.customAiId??(body.sourceIds!==undefined?undefined:saved.customAiId||undefined),researchEnabled:body.researchEnabled??saved.researchEnabled};
 z.string().min(1,'Save workflow instructions or supply input for this run.').max(30000).parse(input.input);
 return queueRun(workspaceId,id as WorkflowName,input,dedupeKey);
}
export async function queueDeepResearch(workspaceId:string,body:{input:string;sourceIds?:string[];customAiId?:string;mode?:string;title?:string}){return queueRun(workspaceId,'deep-research',body);}

async function captureContext(workspaceId:string,run:Entity,request:any):Promise<Context>{
 const resolved=await resolveSources(workspaceId,request.sourceIds||[],request.customAiId),restricted=!!request.customAiId||!!request.sourceIds?.length;
 const visible=restricted?resolved.sources:await listEntities(workspaceId);
 const knowledge=visible.filter(e=>!e.archived&&['item','voice','creator','brand','table'].includes(e.kind)&&!['workflow-settings','workflow-evidence'].includes(e.data.type));
 const words=String(request.input).toLowerCase().split(/\W+/).filter((w:string)=>w.length>3).slice(0,30);
 const scored=knowledge.map(e=>({e,score:words.filter((w:string)=>`${e.title} ${e.content}`.toLowerCase().includes(w)).length})).sort((a,b)=>b.score-a.score);
 const selected=(restricted?knowledge:scored.filter(row=>row.score>0).map(row=>row.e)).slice(0,24);
 const metrics=visible.filter(e=>e.kind==='metric').slice(0,20),past=visible.filter(e=>e.kind==='workflow-run'&&e.id!==run.id&&e.data.status==='completed'&&e.data.workflowId===request.workflowId).slice(0,3),strategy=visible.filter(e=>e.kind==='item'&&e.data.artifactType==='strategy').slice(0,2),drafts=visible.filter(e=>e.kind==='draft').slice(0,20);
 const evidence=[...new Map([...selected,...metrics,...past,...strategy,...drafts].map(e=>[e.id,snapshotEvidence(e)])).values()].slice(0,64);
 const corpus=knowledge.filter(e=>['social','ad','format'].includes(e.data.type)||e.tags.includes('format-reference')).slice(0,300).map(snapshotEvidence);
 const researchAllowed=!restricted&&request.policy?.liveResearch===true&&request.mode!=='synthesis';
 const providers=await researchProviders(workspaceId,researchAllowed),gaps:string[]=[];
 if(restricted)gaps.push('Only explicitly selected sources or custom assistant knowledge were inspected. Live provider search and other workspace material were excluded.');
 else if(!researchAllowed)gaps.push('Live market research is disabled for this run or not permitted by its authorization.');
 else if(!providers.length)gaps.push('No supported connected search provider was available. Research uses saved authorized imports only; no seven-network corpus is assumed.');
 if(!metrics.length)gaps.push('Owned performance metrics are unavailable. Missing metrics are unknown, not zero.');
 if(!evidence.length&&!corpus.length)gaps.push('No source evidence is available. Creative suggestions must be labelled assumptions.');
 const priorHooks=[...drafts.map(e=>e.title),...past.flatMap(e=>e.data.execution?.steps?.find((s:Step)=>s.id==='synthesis')?.result?.ideas?.map((i:any)=>i.hook)||[])].slice(0,100);
 // The source pool is queried from the current ACL on each query, not stored in
 // full in every run. This also avoids copying an entire private library.
 return {evidence,corpus:corpus.slice(0,120),queries:planResearch(request.input,providers),gaps,restricted,customInstruction:resolved.custom?`${String(resolved.custom.data.instructions||resolved.custom.content)}\nVoice: ${String(resolved.custom.data.voice||'')}`.slice(0,12000):'',priorHooks,capturedAt:stamp()};
}
async function assertSnapshotAccess(workspaceId:string,request:any,context:Context,extra:Evidence[]=[]){
 const actor=actorFor(workspaceId),[membership]=await query<{role:string;item_only:boolean}>('SELECT role,item_only FROM memberships WHERE workspace_id=$1 AND user_id=$2',[workspaceId,actor.userId]);
 if(!membership||membership.role==='viewer'||Boolean(membership.item_only)!==Boolean(actor.itemOnly))throw httpError(403,'The workflow owner no longer has the required workspace access.','ACTOR_REVOKED');
 const ids=[...new Set([...context.evidence,...context.corpus,...extra].map(e=>e.entityId).filter((id):id is string=>!!id))];
 if(ids.length){const predicate=entityAccessPredicate('e',3);const rows=await query<{id:string}>(`SELECT e.id FROM entities e WHERE e.workspace_id=$1 AND e.id=ANY($2::uuid[]) AND e.deleted_at IS NULL AND ${predicate.sql}`,[workspaceId,ids,...predicate.params]);if(rows.length!==ids.length)throw httpError(403,'A saved workflow source is no longer accessible. Create a new run with current sources.','WORKFLOW_SOURCE_REVOKED');}
 if(context.restricted){const allowed=new Set((await resolveSources(workspaceId,request.sourceIds||[],request.customAiId)).sources.map(e=>e.id));if(ids.some(id=>!allowed.has(id)))throw httpError(403,'The selected source scope changed. Create a new run using current selections.','WORKFLOW_SOURCE_REVOKED');}
}
function initialExecution():Execution{return {version:1,startedAt:stamp(),steps:[{id:'context',title:'Snapshot selected knowledge and owned results'},{id:'research-1',title:'Investigate the topic'},{id:'research-2',title:'Investigate audience needs'},{id:'research-3',title:'Compare examples and formats'},{id:'synthesis',title:'Validate the structured plan'},{id:'artifacts',title:'Save private results and unapproved drafts'}].map(s=>({...s,status:'pending',attempts:0}))};}
function mergedEvidence(context:Context,execution:Execution){
 const map=new Map(context.evidence.map(e=>[e.id,e]));for(const step of execution.steps.filter(s=>s.id.startsWith('research-')&&s.status==='completed'))for(const e of (step.result as ResearchResult).evidence)if(!map.has(e.id))map.set(e.id,e);
 let size=0;const selected:Evidence[]=[];
 for(const item of map.values()){const snapshot={...item,excerpt:item.excerpt.slice(0,1800)},cost=JSON.stringify(snapshot).length;if(selected.length>=100||size+cost>145000)continue;selected.push(snapshot);size+=cost;}
 if(selected.length<map.size&&!context.gaps.includes('Evidence exceeded the bounded report context; some source snapshots were omitted.'))context.gaps.push('Evidence exceeded the bounded report context; some source snapshots were omitted.');
 return selected;
}
const md=(text:string)=>text.replace(/([\\[\]])/g,'\\$1');
function renderReport(name:WorkflowName,output:any,evidence:Evidence[]){
 const ref=(ids:string[])=>ids.length?' '+ids.map(id=>`[${evidence.findIndex(e=>e.id===id)+1}]`).join(' '):'';
 let body=`${output.summary}\n`;
 const section=(title:string,content:string)=>{body+=`\n## ${title}\n\n${content}\n`;};
 const list=(values:string[])=>values.map(v=>`- ${v}`).join('\n')||'None available.';
 if(name==='weekly-strategist'){
  section('Owned performance',output.ownedPerformance.summary+ref(output.ownedPerformance.evidenceIds));section('Market patterns',output.patterns.map((p:any)=>`- ${p.pattern}${ref(p.evidenceIds)}`).join('\n')||'Insufficient evidence from distinct creators.');section('Three plays',output.plays.map((p:any,i:number)=>`${i+1}. **${p.hook}** — ${p.action}${ref(p.evidenceIds)}`).join('\n'));section('Weekly bet',`${output.bet.hypothesis}${ref(output.bet.evidenceIds)}\n\nMeasure: ${output.bet.metric}\n\nTarget: ${output.bet.target}\n\nReview: ${output.bet.reviewDate}`);section('Previous bet',`${output.previousBet.status}: ${output.previousBet.reason}${ref(output.previousBet.evidenceIds)}`);
 }else if(name==='head-of-content'){
  section('Proposed slate — review required',output.slate.map((d:any,i:number)=>`### ${i+1}. ${d.title}\n\n${d.platform} · ${d.suggestedDay||'Unscheduled'}${d.experiment?' · Experiment':''}\n\n${d.content}\n\n${d.rationale}${ref(d.evidenceIds)}`).join('\n\n')||'No sufficiently supported drafts.');section('Change log',list(output.changeLog));
 }else if(name==='personal-brand-strategist'){
  section('Positioning',output.positioning);section('Audience needs',list(output.audienceNeeds));section('Origin story',output.originStory);section('Topic tree',output.topicTree.map((t:any)=>`### ${t.topic}\n\n${list(t.angles)}`).join('\n\n'));section('Content directions',list(output.contentDirections));section('Monetization hypotheses',list(output.monetizationOptions));section('Reference posts',output.referenceEvidenceIds.map((id:string)=>`- ${byEvidence(evidence,id).title}${ref([id])}`).join('\n')||'No real market reference posts supplied.');section('First posts — review required',output.firstPosts.map((d:any)=>`### ${d.title}\n\n${d.content}\n\n${d.rationale}${ref(d.evidenceIds)}`).join('\n\n')||'No sufficiently supported drafts.');section('Interview questions',list(output.interviewQuestions));
 }else if(name==='content-command-center'){
  for(const station of output.stations)section(station.station,`${station.brief}${ref(station.evidenceIds)}\n\n${list(station.actions)}`);section('Repurposing draft',output.repurpose.content+ref(output.repurpose.sourceEvidenceId?[output.repurpose.sourceEvidenceId]:[])||'No supplied source to repurpose.');section('Digest — saved text only',output.digest);
 }else if(name==='idea-engine'){
  section('Idea cards',output.ideas.map((idea:any,i:number)=>`### ${i+1}. ${idea.hook}${i===output.strongestIndex?' · Strongest choice':''}\n\n${idea.angle}\n\nAudience: ${idea.audienceValue}\n\nFormat: ${idea.format}\n\nEvidence legs: ${idea.legs.map((leg:any)=>leg.kind+ref([leg.evidenceId])).join('; ')}\n\nFirst step: ${idea.firstStep}`).join('\n\n')||'Not enough distinct evidence legs to generate supported idea cards.');
 }else{section('Findings',output.findings.map((f:any)=>`- ${f.claim}${ref(f.evidenceIds)}`).join('\n')||'No supported factual findings.');section('Disagreements',output.disagreements.map((d:any)=>`- ${d.description}${ref(d.evidenceIds)}`).join('\n')||'No supported disagreements identified.');section('Next steps',list(output.nextSteps));}
 section('Evidence gaps',list(output.gaps));
 section('Sources',evidence.map((e,i)=>`${i+1}. ${md(e.title)}${e.url?` — ${e.url}`:''}\n   ${e.kind}; ${e.provenance}; captured ${e.capturedAt}${e.creator?`; creator ${md(e.creator)}`:''}`).join('\n')||'No sources available.');
 return body;
}
function byEvidence(evidence:Evidence[],id:string){const e=evidence.find(e=>e.id===id);if(!e)throw httpError(502,'Unavailable evidence reference.');return e;}
async function commitArtifacts(workspaceId:string,run:Entity,execution:Execution,name:WorkflowName,output:any,evidence:Evidence[],request:any){
 const actor=actorFor(workspaceId),context=execution.steps.find(s=>s.id==='context')!.result as Context;
 await assertSnapshotAccess(workspaceId,request,context,evidence);
 if(!await isExclusivePrivateTarget(workspaceId,run.id))throw httpError(409,'Workflow runs containing private context must remain private to their owner.');
 return withTransaction(async client=>{
  const {rows:[current]}=await client.query('SELECT * FROM entities WHERE id=$1 AND workspace_id=$2 AND created_by=$3 AND deleted_at IS NULL FOR UPDATE',[run.id,workspaceId,actor.userId]);
  if(!current)throw httpError(404,'Private workflow run was removed.');
  if(current.data.status==='completed'&&current.data.outputId)return current.data.result;
  const {rows:members}=await client.query("SELECT user_id FROM memberships WHERE workspace_id=$1 AND user_id=$2 AND role<>'viewer'",[workspaceId,actor.userId]);if(!members.length)throw httpError(403,'The workflow owner no longer has editor access.');
  // Everything below uses this one client. A failed draft, history, report or
  // run update rolls back every artifact, including the notification.
  const used=new Set(evidenceReferences(output)),cited=evidence.filter(e=>used.has(e.id));
  const evidenceEntities=new Map<string,string>();
  for(const e of evidence){if(e.entityId){evidenceEntities.set(e.id,e.entityId);continue;}const item=await privateRow(client,workspaceId,actor.userId,{kind:'item',title:e.title,content:e.excerpt,tags:['workflow-evidence','research'],data:{type:'social',artifactType:'workflow-evidence',runId:run.id,workflowId:name,url:e.url,creator:e.creator,platform:e.platform,metrics:e.metrics,provenance:e.provenance,publishedAt:e.publishedAt,capturedAt:e.capturedAt,evidenceId:e.id}});evidenceEntities.set(e.id,item.id);}
  const citations:Citation[]=cited.map(e=>({id:evidenceEntities.get(e.id)!,title:e.title,url:e.url,excerpt:e.excerpt.slice(0,240)}));
  const sourceIds=[...new Set(evidence.map(e=>evidenceEntities.get(e.id)!))],base={workflowId:name,runId:run.id,sourceIds,citations};
  const drafts:string[]=[],cards:string[]=[];
  for(const draft of output.slate||output.firstPosts||[]){const entity=await privateRow(client,workspaceId,actor.userId,{kind:'draft',title:draft.title,content:draft.content,tags:['workflow'],data:{...base,status:'draft',platforms:[draft.platform],variants:{},mediaIds:[],connectionIds:[],evidenceIds:draft.evidenceIds,rationale:draft.rationale,experiment:draft.experiment,suggestedDay:draft.suggestedDay}});drafts.push(entity.id);}
  for(const idea of output.ideas||[]){const entity=await privateRow(client,workspaceId,actor.userId,{kind:'item',title:idea.hook,content:`${idea.angle}\n\nAudience: ${idea.audienceValue}\n\nFormat: ${idea.format}\n\nFirst step: ${idea.firstStep}`,tags:['workflow','idea'],data:{...base,type:'card',artifactType:'idea',idea,evidenceIds:idea.legs.map((leg:any)=>leg.evidenceId)}});cards.push(entity.id);}
  const report=renderReport(name,output,evidence),document=await privateRow(client,workspaceId,actor.userId,{kind:'item',title:run.title,content:report,tags:['workflow',name],data:{...base,type:'document',artifactType:['weekly-strategist','personal-brand-strategist'].includes(name)?'strategy':name==='content-command-center'?'command-center':'report',structuredOutput:output,draftIds:drafts,ideaIds:cards,snapshotAt:context.capturedAt}});
  const result={entityId:document.id,documentId:document.id,runId:run.id,draftIds:drafts,ideaIds:cards,evidenceIds:sourceIds};
  const artifacts=execution.steps.find(s=>s.id==='artifacts')!;artifacts.status='completed';artifacts.result=result;artifacts.completedAt=stamp();execution.completedAt=stamp();
  const data={...current.data,status:'completed',outputId:document.id,result,citations,execution,completedAt:stamp(),error:null};
  const {rows:[updated]}=await client.query('UPDATE entities SET content=$4,data=$5,version=version+1,updated_at=now() WHERE id=$1 AND workspace_id=$2 AND created_by=$3 RETURNING *',[run.id,workspaceId,actor.userId,report,JSON.stringify(data)]);
  await client.query('INSERT INTO entity_history(entity_id,workspace_id,version,snapshot) VALUES($1,$2,$3,$4)',[run.id,workspaceId,updated.version,JSON.stringify(mapEntity(updated))]);
  await privateRow(client,workspaceId,actor.userId,{kind:'notification',title:`${run.title} is ready`,data:{entityId:document.id,runId:run.id,read:false}});
  return result;
 });
}

async function recordRunFailure(workspaceId:string,runId:string,actorId:string,error:unknown){
 const message=error instanceof Error?error.message:'Workflow failed';
 await withTransaction(async client=>{
  const {rows:[row]}=await client.query('SELECT * FROM entities WHERE workspace_id=$1 AND id=$2 AND created_by=$3 AND deleted_at IS NULL FOR UPDATE',[workspaceId,runId,actorId]);
  if(!row||row.data.status==='completed')return;
  const execution=row.data.execution as Execution|undefined;
  for(const step of execution?.steps||[])if(step.status==='running'){step.status='failed';step.error=message;}
  // Failure metadata must remain writable after a source ACL is revoked. It
  // preserves every reference and never re-reads or copies revoked content.
  const {rows:[updated]}=await client.query('UPDATE entities SET data=$4,updated_at=now(),version=version+1 WHERE workspace_id=$1 AND id=$2 AND created_by=$3 RETURNING *',[workspaceId,runId,actorId,JSON.stringify({...row.data,execution,status:'failed',error:message})]);
  await client.query('INSERT INTO entity_history(entity_id,workspace_id,version,snapshot) VALUES($1,$2,$3,$4)',[runId,workspaceId,updated.version,JSON.stringify(mapEntity(updated))]);
 });
}

export async function executeStructuredWorkflow(workspaceId:string,data:any,dependencies:WorkflowDependencies={}){
 const actor=actorFor(workspaceId),lock=await pool.connect();
 let locked=false;
 try{
  const {rows:[claim]}=await lock.query('SELECT pg_try_advisory_lock(hashtext($1),hashtext($2)) AS acquired',['grove-workflow',String(data.runId)]);
  if(!claim.acquired)throw httpError(409,'This workflow is already executing.','WORKFLOW_RUNNING');locked=true;
  let run=await getEntity(workspaceId,data.runId);
  if(!run||run.kind!=='workflow-run'||run.createdBy!==actor.userId)throw httpError(404,'Workflow run no longer exists for this actor.');
  if(!await isExclusivePrivateTarget(workspaceId,run.id))throw httpError(409,'Workflow source context must remain private to its owner.');
  if(run.data.status==='completed'&&run.data.outputId){if(!await getEntity(workspaceId,run.data.outputId))throw httpError(409,'The completed output was removed. Create a new workflow run.');return run.data.result||{entityId:run.data.outputId,documentId:run.data.outputId,runId:run.id};}
  const request=run.data.request||{...data,policy:{liveResearch:false}},name=request.workflowId as WorkflowName;
  if(!workflowSchemas[name])throw httpError(404,'Workflow not found');
  const execution:Execution=run.data.execution?.version===1?run.data.execution:initialExecution();
  const persist=async()=>{run=await updateEntity(workspaceId,run!.id,{data:{...run!.data,execution,status:'running',error:null},version:run!.version});};
  const step=async<T>(id:string,work:()=>Promise<T>):Promise<T>=>{
   const state=execution.steps.find(s=>s.id===id)!;if(state.status==='completed')return state.result;
   state.status='running';state.attempts++;state.startedAt=stamp();delete state.error;await persist();
   try{const result=await work();state.result=result;state.status='completed';state.completedAt=stamp();await persist();if(dependencies.afterStep)await dependencies.afterStep(id);return result;}
   catch(error){if(state.status!=='completed'){state.status='failed';state.error=error instanceof Error?error.message:'Step failed';await persist();}throw error;}
  };
  try{
   const context=await step('context',()=>captureContext(workspaceId,run!,request)) as Context;
   for(const task of context.queries){await assertSnapshotAccess(workspaceId,request,context);await step(task.id,()=>executeResearchQuery(workspaceId,task,context.corpus,dependencies.request));}
   const evidence=mergedEvidence(context,execution);await assertSnapshotAccess(workspaceId,request,context,evidence);
   const output=await step('synthesis',async()=>{
    const instruction=name==='deep-research'?'Investigate the question through the bounded queries and evidence below. Separate owned knowledge and owned performance from market posts. Include citations for every factual finding, disagreements only with both sources, and concrete limitations.':named(name).prompt;
    const gaps=[...context.gaps,...execution.steps.filter(s=>s.id.startsWith('research-')).flatMap(s=>s.result?.gaps||[])];
    const value=await generateStructured(workspaceId,{input:JSON.stringify({request:request.input,snapshotAt:context.capturedAt,queries:context.queries,evidence,knownGaps:[...new Set(gaps)],priorHooks:context.priorHooks}),instruction:`${instruction}\n${context.customInstruction?`Custom assistant instructions: ${context.customInstruction}\nUse only the selected assistant sources.`:''}\nUse exact evidence IDs. A source's kind constrains its use: metrics only support owned performance, market sources support market claims, knowledge/format sources support those idea legs. Ideas need two different categories and IDs. Drafts need at least one evidence ID; fewer or zero supported drafts/cards are valid when knowledge is missing. Use empty arrays rather than inventing content. Do not return approval, schedule, connection or publishing fields.`,schema:workflowSchemas[name] as z.ZodType<any>,name:`workflow_${name.replaceAll('-','_')}`});
    const result=validateWorkflowOutput(name,value,evidence,context.priorHooks);result.gaps=[...new Set([...gaps,...result.gaps])].slice(0,40);return result;
   });
   const artifacts=execution.steps.find(s=>s.id==='artifacts')!;artifacts.status='running';artifacts.attempts++;artifacts.startedAt=stamp();await persist();
   const result=await commitArtifacts(workspaceId,run!,execution,name,output,evidence,request);
   if(dependencies.afterStep)await dependencies.afterStep('artifacts');return result;
  }catch(error){
   // A crash after the atomic commit must never downgrade a completed run.
   await recordRunFailure(workspaceId,run!.id,actor.userId,error);throw error;
  }
 }finally{try{if(locked)await lock.query('SELECT pg_advisory_unlock(hashtext($1),hashtext($2))',['grove-workflow',String(data.runId)]);}finally{lock.release();}}
}

export async function executeDeepResearch(workspaceId:string,data:any,jobId?:string,dependencies:WorkflowDependencies={}){
 if(data.runId)return executeStructuredWorkflow(workspaceId,data,dependencies);
 // Upgrade jobs queued before durable research runs existed. The actor-bound
 // job row is the stable identity, so concurrent recovery cannot add runs.
 if(!jobId)throw httpError(409,'Recreate this legacy research task from a signed-in session.');
 const actor=actorFor(workspaceId);
 const runId=await withTransaction(async client=>{
  const {rows:[job]}=await client.query("SELECT data FROM jobs WHERE id=$1 AND workspace_id=$2 AND actor_user_id=$3 AND kind='deep-research' FOR UPDATE",[jobId,workspaceId,actor.userId]);if(!job)throw httpError(404,'Research task not found.');if(job.data.runId)return job.data.runId;
  const request={...job.data,workflowId:'deep-research',policy:{liveResearch:false,actorUserId:actor.userId}};
  const run=await privateRow(client,workspaceId,actor.userId,{kind:'workflow-run',title:job.data.title||'Research synthesis',content:job.data.input,data:{workflowId:'deep-research',status:'pending',request,sourceIds:job.data.sourceIds||[],jobId}});
  await client.query('UPDATE jobs SET data=data||$2::jsonb WHERE id=$1',[jobId,JSON.stringify({runId:run.id,policy:request.policy})]);return run.id;
 });
 return executeStructuredWorkflow(workspaceId,{...data,runId},dependencies);
}
