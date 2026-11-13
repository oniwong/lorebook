import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Page } from '../lib/api';
import { forgetPageLookups } from '../lib/enhance';
import { Modal } from './Modal';
import { ErrorBox } from './ErrorBox';

export function DeleteDialog({ page, onClose }: { page: Page; onClose: () => void }) {
  const count = useQuery({
    queryKey: ['subtree-count', page.id],
    queryFn: () => api.get<{ count: number }>(`/pages/${page.id}/subtree-count`),
    staleTime: 0,
  });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const n = count.data?.count ?? 1;

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.del(`/pages/${page.id}`);
      forgetPageLookups();
      qc.removeQueries({ queryKey: ['page', page.id] });
      await qc.invalidateQueries({ queryKey: ['tree'] });
      await qc.invalidateQueries({ queryKey: ['spaces'] });
      await qc.invalidateQueries({ queryKey: ['recent'] });
      onClose();
      const parent = page.breadcrumbs[page.breadcrumbs.length - 1];
      navigate(parent ? `/p/${parent.id}` : `/s/${page.spaceKey}`);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };

  return (
    <Modal title="Delete page" onClose={onClose}>
      <div className="form">
        <p>
          Move <strong>{page.title}</strong>
          {n > 1 && <> and its <strong>{n - 1} subpage{n > 2 ? 's' : ''}</strong></>} to the trash?
        </p>
        <p className="muted small">An admin can restore {n > 1 ? 'them' : 'it'} for 30 days. After that {n > 1 ? 'they are' : 'it is'} deleted permanently. Links to {n > 1 ? 'these pages' : 'this page'} will show as broken meanwhile.</p>
        {error != null && <ErrorBox error={error} />}
        <div className="form-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" className="danger" disabled={busy || count.isLoading} onClick={() => void remove()}>
            {n > 1 ? `Delete ${n} pages` : 'Delete page'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
