import { useEffect, useState } from 'react';
import { fmtAge } from '../../src/shared/format';
import type { ClaudeMemoryView, MemoryAction, MemoryInjectionView, MemoryItemDetail, MemoryItemKind, MemoryItemView, MemoryPage, MemoryTarget } from '../../src/shared/protocol';
import { send } from '../conn';
import { Icon } from '../controls/icons';
import { Markdown } from '../controls/Markdown';
import { Select } from '../controls/Select';
import { useNow } from '../hooks';
import { getState, lastMemoryRid, memoryActionRequested, memoryRequested, selectNode, useStore } from '../store';
import { badges, CHIPS, checkoutLine, chipCount, itemActions, KIND_LABEL, pinNeedsConfirm, provenance, purgeCommand, purgeNote, sectionsFor, splitFrontmatter, stateLine, type SectionKey } from './memory-model';
import './memory.css';

// The daemon's limits (LIMITS.tools and the dir schema): longer input would be refused as malformed, with no reply.
const PIN_TEXT_MAX = 500;
const REASON_MAX = 300;
const QUERY_MAX = 500;
const DIR_MAX = 4096;
const ago = (now: number, at: number) => <span title={new Date(at).toLocaleString()}>{fmtAge(now - at)} ago</span>;

/** One row of the list. Item text is untrusted: it renders as plain text. */
export function ItemRow({ item, now, selected, onSelect }: { item: MemoryItemView; now: number; selected: boolean; onSelect: () => void }) {
  return (
    <button className={`memory-row${selected ? ' sel' : ''}${item.invalid ? ' hidden' : ''}`} aria-current={selected} onClick={onSelect}>
      <span className="l1">
        <span className="kind">{KIND_LABEL[item.kind] ?? item.kind}</span>
        <span className="id">m{item.id}</span>
        {badges(item).map((b) => <span key={b} className="tag">{b}</span>)}
      </span>
      <span className="text">{item.tombstone ? `(${item.tombstone})` : item.text}</span>
      <span className="prov">{provenance(item)} · {ago(now, item.updatedAt)} · seen×{item.seen}</span>
    </button>
  );
}

type Mode = { kind: 'forget'; reason: string } | { kind: 'edit'; text: string } | { kind: 'confirmPin' } | null;

/** An item in full with the human's actions. blocked: why actions are refused (memory not on for this checkout). */
export function ItemDetail({ detail, page, now, blocked, act, onClose }: {
  detail: MemoryItemDetail; page: MemoryPage; now: number; blocked?: string; act: (a: MemoryAction) => void; onClose: () => void;
}) {
  const { item, supersededBy, givenTo } = detail;
  const [mode, setMode] = useState<Mode>(null);
  const live = (id: string) => !!getState().nodes[id];
  const purge = !item.tombstone && purgeCommand(page.cli, item.id);
  const note = !item.tombstone && purgeNote(page);
  const done = (a: MemoryAction) => { setMode(null); act(a); };
  const label = { pin: 'Pin', unpin: 'Unpin', edit: 'Edit…', forget: 'Forget…', restore: item.pinned ? 'Restore (stays pinned)' : 'Restore' };
  const run = {
    pin: () => pinNeedsConfirm(item) ? setMode({ kind: 'confirmPin' }) : done({ kind: 'pin', itemId: item.id }),
    unpin: () => done({ kind: 'unpin', itemId: item.id }),
    edit: () => setMode({ kind: 'edit', text: item.text }),
    forget: () => setMode({ kind: 'forget', reason: 'wrong or stale' }),
    restore: () => done({ kind: 'restore', itemId: item.id }),
  };
  return (
    <aside className="memory-detail" aria-label={`Item m${item.id}`}>
      <div className="tb1">
        <h2>{KIND_LABEL[item.kind] ?? item.kind} m{item.id}</h2>
        <span className="spacer" />
        <button className="btn icon" title="Close" aria-label="Close item" onClick={onClose}><Icon name="x" size={14} /></button>
      </div>
      <div className="badges">{badges(item, supersededBy).map((b) => <span key={b} className="tag">{b}</span>)}</div>
      <p className="text">{item.tombstone ? `(${item.tombstone}: its text is gone)` : item.text}</p>
      {item.body && <div className="body">{item.body}</div>}
      <dl>
        <dt>From</dt>
        <dd>{item.nodeId && live(item.nodeId) ? <button className="link" onClick={() => selectNode(item.nodeId!)}>{provenance(item)}</button> : provenance(item)}</dd>
        <dt>Updated</dt><dd>{ago(now, item.updatedAt)} · created {ago(now, item.createdAt)} · seen×{item.seen}{item.gets !== undefined && ` · read×${item.gets}`}</dd>
        {item.supersedes !== undefined && <><dt>Supersedes</dt><dd>m{item.supersedes}</dd></>}
        {item.invalid?.reason && <><dt>Reason</dt><dd>{item.invalid.reason}</dd></>}
        <dt>Given to</dt>
        <dd>{givenTo.length ? <ul>{givenTo.map((g) => <li key={`${g.nodeId}-${g.sessionId}-${g.ts}`}>{g.nodeId} · {g.arm === 'on' ? 'given' : 'recorded, not given (A/B off arm)'} · {ago(now, g.ts)}</li>)}</ul> : 'no node yet'}</dd>
      </dl>
      {blocked && <p className="memory-blocked">{blocked}</p>}
      {mode?.kind === 'confirmPin' ? (
        <div className="memory-confirm" role="alert">
          <p>Pinning makes this {item.author === 'daemon' ? "daemon's" : "agent's"} text an instruction every node in this repository follows.</p>
          <button className="btn primary" disabled={!!blocked} onClick={() => done({ kind: 'pin', itemId: item.id })}>Pin</button>
          <button className="btn" onClick={() => setMode(null)}>Cancel</button>
        </div>
      ) : mode?.kind === 'forget' ? (
        <form className="memory-confirm" onSubmit={(e) => { e.preventDefault(); if (mode.reason.trim()) done({ kind: 'forget', itemId: item.id, reason: mode.reason.trim() }); }}>
          <label>Reason (permanent: later work does not bring it back)
            <input value={mode.reason} maxLength={REASON_MAX} required onChange={(e) => setMode({ kind: 'forget', reason: e.target.value })} />
          </label>
          <button className="btn danger" type="submit" disabled={!!blocked || !mode.reason.trim()}>Forget</button>
          <button className="btn" type="button" onClick={() => setMode(null)}>Cancel</button>
        </form>
      ) : mode?.kind === 'edit' ? (
        <form className="memory-confirm" onSubmit={(e) => { e.preventDefault(); if (mode.text.trim()) done({ kind: 'editPin', itemId: item.id, text: mode.text.trim() }); }}>
          <label>Pinned instruction
            <textarea value={mode.text} maxLength={PIN_TEXT_MAX} required onChange={(e) => setMode({ kind: 'edit', text: e.target.value })} />
          </label>
          <button className="btn primary" type="submit" disabled={!!blocked || !mode.text.trim()}>Save</button>
          <button className="btn" type="button" onClick={() => setMode(null)}>Cancel</button>
        </form>
      ) : (
        <div className="memory-actions">
          {itemActions(item).map((a) => <button key={a} className={`btn${a === 'forget' ? ' danger' : ''}`} disabled={!!blocked} onClick={run[a]}>{label[a]}</button>)}
        </div>
      )}
      {purge && <div className="memory-purge"><span>Purge for good, from a terminal:</span><code>{purge}</code></div>}
      {note && <p className="hint">{note}</p>}
    </aside>
  );
}

/** A node's digest decisions, newest first. Digest text is untrusted: it renders in a pre. */
export function GivenList({ injections, now, onItem }: { injections: MemoryInjectionView[]; now: number; onItem: (id: number) => void }) {
  if (!injections.length) return <p className="hint">No digest was recorded for this node: memory was off, or it launched before memory was on.</p>;
  return (
    <ol className="memory-given">
      {injections.map((g) => (
        <li key={`${g.sessionId}-${g.ts}`}>
          <div className="l1">
            {ago(now, g.ts)}<span className="tag">{g.cause}</span>
            <span>{g.arm === 'on' ? 'given' : 'recorded, not given (A/B off arm)'}</span>
          </div>
          {g.cause === 'resume' ? <p className="hint">Reused this session's first digest.</p> : <pre>{g.text}</pre>}
          {g.itemIds.length > 0 && <div className="ids">{g.itemIds.map((id) => <button key={id} className="btn" onClick={() => onItem(id)}>m{id}</button>)}</div>}
        </li>
      ))}
    </ol>
  );
}

/** Claude Code's own memory files, read-only. Their content is untrusted: Markdown renders without HTML, images or unsafe links. */
export function ClaudeView({ view, checkout }: { view: ClaudeMemoryView; checkout?: string }) {
  return (
    <div className="memory-claude">
      <p>Claude Code's own memory for {checkout ?? 'this checkout'}{view.account ? ` (account ${view.account})` : ''}. Read-only; Tiller does not copy it.</p>
      <p className="path">{view.dir}</p>
      {view.note && <p className="memory-blocked">{view.note}</p>}
      {!view.files.length && !view.note && <p className="hint">No Claude auto-memory at {view.dir}</p>}
      {view.files.map((f) => {
        const { frontmatter, body } = splitFrontmatter(f.text);
        return (
          <details key={f.name} open={f.name === 'MEMORY.md'}>
            <summary>{f.name} <span className="dim">{f.bytes} bytes{f.truncated ? ', truncated' : ''}</span></summary>
            {frontmatter !== undefined && <pre>{frontmatter}</pre>}
            <Markdown>{body}</Markdown>
            {f.truncated && <p className="hint">Only the start of this file is shown.</p>}
          </details>
        );
      })}
      {view.omitted.length > 0 && <p className="hint">Not shown (over the limits): {view.omitted.join(', ')}</p>}
    </div>
  );
}

/**
 * What memory holds for a target: a node (live or closed), or an account file and repository chosen here. Asks on open, on
 * a filter change (search debounced), after the human's own action, when a node closes (that adds a ledger item), on
 * reconnect and on Refresh. Reads work whatever the opt-in; actions need memory on for the checkout.
 */
export function MemoryPane({ target: initial, onClose }: { target: MemoryTarget; onClose?: () => void }) {
  const connected = useStore((s) => s.connected);
  const removals = useStore((s) => s.removals);
  const rev = useStore((s) => s.memoryRev);
  // Reply slots are shared, so a slot answered before this pane opened belongs to another target.
  const [since] = useState(lastMemoryRid);
  const mine = <T extends { rid: number }>(r: T | null) => (r && r.rid > since ? r : undefined);
  const reply = mine(useStore((s) => s.memory));
  const detail = mine(useStore((s) => s.memoryItem));
  const given = mine(useStore((s) => s.memoryGiven));
  const claude = mine(useStore((s) => s.claudeMemory));
  const acted = useStore((s) => s.memoryActed);
  const now = useNow();
  const [target, setTarget] = useState(initial);
  const [section, setSection] = useState<SectionKey>('items');
  const [kind, setKind] = useState<MemoryItemKind | 'pinned'>();
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [retracted, setRetracted] = useState(false);
  const [itemId, setItemId] = useState<number>();
  const [pinText, setPinText] = useState('');
  const [pinRid, setPinRid] = useState<number>();
  const [dir, setDir] = useState('');
  const [refresh, setRefresh] = useState(0);
  const page = reply?.data;

  useEffect(() => {
    const timer = setTimeout(() => setQuery(q.trim()), 250);
    return () => clearTimeout(timer);
  }, [q]);
  useEffect(() => {
    if (connected) send({ t: 'memory', rid: memoryRequested('memory', since), target, ...(kind && { kind }), ...(query && { query }), ...(retracted && { retracted }) });
  }, [connected, removals, rev, refresh, target, kind, query, retracted]);
  useEffect(() => {
    if (connected && itemId !== undefined) send({ t: 'memoryItem', rid: memoryRequested('memoryItem', since), target, itemId });
  }, [connected, rev, refresh, target, itemId]);
  useEffect(() => {
    if (connected && section === 'given' && target.nodeId) send({ t: 'memoryGiven', rid: memoryRequested('memoryGiven', since), nodeId: target.nodeId });
  }, [connected, removals, refresh, section, target.nodeId]);
  useEffect(() => {
    if (connected && section === 'claude') send({ t: 'claudeMemory', rid: memoryRequested('claudeMemory', since), target });
  }, [connected, refresh, section, target]);

  // The typed pin stays until the daemon accepts it, so a refusal does not lose it.
  useEffect(() => {
    if (acted?.ok && acted.rid === pinRid) setPinText('');
  }, [acted, pinRid]);

  const retarget = (t: MemoryTarget) => { setTarget(t); setItemId(undefined); };
  const act = (action: MemoryAction) => {
    const rid = memoryActionRequested(action.kind);
    send({ t: 'memoryAction', rid, target: page?.target ?? target, action });
    return rid;
  };
  // A digest's item ids are in the node's own file and repository: show those, not another the pickers chose.
  const openGiven = (id: number) => {
    if (Object.keys(target).some((k) => k !== 'nodeId')) setTarget({ nodeId: target.nodeId });
    setItemId(id);
  };
  const more = () => page?.next && send({ t: 'memory', rid: memoryRequested('memory', since, true), target, ...(kind && { kind }), ...(retracted && { retracted }), before: page.next });
  const blocked = page && page.on !== true ? `Changes need memory on for this checkout: ${page.source}.` : undefined;
  // One entry per file: a configured account without its own Claude home shares the _default file, and is named on it.
  const files = page ? [...page.files, ...(page.files.some((f) => f.file === page.file) ? [] : [{ account: page.target.account, file: page.file, state: page.state }])] : [];
  const fileLabel = (f: MemoryPage['files'][number]) =>
    `${f.file === page?.file && page.target.account && page.target.account !== f.account ? `${page.target.account} (${f.file} file)` : f.account ?? 'no account'}${f.state !== 'ok' ? ` (${f.state})` : ''}`;
  const repos = page ? [...page.repos, ...(page.target.repo && !page.repos.some((r) => r.key === page.target.repo) ? [{ key: page.target.repo, path: '', items: 0 }] : [])] : [];
  const shown = detail?.data && detail.data.item.id === itemId ? detail.data : undefined;

  return (
    <div className="memory">
      <header className="archhead memory-head">
        <div className="tb1">
          <h1>Memory</h1>
          {page && <span className="tag" title={`account file ${page.file}`}>{page.file}</span>}
          <span className="spacer" />
          <button className="btn" onClick={() => setRefresh((n) => n + 1)}><Icon name="restart" size={14} />Refresh</button>
          {onClose && <button className="btn icon" title="Close" aria-label="Close memory" onClick={onClose}><Icon name="x" size={14} /></button>}
        </div>
        {page && (
          <div className="memory-pickers">
            <label>Account
              <Select aria-label="Account" value={page.file} onChange={(e) => retarget({ ...target, account: files.find((f) => f.file === e.target.value)?.account ?? null, repo: undefined })}>
                {files.map((f) => <option key={f.file} value={f.file}>{fileLabel(f)}</option>)}
              </Select>
            </label>
            <label>Repository
              <Select aria-label="Repository" value={page.target.repo ?? ''} disabled={!repos.length} onChange={(e) => retarget({ ...target, repo: e.target.value })}>
                {!repos.length && <option value="">none recorded</option>}
                {repos.map((r) => <option key={r.key} value={r.key}>{r.key} · {r.items} items{r.path ? ` · first recorded at ${r.path}` : ''}</option>)}
              </Select>
            </label>
            {/* Submitting it empty drops a chosen directory. */}
            <form onSubmit={(e) => { e.preventDefault(); if (dir.trim() || target.dir) retarget({ ...target, dir: dir.trim() || undefined, repo: undefined }); }}>
              <input aria-label="Use a directory" placeholder="Use a directory…" maxLength={DIR_MAX} value={dir} onChange={(e) => setDir(e.target.value)} />
              <button className="btn" type="submit" disabled={!dir.trim() && !target.dir}>{dir.trim() || !target.dir ? 'Use' : 'Clear'}</button>
            </form>
          </div>
        )}
        {page && <p className="memory-line">{checkoutLine(page)}</p>}
        {page && <p className={`memory-line state ${page.on === true ? 'on' : page.on === false ? 'off' : 'unknown'}`}>{stateLine(page)} Changes apply to nodes launched from now on; running nodes keep the digest they were given.</p>}
        {page && page.state !== 'ok' && <p className="memory-line bad">File {page.file}: {page.state}</p>}
        {page && page.quarantined.length > 0 && <p className="memory-line bad">Quarantined copies: {page.quarantined.join(', ')}</p>}
        {reply?.error && <p className="memory-line bad">{reply.error}</p>}
      </header>
      <div className="seg memory-sections" role="radiogroup" aria-label="Section">
        {sectionsFor(target).map((s) => <button key={s.key} role="radio" aria-checked={section === s.key} className={section === s.key ? 'on' : ''} onClick={() => setSection(s.key)}>{s.label}</button>)}
      </div>
      <div className="memory-body">
        <div className="memory-main">
          {section === 'items' && (
            <>
              <div className="memory-filters">
                <input type="search" aria-label="Search memory" placeholder="Search memory…" maxLength={QUERY_MAX} value={q} onChange={(e) => setQ(e.target.value)} />
                <div className="memory-chips" role="group" aria-label="Kind">
                  {CHIPS.map((c) => <button key={c.label} className={`memory-chip${kind === c.kind ? ' on' : ''}`} aria-pressed={kind === c.kind} onClick={() => setKind(c.kind)}>{c.label}{page && ` ${chipCount(page.counts, c.kind)}`}</button>)}
                </div>
                <label className="check"><input type="checkbox" checked={retracted} onChange={(e) => setRetracted(e.target.checked)} />Show retracted{page && ` (${page.counts.retracted})`}</label>
                <form className="memory-pin" onSubmit={(e) => { e.preventDefault(); if (pinText.trim()) setPinRid(act({ kind: 'pinText', text: pinText.trim() })); }}>
                  <input aria-label="Pin an instruction" placeholder="Pin an instruction…" maxLength={PIN_TEXT_MAX} value={pinText} disabled={!page || !!blocked} onChange={(e) => setPinText(e.target.value)} />
                  <button className="btn" type="submit" disabled={!page || !!blocked || !pinText.trim()}>Pin</button>
                </form>
                {blocked && <p className="memory-blocked">{blocked}</p>}
              </div>
              <div className="memory-list">
                {page?.items.map((item) => <ItemRow key={item.id} item={item} now={now} selected={item.id === itemId} onSelect={() => setItemId(item.id)} />)}
                {page && !page.items.length && <p className="hint">{query ? "Nothing matches. Common words like 'the' or 'src' are ignored." : 'No items here.'}</p>}
                {!page && !reply?.error && <p className="hint">Loading memory…</p>}
                {page?.next && !query && <button className="btn memory-more" onClick={more}>Load more</button>}
              </div>
            </>
          )}
          {section === 'given' && (given?.error ? <p className="hint">{given.error}</p>
            : given?.data ? <GivenList injections={given.data} now={now} onItem={openGiven} /> : <p className="hint">Loading…</p>)}
          {section === 'claude' && (claude?.error ? <p className="hint">{claude.error}</p>
            : claude?.data ? <ClaudeView view={claude.data} checkout={page?.checkout?.path} /> : <p className="hint">Loading…</p>)}
        </div>
        {itemId !== undefined && page && (shown ? <ItemDetail key={itemId} detail={shown} page={page} now={now} blocked={blocked} act={act} onClose={() => setItemId(undefined)} />
          : <aside className="memory-detail"><p className="hint">{detail?.error ?? 'Loading item…'}</p></aside>)}
      </div>
    </div>
  );
}
