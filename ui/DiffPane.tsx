import { useEffect, useMemo, useState } from 'react';
import type { DiffFile, NodeView } from '../src/shared/protocol';
import { Counts } from './controls/Bits';
import { send } from './conn';
import { formatComments, parsePatch, type DiffLine, type ReviewComment } from './diff';
import { branchLabel } from '../src/shared/format';
import { addComment, diffRequested, removeComment, useStore } from './store';

const STATUS_MARK = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' } as const;


/** Which line a comment points at: the new file's number, or the old one for a removed line. */
const lineNo = (l: DiffLine) => (l.kind === 'del' ? l.old! : l.new!);

function Composer({ onAdd, onCancel }: { onAdd: (note: string) => void; onCancel: () => void }) {
  const [note, setNote] = useState('');
  const add = () => note.trim() && onAdd(note.trim());
  return (
    <div className="composer">
      <textarea autoFocus rows={3} value={note} placeholder="Comment for the node" aria-label="Comment"
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) add(); else if (e.key === 'Escape') onCancel(); }} />
      <div className="btns">
        <button className="btn" onClick={onCancel}>Cancel</button>
        <button className="btn primary" disabled={!note.trim()} onClick={add}>Add comment</button>
      </div>
    </div>
  );
}

function Patch({ node, file }: { node: NodeView; file: DiffFile }) {
  const lines = useMemo(() => parsePatch(file.patch ?? ''), [file.patch]);
  const comments = useStore((s) => s.comments).filter((c) => c.nodeId === node.id && c.path === file.path);
  const [open, setOpen] = useState<number | null>(null); // index of the line with the composer

  if (!file.patch) return <p className="hint">{file.binary ? 'Binary file; no patch to show.' : 'Patch not shown: the diff passed its 2 MB limit before this file.'}</p>;
  return (
    <div className="lines">
      {lines.map((l, i) => {
        const commentable = l.kind === 'add' || l.kind === 'del' || l.kind === 'ctx';
        const here = commentable ? comments.filter((c) => c.line === lineNo(l) && c.text === l.text) : [];
        return (
          <div key={i}>
            <div className={`dl ${l.kind}`} {...(commentable && {
              role: 'button', tabIndex: 0, title: 'Comment on this line',
              onClick: () => setOpen(i), onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter') setOpen(i); },
            })}>
              <span className="ln">{l.old ?? ''}</span><span className="ln">{l.new ?? ''}</span><span className="code">{l.text}</span>
            </div>
            {here.map((c, j) => (
              <div className="note" key={j}>
                <span>{c.note}</span>
                <button className="btn icon" aria-label="Remove comment" onClick={() => removeComment(c)}>×</button>
              </div>
            ))}
            {open === i && (
              <Composer onCancel={() => setOpen(null)} onAdd={(note) => {
                addComment({ nodeId: node.id, path: file.path, line: lineNo(l), text: l.text, note });
                setOpen(null);
              }} />
            )}
          </div>
        );
      })}
    </div>
  );
}

/** The selected worktree node's changes since it branched, with line comments that go back to the node as one message. */
export function DiffPane({ node }: { node: NodeView }) {
  const diff = useStore((s) => (s.diff?.id === node.id ? s.diff : undefined));
  const connected = useStore((s) => s.connected);
  const comments = useStore((s) => s.comments).filter((c) => c.nodeId === node.id);
  const [path, setPath] = useState<string>();
  const gitKey = JSON.stringify(node.status.git ?? null);

  // On open, on reconnect, and whenever the node's git state moves.
  useEffect(() => {
    if (!connected) return;
    diffRequested(node.id);
    send({ t: 'diff', id: node.id });
  }, [node.id, gitKey, connected]);

  const files = diff?.data?.files ?? [];
  const file = files.find((f) => f.path === path) ?? files[0];
  const sendComments = () => send({ t: 'send', id: node.id, text: formatComments(branchLabel(node.worktree!), comments) });

  return (
    <div className="diffpane">
      {diff?.error ? <p className="hint">{diff.error}</p> : !diff?.data ? <p className="hint">Loading diff…</p> : !files.length ? (
        <p className="hint">No changes on {branchLabel(diff.data)} against {diff.data.base}.</p>
      ) : (
        <div className="diffbody">
          <nav className="files" aria-label="Changed files">
            {files.map((f) => (
              <button key={f.path} className={`file${f === file ? ' sel' : ''}`} aria-current={f === file} title={f.path} onClick={() => setPath(f.path)}>
                <span className={`fst ${f.status}`}>{STATUS_MARK[f.status]}</span>
                <span className="path">{f.path}</span>
                <Counts of={f} />
              </button>
            ))}
            {diff.data.truncated && <p className="hint">Patches stop after 2 MB; later files show counts only.</p>}
          </nav>
          <section className="patch" aria-label={file!.path}>
            <h2>{file!.path}</h2>
            <Patch key={file!.path} node={node} file={file!} />
          </section>
        </div>
      )}
      {comments.length > 0 && (
        <div className="review">
          <span>{comments.length} comment{comments.length === 1 ? '' : 's'} for {node.title}, delivered as one message when it is idle</span>
          <span className="spacer" />
          <button className="btn primary" onClick={sendComments}>Send {comments.length} comment{comments.length === 1 ? '' : 's'}</button>
        </div>
      )}
    </div>
  );
}
