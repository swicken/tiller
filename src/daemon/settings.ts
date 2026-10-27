import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { SETTINGS_FIELDS, type SettingsScope, type SettingsSnapshot, type SettingsUpdate } from '../shared/settings.js';
import { canonicalProject, projectAccount } from './claude-accounts.js';
import { ConfigFile, DEFAULTS, claudeAccountListError, configEntries, effectiveProfileEntries, loadConfig } from './config.js';
import type { NodeManager } from './manager.js';
import { readBody } from './util.js';

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
  return settingsSnapshot(manager, scope, nodeId);
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
const updateSchema = z.object({ ...selection, revision: z.string().min(1), homeRevision: z.string().min(1).optional(), changes: z.record(z.string(), z.unknown()) }).strict();
/** This route deliberately uses the admin bearer token alone, never node authentication or MCP. */
export function settingsApi(manager: NodeManager, isAdmin: (token: string) => boolean) {
  return async (req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> => {
    const reply = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body)); };
    if (!isAdmin(/^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '')) return reply(401, { error: 'Admin bearer token required' });
    try {
      if (req.method === 'GET') {
        const args = querySchema.parse(Object.fromEntries(url.searchParams));
        return reply(200, settingsSnapshot(manager, args.scope, args.nodeId));
      }
      if (req.method === 'POST') {
        const body = await readBody(req, res);
        if (body === undefined) return;
        let data: unknown;
        try { data = JSON.parse(body); } catch { throw new SettingsError(400, 'Expected JSON request body'); }
        const args = updateSchema.parse(data);
        return reply(200, updateSettings(manager, args));
      }
      res.setHeader('Allow', 'GET, POST');
      reply(405, { error: 'Method not allowed' });
    } catch (e) {
      reply(e instanceof SettingsError ? e.status : e instanceof z.ZodError ? 400 : 500, { error: e instanceof Error ? e.message : 'Settings read/write failed' });
    }
  };
}
