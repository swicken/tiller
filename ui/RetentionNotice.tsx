import type { ExpiringSession } from '../src/shared/protocol';
import { send } from './conn';
import { fmtDeleteDate } from './format';
import { useNow } from './hooks';
import { openDialog, useStore } from './store';

const DAY = 86_400_000;
const startOfDay = (t: number) => new Date(t).setHours(0, 0, 0, 0);

/** The banner for the undismissed sessions, timed by the soonest one; null when every session is dismissed. */
export function retentionNotice(sessions: ExpiringSession[], now: number) {
  const shown = sessions.filter((s) => !s.dismissed);
  const first = shown[0];
  if (!first) return null;
  const days = Math.round((startOfDay(first.deleteAt) - startOfDay(now)) / DAY);
  const when = days <= 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
  return {
    text: shown.length === 1 ? `1 closed session will be deleted ${when}` : `${shown.length} closed sessions will be deleted, starting ${when}`,
    title: `${shown.length === 1 ? 'Deleted' : 'First deleted'} on ${fmtDeleteDate(first.deleteAt)}`,
    urgent: first.stage === 1,
    ids: shown.map((s) => s.rootId),
  };
}

export function RetentionNotice() {
  const sessions = useStore((s) => s.retention);
  const now = useNow();
  const notice = sessions && retentionNotice(sessions, now);
  if (!notice) return null;
  return (
    <span className={`retention-notice${notice.urgent ? ' urgent' : ''}`} role={notice.urgent ? 'alert' : 'status'}>
      <span title={notice.title}>{notice.text}</span>
      <button onClick={() => openDialog({ kind: 'retention' })} aria-haspopup="dialog" aria-label="Review sessions due for deletion">Review</button>
      <button onClick={() => send({ t: 'retentionDismiss', rootIds: notice.ids })} aria-label="Dismiss session deletion warning">Dismiss</button>
    </span>
  );
}
