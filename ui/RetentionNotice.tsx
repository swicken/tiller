import type { ExpiringSession } from '../src/shared/protocol';
import { send } from './conn';
import { fmtDeleteDate } from './format';
import { useNow } from './hooks';
import { openDialog, useStore } from './store';

const DAY = 86_400_000;
const startOfDay = (t: number) => new Date(t).setHours(0, 0, 0, 0);

/** The banner for the undismissed sessions, timed by the soonest one; null when every session is dismissed.
 *  A deleteAt already past waits for the daemon's daily sweep, so it is "at the next cleanup", not a past date. */
export function retentionNotice(sessions: ExpiringSession[], now: number) {
  const shown = sessions.filter((s) => !s.dismissed);
  const first = shown[0];
  if (!first) return null;
  const overdue = first.deleteAt <= now;
  const days = Math.round((startOfDay(first.deleteAt) - startOfDay(now)) / DAY);
  const when = overdue ? 'at the next cleanup' : days <= 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
  return {
    text: shown.length === 1 ? `1 closed session will be deleted ${when}` : `${shown.length} closed sessions will be deleted, starting ${when}`,
    title: overdue ? 'Deleted when the daemon next cleans up closed sessions' : `${shown.length === 1 ? 'Deleted' : 'First deleted'} on ${fmtDeleteDate(first.deleteAt)}`,
    urgent: first.stage === 1,
    ids: shown.map((s) => s.rootId),
  };
}

/** A top-of-pane notice. The status region stays mounted so its updates are announced; the last-day
 *  warning is a separate alert element that mounts when that stage begins, so no role changes in place. */
export function RetentionNotice() {
  const sessions = useStore((s) => s.retention);
  const now = useNow();
  const notice = sessions && retentionNotice(sessions, now);
  const body = notice && <>
    <span title={notice.title}>{notice.text}</span>
    <span className="spacer" />
    <button onClick={() => openDialog({ kind: 'retention' })} aria-haspopup="dialog" aria-label="Review sessions due for deletion">Review</button>
    <button onClick={() => send({ t: 'retentionDismiss', rootIds: notice.ids })} aria-label="Dismiss session deletion warning">Dismiss</button>
  </>;
  return <>
    <div role="status" className={notice && !notice.urgent ? 'retention-notice' : undefined}>{notice && !notice.urgent && body}</div>
    {notice?.urgent && <div role="alert" className="retention-notice urgent">{body}</div>}
  </>;
}
