import { Select } from '../controls/Select';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { HARNESS_LABELS, finished, type ArchivedNode, type Harness, type Transcript, type TranscriptEntry } from '../../src/shared/protocol';
import { send } from '../conn';
import { conversationRequested, conversationsRequested, getState, selectNode, toggleShowTools, transcriptRequested, useStore, viewArchived } from '../store';
import { ConversationList, ConversationView, conversationTitle, type Choice } from './Conversations';
import { ClampedText, Tools, When } from './parts';

function Entry({ e, assistantName, showTools }: { e: TranscriptEntry; assistantName: string; showTools: boolean }) {
  return (
    <article className={`entry ${e.role}`}>
      <header>
        <span className="who">{e.role === 'user' ? 'User' : assistantName}</span>
        {e.at !== undefined && <When at={e.at} />}
      </header>
      {e.text && <ClampedText text={e.text} />}
      {showTools && <Tools tools={e.tools} />}
    </article>
  );
}

/**
 * A conversation as a timeline; a session picker (current first) when there is more than one session. `sessionId` undefined is the current one.
 * Without `showTools`, tool chips are hidden and entries that only called tools are left out.
 */
export function TranscriptView({ data, sessionId, onSession, harness = 'claude', showTools = false }: { data: Transcript; sessionId?: string; onSession: (id: string | undefined) => void; harness?: Harness; showTools?: boolean }) {
  const selectedHarness = data.sessions.find((s) => sessionId ? s.sessionId === sessionId : s.current)?.harness ?? harness;
  const assistantName = HARNESS_LABELS[selectedHarness];
  const entries = showTools ? data.entries : data.entries.filter((e) => e.text);
  return (
    <>
      {data.sessions.length > 1 && (
        <label className="sesspick">Session
          <Select value={sessionId ?? ''} onChange={(e) => onSession(e.target.value || undefined)}>
            {data.sessions.map((s) => <option key={s.sessionId} value={s.current ? '' : s.sessionId}>{s.current ? 'Current session' : `Session ${s.sessionId.slice(0, 8)}`}{s.harness ? ` · ${s.harness}` : ''}</option>)}
          </Select>
        </label>
      )}
      {data.truncated && <p className="hint">Older messages are not shown.</p>}
      {entries.map((e, i) => <Entry key={i} e={e} assistantName={assistantName} showTools={showTools} />)}
      {!entries.length && <p className="hint">No messages in this session.</p>}
    </>
  );
}

/** The view's title and the Show tool calls checkbox (disabled where there are no tool calls). */
function Toolbar({ title, noTools }: { title: string; noTools?: boolean }) {
  const showTools = useStore((s) => s.showTools);
  return (
    <div className="convo-bar">
      <h2 title={title}>{title}</h2>
      <label className="check">
        <input type="checkbox" checked={showTools} disabled={noTools} onChange={toggleShowTools} />Show tool calls
      </label>
    </div>
  );
}

/** A scroller ref that jumps to its newest entry once per `key`, when `ready`. */
function useScrollToEnd(ready: boolean, key: string) {
  const scroller = useRef<HTMLDivElement>(null);
  const scrolled = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!ready || !el || scrolled.current === key) return;
    scrolled.current = key;
    el.scrollTop = el.scrollHeight;
  }, [ready, key]);
  return scroller;
}

/**
 * The node's full harness transcript. Asks on open, on reconnect, on a session change and whenever `refresh` changes.
 * Current requests use the actual session identity so a replacement cannot reuse the old conversation's cache or
 * in-flight reply. An explicitly selected historical session stays selected when the live conversation changes.
 */
export function FullTranscript({ id, currentSessionId, refresh, harness }: { id: string; currentSessionId?: string; refresh?: unknown; harness?: Harness }) {
  const [sessionId, setSessionId] = useState<string>();
  const requestedSessionId = sessionId ?? currentSessionId;
  const t = useStore((s) => {
    const cached = s.transcript;
    if (cached?.id !== id || cached.sessionId !== requestedSessionId) return undefined;
    // A historical selection keeps its messages, but needs fresh session metadata after a switch.
    if (cached.data && currentSessionId && cached.data.sessions.find((s) => s.current)?.sessionId !== currentSessionId) return undefined;
    return cached;
  });
  const connected = useStore((s) => s.connected);
  const showTools = useStore((s) => s.showTools);

  useEffect(() => {
    if (!connected) return;
    transcriptRequested(id, requestedSessionId);
    send({ t: 'transcript', id, ...(requestedSessionId && { sessionId: requestedSessionId }) });
  }, [id, requestedSessionId, currentSessionId, connected, refresh]);

  const scroller = useScrollToEnd(!!t?.data, requestedSessionId ?? '');
  return (
    <>
      <Toolbar title="Full transcript" />
      <div className="convo-scroll" ref={scroller}>
        <div className="entries">
          {t?.error ? <p className="hint">{t.error}</p>
            : !t?.data ? <p className="hint">Loading transcript…</p>
            : <TranscriptView data={t.data} sessionId={sessionId} onSession={setSessionId} harness={harness} showTools={showTools} />}
        </div>
      </div>
    </>
  );
}

/**
 * One conversation of node `nodeId`. Asks on open, on reconnect, when `refresh` changes and when the other
 * participant finishes. `archived` holds closed participants so their names can open their panes.
 */
function ConversationPane({ nodeId, choice, refresh, archived }: { nodeId: string; choice: { id: string; with?: string }; refresh?: unknown; archived: Record<string, ArchivedNode> }) {
  const { id, with: peer } = choice;
  const c = useStore((s) => s.conversation?.id === id && s.conversation.with === peer ? s.conversation : undefined);
  const connected = useStore((s) => s.connected);
  const showTools = useStore((s) => s.showTools);
  const other = peer ?? (id === nodeId ? undefined : id);
  const otherRefresh = useStore((s) => {
    const n = s.nodes[other ?? s.nodes[nodeId]?.parentId ?? ''];
    return n && finished(n.status) ? n.status.changedAt : 'running';
  });

  useEffect(() => {
    if (!connected) return;
    conversationRequested(id, peer);
    send({ t: 'conversation', id, ...(peer && { with: peer }) });
  }, [id, peer, connected, refresh, otherRefresh]);

  const jump = (to: string) => to === nodeId ? undefined
    : getState().nodes[to] ? () => selectNode(to)
    : archived[to] ? () => viewArchived(archived[to]) : undefined;
  const scroller = useScrollToEnd(!!c?.data, `${id}|${peer ?? ''}`);
  return (
    <>
      <Toolbar title={c?.data ? conversationTitle(c.data) : 'Conversation'} noTools={!!peer} />
      <div className="convo-scroll" ref={scroller}>
        <div className="entries convo">
          {c?.error ? <p className="hint">{c.error}</p>
            : !c?.data ? <p className="hint">Loading conversation…</p>
            : <ConversationView data={c.data} showTools={showTools && !peer} jump={jump} />}
        </div>
      </div>
    </>
  );
}

/**
 * A live or archived node's conversations over the stage; `children` go above them. Opens on the node's conversation with
 * its parent ("With you" for a root); the list offers its children's and peers' conversations and the full transcript.
 * Key by node id.
 */
export function TranscriptPane({ id, currentSessionId, refresh, harness, children }: { id: string; currentSessionId?: string; refresh?: unknown; harness?: Harness; children?: ReactNode }) {
  const [choice, setChoice] = useState<Choice>({ id });
  const list = useStore((s) => s.conversations?.id === id ? s.conversations : undefined);
  const connected = useStore((s) => s.connected);
  // Children come and go and finish while the node works; their rows' presence, glyphs and counts follow.
  const childKey = useStore((s) => Object.values(s.nodes).filter((n) => n.parentId === id)
    .map((n) => `${n.id}:${finished(n.status) ? n.status.changedAt : ''}`).sort().join(' '));

  useEffect(() => {
    if (!connected) return;
    conversationsRequested(id);
    send({ t: 'conversations', id });
  }, [id, connected, refresh, childKey]);

  const archived = Object.fromEntries((list?.items ?? []).flatMap((c) => c.archived ? [[c.counterpart, c.archived]] : []));
  return (
    <div className="transcript convos">
      {children}
      <div className="convo-shell">
        <ConversationList items={list?.items} error={list?.error} selected={choice} onSelect={setChoice} />
        <section className="convo-main" aria-label="Conversation">
          {choice === 'full'
            ? <FullTranscript id={id} currentSessionId={currentSessionId} refresh={refresh} harness={harness} />
            : <ConversationPane key={`${choice.id}|${choice.with ?? ''}`} nodeId={id} choice={choice} refresh={refresh} archived={archived} />}
        </section>
      </div>
    </div>
  );
}
