import type {TableData} from '../../shared/types';
import {normalizeTableData,validateTableData,type CellPoint} from '../../shared/table';

export interface RawTableCell {point:CellPoint;text:string}
export interface RecoveredTableDraft {version:number;draft:{title:string;data:TableData};pending:RawTableCell[];savedAt:string}
const safeId=(value:unknown)=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,100}$/.test(value)&&!['__proto__','constructor','prototype'].includes(value);
export function parseTableDraft(raw:string|null):RecoveredTableDraft|null {
 if(!raw||raw.length>2_500_000)return null;
 try{
  const saved=JSON.parse(raw);
  if(!Number.isInteger(saved.version)||saved.version<1||!saved.draft||typeof saved.draft.title!=='string'||saved.draft.title.length>500||!saved.draft.data||!Array.isArray(saved.draft.data.columns)||!Array.isArray(saved.draft.data.rows))return null;
  const data=normalizeTableData(saved.draft.data);validateTableData(data,data);
  const pending=saved.pending||[];
  if(!Array.isArray(pending)||pending.length>10000||pending.some(cell=>!cell||!safeId(cell.point?.rowId)||!safeId(cell.point?.columnId)||typeof cell.text!=='string'||cell.text.length>60000))return null;
  return {version:saved.version,draft:{title:saved.draft.title,data},pending,savedAt:typeof saved.savedAt==='string'?saved.savedAt:''};
 }catch{return null;}
}
export function readTableDraft(key:string):RecoveredTableDraft|null {try{return parseTableDraft(localStorage.getItem(key));}catch{return null;}}
