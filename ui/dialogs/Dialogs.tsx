import { Select } from '../controls/Select';
import { useEffect, useRef, useState } from 'react';
import { PROFILES, PROFILE_LABELS, harnessFor, profileFor, type InstalledReleaseNotes, type Profile, type Effort, isAgentKind, type ClaudeAccountView, type ClientMessage, type Harness, type NodeKind, type Role } from '../../src/shared/protocol';
import { SETTINGS_HARNESSES, SETTINGS_EFFORTS } from '../../src/shared/settings';
import { send } from '../conn';
import type { TauriWindow } from '../hooks';
import { Modal } from '../controls/Modal';
import { actionsFor } from '../controls/ActionButtons';
import { ReleaseNotes } from '../release-notes/ReleaseNotes';
import { expectSpawn, openDialog, toast, useStore, type Dialog } from '../store';
import { IN_APP } from '../url';
import { UpdateDialog } from './UpdateDialog';
import { accountsError } from '../settings/settings-model';
import './dialogs.css';

type Spawn = Extract<Dialog, { kind: 'spawn' }>;
const close = () => openDialog(null);

/** The app's native folder dialog (tauri-plugin-dialog): the chosen path, or null when cancelled or not in the app.
 *  It opens at `current` when that is an absolute path, else where the OS chooses. */
const pickFolder = async (current: string): Promise<string | null> => {
  const tauri = (window as TauriWindow).__TAURI_INTERNALS__;
  const defaultPath = current.trim().startsWith('/') ? current.trim() : undefined;
  return ((await tauri?.invoke('plugin:dialog|open', { options: { directory: true, multiple: false, defaultPath, title: 'Choose a working directory' } })) as string | null | undefined) ?? null;
};

type SpawnChoice = Harness | 'terminal';

/** The node kind a spawn choice means: an agent for its harness, or a plain terminal. */
const choiceKind = (choice: SpawnChoice): NodeKind => (choice === 'terminal' ? 'terminal' : choice !== 'claude' ? 'agent' : 'claude');
/** The harness sent for a choice; omitted for claude and terminal so their records keep the legacy shape. */
const choiceHarness = (choice: SpawnChoice): Harness | undefined => (choice !== 'claude' && choice !== 'terminal' ? choice : undefined);

/** An account option: its name and login state. */
export const accountLabel = (a: ClaudeAccountView) => `${a.name}${a.isDefault ? ' (default)' : ''} · ${
  a.loggedIn ? [a.email, a.orgName].filter(Boolean).join(', ') || 'logged in' : a.loggedIn === false ? 'not logged in' : 'login unknown'}`;

/** What the spawn dialog sends: kind/harness from the choice, with the agent fields only for agent nodes.
 *  A Claude account is chosen only for a root Claude node; children inherit their parent's. */
export function spawnMsg(
  d: { parentId: string | null },
  form: { choice: SpawnChoice; title: string; cwd: string; prompt: string; model: string; role: Role; defaultRole: Role; profile?: Profile; effort?: Effort; isolate: boolean; account?: string },
): ClientMessage {
  const kind = choiceKind(form.choice);
  const agent = isAgentKind(kind);
  const harness = choiceHarness(form.choice);
  return {
    t: 'spawn', kind, ...(harness ? { harness } : {}),
    title: form.title.trim() || form.choice, cwd: form.cwd.trim(), parentId: d.parentId,
    ...(agent && form.prompt.trim() ? { prompt: form.prompt } : {}),
    ...(agent && form.profile ? { profile: form.profile } : {}),
    ...(agent && form.effort ? { effort: form.effort } : {}),
    ...(agent && form.role !== form.defaultRole ? { role: form.role } : {}),
    ...(agent && form.isolate ? { isolation: 'worktree' as const } : {}),
    ...(form.model.trim() ? { model: form.model.trim() } : {}),
    ...(!d.parentId && form.choice === 'claude' && form.account ? { account: form.account } : {}),
  };
}

function SpawnDialog({ d }: { d: Spawn }) {
  const parent = useStore((s) => (d.parentId ? s.nodes[d.parentId] : undefined));
  const [choice, setChoice] = useState<SpawnChoice>(parent?.harness ?? 'claude');
  const [title, setTitle] = useState('');
  const [cwd, setCwd] = useState(d.cwd);
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState('');
  const [chosenProfile, setProfile] = useState<Profile>();
  const [effort, setEffort] = useState<Effort | ''>('');
  const byPosition: Role = d.parentId ? 'worker' : 'orchestrator';
  const [role, setRole] = useState<Role>(byPosition);
  const profile = profileFor(chosenProfile, d.parentId, role);
  const [isolate, setIsolate] = useState(false);
  const reply = useStore((s) => s.claudeAccounts);
  // An invalid accounts config arrives as one error view: show the error, never offer it as an account.
  const accountsErr = accountsError(reply), accounts = accountsErr ? undefined : reply;
  const [account, setAccount] = useState('');
  useEffect(() => { if (!d.parentId) send({ t: 'claudeAccounts' }); }, [d.parentId]);
  // A selection the latest reply no longer lists falls back to Automatic, so a stale name is never sent.
  const chosen = accounts?.find((a) => a.name === account);
  const kind = choiceKind(choice);
  const agent = isAgentKind(kind);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    send(spawnMsg(d, { choice, title, cwd, prompt, model, role, profile, effort: effort || undefined, defaultRole: byPosition, isolate, account: chosen?.name }));
    expectSpawn();
    close();
  };
  return (
    <Modal title={parent ? `New child of ${parent.title}` : 'New session'} onClose={close}>
      <form className="form" onSubmit={submit}>
        <div className="seg" role="radiogroup" aria-label="Kind">
          {([...SETTINGS_HARNESSES, 'terminal'] as const).map((k) => (
            <button type="button" key={k} role="radio" aria-checked={choice === k} className={choice === k ? 'on' : ''} onClick={() => { setChoice(k); if (k === 'codex' && effort === 'max') setEffort(''); }}>{k}</button>
          ))}
        </div>
        <label>Title<input placeholder={choice} value={title} onChange={(e) => setTitle(e.target.value)} autoFocus /></label>
        <label>Working directory<div className="pick">
          <input className="mono" value={cwd} onChange={(e) => setCwd(e.target.value)} required placeholder="/path/to/project" />
          {IN_APP && <button type="button" className="btn" onClick={() => void pickFolder(cwd).then((p) => p && setCwd(p)).catch(() => {})}>Choose…</button>}
        </div></label>
        {choice === 'claude' && !d.parentId && accountsErr && <p className="account-login" role="alert">{accountsErr}</p>}
        {choice === 'claude' && !d.parentId && !!accounts?.length && <>
          <label>Account<Select value={chosen?.name ?? ''} onChange={(e) => setAccount(e.target.value)} aria-describedby={chosen?.loggedIn === false || chosen?.error ? 'account-login' : undefined}>
            <option value="">Automatic (by project)</option>
            {accounts.map((a) => <option key={a.name} value={a.name}>{accountLabel(a)}</option>)}
          </Select></label>
          {chosen && (chosen.loggedIn === false || chosen.error) && <div className="account-login" id="account-login">
            {chosen.error && <p>{chosen.error}</p>}
            {chosen.loggedIn === false && <>
              <p>Not logged in. Log in with:</p>
              <div className="pick">
                <input className="mono" readOnly value={chosen.loginCommand} aria-label="Login command" onFocus={(e) => e.currentTarget.select()} />
                <button type="button" className="btn" onClick={() => void navigator.clipboard?.writeText(chosen.loginCommand).then(() => toast('Login command copied', undefined, 'ok')).catch(() => {})}>Copy</button>
              </div>
              <p>or /login in the node's terminal</p>
            </>}
          </div>}
        </>}
        {choice === 'claude' && parent?.account && <p className="account-inherited">Account: {parent.account} (inherited)</p>}
        {agent && <label>Initial prompt<textarea rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Optional" /></label>}
        {agent && <label>Task profile<Select value={profile} onChange={(e) => setProfile(e.target.value as Profile)}>{PROFILES.map((p) => <option key={p} value={p}>{PROFILE_LABELS[p]}</option>)}</Select></label>}
        <label>Model<input className="mono" value={model} onChange={(e) => setModel(e.target.value)} placeholder="Default" /></label>
        {agent && <label>Effort<Select value={effort} onChange={(e) => setEffort(e.target.value as Effort | '')}><option value="">Default</option>{SETTINGS_EFFORTS[choice === 'terminal' ? 'claude' : choice].map((e) => <option key={e}>{e}</option>)}</Select></label>}
        {agent && <label>Coordination role<Select value={role} onChange={(e) => setRole(e.target.value as Role)}>{(['orchestrator', 'worker', 'none'] as const).map((r) => <option key={r}>{r}</option>)}</Select></label>}
        {agent && (
          <label className="check"><input type="checkbox" checked={isolate} onChange={(e) => setIsolate(e.target.checked)} />Isolate in a git worktree
            <small>Its branch is created from the current checkout's HEAD.</small></label>
        )}
        <div className="btns"><button type="button" className="btn" onClick={close}>Cancel</button><button type="submit" className="btn primary">Spawn</button></div>
      </form>
    </Modal>
  );
}

/** The close choices for a node with a worktree; plain Close sends no worktree option, so the daemon refuses a dirty or unmerged tree. */
export const worktreeCloses = (id: string, force = false): Array<{ label: string; className: string; msg: ClientMessage }> => [
  { label: 'Close', className: 'btn primary', msg: { t: 'close', id, ...(force ? { force } : {}) } },
  { label: 'Keep branch', className: 'btn', msg: { t: 'close', id, ...(force ? { force } : {}), worktree: 'keep' } },
  { label: 'Discard', className: 'btn danger solid', msg: { t: 'close', id, ...(force ? { force } : {}), worktree: 'discard' } },
];

function KillDialog({ id }: { id: string }) {
  const node = useStore((s) => s.nodes[id]);
  if (!node) return null;
  const wt = node.worktree;
  if (wt) return (
    <Modal title={`Close ${node.title}?`} onClose={close}>
      <p>It works in its own git worktree on branch <code>{wt.branch}</code>. Close stops it and removes the worktree only when the tree is clean and merged into {wt.base}; otherwise the close is refused and the node keeps running.</p>
      <p>Keep branch commits uncommitted work as a WIP commit, removes the directory and keeps the branch. Discard deletes the worktree and the branch, including uncommitted work.</p>
      <div className="btns">
        <button className="btn" autoFocus onClick={close}>Cancel</button>
        {worktreeCloses(id, node.parentId === null).map((c) => <button key={c.label} className={c.className} onClick={() => { send(c.msg); close(); }}>{c.label}</button>)}
      </div>
    </Modal>
  );
  return (
    <Modal title={`Kill ${node.title}?`} onClose={close}>
      <p>The process is stopped and the node is closed. Any work it has not finished is lost.</p>
      <div className="btns">
        <button className="btn" autoFocus onClick={close}>Cancel</button>
        <button className="btn danger solid" onClick={() => { send({ t: 'close', id }); close(); }}>Kill</button>
      </div>
    </Modal>
  );
}

/** What the restart dialog sends; a first prompt is meaningful for an agent node (Claude or Pi). */
export const restartMsg = (id: string, kind: NodeKind, prompt: string): ClientMessage =>
  ({ t: 'restart', id, ...(isAgentKind(kind) && prompt.trim() ? { prompt } : {}) });

function RestartDialog({ id }: { id: string }) {
  const node = useStore((s) => s.nodes[id]);
  const [prompt, setPrompt] = useState('');
  if (!node) return null;
  const remove = actionsFor(node).find((a) => a.key === 'remove');
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    send(restartMsg(id, node.kind, prompt));
    close();
  };
  return (
    <Modal title={`Restart ${node.title}?`} onClose={close}>
      <form className="form" onSubmit={submit}>
        <p>Its context is cleared; children are kept.</p>
        {node.status.exited && <p>Close removes this node from the sidebar without restarting it; children are kept.</p>}
        {isAgentKind(node.kind) && <label>First prompt<textarea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Optional: by default it is pointed at its handoff.md, if there is one" /></label>}
        <div className="btns">
          <button type="button" className="btn" autoFocus onClick={close}>Cancel</button>
          {remove && <button type="button" className="btn danger" onClick={() => { close(); remove.run(); }}>Close</button>}
          <button type="submit" className="btn primary">Restart</button>
        </div>
      </form>
    </Modal>
  );
}

function ChangeHarnessDialog({ id }: { id: string }) {
  const node = useStore((s) => s.nodes[id]);
  const connected = useStore((s) => s.connected);
  const [target, setTarget] = useState<Harness>(node ? harnessFor(node) : 'claude');
  const [prompt, setPrompt] = useState('');
  const submitted = useRef(false);
  if (!node || !isAgentKind(node.kind)) return null;
  const current = harnessFor(node);
  const unavailable = !connected || !!node.changingHarness || !!node.pending || node.gate === 'running';
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (unavailable || target === current || submitted.current) return;
    submitted.current = true;
    send({ t: 'changeHarness', id, harness: target, ...(prompt.trim() ? { prompt } : {}) });
    close();
  };
  return (
    <Modal title={`Change harness for ${node.title}?`} className="modal change-harness-dialog" onClose={close} restoreFocus blockGlobalShortcuts>
      <form className="form" onSubmit={submit}>
        <p>The current {current} process will stop. The selected harness starts with a fresh context; it will not resume this conversation.</p>
        <p>Earlier transcripts stay readable. This node keeps its title, children, working directory and worktree.</p>
        <label>Harness<Select value={target} onChange={(e) => setTarget(e.target.value as Harness)} aria-describedby="harness-defaults">
          {SETTINGS_HARNESSES.map((h) => <option key={h} value={h}>{h}{h === current ? ' (current)' : ''}</option>)}
        </Select></label>
        <p id="harness-defaults">Model, effort, preset and Claude permission overrides are cleared. The selected harness uses its task profile defaults and configured permission and approval settings.</p>
        <label>First prompt<textarea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Optional: by default it is pointed at its handoff.md, if there is one" /></label>
        {unavailable && <p role="status">{!connected ? 'Reconnect before changing harness.' : 'Wait for the current lifecycle operation to finish.'}</p>}
        <div className="btns">
          <button type="button" className="btn" autoFocus onClick={close}>Cancel</button>
          <button type="submit" className="btn primary" disabled={unavailable || target === current}>Change harness</button>
        </div>
      </form>
    </Modal>
  );
}

type Fork = Extract<Dialog, { kind: 'fork' }>;

/** What the follow-up dialog sends: the archived node's session continues as a new live node. */
export const followupMsg = (id: string, prompt: string): ClientMessage => ({ t: 'followup', id, prompt });

/** What the fork dialog sends: a Claude node in the source's directory that starts from its conversation. */
export const forkMsg = (d: Fork, title: string, prompt: string): ClientMessage => ({
  t: 'spawn', kind: 'claude', title: title.trim() || `fork of ${d.title}`, cwd: d.cwd, parentId: d.parentId, fork: d.from,
  ...(prompt.trim() ? { prompt } : {}),
});

function FollowupDialog({ id, title }: { id: string; title: string }) {
  const [prompt, setPrompt] = useState('');
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    send(followupMsg(id, prompt));
    expectSpawn();
    close();
  };
  return (
    <Modal title={`Follow up on ${title}`} onClose={close}>
      <form className="form" onSubmit={submit}>
        <p>Its last session continues as a new node, starting on this prompt.</p>
        <label>Prompt<textarea rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} required autoFocus /></label>
        <div className="btns"><button type="button" className="btn" onClick={close}>Cancel</button><button type="submit" className="btn primary" disabled={!prompt.trim()}>Follow up</button></div>
      </form>
    </Modal>
  );
}

function ForkDialog({ d }: { d: Fork }) {
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    send(forkMsg(d, title, prompt));
    expectSpawn();
    close();
  };
  return (
    <Modal title={`Fork ${d.title}`} onClose={close}>
      <form className="form" onSubmit={submit}>
        <p>A new Claude node in <code>{d.cwd}</code> starts with a copy of this conversation; the original is not changed.</p>
        <label>Title<input placeholder={`fork of ${d.title}`} value={title} onChange={(e) => setTitle(e.target.value)} autoFocus /></label>
        <label>Prompt<textarea rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Optional" /></label>
        <div className="btns"><button type="button" className="btn" onClick={close}>Cancel</button><button type="submit" className="btn primary">Fork</button></div>
      </form>
    </Modal>
  );
}

/** Mounted by Modal only after the native dialog is open and its notes are visible. */
function InstalledNotes({ notes }: { notes: InstalledReleaseNotes }) {
  const connected = useStore((s) => s.connected);
  useEffect(() => {
    if (connected && notes.releases.length) send({ t: 'updateNotesRead', identity: notes.identity });
  }, [connected, notes]);
  return <>
    <div className="release-notes" tabIndex={0} aria-label="Installed release notes">
      {notes.releases.map((release) => <section key={release.id}>
        <h3>{release.tag}{release.name !== release.tag && ` · ${release.name}`}</h3>
        <ReleaseNotes body={release.body} />
      </section>)}
    </div>
  </>;
}

function WhatsNewDialog({ notes }: { notes: InstalledReleaseNotes }) {
  const opener = useRef(document.activeElement);
  const onClose = () => {
    close();
    requestAnimationFrame(() => {
      const target = opener.current;
      if (target instanceof HTMLElement && target.isConnected) target.focus();
      else document.querySelector<HTMLElement>('.tree')?.focus();
    });
  };
  return <Modal title="What’s new" className="modal release-notes-dialog" resizable onClose={onClose} footer={<div className="btns"><button className="btn" autoFocus onClick={onClose}>Close</button></div>}><InstalledNotes notes={notes} /></Modal>;
}


export function Dialogs() {
  const d = useStore((s) => s.dialog);
  if (d?.kind === 'whatsNew') return <WhatsNewDialog notes={d.notes} />;
  if (d?.kind === 'update') return <UpdateDialog />;
  if (d?.kind === 'spawn') return <SpawnDialog d={d} />;
  if (d?.kind === 'kill') return <KillDialog id={d.id} />;
  if (d?.kind === 'restart') return <RestartDialog id={d.id} />;
  if (d?.kind === 'changeHarness') return <ChangeHarnessDialog key={d.id} id={d.id} />;
  if (d?.kind === 'followup') return <FollowupDialog id={d.id} title={d.title} />;
  if (d?.kind === 'fork') return <ForkDialog d={d} />;
  return null;
}
