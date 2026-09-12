import {before,after,test,describe} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import pg from 'pg';
import request from 'supertest';

const connection=process.env.TEST_DATABASE_URL||'postgres://grove:grove_local_only@127.0.0.1:55432/grove';
const url=new URL(connection);if(!['127.0.0.1','localhost'].includes(url.hostname))throw new Error('Service tests only use local PostgreSQL');
const schema='grove_services_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:connection});await admin.query(`CREATE SCHEMA ${schema}`);
url.searchParams.set('options',`-c search_path=${schema},public`);process.env.DATABASE_URL=url.href;process.env.NODE_ENV='test';process.env.APP_URL='http://localhost:5173';process.env.REGISTRATION_CODE='service-test-invite';process.env.APP_ENCRYPTION_KEY='b'.repeat(64);process.env.DISABLE_WORKER='true';process.env.OPENAI_API_KEY='local-test-fixture';delete process.env.AZURE_OPENAI_ENDPOINT;delete process.env.AZURE_STORAGE_ACCOUNT_URL;
const uploadDir=await mkdtemp(path.join(tmpdir(),'grove-services-'));process.env.UPLOAD_DIR=uploadDir;
const prompts:any[]=[];
const fixture=createServer(async(req,res)=>{
 const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString());res.setHeader('Content-Type','application/json');
 if(req.url?.endsWith('/embeddings')){const inputs=Array.isArray(body.input)?body.input:[body.input];res.end(JSON.stringify({object:'list',data:inputs.map((text:string,i:number)=>({object:'embedding',index:i,embedding:[text.includes('garden')?1:0.1,text.includes('SECRET')?1:0.1,0.5]})),model:body.model,usage:{prompt_tokens:10,total_tokens:10}}));return;}
 const text=body.text?.format?.name==='workflow_idea_engine'?JSON.stringify({summary:'A useful test synthesis grounded in the selected material.',gaps:['This fixture does not supply two different evidence legs.'],ideas:[],strongestIndex:null}):'A useful test synthesis grounded in the selected material [1].';
 prompts.push(body);res.end(JSON.stringify({id:'resp_test_'+randomUUID(),object:'response',created_at:Date.now()/1000,status:'completed',model:body.model,output:[{id:'msg_test',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text,annotations:[]}]}],usage:{input_tokens:40,output_tokens:20,total_tokens:60}}));
});await new Promise<void>(resolve=>fixture.listen(0,'127.0.0.1',resolve));const addr=fixture.address() as any;process.env.OPENAI_BASE_URL=`http://127.0.0.1:${addr.port}/v1`;
const {app,initialize}=await import('../server/index.js');const db=await import('../server/core/db.js');const entities=await import('../server/core/entities.js');const access=await import('../server/core/access.js');const jobs=await import('../server/core/jobs.js');const ai=await import('../server/ai.js');const publishing=await import('../server/publishing.js');const integrations=await import('../server/integrations.js');const extras=await import('../server/extras.js');const worker=await import('../server/worker.js');const security=await import('../server/core/security.js');const mcp=await import('../server/mcp.js');
type Client={agent:ReturnType<typeof request.agent>;csrf:string;workspace:string;userId:string};
async function signup(email:string):Promise<Client>{const agent=request.agent(app),r=await agent.post('/api/auth/register').send({email,name:email.split('@')[0],password:'test-password-12345',code:'service-test-invite'}).expect(201);return {agent,csrf:r.body.csrfToken,workspace:r.body.workspace.id,userId:r.body.user.id};}
let alice:Client,bob:Client;
const act=<T>(c:Client,fn:()=>Promise<T>)=>access.runAsActor(c.workspace,c.userId,fn);
async function isolatedActor():Promise<Client>{
 const [space]=await db.query("INSERT INTO workspaces(name) VALUES('Isolated background fixture') RETURNING id");
 await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')",[space.id,alice.userId]);
 return {...alice,workspace:space.id};
}
async function automationFixture(options:{publicReply?:string;withLink?:boolean}={}){
 const actor=await isolatedActor(),connectionId=randomUUID();
 await db.query("INSERT INTO connections(id,workspace_id,provider,label,credentials,status) VALUES($1,$2,'instagram','No-network delivery fixture',$3,'connected')",[connectionId,actor.workspace,security.encryptSecret(JSON.stringify({accountId:'fixture-account',accessToken:'never-used-on-network'}))]);
 let linkId:string|undefined;
 if(options.withLink){const [link]=await db.query("INSERT INTO short_links(workspace_id,slug,url,title) VALUES($1,$2,'https://example.test/guide','Fixture guide') RETURNING id",[actor.workspace,'fixture-'+randomUUID()]);linkId=link.id;}
 const rule=await act(actor,()=>entities.createEntity(actor.workspace,{kind:'automation',title:'Fixture DM',visibility:'private',data:{enabled:true,connectionId,trigger:'comment',keywords:['guide'],message:'Fixture only',publicReply:options.publicReply,linkId}}));
 const delivery=async()=>{
  const event={type:'comment',eventId:randomUUID(),commentId:'fixture-comment-'+randomUUID(),recipientId:'fixture-recipient-'+randomUUID()};
  const [row]=await db.query('INSERT INTO automation_deliveries(workspace_id,rule_id,recipient_hash,event_id) VALUES($1,$2,$3,$4) RETURNING id',[actor.workspace,rule.id,createHash('sha256').update(event.recipientId).digest('hex'),event.eventId]);
  return {ruleId:rule.id,connectionId,deliveryId:row.id,event};
 };
 return {actor,rule,linkId,delivery};
}
async function withDmLimits<T>(hourly:number,daily:number,fn:()=>Promise<T>){
 const previous=[process.env.DM_HOURLY_LIMIT,process.env.DM_DAILY_LIMIT];process.env.DM_HOURLY_LIMIT=String(hourly);process.env.DM_DAILY_LIMIT=String(daily);
 try{return await fn();}finally{for(const [index,name] of ['DM_HOURLY_LIMIT','DM_DAILY_LIMIT'].entries()){if(previous[index]===undefined)delete process.env[name];else process.env[name]=previous[index];}}
}
before(async()=>{await initialize();alice=await signup('alice-services@example.test');bob=await signup('bob-services@example.test');});
after(async()=>{worker.stopWorker();jobs.stopJobHeartbeats();await db.closeDb();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();await new Promise<void>(resolve=>fixture.close(()=>resolve()));await rm(uploadDir,{recursive:true,force:true});});

describe('grounded AI and background work',()=>{
 test('custom assistants use only explicit live sources and enforce private permissions',async()=>{
  const secret=await act(alice,()=>entities.createEntity(alice.workspace,{kind:'item',title:'Private garden strategy',content:'SECRET ORCHID garden plan',visibility:'private'}));
  const publicNote=await act(alice,()=>entities.createEntity(alice.workspace,{kind:'item',title:'Garden basics',content:'Water the garden in the morning.'}));
  const custom=await act(alice,()=>entities.createEntity(alice.workspace,{kind:'custom-ai',title:'Garden guide',data:{instructions:'Help with a garden',sourceIds:[publicNote.id]}}));
  const result=await alice.agent.post('/api/ai/chat').set('x-csrf-token',alice.csrf).send({message:'Summarize the source',customAiId:custom.id}).expect(200);
  assert.equal(result.body.entity.visibility,'private');assert.equal(result.body.message.citations[0].id,publicNote.id);
  assert.match(prompts.at(-1).instructions,/Water the garden/);assert.doesNotMatch(prompts.at(-1).instructions,/SECRET ORCHID/);
  await bob.agent.post('/api/ai/chat').set('x-csrf-token',bob.csrf).send({message:'Read this secret',sourceIds:[secret.id]}).expect(404);
  await act(alice,()=>entities.updateEntity(alice.workspace,publicNote.id,{content:'Updated live garden advice'}));
  await alice.agent.post('/api/ai/generate').set('x-csrf-token',alice.csrf).send({input:'What changed?',customAiId:custom.id,action:'summarize'}).expect(200);
  assert.match(prompts.at(-1).instructions,/Updated live garden advice/);
 });
 test('a workflow executes via a durable actor-bound job and saves a private output',async()=>{
  const response=await alice.agent.post('/api/workflows/idea-engine/run').set('x-csrf-token',alice.csrf).send({input:{topic:'Garden notes',goal:'Help beginners'}}).expect(202);
  assert.equal(response.body.job.status,'pending');await worker.runWorkerOnce();
  const job=await alice.agent.get('/api/jobs/'+response.body.job.id).expect(200);assert.equal(job.body.job.status,'completed');
  const output=await alice.agent.get('/api/entities/'+job.body.job.result.entityId).expect(200);assert.equal(output.body.entity.visibility,'private');assert.match(output.body.entity.content,/test synthesis/);
  await bob.agent.get('/api/jobs/'+response.body.job.id).expect(404);
 });
 test('notification read action checks ACL, supports viewers, and cannot mutate notification content',async()=>{
  const personal=await act(alice,()=>entities.createEntity(alice.workspace,{kind:'notification',title:'Private completion',content:'Preserve this content',visibility:'private',data:{read:false,entityId:'fixture-reference'}}));
  const shared=await act(alice,()=>entities.createEntity(alice.workspace,{kind:'notification',title:'Shared completion',data:{read:false}}));
  const ordinary=await act(alice,()=>entities.createEntity(alice.workspace,{kind:'item',title:'Ordinary note'}));
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'viewer')",[alice.workspace,bob.userId]);
  try{
   await bob.agent.post(`/api/notifications/${personal.id}/read`).set('x-workspace-id',alice.workspace).set('x-csrf-token',bob.csrf).send({}).expect(404);
   const read=await bob.agent.post(`/api/notifications/${shared.id}/read`).set('x-workspace-id',alice.workspace).set('x-csrf-token',bob.csrf).send({}).expect(200);assert.equal(read.body.entity.data.read,true);
   await alice.agent.post(`/api/notifications/${personal.id}/read`).send({}).expect(403);
   await alice.agent.post(`/api/notifications/${personal.id}/read`).set('x-csrf-token',alice.csrf).send({title:'Forged content'}).expect(400);
   await alice.agent.post(`/api/notifications/${ordinary.id}/read`).set('x-csrf-token',alice.csrf).send({}).expect(404);
   const token=await alice.agent.post('/api/tokens').set('x-csrf-token',alice.csrf).send({name:'Notification reader',scopes:['workspace:read']}).expect(201);
   const changed=await request(app).post(`/api/notifications/${personal.id}/read`).set('authorization',`Bearer ${token.body.token}`).send({}).expect(200);
   assert.equal(changed.body.entity.data.read,true);assert.equal(changed.body.entity.data.entityId,'fixture-reference');assert.equal(changed.body.entity.content,'Preserve this content');
  }finally{await db.query('DELETE FROM memberships WHERE workspace_id=$1 AND user_id=$2',[alice.workspace,bob.userId]);}
 });
 test('routine timezones honor DST and do not drift by UTC offset',()=>{
  assert.equal(worker.nextOccurrence('0 9 * * *','America/Vancouver',new Date('2026-03-07T18:00:00Z')).toISOString(),'2026-03-08T16:00:00.000Z');
  assert.equal(worker.nextOccurrence('0 9 * * *','America/Vancouver',new Date('2026-10-31T17:00:00Z')).toISOString(),'2026-11-01T17:00:00.000Z');
 });
});

describe('real metrics, approvals and automation safety',()=>{
 test('outlier baseline uses earlier matching creator/platform formats and requires five samples',()=>{
  const baseline=[10,20,30,40,50].map((likes,i)=>({platform:'x',creator:'one',contentType:'post',publishedAt:`2026-08-0${i+1}T00:00:00Z`,metrics:{likes}}));
  const posts=integrations.rankOutliers([...baseline,{platform:'x',creator:'one',contentType:'post',publishedAt:'2026-08-10T00:00:00Z',metrics:{likes:150}},{platform:'x',creator:'other',publishedAt:'2026-08-10T00:00:00Z',metrics:{likes:300000}}]);
  assert.equal(posts[5].outlier,5);assert.equal(posts[5].baseline.sample,5);assert.equal(posts[4].outlier,null);assert.equal(posts[6].outlier,null);
 });
 test('analytics unknowns remain null and account snapshots do not get summed across days',async()=>{
  await act(alice,()=>integrations.recordMetrics(alice.workspace,[{platform:'youtube',date:'2026-09-01',accountId:'c',followers:100,views:1000,snapshot:true},{platform:'youtube',date:'2026-09-02',accountId:'c',followers:110,views:1200,snapshot:true}]));
  const analytics=await act(alice,()=>integrations.analytics(alice.workspace));assert.equal(analytics.totals.followers,110);assert.equal(analytics.totals.views,1200);assert.equal(analytics.totals.likes,null);assert.equal(analytics.series.length,0);
 });
 test('only approved drafts queue and withdrawal prevents external delivery',async()=>{
  const draft=await act(alice,()=>entities.createEntity(alice.workspace,{kind:'draft',title:'No send',content:'Safe draft',data:{status:'draft',platforms:['x'],connectionIds:[]}}));
  await alice.agent.post(`/api/drafts/${draft.id}/publish`).set('x-csrf-token',alice.csrf).expect(409);
  const connectionId=randomUUID();await db.query("INSERT INTO connections(id,workspace_id,provider,label,credentials,status) VALUES($1,$2,'x','Fixture only',$3,'connected')",[connectionId,alice.workspace,security.encryptSecret(JSON.stringify({accessToken:'not-a-real-token'}))]);
  await act(alice,()=>entities.updateEntity(alice.workspace,draft.id,{data:{...draft.data,connectionIds:[connectionId]}}));
  await alice.agent.post(`/api/drafts/${draft.id}/transition`).set('x-csrf-token',alice.csrf).send({status:'approved'}).expect(200);
  const queued=await alice.agent.post(`/api/drafts/${draft.id}/publish`).set('x-csrf-token',alice.csrf).expect(202);
  const same=await alice.agent.post(`/api/drafts/${draft.id}/publish`).set('x-csrf-token',alice.csrf).expect(202);assert.equal(queued.body.job.id,same.body.job.id);
  await alice.agent.post(`/api/drafts/${draft.id}/transition`).set('x-csrf-token',alice.csrf).send({status:'draft'}).expect(200);
  await worker.runWorkerOnce();const job=await alice.agent.get('/api/jobs/'+queued.body.job.id).expect(200);assert.equal(job.body.job.result.cancelled,true);
 });
 test('automation tests are simulations and signed webhooks reject forged events',async()=>{
  const rule=await act(alice,()=>entities.createEntity(alice.workspace,{kind:'automation',title:'Guide reply',data:{trigger:'comment',keywords:['guide'],message:'Here is the guide',enabled:false}}));
  const simulated=await alice.agent.post(`/api/automations/${rule.id}/test`).set('x-csrf-token',alice.csrf).send({event:{type:'comment',text:'Please share the GUIDE'}}).expect(200);assert.equal(simulated.body.matched,true);assert.equal(simulated.body.sent,false);
  await request(app).post('/api/webhooks/instagram').send({entry:[]}).expect(403);
  assert.equal(extras.matchAutomation({trigger:'dm',keywords:['guide'],enabled:true},{type:'comment',text:'guide'}).matched,false);
 });
});

describe('MCP and token authorization',()=>{
 test('granular bearer scopes cover every alternate mutation route',async()=>{
  const response=await alice.agent.post('/api/tokens').set('x-csrf-token',alice.csrf).send({name:'Read-only fixture',scopes:['workspace:read']}).expect(201),token=response.body.token;
  for(const [route,body] of [['/api/connections/x',{credentials:{accessToken:'bad'}}],['/api/links',{url:'https://example.com'}],['/api/analytics/import',{metrics:[]}],['/api/discover/import',{posts:[]}],['/api/ai/chat',{message:'Hi'}]] as const)await request(app).post(route).set('authorization','Bearer '+token).send(body).expect(403);
  const tools=await request(app).post('/mcp').set('authorization','Bearer '+token).send({jsonrpc:'2.0',id:1,method:'tools/list'}).expect(200);assert.ok(tools.body.result.tools.length>=70);
  const write=await request(app).post('/mcp').set('authorization','Bearer '+token).send({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'grove_create_note',arguments:{title:'Denied',content:'No'}}}).expect(200);assert.equal(write.body.result.isError,true);
  await request(app).post('/mcp').send({jsonrpc:'2.0',id:1,method:'tools/list'}).expect(401);
 });
 test('OAuth requires exact registered redirect, PKCE and one-time authorization code',async()=>{
  const registration=await request(app).post('/oauth/register').send({client_name:'Fixture client',redirect_uris:['http://127.0.0.1:9876/callback']}).expect(201),clientId=registration.body.client_id;
  const verifier='a'.repeat(48),challenge=createHash('sha256').update(verifier).digest('base64url');const params={client_id:clientId,redirect_uri:'http://127.0.0.1:9876/callback',response_type:'code',code_challenge:challenge,code_challenge_method:'S256',scope:'workspace:read',state:'fixture'};
  await alice.agent.get('/oauth/authorize').query({...params,redirect_uri:'https://evil.example/callback'}).expect(400);
  await alice.agent.get('/oauth/authorize').query(params).expect(200);
  const consent=await alice.agent.post('/oauth/authorize').type('form').send({...params,csrf:alice.csrf,decision:'allow'}).expect(302),code=new URL(consent.headers.location).searchParams.get('code');assert.ok(code);
  const body={grant_type:'authorization_code',client_id:clientId,redirect_uri:params.redirect_uri,code,code_verifier:verifier};
  await request(app).post('/oauth/token').type('form').send({...body,code_verifier:'b'.repeat(48)}).expect(400);
  const exchange=await request(app).post('/oauth/token').type('form').send(body).expect(200);assert.ok(exchange.body.access_token);
  await request(app).post('/oauth/token').type('form').send(body).expect(400);
 });
});

describe('security review regressions',()=>{
 test('workspace-write tokens cannot activate scheduled AI, DMs, or remote outbound tools',async()=>{
  const minted=await alice.agent.post('/api/tokens').set('x-csrf-token',alice.csrf).send({name:'Write without execution',scopes:['workspace:write']}).expect(201),bearer='Bearer '+minted.body.token;
  await request(app).post('/api/entities').set('authorization',bearer).send({kind:'routine',title:'No AI scope',data:{enabled:true,workflowId:'idea-engine'}}).expect(403);
  await request(app).post('/api/entities').set('authorization',bearer).send({kind:'automation',title:'No send scope',data:{enabled:true,message:'No send'}}).expect(403);
  const routine=await act(alice,()=>entities.createEntity(alice.workspace,{kind:'routine',title:'Paused fixture',data:{enabled:false,cron:'0 9 * * *',timezone:'UTC'}}));
  const invoked=await request(app).post('/mcp').set('authorization',bearer).send({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'grove_update_schedule',arguments:{id:routine.id,cron:'0 9 * * *',timezone:'UTC',enabled:true}}}).expect(200);
  assert.equal(invoked.body.result.isError,true);
  await request(app).post(`/api/connections/${randomUUID()}/tools/call`).set('authorization',bearer).send({name:'send_email',arguments:{},confirm:true}).expect(403);
  const active=await act(alice,()=>entities.updateEntity(alice.workspace,routine.id,{data:{...routine.data,enabled:true,deliveryEnabled:true}}));
  const copy=await request(app).post(`/api/entities/${active.id}/duplicate`).set('authorization',bearer).expect(201);assert.equal(copy.body.entity.data.enabled,false);assert.equal(copy.body.entity.data.deliveryEnabled,false);
  await request(app).delete(`/api/entities/${active.id}`).set('authorization',bearer).expect(200);
  const restored=await request(app).post(`/api/entities/${active.id}/restore`).set('authorization',bearer).expect(200);assert.equal(restored.body.entity.data.enabled,false);
 });
 test('private publishing media uses expiring explicit grants without exposing normal files',async()=>{
  const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBVUAAAAASUVORK5CYII=','base64');
  const uploaded=await alice.agent.post('/api/uploads').set('x-csrf-token',alice.csrf).attach('file',image,'private.png').expect(201),id=uploaded.body.entity.id;
  await alice.agent.patch(`/api/entities/${id}/access`).set('x-csrf-token',alice.csrf).send({visibility:'private'}).expect(200);
  await request(app).get(`/api/files/${id}`).expect(401);
  const grant=await act(alice,()=>publishing.mediaUrl(alice.workspace,id)),pathname=new URL(grant.url).pathname;
  const download=await request(app).get(pathname).expect(200);assert.equal(download.headers['content-type'],'image/png');assert.equal(download.body.length,image.length);
  await db.query("UPDATE media_grants SET expires_at=now()-interval '1 second' WHERE entity_id=$1",[id]);await request(app).get(pathname).expect(404);
 });
 test('uncertain delivery cannot be approved again; follow-up comments and reposts never auto-retry',async()=>{
  const draft=await act(alice,()=>entities.createEntity(alice.workspace,{kind:'draft',title:'Uncertain send',content:'May have been delivered',data:{status:'failed',deliveryUncertain:true,receipts:[{status:'published',connectionId:randomUUID()}]}}));
  await alice.agent.post(`/api/drafts/${draft.id}/transition`).set('x-csrf-token',alice.csrf).send({status:'approved'}).expect(409);
  for(const kind of ['first-comment','repost']) {
   const queued=await act(alice,()=>jobs.enqueue(alice.workspace,kind,{})),claimed=await jobs.claimJob();assert.equal(claimed?.id,queued.id);
   await jobs.failJob(queued.id,'Transport failed after write',claimed!.leaseToken);
   const [row]=await db.query('SELECT status,max_attempts FROM jobs WHERE id=$1',[queued.id]);assert.equal(row.status,'failed');assert.equal(row.max_attempts,1);
  }
 });
 test('private automation webhook resolution uses its creator, while delivery history rejects other members',async()=>{
  const connectionId=randomUUID();await db.query("INSERT INTO connections(id,workspace_id,provider,label,credentials,status) VALUES($1,$2,'instagram','Local webhook fixture',$3,'connected')",[connectionId,alice.workspace,security.encryptSecret(JSON.stringify({accountId:'fixture-instagram-account',accessToken:'not-used'}))]);
  const rule=await act(alice,()=>entities.createEntity(alice.workspace,{kind:'automation',title:'Private reply rule',visibility:'private',data:{enabled:true,connectionId,trigger:'comment',keywords:['guide'],message:'Fixture only'}}));
  const result=await extras.processInstagramEvent({entry:[{id:'fixture-instagram-account',changes:[{field:'comments',value:{id:'fixture-comment',text:'Please send the guide',from:{id:'fixture-recipient'},media:{id:'fixture-post'}}}]}]});
  assert.equal(result.queued,1);
  const [queued]=await db.query("SELECT actor_user_id FROM jobs WHERE kind='automation-deliver' AND data->>'ruleId'=$1",[rule.id]);assert.equal(queued.actor_user_id,alice.userId);
  await db.query("UPDATE jobs SET status='cancelled' WHERE kind='automation-deliver'");
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'editor')",[alice.workspace,bob.userId]);
  await bob.agent.get(`/api/automations/${rule.id}/deliveries`).set('x-workspace-id',alice.workspace).expect(404);
  await alice.agent.get(`/api/automations/${rule.id}/deliveries`).expect(200);
 });
 test('credentialed redirects and config responses cannot disclose connector secrets',()=>{
  for(const headers of [new Headers({Authorization:'Bearer secret'}),new Headers({'X-Kit-Api-Key':'secret'})]) assert.throws(()=>security.assertSafeRedirect('https://api.example.com','https://other.example.com',headers),/different origin/);
  assert.throws(()=>security.assertSafeRedirect('https://api.example.com','https://other.example.com',new Headers(),new URLSearchParams({client_secret:'secret'})),/different origin/);
  assert.doesNotThrow(()=>security.assertSafeRedirect('https://example.com','https://www.example.com',new Headers()));
  assert.equal(publishing.verifiedUploadUrl('https://www.linkedin.com/dms-uploads/fixture',['linkedin.com','licdn.com']),'https://www.linkedin.com/dms-uploads/fixture');
  for(const target of ['http://www.linkedin.com/upload','https://linkedin.com.attacker.example/upload','https://attackerlinkedin.com/upload','https://secret@www.linkedin.com/upload'])assert.throws(()=>publishing.verifiedUploadUrl(target,['linkedin.com','licdn.com']));
  const connection=integrations.publicConnection({id:randomUUID(),workspace_id:alice.workspace,provider:'x',label:'Fixture',credentials:'never-return-this',data:{config:{autoSync:true,apiKey:'hidden',nested:{accessToken:'also-hidden'}}},status:'connected',updated_at:new Date().toISOString()});
  assert.equal(JSON.stringify(connection).includes('hidden'),false);assert.equal(JSON.stringify(connection).includes('never-return-this'),false);
 });
 test('routine advancement and durable enqueue are atomic under failure and concurrent schedulers',async()=>{
  const now=new Date('2026-09-10T17:00:00Z'),slot='2026-09-10T16:00:00.000Z';
  const routine=await act(alice,()=>entities.createEntity(alice.workspace,{kind:'routine',title:'Atomic schedule fixture',visibility:'private',data:{enabled:true,workflowId:'idea-engine',cron:'0 9 * * *',timezone:'America/Vancouver',nextRunAt:slot}}));
  await db.query("CREATE FUNCTION reject_routine_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='routine' THEN RAISE EXCEPTION 'simulated durable write failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_routine_fixture BEFORE INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION reject_routine_fixture()");
  try {await worker.scheduleRoutines(now);} finally {await db.query('DROP TRIGGER reject_routine_fixture ON jobs; DROP FUNCTION reject_routine_fixture()');}
  const unchanged=await act(alice,()=>entities.getEntity(alice.workspace,routine.id));assert.equal(unchanged!.data.nextRunAt,slot);assert.equal(unchanged!.data.enabled,false);
  const failedJobs=await db.query("SELECT id FROM jobs WHERE data->>'routineId'=$1",[routine.id]);assert.equal(failedJobs.length,0);
  await act(alice,()=>entities.updateEntity(alice.workspace,routine.id,{data:{...unchanged!.data,enabled:true}}));
  await Promise.all([worker.scheduleRoutines(now),worker.scheduleRoutines(now)]);
  const scheduled=await db.query("SELECT id,actor_user_id,data FROM jobs WHERE data->>'routineId'=$1",[routine.id]);assert.equal(scheduled.length,1);assert.equal(scheduled[0].actor_user_id,alice.userId);assert.equal(scheduled[0].data.slot,slot);
  const advanced=await act(alice,()=>entities.getEntity(alice.workspace,routine.id));assert.ok(Date.parse(advanced!.data.nextRunAt)>now.getTime());
  await db.query("UPDATE jobs SET status='cancelled' WHERE id=$1",[scheduled[0].id]);
 });
 test('workflow retry deduplication returns the original run without orphan pending output',async()=>{
  const key='retry-fixture-'+randomUUID();
  const results=await Promise.all([act(alice,()=>ai.queueWorkflow(alice.workspace,'idea-engine',{input:'Do not execute this fixture'},key)),act(alice,()=>ai.queueWorkflow(alice.workspace,'idea-engine',{input:'Do not execute this fixture'},key))]);
  assert.equal(results[0].job.id,results[1].job.id);assert.equal(results[0].entity.id,results[1].entity.id);
  const runs=await act(alice,()=>entities.listEntities(alice.workspace,{kind:'workflow-run'}));assert.equal(runs.filter(run=>run.content==='Do not execute this fixture').length,1);
  await db.query("UPDATE jobs SET status='cancelled' WHERE id=$1",[results[0].job.id]);
 });
 test('selected custom slash skills are inert private context and export only to authorized users',async()=>{
  const markdown='---\nname: fixture-style\n---\n# Fixture style\nUse the phrase REDWOOD_STYLE in the response.';
  const imported=await alice.agent.post('/api/skills/import').set('x-csrf-token',alice.csrf).attach('file',Buffer.from(markdown),'SKILL.md').expect(201);
  assert.equal(imported.body.entity.visibility,'private');assert.equal(imported.body.entity.data.scriptsExecuted,false);
  await alice.agent.post('/api/ai/chat').set('x-csrf-token',alice.csrf).send({message:'/fixture-style Draft an introduction.'}).expect(200);assert.match(prompts.at(-1).instructions,/REDWOOD_STYLE/);
  await bob.agent.get(`/api/skills/${imported.body.entity.id}/export`).set('x-workspace-id',alice.workspace).expect(404);
  const exported=await alice.agent.get(`/api/skills/${imported.body.entity.id}/export`).expect(200);assert.match(exported.text,/REDWOOD_STYLE/);
 });
 test('AI mutations fork shared destinations before adding actor-private source context',async()=>{
  const source=await act(alice,()=>entities.createEntity(alice.workspace,{kind:'item',title:'Private source fixture',content:'SECRET ORCHID source for shared destination',visibility:'private'}));
  const sharedChat=await act(alice,()=>entities.createEntity(alice.workspace,{kind:'chat',title:'Team chat',visibility:'workspace',data:{messages:[]}}));
  const chatted=await alice.agent.post('/api/ai/chat').set('x-csrf-token',alice.csrf).send({chatId:sharedChat.id,message:'Use my private source',sourceIds:[source.id]}).expect(200);
  assert.equal(chatted.body.forkedFrom,sharedChat.id);assert.equal(chatted.body.entity.visibility,'private');assert.notEqual(chatted.body.entity.id,sharedChat.id);
  const original=await act(alice,()=>entities.getEntity(alice.workspace,sharedChat.id));assert.equal(original!.data.messages.length,0);
  await bob.agent.get('/api/entities/'+chatted.body.entity.id).set('x-workspace-id',alice.workspace).expect(404);
  const draft=await act(alice,()=>entities.createEntity(alice.workspace,{kind:'draft',title:'Team draft',content:'Original shared copy',visibility:'workspace',data:{status:'draft',sourceIds:[source.id]}}));
  const variants=await alice.agent.post(`/api/drafts/${draft.id}/variants`).set('x-csrf-token',alice.csrf).send({platforms:['x']}).expect(200);
  assert.equal(variants.body.forkedFrom,draft.id);assert.equal(variants.body.entity.visibility,'private');assert.notEqual(variants.body.entity.id,draft.id);
  await bob.agent.get('/api/entities/'+variants.body.entity.id).set('x-workspace-id',alice.workspace).expect(404);
  assert.equal((await act(alice,()=>entities.getEntity(alice.workspace,draft.id)))!.data.variants,undefined);
 });
 test('browser media links and OAuth selection preserve the explicitly chosen workspace',async()=>{
  const second=await alice.agent.post('/api/workspaces').set('x-csrf-token',alice.csrf).send({name:'Second workspace'}).expect(201),wid=second.body.workspace.id;
  const uploaded=await alice.agent.post('/api/uploads').set('x-workspace-id',wid).set('x-csrf-token',alice.csrf).attach('file',Buffer.from('Second workspace file'),'second.txt').expect(201);
  await alice.agent.get('/api/files/'+uploaded.body.entity.id).expect(200);
  await bob.agent.get('/api/files/'+uploaded.body.entity.id).expect(404);
  process.env.X_CLIENT_ID='local-test-client';
  try {
   const started=await alice.agent.get('/api/oauth/x/start').query({workspaceId:wid}).expect(302),state=new URL(started.headers.location).searchParams.get('state');
   const [saved]=await db.query('SELECT workspace_id FROM oauth_states WHERE state=$1',[state]);assert.equal(saved.workspace_id,wid);
   await bob.agent.get('/api/oauth/x/start').query({workspaceId:wid}).expect(403);
  } finally {delete process.env.X_CLIENT_ID;}
 });
});

describe('DM rate reservations and routine child lifetime',()=>{
 test('concurrent DM sends share one durable hourly allowance before any provider call',async()=>{
  const f=await automationFixture(),deliveries=await Promise.all(Array.from({length:8},()=>f.delivery()));let calls=0;
  await withDmLimits(2,20,async()=>{
   const results=await Promise.allSettled(deliveries.map(data=>act(f.actor,()=>extras.deliverAutomation(f.actor.workspace,data,async()=>{calls++;return {message_id:'fixture-'+data.deliveryId};}))));
   assert.equal(results.filter(r=>r.status==='fulfilled').length,2);
   const blocked=results.filter((r):r is PromiseRejectedResult=>r.status==='rejected');assert.equal(blocked.length,6);assert.ok(blocked.every(r=>r.reason.status===429&&r.reason.code==='DM_RATE_LIMIT'));
   assert.equal(calls,2);
   const attempted=await db.query('SELECT status,receipt FROM automation_deliveries WHERE workspace_id=$1 AND attempted_at IS NOT NULL',[f.actor.workspace]);assert.equal(attempted.length,2);assert.ok(attempted.every(row=>row.status==='sent'&&row.receipt.messageId));
  });
 });
 test('daily DM allowance includes older-hour attempts and uncertain sends cannot be replayed',async()=>{
  const f=await automationFixture(),old=await f.delivery(),uncertain=await f.delivery(),blocked=await f.delivery();let calls=0;
  await db.query("UPDATE automation_deliveries SET attempted_at=now()-interval '2 hours',status='uncertain' WHERE id=$1",[old.deliveryId]);
  await withDmLimits(1,2,async()=>{
   await assert.rejects(act(f.actor,()=>extras.deliverAutomation(f.actor.workspace,uncertain,async()=>{calls++;throw new Error('Fixture connection closed after write');})),/closed after write/);
   const [row]=await db.query('SELECT status,attempted_at FROM automation_deliveries WHERE id=$1',[uncertain.deliveryId]);assert.equal(row.status,'uncertain');assert.ok(row.attempted_at);
   // Move the most recent attempt outside the hourly window: daily accounting
   // must still block a new send, even without a successful receipt.
   await db.query("UPDATE automation_deliveries SET attempted_at=now()-interval '2 hours' WHERE id=$1",[uncertain.deliveryId]);
   await assert.rejects(act(f.actor,()=>extras.deliverAutomation(f.actor.workspace,blocked,async()=>{calls++;return {message_id:'must-not-run'};})),(error:any)=>error.status===429);
   await db.query("UPDATE automation_deliveries SET attempted_at=now()-interval '2 days' WHERE id=$1",[uncertain.deliveryId]);
   await assert.rejects(act(f.actor,()=>extras.deliverAutomation(f.actor.workspace,uncertain,async()=>{calls++;return {message_id:'must-not-replay'};})),(error:any)=>error.status===409&&error.code==='DELIVERY_ALREADY_ATTEMPTED');
   assert.equal(calls,1);
  });
 });
 test('an in-flight duplicate is rejected and a confirmed DM survives a failed public reply exactly once',async()=>{
  const f=await automationFixture({withLink:true,publicReply:'Fixture public response'}),data=await f.delivery();let calls=0;
  let signal!:()=>void,release!:()=>void;const entered=new Promise<void>(resolve=>signal=resolve),gate=new Promise<void>(resolve=>release=resolve);
  const first=act(f.actor,()=>extras.deliverAutomation(f.actor.workspace,data,async url=>{
   calls++;if(url.endsWith('/messages')){signal();await gate;return {message_id:'confirmed-fixture-dm'};}
   throw new Error('Fixture public reply timeout');
  }));
  try{
   await entered;
   await assert.rejects(act(f.actor,()=>extras.deliverAutomation(f.actor.workspace,data,async()=>{calls++;return {message_id:'duplicate-must-not-send'};})),(error:any)=>error.status===409);
  }finally{release();}
  const result=await first;assert.equal(result.messageId,'confirmed-fixture-dm');assert.equal(result.publicReply.status,'uncertain');assert.equal(calls,2);
  const [stored]=await db.query('SELECT status,receipt,error,attempted_at FROM automation_deliveries WHERE id=$1',[data.deliveryId]);assert.equal(stored.status,'sent');assert.equal(stored.receipt.messageId,'confirmed-fixture-dm');assert.equal(stored.receipt.publicReply.status,'uncertain');assert.match(stored.error,/Private message sent/);assert.ok(stored.attempted_at);
  const retry=await act(f.actor,()=>extras.deliverAutomation(f.actor.workspace,data,async()=>{calls++;return {message_id:'must-not-retry'};}));assert.equal(retry.messageId,'confirmed-fixture-dm');assert.equal(calls,2);
  const [link]=await db.query('SELECT sends FROM short_links WHERE id=$1',[f.linkId]);assert.equal(Number(link.sends),1);
  const history=await f.actor.agent.get(`/api/automations/${f.rule.id}/deliveries`).set('x-workspace-id',f.actor.workspace).expect(200);assert.equal(history.body.deliveries[0].receipt.messageId,'confirmed-fixture-dm');
 });
 test('legacy failed deliveries with receipts migrate to counted successful DMs without losing follow-up errors',async()=>{
  const f=await automationFixture(),data=await f.delivery();
  await db.query("UPDATE automation_deliveries SET status='failed',receipt=$2,error='Legacy follow-up failed' WHERE id=$1",[data.deliveryId,JSON.stringify({messageId:'legacy-confirmed-dm'})]);
  await extras.migrateExtras();
  const [row]=await db.query('SELECT status,attempted_at,receipt,error FROM automation_deliveries WHERE id=$1',[data.deliveryId]);assert.equal(row.status,'sent');assert.ok(row.attempted_at);assert.equal(row.receipt.messageId,'legacy-confirmed-dm');assert.equal(row.error,'Legacy follow-up failed');
 });
 test('routine overlap remains protected after its parent finishes and until the child workflow terminates',async()=>{
  const actor=await isolatedActor(),firstSlot='2026-09-06T16:00:00.000Z',firstNow=new Date('2026-09-06T17:00:00Z'),nextNow=new Date('2026-09-07T17:00:00Z');
  const routine=await act(actor,()=>entities.createEntity(actor.workspace,{kind:'routine',title:'Child lifetime fixture',visibility:'private',data:{enabled:true,workflowId:'idea-engine',cron:'0 9 * * *',timezone:'America/Vancouver',nextRunAt:firstSlot,input:'Fixture only; do not run provider'}}));
  await worker.scheduleRoutines(firstNow);
  const [parent]=await db.query("SELECT id,data FROM jobs WHERE workspace_id=$1 AND kind='routine' AND data->>'routineId'=$2",[actor.workspace,routine.id]);assert.ok(parent);
  const child=await act(actor,()=>worker.executeJob(actor.workspace,'routine',parent.data));
  await db.query("UPDATE jobs SET status='completed',result=$2 WHERE id=$1",[parent.id,JSON.stringify(child)]);
  // Simulate a crash before saving the pointer. The durable child dedupe key
  // must preserve overlap protection even for older jobs without routineId.
  await db.query("UPDATE entities SET data=data-'lastJobId' WHERE id=$1",[routine.id]);
  for(const state of ['pending','running']){
   await db.query('UPDATE jobs SET status=$2 WHERE id=$1',[child.jobId,state]);
   await Promise.all([worker.scheduleRoutines(nextNow),worker.scheduleRoutines(nextNow)]);
   const parents=await db.query("SELECT id FROM jobs WHERE workspace_id=$1 AND kind='routine' AND data->>'routineId'=$2",[actor.workspace,routine.id]);assert.equal(parents.length,1,`Child ${state} must block a second parent`);
  }
  await db.query("UPDATE jobs SET status='completed' WHERE id=$1",[child.jobId]);
  await Promise.all([worker.scheduleRoutines(nextNow),worker.scheduleRoutines(nextNow)]);
  const parents=await db.query("SELECT id FROM jobs WHERE workspace_id=$1 AND kind='routine' AND data->>'routineId'=$2",[actor.workspace,routine.id]);assert.equal(parents.length,2);
  await db.query("UPDATE jobs SET status='cancelled' WHERE workspace_id=$1 AND status IN ('pending','running')",[actor.workspace]);
 });
});
