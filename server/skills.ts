import {Router} from 'express';
import multer from 'multer';
import {z} from 'zod';
import {createHash} from 'node:crypto';
import {readZipArchive} from './core/archives.js';
import {requireAuth,requireEditor,requireScope} from './core/auth.js';
import {getEntity,listEntities,createEntity,updateEntity} from './core/entities.js';
import {query} from './core/db.js';
import {httpError} from './core/security.js';
import {builtInSkills} from './catalog.js';

export async function migrateSkills(){await query('CREATE TABLE IF NOT EXISTS skill_bundles(entity_id uuid PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,workspace_id uuid NOT NULL REFERENCES workspaces(id),original bytea NOT NULL,name text NOT NULL,sha256 text NOT NULL)');}
export async function skillContext(workspaceId:string,requestedIds:string[],message:string){
 const items=await listEntities(workspaceId,{kind:'item'}),disabled=new Set(items.filter(e=>e.data.type==='skill-preferences').flatMap(e=>e.data.disabled||[]));
 const names=[...new Set([...requestedIds,...[...message.matchAll(/(?:^|\s)\/([\w-]+)/g)].map(m=>m[1])])];
 const active:any[]=[];
 for(const name of names.slice(0,10)){
  const built=builtInSkills.find(s=>s.id===name&&!disabled.has(s.id));if(built){active.push({id:built.id,title:built.title,instructions:built.prompt});continue;}
  const skill=items.find(e=>e.data.type==='skill'&&(e.id===name||e.title.toLowerCase().replaceAll(' ','-')===name)&&e.data.enabled!==false);if(!skill)continue;
  active.push({id:skill.id,title:skill.title,instructions:skill.content.slice(0,30000),references:skill.data.references||[]});
 }
 return {active,prompt:active.map(s=>`USER-SELECTED SKILL ${s.title}\n${s.instructions}\n${(s.references||[]).map((r:any)=>`REFERENCE ${r.path}\n${r.content}`).join('\n').slice(0,20000)}`).join('\n\n')};
}
export const skillsRouter=Router();
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:5*1024*1024,files:1,fields:4}});
skillsRouter.post('/skills/import',requireAuth,requireEditor,requireScope('workspace:write'),upload.single('file'),async(req,res)=>{
 if(!req.file)throw httpError(400,'Choose a markdown skill or ZIP bundle');const mode=z.enum(['keep-both','replace']).default('keep-both').parse(req.body.mode);
 const zip=req.file.originalname.toLowerCase().endsWith('.zip'),entries=zip?await readZipArchive(req.file.buffer):[{path:'SKILL.md',buffer:req.file.buffer}];
 const main=entries.find(e=>/(^|\/)SKILL\.md$/i.test(e.path));if(!main)throw httpError(400,'The bundle needs a SKILL.md file');if(main.buffer.length>150000)throw httpError(413,'The skill markdown exceeds 150 KB');
 const markdown=main.buffer.toString('utf8'),title=(markdown.match(/^name:\s*["']?([^\n"']+)/m)?.[1]||markdown.match(/^#\s+(.+)/m)?.[1]||req.file.originalname.replace(/\.(zip|md)$/i,'')).trim().slice(0,200);
 const references=entries.filter(e=>e!==main&&/\.(md|txt|json|csv)$/i.test(e.path)).slice(0,40).map(e=>({path:e.path,content:e.buffer.toString('utf8').slice(0,5000)}));
 const data={type:'skill',enabled:true,references,bundleFiles:entries.map(e=>({path:e.path,bytes:e.buffer.length})),scriptsExecuted:false};
 const existing=(await listEntities(req.auth.workspaceId,{kind:'item'})).find(e=>e.data.type==='skill'&&e.title===title);
 const entity=mode==='replace'&&existing?await updateEntity(req.auth.workspaceId,existing.id,{content:markdown,data}):await createEntity(req.auth.workspaceId,{kind:'item',title:existing?`${title} (copy)`:title,content:markdown,visibility:'private',data});
 await query('INSERT INTO skill_bundles(entity_id,workspace_id,original,name,sha256) VALUES($1,$2,$3,$4,$5) ON CONFLICT(entity_id) DO UPDATE SET original=$3,name=$4,sha256=$5',[entity.id,req.auth.workspaceId,req.file.buffer,req.file.originalname,createHash('sha256').update(req.file.buffer).digest('hex')]);
 res.status(201).json({entity,files:entries.length,notice:'References are stored as inert context. Scripts are never executed.'});
});
skillsRouter.get('/skills/:id/export',requireAuth,requireScope('workspace:read'),async(req,res)=>{
 const id=z.uuid().parse(req.params.id),entity=await getEntity(req.auth.workspaceId,id);if(!entity||entity.data.type!=='skill')throw httpError(404,'Skill not found');
 const [bundle]=await query<any>('SELECT original,name FROM skill_bundles WHERE entity_id=$1 AND workspace_id=$2',[id,req.auth.workspaceId]);
 const name=bundle?String(bundle.name).replace(/[^a-zA-Z0-9._-]/g,'_'):'SKILL.md';res.setHeader('Content-Disposition',`attachment; filename="${name}"`);res.type(name.endsWith('.zip')?'application/zip':'text/markdown').send(bundle?.original||entity.content);
});
