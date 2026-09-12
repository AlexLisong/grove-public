import {after,before,describe,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import pg from 'pg';
import {normalizeTableData,tableRowTitle} from '../shared/table.js';

const connection=process.env.TEST_DATABASE_URL||'postgres://grove:grove_local_only@127.0.0.1:55432/grove';
const url=new URL(connection),schema=`grove_table_test_${randomUUID().replaceAll('-','')}`;
if(!['127.0.0.1','localhost'].includes(url.hostname))throw new Error('Table tests require local PostgreSQL.');
const admin=new pg.Pool({connectionString:connection});await admin.query(`CREATE SCHEMA ${schema}`);url.searchParams.set('options',`-c search_path=${schema},public`);
process.env.DATABASE_URL=url.href;process.env.APP_URL='http://localhost:5173';process.env.REGISTRATION_CODE='isolated-tables';process.env.APP_ENCRYPTION_KEY='e'.repeat(64);process.env.NODE_ENV='test';
const db=await import('../server/core/db.js'),auth=await import('../server/core/auth.js'),entities=await import('../server/core/entities.js'),mcp=await import('../server/mcp.js'),access=await import('../server/core/access.js');
const app=express();app.use(express.json({limit:'2mb'}),cookieParser(),auth.csrfProtection);app.use('/api',auth.authRouter,entities.entityRouter);app.use((error:any,_req:any,res:any,_next:any)=>res.status(error.status||(error.name==='ZodError'?400:500)).json({error:error.message,code:error.code}));
const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
type Client={agent:ReturnType<typeof request.agent>;csrf:string;workspace:string;userId:string};
async function signup(name:string,code='isolated-tables'):Promise<Client>{const agent=request.agent(server),res=await agent.post('/api/auth/register').send({email:`${name}@tables.example.test`,name,password:'isolated-tables-password-123',code}).expect(201);return {agent,csrf:res.body.csrfToken,workspace:res.body.workspace.id,userId:res.body.user.id};}
const mutate=(client:Client,method:'post'|'patch'|'delete',path:string)=>client.agent[method](`/api${path}`).set('x-csrf-token',client.csrf);
const tableData=(ids:{itemId?:string;relatedItemIds?:string[];relation?:string}={})=>({tableVersion:2,columns:[{id:'name',name:'Name',type:'text'},{id:'due',name:'Due',type:'date'},{id:'link',name:'Source',type:'relation'},{id:'priority',name:'Priority',type:'priority',options:['Low','High'],optionColors:{Low:'#8baa72',High:'#dc8e70'}},{id:'likes',name:'Likes',type:'likes'}],rows:[{id:'row-1',cells:{name:'Original row',due:'2026-09-05',priority:'High',...(ids.relation?{link:ids.relation}:{})},...(ids.itemId?{itemId:ids.itemId}:{}),...(ids.relatedItemIds?{relatedItemIds:ids.relatedItemIds}:{})}],view:'table'});
async function create(client:Client,input:any){return (await mutate(client,'post','/entities').send(input).expect(201)).body.entity;}
let alice:Client,bob:Client,editor:Client;
before(async()=>{await db.migrate();alice=await signup('alice');bob=await signup('bob');const invitation=await mutate(alice,'post',`/workspaces/${alice.workspace}/invite`).send({email:'editor@tables.example.test',role:'editor'}).expect(201);editor=await signup('editor',invitation.body.token);});
after(async()=>{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await db.closeDb();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});

describe('table API persistence and access',()=>{
 test('typed schemas, views and recurrence survive save/reopen with optimistic version enforcement',async()=>{
  const table=await create(alice,{kind:'table',title:'Planning',data:tableData()}),normalized=normalizeTableData(table.data);normalized.view='calendar';normalized.viewSettings.filters=[{id:'today',columnId:'due',operator:'today'}];normalized.savedViews=[{id:'daily',name:'Today',layout:'calendar',settings:normalized.viewSettings}];normalized.activeViewId='daily';normalized.rows[0].recurrence={frequency:'weekday',interval:1,anchor:'scheduled',dateColumnId:'due',originDate:'2026-09-05'};
  const saved=await mutate(alice,'patch',`/entities/${table.id}`).send({data:normalized,version:table.version}).expect(200);assert.equal(saved.body.entity.version,2);
  const reread=(await alice.agent.get(`/api/entities/${table.id}`).expect(200)).body.entity;assert.deepEqual(reread.data,JSON.parse(JSON.stringify(normalized)));
  await mutate(alice,'patch',`/entities/${table.id}`).send({title:'Stale edit',version:1}).expect(409);
  const invalid=structuredClone(normalized);invalid.rows[0].cells.due='2026-02-30';const rejected=await mutate(alice,'patch',`/entities/${table.id}`).send({data:invalid,version:2}).expect(400);assert.equal(rejected.body.code,'INVALID_TABLE');assert.equal((await alice.agent.get(`/api/entities/${table.id}`)).body.entity.version,2);
 });
 test('all relation forms reject foreign workspaces, private sources and removed-row foreign links',async()=>{
  const foreign=await create(bob,{kind:'item',title:'Foreign'}),secret=await create(alice,{kind:'item',title:'Private',visibility:'private'});
  for(const reference of [{itemId:foreign.id},{relatedItemIds:[foreign.id]},{relation:foreign.id},{itemId:secret.id},{relatedItemIds:[secret.id]},{relation:secret.id}]){const failed=await mutate(editor,'post','/entities').send({kind:'table',title:'Denied',data:tableData(reference)}).expect(400);assert.equal(failed.body.code,'INVALID_REFERENCE');}
  const removed=tableData({relation:foreign.id}) as any;removed.removedRows=removed.rows;removed.rows=[];await mutate(alice,'post','/entities').send({kind:'table',title:'Hidden foreign link',data:removed}).expect(400);
 });
 test('retained revoked or trashed links do not block unrelated edits, while new links remain forbidden',async()=>{
  const source=await create(alice,{kind:'item',title:'Temporary source'}),table=await create(editor,{kind:'table',title:'Reference checks',data:tableData({relation:source.id})});
  await mutate(alice,'patch',`/entities/${source.id}/access`).send({visibility:'private'}).expect(200);
  await mutate(editor,'patch',`/entities/${table.id}`).send({title:'Changed',version:table.version}).expect(200);
  const clean=structuredClone(table.data);delete clean.rows[0].cells.link;await mutate(editor,'patch',`/entities/${table.id}`).send({data:clean,version:2}).expect(200);await mutate(editor,'patch',`/entities/${table.id}`).send({data:table.data,version:3}).expect(400);
  const source2=await create(alice,{kind:'item',title:'Removed later'}),table2=await create(alice,{kind:'table',title:'Trash reference',data:tableData({itemId:source2.id})});await mutate(alice,'delete',`/entities/${source2.id}`).expect(200);
  await mutate(alice,'patch',`/entities/${table2.id}`).send({title:'Retained unavailable link',version:1}).expect(200);
 });
 test('linked row titles follow the source while related documents leave the standalone title intact',async()=>{
  let source=await create(alice,{kind:'item',title:'Source title'});const table=await create(alice,{kind:'table',title:'Title following',data:tableData({itemId:source.id})});source=(await mutate(alice,'patch',`/entities/${source.id}`).send({title:'Renamed source',version:1}).expect(200)).body.entity;
  assert.equal(tableRowTitle(table.data.rows[0],table.data.columns,[source]),'Renamed source');assert.equal(table.data.rows[0].cells.name,'Original row');
  const related=await create(alice,{kind:'table',title:'Related only',data:tableData({relatedItemIds:[source.id]})});assert.equal(tableRowTitle(related.data.rows[0],related.data.columns,[source]),'Original row');
 });
 test('public views and external duplicates detach table links without revealing hidden source IDs',async()=>{
  const source=await create(alice,{kind:'item',title:'Secret link',visibility:'private'}),table=await create(alice,{kind:'table',title:'Shared rows',data:tableData({itemId:source.id,relatedItemIds:[source.id],relation:source.id})});
  table.data.removedRows=[{id:'private-recovery-row',cells:{name:'Private deleted row text',due:'2026-09-05'}}];await mutate(alice,'patch',`/entities/${table.id}`).send({data:table.data,version:1}).expect(200);
  const share=await mutate(alice,'post',`/entities/${table.id}/share`).send({enabled:true,allowDuplicate:true}).expect(200),publicResult=await request(server).get(`/api/public/${share.body.token}`).expect(200);assert.equal(JSON.stringify(publicResult.body).includes(source.id),false);assert.equal(JSON.stringify(publicResult.body).includes('Private deleted row text'),false);assert.equal(publicResult.body.entity.data.removedRows,undefined);
  const duplicate=await mutate(bob,'post',`/public/${share.body.token}/duplicate`).expect(201);assert.equal(duplicate.body.entity.workspaceId,bob.workspace);assert.equal(JSON.stringify(duplicate.body.entity).includes(source.id),false);assert.equal(duplicate.body.entity.data.rows[0].cells.name,'Original row');assert.equal(JSON.stringify(duplicate.body.entity).includes('Private deleted row text'),false);assert.equal(duplicate.body.entity.data.removedRows,undefined);assert.equal((await alice.agent.get(`/api/entities/${table.id}`).expect(200)).body.entity.data.removedRows[0].cells.name,'Private deleted row text');
 });
 test('item-only view access cannot mutate a table and revocation hides it immediately',async()=>{
  const table=await create(alice,{kind:'table',title:'Read only table',visibility:'private',data:tableData()}),invitation=await mutate(alice,'post',`/entities/${table.id}/invite`).send({email:'viewer@tables.example.test',permission:'view'}).expect(201),viewer=await signup('viewer',invitation.body.token);
  await viewer.agent.get(`/api/entities/${table.id}`).expect(200);await mutate(viewer,'patch',`/entities/${table.id}`).send({title:'Unauthorized',version:1}).expect(404);
  await mutate(alice,'delete',`/entities/${table.id}/access/${viewer.userId}`).expect(200);await viewer.agent.get(`/api/entities/${table.id}`).expect(404);
 });
 test('legacy stored table cells can receive unrelated updates without admitting new invalid typed cells',async()=>{
  const table=await create(alice,{kind:'table',title:'Old table',data:{columns:[{id:'n',name:'N',type:'number'}],rows:[{id:'r',cells:{n:1}}]}});
  await db.query("UPDATE entities SET data=jsonb_set(data,'{rows,0,cells,n}','\"legacy free text\"'::jsonb) WHERE id=$1",[table.id]);
  const current=(await alice.agent.get(`/api/entities/${table.id}`).expect(200)).body.entity;await mutate(alice,'patch',`/entities/${table.id}`).send({title:'Still editable',version:current.version}).expect(200);
  current.data.rows[0].cells.n='new bad text';await mutate(alice,'patch',`/entities/${table.id}`).send({data:current.data,version:2}).expect(400);
 });
 test('retained table IDs still count toward the combined document/table reference limit',async()=>{
  const table=await create(alice,{kind:'table',title:'Reference cap',data:tableData()}),stored=tableData();
  stored.rows=Array.from({length:2000},(_,i)=>({id:`row-${i}`,cells:{name:'Retained unavailable source',due:'2026-09-05',priority:'High',link:randomUUID()}})) as typeof stored.rows;
  await db.query('UPDATE entities SET data=$2::jsonb WHERE id=$1',[table.id,JSON.stringify(stored)]);
  await mutate(alice,'patch',`/entities/${table.id}`).send({title:'All retained',version:1}).expect(200);
  const result=await mutate(alice,'patch',`/entities/${table.id}`).send({data:{...stored,entityLinks:[randomUUID()]},version:2}).expect(400);assert.match(result.body.error,/2,000/);
 });
 test('MCP row handler merges partial cells and preserves row identity and recurrence',async()=>{
  const source=await create(alice,{kind:'item',title:'MCP linked item'}),input=tableData({itemId:source.id}) as any;input.rows[0].recurrence={frequency:'monthly',interval:1,anchor:'scheduled',dateColumnId:'due',originDate:'2026-09-05'};
  const table=await create(alice,{kind:'table',title:'MCP row merge',data:input}),tool=mcp.toolRegistry.find(tool=>tool.name==='grove_update_table_rows')!;
  const updated=await access.runAsActor(alice.workspace,alice.userId,()=>tool.run(alice.workspace,tool.schema.parse({id:table.id,version:1,rows:[{id:'row-1',cells:{name:'Updated via MCP',priority:null}}]}),{} as any));
  assert.equal(updated.data.rows[0].cells.name,'Updated via MCP');assert.equal(updated.data.rows[0].cells.due,'2026-09-05');assert.equal(updated.data.rows[0].cells.priority,null);assert.equal(updated.data.rows[0].itemId,source.id);assert.deepEqual(updated.data.rows[0].recurrence,input.rows[0].recurrence);
  await assert.rejects(()=>access.runAsActor(alice.workspace,alice.userId,()=>tool.run(alice.workspace,{id:table.id,version:1,rows:[{id:'row-1',cells:{name:'Stale'}}]},{} as any)),(error:any)=>error.status===409);
 });
 test('MCP column removal erases removed cells and public APIs project away legacy orphaned values',async()=>{
  const input=normalizeTableData({columns:[{id:'name',name:'Name',type:'text'},{id:'secret',name:'Private planning',type:'text'},{id:'due',name:'Due',type:'date'}],rows:[{id:'visible',cells:{name:'Public name',secret:'Removed private planning text',due:'2026-09-05',__done:true},recurrence:{frequency:'daily',interval:1,anchor:'scheduled',dateColumnId:'due'}}],removedRows:[{id:'removed',cells:{name:'Private row recovery',secret:'Deleted secret'}}]});input.viewSettings.dateColumnId='due';input.viewSettings.filters=[{id:'date-filter',columnId:'due',operator:'today'}];
  const table=await create(alice,{kind:'table',title:'Column projection',data:input}),tool=mcp.toolRegistry.find(tool=>tool.name==='grove_update_table')!;
  const updated=await access.runAsActor(alice.workspace,alice.userId,()=>tool.run(alice.workspace,tool.schema.parse({id:table.id,version:1,columns:[input.columns[0]]}),{} as any));assert.deepEqual(updated.data.rows[0].cells,{name:'Public name',__done:true});assert.equal(updated.data.rows[0].recurrence,undefined);assert.deepEqual(updated.data.removedRows[0].cells,{name:'Private row recovery'});assert.equal(updated.data.viewSettings.dateColumnId,'');
  // Older clients may have left orphaned values before this cleanup existed.
  await db.query("UPDATE entities SET data=jsonb_set(data,'{rows,0,cells,secret}','\"Legacy orphaned secret\"'::jsonb) WHERE id=$1",[table.id]);
  const share=await mutate(alice,'post',`/entities/${table.id}/share`).send({enabled:true,allowDuplicate:true}).expect(200),publicResult=await request(server).get(`/api/public/${share.body.token}`).expect(200);assert.deepEqual(publicResult.body.entity.data.rows[0].cells,{name:'Public name',__done:true});assert.equal(JSON.stringify(publicResult.body).includes('secret'),false);
  const copy=await mutate(bob,'post',`/public/${share.body.token}/duplicate`).expect(201);assert.deepEqual(copy.body.entity.data.rows[0].cells,{name:'Public name',__done:true});assert.equal(copy.body.entity.data.removedRows,undefined);assert.equal(JSON.stringify(copy.body).includes('secret'),false);
 });
 test('MCP advertised table schemas accept the new property and layout contract',()=>{
  const create=mcp.toolRegistry.find(tool=>tool.name==='grove_create_table')!,update=mcp.toolRegistry.find(tool=>tool.name==='grove_update_table')!,rows=mcp.toolRegistry.find(tool=>tool.name==='grove_update_table_rows')!;
  assert.ok(create.schema.safeParse({title:'Typed table',columns:tableData().columns}).success);
  for(const view of ['table','list','kanban','calendar','gallery','grid'])assert.ok(update.schema.safeParse({id:randomUUID(),view,version:2}).success);
  assert.ok(rows.schema.safeParse({id:randomUUID(),rows:[{id:'r',cells:{name:'x'},itemId:randomUUID(),relatedItemIds:[],recurrence:{frequency:'monthly',interval:1,anchor:'completion',dateColumnId:'due'}}]}).success);
 });
});
