import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Pause, Play, SkipForward, Square, Volume2 } from 'lucide-react';
import { Button, IconButton } from '../ui';
import type { ReadingController } from './useReadingState';

interface QueuePart { text: string; chapter: number; title: string }
export interface NarrationHandle { stop: () => void }
export function narrationChunks(text: string) {
 const normalized = text.replace(/\s+/g, ' ').trim(); if (!normalized) return [];
 const sentences = typeof Intl.Segmenter === 'function' ? Array.from(new Intl.Segmenter(undefined, { granularity: 'sentence' }).segment(normalized), part => part.segment) : [normalized];
 const chunks: string[] = [];
 for (const sentence of sentences) { let rest = sentence; while (rest.length > 260) { const space = rest.lastIndexOf(' ', 259), end = space >= 80 ? space + 1 : 260; chunks.push(rest.slice(0, end)); rest = rest.slice(end); } if (rest) chunks.push(rest); }
 return chunks;
}
export const Narration = forwardRef<NarrationHandle, { text: string; chapter: number; chapters: { title: string; content: string }[]; reading: ReadingController; onChapter: (chapter: number) => void }>(function Narration({ text, chapter, chapters, reading, onChapter }, ref) {
 const supported = typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
 const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]), [status, setStatus] = useState<'idle' | 'playing' | 'paused' | 'error'>('idle'), [error, setError] = useState('');
 const [queue, setQueue] = useState<QueuePart[]>([]), [position, setPosition] = useState(0), [continueBook, setContinueBook] = useState(true), [expanded, setExpanded] = useState(false);
 const run = useRef(0), queueRef = useRef<QueuePart[]>([]), positionRef = useRef(0), active = useRef(false), mounted = useRef(true);
 const options = useRef({ rate: reading.state.rate, voice: reading.state.voice, voices, onChapter }); options.current = { rate: reading.state.rate, voice: reading.state.voice, voices, onChapter };
 function stop() { ++run.current; active.current = false; if (supported) window.speechSynthesis.cancel(); if (mounted.current) setStatus('idle'); }
 useImperativeHandle(ref, () => ({ stop }));
 useEffect(() => { mounted.current = true; if (!supported) return; const update = () => setVoices(window.speechSynthesis.getVoices()); update(); window.speechSynthesis.addEventListener('voiceschanged', update); return () => { mounted.current = false; ++run.current; active.current = false; window.speechSynthesis.cancel(); window.speechSynthesis.removeEventListener('voiceschanged', update); }; }, [supported]);
 function speak(index: number) {
  if (!supported) return;
  const token = ++run.current; window.speechSynthesis.cancel();
  if (index >= queueRef.current.length) { active.current = false; setStatus('idle'); return; }
  const part = queueRef.current[index]; positionRef.current = index; setPosition(index); setStatus('playing'); setError(''); active.current = true;
  options.current.onChapter(part.chapter);
  const utterance = new SpeechSynthesisUtterance(part.text); utterance.rate = options.current.rate;
  utterance.voice = options.current.voices.find(voice => voice.voiceURI === options.current.voice) || null;
  utterance.onend = () => { if (mounted.current && token === run.current && active.current) speak(index + 1); };
  utterance.onerror = event => { if (mounted.current && token === run.current && !['canceled', 'interrupted'].includes(event.error)) { active.current = false; setStatus('error'); setError(`Narration stopped (${event.error}). Try another voice or press Play again.`); } };
  window.speechSynthesis.speak(utterance);
 }
 function play() {
  if (!supported) return;
  if (status === 'paused') { window.speechSynthesis.resume(); setStatus('playing'); return; }
  const sources = chapters.length ? (continueBook ? chapters.slice(chapter) : [chapters[chapter]]).map((source, index) => ({ ...source, chapter: chapter + index })) : [{ title: 'Current document', content: text, chapter: 0 }];
  const parts = sources.flatMap(source => narrationChunks(source.chapter === chapter ? text : source.content).map(value => ({ text: value, chapter: source.chapter, title: source.title })));
  queueRef.current = parts; setQueue(parts); speak(0);
 }
 const previousOptions = useRef(`${reading.state.rate}:${reading.state.voice}`);
 useEffect(() => { const next = `${reading.state.rate}:${reading.state.voice}`; if (previousOptions.current !== next && active.current && status === 'playing') speak(positionRef.current); previousOptions.current = next; }, [reading.state.rate, reading.state.voice]);
 return <section className="reader-narration" aria-label="Narration"><div className="reader-narration-top"><Volume2 size={15} /><strong>Listen</strong>{supported ? <><Button aria-label={status === 'paused' ? 'Resume narration' : 'Play narration'} disabled={!reading.ready || !text.trim() || status === 'playing'} onClick={play}><Play size={13} />{status === 'paused' ? 'Resume' : 'Play'}</Button><IconButton label="Pause narration" disabled={status !== 'playing'} onClick={() => { window.speechSynthesis.pause(); setStatus('paused'); }}><Pause size={14} /></IconButton><IconButton label="Stop narration" disabled={!['playing', 'paused'].includes(status)} onClick={stop}><Square size={13} /></IconButton><IconButton label="Next narration passage" disabled={!queue.length || position >= queue.length - 1 || status === 'idle'} onClick={() => speak(positionRef.current + 1)}><SkipForward size={14} /></IconButton></> : <span className="field-hint">Speech isn’t available in this browser.</span>}<button type="button" className="reader-queue-toggle" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>Voice & queue</button></div>
  {supported && expanded && <div className="reader-narration-options"><label>Voice<select aria-label="Narration voice" value={reading.state.voice} onChange={event => reading.update({ voice: event.target.value })}><option value="">Browser default</option>{voices.map(voice => <option key={voice.voiceURI} value={voice.voiceURI}>{voice.name} · {voice.lang}{voice.localService ? ' · device' : ''}</option>)}</select></label><label>Speed<select aria-label="Narration speed" value={reading.state.rate} onChange={event => reading.update({ rate: Number(event.target.value) })}>{[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3].map(rate => <option key={rate} value={rate}>{rate}×</option>)}</select></label>{chapters.length > 1 && <label className="reader-continue-book"><input type="checkbox" checked={continueBook} onChange={event => setContinueBook(event.target.checked)} />Continue through chapters</label>}<p className="field-hint">Uses browser speech. Voice availability and network use depend on your browser and system.</p>{queue.length > 0 && <ol className="reader-narration-queue" aria-label="Narration queue">{queue.slice(Math.max(0, position - 1), position + 5).map((part, offset) => { const index = Math.max(0, position - 1) + offset; return <li key={index}><button type="button" aria-current={index === position ? 'true' : undefined} onClick={() => speak(index)}><span>{index + 1}. {part.title}</span><strong>{part.text}</strong></button></li>; })}</ol>}</div>}
  {queue.length > 0 && <div className="reader-narration-status" role="status">{status === 'playing' ? 'Reading' : status === 'paused' ? 'Paused at' : status === 'error' ? 'Stopped at' : 'Queue ready ·'} passage {position + 1} of {queue.length}<span>{queue[position]?.text}</span></div>}{error && <p className="reader-warning" role="alert">{error}</p>}
 </section>;
});
