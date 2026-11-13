import { formatDay, type ReviewStatus } from '../lib/api';

const label: Record<ReviewStatus, string> = { none: '', ok: 'Review by', due: 'Review due', overdue: 'Needs review' };

/** Small badge for a page's review state. Shows nothing for pages without a review date. */
export function ReviewBadge({ status, reviewBy }: { status: ReviewStatus; reviewBy: string | null }) {
  if (status === 'none' || !reviewBy) return null;
  return (
    <span className={`badge review-${status}`} title={`Review by ${formatDay(reviewBy)}`}>
      {status === 'overdue' ? label.overdue : `${label[status]} ${formatDay(reviewBy)}`}
    </span>
  );
}
