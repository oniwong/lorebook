export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: any) {
    super(message);
  }
  get code(): string | undefined {
    return this.details?.code;
  }
}

let csrfToken: string | null = null;
export function setCsrfToken(t: string | null) {
  csrfToken = t;
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  const res = await fetch(`/api/v1${url}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    if (res.status === 401 && url !== '/auth/login' && url !== '/auth/session') onUnauthorized?.();
    throw new ApiError(res.status, data?.error ?? res.statusText, data?.details);
  }
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body: unknown = {}) => request<T>('POST', url, body),
  put: <T>(url: string, body: unknown) => request<T>('PUT', url, body),
  patch: <T>(url: string, body: unknown) => request<T>('PATCH', url, body),
};

// ---- Types shared with the server responses ----

export type User = {
  id: number;
  username: string;
  displayName: string;
  email: string | null;
  role: 'user' | 'admin';
  authSource: string;
};

export type Space = { id: number; key: string; name: string; description: string; pageCount?: number };

export type TreePage = {
  id: number;
  parentId: number | null;
  position: number;
  title: string;
  slug: string;
  checkedOut: boolean;
};

export type Page = {
  id: number;
  spaceId: number;
  spaceKey: string;
  spaceName: string;
  parentId: number | null;
  title: string;
  slug: string;
  body: string;
  template: string;
  currentRevisionId: number;
  owner: { id: number; displayName: string; active: boolean };
  createdAt: string;
  updatedAt: string;
  updatedBy: { id: number; displayName: string };
  checkout: { userId: number; displayName: string; since: string; mine: boolean } | null;
  myDraft: { updatedAt: string; status: string } | null;
  breadcrumbs: { id: number; title: string; slug: string }[];
};

export type Draft = {
  pageId: number;
  title: string;
  body: string;
  baseRevisionId: number;
  updatedAt: string;
  status: string;
  stale: boolean;
};

export type RevisionSummary = {
  id: number;
  title: string;
  kind: 'create' | 'checkin' | 'restore';
  message: string;
  restoredFrom: number | null;
  createdAt: string;
  author: { id: number; displayName: string };
};

export type Revision = RevisionSummary & { pageId: number; body: string };

export function pagePath(p: { spaceKey: string; id: number; slug: string }): string {
  return `/s/${p.spaceKey}/p/${p.id}/${p.slug}`;
}

export function formatDateTime(s: string | Date): string {
  const d = new Date(s);
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function formatTime(s: string | Date): string {
  return new Date(s).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function timeAgo(s: string | Date): string {
  const sec = Math.round((Date.now() - new Date(s).getTime()) / 1000);
  if (sec < 60) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} d ago`;
  return formatDateTime(s);
}
