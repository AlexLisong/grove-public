import {useState} from 'react';
import {Check, ArrowRight, Sprout} from 'lucide-react';
import {useNavigate} from 'react-router-dom';
import {useWorkspace} from '../store';
import {Button, Field, Input, TagsInput, ErrorNotice} from './ui';
import './onboarding.css';

export function Onboarding() {
 const app=useWorkspace(),navigate=useNavigate();
 const [topics,setTopics]=useState(app.preferences.topics),[name,setName]=useState('My ideas'),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const board=app.entities.find(e=>e.kind==='board');
 if(app.preferences.onboardingComplete || app.workspace.itemOnly)return null;
 const canCreate=app.workspace.role!=='viewer';
 async function save(createBoard=false){
  setBusy(true);setError('');
  try{
   const destination=createBoard?await app.create({kind:'board',title:name.trim()||'My ideas',tags:topics,data:{view:'canvas',placements:[],sections:[]}}):board;
   await app.savePreferences({topics,onboardingComplete:true,...(createBoard&&destination?{captureBoardId:destination.id}:{})});
   if(createBoard&&destination)navigate(`/boards/${destination.id}`);
  }catch(e){setError((e as Error).message);}finally{setBusy(false);}
 }
 return <section className="onboarding-card" aria-label="Make Grove your own">
  <div className="onboarding-intro"><Sprout size={23}/><div><h2>Make this space your own.</h2><p>Choose a few interests, then give your first ideas a home.</p></div></div>
  <div className="onboarding-fields"><Field label="What are you working on?" hint="Add topics such as design, startups, or your next newsletter."><TagsInput value={topics} onChange={value=>setTopics(value.slice(0,20).map(t=>t.slice(0,60)))}/></Field>{!board&&canCreate&&<Field label="Your first board"><Input value={name} onChange={e=>setName(e.target.value)} maxLength={500}/></Field>}</div>
  <div className="onboarding-actions"><div className="onboarding-progress"><span><Check size={13}/>Account ready</span><span>{board?<Check size={13}/>:<span className="status-dot"/>}First board {board?'ready':'waiting'}</span></div><Button busy={busy} onClick={()=>void save()}>Save interests</Button>{!board&&canCreate&&<Button tone="primary" busy={busy} onClick={()=>void save(true)}>Create my first board<ArrowRight size={14}/></Button>}</div>
  {error&&<ErrorNotice>{error}</ErrorNotice>}
 </section>;
}
