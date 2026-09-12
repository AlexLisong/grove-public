import {Router} from 'express';
import {z} from 'zod';
import {query} from './core/db.js';
import {requireAuth,requireScope} from './core/auth.js';
import {entityAccessPredicate} from './core/access.js';
import {getEntity,mapEntity} from './core/entities.js';
import {httpError} from './core/security.js';

export async function migrateReader(){
 await query(`CREATE TABLE IF NOT EXISTS reader_states (
  workspace_id uuid NOT NULL,user_id uuid NOT NULL,entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  data jsonb NOT NULL DEFAULT '{}',updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,user_id,entity_id),
  FOREIGN KEY(workspace_id,user_id) REFERENCES memberships(workspace_id,user_id) ON DELETE CASCADE
 )`);
}
export const readerRouter=Router();
const read=[requireAuth,requireScope('workspace:read')];
const defaults={progress:0,chapter:0,scrollTop:0,rate:1,voice:'',highlightColor:'yellow',notes:''};
const statePatch=z.object({progress:z.number().min(0).max(1),chapter:z.number().int().min(0).max(9999),scrollTop:z.number().min(0).max(10000000),rate:z.number().min(0.5).max(3),voice:z.string().max(300),highlightColor:z.enum(['yellow','green','blue','pink','purple']),notes:z.string().max(100000)}).partial().strict();
async function readable(workspaceId:string,id:string){
 const entity=await getEntity(workspaceId,z.uuid().parse(id));
 if(!entity)throw httpError(404,'The source is not available to this account.');
 return entity;
}
readerRouter.get('/reader/:id/state',...read,async(req,res)=>{
 const entity=await readable(req.auth.workspaceId,String(req.params.id));
 const [row]=await query('SELECT data FROM reader_states WHERE workspace_id=$1 AND user_id=$2 AND entity_id=$3',[req.auth.workspaceId,req.auth.userId,entity.id]);
 res.json({state:{...defaults,...row?.data}});
});
readerRouter.patch('/reader/:id/state',...read,requireScope('workspace:write'),async(req,res)=>{
 const entity=await readable(req.auth.workspaceId,String(req.params.id)),body=statePatch.parse(req.body);
 if(body.chapter!==undefined && Array.isArray(entity.data.chapters) && entity.data.chapters.length && body.chapter>=entity.data.chapters.length)throw httpError(400,'This chapter is outside the book.');
 const [row]=await query(`INSERT INTO reader_states(workspace_id,user_id,entity_id,data) VALUES($1,$2,$3,$4)
  ON CONFLICT(workspace_id,user_id,entity_id) DO UPDATE SET data=reader_states.data||EXCLUDED.data,updated_at=now() RETURNING data`,[req.auth.workspaceId,req.auth.userId,entity.id,JSON.stringify(body)]);
 res.json({state:{...defaults,...row.data}});
});
readerRouter.get('/entities/:id/backlinks',...read,async(req,res)=>{
 const entity=await readable(req.auth.workspaceId,String(req.params.id)),access=entityAccessPredicate('e',3);
 const rows=await query(`SELECT e.* FROM entities e WHERE e.workspace_id=$1 AND e.deleted_at IS NULL AND e.id<>$2::uuid
  AND (e.data->'connections' @> jsonb_build_array($2::text) OR e.data->'entityLinks' @> jsonb_build_array($2::text)
   OR e.data->>'sourceId'=$2::text OR e.parent_id=$2::uuid) AND ${access.sql}
  ORDER BY e.updated_at DESC,e.id LIMIT 200`,[req.auth.workspaceId,entity.id,...access.params]);
 res.json({entities:rows.map(mapEntity)});
});
