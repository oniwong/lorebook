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
  del: <T>(url: string) => request<T>('DELETE', url),
};

/**
 * Uploads a file as the raw request body (the server streams it to disk). Reports progress 0..1.
 * Uses XMLHttpRequest because fetch has no upload progress.
 */
export function uploadAttachment(pageId: number, file: File, onProgress?: (p: number) => void): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/v1/pages/${pageId}/attachments?filename=${encodeURIComponent(file.name || 'pasted-image.png')}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    if (csrfToken) xhr.setRequestHeader('X-CSRF-Token', csrfToken);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    xhr.onload = () => {
      let data: any = null;
      try { data = xhr.responseText ? JSON.parse(xhr.responseText) : null; } catch { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as Attachment);
      else reject(new ApiError(xhr.status, data?.error ?? (xhr.status === 413 ? 'The file is too large' : xhr.statusText), data?.details));
    };
    xhr.onerror = () => reject(new ApiError(0, 'Upload failed: network error'));
    xhr.send(file);
  });
}

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
  templateInfo: { key: string; name: string; requiredSections: string[] };
  currentRevisionId: number;
  owner: { id: number; displayName: string; active: boolean };
  createdAt: string;
  updatedAt: string;
  updatedBy: { id: number; displayName: string };
  checkout: { userId: number; displayName: string; since: string; mine: boolean } | null;
  myDraft: { updatedAt: string; status: string } | null;
  breadcrumbs: { id: number; title: string; slug: string }[];
  tags: string[];
  review: {
    reviewBy: string | null;
    status: ReviewStatus;
    lastReviewedAt: string;
    reviewedBy: { id: number; displayName: string } | null;
  };
  secretFindings: StoredFinding[];
};

export type ReviewStatus = 'none' | 'ok' | 'due' | 'overdue';

/** A masked secret-scan finding as stored on revisions and attachments. */
export type StoredFinding = { ruleId: string; ruleName: string; line: number; preview: string };

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
  secretFindings: StoredFinding[] | null;
  secretsAcknowledged: boolean;
};

export type Revision = RevisionSummary & { pageId: number; body: string };

export type Template = {
  key: string;
  name: string;
  description: string;
  body: string;
  requiredSections: string[];
  reviewIntervalMonths: number | null;
  builtin: boolean;
  position: number;
  pageCount?: number;
};

export type Attachment = {
  id: number;
  pageId: number;
  filename: string;
  contentType: string;
  size: number;
  createdAt: string;
  uploadedBy: { id: number; displayName: string };
  url: string;
  isImage: boolean;
  isText: boolean;
  secretFindings: StoredFinding[];
  /** Only on the upload response. */
  warnings?: StoredFinding[];
};

export type PageRef = { id: number; title: string; slug: string; spaceKey: string; spaceName: string };

export type TrashItem = {
  id: number;
  title: string;
  spaceKey: string;
  spaceName: string;
  deletedAt: string;
  deletedBy: string | null;
  parentId: number | null;
  parentTitle: string | null;
  parentLive: boolean;
  count: number;
  purgeAt: string;
};

export type AppSettings = { uploadMaxMb: number | null; searchLanguage: string; defaultReviewMonths: number };

export type Snippet = { text: string; highlights: [number, number][] };

export type SearchHit = {
  id: number;
  title: string;
  slug: string;
  spaceKey: string;
  spaceName: string;
  path: string[];
  owner: { id: number; displayName: string; active: boolean };
  updatedAt: string;
  template: string;
  tags: string[];
  reviewBy: string | null;
  titleHighlights: [number, number][];
  snippet: Snippet | null;
  attachments: { filename: string; snippet: Snippet | null }[];
};

export type SearchResult = { total: number; hits: SearchHit[]; tookMs: number };

export type StaleRow = {
  id: number; title: string; slug: string; spaceKey: string; spaceName: string; template: string;
  reviewBy: string; status: ReviewStatus; lastReviewedAt: string; reviewedByName: string | null; updatedAt: string;
  owner: { id: number; displayName: string; active: boolean };
};

export type DirectoryUser = { id: number; displayName: string; active: boolean };

/** Formats a YYYY-MM-DD date for display without shifting it through a time zone. */
export function formatDay(d: string): string {
  const [y, m, day] = d.split('-').map(Number);
  return new Date(y, m - 1, day).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function todayIso(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

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
