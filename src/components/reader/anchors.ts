export interface PassageAnchor { start: number; end: number; quote: string; prefix: string; suffix: string; chapter?: number }

export function textRange(root: HTMLElement, start: number, end: number): Range | null {
 const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let offset = 0, startNode: Node | null = null, endNode: Node | null = null, startOffset = 0, endOffset = 0;
 while (walker.nextNode()) { const node = walker.currentNode, length = node.textContent?.length || 0; if (!startNode && start >= offset && start < offset + length) { startNode = node; startOffset = start - offset; } if (startNode && end >= offset && end <= offset + length) { endNode = node; endOffset = end - offset; break; } offset += length; }
 if (!startNode || !endNode || end <= start) return null;
 const range = document.createRange(); range.setStart(startNode, startOffset); range.setEnd(endNode, endOffset); return range;
}
export function selectedAnchor(root: HTMLElement, chapter?: number): PassageAnchor | null {
 const selection = window.getSelection(); if (!selection?.rangeCount || selection.isCollapsed) return null;
 const range = selection.getRangeAt(0); if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
 const before = document.createRange(); before.selectNodeContents(root); before.setEnd(range.startContainer, range.startOffset);
 const selected = range.toString(), quote = selected.trim(); if (!quote || quote.length > 100000) return null;
 const leading = selected.length - selected.trimStart().length, start = before.toString().length + leading, end = start + quote.length, text = root.textContent || '';
 return { start, end, quote, prefix: text.slice(Math.max(0, start - 80), start), suffix: text.slice(end, end + 80), ...(chapter === undefined ? {} : { chapter }) };
}
export function locateAnchor(root: HTMLElement, anchor: PassageAnchor): Range | null {
 const text = root.textContent || '', quote = anchor.quote; if (!quote) return null;
 if (text.slice(anchor.start, anchor.end) === quote) return textRange(root, anchor.start, anchor.end);
 let index = text.indexOf(quote), best = -1, score = -1;
 while (index !== -1) { const context = (anchor.prefix && text.slice(Math.max(0, index - anchor.prefix.length), index) === anchor.prefix ? 2 : 0) + (anchor.suffix && text.slice(index + quote.length, index + quote.length + anchor.suffix.length) === anchor.suffix ? 2 : 0) + 1 / (1 + Math.abs(index - anchor.start)); if (context > score) { best = index; score = context; } index = text.indexOf(quote, index + 1); }
 return best < 0 ? null : textRange(root, best, best + quote.length);
}
