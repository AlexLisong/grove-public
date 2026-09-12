import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readdir,rm,stat,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import pg from 'pg';
import {BlobServiceClient} from '@azure/storage-blob';

const connection=process.env.TEST_DATABASE_URL || 'postgres://grove:grove_local_only@127.0.0.1:55432/grove';
const url=new URL(connection);
if(!['127.0.0.1','localhost'].includes(url.hostname)) throw new Error('Storage tests only use local PostgreSQL.');
const schema=`grove_storage_test_${randomUUID().replaceAll('-','')}`,admin=new pg.Pool({connectionString:connection});
await admin.query(`CREATE SCHEMA ${schema}`);
url.searchParams.set('options',`-c search_path=${schema},public`);
process.env.DATABASE_URL=url.href;
process.env.NODE_ENV='production';
process.env.APP_URL='https://grove.example.test';
process.env.REGISTRATION_CODE='storage-fixture-private-code';
process.env.APP_ENCRYPTION_KEY='d'.repeat(64);
process.env.STORAGE_LIMIT_MB='10';
delete process.env.AZURE_STORAGE_ACCOUNT_URL;
delete process.env.FILE_STORAGE_BACKEND;
const fixtureDir=await mkdtemp(path.join(tmpdir(),'grove-storage-'));
const uploadDir=path.join(fixtureDir,'uploads');
process.env.UPLOAD_DIR=uploadDir;
const db=await import('../server/core/db.js'),auth=await import('../server/core/auth.js'),files=await import('../server/core/files.js'),quota=await import('../server/quota.js');
const app=express();
app.use(express.json(),cookieParser(),auth.csrfProtection);
app.use('/api',auth.authRouter,files.fileRouter);
app.use((error:any,_req:any,res:any,_next:any)=>res.status(error.status || (error.name==='ZodError' ? 400 : 500)).json({error:error.message,code:error.code}));
type Client={cookie:string;csrf:string;workspace:string;userId:string};
async function signup(name:string):Promise<Client> {
  const response=await request(app).post('/api/auth/register').send({name,email:`${name.toLowerCase()}@storage.example.test`,password:'storage-test-password-123',code:process.env.REGISTRATION_CODE}).expect(201);
  const cookies=response.headers['set-cookie'] as unknown as string[];
  assert.match(cookies.join(';'),/Secure/);
  return {cookie:cookies.map(value=>value.split(';')[0]).join('; '),csrf:response.body.csrfToken,workspace:response.body.workspace.id,userId:response.body.user.id};
}
async function withEnv<T>(values:Record<string,string|undefined>,fn:()=>Promise<T>) {
  const previous=Object.fromEntries(Object.keys(values).map(key=>[key,process.env[key]]));
  for(const [key,value] of Object.entries(values)) {if(value===undefined) delete process.env[key];else process.env[key]=value;}
  try {return await fn();} finally {for(const [key,value] of Object.entries(previous)) {if(value===undefined) delete process.env[key];else process.env[key]=value;}}
}
let alice:Client,bob:Client;
const upload=(client:Client=alice)=>request(app).post('/api/uploads').set('cookie',client.cookie).set('x-csrf-token',client.csrf);
const download=(id:string,client:Client=alice)=>request(app).get(`/api/files/${id}`).set('cookie',client.cookie);
before(async()=>{await db.migrate();alice=await signup('Alice');bob=await signup('Bob');});
after(async()=>{await db.closeDb();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();await rm(fixtureDir,{recursive:true,force:true});});

test('production fails closed without an explicit local backend before reserving storage',async()=>{
  const initial=await quota.quotaStatus(alice.workspace);
  for(const backend of [undefined,'','locals','azure']) {
    await withEnv({FILE_STORAGE_BACKEND:backend},async()=>{
      const denied=await upload().attach('file',Buffer.from('private content'),'source.txt').expect(503);
      assert.equal(denied.body.code,'STORAGE_UNCONFIGURED');
    });
  }
  assert.deepEqual((await quota.quotaStatus(alice.workspace)).storage,initial.storage);
  assert.deepEqual(await readdir(fixtureDir),[]);
});

test('production local storage rejects missing, relative, code, public and symlink-aliased roots',async()=>{
  const alias=path.join(fixtureDir,'code-alias');
  await symlink(process.cwd(),alias,'dir');
  const unsafe=[undefined,'','relative/uploads',process.cwd(),path.parse(process.cwd()).root,
    ...['public','dist','dist-server','server','src','shared','.data'].map(dir=>path.join(process.cwd(),dir,'uploads')),
    path.join(alias,'public','uploads')];
  const initial=(await quota.quotaStatus(alice.workspace)).storage;
  for(const root of unsafe) {
    await withEnv({FILE_STORAGE_BACKEND:'local',UPLOAD_DIR:root},async()=>{
      const denied=await upload().attach('file',Buffer.from('private content'),'source.txt').expect(503);
      assert.equal(denied.body.code,'STORAGE_CONFIG_INVALID');
    });
  }
  assert.deepEqual((await quota.quotaStatus(alice.workspace)).storage,initial);
  assert.deepEqual(await readdir(fixtureDir),['code-alias']);
  const internalAlias=path.join(process.cwd(),`.storage-fixture-${randomUUID()}`);
  await symlink(fixtureDir,internalAlias,'dir');
  try {
    await withEnv({FILE_STORAGE_BACKEND:'local',UPLOAD_DIR:internalAlias},async()=>{
      const denied=await upload().attach('file',Buffer.from('not a public asset'),'source.txt').expect(503);
      assert.equal(denied.body.code,'STORAGE_CONFIG_INVALID');
    });
  } finally {await rm(internalAlias);}
});

test('explicit production local uploads retain private filesystem modes and authenticated ACLs',async()=>{
  await withEnv({FILE_STORAGE_BACKEND:'local'},async()=>{
    const uploaded=await upload().field('visibility','private').attach('file',Buffer.from('English and 中文 research'),'research.txt').expect(201);
    const id=uploaded.body.entity.id;
    assert.equal(uploaded.body.entity.visibility,'private');
    assert.equal(uploaded.body.entity.content,'English and 中文 research');
    const [record]=await db.query('SELECT * FROM files WHERE id=$1',[id]);
    assert.equal(record.backend,'local');
    const destination=path.join(uploadDir,record.storage_key);
    assert.equal((await stat(destination)).mode & 0o777,0o600);
    for(const dir of [uploadDir,path.join(uploadDir,alice.workspace),path.dirname(destination)]) assert.equal((await stat(dir)).mode & 0o777,0o700);
    const response=await download(id).expect(200);
    assert.equal(response.text,'English and 中文 research');
    assert.match(response.headers['content-disposition'],/^attachment;/);
    assert.equal(response.headers['cache-control'],'private, no-store');
    assert.equal(response.headers['x-content-type-options'],'nosniff');
    assert.match(response.headers['content-security-policy'],/^sandbox;/);
    await request(app).get(`/api/files/${id}`).expect(401);
    await request(app).post('/api/uploads').attach('file',Buffer.from('no login'),'denied.txt').expect(401);
    await download(id,bob).expect(404);
    await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'viewer')",[alice.workspace,bob.userId]);
    try {
      await download(id,bob).set('x-workspace-id',alice.workspace).expect(404);
      await upload(bob).set('x-workspace-id',alice.workspace).attach('file',Buffer.from('viewer'),'denied.txt').expect(403);
    } finally {await db.query('DELETE FROM memberships WHERE workspace_id=$1 AND user_id=$2',[alice.workspace,bob.userId]);}
    const token=await request(app).post('/api/tokens').set('cookie',alice.cookie).set('x-csrf-token',alice.csrf).send({name:'Insufficient file scope',scopes:['workspace:read']}).expect(201);
    await request(app).get(`/api/files/${id}`).set('authorization',`Bearer ${token.body.token}`).expect(403);
    await request(app).post('/api/uploads').set('authorization',`Bearer ${token.body.token}`).attach('file',Buffer.from('no scope'),'denied.txt').expect(403);
    await withEnv({FILE_STORAGE_BACKEND:undefined},async()=>{await download(id).expect(503);});
  });
});

test('production local uploads still reserve quota before writing',async()=>{
  await withEnv({FILE_STORAGE_BACKEND:'local'},async()=>{await upload().attach('file',Buffer.from('quota seed'),'quota-seed.txt').expect(201);});
  const initial=(await quota.quotaStatus(alice.workspace)).storage;
  const beforeFiles=await readdir(uploadDir,{recursive:true});
  await withEnv({FILE_STORAGE_BACKEND:'local',STORAGE_LIMIT_MB:String(initial.used/(1024*1024))},async()=>{
    const denied=await upload().attach('file',Buffer.from('over limit'),'denied.txt').expect(429);
    assert.equal(denied.body.code,'STORAGE_QUOTA_EXCEEDED');
  });
  assert.deepEqual((await quota.quotaStatus(alice.workspace)).storage,initial);
  assert.deepEqual(await readdir(uploadDir,{recursive:true}),beforeFiles);
});

test('local download paths reject traversal, prefix siblings and symlink escapes',async()=>{
  await withEnv({FILE_STORAGE_BACKEND:'local'},async()=>{
    const uploaded=await upload().attach('file',Buffer.from('safe'),'safe.txt').expect(201);
    const id=uploaded.body.entity.id;
    const [record]=await db.query('SELECT storage_key FROM files WHERE id=$1',[id]);
    const outside=path.join(fixtureDir,'outside.txt');await writeFile(outside,'must not escape');
    const alias=path.join(uploadDir,'escape.txt');await symlink(outside,alias);
    try {
      for(const key of ['../outside.txt','../uploads-sibling/outside.txt','escape.txt']) {
        await db.query('UPDATE files SET storage_key=$1 WHERE id=$2',[key,id]);
        const denied=await download(id).expect(500);
        assert.equal(denied.body.error,'Invalid file path.');
      }
    } finally {await db.query('UPDATE files SET storage_key=$1 WHERE id=$2',[record.storage_key,id]);}
    assert.equal((await download(id).expect(200)).text,'safe');
  });
});

test('configured Azure storage retains precedence and needs no local root or opt-in',async(t)=>{
  const stored=new Map<string,Buffer>();
  t.mock.method(BlobServiceClient.prototype,'getContainerClient',()=>({getBlockBlobClient:(key:string)=>({
    uploadData:async(buffer:Buffer)=>{stored.set(key,Buffer.from(buffer));},
    downloadToBuffer:async()=>stored.get(key),
    deleteIfExists:async()=>stored.delete(key),
  })}) as any);
  for(const backend of [undefined,'local']) {
    await withEnv({AZURE_STORAGE_ACCOUNT_URL:'https://storagefixture.blob.core.windows.net',FILE_STORAGE_BACKEND:backend,UPLOAD_DIR:undefined},async()=>{
      const uploaded=await upload().attach('file',Buffer.from('Azure fixture'),'azure.txt').expect(201);
      const id=uploaded.body.entity.id;
      assert.equal((await db.query('SELECT backend FROM files WHERE id=$1',[id]))[0].backend,'azure');
      assert.equal((await download(id).expect(200)).text,'Azure fixture');
    });
  }
  assert.equal(stored.size,2);
});
