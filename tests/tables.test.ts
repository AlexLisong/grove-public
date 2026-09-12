import {describe,test} from 'node:test';
import assert from 'node:assert/strict';
import type {Entity,TableColumn,TableData,TableRecurrence,TableRow} from '../shared/types.js';
import {addDays,applyCellMatrix,completeTableRow,defaultViewSettings,encodeTSV,matchesTableFilter,nextRecurrence,normalizeTableData,parseCell,parseTSV,rangeBounds,recurrenceFor,recurrencePreview,reorderTableRow,replaceTableColumns,stripTableRelations,tableCellValue,tableReferenceIds,tableRowTitle,undoTableCompletion,validDate,validateTableData,visibleTableRows} from '../shared/table.js';
import {parseTableDraft} from '../src/components/tableDraft.js';
const uuid=(n:number)=>`50000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const columns:TableColumn[]=[{id:'name',name:'Name',type:'text'},{id:'date',name:'Due',type:'date'},{id:'score',name:'Score',type:'number'},{id:'status',name:'Status',type:'select',options:['Open','Done']},{id:'tags',name:'Tags',type:'multi-select',options:['A','B']},{id:'priority',name:'Priority',type:'priority',options:['Low','Medium','High','Urgent']}];
const data=(rows:TableRow[]=[],cols=columns):TableData=>({tableVersion:2,columns:structuredClone(cols),rows:structuredClone(rows),removedRows:[],view:'table',viewSettings:defaultViewSettings(cols),savedViews:[]});
const row=(id='r1',date='2026-01-31',extra:Partial<TableRow>={}):TableRow=>({id,cells:{name:id,date,score:1},...extra});
const rule=(frequency:TableRecurrence['frequency']='monthly',extra:Partial<TableRecurrence>={}):TableRecurrence=>({frequency,interval:1,anchor:'scheduled',dateColumnId:'date',originDate:'2026-01-31',...extra});
const entity=(id=uuid(1),extra:Partial<Entity>={}):Entity=>({id,kind:'item',title:'Live title',workspaceId:uuid(99),content:'',data:{},tags:[],starred:false,archived:false,parentId:null,createdAt:'2026-01-02T00:00:00.000Z',updatedAt:'2026-01-02T00:00:00.000Z',deletedAt:null,version:1,...extra});
const invalid=(fn:()=>unknown)=>assert.throws(fn,(error:any)=>error.status===400&&error.code==='INVALID_TABLE');

describe('typed table data and legacy compatibility',()=>{
 test('stored values are typed and option colors, URLs and dates are validated',()=>{
  const table=data([row()]);Object.assign(table.rows[0].cells,{status:'Open',tags:['A','B'],priority:'Urgent'});table.columns[3].optionColors={Open:'#12ab34'};validateTableData(table);
  for(const [key,value] of [['score','1'],['date','2026-02-29'],['tags','A'],['status','Missing'],['tags',['A','A']]]){const bad=structuredClone(table);bad.rows[0].cells[key as string]=value;invalid(()=>validateTableData(bad));}
  assert.equal(parseCell({id:'x',name:'N',type:'number'},'2.5'),2.5);assert.equal(parseCell({id:'x',name:'Check',type:'checkbox'},'yes'),true);
  for(const value of ['javascript:alert(1)','file:///a','https://user:password@example.test'])invalid(()=>parseCell({id:'url',name:'Website',type:'url'},value));
  assert.equal(parseCell({id:'url',name:'Website',type:'url'},'https://example.test/path'),'https://example.test/path');
  invalid(()=>validateTableData({...table,columns:table.columns.map(c=>c.id==='status'?{...c,optionColors:{Open:'red'}}:c)}));
 });
 test('unchanged malformed legacy cells can be preserved, but changed values and schemas cannot bypass validation',()=>{
  const old={columns:[{id:'n',name:'Number',type:'number'}],rows:[{id:'r',cells:{n:'legacy text'}}]};
  validateTableData({...structuredClone(old),caption:'A harmless edit'},old);
  invalid(()=>validateTableData({...structuredClone(old),tableVersion:2},old));
  const changed=structuredClone(old);changed.rows[0].cells.n='different invalid text';invalid(()=>validateTableData(changed,old));
  const changedType=structuredClone(old);changedType.columns[0].type='url';invalid(()=>validateTableData(changedType,old));
  invalid(()=>validateTableData(structuredClone(old)));
  const normalized=normalizeTableData({columns:[{id:'n',name:'N',type:'number'},{id:'tag',name:'Tag',type:'multi-select',options:['A']}],rows:[{id:'r',cells:{n:'12',tag:'A, B'}}],view:'grid'});
  assert.equal(normalized.rows[0].cells.n,12);assert.deepEqual(normalized.rows[0].cells.tag,['A','B']);assert.deepEqual(normalized.columns[1].options,['A','B']);assert.equal(normalized.view,'table');validateTableData({...normalized,tableVersion:2});
  assert.doesNotThrow(()=>normalizeTableData({columns:[null,{id:'x',name:'X',type:'text',options:{bad:true}}],rows:[null]}));
 });
 test('property, row, filter and saved-view identifiers are safe and structurally checked',()=>{
  const table=data([row()]);
  for(const col of [{id:'__proto__',name:'Bad',type:'text'},{id:'x',name:'Bad',type:'bogus'},null])invalid(()=>validateTableData({...table,columns:[col]}));
  invalid(()=>validateTableData({...table,rows:[row(),row()]}));
  invalid(()=>validateTableData({...table,rows:[{id:'r',cells:JSON.parse('{"__proto__":"bad"}')}]}));
  invalid(()=>validateTableData({...table,savedViews:[null]}));
  invalid(()=>validateTableData({...table,viewSettings:{...table.viewSettings,dateColumnId:'name'}}));
  invalid(()=>validateTableData({...table,viewSettings:{...table.viewSettings,filters:[{id:'f',columnId:'name',operator:'today'}]}}));
  invalid(()=>validateTableData({...table,viewSettings:{...table.viewSettings,filters:[{id:'f',columnId:'date',operator:'before',value:'2026-02-30'}]}}));
  const filter={id:'f',columnId:'date',operator:'today'};invalid(()=>validateTableData({...table,viewSettings:{...table.viewSettings,filters:[filter,filter]}}));
 });
 test('schema replacement removes active and recovered hidden cells and dependent view/recurrence settings',()=>{
  const table=data([row('active','2026-01-31',{recurrence:rule()})]);table.rows[0].cells.secret='Orphaned secret';table.removedRows=[row('removed','2026-01-31',{recurrence:rule()})];table.viewSettings.dateColumnId='date';table.viewSettings.sortColumnId='score';table.viewSettings.filters=[{id:'due',columnId:'date',operator:'today'}];table.savedViews=[{id:'daily',name:'Daily',layout:'calendar',settings:structuredClone(table.viewSettings)}];
  const changed=replaceTableColumns(table,[columns[0]]);assert.deepEqual(changed.rows[0].cells,{name:'active'});assert.equal(changed.rows[0].recurrence,undefined);assert.deepEqual(changed.removedRows[0].cells,{name:'removed'});assert.equal(changed.viewSettings.dateColumnId,'');assert.equal(changed.viewSettings.sortColumnId,'');assert.deepEqual(changed.savedViews[0].settings.filters,[]);assert.equal(table.rows[0].cells.secret,'Orphaned secret');
 });
 test('linked and related IDs include removed rows, and public copies strip all row relations',()=>{
  const cols=[...columns,{id:'rel',name:'Relation',type:'relation'}] as TableColumn[];
  const table=data([row('r1','2026-01-01',{itemId:uuid(1),relatedItemIds:[uuid(2)],cells:{rel:uuid(3)}})],cols);table.removedRows=[row('r2','2026-01-02',{itemId:uuid(4)})];
  assert.deepEqual(tableReferenceIds(table).sort(),[1,2,3,4].map(uuid));
  table.viewSettings.filters=[{id:'filter',columnId:'rel',operator:'equals',value:uuid(3)}];const publicData=stripTableRelations(table);assert.deepEqual(publicData.viewSettings.filters,[]);assert.equal(publicData.removedRows,undefined);assert.deepEqual(tableReferenceIds(publicData),[]);assert.ok(table.rows[0].itemId);assert.equal(publicData.rows[0].cells.rel,undefined);
  for(const bad of [{itemId:'bad'},{relatedItemIds:['bad']},{cells:{rel:'bad'}}])invalid(()=>validateTableData({...table,rows:[{...table.rows[0],...bad}]}));
 });
});

describe('calendar recurrence and undo',()=>{
 test('monthly recurrence preserves month-end across February and missed occurrences',()=>{
  const recurring=row('monthly','2026-01-31',{recurrence:rule()});
  const feb=completeTableRow(recurring,columns,'2026-01-31');assert.equal(feb.cells.date,'2026-02-28');assert.equal(feb.cells.__done,false);
  const march=completeTableRow(feb,columns,'2026-02-28');assert.equal(march.cells.date,'2026-03-31');
  assert.equal(nextRecurrence(rule(),'2026-01-31','2026-04-01'),'2026-04-30');
  assert.deepEqual(recurrencePreview(recurring,columns,'2026-01-31',3),['2026-02-28','2026-03-31','2026-04-30']);
 });
 test('yearly recurrence restores leap days; calendar arithmetic is date-only across DST',()=>{
  const leap=rule('yearly',{originDate:'2024-02-29'});assert.equal(nextRecurrence(leap,'2024-02-29','2024-02-29'),'2025-02-28');assert.equal(nextRecurrence(leap,'2027-02-28','2027-02-28'),'2028-02-29');
  assert.equal(addDays('2026-03-07',1),'2026-03-08');assert.equal(addDays('2026-11-01',1),'2026-11-02');assert.equal(validDate('2026-02-29'),false);assert.equal(validDate('2028-02-29'),true);
  assert.equal(nextRecurrence(rule('daily',{originDate:'2001-01-01'}),'2001-01-01','2026-09-05'),'2026-09-06');
 });
 test('weekdays skip weekends; daily, weekly and custom units preserve their interval',()=>{
  const work=rule('weekday');assert.equal(nextRecurrence(work,'2026-09-04','2026-09-04'),'2026-09-07');assert.equal(nextRecurrence(work,'2026-09-05','2026-09-05'),'2026-09-07');assert.equal(nextRecurrence(work,'2026-09-06','2026-09-06'),'2026-09-07');
  assert.equal(nextRecurrence(rule('weekday',{interval:2}),'2026-09-04','2026-09-04'),'2026-09-08');
  assert.equal(nextRecurrence(rule('weekly',{interval:2}),'2026-09-01','2026-09-20'),'2026-09-29');
  assert.equal(nextRecurrence(rule('custom',{interval:2,unit:'month'}),'2026-01-31','2026-01-31'),'2026-03-31');
  assert.equal(nextRecurrence(rule('custom',{interval:30,unit:'day'}),'2026-01-31','2026-01-31'),'2026-03-02');
  invalid(()=>nextRecurrence(rule('custom',{unit:undefined}),'2026-01-31','2026-01-31'));
 });
 test('completion anchors use completion day in subsequent previews and skip future scheduled dates',()=>{
  const current=row('r','2026-01-31',{recurrence:rule('monthly',{anchor:'completion'})});
  assert.deepEqual(recurrencePreview(current,columns,'2026-02-10',3),['2026-03-10','2026-04-10','2026-05-10']);
  assert.equal(nextRecurrence(rule('weekly',{anchor:'completion'}),'2026-12-31','2026-09-05'),'2026-09-12');
  assert.equal(nextRecurrence(rule('weekly'),'2026-12-31','2026-09-05'),'2027-01-07');
 });
 test('legacy 30-day repeats stay 30 days and completion can be undone without overwriting newer dates',()=>{
  const legacy=row();legacy.cells.__repeat=30;
  assert.equal(recurrenceFor(legacy,columns)?.unit,'day');const completed=completeTableRow(legacy,columns,'2026-01-31');assert.equal(completed.cells.date,'2026-03-02');
  const restored=undoTableCompletion(completed);assert.equal(restored.cells.date,'2026-01-31');assert.equal(restored.cells.__done,false);
  invalid(()=>undoTableCompletion({...completed,cells:{...completed.cells,date:'2026-03-03'}}));
  const once=completeTableRow(row(),columns);assert.equal(once.cells.__done,true);assert.equal(completeTableRow(once,columns).cells.__done,false);
 });
});

describe('table views, computed fields and clipboard operations',()=>{
 test('live linked titles and metrics are derived without inventing zero values',()=>{
  const link=entity(uuid(1),{data:{platform:'youtube',metrics:{likes:0,views:53}}}),linked=row('r','2026-01-31',{itemId:link.id});
  assert.equal(tableRowTitle(linked,columns,[link]),'Live title');assert.equal(tableCellValue(linked,{id:'n',name:'Likes',type:'likes'},[link]),0);assert.equal(tableCellValue(linked,{id:'n',name:'Views',type:'views'},[link]),53);assert.equal(tableCellValue(linked,{id:'n',name:'Platform',type:'platform'},[link]),'youtube');
  assert.equal(tableCellValue(linked,{id:'n',name:'Likes',type:'likes'},[]),null);assert.equal(tableRowTitle(linked,columns,[]),'Linked item unavailable');
  const other=entity(uuid(2),{data:{views:99}});linked.cells.relation=other.id;assert.equal(tableCellValue(linked,{id:'n',name:'Views',type:'views',sourceColumnId:'relation'},[link,other]),99);
  const computed=data([{id:'r',cells:{likes:0}}],[{id:'likes',name:'Likes',type:'likes'}]);invalid(()=>validateTableData(computed));
 });
 test('saved relative filters reevaluate and sorts use live titles, numeric values and priority rank',()=>{
  const table=data([row('z','2026-09-05',{itemId:uuid(1),cells:{name:'Z old',date:'2026-09-05',score:20,priority:'Low'}}),row('a','2026-09-06',{cells:{name:'B standalone',date:'2026-09-06',score:3,priority:'High'}})]);
  const sources=[entity(uuid(1),{title:'A live'})];table.viewSettings.sortColumnId='name';assert.deepEqual(visibleTableRows(table,sources).map(r=>r.id),['z','a']);
  table.viewSettings.sortColumnId='score';assert.deepEqual(visibleTableRows(table,sources).map(r=>r.id),['a','z']);table.viewSettings.sortColumnId='priority';table.viewSettings.sortDirection='desc';assert.deepEqual(visibleTableRows(table,sources).map(r=>r.id),['a','z']);
  table.viewSettings.filters=[{id:'f',columnId:'date',operator:'today'}];assert.deepEqual(visibleTableRows(table,sources,'2026-09-05').map(r=>r.id),['z']);assert.deepEqual(visibleTableRows(table,sources,'2026-09-06').map(r=>r.id),['a']);
  assert.equal(matchesTableFilter('2026-09-01',{id:'f',columnId:'date',operator:'overdue'},'2026-09-05'),true);assert.equal(matchesTableFilter('2026-09-06',{id:'f',columnId:'date',operator:'this-week'},'2026-09-05'),true);assert.equal(matchesTableFilter('2026-09-07',{id:'f',columnId:'date',operator:'this-week'},'2026-09-05'),false);
 });
 test('TSV preserves tabs, quoted newlines and carriage returns, and rejects malformed or oversized fields',()=>{
  const matrix=[['plain','tab\tinside','two\nlines','"quoted"'],['x','CR\rLF\r\n','', 'last']];assert.deepEqual(parseTSV(encodeTSV(matrix)),matrix);
  assert.deepEqual(parseTSV('a\tb\r\nc\td\r\n'),[['a','b'],['c','d']]);assert.deepEqual(parseTSV(''),[['']]);
  invalid(()=>parseTSV('"unclosed'));invalid(()=>parseTSV('"a"x'));invalid(()=>parseTSV('x'.repeat(1_000_001)));
 });
 test('range edits validate atomically, retain identities and skip computed and linked title cells',()=>{
  const cols:TableColumn[]=[{id:'name',name:'Name',type:'text'},{id:'n',name:'N',type:'number'},{id:'likes',name:'Likes',type:'likes'}];
  const table=data([{id:'a',itemId:uuid(1),cells:{name:'Original',n:1}},{id:'b',cells:{name:'Standalone',n:2}}],cols),before=structuredClone(table);
  const pasted=applyCellMatrix(table,table.rows,{rowId:'a',columnId:'name'},[['Overwrite attempt','12','99'],['New','5','19']]);
  assert.equal(pasted.rows[0].cells.name,'Original');assert.equal(pasted.rows[0].cells.n,12);assert.equal(pasted.rows[0].cells.likes,undefined);assert.equal(pasted.rows[1].cells.name,'New');assert.deepEqual(table,before);
  invalid(()=>applyCellMatrix(table,table.rows,{rowId:'a',columnId:'n'},[['8'],['invalid']]));assert.deepEqual(table,before);
  invalid(()=>applyCellMatrix(table,table.rows,{rowId:'b',columnId:'likes'},[['x','too wide']]));
  assert.deepEqual(rangeBounds({anchor:{rowId:'b',columnId:'likes'},focus:{rowId:'a',columnId:'name'}},table.rows,cols),{top:0,bottom:1,left:0,right:2});
 });
 test('manual reorder is rejected while sorted and date paste clears stale completion undo',()=>{
  const table=data([row('a'),row('b'),row('c')]);assert.deepEqual(reorderTableRow(table,'c','a').rows.map(r=>r.id),['c','a','b']);table.viewSettings.sortColumnId='name';invalid(()=>reorderTableRow(table,'c','a'));
  const completed=completeTableRow(row('a','2026-01-31',{recurrence:rule()}),columns,'2026-01-31'),calendar=data([completed]);const pasted=applyCellMatrix(calendar,calendar.rows,{rowId:'a',columnId:'date'},[['2026-03-15']]);assert.equal(pasted.rows[0].lastCompletion,undefined);
 });
});


describe('table draft recovery format',()=>{
 test('a recovered draft preserves its optimistic version and raw uncommitted cell text separately from stored typed data',()=>{
  const saved={version:7,draft:{title:'Unsaved planning',data:data([row()])},pending:[{point:{rowId:'r1',columnId:'score'},text:'unfinished number'}],savedAt:'2026-09-05T12:00:00Z'};
  const recovered=parseTableDraft(JSON.stringify(saved))!;assert.equal(recovered.version,7);assert.equal(recovered.draft.title,'Unsaved planning');assert.equal(recovered.draft.data.rows[0].cells.score,1);assert.deepEqual(recovered.pending,saved.pending);
 });
 test('malformed or unsafe recovery records are rejected without throwing',()=>{
  for(const raw of [null,'not json','{}',JSON.stringify({version:0,draft:{title:'x',data:data()}}),JSON.stringify({version:1,draft:{title:'x',data:data()},pending:[{point:{rowId:'__proto__',columnId:'name'},text:'unsafe'}]})])assert.equal(parseTableDraft(raw),null);
  assert.equal(parseTableDraft('x'.repeat(2_500_001)),null);
 });
});
