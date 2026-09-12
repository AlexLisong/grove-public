import {after,before,describe,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import pg from 'pg';
import {crc32,deflateRawSync} from 'node:zlib';

// Every run gets a private schema, so the tests cannot erase a development
// account or race other suites. Remote databases require explicit opt-in.
const connection=process.env.TEST_DATABASE_URL || 'postgres://grove:grove_local_only@127.0.0.1:55432/grove';
const schema=`grove_core_test_${randomUUID().replaceAll('-','')}`;
const baseUrl=new URL(connection);
if (!['127.0.0.1','localhost'].includes(baseUrl.hostname) && !process.env.ALLOW_REMOTE_TEST_DATABASE) throw new Error('Core tests require a local or explicitly allowed test database.');
const admin=new pg.Pool({connectionString:connection});
await admin.query(`CREATE SCHEMA ${schema}`);
baseUrl.searchParams.set('options',`-c search_path=${schema},public`);
process.env.DATABASE_URL=baseUrl.href;
process.env.APP_URL='http://localhost:5173';
process.env.REGISTRATION_CODE='test-private-invite-code';
process.env.APP_ENCRYPTION_KEY='a'.repeat(64);
process.env.NODE_ENV='test';
delete process.env.AZURE_STORAGE_ACCOUNT_URL;
const uploadDir=await mkdtemp(path.join(tmpdir(),'grove-core-'));
process.env.UPLOAD_DIR=uploadDir;
const db=await import('../server/core/db.js');
const auth=await import('../server/core/auth.js');
const entities=await import('../server/core/entities.js');
const files=await import('../server/core/files.js');
const security=await import('../server/core/security.js');
const jobs=await import('../server/core/jobs.js');
const access=await import('../server/core/access.js');
const archives=await import('../server/core/archives.js');
const app=express();
app.use(express.json({limit:'2mb'}),cookieParser(),auth.csrfProtection);
app.use('/api',auth.authRouter,entities.entityRouter,files.fileRouter,jobs.jobRouter);
app.use((error:any,_req:any,res:any,_next:any) => res.status(error.status || (error.name==='ZodError' ? 400 : 500)).json({error:error.message,code:error.code}));
type Client={agent:ReturnType<typeof request.agent>;csrf:string;workspace:string;userId:string};
async function signup(email:string,name:string,code='test-private-invite-code'):Promise<Client> {
  const agent=request.agent(app);
  const response=await agent.post('/api/auth/register').send({email,name,password:'test-password-long-123',code}).expect(201);
  return {agent,csrf:response.body.csrfToken,workspace:response.body.workspace.id,userId:response.body.user.id};
}
let alice:Client,bob:Client;
before(async () => {await db.migrate();alice=await signup('alice@example.test','Alice');bob=await signup('bob@example.test','Bob');});
after(async () => {jobs.stopJobHeartbeats();await db.closeDb();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();await rm(uploadDir,{recursive:true,force:true});});

describe('private workspace, persistence, and authorization', () => {
  test('signup is invitation-only; sessions use secure cookie flags and constant auth errors',async () => {
    await request(app).post('/api/auth/register').send({name:'Eve',email:'eve@example.test',password:'test-password-long-123',code:'wrong'}).expect(403);
    const login=await request(app).post('/api/auth/login').send({email:'alice@example.test',password:'test-password-long-123'}).expect(200);
    assert.match(String(login.headers['set-cookie']),/HttpOnly/);assert.match(String(login.headers['set-cookie']),/SameSite=Lax/);
    const wrong=await request(app).post('/api/auth/login').send({email:'alice@example.test',password:'wrong'}).expect(401);
    const absent=await request(app).post('/api/auth/login').send({email:'nobody@example.test',password:'wrong'}).expect(401);
    assert.deepEqual(wrong.body,absent.body);
    const me=await alice.agent.get('/api/auth/me').expect(200);assert.equal(me.body.user.email,'alice@example.test');assert.equal(me.body.csrfToken,alice.csrf);
  });
  test('cookie mutations require CSRF and same origin',async () => {
    await alice.agent.post('/api/entities').send({kind:'item',title:'Denied'}).expect(403);
    await alice.agent.post('/api/entities').set('x-csrf-token','incorrect').send({kind:'item',title:'Denied'}).expect(403);
    await alice.agent.post('/api/entities').set('x-csrf-token',alice.csrf).set('origin','https://attacker.example').send({kind:'item',title:'Denied'}).expect(403);
    await request(app).post('/api/auth/login').set('origin','https://attacker.example').send({email:'alice@example.test',password:'test-password-long-123'}).expect(403);
  });
  test('entity CRUD, version history, parent refs, and comments cannot cross workspaces',async () => {
    const created=await alice.agent.post('/api/entities').set('x-csrf-token',alice.csrf).send({kind:'item',title:'Private note',content:'Secret alpha',tags:['research']}).expect(201);
    const id=created.body.entity.id;
    await bob.agent.get(`/api/entities/${id}`).expect(404);
    await bob.agent.patch(`/api/entities/${id}`).set('x-csrf-token',bob.csrf).send({content:'stolen'}).expect(404);
    await bob.agent.delete(`/api/entities/${id}`).set('x-csrf-token',bob.csrf).expect(404);
    await bob.agent.get(`/api/entities/${id}/history`).expect(404);
    await bob.agent.get(`/api/entities/${id}/comments`).expect(404);
    await bob.agent.get('/api/entities').set('x-workspace-id',alice.workspace).expect(403);
    await bob.agent.post('/api/entities').set('x-csrf-token',bob.csrf).send({kind:'custom-ai',title:'Cross source',data:{sourceIds:[id]}}).expect(400);
    const changed=await alice.agent.patch(`/api/entities/${id}`).set('x-csrf-token',alice.csrf).send({version:1,title:'Updated note',content:'Version two'}).expect(200);
    assert.equal(changed.body.entity.version,2);
    await alice.agent.patch(`/api/entities/${id}`).set('x-csrf-token',alice.csrf).send({version:1,title:'Lost update'}).expect(409);
    const history=await alice.agent.get(`/api/entities/${id}/history`).expect(200);assert.equal(history.body.history.length,2);assert.equal(history.body.history[1].snapshot.content,'Secret alpha');
    const restored=await alice.agent.post(`/api/entities/${id}/history/1/restore`).set('x-csrf-token',alice.csrf).expect(200);assert.equal(restored.body.entity.content,'Secret alpha');
    const search=await alice.agent.get('/api/entities?q=alpha&tag=research').expect(200);assert.ok(search.body.entities.some((e:any) => e.id===id));
    const comment=await alice.agent.post(`/api/entities/${id}/comments`).set('x-csrf-token',alice.csrf).send({content:'Review this note'}).expect(201);
    await bob.agent.delete(`/api/comments/${comment.body.comment.id}`).set('x-csrf-token',bob.csrf).expect(404);
    await alice.agent.delete(`/api/entities/${id}`).set('x-csrf-token',alice.csrf).expect(200);
    await alice.agent.get(`/api/entities/${id}`).expect(404);
    const trash=await alice.agent.get('/api/entities?trash=true').expect(200);assert.ok(trash.body.entities.some((e:any)=>e.id===id));
    await alice.agent.post(`/api/entities/${id}/restore`).set('x-csrf-token',alice.csrf).expect(200);
    assert.equal((await entities.getEntity(alice.workspace,id))?.content,'Secret alpha');
  });
  test('public shares contain only explicit references, redact source context, and revoke immediately',async () => {
    const visible=await entities.createEntity(alice.workspace,{kind:'item',title:'Shared note',content:'Visible'});
    const hidden=await entities.createEntity(alice.workspace,{kind:'item',title:'Hidden note',content:'Not shared'});
    const custom=await entities.createEntity(alice.workspace,{kind:'custom-ai',title:'Shared assistant',data:{instructions:'Help write',sourceIds:[hidden.id]}});
    const board=await entities.createEntity(alice.workspace,{kind:'board',title:'Public board',data:{placements:[{id:visible.id,x:0,y:0},{id:custom.id,x:300,y:0}]}});
    const share=await alice.agent.post(`/api/entities/${board.id}/share`).set('x-csrf-token',alice.csrf).send({enabled:true,allowDuplicate:true}).expect(200);
    const publicResult=await request(app).get(`/api/public/${share.body.token}`).expect(200);
    assert.deepEqual(publicResult.body.entities.map((e:any)=>e.id).sort(),[visible.id,custom.id].sort());
    assert.equal(JSON.stringify(publicResult.body).includes(hidden.id),false);
    assert.equal(JSON.stringify(publicResult.body).includes('Not shared'),false);
    const duplicate=await bob.agent.post(`/api/public/${share.body.token}/duplicate`).set('x-csrf-token',bob.csrf).expect(201);
    assert.equal(duplicate.body.entity.workspaceId,bob.workspace);assert.equal(duplicate.body.entities.length,2);
    const placements=duplicate.body.entity.data.placements;assert.ok(placements.every((p:any)=>duplicate.body.entities.some((e:any)=>e.id===p.id)));
    await alice.agent.post(`/api/entities/${board.id}/share`).set('x-csrf-token',alice.csrf).send({enabled:false,allowDuplicate:false}).expect(200);
    await request(app).get(`/api/public/${share.body.token}`).expect(404);
  });
  test('draft status and service records cannot be forged; editing resets approval',async () => {
    await alice.agent.post('/api/entities').set('x-csrf-token',alice.csrf).send({kind:'workflow-run',title:'Fake success'}).expect(403);
    await alice.agent.post('/api/entities').set('x-csrf-token',alice.csrf).send({kind:'draft',title:'Bypass',data:{status:'published',receipts:[{id:'fake'}]}}).expect(400);
    const draft=await entities.createEntity(alice.workspace,{kind:'draft',title:'Approved',content:'Approved words',data:{status:'approved',approvedAt:new Date().toISOString(),platforms:['x']}});
    await alice.agent.patch(`/api/entities/${draft.id}`).set('x-csrf-token',alice.csrf).send({data:{...draft.data,status:'published'}}).expect(400);
    const edit=await alice.agent.patch(`/api/entities/${draft.id}`).set('x-csrf-token',alice.csrf).send({content:'Changed after approval'}).expect(200);
    assert.equal(edit.body.entity.data.status,'draft');assert.equal(edit.body.entity.data.approvedAt,undefined);
  });
  test('manual member invitations enforce email, viewer role, and API token scopes',async () => {
    const invite=await alice.agent.post(`/api/workspaces/${alice.workspace}/invite`).set('x-csrf-token',alice.csrf).send({email:'viewer@example.test',role:'viewer'}).expect(201);
    await bob.agent.post('/api/invitations/accept').set('x-csrf-token',bob.csrf).send({token:invite.body.token}).expect(403);
    const viewer=await signup('viewer@example.test','Viewer',invite.body.token);
    assert.equal(viewer.workspace,alice.workspace);
    await viewer.agent.post('/api/entities').set('x-csrf-token',viewer.csrf).send({kind:'item',title:'Forbidden'}).expect(403);
    await viewer.agent.post('/api/tokens').set('x-csrf-token',viewer.csrf).send({name:'No escalation',scopes:['workspace:write']}).expect(403);
    const token=await alice.agent.post('/api/tokens').set('x-csrf-token',alice.csrf).send({name:'Read only',scopes:['workspace:read']}).expect(201);
    await request(app).get('/api/entities').set('authorization',`Bearer ${token.body.token}`).expect(200);
    await request(app).post('/api/entities').set('authorization',`Bearer ${token.body.token}`).send({kind:'item',title:'Denied'}).expect(403);
    await request(app).get('/api/entities').set('authorization',`Bearer ${token.body.token}`).set('x-workspace-id',bob.workspace).expect(403);
    await request(app).get('/api/workspaces').set('authorization',`Bearer ${token.body.token}`).expect(403);
    await alice.agent.delete(`/api/tokens/${token.body.id}`).set('x-csrf-token',alice.csrf).expect(200);
    await request(app).get('/api/entities').set('authorization',`Bearer ${token.body.token}`).expect(401);
  });
});

describe('bounded private ingestion and safe remote URLs',() => {
  test('private files persist, duplicate, and cannot be read in another workspace',async () => {
    const upload=await alice.agent.post('/api/uploads').set('x-csrf-token',alice.csrf).attach('file',Buffer.from('# Research\nPrivate uploaded content'),'research.md').expect(201);
    assert.equal(upload.body.entity.content,'# Research\nPrivate uploaded content');
    const id=upload.body.entity.id;
    const download=await alice.agent.get(`/api/files/${id}`).expect(200);assert.match(download.headers['content-disposition'],/attachment/);
    await bob.agent.get(`/api/files/${id}`).expect(404);
    const copy=await alice.agent.post(`/api/entities/${id}/duplicate`).set('x-csrf-token',alice.csrf).expect(201);
    assert.equal((await files.readFile(alice.workspace,copy.body.entity.id)).buffer.toString(),'# Research\nPrivate uploaded content');
    await alice.agent.post('/api/uploads').set('x-csrf-token',alice.csrf).attach('file',Buffer.from('MZ harmful'),'photo.png').expect(415);
    await alice.agent.post('/api/uploads').set('x-csrf-token',alice.csrf).attach('file',Buffer.from('<script>alert(1)</script>'),'bad.svg').expect(415);
  });
  test('imports support structured CSV, Markdown, HTML and ENEX without executing content',async () => {
    const csv=await alice.agent.post('/api/imports').set('x-csrf-token',alice.csrf).field('format','csv').attach('file',Buffer.from('Name,Count\n"One, two",3\nThree,4'),'table.csv').expect(201);
    assert.equal(csv.body.entities[0].kind,'table');assert.equal(csv.body.entities[0].data.rows[0].cells.col_0,'One, two');
    assert.equal(files.parseImport(Buffer.from('# Headline\nBody'),'note.md')[0].title,'Headline');
    const html=files.parseImport(Buffer.from('<html><head><title>Imported</title></head><body><p>Public article</p><script>privateEvil()</script></body></html>'),'note.html')[0];
    assert.equal(html.title,'Imported');assert.equal(html.content?.includes('privateEvil'),false);
    const enex=files.parseImport(Buffer.from('<en-export><note><title>Evernote</title><content><![CDATA[<en-note><p>A note</p></en-note>]]></content><tag>keep</tag></note></en-export>'),'notes.enex')[0];
    assert.equal(enex.content,'A note');assert.deepEqual(enex.tags,['keep']);
    assert.throws(()=>files.parseImport(Buffer.from('<!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><en-export/>'),'notes.enex'),/entity declarations/);
    const exported=await alice.agent.get('/api/export?format=json').expect(200);assert.equal(exported.body.format,'grove-export-v1');assert.ok(exported.body.entities.length>0);
  });
  test('SSRF rejects private, mapped, metadata, credentials, ports and non-HTTP schemes',async () => {
    const urls=['http://127.0.0.1/','http://2130706433/','http://0177.0.0.1/','http://[::1]/','http://[::ffff:127.0.0.1]/','http://169.254.169.254/metadata','http://10.1.2.3/','http://100.64.0.1/','http://192.168.1.1/','http://198.18.0.1/','http://192.0.2.1/','https://user:password@example.com/','http://example.com:8080/','file:///etc/passwd','ftp://example.com/test'];
    for (const url of urls) await assert.rejects(security.safeFetch(url), (error:any) => error.status===400,url);
    assert.equal(security.isPublicAddress('8.8.8.8'),true);assert.equal(security.isPublicAddress('2606:4700:4700::1111'),true);
    await alice.agent.post('/api/capture').set('x-csrf-token',alice.csrf).send({url:'http://127.0.0.1:80/'}).expect(400);
    const selected=await alice.agent.post('/api/capture').set('x-csrf-token',alice.csrf).send({url:'https://example.com/signed-in-page',title:'Saved selection',content:'User selected text'}).expect(201);
    assert.equal(selected.body.entity.data.captureSource,'user-selection');
  });
  test('encrypted secrets reject tampering and never equal stored plaintext',() => {
    const cipher=security.encryptSecret('provider-secret');assert.notEqual(cipher,'provider-secret');assert.equal(security.decryptSecret(cipher),'provider-secret');
    const parts=cipher.split('.');parts[3]=Buffer.from('tampered').toString('base64url');assert.throws(()=>security.decryptSecret(parts.join('.')));
  });
});

describe('durable jobs, deduplication, and crash recovery',() => {
  test('parallel claimers own each job once and duplicate enqueue keys reuse a record',async () => {
    const originals=await Promise.all(Array.from({length:10},(_,i)=>jobs.enqueue(alice.workspace,'workflow',{index:i},undefined,`workflow-${i}`)));
    const duplicate=await jobs.enqueue(alice.workspace,'workflow',{index:100},undefined,'workflow-0');assert.equal(duplicate.id,originals[0].id);
    const claimed=(await Promise.all(Array.from({length:20},()=>jobs.claimJob()))).filter((job):job is NonNullable<typeof job>=>!!job);
    assert.equal(claimed.length,10);assert.equal(new Set(claimed.map(job=>job.id)).size,10);
    for(const job of claimed) await jobs.finishJob(job.id,{ok:true},job.leaseToken);
    const list=await alice.agent.get('/api/jobs').expect(200);assert.equal(list.body.jobs.filter((job:any)=>job.status==='completed').length,10);
    assert.equal(JSON.stringify(list.body).includes('leaseToken'),false);
    await bob.agent.get(`/api/jobs/${originals[0].id}`).expect(404);
  });
  test('publishing never retries uncertain sends and stale lease completion is rejected',async () => {
    const publish=await jobs.enqueue(alice.workspace,'publish',{draftId:randomUUID()});
    const claimed=await jobs.claimJob();assert.equal(claimed!.id,publish.id);
    await assert.rejects(jobs.finishJob(publish.id,{ok:true},randomUUID()),(error:any)=>error.code==='JOB_LEASE');
    await jobs.failJob(publish.id,'Provider timed out after send',claimed!.leaseToken);
    const [row]=await db.query('SELECT status,attempts FROM jobs WHERE id=$1',[publish.id]);assert.equal(row.status,'failed');assert.equal(row.attempts,1);
    const crashed=await jobs.enqueue(alice.workspace,'publish',{draftId:randomUUID()});
    await db.query("UPDATE jobs SET status='running',attempts=1,lease_until=now()-interval '1 second',lease_token=$2 WHERE id=$1",[crashed.id,randomUUID()]);
    assert.equal(await jobs.claimJob(),null);
    const [recovered]=await db.query('SELECT status,error FROM jobs WHERE id=$1',[crashed.id]);assert.equal(recovered.status,'failed');assert.match(recovered.error,/Verify the provider outcome/);
  });
  test('safe jobs retry with backoff; future jobs wait and pending jobs can cancel',async () => {
    const safe=await jobs.enqueue(alice.workspace,'workflow',{input:'Retry safely'});
    const claimed=await jobs.claimJob();assert.equal(claimed!.id,safe.id);
    await jobs.failJob(safe.id,'Transient API timeout',claimed!.leaseToken);
    const [row]=await db.query('SELECT status,run_at FROM jobs WHERE id=$1',[safe.id]);assert.equal(row.status,'pending');assert.ok(new Date(row.run_at).getTime()>Date.now());
    assert.equal(await jobs.claimJob(),null);
    await alice.agent.post(`/api/jobs/${safe.id}/cancel`).set('x-csrf-token',alice.csrf).expect(200);
    const future=await jobs.enqueue(alice.workspace,'workflow',{},new Date(Date.now()+86400_000));assert.equal(await jobs.claimJob(),null);
    await bob.agent.post(`/api/jobs/${future.id}/cancel`).set('x-csrf-token',bob.csrf).expect(409);
  });
});

describe('private entity ACLs and item-only guest invitations',() => {
  test('same-workspace members, serverless reads, history, AI source refs and files respect privacy',async () => {
    const invite=await alice.agent.post(`/api/workspaces/${alice.workspace}/invite`).set('x-csrf-token',alice.csrf).send({email:'editor@example.test',role:'editor'}).expect(201);
    const editor=await signup('editor@example.test','Editor',invite.body.token);
    const secret=await alice.agent.post('/api/entities').set('x-csrf-token',alice.csrf).send({kind:'item',title:'Private strategy',content:'Alice-only sensitive content',visibility:'private'}).expect(201);
    const id=secret.body.entity.id;assert.equal(secret.body.entity.createdBy,alice.userId);
    await editor.agent.get(`/api/entities/${id}`).expect(404);
    await editor.agent.get(`/api/entities/${id}/history`).expect(404);
    await editor.agent.get(`/api/entities/${id}/comments`).expect(404);
    await editor.agent.patch(`/api/entities/${id}`).set('x-csrf-token',editor.csrf).send({content:'Cannot overwrite'}).expect(404);
    const listed=await editor.agent.get('/api/entities').expect(200);assert.equal(listed.body.entities.some((e:any)=>e.id===id),false);
    const exported=await editor.agent.get('/api/export?format=json').expect(200);assert.equal(JSON.stringify(exported.body).includes('Alice-only sensitive content'),false);
    await editor.agent.post('/api/entities').set('x-csrf-token',editor.csrf).send({kind:'custom-ai',title:'Leak attempt',data:{sourceIds:[id]}}).expect(400);
    assert.equal(await entities.getEntity(alice.workspace,id),null);
    const ownerRead=await access.runAsActor(alice.workspace,alice.userId,()=>entities.getEntity(alice.workspace,id));assert.equal(ownerRead?.content,'Alice-only sensitive content');
    const deniedRead=await access.runAsActor(alice.workspace,editor.userId,()=>entities.getEntity(alice.workspace,id));assert.equal(deniedRead,null);
    const file=await alice.agent.post('/api/uploads').set('x-csrf-token',alice.csrf).attach('file',Buffer.from('private file'),'private.txt').expect(201);
    await alice.agent.patch(`/api/entities/${file.body.entity.id}/access`).set('x-csrf-token',alice.csrf).send({visibility:'private'}).expect(200);
    await editor.agent.get(`/api/files/${file.body.entity.id}`).expect(404);
    const board=await alice.agent.post('/api/entities').set('x-csrf-token',alice.csrf).send({kind:'board',title:'Private board',visibility:'private',data:{placements:[{id,x:0,y:0}]}}).expect(201);
    const child=await alice.agent.post('/api/entities').set('x-csrf-token',alice.csrf).send({kind:'item',title:'Inherited privacy',content:'Contained secret',parentId:board.body.entity.id}).expect(201);
    await editor.agent.get(`/api/entities/${child.body.entity.id}`).expect(404);
    const share=await alice.agent.post(`/api/entities/${board.body.entity.id}/share`).set('x-csrf-token',alice.csrf).send({enabled:true,allowDuplicate:false}).expect(200);
    const publicBoard=await request(app).get(`/api/public/${share.body.token}`).expect(200);assert.equal(publicBoard.body.entities.length,0);assert.equal(publicBoard.body.entity.data.placements.length,0);
    const job=await access.runAsActor(alice.workspace,alice.userId,()=>jobs.enqueue(alice.workspace,'workflow',{secret:'Private workflow data'},new Date(Date.now()+86400000)));
    const [saved]=await db.query('SELECT actor_user_id FROM jobs WHERE id=$1',[job.id]);assert.equal(saved.actor_user_id,alice.userId);
    await editor.agent.get(`/api/jobs/${job.id}`).expect(404);
    const editorJobs=await editor.agent.get('/api/jobs').expect(200);assert.equal(JSON.stringify(editorJobs.body).includes('Private workflow data'),false);
  });
  test('comment-only guests see exactly invited content, can reply, and cannot edit; revocation is immediate',async () => {
    const root=await alice.agent.post('/api/entities').set('x-csrf-token',alice.csrf).send({kind:'item',title:'Review request',content:'Please review',visibility:'private'}).expect(201);
    const invite=await alice.agent.post(`/api/entities/${root.body.entity.id}/invite`).set('x-csrf-token',alice.csrf).send({email:'commenter@example.test',permission:'comment'}).expect(201);
    const commenter=await signup('commenter@example.test','Commenter',invite.body.token);
    const listed=await commenter.agent.get('/api/entities').expect(200);assert.deepEqual(listed.body.entities.map((e:any)=>e.id),[root.body.entity.id]);
    await commenter.agent.get('/api/export?format=json').expect(403);
    await commenter.agent.get(`/api/workspaces/${alice.workspace}/members`).expect(403);
    await commenter.agent.patch(`/api/entities/${root.body.entity.id}`).set('x-csrf-token',commenter.csrf).send({content:'Cannot edit'}).expect(404);
    const comment=await commenter.agent.post(`/api/entities/${root.body.entity.id}/comments`).set('x-csrf-token',commenter.csrf).send({content:'A useful suggestion'}).expect(201);
    const reply=await alice.agent.post(`/api/entities/${root.body.entity.id}/comments`).set('x-csrf-token',alice.csrf).send({content:'Thanks for reviewing',parentId:comment.body.comment.id}).expect(201);
    assert.equal(reply.body.comment.parentId,comment.body.comment.id);
    await commenter.agent.patch(`/api/comments/${comment.body.comment.id}`).set('x-csrf-token',commenter.csrf).send({resolved:true}).expect(200);
    const thread=await commenter.agent.get(`/api/entities/${root.body.entity.id}/comments`).expect(200);assert.equal(thread.body.comments[0].resolved,true);assert.equal(thread.body.comments.length,2);
    await commenter.agent.post(`/api/entities/${root.body.entity.id}/invite`).set('x-csrf-token',commenter.csrf).send({email:'other@example.test',permission:'edit'}).expect(404);
    await alice.agent.delete(`/api/entities/${root.body.entity.id}/access/${commenter.userId}`).set('x-csrf-token',alice.csrf).expect(200);
    await commenter.agent.get(`/api/entities/${root.body.entity.id}`).expect(404);
    const none=await commenter.agent.get('/api/entities').expect(200);assert.equal(none.body.entities.length,0);
  });
  test('edit invitation works for an existing account and parent invitations inherit without workspace access',async () => {
    const board=await alice.agent.post('/api/entities').set('x-csrf-token',alice.csrf).send({kind:'board',title:'Shared with editor',visibility:'private'}).expect(201);
    const child=await alice.agent.post('/api/entities').set('x-csrf-token',alice.csrf).send({kind:'item',title:'Inside board',parentId:board.body.entity.id,visibility:'private'}).expect(201);
    const invite=await alice.agent.post(`/api/entities/${board.body.entity.id}/invite`).set('x-csrf-token',alice.csrf).send({email:'bob@example.test',permission:'edit'}).expect(201);
    await bob.agent.post('/api/entity-invitations/accept').set('x-csrf-token',bob.csrf).send({token:invite.body.token}).expect(200);
    const listed=await bob.agent.get('/api/entities').set('x-workspace-id',alice.workspace).expect(200);assert.deepEqual(listed.body.entities.map((e:any)=>e.id).sort(),[board.body.entity.id,child.body.entity.id].sort());
    await bob.agent.patch(`/api/entities/${child.body.entity.id}`).set('x-workspace-id',alice.workspace).set('x-csrf-token',bob.csrf).send({content:'Edited through item grant'}).expect(200);
    await bob.agent.patch(`/api/entities/${board.body.entity.id}/access`).set('x-workspace-id',alice.workspace).set('x-csrf-token',bob.csrf).send({visibility:'workspace'}).expect(404);
  });
});

function zipFixture(items:{name:string;content:string|Buffer;expandedSize?:number}[]) {
  const local:Buffer[]=[],central:Buffer[]=[];let offset=0,centralSize=0;
  for(const item of items) {
    const name=Buffer.from(item.name),raw=Buffer.isBuffer(item.content) ? item.content:Buffer.from(item.content),compressed=deflateRawSync(raw),checksum=crc32(raw);
    const header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50,0);header.writeUInt16LE(20,4);header.writeUInt16LE(8,8);header.writeUInt32LE(checksum,14);header.writeUInt32LE(compressed.length,18);header.writeUInt32LE(item.expandedSize ?? raw.length,22);header.writeUInt16LE(name.length,26);
    const entry=Buffer.alloc(46);entry.writeUInt32LE(0x02014b50,0);entry.writeUInt16LE(20,4);entry.writeUInt16LE(20,6);entry.writeUInt16LE(8,10);entry.writeUInt32LE(checksum,16);entry.writeUInt32LE(compressed.length,20);entry.writeUInt32LE(item.expandedSize ?? raw.length,24);entry.writeUInt16LE(name.length,28);entry.writeUInt32LE(offset,42);
    local.push(header,name,compressed);central.push(entry,name);offset+=header.length+name.length+compressed.length;centralSize+=entry.length+name.length;
  }
  const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(items.length,8);end.writeUInt16LE(items.length,10);end.writeUInt32LE(centralSize,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,...central,end]);
}
describe('portable ZIP and EPUB workflows',() => {
  test('Obsidian and Notion archives preserve note links and attachments',async () => {
    const archive=zipFixture([{name:'Notes/One.md',content:'# One\nSee [[Two]] and [attachment](../Assets/reference.txt).'},{name:'Notes/Two.md',content:'# Two\nAnother note'},{name:'Assets/reference.txt',content:'Attachment content'}]);
    const imported=await alice.agent.post('/api/imports').set('x-csrf-token',alice.csrf).field('format','auto').attach('file',archive,'notes.zip').expect(201);
    assert.equal(imported.body.count,3);
    const one=imported.body.entities.find((e:any)=>e.title==='One'),two=imported.body.entities.find((e:any)=>e.title==='Two'),attachment=imported.body.entities.find((e:any)=>e.title==='reference.txt');
    assert.match(one.content,new RegExp(`/library\\?open=${two.id}`));assert.match(one.content,new RegExp(`/api/files/${attachment.id}`));assert.equal(one.data.sourceIds.length,2);
  });
  test('archive traversal, declared bombs, corrupt compressed data and duplicate paths are rejected',async () => {
    await assert.rejects(archives.readZipArchive(zipFixture([{name:'../outside.md',content:'Bad path'}])),(e:any)=>e.code==='ARCHIVE_PATH');
    await assert.rejects(archives.readZipArchive(zipFixture([{name:'bomb.md',content:'tiny',expandedSize:100*1024*1024}])),(e:any)=>e.status===413);
    await assert.rejects(archives.readZipArchive(zipFixture([{name:'same.md',content:'a'},{name:'same.md',content:'b'}])),/duplicate/);
    const corrupt=zipFixture([{name:'bad.md',content:'content'}]);corrupt[36]^=255;await assert.rejects(archives.readZipArchive(corrupt));
  });
  test('EPUB chapters and embedded Evernote attachments become readable private files',async () => {
    const epub=zipFixture([{name:'mimetype',content:'application/epub+zip'},{name:'META-INF/container.xml',content:'<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>'},{name:'OPS/book.opf',content:'<package><metadata><dc:title>Sample Book</dc:title><dc:creator>Author</dc:creator></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>'},{name:'OPS/chapter.xhtml',content:'<html><head><title>First chapter</title></head><body><p>Readable chapter content.</p></body></html>'}]);
    const uploaded=await alice.agent.post('/api/uploads').set('x-csrf-token',alice.csrf).attach('file',epub,'book.epub').expect(201);
    assert.equal(uploaded.body.entity.data.bookTitle,'Sample Book');assert.equal(uploaded.body.entity.data.chapters.length,1);assert.match(uploaded.body.entity.content,/Readable chapter content/);
    const encoded=Buffer.from('Evernote attachment text').toString('base64');
    const enex=`<en-export><note><title>Attached note</title><content><![CDATA[<en-note>Note with an attachment</en-note>]]></content><resource><data encoding="base64">${encoded}</data><mime>text/plain</mime><resource-attributes><file-name>attached.txt</file-name></resource-attributes></resource></note></en-export>`;
    const imported=await alice.agent.post('/api/imports').set('x-csrf-token',alice.csrf).attach('file',Buffer.from(enex),'attached.enex').expect(201);assert.equal(imported.body.count,2);
    const file=imported.body.entities.find((e:any)=>e.data.type==='file'),note=imported.body.entities.find((e:any)=>e.title==='Attached note');assert.match(note.content,new RegExp(file.id));assert.equal(file.content,'Evernote attachment text');
  });
  test('ZIP export contains Markdown, structured tables, links and uploaded originals',async () => {
    const output=await alice.agent.get('/api/export?format=zip').buffer(true).parse((response,callback)=>{const chunks:Buffer[]=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>callback(null,Buffer.concat(chunks)));}).expect(200);
    const contents=await archives.readZipArchive(output.body as Buffer);
    assert.ok(contents.some(entry=>entry.path==='links.csv'));assert.ok(contents.some(entry=>entry.path==='grove-export.json'));assert.ok(contents.some(entry=>entry.path.startsWith('notes/')));assert.ok(contents.some(entry=>entry.path.startsWith('uploads/')));assert.ok(contents.some(entry=>entry.path.startsWith('tables/')));
  });
});
