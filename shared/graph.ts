import type {Entity} from './types';
export type GraphKind='item'|'board'|'creator'|'book'|'tag'|'mention';
export interface GraphNode {id:string;label:string;kind:GraphKind;entityId?:string;sourceIds:string[];x:number;y:number;degree:number}
export interface GraphEdge {source:string;target:string;kind:string}
const strings=(value:unknown)=>Array.isArray(value)?value.filter((s):s is string=>typeof s==='string'):[];
const canonical=(s:string)=>s.trim().replace(/\s+/g,' ').toLowerCase();
// Mention hubs are exact repeated phrases, not a claim of semantic entity
// recognition. No private source text is sent to a provider to draw this map.
export function buildKnowledgeGraph(items:Entity[],context:Entity[],kinds:Set<GraphKind>){
 const nodes=new Map<string,GraphNode>(),edges:GraphEdge[]=[],seen=new Set<string>(),selected=items.slice(0,120),ids=new Set(selected.map(e=>e.id));
 const add=(id:string,label:string,kind:GraphKind,entityId?:string)=>{if(!nodes.has(id)&&nodes.size<220)nodes.set(id,{id,label:label.slice(0,160),kind,entityId,sourceIds:[],x:0,y:0,degree:0});return nodes.get(id);};
 const link=(source:string,target:string,kind:string)=>{if(source===target||!nodes.has(source)||!nodes.has(target))return;const key=[source,target].sort().join('|')+'|'+kind;if(seen.has(key))return;seen.add(key);edges.push({source,target,kind});nodes.get(source)!.degree++;nodes.get(target)!.degree++;};
 const hub=(kind:GraphKind,label:string,sourceId:string,entityId?:string)=>{if(!kinds.has(kind)||!label.trim())return;const id=`${kind}:${entityId?entityId:canonical(label)}`,node=add(id,label,kind,entityId);if(!node)return;if(!node.sourceIds.includes(sourceId))node.sourceIds.push(sourceId);link(sourceId,id,kind);};
 for(const item of selected)add(item.id,item.title,'item',item.id);
 const phrases=new Map<string,{label:string;sources:Set<string>}>();
 for(const item of selected){
  for(const id of [...strings(item.data.connections),...strings(item.data.entityLinks),...strings(item.data.sourceIds),item.data.sourceId].filter((v):v is string=>typeof v==='string'))if(ids.has(id))link(item.id,id,'reference');
  for(const tag of item.tags)hub('tag',tag,item.id);
  const creator=context.find(e=>e.kind==='creator'&&(e.id===item.data.creatorId||e.id===item.data.creator));
  const label=creator?.title||item.data.creatorName||item.data.creator;
  if(typeof label==='string')hub('creator',label,item.id,creator?.id);
  if(typeof item.data.bookTitle==='string')hub('book',item.data.bookTitle,item.id,item.id);
  if(typeof item.data.bookAuthor==='string')hub('creator',item.data.bookAuthor,item.id);
  if(kinds.has('mention'))for(const match of item.content.slice(0,16000).matchAll(/\b[A-Z][\p{L}'’-]+(?:\s+[A-Z][\p{L}'’-]+){1,3}\b/gu)){
   const label=match[0],key=canonical(label);if(!phrases.has(key))phrases.set(key,{label,sources:new Set()});phrases.get(key)!.sources.add(item.id);
  }
 }
 for(const board of context.filter(e=>e.kind==='board')){
  const contained=new Set([...strings(board.data.itemIds),...(Array.isArray(board.data.placements)?board.data.placements.map((p:any)=>p?.id):[]),...selected.filter(e=>e.parentId===board.id).map(e=>e.id)]);
  for(const id of contained)if(ids.has(id))hub('board',board.title,id,board.id);
 }
 for(const phrase of [...phrases.values()].filter(p=>p.sources.size>1).sort((a,b)=>b.sources.size-a.sources.size).slice(0,30))for(const id of phrase.sources)hub('mention',phrase.label,id);
 const list=[...nodes.values()];list.forEach((node,i)=>{const radius=node.kind==='item'?150+Math.sqrt(i)*24:90+Math.sqrt(i)*12;node.x=600+Math.cos(i*2.39996)*radius;node.y=360+Math.sin(i*2.39996)*radius*.75;});
 // Bounded deterministic force layout. The network changes automatically when
 // items/references change, without random movement every React render.
 for(let step=0;step<90;step++){
  for(let i=0;i<list.length;i++)for(let j=i+1;j<list.length;j++){const a=list[i],b=list[j],dx=a.x-b.x,dy=a.y-b.y,d=Math.max(25,dx*dx+dy*dy),force=Math.min(2.5,1200/d);a.x+=dx*force*.04;a.y+=dy*force*.04;b.x-=dx*force*.04;b.y-=dy*force*.04;}
  for(const edge of edges){const a=nodes.get(edge.source)!,b=nodes.get(edge.target)!,dx=b.x-a.x,dy=b.y-a.y,d=Math.hypot(dx,dy)||1,force=(d-115)*.018;a.x+=dx/d*force;a.y+=dy/d*force;b.x-=dx/d*force;b.y-=dy/d*force;}
  for(const node of list){node.x+=(600-node.x)*.002;node.y+=(360-node.y)*.002;}
 }
 return {nodes:list,edges,shownItems:selected.length,totalItems:items.length};
}
