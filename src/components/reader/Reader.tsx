import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { BookOpen, Check, ChevronLeft, ChevronRight, Highlighter, Search, X } from 'lucide-react';
import type { Entity } from '../../../shared/types';
import { api, getFileBlob, safeUrl } from '../../api';
import { useWorkspace } from '../../store';
import { Button, ErrorNotice, Field, IconButton } from '../ui';
import { DocumentContent, EntityReference, markdownDocument, referenceId } from '../editor/DocumentNodes';
import { locateAnchor, selectedAnchor, type PassageAnchor } from './anchors';
import { Narration, type NarrationHandle } from './Narration';
import type { HighlightColor, ReadingController } from './useReadingState';
import './reader.css';

const colors: HighlightColor[] = ['yellow', 'green', 'blue', 'pink', 'purple'];
function PDFOriginal({ entity, page }: { entity: Entity; page: number }) {
 const [url, setUrl] = useState(''), [error, setError] = useState(''), [retry, setRetry] = useState(0);
 useEffect(() => { let live = true, objectUrl = ''; setUrl(''); setError(''); getFileBlob(entity.id).then(blob => { if (live) { objectUrl = URL.createObjectURL(blob); setUrl(objectUrl); } }).catch(e => { if (live) setError(e.message); }); return () => { live = false; if (objectUrl) URL.revokeObjectURL(objectUrl); }; }, [entity.id, retry]);
 return error ? <ErrorNotice onRetry={() => setRetry(value => value + 1)}>{error}</ErrorNotice> : url ? <iframe title={`Original PDF: ${entity.title}`} className="pdf-preview" src={`${url}#page=${page}`} /> : <p className="field-hint">Opening original PDF…</p>;
}

export function Reader({ entity, reading, canCreate, original }: { entity: Entity; reading: ReadingController; canCreate: boolean; original?: ReactNode }) {
 const app = useWorkspace(), contentRef = useRef<HTMLDivElement>(null), scrollRef = useRef<HTMLDivElement>(null), narration = useRef<NarrationHandle>(null);
 const [pdfView, setPdfView] = useState('text'), [message, setMessage] = useState(''), [creating, setCreating] = useState(false), [search, setSearch] = useState(''), [allChapters, setAllChapters] = useState(true), [searchTarget, setSearchTarget] = useState<(PassageAnchor & { chapter: number }) | null>(null);
 const [board, setBoard] = useState(''), [selectedHighlight, setSelectedHighlight] = useState(''), [pendingAnchor, setPendingAnchor] = useState<PassageAnchor | null>(null), [reopenAnchor, setReopenAnchor] = useState<PassageAnchor | null>(null);
 const selectionRef = useRef<PassageAnchor | null>(null), suppressScroll = useRef<number | null>(null), restored = useRef('');
 const chapters = useMemo<{ title: string; content: string }[]>(() => Array.isArray(entity.data.chapters) ? entity.data.chapters.filter((chapter: any) => chapter && typeof chapter.content === 'string').map((chapter: any, index: number) => ({ title: chapter.title || `Chapter ${index + 1}`, content: chapter.content })) : [], [entity.data.chapters]);
 const chapter = chapters.length ? Math.max(0, Math.min(chapters.length - 1, reading.state.chapter)) : 0;
 const text = chapters.length ? chapters[chapter].content : entity.content;
 const displayDocument = useMemo(() => chapters.length ? null : entity.data.editorJSON?.type === 'doc' ? entity.data.editorJSON : markdownDocument(text), [chapters.length, entity.data.editorJSON, text]);
 const isPDF = (entity.data.mime || entity.data.mimeType) === 'application/pdf';
 const highlights = app.entities.filter(item => item.data.type === 'highlight' && item.data.sourceId === entity.id);
 const requested = new URLSearchParams(window.location.search).get('highlight');
 const requestedHighlight = highlights.find(item => item.id === requested);
 const highlightsRevision = highlights.map(item => `${item.id}:${item.version}`).join(',');
 const [paintAvailable] = useState(() => typeof CSS !== 'undefined' && 'highlights' in CSS && 'Highlight' in window);
 const [narrationText, setNarrationText] = useState(text);
 const searchResults = useMemo(() => {
  const query = search.trim().toLowerCase(); if (query.length < 2) return [];
  const sources = chapters.length ? chapters.map((source, index) => ({ ...source, chapter: index })).filter(source => allChapters || source.chapter === chapter) : [{ title: entity.title, content: contentRef.current?.textContent || text, chapter: 0 }];
  const result: (PassageAnchor & { chapter: number; title: string; excerpt: string })[] = [];
  for (const source of sources) { let index = source.content.toLowerCase().indexOf(query); while (index !== -1 && result.length < 50) { result.push({ chapter: source.chapter, title: source.title, quote: source.content.slice(index, index + query.length), start: index, end: index + query.length, prefix: source.content.slice(Math.max(0, index - 80), index), suffix: source.content.slice(index + query.length, index + query.length + 80), excerpt: source.content.slice(Math.max(0, index - 45), index + query.length + 75) }); index = source.content.toLowerCase().indexOf(query, index + query.length); } }
  return result;
 }, [search, allChapters, chapter, chapters, text, entity.title]);
 function changeChapter(next: number, fromNarration = false) { if (!fromNarration) narration.current?.stop(); if (next !== chapter) { reading.update({ chapter: next, scrollTop: 0, progress: next / Math.max(1, chapters.length) }); selectionRef.current = null; setPendingAnchor(null); setMessage(''); } }
 useEffect(() => { setNarrationText(contentRef.current?.textContent || text); }, [text, entity.data.editorJSON, pdfView]);
 useLayoutEffect(() => {
  if (!reading.ready || !scrollRef.current) return;
  const key = `${chapter}:${pdfView}`; if (restored.current === key) return; restored.current = key;
  const pane = scrollRef.current; pane.scrollTop = reading.state.scrollTop || 0; suppressScroll.current = pane.scrollTop;
 }, [reading.ready, chapter, pdfView]);
 useEffect(() => {
  const capture = () => { if (!contentRef.current) return; const anchor = selectedAnchor(contentRef.current, chapters.length ? chapter : undefined); if (anchor) { selectionRef.current = anchor; setPendingAnchor(anchor); } };
  document.addEventListener('selectionchange', capture); return () => document.removeEventListener('selectionchange', capture);
 }, [chapter, chapters.length, pdfView]);
 function reveal(anchor: PassageAnchor, select = true) {
  const root = contentRef.current; if (!root) return false; const range = locateAnchor(root, anchor); if (!range) return false;
  if (select) { const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range); }
  const box = range.getBoundingClientRect(), pane = scrollRef.current; if (pane) pane.scrollTop += box.top - pane.getBoundingClientRect().top - 80;
  root.focus({ preventScroll: true }); return true;
 }
 function openHighlight(highlight: Entity) {
  setSelectedHighlight(highlight.id); const anchor: PassageAnchor = highlight.data.anchor || { quote: highlight.content, start: 0, end: highlight.content.length, prefix: '', suffix: '' };
  if (chapters.length && typeof anchor.chapter === 'number' && anchor.chapter !== chapter) changeChapter(Math.min(chapters.length - 1, anchor.chapter));
  setPdfView('text'); setReopenAnchor(anchor);
 }
 useEffect(() => { if (!requestedHighlight || !reading.ready) return; openHighlight(requestedHighlight); }, [requestedHighlight?.id, reading.ready]);
 useEffect(() => { if (!reopenAnchor || pdfView !== 'text' || reopenAnchor.chapter !== undefined && reopenAnchor.chapter !== chapter) return; const frame = requestAnimationFrame(() => { setMessage(reveal(reopenAnchor) ? 'Passage located.' : 'The saved quote could not be located in this version of the source. Your highlight is kept below.'); setReopenAnchor(null); }); return () => cancelAnimationFrame(frame); }, [chapter, pdfView, reopenAnchor]);
 useEffect(() => {
  if (!paintAvailable || !contentRef.current || pdfView !== 'text') return;
  const registry = (CSS as any).highlights, Highlight = (window as any).Highlight;
  for (const color of colors) { const ranges = highlights.filter(item => (item.data.color || 'yellow') === color && (item.data.anchor?.chapter === undefined || item.data.anchor.chapter === chapter)).map(item => locateAnchor(contentRef.current!, item.data.anchor || { quote: item.content, start: 0, end: item.content.length, prefix: '', suffix: '' })).filter(Boolean); registry.set(`grove-reader-${color}`, new Highlight(...ranges)); }
  return () => { for (const color of colors) registry.delete(`grove-reader-${color}`); };
 }, [paintAvailable, highlightsRevision, chapter, text, entity.data.editorJSON, pdfView]);
 useEffect(() => {
  if (!searchTarget || searchTarget.chapter !== chapter || !contentRef.current) return;
  const frame = requestAnimationFrame(() => { if (!reveal(searchTarget)) setMessage('The matching text is in this chapter, but its formatted passage could not be selected.'); setSearchTarget(null); }); return () => cancelAnimationFrame(frame);
 }, [searchTarget, chapter, text, pdfView]);
 async function createHighlight() {
  const root = contentRef.current, anchor = root ? selectedAnchor(root, chapters.length ? chapter : undefined) || selectionRef.current : null;
  if (!anchor || (anchor.chapter !== undefined && anchor.chapter !== chapter)) { setMessage('Select a passage in the readable text first.'); return; }
  if (root && !locateAnchor(root, anchor)) { setMessage('Select this passage again before saving it.'); return; }
  setCreating(true); setMessage('');
  try { const created = await app.create({ kind: 'item', visibility: 'private', title: anchor.quote.slice(0, 90), content: anchor.quote, data: { type: 'highlight', sourceId: entity.id, sourceTitle: entity.title, url: entity.data.url, color: reading.state.highlightColor, anchor }, tags: entity.tags }); setSelectedHighlight(created.id); setMessage('Highlight saved. Reopen it here or from your library.'); selectionRef.current = null; setPendingAnchor(null); window.getSelection()?.removeAllRanges(); } catch (e) { setMessage((e as Error).message); } finally { setCreating(false); }
 }
 async function addToBoard() {
  if (!board || !selectedHighlight) return;
  await app.run(async () => { const { entity: target } = await api<{ entity: Entity }>(`/entities/${board}`); if (!(target.data.placements || []).some((placement: any) => placement.id === selectedHighlight)) await app.update(target.id, { version: target.version, data: { ...target.data, placements: [...(target.data.placements || []), { id: selectedHighlight, x: 60, y: 60 }] } }); }, 'Highlight added to the board');
 }
 return <div className="reader-workspace">
  <div className="reader-progress"><BookOpen size={14} /><span>{reading.ready ? `${Math.round(reading.state.progress * 100)}% read` : 'Restoring your place…'}</span><progress aria-label="Reading progress" value={reading.state.progress} max="1" /><small>{reading.saving ? 'Saving your place…' : reading.dirty ? 'Personal changes pending' : 'Your place is saved'}</small><Button disabled={!reading.ready} onClick={() => { reading.update({ progress: 1, scrollTop: scrollRef.current?.scrollHeight || 0 }); }}><Check size={12} />Finished</Button></div>
  {reading.error && <ErrorNotice onRetry={reading.retry}>Your personal reading state could not be saved or loaded. {reading.error} Pending changes stay on this device.</ErrorNotice>}
  {chapters.length > 0 && <div className="reader-chapters"><IconButton label="Previous chapter" disabled={!reading.ready || chapter === 0} onClick={() => changeChapter(chapter - 1)}><ChevronLeft size={16} /></IconButton><select aria-label="Book chapter" value={chapter} disabled={!reading.ready} onChange={event => changeChapter(Number(event.target.value))}>{chapters.map((item, index) => <option key={index} value={index}>{index + 1}. {item.title}</option>)}</select><IconButton label="Next chapter" disabled={!reading.ready || chapter === chapters.length - 1} onClick={() => changeChapter(chapter + 1)}><ChevronRight size={16} /></IconButton><span>{chapter + 1} / {chapters.length}</span></div>}
  {isPDF && <><div className="reader-pdf-tabs" aria-label="PDF view"><button type="button" aria-pressed={pdfView === 'text'} onClick={() => setPdfView('text')}>Readable text</button><button type="button" aria-pressed={pdfView === 'original'} onClick={() => { narration.current?.stop(); setPdfView('original'); }}>Original PDF</button>{pdfView === 'original' && <label>Saved page<input type="number" min="1" max="10000" aria-label="Saved PDF page" value={reading.state.chapter + 1} onChange={event => reading.update({ chapter: Math.max(0, Math.min(9999, Number(event.target.value) - 1)) })} /></label>}</div><p className="field-hint">{pdfView === 'original' ? 'Set the page field to save your place. Page changes inside the browser PDF viewer are not tracked.' : 'Search and highlights use extracted text. Scans without text and complex layouts may need OCR or the original PDF.'}</p></>}
  <div className="reader-search"><Search size={14} /><input aria-label="Search within source" value={search} onChange={event => setSearch(event.target.value)} placeholder={chapters.length ? 'Search this book…' : 'Search this source…'} />{search && <IconButton label="Clear reader search" onClick={() => setSearch('')}><X size={13} /></IconButton>}{chapters.length > 1 && <label><input type="checkbox" checked={allChapters} onChange={event => setAllChapters(event.target.checked)} />All chapters</label>}</div>
  {search.trim().length >= 2 && <div className="reader-search-results" aria-label="Search results"><span>{searchResults.length === 50 ? '50+' : searchResults.length} matches</span>{searchResults.map((result, index) => <button type="button" key={index} onClick={() => { if (chapters.length) changeChapter(result.chapter); setPdfView('text'); setSearchTarget(result); }}><strong>{result.title}</strong><span>{result.excerpt}</span></button>)}</div>}
  {pdfView === 'original' && isPDF ? <PDFOriginal entity={entity} page={reading.state.chapter + 1} /> : <><div className="reader-highlight-toolbar"><span>Highlight</span><div className="reader-colors" aria-label="Highlight colors">{colors.map(color => <button type="button" key={color} className={`highlight-color ${color}`} aria-label={`${color[0].toUpperCase() + color.slice(1)} highlight`} aria-pressed={reading.state.highlightColor === color} onMouseDown={event => event.preventDefault()} onClick={() => reading.update({ highlightColor: color })} />)}</div>{canCreate && <Button busy={creating} onMouseDown={event => event.preventDefault()} onClick={() => void createHighlight()}><Highlighter size={14} />Save highlight</Button>}<span className="field-hint">{pendingAnchor ? `${pendingAnchor.quote.length} characters selected` : 'Select text to save a passage'}</span></div>
   <div className="reader-scroll" ref={scrollRef} onScroll={event => { if (!reading.ready) return; const pane = event.currentTarget; if (suppressScroll.current !== null) { const restoredTop = suppressScroll.current; suppressScroll.current = null; if (Math.abs(pane.scrollTop - restoredTop) < 2) return; } const distance = pane.scrollHeight - pane.clientHeight, ratio = distance > 2 ? Math.max(0, Math.min(1, pane.scrollTop / distance)) : 1; reading.update({ scrollTop: pane.scrollTop, progress: (chapter + ratio) / Math.max(1, chapters.length) }); }}><div className="reader-text" ref={contentRef} tabIndex={-1} aria-label="Readable source text">{!text && !entity.data.editorJSON ? <p className="muted">There is no readable text in this item yet.</p> : displayDocument ? <DocumentContent doc={displayDocument} /> : <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children }) => referenceId(href) ? <EntityReference id={referenceId(href)!} label={String(children).replace(/^@/, '')} /> : <a href={safeUrl(href)} target="_blank" rel="noopener noreferrer">{children}</a> }}>{text}</ReactMarkdown>}</div></div>
   <Narration ref={narration} text={narrationText} chapter={chapter} chapters={chapters} reading={reading} onChapter={next => { if (chapters.length) changeChapter(next, true); }} />
  </>}
  {entity.data.extractionWarning && <p className="reader-warning">{entity.data.extractionWarning}</p>}
  {!isPDF && original && <details className="reader-original"><summary>Original file</summary>{original}</details>}
  {message && <p className="reader-message" role="status">{message}</p>}
  {highlights.length > 0 && <section className="reader-highlights"><h3>Saved passages <span>{highlights.length}</span></h3>{!paintAvailable && <p className="field-hint">This browser shows saved passages in the list. Open a passage to select it in the source.</p>}<div>{highlights.map(highlight => <button type="button" key={highlight.id} className={`reader-highlight-card ${highlight.data.color || 'yellow'}`} aria-pressed={selectedHighlight === highlight.id} onClick={() => openHighlight(highlight)}><q>{highlight.content}</q><span>{typeof highlight.data.anchor?.chapter === 'number' ? `Chapter ${highlight.data.anchor.chapter + 1} · ` : ''}Open passage</span></button>)}</div>{canCreate && selectedHighlight && <div className="reader-board-add"><select aria-label="Highlight board" value={board} onChange={event => setBoard(event.target.value)}><option value="">Choose a board…</option>{app.entities.filter(item => item.kind === 'board').map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select><Button disabled={!board} onClick={() => void addToBoard()}>Add highlight to board</Button></div>}</section>}
  <Field label="Personal reading notes" hint="Only you can see these notes. The source text stays intact."><textarea aria-label="Personal reading notes" rows={4} maxLength={100000} value={reading.state.notes} disabled={!reading.ready} placeholder="A thought to come back to…" onChange={event => reading.update({ notes: event.target.value })} /></Field>
 </div>;
}
