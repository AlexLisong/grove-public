import {useEffect,useMemo,useRef,useState} from 'react';
import {useNavigate} from 'react-router-dom';
import {Minus,Plus,Maximize2,Network,X,ArrowUpRight} from 'lucide-react';
import type {Entity} from '../../shared/types';
import {buildKnowledgeGraph,type GraphKind} from '../../shared/graph';
import {useWorkspace} from '../store';
import {Button,IconButton} from './ui';
import './knowledge-graph.css';
const kinds:{id:GraphKind;label:string}[]=[{id:'board',label:'Boards'},{id:'creator',label:'Creators'},{id:'book',label:'Books'},{id:'tag',label:'Tags'},{id:'mention',label:'Repeated names'}];
const color:Record<GraphKind,string>={item:'#abc79b',board:'#b6a9d6',creator:'#d6bb8c',book:'#81b8b0',tag:'#94a484',mention:'#c691ab'};
export function KnowledgeGraph({items}:{items:Entity[]}){
 const app=useWorkspace(),navigate=useNavigate(),svg=useRef<SVGSVGElement>(null),drag=useRef<{x:number;y:number;panX:number;panY:number}|null>(null);
 const [enabled,setEnabled]=useState<GraphKind[]>(['board','creator','book','tag']),[focus,setFocus]=useState(''),[view,setView]=useState({x:0,y:0,scale:1});
 const viewRef=useRef(view);viewRef.current=view;
 const pointer=(clientX:number,clientY:number)=>{const matrix=svg.current?.getScreenCTM();return matrix?new DOMPoint(clientX,clientY).matrixTransform(matrix.inverse()):{x:clientX,y:clientY};};
 const graph=useMemo(()=>buildKnowledgeGraph(items,app.entities,new Set(enabled)),[items,app.entities,enabled]);
 const byId=new Map(graph.nodes.map(n=>[n.id,n])),selected=byId.get(focus),neighbors=new Set([focus,...graph.edges.filter(e=>e.source===focus||e.target===focus).flatMap(e=>[e.source,e.target])]);
 function open(id:string){const entity=app.entities.find(e=>e.id===id);if(entity?.kind==='board')navigate(`/boards/${id}`);else app.openItem(id);}
 function zoom(factor:number){setView(v=>{const scale=Math.max(.35,Math.min(3,v.scale*factor));return {scale,x:600-(600-v.x)*scale/v.scale,y:360-(360-v.y)*scale/v.scale};});}
 function fit(){if(!graph.nodes.length){setView({x:0,y:0,scale:1});return;}const xs=graph.nodes.map(n=>n.x),ys=graph.nodes.map(n=>n.y),x0=Math.min(...xs)-100,x1=Math.max(...xs)+190,y0=Math.min(...ys)-70,y1=Math.max(...ys)+70,scale=Math.min(1.5,1100/(x1-x0),630/(y1-y0));setView({scale,x:600-(x0+x1)*scale/2,y:360-(y0+y1)*scale/2});}
 useEffect(()=>{const element=svg.current;if(!element)return;const wheel=(e:WheelEvent)=>{e.preventDefault();const {x,y}=pointer(e.clientX,e.clientY),v=viewRef.current,scale=Math.max(.35,Math.min(3,v.scale*Math.exp(-e.deltaY*.0015)));setView({scale,x:x-(x-v.x)*scale/v.scale,y:y-(y-v.y)*scale/v.scale});};element.addEventListener('wheel',wheel,{passive:false});return()=>element.removeEventListener('wheel',wheel);},[]);
 return <div className="knowledge-graph"><div className="knowledge-graph-toolbar"><Network size={16}/><strong>Your ideas, connected</strong><span>{graph.shownItems} items · {graph.edges.length} links</span><div className="spacer"/><IconButton label="Zoom out" onClick={()=>zoom(1/1.2)}><Minus size={15}/></IconButton><output aria-label="Graph zoom">{Math.round(view.scale*100)}%</output><IconButton label="Zoom in" onClick={()=>zoom(1.2)}><Plus size={15}/></IconButton><IconButton label="Fit graph" onClick={fit}><Maximize2 size={15}/></IconButton></div>
  <div className="graph-kind-controls">{kinds.map(k=><button key={k.id} type="button" aria-pressed={enabled.includes(k.id)} onClick={()=>{setFocus('');setEnabled(v=>v.includes(k.id)?v.filter(id=>id!==k.id):[...v,k.id]);}}><span style={{background:color[k.id]}}/>{k.label}</button>)}</div>
  <div className="graph-layout"><svg ref={svg} viewBox="0 0 1200 720" role="group" aria-label="Interactive map of your library" tabIndex={0}
   onPointerDown={e=>{if(e.button!==0||(e.target as Element).closest('[data-graph-node]'))return;const p=pointer(e.clientX,e.clientY);drag.current={x:p.x,y:p.y,panX:view.x,panY:view.y};e.currentTarget.setPointerCapture(e.pointerId);}}
   onPointerMove={e=>{const d=drag.current;if(!d)return;const p=pointer(e.clientX,e.clientY);setView(v=>({...v,x:d.panX+p.x-d.x,y:d.panY+p.y-d.y}));}}
   onPointerUp={()=>{drag.current=null;}} onPointerCancel={()=>{drag.current=null;}}
   onKeyDown={e=>{if(e.key==='Escape'){setFocus('');drag.current=null;}if(e.target!==e.currentTarget)return;if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();setView(v=>({...v,x:v.x+(e.key==='ArrowLeft'?35:e.key==='ArrowRight'?-35:0),y:v.y+(e.key==='ArrowUp'?35:e.key==='ArrowDown'?-35:0)}));}if(e.key==='+'||e.key==='=')zoom(1.2);if(e.key==='-')zoom(1/1.2);}}>
   <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
    {graph.edges.map((edge,i)=>{const a=byId.get(edge.source)!,b=byId.get(edge.target)!;return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={color[b.kind]} strokeOpacity={!focus||edge.source===focus||edge.target===focus?0.35:0.08} strokeWidth={edge.source===focus||edge.target===focus?2:1}/>;})}
    {graph.nodes.map(node=><g data-graph-node={node.id} key={node.id} transform={`translate(${node.x} ${node.y})`} role="button" tabIndex={0} aria-label={`${node.kind==='item'?'Item':node.kind}: ${node.label}`} aria-pressed={focus===node.id} style={{opacity:!focus||neighbors.has(node.id)?1:.25,cursor:'pointer'}} onClick={()=>setFocus(node.id)} onDoubleClick={()=>{if(node.entityId)open(node.entityId);}} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();setFocus(node.id);}}}><circle r={node.kind==='item'?(app.preferences.pinnedIds.includes(node.id)?9:6):11+Math.min(8,node.degree)} fill={color[node.kind]} fillOpacity={node.kind==='item'?0.9:0.2} stroke={color[node.kind]}/><text x={node.kind==='item'?13:25} y={4} fill="#d9dfd1" fontSize="12">{node.label.length>28?node.label.slice(0,27)+'…':node.label}</text></g>)}
   </g>
  </svg>{selected&&<aside className="graph-focus-panel"><div><span>{selected.kind}</span><IconButton label="Clear graph focus" onClick={()=>setFocus('')}><X size={15}/></IconButton></div><h3>{selected.label}</h3><p>{selected.degree} connections</p>{selected.entityId&&<Button onClick={()=>open(selected.entityId!)}>Open {selected.kind==='board'?'board':'item'}<ArrowUpRight size={13}/></Button>}<div className="graph-linked-items">{[...neighbors].filter(id=>id!==selected.id).map(id=>byId.get(id)).filter(Boolean).map(node=><button key={node!.id} onClick={()=>node!.entityId?open(node!.entityId!):setFocus(node!.id)}>{node!.label}<ArrowUpRight size={12}/></button>)}</div></aside>}</div>
  <p className="graph-instructions">Drag to pan, scroll to zoom, select a hub to focus, or double-click an item to open it. Repeated names uses matching capitalized phrases from your visible notes.{graph.totalItems>graph.shownItems?` Showing the latest ${graph.shownItems} of ${graph.totalItems} filtered items.`:''}</p>
 </div>;
}
