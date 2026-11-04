import { useEffect, useRef } from 'react';
import { isAgentKind, shellNodeId, shellStreamId, type NodeView } from '../src/shared/protocol';
import { send } from './conn';
import { useStore } from './store';
import { createTerm, disposeTerm, getTerm } from './terminals';
import '@xterm/xterm/css/xterm.css';

/** A node's own PTY, or with a shell stream id (shellStreamId) the human's shell beside an agent node. */
function TermView({ id, visible, exited, strip }: { id: string; visible: boolean; exited: boolean; strip?: boolean }) {
  const el = useRef<HTMLDivElement>(null);
  const connected = useStore((s) => s.connected);

  useEffect(() => {
    const { term } = createTerm(id, el.current!);
    const sub = term.onData((data) => send({ t: 'input', id, data }));
    // Legacy mouse reports contain raw bytes, including after a serialized screen attach.
    const binarySub = term.onBinary((data) => send({ t: 'input', id, data, binary: true }));
    return () => { sub.dispose(); binarySub.dispose(); disposeTerm(id); };
  }, [id]);

  // Becoming visible (or reconnecting / resuming while visible): reset, fit, attach. The reply is a serialized screen to write as-is.
  useEffect(() => {
    if (!visible || !connected) return;
    const t = getTerm(id);
    if (!t) return;
    t.term.reset();
    t.fit.fit();
    send({ t: 'select', id: shellNodeId(id) ?? id });
    send({ t: 'attach', id, cols: t.term.cols, rows: t.term.rows });
    if (!exited && !document.activeElement?.closest('.tree')) t.term.focus();
    return () => send({ t: 'detach', id });
  }, [id, visible, connected, exited]);

  useEffect(() => {
    if (!visible) return;
    let timer: ReturnType<typeof setTimeout>;
    const ro = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const t = getTerm(id);
        if (!t) return;
        t.fit.fit();
        send({ t: 'resize', id, cols: t.term.cols, rows: t.term.rows });
      }, 100);
    });
    ro.observe(el.current!);
    return () => { clearTimeout(timer); ro.disconnect(); };
  }, [id, visible]);

  // visibility, never display:none: a hidden xterm cannot measure itself.
  return <div ref={el} className={`term${visible ? ' show' : ''}${strip ? ' below-strip' : ''}`} />;
}

/** The agent's suggested command over its shell. The daemon types it on Insert, so the text sent is always the validated one. */
function SuggestionStrip({ node }: { node: NodeView }) {
  const { command, why } = node.suggestion!;
  const act = (action: 'insert' | 'dismiss') => send({ t: 'suggestion', id: node.id, action });
  return (
    <div className="suggest-strip" title={why}>
      <span className="dim">Agent suggests:</span>
      <code title={why ? `${command}\n${why}` : command}>{command}</code>
      <button className="btn" disabled={!node.shellReady} title={node.shellReady ? 'Type it at the prompt without running it' : 'Waiting for the shell prompt'} onClick={() => act('insert')}>Insert</button>
      <button className="btn" onClick={() => act('dismiss')}>Dismiss</button>
    </div>
  );
}

export function TerminalPane() {
  const opened = useStore((s) => s.opened);
  const selected = useStore((s) => s.selected);
  const nodes = useStore((s) => s.nodes);
  const node = selected ? nodes[selected] : undefined;
  const shell = useStore((s) => s.shellOpen) && !!node && isAgentKind(node.kind) ? node : undefined;
  return (
    <div className="termwrap">
      {opened.map((id) => <TermView key={id} id={id} visible={id === selected && !shell} exited={!!nodes[id]?.status.exited} />)}
      {shell?.suggestion && <SuggestionStrip node={shell} />}
      {shell && <TermView key={shellStreamId(shell.id)} id={shellStreamId(shell.id)} visible exited={false} strip={!!shell.suggestion} />}
    </div>
  );
}
