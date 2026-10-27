import { PROFILE_LABELS, profileFor, isAgentKind, type GitState, type NodeView, type Outcome } from '../../src/shared/protocol';
import { branchLabel, ctxLevel, fmtTokens, shortEffort, shortModel } from '../../src/shared/format';
import { fmtUsd, INCOMPLETE_NOTE, type Spend } from '../../src/shared/spend';
import { KIND_LABEL, type StatusKind } from '../sidebar/tree';

export const StateDot = ({ kind }: { kind: StatusKind }) => <span className={`dot ${kind}`} title={KIND_LABEL[kind]} />;

export function CtxBar({ pct }: { pct: number }) {
  return (
    <span className={`ctx ${ctxLevel(pct)}`} title={`context ${Math.round(pct)}% used`}>
      <span className="bar"><i style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} /></span>
      <span className="pct">{Math.round(pct)}%</span>
    </span>
  );
}

/** `+42 −18`: lines added and removed. */
export const Counts = ({ of: x, title }: { of: { additions: number; deletions: number }; title?: string }) => (
  <span className="counts" title={title}><span className="add">+{x.additions}</span> <span className="del">−{x.deletions}</span></span>
);

/** A worktree node's Counts, committed or not. */
export const DiffCounts = ({ git: g }: { git: GitState }) =>
  <Counts of={g} title={`${g.additions} line(s) added and ${g.deletions} removed since the branch left ${g.base}, committed or not`} />;

/** `⎇ tl/n-3f2a · +42 −18 · ↑2 · ●1 · opus 5.5 · high · [bar] 42% · $0.42 · Σ$3.10`; null when the node reports none of it. `subtree`: spend with descendants. */
export function NodeMeta({ node, detail, subtree }: { node: NodeView; detail?: boolean; subtree?: Spend }) {
  const s = node.status, wt = node.worktree, g = s.git;
  const model = shortModel(s.model ?? node.model), effort = s.effort ?? node.effort;
  const parts = [
    wt && <span className="branch" title={wt.branch ? `branch ${wt.branch} from ${wt.base}` : `read-only worktree, ${branchLabel(wt)}`}>⎇ {branchLabel(wt)}</span>,
    g && g.additions + g.deletions > 0 && <DiffCounts git={g} />,
    g && g.ahead > 0 && <span title={`${g.ahead} commit(s) not in ${g.base}${g.behind ? `; ${g.base} has ${g.behind} not on the branch` : ''}`}>↑{g.ahead}</span>,
    g && g.dirty > 0 && <span title={`${g.dirty} uncommitted file(s) in the worktree`}>●{g.dirty}</span>,
    g?.mergedAt && <span title={`merged into ${g.base}`}>merged</span>,
    wt?.missing && <span className="warn" title="the worktree directory is gone; resume is refused">missing</span>,
    isAgentKind(node.kind) && <span title="task profile">{PROFILE_LABELS[profileFor(node.profile, node.parentId, node.role)]}</span>,
    model && <span>{model}</span>,
    effort && <span>{shortEffort(effort)}</span>,
    s.contextPct !== undefined && <CtxBar pct={s.contextPct} />,
    detail && s.contextTokens && s.contextWindow ? <span>{fmtTokens(s.contextTokens)}/{fmtTokens(s.contextWindow)}</span> : null,
    node.spentUsd !== undefined && <span title={`spent, all sessions${node.spentIncomplete ? `; ${INCOMPLETE_NOTE}` : ''}`}>{fmtUsd(node.spentUsd, node.spentIncomplete)}</span>,
    subtree && (subtree.usd > (node.spentUsd ?? 0) || (subtree.incomplete && !node.spentIncomplete)) &&
      <span title={`spent with descendants${subtree.incomplete ? `; ${INCOMPLETE_NOTE}` : ''}`}>Σ{fmtUsd(subtree.usd, subtree.incomplete)}</span>,
  ].filter(Boolean);
  if (!parts.length) return null;
  return <div className="meta">{parts.map((p, i) => <span className="part" key={i}>{p}</span>)}</div>;
}

/** A reported outcome in the sidebar's words. */
export const outcomeLabel = (o: Pick<Outcome, 'outcome'>) => (o.outcome === 'failed' ? 'Needs changes' : 'succeeded');

/** What a node reported through report_outcome: the verdict, then whichever structured fields it filled. */
export function OutcomeDetails({ o }: { o: Outcome }) {
  const list = (title: string, items?: string[]) => items?.length ? <><h3>{title}</h3><ul>{items.map((x, i) => <li key={i}>{x}</li>)}</ul></> : null;
  return (
    <div className="outcome">
      <div className={`verdict ${o.outcome}`}>{o.outcome === 'succeeded' ? 'Succeeded' : 'Failed'}{o.gate && ` · gate ${o.gate}`}</div>
      {o.summary && <p>{o.summary}</p>}
      {o.note && <p>{o.note}</p>}
      {o.verified && <><h3>Verified</h3><p>{o.verified}</p></>}
      {list('Changed files', o.changedFiles)}
      {list('Open questions', o.openQuestions)}
    </div>
  );
}

/** The completion gate's state as a small row marker. */
export const GateMark = ({ gate }: { gate: NonNullable<NodeView['gate']> }) =>
  <span className={`count${gate === 'failed' ? ' bad' : ''}`} title={`completion gate ${gate}`}>gate {gate}</span>;
