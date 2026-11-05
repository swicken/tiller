import { isAgentKind, shellStreamId } from '../shared/protocol.js';
import type { NodeManager } from './manager.js';
import { buildChildEnv, PtySession } from './pty.js';
import { logError } from './util.js';

const EXITED = '\r\n[shell exited; reopen the Terminal tab to start a new one]\r\n';
/** What would let `tl` in the shell act as the node's agent; the daemon may have inherited them. */
const AGENT_ENV = ['TL_NODE_ID', 'TL_PARENT_ID', 'TL_ENDPOINT', 'TL_TOKEN_FILE', 'TL_SESSION_DIR'];

interface Shell { s: PtySession; ready: boolean }

/**
 * The human's login shell beside each agent node (its Terminal tab), addressed by shellStreamId. Spawned on the first
 * attach, killed when the node is removed or the daemon stops. Never reachable through manager.session(), so agents
 * cannot read or type into it. Output goes out as the manager's 'data' event with the stream id.
 */
export class Shells {
  private shells = new Map<string, Shell>();

  constructor(private m: NodeManager, private shell: string) {}

  /** Start the node's shell if it has none, resize it to the viewer and return its screen; throws for a node without a shell tab. */
  async attach(id: string, cols: number, rows: number): Promise<string> {
    const rec = this.m.registry.get(id);
    if (!rec || !this.m.view(id)) throw new Error(`no such node: ${id}`);
    if (!isAgentKind(rec.kind)) throw new Error(`${id} is a terminal node: it has no shell tab`);
    if (this.m.stopped) throw new Error('the daemon is stopping');
    // Until then cwd is the source checkout, and a shell started there would stay there once the node moves in.
    const busy = this.m.runtimes.get(id)?.busy;
    if (rec.pending?.isolation === 'worktree' || busy === 'creating') throw new Error(`${id}'s worktree is not created yet: open the Terminal tab again once it exists`);
    if (busy === 'closing') throw new Error(`${id} is closing`); // its tree may be on its way out
    const sh = this.shells.get(id) ?? this.spawn(id, rec.cwd, cols, rows);
    sh.s.resize(cols, rows);
    await sh.s.flush();
    return sh.s.snapshot();
  }

  private spawn(id: string, cwd: string, cols: number, rows: number): Shell {
    const env = buildChildEnv({ PATH: this.m.path });
    for (const k of AGENT_ENV) delete env[k];
    const sh: Shell = { s: PtySession.spawn({ file: this.shell, args: ['-l'], cwd, env, cols, rows }), ready: false };
    this.shells.set(id, sh);
    const stream = shellStreamId(id);
    sh.s.onData((d) => {
      this.m.emit('data', stream, d);
      if (!sh.ready) { sh.ready = true; this.m.emitNode(id); }
    });
    sh.s.onExit(() => {
      if (this.shells.get(id) !== sh) return; // killed: the node is gone
      this.shells.delete(id);
      this.m.emit('data', stream, EXITED);
      this.m.emitNode(id);
    });
    return sh;
  }

  session(id: string): PtySession | undefined { return this.shells.get(id)?.s; }
  /** The shell is running and has printed output, so typed text will not be lost to a login shell still starting. */
  ready(id: string): boolean { return !!this.shells.get(id)?.ready; }

  input(id: string, data: string, binary = false): void {
    this.shells.get(id)?.s.write(binary ? Buffer.from(data, 'latin1') : data).catch(logError);
  }

  resize(id: string, cols: number, rows: number): void { this.shells.get(id)?.s.resize(cols, rows); }

  /** Type `text` at the shell's prompt; throws while the shell is missing or has printed nothing yet. */
  insert(id: string, text: string): void {
    if (!this.ready(id)) throw new Error('the shell is not ready yet: open the Terminal tab and wait for its prompt');
    this.input(id, text);
  }

  /** Kill the node's shell, if any; returns it so a caller can wait for its exit. */
  kill(id: string): PtySession | undefined {
    const sh = this.shells.get(id);
    this.shells.delete(id);
    sh?.s.kill();
    if (sh && this.m.registry.get(id)) { // the node stays (a close that failed after this): show the tab as exited
      this.m.emit('data', shellStreamId(id), EXITED);
      this.m.emitNode(id);
    }
    return sh?.s;
  }

  /** Kill every shell; resolves once they have exited or `timeoutMs` passed. */
  terminateAll(timeoutMs?: number): Promise<unknown> {
    const all = [...this.shells.values()];
    this.shells.clear();
    return Promise.all(all.map((sh) => sh.s.terminate(timeoutMs).catch(() => false)));
  }
}
