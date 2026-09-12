import {inflateRaw,crc32} from 'node:zlib';
import {promisify} from 'node:util';
import path from 'node:path';
import {XMLParser} from 'fast-xml-parser';
import {httpError} from './security.js';

const inflate=promisify(inflateRaw);
const MAX_ENTRY=25*1024*1024,MAX_EXPANDED=100*1024*1024,MAX_ENTRIES=1000;
export interface ArchiveEntry {path:string;buffer:Buffer}
export function archivePath(name:string) {
  let decoded:string;try {decoded=decodeURIComponent(name);} catch {decoded=name;}
  decoded=decoded.replaceAll('\\','/');
  if(decoded.includes('\0') || decoded.startsWith('/') || /^[A-Za-z]:/.test(decoded) || decoded.split('/').includes('..')) throw httpError(400,'Archive paths cannot escape the import folder.','ARCHIVE_PATH');
  return path.posix.normalize(decoded).replace(/^\.\//,'');
}
export async function readZipArchive(buffer:Buffer):Promise<ArchiveEntry[]> {
  if(buffer.length>25*1024*1024) throw httpError(413,'Archives must be 25 MB or smaller.');
  // Only a complete classic ZIP central directory is accepted. ZIP64,
  // encrypted archives, nested archives, and symlinks are not interpreted.
  const signature=Buffer.from([0x50,0x4b,0x05,0x06]);
  let end=buffer.lastIndexOf(signature);
  while(end>=0 && (end+22>buffer.length || end+22+buffer.readUInt16LE(end+20)!==buffer.length)) end=buffer.lastIndexOf(signature,end-1);
  if(end<0) throw httpError(400,'This ZIP archive is incomplete or invalid.','ARCHIVE_INVALID');
  const disk=buffer.readUInt16LE(end+4),directoryDisk=buffer.readUInt16LE(end+6),entries=buffer.readUInt16LE(end+10),directorySize=buffer.readUInt32LE(end+12),directoryOffset=buffer.readUInt32LE(end+16);
  if(disk || directoryDisk || entries===65535 || directoryOffset===0xffffffff || directorySize===0xffffffff) throw httpError(415,'Multi-volume and ZIP64 archives are not supported.');
  if(entries>MAX_ENTRIES || directoryOffset+directorySize>end) throw httpError(413,'Import at most 1,000 files per archive.');
  const metadata:{name:string;compressed:number;expanded:number;offset:number;method:number;checksum:number}[]=[];
  const names=new Set<string>();let cursor=directoryOffset,total=0;
  for(let index=0;index<entries;index++) {
    if(cursor+46>buffer.length || buffer.readUInt32LE(cursor)!==0x02014b50) throw httpError(400,'Invalid ZIP directory.');
    const flags=buffer.readUInt16LE(cursor+8),method=buffer.readUInt16LE(cursor+10),checksum=buffer.readUInt32LE(cursor+16),compressed=buffer.readUInt32LE(cursor+20),expanded=buffer.readUInt32LE(cursor+24),nameSize=buffer.readUInt16LE(cursor+28),extraSize=buffer.readUInt16LE(cursor+30),commentSize=buffer.readUInt16LE(cursor+32),attributes=buffer.readUInt32LE(cursor+38),offset=buffer.readUInt32LE(cursor+42);
    if(cursor+46+nameSize+extraSize+commentSize>directoryOffset+directorySize) throw httpError(400,'Truncated ZIP entry.');
    const name=archivePath(buffer.subarray(cursor+46,cursor+46+nameSize).toString('utf8'));
    if(flags&1 || ![0,8].includes(method)) throw httpError(415,'Encrypted or unsupported ZIP compression is not supported.');
    if(((attributes>>>16)&0o170000)===0o120000) throw httpError(400,'Archive symlinks are not supported.','ARCHIVE_PATH');
    total+=expanded;
    if(expanded>MAX_ENTRY || total>MAX_EXPANDED || (expanded>1024*1024 && expanded/Math.max(compressed,1)>2000)) throw httpError(413,'The expanded archive exceeds the import limits.','ARCHIVE_TOO_LARGE');
    if(names.has(name)) throw httpError(400,'The archive contains duplicate file paths.');names.add(name);
    if(!name.endsWith('/')) metadata.push({name,compressed,expanded,offset,method,checksum});
    cursor+=46+nameSize+extraSize+commentSize;
  }
  if(cursor!==directoryOffset+directorySize) throw httpError(400,'The ZIP directory size is inconsistent.');
  const output:ArchiveEntry[]=[];
  for(const entry of metadata) {
    const offset=entry.offset;
    if(offset+30>directoryOffset || buffer.readUInt32LE(offset)!==0x04034b50) throw httpError(400,'Invalid ZIP file header.');
    const nameSize=buffer.readUInt16LE(offset+26),extraSize=buffer.readUInt16LE(offset+28),start=offset+30+nameSize+extraSize;
    if(start+entry.compressed>directoryOffset || buffer.readUInt16LE(offset+8)!==entry.method) throw httpError(400,'The ZIP file header does not match its directory.');
    const localName=archivePath(buffer.subarray(offset+30,offset+30+nameSize).toString('utf8'));
    if(localName!==entry.name) throw httpError(400,'The ZIP filename does not match its directory.');
    const compressed=buffer.subarray(start,start+entry.compressed);
    let expanded:Buffer;
    try {expanded=entry.method===0 ? Buffer.from(compressed):await inflate(compressed,{maxOutputLength:Math.max(entry.expanded,1)});} catch {throw httpError(400,'A ZIP entry could not be safely decompressed.','ARCHIVE_INVALID');}
    if(expanded.length!==entry.expanded || crc32(expanded)!==entry.checksum) throw httpError(400,'A ZIP entry failed its integrity check.','ARCHIVE_INVALID');
    output.push({path:entry.name,buffer:expanded});
  }
  return output;
}
export function parseSafeXml(text:string):any {
  if(/<!\s*(DOCTYPE|ENTITY)/i.test(text)) throw httpError(400,'XML entity declarations are not supported.');
  return new XMLParser({ignoreAttributes:false,processEntities:false,htmlEntities:false,parseTagValue:false,cdataPropName:'__cdata'}).parse(text);
}
const array=(value:any):any[]=>value ? Array.isArray(value) ? value:[value]:[];
export async function readEpub(buffer:Buffer,toText:(html:string)=>{title:string;content:string}) {
  const entries=await readZipArchive(buffer),byPath=new Map(entries.map(entry=>[entry.path,entry.buffer]));
  const container=byPath.get('META-INF/container.xml');if(!container) throw httpError(400,'This EPUB has no package metadata.');
  const containerXml=parseSafeXml(container.toString('utf8'));
  const packagePath=archivePath(array(containerXml?.container?.rootfiles?.rootfile)[0]?.['@_full-path'] || '');
  const packageBytes=byPath.get(packagePath);if(!packageBytes) throw httpError(400,'This EPUB package could not be found.');
  const pkg=parseSafeXml(packageBytes.toString('utf8'))?.package;
  const manifest=new Map(array(pkg?.manifest?.item).map(item=>[item['@_id'],item]));
  const title=String(pkg?.metadata?.['dc:title'] || 'Untitled book').slice(0,500),author=String(pkg?.metadata?.['dc:creator'] || '').slice(0,500);
  const chapters:{title:string;content:string}[]=[];let length=0;
  for(const ref of array(pkg?.spine?.itemref).slice(0,500)) {
    const item=manifest.get(ref['@_idref']);if(!item || !/html|xhtml/.test(item['@_media-type'] || '')) continue;
    const href=String(item['@_href'] || '').split('#')[0];
    // Resolve ordinary ../ links within the archive, then enforce its root.
    const target=path.posix.normalize(path.posix.join(path.posix.dirname(packagePath),decodeURIComponent(href)));
    if(target.startsWith('../') || target.startsWith('/')) throw httpError(400,'EPUB chapter paths escape the archive.');
    const chapterBytes=byPath.get(target);if(!chapterBytes) continue;
    const text=toText(chapterBytes.toString('utf8'));if(!text.content) continue;
    const remaining=Math.max(0,900_000-length);if(!remaining) break;
    chapters.push({title:text.title || `Chapter ${chapters.length+1}`,content:text.content.slice(0,remaining)});length+=text.content.length;
  }
  if(!chapters.length) throw httpError(400,'No readable chapters were found in this EPUB.');
  return {title,author,chapters,text:chapters.map(chapter=>`## ${chapter.title}\n\n${chapter.content}`).join('\n\n').slice(0,1_000_000)};
}
