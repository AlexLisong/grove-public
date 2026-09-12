import {createHash,randomUUID} from 'node:crypto';
import {isIP} from 'node:net';
import {Router} from 'express';
import type {PoolClient} from 'pg';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import sanitizeHtml from 'sanitize-html';
import {z} from 'zod';
import {currentAccess,entityAccessPredicate} from './core/access.js';
import {requireAuth,requireEditor,requireScope} from './core/auth.js';
import {query,withTransaction} from './core/db.js';
import {mapEntity} from './core/entities.js';
import {httpError,isPublicAddress} from './core/security.js';
import type {Entity} from '../shared/types.js';
import type {ArticleApproval,ArticleListEntry,ArticlePublication,ArticleSite,ArticleSnapshot,ArticleUnpublishRequest} from '../shared/articles.js';

import {parseArticleSites} from './article-sites.js';

export const ARTICLE_SITES:readonly ArticleSite[] = parseArticleSites(process.env.WEBSITE_PUBLISHING_SITES);
export function validatePublishingSchema(value:string):string {
  if(!/^[a-z_][a-z0-9_]{0,62}$/.test(value) || ['public','information_schema'].includes(value) || value.startsWith('pg_')) {
    throw new Error('PUBLISHING_SCHEMA must be a dedicated lowercase PostgreSQL identifier.');
  }
  return value;
}
export const publishingSchema = validatePublishingSchema(process.env.PUBLISHING_SCHEMA || 'publishing');
const sqlSchema = `"${publishingSchema}"`;
const iso = (value:Date|string):string => value instanceof Date ? value.toISOString() : value;
const hash = (value:unknown):string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const siteIdSchema = z.string().refine(id=>ARTICLE_SITES.some(site=>site.id===id),'Unknown publishing destination');
const siteIdsSchema = z.array(siteIdSchema).min(1).max(20).transform(ids=>[...new Set(ids)].sort());
const metadataSchema = z.object({
  locale:z.enum(['en','zh']),slug:z.string().min(1).max(200).regex(/^[a-z0-9][a-z0-9-]*$/),
  excerpt:z.string().trim().min(1).max(1000),category:z.string().trim().min(1).max(80),
  featured:z.boolean(),coverImage:z.string().trim().max(2048).optional(),siteIds:siteIdsSchema,
  date:z.iso.datetime({offset:true}).optional(),
}).strict();
const approveSchema = z.object({version:z.number().int().positive()}).strict();
const publishSchema = approveSchema.extend({approvalId:z.uuid()}).strict();
const unpublishSchema = approveSchema.extend({
  siteIds:siteIdsSchema,operationId:z.uuid().optional(),
  expectedRevisions:z.record(siteIdSchema,z.number().int().nonnegative()).optional(),
}).strict();

/** Public views are the entire website-reader contract. Private IDs and audit data never enter them. */
export async function migrateArticles():Promise<void> {
  // Existing unrelated test suites initialize the application in their own core schema.
  // Article tests must explicitly provide a separate PUBLISHING_SCHEMA as well.
  if(process.env.NODE_ENV==='test' && !process.env.PUBLISHING_SCHEMA) return;
  await withTransaction(async client=>{
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`grove:articles:migrate:${publishingSchema}`]);
    await client.query(`
      CREATE SCHEMA IF NOT EXISTS ${sqlSchema};
      REVOKE ALL ON SCHEMA ${sqlSchema} FROM PUBLIC;
      CREATE TABLE IF NOT EXISTS ${sqlSchema}.sites (
        id text PRIMARY KEY CHECK(id ~ '^[a-z][a-z0-9_]{0,39}$'),
        name text NOT NULL, domain text NOT NULL UNIQUE, workspace_id uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS ${sqlSchema}.article_snapshots (
        site_id text NOT NULL REFERENCES ${sqlSchema}.sites(id), workspace_id uuid NOT NULL, source_id uuid NOT NULL,
        locale text NOT NULL CHECK(locale IN ('en','zh')),slug text NOT NULL,title text NOT NULL,excerpt text NOT NULL,
        content text NOT NULL,category text NOT NULL,tags text[] NOT NULL DEFAULT '{}',featured boolean NOT NULL DEFAULT false,
        cover_image text,date timestamptz NOT NULL,reading_time integer NOT NULL CHECK(reading_time>0),
        status text NOT NULL CHECK(status IN ('published','unpublished')),revision integer NOT NULL CHECK(revision>0),
        source_version integer NOT NULL CHECK(source_version>0),snapshot_hash text NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(site_id,source_id),UNIQUE(site_id,locale,slug)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS article_one_featured ON ${sqlSchema}.article_snapshots(site_id,locale)
        WHERE status='published' AND featured;
      CREATE INDEX IF NOT EXISTS article_source ON ${sqlSchema}.article_snapshots(workspace_id,source_id);
      CREATE TABLE IF NOT EXISTS ${sqlSchema}.article_approvals (
        id uuid PRIMARY KEY,workspace_id uuid NOT NULL,source_id uuid NOT NULL,source_version integer NOT NULL,
        snapshot jsonb NOT NULL,snapshot_hash text NOT NULL,destinations jsonb NOT NULL,expected_revisions jsonb NOT NULL,
        approved_by uuid NOT NULL,approved_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS article_approval_source ON ${sqlSchema}.article_approvals(workspace_id,source_id);
      CREATE TABLE IF NOT EXISTS ${sqlSchema}.article_events (
        id uuid PRIMARY KEY,workspace_id uuid NOT NULL,source_id uuid NOT NULL,actor_id uuid NOT NULL,
        action text NOT NULL CHECK(action IN ('publish','unpublish')),approval_id uuid REFERENCES ${sqlSchema}.article_approvals(id),
        operation_key text NOT NULL,request_hash text NOT NULL,result jsonb NOT NULL,changes jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(workspace_id,operation_key),UNIQUE(approval_id)
      );
      CREATE OR REPLACE FUNCTION ${sqlSchema}.reject_article_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'Article approvals and audit events are immutable'; END;
      $$;
      DROP TRIGGER IF EXISTS article_approval_immutable ON ${sqlSchema}.article_approvals;
      CREATE TRIGGER article_approval_immutable BEFORE UPDATE OR DELETE ON ${sqlSchema}.article_approvals
        FOR EACH ROW EXECUTE FUNCTION ${sqlSchema}.reject_article_audit_mutation();
      DROP TRIGGER IF EXISTS article_event_immutable ON ${sqlSchema}.article_events;
      CREATE TRIGGER article_event_immutable BEFORE UPDATE OR DELETE ON ${sqlSchema}.article_events
        FOR EACH ROW EXECUTE FUNCTION ${sqlSchema}.reject_article_audit_mutation();
    `);
    for(const site of ARTICLE_SITES) {
      await client.query(`CREATE OR REPLACE VIEW ${sqlSchema}.${site.id}_articles WITH (security_barrier=true) AS
        SELECT a.site_id,a.locale,a.slug,a.title,a.excerpt,a.content,a.category,a.tags,a.featured,a.cover_image,a.date,a.reading_time,a.updated_at
        FROM ${sqlSchema}.article_snapshots a JOIN ${sqlSchema}.sites s ON s.id=a.site_id AND s.workspace_id=a.workspace_id
        WHERE a.status='published' AND a.site_id='${site.id}'`);
    }
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${sqlSchema} FROM PUBLIC`);
    const workspaceId=process.env.WEBSITE_PUBLISHING_WORKSPACE_ID;
    if(workspaceId) {
      z.uuid().parse(workspaceId);
      if(!(await client.query('SELECT id FROM workspaces WHERE id=$1',[workspaceId])).rowCount) throw new Error('WEBSITE_PUBLISHING_WORKSPACE_ID does not identify an existing Grove workspace.');
      for(const site of ARTICLE_SITES) {
        await client.query(`INSERT INTO ${sqlSchema}.sites(id,name,domain,workspace_id) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING`,[site.id,site.name,site.domain,workspaceId]);
        const {rows:[bound]}=await client.query(`SELECT workspace_id,domain FROM ${sqlSchema}.sites WHERE id=$1`,[site.id]);
        if(bound.workspace_id!==workspaceId || bound.domain!==site.domain) throw new Error(`Publishing site ${site.id} is already bound to a different workspace or domain; explicit provisioning is required.`);
      }
    }
  });
}

function decodeLinkText(value:string):string {
  let decoded=value.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g,'$1');
  for(let i=0;i<3;i++) {
    const next=decoded.replace(/&#(?:x([0-9a-f]+)|(\d+));?/gi,(_m,hex,decimal)=>{
      const point=parseInt(hex || decimal,hex?16:10);return point<=0x10ffff?String.fromCodePoint(point):'';
    }).replace(/&(?:amp|sol|colon|quest|equals);/gi,entity=>({'&amp;':'&','&sol;':'/','&colon;':':','&quest;':'?','&equals;':'='}[entity.toLowerCase()] || entity));
    let unescaped=next;
    try {unescaped=decodeURIComponent(next);} catch {unescaped=next.replace(/%([0-9a-f]{2})/gi,(_m,h)=>String.fromCharCode(parseInt(h,16)));}
    if(unescaped===decoded) break;
    decoded=unescaped;
  }
  return decoded;
}
const normalizedHostname=(url:URL)=>url.hostname.replace(/^\[|\]$/g,'').replace(/\.$/,'').toLowerCase();
function assertPublicDestination(value:string):void {
  const decoded=decodeLinkText(value).trim();
  if(!decoded) return;
  // URL() removes embedded ASCII tabs/newlines from schemes and hosts. Reject
  // them before classification so an obfuscated absolute URL cannot look relative.
  if(/[\u0000-\u001f\u007f]/.test(decoded)) throw httpError(400,'Article URLs must not contain control characters.','ARTICLE_URL');
  const absolute=/^(?:[a-z][a-z\d+.-]*:|[\\/]{2})/i.test(decoded);
  let url:URL;
  try {url=new URL(decoded,'https://article-relative.invalid/');} catch {throw httpError(400,'An article contains an invalid URL.','ARTICLE_URL');}
  const sensitiveKey=/^(?:token|access_token|api[_-]?key|secret|authorization|auth|sig|signature|expires|se|x-amz-[\w-]+|x-goog-[\w-]+)$/i;
  if([...url.searchParams.keys(),...new URLSearchParams(url.hash.slice(1)).keys()].some(key=>sensitiveKey.test(key)) ||
    /^\/api\/(?:files|media)(?:\/|$)/i.test(url.pathname) ||
    (!absolute && /^\/(?:api|library|boards|drafts|chats|settings)(?:\/|$)/i.test(url.pathname))) {
    throw httpError(400,'Replace private Grove links and temporary media URLs with permanent public links before approval.','ARTICLE_PRIVATE_LINK');
  }
  if(['mailto:','tel:'].includes(url.protocol)) return;
  if(!['http:','https:'].includes(url.protocol)) throw httpError(400,'Article links must use public HTTP or HTTPS URLs, website paths, or contact links.','ARTICLE_URL');
  if(!absolute) return;
  const hostname=normalizedHostname(url),appHostname=process.env.APP_URL ? normalizedHostname(new URL(process.env.APP_URL)) : undefined;
  if(url.username || url.password || hostname===appHostname || (isIP(hostname)?!isPublicAddress(hostname):!hostname.includes('.') || /(^|\.)(localhost|local|internal|test|invalid)$/i.test(hostname))) {
    throw httpError(400,'Article links must be publicly usable and must not contain credentials or private network addresses.','ARTICLE_PRIVATE_LINK');
  }
}
function assertHtmlDestinations(value:string):void {
  // Only inspect actual attributes, using the HTML parser's entity decoding.
  // The returned markup is discarded; website rendering and sanitization remain separate.
  sanitizeHtml(value,{allowedTags:[],allowedAttributes:{},onOpenTag:(_name,attributes)=>{
    for(const key of ['href','src','poster','cite','action','formaction','data']) if(attributes[key]) assertPublicDestination(attributes[key]);
    if(attributes.srcset) for(const entry of attributes.srcset.split(',')) assertPublicDestination(entry.trim().split(/\s+/)[0]);
    if(attributes.style) for(const match of attributes.style.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) assertPublicDestination(match[2]);
  }});
}
function assertPublicReferences(value:string):void {
  // Reuse the reader's declared Markdown dependencies so code examples and ordinary
  // paths are never mistaken for links, while reference links and GFM URLs are checked.
  const inspectLinks=()=> (tree:any)=>{
    const pending=[tree];
    while(pending.length) {
      const node=pending.pop();
      if(['link','image','definition'].includes(node.type) && typeof node.url==='string') assertPublicDestination(node.url);
      if(node.type==='html') assertHtmlDestinations(node.value);
      if(Array.isArray(node.children)) for(const child of node.children) pending.push(child);
    }
  };
  Markdown({children:value,remarkPlugins:[remarkGfm,inspectLinks],allowedElements:[]});
}
export function createArticleSnapshot(entity:Entity):ArticleSnapshot {
  const metadata=metadataSchema.parse(entity.data.websiteArticle);
  const title=z.string().trim().min(1).max(500).parse(entity.title);
  const content=z.string().max(1_000_000).refine(value=>value.trim().length>0,'Write article content before approval.').parse(entity.content);
  const tags=z.array(z.string().trim().min(1).max(80)).max(100).parse(entity.tags);
  for(const value of [title,content,metadata.excerpt,metadata.category,...tags]) assertPublicReferences(value);
  let coverImage=metadata.coverImage || undefined;
  if(coverImage) {
    assertPublicDestination(coverImage);
    const decoded=decodeLinkText(coverImage);
    if(/[\s\\\u0000-\u001f]/.test(decoded)) throw httpError(400,'Use a permanent public HTTPS image or a root-relative website image asset.','ARTICLE_COVER');
    if(coverImage.startsWith('/')) {
      if(!/^\/(?!\/)[\w/.-]+\.(?:png|jpe?g|webp|gif|avif|svg)$/i.test(decoded) || decoded.split('/').includes('..')) throw httpError(400,'Use a root-relative website image asset, such as /images/cover.jpg.','ARTICLE_COVER');
    } else {
      let url:URL;try {url=new URL(coverImage);} catch {throw httpError(400,'Use a permanent public HTTPS image.','ARTICLE_COVER');}
      if(url.protocol!=='https:' || (url.port && url.port!=='443')) throw httpError(400,'Use a permanent public HTTPS image.','ARTICLE_COVER');
      coverImage=url.href;
    }
  }
  return {title,content,tags:[...new Set(tags)],locale:metadata.locale,slug:metadata.slug,excerpt:metadata.excerpt,category:metadata.category,
    featured:metadata.featured,...(coverImage?{coverImage}:{}),date:new Date(metadata.date || entity.createdAt).toISOString(),siteIds:metadata.siteIds};
}
function readingTime(snapshot:ArticleSnapshot):number {
  const chinese=(snapshot.content.match(/\p{Script=Han}/gu)||[]).length;
  const words=(snapshot.content.replace(/\p{Script=Han}/gu,' ').match(/[\p{L}\p{N}]+/gu)||[]).length;
  return Math.max(1,Math.ceil(words/220+chinese/400));
}
const articleUrl=(site:ArticleSite,locale:string,slug:string):string=>`https://${site.domain}/${locale}/blog/${slug}`;
function mapPublication(row:any):ArticlePublication {
  const site:ArticleSite={id:row.site_id,name:row.site_id,domain:row.site_domain};
  return {siteId:row.site_id,locale:row.locale,slug:row.slug,url:articleUrl(site,row.locale,row.slug),status:row.status,
    revision:row.revision,sourceVersion:row.source_version,updatedAt:iso(row.updated_at)};
}
function mapApproval(row:any):ArticleApproval {
  return {id:row.id,sourceVersion:row.source_version,snapshot:row.snapshot,snapshotHash:row.snapshot_hash,destinations:row.destinations,
    expectedRevisions:row.expected_revisions,approvedAt:iso(row.approved_at)};
}
async function lockSource(client:PoolClient,workspaceId:string,id:string,includeDeleted=false):Promise<Entity> {
  const actor=currentAccess();
  if(!actor || actor.workspaceId!==workspaceId) throw httpError(403,'An authorized workspace editor is required.','WORKSPACE_ACCESS');
  const {rows:[member]}=await client.query('SELECT role,item_only FROM memberships WHERE workspace_id=$1 AND user_id=$2 FOR SHARE',[workspaceId,actor.userId]);
  if(!member || member.role==='viewer' || member.item_only) throw httpError(403,'Editor access is required.','EDITOR_REQUIRED');
  if(actor.scopes && !actor.scopes.includes('publish:write')) throw httpError(403,'The API token requires publish:write.','TOKEN_SCOPE');
  const access=entityAccessPredicate('e',3,'edit');
  const {rows:[row]}=await client.query(`SELECT e.* FROM entities e WHERE e.workspace_id=$1 AND e.id=$2 AND ${access.sql}
    ${includeDeleted?'':'AND e.deleted_at IS NULL'} FOR UPDATE OF e`,[workspaceId,z.uuid().parse(id),...access.params]);
  if(!row || row.kind!=='item' || (!includeDeleted && row.data.type!=='document')) throw httpError(404,'Article document not found or this account cannot edit it.','NOT_FOUND');
  return mapEntity(row);
}
function assertVersion(entity:Entity,version:number):void {
  if(entity.version!==version) throw httpError(409,'This document changed. Save and review the current version before publishing.','VERSION_CONFLICT');
}
async function authorizedSites(client:PoolClient,workspaceId:string,ids:string[]):Promise<ArticleSite[]> {
  const {rows}=await client.query(`SELECT id,name,domain FROM ${sqlSchema}.sites WHERE workspace_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR SHARE`,[workspaceId,ids]);
  if(rows.length!==ids.length || rows.some(row=>!ARTICLE_SITES.some(site=>site.id===row.id && site.domain===row.domain))) throw httpError(403,'One or more websites are not configured for this workspace.','ARTICLE_SITE_ACCESS');
  return rows;
}
async function lockDestinations(client:PoolClient,siteIds:string[]):Promise<void> {
  // All source operations take site locks in the same order, including changes to featured rows.
  for(const siteId of [...siteIds].sort()) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`grove:articles:${publishingSchema}:${siteId}`]);
}
async function sourcePublications(client:PoolClient,workspaceId:string,sourceId:string):Promise<any[]> {
  return (await client.query(`SELECT a.*,s.domain AS site_domain FROM ${sqlSchema}.article_snapshots a JOIN ${sqlSchema}.sites s ON s.id=a.site_id AND s.workspace_id=a.workspace_id WHERE a.workspace_id=$1 AND a.source_id=$2 ORDER BY a.site_id`,[workspaceId,sourceId])).rows;
}
async function checkPaths(client:PoolClient,workspaceId:string,sourceId:string,snapshot:ArticleSnapshot,current:any[]):Promise<void> {
  for(const siteId of snapshot.siteIds) {
    const previous=current.find(row=>row.site_id===siteId);
    if(previous?.status==='published' && (previous.locale!==snapshot.locale || previous.slug!==snapshot.slug)) throw httpError(409,'Unpublish the existing article URL before changing its language or slug.','ARTICLE_PATH_CHANGED');
    const {rows}=await client.query(`SELECT source_id FROM ${sqlSchema}.article_snapshots WHERE site_id=$1 AND locale=$2 AND slug=$3 AND (source_id<>$4 OR workspace_id<>$5)`,[siteId,snapshot.locale,snapshot.slug,sourceId,workspaceId]);
    if(rows.length) throw httpError(409,`This article URL is already reserved on ${siteId}. Choose another slug.`,'ARTICLE_SLUG_CONFLICT');
  }
}
export async function listArticleSites(workspaceId:string):Promise<ArticleSite[]> {
  return (await query<ArticleSite>(`SELECT id,name,domain FROM ${sqlSchema}.sites WHERE workspace_id=$1 ORDER BY id`,[workspaceId]))
    .filter(row=>ARTICLE_SITES.some(site=>site.id===row.id && site.domain===row.domain));
}
export async function listArticles(workspaceId:string):Promise<ArticleListEntry[]> {
  const access=entityAccessPredicate('e',2,'view');
  const entities=(await query(`SELECT e.* FROM entities e WHERE e.workspace_id=$1 AND e.kind='item' AND ${access.sql}
    AND ((e.deleted_at IS NULL AND e.data->>'type'='document' AND e.data ? 'websiteArticle') OR EXISTS (
      SELECT 1 FROM ${sqlSchema}.article_snapshots a WHERE a.source_id=e.id AND a.workspace_id=e.workspace_id))
    ORDER BY e.updated_at DESC,e.id LIMIT 2000`,[workspaceId,...access.params])).map(mapEntity);
  const rows=await query(`SELECT a.*,s.domain AS site_domain FROM ${sqlSchema}.article_snapshots a JOIN ${sqlSchema}.sites s ON s.id=a.site_id AND s.workspace_id=a.workspace_id WHERE a.workspace_id=$1 AND a.source_id=ANY($2::uuid[]) ORDER BY a.site_id`,[workspaceId,entities.map(entity=>entity.id)]);
  return entities.map(entity=>({entity,publications:rows.filter(row=>row.source_id===entity.id).map(mapPublication)}));
}
export async function approveArticle(workspaceId:string,id:string,version:number):Promise<ArticleApproval> {
  return withTransaction(async client=>{
    const entity=await lockSource(client,workspaceId,id);assertVersion(entity,version);
    const snapshot=createArticleSnapshot(entity),sites=await authorizedSites(client,workspaceId,snapshot.siteIds);
    await lockDestinations(client,snapshot.siteIds);
    const current=await sourcePublications(client,workspaceId,id);await checkPaths(client,workspaceId,id,snapshot,current);
    const expectedRevisions=Object.fromEntries(snapshot.siteIds.map(siteId=>[siteId,current.find(row=>row.site_id===siteId)?.revision || 0]));
    const destinations=sites.map(site=>({siteId:site.id,url:articleUrl(site,snapshot.locale,snapshot.slug)}));
    const {rows:[row]}=await client.query(`INSERT INTO ${sqlSchema}.article_approvals(id,workspace_id,source_id,source_version,snapshot,snapshot_hash,destinations,expected_revisions,approved_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[randomUUID(),workspaceId,id,version,JSON.stringify(snapshot),hash(snapshot),JSON.stringify(destinations),JSON.stringify(expectedRevisions),currentAccess()!.userId]);
    return mapApproval(row);
  });
}
async function priorReceipt(client:PoolClient,workspaceId:string,key:string,requestHash:string):Promise<ArticlePublication[]|null> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`grove:article-operation:${publishingSchema}:${workspaceId}:${key}`]);
  const {rows:[event]}=await client.query(`SELECT request_hash,result FROM ${sqlSchema}.article_events WHERE workspace_id=$1 AND operation_key=$2`,[workspaceId,key]);
  if(!event) return null;
  if(event.request_hash!==requestHash) throw httpError(409,'This operation identifier was already used for a different request.','ARTICLE_OPERATION_CONFLICT');
  return event.result.publications;
}
async function recordEvent(client:PoolClient,workspaceId:string,sourceId:string,action:'publish'|'unpublish',key:string,requestHash:string,publications:ArticlePublication[],changes:unknown[],approvalId?:string):Promise<void> {
  await client.query(`INSERT INTO ${sqlSchema}.article_events(id,workspace_id,source_id,actor_id,action,approval_id,operation_key,request_hash,result,changes)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[randomUUID(),workspaceId,sourceId,currentAccess()!.userId,action,approvalId || null,key,requestHash,JSON.stringify({publications}),JSON.stringify(changes)]);
}
export async function publishArticle(workspaceId:string,id:string,version:number,approvalId:string):Promise<ArticlePublication[]> {
  return withTransaction(async client=>{
    const entity=await lockSource(client,workspaceId,id,true);
    const key=`publish:${approvalId}`,requestHash=hash({id,version,approvalId});
    const receipt=await priorReceipt(client,workspaceId,key,requestHash);if(receipt) return receipt;
    assertVersion(entity,version);
    if(entity.deletedAt || entity.data.type!=='document') throw httpError(409,'Restore this document before publishing.','ARTICLE_SOURCE_UNAVAILABLE');
    const {rows:[approved]}=await client.query(`SELECT * FROM ${sqlSchema}.article_approvals WHERE id=$1 AND workspace_id=$2 AND source_id=$3`,[z.uuid().parse(approvalId),workspaceId,id]);
    if(!approved || approved.source_version!==version) throw httpError(409,'Review and approve the current document before publishing.','ARTICLE_APPROVAL_REQUIRED');
    const snapshot=createArticleSnapshot(entity);
    if(hash(snapshot)!==approved.snapshot_hash) throw httpError(409,'The article changed after approval. Review it again before publishing.','ARTICLE_APPROVAL_STALE');
    await authorizedSites(client,workspaceId,snapshot.siteIds);await lockDestinations(client,snapshot.siteIds);
    const current=await sourcePublications(client,workspaceId,id);
    for(const siteId of snapshot.siteIds) if((current.find(row=>row.site_id===siteId)?.revision || 0)!==approved.expected_revisions[siteId]) throw httpError(409,'A website publication changed after approval. Review the current state again.','ARTICLE_REVISION_CONFLICT');
    await checkPaths(client,workspaceId,id,snapshot,current);
    const changes:unknown[]=[];
    for(const siteId of snapshot.siteIds) {
      if(snapshot.featured) {
        const {rows:featured}=await client.query(`SELECT * FROM ${sqlSchema}.article_snapshots WHERE site_id=$1 AND locale=$2 AND status='published' AND featured AND source_id<>$3`,[siteId,snapshot.locale,id]);
        for(const before of featured) {
          const {rows:[after]}=await client.query(`UPDATE ${sqlSchema}.article_snapshots SET featured=false,revision=revision+1,updated_at=now() WHERE site_id=$1 AND source_id=$2 RETURNING *`,[siteId,before.source_id]);
          changes.push({reason:'featured-replaced',before,after});
        }
      }
      const {rows:[after]}=await client.query(`INSERT INTO ${sqlSchema}.article_snapshots AS a
        (site_id,workspace_id,source_id,locale,slug,title,excerpt,content,category,tags,featured,cover_image,date,reading_time,status,revision,source_version,snapshot_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'published',1,$15,$16)
        ON CONFLICT(site_id,source_id) DO UPDATE SET locale=EXCLUDED.locale,slug=EXCLUDED.slug,title=EXCLUDED.title,excerpt=EXCLUDED.excerpt,
          content=EXCLUDED.content,category=EXCLUDED.category,tags=EXCLUDED.tags,featured=EXCLUDED.featured,cover_image=EXCLUDED.cover_image,
          date=EXCLUDED.date,reading_time=EXCLUDED.reading_time,status='published',revision=a.revision+1,source_version=EXCLUDED.source_version,
          snapshot_hash=EXCLUDED.snapshot_hash,updated_at=now() RETURNING *`,[siteId,workspaceId,id,snapshot.locale,snapshot.slug,snapshot.title,snapshot.excerpt,
        snapshot.content,snapshot.category,snapshot.tags,snapshot.featured,snapshot.coverImage || null,snapshot.date,readingTime(snapshot),version,approved.snapshot_hash]);
      changes.push({reason:'publish',before:current.find(row=>row.site_id===siteId) || null,after});
    }
    const publications=(await sourcePublications(client,workspaceId,id)).map(mapPublication);
    await recordEvent(client,workspaceId,id,'publish',key,requestHash,publications,changes,approvalId);
    return publications;
  });
}
export async function unpublishArticle(workspaceId:string,id:string,input:ArticleUnpublishRequest):Promise<ArticlePublication[]> {
  const parsed=unpublishSchema.parse(input);
  return withTransaction(async client=>{
    const entity=await lockSource(client,workspaceId,id,true);
    const requestHash=hash({id,version:parsed.version,siteIds:parsed.siteIds,expectedRevisions:parsed.expectedRevisions || null});
    // Legacy clients without operationId get safe retries for this exact source version and selection.
    const key=`unpublish:${parsed.operationId || requestHash}`;
    const receipt=await priorReceipt(client,workspaceId,key,requestHash);if(receipt) return receipt;
    assertVersion(entity,parsed.version);await authorizedSites(client,workspaceId,parsed.siteIds);await lockDestinations(client,parsed.siteIds);
    const current=await sourcePublications(client,workspaceId,id),changes:unknown[]=[];
    for(const siteId of parsed.siteIds) {
      const before=current.find(row=>row.site_id===siteId);
      if(!before) throw httpError(404,`This document has no publication on ${siteId}.`,'ARTICLE_PUBLICATION_NOT_FOUND');
      if(parsed.expectedRevisions && parsed.expectedRevisions[siteId]!==before.revision) throw httpError(409,'The selected website publication changed. Review it again before unpublishing.','ARTICLE_REVISION_CONFLICT');
      if(before.status==='published') {
        const {rows:[after]}=await client.query(`UPDATE ${sqlSchema}.article_snapshots SET status='unpublished',featured=false,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND source_id=$2 AND site_id=$3 RETURNING *`,[workspaceId,id,siteId]);
        changes.push({reason:'unpublish',before,after});
      }
    }
    const publications=(await sourcePublications(client,workspaceId,id)).map(mapPublication);
    await recordEvent(client,workspaceId,id,'unpublish',key,requestHash,publications,changes);
    return publications;
  });
}

export const articlesRouter=Router();
articlesRouter.get('/articles',requireAuth,requireScope('workspace:read'),async(req,res)=>res.set('Cache-Control','no-store').json({articles:await listArticles(req.auth!.workspaceId)}));
articlesRouter.get('/articles/sites',requireAuth,requireScope('workspace:read'),async(req,res)=>res.set('Cache-Control','no-store').json({sites:await listArticleSites(req.auth!.workspaceId)}));
articlesRouter.post('/articles/:id/approve',requireAuth,requireEditor,requireScope('publish:write'),async(req,res)=>{
  const {version}=approveSchema.parse(req.body);res.json({approval:await approveArticle(req.auth!.workspaceId,z.uuid().parse(req.params.id),version)});
});
articlesRouter.post('/articles/:id/publish',requireAuth,requireEditor,requireScope('publish:write'),async(req,res)=>{
  const {version,approvalId}=publishSchema.parse(req.body);res.json({publications:await publishArticle(req.auth!.workspaceId,z.uuid().parse(req.params.id),version,approvalId)});
});
articlesRouter.post('/articles/:id/unpublish',requireAuth,requireEditor,requireScope('publish:write'),async(req,res)=>{
  res.json({publications:await unpublishArticle(req.auth!.workspaceId,z.uuid().parse(req.params.id),unpublishSchema.parse(req.body))});
});
