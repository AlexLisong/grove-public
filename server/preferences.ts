import {Router} from 'express';
import {z} from 'zod';
import {query,withTransaction} from './core/db.js';
import {requireAuth,requireScope} from './core/auth.js';
import {getEntity} from './core/entities.js';
import {assertEntityAccess,entityAccessPredicate} from './core/access.js';
import {httpError} from './core/security.js';

export async function migratePreferences(){
 await query(`CREATE TABLE IF NOT EXISTS user_preferences (
  workspace_id uuid NOT NULL, user_id uuid NOT NULL, data jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,user_id),
  FOREIGN KEY(workspace_id,user_id) REFERENCES memberships(workspace_id,user_id) ON DELETE CASCADE
 )`);
}
export const preferencesRouter=Router();
const guard=[requireAuth,requireScope('workspace:read')];
const defaults={pinnedIds:[] as string[],recentIds:[] as string[],topics:[] as string[],onboardingComplete:false,captureBoardId:null as string|null,library:{tab:'all',tag:'',view:'grid',platform:'',source:''}};
async function visible(workspaceId:string,data:any){
 const referenced=[...new Set([...(data.pinnedIds||[]),...(data.recentIds||[]),data.captureBoardId].filter(Boolean))];
 const predicate=entityAccessPredicate('e',3);
 const rows=referenced.length?await query(`SELECT e.id,e.kind FROM entities e WHERE e.workspace_id=$1 AND e.id=ANY($2::uuid[]) AND e.deleted_at IS NULL AND ${predicate.sql}`,[workspaceId,referenced,...predicate.params]):[];
 const ids=new Set(rows.map(e=>e.id));
 return {...defaults,...data,library:{...defaults.library,...data.library},pinnedIds:(data.pinnedIds||[]).filter((id:string)=>ids.has(id)),recentIds:(data.recentIds||[]).filter((id:string)=>ids.has(id)),captureBoardId:rows.some(e=>e.id===data.captureBoardId&&e.kind==='board')?data.captureBoardId:null};
}
async function mutate(workspaceId:string,userId:string,change:(data:any)=>any){
 return withTransaction(async client=>{
  await client.query('INSERT INTO user_preferences(workspace_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[workspaceId,userId]);
  const {rows:[row]}=await client.query('SELECT data FROM user_preferences WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE',[workspaceId,userId]);
  const data=change({...defaults,...row.data});
  await client.query('UPDATE user_preferences SET data=$3,updated_at=now() WHERE workspace_id=$1 AND user_id=$2',[workspaceId,userId,JSON.stringify(data)]);
  return data;
 });
}
preferencesRouter.get('/preferences',...guard,async(req,res)=>{
 const [row]=await query('SELECT data FROM user_preferences WHERE workspace_id=$1 AND user_id=$2',[req.auth.workspaceId,req.auth.userId]);
 res.json({preferences:await visible(req.auth.workspaceId,row?.data||{})});
});
preferencesRouter.patch('/preferences',...guard,requireScope('workspace:write'),async(req,res)=>{
 const body=z.object({topics:z.array(z.string().trim().min(1).max(60)).max(20).optional(),onboardingComplete:z.boolean().optional(),captureBoardId:z.uuid().nullable().optional(),library:z.object({tab:z.enum(['all','documents','highlights','reading','favorites','media']),tag:z.string().max(100),view:z.enum(['grid','list','graph']),platform:z.string().max(100),source:z.string().max(300)}).partial().strict().optional()}).strict().parse(req.body);
 if(body.captureBoardId){const board=await getEntity(req.auth.workspaceId,body.captureBoardId);if(!board||board.kind!=='board')throw httpError(404,'Capture board not found');await assertEntityAccess(req.auth.workspaceId,board.id,'edit');}
 const data=await mutate(req.auth.workspaceId,req.auth.userId,data=>({...data,...body,library:{...defaults.library,...data.library,...body.library},...(body.topics?{topics:[...new Set(body.topics)]}:{})}));
 res.json({preferences:await visible(req.auth.workspaceId,data)});
});
preferencesRouter.post('/preferences/items/:id',...guard,requireScope('workspace:write'),async(req,res)=>{
 const id=z.uuid().parse(req.params.id),body=z.object({action:z.enum(['pin','unpin','open'])}).strict().parse(req.body);
 const entity=await getEntity(req.auth.workspaceId,id);if(!entity)throw httpError(404,'Item not found');
 const data=await mutate(req.auth.workspaceId,req.auth.userId,data=>{
  const field=body.action==='open'?'recentIds':'pinnedIds';
  data[field]=(data[field]||[]).filter((value:string)=>value!==id);
  if(body.action!=='unpin')data[field]=[id,...data[field]].slice(0,body.action==='open'?30:200);
  return data;
 });
 res.json({preferences:await visible(req.auth.workspaceId,data)});
});
