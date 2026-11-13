import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type DirectoryUser, type Page } from '../lib/api';
import { Modal } from './Modal';
import { ErrorBox } from './ErrorBox';

/** Admins hand a page to a new owner, e.g. when the owner has left. */
export function OwnerDialog({ page, onClose }: { page: Page; onClose: () => void }) {
  const qc = useQueryClient();
  const people = useQuery({ queryKey: ['directory'], queryFn: () => api.get<DirectoryUser[]>('/users/directory') });
  const [userId, setUserId] = useState<number | ''>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const save = async () => {
    if (!userId) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/pages/${page.id}/owner`, { userId });
      await qc.invalidateQueries({ queryKey: ['page', page.id] });
      await qc.invalidateQueries({ queryKey: ['stale'] });
      onClose();
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };

  return (
    <Modal title="Change owner" onClose={onClose}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <p>
          The owner of “{page.title}” is <strong>{page.owner.displayName}</strong>{!page.owner.active && ' (former user)'}.
          The owner can lock the page, reviews its change requests and gets its review reminders.
        </p>
        <label>
          New owner
          <select value={userId} onChange={(e) => setUserId(e.target.value ? Number(e.target.value) : '')} autoFocus>
            <option value="">Choose a person…</option>
            {people.data?.filter((u) => u.active && u.id !== page.owner.id).map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
          </select>
        </label>
        <p className="muted small">Both the new and the old owner are told in their inbox. Open change requests move to the new owner.</p>
        {error != null && <ErrorBox error={error} />}
        <div className="form-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={busy || !userId}>Change owner</button>
        </div>
      </form>
    </Modal>
  );
}
