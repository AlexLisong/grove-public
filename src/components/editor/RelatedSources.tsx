import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Link2, Sparkles } from 'lucide-react';
import type { Entity } from '../../../shared/types';
import { api } from '../../api';
import { useWorkspace } from '../../store';
import { Button, ErrorNotice } from '../ui';

export function Backlinks({ id, onOpen }: { id: string; onOpen: (id: string) => void }) {
 const { entities } = useWorkspace();
 const [links, setLinks] = useState<Entity[]>([]), [error, setError] = useState('');
 const [retry, setRetry] = useState(0), [loading, setLoading] = useState(true);
 // Entity versions change after a mention, highlight, or manual connection is saved.
 const revision = entities.map(entity => `${entity.id}:${entity.version}`).join(',');
 useEffect(() => { const abort = new AbortController(); setLoading(true); api<{ entities: Entity[] }>(`/entities/${id}/backlinks`, { signal: abort.signal }).then(result => { if (!abort.signal.aborted) { setLinks(result.entities); setError(''); } }).catch(e => { if (!abort.signal.aborted) setError(e.message); }).finally(() => { if (!abort.signal.aborted) setLoading(false); }); return () => abort.abort(); }, [id, revision, retry]);
 return <section className="document-backlinks" aria-label="Backlinks"><div className="document-section-label"><Link2 size={14} /><strong>Backlinks</strong><span>{links.length}</span></div>{error ? <ErrorNotice onRetry={() => setRetry(value => value + 1)}>{error}</ErrorNotice> : loading ? <p className="muted small">Finding linked items…</p> : links.length ? <div className="document-backlink-list">{links.map(link => <button type="button" key={link.id} onClick={() => onOpen(link.id)}><span>{link.title}</span><small>{link.data.type || link.kind}</small><ArrowUpRight size={13} /></button>)}</div> : <p className="field-hint">Items that mention or connect to this source will appear here.</p>}</section>;
}

export function RelatedSources({ query, currentId, linkedIds, onInsert, onOpen }: { query: string; currentId: string; linkedIds: string[]; onInsert: (entity: Entity) => void; onOpen: (id: string) => void }) {
 const [enabled, setEnabled] = useState(false), [filter, setFilter] = useState('all');
 const [results, setResults] = useState<{ entity: Entity; score: number }[]>([]), [method, setMethod] = useState('');
 const [loading, setLoading] = useState(false), [error, setError] = useState(''), [retry, setRetry] = useState(0);
 const sequence = useRef(0);
 const text = query.trim().slice(0, 6000);
 useEffect(() => {
  const run = ++sequence.current, abort = new AbortController(); setError('');
  if (!enabled || text.length < 12) { setResults([]); setLoading(false); return; }
  setLoading(true); setResults([]);
  const timer = setTimeout(() => { api<{ results: { entity: Entity; score: number }[]; method: string }>('/search/semantic', { method: 'POST', body: JSON.stringify({ query: text }), signal: abort.signal }).then(result => { if (run === sequence.current && !abort.signal.aborted) { setResults(result.results); setMethod(result.method); } }).catch(e => { if (run === sequence.current && !abort.signal.aborted) setError(e.message); }).finally(() => { if (run === sequence.current && !abort.signal.aborted) setLoading(false); }); }, 750);
  return () => { clearTimeout(timer); abort.abort(); };
 }, [enabled, text, retry]);
 const visible = results.filter(({ entity }) => entity.id !== currentId && !linkedIds.includes(entity.id) && (filter === 'all' || (filter === 'table' ? entity.kind === 'table' : filter === 'link' ? entity.data.type === 'link' : entity.kind === 'item' && !['link', 'highlight'].includes(entity.data.type)))).slice(0, 5);
 return <section className="related-sources" aria-label="Related sources"><div className="document-section-label"><Sparkles size={14} /><strong>Related sources</strong><label><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />{enabled ? 'On' : 'Off'}</label></div>{!enabled ? <p className="field-hint">Find workspace sources related to the paragraph you’re writing. Uses your workspace search settings.</p> : <><div className="related-source-filters" aria-label="Related source type">{[['all', 'All'], ['note', 'Notes'], ['link', 'Links'], ['table', 'Tables']].map(([id, label]) => <button type="button" key={id} aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}</button>)}<span>{method === 'keyword' ? 'Keyword search' : method === 'semantic' ? 'Semantic search' : ''}</span></div>{error ? <ErrorNotice onRetry={() => setRetry(value => value + 1)}>{error}</ErrorNotice> : loading ? <p className="field-hint" role="status">Finding related sources…</p> : !visible.length ? <p className="field-hint">{text.length < 12 ? 'Write a little more to find related sources.' : 'No new matches for this paragraph.'}</p> : <div className="related-source-results">{visible.map(({ entity }) => <div key={entity.id}><button type="button" onClick={() => onOpen(entity.id)}><strong>{entity.title}</strong><span>{(entity.content || entity.data.description || '').slice(0, 130)}</span></button><Button onMouseDown={event => event.preventDefault()} onClick={() => onInsert(entity)}>Insert {entity.kind === 'table' ? 'table' : 'mention'}</Button></div>)}</div>}</>}</section>;
}
