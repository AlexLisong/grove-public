export interface ItemDraft { title: string; content: string; data: Record<string, any>; tags: string[] }
export interface RecoveredItemDraft { version: number; draft: ItemDraft; savedAt: string }
export function readItemDraft(key: string): RecoveredItemDraft | null {
 try { const value = JSON.parse(localStorage.getItem(key) || 'null'); const draft = value?.draft; return value && Number.isInteger(value.version) && draft && typeof draft.title === 'string' && typeof draft.content === 'string' && draft.data && typeof draft.data === 'object' && !Array.isArray(draft.data) && Array.isArray(draft.tags) && draft.tags.every((tag: unknown) => typeof tag === 'string') ? value : null; } catch { return null; }
}
