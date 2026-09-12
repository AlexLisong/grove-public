// Creates the installation owner through the real API and saves credentials locally.
// Never prints passwords, invite codes, cookies, or connection strings.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import path from 'node:path';
const remote=process.argv.includes('--production');
const config=JSON.parse(await readFile(remote?'/tmp/grove-deploy.json':'.data/dev-env.json','utf8'));
const target=remote?config.APP_URL:'http://localhost:5173';
const destination=path.resolve('.data',remote?'owner-login.json':'local-owner-login.json');
await mkdir(path.dirname(destination),{recursive:true,mode:0o700});
let credentials;try{credentials=JSON.parse(await readFile(destination,'utf8'));}catch{credentials={url:target,email:process.env.GROVE_OWNER_EMAIL||'owner@grove.local',password:randomBytes(24).toString('base64url'),name:process.env.GROVE_OWNER_NAME||'Owner',createdAt:new Date().toISOString()};}
// Persist before the request so a lost response can be retried with the same
// password instead of creating an account whose credentials are unavailable.
await writeFile(destination,JSON.stringify(credentials,null,2),{mode:0o600});
const response=await fetch(target+'/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:credentials.email,name:credentials.name,password:credentials.password,code:config.REGISTRATION_CODE})});
let data=await response.json();
if(!response.ok){if(response.status===409){const login=await fetch(target+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:credentials.email,password:credentials.password})});data=await login.json();if(!login.ok)throw new Error('Existing owner login could not be verified; credentials were not changed.');}else throw new Error('Owner registration failed: '+String(data.error).slice(0,200));}
credentials.workspaceId=data.workspace.id;
await writeFile(destination,JSON.stringify(credentials,null,2),{mode:0o600});
console.log(JSON.stringify({status:'owner-ready',url:target,email:credentials.email,credentialsFile:destination,workspaceId:data.workspace.id}));
