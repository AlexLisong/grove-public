import type { Session } from '../shared/types';
let csrf = '';
let workspace = '';
export function setSessionContext(session: Session | null, workspaceId?: string) { csrf = session?.csrfToken || ''; workspace = workspaceId || session?.workspace?.id || ''; }
export function setWorkspaceContext(id: string) { workspace = id; }
export class ApiError extends Error { status: number; code?: string; constructor(message: string, status: number, code?: string) { super(message); this.status = status; this.code = code; } }
export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (workspace && !headers.has('X-Workspace-Id')) headers.set('X-Workspace-Id', workspace);
  if (csrf) headers.set('X-CSRF-Token', csrf);
  if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(`/api${path}`, { ...options, headers, credentials: 'same-origin' });
  const result = response.headers.get('content-type')?.includes('json') ? await response.json() : null;
  if (!response.ok) throw new ApiError(result?.error || `The request could not be completed (${response.status}).`, response.status, result?.code);
  return result as T;
}
export const post = <T = any>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', body: JSON.stringify(body) });
export const patch = <T = any>(path: string, body: unknown) => api<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
export async function download(path: string, name?: string) {
  const response = await fetch(`/api${path}`, { credentials: 'same-origin', headers: { 'X-Workspace-Id': workspace, 'X-CSRF-Token': csrf } });
  if (!response.ok) { let message = 'Download failed. Please try again.'; try { message = (await response.json()).error || message; } catch {} throw new Error(message); }
  const responseName = response.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1];
  saveBlob(await response.blob(), name || responseName || 'grove-download');
}
export function saveBlob(blob: Blob, name: string) { const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 3000); }
export function safeUrl(value?: string): string | undefined { if (!value) return; try { const u = new URL(value, window.location.origin); return ['http:', 'https:'].includes(u.protocol) ? u.href : undefined; } catch { return; } }
export async function getFileBlob(id: string) { const response = await fetch(`/api/files/${id}`, { credentials: 'same-origin', headers: { 'X-Workspace-Id': workspace } }); if (!response.ok) throw new Error('This file could not be opened.'); return response.blob(); }
