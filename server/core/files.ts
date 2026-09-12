import {randomUUID} from 'node:crypto';
import {mkdir,readFile as fsReadFile,writeFile,unlink} from 'node:fs/promises';
import {createReadStream,lstatSync,realpathSync} from 'node:fs';
import path from 'node:path';
import {Router} from 'express';
import multer from 'multer';
import {BlobServiceClient} from '@azure/storage-blob';
import {DefaultAzureCredential} from '@azure/identity';
import {JSDOM} from 'jsdom';
import {Readability} from '@mozilla/readability';
import {parse as parseCsv} from 'csv-parse/sync';
import {XMLParser} from 'fast-xml-parser';
import mammoth from 'mammoth';
import {z} from 'zod';
import archiver from 'archiver';
import type {Entity, EntityInput, TableColumn, TableRow} from '../../shared/types.js';
import {requireAuth,requireEditor,requireScope} from './auth.js';
import {createEntity,entityInputSchema,listEntities,updateEntity} from './entities.js';
import {query} from './db.js';
import {httpError,safeFetch} from './security.js';
import {assertEntityAccess,runAsActor} from './access.js';
import {parseSafeXml,readEpub,readZipArchive,type ArchiveEntry} from './archives.js';
import {reserveQuota,releaseQuota,settleStorageQuota} from '../quota.js';

const MAX_UPLOAD = 25 * 1024 * 1024;
const upload = multer({storage:multer.memoryStorage(),limits:{fileSize:MAX_UPLOAD,files:1,fields:5,fieldSize:100_000}});
const withinPath = (root:string,candidate:string) => candidate===root || candidate.startsWith(root.endsWith(path.sep) ? root : root+path.sep);
function physicalPath(candidate:string):string {
  try {return realpathSync(candidate);} catch(error:any) {
    // Resolve the nearest existing ancestor before mkdir creates a new upload
    // directory. A symlink must resolve successfully, including its target.
    if(error.code!=='ENOENT' || lstatSync(candidate,{throwIfNoEntry:false})?.isSymbolicLink()) throw error;
    const parent=path.dirname(candidate);if(parent===candidate) throw error;
    return path.join(physicalPath(parent),path.basename(candidate));
  }
}
function localRoot() {
  if(process.env.NODE_ENV!=='production') return path.resolve(process.env.UPLOAD_DIR || '.data/uploads');
  if(process.env.FILE_STORAGE_BACKEND!=='local') throw httpError(503,'Private file storage is not configured.','STORAGE_UNCONFIGURED');
  const configured=process.env.UPLOAD_DIR;
  const invalid=() => httpError(503,'Production local storage requires an absolute UPLOAD_DIR outside the application and public asset directories.','STORAGE_CONFIG_INVALID');
  if(!configured || !path.isAbsolute(configured)) throw invalid();
  if(withinPath(process.cwd(),path.resolve(configured))) throw invalid();
  let root:string,protectedRoots:string[];
  try {
    root=physicalPath(path.resolve(configured));
    protectedRoots=['.','public','dist','dist-server','server','src','shared','node_modules'].map(dir=>physicalPath(path.resolve(dir)));
  } catch {throw invalid();}
  if(protectedRoots.some(protectedRoot=>withinPath(protectedRoot,root) || withinPath(root,protectedRoot))) throw invalid();
  return root;
}
function localFilePath(key:string) {
  const root=localRoot(),destination=path.resolve(root,key);
  if(destination===root || !withinPath(root,destination)) throw httpError(500,'Invalid file path.');
  const resolved=process.env.NODE_ENV==='production' ? physicalPath(destination) : destination;
  if(resolved===root || !withinPath(root,resolved)) throw httpError(500,'Invalid file path.');
  return resolved;
}
let blobClient:BlobServiceClient|undefined;
function blobs() {
  const url = process.env.AZURE_STORAGE_ACCOUNT_URL;
  if (!url) return undefined;
  blobClient ||= new BlobServiceClient(url,new DefaultAzureCredential());
  return blobClient.getContainerClient(process.env.AZURE_STORAGE_CONTAINER || 'uploads');
}
const allowedExtensions = new Set(['.txt','.md','.markdown','.csv','.json','.html','.htm','.enex','.pdf','.docx','.epub','.png','.jpg','.jpeg','.gif','.webp','.avif','.mp3','.m4a','.wav','.ogg','.mp4','.mov','.webm','.vtt','.srt']);
function safeName(name:string) {return path.basename(name.replace(/\\/g,'/')).replace(/[\u0000-\u001f\u007f]/g,'').slice(0,240) || 'file';}
const mimeByExtension:Record<string,string> = {'.txt':'text/plain','.md':'text/markdown','.markdown':'text/markdown','.csv':'text/csv','.json':'application/json','.html':'text/html','.htm':'text/html','.enex':'application/xml','.pdf':'application/pdf','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','.epub':'application/epub+zip','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.avif':'image/avif','.mp3':'audio/mpeg','.m4a':'audio/mp4','.wav':'audio/wav','.ogg':'audio/ogg','.mp4':'video/mp4','.mov':'video/quicktime','.webm':'video/webm','.vtt':'text/vtt','.srt':'text/plain'};
function validateFile(buffer:Buffer,name:string) {
  if (buffer.length > MAX_UPLOAD) throw httpError(413,'Files must be 25 MB or smaller.','FILE_TOO_LARGE');
  if (!buffer.length) throw httpError(400,'The file is empty.');
  const extension = path.extname(name).toLowerCase();
  if (!allowedExtensions.has(extension)) throw httpError(415,'This file type is not supported. Upload a document, image, audio, or video file.','FILE_TYPE');
  if (buffer.subarray(0,2).equals(Buffer.from('MZ')) || buffer.subarray(0,4).equals(Buffer.from([0x7f,0x45,0x4c,0x46]))) throw httpError(415,'Executable files are not supported.','FILE_TYPE');
  if (extension === '.pdf' && !buffer.subarray(0,5).equals(Buffer.from('%PDF-'))) throw httpError(415,'The file is not a valid PDF.');
  if (extension === '.docx' && !buffer.subarray(0,2).equals(Buffer.from('PK'))) throw httpError(415,'The file is not a valid DOCX.');
  if (extension === '.docx') validateDocumentArchive(buffer);
  if (extension === '.png' && !buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw httpError(415,'The file is not a valid PNG.');
  if (['.jpg','.jpeg'].includes(extension) && !(buffer[0]===255 && buffer[1]===216)) throw httpError(415,'The file is not a valid JPEG.');
  return {extension,mime:mimeByExtension[extension] || 'application/octet-stream'};
}
function validateDocumentArchive(buffer:Buffer) {
  const end=buffer.lastIndexOf(Buffer.from([0x50,0x4b,0x05,0x06]));
  if(end<0 || end+22>buffer.length) throw httpError(415,'The DOCX archive is invalid.');
  const entries=buffer.readUInt16LE(end+10),directorySize=buffer.readUInt32LE(end+12),directoryOffset=buffer.readUInt32LE(end+16);
  if(entries>1000 || directoryOffset+directorySize>end) throw httpError(413,'The document archive is too complex.');
  let offset=directoryOffset,total=0;
  for(let i=0;i<entries;i++) {
    if(offset+46>buffer.length || buffer.readUInt32LE(offset)!==0x02014b50) throw httpError(415,'The DOCX archive directory is invalid.');
    const uncompressed=buffer.readUInt32LE(offset+24),compressed=buffer.readUInt32LE(offset+20);
    total+=uncompressed;
    if(uncompressed>25*1024*1024 || total>50*1024*1024 || (uncompressed>1024*1024 && uncompressed/Math.max(compressed,1)>2000)) throw httpError(413,'The expanded document is too large.');
    offset+=46+buffer.readUInt16LE(offset+28)+buffer.readUInt16LE(offset+30)+buffer.readUInt16LE(offset+32);
  }
  if(offset!==directoryOffset+directorySize) throw httpError(415,'The DOCX archive directory is inconsistent.');
}
function htmlText(html:string,url?:string) {
  const dom = new JSDOM(html,{url: url || 'https://import.invalid/'});
  try {
    dom.window.document.querySelectorAll('script,style,iframe,object,embed,form').forEach(node => node.remove());
    const title = dom.window.document.title;
    const article = new Readability(dom.window.document).parse();
    return {title:article?.title || title,content:(article?.textContent || dom.window.document.body.textContent || '').trim().slice(0,1_000_000),excerpt:article?.excerpt || ''};
  } finally {dom.window.close();}
}
export async function extractText(buffer:Buffer,name:string):Promise<{text:string;warning?:string;chapters?:{title:string;content:string}[];bookTitle?:string;bookAuthor?:string}> {
  const extension = path.extname(name).toLowerCase();
  try {
    if (['.txt','.md','.markdown','.csv','.json','.vtt','.srt'].includes(extension)) return {text:buffer.toString('utf8').slice(0,1_000_000)};
    if (['.html','.htm'].includes(extension)) return {text:htmlText(buffer.toString('utf8')).content};
    if (extension === '.docx') {await readZipArchive(buffer);const result = await mammoth.extractRawText({buffer});return {text:result.value.slice(0,1_000_000)};}
    if (extension === '.epub') {const book=await readEpub(buffer,htmlText);return {text:book.text,chapters:book.chapters,bookTitle:book.title,bookAuthor:book.author};}
    if (extension === '.pdf') {
      // Import the library entry explicitly: pdf-parse's package entry executes
      // a test fixture when ESM bundling makes module.parent unavailable.
      const {default:parsePdf} = await import('pdf-parse/lib/pdf-parse.js');
      const result = await parsePdf(buffer,{max:300});return {text:result.text.slice(0,1_000_000)};
    }
    return {text:''};
  } catch (error:any) {
    console.warn('Document text extraction failed',{extension,message:error.message});
    return {text:'',warning:'The original file was saved, but text extraction failed. You can still download it.'};
  }
}

export async function saveFile(workspaceId:string,input:{buffer:Buffer;name:string;mime:string;visibility?:'workspace'|'private';parentId?:string}):Promise<Entity> {
  if(input.parentId) await assertEntityAccess(workspaceId,z.uuid().parse(input.parentId),'edit');
  const name = safeName(input.name), {mime} = validateFile(input.buffer,name);
  const key = `${workspaceId}/${randomUUID()}/${name}`;
  const container = blobs();
  const destination = container ? undefined : localFilePath(key);
  const reservation=await reserveQuota(workspaceId,'storage',input.buffer.length,{storageKey:key,backend:container?'azure':'local'});
  let entity:Entity|undefined;
  try {
    if (container) await container.getBlockBlobClient(key).uploadData(input.buffer,{blobHTTPHeaders:{blobContentType:mime,blobContentDisposition:`attachment; filename*=UTF-8''${encodeURIComponent(name)}`}});
    else {await mkdir(path.dirname(destination!),{recursive:true,mode:0o700});await writeFile(destination!,input.buffer,{mode:0o600,flag:'wx'});}
    const extracted = await extractText(input.buffer,name);
    entity = await createEntity(workspaceId,{kind:'item',title:name,content:extracted.text,visibility:input.visibility || 'workspace',parentId:input.parentId,data:{type:'file',name,mime,size:input.buffer.length,...(extracted.warning ? {extractionWarning:extracted.warning} : {}),...(extracted.chapters ? {chapters:extracted.chapters,bookTitle:extracted.bookTitle,bookAuthor:extracted.bookAuthor}: {})}});
    await settleStorageQuota(reservation,{id:entity.id,key,name,mime,size:input.buffer.length,backend:container?'azure':'local'});
    return entity;
  } catch (error) {
    if(entity){
      // A COMMIT response can be lost. Never remove an object already committed
      // to files, or one whose database state cannot currently be confirmed.
      let rows;try{rows=await query('SELECT id FROM files WHERE workspace_id=$1 AND id=$2',[workspaceId,entity.id]);}catch{throw error;}
      if(rows.length)return entity;
      await query('DELETE FROM entities WHERE workspace_id=$1 AND id=$2',[workspaceId,entity.id]).catch(cleanup=>console.warn('Upload entity cleanup failed',{message:cleanup.message}));
    }
    let removed=false;
    if(container){try{await container.getBlockBlobClient(key).deleteIfExists();removed=true;}catch(cleanup:any){console.warn('Blob cleanup failed; quota reservation retained',{message:cleanup.message,reservationId:reservation.id});}}
    else {try{await unlink(destination!);removed=true;}catch(cleanup:any){removed=['ENOENT','ENOTDIR'].includes(cleanup.code);if(!removed)console.warn('Upload cleanup failed; quota reservation retained',{message:cleanup.message,reservationId:reservation.id});}}
    if(removed)await releaseQuota(reservation).catch(cleanup=>console.warn('Upload reservation cleanup failed',{message:cleanup.message,reservationId:reservation.id}));
    throw error;
  }
}

export async function readFile(workspaceId:string,id:string):Promise<{buffer:Buffer;mime:string;name:string}> {
  await assertEntityAccess(workspaceId,z.uuid().parse(id));
  return readStoredFile(workspaceId,id);
}
export async function readGrantedFile(workspaceId:string,id:string,tokenHash:string):Promise<{buffer:Buffer;mime:string;name:string}> {
  const [grant]=await query('SELECT entity_id FROM media_grants WHERE workspace_id=$1 AND entity_id=$2 AND token_hash=$3 AND expires_at>now()',[workspaceId,z.uuid().parse(id),tokenHash]);
  if(!grant) throw httpError(404,'This media grant is invalid or expired.');
  const file=await readStoredFile(workspaceId,id);
  if(!/^(image\/(png|jpeg|webp|gif)|video\/|audio\/)/.test(file.mime)) throw httpError(403,'This grant is not for publishable media.');
  return file;
}
async function readStoredFile(workspaceId:string,id:string):Promise<{buffer:Buffer;mime:string;name:string}> {
  const [file] = await query('SELECT f.* FROM files f JOIN entities e ON e.id=f.id AND e.workspace_id=f.workspace_id WHERE f.workspace_id=$1 AND f.id=$2 AND e.deleted_at IS NULL', [workspaceId,z.uuid().parse(id)]);
  if (!file) throw httpError(404,'File not found.','NOT_FOUND');
  let buffer:Buffer;
  if (file.backend === 'azure') {
    const container = blobs();if (!container) throw httpError(503,'Private file storage is not configured.');
    buffer = await container.getBlockBlobClient(file.storage_key).downloadToBuffer();
  } else {
    buffer = await fsReadFile(localFilePath(file.storage_key));
  }
  return {buffer,mime:file.mime,name:file.original_name};
}

export async function captureUrl(workspaceId:string,input:{url:string;title?:string;content?:string;tags?:string[];parentId?:string}) {
  const parsed = z.object({url:z.url().max(4000),title:z.string().max(500).optional(),content:z.string().max(1_000_000).optional(),tags:z.array(z.string().max(80)).max(100).optional(),parentId:z.uuid().optional()}).strict().parse(input);
  if(parsed.parentId) await assertEntityAccess(workspaceId,parsed.parentId,'edit');
  // Even browser-supplied text must have a safe HTTP URL. It is never fetched
  // when capture already includes selected content, making extension capture
  // useful for authenticated pages without transmitting session credentials.
  const url = new URL(parsed.url);
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password) throw httpError(400,'Enter an HTTP or HTTPS URL.');
  let title = parsed.title || url.hostname, content = parsed.content || '', excerpt = '', fetchedUrl = url.href;
  if (!parsed.content) {
    const response = await safeFetch(url.href,{maxBytes:5*1024*1024});
    if (!response.ok) throw httpError(422,`The page returned HTTP ${response.status}. Use the browser extension to save selected text from pages requiring sign-in.`,'CAPTURE_FAILED');
    const mime = response.headers.get('content-type') || '';
    if (!/text\/html|text\/plain|application\/xhtml\+xml/.test(mime)) throw httpError(415,'This URL is not a web page. Upload the file instead.');
    const raw = await response.text();fetchedUrl=response.url || url.href;
    const article = mime.includes('html') ? htmlText(raw,fetchedUrl) : {title:'',content:raw.slice(0,1_000_000),excerpt:''};
    title=parsed.title || article.title || title;content=article.content;excerpt=article.excerpt;
  }
  return createEntity(workspaceId,{kind:'item',title:title.slice(0,500),content,parentId:parsed.parentId,data:{type:'link',url:fetchedUrl,excerpt:excerpt.slice(0,1000),capturedAt:new Date().toISOString(),captureSource:parsed.content ? 'user-selection' : 'remote-page'},tags:parsed.tags || []});
}

function importedTitle(name:string) {return path.basename(name,path.extname(name)).slice(0,500) || 'Imported document';}
export function parseImport(buffer:Buffer,name:string,format='auto'):EntityInput[] {
  if (buffer.length > MAX_UPLOAD) throw httpError(413,'Imports must be 25 MB or smaller.');
  const raw = buffer.toString('utf8').replace(/^\uFEFF/,''), extension = path.extname(name).toLowerCase();
  const detected = format === 'auto' ? ({'.csv':'csv','.json':'json','.enex':'enex','.html':'html','.htm':'html'}[extension] || 'markdown') : format;
  let entities:EntityInput[];
  if (detected === 'csv') {
    let records:string[][];
    try {records=parseCsv(raw,{bom:true,skip_empty_lines:true,relax_column_count:false,max_record_size:1_000_000});} catch {throw httpError(400,'This CSV could not be parsed. Check row lengths and quoting.','IMPORT_INVALID');}
    if (!records.length) throw httpError(400,'The CSV is empty.');
    if (records.length>10001 || records[0].length>100) throw httpError(400,'A CSV table supports up to 10,000 rows and 100 columns.');
    const columns:TableColumn[] = records[0].map((name,i) => ({id:`col_${i}`,name:name.slice(0,100) || `Column ${i+1}`,type:'text'}));
    const rows:TableRow[] = records.slice(1).map(record => ({id:randomUUID(),cells:Object.fromEntries(columns.map((col,i) => [col.id,record[i] || '']))}));
    entities=[{kind:'table',title:importedTitle(name),data:{columns,rows,view:'table',importedFrom:'csv'}}];
  } else if (detected === 'json') {
    let parsed:any;try {parsed=JSON.parse(raw);} catch {throw httpError(400,'This file is not valid JSON.','IMPORT_INVALID');}
    const records = Array.isArray(parsed) ? parsed : Array.isArray(parsed.entities) ? parsed.entities : [parsed];
    if (records.length>2000) throw httpError(400,'Import at most 2,000 entities at a time.');
    // Export IDs are intentionally not trusted. Import creates independent
    // documents/tables; no old tenant IDs become access or source pointers.
    entities=records.map((record:any) => {
      if (!record || typeof record !== 'object') throw httpError(400,'Each imported entity must be an object.');
      const kind = ['item','board','space','table','creator','creator-list','brand','custom-ai','voice','draft'].includes(record.kind) ? record.kind : 'item';
      const data = {...(record.data && typeof record.data === 'object' && !Array.isArray(record.data) ? record.data : {}),importedFrom:'json'};
      for (const key of ['sourceIds','sourceId','itemIds','creatorIds','mediaIds','connections','connectionIds','placements','spaceId','fileId','receipts','publishJobId','publishedAt','scheduledAt','approvedAt','approvedBy']) delete data[key];
      if (kind === 'draft') data.status='draft';
      if (data.type === 'file') data.type='document';
      return {kind,title:typeof record.title === 'string' ? record.title : importedTitle(name),content:typeof record.content === 'string' ? record.content : '',tags:Array.isArray(record.tags) ? record.tags : [],data} as EntityInput;
    });
  } else if (detected === 'enex') {
    if (/<!\s*(DOCTYPE|ENTITY)/i.test(raw)) throw httpError(400,'XML entity declarations are not supported.');
    let parsed:any;try {parsed=new XMLParser({ignoreAttributes:false,processEntities:false,htmlEntities:false,parseTagValue:false,cdataPropName:'__cdata'}).parse(raw);} catch {throw httpError(400,'This Evernote export could not be parsed.');}
    const notes = parsed?.['en-export']?.note;
    if (!notes) throw httpError(400,'This file contains no Evernote notes.');
    const records = Array.isArray(notes) ? notes : [notes];
    if (records.length>2000) throw httpError(400,'Import at most 2,000 notes at a time.');
    entities=records.map((note:any) => ({kind:'item',title:String(note.title || 'Imported note').slice(0,500),content:htmlText(typeof note.content === 'string' ? note.content : note.content?.__cdata || '').content,tags:(Array.isArray(note.tag) ? note.tag : note.tag ? [note.tag] : []).map(String).slice(0,100),data:{type:'document',importedFrom:'evernote',...(note.resource ? {importWarning:'Embedded Evernote attachments are not imported; upload the original files separately.'} : {})}}));
  } else if (detected === 'html') {
    const article=htmlText(raw);entities=[{kind:'item',title:article.title.slice(0,500) || importedTitle(name),content:article.content,data:{type:'document',importedFrom:'html'}}];
  } else if (detected === 'markdown') {
    if (raw.length>1_000_000) throw httpError(413,'A document supports up to 1 million characters.');
    const title=raw.match(/^#\s+(.+)$/m)?.[1] || importedTitle(name);
    entities=[{kind:'item',title:title.slice(0,500),content:raw,data:{type:'document',importedFrom:'markdown'}}];
  } else throw httpError(400,'Unsupported import format.');
  return entities.map(entity => entityInputSchema.parse(entity));
}

export async function importArchive(workspaceId:string,buffer:Buffer) {
  const entries=(await readZipArchive(buffer)).filter(entry=>!entry.path.startsWith('__MACOSX/') && !entry.path.split('/').some(part=>part.startsWith('.')));
  const notes:{entry:ArchiveEntry;input:EntityInput}[]=[],attachments:ArchiveEntry[]=[],warnings:string[]=[];
  for(const entry of entries) {
    const ext=path.posix.extname(entry.path).toLowerCase();
    if(['.md','.markdown','.csv','.html','.htm'].includes(ext)) {
      for(const input of parseImport(entry.buffer,path.posix.basename(entry.path))) notes.push({entry,input:{...input,data:{...input.data,importedFrom:'notion-or-obsidian',importPath:entry.path}}});
    } else if(allowedExtensions.has(ext) && !['.enex'].includes(ext)) {
      validateFile(entry.buffer,path.posix.basename(entry.path));attachments.push(entry);
    } else warnings.push(`Skipped unsupported archive entry: ${entry.path.slice(0,160)}`);
  }
  if(!notes.length && !attachments.length) throw httpError(400,'The archive contains no supported notes or attachments.');
  const entities:Entity[]=[],paths=new Map<string,Entity>();
  for(const entry of attachments) {const entity=await saveFile(workspaceId,{buffer:entry.buffer,name:path.posix.basename(entry.path),mime:''});paths.set(entry.path,entity);entities.push(entity);}
  for(const {entry,input} of notes) {const entity=await createEntity(workspaceId,input);paths.set(entry.path,entity);entities.push(entity);}
  for(const {entry} of notes) {
    const entity=paths.get(entry.path)!;if(!entity.content) continue;
    const references=new Set<string>();
    const resolve=(target:string,wiki=false) => {
      let decoded:string;try{decoded=decodeURIComponent(target.split('#')[0]);}catch{return null;}
      if(!decoded || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(decoded)) return null;
      const candidate=path.posix.normalize(path.posix.join(path.posix.dirname(entry.path),decoded));
      let found=paths.get(candidate) || paths.get(`${candidate}.md`);
      if(!found && wiki) found=[...paths.entries()].find(([name])=>path.posix.basename(name,path.posix.extname(name)).toLowerCase()===decoded.toLowerCase())?.[1];
      if(!found) return null;references.add(found.id);
      return found.data.type==='file' ? `/api/files/${found.id}`:`/library?open=${found.id}`;
    };
    let content=entity.content.replace(/(!?\[[^\]\n]*\]\()([^\s)]+)(\))/g,(_match,prefix,target,suffix)=>`${prefix}${resolve(target)||target}${suffix}`);
    content=content.replace(/!?\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/g,(match,target,label)=>{const link=resolve(target,true);return link ? `[${label || target}](${link})`:match;});
    const updated=await updateEntity(workspaceId,entity.id,{content,data:{...entity.data,sourceIds:[...references].filter(id=>id!==entity.id)}});
    entities[entities.findIndex(v=>v.id===entity.id)]=updated;
  }
  return {entities,count:entities.length,warnings};
}

export async function importEvernote(workspaceId:string,buffer:Buffer,name:string) {
  const raw=buffer.toString('utf8'),parsed=parseSafeXml(raw),notesValue=parsed?.['en-export']?.note;
  const notes=Array.isArray(notesValue) ? notesValue : notesValue ? [notesValue]:[];
  const inputs=parseImport(buffer,name,'enex');
  const attachments:{noteIndex:number;name:string;buffer:Buffer;mime:string}[]=[],warnings:string[]=[];
  let total=0;
  for(let noteIndex=0;noteIndex<notes.length;noteIndex++) {
    const resources=Array.isArray(notes[noteIndex].resource) ? notes[noteIndex].resource : notes[noteIndex].resource ? [notes[noteIndex].resource]:[];
    for(const resource of resources) {
      const mime=String(resource.mime || 'application/octet-stream');
      const ext=Object.entries(mimeByExtension).find(([,value])=>value===mime)?.[0];
      const name=safeName(String(resource['resource-attributes']?.['file-name'] || `Evernote attachment ${attachments.length+1}${ext || '.bin'}`));
      const encoded=String(typeof resource.data==='string' ? resource.data : resource.data?.__cdata || resource.data?.['#text'] || '').replace(/\s/g,'');
      if(!ext || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length>Math.ceil(MAX_UPLOAD/3)*4) {warnings.push(`Skipped unsupported Evernote attachment: ${name}`);continue;}
      const data=Buffer.from(encoded,'base64');total+=data.length;
      if(total>100*1024*1024 || attachments.length>=1000) throw httpError(413,'Evernote attachments exceed the import limits.');
      try {validateFile(data,name);} catch(error:any) {warnings.push(`Skipped ${name}: ${error.message}`);continue;}
      attachments.push({noteIndex,name,buffer:data,mime});
    }
  }
  const entities:Entity[]=[],byNote=new Map<number,Entity[]>();
  for(const attachment of attachments) {const entity=await saveFile(workspaceId,attachment);entities.push(entity);byNote.set(attachment.noteIndex,[...(byNote.get(attachment.noteIndex) || []),entity]);}
  for(let index=0;index<inputs.length;index++) {
    const input=inputs[index],saved=byNote.get(index) || [],data:Record<string,any>={...input.data,sourceIds:saved.map(file=>file.id)};delete data.importWarning;
    const content=`${input.content || ''}${saved.length ? '\n\nAttachments\n\n'+saved.map(file=>`- [${file.title}](/api/files/${file.id})`).join('\n'):''}`;
    entities.push(await createEntity(workspaceId,{...input,content,data}));
  }
  return {entities,count:entities.length,warnings};
}

const csvCell=(value:unknown) => {
  let text=String(value ?? '');if(/^[=+@-]/.test(text)) text=`'${text}`;
  return `"${text.replaceAll('"','""')}"`;
};
async function exportZip(workspaceId:string,res:import('express').Response) {
  const entities=await listEntities(workspaceId),ids=entities.map(entity=>entity.id);
  const uploads=ids.length ? await query('SELECT * FROM files WHERE workspace_id=$1 AND id=ANY($2::uuid[])',[workspaceId,ids]):[];
  const estimated=entities.reduce((sum,entity)=>sum+Buffer.byteLength(entity.content)+Buffer.byteLength(JSON.stringify(entity.data)),0)+uploads.reduce((sum,file)=>sum+Number(file.size),0);
  if(estimated>200*1024*1024 || uploads.length>1000) throw httpError(413,'This export exceeds 200 MB. Export smaller workspaces separately.');
  const archive=archiver('zip',{zlib:{level:6}}),date=new Date().toISOString().slice(0,10);
  res.set({'Content-Type':'application/zip','Content-Disposition':`attachment; filename="grove-export-${date}.zip"`,'Cache-Control':'no-store'});
  archive.on('warning',error=>console.warn('Export archive warning',{message:error.message}));
  archive.on('error',error=>{console.error('Export archive failed',{message:error.message});res.destroy(error);});
  res.on('close',()=>{if(!res.writableFinished) archive.abort();});archive.pipe(res);
  const exportedFiles=new Map(uploads.map(file=>[file.id,`uploads/${file.id}-${safeName(file.original_name)}`]));
  const noteNames=new Map(entities.map(entity=>[entity.id,`notes/${entity.id}-${safeName(entity.title)}.md`]));
  const relativeLinks=(content:string) => content.replace(/\/api\/files\/([a-f\d-]{36})/gi,(match,id)=>exportedFiles.has(id) ? `../${exportedFiles.get(id)}`:match).replace(/\/library\?open=([a-f\d-]{36})/gi,(match,id)=>noteNames.has(id) ? path.posix.basename(noteNames.get(id)!):match);
  archive.append(JSON.stringify({format:'grove-export-v1',exportedAt:new Date().toISOString(),entities,files:Object.fromEntries(exportedFiles)},null,2),{name:'grove-export.json'});
  archive.append(['Title,URL,Tags',...entities.filter(entity=>entity.data.url).map(entity=>[entity.title,entity.data.url,entity.tags.join(';')].map(csvCell).join(','))].join('\r\n'),{name:'links.csv'});
  for(const entity of entities) {
    archive.append(`# ${entity.title}\n\n${entity.tags.length ? `Tags: ${entity.tags.join(', ')}\n\n`:''}${relativeLinks(entity.content)}\n`,{name:noteNames.get(entity.id)!});
    if(entity.kind==='table' && Array.isArray(entity.data.columns) && Array.isArray(entity.data.rows)) {
      const columns=entity.data.columns,rows=entity.data.rows;
      const csv=[columns.map((column:any)=>csvCell(column.name)).join(','),...rows.map((row:any)=>columns.map((column:any)=>csvCell(row.cells?.[column.id])).join(','))].join('\r\n');
      archive.append(csv,{name:`tables/${entity.id}-${safeName(entity.title)}.csv`});
    }
  }
  for(const file of uploads) {
    if(file.backend==='azure') {
      const container=blobs();if(!container) throw httpError(503,'Private file storage is not configured.');
      const download=await container.getBlobClient(file.storage_key).download();
      if(download.readableStreamBody) archive.append(download.readableStreamBody as import('node:stream').Readable,{name:exportedFiles.get(file.id)!});
    } else {
      archive.append(createReadStream(localFilePath(file.storage_key)),{name:exportedFiles.get(file.id)!});
    }
  }
  await archive.finalize();
}

export const fileRouter = Router();
fileRouter.post('/uploads',requireAuth,requireEditor,requireScope('files:write'),upload.single('file'),async (req,res) => {
  if (!req.file) throw httpError(400,'Choose a file to upload.');
  const parentId=z.uuid().optional().parse(req.body?.parentId);
  const visibility=z.enum(['workspace','private']).optional().parse(req.body?.visibility);
  const entity=await saveFile(req.auth!.workspaceId,{buffer:req.file.buffer,name:req.file.originalname,mime:req.file.mimetype,parentId,visibility});
  res.status(201).json({entity});
});
fileRouter.get('/files/:id',requireAuth,requireScope('files:read'),async (req,res) => {
  const id=z.uuid().parse(req.params.id);
  // Browser image/video URLs cannot attach a workspace header. Infer a target
  // only for session requests, and recheck both membership and the entity ACL.
  const [target]=!req.auth.scopes && !req.get('x-workspace-id') ? await query('SELECT f.workspace_id FROM files f JOIN memberships m ON m.workspace_id=f.workspace_id WHERE f.id=$1 AND m.user_id=$2',[id,req.auth.userId]):[];
  const file=target ? await runAsActor(target.workspace_id,req.auth.userId,()=>readFile(target.workspace_id,id)):await readFile(req.auth!.workspaceId,id);
  res.set({'Content-Type':file.mime,'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,'X-Content-Type-Options':'nosniff','Cache-Control':'private, no-store','Content-Security-Policy':"sandbox; default-src 'none'"}).send(file.buffer);
});
fileRouter.post('/capture',requireAuth,requireEditor,requireScope('workspace:write'),async (req,res) => res.status(201).json({entity:await captureUrl(req.auth!.workspaceId,req.body)}));
fileRouter.post('/imports',requireAuth,requireEditor,requireScope('workspace:write'),upload.single('file'),async (req,res) => {
  if (!req.file) throw httpError(400,'Choose a file to import.');
  const format=z.enum(['auto','markdown','csv','json','enex','html','zip']).default('auto').parse(req.body?.format);
  if(format==='zip' || (format==='auto' && path.extname(req.file.originalname).toLowerCase()==='.zip')) {res.status(201).json(await importArchive(req.auth.workspaceId,req.file.buffer));return;}
  if(format==='enex' || (format==='auto' && path.extname(req.file.originalname).toLowerCase()==='.enex')) {res.status(201).json(await importEvernote(req.auth.workspaceId,req.file.buffer,req.file.originalname));return;}
  const inputs=parseImport(req.file.buffer,req.file.originalname,format);
  const entities:Entity[]=[];
  for (const input of inputs) entities.push(await createEntity(req.auth!.workspaceId,input));
  res.status(201).json({entities,count:entities.length});
});
fileRouter.get('/export',requireAuth,requireScope('workspace:read'),async (req,res) => {
  const format=z.enum(['json','markdown','zip']).default('json').parse(req.query.format);
  if(format==='zip') {await exportZip(req.auth.workspaceId,res);return;}
  const entities=await listEntities(req.auth!.workspaceId);
  const date=new Date().toISOString().slice(0,10);
  if (format==='json') res.set({'Content-Type':'application/json','Content-Disposition':`attachment; filename="grove-export-${date}.json"`}).send(JSON.stringify({format:'grove-export-v1',exportedAt:new Date().toISOString(),entities},null,2));
  else res.set({'Content-Type':'text/markdown; charset=utf-8','Content-Disposition':`attachment; filename="grove-export-${date}.md"`}).send(entities.map(entity => `# ${entity.title}\n\n${entity.tags.length ? `Tags: ${entity.tags.join(', ')}\n\n` : ''}${entity.content || (entity.kind==='table' ? JSON.stringify(entity.data,null,2) : '')}\n\n---\n`).join('\n'));
});
