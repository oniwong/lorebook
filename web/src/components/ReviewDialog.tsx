import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, formatDateTime, formatDay, type Page } from '../lib/api';
import { Modal } from './Modal';
import { ErrorBox } from './ErrorBox';

/** Owner/admin dialog: mark the page as reviewed, or set or clear its review-by date (spec §11). */
export function ReviewDialog({ page, onClose }: { page: Page; onClose: () => void }) {
  const qc = useQueryClient();
  const [date, setDate] = useState(page.review.reviewBy ?? '');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ['page', page.id] });
      await qc.invalidateQueries({ queryKey: ['stale'] });
      onClose();
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };

  const r = page.review;
  return (
    <Modal title="Review" onClose={onClose}>
      <div className="form">
        <p className="muted small">
          {r.reviewBy ? <>Review by <strong>{formatDay(r.reviewBy)}</strong>. </> : <>This page has no review date. </>}
          Last reviewed {formatDateTime(r.lastReviewedAt)}{r.reviewedBy ? ` by ${r.reviewedBy.displayName}` : ' (created)'}.
        </p>
        <div className="review-box">
          <strong>Still correct?</strong>
          <p className="muted small">Marking it reviewed records you and today's date{r.reviewBy ? ', and moves the review date forward by the template interval' : ''}. No edit needed.</p>
          <button className="primary" disabled={busy} onClick={() => void run(() => api.post(`/pages/${page.id}/review`))}>Mark as reviewed</button>
        </div>
        <form className="review-box" onSubmit={(e) => { e.preventDefault(); void run(() => api.put(`/pages/${page.id}/review`, { reviewBy: date || null })); }}>
          <label>Review-by date<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
          <div className="form-actions">
            {r.reviewBy && <button type="button" disabled={busy} onClick={() => void run(() => api.put(`/pages/${page.id}/review`, { reviewBy: null }))}>Remove review date</button>}
            <button type="submit" disabled={busy || !date || date === r.reviewBy}>Set date</button>
          </div>
        </form>
        {error != null && <ErrorBox error={error} />}
      </div>
    </Modal>
  );
}
