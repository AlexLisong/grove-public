import type {Entity,TableColumn,TableColumnType,TableData,TableFilter,TableRecurrence,TableRow,TableViewSettings} from './types.js';

export const tableTypes:TableColumnType[]=['text','number','select','multi-select','date','checkbox','url','relation','priority','created','platform','likes','views'];
export const computedTypes=new Set<TableColumnType>(['created','platform','likes','views']);
export const priorityOptions=['Low','Medium','High','Urgent'];
const forbidden=new Set(['__proto__','prototype','constructor']);
const idPattern=/^[A-Za-z0-9_.:-]{1,100}$/;
const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const dayMs=86400000;
export class TableValidationError extends Error {status=400;code='INVALID_TABLE';constructor(message:string){super(message);this.name='TableValidationError';}}
const fail=(message:string):never=>{throw new TableValidationError(message);};
export function validDate(value:unknown):value is string {if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;const date=new Date(value+'T12:00:00Z');return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===value;}
const dateValue=(value:string)=>{if(!validDate(value))return fail('Dates must be valid YYYY-MM-DD calendar dates.');return new Date(value+'T12:00:00Z');};
const isoDate=(date:Date)=>{const iso=date.toISOString();if(!/^\d{4}-/.test(iso))return fail('This recurrence exceeds the supported calendar.');return iso.slice(0,10);};
export const todayDate=(date=new Date())=>`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
export const addDays=(value:string,days:number)=>isoDate(new Date(dateValue(value).getTime()+days*dayMs));
export function addMonths(value:string,months:number,anchorDay?:number){const date=dateValue(value),day=anchorDay||date.getUTCDate();date.setUTCDate(1);date.setUTCMonth(date.getUTCMonth()+months);const end=new Date(date.getTime());end.setUTCMonth(end.getUTCMonth()+1);end.setUTCDate(0);date.setUTCDate(Math.min(day,end.getUTCDate()));return isoDate(date);}
function weekdaysAfter(value:string,count:number){let date=dateValue(value);if(date.getUTCDay()===6)date.setUTCDate(date.getUTCDate()-1);if(date.getUTCDay()===0)date.setUTCDate(date.getUTCDate()-2);const weeks=Math.floor(count/5);date.setUTCDate(date.getUTCDate()+weeks*7);let remaining=count%5;while(remaining){date.setUTCDate(date.getUTCDate()+1);if(date.getUTCDay()!==0&&date.getUTCDay()!==6)remaining--;}return isoDate(date);}
export function validateRecurrence(rule:TableRecurrence,columns?:TableColumn[]){
 if(!rule||typeof rule!=='object'||!['daily','weekday','weekly','monthly','yearly','custom'].includes(rule.frequency)||!['scheduled','completion'].includes(rule.anchor))fail('Choose a supported recurrence and anchor.');
 if(!Number.isInteger(rule.interval)||rule.interval<1||rule.interval>1000)fail('Recurrence intervals must be between 1 and 1,000.');
 if(rule.frequency==='custom'&&!['day','week','month','year'].includes(rule.unit||''))fail('Choose a calendar unit for custom recurrence.');
 if(!idPattern.test(rule.dateColumnId)||forbidden.has(rule.dateColumnId)||columns&&!columns.some(c=>c.id===rule.dateColumnId&&c.type==='date'))fail('Recurrence must use a date property in this table.');
 if(rule.originDate!==undefined&&!validDate(rule.originDate))fail('The recurrence origin must be a valid date.');
}
export function recurrenceFor(row:TableRow,columns:TableColumn[]):TableRecurrence|undefined{
 if(row.recurrence)return row.recurrence;
 const days=Number(row.cells.__repeat),date=columns.find(c=>c.type==='date');
 if(Number.isInteger(days)&&days>0&&days<=1000&&date)return {frequency:'custom',unit:'day',interval:days,anchor:'scheduled',dateColumnId:date.id,...(validDate(row.cells[date.id])?{originDate:row.cells[date.id]}:{})};
}
export function nextRecurrence(rule:TableRecurrence,scheduled:string,today=todayDate()):string{
 validateRecurrence(rule);dateValue(today);const current=validDate(scheduled)?scheduled:today,base=rule.anchor==='completion'?today:current,origin=rule.anchor==='completion'?base:rule.originDate||base;
 const frequency=rule.frequency==='custom'?rule.unit:({daily:'day',weekly:'week',monthly:'month',yearly:'year',weekday:'weekday'} as const)[rule.frequency];
 const interval=rule.interval,diff=Math.floor((dateValue(today).getTime()-dateValue(base).getTime())/dayMs);
 if(frequency==='day'||frequency==='week'){const step=interval*(frequency==='week'?7:1);return addDays(base,Math.max(1,Math.floor(diff/step)+1)*step);}
 if(frequency==='weekday'){let count=Math.max(1,Math.floor(Math.max(0,diff)*5/7/interval));let result=weekdaysAfter(base,count*interval);while(result<=today){count++;result=weekdaysAfter(base,count*interval);}return result;}
 const from=dateValue(base),to=dateValue(today),anchor=dateValue(origin),months=interval*(frequency==='year'?12:1);
 let count=Math.max(1,Math.floor(((to.getUTCFullYear()-from.getUTCFullYear())*12+to.getUTCMonth()-from.getUTCMonth())/months));
 let result=addMonths(base,count*months,anchor.getUTCDate());while(result<=today){count++;result=addMonths(base,count*months,anchor.getUTCDate());}return result;
}
export function recurrencePreview(row:TableRow,columns:TableColumn[],today=todayDate(),count=5){const rule=recurrenceFor(row,columns);if(!rule)return [];const output:string[]=[];let due=validDate(row.cells[rule.dateColumnId])?row.cells[rule.dateColumnId]:today;const originDate=rule.anchor==='completion'?today:rule.originDate||due;for(let i=0;i<Math.min(count,12);i++){due=nextRecurrence({...rule,originDate,anchor:i?'scheduled':rule.anchor},due,i?due:today);output.push(due);}return output;}
export function completeTableRow(row:TableRow,columns:TableColumn[],today=todayDate()):TableRow{
 const recurrence=recurrenceFor(row,columns);if(!recurrence)return {...row,cells:{...row.cells,__done:!row.cells.__done},lastCompletion:undefined};
 const previousDate=validDate(row.cells[recurrence.dateColumnId])?row.cells[recurrence.dateColumnId]:today,rule={...recurrence,originDate:recurrence.originDate||previousDate},nextDate=nextRecurrence(rule,previousDate,today);
 return {...row,recurrence:rule,cells:{...row.cells,[rule.dateColumnId]:nextDate,__done:false,__repeat:0},lastCompletion:{dateColumnId:rule.dateColumnId,previousDate,nextDate,previousDone:!!row.cells.__done,completedAt:today,previousRecurrence:row.recurrence}};
}
export function undoTableCompletion(row:TableRow):TableRow{const previous=row.lastCompletion;if(!previous)return row;if(row.cells[previous.dateColumnId]!==previous.nextDate||row.cells.__done)fail('The row changed after completion. Undo would replace a newer edit.');return {...row,cells:{...row.cells,[previous.dateColumnId]:previous.previousDate,__done:previous.previousDone},recurrence:previous.previousRecurrence||row.recurrence,lastCompletion:undefined};}

export const defaultViewSettings=(columns:TableColumn[]):TableViewSettings=>({query:'',sortColumnId:'',sortDirection:'asc',groupColumnId:columns.find(c=>c.type==='select'||c.type==='priority')?.id||'',dateColumnId:columns.find(c=>c.type==='date')?.id||'',filters:[],laneOrder:[]});
export function normalizeTableData(value:Record<string,any>):TableData{
 const columns:TableColumn[]=Array.isArray(value.columns)?value.columns.filter(column=>column&&typeof column==='object').map((column:any)=>({...column,options:Array.isArray(column.options)?[...column.options]:column.type==='priority'?[...priorityOptions]:undefined,optionColors:{...column.optionColors}})):[];
 const normalizeRows=(values:any[])=>values.filter(row=>row&&typeof row==='object').map(row=>({...row,cells:{...(row.cells||{})},relatedItemIds:Array.isArray(row.relatedItemIds)?[...row.relatedItemIds]:[]}));
 const rows=normalizeRows(Array.isArray(value.rows)?value.rows:[]),removedRows=normalizeRows(Array.isArray(value.removedRows)?value.removedRows:[]);
 // Older multi-select cells were free text. Preserve their values as options,
 // and interpret legacy 30-day repeats as 30 days, never as calendar months.
 if(value.tableVersion!==2)for(const column of columns){
  for(const row of [...rows,...removedRows]){let cell=row.cells[column.id];if(column.type==='multi-select'&&typeof cell==='string')row.cells[column.id]=cell=cell.split(',').map((s:string)=>s.trim()).filter(Boolean);if(column.type==='number'&&typeof cell==='string'&&cell.trim()&&Number.isFinite(Number(cell)))row.cells[column.id]=Number(cell);
   if(['select','multi-select','priority'].includes(column.type))for(const option of Array.isArray(cell)?cell:[cell])if(typeof option==='string'&&option&&!column.options?.includes(option))column.options=[...(column.options||[]),option];
  }
 }
 return {...value,columns,rows,removedRows,view:value.view==='grid'?'table':(['table','list','kanban','calendar','gallery'].includes(value.view)?value.view:'table'),viewSettings:{...defaultViewSettings(columns),...value.viewSettings,filters:Array.isArray(value.viewSettings?.filters)?value.viewSettings.filters:[],laneOrder:Array.isArray(value.viewSettings?.laneOrder)?value.viewSettings.laneOrder:[]},savedViews:Array.isArray(value.savedViews)?value.savedViews:[]};
}
export function parseCell(column:TableColumn,value:unknown):any{
 if(computedTypes.has(column.type))fail(`${column.name} is computed from its linked item.`);
 if(value===null||value===undefined||value==='')return column.type==='checkbox'?false:column.type==='multi-select'?[]:null;
 if(column.type==='checkbox'){if(typeof value==='boolean')return value;const v=String(value).toLowerCase().trim();if(['true','1','yes','checked'].includes(v))return true;if(['false','0','no','unchecked'].includes(v))return false;return fail(`${column.name} expects a checkbox value.`);}
 if(column.type==='number'){if(typeof value!=='number'&&typeof value!=='string')fail(`${column.name} expects a number.`);const n=Number(value);if(!Number.isFinite(n))fail(`${column.name} expects a finite number.`);return n;}
 if(column.type==='multi-select'){const options=Array.isArray(value)?value:String(value).split(',').map(s=>s.trim()).filter(Boolean);if(options.some(v=>typeof v!=='string'||!column.options?.includes(v)))fail(`${column.name} contains an option that is not configured.`);return [...new Set(options)];}
 if(typeof value!=='string')return fail(`${column.name} expects text.`);
 if(value.length>60000)fail(`${column.name} exceeds the cell text limit.`);
 if(column.type==='date'&&!validDate(value))fail(`${column.name} expects a valid YYYY-MM-DD date.`);
 if(column.type==='relation'&&!uuidPattern.test(value))fail(`${column.name} expects an accessible item ID.`);
 if(column.type==='url'){try{const url=new URL(value);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error();}catch{fail(`${column.name} expects an HTTP or HTTPS URL.`);}}
 if((column.type==='select'||column.type==='priority')&&!(column.options||(column.type==='priority'?priorityOptions:[])).includes(value))fail(`${column.name} contains an option that is not configured.`);
 return value;
}
export function validateTableData(data:Record<string,any>,previous?:Record<string,any>){
 if(data.columns===undefined)data.columns=[];if(data.rows===undefined)data.rows=[];
 if(!Array.isArray(data.columns)||!Array.isArray(data.rows))fail('Tables require columns and rows arrays.');
 if(data.removedRows!==undefined&&!Array.isArray(data.removedRows))fail('Removed table rows must be an array.');
 if(data.columns.length>100||data.rows.length>10000||(data.removedRows?.length||0)>10000)fail('Tables support up to 100 properties and 10,000 active or removed rows.');
 const ids=new Set<string>();for(const col of data.columns as TableColumn[]){if(!col||typeof col.id!=='string'||!idPattern.test(col.id)||forbidden.has(col.id)||ids.has(col.id))fail('Table property IDs must be unique safe identifiers.');ids.add(col.id);if(typeof col.name!=='string'||col.name.length>200||!tableTypes.includes(col.type))fail('Invalid table property definition.');if(col.options!==undefined&&(!Array.isArray(col.options)||col.options.length>200||new Set(col.options).size!==col.options.length||col.options.some(option=>typeof option!=='string'||!option||option.length>200)))fail('Property options must be unique, nonempty strings.');if(col.optionColors!==undefined&&(!col.optionColors||typeof col.optionColors!=='object'||Array.isArray(col.optionColors)||Object.entries(col.optionColors).some(([key,color])=>forbidden.has(key)||!/^#[0-9a-f]{6}$/i.test(String(color)))))fail('Option colors must be six-digit hex colors.');if(col.sourceColumnId&&!data.columns.some((c:TableColumn)=>c?.id===col.sourceColumnId&&c?.type==='relation'))fail('A computed source property must reference a relation column.');}
 const previousRows=new Map<string,TableRow>([...(Array.isArray(previous?.rows)?previous.rows:[]),...(Array.isArray(previous?.removedRows)?previous.removedRows:[])].filter(row=>row&&typeof row==='object').map(row=>[row.id,row]));
 const rowIds=new Set<string>();for(const row of [...data.rows,...(data.removedRows||[])] as TableRow[]){if(!row||typeof row.id!=='string'||!idPattern.test(row.id)||forbidden.has(row.id)||rowIds.has(row.id))fail('Table row IDs must be unique safe identifiers.');rowIds.add(row.id);if(!row.cells||typeof row.cells!=='object'||Array.isArray(row.cells)||Object.keys(row.cells).some(key=>forbidden.has(key)))fail('Invalid row cells.');
  if(row.itemId!==undefined&&row.itemId!==null&&!uuidPattern.test(row.itemId))fail('Linked row items must use valid item IDs.');if(row.relatedItemIds!==undefined&&(!Array.isArray(row.relatedItemIds)||row.relatedItemIds.length>80||row.relatedItemIds.some(id=>!uuidPattern.test(id))))fail('Related row items must use valid item IDs.');
  if(row.recurrence)validateRecurrence(row.recurrence,data.columns);if(row.lastCompletion){const undo=row.lastCompletion;if(!data.columns.some((c:TableColumn)=>c.id===undo.dateColumnId&&c.type==='date')||![undo.previousDate,undo.nextDate,undo.completedAt].every(validDate)||typeof undo.previousDone!=='boolean')fail('Invalid recurrence undo state.');if(undo.previousRecurrence)validateRecurrence(undo.previousRecurrence,data.columns);}
  for(const column of data.columns as TableColumn[]){const value=row.cells[column.id];if(value==null||value==='')continue;const legacyUnchanged=data.tableVersion!==2&&previous?.tableVersion!==2&&previous?.columns?.some((old:TableColumn)=>old.id===column.id&&old.type===column.type&&JSON.stringify(old.options)===JSON.stringify(column.options))&&JSON.stringify(previousRows.get(row.id)?.cells?.[column.id])===JSON.stringify(value);if(column.type==='relation')parseCell(column,value);else if(!legacyUnchanged&&!computedTypes.has(column.type)){const parsed=parseCell(column,value);if(JSON.stringify(parsed)!==JSON.stringify(value))fail(`${column.name} has the wrong stored type.`);}if(computedTypes.has(column.type)&&!legacyUnchanged)fail(`${column.name} cannot contain a stored computed value.`);}
 }
 if(data.viewSettings)validateViewSettings(data.viewSettings,data.columns);
 if(data.savedViews!==undefined){if(!Array.isArray(data.savedViews)||data.savedViews.length>30)fail('At most 30 saved views are supported.');const views=new Set<string>();for(const view of data.savedViews){if(!view||typeof view.id!=='string'||!idPattern.test(view.id)||forbidden.has(view.id)||views.has(view.id)||typeof view.name!=='string'||!view.name.trim()||view.name.length>100||!['table','list','kanban','calendar','gallery'].includes(view.layout))fail('Invalid saved table view.');views.add(view.id);validateViewSettings(view.settings,data.columns);}}
}
function validateViewSettings(settings:TableViewSettings,columns:TableColumn[]){
 if(!settings||typeof settings!=='object'||Array.isArray(settings)||typeof settings.query!=='string'||settings.query.length>300||!['asc','desc'].includes(settings.sortDirection))fail('Invalid table view settings.');
 for(const id of [settings.sortColumnId,settings.groupColumnId,settings.dateColumnId])if(typeof id!=='string'||id&&!columns.some(c=>c.id===id))fail('Saved view references a missing property.');
 if(settings.dateColumnId&&!columns.some(c=>c.id===settings.dateColumnId&&c.type==='date'))fail('A calendar view requires a date property.');
 if(!Array.isArray(settings.filters)||settings.filters.length>20||!Array.isArray(settings.laneOrder)||settings.laneOrder.length>300||settings.laneOrder.some(l=>typeof l!=='string'||l.length>200)||new Set(settings.laneOrder).size!==settings.laneOrder.length)fail('Invalid table filters or lane order.');
 const ids=new Set<string>();
 for(const filter of settings.filters){
  if(!filter||typeof filter.id!=='string'||!idPattern.test(filter.id)||forbidden.has(filter.id)||ids.has(filter.id)||!columns.some(c=>c.id===filter.columnId)||!['equals','contains','empty','not-empty','today','overdue','next-7-days','this-week','before','after'].includes(filter.operator)||filter.value!==undefined&&(typeof filter.value!=='string'||filter.value.length>200))fail('Invalid table filter.');
  ids.add(filter.id);
  if(['today','overdue','next-7-days','this-week','before','after'].includes(filter.operator)&&!columns.some(c=>c.id===filter.columnId&&['date','created'].includes(c.type)))fail('Relative date filters require a date or created property.');
  if(['before','after'].includes(filter.operator)&&!validDate(filter.value))fail('Date comparisons require a valid YYYY-MM-DD date.');
 }
}
export function tableReferenceIds(data:Record<string,any>){
 const columns:TableColumn[]=Array.isArray(data.columns)?data.columns:[],ids=new Set<string>();
 for(const row of [...(Array.isArray(data.rows)?data.rows:[]),...(Array.isArray(data.removedRows)?data.removedRows:[])] as TableRow[]){if(!row)continue;if(typeof row.itemId==='string')ids.add(row.itemId);for(const id of Array.isArray(row.relatedItemIds)?row.relatedItemIds:[])if(typeof id==='string')ids.add(id);for(const column of columns)if(column?.type==='relation'&&typeof row.cells?.[column.id]==='string'&&row.cells[column.id])ids.add(row.cells[column.id]);}
 return [...ids];
}
export function replaceTableColumns<T extends Record<string,any>>(data:T,columns:TableColumn[]):T{
 const ids=new Set(columns.map(column=>column.id)),dates=new Set(columns.filter(column=>column.type==='date').map(column=>column.id)),relations=new Set(columns.filter(column=>column.type==='relation').map(column=>column.id));
 const cleanRow=(row:TableRow)=>{
  const next={...row,cells:Object.fromEntries(Object.entries(row.cells).filter(([id])=>ids.has(id)||['__done','__repeat'].includes(id)))};
  if(next.recurrence&&!dates.has(next.recurrence.dateColumnId)){delete next.recurrence;delete next.lastCompletion;next.cells.__repeat=0;}
  if(next.lastCompletion&&(!dates.has(next.lastCompletion.dateColumnId)||next.lastCompletion.previousRecurrence&&!dates.has(next.lastCompletion.previousRecurrence.dateColumnId)))delete next.lastCompletion;
  if(!dates.size)delete next.cells.__repeat;
  return next;
 };
 const cleanSettings=(settings:TableViewSettings)=>({...settings,sortColumnId:ids.has(settings.sortColumnId)?settings.sortColumnId:'',groupColumnId:ids.has(settings.groupColumnId)?settings.groupColumnId:'',dateColumnId:dates.has(settings.dateColumnId)?settings.dateColumnId:'',filters:settings.filters.filter(filter=>ids.has(filter.columnId)),laneOrder:ids.has(settings.groupColumnId)?settings.laneOrder:[]});
 return {...data,columns:columns.map(column=>column.sourceColumnId&&!relations.has(column.sourceColumnId)?{...column,sourceColumnId:undefined}:column),rows:(data.rows||[]).map(cleanRow),...(Array.isArray(data.removedRows)?{removedRows:data.removedRows.map(cleanRow)}:{}),...(data.viewSettings?{viewSettings:cleanSettings(data.viewSettings)}:{}),...(Array.isArray(data.savedViews)?{savedViews:data.savedViews.map((view:any)=>({...view,settings:cleanSettings(view.settings)}))}:{})};
}
export function stripTableRelations(data:Record<string,any>){
 const copy=structuredClone(data),relations=(copy.columns||[]).filter((c:TableColumn)=>c.type==='relation'),relationIds=new Set(relations.map((c:TableColumn)=>c.id));
 const publicCellIds=new Set((copy.columns||[]).filter((column:TableColumn)=>column.type!=='relation'&&!computedTypes.has(column.type)).map((column:TableColumn)=>column.id));
 // Removed rows are private recovery history, never public table content.
 delete copy.removedRows;
 for(const row of copy.rows||[]){delete row.itemId;delete row.relatedItemIds;delete row.lastCompletion;row.cells=Object.fromEntries(Object.entries(row.cells||{}).filter(([id,value])=>publicCellIds.has(id)||id==='__done'&&typeof value==='boolean'));}
 // A relation filter can also contain a private source identifier. It cannot
 // meaningfully filter detached rows in the receiving public workspace.
 for(const settings of [copy.viewSettings,...(copy.savedViews||[]).map((view:any)=>view.settings)])if(settings&&Array.isArray(settings.filters))settings.filters=settings.filters.filter((filter:TableFilter)=>!relationIds.has(filter.columnId));
 return copy;
}
type Entities=ReadonlyArray<Entity>|ReadonlyMap<string,Entity>;
const lookup=(entities:Entities,id?:string|null)=>id?(Array.isArray(entities)?entities.find(e=>e.id===id):(entities as ReadonlyMap<string,Entity>).get(id)):undefined;
export function tableCellValue(row:TableRow,column:TableColumn,entities:Entities=[]):any{
 if(!computedTypes.has(column.type))return row.cells[column.id];const linked=lookup(entities,column.sourceColumnId?row.cells[column.sourceColumnId]:row.itemId);
 if(column.type==='created')return linked?.createdAt||row.createdAt||null;if(!linked)return null;
 if(column.type==='platform')return linked.data.platform||null;const value=linked.data.metrics?.[column.type]??linked.data[column.type];return typeof value==='number'&&Number.isFinite(value)?value:null;
}
export function tableRowTitle(row:TableRow,columns:TableColumn[],entities:Entities=[]){return row.itemId?(lookup(entities,row.itemId)?.title||'Linked item unavailable'):String(row.cells[columns[0]?.id]||'Untitled row');}
export function cellText(value:unknown,entities:Entities=[],column?:TableColumn){if(value===null||value===undefined)return '';if(column?.type==='relation')return lookup(entities,String(value))?.title||'Linked item unavailable';return Array.isArray(value)?value.join(', '):typeof value==='boolean'?value?'true':'false':String(value);}
export function matchesTableFilter(value:any,filter:TableFilter,today=todayDate()){
 const text=cellText(value).toLowerCase(),needle=(filter.value||'').toLowerCase(),date=typeof value==='string'?value.slice(0,10):'';
 switch(filter.operator){case 'empty':return value==null||value===''||Array.isArray(value)&&!value.length;case 'not-empty':return !(value==null||value===''||Array.isArray(value)&&!value.length);case 'contains':return text.includes(needle);case 'equals':return Array.isArray(value)?value.includes(filter.value):text===needle;case 'today':return date===today;case 'overdue':return validDate(date)&&date<today;case 'next-7-days':return validDate(date)&&date>=today&&date<=addDays(today,7);case 'this-week':{const weekday=dateValue(today).getUTCDay(),start=addDays(today,-((weekday+6)%7));return validDate(date)&&date>=start&&date<=addDays(start,6);}case 'before':return validDate(date)&&validDate(filter.value)&&date<filter.value;case 'after':return validDate(date)&&validDate(filter.value)&&date>filter.value;default:return true;}
}
export function visibleTableRows(data:TableData,entities:Entities=[],today=todayDate()){
 const settings=data.viewSettings,read=(row:TableRow,column:TableColumn)=>column.id===data.columns[0]?.id&&row.itemId?tableRowTitle(row,data.columns,entities):tableCellValue(row,column,entities);const rows=data.rows.filter(row=>(!settings.query||`${tableRowTitle(row,data.columns,entities)} ${data.columns.map(c=>cellText(tableCellValue(row,c,entities),entities,c)).join(' ')}`.toLowerCase().includes(settings.query.toLowerCase()))&&settings.filters.every(f=>{const col=data.columns.find(c=>c.id===f.columnId);return !!col&&matchesTableFilter(read(row,col),f,today);}));
 const column=data.columns.find(c=>c.id===settings.sortColumnId);if(column)rows.sort((a,b)=>{const av=read(a,column),bv=read(b,column);let cmp=typeof av==='number'&&typeof bv==='number'?av-bv:column.type==='priority'?(column.options||priorityOptions).indexOf(av)-(column.options||priorityOptions).indexOf(bv):cellText(av,entities,column).localeCompare(cellText(bv,entities,column),undefined,{numeric:true});return settings.sortDirection==='desc'?-cmp:cmp;});return rows;
}
export interface CellPoint {rowId:string;columnId:string}
export interface CellRange {anchor:CellPoint;focus:CellPoint}
export function rangeBounds(range:CellRange,rows:TableRow[],columns:TableColumn[]){const r1=rows.findIndex(r=>r.id===range.anchor.rowId),r2=rows.findIndex(r=>r.id===range.focus.rowId),c1=columns.findIndex(c=>c.id===range.anchor.columnId),c2=columns.findIndex(c=>c.id===range.focus.columnId);if([r1,r2,c1,c2].some(i=>i<0))return null;return {top:Math.min(r1,r2),bottom:Math.max(r1,r2),left:Math.min(c1,c2),right:Math.max(c1,c2)};}
export function encodeTSV(values:unknown[][]){return values.map(row=>row.map(value=>{const text=cellText(value);return /[\t\r\n"]/.test(text)?`"${text.replaceAll('"','""')}"`:text;}).join('\t')).join('\n');}
export function parseTSV(text:string):string[][]{
 if(text.length>1_000_000)fail('Clipboard input exceeds 1 MB.');const rows:string[][]=[[]];let field='',quoted=false,afterQuote=false;
 for(let i=0;i<text.length;i++){const ch=text[i];if(quoted){if(ch==='"'){if(text[i+1]==='"'){field+='"';i++;}else{quoted=false;afterQuote=true;}}else field+=ch;continue;}if(ch==='"'&&!field&&!afterQuote){quoted=true;continue;}if(ch==='\t'||ch==='\n'||ch==='\r'){rows.at(-1)!.push(field);field='';afterQuote=false;if(ch!=='\t'){if(ch==='\r'&&text[i+1]==='\n')i++;rows.push([]);}continue;}if(afterQuote)fail('Invalid quoted clipboard field.');field+=ch;}
 if(quoted)fail('Unclosed quoted clipboard field.');rows.at(-1)!.push(field);if(rows.length>1&&rows.at(-1)!.length===1&&rows.at(-1)![0]==='')rows.pop();if(rows.length>10000||rows.some(row=>row.length>100))fail('Clipboard range exceeds the table limits.');return rows;
}
export function applyCellMatrix(data:TableData,orderedRows:TableRow[],start:CellPoint,matrix:unknown[][]):TableData{
 const rowIndex=orderedRows.findIndex(r=>r.id===start.rowId),columnIndex=data.columns.findIndex(c=>c.id===start.columnId);if(rowIndex<0||columnIndex<0)fail('Select a cell before pasting.');
 if(rowIndex+matrix.length>orderedRows.length||matrix.some(row=>columnIndex+row.length>data.columns.length))fail('Clipboard data does not fit. Add rows or properties first.');
 const changes=new Map<string,Record<string,any>>();for(let r=0;r<matrix.length;r++){const row=orderedRows[rowIndex+r],cells={...row.cells};for(let c=0;c<matrix[r].length;c++){const column=data.columns[columnIndex+c];if(computedTypes.has(column.type)||row.itemId&&columnIndex+c===0)continue;cells[column.id]=parseCell(column,matrix[r][c]);}changes.set(row.id,cells);}
 return {...data,rows:data.rows.map(row=>{const cells=changes.get(row.id);return cells?{...row,cells,...(row.lastCompletion&&cells[row.lastCompletion.dateColumnId]!==row.cells[row.lastCompletion.dateColumnId]?{lastCompletion:undefined}:{})}:row;})};
}
export function reorderTableRow(data:TableData,id:string,beforeId:string):TableData{if(data.viewSettings.sortColumnId)fail('Manual row reordering is unavailable while a sort is active.');const source=data.rows.find(row=>row.id===id);if(!source||id===beforeId||!data.rows.some(row=>row.id===beforeId))return data;const rows=data.rows.filter(row=>row.id!==id);rows.splice(rows.findIndex(row=>row.id===beforeId),0,source);return {...data,rows};}
