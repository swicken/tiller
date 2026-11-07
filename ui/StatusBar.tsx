import { useRef, useState } from 'react';
import { harnessFor, isAgentKind, needsYou } from '../src/shared/protocol';
import { fmtAge } from '../src/shared/format';
import { fmtUsd, INCOMPLETE_NOTE, todaySpend } from '../src/shared/spend';
import { useNow } from './hooks';
import { openDialog, useStore } from './store';
import { selectedUsage, usageScope, usageStale, usageToolName } from '../src/shared/usage';
import { refreshUsage, send } from './conn';
import { UsagePanel, UsageWindows } from './UsagePanel';

export function StatusBar() {
  const connected = useStore((s) => s.connected);
  const retry = useStore((s) => s.retry);
  const total = useStore((s) => Object.keys(s.nodes).length);
  const needs = useStore((s) => Object.values(s.nodes).filter((n) => needsYou(n.status)).length);
  const queued = useStore((s) => Object.values(s.nodes).filter((n) => n.status.state === 'queued').length);
  const [usageOpen, setUsageOpen] = useState(false);
  const usageButton = useRef<HTMLButtonElement>(null);
  const closeUsage = () => { setUsageOpen(false); requestAnimationFrame(() => usageButton.current?.focus()); };
  const selected = useStore((s) => s.archived ? undefined : s.selected ? s.nodes[s.selected] : undefined);
  const sources = useStore((s) => s.usageSources);
  const legacy = useStore((s) => s.usage);
  const reports = selectedUsage(selected, sources, legacy);
  const unavailable = selected && sources?.some((s) => s.tool === harnessFor(selected) && s.nodeIds.includes(selected.id) && s.availability === 'unavailable');
  const now = useNow();
  const nodes = useStore((s) => s.nodes);
  const today = todaySpend(Object.values(nodes), now);
  const update = useStore((s) => s.update);
  const notes = update?.installedNotes;
  const drain = useStore((s) => s.drain);
  const waiting = drain?.waiting.length ?? 0;
  const runtimeBehindCheckout = !!update?.runtimeSha && update.runtimeSha !== update.sha;
  const available = update?.target && ((update.sha !== update.target.sha && update.releases.length > 0) || (runtimeBehindCheckout && update.sha === update.target.sha && update.currentVersion === update.target.tag)) && !update.fetchError && !update.applying;
  return (
    <>
    <footer className="statusbar" role="status">
      <span className={`conn ${connected ? 'up' : 'down'}`}>
        <i className="dot" />
        {connected ? `daemon connected · ${location.host}` : `reconnecting to ${location.host}${retry > 1 ? ` (attempt ${retry})` : ''}…`}
      </span>
      <span>{total} nodes{needs > 0 && <b className="warn"> · {needs} need you</b>}{queued > 0 && ` · ${queued} queued`}</span>
      <button ref={usageButton} className="usage-button" aria-haspopup="dialog" aria-expanded={usageOpen} onClick={() => { refreshUsage(); setUsageOpen(true); }}>Usage</button>
      <div className="selected-usage" aria-label="Selected agent usage" tabIndex={0}>
        {selected && isAgentKind(selected.kind) ? <>
          <span>{usageToolName(harnessFor(selected))} · {selected.status.model || 'model unknown'}</span>
          {reports.length ? reports.map((source) => <span className="usage-bar-report" key={source.id} title={`Reported ${fmtAge(now - source.at!)} ago${source.accountId ? '' : ' · account identity unknown'}`}>
            <span>{source.pool && `${source.pool} · `}{usageScope(source)}</span>
            <UsageWindows source={source} now={now} />
            {(usageStale(source, now) || selected.status.exited || !connected) && <span>stale · {fmtAge(now - source.at!)} ago</span>}
          </span>) : <span>{unavailable || harnessFor(selected) === 'pi' ? 'account quota unavailable' : 'no quota report for this agent'}</span>}
        </> : <span>{selected ? 'Terminal · no model quota' : 'Select an agent to see its quota'}</span>}
      </div>
      {(today.usd > 0 || today.incomplete) && <span title={`spent today, all nodes${today.incomplete ? `; ${INCOMPLETE_NOTE}` : ''}`}>{fmtUsd(today.usd, today.incomplete)} today</span>}
      <span className="spacer" />
      {drain && <span className="drain-notice" title={drain.waiting.map((w) => w.title).join(', ')}>
        {drain.force || !waiting ? 'Restarting Tiller…' : `Waiting for ${waiting} agent${waiting === 1 ? '' : 's'} to finish their turn`}
        {!drain.force && waiting > 0 && <button className="restart-now" onClick={() => send({ t: 'restartNow' })}>Restart now</button>}
      </span>}
      {available && <button className="update-available" onClick={() => openDialog({ kind: 'update' })} aria-haspopup="dialog">{runtimeBehindCheckout && update!.sha === update!.target!.sha ? 'Restart to finish update' : 'Update available'}</button>}
      {!!notes?.releases.length && <button className="whats-new" onClick={() => openDialog({ kind: 'whatsNew', notes })} aria-haspopup="dialog">What’s new</button>}
    </footer>
    {usageOpen && <UsagePanel onClose={closeUsage} />}
    </>
  );
}
