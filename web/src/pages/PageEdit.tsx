import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api, formatTime, pagePath, type Draft, type Page } from '../lib/api';
import { useUser } from '../lib/session';
import { MarkdownEditor } from '../components/MarkdownEditor';
import { MarkdownView } from '../components/MarkdownView';
import { ErrorBox } from '../components/ErrorBox';
import { Modal } from '../components/Modal';

const AUTOSAVE_MS = 4_000;
const HEARTBEAT_MS = 60_000;
type ViewMode = 'split' | 'editor' | 'preview';

function loadMode(): ViewMode {
  try {
    const m = localStorage.getItem('lorebook.editorMode');
    if (m === 'split' || m === 'editor' || m === 'preview') return m;
  } catch { /* storage unavailable */ }
  return 'split';
}

type Status =
  | { kind: 'loading' }
  | { kind: 'blocked'; error: ApiError | Error }
  | { kind: 'editing' }
  | { kind: 'lost'; message: string };

export function PageEdit() {
  const { id } = useParams();
  const pageId = Number(id);
  const user = useUser();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const pageQ = useQuery({ queryKey: ['page', pageId], queryFn: () => api.get<Page>(`/pages/${pageId}`) });

  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [preview, setPreview] = useState('');
  const [stale, setStale] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [mode, setMode] = useState<ViewMode>(loadMode);
  const [checkinOpen, setCheckinOpen] = useState(false);
  const [editorKey, setEditorKey] = useState(0);

  const current = useRef({ title: '', body: '' });
  const saved = useRef({ title: '', body: '' });
  const lastActivity = useRef(Date.now());
  const lastBeat = useRef(Date.now());
  const saving = useRef<Promise<void> | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef(status);
  statusRef.current = status;

  const dirty = () => current.current.title !== saved.current.title || current.current.body !== saved.current.body;

  const handleLost = useCallback((e: unknown) => {
    if (e instanceof ApiError && e.status === 409) {
      setStatus({ kind: 'lost', message: e.message });
      return true;
    }
    return false;
  }, []);

  const applyDraft = (d: Draft) => {
    setDraft(d);
    setTitle(d.title);
    setBody(d.body);
    setPreview(d.body);
    setStale(d.stale);
    current.current = { title: d.title, body: d.body };
    saved.current = { title: d.title, body: d.body };
    setEditorKey((k) => k + 1);
  };

  const doCheckout = useCallback(async (fresh = false) => {
    try {
      const d = await api.post<Draft>(`/pages/${pageId}/checkout`, { fresh });
      applyDraft(d);
      setStatus({ kind: 'editing' });
      void qc.invalidateQueries({ queryKey: ['page', pageId] });
      void qc.invalidateQueries({ queryKey: ['drafts'] });
    } catch (e) {
      setStatus({ kind: 'blocked', error: e as Error });
    }
  }, [pageId, qc]);

  useEffect(() => { void doCheckout(); }, [doCheckout]);

  const saveNow = useCallback(async () => {
    if (saving.current) await saving.current;
    if (statusRef.current.kind !== 'editing' || !dirty()) return;
    const snapshot = { ...current.current };
    saving.current = (async () => {
      try {
        const d = await api.put<Draft>(`/pages/${pageId}/draft`, snapshot);
        saved.current = snapshot;
        lastBeat.current = Date.now();
        setSavedAt(new Date(d.updatedAt));
        setStale(d.stale);
        setSaveError(null);
      } catch (e) {
        if (!handleLost(e)) setSaveError((e as Error).message);
      } finally {
        saving.current = null;
      }
    })();
    await saving.current;
  }, [pageId, handleLost]);

  // Autosave while there are changes.
  useEffect(() => {
    if (status.kind !== 'editing') return;
    const t = setInterval(() => { void saveNow(); }, AUTOSAVE_MS);
    return () => clearInterval(t);
  }, [status.kind, saveNow]);

  // Heartbeat, only while the person is actually active, so an abandoned tab still lets the check-out expire.
  useEffect(() => {
    if (status.kind !== 'editing') return;
    const mark = () => { lastActivity.current = Date.now(); };
    window.addEventListener('keydown', mark);
    window.addEventListener('mousemove', mark);
    window.addEventListener('mousedown', mark);
    const t = setInterval(async () => {
      if (lastActivity.current <= lastBeat.current) return;
      try {
        await api.post(`/pages/${pageId}/heartbeat`);
        lastBeat.current = Date.now();
      } catch (e) {
        handleLost(e);
      }
    }, HEARTBEAT_MS);
    return () => {
      clearInterval(t);
      window.removeEventListener('keydown', mark);
      window.removeEventListener('mousemove', mark);
      window.removeEventListener('mousedown', mark);
    };
  }, [status.kind, pageId, handleLost]);

  // Debounced preview rendering.
  useEffect(() => {
    const t = setTimeout(() => setPreview(body), 150);
    return () => clearTimeout(t);
  }, [body]);

  // Warn before closing the tab with unsaved changes; Ctrl+S saves the draft now.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirty()) e.preventDefault();
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saveNow();
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('keydown', onKey);
    };
  }, [saveNow]);

  const changeMode = (m: ViewMode) => {
    setMode(m);
    try { localStorage.setItem('lorebook.editorMode', m); } catch { /* ignore */ }
  };

  const onBody = useCallback((v: string) => {
    current.current.body = v;
    lastActivity.current = Date.now();
    setBody(v);
  }, []);

  const onScrollRatio = useCallback((r: number) => {
    const el = previewRef.current?.parentElement;
    if (el) el.scrollTop = r * (el.scrollHeight - el.clientHeight);
  }, []);

  const retake = async () => {
    const local = { ...current.current };
    try {
      await api.post<Draft>(`/pages/${pageId}/checkout`, {});
      const d = await api.put<Draft>(`/pages/${pageId}/draft`, local);
      saved.current = local;
      setStale(d.stale);
      setSavedAt(new Date(d.updatedAt));
      setStatus({ kind: 'editing' });
    } catch (e) {
      setStatus({ kind: 'lost', message: (e as Error).message });
    }
  };

  const discard = async () => {
    if (!confirm('Discard your changes and release the page?')) return;
    current.current = saved.current = { title: '', body: '' };
    await api.post(`/pages/${pageId}/discard`).catch(() => undefined);
    await qc.invalidateQueries({ queryKey: ['page', pageId] });
    await qc.invalidateQueries({ queryKey: ['drafts'] });
    const p = pageQ.data;
    navigate(p ? pagePath(p) : '/');
  };

  const leave = async () => {
    await saveNow();
    const p = pageQ.data;
    navigate(p ? pagePath(p) : '/');
  };

  const page = pageQ.data;

  if (status.kind === 'loading') return <div className="editor-shell"><p className="pad muted">Checking out…</p></div>;
  if (status.kind === 'blocked') {
    const e = status.error;
    const co = e instanceof ApiError ? e.details?.checkout : null;
    return (
      <div className="editor-shell">
        <div className="content">
          <h1>Can't edit this page</h1>
          {co
            ? <div className="banner warn">Checked out by <strong>{co.displayName}</strong> since {formatTime(co.since)}. Try again when they check in{user.role === 'admin' ? ', or break the check-out from the page view' : ''}.</div>
            : <ErrorBox error={e} />}
          {page && <p><Link to={pagePath(page)}>Back to the page</Link></p>}
        </div>
      </div>
    );
  }

  return (
    <div className="editor-shell">
      <header className="editor-top">
        <button className="link-btn" onClick={() => void leave()} title="Keep the check-out and your draft">← Back to page</button>
        <input
          className="title-input"
          value={title}
          maxLength={200}
          aria-label="Page title"
          onChange={(e) => { setTitle(e.target.value); current.current.title = e.target.value; lastActivity.current = Date.now(); }}
        />
        <div className="seg" role="group" aria-label="View">
          {(['editor', 'split', 'preview'] as ViewMode[]).map((m) => (
            <button key={m} className={mode === m ? 'on' : ''} onClick={() => changeMode(m)}>{m[0].toUpperCase() + m.slice(1)}</button>
          ))}
        </div>
        <span className="save-state muted small" aria-live="polite">
          {saveError ? <span className="text-danger">Autosave failed: {saveError}</span>
            : savedAt ? `Draft saved ${formatTime(savedAt)}` : 'Checked out'}
        </span>
        <button onClick={() => void discard()}>Discard</button>
        <button className="primary" disabled={status.kind !== 'editing' || !title.trim()} onClick={async () => { await saveNow(); setCheckinOpen(true); }}>
          Check in
        </button>
      </header>

      {status.kind === 'lost' && (
        <div className="banner danger">
          {status.message} Your text is still here.
          <button className="link-btn" onClick={() => void retake()}>Try to check out again</button>
        </div>
      )}
      {stale && status.kind === 'editing' && (
        <div className="banner warn">
          This page changed since your draft was started. Checking in will replace those changes.{' '}
          <Link to={`/p/${pageId}/history`} target="_blank">See history</Link>
          <button className="link-btn" onClick={() => { if (confirm('Throw away your draft and start from the current version?')) void doCheckout(true); }}>
            Start over from current version
          </button>
        </div>
      )}

      <div className={`editor-panes mode-${mode}`}>
        <div className="pane pane-editor">
          {draft && <MarkdownEditor key={editorKey} initialValue={draft.body} onChange={onBody} onScrollRatio={mode === 'split' ? onScrollRatio : undefined} />}
        </div>
        <div className="pane pane-preview">
          <div className="preview-inner">
            <h1 className="preview-title">{title}</h1>
            <MarkdownView ref={previewRef} source={preview} />
          </div>
        </div>
      </div>

      {checkinOpen && (
        <CheckinDialog
          pageId={pageId}
          title={title}
          body={body}
          stale={stale}
          onClose={() => setCheckinOpen(false)}
          onDone={async () => {
            current.current = saved.current = { title: '', body: '' };
            await qc.invalidateQueries({ queryKey: ['page', pageId] });
            await qc.invalidateQueries({ queryKey: ['tree'] });
            await qc.invalidateQueries({ queryKey: ['drafts'] });
            await qc.invalidateQueries({ queryKey: ['recent'] });
            const p = await api.get<Page>(`/pages/${pageId}`);
            navigate(pagePath(p));
          }}
        />
      )}
    </div>
  );
}

function CheckinDialog({ pageId, title, body, stale, onClose, onDone }: {
  pageId: number; title: string; body: string; stale: boolean; onClose: () => void; onDone: () => Promise<void>;
}) {
  const [message, setMessage] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [confirmOverwrite, setConfirmOverwrite] = useState(stale);
  const [busy, setBusy] = useState(false);

  const submit = async (overwriteNewer: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/pages/${pageId}/checkin`, { title, body, message, overwriteNewer });
      await onDone();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'stale_draft') setConfirmOverwrite(true);
      else setError(e);
      setBusy(false);
    }
  };

  return (
    <Modal title="Check in" onClose={onClose}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); void submit(confirmOverwrite); }}>
        <label>
          What changed? <span className="muted">(optional)</span>
          <input autoFocus value={message} maxLength={500} onChange={(e) => setMessage(e.target.value)} placeholder="e.g. Added rollback steps" />
        </label>
        {confirmOverwrite && (
          <div className="banner warn">Someone changed this page after you started. Checking in replaces their version (it stays in History).</div>
        )}
        {error != null && <ErrorBox error={error} />}
        <div className="form-actions">
          <button type="button" onClick={onClose}>Keep editing</button>
          <button type="submit" className="primary" disabled={busy}>{confirmOverwrite ? 'Check in anyway' : 'Check in'}</button>
        </div>
      </form>
    </Modal>
  );
}
