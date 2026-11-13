import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Modal } from './Modal';
import { ErrorBox } from './ErrorBox';

export function NewPageDialog({ spaceKey, parentId, parentTitle, onClose }: {
  spaceKey: string; parentId: number | null; parentTitle?: string; onClose: () => void;
}) {
  const [title, setTitle] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const p = await api.post<{ id: number }>('/pages', { spaceKey, parentId, title });
      await qc.invalidateQueries({ queryKey: ['tree', spaceKey] });
      await qc.invalidateQueries({ queryKey: ['spaces'] });
      onClose();
      navigate(`/p/${p.id}/edit`);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <Modal title={parentId ? 'New subpage' : 'New page'} onClose={onClose}>
      <form onSubmit={submit} className="form">
        {parentTitle && <p className="muted">Under “{parentTitle}”</p>}
        <label>
          Title
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required />
        </label>
        {error != null && <ErrorBox error={error} />}
        <div className="form-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={busy || !title.trim()}>Create and edit</button>
        </div>
      </form>
    </Modal>
  );
}
