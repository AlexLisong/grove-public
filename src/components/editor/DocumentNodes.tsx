import { createContext, useContext, type ReactNode } from 'react';
import { Node as TiptapNode, mergeAttributes, NodeViewWrapper, ReactNodeViewRenderer, generateJSON, type JSONContent, type NodeViewProps } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { renderToStaticMarkup } from 'react-dom/server';
import { ArrowUpRight, GripVertical, Table2 } from 'lucide-react';
import { useWorkspace } from '../../store';
import { TableSurface } from '../TableEditor';
import { safeUrl } from '../../api';

export const DocumentNavigation = createContext<(id: string) => void>(() => {});
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function referenceId(href?: string) { try { const url = new URL(href || '', window.location.origin), id = url.searchParams.get('open'); return url.origin === window.location.origin && id && uuid.test(id) ? id : null; } catch { return null; } }

export function EntityReference({ id, label }: { id: string; label?: string }) {
 const app = useWorkspace(), open = useContext(DocumentNavigation), entity = app.entities.find(e => e.id === id);
 return <button type="button" className="document-entity-reference" data-entity-reference={id} disabled={!entity} onClick={() => open(id)} title={entity ? `Open ${entity.title}` : 'This item is unavailable'}>@{entity?.title || label || 'Unavailable item'}</button>;
}
export function LiveTableReference({ id, label }: { id: string; label?: string }) {
 const app = useWorkspace(), open = useContext(DocumentNavigation), entity = app.entities.find(e => e.id === id && e.kind === 'table');
 return <div className="document-table-reference" data-table-reference={id}><div className="document-table-heading"><Table2 size={15} /><strong>{entity?.title || label || 'Table'}</strong><span>Live table</span>{entity && <button type="button" onClick={() => open(id)}>Open table<ArrowUpRight size={13} /></button>}</div>{entity ? <TableSurface entity={entity} embedded readOnly onOpen={() => open(id)} /> : <p className="muted">This table is unavailable. The reference is kept in your document.</p>}</div>;
}
function MentionView({ node }: NodeViewProps) { return <NodeViewWrapper as="span" className="document-mention-node" contentEditable={false}><EntityReference id={node.attrs.entityId} label={node.attrs.label} /></NodeViewWrapper>; }
function TableView({ node, editor }: NodeViewProps) { return <NodeViewWrapper className="document-table-node" contentEditable={false}>{editor.isEditable && <span className="document-block-grip" data-drag-handle title="Drag this table block"><GripVertical size={16} /></span>}<LiveTableReference id={node.attrs.entityId} label={node.attrs.label} /></NodeViewWrapper>; }
function PreservedMarkdown({ markdown }: { markdown: string }) { return <div className="preserved-markdown markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children }) => { const id = referenceId(href); return id ? <EntityReference id={id} label={String(children).replace(/^@/, '')} /> : <a href={safeUrl(href)} target="_blank" rel="noopener noreferrer">{children}</a>; } }}>{markdown}</ReactMarkdown></div>; }
function RawMarkdownView({ node, editor, updateAttributes }: NodeViewProps) { return <NodeViewWrapper className="document-raw-node" contentEditable={false}><PreservedMarkdown markdown={node.attrs.markdown || ''} />{editor.isEditable && <details><summary>Edit Markdown block</summary><textarea aria-label="Preserved Markdown block source" value={node.attrs.markdown || ''} onChange={event => updateAttributes({ markdown: event.target.value })} onKeyDown={event => event.stopPropagation()} /><p className="field-hint">This block keeps its original Markdown, including images, tables, and task status.</p></details>}</NodeViewWrapper>; }
export const RawMarkdown = TiptapNode.create({
 name: 'rawMarkdown', group: 'block', atom: true, draggable: true, selectable: true,
 addAttributes() { return { markdown: { default: '', parseHTML: element => element.getAttribute('data-raw-markdown') || '' } }; },
 parseHTML() { return [{ tag: 'div[data-raw-markdown]' }]; },
 renderHTML({ HTMLAttributes }) { return ['div', { 'data-raw-markdown': HTMLAttributes.markdown }, 'Preserved Markdown block']; },
 renderText({ node }) { return node.attrs.markdown || ''; },
 addNodeView() { return ReactNodeViewRenderer(RawMarkdownView); }
});
export const EntityMention = TiptapNode.create({
 name: 'entityMention', group: 'inline', inline: true, atom: true, selectable: true,
 addAttributes() { return { entityId: { default: null, parseHTML: element => element.getAttribute('data-entity-reference') || referenceId(element.getAttribute('href') || '') }, label: { default: 'Item', parseHTML: element => element.getAttribute('data-label') || element.textContent?.replace(/^@/, '') || 'Item' } }; },
 parseHTML() { return [{ tag: 'span[data-entity-reference]' }, { tag: 'a[data-entity-reference]' }]; },
 renderHTML({ HTMLAttributes }) { return ['span', mergeAttributes(HTMLAttributes, { 'data-entity-reference': HTMLAttributes.entityId, 'data-label': HTMLAttributes.label }), `@${HTMLAttributes.label}`]; },
 renderText({ node }) { return `@${node.attrs.label}`; },
 addNodeView() { return ReactNodeViewRenderer(MentionView); }
});
export const TableReference = TiptapNode.create({
 name: 'tableReference', group: 'block', atom: true, draggable: true, selectable: true,
 addAttributes() { return { entityId: { default: null, parseHTML: element => element.getAttribute('data-table-reference') }, label: { default: 'Table', parseHTML: element => element.getAttribute('data-label') || 'Table' } }; },
 parseHTML() { return [{ tag: 'div[data-table-reference]' }]; },
 renderHTML({ HTMLAttributes }) { return ['div', mergeAttributes(HTMLAttributes, { 'data-table-reference': HTMLAttributes.entityId, 'data-label': HTMLAttributes.label }), `Table: ${HTMLAttributes.label}`]; },
 renderText({ node }) { return `Table: ${node.attrs.label}`; },
 addNodeView() { return ReactNodeViewRenderer(TableView); }
});
export const documentExtensions = [StarterKit.configure({ link: { openOnClick: false } }), EntityMention, TableReference, RawMarkdown];
export function entityLinks(doc?: JSONContent): string[] { const ids = new Set<string>(); const visit = (node: JSONContent) => { if (['entityMention', 'tableReference'].includes(node.type || '') && uuid.test(node.attrs?.entityId || '')) ids.add(node.attrs!.entityId); if (node.type === 'rawMarkdown' && node.attrs?.markdown) renderToStaticMarkup(<ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ href }) => { const id = referenceId(href); if (id) ids.add(id); return null; } }}>{node.attrs.markdown}</ReactMarkdown>); node.content?.forEach(visit); }; if (doc) visit(doc); return [...ids]; }

const escapeMarkdown = (text: string) => text.replace(/([\\`*_[\]<>#!|])/g, '\\$1');
export function documentMarkdown(doc: JSONContent): string {
 const render = (node: JSONContent): string => {
  if (node.type === 'text') { let text = escapeMarkdown(node.text || ''); for (const mark of node.marks || []) { if (mark.type === 'bold') text = `**${text}**`; else if (mark.type === 'italic') text = `*${text}*`; else if (mark.type === 'strike') text = `~~${text}~~`; else if (mark.type === 'underline') text = `<u>${text}</u>`; else if (mark.type === 'code') { const source = node.text || '', fence = '`'.repeat(Math.max(0, ...(source.match(/`+/g) || []).map(value => value.length)) + 1), pad = /^`|`$/.test(source) || /^ .* $/.test(source) && !!source.trim() ? ' ' : ''; text = `${fence}${pad}${source}${pad}${fence}`; } else if (mark.type === 'link' && safeUrl(mark.attrs?.href)) text = `[${text}](${mark.attrs!.href})`; } return text; }
  if (node.type === 'entityMention') return `[@${escapeMarkdown(node.attrs?.label || 'Item')}](/library?open=${node.attrs?.entityId})`;
  if (node.type === 'tableReference') return `\n\n[Table: ${escapeMarkdown(node.attrs?.label || 'Table')}](/library?open=${node.attrs?.entityId}&embed=table)\n\n`;
  if (node.type === 'rawMarkdown') return `${node.attrs?.markdown || ''}\n\n`;
  const text = (node.content || []).map(render).join('');
  if (node.type === 'heading') return `${'#'.repeat(node.attrs?.level || 2)} ${text}\n\n`;
  if (node.type === 'paragraph') return `${text.replace(/^( {0,3})([-+]|\d+[.)])(?=\s)/gm, (_match, space, marker) => `${space}${marker.length === 1 ? `\\${marker}` : `${marker.slice(0, -1)}\\${marker.slice(-1)}`}`).replace(/^( {0,3})-((?: *-){2,})$/gm, '$1\\-$2')}\n\n`;
  if (node.type === 'hardBreak') return '  \n';
  if (node.type === 'horizontalRule') return '\n---\n\n';
  if (node.type === 'codeBlock') { const source = node.content?.map(n => n.text || '').join('') || '', fence = '`'.repeat(Math.max(2, ...(source.match(/`+/g) || []).map(value => value.length)) + 1); return `\n${fence}${node.attrs?.language || ''}\n${source}\n${fence}\n\n`; }
  if (node.type === 'blockquote') return text.trim().split('\n').map(line => `> ${line}`).join('\n') + '\n\n';
  if (node.type === 'bulletList' || node.type === 'orderedList') return (node.content || []).map((item, index) => `${node.type === 'bulletList' ? '-' : `${(node.attrs?.start || 1) + index}.`} ${render(item).trim().replace(/\n/g, '\n  ')}`).join('\n') + '\n\n';
  return text;
 };
 return render(doc).trim();
}
export function markdownDocument(markdown: string): JSONContent {
 // Keep constructs outside the rich schema as verbatim source blocks. AST
 // positions avoid reconstructing tables, image attributes, and task states.
 const supported = new Set(['root', 'paragraph', 'text', 'heading', 'strong', 'emphasis', 'delete', 'inlineCode', 'code', 'blockquote', 'list', 'listItem', 'link', 'thematicBreak', 'break']);
 const independentRaw = new Set(['image', 'table', 'tableRow', 'tableCell', 'html']);
 const unsupported = (node: any): boolean => !supported.has(node.type) || node.type === 'listItem' && node.checked != null || node.type === 'inlineCode' && /(^\s|\s$|\s{2})/.test(node.value || '') || (node.children || []).some(unsupported);
 const unknown = (node: any): boolean => !supported.has(node.type) && !independentRaw.has(node.type) || (node.children || []).some(unknown);
 const raw = (value: string) => ({ type: 'paragraph', data: { hName: 'div', hProperties: { 'data-raw-markdown': value } }, children: [] });
 function preserve() { return (tree: any) => { tree.children = unknown(tree) ? [raw(markdown)] : tree.children.map((node: any) => unsupported(node) ? raw(markdown.slice(node.position.start.offset, node.position.end.offset)) : node); }; }
 const html = renderToStaticMarkup(<ReactMarkdown remarkPlugins={[remarkGfm, preserve]} components={{ a: ({ href, children }) => { const id = referenceId(href); if (id && href?.includes('embed=table')) return <div data-table-reference={id} data-label={String(children).replace(/^Table: /, '')} />; if (id) return <span data-entity-reference={id} data-label={String(children).replace(/^@/, '')}>{children}</span>; return <a href={safeUrl(href)}>{children}</a>; } }}>{markdown}</ReactMarkdown>);
 return generateJSON(html, documentExtensions);
}

export function DocumentContent({ doc }: { doc: JSONContent }) {
 const render = (node: JSONContent, key: string): ReactNode => {
  if (node.type === 'text') { let value: ReactNode = node.text || ''; for (const [index, mark] of (node.marks || []).entries()) { if (mark.type === 'bold') value = <strong key={index}>{value}</strong>; else if (mark.type === 'italic') value = <em key={index}>{value}</em>; else if (mark.type === 'strike') value = <s key={index}>{value}</s>; else if (mark.type === 'underline') value = <u key={index}>{value}</u>; else if (mark.type === 'code') value = <code key={index}>{value}</code>; else if (mark.type === 'link') value = <a key={index} href={safeUrl(mark.attrs?.href)} target="_blank" rel="noopener noreferrer">{value}</a>; } return <span key={key}>{value}</span>; }
  if (node.type === 'entityMention') return <EntityReference key={key} id={node.attrs?.entityId} label={node.attrs?.label} />;
  if (node.type === 'tableReference') return <LiveTableReference key={key} id={node.attrs?.entityId} label={node.attrs?.label} />;
  if (node.type === 'rawMarkdown') return <PreservedMarkdown key={key} markdown={node.attrs?.markdown || ''} />;
  const children = node.content?.map((child, index) => render(child, `${key}-${index}`));
  if (node.type === 'paragraph') return <p key={key}>{children || <br />}</p>;
  if (node.type === 'heading') { const level = node.attrs?.level; return level === 1 ? <h1 key={key}>{children}</h1> : level === 3 ? <h3 key={key}>{children}</h3> : level === 4 ? <h4 key={key}>{children}</h4> : level === 5 ? <h5 key={key}>{children}</h5> : level === 6 ? <h6 key={key}>{children}</h6> : <h2 key={key}>{children}</h2>; }
  if (node.type === 'bulletList') return <ul key={key}>{children}</ul>;
  if (node.type === 'orderedList') return <ol key={key} start={node.attrs?.start}>{children}</ol>;
  if (node.type === 'listItem') return <li key={key}>{children}</li>;
  if (node.type === 'blockquote') return <blockquote key={key}>{children}</blockquote>;
  if (node.type === 'codeBlock') return <pre key={key}><code>{children}</code></pre>;
  if (node.type === 'horizontalRule') return <hr key={key} />;
  if (node.type === 'hardBreak') return <br key={key} />;
  return <div key={key}>{children}</div>;
 };
 return <div className="document-rendered">{render(doc, 'doc')}</div>;
}
