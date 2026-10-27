import { fmtAge, limitResetPassed, limitStale, usageParts } from '../src/shared/format';
import type { RateLimit, UsageSource } from '../src/shared/protocol';
import { groupUsageObservations, usageStale, usageToolName } from '../src/shared/usage';
import { useNow } from './hooks';
import { refreshUsage } from './conn';
import { Modal } from './controls/Modal';
import { useStore } from './store';
import openaiLogo from './assets/usage/openai.svg';
import claudeLogo from './assets/usage/claude.png';
import './usage.css';

export function UsageWindows({ source, now }: { source: UsageSource; now: number }) {
  return <>{usageParts(source.rateLimits, false, now).map((part, i) => (
    <span key={i} className={`ctx ${part.level}`}><span className="pct">{part.text}{(!source.rateLimits[i].resetsAt || !Number.isFinite(Date.parse(source.rateLimits[i].resetsAt!))) && ' · reset unknown'}</span></span>
  ))}</>;
}

const windowNames: Record<string, string> = {
  five_hour: '5-hour limit', '5h': '5-hour limit', seven_day: 'Weekly limit', '7d': 'Weekly limit',
  seven_day_opus: 'Weekly Opus limit', seven_day_sonnet: 'Weekly Sonnet limit',
};

function QuotaWindow({ limit, title, now }: { limit: RateLimit; title?: string; now: number }) {
  const name = windowNames[limit.kind] ?? limit.kind;
  const reset = limit.resetsAt ? Date.parse(limit.resetsAt) : NaN;
  const expired = limitResetPassed(limit, now);
  const valid = Number.isFinite(limit.percentUsed) && limit.percentUsed >= 0;
  const percent = Math.round(limit.percentUsed);
  const resetText = !Number.isFinite(reset) ? 'Reset time unavailable'
    : expired ? 'Reset passed · awaiting update'
    : `Resets ${new Date(reset).toLocaleString([], { ...(reset - now >= 86_400_000 ? { weekday: 'short' as const, month: 'short' as const, day: 'numeric' as const } : {}), hour: 'numeric', minute: '2-digit' })}`;
  return <div className="usage-quota">
    <div className="usage-quota-heading"><span>{title ?? name}</span><span className="usage-percent">{valid && !expired ? `${percent}% used` : 'Awaiting update'}</span></div>
    {valid && !expired && <progress className={percent > 95 ? 'usage-critical' : percent > 80 ? 'usage-warning' : ''} aria-label={`${title ?? name}: ${name}`} max={100} value={Math.min(100, limit.percentUsed)} aria-valuetext={`${percent}% used`} />}
    <p className="usage-caption">{title && <>{name} · </>}{resetText}{limitStale(limit, now) && ' · Stale reading'}</p>
  </div>;
}

export function UsagePanel({ onClose }: { onClose: () => void }) {
  const sources = useStore((s) => s.usageSources);
  const scanning = useStore((s) => s.usageScanning);
  const connected = useStore((s) => s.connected);
  const nodes = useStore((s) => s.nodes);
  const now = useNow();
  const tools = (['codex', 'claude', 'pi'] as const).filter((tool) => {
    const discovery = sources?.find((source) => source.id === `discovery:${tool}`);
    return discovery ? discovery.installed === true : sources?.some((source) => source.tool === tool && source.installed === true);
  });
  return <Modal title="Usage" className="modal usage-panel" onClose={onClose}>
    <p className="usage-subtitle">Account limits for installed CLIs</p>
    {!connected && <p className="usage-notice" role="status">Disconnected. Retained usage may be out of date.</p>}
    {!sources && <p className="usage-notice" role="status">{connected ? 'Waiting for CLI usage…' : 'Connect to load CLI usage.'}</p>}
    {sources && tools.length === 0 && <p className="usage-notice" role="status">{scanning ? 'Checking installed CLIs…' : 'No supported CLIs detected.'}</p>}
    {tools.map((tool) => {
      const name = usageToolName(tool);
      const discovery = sources?.find((source) => source.id === `discovery:${tool}`);
      const reports = sources?.filter((source) => source.tool === tool && source.at !== undefined && source.rateLimits.length > 0) ?? [];
      const groups = groupUsageObservations(reports);
      const numbered = groups.filter((group) => !group.unidentified && !group.reports[0].account);
      const renderReport = (source: UsageSource, title?: string, showAge = false) => {
        const unavailable = source.availability === 'unavailable';
        const stale = usageStale(source, now) || source.nodeIds.every((id) => !nodes[id] || nodes[id].status.exited);
        return <div className="usage-quota-report" key={source.id}>
          {source.rateLimits.map((limit, i) => <QuotaWindow key={limit.windowId ?? `${limit.kind}:${i}`} limit={limit} title={i === 0 ? title : undefined} now={now} />)}
          {(showAge || stale || unavailable) && <p className="usage-caption">{unavailable ? 'Usage unavailable · ' : ''}Last report: {fmtAge(now - source.at!)}{now - source.at! >= 1000 ? ' ago' : ''}{(stale || unavailable) && ' · may be out of date'}</p>}
          {source.scope === 'model' && source.model && <p className="usage-caption">{source.model} model limit</p>}
        </div>;
      };
      const unavailable = sources?.some((source) => source.tool === tool && source.id !== `discovery:${tool}` && source.availability === 'unavailable');
      return <section className="usage-cli" key={tool} aria-label={name}>
        <div className="usage-brand" aria-hidden="true">{tool !== 'pi' && <img className={tool === 'codex' ? 'usage-openai-logo' : undefined} src={tool === 'codex' ? openaiLogo : claudeLogo} alt="" width="24" height="24" />}</div>
        <div className="usage-cli-content">
          <h3 className={groups.length === 1 ? 'usage-sr-only' : ''}>{name}</h3>
          {groups.map((group) => {
            const [latest, ...others] = group.reports;
            return <div className="usage-observation-group" key={group.id}>
              {group.unidentified ? <>
                <p className="usage-report-label">Latest session reading</p>
                <p className="usage-caption">Account identity is not reported.</p>
              </> : latest.account ? <p className="usage-report-label">Account: {latest.account}</p>
                : groups.length > 1 && <p className="usage-report-label">Separate quota {numbered.indexOf(group) + 1}</p>}
              {renderReport(latest, groups.length === 1 ? name : undefined, group.unidentified)}
              {others.length > 0 && <details className="usage-observations">
                <summary>{others.length === 1 ? '1 other session reading' : `${others.length} other session readings`}</summary>
                {others.map((source) => renderReport(source, undefined, true))}
              </details>}
            </div>;
          })}
          {!reports.length && <p className="usage-caption" role="status">{discovery?.executableStatus === 'broken' ? `Unable to run ${name}. Check the CLI installation.` : tool === 'pi' ? 'Pi does not report account limits.' : unavailable ? 'Usage unavailable. Try refreshing later.' : scanning ? 'Checking usage…' : `Open ${name} to load usage.`}</p>}
        </div>
      </section>;
    })}
    <div className="usage-actions"><button className="btn" disabled={!connected || scanning} onClick={refreshUsage}>{scanning ? 'Refreshing…' : 'Refresh'}</button><button className="btn" autoFocus onClick={onClose}>Close</button></div>
  </Modal>;
}
