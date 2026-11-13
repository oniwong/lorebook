import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api, formatTime, pagePath, uploadAttachment, type Draft, type Page, type PageRef } from '../lib/api';
import { checkRequiredSections } from '../lib/sections';
import { useUser } from '../lib/session';
import { MarkdownEditor } from '../components/MarkdownEditor';
import { MarkdownView } from '../components/MarkdownView';
import { ErrorBox } from '../components/ErrorBox';
import { Modal } from '../components/Modal';
import { SecretFindings } from '../components/SecretFindings';
import type { SecretFinding, SecretScanConfig } from '../lib/secrets';

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
  const rulesQ = useQuery({
    queryKey: ['secret-rules'],
    queryFn: () => api.get<{ config: SecretScanConfig }>('/secret-rules'),
    staleTime: 5 * 60_000,
  });
  const [secretFindings, setSecretFindings] = useState<SecretFinding[]>([]);

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
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadWarning, setUploadWarning] = useState<string | null>(null);

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

  const upload = useCallback(async (file: File, onProgress: (p: number) => void) => {
    lastActivity.current = Date.now();
    const a = await uploadAttachment(pageId, file, onProgress);
    void qc.invalidateQueries({ queryKey: ['attachments', pageId] });
    if (a.warnings?.length) {
      setUploadWarning(`${a.filename} looks like it contains a password or key (line ${a.warnings.map((w) => w.line).slice(0, 5).join(', ')}). Consider removing it and linking to the vault entry.`);
    }
    return a;
  }, [pageId, qc]);

  const searchPages = useCallback((q: string) => api.get<PageRef[]>(`/pages/quick?q=${encodeURIComponent(q)}`), []);

  const page = pageQ.data;
  const required = page?.templateInfo.requiredSections ?? [];
  const sectionCheck = required.length ? checkRequiredSections(preview, required) : null;

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
        {secretFindings.length > 0 && (
          <span className="secret-count" title={secretFindings.map((f) => `Line ${f.line}: ${f.ruleName}`).join('\n')}>
            ⚠ {secretFindings.length === 1 ? '1 possible secret' : `${secretFindings.length} possible secrets`}
          </span>
        )}
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

      {uploadWarning && (
        <div className="banner warn">{uploadWarning} <button className="link-btn" onClick={() => setUploadWarning(null)}>Dismiss</button></div>
      )}
      {uploadError && (
        <div className="banner danger">Upload failed: {uploadError} <button className="link-btn" onClick={() => setUploadError(null)}>Dismiss</button></div>
      )}
      {sectionCheck && page && (
        <div className={`section-status ${sectionCheck.missing.length || sectionCheck.empty.length ? 'todo' : 'ok'}`} aria-live="polite">
          <span className="badge">{page.templateInfo.name}</span>
          {sectionCheck.missing.length || sectionCheck.empty.length ? (
            <>
              {sectionCheck.missing.length > 0 && <span>Missing sections: <strong>{sectionCheck.missing.join(', ')}</strong></span>}
              {sectionCheck.empty.length > 0 && <span>Still empty: <strong>{sectionCheck.empty.join(', ')}</strong></span>}
              <span className="muted small">Required before check-in.</span>
            </>
          ) : <span>All required sections are filled in.</span>}
        </div>
      )}

      <div className={`editor-panes mode-${mode}`}>
        <div className="pane pane-editor">
          {draft && (
            <MarkdownEditor
              key={editorKey}
              initialValue={draft.body}
              onChange={onBody}
              onScrollRatio={mode === 'split' ? onScrollRatio : undefined}
              upload={upload}
              onUploadError={setUploadError}
              searchPages={searchPages}
              secretConfig={rulesQ.data?.config ?? null}
              onSecretFindings={setSecretFindings}
            />
          )}
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
          page={page}
          canChangeTemplate={!!page && (page.owner.id === user.id || user.role === 'admin')}
          canReview={!!page && !!page.review.reviewBy && (page.owner.id === user.id || user.role === 'admin')}
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
            await qc.invalidateQueries({ queryKey: ['backlinks'] });
            const p = await api.get<Page>(`/pages/${pageId}`);
            navigate(pagePath(p));
          }}
        />
      )}
    </div>
  );
}

function CheckinDialog({ page, canChangeTemplate, canReview, pageId, title, body, stale, onClose, onDone }: {
  page: Page | undefined; canChangeTemplate: boolean; canReview: boolean;
  pageId: number; title: string; body: string; stale: boolean; onClose: () => void; onDone: () => Promise<void>;
}) {
  const [message, setMessage] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [confirmOverwrite, setConfirmOverwrite] = useState(stale);
  const [sections, setSections] = useState<{ missing: string[]; empty: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [secrets, setSecrets] = useState<SecretFinding[] | null>(null);
  const [markReviewed, setMarkReviewed] = useState(page?.review.status === 'overdue');

  const submit = async (overwriteNewer: boolean, secretsAcknowledged = false) => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/pages/${pageId}/checkin`, {
        title, body, message, overwriteNewer, secretsAcknowledged, markReviewed: canReview && markReviewed,
      });
      await onDone();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'stale_draft') setConfirmOverwrite(true);
      else if (e instanceof ApiError && e.code === 'missing_sections') setSections({ missing: e.details.missing, empty: e.details.empty });
      else if (e instanceof ApiError && e.code === 'possible_secrets') setSecrets(e.details.findings);
      else setError(e);
      setBusy(false);
    }
  };

  if (secrets) {
    return (
      <Modal title="Possible secrets" onClose={onClose} wide>
        <div className="form">
          <p>This looks like it contains {secrets.length === 1 ? 'a password or key' : `${secrets.length} passwords or keys`}. Anyone who can read Lorebook will see it, and it stays in the page history.</p>
          <SecretFindings findings={secrets} />
          <p className="muted small">
            Better: store it in the password vault and link to the entry. For a false alarm, add <code>{'<!-- lorebook:ignore-secret -->'}</code> at the end of the line.
          </p>
          {error != null && <ErrorBox error={error} />}
          <div className="form-actions">
            <button type="button" disabled={busy} onClick={() => void submit(confirmOverwrite, true)}>Save anyway</button>
            <button type="button" className="primary" onClick={onClose}>Go back and fix it</button>
          </div>
        </div>
      </Modal>
    );
  }

  const switchToBlank = async () => {
    if (!confirm(`Switch this page from the ${page?.templateInfo.name ?? ''} template to Blank? Its sections will no longer be required.`)) return;
    setBusy(true);
    try {
      await api.post(`/pages/${pageId}/template`, { template: 'blank' });
      setSections(null);
      await submit(confirmOverwrite);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };

  if (sections) {
    return (
      <Modal title="Required sections missing" onClose={onClose}>
        <div className="form">
          <p>This page uses the <strong>{page?.templateInfo.name}</strong> template. Fill in these sections before checking in:</p>
          <ul>
            {sections.missing.map((s) => <li key={s}><strong>{s}</strong> <span className="muted">(heading missing)</span></li>)}
            {sections.empty.map((s) => <li key={s}><strong>{s}</strong> <span className="muted">(empty)</span></li>)}
          </ul>
          <p className="muted small">Each one is a <code>## Heading</code> with some text under it.</p>
          {error != null && <ErrorBox error={error} />}
          <div className="form-actions">
            {canChangeTemplate && <button type="button" disabled={busy} onClick={() => void switchToBlank()}>Switch page to Blank</button>}
            <button type="button" className="primary" onClick={onClose}>Back to editing</button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Check in" onClose={onClose}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); void submit(confirmOverwrite); }}>
        <label>
          What changed? <span className="muted">(optional)</span>
          <input autoFocus value={message} maxLength={500} onChange={(e) => setMessage(e.target.value)} placeholder="e.g. Added rollback steps" />
        </label>
        {canReview && (
          <label className="check">
            <input type="checkbox" checked={markReviewed} onChange={(e) => setMarkReviewed(e.target.checked)} />
            Also mark the page as reviewed{page?.review.status === 'overdue' ? ' (it is overdue)' : ''}
          </label>
        )}
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
