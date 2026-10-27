import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { SETTINGS_FIELDS, type ClaudeAccountsSave, type ClaudeConfigDirCheck, type SettingsScope, type SettingsSnapshot, type SettingsUpdate } from '../shared/settings.js';
import { canonicalProject, projectAccount } from './claude-accounts.js';
import { ConfigFile, DEFAULTS, claudeAccountListError, claudeAccountsError, configEntries, effectiveProfileEntries, loadConfig } from './config.js';
import type { NodeManager } from './manager.js';
import { expandHome, inside, readBody } from './util.js';

export class SettingsError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';
const keys = SETTINGS_FIELDS.map(f => f.key);
function validate(key: string, value: unknown): void {
  if (!keys.includes(key)) throw new SettingsError(400, `Unknown settings field: ${key}`);
  if (value === null) return;
  const data = key.split('.').reduceRight<unknown>((v, part) => ({ [part]: v }), value);
  const result = ConfigFile.safeParse(data);
  if (!result.success) throw new SettingsError(400, `${key}: ${result.error.issues.map(i => i.message).join('; ')}`);
}
function checkPath(path: string): void {
  for (const p of [dirname(path), path]) {
    try {
      const stat = fs.lstatSync(p);
      if (stat.isSymbolicLink() || (p === path ? !stat.isFile() : !stat.isDirectory())) throw new SettingsError(400, `Unsafe settings path: ${p}`);
    } catch (e) { if (!missing(e)) throw e; }
  }
}
function read(path: string): { raw: string | null; data: Record<string, unknown> } {
  checkPath(path);
  let raw: string;
  let fd: number | undefined;
  try {
    fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    if (!fs.fstatSync(fd).isFile()) throw new SettingsError(400, `Unsafe settings path: ${path}`);
    raw = fs.readFileSync(fd, 'utf8');
  } catch (e) { if (missing(e)) return { raw: null, data: {} }; throw e; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  let data: unknown;
  try { data = JSON.parse(raw); } catch { throw new SettingsError(422, `Malformed JSON in ${path}; repair the file before saving`); }
  if (!object(data)) throw new SettingsError(422, `Expected a JSON object in ${path}`);
  // Unknown fields are retained. Known groups must be objects so edits cannot silently replace them.
  for (const key of keys) {
    const parts = key.split('.');
    let parent: unknown = data;
    for (const part of parts.slice(0, -1)) {
      if (!object(parent) || !Object.hasOwn(parent, part)) break;
      parent = parent[part];
      if (!object(parent)) throw new SettingsError(422, `Invalid settings group in ${path}: ${key}`);
    }
  }
  return { raw, data };
}
const revision = (raw: string | null) => createHash('sha256').update(raw === null ? 'missing' : `file:${raw}`).digest('hex');
function flatten(data: Record<string, unknown>, prefix = ''): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).flatMap(([k, v]) => {
    const key = prefix + k;
    return object(v) ? Object.entries(flatten(v, key + '.')) : [[key, v]];
  }));
}
function target(manager: NodeManager, scope: SettingsScope, nodeId?: string) {
  if (scope !== 'project' && scope !== 'home') throw new SettingsError(400, 'scope must be project or home');
  let projectPath: string | null = null;
  if (nodeId !== undefined) {
    const node = manager.registry.get(nodeId);
    if (!node) throw new SettingsError(404, `No such node: ${nodeId}`);
    projectPath = fs.realpathSync(manager.projectDir(node));
  }
  if (scope === 'project' && !projectPath) throw new SettingsError(400, 'Project settings require nodeId');
  const home = fs.realpathSync(manager.home);
  return { path: scope === 'home' ? join(home, 'config.json') : join(projectPath!, '.tiller', 'config.json'), projectPath, homePath: join(home, 'config.json') };
}
export function settingsSnapshot(manager: NodeManager, scope: SettingsScope, nodeId?: string): SettingsSnapshot {
  const { path, projectPath, homePath } = target(manager, scope, nodeId);
  const layer = read(path);
  if (scope === 'project') read(homePath); // Fail clearly on unreadable or malformed inherited files.
  const home = dirname(homePath);
  const effective = configEntries(scope === 'project' ? projectPath : null, home);
  const below = scope === 'project' ? configEntries(null, home) : null;
  const inherited: SettingsSnapshot['inherited'] = {}, entries: SettingsSnapshot['entries'] = {};
  for (const key of keys) {
    const runtimeKey = key as keyof typeof effective;
    entries[key] = effective[runtimeKey];
    inherited[key] = below ? below[runtimeKey] : { value: (DEFAULTS as Record<string, unknown>)[key], source: 'default' };
  }
  // Reset removes only the profile leaf, retaining legacy overrides in this file.
  const resetEntries = { ...inherited };
  for (const [key, entry] of Object.entries(effective)) if (key.startsWith('roles.')) resetEntries[key] = entry;
  Object.assign(entries, effectiveProfileEntries(effective));
  for (const [key, entry] of Object.entries(effectiveProfileEntries(resetEntries))) if (key.startsWith('profiles.')) inherited[key] = entry;
  const values = flatten(layer.data);
  let claudeAccount: SettingsSnapshot['claudeAccount'] = { effective: entries['claude.account']?.value as string | undefined };
  if (scope === 'project') {
    // The repo's choice is the account listing its exact path in the home file; a repo file's own claude.account is never read.
    delete values['claude.account'];
    let resolved: { account?: string; project?: string } = {};
    try { resolved = projectAccount(home, projectPath!); } catch { /* an invalid list: the account views report it */ }
    const { account, project } = resolved;
    claudeAccount = { effective: account, ...(project ? { project } : {}) };
    if (project === projectPath) values['claude.account'] = account;
    entries['claude.account'] = { value: account, source: project || inherited['claude.account']?.value !== undefined ? homePath : 'default' };
  }
  return { scope, path, projectPath, revision: revision(layer.raw), values, entries, inherited, homeRevision: revision(read(homePath).raw), claudeAccount };
}

/**
 * Refuse a claude.account value that is not a configured account, or any while the account list is invalid. A claude.account
 * naming a deleted account does not block this, so Settings can replace or remove it.
 */
function checkAccount(home: string, value: unknown): void {
  if (value === null) return;
  const listError = claudeAccountListError(home);
  if (listError) throw new SettingsError(422, listError);
  const names = loadConfig(null, home).claude.accounts.map((a) => a.name);
  if (typeof value !== 'string' || !names.includes(value)) throw new SettingsError(400, `claude.account: ${JSON.stringify(value)} is not an account in claude.accounts (${join(home, 'config.json')})`);
}

/** List `project` (a real path) under `account`'s projects in home file data, and remove its exact entries from every other account. */
function moveProject(data: Record<string, unknown>, project: string, account: string | null): void {
  const accounts = ((data.claude as Record<string, unknown> | undefined)?.accounts ?? []) as { name: string; projects?: string[] }[];
  for (const a of accounts) if (a.projects) a.projects = a.projects.filter((p) => canonicalProject(p) !== project);
  if (account) (accounts.find((a) => a.name === account)!.projects ??= []).push(project);
}
export function updateSettings(manager: NodeManager, update: SettingsUpdate): SettingsSnapshot {
  const { scope, nodeId } = update, changes = { ...update.changes };
  const { path, projectPath, homePath } = target(manager, scope, nodeId);
  const before = read(path);
  if (scope === 'project') read(homePath); // Refuse an unreadable inherited layer before writing.
  if (revision(before.raw) !== update.revision) throw new SettingsError(409, 'Settings changed; reload before saving');
  // A repo's account is chosen in the home file (agents can edit the repo's), so it is checked against the home revision.
  let home: { data: Record<string, unknown>; revision: string } | undefined;
  if (Object.hasOwn(changes, 'claude.account')) {
    checkAccount(dirname(homePath), changes['claude.account']);
    if (scope === 'project') {
      const layer = read(homePath);
      if (update.homeRevision === undefined || revision(layer.raw) !== update.homeRevision) throw new SettingsError(409, 'Settings changed; reload before saving');
      moveProject(layer.data, projectPath!, changes['claude.account'] as string | null);
      home = { data: layer.data, revision: update.homeRevision };
      delete changes['claude.account'];
    }
  }
  for (const [key, value] of Object.entries(changes)) {
    if (scope === 'project' && key.startsWith('daemon.')) throw new SettingsError(400, 'daemon settings are home-only');
    validate(key, value);
  }
  for (const [key, value] of Object.entries(changes)) {
    const parts = key.split('.');
    let parent = before.data;
    for (const part of parts.slice(0, -1)) {
      if (!Object.hasOwn(parent, part)) parent[part] = {};
      parent = parent[part] as Record<string, unknown>;
    }
    if (value === null) delete parent[parts.at(-1)!];
    else parent[parts.at(-1)!] = value;
  }
  if (home) writeConfig(homePath, home.data, home.revision);
  if (!home || Object.keys(changes).length) writeConfig(path, before.data, update.revision);
  manager.refreshRepoAccounts();
  return settingsSnapshot(manager, scope, nodeId);
}

/**
 * Replace claude.accounts in the home file from the Settings form, creating the configDirs asked for. With none configured
 * this seeds the list and claude.account. Otherwise accounts are kept, added or removed by name: there is no rename, a kept
 * account keeps its projects (only its configDir may change), a new one has none, and claude.account's account stays.
 */
export function saveClaudeAccounts(manager: NodeManager, save: ClaudeAccountsSave): SettingsSnapshot {
  const { homePath } = target(manager, 'home');
  const before = read(homePath);
  if (revision(before.raw) !== save.revision) throw new SettingsError(409, 'Settings changed; reload before saving');
  const listError = claudeAccountListError(dirname(homePath));
  if (listError) throw new SettingsError(422, `${listError}; fix it in the file`);
  const claude = before.data.claude as Record<string, unknown> | undefined;
  const existing = (claude?.accounts ?? []) as { name: string; configDir?: string; projects?: string[] }[];
  // The form lists accounts from a WebSocket store, which can lag the HTTP revision: a list from before an added account is stale.
  const names = (list: string[]) => JSON.stringify([...list].sort());
  if (names(existing.map((a) => a.name)) !== names(save.openedWith)) throw new SettingsError(409, 'Settings changed; reload before saving');
  // Once accounts exist, a claude.account naming none of them is refused too (with none, the first save replaces it).
  const accountError = existing.length ? claudeAccountsError(dirname(homePath)) : undefined;
  if (accountError) throw new SettingsError(422, `${accountError}; fix it in the file`);
  const { account } = save.claudeAccounts, current = existing.length ? claude?.account : account;
  if (!existing.length && account === undefined) throw new SettingsError(400, 'claude.account: name the default account');
  if (existing.length && account !== undefined) throw new SettingsError(400, 'claude.account: change the default account with its own setting');
  if (existing.some((a) => a.name === current) && !save.claudeAccounts.accounts.some((a) => a.name === current)) throw new SettingsError(400, `${current} is the default account (claude.account); choose another default before removing it`);
  const accounts = save.claudeAccounts.accounts.map(({ name, configDir }) => {
    const old = existing.find((a) => a.name === name);
    if (old?.configDir && !configDir) throw new SettingsError(400, `${name}: keep a config directory; without one it would use Claude's default home (~/.claude) and its login`);
    // An unchanged directory keeps its spelling in the file (the form shows it expanded).
    const dir = configDir && old?.configDir && expandHome(configDir) === expandHome(old.configDir) ? old.configDir : configDir;
    return { name, ...(dir ? { configDir: dir } : {}), ...(old?.projects ? { projects: old.projects } : {}) };
  });
  const result = ConfigFile.safeParse({ claude: { accounts, account: current } });
  if (!result.success) throw new SettingsError(400, result.error.issues.map((i) => `${i.path.map(String).join('.')}: ${i.message}`).join('; '));
  if (account !== undefined && !accounts.some((a) => a.name === account)) throw new SettingsError(400, `claude.account: ${JSON.stringify(account)} is not one of the accounts`);
  // Only a new or changed directory is checked; a kept one may not exist yet (logged out).
  const dirs = save.claudeAccounts.accounts.flatMap((a, i) => (accounts[i].configDir && accounts[i].configDir !== existing.find((e) => e.name === a.name)?.configDir ? [{ dir: expandHome(accounts[i].configDir!), create: a.create }] : []));
  for (const { dir, create } of dirs) {
    const reserved = reservedConfigDir(manager, dir);
    if (reserved) throw new SettingsError(400, reserved);
    const stat = fs.statSync(dir, { throwIfNoEntry: false });
    if (stat ? !stat.isDirectory() : !create) throw new SettingsError(400, stat ? `${dir} is not a directory` : `${dir} does not exist; choose to create it`);
  }
  // ponytail: no rollback, so a 409/500 from writeConfig leaves the new (empty, 0700) directories behind; harmless on retry.
  for (const { dir, create } of dirs) if (create) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  before.data.claude = { ...claude, accounts, ...(account === undefined ? {} : { account }) };
  writeConfig(homePath, before.data, save.revision);
  manager.refreshRepoAccounts();
  return settingsSnapshot(manager, 'home');
}

/** Why `dir` (expanded) can never be an account's configDir, or undefined. */
function reservedConfigDir(manager: NodeManager, dir: string): string | undefined {
  // The schema compares strings; a symlink to ~/.claude is the same keychain mistake, and the Tiller home is not Claude's.
  // realpath.native gives each existing part its on-disk spelling (~/.CLAUDE is ~/.claude on macOS); a missing tail is
  // joined back onto the nearest existing ancestor, so a symlinked parent still resolves for a directory not yet created.
  const real = (p: string): string => {
    let tail: string[] = [], cur = resolve(p);
    for (;;) {
      try { return join(fs.realpathSync.native(cur), ...tail); } catch { if (dirname(cur) === cur) return resolve(p); tail = [basename(cur), ...tail]; cur = dirname(cur); }
    }
  };
  if (real(dir) === real(join(homedir(), '.claude'))) return `${dir} is Claude's default home (~/.claude); give that account no config directory`;
  if ([dir, real(dir)].some((d) => inside(d, real(manager.home)) || inside(d, resolve(manager.home)))) return `${dir} is inside the Tiller home; choose another directory`;
  return undefined;
}

/** What is at a prospective configDir, for the accounts form. Only stats. */
export function claudeConfigDirCheck(manager: NodeManager, path: string): ClaudeConfigDirCheck {
  if (!isAbsolute(path) && !path.startsWith('~/')) return { exists: false, directory: false, error: 'Use an absolute path or one starting with ~/' };
  const dir = expandHome(path), error = reservedConfigDir(manager, dir);
  let stat: fs.Stats | undefined;
  try { stat = fs.statSync(dir, { throwIfNoEntry: false }); } catch { /* unreadable: reported as missing; the save stats again */ }
  return { exists: !!stat, directory: !!stat?.isDirectory(), ...(error ? { error } : {}) };
}

/** Atomically replace `path` with `data`, unless the file no longer has `expected` revision. */
function writeConfig(path: string, data: Record<string, unknown>, expected: string): void {
  // Synchronous read/check/rename serializes this daemon's writers, including different HTTP requests.
  // External editors are detected up to the final check; portable rename has no cross-process CAS.
  fs.mkdirSync(dirname(path), { recursive: true });
  checkPath(path);
  const temp = join(dirname(path), `.config-${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(temp, 'wx', fs.existsSync(path) ? fs.statSync(path).mode & 0o777 : 0o600);
    fs.writeFileSync(fd, JSON.stringify(data, null, 2) + '\n');
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    if (revision(read(path).raw) !== expected) throw new SettingsError(409, 'Settings changed; reload before saving');
    fs.renameSync(temp, path);
  } finally {
    try { if (fd !== undefined) fs.closeSync(fd); }
    finally { try { fs.unlinkSync(temp); } catch (e) { if (!missing(e)) throw e; } }
  }
}
const selection = { scope: z.enum(['project', 'home']), nodeId: z.string().min(1).optional() };
const querySchema = z.object(selection).strict();
const dirQuerySchema = z.object({ claudeConfigDir: z.string().min(1) }).strict();
const updateSchema = z.object({ ...selection, revision: z.string().min(1), homeRevision: z.string().min(1).optional(), changes: z.record(z.string(), z.unknown()) }).strict();
const accountsSchema = z.object({
  scope: z.literal('home'), revision: z.string().min(1), openedWith: z.array(z.string()),
  claudeAccounts: z.object({ account: z.string().optional(), accounts: z.array(z.object({ name: z.string(), configDir: z.string().optional(), create: z.boolean().optional() }).strict()).min(1) }).strict(),
}).strict();
/** This route deliberately uses the admin bearer token alone, never node authentication or MCP. */
export function settingsApi(manager: NodeManager, isAdmin: (token: string) => boolean) {
  return async (req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> => {
    const reply = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body)); };
    if (!isAdmin(/^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '')) return reply(401, { error: 'Admin bearer token required' });
    try {
      if (req.method === 'GET') {
        const query = Object.fromEntries(url.searchParams);
        if (Object.hasOwn(query, 'claudeConfigDir')) return reply(200, claudeConfigDirCheck(manager, dirQuerySchema.parse(query).claudeConfigDir));
        const args = querySchema.parse(query);
        return reply(200, settingsSnapshot(manager, args.scope, args.nodeId));
      }
      if (req.method === 'POST') {
        const body = await readBody(req, res);
        if (body === undefined) return;
        let data: unknown;
        try { data = JSON.parse(body); } catch { throw new SettingsError(400, 'Expected JSON request body'); }
        if (object(data) && Object.hasOwn(data, 'claudeAccounts')) return reply(200, saveClaudeAccounts(manager, accountsSchema.parse(data)));
        return reply(200, updateSettings(manager, updateSchema.parse(data)));
      }
      res.setHeader('Allow', 'GET, POST');
      reply(405, { error: 'Method not allowed' });
    } catch (e) {
      reply(e instanceof SettingsError ? e.status : e instanceof z.ZodError ? 400 : 500, { error: e instanceof Error ? e.message : 'Settings read/write failed' });
    }
  };
}
