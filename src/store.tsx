import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from 'react';
import type { Session, Entity, EntityInput, WorkflowTemplate, ConnectorDefinition, Connection, Workspace, Preferences } from '../shared/types';
import { api, post, patch, setWorkspaceContext } from './api';
export interface Catalog { marketplace?: any[]; builtInSkills?: any[]; workflows: WorkflowTemplate[]; connectors: ConnectorDefinition[]; ai: { configured: boolean; model?: string; images?: boolean; transcription?: boolean } }
export interface Toast { id: string; text: string; tone: 'success' | 'error' | 'info' }
type PreferencePatch = Partial<Omit<Preferences, 'pinnedIds' | 'recentIds' | 'library'>> & { library?: Partial<Preferences['library']> };
const emptyPreferences: Preferences = { pinnedIds: [], recentIds: [], topics: [], onboardingComplete: false, captureBoardId: null, library: { tab: 'all', tag: '', view: 'grid', platform: '', source: '' } };
interface State {
 session: Session; workspace: Workspace; entities: Entity[]; catalog: Catalog; connections: Connection[]; loading: boolean; error: string; toasts: Toast[];
 preferences: Preferences; savePreferences: (input: PreferencePatch) => Promise<void>; pin: (id: string, pinned: boolean) => Promise<void>; recordOpen: (id: string) => void;
 refresh: () => Promise<void>; create: (input: EntityInput) => Promise<Entity>; update: (id: string, input: Partial<EntityInput> & { version?: number }) => Promise<Entity>; remove: (id: string) => Promise<void>; put: (entity: Entity) => void;
 notify: (text: string, tone?: Toast['tone']) => void; dismiss: (id: string) => void; switchWorkspace: (id: string) => void; openItem: (id: string) => void; selectedItem: string | null; closeItem: () => void;
 registerItemGuard:(id:string,guard:()=>Promise<boolean>)=>()=>void;
 run: <T>(fn: () => Promise<T>, success?: string) => Promise<T | undefined>; logout: () => Promise<void>;
}
const Context = createContext<State | null>(null);
const emptyCatalog: Catalog = { workflows: [], connectors: [], ai: { configured: false } };
export function WorkspaceProvider({ session, onLogout, children }: { session: Session; onLogout: () => void; children: ReactNode }) {
 const [workspace, setWorkspace] = useState(session.workspace);
 const activeWorkspace = useRef(session.workspace.id); const refreshSequence = useRef(0); const mutationRevision = useRef(0); const knownVersions = useRef(new Map<string, number>());
 const [preferences, setPreferences] = useState<Preferences>(emptyPreferences); const preferenceRevision = useRef(0); const preferenceQueues = useRef(new Map<string, Promise<void>>());
 const [entities, setEntities] = useState<Entity[]>([]); const [catalog, setCatalog] = useState<Catalog>(emptyCatalog); const [connections, setConnections] = useState<Connection[]>([]);
 const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [toasts, setToasts] = useState<Toast[]>([]); const [selectedItem, setSelected] = useState<string | null>(null);
 const itemGuard=useRef<{id:string;guard:()=>Promise<boolean>}|null>(null),navigationSequence=useRef(0);
 const notify = useCallback((text: string, tone: Toast['tone'] = 'success') => { const id = crypto.randomUUID(); setToasts(s => [...s.slice(-3), { id, text, tone }]); setTimeout(() => setToasts(s => s.filter(t => t.id !== id)), tone === 'error' ? 10000 : 5000); }, []);
 const dismiss = (id: string) => setToasts(s => s.filter(t => t.id !== id));
 const registerItemGuard=useCallback((id:string,guard:()=>Promise<boolean>)=>{const entry={id,guard};itemGuard.current=entry;return()=>{if(itemGuard.current===entry)itemGuard.current=null;};},[]);
 const navigateAfterSave=useCallback(async(action:()=>void|Promise<void>)=>{
  const sequence=++navigationSequence.current;
  try{if(itemGuard.current&&!await itemGuard.current.guard())return false;if(sequence!==navigationSequence.current)return false;await action();return true;}
  catch(e){notify(e instanceof Error?e.message:'Your changes could not be saved. Retry before leaving.','error');return false;}
 },[notify]);
 const refresh = useCallback(async () => {
  const workspaceId = workspace.id; const sequence = ++refreshSequence.current; const preferenceVersion = preferenceRevision.current; const entityVersion = mutationRevision.current;
  if (activeWorkspace.current !== workspaceId) return;
  setError('');
  const result = await Promise.allSettled([api<{ entities: Entity[] }>('/entities'), api<Catalog>('/catalog'), api<{ connections: Connection[] }>('/connections'), (preferenceQueues.current.get(workspaceId) || Promise.resolve()).catch(() => {}).then(() => api<{preferences: Preferences}>('/preferences', {headers: {'X-Workspace-Id': workspaceId}}))]);
  if (activeWorkspace.current !== workspaceId || sequence !== refreshSequence.current) return;
  if (result[0].status === 'fulfilled') {
   if (entityVersion === mutationRevision.current) {
    const list = result[0].value.entities || [];
    for (const entity of list) knownVersions.current.set(entity.id, Math.max(knownVersions.current.get(entity.id) || 0, entity.version));
    setEntities(previous => list.map(entity => { const current = previous.find(e => e.id === entity.id); return current && current.version > entity.version ? current : entity; }));
   }
  } else setError(result[0].reason.message);
  if (result[1].status === 'fulfilled') setCatalog(result[1].value);
  if (result[2].status === 'fulfilled') setConnections(result[2].value.connections || []);
  if (result[3].status === 'fulfilled' && preferenceVersion === preferenceRevision.current) setPreferences(result[3].value.preferences || emptyPreferences);
  if (result[3].status === 'rejected') setError('Your saved preferences could not be loaded. Retry to restore them.');
  setLoading(false);
 }, [workspace.id]);
 useEffect(() => { setWorkspaceContext(workspace.id); setLoading(true); setEntities([]); setConnections([]); setCatalog(emptyCatalog); setPreferences(emptyPreferences); setSelected(null); void refresh(); }, [workspace.id, refresh]);
 const changePreferences = useCallback((path: string, method: 'PATCH' | 'POST', body: unknown, optimistic: (previous: Preferences) => Preferences) => {
  const workspaceId = activeWorkspace.current; const revision = ++preferenceRevision.current;
  setPreferences(optimistic);
  const task = (preferenceQueues.current.get(workspaceId) || Promise.resolve()).catch(() => {}).then(async () => {
   try {
    const result = await api<{preferences: Preferences}>(path, {method, body: JSON.stringify(body), headers: {'X-Workspace-Id': workspaceId}});
    if (activeWorkspace.current === workspaceId && preferenceRevision.current === revision) setPreferences(result.preferences);
   } catch (error) {
    if (activeWorkspace.current === workspaceId && preferenceRevision.current === revision) {
     try { const result = await api<{preferences: Preferences}>('/preferences', {headers: {'X-Workspace-Id': workspaceId}}); if (activeWorkspace.current === workspaceId && preferenceRevision.current === revision) setPreferences(result.preferences); } catch { /* The next refresh can retry without discarding the visible preference. */ }
    }
    throw error;
   }
  });
  preferenceQueues.current.set(workspaceId, task);
  void task.finally(() => { if (preferenceQueues.current.get(workspaceId) === task) preferenceQueues.current.delete(workspaceId); }).catch(() => {});
  return task;
 }, []);
 const savePreferences = useCallback((input: PreferencePatch) => changePreferences('/preferences', 'PATCH', input, previous => ({...previous, ...input, library: {...previous.library, ...input.library}})), [changePreferences]);
 const pin = useCallback((id: string, pinned: boolean) => changePreferences(`/preferences/items/${id}`, 'POST', {action: pinned ? 'pin' : 'unpin'}, previous => ({...previous, pinnedIds: pinned ? [id, ...previous.pinnedIds.filter(value => value !== id)].slice(0, 200) : previous.pinnedIds.filter(value => value !== id)})), [changePreferences]);
 const recordOpen = useCallback((id: string) => { void changePreferences(`/preferences/items/${id}`, 'POST', {action: 'open'}, previous => ({...previous, recentIds: [id, ...previous.recentIds.filter(value => value !== id)].slice(0, 30)})).catch(() => notify('Could not save your recent items. Reconnect and try again.', 'error')); }, [changePreferences, notify]);
 const openItem = useCallback((id: string) => { void navigateAfterSave(()=>{setSelected(id);recordOpen(id);}); }, [recordOpen,navigateAfterSave]);
 const closeItem=useCallback(()=>{void navigateAfterSave(()=>setSelected(null));},[navigateAfterSave]);
 const put = useCallback((e: Entity) => { if (e.workspaceId !== activeWorkspace.current || (knownVersions.current.get(e.id) || 0) > e.version) return; ++mutationRevision.current; knownVersions.current.set(e.id, e.version); setEntities(prev => { if (e.deletedAt) return prev.filter(x => x.id !== e.id); const i = prev.findIndex(x => x.id === e.id); return i < 0 ? [e, ...prev] : prev.map(x => x.id === e.id ? e : x); }); }, []);
 const create = async (input: EntityInput) => { const { entity } = await post<{ entity: Entity }>('/entities', input); put(entity); return entity; };
 const update = async (id: string, input: Partial<EntityInput> & { version?: number }) => { const { entity } = await patch<{ entity: Entity }>(`/entities/${id}`, { version: knownVersions.current.get(id), ...input }); put(entity); return entity; };
 const remove = async (id: string) => { const {entity} = await api<{entity: Entity}>(`/entities/${id}`, { method: 'DELETE' }); put(entity); if (entity.workspaceId !== activeWorkspace.current) return; if (selectedItem === id) setSelected(null); notify('Moved to trash. You can restore it in Settings.'); };
 const run = async <T,>(fn: () => Promise<T>, success?: string) => { try { const value = await fn(); if (success) notify(success); return value; } catch (e) { notify(e instanceof Error ? e.message : 'Something went wrong. Please try again.', 'error'); } };
 const switchWorkspace = (id: string) => { const w = session.workspaces.find(w => w.id === id); if (w) void navigateAfterSave(()=>{ activeWorkspace.current = id; knownVersions.current.clear(); ++refreshSequence.current; ++preferenceRevision.current; setWorkspaceContext(id); setEntities([]); setConnections([]); setPreferences(emptyPreferences); setSelected(null); setLoading(true); setWorkspace(w); }); };
 const logout = async () => { await navigateAfterSave(async()=>{await post('/auth/logout');onLogout();}); };
 return <Context.Provider value={{ session, workspace, entities, catalog, connections, preferences, savePreferences, pin, recordOpen, loading, error, toasts, refresh, create, update, remove, put, notify, dismiss, switchWorkspace, selectedItem, openItem, closeItem, registerItemGuard, run, logout }}>{children}</Context.Provider>;
}
export function useWorkspace() { const context = useContext(Context); if (!context) throw new Error('Workspace is not ready'); return context; }
export function useEntity(id?: string) { const { entities } = useWorkspace(); return entities.find(e => e.id === id); }
