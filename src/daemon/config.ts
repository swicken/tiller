// Per-project settings: <cwd>/.tiller/config.json, then <home>/config.json, then built-in defaults. Read fresh on every call.
// The `daemon` group, `claude.accounts` and `claude.account` come from the home file only. A project file may only make `approvals` stricter.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { HARNESSES, PROFILES, isSupportedEffort } from '../shared/harness-policy.js';
import { EFFORTS, ISOLATIONS, type Harness, type Profile, type Role } from '../shared/protocol.js';
import { CLAUDE_ACCOUNT_NAME, CLAUDE_ACCOUNT_NAME_RULE, SETTINGS_PROFILE_DEFAULTS, type SettingsEntry } from '../shared/settings.js';
import { homeDir } from './home.js';
import { expandHome } from './util.js';

export const MERGE_STYLES = ['merge', 'squash', 'ff-only'] as const;
export type MergeStyle = (typeof MERGE_STYLES)[number];
export const NOTIFY_LEVELS = ['banner', 'sound', 'silent'] as const;
export type NotifyLevel = (typeof NOTIFY_LEVELS)[number];
/** "HH:MM-HH:MM", local time; the end may be earlier than the start (across midnight). */
const QUIET_HOURS = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;

const RoleDefaults = z.object({ model: z.string().min(1).optional(), effort: z.enum(EFFORTS).optional() }).strict();
const ProfileDefaults = z.object(Object.fromEntries(
  PROFILES.map((profile) => [profile, RoleDefaults.optional()]),
) as Record<Profile, z.ZodOptional<typeof RoleDefaults>>).strict();
const CodexProfileDefaults = ProfileDefaults.superRefine((profiles, ctx) => {
  for (const [profile, defaults] of Object.entries(profiles)) {
    if (defaults?.effort && !isSupportedEffort('codex', defaults.effort)) ctx.addIssue({ code: 'custom', path: [profile, 'effort'], message: 'unsupported Codex effort: max (use low, medium, high or xhigh)' });
  }
});
const Level = z.enum(NOTIFY_LEVELS).optional();
const AccountPath = z.string().refine((p) => isAbsolute(p) || p.startsWith('~/'), 'must be absolute or start with ~/');
const AccountName = z.string().regex(CLAUDE_ACCOUNT_NAME, CLAUDE_ACCOUNT_NAME_RULE);
/** Home file only: Claude accounts, each a CLAUDE_CONFIG_DIR. No configDir means Claude's default home (at most one). */
const ClaudeAccounts = z.array(z.object({
  name: AccountName,
  configDir: AccountPath.optional(),
  /** Root nodes whose project is inside one of these run in this account (the longest match wins; Settings writes a repo's exact path). */
  projects: z.array(AccountPath).optional(),
}).strict()).superRefine((accounts, ctx) => {
  const names = new Set<string>(), dirs = new Set<string>();
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  for (const a of accounts) {
    if (names.has(a.name)) issue(`duplicate account name ${a.name}`);
    names.add(a.name);
    if (!a.configDir) continue;
    const dir = expandHome(a.configDir);
    // Claude keys its keychain item by the CLAUDE_CONFIG_DIR string, so naming its default home would be a different login.
    if (dir === join(homedir(), '.claude')) issue(`account ${a.name}: omit configDir for Claude's default home (~/.claude)`);
    if (dirs.has(dir)) issue(`account ${a.name}: another account already uses ${a.configDir}`);
    dirs.add(dir);
  }
  if (accounts.filter((a) => !a.configDir).length > 1) issue('at most one account may omit configDir (Claude\'s default home)');
});
export const ConfigFile = z.object({
  /** Per-harness task profile defaults; unset preserves the harness's own defaults. */
  profiles: z.object({ claude: ProfileDefaults.optional(), codex: CodexProfileDefaults.optional(), pi: ProfileDefaults.optional() }).strict().optional(),
  /** model and effort for a claude node spawned without them, by role (none counts as worker). */
  roles: z.object({ orchestrator: RoleDefaults.optional(), worker: RoleDefaults.optional() }).strict().optional(),
  /**
   * inheritMcpServers: a Claude node also loads the user's and plugins' MCP servers; the project's .mcp.json servers stay off. False gives it only tiller's.
   * accounts (home file only): see ClaudeAccounts and docs/harnesses.md. account (home file only): the default account, by
   * name, for a root node whose project no account lists; unset means none (Claude's default home, no account).
   */
  claude: z.object({ inheritMcpServers: z.boolean().optional(), accounts: ClaudeAccounts.optional(), account: AccountName.optional() }).strict().optional(),
  /**
   * extensions: which of the user's Pi extensions a Pi node loads besides tiller's adapter. "all" is what Pi's settings
   * configure; "none" is no others; a list loads only those package sources, as written in Pi's settings.
   */
  pi: z.object({
    extensions: z.union([z.enum(['all', 'none']), z.array(z.string().min(1)).refine((l) => !l.includes('all') && !l.includes('none'), 'use "all" or "none" alone, not in a list')]).optional(),
  }).strict().optional(),
  /**
   * When an agent's action skips the human's approval. close: "always"; "done" when every node in the batch is done, has
   * exited or has reported an outcome; "never". merge: true means an agent's merge never asks.
   */
  approvals: z.object({ close: z.enum(['never', 'done', 'always']).optional(), merge: z.boolean().optional() }).strict().optional(),
  /**
   * isolation: what a spawn that omits it gets, for claude nodes whose role is worker or none.
   * branchPrefix: a worktree's branch is <prefix><nodeId>. include: gitignored files to copy in; absent means .worktreeinclude.
   * mergeStyle: how the merge verb brings a branch into its base.
   * setup, teardown: shell commands run in a new worktree before launch, and in a worktree before it is removed.
   * protected: branches merge refuses as a base (origin's default branch counts too; [] protects nothing). A worker spawned without a base
   * from one of them, or from a detached HEAD, gets a new base branch named by taskBranch, {slug} from its title.
   */
  worktrees: z.object({
    isolation: z.enum(ISOLATIONS).optional(),
    branchPrefix: z.string().min(1).optional(),
    include: z.array(z.string().min(1)).optional(),
    mergeStyle: z.enum(MERGE_STYLES).optional(),
    setup: z.array(z.string().min(1)).optional(),
    teardown: z.array(z.string().min(1)).optional(),
    protected: z.array(z.string().min(1)).optional(),
    taskBranch: z.string().regex(/\{slug\}/, 'must contain {slug}').optional(),
  }).strict().optional(),
  /**
   * A command that must pass before a worker's report_outcome "succeeded" is accepted; absent means no gate. Once it has
   * failed retries + 1 times the outcome is recorded as failed. Each run is stopped after timeoutMinutes.
   */
  gate: z.object({
    command: z.string().min(1).optional(),
    retries: z.number().int().nonnegative().optional(),
    timeoutMinutes: z.number().positive().optional(),
  }).strict().optional(),
  /**
   * Home file only. resumeOnStart: on start, resume the nodes that were live when the daemon last went away, unless idle for
   * more than resumeMaxAgeDays. sessionsKeepDays: a session directory is deleted this long after its root closed (or, with
   * the root gone, after its last write). digestAfterMinutes: a client regaining focus after this long with no focused
   * client gets an away digest. maxLiveNodes: an agent's spawn is refused once this many nodes are live. maxWorking: Claude
   * nodes working at once; past it a spawn is queued and launched in creation order as nodes stop; 0 is unlimited.
   */
  daemon: z.object({
    resumeOnStart: z.boolean().optional(),
    resumeMaxAgeDays: z.number().nonnegative().optional(),
    sessionsKeepDays: z.number().nonnegative().optional(),
    digestAfterMinutes: z.number().nonnegative().optional(),
    maxLiveNodes: z.number().int().nonnegative().optional(),
    maxWorking: z.number().int().nonnegative().optional(),
  }).strict().optional(),
  /**
   * kinds: how each notify kind is shown; sound means a banner with a sound.
   * treeDoneSummary: once all agents finish, with no pending launches or unresolved gates, one tree notification
   * replaces per-agent done and exited notifications. quietHours: everything is silent then, except needsYou, which is a banner without sound.
   */
  notifications: z.object({
    kinds: z.object({ needsYou: Level, done: Level, errored: Level, exited: Level }).strict().optional(),
    treeDoneSummary: z.boolean().optional(),
    quietHours: z.string().regex(QUIET_HOURS, 'expected "HH:MM-HH:MM"').optional(),
  }).strict().optional(),
  /**
   * Guardrails for unattended agents; the human is exempt from the spawn caps. maxDepth: levels below the root a spawned node
   * may sit at (a root is level 0). maxChildren: live children per node. stallMinutes: a working node with no hook event
   * this long gets a notice to its parent. maxMessagesPer10Min: messages one sender may send one target in 10 minutes.
   */
  limits: z.object({
    maxDepth: z.number().int().nonnegative().optional(),
    maxChildren: z.number().int().nonnegative().optional(),
    stallMinutes: z.number().positive().optional(),
    maxMessagesPer10Min: z.number().int().positive().optional(),
  }).strict().optional(),
}).strict();
type ConfigFile = z.infer<typeof ConfigFile>;

type Leaf = string | number | boolean | unknown[];
/** [dotted path, value] for every leaf of T. */
type Entries<T, P extends string = ''> = { [K in keyof T & string]-?: NonNullable<T[K]> extends Leaf ? [`${P}${K}`, T[K]] : Entries<NonNullable<T[K]>, `${P}${K}.`> }[keyof T & string];
type Flat = { [E in Entries<ConfigFile> as E[0]]: E[1] };
export type Key = keyof Flat;

/** Every key of the schema with its built-in default; undefined means none. Adding a key is a schema line and a line here. */
export const DEFAULTS = {
  'profiles.claude.orchestrator.model': undefined, 'profiles.claude.orchestrator.effort': undefined,
  'profiles.claude.implementation.model': undefined, 'profiles.claude.implementation.effort': undefined,
  'profiles.claude.explorer.model': undefined, 'profiles.claude.explorer.effort': undefined,
  'profiles.claude.mechanical.model': undefined, 'profiles.claude.mechanical.effort': undefined,
  'profiles.claude.reviewer.model': undefined, 'profiles.claude.reviewer.effort': undefined,
  'profiles.codex.orchestrator.model': undefined, 'profiles.codex.orchestrator.effort': undefined,
  'profiles.codex.implementation.model': undefined, 'profiles.codex.implementation.effort': undefined,
  'profiles.codex.explorer.model': undefined, 'profiles.codex.explorer.effort': undefined,
  'profiles.codex.mechanical.model': undefined, 'profiles.codex.mechanical.effort': undefined,
  'profiles.codex.reviewer.model': undefined, 'profiles.codex.reviewer.effort': undefined,
  'profiles.pi.orchestrator.model': undefined, 'profiles.pi.orchestrator.effort': undefined,
  'profiles.pi.implementation.model': undefined, 'profiles.pi.implementation.effort': undefined,
  'profiles.pi.explorer.model': undefined, 'profiles.pi.explorer.effort': undefined,
  'profiles.pi.mechanical.model': undefined, 'profiles.pi.mechanical.effort': undefined,
  'profiles.pi.reviewer.model': undefined, 'profiles.pi.reviewer.effort': undefined,
  'roles.orchestrator.model': undefined, 'roles.orchestrator.effort': undefined, 'roles.worker.model': undefined, 'roles.worker.effort': undefined,
  'claude.inheritMcpServers': true, 'claude.accounts': [], 'claude.account': undefined,
  'pi.extensions': 'all',
  'approvals.close': 'never', 'approvals.merge': false,
  'worktrees.isolation': 'none', 'worktrees.branchPrefix': 'tl/', 'worktrees.include': undefined, 'worktrees.mergeStyle': 'merge', 'worktrees.setup': [], 'worktrees.teardown': [],
  'worktrees.protected': ['main', 'master'], 'worktrees.taskBranch': 'tl/{slug}',
  'gate.command': undefined, 'gate.retries': 2, 'gate.timeoutMinutes': 10,
  'daemon.resumeOnStart': true, 'daemon.resumeMaxAgeDays': 3, 'daemon.sessionsKeepDays': 14, 'daemon.digestAfterMinutes': 10, 'daemon.maxLiveNodes': 20, 'daemon.maxWorking': 0,
  'notifications.kinds.needsYou': 'sound', 'notifications.kinds.errored': 'silent', 'notifications.kinds.done': 'banner', 'notifications.kinds.exited': 'silent',
  'notifications.treeDoneSummary': true, 'notifications.quietHours': undefined,
  'limits.maxDepth': 3, 'limits.maxChildren': 8, 'limits.stallMinutes': 5, 'limits.maxMessagesPer10Min': 20,
} satisfies Flat;

type Defaulted = { [K in Key]: (typeof DEFAULTS)[K] extends undefined ? never : K }[Key];
/** The leaves of T (at path prefix P) that have no default. */
type NoDefault<T, P extends string> = { [K in keyof T & string]: NonNullable<T[K]> extends Leaf ? (`${P}${K}` extends Defaulted ? never : K) : never }[keyof T & string];
/** T with every group present and every leaf that has a default required; the others stay optional. */
type Filled<T, P extends string = ''> =
  & { [K in Exclude<keyof T & string, NoDefault<T, P>>]-?: NonNullable<T[K]> extends Leaf ? NonNullable<T[K]> : Filled<NonNullable<T[K]>, `${P}${K}.`> }
  & { [K in NoDefault<T, P>]?: T[K] };
type Resolved = Filled<ConfigFile>;
export type Notifications = Resolved['notifications'];
/** gate is present only when gate.command is set. */
export type Config = Omit<Resolved, 'gate'> & { gate?: Resolved['gate'] & { command: string } };

/** The project file for `cwd` (none when null), then the home file; earlier wins. */
export const configPaths = (cwd: string | null, home = homeDir()): string[] => [...(cwd === null ? [] : [join(cwd, '.tiller', 'config.json')]), join(home, 'config.json')];

const warned = new Set<string>();
const warn = (path: string, msg: string) => {
  if (!warned.has(`${path}\0${msg}`)) { warned.add(`${path}\0${msg}`); console.error(`tiller: ignoring in ${path}: ${msg}`); }
};
const get = (o: unknown, path: PropertyKey[]): any => path.reduce<any>((x, k) => x?.[k], o);

/** A file's settings. An unreadable file gives none; a bad key (unknown, renamed or invalid) is logged once and dropped. */
function readLayer(path: string, isHome: boolean): ConfigFile | undefined {
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); } catch { return undefined; } // absent: nothing to say
  let data: any;
  try { data = JSON.parse(raw); } catch (err) { warn(path, (err as Error).message); return undefined; }
  const bad: string[] = [];
  if (!isHome && data?.daemon !== undefined) { delete data.daemon; bad.push('daemon: read from the home file only'); }
  for (const key of ['accounts', 'account'] as const) {
    if (!isHome && data?.claude?.[key] !== undefined) { delete data.claude[key]; bad.push(`claude.${key}: read from the home file only`); }
  }
  const r = ConfigFile.safeParse(data);
  if (!r.success) {
    for (const i of r.error.issues) {
      // A bad list element drops the whole list: deleting the element alone would leave a hole that fails again.
      const element = i.path.findIndex((k) => typeof k === 'number'), key = element < 0 ? i.path : i.path.slice(0, element);
      for (const p of i.code === 'unrecognized_keys' ? i.keys.map((k) => [...i.path, k]) : [key]) {
        bad.push(`${p.map(String).join('.')}: ${i.code === 'unrecognized_keys' ? 'unknown key' : i.message}`);
        const parent = get(data, p.slice(0, -1));
        if (p.length && parent && typeof parent === 'object') delete parent[p.at(-1)!];
      }
    }
  }
  if (bad.length) warn(path, bad.join('; '));
  return r.success ? r.data : ConfigFile.safeParse(data).data;
}

/**
 * How strict each approvals value is: higher asks the human more often. An agent can edit its project file, so a project
 * value applies only when it is at least as strict as the home file's value, or the default when home does not set it.
 */
const STRICTNESS: Partial<Record<Key, (value: unknown) => number>> = {
  'approvals.close': (value) => ['always', 'done', 'never'].indexOf(value as string),
  'approvals.merge': (value) => (value ? 0 : 1),
};

/** Each key's effective value and where it came from: the first file that sets it, else 'default'. */
export function configEntries(cwd: string | null, home = homeDir()): Record<Key, { value: unknown; source: string }> {
  const homeFile = join(home, 'config.json');
  const layers = configPaths(cwd, home).flatMap((path) => { const c = readLayer(path, path === homeFile); return c ? [{ path, c }] : []; });
  return Object.fromEntries((Object.entries(DEFAULTS) as [Key, unknown][]).map(([key, fallback]) => {
    const path = key.split('.');
    let set = layers.filter(({ c }) => get(c, path) !== undefined).map((layer) => ({ value: get(layer.c, path), source: layer.path }));
    const strictness = STRICTNESS[key];
    if (strictness && set[0] && set[0].source !== homeFile) {
      const limit = set[1] ?? { value: fallback, source: 'default' };
      if (strictness(set[0].value) < strictness(limit.value)) {
        const [value, instead] = [JSON.stringify(set[0].value), JSON.stringify(limit.value)];
        warn(set[0].source, `${key}: ${value} asks the human less often than allowed, so ${instead} (${limit.source === 'default' ? 'the default' : `from ${homeFile}`}) applies instead. `
          + `A project file may only make approvals stricter, because agents can edit it; to allow ${value}, set ${key} to ${value} in ${homeFile}`);
        set = set.slice(1);
      }
    }
    return [key, set[0] ?? { value: fallback, source: 'default' }];
  })) as Record<Key, { value: unknown; source: string }>;
}

/** Display profile values for the usual role, without feeding legacy or built-in
 * values back into loadConfig (which must still support an explicit spawn role).
 */
export function effectiveProfileEntries(entries: Record<string, SettingsEntry>): Record<string, SettingsEntry> {
  const resolved = { ...entries };
  for (const harness of HARNESSES) for (const profile of PROFILES) {
    const role = profile === 'orchestrator' ? 'orchestrator' : 'worker';
    for (const leaf of ['model', 'effort'] as const) {
      const key = `profiles.${harness}.${profile}.${leaf}`;
      const legacy = harness === 'claude' ? entries[`roles.${role}.${leaf}`] : undefined;
      resolved[key] = entries[key]?.value !== undefined ? entries[key] : legacy?.value !== undefined ? legacy : { value: SETTINGS_PROFILE_DEFAULTS[harness][profile][leaf], source: 'default' };
    }
  }
  return resolved;
}

/**
 * Why the home file's claude.accounts or claude.account is invalid, or undefined. loadConfig drops an invalid value, but then
 * a project mapped to one account would silently run in Claude's default home, so callers that pick an account fail closed on this instead.
 */
export function claudeAccountsError(home = homeDir()): string | undefined {
  const path = join(home, 'config.json'), claude = homeClaude(path), listError = accountListError(path, claude?.accounts);
  if (listError) return listError;
  const account = claude?.account;
  if (account !== undefined && !(Array.isArray(claude?.accounts) && claude.accounts.some((a: { name?: unknown }) => a?.name === account))) {
    return `claude.account in ${path} names ${JSON.stringify(account)}, which is not an account in claude.accounts`;
  }
  return undefined;
}

/** Why the home file's claude.accounts list itself is invalid, or undefined (claude.account aside). */
export function claudeAccountListError(home = homeDir()): string | undefined {
  const path = join(home, 'config.json');
  return accountListError(path, homeClaude(path)?.accounts);
}

function accountListError(path: string, accounts: unknown): string | undefined {
  if (accounts === undefined) return undefined;
  const r = ClaudeAccounts.safeParse(accounts);
  return r.success ? undefined : `claude.accounts in ${path} is invalid: ${r.error.issues.map((i) => `${['claude', 'accounts', ...i.path].join('.')}: ${i.message}`).join('; ')}`;
}

/** The home file's claude group; none when absent or not JSON (readLayer warns about that). */
function homeClaude(path: string): { accounts?: unknown; account?: unknown } | undefined {
  try { return JSON.parse(readFileSync(path, 'utf8'))?.claude; } catch { return undefined; }
}

export function loadConfig(cwd: string | null, home = homeDir()): Config {
  const config: any = {};
  for (const [key, { value }] of Object.entries(configEntries(cwd, home))) {
    const path = key.split('.');
    path.slice(0, -1).reduce((o, k) => (o[k] ??= {}), config)[path.at(-1)!] = value;
  }
  const { gate, ...rest } = config as Resolved;
  return gate.command ? { ...rest, gate: gate as Config['gate'] } : rest;
}

/** Profile settings win per field over legacy role settings, which apply to Claude only. */
export function profileDefaults(config: Config, harness: Harness, profile: Profile, role: Role) {
  const selected = config.profiles[harness][profile];
  const legacy = harness === 'claude' ? config.roles[role === 'orchestrator' ? 'orchestrator' : 'worker'] : {};
  const fallback = SETTINGS_PROFILE_DEFAULTS[harness][profile];
  return { model: selected.model ?? legacy.model ?? fallback.model, effort: selected.effort ?? legacy.effort ?? fallback.effort };
}
