import {after,before,describe,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import pg from 'pg';
import type {Entity} from '../shared/types.js';
import type {ArticleApproval,ArticlePublication,WebsiteArticleMetadata} from '../shared/articles.js';

const connection=process.env.TEST_DATABASE_URL || 'postgres://grove:grove_local_only@127.0.0.1:55432/grove';
const url=new URL(connection),suffix=randomUUID().replaceAll('-',''),schema=`grove_articles_test_${suffix}`,publishingSchema=`publishing_test_${suffix}`;
if(!['127.0.0.1','localhost'].includes(url.hostname)) throw new Error('Article tests require local PostgreSQL.');
const admin=new pg.Pool({connectionString:connection});await admin.query(`CREATE SCHEMA ${schema}`);
url.searchParams.set('options',`-c search_path=${schema},public`);
process.env.DATABASE_URL=url.href;process.env.PUBLISHING_SCHEMA=publishingSchema;process.env.APP_URL='http://localhost:5173';
process.env.WEBSITE_PUBLISHING_SITES=JSON.stringify([{id:'journal',name:'Journal',domain:'journal.example'},{id:'studio',name:'Studio',domain:'studio.example'},{id:'workshop',name:'Workshop',domain:'workshop.example'}]);
process.env.REGISTRATION_CODE='isolated-articles';process.env.APP_ENCRYPTION_KEY='e'.repeat(64);process.env.NODE_ENV='test';
delete process.env.WEBSITE_PUBLISHING_WORKSPACE_ID;
const db=await import('../server/core/db.js'),auth=await import('../server/core/auth.js'),entities=await import('../server/core/entities.js'),articles=await import('../server/articles.js');
const app=express();app.use(express.json({limit:'2mb'}),cookieParser(),auth.csrfProtection);app.use('/api',auth.authRouter,entities.entityRouter,articles.articlesRouter);
app.use((error:any,_req:any,res:any,_next:any)=>res.status(error.status || (error.name==='ZodError'?400:500)).json({error:error.message,code:error.code}));
const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
type Client={agent:ReturnType<typeof request.agent>;csrf:string;workspace:string;userId:string};
async function signup(name:string,code='isolated-articles'):Promise<Client> {
  const agent=request.agent(server),res=await agent.post('/api/auth/register').send({email:`${name}@articles.example.test`,name,password:'isolated-articles-password-123',code}).expect(201);
  return {agent,csrf:res.body.csrfToken,workspace:res.body.workspace.id,userId:res.body.user.id};
}
const mutate=(client:Client,method:'post'|'patch'|'delete',path:string)=>client.agent[method](`/api${path}`).set('x-csrf-token',client.csrf);
async function create(client:Client,metadata:Partial<WebsiteArticleMetadata>={},patch:Record<string,unknown>={}):Promise<Entity> {
  return (await mutate(client,'post','/entities').send({kind:'item',title:'Article for readers',content:'A useful explanation with a [primary source](https://example.com/research).',tags:['AI'],
    data:{type:'document',websiteArticle:{locale:'en',slug:`article-${randomUUID()}`,excerpt:'An everyday explanation.',category:'AI',featured:false,siteIds:['journal'],...metadata}},...patch}).expect(201)).body.entity;
}
async function approve(client:Client,entity:Entity):Promise<ArticleApproval> {
  return (await mutate(client,'post',`/articles/${entity.id}/approve`).send({version:entity.version}).expect(200)).body.approval;
}
async function publish(client:Client,entity:Entity,approval?:ArticleApproval):Promise<ArticlePublication[]> {
  const selected=approval || await approve(client,entity);
  return (await mutate(client,'post',`/articles/${entity.id}/publish`).send({version:entity.version,approvalId:selected.id}).expect(200)).body.publications;
}
async function update(client:Client,entity:Entity,patch:Record<string,unknown>):Promise<Entity> {
  return (await mutate(client,'patch',`/entities/${entity.id}`).send({version:entity.version,...patch}).expect(200)).body.entity;
}
async function rows(siteId='journal',slug?:string):Promise<any[]> {
  return db.query(`SELECT * FROM ${publishingSchema}.${siteId}_articles${slug?' WHERE slug=$1':''}`,slug?[slug]:[]);
}
const countEvents=async(id:string)=>Number((await db.query(`SELECT count(*) FROM ${publishingSchema}.article_events WHERE source_id=$1`,[id]))[0].count);
const readerRoles:string[]=[];
let alice:Client,bob:Client,editor:Client,viewer:Client;
before(async()=>{
  await db.migrate();await articles.migrateArticles();alice=await signup('alice');bob=await signup('bob');
  process.env.WEBSITE_PUBLISHING_WORKSPACE_ID=alice.workspace;await articles.migrateArticles();
  for(const role of ['editor','viewer'] as const) {
    const invite=await mutate(alice,'post',`/workspaces/${alice.workspace}/invite`).send({email:`${role}@articles.example.test`,role}).expect(201);
    const client=await signup(role,invite.body.token);if(role==='editor')editor=client;else viewer=client;
  }
});
after(async()=>{
  await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await db.closeDb();
  await admin.query(`DROP SCHEMA ${publishingSchema} CASCADE`);await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  for(const role of readerRoles) await admin.query(`DROP ROLE ${role}`);
  await admin.end();
});

describe('approved website snapshots',()=>{
  test('workspace-bound site registry cannot be claimed from the API or rebound by startup',async()=>{
    const own=await alice.agent.get('/api/articles/sites').expect(200);assert.deepEqual(own.body.sites,articles.ARTICLE_SITES);
    assert.deepEqual((await bob.agent.get('/api/articles/sites').expect(200)).body.sites,[]);
    const other=await create(bob);await mutate(bob,'post',`/articles/${other.id}/approve`).send({version:1}).expect(403);
    await mutate(bob,'post','/articles/sites').send({id:'journal',workspaceId:bob.workspace}).expect(404);
    process.env.WEBSITE_PUBLISHING_WORKSPACE_ID=bob.workspace;
    try {await assert.rejects(()=>articles.migrateArticles(),/already bound/);} finally {process.env.WEBSITE_PUBLISHING_WORKSPACE_ID=alice.workspace;}
    assert.equal((await db.query(`SELECT workspace_id FROM ${publishingSchema}.sites WHERE id='journal'`))[0].workspace_id,alice.workspace);
  });

  test('saved publications remain readable when an operator removes a configured destination',async()=>{
    let source=await create(alice,{siteIds:['journal','studio']});await publish(alice,source);
    const sites=articles.ARTICLE_SITES as {id:string;name:string;domain:string}[];
    const saved=[...sites];
    try {
      sites.splice(0,sites.length,...saved.filter(site=>site.id==='journal'));
      const listed=(await alice.agent.get('/api/articles').expect(200)).body.articles.find((entry:any)=>entry.entity.id===source.id);
      assert.equal(listed.publications.find((p:ArticlePublication)=>p.siteId==='studio').url,`https://studio.example/en/blog/${source.data.websiteArticle.slug}`);
      source=await update(alice,source,{data:{...source.data,websiteArticle:{...source.data.websiteArticle,siteIds:['journal']}}});
      const updated=await publish(alice,source);assert.equal(updated.length,2);
      await mutate(alice,'post',`/articles/${source.id}/unpublish`).send({version:source.version,siteIds:['journal'],operationId:randomUUID()}).expect(200);
      sites.splice(0,sites.length);
      await alice.agent.get('/api/articles').expect(200);
    } finally {sites.splice(0,sites.length,...saved);}
  });

  test('drafts and approvals stay private; approval has the exact snapshot without changing the source',async()=>{
    const source=await create(alice,{siteIds:['studio','journal'],coverImage:'/images/article.jpg',date:'2026-09-01T10:00:00-07:00'}),approval=await approve(alice,source);
    assert.equal(approval.sourceVersion,source.version);assert.equal(approval.snapshot.content,source.content);assert.equal(approval.snapshot.date,'2026-09-01T17:00:00.000Z');
    assert.deepEqual(approval.expectedRevisions,{journal:0,studio:0});assert.equal(approval.snapshot.coverImage,'/images/article.jpg');assert.match(approval.snapshotHash,/^[a-f\d]{64}$/);
    assert.deepEqual(approval.destinations.map(d=>d.url),[`https://journal.example/en/blog/${source.data.websiteArticle.slug}`,`https://studio.example/en/blog/${source.data.websiteArticle.slug}`]);
    assert.equal((await alice.agent.get(`/api/entities/${source.id}`).expect(200)).body.entity.version,source.version);
    assert.equal((await rows('journal',source.data.websiteArticle.slug)).length,0);
    assert.equal((await rows('studio',source.data.websiteArticle.slug)).length,0);
    const listed=(await alice.agent.get('/api/articles').expect(200)).body.articles.find((entry:any)=>entry.entity.id===source.id);assert.deepEqual(listed.publications,[]);
  });

  test('publishing is synchronous, idempotent and exposes only the approved public column contract',async()=>{
    const source=await create(alice,{siteIds:['journal','studio']}),approval=await approve(alice,source);
    const [one,two]=await Promise.all([publish(alice,source,approval),publish(alice,source,approval)]);assert.deepEqual(two,one);assert.equal(await countEvents(source.id),1);
    assert.equal(one.length,2);assert.equal(one[0].revision,1);assert.equal(one[0].status,'published');
    const publicRow=(await rows('journal',source.data.websiteArticle.slug))[0];
    assert.deepEqual(Object.keys(publicRow),['site_id','locale','slug','title','excerpt','content','category','tags','featured','cover_image','date','reading_time','updated_at']);
    assert.equal(publicRow.content,source.content);assert.equal(publicRow.reading_time,1);assert.equal(publicRow.cover_image,null);
    assert.equal((await rows('workshop',source.data.websiteArticle.slug)).length,0);
  });

  test('edits keep the live snapshot intact and approval cannot publish an old version or modified hash',async()=>{
    let source=await create(alice);const original=await approve(alice,source);await publish(alice,source,original);
    const pending=await approve(alice,source);source=await update(alice,source,{title:'Private revision',content:'New unpublished text.'});
    assert.equal((await rows('journal',source.data.websiteArticle.slug))[0].title,'Article for readers');
    await mutate(alice,'post',`/articles/${source.id}/publish`).send({version:1,approvalId:pending.id}).expect(409);
    await mutate(alice,'post',`/articles/${source.id}/publish`).send({version:2,approvalId:pending.id}).expect(409);
    const current=await approve(alice,source);
    await db.query('UPDATE entities SET title=$2 WHERE id=$1',[source.id,'Out-of-band content change']);
    const stale=await mutate(alice,'post',`/articles/${source.id}/publish`).send({version:2,approvalId:current.id}).expect(409);assert.equal(stale.body.code,'ARTICLE_APPROVAL_STALE');
    // Retrying a consumed approval returns its receipt and never reapplies the old source.
    assert.equal((await publish(alice,{...source,version:1},original))[0].revision,1);assert.equal(await countEvents(source.id),1);
  });

  test('updates affect selected sites only, and removing a destination does not silently unpublish it',async()=>{
    let source=await create(alice,{siteIds:['journal','studio']});await publish(alice,source);
    source=await update(alice,source,{content:'The second version.',data:{...source.data,websiteArticle:{...source.data.websiteArticle,siteIds:['journal']}}});
    const updated=await publish(alice,source);assert.deepEqual(updated.map(p=>[p.siteId,p.revision]),[['journal',2],['studio',1]]);
    assert.equal((await rows('journal',source.data.websiteArticle.slug))[0].content,'The second version.');assert.equal((await rows('studio',source.data.websiteArticle.slug))[0].content,'A useful explanation with a [primary source](https://example.com/research).');
    const input={version:source.version,siteIds:['studio'],operationId:randomUUID(),expectedRevisions:{studio:1}};
    const removed=await mutate(alice,'post',`/articles/${source.id}/unpublish`).send(input).expect(200);
    assert.equal(removed.body.publications.find((p:ArticlePublication)=>p.siteId==='studio').status,'unpublished');assert.equal((await rows('studio',source.data.websiteArticle.slug)).length,0);assert.equal((await rows('journal',source.data.websiteArticle.slug)).length,1);
    assert.deepEqual((await mutate(alice,'post',`/articles/${source.id}/unpublish`).send(input).expect(200)).body,removed.body);assert.equal(await countEvents(source.id),3);
  });

  test('unpublish retries cannot remove a later republish and explicit revisions reject stale confirmations',async()=>{
    const source=await create(alice);await publish(alice,source);
    const input={version:1,siteIds:['journal'],operationId:randomUUID(),expectedRevisions:{journal:1}};
    await mutate(alice,'post',`/articles/${source.id}/unpublish`).send(input).expect(200);
    assert.equal((await publish(alice,source))[0].revision,3);
    await mutate(alice,'post',`/articles/${source.id}/unpublish`).send(input).expect(200);assert.equal((await rows('journal',source.data.websiteArticle.slug)).length,1);
    await mutate(alice,'post',`/articles/${source.id}/unpublish`).send({...input,operationId:randomUUID()}).expect(409);
    await mutate(alice,'post',`/articles/${source.id}/unpublish`).send({...input,siteIds:['studio']}).expect(409);
    assert.equal(await countEvents(source.id),3);
  });

  test('two approvals for one publication cannot overwrite a newer destination revision',async()=>{
    const source=await create(alice),first=await approve(alice,source),second=await approve(alice,source);await publish(alice,source,first);
    const failed=await mutate(alice,'post',`/articles/${source.id}/publish`).send({version:1,approvalId:second.id}).expect(409);assert.equal(failed.body.code,'ARTICLE_REVISION_CONFLICT');assert.equal(await countEvents(source.id),1);
  });

  test('slug reservations and path changes are explicit and a conflict leaves all selected sites untouched',async()=>{
    let existing=await create(alice,{siteIds:['studio']});await publish(alice,existing);
    const duplicate=await create(alice,{slug:existing.data.websiteArticle.slug,siteIds:['journal','studio']});
    const failed=await mutate(alice,'post',`/articles/${duplicate.id}/approve`).send({version:1}).expect(409);assert.equal(failed.body.code,'ARTICLE_SLUG_CONFLICT');assert.equal((await rows('journal',existing.data.websiteArticle.slug)).length,0);
    existing=await update(alice,existing,{data:{...existing.data,websiteArticle:{...existing.data.websiteArticle,slug:'new-path'}}});
    await mutate(alice,'post',`/articles/${existing.id}/approve`).send({version:existing.version}).expect(409);
    await mutate(alice,'post',`/articles/${existing.id}/unpublish`).send({version:existing.version,siteIds:['studio'],operationId:randomUUID()}).expect(200);
    await publish(alice,existing);assert.equal((await rows('studio','new-path')).length,1);
  });

  test('concurrent featured writes preserve one featured article per site and locale with auditable demotion',async()=>{
    const one=await create(alice,{featured:true,siteIds:['journal','workshop']}),two=await create(alice,{featured:true,siteIds:['journal','workshop']});
    const [a,b]=await Promise.all([approve(alice,one),approve(alice,two)]);await Promise.all([publish(alice,one,a),publish(alice,two,b)]);
    for(const siteId of ['journal','workshop']) {
      const featured=(await rows(siteId)).filter(row=>row.locale==='en' && row.featured);assert.equal(featured.length,1);
      const records=await db.query(`SELECT revision FROM ${publishingSchema}.article_snapshots WHERE site_id=$1 AND source_id=ANY($2::uuid[]) ORDER BY revision`,[siteId,[one.id,two.id]]);assert.deepEqual(records.map(r=>r.revision),[1,2]);
    }
    const zh=await create(alice,{locale:'zh',featured:true,siteIds:['journal']},{content:'中文内容，提供清楚的解释。'});await publish(alice,zh);
    assert.equal((await rows('journal')).filter(row=>row.featured).length,2);
    const events=await db.query(`SELECT changes FROM ${publishingSchema}.article_events WHERE source_id=ANY($1::uuid[])`,[[one.id,two.id]]);assert.ok(events.some(event=>event.changes.some((change:any)=>change.reason==='featured-replaced')));
  });

  test('approvals and audit receipts reject mutation at the database boundary',async()=>{
    const source=await create(alice),approval=await approve(alice,source);await publish(alice,source,approval);
    await assert.rejects(()=>db.query(`UPDATE ${publishingSchema}.article_approvals SET snapshot='{}'::jsonb WHERE id=$1`,[approval.id]),/immutable/);
    await assert.rejects(()=>db.query(`DELETE FROM ${publishingSchema}.article_events WHERE source_id=$1`,[source.id]),/immutable/);
    assert.equal(await countEvents(source.id),1);
  });

  test('source ACL, role and API token scope are enforced on list, approve, publish and unpublish',async()=>{
    const source=await create(alice,{}, {visibility:'private'}),approval=await approve(alice,source);await publish(alice,source,approval);
    assert.equal((await editor.agent.get('/api/articles').expect(200)).body.articles.some((entry:any)=>entry.entity.id===source.id),false);
    for(const client of [editor,bob]) {
      await mutate(client,'post',`/articles/${source.id}/approve`).send({version:1}).expect(404);
      await mutate(client,'post',`/articles/${source.id}/publish`).send({version:1,approvalId:approval.id}).expect(404);
      await mutate(client,'post',`/articles/${source.id}/unpublish`).send({version:1,siteIds:['journal']}).expect(404);
    }
    await mutate(viewer,'post',`/articles/${source.id}/approve`).send({version:1}).expect(403);
    const token=(await mutate(alice,'post','/tokens').send({name:'Article reader',scopes:['workspace:read']}).expect(201)).body.token;
    await request(server).get('/api/articles').set('Authorization',`Bearer ${token}`).expect(200);
    await request(server).post(`/api/articles/${source.id}/approve`).set('Authorization',`Bearer ${token}`).send({version:1}).expect(403);
    const publishingToken=(await mutate(alice,'post','/tokens').send({name:'Article publisher',scopes:['publish:write']}).expect(201)).body.token;
    await request(server).get('/api/articles').set('Authorization',`Bearer ${publishingToken}`).expect(403);
    await request(server).post(`/api/articles/${source.id}/approve`).set('Authorization',`Bearer ${publishingToken}`).send({version:1}).expect(200);
    await request(server).get('/api/articles').expect(401);
  });

  test('deleted or repurposed sources keep their snapshot visible and remain available for explicit unpublish',async()=>{
    const source=await create(alice);await publish(alice,source);const deleted=(await mutate(alice,'delete',`/entities/${source.id}`).expect(200)).body.entity;
    assert.equal((await rows('journal',source.data.websiteArticle.slug)).length,1);
    assert.equal((await alice.agent.get('/api/articles').expect(200)).body.articles.some((entry:any)=>entry.entity.id===source.id),true);
    await mutate(alice,'post',`/articles/${source.id}/approve`).send({version:deleted.version}).expect(404);
    await mutate(alice,'post',`/articles/${source.id}/unpublish`).send({version:deleted.version,siteIds:['journal'],operationId:randomUUID()}).expect(200);
    assert.equal((await rows('journal',source.data.websiteArticle.slug)).length,0);
  });

  test('private links, encoded references and expiring media cannot enter approved snapshots',async()=>{
    for(const content of [
      '[private](/api/files/secret)','![private](/api/media/temporary)','[private](/library?open=secret)',
      '[private](/api%2ffiles/secret)','[private](/api/&#102;iles/secret)','[private](http://localhost:5173/library?open=secret)',
      '![local](//127.0.0.1/private.png)','![local](//[::1]/private.png)','[private][source]\n\n[source]: /library?open=secret',
      '<img src="/api/files/private.png">','<img srcset="https://images.example.com/a.png 1x, //127.0.0.1/private.png 2x">',
      'Read <http://localhost:5173/api/files/private>','Read https://example.com/a?access_token=secret',
      '![temporary](https://images.example.com/a.png?X-Amz-Signature=secret)',
      '![temporary](https://images.example.com/a.png?sv=1&se=2026-09-12&sig=secret)',
      '[credential](https://user:password@example.com/a)','[private](https://127.0.0.1/a)',
    ]) {
      const source=await create(alice,{}, {content});const failed=await mutate(alice,'post',`/articles/${source.id}/approve`).send({version:1}).expect(400);assert.equal(failed.body.code,'ARTICLE_PRIVATE_LINK');
    }
    for(const coverImage of ['/api/files/a.png','/images/../a.png','//external.example.com/a.png','http://images.example.com/a.png','https://images.example.com/a.png?token=temporary']) {
      const source=await create(alice,{coverImage});await mutate(alice,'post',`/articles/${source.id}/approve`).send({version:1}).expect(400);
    }
    const valid=await create(alice,{coverImage:'https://images.example.com/permanent.png'});assert.equal((await approve(alice,valid)).snapshot.coverImage,'https://images.example.com/permanent.png');
    for(const content of ['<img src="ht&#9;tps://127.0.0.1/private.png">','![local](ht%09tps://127.0.0.1/private.png)']) {
      const source=await create(alice,{}, {content});const failed=await mutate(alice,'post',`/articles/${source.id}/approve`).send({version:1}).expect(400);assert.equal(failed.body.code,'ARTICLE_URL');
    }
  });

  test('public technical prose and code examples retain their exact Markdown without false URL matches',async()=>{
    const content='In a monorepo, edit `packages/api/src/` and `packages/api/.claude/skills/`. The /boards and /settings folders contain UI code.\n\n'+
      '```typescript\nconst endpoint = "/api/files/example";\nconst local = "http://127.0.0.1:3000/api/";\n```\n\n'+
      'The literal `![example](/api/media/temporary)` illustrates Markdown syntax.\n\n'+
      'Read [public API documentation](https://example.com/api/docs) and ![a public image](//images.example.com/image.png).\n';
    const source=await create(alice,{}, {content}),approval=await approve(alice,source);
    assert.equal(approval.snapshot.content,content);await publish(alice,source,approval);assert.equal((await rows('journal',source.data.websiteArticle.slug))[0].content,content);
  });

  test('metadata requires explicit language, safe slugs, destination and usable article text',async()=>{
    for(const metadata of [{locale:'zh-CN'},{slug:'../../private'},{slug:'UPPER'},{siteIds:[]},{siteIds:['arbitrary']},{featured:'yes'},{date:'2026-02-30T00:00:00Z'},{unexpected:'ignored?'}]) {
      const source=await create(alice,metadata as any);await mutate(alice,'post',`/articles/${source.id}/approve`).send({version:1}).expect(400);
    }
    const empty=await create(alice,{}, {content:'   '});await mutate(alice,'post',`/articles/${empty.id}/approve`).send({version:1}).expect(400);
    for(const value of ['publishing; DROP SCHEMA public','public','pg_catalog','"publishing"','Bad-Name','']) assert.throws(()=>articles.validatePublishingSchema(value));
  });

  test('read-only site roles see only their view, cannot query private tables or another site, and cannot mutate articles',async()=>{
    const source=await create(alice,{siteIds:['journal']});await publish(alice,source);
    for(const siteId of ['journal','studio','workshop']) {
      const role=`article_reader_${siteId}_${suffix}`;readerRoles.push(role);
      await admin.query(`CREATE ROLE ${role} NOLOGIN`);await admin.query(`GRANT USAGE ON SCHEMA ${publishingSchema} TO ${role}`);await admin.query(`GRANT SELECT ON ${publishingSchema}.${siteId}_articles TO ${role}`);
      const asReader=<T>(sql:string)=>db.withTransaction(async client=>{await client.query(`SET LOCAL ROLE ${role}`);return (await client.query(sql)).rows as T[];});
      const visible=await asReader<any>(`SELECT * FROM ${publishingSchema}.${siteId}_articles`);assert.ok(visible.every(row=>row.site_id===siteId));
      assert.equal(visible.some(row=>row.slug===source.data.websiteArticle.slug),siteId==='journal');
      await assert.rejects(()=>asReader(`SELECT * FROM ${publishingSchema}.article_snapshots`),/permission denied/);
      await assert.rejects(()=>asReader(`SELECT * FROM ${publishingSchema}.article_approvals`),/permission denied/);
      await assert.rejects(()=>asReader(`SELECT * FROM ${publishingSchema}.article_events`),/permission denied/);
      await assert.rejects(()=>asReader(`SELECT * FROM ${schema}.entities`),/permission denied/);
      const other=siteId==='journal'?'studio':'journal';await assert.rejects(()=>asReader(`SELECT * FROM ${publishingSchema}.${other}_articles`),/permission denied/);
      await assert.rejects(()=>asReader(`DELETE FROM ${publishingSchema}.${siteId}_articles`),/permission denied|cannot delete/);
    }
  });
});
