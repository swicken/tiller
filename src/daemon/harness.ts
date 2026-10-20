// CLI-specific policy. Coordination remains the daemon's existing MCP + inbox HTTP protocol.
import { execFileSync } from 'node:child_process';
import { accessSync, constants, mkdirSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { isSupportedEffort } from '../shared/harness-policy.js';
import { harnessFor, type Harness, type NodeRecord } from '../shared/protocol.js';
import { claudeLaunch, nodeEnv, systemPrompt, type LaunchInput, type LaunchSpec } from './launch.js';
import type { Preset } from './presets.js';
import { transcriptFor } from './transcript.js';
import { piTranscript, preparePiTranscript } from './pi-session.js';
import { codexTranscript, prepareCodexTranscript } from './codex-session.js';

export interface HarnessOptions {
  permissionMode?: string;
  preset?: Partial<Preset>;
  /** Pi: resolve the pi.extensions setting for this project now, so a bad list fails before any setup. */
  piExtensions?: { setting: LaunchInput['piExtensions']; cwd: string; path: string };
}

/** New CLIs implement this boundary; tools, permissions/scope and delivery receipts stay in Tiller. */
export interface HarnessAdapter {
  id: Harness;
  /** `inbox`: the mod's inbox is the only delivery path, and a claim is a native submission with no paste to verify. */
  capabilities: { fork: boolean; inbox: boolean };
  /** Fail before allocating a node when requested restrictions cannot be enforced. */
  validate(options: HarnessOptions): void;
  launch(input: LaunchInput): LaunchSpec;
  /** Claude adopts worktrees itself; other CLIs start directly inside them. */
  cwd(node: NodeRecord): string;
  transcript(node: Pick<NodeRecord, 'id' | 'cwd' | 'sessionId' | 'transcriptPath'>, sessionDir: string): string | undefined;
  /** Adopt/repair owned session storage before launch, without changing the conversation identity. */
  prepareTranscript?(node: NodeRecord, sessionDir: string, resume: boolean): string;
}

const piExtension = fileURLToPath(new URL('../../adapters/pi/index.ts', import.meta.url));

/**
 * Claude tool names a preset may use, as Pi's built-in tools. Pi's edit and write cover notebooks too, so NotebookEdit maps
 * to edit. A name not listed here has no Pi equivalent and the preset is refused, so a restriction is never weaker than written.
 */
const PI_TOOLS: Record<string, string> = {
  Read: 'read', Write: 'write', Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit',
  Bash: 'bash', PowerShell: 'powershell', Grep: 'grep', Glob: 'find', LS: 'ls',
};
/**
 * The adapter registers tiller's MCP server as tl_<node prefix>_<random> (mcpName in adapters/pi/config.ts), so this node's
 * tiller tools are mcp__tl_<node prefix>_*; a user server that merely starts with tl_ does not match.
 */
export const piTillerTools = (nodeId: string) => `mcp__tl_${nodeId.replace(/^n[-_]/, '').replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 8)}_*`;

export function piToolName(name: string, nodeId: string): string {
  if (name === 'mcp__tiller') return piTillerTools(nodeId);
  if (name.startsWith('mcp__tiller__')) return `${piTillerTools(nodeId)}__${name.slice('mcp__tiller__'.length)}`;
  if (!Object.hasOwn(PI_TOOLS, name)) throw new Error(`Pi has no equivalent of preset tool ${name}; Pi presets can name ${Object.keys(PI_TOOLS).join(', ')} and mcp__tiller tools`);
  return PI_TOOLS[name];
}

/** A preset's tools as Pi's --tools allowlist, which always keeps tiller's MCP tools, and disallowedTools as --exclude-tools. */
export function piToolArgs(p: Partial<Preset>, nodeId: string): string[] {
  const name = (tool: string) => piToolName(tool, nodeId), args: string[] = [];
  if (p.tools) args.push('--tools', [...new Set([...p.tools.map(name), piTillerTools(nodeId)])].join(','));
  if (p.disallowedTools) args.push('--exclude-tools', [...new Set(p.disallowedTools.map(name))].join(','));
  return args;
}

/** A restricted preset loads no user extensions: their tools (subagents, background tasks) would undo its limits. */
const piRestricted = (p: Partial<Preset> | undefined) => p?.tools !== undefined || p?.disallowedTools !== undefined;

/** Built-ins tiller needs once --no-extensions drops them: MCP for tiller's server, codemode and tool search for its exposures. */
const PI_BUILTINS = ['builtin:mcp', 'builtin:codemode', 'builtin:tool-search'];

/**
 * The packages in the user's and the project's Pi settings, from `pi list`: each source line is followed by its install path
 * when it is installed, and a source with filters is marked "(filtered)".
 */
export function piPackages(cwd: string, path: string): { source: string; filtered: boolean; path?: string }[] {
  // prune: parses pi list's human-readable output, as Pi has no machine-readable listing; revisit if Pi adds one.
  const out = execFileSync('pi', ['list'], { cwd, env: { ...process.env, PATH: path, NO_COLOR: '1', FORCE_COLOR: '0' }, encoding: 'utf8', timeout: 10_000 });
  const packages: { source: string; filtered: boolean; path?: string }[] = [];
  for (const line of stripVTControlCharacters(out).split('\n')) { // in case colour is forced some other way
    const installed = /^ {4}(\S.*)$/.exec(line), source = /^ {2}(\S.*?)( \(filtered\))?$/.exec(line);
    if (installed && packages.length) packages[packages.length - 1].path = installed[1];
    else if (source) packages.push({ source: source[1], filtered: !!source[2] });
  }
  return packages;
}

/**
 * Arguments for the pi.extensions setting. "all" adds none, so Pi loads what its settings configure. Otherwise
 * --no-extensions drops the user's extensions and packages, and only the listed packages load, by their install path:
 * `-e npm:<pkg>` would install a separate temporary copy. A listed package that is missing, not installed or filtered
 * refuses the launch rather than give the node fewer or more tools than the setting says.
 */
export function piExtensionArgs(setting: LaunchInput['piExtensions'], cwd: string, path: string): string[] {
  if (setting === undefined || setting === 'all') return [];
  const args = ['--no-extensions', ...PI_BUILTINS.flatMap((b) => ['--extension', b])];
  if (setting === 'none' || !setting.length) return args;
  const packages = piPackages(cwd, path);
  for (const source of setting) {
    const pkg = packages.findLast((p) => p.source === source);
    if (!pkg?.path) throw new Error(`pi.extensions lists ${source}, which is not an installed Pi package (see pi list); install it with pi install ${source} or remove it from pi.extensions`);
    if (pkg.filtered) throw new Error(`pi.extensions lists ${source}, whose Pi settings entry has filters tiller cannot apply; use a plain source in Pi's settings or remove it from pi.extensions`);
    args.push('--extension', pkg.path);
  }
  return args;
}

export const claudeAdapter: HarnessAdapter = {
  id: 'claude',
  capabilities: { fork: true, inbox: false },
  validate() {},
  launch: claudeLaunch,
  cwd: (n) => n.worktree?.repo ?? n.cwd,
  transcript: (n) => n.transcriptPath ?? (n.sessionId ? transcriptFor(n.cwd, n.sessionId) : undefined),
};

export const piAdapter: HarnessAdapter = {
  id: 'pi',
  capabilities: { fork: false, inbox: true },
  validate({ permissionMode, preset, piExtensions }) {
    if (permissionMode !== undefined) throw new Error('Pi does not support Claude permissionMode; omit it (Pi keeps its own permission policy)');
    if (preset?.maxTurns !== undefined) throw new Error('Pi has no equivalent of preset maxTurns; remove it to run this preset on Pi');
    if (preset) piToolArgs(preset, 'n-check');
    if (piExtensions) piExtensionArgs(piRestricted(preset) ? 'none' : piExtensions.setting, piExtensions.cwd, piExtensions.path);
  },
  launch(i) {
    this.validate({ permissionMode: i.permissionMode, preset: i.preset });
    if (i.forkSession) throw new Error('Pi session forking is not supported by this adapter');
    if (!i.sessionDir) throw new Error('Pi needs a persistent Tiller session directory');
    // Lives with the tree archive, not nodes/<id>, which close deletes.
    const path = i.transcriptPath ?? piTranscript(i.sessionDir, i.nodeId, i.sessionId);
    mkdirSync(join(i.sessionDir, 'agents', i.nodeId), { recursive: true, mode: 0o700 });
    const args = ['--session', path, '--name', i.title, ...piExtensionArgs(piRestricted(i.preset) ? 'none' : i.piExtensions, i.cwd, i.path), '--extension', piExtension,
      ...(i.preset ? piToolArgs(i.preset, i.nodeId) : []), '--append-system-prompt', systemPrompt(i)];
    if (i.model) args.push('--model', i.model);
    if (i.effort) args.push('--thinking', i.effort);
    if (i.prompt) args.push('--', i.prompt);
    return { file: 'pi', args, env: { ...nodeEnv(i), TL_HARNESS: 'pi', TL_SESSION_ID: i.sessionId, TL_PI_HOOK_TOOLS: '1' } };
  },
  cwd: (n) => n.cwd,
  prepareTranscript: preparePiTranscript,
  transcript: (n, sessionDir) => n.transcriptPath ?? (n.sessionId ? piTranscript(sessionDir, n.id, n.sessionId) : undefined),
};

export const codexAdapter: HarnessAdapter = {
  id: 'codex',
  capabilities: { fork: false, inbox: true },
  validate({ permissionMode, preset }) {
    if (permissionMode !== undefined) throw new Error('Codex does not support Claude permissionMode; omit it (Codex keeps its own approval and sandbox policy)');
    if (preset?.tools !== undefined || preset?.disallowedTools !== undefined || preset?.maxTurns !== undefined) {
      throw new Error('Codex does not support Claude preset tools, disallowedTools or maxTurns; use a prompt-only preset');
    }
  },
  launch(i) {
    this.validate({ permissionMode: i.permissionMode, preset: i.preset });
    if (i.forkSession) throw new Error('Codex session forking through spawn is not supported; use followup');
    if (!i.sessionDir) throw new Error('Codex needs a persistent Tiller session directory');
    if (i.effort && !isSupportedEffort('codex', i.effort)) throw new Error(`unsupported Codex effort: ${i.effort}`);
    const transcriptPath = i.transcriptPath ?? codexTranscript(i.sessionDir, i.nodeId, i.sessionId);
    return {
      file: process.execPath,
      args: ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../../adapters/codex/index.ts', import.meta.url)), JSON.stringify({
        transcriptPath, sessionId: i.sessionId, resume: !!i.resume, instructions: systemPrompt(i),
        prompt: i.prompt, model: i.model, effort: i.effort,
      })],
      env: { ...nodeEnv(i), TL_HARNESS: 'codex', TL_SESSION_ID: i.sessionId },
    };
  },
  cwd: (n) => n.cwd,
  prepareTranscript: prepareCodexTranscript,
  transcript: (n, dir) => n.transcriptPath ?? (n.sessionId ? codexTranscript(dir, n.id, n.sessionId) : undefined),
};

const adapters: Record<Harness, HarnessAdapter> = { claude: claudeAdapter, pi: piAdapter, codex: codexAdapter };
export function adapterFor(node: { kind: NodeRecord['kind']; harness?: Harness }): HarnessAdapter {
  const id = harnessFor(node), adapter = adapters[id];
  if (!adapter) throw new Error(`unsupported harness: ${id}`);
  return adapter;
}

/** Check the actual CLI, including Codex whose launch spec starts the Node bridge first. */
export function requireHarnessExecutable(harness: Harness, path: string): void {
  const found = path.split(delimiter).some((dir) => {
    try {
      const file = join(dir || '.', harness);
      accessSync(file, constants.X_OK);
      return statSync(file).isFile();
    } catch { return false; }
  });
  if (!found) throw new Error(`${harness} executable not found on the daemon PATH; install it before changing harness`);
}
