import {before,after,describe,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtemp,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import pg from 'pg';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';

const connection=process.env.TEST_DATABASE_URL||'postgres://grove:grove_local_only@127.0.0.1:55432/grove';
const url=new URL(connection);if(!['127.0.0.1','localhost'].includes(url.hostname))throw new Error('Quota tests only use local PostgreSQL');
const schema='grove_quota_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:connection});
await admin.query(`CREATE SCHEMA ${schema}`);url.searchParams.set('options',`-c search_path=${schema},public`);
process.env.DATABASE_URL=url.href;process.env.NODE_ENV='test';process.env.OPENAI_API_KEY='local-quota-fixture';
process.env.APP_URL='http://localhost:5173';process.env.REGISTRATION_CODE='quota-fixture-private-code';process.env.APP_ENCRYPTION_KEY='c'.repeat(64);
delete process.env.AZURE_OPENAI_ENDPOINT;delete process.env.AZURE_STORAGE_ACCOUNT_URL;
const uploadDir=await mkdtemp(path.join(tmpdir(),'grove-quota-'));process.env.UPLOAD_DIR=uploadDir;
let providerCalls=0;
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4TcAAAAASUVORK5CYII=','base64');
const multipartCalls:{path:string;model:string;fileName:string;mime:string;bytes:Buffer}[]=[];
const fixture=createServer(async(req,res)=>{
 const chunks=[];for await(const chunk of req)chunks.push(chunk);
 const raw=Buffer.concat(chunks);providerCalls++;
 res.setHeader('Content-Type','application/json');
 if(req.headers['content-type']?.startsWith('multipart/form-data')){
  const form=await new Request('http://fixture.invalid',{method:'POST',headers:{'Content-Type':req.headers['content-type']},body:new Uint8Array(raw)}).formData();
  const file=(form.get('file')||form.get('image')) as File;
  multipartCalls.push({path:req.url||'',model:String(form.get('model')),fileName:file.name,mime:file.type,bytes:Buffer.from(await file.arrayBuffer())});
  if(req.url?.endsWith('/audio/transcriptions'))res.end(JSON.stringify({text:'A metered URL media transcript.'}));
  else if(req.url?.endsWith('/images/edits'))res.end(JSON.stringify({created:Math.floor(Date.now()/1000),data:[{b64_json:png.toString('base64')}]}));
  else {res.statusCode=404;res.end(JSON.stringify({error:{message:'Unknown multipart fixture endpoint'}}));}
  return;
 }
 const body=JSON.parse(raw.toString());
 const serialized=JSON.stringify(body);
 if(serialized.includes('QUOTA_REJECT_FIXTURE')){res.statusCode=400;res.end(JSON.stringify({error:{message:'Rejected fixture request',type:'invalid_request_error'}}));return;}
 if(serialized.includes('QUOTA_UNCERTAIN_FIXTURE')){res.statusCode=503;res.end(JSON.stringify({error:{message:'Uncertain fixture request',type:'server_error'}}));return;}
 if(req.url?.endsWith('/embeddings')){
  const inputs=Array.isArray(body.input)?body.input:[body.input];res.end(JSON.stringify({object:'list',model:body.model,data:inputs.map((_:unknown,index:number)=>({object:'embedding',index,embedding:[1,0,0]})),usage:{prompt_tokens:10,total_tokens:10}}));return;
 }
 res.end(JSON.stringify({id:'resp_quota_'+randomUUID(),object:'response',created_at:Date.now()/1000,status:'completed',model:body.model,output:[{id:'msg_quota',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Measured fixture response.',annotations:[]}]}],...(serialized.includes('QUOTA_MISSING_USAGE_FIXTURE')?{}:{usage:{input_tokens:40,output_tokens:20,total_tokens:60}})}));
});
await new Promise<void>(resolve=>fixture.listen(0,'127.0.0.1',resolve));
process.env.OPENAI_BASE_URL=`http://127.0.0.1:${(fixture.address() as any).port}/v1`;
const db=await import('../server/core/db.js'),quota=await import('../server/quota.js'),files=await import('../server/core/files.js'),entities=await import('../server/core/entities.js'),extras=await import('../server/extras.js'),ai=await import('../server/ai.js');
const media=await import('../server/media-tools.js'),auth=await import('../server/core/auth.js');
const app=express();app.use(express.json(),cookieParser(),auth.csrfProtection);app.use('/api',auth.authRouter,entities.entityRouter,files.fileRouter,media.mediaToolsRouter);
app.use((error:any,_req:any,res:any,_next:any)=>res.status(error.status||(error.name==='ZodError'?400:500)).json({error:error.message,code:error.code}));
const defaults={DAILY_TOKEN_LIMIT:'1000000',STORAGE_LIMIT_MB:'10',DAILY_IMAGE_LIMIT:'100',DAILY_TRANSCRIPTION_LIMIT:'100'};
Object.assign(process.env,defaults);
async function workspace(){return (await db.query("INSERT INTO workspaces(name) VALUES('Quota fixture') RETURNING id"))[0].id as string;}
async function limits<T>(values:Partial<typeof defaults>,fn:()=>Promise<T>){const previous=Object.fromEntries(Object.keys(values).map(key=>[key,process.env[key]]));Object.assign(process.env,values);try{return await fn();}finally{for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}}
const exceeded=(error:any)=>error.status===429;
before(async()=>{await db.migrate();await extras.migrateExtras();});
after(async()=>{await db.closeDb();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();await new Promise<void>(resolve=>fixture.close(()=>resolve()));await rm(uploadDir,{recursive:true,force:true});});

describe('durable workspace quotas',()=>{
 test('concurrent token reservations cannot oversubscribe; settlement is atomic and idempotent',async()=>{
  const id=await workspace();
  await limits({DAILY_TOKEN_LIMIT:'1000'},async()=>{
   const attempts=await Promise.allSettled(Array.from({length:20},()=>quota.reserveQuota(id,'tokens',80)));
   const accepted=attempts.filter((r):r is PromiseFulfilledResult<Awaited<ReturnType<typeof quota.reserveQuota>>>=>r.status==='fulfilled');
   const denied=attempts.filter((r):r is PromiseRejectedResult=>r.status==='rejected');
   assert.equal(accepted.length,12);assert.equal(denied.length,8);assert.ok(denied.every(r=>exceeded(r.reason)));
   assert.deepEqual((await quota.quotaStatus(id)).tokens,{used:0,reserved:960,limit:1000,remaining:40});
   await Promise.all(accepted.map(r=>quota.settleAiQuota(r.value,{action:'fixture',model:'fixture'},{inputTokens:7,outputTokens:3})));
   await quota.settleAiQuota(accepted[0].value,{action:'fixture',model:'fixture'},{inputTokens:7,outputTokens:3});
   assert.deepEqual((await quota.quotaStatus(id)).tokens,{used:120,reserved:0,limit:1000,remaining:880});
   const exact=await quota.reserveQuota(id,'tokens',880);await assert.rejects(quota.reserveQuota(id,'tokens',1),exceeded);
   await quota.releaseQuota(exact);await quota.releaseQuota(exact);
   assert.equal((await quota.quotaStatus(id)).tokens.remaining,880);
   const other=await workspace(),separate=await quota.reserveQuota(other,'tokens',1000);await quota.releaseQuota(separate);
  });
 });
 test('text and both embedding calls use actual provider tokens and reject before a provider call',async()=>{
  const id=await workspace(),note=await entities.createEntity(id,{kind:'item',title:'Fixture source',content:'A short garden note.'});
  const initial=providerCalls;
  await ai.generate(id,{input:'Summarize the note',sourceIds:[note.id]});
  assert.equal(providerCalls,initial+1);assert.equal((await quota.quotaStatus(id)).tokens.used,60);
  await ai.semanticSearch(id,'garden');assert.equal(providerCalls,initial+3);
  assert.deepEqual((await quota.quotaStatus(id)).tokens,{used:80,reserved:0,limit:1_000_000,remaining:999920});
  await limits({DAILY_TOKEN_LIMIT:'80'},async()=>{
   await assert.rejects(ai.generate(id,{input:'Should be blocked',sourceIds:[note.id]}),exceeded);
   await assert.rejects(ai.semanticSearch(id,'garden'),exceeded);
  });
  assert.equal(providerCalls,initial+3);
 });
 test('rejected provider requests release allowance; uncertain requests remain held with no automatic retry',async()=>{
  const id=await workspace(),note=await entities.createEntity(id,{kind:'item',title:'Fixture source'}),initial=providerCalls;
  await assert.rejects(ai.generate(id,{input:'QUOTA_REJECT_FIXTURE',sourceIds:[note.id]}),/Rejected fixture/);
  assert.equal((await quota.quotaStatus(id)).tokens.reserved,0);
  await assert.rejects(ai.generate(id,{input:'QUOTA_UNCERTAIN_FIXTURE',sourceIds:[note.id]}),/Uncertain fixture/);
  const held=(await quota.quotaStatus(id)).tokens;assert.equal(held.used,0);assert.ok(held.reserved>5500);assert.equal(providerCalls,initial+2);
  await db.query("UPDATE quota_reservations SET expires_at=now()-interval '1 second' WHERE workspace_id=$1",[id]);
  assert.equal((await quota.quotaStatus(id)).tokens.reserved,0);
 });
 test('missing token usage is conservatively recorded instead of receiving free allowance',async()=>{
  const id=await workspace(),note=await entities.createEntity(id,{kind:'item',title:'Fixture source'});
  await ai.generate(id,{input:'QUOTA_MISSING_USAGE_FIXTURE',sourceIds:[note.id]});
  const events=await db.query('SELECT input_tokens,output_tokens,usage_estimated FROM usage_events WHERE workspace_id=$1',[id]);
  assert.equal(events.length,1);assert.equal(events[0].usage_estimated,true);assert.equal(Number(events[0].output_tokens),5500);assert.ok(Number(events[0].input_tokens)>1024);
  assert.equal((await quota.quotaStatus(id)).tokens.reserved,0);
 });
 test('image and transcription caps reserve concurrent requests and settle separately from tokens',async()=>{
  const id=await workspace();
  await limits({DAILY_IMAGE_LIMIT:'1',DAILY_TRANSCRIPTION_LIMIT:'1'},async()=>{
   for(const kind of ['image','transcription'] as const){
    const held=await quota.reserveQuota(id,kind,1);let called=false;
    await assert.rejects(quota.meteredAiRequest(id,{kind,amount:1,action:kind,model:'fixture'},async()=>{called=true;return {};}),exceeded);assert.equal(called,false);
    await quota.settleAiQuota(held,{action:kind,model:'fixture'});
    assert.equal((await quota.quotaStatus(id))[kind].used,1);
    await assert.rejects(quota.reserveQuota(id,kind,1),exceeded);
   }
   assert.equal((await quota.quotaStatus(id)).tokens.used,0);
  });
 });
 test('URL media transcription meters multipart provider usage and rejects the next request before calling the provider',async()=>{
  const id=await workspace(),audio=Buffer.from('RIFF fixture audio bytes');
  await limits({DAILY_TRANSCRIPTION_LIMIT:'1'},async()=>{
   const initial=providerCalls;
   // Exercise the helper used by the public-URL audio/video route without
   // weakening SSRF checks to permit a localhost media source in production.
   const result=await media.transcribeMediaBuffer(id,audio,'authorized-source.wav','audio/wav');
   assert.equal(result.text,'A metered URL media transcript.');assert.equal(providerCalls,initial+1);
   const received=multipartCalls.at(-1)!;assert.equal(received.path,'/v1/audio/transcriptions');assert.equal(received.fileName,'authorized-source.wav');assert.equal(received.mime,'audio/wav');assert.deepEqual(received.bytes,audio);
   assert.deepEqual((await quota.quotaStatus(id)).transcription,{used:1,reserved:0,limit:1,remaining:0});
   const [event]=await db.query('SELECT action,quota_kind FROM usage_events WHERE workspace_id=$1',[id]);assert.equal(event.action,'transcription-url');assert.equal(event.quota_kind,'transcription');
   await assert.rejects(media.transcribeMediaBuffer(id,audio,'second.wav','audio/wav'),exceeded);assert.equal(providerCalls,initial+1);
  });
 });
 test('authenticated image editing honors a zero image cap and meters a successful multipart edit',async()=>{
  const agent=request.agent(app);
  const registration=await agent.post('/api/auth/register').send({name:'Quota editor',email:'image-quota@example.test',password:'fixture-password-12345',code:'quota-fixture-private-code'}).expect(201);
  const csrf=registration.body.csrfToken,id=registration.body.workspace.id;
  const uploaded=await agent.post('/api/uploads').set('x-csrf-token',csrf).attach('file',png,'original.png').expect(201);
  const initial=providerCalls;
  await limits({DAILY_IMAGE_LIMIT:'0'},async()=>{
   const denied=await agent.post('/api/ai/image/edit').set('x-csrf-token',csrf).send({imageId:uploaded.body.entity.id,prompt:'Change the background.'}).expect(429);
   assert.equal(denied.body.code,'AI_QUOTA_EXCEEDED');assert.equal(providerCalls,initial);
   assert.equal((await quota.quotaStatus(id)).image.reserved,0);
  });
  await limits({DAILY_IMAGE_LIMIT:'1'},async()=>{
   const edited=await agent.post('/api/ai/image/edit').set('x-csrf-token',csrf).send({imageId:uploaded.body.entity.id,prompt:'Change the background.'}).expect(200);
   assert.equal(edited.body.entity.visibility,'private');assert.equal(edited.body.entity.data.sourceId,uploaded.body.entity.id);assert.equal(providerCalls,initial+1);
   const received=multipartCalls.at(-1)!;assert.equal(received.path,'/v1/images/edits');assert.equal(received.mime,'image/png');assert.deepEqual(received.bytes,png);
   assert.deepEqual((await quota.quotaStatus(id)).image,{used:1,reserved:0,limit:1,remaining:0});
   await agent.post('/api/ai/image/edit').set('x-csrf-token',csrf).send({imageId:uploaded.body.entity.id,prompt:'Another edit.'}).expect(429);assert.equal(providerCalls,initial+1);
   const [event]=await db.query('SELECT action,quota_kind FROM usage_events WHERE workspace_id=$1',[id]);assert.equal(event.action,'image-edit');assert.equal(event.quota_kind,'image');
  });
 });
 test('concurrent uploads reserve bytes before writing and never exceed the storage cap',async()=>{
  const id=await workspace();
  await limits({STORAGE_LIMIT_MB:String(1024/(1024*1024))},async()=>{
   const attempts=await Promise.allSettled(Array.from({length:8},(_,index)=>files.saveFile(id,{buffer:Buffer.alloc(700,'a'),name:`concurrent-${index}.txt`,mime:'text/plain'})));
   const accepted=attempts.filter((r):r is PromiseFulfilledResult<Awaited<ReturnType<typeof files.saveFile>>>=>r.status==='fulfilled');
   const denied=attempts.filter((r):r is PromiseRejectedResult=>r.status==='rejected');
   assert.equal(accepted.length,1);assert.equal(denied.length,7);assert.ok(denied.every(r=>exceeded(r.reason)));
   assert.deepEqual((await quota.quotaStatus(id)).storage,{used:700,reserved:0,limit:1024,remaining:324});
   const diskEntries=await readdir(path.join(uploadDir,id),{recursive:true,withFileTypes:true});assert.equal(diskEntries.filter(e=>e.isFile()).length,1);
   // A logical duplicate references the same object and does not double-count.
   const copy=await entities.createEntity(id,{kind:'item',title:'Duplicate reference'});
   await db.query('INSERT INTO files(id,workspace_id,storage_key,original_name,mime,size,backend) SELECT $1,workspace_id,storage_key,original_name,mime,size,backend FROM files WHERE id=$2',[copy.id,accepted[0].value.id]);
   await entities.deleteEntity(id,accepted[0].value.id);assert.equal((await quota.quotaStatus(id)).storage.used,700);
   await files.saveFile(id,{buffer:Buffer.alloc(324,'b'),name:'exact-boundary.txt',mime:'text/plain'});
   assert.equal((await quota.quotaStatus(id)).storage.remaining,0);
   await assert.rejects(files.saveFile(id,{buffer:Buffer.from('x'),name:'over.txt',mime:'text/plain'}),exceeded);
  });
 });
 test('failed file metadata writes remove uploaded bytes, incomplete entities, and reservations',async()=>{
  const id=await workspace();
  await db.query("CREATE FUNCTION reject_file_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture file insert rejected'; END $$; CREATE TRIGGER reject_file_fixture BEFORE INSERT ON files FOR EACH ROW EXECUTE FUNCTION reject_file_fixture()");
  try{await assert.rejects(files.saveFile(id,{buffer:Buffer.from('temporary bytes'),name:'failed-metadata.txt',mime:'text/plain'}),/fixture file insert rejected/);}
  finally{await db.query('DROP TRIGGER reject_file_fixture ON files; DROP FUNCTION reject_file_fixture()');}
  const entries=await readdir(path.join(uploadDir,id),{recursive:true,withFileTypes:true});assert.equal(entries.filter(e=>e.isFile()).length,0);
  assert.equal((await db.query('SELECT id FROM entities WHERE workspace_id=$1',[id])).length,0);
  assert.equal((await quota.quotaStatus(id)).storage.reserved,0);assert.equal((await quota.quotaStatus(id)).storage.used,0);
 });
 test('failed local writes release confirmed absent bytes while crash reservations remain durable',async()=>{
  const id=await workspace(),invalidRoot=path.join(uploadDir,'not-a-directory');await writeFile(invalidRoot,'fixture');
  process.env.UPLOAD_DIR=invalidRoot;
  try{await assert.rejects(files.saveFile(id,{buffer:Buffer.from('bytes'),name:'failed-write.txt',mime:'text/plain'}));}
  finally{process.env.UPLOAD_DIR=uploadDir;}
  assert.equal((await quota.quotaStatus(id)).storage.reserved,0);
  await limits({STORAGE_LIMIT_MB:String(100/(1024*1024))},async()=>{
   const held=await quota.reserveQuota(id,'storage',100,{storageKey:'crashed-upload-fixture'});
   await db.query("UPDATE quota_reservations SET created_at=now()-interval '2 days' WHERE id=$1",[held.id]);
   await assert.rejects(files.saveFile(id,{buffer:Buffer.from('x'),name:'blocked.txt',mime:'text/plain'}),exceeded);
   assert.equal((await quota.quotaStatus(id)).storage.reserved,100);await quota.releaseQuota(held);
  });
 });
});
