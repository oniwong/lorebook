import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, formatBytes, formatDateTime, uploadAttachment, type AppSettings, type Attachment } from '../lib/api';
import { renderTextFile } from '../lib/markdown';
import { ErrorBox } from './ErrorBox';
import { useUser } from '../lib/session';

function iconFor(a: Attachment): string {
  const n = a.filename.toLowerCase();
  if (a.isImage) return '🖼';
  if (/\.drawio(\.\w+)?$/.test(n)) return '📐';
  if (/\.vsd[xm]?$/.test(n)) return '📊';
  if (n.endsWith('.pdf')) return '📕';
  if (/\.(zip|gz|7z|tar|tgz)$/.test(n)) return '🗜';
  if (a.isText) return '📄';
  return '📎';
}

function markdownFor(a: Attachment): string {
  const url = a.url.replace(/\(/g, '%28').replace(/\)/g, '%29');
  const label = a.filename.replace(/[[\]]/g, '');
  return a.isImage ? `![${label}](${url})` : `[${label}](${url})`;
}

function TextPreview({ a }: { a: Attachment }) {
  const q = useQuery({
    queryKey: ['attachment-preview', a.id],
    queryFn: () => api.get<{ text: string; truncated: boolean }>(`/attachment-previews/${a.id}`),
    staleTime: Infinity,
  });
  const [html, setHtml] = useState('');
  useEffect(() => {
    if (q.data) void renderTextFile(a.filename, q.data.text).then(setHtml);
  }, [q.data, a.filename]);
  if (q.error) return <ErrorBox error={q.error} />;
  return (
    <div className="att-preview">
      <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />
      {q.data?.truncated && <p className="muted small">Preview shows the first 512 KB. Download the file to see all of it.</p>}
    </div>
  );
}

/** The page's attachment list, with upload, inline previews for images and text files, and download links. */
export function AttachmentsPanel({ pageId, readOnlyReason }: { pageId: number; readOnlyReason?: string }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['attachments', pageId], queryFn: () => api.get<Attachment[]>(`/pages/${pageId}/attachments`) });
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api.get<AppSettings>('/settings'), staleTime: 60_000 });
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [progress, setProgress] = useState<{ name: string; p: number } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const user = useUser();
  const input = useRef<HTMLInputElement>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: ['attachments', pageId] });

  const upload = async (files: File[]) => {
    setError(null);
    for (const f of files) {
      try {
        setProgress({ name: f.name, p: 0 });
        const a = await uploadAttachment(pageId, f, (p) => setProgress({ name: f.name, p }));
        if (a.warnings?.length) setWarning(`${a.filename} looks like it contains a password or key. Consider removing it and linking to the vault entry instead.`);
      } catch (e) {
        setError(e);
      }
    }
    setProgress(null);
    await refresh();
  };

  const purge = async (a: Attachment) => {
    if (!confirm(`Permanently delete ${a.filename}? Older versions of the page that link to it will show a broken link. This can't be undone.`)) return;
    setError(null);
    try {
      await api.del(`/attachments/${a.id}/purge`);
      await refresh();
    } catch (e) {
      setError(e);
    }
  };

  const remove = async (a: Attachment) => {
    if (!confirm(`Remove ${a.filename} from this page? Older versions of the page that link to it keep working.`)) return;
    setError(null);
    try {
      await api.del(`/attachments/${a.id}`);
      await refresh();
    } catch (e) {
      setError(e);
    }
  };

  const copy = async (a: Attachment) => {
    try { await navigator.clipboard.writeText(markdownFor(a)); } catch { prompt('Copy this Markdown', markdownFor(a)); }
    setCopied(a.id);
    setTimeout(() => setCopied(null), 1500);
  };

  const toggle = (id: number) => setOpen((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  const items = list.data ?? [];
  const cap = settings.data?.uploadMaxMb;

  return (
    <section className="attachments" aria-label="Attachments"
      onDragOver={(e) => { if (!readOnlyReason && e.dataTransfer.types.includes('Files')) e.preventDefault(); }}
      onDrop={(e) => { if (readOnlyReason || !e.dataTransfer.files.length) return; e.preventDefault(); void upload([...e.dataTransfer.files]); }}>
      <div className="section-head">
        <h2>Attachments {items.length > 0 && <span className="muted">({items.length})</span>}</h2>
        <div>
          <button onClick={() => input.current?.click()} disabled={!!readOnlyReason || !!progress} title={readOnlyReason ?? (cap ? `Up to ${cap} MB per file` : 'Upload files')}>
            Upload files
          </button>
          <input ref={input} type="file" multiple hidden onChange={(e) => { const f = [...(e.target.files ?? [])]; e.target.value = ''; void upload(f); }} />
        </div>
      </div>
      {progress && (
        <div className="upload-progress">
          Uploading {progress.name}… {Math.round(progress.p * 100)}%
          <progress max={1} value={progress.p} />
        </div>
      )}
      {error != null && <ErrorBox error={error} />}
      {warning && <div className="banner warn">{warning} <button className="link-btn" onClick={() => setWarning(null)}>Dismiss</button></div>}
      {items.length === 0 && !progress && <p className="muted small">No files yet. Drop files here, or paste screenshots straight into the editor.</p>}
      <ul className="att-list">
        {items.map((a) => (
          <li key={a.id}>
            <div className="att-row">
              <span className="att-icon" aria-hidden>{iconFor(a)}</span>
              <a href={a.url} target="_blank" rel="noopener" className="att-name">{a.filename}</a>
              {a.secretFindings.length > 0 && (
                <span className="badge secret-flag" title={a.secretFindings.map((f) => `Line ${f.line}: ${f.ruleName} — ${f.preview}`).join('\n')}>⚠ possible secret</span>
              )}
              <span className="muted small nowrap">{formatBytes(a.size)} · {a.uploadedBy.displayName} · {formatDateTime(a.createdAt)}</span>
              <span className="att-actions">
                {(a.isText || a.isImage) && <button className="small" onClick={() => toggle(a.id)}>{open.has(a.id) ? 'Hide' : 'Preview'}</button>}
                <a className="button small" href={`${a.url}?download=1`}>Download</a>
                <button className="small" onClick={() => void copy(a)} title="Copy a Markdown link to paste into a page">{copied === a.id ? 'Copied' : 'Copy link'}</button>
                <button className="small" onClick={() => void remove(a)} disabled={!!readOnlyReason} title={readOnlyReason}>Remove</button>
                {user.role === 'admin' && a.secretFindings.length > 0 && (
                  <button className="small danger" onClick={() => void purge(a)} title="Delete the file for good, including from older versions">Purge</button>
                )}
              </span>
            </div>
            {open.has(a.id) && (a.isImage
              ? <div className="att-preview"><img src={a.url} alt={a.filename} /></div>
              : <TextPreview a={a} />)}
          </li>
        ))}
      </ul>
    </section>
  );
}
