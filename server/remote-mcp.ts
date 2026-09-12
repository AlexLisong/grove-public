import {Router} from 'express';
import {z} from 'zod';
import archiver from 'archiver';
import path from 'node:path';
import {requireAuth,requireEditor,requireAdmin,requireScope} from './core/auth.js';
import {query} from './core/db.js';
import {safeFetch,httpError} from './core/security.js';
import {getConnection,connectionCredentials} from './integrations.js';
import {enqueue} from './core/jobs.js';
import {getEntity} from './core/entities.js';

interface RemoteSession {url:string;headers:Record<string,string>;sessionId?:string}
function remoteResult(text:string,contentType:string,id:number){
 if(contentType.includes('text/event-stream')){
  const events=text.split(/\r?\n\r?\n/).map(block=>block.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n')).filter(Boolean);
  for(const event of events.reverse()){try{const json=JSON.parse(event);if(json.id===id)return json;}catch{}}
  throw httpError(502,'The remote MCP server returned no matching response');
 }
 try{return JSON.parse(text);}catch{throw httpError(502,'The remote MCP server returned invalid JSON');}
}
async function rpc(session:RemoteSession,method:string,params:any,id:number|undefined){
 const response=await safeFetch(session.url,{method:'POST',headers:{...session.headers,...(session.sessionId?{'Mcp-Session-Id':session.sessionId}:{}),'MCP-Protocol-Version':'2025-03-26'},body:JSON.stringify({jsonrpc:'2.0',...(id===undefined?{}:{id}),method,params}),timeoutMs:45000,maxBytes:5*1024*1024});
 if(!response.ok)throw httpError(502,`Remote MCP request failed (${response.status}). Check the connection and permissions.`);
 const sessionId=response.headers.get('mcp-session-id');if(sessionId)session.sessionId=sessionId;
 if(id===undefined)return undefined;
 const result=remoteResult(await response.text(),response.headers.get('content-type')||'',id);
 if(result.error)throw httpError(502,`Remote MCP returned error code ${Number(result.error.code)||'unknown'}`);
 return result.result;
}
async function sessionFor(credentials:Record<string,string>){
 const u=new URL(credentials.url);if(u.protocol!=='https:')throw httpError(400,'Remote MCP connections require HTTPS');
 const session:RemoteSession={url:u.toString(),headers:{Accept:'application/json, text/event-stream','Content-Type':'application/json',...(credentials.apiKey?{Authorization:`Bearer ${credentials.apiKey}`}:{})}};
 const result=await rpc(session,'initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'Grove',version:'0.1.0'}},1);
 await rpc(session,'notifications/initialized',{},undefined);return {session,result};
}
async function close(session:RemoteSession){if(session.sessionId){try{await safeFetch(session.url,{method:'DELETE',headers:{...session.headers,'Mcp-Session-Id':session.sessionId},timeoutMs:5000,maxBytes:10000});}catch{/* Session expiry is safe; provider session cleanup is best effort. */}}}
export async function inspectRemote(credentials:Record<string,string>){const {session,result}=await sessionFor(credentials);try{const catalog=await rpc(session,'tools/list',{},2);return {name:result.serverInfo?.name||'Remote MCP',serverInfo:result.serverInfo,tools:(catalog.tools||[]).slice(0,500),nextCursor:catalog.nextCursor};}finally{await close(session);}}
export async function executeRemote(credentials:Record<string,string>,name:string,args:any){const {session}=await sessionFor(credentials);try{return await rpc(session,'tools/call',{name,arguments:args},3);}finally{await close(session);}}

export const remoteRouter=Router();
remoteRouter.get('/connections/:id/tools',requireAuth,requireScope('connections:read'),async(req,res)=>{
 const c=await getConnection(req.auth.workspaceId,z.uuid().parse(req.params.id));if(c.provider!=='mcp')throw httpError(400,'This connection is not a remote MCP server');const result=await inspectRemote(connectionCredentials(c));
 res.json({tools:result.tools,enabledTools:c.data.allowedTools||[],nextCursor:result.nextCursor});
});
remoteRouter.patch('/connections/:id/tools',requireAuth,requireAdmin,requireScope('workspace:write'),async(req,res)=>{
 const b=z.object({enabledTools:z.array(z.string().max(200)).max(500)}).parse(req.body),c=await getConnection(req.auth.workspaceId,z.uuid().parse(req.params.id));if(c.provider!=='mcp')throw httpError(400,'This connection is not a remote MCP server');
 const result=await inspectRemote(connectionCredentials(c)),names=new Set(result.tools.map((t:any)=>t.name));if(b.enabledTools.some(t=>!names.has(t)))throw httpError(400,'One of these tools is not in the current server catalog');
 await query('UPDATE connections SET data=data||$3::jsonb WHERE id=$1 AND workspace_id=$2',[c.id,req.auth.workspaceId,JSON.stringify({allowedTools:b.enabledTools})]);res.json({enabledTools:b.enabledTools});
});
remoteRouter.post('/connections/:id/tools/call',requireAuth,requireEditor,requireScope('workspace:write'),requireScope('publish:write'),async(req,res)=>{
 const b=z.object({name:z.string().max(200),arguments:z.record(z.string(),z.unknown()).default({}),confirm:z.literal(true)}).parse(req.body),c=await getConnection(req.auth.workspaceId,z.uuid().parse(req.params.id));if(c.provider!=='mcp')throw httpError(400,'This connection is not a remote MCP server');if(!c.data.allowedTools?.includes(b.name))throw httpError(403,'Enable this remote tool in the connection before using it');
 res.json({result:await executeRemote(connectionCredentials(c),b.name,b.arguments),source:'remote-mcp',untrusted:true});
});
remoteRouter.get('/extension/download',requireAuth,requireScope('workspace:read'),async(_req,res)=>{
 res.setHeader('Content-Type','application/zip');res.setHeader('Content-Disposition','attachment; filename="grove-capture.zip"');const archive=archiver('zip',{zlib:{level:6}});archive.on('error',()=>res.destroy());archive.pipe(res);archive.directory(path.resolve(process.cwd(),'extension'),false);await archive.finalize();
});
remoteRouter.post('/ai/research',requireAuth,requireEditor,requireScope('ai:run'),async(req,res)=>{
 const b=z.object({input:z.string().min(1).max(30000),title:z.string().max(200).optional(),mode:z.enum(['social','synthesis']).default('synthesis'),sourceIds:z.array(z.uuid()).max(80).default([]),customAiId:z.uuid().optional()}).parse(req.body);
 const queued=await (await import('./workflow-engine.js')).queueDeepResearch(req.auth.workspaceId,b);res.status(202).json({job:queued.job});
});
