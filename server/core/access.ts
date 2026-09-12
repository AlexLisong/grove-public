import {AsyncLocalStorage} from 'node:async_hooks';
import type {Role} from '../../shared/types.js';
import {query} from './db.js';
import {httpError} from './security.js';

export interface AccessContext {userId:string;workspaceId:string;role:Role;scopes?:string[];itemOnly?:boolean}
export type EntityPermission='view'|'comment'|'edit'|'manage';
const actors=new AsyncLocalStorage<AccessContext>();
export const currentAccess=() => actors.getStore();
export function runWithAccess<T>(context:AccessContext,fn:()=>T):T {return actors.run(context,fn);}
export function runWithoutAccess<T>(fn:()=>T):T {return actors.exit(fn);}
export async function runAsActor<T>(workspaceId:string,userId:string|null|undefined,fn:()=>Promise<T>):Promise<T> {
  if(!userId) throw httpError(403,'This background task has no authorized actor. Create a new task from your account.','ACTOR_REQUIRED');
  const [member]=await query<{role:Role;item_only:boolean}>('SELECT role,item_only FROM memberships WHERE workspace_id=$1 AND user_id=$2',[workspaceId,userId]);
  if(!member) throw httpError(403,'The task owner no longer belongs to this workspace.','ACTOR_REVOKED');
  return runWithAccess({workspaceId,userId,role:member.role,itemOnly:member.item_only},fn);
}

// The same predicate is used for list, individual, history, file, and worker
// access. Raw entity queries outside core must use this helper or a core read.
export function entityAccessPredicate(alias:string,userParameter:number,permission:EntityPermission='view'): {sql:string;params:any[]} {
  const actor=currentAccess();
  const permitted=permission==='view' ? ['view','comment','edit'] : permission==='comment' ? ['comment','edit'] : permission==='edit' ? ['edit'] : [];
  const baseAllowed=!actor?.itemOnly && (permission==='view' || (permission!=='manage' && actor?.role!=='viewer') || (permission==='manage' && ['owner','admin'].includes(actor?.role || '')));
  const rowClause=(target:string) => !actor ? `${target}.visibility='workspace'` : `(
    ${target}.created_by=$${userParameter}::uuid
    OR (${target}.visibility='workspace' AND ${baseAllowed ? 'true':'false'})
    ${permitted.length ? `OR EXISTS(SELECT 1 FROM entity_acl acl WHERE acl.entity_id=${target}.id AND acl.workspace_id=${target}.workspace_id AND acl.user_id=$${userParameter}::uuid AND acl.permission IN (${permitted.map(v=>`'${v}'`).join(',')}))` : ''}
    ${permitted.length ? `OR EXISTS(
      WITH RECURSIVE inherited AS (
        SELECT p.id,p.parent_id,ARRAY[p.id] AS path FROM entities p WHERE p.id=${target}.parent_id AND p.workspace_id=${target}.workspace_id
        UNION ALL SELECT p.id,p.parent_id,i.path || p.id FROM entities p JOIN inherited i ON p.id=i.parent_id WHERE p.workspace_id=${target}.workspace_id AND NOT p.id=ANY(i.path) AND cardinality(i.path)<100
      ) SELECT 1 FROM inherited i JOIN entity_acl acl ON acl.entity_id=i.id WHERE acl.workspace_id=${target}.workspace_id AND acl.user_id=$${userParameter}::uuid AND acl.permission IN (${permitted.map(v=>`'${v}'`).join(',')})
    )` : ''}
  )`;
  const directGrant=actor && permitted.length ? `EXISTS(SELECT 1 FROM entity_acl direct_acl WHERE direct_acl.entity_id=${alias}.id AND direct_acl.workspace_id=${alias}.workspace_id AND direct_acl.user_id=$${userParameter}::uuid AND direct_acl.permission IN (${permitted.map(v=>`'${v}'`).join(',')}))` : 'false';
  const predicate=`${rowClause(alias)} AND (${directGrant} OR NOT EXISTS (
    WITH RECURSIVE ancestors AS (
      SELECT p.id,p.parent_id,p.workspace_id,p.visibility,p.created_by,ARRAY[p.id] AS path
      FROM entities p WHERE p.id=${alias}.parent_id AND p.workspace_id=${alias}.workspace_id
      UNION ALL
      SELECT p.id,p.parent_id,p.workspace_id,p.visibility,p.created_by,a.path || p.id
      FROM entities p JOIN ancestors a ON p.id=a.parent_id AND p.workspace_id=a.workspace_id
      WHERE NOT p.id=ANY(a.path) AND cardinality(a.path)<100
    ) SELECT 1 FROM ancestors ancestor WHERE NOT (${rowClause('ancestor')})
  ))`;
  return {sql:predicate,params:actor ? [actor.userId]:[]};
}
export async function assertEntityAccess(workspaceId:string,id:string,permission:EntityPermission='view') {
  const actor=currentAccess();
  if(actor && actor.workspaceId!==workspaceId) throw httpError(403,'This actor belongs to a different workspace.','WORKSPACE_ACCESS');
  const predicate=entityAccessPredicate('e',3,permission);
  const [row]=await query(`SELECT e.* FROM entities e WHERE e.workspace_id=$1 AND e.id=$2 AND ${predicate.sql}`,[workspaceId,id,...predicate.params]);
  if(!row) throw httpError(404,'Entity not found or this account does not have access.','NOT_FOUND');
  return row;
}
export async function filterReadableEntities<T extends {id:string;workspaceId?:string;workspace_id?:string}>(rows:T[]):Promise<T[]> {
  if(!rows.length) return rows;
  const workspaceId=rows[0].workspaceId || rows[0].workspace_id;
  const predicate=entityAccessPredicate('e',3,'view');
  const allowed=await query<{id:string}>(`SELECT e.id FROM entities e WHERE e.workspace_id=$1 AND e.id=ANY($2::uuid[]) AND ${predicate.sql}`,[workspaceId,rows.map(row=>row.id),...predicate.params]);
  const ids=new Set(allowed.map(row=>row.id));return rows.filter(row=>ids.has(row.id));
}
export async function effectiveEntityPermission(workspaceId:string,id:string):Promise<EntityPermission|null> {
  for(const permission of ['manage','edit','comment','view'] as const) {
    try {await assertEntityAccess(workspaceId,id,permission);return permission;} catch(error:any) {if(error.status!==404) throw error;}
  }
  return null;
}
export async function isExclusivePrivateTarget(workspaceId:string,id:string):Promise<boolean> {
  const actor=currentAccess();if(!actor || actor.workspaceId!==workspaceId)return false;
  const [target]=await query(`SELECT e.id FROM entities e WHERE e.workspace_id=$1 AND e.id=$2 AND e.created_by=$3 AND e.visibility='private' AND e.parent_id IS NULL
    AND NOT EXISTS(SELECT 1 FROM entity_acl a WHERE a.entity_id=e.id)
    AND NOT EXISTS(SELECT 1 FROM shares s WHERE s.entity_id=e.id AND s.enabled=true)`,[workspaceId,id,actor.userId]);
  return !!target;
}
