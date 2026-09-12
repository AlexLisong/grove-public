import {useEffect,useRef,useState} from 'react';
import {Mic,Square,FileText} from 'lucide-react';
import type {Entity} from '../../shared/types';
import {api} from '../api';
import {useWorkspace} from '../store';
import {Button,ErrorNotice,Field,Modal} from './ui';
import './voice-capture.css';

export function VoiceCapture({onClose,onInsert}:{onClose:()=>void;onInsert:(text:string)=>void}){
 const app=useWorkspace(),workspaceId=app.workspace.id;
 const [status,setStatus]=useState<'idle'|'permission'|'recording'|'ready'>('idle'),[seconds,setSeconds]=useState(0),[audio,setAudio]=useState<Blob|null>(null),[url,setUrl]=useState(''),[transcript,setTranscript]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[saved,setSaved]=useState(false);
 const recorder=useRef<MediaRecorder|null>(null),stream=useRef<MediaStream|null>(null),uploaded=useRef<Entity|null>(null),live=useRef(true),generation=useRef(0),clock=useRef<ReturnType<typeof setInterval>|null>(null),maximum=useRef<ReturnType<typeof setTimeout>|null>(null),working=useRef(false);
 const supported=typeof MediaRecorder!=='undefined'&&!!navigator.mediaDevices?.getUserMedia;
 const release=()=>{if(clock.current)clearInterval(clock.current);if(maximum.current)clearTimeout(maximum.current);stream.current?.getTracks().forEach(track=>track.stop());stream.current=null;};
 function stop(){if(recorder.current?.state==='recording')recorder.current.stop();release();}
 useEffect(()=>{live.current=true;return()=>{live.current=false;generation.current++;if(recorder.current?.state==='recording')recorder.current.stop();release();};},[]);
 useEffect(()=>{if(!audio){setUrl('');return;}const object=URL.createObjectURL(audio);setUrl(object);return()=>URL.revokeObjectURL(object);},[audio]);
 async function start(){
  if(!supported||working.current||status==='permission'||status==='recording')return;
  const current=++generation.current;setStatus('permission');setError('');setAudio(null);setTranscript('');setSeconds(0);setSaved(false);uploaded.current=null;
  try{
   const capture=await navigator.mediaDevices.getUserMedia({audio:true,video:false});
   if(!live.current||current!==generation.current){capture.getTracks().forEach(track=>track.stop());return;}
   stream.current=capture;
   const mime=['audio/webm;codecs=opus','audio/webm','audio/mp4'].find(type=>MediaRecorder.isTypeSupported(type));
   const active=new MediaRecorder(capture,{...(mime?{mimeType:mime}:{}),audioBitsPerSecond:128000});recorder.current=active;
   const chunks:Blob[]=[];let bytes=0;
   active.ondataavailable=event=>{if(!live.current||current!==generation.current)return;if(event.data.size){chunks.push(event.data);bytes+=event.data.size;}if(bytes>24*1024*1024&&active.state==='recording')stop();};
   active.onstop=()=>{if(!live.current||current!==generation.current)return;release();const blob=new Blob(chunks,{type:active.mimeType||mime||'audio/webm'});if(!blob.size||blob.size>25*1024*1024){setError('This recording is empty or too large. Record a shorter clip.');setStatus('idle');return;}setAudio(blob);setStatus('ready');};
   active.onerror=()=>{if(!live.current||current!==generation.current)return;generation.current++;if(active.state==='recording')active.stop();release();setError('The microphone recording failed. Try again.');setStatus('idle');};
   active.start(1000);setStatus('recording');const began=Date.now();clock.current=setInterval(()=>setSeconds(Math.floor((Date.now()-began)/1000)),500);maximum.current=setTimeout(stop,5*60*1000);
  }catch(e){release();if(live.current&&current===generation.current){setStatus('idle');setError((e as Error).name==='NotAllowedError'?'Microphone access was declined. Allow it in your browser to record, or type your message.':(e as Error).message);}}
 }
 async function transcribe(){
  if(!audio||working.current)return;working.current=true;setBusy(true);setError('');
  try{
   if(!uploaded.current){const form=new FormData();form.append('visibility','private');form.append('file',audio,`Voice note ${new Date().toISOString().replace(/[:.]/g,'-')}.${audio.type.includes('mp4')?'m4a':'webm'}`);const result=await api<{entity:Entity}>('/uploads',{method:'POST',body:form,headers:{'X-Workspace-Id':workspaceId}});uploaded.current=result.entity;app.put(result.entity);if(live.current)setSaved(true);}
   if(!live.current)return;
   const result=await api<{entity:Entity}>(`/ai/transcribe/${uploaded.current.id}`,{method:'POST',headers:{'X-Workspace-Id':workspaceId}});app.put(result.entity);if(live.current)setTranscript(result.entity.content);
  }catch(e){if(live.current)setError((e as Error).message);}finally{working.current=false;if(live.current)setBusy(false);}
 }
 return <Modal title="Capture a voice note" onClose={()=>{if(!working.current)onClose();}}><div className="voice-capture">
  <p className="muted">Record up to five minutes, then review the transcript before adding it to your message.</p>
  {!supported&&<ErrorNotice>This browser does not support microphone recording. Use a current browser over HTTPS, or upload an audio file in Library.</ErrorNotice>}
  <div className={`voice-recorder ${status==='recording'?'recording':''}`} role="status"><Mic size={30}/><strong>{status==='recording'?'Recording':status==='permission'?'Waiting for microphone permission':status==='ready'?'Recording ready':'Ready when you are'}</strong><output aria-label="Recording duration">{Math.floor(seconds/60)}:{String(seconds%60).padStart(2,'0')}</output></div>
  {url&&<audio aria-label="Recorded voice preview" controls src={url}/>}
  {error&&<ErrorNotice>{error}</ErrorNotice>}
  <div className="voice-actions">{status==='recording'?<Button tone="danger" onClick={stop}><Square size={14}/>Stop recording</Button>:<Button disabled={!supported||busy||status==='permission'} onClick={()=>void start()}><Mic size={14}/>{audio?'Record again':'Start recording'}</Button>}{audio&&<Button busy={busy} disabled={!app.catalog.ai.transcription} onClick={()=>void transcribe()}><FileText size={14}/>{transcript?'Transcribe again':'Transcribe recording'}</Button>}</div>
  {!app.catalog.ai.transcription&&<p className="field-hint">Connect a transcription provider to convert recordings to text.</p>}
  <p className="field-hint">{saved?(transcript?'The recording and transcript are saved privately in Library.':'The recording is saved privately in Library. A retry reuses this recording.'):'The microphone starts only when you choose Start recording. Transcribe uploads the recording privately to your workspace and configured AI provider.'}</p>
  {transcript&&<Field label="Review transcript"><textarea aria-label="Voice transcript" rows={6} value={transcript} onChange={event=>setTranscript(event.target.value)}/></Field>}
  <div className="form-actions"><Button disabled={busy} onClick={onClose}>Close</Button><Button tone="primary" disabled={!transcript.trim()||busy} onClick={()=>{onInsert(transcript.trim());onClose();}}>Use transcript</Button></div>
 </div></Modal>;
}
