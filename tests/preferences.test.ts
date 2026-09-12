import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import pg from 'pg';

const connection=process.env.TEST_DATABASE_URL||'postgres://grove:grove_local_only@127.0.0.1:55432/grove';
const url=new URL(connection);if(!['localhost','127.0.0.1'].includes(url.hostname))throw new Error('Preference tests require local PostgreSQL.');
const schema='grove_preferences_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:connection});
await admin.query(`CREATE SCHEMA ${schema}`);url.searchParams.set('options',`-c search_path=${schema},public`);
process.env.DATABASE_URL=url.href;process.env.NODE_ENV='test';process.env.APP_URL='http://localhost:5173';process.env.REGISTRATION_CODE='preferences-local-fixture';process.env.APP_ENCRYPTION_KEY='c'.repeat(64);delete process.env.AZURE_STORAGE_ACCOUNT_URL;
const uploadDir=await mkdtemp(path.join(tmpdir(),'grove-preferences-'));process.env.UPLOAD_DIR=uploadDir;
const db=await import('../server/core/db.js'),auth=await import('../server/core/auth.js'),entities=await import('../server/core/entities.js'),preferences=await import('../server/preferences.js'),files=await import('../server/core/files.js'),reader=await import('../server/reader.js');
const app=express();app.use(express.json(),cookieParser(),auth.csrfProtection);app.use('/api',auth.authRouter,entities.entityRouter,preferences.preferencesRouter,files.fileRouter,reader.readerRouter);app.use((e:any,_req:any,res:any,_next:any)=>res.status(e.status||(e.name==='ZodError'?400:500)).json({error:e.message}));
const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
type Client={agent:ReturnType<typeof request.agent>;csrf:string;workspace:string;userId:string};
async function signup(email:string):Promise<Client>{const agent=request.agent(server),r=await agent.post('/api/auth/register').send({email,name:email,password:'preferences-test-password-123',code:'preferences-local-fixture'}).expect(201);return{agent,csrf:r.body.csrfToken,workspace:r.body.workspace.id,userId:r.body.user.id};}
let alice:Client,bob:Client,note:string,board:string;
before(async()=>{await db.migrate();await preferences.migratePreferences();await reader.migrateReader();alice=await signup('alice@preferences.test');bob=await signup('bob@preferences.test');await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'viewer')",[alice.workspace,bob.userId]);const n=await alice.agent.post('/api/entities').set('x-csrf-token',alice.csrf).send({kind:'item',title:'Shared preference fixture'}).expect(201);note=n.body.entity.id;const b=await alice.agent.post('/api/entities').set('x-csrf-token',alice.csrf).send({kind:'board',title:'Private capture destination',visibility:'private',data:{placements:[]}}).expect(201);board=b.body.entity.id;});
after(async()=>{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await db.closeDb();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();await rm(uploadDir,{recursive:true,force:true});});
const get=(c:Client,workspace=c.workspace)=>c.agent.get('/api/preferences').set('x-workspace-id',workspace);
const change=(c:Client,body:any,workspace=c.workspace)=>c.agent.patch('/api/preferences').set('x-csrf-token',c.csrf).set('x-workspace-id',workspace).send(body);
const item=(c:Client,id:string,action:string,workspace=c.workspace)=>c.agent.post(`/api/preferences/items/${id}`).set('x-csrf-token',c.csrf).set('x-workspace-id',workspace).send({action});

test('personal pins work for a viewer without changing the shared item or other accounts',async()=>{
 const prior=(await alice.agent.get(`/api/entities/${note}`).expect(200)).body.entity;
 await item(bob,note,'pin',alice.workspace).expect(200);
 assert.deepEqual((await get(bob,alice.workspace)).body.preferences.pinnedIds,[note]);
 assert.deepEqual((await get(alice)).body.preferences.pinnedIds,[]);
 assert.deepEqual((await get(bob)).body.preferences.pinnedIds,[]);
 const after=(await alice.agent.get(`/api/entities/${note}`).expect(200)).body.entity;assert.equal(after.version,prior.version);assert.equal(after.starred,false);
 await item(bob,note,'unpin',alice.workspace).expect(200);assert.deepEqual((await get(bob,alice.workspace)).body.preferences.pinnedIds,[]);
});
test('partial filters, pins and recent opens survive concurrent writes without overwriting each other',async()=>{
 const ids=[];for(let i=0;i<8;i++){const r=await alice.agent.post('/api/entities').set('x-csrf-token',alice.csrf).send({kind:'item',title:`Recent ${i}`}).expect(201);ids.push(r.body.entity.id);}
 await Promise.all([change(alice,{library:{view:'list'}}).expect(200),change(alice,{library:{platform:'YouTube',source:'example.test'}}).expect(200),change(alice,{topics:['Research','Research','Writing']}).expect(200),...ids.map(id=>item(alice,id,'pin').expect(200)),...ids.map(id=>item(alice,id,'open').expect(200))]);
 const p=(await get(alice)).body.preferences;assert.deepEqual(new Set(p.pinnedIds),new Set(ids));assert.deepEqual(new Set(p.recentIds),new Set(ids));assert.deepEqual(p.topics,['Research','Writing']);assert.equal(p.library.view,'list');assert.equal(p.library.platform,'YouTube');assert.equal(p.library.source,'example.test');assert.equal(p.library.tab,'all');
 await item(alice,ids[0],'open').expect(200);const later=(await get(alice)).body.preferences;assert.equal(later.recentIds[0],ids[0]);assert.equal(later.recentIds.length,8);
});
test('private and revoked references are removed from responses; capture board requires edit access',async()=>{
 await item(alice,board,'pin').expect(200);await change(alice,{captureBoardId:board}).expect(200);
 await item(bob,board,'pin',alice.workspace).expect(404);await change(bob,{captureBoardId:board},alice.workspace).expect(404);await change(alice,{captureBoardId:note}).expect(404);
 await db.query("INSERT INTO entity_acl(workspace_id,entity_id,user_id,permission) VALUES($1,$2,$3,'view')",[alice.workspace,board,bob.userId]);
 await item(bob,board,'pin',alice.workspace).expect(200);await item(bob,board,'open',alice.workspace).expect(200);await change(bob,{captureBoardId:board},alice.workspace).expect(404);
 await db.query('DELETE FROM entity_acl WHERE entity_id=$1 AND user_id=$2',[board,bob.userId]);const p=(await get(bob,alice.workspace)).body.preferences;assert.deepEqual(p.pinnedIds,[]);assert.deepEqual(p.recentIds,[]);
});
test('request validation, CSRF, foreign-workspace references and membership enforce isolation',async()=>{
 await request(server).get('/api/preferences').expect(401);await alice.agent.patch('/api/preferences').send({topics:['Denied']}).expect(403);
 await get(alice,bob.workspace).expect(403);await change(alice,{pinnedIds:[board]}).expect(400);await change(alice,{library:{view:'injected'}}).expect(400);await change(alice,{library:{unexpected:'value'}}).expect(400);await change(alice,{topics:['x'.repeat(61)]}).expect(400);
 await item(bob,note,'pin').expect(404);await item(alice,randomUUID(),'pin').expect(404);await item(alice,note,'remove').expect(400);
});
test('capture and uploads begin inside the destination board ACL, including private ancestors',async()=>{
 const capture=await alice.agent.post('/api/capture').set('x-csrf-token',alice.csrf).send({url:'https://example.test/selection',title:'Private selected content',content:'Private capture body',parentId:board}).expect(201);assert.equal(capture.body.entity.parentId,board);
 await bob.agent.get(`/api/entities/${capture.body.entity.id}`).set('x-workspace-id',alice.workspace).expect(404);
 const upload=await alice.agent.post('/api/uploads').set('x-csrf-token',alice.csrf).field('parentId',board).attach('file',Buffer.from('Private upload body'),'private.txt').expect(201);assert.equal(upload.body.entity.parentId,board);
 await bob.agent.get(`/api/files/${upload.body.entity.id}`).set('x-workspace-id',alice.workspace).expect(404);
 const recording=await alice.agent.post('/api/uploads').set('x-csrf-token',alice.csrf).field('visibility','private').attach('file',Buffer.from('Private recording fixture'),'recording.webm').expect(201);assert.equal(recording.body.entity.visibility,'private');
 await bob.agent.get(`/api/files/${recording.body.entity.id}`).set('x-workspace-id',alice.workspace).expect(404);
 await alice.agent.post('/api/uploads').set('x-csrf-token',alice.csrf).field('visibility','invalid').attach('file',Buffer.from('Rejected'),'recording.webm').expect(400);
 await alice.agent.post('/api/capture').set('x-csrf-token',alice.csrf).send({url:'https://example.test/selection',content:'Cannot cross workspace',parentId:randomUUID()}).expect(404);
});

test('read-only tokens cannot mutate preferences, while item guests can save their own accessible pins',async()=>{
 const token=await alice.agent.post('/api/tokens').set('x-csrf-token',alice.csrf).send({name:'Read-only preference fixture',scopes:['workspace:read']}).expect(201);
 await request(server).get('/api/preferences').set('authorization',`Bearer ${token.body.token}`).expect(200);
 await request(server).patch('/api/preferences').set('authorization',`Bearer ${token.body.token}`).send({topics:['Not authorized']}).expect(403);
 await request(server).post(`/api/preferences/items/${note}`).set('authorization',`Bearer ${token.body.token}`).send({action:'pin'}).expect(403);
 await db.query('UPDATE memberships SET item_only=true WHERE workspace_id=$1 AND user_id=$2',[alice.workspace,bob.userId]);
 await db.query("INSERT INTO entity_acl(workspace_id,entity_id,user_id,permission) VALUES($1,$2,$3,'view')",[alice.workspace,note,bob.userId]);
 await get(bob,alice.workspace).expect(200);await item(bob,note,'pin',alice.workspace).expect(200);await item(bob,note,'open',alice.workspace).expect(200);
 const personal=(await get(bob,alice.workspace)).body.preferences;assert.deepEqual(personal.pinnedIds,[note]);assert.deepEqual(personal.recentIds,[note]);
 await item(bob,board,'pin',alice.workspace).expect(404);await change(bob,{topics:['Guest topic']},alice.workspace).expect(200);
});


test('personal reader state merges concurrently and does not change the source document',async()=>{
 const prior=(await alice.agent.get(`/api/entities/${note}`)).body.entity;
 const state=(c:Client,method:'get'|'patch',body?:any)=>{const r=c.agent[method](`/api/reader/${note}/state`).set('x-workspace-id',alice.workspace);return method==='patch'?r.set('x-csrf-token',c.csrf).send(body):r;};
 await Promise.all([state(bob,'patch',{progress:0.4,chapter:0,scrollTop:320}).expect(200),state(bob,'patch',{rate:1.25,voice:'Local voice',highlightColor:'green',notes:'A personal annotation, separate from the source.'}).expect(200)]);
 const saved=(await state(bob,'get').expect(200)).body.state;assert.equal(saved.progress,0.4);assert.equal(saved.chapter,0);assert.equal(saved.rate,1.25);assert.match(saved.notes,/personal annotation/);
 const own=(await state(alice,'get').expect(200)).body.state;assert.equal(own.progress,0);assert.equal(own.notes,'');
 const after=(await alice.agent.get(`/api/entities/${note}`)).body.entity;assert.equal(after.version,prior.version);assert.equal(after.content,prior.content);
 await state(bob,'patch',{progress:2}).expect(400);await state(bob,'patch',{chapter:-1}).expect(400);await state(bob,'patch',{notes:'x'.repeat(100001)}).expect(400);
 await bob.agent.get(`/api/reader/${board}/state`).set('x-workspace-id',alice.workspace).expect(404);
 const token=await alice.agent.post('/api/tokens').set('x-csrf-token',alice.csrf).send({name:'Reader state read-only',scopes:['workspace:read']}).expect(201);
 await request(server).patch(`/api/reader/${note}/state`).set('authorization',`Bearer ${token.body.token}`).send({progress:0.5}).expect(403);
});
test('backlinks expose only current readable references and validate mention and highlight inputs',async()=>{
 const create=(body:any)=>alice.agent.post('/api/entities').set('x-csrf-token',alice.csrf).send(body);
 const visible=(await create({kind:'item',title:'Public reference',data:{entityLinks:[note]}}).expect(201)).body.entity;
 const privateLink=(await create({kind:'item',title:'Private reference',visibility:'private',data:{entityLinks:[note]}}).expect(201)).body.entity;
 // Bob is an item guest: grant only the explicit link, never the private one.
 await db.query("INSERT INTO entity_acl(workspace_id,entity_id,user_id,permission) VALUES($1,$2,$3,'view')",[alice.workspace,visible.id,bob.userId]);
 const incoming=await bob.agent.get(`/api/entities/${note}/backlinks`).set('x-workspace-id',alice.workspace).expect(200);assert.ok(incoming.body.entities.some((e:any)=>e.id===visible.id));assert.ok(!incoming.body.entities.some((e:any)=>e.id===privateLink.id));
 await create({kind:'item',title:'Foreign mention',data:{entityLinks:[randomUUID()]}}).expect(400);
 const anchor={start:0,end:4,quote:'text',prefix:'',suffix:'',chapter:0};
 await create({kind:'item',title:'Chapter zero highlight',content:'text',data:{type:'highlight',sourceId:note,anchor,color:'yellow'}}).expect(201);
 await create({kind:'item',title:'Invalid backwards highlight',data:{type:'highlight',sourceId:note,anchor:{...anchor,end:-1}}}).expect(400);
 await db.query('DELETE FROM entity_acl WHERE workspace_id=$1 AND entity_id=$2 AND user_id=$3',[alice.workspace,note,bob.userId]);
 await bob.agent.get(`/api/reader/${note}/state`).set('x-workspace-id',alice.workspace).expect(404);await bob.agent.get(`/api/entities/${note}/backlinks`).set('x-workspace-id',alice.workspace).expect(404);
});

test('public document copies flatten live references without crossing workspace permissions',async()=>{
 const create=(body:any)=>alice.agent.post('/api/entities').set('x-csrf-token',alice.csrf).send(body);
 const source=(await create({kind:'item',title:'Private source',visibility:'private',content:'Unshared source text.'}).expect(201)).body.entity;
 const table=(await create({kind:'table',title:'Private table',visibility:'private',data:{columns:[],rows:[]}}).expect(201)).body.entity;
 const content=`An authored label [@Private source](/library?open=${source.id})\n\n[Table: Private table](/library?open=${table.id}&embed=table)`;
 const editorJSON={type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'An authored label '},{type:'entityMention',attrs:{entityId:source.id,label:'Private source'}}]},{type:'tableReference',attrs:{entityId:table.id,label:'Private table'}}]};
 const note=(await create({kind:'item',title:'Shareable document',content,data:{type:'document',entityLinks:[source.id,table.id],editorJSON,html:`<span data-entity-reference="${source.id}">Private source</span>`}}).expect(201)).body.entity;
 const share=await alice.agent.post(`/api/entities/${note.id}/share`).set('x-csrf-token',alice.csrf).send({enabled:true,allowDuplicate:true}).expect(200);
 const response=await request(server).get(`/api/public/${share.body.token}`).expect(200);
 const shared=JSON.stringify(response.body);assert.equal(shared.includes(source.id),false);assert.equal(shared.includes(table.id),false);assert.equal(shared.includes('Unshared source text.'),false);assert.match(shared,/Private source/);
 const copied=(await bob.agent.post(`/api/public/${share.body.token}/duplicate`).set('x-csrf-token',bob.csrf).expect(201)).body.entity;
 assert.equal(copied.workspaceId,bob.workspace);assert.equal(copied.data.entityLinks,undefined);assert.equal(copied.data.html,undefined);assert.equal(JSON.stringify(copied).includes(source.id),false);assert.equal(JSON.stringify(copied).includes(table.id),false);
 assert.equal(copied.data.editorJSON.content[0].content[1].type,'text');assert.equal(copied.data.editorJSON.content[1].type,'paragraph');
});

test('unavailable existing document links survive edits but cannot be newly attached',async()=>{
 const create=(body:any)=>alice.agent.post('/api/entities').set('x-csrf-token',alice.csrf).send(body);
 const source=(await create({kind:'item',title:'Revocable source',visibility:'private'}).expect(201)).body.entity;
 const document=(await create({kind:'item',title:'Editable linked document',visibility:'private',data:{entityLinks:[source.id]}}).expect(201)).body.entity;
 await db.query("INSERT INTO entity_acl(workspace_id,entity_id,user_id,permission) VALUES($1,$2,$3,'edit')",[alice.workspace,document.id,bob.userId]);
 const edit=(data:any)=>bob.agent.patch(`/api/entities/${document.id}`).set('x-workspace-id',alice.workspace).set('x-csrf-token',bob.csrf).send(data);
 await edit({content:'A permitted unrelated edit.',data:{entityLinks:[source.id]}}).expect(200);
 await alice.agent.delete(`/api/entities/${source.id}`).set('x-csrf-token',alice.csrf).expect(200);
 await edit({title:'Still editable after source deletion'}).expect(200);
 await edit({data:{entityLinks:[]}}).expect(200);
 await edit({data:{entityLinks:[source.id]}}).expect(400);
});
