import { useState } from 'react';
import { send } from '../conn';
import { Modal } from '../controls/Modal';
import { fmtDeleteDate } from '../format';
import { openDialog, useStore } from '../store';

const close = () => openDialog(null);

/** Every expiring session, dismissed ones too; a row leaves when the daemon's next retention list drops it. */
export function RetentionDialog() {
  const sessions = useStore((s) => s.retention) ?? [];
  const now = Date.now();
  // Delete now asks for a second click on the same row.
  const [confirming, setConfirming] = useState<string | null>(null);
  return (
    <Modal title="Closed sessions due for deletion" onClose={close} restoreFocus>
      <p>Deleting a session loses its history, follow-up and restore in Tiller. Claude’s own transcript files are not deleted.</p>
      {sessions.length ? <ul className="retention-list">
        {sessions.map((s) => {
          const name = s.title ?? s.rootId;
          return <li key={s.rootId}>
            <div><strong>{name}</strong>{s.title && <> <code>{s.rootId}</code></>}</div>
            {s.cwd && <div className="mono">{s.cwd}</div>}
            <div className="retention-dates">{s.closedAt ? `Closed ${fmtDeleteDate(s.closedAt)} · ` : ''}{s.deleteAt <= now ? 'Deleted at the next cleanup' : `Deleted on ${fmtDeleteDate(s.deleteAt)}`}</div>
            <div className="btns">
              <button className="btn" aria-label={`Keep ${name}`} onClick={() => send({ t: 'sessionKeep', rootId: s.rootId })}>Keep</button>
              {s.restorable && <button className="btn" aria-label={`Restore ${name}`} onClick={() => send({ t: 'restore', id: s.rootId })}>Restore</button>}
              {confirming === s.rootId
                ? <button className="btn danger solid" aria-label={`Confirm delete ${name}`} onClick={() => { send({ t: 'sessionDelete', rootId: s.rootId }); setConfirming(null); }}>Confirm delete</button>
                : <button className="btn danger" aria-label={`Delete now: ${name}`} onClick={() => setConfirming(s.rootId)}>Delete now</button>}
            </div>
          </li>;
        })}
      </ul> : <p>No closed sessions are due for deletion.</p>}
      <div className="btns"><button className="btn" autoFocus onClick={close}>Close</button></div>
    </Modal>
  );
}
