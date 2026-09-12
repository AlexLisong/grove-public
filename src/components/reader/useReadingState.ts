import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import { useWorkspace } from '../../store';

export type HighlightColor = 'yellow' | 'green' | 'blue' | 'pink' | 'purple';
export interface ReadingState { progress: number; chapter: number; scrollTop: number; rate: number; voice: string; highlightColor: HighlightColor; notes: string }
const defaults: ReadingState = { progress: 0, chapter: 0, scrollTop: 0, rate: 1, voice: '', highlightColor: 'yellow', notes: '' };
function recover(key: string): Partial<ReadingState> { try { const value = JSON.parse(localStorage.getItem(key) || '{}'); return value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([field]) => field in defaults)) : {}; } catch { return {}; } }

export function useReadingState(id: string) {
 const { workspace, session } = useWorkspace();
 const key = `grove-reader-pending:${workspace.id}:${session.user.id}:${id}`;
 const pending = useRef<Partial<ReadingState>>(recover(key));
 const [state, setState] = useState<ReadingState>({ ...defaults, ...pending.current });
 const [ready, setReady] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState(''), [dirty, setDirty] = useState(Object.keys(pending.current).length > 0), [reload, setReload] = useState(0);
 const task = useRef<Promise<boolean> | null>(null), initialized = useRef(false), live = useRef(true), timer = useRef<ReturnType<typeof setTimeout> | null>(null);
 const flushRef = useRef<() => Promise<boolean>>(async () => true);
 function persist() { try { if (Object.keys(pending.current).length) localStorage.setItem(key, JSON.stringify(pending.current)); else localStorage.removeItem(key); } catch { /* Visible unsaved state and Retry remain available when storage is full. */ } }
 const flush = useCallback(async (): Promise<boolean> => {
  if (timer.current) clearTimeout(timer.current);
  if (task.current) { const ok = await task.current; return ok && Object.keys(pending.current).length ? flushRef.current() : ok; }
  if (!Object.keys(pending.current).length) return true;
  if (!initialized.current) return false;
  const patch = { ...pending.current }; if (live.current) setSaving(true);
  const request = (async () => { try {
   const result = await api<{ state: ReadingState }>(`/reader/${id}/state`, { method: 'PATCH', body: JSON.stringify(patch), headers: { 'X-Workspace-Id': workspace.id } });
   for (const field of Object.keys(patch) as (keyof ReadingState)[]) if (pending.current[field] === patch[field]) delete pending.current[field];
   persist();
   if (live.current) { setState({ ...defaults, ...result.state, ...pending.current }); setDirty(Object.keys(pending.current).length > 0); setError(''); }
   return true;
  } catch (e) { persist(); if (live.current) setError((e as Error).message); return false; } finally { if (live.current) setSaving(false); } })();
  task.current = request; const ok = await request; task.current = null; return ok && Object.keys(pending.current).length ? flushRef.current() : ok;
 }, [id, workspace.id, key]);
 flushRef.current = flush;
 useEffect(() => {
  live.current = true; const abort = new AbortController(); initialized.current = false; setReady(false);
  api<{ state: ReadingState }>(`/reader/${id}/state`, { signal: abort.signal, headers: { 'X-Workspace-Id': workspace.id } }).then(result => { if (!abort.signal.aborted) { setState({ ...defaults, ...result.state, ...pending.current }); setError(''); } }).catch(e => { if (!abort.signal.aborted) setError(e.message); }).finally(() => { if (!abort.signal.aborted) { initialized.current = true; setReady(true); if (Object.keys(pending.current).length) void flushRef.current(); } });
  return () => { abort.abort(); };
 }, [id, workspace.id, reload]);
 useEffect(() => { const leave = () => { persist(); void flushRef.current(); }; window.addEventListener('pagehide', leave); return () => { live.current = false; window.removeEventListener('pagehide', leave); if (timer.current) clearTimeout(timer.current); persist(); void flushRef.current(); }; }, [key]);
 const update = useCallback((patch: Partial<ReadingState>) => {
  pending.current = { ...pending.current, ...patch }; persist(); setState(previous => ({ ...previous, ...patch })); setDirty(true);
  if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => void flushRef.current(), 700);
 }, [key]);
 const retry = () => { if (Object.keys(pending.current).length) void flushRef.current(); else setReload(value => value + 1); };
 return { state, ready, saving, dirty, error, update, flush, retry };
}
export type ReadingController = ReturnType<typeof useReadingState>;
