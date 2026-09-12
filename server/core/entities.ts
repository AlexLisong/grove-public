import {Router,type Request} from 'express';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {ENTITY_KINDS, type Entity, type EntityInput} from '../../shared/types.js';
import {query, withTransaction} from './db.js';
import {requireAuth, requireEditor, requireScope,assertScope} from './auth.js';
import {hashToken, httpError, randomToken} from './security.js';
import {assertEntityAccess,currentAccess,effectiveEntityPermission,entityAccessPredicate,filterReadableEntities,runWithoutAccess} from './access.js';
import {validateTableData,tableReferenceIds,stripTableRelations} from '../../shared/table.js';
import {detachDocumentReferences,detachMarkdownReferences} from '../../shared/document-references.js';

const uuid = z.uuid();
const dataSchema = z.record(z.string(),z.unknown()).refine(value => Buffer.byteLength(JSON.stringify(value)) <= 1_000_000, 'Entity data exceeds 1 MB.');
const fields = {
  title: z.string().max(500), content: z.string().max(1_000_000), data: dataSchema,
  tags: z.array(z.string().trim().min(1).max(80)).max(100).transform(v => [...new Set(v)]),
  starred: z.boolean(), archived:z.boolean(), parentId:uuid.nullable(),
  visibility:z.enum(['workspace','private']),
};
export const entityInputSchema = z.object({kind:z.enum(ENTITY_KINDS),...Object.fromEntries(Object.entries(fields).map(([key,schema]) => [key,schema.optional()]))}).strict() as z.ZodType<EntityInput>;
export const entityPatchSchema = z.object({...fields,version:z.number().int().positive()}).partial().strict();
export type EntityPatch = Partial<Omit<EntityInput,'kind'>> & {version?:number};
export interface EntityFilters {kind?:string; q?:string; tag?:string; parentId?:string|null; starred?:boolean|string; archived?:boolean|string; trash?:boolean|string; limit?:number}

const iso = (value: any) => value instanceof Date ? value.toISOString() : value;
export function mapEntity(row: any): Entity {
  return {id:row.id,workspaceId:row.workspace_id,kind:row.kind,title:row.title,content:row.content,data:row.data || {},tags:row.tags || [],starred:row.starred,archived:row.archived,parentId:row.parent_id,version:row.version,deletedAt:iso(row.deleted_at),createdAt:iso(row.created_at),updatedAt:iso(row.updated_at),createdBy:row.created_by,visibility:row.visibility};
}

export async function listEntities(workspaceId: string, filters: EntityFilters = {}): Promise<Entity[]> {
  const params: any[] = [workspaceId], where = ['workspace_id=$1'];
  const add = (field: string,value: any,operator = '=') => {params.push(value);where.push(`${field}${operator}$${params.length}`);};
  if (filters.kind) add('kind',z.enum(ENTITY_KINDS).parse(filters.kind));
  if (filters.q) {
    const q = z.string().max(300).parse(filters.q).replace(/[\\%_]/g,'\\$&');
    params.push(`%${q}%`); where.push(`(title ILIKE $${params.length} OR content ILIKE $${params.length})`);
  }
  if (filters.tag) {params.push(z.string().max(80).parse(filters.tag));where.push(`$${params.length}=ANY(tags)`);}
  if (filters.parentId !== undefined) {
    if (filters.parentId === null || filters.parentId === 'null') where.push('parent_id IS NULL');
    else add('parent_id',uuid.parse(filters.parentId));
  }
  for (const field of ['starred','archived'] as const) if (filters[field] !== undefined) add(field, filters[field] === true || filters[field] === 'true');
  where.push(filters.trash === true || filters.trash === 'true' ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL');
  const access=entityAccessPredicate('e',params.length+1);where.push(access.sql);params.push(...access.params);
  params.push(Math.min(Math.max(filters.limit || 2000,1),2000));
  return (await query(`SELECT e.* FROM entities e WHERE ${where.join(' AND ')} ORDER BY updated_at DESC,id LIMIT $${params.length}`,params)).map(mapEntity);
}
export async function getEntity(workspaceId: string,id: string,includeDeleted = false): Promise<Entity|null> {
  if (!uuid.safeParse(id).success) return null;
  const access=entityAccessPredicate('e',3);
  const [row] = await query(`SELECT e.* FROM entities e WHERE workspace_id=$1 AND id=$2${includeDeleted ? '' : ' AND deleted_at IS NULL'} AND ${access.sql}`, [workspaceId,id,...access.params]);
  return row ? mapEntity(row) : null;
}

async function validateParent(client: PoolClient, workspaceId:string, parentId:string|null|undefined,id?:string,kind?:string) {
  if (!parentId) return;
  if (parentId === id) throw httpError(400,'An entity cannot contain itself.','PARENT_CYCLE');
  const {rows:[parent]} = await client.query('SELECT id,parent_id,kind FROM entities WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL', [workspaceId,parentId]);
  if (!parent) throw httpError(400,'The parent does not exist in this workspace.','INVALID_PARENT');
  await assertEntityAccess(workspaceId,parentId,'edit');
  if (!['board','space'].includes(parent.kind)) throw httpError(400,'Only boards and spaces can contain entities.','INVALID_PARENT');
  if (kind === 'space' && parent.kind === 'space') throw httpError(400,'Spaces support a single level.','SPACE_DEPTH');
  if (id) {
    const {rows} = await client.query(`WITH RECURSIVE ancestors AS (
      SELECT id,parent_id,ARRAY[id] AS path FROM entities WHERE workspace_id=$1 AND id=$2
      UNION ALL SELECT e.id,e.parent_id,a.path || e.id FROM entities e JOIN ancestors a ON a.parent_id=e.id
      WHERE e.workspace_id=$1 AND NOT e.id=ANY(a.path) AND cardinality(a.path)<100
    ) SELECT id FROM ancestors WHERE id=$3`, [workspaceId,parentId,id]);
    if (rows.length) throw httpError(400,'This move would create a circular hierarchy.','PARENT_CYCLE');
  }
}

async function validateReferences(client:PoolClient,workspaceId:string,kind:string,data:Record<string,any>,previous?:Record<string,any>) {
  const ids = new Set<string>(),retainedIds=new Set<string>();
  const collect = (values:unknown) => {
    if (!Array.isArray(values)) return;
    for (const value of values) if (typeof value === 'string' && uuid.safeParse(value).success) ids.add(value);
  };
  collect(data.sourceIds); collect(data.itemIds); collect(data.creatorIds); collect(data.mediaIds);
  if(data.entityLinks!==undefined){
    const links=z.array(z.uuid()).max(2000).parse(data.entityLinks),retained=new Set(Array.isArray(previous?.entityLinks)?previous.entityLinks:[]);
    // A revoked or deleted source remains an unavailable placeholder. Retaining
    // an existing link must not prevent otherwise authorized document edits.
    collect(links);for(const id of links)if(retained.has(id))retainedIds.add(id);
  }
  if(kind==='item' && data.type==='highlight' && data.anchor!==undefined){
    z.object({start:z.number().int().min(0).max(10000000),end:z.number().int().min(0).max(10000000),quote:z.string().min(1).max(100000),prefix:z.string().max(500),suffix:z.string().max(500),chapter:z.number().int().min(0).max(9999).optional()}).strict().refine(a=>a.end>=a.start,'Highlight end must follow its start.').parse(data.anchor);
  }
  if (kind === 'board' && Array.isArray(data.placements)) collect(data.placements.map((v:any) => v?.id));
  if (kind === 'table') {
    validateTableData(data,previous);
    const refs=tableReferenceIds(data),retained=new Set(previous?tableReferenceIds(previous):[]);
    // Revocation makes a linked item unavailable in the reader; it must not
    // prevent an authorized editor from changing unrelated table properties.
    collect(refs);for(const id of refs)if(retained.has(id))retainedIds.add(id);
  }
  if (kind === 'item') {if (data.sourceId && uuid.safeParse(data.sourceId).success) ids.add(data.sourceId); collect(data.connections);}
  if (ids.size > 2000) throw httpError(400,'An entity can reference at most 2,000 sources.');
  const requireAccess=[...ids].filter(id=>!retainedIds.has(id));
  if (requireAccess.length) {
    const access=entityAccessPredicate('e',3);
    const {rows} = await client.query(`SELECT e.id FROM entities e WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND deleted_at IS NULL AND ${access.sql}`, [workspaceId,requireAccess,...access.params]);
    if (rows.length !== requireAccess.length) throw httpError(400,'One or more references are outside this workspace or no longer available.','INVALID_REFERENCE');
  }
}
async function recordHistory(client:PoolClient,entity:Entity) {
  await client.query('INSERT INTO entity_history(entity_id,workspace_id,version,snapshot) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [entity.id,entity.workspaceId,entity.version,JSON.stringify(entity)]);
}
export async function createEntity(workspaceId: string,input: EntityInput): Promise<Entity> {
  const clean = entityInputSchema.parse(input);
  const actor=currentAccess();
  if(actor && actor.workspaceId!==workspaceId) throw httpError(403,'This actor belongs to a different workspace.');
  if(clean.visibility==='private' && !actor) throw httpError(403,'Private content requires an authenticated owner.','ACTOR_REQUIRED');
  return withTransaction(async client => {
    await validateParent(client,workspaceId,clean.parentId,undefined,clean.kind);
    await validateReferences(client,workspaceId,clean.kind,clean.data || {});
    const {rows:[row]} = await client.query('INSERT INTO entities(workspace_id,kind,title,content,data,tags,starred,archived,parent_id,visibility,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *', [workspaceId,clean.kind,clean.title || 'Untitled',clean.content || '',JSON.stringify(clean.data || {}),clean.tags || [],clean.starred || false,clean.archived || false,clean.parentId || null,clean.visibility || 'workspace',actor?.userId || null]);
    const entity = mapEntity(row); await recordHistory(client,entity); return entity;
  });
}
export async function updateEntity(workspaceId:string,id:string,patch:EntityPatch): Promise<Entity> {
  const clean = entityPatchSchema.parse(patch);
  await assertEntityAccess(workspaceId,id,'edit');
  if(clean.visibility!==undefined) await assertEntityAccess(workspaceId,id,'manage');
  return withTransaction(async client => {
    const {rows:[row]} = await client.query('SELECT * FROM entities WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE', [workspaceId,uuid.parse(id)]);
    if (!row) throw httpError(404,'Entity not found.','NOT_FOUND');
    const before = mapEntity(row);
    if (clean.version !== undefined && clean.version !== before.version) throw httpError(409,'This item changed in another session. Reload it before saving.','VERSION_CONFLICT');
    const next = {...before,...clean};
    await validateParent(client,workspaceId,next.parentId,id,next.kind);
    await validateReferences(client,workspaceId,next.kind,next.data,before.data);
    await recordHistory(client,before);
    const {rows:[updated]} = await client.query('UPDATE entities SET title=$1,content=$2,data=$3,tags=$4,starred=$5,archived=$6,parent_id=$7,visibility=$10,version=version+1,updated_at=now() WHERE workspace_id=$8 AND id=$9 RETURNING *', [next.title,next.content,JSON.stringify(next.data),next.tags,next.starred,next.archived,next.parentId,workspaceId,id,next.visibility || 'workspace']);
    const entity = mapEntity(updated); await recordHistory(client,entity); return entity;
  });
}
export async function deleteEntity(workspaceId:string,id:string): Promise<Entity> {
  await assertEntityAccess(workspaceId,id,'edit');
  return withTransaction(async client => {
    const {rows:[row]} = await client.query('SELECT * FROM entities WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE', [workspaceId,uuid.parse(id)]);
    if (!row) throw httpError(404,'Entity not found.','NOT_FOUND');
    await recordHistory(client,mapEntity(row));
    const {rows:[updated]} = await client.query('UPDATE entities SET deleted_at=now(),updated_at=now(),version=version+1 WHERE workspace_id=$1 AND id=$2 RETURNING *', [workspaceId,id]);
    await client.query('UPDATE shares SET enabled=false WHERE workspace_id=$1 AND entity_id=$2', [workspaceId,id]);
    const entity = mapEntity(updated); await recordHistory(client,entity); return entity;
  });
}
export async function restoreEntity(workspaceId:string,id:string): Promise<Entity> {
  await assertEntityAccess(workspaceId,id,'edit');
  return withTransaction(async client => {
    const {rows:[row]} = await client.query('SELECT * FROM entities WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [workspaceId,uuid.parse(id)]);
    if (!row) throw httpError(404,'Entity not found.','NOT_FOUND');
    const before = mapEntity(row);
    // Restoring deleted drafts never silently re-enables scheduled publishing.
    const data = before.kind === 'draft' ? {...before.data,status:'draft',scheduledAt:undefined,approvalId:undefined,approvedAt:undefined} : ['routine','automation'].includes(before.kind) ? {...before.data,enabled:false,deliveryEnabled:false}:before.data;
    const {rows:[restored]} = await client.query('UPDATE entities SET deleted_at=NULL,data=$3,updated_at=now(),version=version+1 WHERE workspace_id=$1 AND id=$2 RETURNING *', [workspaceId,id,JSON.stringify(data)]);
    const entity = mapEntity(restored); await recordHistory(client,entity); return entity;
  });
}

const serverOnlyKinds = new Set(['workflow-run','metric','notification']);
const draftProtected = ['status','receipts','publishedAt','publishedIds','publishJobId','scheduledAt','approvedAt','approvedBy','approvalId','deliveryUncertain','lastError','publishingAt','error'];
export function assertUserEditable(entity: Entity|null, input: EntityInput|EntityPatch) {
  const kind = entity?.kind || (input as EntityInput).kind;
  if (serverOnlyKinds.has(kind)) throw httpError(403,'This record is managed by a service and cannot be edited directly.','SERVER_MANAGED');
  if (kind === 'draft') {
    if (input.data) for (const field of draftProtected) {
      if (input.data[field] !== undefined && JSON.stringify(input.data[field]) !== JSON.stringify(entity?.data[field]) && !(field === 'status' && !entity && input.data.status === 'draft')) throw httpError(400,`Draft ${field} must be changed through the publishing workflow.`,'SERVER_MANAGED');
    }
    if (!entity) input.data = {...input.data,status:'draft'};
    else if (['publishing','published'].includes(entity.data.status) && (input.content !== undefined || input.data !== undefined || input.title !== undefined)) throw httpError(409,'Duplicate this published or publishing draft before editing.','DRAFT_LOCKED');
    else if ((input.content !== undefined && input.content !== entity.content) || (input.title !== undefined && input.title !== entity.title) || (input.data !== undefined && JSON.stringify(input.data) !== JSON.stringify(entity.data))) {
      input.data = {...entity.data,...input.data,status:'draft'};
      for (const key of ['scheduledAt','approvedAt','approvedBy','approvalId','publishJobId']) delete input.data[key];
    } else if (input.data) input.data = {...input.data,...Object.fromEntries(draftProtected.filter(key => entity.data[key] !== undefined).map(key => [key,entity.data[key]]))};
  }
}
export function assertAutomationPermissions(req:Request,entity:Entity|null,input:EntityInput|EntityPatch) {
  const kind=entity?.kind || (input as EntityInput).kind,data=input.data || entity?.data || {};
  // A routine executes later under its owner. Persist the initiating caller's
  // research authorization instead of accepting a forged marker from clients.
  if(kind==='routine' && input.data) input.data={...input.data,researchAuthorized:!req.auth.scopes || req.auth.scopes.includes('research:read')};
  if(kind==='routine' && (data.enabled || data.deliveryEnabled)) {
    if(req.auth.role==='viewer') throw httpError(403,'Workspace editor access is required to activate routines.');
    assertScope(req,'ai:run');if(data.deliveryEnabled) assertScope(req,'publish:write');
  }
  if(kind==='automation' && data.enabled) {
    if(req.auth.role==='viewer') throw httpError(403,'Workspace editor access is required to activate automations.');
    assertScope(req,'publish:write');
  }
}

function copyData(entity: Entity, mapping: Map<string,string> = new Map(), publicCopy = false) {
  const data = structuredClone(entity.data);
  if(['routine','automation'].includes(entity.kind)) {data.enabled=false;data.deliveryEnabled=false;delete data.nextRunAt;delete data.lastRunId;delete data.lastJobId;}
  if (entity.kind === 'draft') {
    for (const key of draftProtected) delete data[key];
    data.status = 'draft';
    if (publicCopy) {delete data.connectionIds;delete data.mediaIds;}
  }
  if (entity.kind === 'custom-ai' && publicCopy) {data.sourceIds=[];data.knowledgeSlots=['Connect your own sources'];}
  if (entity.kind === 'table' && publicCopy) {Object.assign(data,stripTableRelations(data));delete data.removedRows;}
  if (entity.kind === 'board') {
    if (Array.isArray(data.placements)) data.placements = data.placements.filter((p:any) => mapping.has(p.id) || !publicCopy).map((p:any) => ({...p,id:mapping.get(p.id) || p.id}));
    if (Array.isArray(data.itemIds)) data.itemIds = data.itemIds.filter((id:string) => mapping.has(id) || !publicCopy).map((id:string) => mapping.get(id) || id);
  }
  if (publicCopy) {
    delete data.sourceIds;delete data.sourceId;delete data.connections;delete data.connectionIds;delete data.creatorIds;delete data.mediaIds;delete data.spaceId;delete data.entityLinks;
    if(data.editorJSON)data.editorJSON=detachDocumentReferences(data.editorJSON);
    delete data.html;
  }
  return data;
}
async function cloneEntity(workspaceId:string,entity:Entity,data?:Record<string,any>,parentId:string|null = null,publicCopy=false) {
  const content=publicCopy?detachMarkdownReferences(entity.content):entity.content;
  const copy = await createEntity(workspaceId,{kind:entity.kind,title:`${entity.title} (copy)`,content,data:data || copyData(entity),tags:entity.tags,parentId,visibility:entity.visibility==='private' ? 'private':'workspace'});
  await query('INSERT INTO files(id,workspace_id,storage_key,original_name,mime,size,backend) SELECT $1,$2,storage_key,original_name,mime,size,backend FROM files WHERE id=$3 AND workspace_id=$4 ON CONFLICT DO NOTHING', [copy.id,workspaceId,entity.id,entity.workspaceId]);
  return copy;
}

const publicKinds = new Set(['item','board','table','creator','creator-list','brand','custom-ai','draft','voice','feed']);
export async function publicShare(token:string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw httpError(404,'Shared item not found.');
  const [share] = await query('SELECT * FROM shares WHERE token_hash=$1 AND enabled=true', [hashToken(token)]);
  if (!share) throw httpError(404,'This share is unavailable or has been revoked.');
  const [root]=await query('SELECT * FROM entities WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL',[share.workspace_id,share.entity_id]);
  const entity=root ? mapEntity(root):null;
  if (!entity || !publicKinds.has(entity.kind)) throw httpError(404,'Shared item not found.');
  const ids = entity.kind === 'board' ? [...new Set<string>([...(Array.isArray(entity.data.itemIds) ? entity.data.itemIds : []),...(Array.isArray(entity.data.placements) ? entity.data.placements.map((v:any) => v?.id) : [])].filter(v => typeof v === 'string' && uuid.safeParse(v).success))].slice(0,2000) : [];
  const candidates = ids.length ? (await query('SELECT * FROM entities WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND deleted_at IS NULL', [share.workspace_id,ids])).map(mapEntity).filter(e => publicKinds.has(e.kind)) : [];
  const entities=await runWithoutAccess(()=>filterReadableEntities(candidates));
  if(entity.kind==='board') {
    const allowed=new Set(entities.map(e=>e.id));
    entity.data={...entity.data,placements:(entity.data.placements || []).filter((p:any)=>allowed.has(p.id)),itemIds:(entity.data.itemIds || []).filter((id:string)=>allowed.has(id))};
  }
  return {share,entity,entities};
}
function publicView(entity: Entity) {
  const data = copyData(entity,new Map(),true);
  // Preserve visible board placement IDs without exposing parent/workspace IDs.
  if (entity.kind === 'board') {data.placements=entity.data.placements || [];data.itemIds=entity.data.itemIds || [];}
  for (const key of ['storageKey','storage_key','filePath','credentials','accessToken','refreshToken','token','webhookSecret']) delete data[key];
  return {...entity,content:detachMarkdownReferences(entity.content),workspaceId:'',parentId:null,createdBy:undefined,data};
}

export const entityRouter = Router();
entityRouter.get('/public/:token', async (req,res) => {
  const {share,entity,entities} = await publicShare(String(req.params.token));
  res.set('Cache-Control','no-store').json({entity:publicView(entity),entities:entities.map(publicView),allowDuplicate:share.allow_duplicate});
});
entityRouter.post('/public/:token/duplicate', requireAuth, requireEditor, requireScope('workspace:write'), async (req,res) => {
  const {share,entity,entities} = await publicShare(String(req.params.token));
  if (!share.allow_duplicate) throw httpError(403,'The owner has disabled duplication.');
  const workspaceId = req.auth!.workspaceId, mapping = new Map<string,string>();
  const copies: Entity[] = [];
  for (const source of entities) {const copy = await cloneEntity(workspaceId,source,copyData(source,new Map(),true),null,true);mapping.set(source.id,copy.id);copies.push(copy);}
  const copy = await cloneEntity(workspaceId,entity,copyData(entity,mapping,true),null,true);
  res.status(201).json({entity:copy,entities:copies});
});
entityRouter.get('/entities', requireAuth, requireScope('workspace:read'), async (req,res) => {
  const filters = z.object({kind:z.string().optional(),q:z.string().max(300).optional(),tag:z.string().max(80).optional(),parentId:z.string().optional(),starred:z.enum(['true','false']).optional(),archived:z.enum(['true','false']).optional(),trash:z.enum(['true','false']).optional()}).strict().parse(req.query);
  res.json({entities:await listEntities(req.auth!.workspaceId,filters)});
});
entityRouter.post('/entities', requireAuth, requireEditor, requireScope('workspace:write'), async (req,res) => {
  const input = entityInputSchema.parse(req.body);assertUserEditable(null,input);assertAutomationPermissions(req,null,input);
  res.status(201).json({entity:await createEntity(req.auth!.workspaceId,input)});
});
entityRouter.get('/entities/:id', requireAuth, requireScope('workspace:read'), async (req,res) => {
  const entity = await getEntity(req.auth!.workspaceId,uuid.parse(req.params.id));
  if (!entity) throw httpError(404,'Entity not found.');res.json({entity});
});
entityRouter.patch('/entities/:id', requireAuth, requireScope('workspace:write'), async (req,res) => {
  const id = uuid.parse(req.params.id), input = entityPatchSchema.parse(req.body);
  const entity = await getEntity(req.auth!.workspaceId,id);
  if (!entity) throw httpError(404,'Entity not found.');assertUserEditable(entity,input);assertAutomationPermissions(req,entity,input);
  // Always compare the version read for domain guards, even if the client did
  // not supply one. Approval cannot race a content edit and remain approved.
  res.json({entity:await updateEntity(req.auth!.workspaceId,id,{...input,version:input.version || entity.version})});
});
entityRouter.delete('/entities/:id', requireAuth, requireScope('workspace:write'), async (req,res) => {
  const entity = await getEntity(req.auth!.workspaceId,uuid.parse(req.params.id));
  if (!entity) throw httpError(404,'Entity not found.');
  if (entity.kind === 'draft' && entity.data.status === 'publishing') throw httpError(409,'Wait for the current publishing attempt to finish.');
  res.json({entity:await deleteEntity(req.auth!.workspaceId,entity.id)});
});
entityRouter.post('/entities/:id/restore', requireAuth, requireScope('workspace:write'), async (req,res) => res.json({entity:await restoreEntity(req.auth!.workspaceId,uuid.parse(req.params.id))}));
entityRouter.get('/entities/:id/history', requireAuth, requireScope('workspace:read'), async (req,res) => {
  const id = uuid.parse(req.params.id);
  if (!await getEntity(req.auth!.workspaceId,id,true)) throw httpError(404,'Entity not found.');
  const history = await query('SELECT version,snapshot,created_at AS "createdAt" FROM entity_history WHERE workspace_id=$1 AND entity_id=$2 ORDER BY version DESC LIMIT 100', [req.auth!.workspaceId,id]);
  res.json({history});
});
entityRouter.post('/entities/:id/history/:version/restore', requireAuth, requireScope('workspace:write'), async (req,res) => {
  const id = uuid.parse(req.params.id), version = z.coerce.number().int().positive().parse(req.params.version);
  const current = await getEntity(req.auth!.workspaceId,id);if (!current) throw httpError(404,'Entity not found.');
  const [record] = await query('SELECT snapshot FROM entity_history WHERE workspace_id=$1 AND entity_id=$2 AND version=$3', [req.auth!.workspaceId,id,version]);
  if (!record) throw httpError(404,'Version not found.');
  const snapshot = record.snapshot as Entity;
  const input:EntityPatch = {title:snapshot.title,content:snapshot.content,data:copyData(snapshot),tags:snapshot.tags,starred:snapshot.starred,archived:snapshot.archived,parentId:snapshot.parentId};
  if (current.kind === 'draft') {input.data={...input.data,...Object.fromEntries(draftProtected.filter(k => current.data[k] !== undefined).map(k => [k,current.data[k]]))};}
  assertUserEditable(current,input);
  assertAutomationPermissions(req,current,input);
  res.json({entity:await updateEntity(req.auth!.workspaceId,id,{...input,version:current.version})});
});
entityRouter.post('/entities/:id/duplicate', requireAuth, requireEditor, requireScope('workspace:write'), async (req,res) => {
  const entity = await getEntity(req.auth!.workspaceId,uuid.parse(req.params.id));if (!entity) throw httpError(404,'Entity not found.');
  if (serverOnlyKinds.has(entity.kind)) throw httpError(400,'This service record cannot be duplicated.');
  res.status(201).json({entity:await cloneEntity(req.auth!.workspaceId,entity,undefined,entity.parentId)});
});
entityRouter.post('/entities/:id/share', requireAuth, requireEditor, requireScope('workspace:write'), async (req,res) => {
  const id = uuid.parse(req.params.id), input = z.object({enabled:z.boolean(),allowDuplicate:z.boolean().optional().default(false)}).strict().parse(req.body);
  const entity = await getEntity(req.auth!.workspaceId,id);if (!entity) throw httpError(404,'Entity not found.');
  if (!publicKinds.has(entity.kind)) throw httpError(400,'This type of entity cannot be publicly shared.');
  await assertEntityAccess(req.auth.workspaceId,id,'manage');
  const token = randomToken();
  const [share] = await query('INSERT INTO shares(workspace_id,entity_id,token_hash,token,enabled,allow_duplicate) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(entity_id) DO UPDATE SET enabled=EXCLUDED.enabled,allow_duplicate=EXCLUDED.allow_duplicate RETURNING token', [req.auth!.workspaceId,id,hashToken(token),token,input.enabled,input.allowDuplicate]);
  res.json({url:`${process.env.APP_URL || 'http://localhost:5173'}/share/${share.token}`,token:share.token,enabled:input.enabled});
});
entityRouter.get('/entities/:id/comments', requireAuth, requireScope('workspace:read'), async (req,res) => {
  const id = uuid.parse(req.params.id);if (!await getEntity(req.auth!.workspaceId,id)) throw httpError(404,'Entity not found.');
  const comments = await query('SELECT c.id,c.entity_id AS "entityId",c.user_id AS "userId",c.content,c.created_at AS "createdAt",c.parent_id AS "parentId",c.resolved,c.resolved_by AS "resolvedBy",c.resolved_at AS "resolvedAt",u.name AS "authorName" FROM comments c JOIN users u ON u.id=c.user_id WHERE c.workspace_id=$1 AND c.entity_id=$2 ORDER BY c.created_at LIMIT 1000', [req.auth!.workspaceId,id]);
  res.json({comments});
});
entityRouter.post('/entities/:id/comments', requireAuth, requireScope('workspace:write'), async (req,res) => {
  const id = uuid.parse(req.params.id), input = z.object({content:z.string().trim().min(1).max(10000),parentId:uuid.optional()}).strict().parse(req.body);
  if (!await getEntity(req.auth!.workspaceId,id)) throw httpError(404,'Entity not found.');
  await assertEntityAccess(req.auth.workspaceId,id,'comment');
  if(input.parentId) {
    const [parent]=await query('SELECT id FROM comments WHERE workspace_id=$1 AND entity_id=$2 AND id=$3 AND parent_id IS NULL',[req.auth.workspaceId,id,input.parentId]);
    if(!parent) throw httpError(400,'Reply to a root comment on this same item.');
  }
  const [comment] = await query('INSERT INTO comments(workspace_id,entity_id,user_id,content,parent_id) VALUES($1,$2,$3,$4,$5) RETURNING id,entity_id AS "entityId",user_id AS "userId",content,created_at AS "createdAt",parent_id AS "parentId",resolved', [req.auth!.workspaceId,id,req.auth!.userId,input.content,input.parentId || null]);
  res.status(201).json({comment});
});
entityRouter.delete('/comments/:id', requireAuth, requireScope('workspace:write'), async (req,res) => {
  const id = uuid.parse(req.params.id), [comment] = await query('SELECT user_id,entity_id FROM comments WHERE workspace_id=$1 AND id=$2', [req.auth!.workspaceId,id]);
  if (!comment) throw httpError(404,'Comment not found.');
  await assertEntityAccess(req.auth.workspaceId,comment.entity_id,'comment');
  if (comment.user_id !== req.auth!.userId && !['owner','admin'].includes(req.auth!.role)) throw httpError(403,'You can only delete your own comments.');
  await query('DELETE FROM comments WHERE workspace_id=$1 AND id=$2', [req.auth!.workspaceId,id]);res.json({ok:true});
});
entityRouter.patch('/comments/:id',requireAuth,requireScope('workspace:write'),async (req,res) => {
  const id=uuid.parse(req.params.id),input=z.object({resolved:z.boolean()}).strict().parse(req.body);
  const [comment]=await query('SELECT * FROM comments WHERE workspace_id=$1 AND id=$2',[req.auth.workspaceId,id]);
  if(!comment) throw httpError(404,'Comment not found.');
  await assertEntityAccess(req.auth.workspaceId,comment.entity_id,'comment');
  if(comment.user_id!==req.auth.userId) await assertEntityAccess(req.auth.workspaceId,comment.entity_id,'edit');
  if(comment.parent_id) throw httpError(400,'Resolve the root thread rather than an individual reply.');
  await query('UPDATE comments SET resolved=$1,resolved_by=$2,resolved_at=CASE WHEN $1 THEN now() ELSE NULL END WHERE workspace_id=$3 AND id=$4',[input.resolved,input.resolved ? req.auth.userId:null,req.auth.workspaceId,id]);
  res.json({ok:true,resolved:input.resolved});
});
entityRouter.get('/entities/:id/access',requireAuth,requireScope('workspace:read'),async (req,res) => {
  const id=uuid.parse(req.params.id),entity=await getEntity(req.auth.workspaceId,id);
  if(!entity) throw httpError(404,'Entity not found.');
  const permission=await effectiveEntityPermission(req.auth.workspaceId,id);
  const grants=permission==='manage' ? await query('SELECT a.user_id AS "userId",u.email,u.name,a.permission FROM entity_acl a JOIN users u ON u.id=a.user_id WHERE a.workspace_id=$1 AND a.entity_id=$2',[req.auth.workspaceId,id]):[];
  const invitations=permission==='manage' ? await query('SELECT id,email,permission,expires_at AS "expiresAt" FROM entity_invitations WHERE workspace_id=$1 AND entity_id=$2 AND accepted_at IS NULL AND expires_at>now()',[req.auth.workspaceId,id]):[];
  res.json({visibility:entity.visibility,createdBy:entity.createdBy,permission,grants,invitations});
});
entityRouter.patch('/entities/:id/access',requireAuth,requireScope('workspace:write'),async (req,res) => {
  const id=uuid.parse(req.params.id),input=z.object({visibility:z.enum(['workspace','private'])}).strict().parse(req.body);
  const row=await assertEntityAccess(req.auth.workspaceId,id,'manage');
  // Legacy service-created shared records can be claimed only by an explicit
  // administrator action; private reads never infer ownership from role.
  if(!row.created_by) await query('UPDATE entities SET created_by=$1 WHERE workspace_id=$2 AND id=$3 AND created_by IS NULL',[req.auth.userId,req.auth.workspaceId,id]);
  res.json({entity:await updateEntity(req.auth.workspaceId,id,{visibility:input.visibility})});
});
entityRouter.post('/entities/:id/invite',requireAuth,requireScope('workspace:write'),async (req,res) => {
  const id=uuid.parse(req.params.id),input=z.object({email:z.email().max(254).transform(v=>v.toLowerCase()),permission:z.enum(['view','comment','edit'])}).strict().parse(req.body);
  await assertEntityAccess(req.auth.workspaceId,id,'manage');
  const token=randomToken();
  await query('INSERT INTO entity_invitations(entity_id,workspace_id,email,permission,token_hash,invited_by,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval \'7 days\')',[id,req.auth.workspaceId,input.email,input.permission,hashToken(token),req.auth.userId]);
  res.status(201).json({token,url:`${process.env.APP_URL || 'http://localhost:5173'}/invite?token=${token}&entity=1`,expiresInDays:7});
});
entityRouter.delete('/entities/:id/access/:userId',requireAuth,requireScope('workspace:write'),async (req,res) => {
  const id=uuid.parse(req.params.id),userId=uuid.parse(req.params.userId);await assertEntityAccess(req.auth.workspaceId,id,'manage');
  await query('DELETE FROM entity_acl WHERE workspace_id=$1 AND entity_id=$2 AND user_id=$3',[req.auth.workspaceId,id,userId]);res.json({ok:true});
});
entityRouter.delete('/entities/:id/invitations/:invitationId',requireAuth,requireScope('workspace:write'),async (req,res) => {
  const id=uuid.parse(req.params.id);await assertEntityAccess(req.auth.workspaceId,id,'manage');
  await query('DELETE FROM entity_invitations WHERE workspace_id=$1 AND entity_id=$2 AND id=$3',[req.auth.workspaceId,id,uuid.parse(req.params.invitationId)]);res.json({ok:true});
});
