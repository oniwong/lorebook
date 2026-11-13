import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, formatDateTime, timeAgo, type TrashItem } from '../lib/api';
import { forgetPageLookups } from '../lib/enhance';
import { ErrorBox } from '../components/ErrorBox';
import { Modal } from '../components/Modal';
import { PlacePicker, type Place } from '../components/PlacePicker';

export function TrashAdmin() {
  const [q, setQ] = useState('');
  const qc = useQueryClient();
  const navigate = useNavigate();
  const trash = useQuery({ queryKey: ['trash', q], queryFn: () => api.get<TrashItem[]>(`/trash?q=${encodeURIComponent(q)}`) });
  const [error, setError] = useState<unknown>(null);
  const [restoreTo, setRestoreTo] = useState<TrashItem | null>(null);

  const after = async () => {
    forgetPageLookups();
    await qc.invalidateQueries({ queryKey: ['trash'] });
    await qc.invalidateQueries({ queryKey: ['tree'] });
    await qc.invalidateQueries({ queryKey: ['spaces'] });
  };

  const restore = async (t: TrashItem, place?: Place) => {
    setError(null);
    try {
      await api.post(`/trash/${t.id}/restore`, place ?? {});
      await after();
      setRestoreTo(null);
      navigate(`/p/${t.id}`);
    } catch (e) {
      setError(e);
    }
  };

  const purge = async (t: TrashItem) => {
    if (!confirm(`Permanently delete “${t.title}”${t.count > 1 ? ` and ${t.count - 1} subpage(s)` : ''}, with all revisions and attachments? This cannot be undone.`)) return;
    setError(null);
    try {
      await api.post(`/trash/${t.id}/purge`);
      await after();
    } catch (e) {
      setError(e);
    }
  };

  const items = trash.data ?? [];
  return (
    <section className="card">
      <div className="section-head">
        <h2>Trash</h2>
        <input className="trash-search" type="search" placeholder="Search trashed pages…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <p className="muted small">Deleted pages stay here for 30 days, then the nightly job deletes them permanently.</p>
      {error != null && <ErrorBox error={error} />}
      {items.length === 0 ? <p className="muted">{q ? 'Nothing matches.' : 'The trash is empty.'}</p> : (
        <table className="data-table">
          <thead><tr><th>Page</th><th>Was in</th><th>Deleted</th><th>Purged on</th><th /></tr></thead>
          <tbody>
            {items.map((t) => (
              <tr key={t.id}>
                <td>{t.title}{t.count > 1 && <span className="muted small"> + {t.count - 1} subpage{t.count > 2 ? 's' : ''}</span>}</td>
                <td className="small">{t.spaceName}{t.parentTitle && <> / {t.parentTitle}{!t.parentLive && <span className="muted"> (gone)</span>}</>}</td>
                <td className="small nowrap" title={formatDateTime(t.deletedAt)}>{timeAgo(t.deletedAt)} by {t.deletedBy ?? '?'}</td>
                <td className="small nowrap">{formatDateTime(t.purgeAt)}</td>
                <td className="nowrap">
                  <button className="small" onClick={() => void restore(t)} title={t.parentLive ? 'Back under its original parent' : 'To the top level of its Space'}>Restore</button>
                  <button className="small" onClick={() => setRestoreTo(t)}>Restore to…</button>
                  <button className="small" onClick={() => void purge(t)}>Delete forever</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {restoreTo && <RestoreDialog item={restoreTo} onClose={() => setRestoreTo(null)} onRestore={(p) => restore(restoreTo, p)} />}
    </section>
  );
}

function RestoreDialog({ item, onClose, onRestore }: { item: TrashItem; onClose: () => void; onRestore: (p: Place) => Promise<void> }) {
  const [place, setPlace] = useState<Place>({ spaceKey: item.spaceKey, parentId: null });
  return (
    <Modal title={`Restore “${item.title}” to…`} onClose={onClose}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); void onRestore(place); }}>
        <PlacePicker value={place} onChange={setPlace} />
        <div className="form-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="primary" type="submit">Restore here</button>
        </div>
      </form>
    </Modal>
  );
}
