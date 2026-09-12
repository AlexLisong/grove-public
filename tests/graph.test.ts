import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {buildKnowledgeGraph,type GraphKind} from '../shared/graph.js';
import type {Entity} from '../shared/types.js';

const entity=(id:string,patch:Partial<Entity>={}):Entity=>({id,workspaceId:'workspace',kind:'item',title:id,content:'',data:{},tags:[],starred:false,archived:false,parentId:null,createdAt:'2026-09-05T00:00:00Z',updatedAt:'2026-09-05T00:00:00Z',version:1,deletedAt:null,...patch});
const all=()=>new Set<GraphKind>(['board','creator','book','tag','mention']);
describe('knowledge graph',()=>{
 it('uses explicit references only for the visible selection and keeps distinct board identities',()=>{
  const a=entity('a',{parentId:'board-1',data:{connections:['b','hidden'],entityLinks:['b']}}),b=entity('b');
  const boards=[entity('board-1',{kind:'board',title:'Research',data:{itemIds:['a','hidden']}}),entity('board-2',{kind:'board',title:'Research',data:{placements:[{id:'b'}]}})];
  const graph=buildKnowledgeGraph([a,b],boards,all());
  assert.equal(graph.edges.filter(e=>e.kind==='reference').length,1);
  assert.equal(graph.nodes.filter(n=>n.kind==='board').length,2);
  assert.ok(graph.nodes.every(n=>n.id!=='hidden'&&!n.sourceIds.includes('hidden')));
  assert.deepEqual(graph.nodes.find(n=>n.id==='board:board-1')?.sourceIds,['a']);
 });
 it('builds exact repeated-name hubs only when requested and across distinct sources',()=>{
  const items=[entity('a',{content:'Ada Lovelace wrote notes. Ada Lovelace appears again. Grace Hopper worked alone here.'}),entity('b',{content:'Ada Lovelace inspired this example.'})];
  assert.equal(buildKnowledgeGraph(items,[],new Set()).nodes.length,2);
  const graph=buildKnowledgeGraph(items,[],all()),mentions=graph.nodes.filter(n=>n.kind==='mention');
  assert.deepEqual(mentions.map(n=>n.label),['Ada Lovelace']);
  assert.deepEqual(mentions[0].sourceIds,['a','b']);
 });
 it('builds book/creator/tag hubs without mutating source data and lays out deterministically',()=>{
  const items=[entity('a',{tags:[' Research ','research'],data:{bookTitle:'A Book',bookAuthor:'A Writer',creatorId:'creator-1'}})];
  const context=[entity('creator-1',{kind:'creator',title:'Creator'})],original=JSON.stringify(items);
  const first=buildKnowledgeGraph(items,context,all()),again=buildKnowledgeGraph(items,context,all());
  assert.deepEqual(first,again);assert.equal(JSON.stringify(items),original);
  assert.equal(first.nodes.filter(n=>n.kind==='tag').length,1);
  assert.ok(first.nodes.some(n=>n.kind==='book'&&n.label==='A Book'));
  assert.ok(first.nodes.some(n=>n.kind==='creator'&&n.entityId==='creator-1'));
  for(const n of first.nodes)assert.ok(Number.isFinite(n.x)&&Number.isFinite(n.y));
 });
 it('bounds large libraries and does not create dangling edges when the hub limit is reached',()=>{
  const items=Array.from({length:300},(_,i)=>entity(`item-${i}`,{tags:Array.from({length:20},(_,j)=>`tag-${i}-${j}`),data:{connections:[`item-${i+1}`]}}));
  const graph=buildKnowledgeGraph(items,[],all()),ids=new Set(graph.nodes.map(n=>n.id));
  assert.equal(graph.shownItems,120);assert.equal(graph.totalItems,300);assert.ok(graph.nodes.length<=220);
  assert.ok(graph.edges.every(e=>ids.has(e.source)&&ids.has(e.target)));
  assert.equal(graph.nodes.filter(n=>n.kind==='item').length,120);
 });
 it('keeps same-named creators and distinct book records separate',()=>{
  const items=[entity('a',{data:{creatorId:'c1',bookTitle:'Shared title',bookAuthor:'First writer'}}),entity('b',{data:{creatorId:'c2',bookTitle:'Shared title',bookAuthor:'Second writer'}})];
  const creators=[entity('c1',{kind:'creator',title:'Alex Smith'}),entity('c2',{kind:'creator',title:'Alex Smith'})];
  const graph=buildKnowledgeGraph(items,creators,all());
  assert.equal(graph.nodes.filter(n=>n.kind==='creator'&&n.label==='Alex Smith').length,2);
  assert.equal(graph.nodes.filter(n=>n.kind==='book').length,2);
  assert.deepEqual(graph.nodes.find(n=>n.id==='creator:c2')?.sourceIds,['b']);
 });
});
