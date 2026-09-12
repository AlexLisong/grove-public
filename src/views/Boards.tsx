import { useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Grid2X2, Move, Plus, ArrowLeft, Layers, Share2, Trash2, Pencil, X, Link2 } from 'lucide-react';
import type { Entity, EntityInput, BoardPlacement } from '../../shared/types';
import { useWorkspace } from '../store';
import { api, ApiError, post } from '../api';
import { Button, IconButton, PageHeader, Modal, Field, Input, Empty, SearchBox, timeAgo } from '../components/ui';
import { ItemCard, ItemIcon, CreateModal } from '../components/items';
import { BoardCanvas, type BoardCanvasHandle } from '../components/BoardCanvas';

type Placement = BoardPlacement & { placementId?: string; height?: number };
const placementKey = (p: Placement) => p.placementId || p.id;
export function Boards() { const app = useWorkspace(); const navigate = useNavigate(); const [create, setCreate] = useState(false); const [space, setSpace] = useState(''); const [q, setQ] = useState(''); const spaces = app.entities.filter(e => e.kind === 'space'); const boards = app.entities.filter(e => e.kind === 'board' && (!space || e.data.spaceId === space || e.parentId === space) && e.title.toLowerCase().includes(q.toLowerCase())); return <><PageHeader eyebrow="ROOM TO THINK" title="Boards" description="Put the pieces together. Find something new."><Button tone="primary" onClick={() => setCreate(true)}><Plus size={16} />New board</Button></PageHeader><div className="filter-toolbar"><SearchBox value={q} onChange={setQ} placeholder="Find a board…" /><select aria-label="Filter space" value={space} onChange={e => setSpace(e.target.value)}><option value="">All spaces</option>{spaces.map(s => <option value={s.id} key={s.id}>{s.title}</option>)}</select><div className="spacer" /><span className="muted small">{boards.length} boards</span></div>{boards.length ? <div className="board-grid">{boards.map((b, i) => <button className="board-tile" onClick={() => navigate(`/boards/${b.id}`)} key={b.id}><div className={`board-art art-${i % 4}`}>{(b.data.placements || []).slice(0, 4).map((p: BoardPlacement, j: number) => { const item = app.entities.find(e => e.id === p.id); return <div className={`mini-paper paper-${j}`} key={`${p.id}-${j}`}><span /><p>{item?.content?.slice(0, 65) || item?.title}</p><span /></div>; })}{!(b.data.placements || []).length && <><div className="mini-paper paper-0 blank-paper"><Plus size={22} /></div><div className="mini-paper paper-1 blank-paper" /></>}</div><div className="board-tile-caption"><div><h3>{b.title}</h3><p>{b.data.placements?.length || 0} items · {timeAgo(b.updatedAt)}</p></div><Layers size={18} /></div></button>)}</div> : <Empty icon={<Layers size={30} />} title="Give a project its own space" description="Collect research, arrange ideas, and keep your writing close. A board holds it all." action={<Button tone="primary" onClick={() => setCreate(true)}><Plus size={15} />Create a board</Button>} />}{create && <CreateModal initial="board" onClose={() => setCreate(false)} />}</>; }

export function BoardDetail() {
 const { id } = useParams(), app = useWorkspace(), navigate = useNavigate();
 const board = app.entities.find(e => e.id === id && e.kind === 'board');
 const [create, setCreate] = useState(false), [picker, setPicker] = useState(false), [settings, setSettings] = useState(false);
 const [section, setSection] = useState(''), [newSection, setNewSection] = useState(''), [shareUrl, setShareUrl] = useState('');
 const canvas = useRef<BoardCanvasHandle>(null), mutations = useRef<Promise<unknown>>(Promise.resolve());
 if (!board) return <Empty title="Board not found" description="This board may have been moved to trash, or you may not have access." action={<Button onClick={() => navigate('/boards')}>Back to boards</Button>} />;
 const currentBoard = board;
 const placements: Placement[] = board.data.placements || [], view = board.data.view || 'grid';
 const visible = placements.filter(p => (!section || p.section === section) && app.entities.some(e => e.id === p.id));
 async function ready(action: () => void) { if (!canvas.current || await canvas.current.flush()) action(); else app.notify('Your canvas has unsaved changes. Retry the save or use the recovery options first.', 'error'); }
 // Board controls share one queue, and wait for the canvas queue before changing data.
 // Fetch the current document because the API replaces nested data in its entirety.
 function changeBoard(change: (latest: Entity) => Partial<EntityInput>) {
  return app.run(async () => {
   if (canvas.current && !await canvas.current.flush()) throw new Error('Save or recover the pending canvas changes first.');
   const job = mutations.current.catch(() => {}).then(async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
     const { entity: latest } = await api<{ entity: Entity }>(`/entities/${currentBoard.id}`);
     try { return await app.update(currentBoard.id, { ...change(latest), version: latest.version }); }
     catch (reason) { if (!(reason instanceof ApiError) || reason.status !== 409 || attempt === 2) throw reason; }
    }
   });
   mutations.current = job; return job;
  });
 }
 const saveData = (change: Record<string, unknown> | ((data: Entity['data']) => Record<string, unknown>)) => changeBoard(latest => ({ data: { ...latest.data, ...(typeof change === 'function' ? change(latest.data) : change) } }));
 return <>
  <div className="breadcrumb"><button onClick={() => navigate('/boards')}><ArrowLeft size={14} />Boards</button><span>/</span><span>{board.title}</span></div>
  <PageHeader title={board.title} description={`${placements.length} ideas, connected in one place.`}>
   <Button onClick={() => void ready(() => setSettings(true))}><Pencil size={14} />Details</Button>
   <Button onClick={() => void ready(() => { void app.run(async () => { const r = await post(`/entities/${board.id}/share`, { enabled: true, allowDuplicate: true }); setShareUrl(r.url); }, 'View link created'); })}><Share2 size={15} />Share</Button>
   <Button tone="primary" onClick={() => void ready(() => setCreate(true))}><Plus size={16} />Create</Button>
  </PageHeader>
  <div className="filter-toolbar">
   <div className="segmented"><Button tone={view === 'grid' ? 'default' : 'ghost'} onClick={() => void saveData({ view: 'grid' })}><Grid2X2 size={15} />Grid</Button><Button tone={view === 'canvas' ? 'default' : 'ghost'} onClick={() => void saveData({ view: 'canvas' })}><Move size={15} />Canvas</Button></div>
   <select aria-label="Board section" value={section} onChange={e => setSection(e.target.value)}><option value="">All sections</option>{(board.data.sections || []).map((s: string) => <option key={s}>{s}</option>)}</select>
   <div className="spacer" /><Button tone="ghost" onClick={() => void ready(() => setPicker(true))}><Link2 size={15} />Add from library</Button>
  </div>
  {view === 'canvas' ? <BoardCanvas key={board.id} ref={canvas} board={board} section={section} onAddFromLibrary={() => void ready(() => setPicker(true))} /> : visible.length ? <div className="item-grid">{visible.map(p => {
   const item = app.entities.find(e => e.id === p.id)!;
   return <div key={placementKey(p)} className="board-item-wrap"><ItemCard entity={item} /><div className="board-item-controls">
    <select aria-label={`Section for ${item.title}`} value={p.section || ''} onChange={e => { const value = e.target.value; void saveData(data => ({ placements: (data.placements || []).map((valueInBoard: Placement) => placementKey(valueInBoard) === placementKey(p) ? { ...valueInBoard, section: value } : valueInBoard) })); }}><option value="">No section</option>{(board.data.sections || []).map((s: string) => <option key={s}>{s}</option>)}</select>
    <IconButton label={`Remove ${item.title} from board`} onClick={() => void saveData(data => ({ placements: (data.placements || []).filter((value: Placement) => placementKey(value) !== placementKey(p)) }))}><X size={13} /></IconButton>
   </div></div>;
  })}</div> : <Empty title="Start connecting the dots" description="Add a note, a link, or something from your library. This space is yours to shape." action={<Button onClick={() => setPicker(true)}><Plus size={15} />Add from library</Button>} />}
  {create && <CreateModal parentId={board.id} onClose={() => setCreate(false)} />}
  {picker && <BoardPicker board={board} onClose={() => setPicker(false)} onAdd={async ids => {
   const result = await saveData(data => {
    const previous: Placement[] = data.placements || [], existing = new Set(previous.map(p => p.id));
    return { placements: [...previous, ...ids.filter(id => !existing.has(id)).map((id, i) => ({ id, x: 40 + (i % 4) * 310, y: 40 + Math.floor(i / 4) * 350, section }))] };
   });
   if (result) { setPicker(false); app.notify(`${ids.length} items added`); }
  }} />}
  {shareUrl && <Modal title="Share your board" onClose={() => setShareUrl('')}><div className="form-stack"><p className="muted">Anyone with this link can view this board and duplicate its shared items.</p><Input value={shareUrl} readOnly /><Button tone="primary" onClick={() => void app.run(() => navigator.clipboard.writeText(shareUrl), 'Link copied')}>Copy link</Button><Button onClick={() => void app.run(async () => { await post(`/entities/${board.id}/share`, { enabled: false }); setShareUrl(''); }, 'Link revoked')}>Revoke link</Button></div></Modal>}
  {settings && <Modal title="Board details" onClose={() => setSettings(false)}><div className="form-stack">
   <Field label="Name"><Input defaultValue={board.title} onBlur={e => { const value = e.target.value; if (value && value !== board.title) void changeBoard(() => ({ title: value })); }} /></Field>
   <Field label="Space"><select aria-label="Board space" value={board.data.spaceId || ''} onChange={e => void saveData({ spaceId: e.target.value })}><option value="">No space</option>{app.entities.filter(e => e.kind === 'space').map(s => <option value={s.id} key={s.id}>{s.title}</option>)}</select></Field>
   <Field label="Sections"><div className="choice-chips">{(board.data.sections || []).map((s: string) => <button key={s} onClick={() => void saveData(data => ({ sections: (data.sections || []).filter((x: string) => x !== s), placements: (data.placements || []).map((p: Placement) => p.section === s ? { ...p, section: '' } : p), canvasObjects: (data.canvasObjects || []).map((o: { section?: string }) => o.section === s ? { ...o, section: '' } : o) }))}>{s}<X size={12} /></button>)}</div></Field>
   <form className="inline-form" onSubmit={e => { e.preventDefault(); const value = newSection.trim(); if (value) void saveData(data => ({ sections: [...new Set([...(data.sections || []), value])] })).then(result => { if (result) setNewSection(''); }); }}><Input placeholder="New section" value={newSection} onChange={e => setNewSection(e.target.value)} /><Button type="submit"><Plus size={15} />Add</Button></form>
   <Button tone="danger" onClick={() => void app.run(async () => { await app.remove(board.id); navigate('/boards'); })}><Trash2 size={15} />Move board to trash</Button>
  </div></Modal>}
 </>;
}
function BoardPicker({ board, onClose, onAdd }: { board: Entity; onClose: () => void; onAdd: (ids: string[]) => Promise<void> }) {
 const app = useWorkspace(), [q, setQ] = useState(''), [selected, setSelected] = useState<string[]>([]), [busy, setBusy] = useState(false);
 const ids: string[] = (board.data.placements || []).map((p: BoardPlacement) => p.id);
 const options = app.entities.filter(e => ['item', 'table', 'chat'].includes(e.kind) && !ids.includes(e.id) && e.title.toLowerCase().includes(q.toLowerCase()));
 return <Modal title="Add from your library" onClose={onClose} footer={<Button tone="primary" busy={busy} disabled={!selected.length} onClick={() => { setBusy(true); void onAdd(selected).finally(() => setBusy(false)); }}>Add {selected.length || ''} items</Button>}><SearchBox value={q} onChange={setQ} placeholder="Search your library…" /><div className="source-options spacious">{options.map(e => <label key={e.id}><input type="checkbox" aria-label={`Add ${e.title} to board`} checked={selected.includes(e.id)} onChange={() => setSelected(selected.includes(e.id) ? selected.filter(id => id !== e.id) : [...selected, e.id])} /><ItemIcon entity={e} /><span>{e.title}</span><small>{e.data.type || e.kind}</small></label>)}{!options.length && <p className="muted">Everything matching this search is already here.</p>}</div></Modal>;
}
