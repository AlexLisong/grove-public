import {before,after,test,describe} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import pg from 'pg';
import request from 'supertest';
import type {Evidence} from '../server/workflow-schema.js';

const connection=process.env.TEST_DATABASE_URL||'postgres://grove:grove_local_only@127.0.0.1:55432/grove',url=new URL(connection);
if(!['127.0.0.1','localhost'].includes(url.hostname))throw new Error('Workflow tests require local PostgreSQL');
const schema='grove_workflows_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:connection});await admin.query(`CREATE SCHEMA ${schema}`);
url.searchParams.set('options',`-c search_path=${schema},public`);process.env.DATABASE_URL=url.href;process.env.NODE_ENV='test';process.env.APP_URL='http://localhost:5173';process.env.REGISTRATION_CODE='workflow-fixture';process.env.APP_ENCRYPTION_KEY='c'.repeat(64);process.env.DISABLE_WORKER='true';process.env.OPENAI_API_KEY='local-only';delete process.env.AZURE_OPENAI_ENDPOINT;delete process.env.AZURE_STORAGE_ACCOUNT_URL;
const prompts:any[]=[];let responseOverride:((name:string,input:any)=>unknown)|undefined;
function outputFor(name:string,input:any):any{
 const evidence:Evidence[]=input.evidence||[],knowledge=evidence.find(e=>e.kind==='knowledge'),market=evidence.filter(e=>e.kind==='market'),metric=evidence.filter(e=>e.kind==='metric'),format=evidence.find(e=>e.kind==='format');
 const common={summary:'A grounded workflow fixture.',gaps:['This is bounded fixture evidence.']},ref=evidence[0]?[evidence[0].id]:[];
 const draft=(i:number)=>({title:`Garden post ${i}`,content:`An original garden draft ${i}.`,platform:'LinkedIn',rationale:'Based on the supplied source.',evidenceIds:ref,experiment:i===0,suggestedDay:`Day ${i+1}`});
 switch(name){
  case 'workflow_weekly_strategist':return {...common,ownedPerformance:{summary:metric.length?'Owned measurements are present.':'Owned measurements are unavailable.',evidenceIds:metric.map(e=>e.id)},patterns:market.length>=2?[{pattern:'A documented garden pattern.',evidenceIds:market.slice(0,2).map(e=>e.id)}]:[],plays:[0,1,2].map(i=>({hook:`Garden play ${i}`,action:'Try an original explanation.',evidenceIds:ref})),bet:{hypothesis:'A practical format may help.',metric:'qualified replies',target:'3 replies',reviewDate:'next week',evidenceIds:ref},previousBet:{status:'ungraded',reason:'No comparable prior outcome.',evidenceIds:[]}};
  case 'workflow_head_of_content':return {...common,slate:ref.length?[draft(0),draft(1)]:[],changeLog:['Two proposed posts, no publishing actions.']};
  case 'workflow_personal_brand_strategist':return {...common,positioning:'Help beginning gardeners.',audienceNeeds:['Simple practice'],originStory:'Personal history was not supplied.',topicTree:[{topic:'Gardens',angles:['Soil','Water']}],contentDirections:['Practical notes'],monetizationOptions:['A guide, if validated'],referenceEvidenceIds:market.map(e=>e.id).slice(0,16),interviewQuestions:['What have you personally tried?'],firstPosts:ref.length?[0,1,2,3,4].map(draft):[]};
  case 'workflow_content_command_center':return {...common,stations:['Analyst','Scout','Strategist','Planner','Repurposer'].map(station=>({station,brief:`${station} brief`,evidenceIds:station==='Analyst'?metric.map(e=>e.id):station==='Scout'?market.map(e=>e.id).slice(0,4):ref,actions:['Review this brief']})),digest:'A saved digest, never sent.',repurpose:{sourceEvidenceId:knowledge?.id||null,content:knowledge?'A garden source, adapted.':''}};
  case 'workflow_idea_engine':{const second=market[0]||format;return {...common,ideas:knowledge&&second?[0,1].map(i=>({hook:`Garden idea ${i}`,angle:'Connect practice and format.',audienceValue:'Make a useful first step.',format:'Short post',legs:[{kind:'knowledge',evidenceId:knowledge.id},{kind:second.kind,evidenceId:second.id}],firstStep:'Draft an outline.'})):[],strongestIndex:knowledge&&second?0:null};}
  case 'workflow_deep_research':return {...common,findings:ref.length?[{claim:'The available source discusses a garden.',evidenceIds:ref}]:[],disagreements:[],nextSteps:['Collect further evidence.']};
  default:throw new Error('Unexpected structured fixture '+name);
 }
}
const fixture=createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString());prompts.push(body);const name=body.text?.format?.name,input=JSON.parse(body.input),value=responseOverride?responseOverride(name,input):outputFor(name,input);const text=typeof value==='string'?value:JSON.stringify(value);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:'resp_'+randomUUID(),object:'response',status:'completed',model:body.model,output:[{id:'msg_fixture',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text,annotations:[]}]}],usage:{input_tokens:50,output_tokens:100}}));});
await new Promise<void>(resolve=>fixture.listen(0,'127.0.0.1',resolve));process.env.OPENAI_BASE_URL=`http://127.0.0.1:${(fixture.address() as any).port}/v1`;
const {app,initialize}=await import('../server/index.js'),db=await import('../server/core/db.js'),entities=await import('../server/core/entities.js'),access=await import('../server/core/access.js'),engine=await import('../server/workflow-engine.js'),ai=await import('../server/ai.js'),security=await import('../server/core/security.js'),schemas=await import('../server/workflow-schema.js');
type Actor={workspace:string;userId:string};let owner:Actor,other:Actor,agent:ReturnType<typeof request.agent>,csrf:string;
const act=<T>(actor:Actor,fn:()=>Promise<T>)=>access.runAsActor(actor.workspace,actor.userId,fn);
async function isolated():Promise<Actor>{const [row]=await db.query("INSERT INTO workspaces(name) VALUES('Workflow fixture') RETURNING id");await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')",[row.id,owner.userId]);return {workspace:row.id,userId:owner.userId};}
async function sources(actor:Actor){return act(actor,async()=>{
 const knowledge=await entities.createEntity(actor.workspace,{kind:'item',title:'Garden knowledge',content:'Personal garden watering observations.',visibility:'private'});
 const market=[];for(let i=0;i<2;i++)market.push(await entities.createEntity(actor.workspace,{kind:'item',title:`Garden market example ${i}`,content:'Garden audience questions with examples and formats.',visibility:'private',data:{type:'social',platform:'x',creator:'creator-'+i,url:`https://example.test/post/${i}`,metrics:{likes:i+2},provenance:'Authorized fixture export'}}));
 return {knowledge,market};
});}
async function connected(actor:Actor,provider='x'){const id=randomUUID();await db.query('INSERT INTO connections(id,workspace_id,provider,label,credentials,status) VALUES($1,$2,$3,\'Inert fixture\',$4,\'connected\')',[id,actor.workspace,provider,security.encryptSecret(JSON.stringify({accessToken:'NEVER_SEND_THIS_SECRET',apiKey:provider==='youtube-data'?'FAKE_YOUTUBE_KEY':undefined}))]);return id;}
const fakeProvider=async(url:string)=>{assert.match(url,/^https:\/\/(api\.x\.com|www\.googleapis\.com)\//);if(url.includes('/search?'))return {items:[{id:{videoId:'fixture-video'}}]};if(url.includes('/videos?'))return {items:[{id:'fixture-video',snippet:{title:'Garden video',description:'Garden audience examples.',channelId:'fixture-creator'},statistics:{viewCount:'50'}}]};return {data:[{id:'fixture-post',text:'Garden audience examples and formats.',author_id:'fixture-author',public_metrics:{like_count:5}}],includes:{users:[{id:'fixture-author',username:'fixture-creator'}]}};};
const artifacts=async(actor:Actor,runId:string)=>act(actor,async()=>(await entities.listEntities(actor.workspace)).filter(e=>e.data.runId===runId));
before(async()=>{await initialize();agent=request.agent(app);const r=await agent.post('/api/auth/register').send({email:'owner-workflow@example.test',name:'Owner',password:'fixture-password-123',code:'workflow-fixture'}).expect(201);owner={workspace:r.body.workspace.id,userId:r.body.user.id};csrf=r.body.csrfToken;const response=await request(app).post('/api/auth/register').send({email:'other-workflow@example.test',name:'Other',password:'fixture-password-123',code:'workflow-fixture'}).expect(201);other={workspace:response.body.workspace.id,userId:response.body.user.id};});
after(async()=>{await db.closeDb();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();await new Promise<void>(resolve=>fixture.close(()=>resolve()));});

describe('typed resumable workflows',()=>{
 test('all five workflows save typed private artifacts and never approve or queue drafts',async()=>{
  const actor=await isolated();await sources(actor);
  for(const id of ['weekly-strategist','head-of-content','content-command-center','personal-brand-strategist','idea-engine']){
   const queued=await act(actor,()=>ai.queueWorkflow(actor.workspace,id,{input:'Garden audience questions and examples'})),result=await act(actor,()=>engine.executeStructuredWorkflow(actor.workspace,queued.job.data));
   assert.equal(result.documentId,result.entityId);const output=await act(actor,()=>entities.getEntity(actor.workspace,result.entityId));assert.ok(output?.data.structuredOutput);assert.equal(output?.visibility,'private');
   const run=await act(actor,()=>entities.getEntity(actor.workspace,queued.entity.id));assert.equal(run?.data.execution.steps.length,6);assert.ok(run?.data.execution.steps.every((s:any)=>s.status==='completed'));
   const saved=await artifacts(actor,queued.entity.id);assert.ok(saved.every(e=>e.visibility==='private'&&e.createdBy===actor.userId));assert.equal(saved.filter(e=>e.kind==='notification').length,1);
   for(const draft of saved.filter(e=>e.kind==='draft')){assert.equal(draft.data.status,'draft');assert.equal(draft.data.approvalId,undefined);assert.equal(draft.data.scheduledAt,undefined);assert.deepEqual(draft.data.connectionIds,[]);}
   if(id==='head-of-content')assert.equal(result.draftIds.length,2);if(id==='personal-brand-strategist')assert.equal(result.draftIds.length,5);if(id==='idea-engine')assert.equal(result.ideaIds.length,2);
  }
  assert.equal((await db.query("SELECT id FROM jobs WHERE workspace_id=$1 AND kind IN ('publish','send-digest','automation-deliver')",[actor.workspace])).length,0);
 });
 test('completed research steps resume after interruption and output retries are idempotent',async()=>{
  const actor=await isolated();await sources(actor);await connected(actor);const queued=await act(actor,()=>ai.queueWorkflow(actor.workspace,'head-of-content',{input:'Garden audience examples'}));let providerCalls=0;const request=async(url:string)=>{providerCalls++;return fakeProvider(url);};const before=prompts.length;
  await assert.rejects(act(actor,()=>engine.executeStructuredWorkflow(actor.workspace,queued.job.data,{request,afterStep:async id=>{if(id==='research-1')throw new Error('Simulated process stop after durable step');}})),/Simulated process stop/);
  const interrupted=await act(actor,()=>entities.getEntity(actor.workspace,queued.entity.id));assert.equal(interrupted?.data.execution.steps.find((s:any)=>s.id==='research-1').status,'completed');assert.equal(providerCalls,1);
  let committed:any;await assert.rejects(act(actor,()=>engine.executeStructuredWorkflow(actor.workspace,queued.job.data,{request,afterStep:async id=>{if(id==='artifacts')throw new Error('Simulated stop after committed artifacts');}})),/committed artifacts/);
  const completed=await act(actor,()=>entities.getEntity(actor.workspace,queued.entity.id));assert.equal(completed?.data.status,'completed');committed=completed?.data.result;
  const firstIds=(await artifacts(actor,queued.entity.id)).map(e=>e.id).sort(),retry=await act(actor,()=>engine.executeStructuredWorkflow(actor.workspace,queued.job.data,{request}));assert.deepEqual(retry,committed);assert.deepEqual((await artifacts(actor,queued.entity.id)).map(e=>e.id).sort(),firstIds);assert.equal(providerCalls,3);assert.equal(prompts.length-before,1);
 });
 test('one database transaction rolls back all artifacts and resumes without regenerating synthesis',async()=>{
  const actor=await isolated();await sources(actor);const queued=await act(actor,()=>ai.queueWorkflow(actor.workspace,'personal-brand-strategist',{input:'Garden strategy'})),before=prompts.length;
  await db.query(`CREATE FUNCTION reject_workflow_notification() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='notification' AND NEW.data->>'runId'='${queued.entity.id}' THEN RAISE EXCEPTION 'fixture rollback'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_workflow_notification BEFORE INSERT ON entities FOR EACH ROW EXECUTE FUNCTION reject_workflow_notification()`);
  try{await assert.rejects(act(actor,()=>engine.executeStructuredWorkflow(actor.workspace,queued.job.data)),/fixture rollback/);}finally{await db.query('DROP TRIGGER reject_workflow_notification ON entities; DROP FUNCTION reject_workflow_notification()');}
  assert.equal((await artifacts(actor,queued.entity.id)).length,0);const failed=await act(actor,()=>entities.getEntity(actor.workspace,queued.entity.id));assert.equal(failed?.data.execution.steps.find((s:any)=>s.id==='synthesis').status,'completed');
  const result=await act(actor,()=>engine.executeStructuredWorkflow(actor.workspace,queued.job.data));assert.equal(result.draftIds.length,5);assert.equal(prompts.length-before,1);
 });
 test('a concurrent executor cannot repeat a running workflow',async()=>{
  const actor=await isolated(),queued=await act(actor,()=>ai.queueWorkflow(actor.workspace,'idea-engine',{input:'Garden fixture'}));let unblock!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>unblock=resolve),started=new Promise<void>(resolve=>entered=resolve);
  const first=act(actor,()=>engine.executeStructuredWorkflow(actor.workspace,queued.job.data,{afterStep:async id=>{if(id==='context'){entered();await gate;}}}));await started;
  try{await assert.rejects(act(actor,()=>engine.executeStructuredWorkflow(actor.workspace,queued.job.data)),(error:any)=>error.code==='WORKFLOW_RUNNING');}finally{unblock();}await first;
 });
 test('custom assistants and explicit selections exclude unrelated private knowledge and live providers',async()=>{
  const actor=await isolated(),selected=await sources(actor);await connected(actor);const secret=await act(actor,()=>entities.createEntity(actor.workspace,{kind:'item',title:'Unselected garden',content:'PRIVATE_UNSELECTED_ORCHID',visibility:'private'}));await act(other,()=>entities.createEntity(other.workspace,{kind:'item',title:'Other garden',content:'OTHER_WORKSPACE_SECRET',visibility:'private'}));
  const custom=await act(actor,()=>entities.createEntity(actor.workspace,{kind:'custom-ai',title:'Garden guide',data:{sourceIds:[selected.knowledge.id],instructions:'Use exactly the selected garden source.',voice:'GARDEN_VOICE_FIXTURE'}}));
  for(const selection of [{sourceIds:[selected.knowledge.id]},{customAiId:custom.id,sourceIds:[secret.id]}]){
   const queued=await act(actor,()=>ai.queueWorkflow(actor.workspace,'idea-engine',{input:'Garden',...selection}));let calls=0;await act(actor,()=>engine.executeStructuredWorkflow(actor.workspace,queued.job.data,{request:async()=>{calls++;throw new Error('Must not call a provider');}}));assert.equal(calls,0);
   const body=prompts.at(-1);assert.doesNotMatch(body.input,/PRIVATE_UNSELECTED_ORCHID|OTHER_WORKSPACE_SECRET|Garden market example/);const input=JSON.parse(body.input);assert.deepEqual(input.evidence.map((e:Evidence)=>e.entityId),[selected.knowledge.id]);if('customAiId' in selection)assert.match(body.instructions,/GARDEN_VOICE_FIXTURE/);
  }
  await assert.rejects(act(other,()=>engine.executeStructuredWorkflow(actor.workspace,{runId:custom.id})),(e:any)=>e.status===403);
 });
 test('revoked source or editor access stops later steps before another AI request',async()=>{
  const actor=await isolated();await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'editor')",[actor.workspace,other.userId]);const source=await act({...other,workspace:actor.workspace},()=>entities.createEntity(actor.workspace,{kind:'item',title:'Shared garden',content:'Revocable source',visibility:'private'}));await db.query("INSERT INTO entity_acl(entity_id,workspace_id,user_id,permission) VALUES($1,$2,$3,'view')",[source.id,actor.workspace,actor.userId]);
  const queued=await act(actor,()=>ai.queueWorkflow(actor.workspace,'head-of-content',{input:'Garden',sourceIds:[source.id]}));await assert.rejects(act(actor,()=>engine.executeStructuredWorkflow(actor.workspace,queued.job.data,{afterStep:async id=>{if(id==='context')throw new Error('pause');}})),/pause/);await db.query('DELETE FROM entity_acl WHERE entity_id=$1 AND user_id=$2',[source.id,actor.userId]);const before=prompts.length;
  await assert.rejects(act(actor,()=>engine.executeStructuredWorkflow(actor.workspace,queued.job.data)),(error:any)=>error.code==='WORKFLOW_SOURCE_REVOKED');assert.equal(prompts.length,before);assert.equal((await artifacts(actor,queued.entity.id)).length,0);
  const changing=await isolated(),second=await act(changing,()=>ai.queueWorkflow(changing.workspace,'idea-engine',{input:'Garden'}));
  try{await assert.rejects(act(changing,()=>engine.executeStructuredWorkflow(changing.workspace,second.job.data,{afterStep:async id=>{if(id==='context')await db.query("UPDATE memberships SET role='viewer' WHERE workspace_id=$1 AND user_id=$2",[changing.workspace,changing.userId]);}})),(error:any)=>error.code==='ACTOR_REVOKED');}finally{await db.query("UPDATE memberships SET role='owner' WHERE workspace_id=$1 AND user_id=$2",[changing.workspace,changing.userId]);}assert.equal(prompts.length,before);
 });
 test('malformed JSON, extra action fields and fabricated citations cannot create artifacts',async()=>{
  const actor=await isolated();await sources(actor);
  for(const mutation of [(name:string,input:any)=>'not json',(name:string,input:any)=>({...outputFor(name,input),approved:true}),(name:string,input:any)=>{const value=outputFor(name,input);value.slate[0].evidenceIds=['fabricated-source'];return value;}]){
   const queued=await act(actor,()=>ai.queueWorkflow(actor.workspace,'head-of-content',{input:'Garden'}));responseOverride=mutation;
   try{await assert.rejects(act(actor,()=>engine.executeStructuredWorkflow(actor.workspace,queued.job.data)),(error:any)=>error.code==='WORKFLOW_OUTPUT_INVALID');}finally{responseOverride=undefined;}
   assert.equal((await artifacts(actor,queued.entity.id)).length,0);const run=await act(actor,()=>entities.getEntity(actor.workspace,queued.entity.id));assert.equal(run?.data.execution.steps.find((s:any)=>s.id==='synthesis').status,'failed');
  }
 });
 test('saved settings supply later runs and remain private to their owner',async()=>{
  const selected=await sources(owner),saved=await agent.put('/api/workflows/head-of-content/settings').set('x-csrf-token',csrf).send({input:'Garden cadence',sourceIds:[selected.knowledge.id],researchEnabled:false}).expect(200);assert.ok(saved.body.entityId);
  const response=await agent.post('/api/workflows/head-of-content/run').set('x-csrf-token',csrf).send({}).expect(202);assert.equal(response.body.job.data.input,'Garden cadence');assert.deepEqual(response.body.job.data.sourceIds,[selected.knowledge.id]);assert.equal(response.body.job.data.policy.liveResearch,false);
  assert.equal(await act(other,()=>entities.getEntity(other.workspace,saved.body.entityId)),null);await agent.put('/api/workflows/head-of-content/settings').set('x-csrf-token',csrf).send({input:'Updated garden cadence',sourceIds:[selected.knowledge.id]}).expect(200);assert.equal((await agent.get('/api/workflows/head-of-content/settings').expect(200)).body.settings.input,'Updated garden cadence');
 });
 test('deep social research uses three bounded real-adapter queries, stable citations and unknown metrics',async()=>{
  const actor=await isolated();await connected(actor,'youtube-data');const queued=await act(actor,()=>engine.queueDeepResearch(actor.workspace,{input:'Garden',mode:'social'}));const requests:string[]=[];
  const result=await act(actor,()=>engine.executeDeepResearch(actor.workspace,queued.job.data,queued.job.id,{request:async url=>{requests.push(url);return fakeProvider(url);}}));assert.equal(requests.length,6);assert.equal(requests.filter(url=>url.includes('/search?')).length,3);
  const run=await act(actor,()=>entities.getEntity(actor.workspace,result.runId));const evidence=run?.data.execution.steps.find((s:any)=>s.id==='research-1').result.evidence[0];assert.equal(evidence.metrics.likes,null);assert.equal(evidence.metrics.views,50);assert.equal(evidence.provenance,'YouTube Data API');
  const rows=await artifacts(actor,result.runId),sourceRows=rows.filter(e=>e.data.artifactType==='workflow-evidence');assert.equal(sourceRows.length,1);assert.equal(sourceRows[0].visibility,'private');assert.doesNotMatch(JSON.stringify(rows),/FAKE_YOUTUBE_KEY|NEVER_SEND_THIS_SECRET/);const output=rows.find(e=>e.id===result.entityId)!;assert.equal(output.data.citations[0].id,sourceRows[0].id);assert.match(output.content,/youtube\.com\/watch/);
 });
 test('API token research authorization survives background actor reconstruction',async()=>{
  await connected(owner);const token=await agent.post('/api/tokens').set('x-csrf-token',csrf).send({name:'AI only',scopes:['ai:run','workspace:read']}).expect(201);
  const response=await request(app).post('/api/ai/research').set('authorization',`Bearer ${token.body.token}`).send({input:'Garden',mode:'social'}).expect(202);assert.equal(response.body.job.data.policy.liveResearch,false);let calls=0;
  const result=await act(owner,()=>engine.executeDeepResearch(owner.workspace,response.body.job.data,response.body.job.id,{request:async()=>{calls++;throw new Error('No token research permission');}}));assert.equal(calls,0);const output=await act(owner,()=>entities.getEntity(owner.workspace,result.entityId));assert.match(output!.content,/disabled.*authorization/);
 });
 test('routine create and update cannot forge live-research authorization with a restricted token',async()=>{
  const token=await agent.post('/api/tokens').set('x-csrf-token',csrf).send({name:'Routine AI only',scopes:['ai:run','workspace:write','workspace:read']}).expect(201),bearer=`Bearer ${token.body.token}`;
  const created=await request(app).post('/api/entities').set('authorization',bearer).send({kind:'routine',title:'Restricted routine fixture',visibility:'private',data:{enabled:true,input:'Garden fixture',workflowId:'idea-engine',researchAuthorized:true,researchEnabled:true}}).expect(201);assert.equal(created.body.entity.data.researchAuthorized,false);
  const updated=await request(app).patch('/api/entities/'+created.body.entity.id).set('authorization',bearer).send({data:{...created.body.entity.data,researchAuthorized:true}}).expect(200);assert.equal(updated.body.entity.data.researchAuthorized,false);
  const worker=await import('../server/worker.js'),child=await act(owner,()=>worker.executeJob(owner.workspace,'routine',{routineId:created.body.entity.id,slot:'fixture-slot'}));const [job]=await db.query('SELECT data FROM jobs WHERE id=$1',[child.jobId]);assert.equal(job.data.policy.liveResearch,false);
  const authorized=await agent.patch('/api/entities/'+created.body.entity.id).set('x-csrf-token',csrf).send({data:{...updated.body.entity.data,researchAuthorized:false}}).expect(200);assert.equal(authorized.body.entity.data.researchAuthorized,true);
 });
 test('legacy deep-research recovery binds one run to the authorized job and does not widen old scopes',async()=>{
  const actor=await isolated();await connected(actor);const jobs=await import('../server/core/jobs.js'),job=await act(actor,()=>jobs.enqueue(actor.workspace,'deep-research',{input:'Garden',mode:'social',sourceIds:[]}));let calls=0;const dependencies={request:async()=>{calls++;throw new Error('Legacy scope was never authorized');}};
  const first=await act(actor,()=>engine.executeDeepResearch(actor.workspace,job.data,job.id,dependencies)),second=await act(actor,()=>engine.executeDeepResearch(actor.workspace,job.data,job.id,dependencies));assert.equal(calls,0);assert.deepEqual(first,second);const [saved]=await db.query('SELECT data FROM jobs WHERE id=$1',[job.id]);assert.equal(saved.data.runId,first.runId);assert.equal((await act(actor,()=>entities.listEntities(actor.workspace,{kind:'workflow-run'}))).length,1);
 });
 test('provider failures persist honest query gaps and never fabricate saved market evidence',async()=>{
  const actor=await isolated();await connected(actor);const queued=await act(actor,()=>engine.queueDeepResearch(actor.workspace,{input:'Garden',mode:'social'}));let calls=0;const result=await act(actor,()=>engine.executeDeepResearch(actor.workspace,queued.job.data,queued.job.id,{request:async()=>{calls++;throw new Error('Untrusted provider error NEVER_SEND_THIS_SECRET');}}));assert.equal(calls,3);
  const run=await act(actor,()=>entities.getEntity(actor.workspace,result.runId));assert.ok(run!.data.execution.steps.filter((s:any)=>s.id.startsWith('research-')).every((s:any)=>s.result.providerStatus==='unavailable'));const saved=await artifacts(actor,result.runId);assert.equal(saved.filter(e=>e.data.artifactType==='workflow-evidence').length,0);assert.doesNotMatch(JSON.stringify(saved),/NEVER_SEND_THIS_SECRET/);assert.match(saved.find(e=>e.id===result.entityId)!.content,/provider was unavailable/);
 });
 test('empty corpus produces an explicit gap report and no fabricated cards or market sources',async()=>{
  const actor=await isolated(),queued=await act(actor,()=>engine.queueDeepResearch(actor.workspace,{input:'Garden',mode:'social'})),result=await act(actor,()=>engine.executeDeepResearch(actor.workspace,queued.job.data,queued.job.id));
  const output=await act(actor,()=>entities.getEntity(actor.workspace,result.entityId));assert.deepEqual(output?.data.structuredOutput.findings,[]);assert.deepEqual(output?.data.citations,[]);assert.match(output!.content,/No supported connected search provider/);assert.match(output!.content,/No matching market evidence/);
 });
 test('evidence constraints reject invented pattern diversity and dedupe repeated idea hooks',async()=>{
  const actor=await isolated(),source=await sources(actor);const evidence=[{id:'k',kind:'knowledge',title:'Garden knowledge',excerpt:'Notes',provenance:'fixture',capturedAt:new Date().toISOString()},{id:'m1',kind:'market',creator:'same',platform:'x',title:'Garden market 1',excerpt:'Notes',provenance:'fixture',capturedAt:new Date().toISOString()},{id:'m2',kind:'market',creator:'same',platform:'x',title:'Garden market 2',excerpt:'Notes',provenance:'fixture',capturedAt:new Date().toISOString()}] as Evidence[];
  assert.throws(()=>schemas.validateWorkflowOutput('weekly-strategist',outputFor('workflow_weekly_strategist',{evidence}),evidence),/distinct creators/);const ideas=schemas.validateWorkflowOutput('idea-engine',outputFor('workflow_idea_engine',{evidence}),evidence,['GARDEN IDEA 0']);assert.equal(ideas.ideas.length,1);assert.equal(ideas.ideas[0].hook,'Garden idea 1');assert.match(ideas.gaps.join(' '),/repeated idea/);assert.ok(source.knowledge.id);
 });
});
