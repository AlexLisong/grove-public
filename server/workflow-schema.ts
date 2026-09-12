import {z} from 'zod';
import {httpError} from './core/security.js';

const short=z.string().min(1).max(1500), prose=z.string().min(1).max(12000);
const refs=z.array(z.string().min(1).max(100)).max(20);
const strings=z.array(short).max(20);
const common={summary:prose,gaps:z.array(short).max(40)};
const draft=z.object({title:z.string().min(1).max(300),content:prose,platform:z.enum(['X','LinkedIn','Threads','Instagram','Facebook','YouTube','TikTok','Substack','Newsletter']),rationale:short,evidenceIds:refs,experiment:z.boolean(),suggestedDay:z.string().max(100)}).strict();
export const workflowSchemas={
 'weekly-strategist':z.object({...common,ownedPerformance:z.object({summary:short,evidenceIds:refs}).strict(),patterns:z.array(z.object({pattern:short,evidenceIds:refs.min(2)}).strict()).max(3),plays:z.array(z.object({hook:short,action:short,evidenceIds:refs}).strict()).length(3),bet:z.object({hypothesis:short,metric:short,target:short,reviewDate:short,evidenceIds:refs}).strict(),previousBet:z.object({status:z.enum(['ungraded','supported','missed','mixed']),reason:short,evidenceIds:refs}).strict()}).strict(),
 'head-of-content':z.object({...common,slate:z.array(draft).max(7),changeLog:strings}).strict(),
 'content-command-center':z.object({...common,stations:z.array(z.object({station:z.enum(['Analyst','Scout','Strategist','Planner','Repurposer']),brief:prose,evidenceIds:refs,actions:strings}).strict()).length(5),digest:prose,repurpose:z.object({sourceEvidenceId:z.string().max(100).nullable(),content:z.string().max(12000)}).strict()}).strict(),
 'personal-brand-strategist':z.object({...common,positioning:prose,audienceNeeds:strings,originStory:prose,topicTree:z.array(z.object({topic:short,angles:strings}).strict()).max(12),contentDirections:strings,monetizationOptions:strings,referenceEvidenceIds:refs.max(16),interviewQuestions:strings,firstPosts:z.array(draft).max(5)}).strict(),
 'idea-engine':z.object({...common,ideas:z.array(z.object({hook:z.string().min(1).max(300),angle:short,audienceValue:short,format:short,legs:z.array(z.object({kind:z.enum(['knowledge','market','format']),evidenceId:z.string().min(1).max(100)}).strict()).min(2).max(3),firstStep:short}).strict()).max(8),strongestIndex:z.number().int().min(0).max(7).nullable()}).strict(),
 'deep-research':z.object({...common,findings:z.array(z.object({claim:prose,evidenceIds:refs.min(1)}).strict()).max(12),disagreements:z.array(z.object({description:short,evidenceIds:refs.min(2)}).strict()).max(8),nextSteps:strings}).strict(),
} as const;
export type WorkflowName=keyof typeof workflowSchemas;
export interface Evidence {
 id:string;kind:'knowledge'|'market'|'metric'|'prior'|'draft'|'format';title:string;excerpt:string;
 entityId?:string;url?:string;creator?:string;platform?:string;metrics?:Record<string,number|null>;
 provenance:string;capturedAt:string;publishedAt?:string;connectionId?:string;
}

export function evidenceReferences(value:unknown):string[]{
 const ids=new Set<string>();
 const visit=(node:any)=>{if(!node||typeof node!=='object')return;if(Array.isArray(node)){node.forEach(visit);return;}
  for(const [key,item] of Object.entries(node)){if((key==='evidenceIds'||key==='referenceEvidenceIds')&&Array.isArray(item))item.forEach(id=>{if(typeof id==='string')ids.add(id);});else if((key==='evidenceId'||key==='sourceEvidenceId')&&typeof item==='string')ids.add(item);else visit(item);}};
 visit(value);return [...ids];
}
export const normalizedHook=(text:string)=>text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
export function validateWorkflowOutput(name:WorkflowName,value:unknown,evidence:Evidence[],priorHooks:string[]=[]):any{
 const parsed=workflowSchemas[name].safeParse(value);
 if(!parsed.success)throw httpError(502,'The workflow returned an invalid structured result. No output artifacts were saved.','WORKFLOW_OUTPUT_INVALID');
 const output:any=parsed.data,byId=new Map(evidence.map(e=>[e.id,e]));
 const invalid=(message:string):never=>{throw httpError(502,message,'WORKFLOW_OUTPUT_INVALID');};
 for(const id of evidenceReferences(output))if(!byId.has(id))invalid('The workflow cited unavailable evidence. No output artifacts were saved.');
 if(name==='weekly-strategist'){
  for(const pattern of output.patterns){const creators=new Set(pattern.evidenceIds.map((id:string)=>byId.get(id)).filter((e:Evidence|undefined)=>e?.kind==='market'&&e.creator).map((e:Evidence)=>e.creator!.trim().toLowerCase()));if(creators.size<2)invalid('A market pattern needs evidence from at least two distinct creators.');}
  if(output.ownedPerformance.evidenceIds.some((id:string)=>byId.get(id)?.kind!=='metric'))invalid('Owned performance can cite only owned metric records.');
  if(output.previousBet.status!=='ungraded'&&(!output.previousBet.evidenceIds.some((id:string)=>byId.get(id)?.kind==='metric')||!output.previousBet.evidenceIds.some((id:string)=>byId.get(id)?.kind==='prior')))invalid('A graded previous bet needs both its prior memo and actual owned results.');
 }
 if(name==='head-of-content'&&output.slate.filter((d:any)=>d.experiment).length>1)invalid('A weekly slate supports at most one experiment.');
 if(name==='content-command-center'){
  if(new Set(output.stations.map((s:any)=>s.station)).size!==5)invalid('The command center must include each of its five stations once.');
  const analyst=output.stations.find((s:any)=>s.station==='Analyst');if(analyst.evidenceIds.some((id:string)=>byId.get(id)?.kind!=='metric'))invalid('The Analyst station can cite only owned metrics.');
  if(output.repurpose.content&&!output.repurpose.sourceEvidenceId)invalid('Repurposed text requires a supplied source.');
 }
 if(name==='personal-brand-strategist'&&output.referenceEvidenceIds.some((id:string)=>byId.get(id)?.kind!=='market'))invalid('Brand reference posts must be actual market evidence.');
 for(const item of output.slate||output.firstPosts||[]){if(!item.evidenceIds.length)invalid('Every proposed post needs supplied evidence.');}
 if(name==='idea-engine'){
  const known=new Set(priorHooks.map(normalizedHook)),retained=[];
  for(const idea of output.ideas){
   if(new Set(idea.legs.map((leg:any)=>leg.kind)).size<2||new Set(idea.legs.map((leg:any)=>leg.evidenceId)).size<2)invalid('Every idea needs two distinct evidence legs and sources.');
   for(const leg of idea.legs)if(byId.get(leg.evidenceId)?.kind!==leg.kind)invalid('An idea evidence leg does not match the supplied source category.');
   const hook=normalizedHook(idea.hook);if(known.has(hook)){output.gaps.push('A repeated idea hook was omitted because it already exists in recent ideas or drafts.');continue;}known.add(hook);retained.push(idea);
  }
  const selected=output.strongestIndex===null?null:output.ideas[output.strongestIndex];
  if(output.strongestIndex!==null&&!selected)invalid('The strongest idea index is outside the returned cards.');
  output.ideas=retained;output.strongestIndex=selected&&retained.includes(selected)?retained.indexOf(selected):retained.length?0:null;
 }
 if(!evidence.length&&!output.gaps.length)invalid('An empty evidence set must be disclosed in the result.');
 output.gaps=[...new Set(output.gaps)].slice(0,30);
 return output;
}
