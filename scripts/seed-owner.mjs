// Idempotent first-use documents. Uses only the owner's authenticated workspace.
import {readFile} from 'node:fs/promises';
const credentials=JSON.parse(await readFile('.data/owner-login.json','utf8'));
const login=await fetch(credentials.url+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:credentials.email,password:credentials.password})});
if(!login.ok)throw new Error('Owner login failed');
const session=await login.json();
const cookie=login.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
const headers={'Content-Type':'application/json','Cookie':cookie,'X-CSRF-Token':session.csrfToken,'X-Workspace-Id':session.workspace.id};
async function request(path,method='GET',body){const response=await fetch(credentials.url+'/api'+path,{method,headers,...(body?{body:JSON.stringify(body)}:{})});const result=await response.json();if(!response.ok)throw new Error(path+': '+result.error);return result;}
const existing=(await request('/entities')).entities;
async function ensure(key,input){const current=existing.find(e=>e.data.onboardingKey===key);if(current)return current;const {entity}=await request('/entities','POST',{...input,visibility:'private',data:{...input.data,onboardingKey:key}});existing.push(entity);return entity;}
const guide=(await readFile('docs/USING-GROVE.md','utf8')).replaceAll('(PROVIDER-SETUP.md)','(https://github.com/AlexLisong/grove-public/blob/main/docs/PROVIDER-SETUP.md)').replaceAll('(feature-coverage.md)','(https://github.com/AlexLisong/grove-public/blob/main/docs/feature-coverage.md)');
const welcome=await ensure('welcome',{kind:'item',title:'Welcome to Grove',content:guide,tags:['start-here'],data:{type:'document'}});
const brief=await ensure('creator-brief',{kind:'item',title:'Your creator brief',content:'# Make this brief your own\n\nReplace each prompt with your own facts before using this as AI context.\n\n## My work\nWhat do you make, and what experience can you speak from?\n\n## My audience\nWho do you want to help? What do they need?\n\n## My point of view\nWhat do you see differently, and what evidence supports it?\n\n## My topics\nChoose three to five themes you want to explore.\n\n## My voice\nPaste a short sample of writing that sounds like you.\n\n## My rhythm\nWhich platforms do you use, and how often can you realistically publish?\n\n## My next goal\nWhat would make the next month useful?',tags:['start-here'],data:{type:'document'}});
const pipeline=await ensure('content-pipeline',{kind:'table',title:'Your content pipeline',data:{columns:[{id:'title',name:'Idea',type:'text'},{id:'status',name:'Status',type:'select',options:['Idea','Draft','In review','Ready','Published']},{id:'date',name:'Target date',type:'date'},{id:'source',name:'Source',type:'relation'}],rows:[],view:'table'}});
await ensure('start-board',{kind:'board',title:'Start here',data:{view:'grid',sections:['Get started'],placements:[welcome,brief,pipeline].map((e,index)=>({id:e.id,x:40+index*310,y:40,section:'Get started'}))}});
console.log(JSON.stringify({status:'starter-ready',documents:2,table:1,board:1}));
