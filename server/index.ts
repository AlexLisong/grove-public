import {clientRateKey} from './core/rate-limit.js';
import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { migrate, query } from './core/db.js';
import { authRouter, csrfProtection } from './core/auth.js';
import { entityRouter } from './core/entities.js';
import { fileRouter } from './core/files.js';
import { jobRouter } from './core/jobs.js';
import { aiRouter } from './ai.js';
import { integrationRouter } from './integrations.js';
import { publishingRouter } from './publishing.js';
import { mcpRouter } from './mcp.js';
import { startWorker, stopWorker } from './worker.js';
import { extrasRouter, extrasPublicRouter, migrateExtras } from './extras.js';
import {remoteRouter} from './remote-mcp.js';
import {skillsRouter,migrateSkills} from './skills.js';
import {mediaToolsRouter} from './media-tools.js';
import {preferencesRouter,migratePreferences} from './preferences.js';
import {readerRouter,migrateReader} from './reader.js';
import {articlesRouter,migrateArticles} from './articles.js';

export const app = express();
app.set('trust proxy',1);
app.disable('x-powered-by');
app.use(helmet({contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'"],styleSrc:["'self'","'unsafe-inline'"],imgSrc:["'self'",'data:','blob:','https:'],connectSrc:["'self'"],fontSrc:["'self'"],mediaSrc:["'self'",'blob:'],frameSrc:['blob:'],objectSrc:["'none'"]}},crossOriginEmbedderPolicy:false}));
app.use(express.json({limit:'2mb',verify:(req,_res,buf)=>{(req as any).rawBody=buf;}}));
app.use(cookieParser());
app.use('/api',rateLimit({keyGenerator:clientRateKey,windowMs:60_000,limit:240,standardHeaders:'draft-8',legacyHeaders:false}));
app.get('/api/health',async(_req,res)=>{try{await query('SELECT 1');res.json({status:'ok',service:'grove',version:'0.1.0'});}catch{res.status(503).json({status:'unavailable'});}});
app.use(mcpRouter);
app.use(csrfProtection);
app.use('/api',authRouter,entityRouter,fileRouter,jobRouter,aiRouter,integrationRouter,publishingRouter,extrasRouter,remoteRouter,skillsRouter,mediaToolsRouter,preferencesRouter,readerRouter,articlesRouter);
app.use(extrasPublicRouter);
app.use('/api',(_req,res)=>res.status(404).json({error:'Endpoint not found'}));
const webRoot=path.resolve(process.cwd(),'dist');
if(existsSync(webRoot)){
 app.use(express.static(webRoot,{index:false,maxAge:'1h'}));
 app.get('/{*path}',(_req,res)=>res.sendFile(path.join(webRoot,'index.html')));
}
app.use((err:any,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{
 const status=Number(err.status||err.statusCode)||(err.name==='ZodError'?400:500);
 if(status>=500)console.error(JSON.stringify({event:'request_error',type:err.name,code:err.code,status}));
 res.status(status>=400&&status<600?status:500).json({error:status>=500&&!err.expose?'The request could not be completed. Please retry.':(err.message||'Invalid request'),code:err.code,details:err.name==='ZodError'?err.issues:undefined});
});

export async function initialize(){await migrate();await migrateExtras();await migrateSkills();await migratePreferences();await migrateReader();await migrateArticles();}
const isEntry=process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(isEntry){
 await initialize();
 const port=Number(process.env.PORT||3000);
 const host=process.env.HOST||'0.0.0.0';
 const server=app.listen(port,host,()=>{console.log(JSON.stringify({event:'listening',port,host}));if(process.env.DISABLE_WORKER!=='true')startWorker();});
 const shutdown=()=>{stopWorker();server.close(()=>process.exit(0));setTimeout(()=>process.exit(1),10000).unref();};
 process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
}
