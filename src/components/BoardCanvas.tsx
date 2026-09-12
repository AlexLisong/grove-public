import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { ArrowUpRight, Circle, Copy, Download, Eraser, Grid2X2, Hand, HelpCircle, Layers, Magnet, Maximize, Minus, MousePointer2, Move, Pencil, Plus, Redo2, Square, Trash2, Type, Undo2, Wand2, X } from 'lucide-react';
import type { BoardPlacement, Entity } from '../../shared/types';
import { api, ApiError, saveBlob } from '../api';
import { useWorkspace } from '../store';
import { Button, IconButton, Modal } from './ui';
import { ItemCard } from './items';
import './BoardCanvas.css';

type Point = { x: number; y: number };
type Rect = Point & { width: number; height: number };
type Placement = BoardPlacement & { placementId?: string; height?: number };
type DrawingType = 'pen' | 'rectangle' | 'ellipse' | 'text' | 'line' | 'arrow';
type CanvasObject = Rect & { id: string; type: DrawingType; color: string; strokeWidth: number; points?: Point[]; text?: string; section?: string };
type Scene = { placements: Placement[]; objects: CanvasObject[]; settings: { grid: boolean; snap: boolean } };
type Tool = 'select' | 'hand' | DrawingType | 'eraser' | 'laser';
type HistoryEntry = { before: Scene; after: Scene };
export type BoardCanvasHandle = { flush: () => Promise<boolean> };

const MIN_ZOOM = .2, MAX_ZOOM = 3, GRID = 20;
const placementKey = (p: Placement) => p.placementId || p.id;
const itemKey = (p: Placement) => `item:${placementKey(p)}`;
const objectKey = (o: CanvasObject) => `object:${o.id}`;
function same(a: unknown, b: unknown): boolean {
 if (Object.is(a, b)) return true;
 if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
 const left = a as Record<string, unknown>, right = b as Record<string, unknown>, keys = Object.keys(left);
 return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && same(left[key], right[key]));
}
const clone = <T,>(value: T): T => structuredClone(value);
const finite = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
function readScene(board: Entity): Scene {
 return {
  placements: (Array.isArray(board.data.placements) ? board.data.placements : []).filter((p: Placement) => p && typeof p.id === 'string').map((p: Placement) => ({ ...p, x: finite(p.x, 40), y: finite(p.y, 40), ...(p.width !== undefined ? { width: Math.max(180, finite(p.width, 270)) } : {}), ...(p.height !== undefined ? { height: Math.max(170, finite(p.height, 290)) } : {}) })),
  objects: (Array.isArray(board.data.canvasObjects) ? board.data.canvasObjects : []).filter((o: CanvasObject) => o && typeof o.id === 'string' && ['pen', 'rectangle', 'ellipse', 'text', 'line', 'arrow'].includes(o.type)).map((o: CanvasObject) => ({ ...o, x: finite(o.x, 0), y: finite(o.y, 0), width: Math.max(1, finite(o.width, 100)), height: Math.max(1, finite(o.height, 100)), color: typeof o.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(o.color) ? o.color : '#c0d9bc', strokeWidth: Math.min(12, Math.max(1, finite(o.strokeWidth, 3))), ...(o.text !== undefined ? { text: typeof o.text === 'string' ? o.text : '' } : {}), ...(o.points ? { points: Array.isArray(o.points) ? o.points.filter(p => p && Number.isFinite(p.x) && Number.isFinite(p.y)).slice(0, 10000) : [] } : {}) })),
  settings: { grid: board.data.canvasSettings?.grid !== false, snap: board.data.canvasSettings?.snap !== false }
 };
}
function writeScene(scene: Scene) { return { placements: scene.placements, canvasObjects: scene.objects, canvasSettings: scene.settings }; }
class CanvasConflict extends Error { constructor() { super('This canvas was also edited elsewhere. Your work is kept on this device. Review the conflict or download a copy.'); } }

// Apply only the fields changed locally. Unrelated library additions, section changes,
// and edits by other clients survive a save, undo, or a gesture finishing during a save.
function mergeRecord<T extends object>(base: T, local: T, remote: T, strict: boolean): T {
 const result = { ...remote } as Record<string, unknown>;
 for (const key of new Set([...Object.keys(base), ...Object.keys(local)])) {
  const b = (base as any)[key], l = (local as any)[key], r = (remote as any)[key];
  if (same(b, l)) continue;
  if (strict && !same(r, b) && !same(r, l)) throw new CanvasConflict();
  if (l === undefined) delete result[key]; else result[key] = l;
 }
 return result as T;
}
function mergeCollection<T extends object>(base: T[], local: T[], remote: T[], key: (value: T) => string, strict: boolean): T[] {
 const b = new Map(base.map(value => [key(value), value])), l = new Map(local.map(value => [key(value), value]));
 const result = new Map(remote.map(value => [key(value), value]));
 for (const [id, before] of b) {
  const after = l.get(id), current = result.get(id);
  if (same(before, after)) continue;
  if (!after) { if (strict && current && !same(current, before)) throw new CanvasConflict(); result.delete(id); }
  else if (!current) { if (strict) throw new CanvasConflict(); result.set(id, after); }
  else result.set(id, mergeRecord(before, after, current, strict));
 }
 for (const [id, after] of l) if (!b.has(id)) {
  if (strict && result.has(id) && !same(result.get(id), after)) throw new CanvasConflict();
  result.set(id, after);
 }
 return [...result.values()];
}
function mergeScene(base: Scene, local: Scene, remote: Scene, strict = true): Scene {
 return {
  placements: mergeCollection(base.placements, local.placements, remote.placements, placementKey, strict),
  objects: mergeCollection(base.objects, local.objects, remote.objects, o => o.id, strict),
  settings: mergeRecord(base.settings, local.settings, remote.settings, strict)
 };
}

function useCanvasScene(board: Entity) {
 const app = useWorkspace(), appRef = useRef(app); appRef.current = app;
 const storageKey = `grove:canvas-draft:${app.session.user.id}:${board.workspaceId}:${board.id}`;
 const initial = useRef<{ base: Scene; scene: Scene; recovered: boolean } | null>(null);
 if (!initial.current) {
  const server = readScene(board);
  initial.current = { base: server, scene: server, recovered: false };
  try {
   const stored = JSON.parse(localStorage.getItem(storageKey) || 'null');
   if (stored?.base?.placements && stored?.scene?.placements && stored.scene.objects && stored.scene.settings && !same(stored.base, stored.scene)) initial.current = { base: stored.base, scene: stored.scene, recovered: true };
  } catch { /* An unavailable device cache does not prevent editing. */ }
 }
 const base = useRef(initial.current.base), current = useRef(initial.current.scene);
 const [scene, setScene] = useState(current.current);
 const [status, setStatus] = useState<'saved' | 'saving' | 'error'>(initial.current.recovered ? 'error' : 'saved');
 const [error, setError] = useState(initial.current.recovered ? 'Recovered unsaved canvas changes from this device. Retry to save them.' : '');
 const errorRef = useRef(error), [conflict, setConflict] = useState(false);
 const task = useRef<Promise<boolean> | null>(null), mounted = useRef(true);
 const [history, setHistory] = useState<{ past: HistoryEntry[]; future: HistoryEntry[] }>({ past: [], future: [] });
 const historyRef = useRef(history); historyRef.current = history;
 function persist() {
  try { if (same(base.current, current.current)) localStorage.removeItem(storageKey); else localStorage.setItem(storageKey, JSON.stringify({ base: base.current, scene: current.current, savedAt: Date.now() })); } catch { /* Keep the in-memory draft if device storage is full or disabled. */ }
 }
 function publish(next: Scene) { current.current = next; if (mounted.current) setScene(next); persist(); }
 function fail(reason: unknown) {
  const message = reason instanceof Error ? reason.message : 'Canvas could not be saved. Your changes are still here.';
  errorRef.current = message;
  if (mounted.current) { setStatus('error'); setError(message); setConflict(reason instanceof CanvasConflict || (reason instanceof ApiError && reason.status === 409)); }
  persist();
 }
 async function flush(retry = false, overwriteConflicts = false): Promise<boolean> {
  if (task.current) return task.current;
  if (errorRef.current && !retry) return false;
  errorRef.current = ''; setError(''); setConflict(false);
  const work = async () => {
   try {
    while (!same(base.current, current.current)) {
     if (mounted.current) setStatus('saving');
     const from = base.current, target = current.current;
     let saved: Entity | undefined;
     for (let attempt = 0; attempt < 3 && !saved; attempt++) {
      const { entity: latest } = await api<{ entity: Entity }>(`/entities/${board.id}`);
      const merged = mergeScene(from, target, readScene(latest), !overwriteConflicts);
      try { saved = await appRef.current.update(board.id, { version: latest.version, data: { ...latest.data, ...writeScene(merged) } }); }
      catch (reason) { if (!(reason instanceof ApiError) || reason.status !== 409 || attempt === 2) throw reason; }
     }
     if (!saved) throw new Error('The board is busy. Retry to save your canvas.');
     const server = readScene(saved);
     base.current = server;
     // A second completed gesture can arrive while the first request is in flight.
     publish(mergeScene(target, current.current, server, false));
    }
    if (mounted.current) setStatus('saved');
    return true;
   } catch (reason) { fail(reason); return false; }
  };
  task.current = work();
  try { return await task.current; } finally { task.current = null; }
 }
 function commit(next: Scene, from = current.current) {
  const before = current.current, after = mergeScene(from, next, before, false);
  if (same(before, after)) return;
  const nextHistory = { past: [...historyRef.current.past.slice(-99), { before, after }], future: [] };
  historyRef.current = nextHistory; setHistory(nextHistory); publish(after); void flush();
 }
 function travel(direction: 'undo' | 'redo') {
  const h = historyRef.current, entry = direction === 'undo' ? h.past.at(-1) : h.future.at(-1);
  if (!entry) return;
  try {
   const next = mergeScene(direction === 'undo' ? entry.after : entry.before, direction === 'undo' ? entry.before : entry.after, current.current);
   const nextHistory = direction === 'undo' ? { past: h.past.slice(0, -1), future: [...h.future, entry] } : { past: [...h.past, entry], future: h.future.slice(0, -1) };
   historyRef.current = nextHistory; setHistory(nextHistory); publish(next); void flush();
  } catch (reason) { fail(reason); }
 }
 useEffect(() => {
  if (task.current) return;
  const remote = readScene(board);
  if (same(remote, base.current)) return;
  try { const next = mergeScene(base.current, current.current, remote); base.current = remote; publish(next); }
  catch (reason) { fail(reason); }
 }, [board.version, board.data, status]);
 useEffect(() => {
  mounted.current = true;
  const unload = (event: BeforeUnloadEvent) => { if (!same(base.current, current.current)) { event.preventDefault(); event.returnValue = ''; } };
  window.addEventListener('beforeunload', unload);
  return () => { mounted.current = false; window.removeEventListener('beforeunload', unload); };
 }, []);
 async function reloadSaved() {
  if (task.current) await task.current;
  try {
   const { entity } = await api<{ entity: Entity }>(`/entities/${board.id}`);
   base.current = readScene(entity); publish(base.current); appRef.current.put(entity);
   const cleared = { past: [], future: [] }; historyRef.current = cleared; setHistory(cleared);
   errorRef.current = ''; setError(''); setConflict(false); setStatus('saved');
  } catch (reason) { fail(reason); }
 }
 return { scene, current, commit, status, error, conflict, history, flush, retry: () => flush(true), keepLocal: () => flush(true, true), reloadSaved, undo: () => travel('undo'), redo: () => travel('redo') };
}

const rectFor = (value: Placement | CanvasObject): Rect => ({ x: value.x, y: value.y, width: value.width || 270, height: value.height || 290 });
function bounds(rectangles: Rect[]): Rect {
 if (!rectangles.length) return { x: 0, y: 0, width: 0, height: 0 };
 const x = Math.min(...rectangles.map(r => r.x)), y = Math.min(...rectangles.map(r => r.y));
 return { x, y, width: Math.max(...rectangles.map(r => r.x + r.width)) - x, height: Math.max(...rectangles.map(r => r.y + r.height)) - y };
}
const intersects = (a: Rect, b: Rect) => a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y;
function segmentDistance(p: Point, a: Point, b: Point) {
 const dx = b.x - a.x, dy = b.y - a.y, t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
 return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}
function touches(o: CanvasObject, point: Point, tolerance: number) {
 const p = { x: point.x - o.x, y: point.y - o.y };
 if (o.points?.length) return o.points.some((end, i, points) => segmentDistance(p, points[Math.max(0, i - 1)], end) <= tolerance + o.strokeWidth);
 return p.x >= -tolerance && p.x <= o.width + tolerance && p.y >= -tolerance && p.y <= o.height + tolerance;
}
function drawing(type: DrawingType, points: Point[], color: string, strokeWidth: number, section: string, id: string, square = false): CanvasObject {
 let end = points.at(-1)!;
 const start = points[0];
 if (square && ['rectangle', 'ellipse'].includes(type)) { const edge = Math.max(Math.abs(end.x - start.x), Math.abs(end.y - start.y)); end = { x: start.x + Math.sign(end.x - start.x || 1) * edge, y: start.y + Math.sign(end.y - start.y || 1) * edge }; }
 if (square && ['line', 'arrow'].includes(type)) { const distance = Math.hypot(end.x - start.x, end.y - start.y), angle = Math.round(Math.atan2(end.y - start.y, end.x - start.x) / (Math.PI / 4)) * Math.PI / 4; end = { x: start.x + Math.cos(angle) * distance, y: start.y + Math.sin(angle) * distance }; }
 const used = type === 'pen' ? points : [start, end], box = bounds(used.map(p => ({ ...p, width: 0, height: 0 })));
 return { id, type, ...box, width: Math.max(box.width, 1), height: Math.max(box.height, 1), color, strokeWidth, section, ...(['pen', 'line', 'arrow'].includes(type) ? { points: used.map(p => ({ x: p.x - box.x, y: p.y - box.y })) } : {}) };
}
function Drawing({ object }: { object: CanvasObject }) {
 const o = object, common = { stroke: o.color, strokeWidth: o.strokeWidth, fill: 'none', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
 if (o.type === 'rectangle') return <rect x={0} y={0} width={o.width} height={o.height} rx={3} {...common} />;
 if (o.type === 'ellipse') return <ellipse cx={o.width / 2} cy={o.height / 2} rx={o.width / 2} ry={o.height / 2} {...common} />;
 if (o.type === 'text') return <foreignObject width={o.width} height={o.height}><div className="board-canvas-text" style={{ color: o.color, fontSize: Math.max(14, o.strokeWidth * 6) }}>{o.text}</div></foreignObject>;
 const points = o.points || [{ x: 0, y: 0 }, { x: o.width, y: o.height }];
 const end = points.at(-1)!, previous = points.at(-2) || points[0], angle = Math.atan2(end.y - previous.y, end.x - previous.x), head = 12 + o.strokeWidth;
 return <><polyline points={points.map(p => `${p.x},${p.y}`).join(' ')} {...common} />{o.type === 'arrow' && <polyline points={`${end.x - Math.cos(angle - .5) * head},${end.y - Math.sin(angle - .5) * head} ${end.x},${end.y} ${end.x - Math.cos(angle + .5) * head},${end.y - Math.sin(angle + .5) * head}`} {...common} />}</>;
}

type Gesture = {
 kind: 'pan' | 'move' | 'resize' | 'marquee' | 'draw' | 'erase' | 'laser';
 before: Scene; start: Point; client: Point; pointerId: number; selection: string[];
 source?: Scene; keys?: string[]; viewport?: Point; rect?: Rect; key?: string; drawingType?: DrawingType; points?: Point[]; objectId?: string; moved?: boolean; toggleOffKey?: string;
};
const toolButtons: { id: Tool; label: string; icon: typeof Hand; shortcut: string }[] = [
 { id: 'select', label: 'Select', icon: MousePointer2, shortcut: 'V' }, { id: 'hand', label: 'Hand', icon: Hand, shortcut: 'H' },
 { id: 'pen', label: 'Pen', icon: Pencil, shortcut: 'P' }, { id: 'eraser', label: 'Eraser', icon: Eraser, shortcut: 'E' },
 { id: 'rectangle', label: 'Rectangle', icon: Square, shortcut: 'R' }, { id: 'ellipse', label: 'Ellipse', icon: Circle, shortcut: 'O' },
 { id: 'text', label: 'Text', icon: Type, shortcut: 'T' }, { id: 'line', label: 'Line', icon: Minus, shortcut: 'L' },
 { id: 'arrow', label: 'Arrow', icon: ArrowUpRight, shortcut: 'A' }, { id: 'laser', label: 'Laser', icon: Wand2, shortcut: 'K' }
];

export const BoardCanvas = forwardRef<BoardCanvasHandle, { board: Entity; section: string; onAddFromLibrary: () => void }>(function BoardCanvas({ board, section, onAddFromLibrary }, ref) {
 const app = useWorkspace(), canvas = useCanvasScene(board);
 const [permission, setPermission] = useState<'view' | 'comment' | 'edit' | 'manage' | null>(null);
 const canEdit = permission === 'edit' || permission === 'manage';
 const viewport = useRef<HTMLDivElement>(null), gesture = useRef<Gesture | null>(null), previewRef = useRef<Scene | null>(null);
 const [preview, setPreview] = useState<Scene | null>(null), [tool, setTool] = useState<Tool>('select'), [selected, setSelected] = useState<string[]>([]);
 const [view, setView] = useState({ x: 30, y: 30, zoom: 1 }), viewRef = useRef(view); viewRef.current = view;
 const [space, setSpace] = useState(false), spaceRef = useRef(false), cursor = useRef<Point>({ x: 100, y: 100 });
 const [color, setColor] = useState('#c0d9bc'), [strokeWidth, setStrokeWidth] = useState(3);
 const [marquee, setMarquee] = useState<Rect | null>(null), [laser, setLaser] = useState<(Point & { at: number })[]>([]);
 const laserRef = useRef<(Point & { at: number })[]>([]), [help, setHelp] = useState(false), [recovery, setRecovery] = useState(false);
 const [textEdit, setTextEdit] = useState<{ point: Point; text: string; id?: string } | null>(null);
 const clipboard = useRef<Scene | null>(null);
 const lastClick = useRef<string | null>(null);
 const scene = preview || canvas.scene;
 const visibleItems = scene.placements.filter(p => !section || p.section === section), visibleObjects = scene.objects.filter(o => !section || o.section === section);
 const allVisibleKeys = [...visibleItems.map(itemKey), ...visibleObjects.map(objectKey)];
 const selectedRects = [...visibleItems.filter(p => selected.includes(itemKey(p))).map(rectFor), ...visibleObjects.filter(o => selected.includes(objectKey(o))).map(rectFor)];
 const selectedBounds = bounds(selectedRects), selectionCount = selectedRects.length;
 useImperativeHandle(ref, () => ({ flush: () => canvas.flush() }));
 useEffect(() => {
  let active = true; setPermission(null);
  api<{ permission: 'view' | 'comment' | 'edit' | 'manage' }>(`/entities/${board.id}/access`).then(result => { if (active) setPermission(result.permission); }).catch(() => { if (active) { setPermission('view'); app.notify('Could not confirm editing access. This canvas is available to view.', 'error'); } });
  return () => { active = false; };
 }, [board.id, board.workspaceId]);
 function showPreview(next: Scene | null) { previewRef.current = next; setPreview(next); }
 function world(clientX: number, clientY: number): Point { const box = viewport.current!.getBoundingClientRect(), v = viewRef.current; return { x: (clientX - box.left - v.x) / v.zoom, y: (clientY - box.top - v.y) / v.zoom }; }
 function snap(point: Point, override = false): Point { return canvas.current.current.settings.snap && !override ? { x: Math.round(point.x / GRID) * GRID, y: Math.round(point.y / GRID) * GRID } : point; }
 function focusCanvas() { viewport.current?.focus({ preventScroll: true }); }
 function cancel() {
  const g = gesture.current;
  if (g) { if (g.kind === 'pan' && g.viewport) setView(v => ({ ...v, ...g.viewport })); setSelected(g.selection); }
  gesture.current = null; showPreview(null); setMarquee(null); setTextEdit(null);
 }
 function changeTool(next: Tool) { cancel(); setTool(next); focusCanvas(); }
 useEffect(() => { cancel(); setSelected([]); }, [section]);
 useEffect(() => { if (!laser.length) return; const timer = window.setInterval(() => { laserRef.current = laserRef.current.filter(p => Date.now() - p.at < 800); setLaser([...laserRef.current]); }, 50); return () => clearInterval(timer); }, [laser.length > 0]);
 useEffect(() => { const clearSpace = () => { spaceRef.current = false; setSpace(false); }; const up = (event: KeyboardEvent) => { if (event.code === 'Space') clearSpace(); }; window.addEventListener('keyup', up); window.addEventListener('blur', clearSpace); return () => { window.removeEventListener('keyup', up); window.removeEventListener('blur', clearSpace); }; }, []);
 function zoomAt(next: number, location?: Point) {
  if (gesture.current) return;
  const el = viewport.current; if (!el) return;
  const v = viewRef.current, zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next)), point = location || { x: el.clientWidth / 2, y: el.clientHeight / 2 };
  setView({ zoom, x: point.x - (point.x - v.x) * zoom / v.zoom, y: point.y - (point.y - v.y) * zoom / v.zoom });
 }
 function fit() {
  cancel(); const el = viewport.current; if (!el) return;
  const box = bounds([...visibleItems.map(rectFor), ...visibleObjects.map(rectFor)]);
  if (!box.width && !box.height) { setView({ x: 30, y: 30, zoom: 1 }); return; }
  const zoom = Math.max(MIN_ZOOM, Math.min(1.5, (el.clientWidth - 100) / Math.max(box.width, 1), (el.clientHeight - 100) / Math.max(box.height, 1)));
  setView({ zoom, x: (el.clientWidth - box.width * zoom) / 2 - box.x * zoom, y: (el.clientHeight - box.height * zoom) / 2 - box.y * zoom });
 }
 // A native non-passive wheel listener handles trackpads without scrolling the page.
 const wheelAction = useRef<(event: WheelEvent) => void>(() => {});
 wheelAction.current = event => {
  event.preventDefault(); if (gesture.current) return;
  const box = viewport.current!.getBoundingClientRect();
  if (event.ctrlKey || event.metaKey) zoomAt(viewRef.current.zoom * Math.exp(-event.deltaY * .008), { x: event.clientX - box.left, y: event.clientY - box.top });
  else setView(v => ({ ...v, x: v.x - (event.shiftKey ? event.deltaY : event.deltaX), y: v.y - (event.shiftKey ? 0 : event.deltaY) }));
 };
 useEffect(() => { const el = viewport.current; if (!el) return; const wheel = (event: WheelEvent) => wheelAction.current(event); el.addEventListener('wheel', wheel, { passive: false }); return () => el.removeEventListener('wheel', wheel); }, []);
 function duplicate(source: Scene, keys: string[], offset: Point): { scene: Scene; keys: string[] } {
  const placements = source.placements.filter(p => keys.includes(itemKey(p))).map(p => ({ ...p, placementId: crypto.randomUUID(), x: p.x + offset.x, y: p.y + offset.y, section: section || p.section || '' }));
  const objects = source.objects.filter(o => keys.includes(objectKey(o))).map(o => ({ ...clone(o), id: crypto.randomUUID(), x: o.x + offset.x, y: o.y + offset.y, section: section || o.section || '' }));
  return { scene: { ...source, placements: [...source.placements, ...placements], objects: [...source.objects, ...objects] }, keys: [...placements.map(itemKey), ...objects.map(objectKey)] };
 }
 function eraseAt(source: Scene, point: Point) { return { ...source, objects: source.objects.filter(o => (section && o.section !== section) || !touches(o, point, 10 / viewRef.current.zoom)) }; }
 function begin(event: ReactPointerEvent<HTMLDivElement>) {
  lastClick.current = null;
  if (gesture.current || textEdit || help || recovery) return;
  const target = event.target as Element, pan = event.button === 1 || event.button === 2 || spaceRef.current || tool === 'hand';
  if (!pan && event.button !== 0) return;
  if (!pan && target.closest('[data-canvas-control]')) return;
  event.preventDefault(); focusCanvas(); event.currentTarget.setPointerCapture(event.pointerId);
  const start = world(event.clientX, event.clientY), before = canvas.current.current;
  cursor.current = start;
  const common = { before, start, client: { x: event.clientX, y: event.clientY }, pointerId: event.pointerId, selection: selected };
  if (pan) { gesture.current = { ...common, kind: 'pan', viewport: { x: view.x, y: view.y } }; return; }
  if (tool === 'laser') { gesture.current = { ...common, kind: 'laser' }; laserRef.current = [{ ...start, at: Date.now() }]; setLaser([...laserRef.current]); return; }
  if (tool === 'eraser' && canEdit) { gesture.current = { ...common, kind: 'erase' }; showPreview(eraseAt(before, start)); return; }
  if (tool === 'text' && canEdit) { setTextEdit({ point: snap(start, event.ctrlKey || event.metaKey), text: '' }); return; }
  if (!['select', 'hand'].includes(tool) && canEdit) {
   const first = tool === 'pen' ? start : snap(start, event.ctrlKey || event.metaKey), id = crypto.randomUUID();
   gesture.current = { ...common, kind: 'draw', start: first, drawingType: tool as DrawingType, points: [first], objectId: id };
   showPreview({ ...before, objects: [...before.objects, drawing(tool as DrawingType, [first, first], color, strokeWidth, section, id)] }); return;
  }
  const key = target.closest('[data-canvas-key]')?.getAttribute('data-canvas-key');
  if (key) {
   if (target.closest('[data-resize]') && canEdit) {
    const value = before.placements.find(p => itemKey(p) === key) || before.objects.find(o => objectKey(o) === key);
    if (value) { gesture.current = { ...common, kind: 'resize', key, rect: rectFor(value) }; setSelected([key]); } return;
   }
   const toggleOffKey = event.shiftKey && selected.includes(key) ? key : undefined;
   const keys = event.shiftKey ? selected.includes(key) ? selected : [...selected, key] : selected.includes(key) ? selected : [key];
   setSelected(keys);
   if (!canEdit) { lastClick.current = key; if (toggleOffKey) setSelected(keys.filter(k => k !== key)); return; }
   const copied = event.altKey ? duplicate(before, keys, { x: 0, y: 0 }) : { scene: before, keys };
   gesture.current = { ...common, kind: 'move', key, source: copied.scene, keys: copied.keys, toggleOffKey, rect: bounds([...copied.scene.placements.filter(p => copied.keys.includes(itemKey(p))).map(rectFor), ...copied.scene.objects.filter(o => copied.keys.includes(objectKey(o))).map(rectFor)]) };
   if (event.altKey) { setSelected(copied.keys); showPreview(copied.scene); }
  } else { gesture.current = { ...common, kind: 'marquee' }; if (!event.shiftKey) setSelected([]); setMarquee({ ...start, width: 0, height: 0 }); }
 }
 function move(event: ReactPointerEvent<HTMLDivElement>) {
  const point = world(event.clientX, event.clientY); cursor.current = point;
  const g = gesture.current; if (!g || g.pointerId !== event.pointerId) return;
  g.moved ||= Math.hypot(event.clientX - g.client.x, event.clientY - g.client.y) > 3;
  if (g.kind === 'pan') { setView(v => ({ ...v, x: g.viewport!.x + event.clientX - g.client.x, y: g.viewport!.y + event.clientY - g.client.y })); return; }
  if (g.kind === 'laser') { laserRef.current = [...laserRef.current.slice(-150), { ...point, at: Date.now() }]; setLaser([...laserRef.current]); return; }
  if (g.kind === 'marquee') {
   const rect = bounds([{ ...g.start, width: 0, height: 0 }, { ...point, width: 0, height: 0 }]); setMarquee(rect);
   const keys = [...visibleItems.filter(p => intersects(rectFor(p), rect)).map(itemKey), ...visibleObjects.filter(o => intersects(rectFor(o), rect)).map(objectKey)];
   setSelected(event.shiftKey ? [...new Set([...g.selection, ...keys])] : keys); return;
  }
  if (g.kind === 'erase') { showPreview(eraseAt(previewRef.current || g.before, point)); return; }
  if (g.kind === 'draw') {
   const end = g.drawingType === 'pen' ? point : snap(point, event.ctrlKey || event.metaKey);
   if (g.drawingType === 'pen') { if (Math.hypot(end.x - g.points!.at(-1)!.x, end.y - g.points!.at(-1)!.y) > 1 / view.zoom) g.points!.push(end); }
   else g.points = [g.start, end];
   showPreview({ ...g.before, objects: [...g.before.objects, drawing(g.drawingType!, g.points!, color, strokeWidth, section, g.objectId!, event.shiftKey)] }); return;
  }
  if (!g.moved) return;
  let dx = point.x - g.start.x, dy = point.y - g.start.y;
  if (event.shiftKey && g.kind === 'move') { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
  if (g.kind === 'move') {
   const origin = g.rect!, snapped = snap({ x: origin.x + dx, y: origin.y + dy }, event.ctrlKey || event.metaKey);
   if (!event.shiftKey || dx !== 0) dx = snapped.x - origin.x;
   if (!event.shiftKey || dy !== 0) dy = snapped.y - origin.y;
   showPreview({ ...g.source!, placements: g.source!.placements.map(p => g.keys!.includes(itemKey(p)) ? { ...p, x: p.x + dx, y: p.y + dy } : p), objects: g.source!.objects.map(o => g.keys!.includes(objectKey(o)) ? { ...o, x: o.x + dx, y: o.y + dy } : o) });
  }
  if (g.kind === 'resize') {
   const rect = g.rect!, end = snap({ x: rect.x + rect.width + dx, y: rect.y + rect.height + dy }, event.ctrlKey || event.metaKey), item = g.key!.startsWith('item:');
   let width = Math.max(item ? 180 : 20, end.x - rect.x), height = Math.max(item ? 170 : 20, end.y - rect.y);
   if (event.shiftKey) { const ratio = Math.max((item ? 180 : 20) / rect.width, (item ? 170 : 20) / rect.height, Math.abs(dx / rect.width) >= Math.abs(dy / rect.height) ? width / rect.width : height / rect.height); width = rect.width * ratio; height = rect.height * ratio; }
   showPreview({ ...g.before, placements: g.before.placements.map(p => itemKey(p) === g.key ? { ...p, width, height } : p), objects: g.before.objects.map(o => objectKey(o) === g.key ? { ...o, width, height, ...(o.points ? { points: o.points.map(p => ({ x: p.x * width / rect.width, y: p.y * height / rect.height })) } : {}) } : o) });
  }
 }
 function finish(event: ReactPointerEvent<HTMLDivElement>) {
  const g = gesture.current; if (!g || g.pointerId !== event.pointerId) return;
  gesture.current = null;
  lastClick.current = g.kind === 'move' && !g.moved ? g.key || null : null;
  if (g.toggleOffKey && !g.moved) setSelected(g.selection.filter(key => key !== g.toggleOffKey));
  if (previewRef.current && (g.kind !== 'draw' || g.moved || g.drawingType === 'pen')) {
   canvas.commit(previewRef.current, g.before);
   if (g.kind === 'draw') setSelected([`object:${g.objectId}`]);
  }
  showPreview(null); setMarquee(null);
  if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
 }
 function removeSelection() {
  if (!canEdit || !selectionCount) return;
  const current = canvas.current.current;
  canvas.commit({ ...current, placements: current.placements.filter(p => !selected.includes(itemKey(p))), objects: current.objects.filter(o => !selected.includes(objectKey(o))) }); setSelected([]);
 }
 function openSelection() {
  if (tool !== 'select' || !lastClick.current) return;
  const current = canvas.current.current, item = current.placements.find(p => itemKey(p) === lastClick.current);
  if (item && app.entities.some(e => e.id === item.id)) { app.openItem(item.id); return; }
  const object = current.objects.find(o => objectKey(o) === lastClick.current);
  if (object?.type === 'text' && canEdit) setTextEdit({ point: { x: object.x, y: object.y }, text: object.text || '', id: object.id });
 }
 async function copySelection() {
  const current = canvas.current.current;
  const copied = { ...current, placements: current.placements.filter(p => selected.includes(itemKey(p))), objects: current.objects.filter(o => selected.includes(objectKey(o))) };
  if (!copied.placements.length && !copied.objects.length) return;
  clipboard.current = clone(copied);
  try { await navigator.clipboard.writeText(JSON.stringify({ groveCanvas: 1, ...copied })); } catch { /* The in-app clipboard is still available. */ }
 }
 async function pasteSelection() {
  if (!canEdit) return;
  let copied = clipboard.current;
  try {
   const data = JSON.parse(await navigator.clipboard.readText());
   if (data?.groveCanvas === 1 && Array.isArray(data.placements) && Array.isArray(data.objects)) {
    // Clipboard content is untrusted. Accept only existing item references and
    // recognized drawing records, then normalize their coordinates.
    copied = readScene({ ...board, data: { placements: data.placements.filter((p: Placement) => app.entities.some(e => e.id === p.id)), canvasObjects: data.objects.filter((o: CanvasObject) => typeof o.id === 'string' && Number.isFinite(o.x) && Number.isFinite(o.y) && Number.isFinite(o.width) && Number.isFinite(o.height) && typeof o.color === 'string' && Number.isFinite(o.strokeWidth) && (!o.points || Array.isArray(o.points) && o.points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)))) } });
   }
  } catch { /* Use the in-app clipboard if system clipboard access is unavailable. */ }
  if (!copied) return;
  const box = bounds([...copied.placements.map(rectFor), ...copied.objects.map(rectFor)]), point = snap(cursor.current), current = canvas.current.current;
  const copies = duplicate(copied, [...copied.placements.map(itemKey), ...copied.objects.map(objectKey)], { x: point.x - box.x, y: point.y - box.y });
  const placements = copies.scene.placements.filter(p => copies.keys.includes(itemKey(p))), objects = copies.scene.objects.filter(o => copies.keys.includes(objectKey(o)));
  canvas.commit({ ...current, placements: [...current.placements, ...placements], objects: [...current.objects, ...objects] }); setSelected(copies.keys);
 }
 function duplicateSelection() { if (!canEdit || !selectionCount) return; const copied = duplicate(canvas.current.current, selected, { x: GRID, y: GRID }); canvas.commit(copied.scene); setSelected(copied.keys); focusCanvas(); }
 function changeSection(value: string) { const current = canvas.current.current; canvas.commit({ ...current, placements: current.placements.map(p => selected.includes(itemKey(p)) ? { ...p, section: value } : p), objects: current.objects.map(o => selected.includes(objectKey(o)) ? { ...o, section: value } : o) }); setSelected([]); }
 function saveText() {
  if (!textEdit?.text.trim()) { setTextEdit(null); return; }
  const current = canvas.current.current;
  if (textEdit.id) canvas.commit({ ...current, objects: current.objects.map(o => o.id === textEdit.id ? { ...o, text: textEdit.text } : o) });
  else { const object: CanvasObject = { id: crypto.randomUUID(), type: 'text', ...textEdit.point, width: 260, height: Math.max(90, textEdit.text.split('\n').length * strokeWidth * 9 + 20), text: textEdit.text, color, strokeWidth, section }; canvas.commit({ ...current, objects: [...current.objects, object] }); setSelected([objectKey(object)]); }
  setTextEdit(null); focusCanvas();
 }
 function keyDown(event: React.KeyboardEvent<HTMLDivElement>) {
  if ((event.target as Element).closest('input,textarea,select,[contenteditable=true]') || help || textEdit || recovery) return;
  if (event.key === 'Escape') { event.preventDefault(); if (gesture.current) cancel(); else setSelected([]); return; }
  if (event.code === 'Space') { event.preventDefault(); spaceRef.current = true; setSpace(true); return; }
  if (gesture.current) return;
  const command = event.metaKey || event.ctrlKey, key = event.key.toLowerCase();
  if (command && key === 'a') { event.preventDefault(); setSelected(allVisibleKeys); return; }
  if (command && key === 'c') { event.preventDefault(); void copySelection(); return; }
  if (command && key === 'v') { event.preventDefault(); void pasteSelection(); return; }
  if (command && key === 'd') { event.preventDefault(); duplicateSelection(); return; }
  if (command && (key === 'z' || key === 'y')) { event.preventDefault(); if (canEdit) { if (key === 'y' || event.shiftKey) canvas.redo(); else canvas.undo(); } return; }
  if (['Delete', 'Backspace'].includes(event.key)) { event.preventDefault(); removeSelection(); return; }
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) && selectionCount && canEdit) {
   event.preventDefault(); const delta = event.shiftKey ? 20 : 1, dx = event.key === 'ArrowLeft' ? -delta : event.key === 'ArrowRight' ? delta : 0, dy = event.key === 'ArrowUp' ? -delta : event.key === 'ArrowDown' ? delta : 0, current = canvas.current.current;
   canvas.commit({ ...current, placements: current.placements.map(p => selected.includes(itemKey(p)) ? { ...p, x: p.x + dx, y: p.y + dy } : p), objects: current.objects.map(o => selected.includes(objectKey(o)) ? { ...o, x: o.x + dx, y: o.y + dy } : o) }); return;
  }
  if (command || event.altKey) return;
  if (key === '?') { event.preventDefault(); setHelp(true); return; }
  if (key === 'f') { event.preventDefault(); fit(); return; }
  if (key === '+' || key === '=') { event.preventDefault(); zoomAt(view.zoom * 1.2); return; }
  if (key === '-') { event.preventDefault(); zoomAt(view.zoom / 1.2); return; }
  const next = toolButtons.find(t => t.shortcut.toLowerCase() === key); if (next && (canEdit || ['select', 'hand', 'laser'].includes(next.id))) { event.preventDefault(); changeTool(next.id); }
 }
 const selectedSections = new Set([...scene.placements.filter(p => selected.includes(itemKey(p))), ...scene.objects.filter(o => selected.includes(objectKey(o)))].map(o => o.section || ''));
 return <section className="board-canvas" aria-label="Board canvas" onKeyDown={keyDown}>
  <div className="board-canvas-toolbar" role="toolbar" aria-label="Canvas tools">
   <div className="board-canvas-tool-group">{toolButtons.map(t => <IconButton key={t.id} label={`${t.label} (${t.shortcut})`} aria-pressed={tool === t.id} disabled={!canEdit && !['select', 'hand', 'laser'].includes(t.id)} onClick={() => changeTool(t.id)}><t.icon size={17} /></IconButton>)}</div>
   {canEdit && <div className="board-canvas-tool-group board-canvas-ink"><input type="color" aria-label="Drawing color" value={color} onChange={e => setColor(e.target.value)} /><select aria-label="Stroke width" value={strokeWidth} onChange={e => setStrokeWidth(Number(e.target.value))}><option value="2">Thin</option><option value="3">Medium</option><option value="5">Thick</option></select></div>}
   <div className="board-canvas-tool-group"><IconButton label="Undo canvas change" disabled={!canEdit || !canvas.history.past.length} onClick={() => { cancel(); canvas.undo(); }}><Undo2 size={16} /></IconButton><IconButton label="Redo canvas change" disabled={!canEdit || !canvas.history.future.length} onClick={() => { cancel(); canvas.redo(); }}><Redo2 size={16} /></IconButton></div>
   <span className="spacer" /><IconButton label="Canvas keyboard help" onClick={() => setHelp(true)}><HelpCircle size={17} /></IconButton>
  </div>
  {canvas.error && <div className="board-canvas-error" role="alert"><span>{canvas.error}</span><Button onClick={() => void canvas.retry()}>Retry save</Button><Button onClick={() => saveBlob(new Blob([JSON.stringify({ boardId: board.id, title: board.title, ...writeScene(canvas.current.current) }, null, 2)], { type: 'application/json' }), `${board.title.replace(/[^a-z0-9_-]/gi, '-').slice(0, 80) || 'board'}-canvas.json`)}><Download size={13} />Download local copy</Button><Button onClick={() => setRecovery(true)}>{canvas.conflict ? 'Review conflict' : 'Recovery options'}</Button></div>}
  <div ref={viewport} className={`board-canvas-viewport tool-${space ? 'hand' : tool}`} tabIndex={0} role="region" aria-label="Canvas workspace. Press question mark for keyboard help." data-zoom={view.zoom} data-pan-x={view.x} data-pan-y={view.y} onPointerDown={begin} onPointerMove={move} onPointerUp={finish} onDoubleClick={openSelection} onPointerCancel={cancel} onLostPointerCapture={() => { if (gesture.current) cancel(); }} onContextMenu={e => e.preventDefault()} style={{ backgroundImage: scene.settings.grid ? 'radial-gradient(circle, #74836c55 1px, transparent 1px)' : 'none', backgroundSize: `${GRID * view.zoom}px ${GRID * view.zoom}px`, backgroundPosition: `${view.x}px ${view.y}px` }}>
   <div className="board-canvas-world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}>
    <svg className="board-canvas-drawings" aria-label="Canvas drawings">{visibleObjects.map(o => <g key={o.id} data-canvas-key={objectKey(o)} data-object-type={o.type} aria-label={`${o.type}${o.text ? `: ${o.text}` : ''}`} transform={`translate(${o.x} ${o.y})`}>
     <rect className="board-canvas-object-hit" x={-7 / view.zoom} y={-7 / view.zoom} width={o.width + 14 / view.zoom} height={o.height + 14 / view.zoom} fill="transparent" />
     <Drawing object={o} />
    </g>)}</svg>
    {visibleItems.map(p => { const item = app.entities.find(e => e.id === p.id), key = itemKey(p); return <div className={`board-canvas-item ${selected.includes(key) ? 'selected' : ''}`} key={key} data-canvas-key={key} data-item-id={p.id} aria-label={`Canvas item: ${item?.title || 'Unavailable item'}`} style={{ left: p.x, top: p.y, width: p.width || 270, height: p.height || 290 }}>
     <div className="board-canvas-card-handle"><Move size={12} /><span>{p.section || 'Board item'}</span>{item && <IconButton data-canvas-control label={`Open ${item.title}`} onClick={() => app.openItem(item.id)}><ArrowUpRight size={13} /></IconButton>}</div>
     {item ? <ItemCard entity={item} onOpen={() => {}} /> : <div className="board-canvas-missing">This item is unavailable.</div>}
    </div>; })}
    {tool === 'select' && !space && [...visibleItems.map(p => ({ key: itemKey(p), rect: rectFor(p), label: app.entities.find(e => e.id === p.id)?.title || 'item' })), ...visibleObjects.map(o => ({ key: objectKey(o), rect: rectFor(o), label: o.type }))].filter(value => selected.includes(value.key)).map(({ key, rect, label }) => <div key={key} className="board-canvas-selection" style={{ left: rect.x - 3 / view.zoom, top: rect.y - 3 / view.zoom, width: rect.width + 6 / view.zoom, height: rect.height + 6 / view.zoom, borderWidth: 1.5 / view.zoom }}>
     {canEdit && selectionCount === 1 && <button type="button" data-canvas-key={key} data-resize="true" className="board-canvas-resize" aria-label={`Resize ${label}`} style={{ width: 12 / view.zoom, height: 12 / view.zoom, right: -6 / view.zoom, bottom: -6 / view.zoom }} />}
    </div>)}
    {selectionCount > 1 && <div className="board-canvas-multi-selection" style={{ left: selectedBounds.x - 6 / view.zoom, top: selectedBounds.y - 6 / view.zoom, width: selectedBounds.width + 12 / view.zoom, height: selectedBounds.height + 12 / view.zoom, borderWidth: 1 / view.zoom }} />}
    {marquee && <div className="board-canvas-marquee" style={{ left: marquee.x, top: marquee.y, width: marquee.width, height: marquee.height, borderWidth: 1 / view.zoom }} />}
    {!!laser.length && <svg className="board-canvas-laser" aria-hidden="true">{laser.slice(1).map((p, i) => <line key={`${p.at}-${i}`} x1={laser[i].x} y1={laser[i].y} x2={p.x} y2={p.y} stroke="#ff777c" strokeWidth={3 / view.zoom} opacity={Math.max(0, 1 - (Date.now() - p.at) / 800)} strokeLinecap="round" />)}<circle cx={laser.at(-1)!.x} cy={laser.at(-1)!.y} r={5 / view.zoom} fill="#ffadb0" /></svg>}
   </div>
   {!visibleItems.length && !visibleObjects.length && tool === 'select' && <div className="board-canvas-empty"><Layers size={30} /><h3>Space to think freely.</h3><p>Add an idea, or choose a drawing tool above.</p><Button data-canvas-control onClick={onAddFromLibrary}>Add from library</Button></div>}
  </div>
  <div className="board-canvas-footer">
   <div className="board-canvas-tool-group"><IconButton label="Zoom out" onClick={() => zoomAt(view.zoom / 1.2)}><Minus size={15} /></IconButton><button type="button" className="board-canvas-zoom" aria-label="Reset zoom to 100 percent" onClick={() => zoomAt(1)}>{Math.round(view.zoom * 100)}%</button><IconButton label="Zoom in" onClick={() => zoomAt(view.zoom * 1.2)}><Plus size={15} /></IconButton><IconButton label="Fit canvas to content (F)" onClick={fit}><Maximize size={15} /></IconButton></div>
   <div className="board-canvas-tool-group"><IconButton label="Show dot grid" aria-pressed={scene.settings.grid} disabled={!canEdit} onClick={() => canvas.commit({ ...canvas.current.current, settings: { ...canvas.current.current.settings, grid: !scene.settings.grid } })}><Grid2X2 size={15} /></IconButton><IconButton label="Snap to grid" aria-pressed={scene.settings.snap} disabled={!canEdit} onClick={() => canvas.commit({ ...canvas.current.current, settings: { ...canvas.current.current.settings, snap: !scene.settings.snap } })}><Magnet size={15} /></IconButton></div>
   <span className="board-canvas-hint">Space to pan · Shift to constrain · ⌘/Ctrl to skip snap</span><span className="spacer" /><span className={`board-canvas-save ${canvas.status}`} role="status" aria-label="Canvas save status">{permission === null ? 'Checking access…' : !canEdit ? 'View only' : canvas.status === 'saving' ? 'Saving…' : canvas.status === 'error' ? 'Unsaved changes' : 'All changes saved'}</span>
  </div>
  {selectionCount > 0 && <div className="board-canvas-selection-bar"><span>{selectionCount} selected</span><Button onClick={() => void copySelection()}><Copy size={13} />Copy</Button>{canEdit && <><Button onClick={duplicateSelection}><Plus size={13} />Duplicate</Button><select aria-label="Move selection to section" value={selectedSections.size === 1 ? [...selectedSections][0] : '__mixed__'} onChange={e => changeSection(e.target.value)}><option value="__mixed__" disabled>Mixed sections</option><option value="">No section</option>{(board.data.sections || []).map((s: string) => <option key={s} value={s}>{s}</option>)}</select><Button onClick={removeSelection}><Trash2 size={13} />Remove</Button></>}<IconButton label="Clear canvas selection" onClick={() => setSelected([])}><X size={14} /></IconButton></div>}
  {textEdit && <Modal title={textEdit.id ? 'Edit canvas text' : 'Add canvas text'} onClose={() => setTextEdit(null)}><form className="form-stack" onSubmit={event => { event.preventDefault(); saveText(); }}><textarea autoFocus aria-label="Canvas text" value={textEdit.text} onChange={e => setTextEdit({ ...textEdit, text: e.target.value })} placeholder="Put a thought on the canvas…" rows={5} /><div className="form-actions"><Button onClick={() => setTextEdit(null)}>Cancel</Button><Button type="submit" tone="primary" disabled={!textEdit.text.trim()}>{textEdit.id ? 'Save text' : 'Add text'}</Button></div></form></Modal>}
  {help && <Modal title="Canvas keyboard help" onClose={() => setHelp(false)}><div className="board-canvas-help"><p>Click to select. Shift-click adds to the selection; drag empty space to select an area. Double-click a card to open it, or text to edit it.</p><dl><dt>Pan</dt><dd>Hold Space and drag, right or middle drag, or use Hand. Scroll to pan.</dd><dt>Zoom / fit</dt><dd>⌘/Ctrl + scroll or + / −. Press F to fit all visible content.</dd><dt>Move / resize</dt><dd>Drag a card or drawing; drag its corner to resize. Shift locks an axis or aspect ratio. Arrow keys nudge; Shift nudges 20 pixels.</dd><dt>Grid / snap</dt><dd>Toggle dots and snapping independently below. Hold ⌘/Ctrl while dragging to skip snapping. Preferences are saved with this board.</dd><dt>Copy / duplicate</dt><dd>⌘/Ctrl+C, ⌘/Ctrl+V pastes at the last cursor position. ⌘/Ctrl+D or Alt-drag duplicates. Cards remain references to the same library items.</dd><dt>Undo / redo</dt><dd>⌘/Ctrl+Z, ⌘/Ctrl+Shift+Z or ⌘/Ctrl+Y. History covers your changes during this canvas session.</dd><dt>Cancel / remove</dt><dd>Escape cancels the active gesture. Delete removes selected placements and drawings; library items are kept.</dd><dt>Tools</dt><dd>V select · H hand · P pen · E eraser · R rectangle · O ellipse · T text · L line · A arrow · K laser. Tools stay selected. The eraser removes drawings; laser fades without saving.</dd></dl></div></Modal>}
  {recovery && <Modal title="Recover canvas changes" onClose={() => setRecovery(false)}><div className="form-stack"><p>Your local canvas is still available. Download a copy before discarding anything you want to keep.</p>{canvas.conflict && <><p>Keeping your changes applies your pending edits to the latest board, including any objects changed in both places. Unchanged objects and board details are preserved.</p><Button tone="primary" onClick={() => void canvas.keepLocal().then(ok => { if (ok) setRecovery(false); })}>Keep my changes</Button></>}<Button tone="danger" onClick={() => void canvas.reloadSaved().then(() => setRecovery(false))}>Discard local changes and reload saved canvas</Button><Button onClick={() => setRecovery(false)}>Continue editing</Button></div></Modal>}
 </section>;
});
