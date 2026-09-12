import { useEffect, useRef, useState } from 'react';
import { EditorContent, generateHTML, useEditor, type Editor, type JSONContent } from '@tiptap/react';
import Placeholder from '@tiptap/extension-placeholder';
import { ArrowDown, ArrowUp, AtSign, Bold, Code, Heading2, Italic, List, ListOrdered, Minus, Plus, Quote, Redo2, Table2, Undo2, X } from 'lucide-react';
import type { Entity } from '../../../shared/types';
import { useWorkspace } from '../../store';
import { IconButton } from '../ui';
import { documentExtensions, documentMarkdown, entityLinks, markdownDocument } from './DocumentNodes';
import { RelatedSources } from './RelatedSources';
import './editor.css';

export interface DocumentChange { content: string; html: string; editorJSON: JSONContent; entityLinks: string[] }
export function documentChange(doc: JSONContent): DocumentChange { return { content: documentMarkdown(doc), html: generateHTML(doc, documentExtensions), editorJSON: doc, entityLinks: entityLinks(doc) }; }
type Menu = { mode: 'commands' | 'mention' | 'table'; query: string; from: number; to: number; index: number; manual?: boolean };
type Command = { id: string; label: string; hint: string; run: (editor: Editor) => void };
const commands: Command[] = [
 { id: 'paragraph', label: 'Text', hint: 'A plain paragraph', run: editor => { editor.chain().focus().setParagraph().run(); } },
 { id: 'heading', label: 'Heading', hint: 'A section heading', run: editor => { editor.chain().focus().setHeading({ level: 2 }).run(); } },
 { id: 'bullet', label: 'Bullet list', hint: 'An unordered list', run: editor => { editor.chain().focus().toggleBulletList().run(); } },
 { id: 'ordered', label: 'Numbered list', hint: 'A sequence of steps', run: editor => { editor.chain().focus().toggleOrderedList().run(); } },
 { id: 'quote', label: 'Quote', hint: 'A block quotation', run: editor => { editor.chain().focus().toggleBlockquote().run(); } },
 { id: 'code', label: 'Code block', hint: 'Plain text code', run: editor => { editor.chain().focus().toggleCodeBlock().run(); } },
 { id: 'divider', label: 'Divider', hint: 'Separate two sections', run: editor => { editor.chain().focus().setHorizontalRule().run(); } },
 { id: 'mention', label: 'Mention an item', hint: 'Link to a saved source', run: () => {} },
 { id: 'table', label: 'Embed a live table', hint: 'Reuse a table from your workspace', run: () => {} }
];

export function DocumentEditor({ id, content, html, editorJSON, editable = true, onChange, onOpen }: { id: string; content: string; html?: string; editorJSON?: JSONContent; editable?: boolean; onChange: (change: DocumentChange) => void; onOpen: (id: string) => void }) {
 const app = useWorkspace(), change = useRef(onChange); change.current = onChange;
 const [menu, setMenu] = useState<Menu | null>(null), [paragraph, setParagraph] = useState(''), [, refresh] = useState(0);
 const menuRef = useRef(menu); menuRef.current = menu;
 const chooseRef = useRef<(index: number) => void>(() => {}), countRef = useRef(0);
 const lastEmit = useRef(''), suppressMenu = useRef(false);
 function inspect(editor: Editor) {
  const { $from, from, empty } = editor.state.selection;
  setParagraph($from.parent.textContent); refresh(value => value + 1);
  if (suppressMenu.current || menuRef.current?.manual) return;
  const before = $from.parent.textBetween(0, $from.parentOffset, '\n', '\ufffc');
  const match = empty && before.match(/(?:^|\s)([/@])([^/@\n]{0,60})$/);
  if (!match || !editor.isEditable || $from.parent.type.name === 'codeBlock') { setMenu(null); return; }
  const trigger = match[1], query = match[2], start = from - query.length - 1;
  setMenu(previous => ({ mode: trigger === '@' ? 'mention' : 'commands', query, from: start, to: from, index: previous?.from === start && previous.query === query ? previous.index : 0 }));
 }
 const editor = useEditor({
  extensions: [...documentExtensions, Placeholder.configure({ placeholder: 'Start writing. Type / for blocks or @ to mention a source…' })],
  content: editorJSON?.type === 'doc' ? editorJSON : html || markdownDocument(content), editable,
  onUpdate: ({ editor }) => { const value = documentChange(editor.getJSON()); lastEmit.current = JSON.stringify(value.editorJSON); change.current(value); inspect(editor); },
  onSelectionUpdate: ({ editor }) => inspect(editor),
  editorProps: { attributes: { 'aria-label': 'Document editor', class: 'rich-document', role: 'textbox', 'aria-multiline': 'true' }, handleKeyDown: (_view, event) => {
   if (!menuRef.current) return false;
   if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setMenu(null); return true; }
   if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); setMenu(previous => previous && ({ ...previous, index: (previous.index + (event.key === 'ArrowDown' ? 1 : -1) + Math.max(countRef.current, 1)) % Math.max(countRef.current, 1) })); return true; }
   if (event.key === 'Enter' && countRef.current) { event.preventDefault(); chooseRef.current(menuRef.current.index); return true; }
   return false;
  } }
 });
 useEffect(() => { editor?.setEditable(editable, false); }, [editor, editable]);
 useEffect(() => {
  if (!editor) return;
  const next = editorJSON?.type === 'doc' ? editorJSON : html || markdownDocument(content);
  const signature = typeof next === 'string' ? next : JSON.stringify(next);
  if (signature !== lastEmit.current && signature !== JSON.stringify(editor.getJSON())) { editor.commands.setContent(next, { emitUpdate: false }); lastEmit.current = JSON.stringify(editor.getJSON()); }
 }, [editor, editorJSON, content, html]);
 const choices = menu?.mode === 'commands' ? commands.filter(command => `${command.id} ${command.label} ${command.hint}`.toLowerCase().includes(menu.query.toLowerCase())) : app.entities.filter(entity => entity.id !== id && !['notification', 'workflow-run'].includes(entity.kind) && (menu?.mode !== 'table' || entity.kind === 'table') && entity.title.toLowerCase().includes(menu?.query.toLowerCase() || '')).slice(0, 10);
 countRef.current = choices.length;
 function insert(entity: Entity, table = entity.kind === 'table', range?: { from: number; to: number }) {
  if (!editor || !editable) return;
  suppressMenu.current = true; menuRef.current = null; setMenu(null);
  const chain = editor.chain().focus(); if (range) chain.deleteRange(range);
  chain.insertContent(table ? [{ type: 'tableReference', attrs: { entityId: entity.id, label: entity.title } }, { type: 'paragraph' }] : [{ type: 'entityMention', attrs: { entityId: entity.id, label: entity.title } }, { type: 'text', text: ' ' }]).run();
  suppressMenu.current = false;
 }
 function choose(index: number) {
  const option = choices[index]; if (!option || !menu || !editor) return;
  if ('run' in option) {
   if (option.id === 'mention' || option.id === 'table') { setMenu({ ...menu, mode: option.id, query: '', index: 0, manual: true }); return; }
   suppressMenu.current = true; editor.chain().focus().deleteRange({ from: menu.from, to: menu.to }).run(); option.run(editor); suppressMenu.current = false; setMenu(null);
  } else insert(option, menu.mode === 'table', menu);
 }
 chooseRef.current = choose;
 function openMenu(mode: Menu['mode']) { if (editor) { const { from, to } = editor.state.selection; setMenu({ mode, query: '', from, to, index: 0, manual: true }); } }
 function moveBlock(direction: -1 | 1) {
  if (!editor || !editable) return;
  const { state } = editor, index = state.selection.$from.index(0), target = index + direction, blocks: JSONContent[] = [];
  state.doc.forEach(node => blocks.push(node.toJSON())); if (target < 0 || target >= blocks.length) return;
  [blocks[index], blocks[target]] = [blocks[target], blocks[index]];
  const next = state.schema.nodeFromJSON({ type: 'doc', content: blocks });
  const transaction = state.tr.replaceWith(0, state.doc.content.size, next.content);
  editor.view.dispatch(transaction); let start = 1; for (let i = 0; i < target; i++) start += next.child(i).nodeSize; editor.commands.setTextSelection(Math.min(start, next.content.size - 1)); editor.commands.focus();
 }
 if (!editor) return null;
 const commandButtons = [
  { label: 'Bold', active: editor.isActive('bold'), icon: <Bold size={15} />, run: () => editor.chain().focus().toggleBold().run() },
  { label: 'Italic', active: editor.isActive('italic'), icon: <Italic size={15} />, run: () => editor.chain().focus().toggleItalic().run() },
  { label: 'Heading', active: editor.isActive('heading'), icon: <Heading2 size={16} />, run: () => editor.chain().focus().toggleHeading({ level: 2 }).run() },
  { label: 'Bullet list', active: editor.isActive('bulletList'), icon: <List size={16} />, run: () => editor.chain().focus().toggleBulletList().run() },
  { label: 'Numbered list', active: editor.isActive('orderedList'), icon: <ListOrdered size={16} />, run: () => editor.chain().focus().toggleOrderedList().run() },
  { label: 'Quote', active: editor.isActive('blockquote'), icon: <Quote size={15} />, run: () => editor.chain().focus().toggleBlockquote().run() },
  { label: 'Code block', active: editor.isActive('codeBlock'), icon: <Code size={15} />, run: () => editor.chain().focus().toggleCodeBlock().run() },
  { label: 'Divider', active: false, icon: <Minus size={15} />, run: () => editor.chain().focus().setHorizontalRule().run() }
 ];
 return <div className="document-editor"><div className="editor-toolbar"><IconButton label="Insert block" disabled={!editable} onClick={() => openMenu('commands')}><Plus size={16} /></IconButton>{commandButtons.map(button => <IconButton key={button.label} label={button.label} aria-pressed={button.active} disabled={!editable} onMouseDown={event => event.preventDefault()} onClick={button.run}>{button.icon}</IconButton>)}<span className="toolbar-divider" /><IconButton label="Mention an item" disabled={!editable} onClick={() => openMenu('mention')}><AtSign size={16} /></IconButton><IconButton label="Embed a live table" disabled={!editable} onClick={() => openMenu('table')}><Table2 size={16} /></IconButton><IconButton label="Move block up" disabled={!editable || editor.state.selection.$from.index(0) === 0} onMouseDown={event => event.preventDefault()} onClick={() => moveBlock(-1)}><ArrowUp size={15} /></IconButton><IconButton label="Move block down" disabled={!editable || editor.state.selection.$from.index(0) >= editor.state.doc.childCount - 1} onMouseDown={event => event.preventDefault()} onClick={() => moveBlock(1)}><ArrowDown size={15} /></IconButton><IconButton label="Undo edit" disabled={!editable || !editor.can().undo()} onClick={() => editor.chain().focus().undo().run()}><Undo2 size={15} /></IconButton><IconButton label="Redo edit" disabled={!editable || !editor.can().redo()} onClick={() => editor.chain().focus().redo().run()}><Redo2 size={15} /></IconButton><small>{editor.getText().split(/\s+/).filter(Boolean).length} words</small></div>
  {menu && <div className="document-insert-menu" aria-label="Insert into document"><div className="document-insert-heading"><strong>{menu.mode === 'commands' ? 'Insert a block' : menu.mode === 'table' ? 'Choose a live table' : 'Mention an item'}</strong><IconButton label="Close insert menu" onClick={() => setMenu(null)}><X size={14} /></IconButton></div>{menu.manual && <input autoFocus aria-label="Filter insert options" placeholder="Search…" value={menu.query} onChange={event => setMenu({ ...menu, query: event.target.value, index: 0 })} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setMenu(null); editor.commands.focus(); } if (event.key === 'Enter') { event.preventDefault(); choose(menu.index); } if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setMenu({ ...menu, index: (menu.index + (event.key === 'ArrowDown' ? 1 : -1) + Math.max(choices.length, 1)) % Math.max(choices.length, 1) }); } }} />}<div role="listbox" aria-label="Insert options">{choices.map((option, index) => <button type="button" role="option" aria-selected={index === menu.index} key={option.id} onMouseDown={event => event.preventDefault()} onClick={() => choose(index)}><strong>{'label' in option ? option.label : option.title}</strong><span>{'hint' in option ? option.hint : option.data.type || option.kind}</span></button>)}{!choices.length && <p className="field-hint">No matching items.</p>}</div><small>↑ ↓ to choose · Enter to insert · Esc to close</small></div>}
  <EditorContent editor={editor} />
  <RelatedSources query={paragraph || content} currentId={id} linkedIds={entityLinks(editor.getJSON())} onInsert={entity => insert(entity)} onOpen={onOpen} />
 </div>;
}
