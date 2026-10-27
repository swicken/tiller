// Memory opt-in (docs/memory.md): off unless the human opts in from the home file, globally, per account or per project.
import { join } from 'node:path';
import { canonicalProject } from './claude-accounts.js';
import { ConfigFile, claudeAccountListError, configEntries, configPaths, loadConfig } from './config.js';
import { SettingsError, read, revision, writeConfig } from './settings.js';
import { inside } from './util.js';

/** Whether memory is on, and the setting that decided it (`default` when none did), so errors and status can say why. */
export interface MemoryOn { on: boolean; source: string }

/**
 * Whether memory is on for a node in `projectDir` (null: none) running in `account`. First match decides:
 * 1. the project file sets memory.enabled false (a project may only turn memory down);
 * 2. the account has memory false, a ceiling no memory.projects entry lifts. An undefined account means claude.account's,
 *    else there is no account step; a named account fails closed (off) while claude.accounts is invalid or lacks it;
 * 3. the longest memory.projects entry containing the project;
 * 4. the account has memory true;
 * 5. the home file's memory.enabled, else off.
 * Never throws: memory never blocks a launch.
 */
export function memoryOn(home: string, projectDir: string | null, account: string | undefined): MemoryOn {
  const homeFile = join(home, 'config.json'), enabled = configEntries(projectDir, home)['memory.enabled'];
  if (projectDir !== null && enabled.source === configPaths(projectDir, home)[0] && enabled.value === false) return { on: false, source: `memory.enabled in ${enabled.source}` };
  const config = loadConfig(null, home), name = account ?? config.claude.account;
  let entry: { name: string; memory?: boolean } | undefined;
  if (name !== undefined) {
    const listError = claudeAccountListError(home);
    if (listError) return { on: false, source: listError };
    entry = config.claude.accounts.find((a) => a.name === name);
    if (!entry) return { on: false, source: `Claude account "${name}" is not configured in ${homeFile} (claude.accounts)` };
  }
  const accountSource = `claude.accounts ${name}.memory in ${homeFile}`;
  if (entry?.memory === false) return { on: false, source: accountSource };
  if (projectDir !== null) {
    const at = canonicalProject(projectDir);
    let best: { path: string; enabled: boolean } | undefined;
    for (const p of config.memory.projects) {
      const path = canonicalProject(p.path);
      if (inside(at, path) && path.length > (best?.path.length ?? -1)) best = { path, enabled: p.enabled };
    }
    if (best) return { on: best.enabled, source: `memory.projects ${best.path} in ${homeFile}` };
  }
  if (entry?.memory === true) return { on: true, source: accountSource };
  return { on: config.memory.enabled, source: enabled.source === homeFile ? `memory.enabled in ${homeFile}` : 'default' };
}

export type MemorySetting = 'on' | 'off' | 'inherit';
/** What `tl memory on|off|inherit` changes: an account's memory, a project's memory.projects entry, or neither (memory.enabled). */
interface SwitchTarget { account?: string; project?: string }

/**
 * Apply one memory opt-in to home file `data` in place, validating it: `inherit` removes the setting. A project's entry
 * replaces its exact-path entries, as Settings does for an account's projects. Shared by `tl memory` and Settings, so both
 * write the same bytes.
 */
export function applyMemorySetting(data: Record<string, unknown>, home: string, target: SwitchTarget, value: MemorySetting): void {
  if (target.account !== undefined && target.project !== undefined) throw new SettingsError(400, 'Choose an account or a project, not both');
  const path = join(home, 'config.json');
  const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
  const group = (key: string) => {
    if (data[key] === undefined) data[key] = {};
    if (!object(data[key])) throw new SettingsError(422, `Invalid settings group in ${path}: ${key}`);
    return data[key];
  };
  if (target.account !== undefined) {
    const listError = claudeAccountListError(home);
    if (listError) throw new SettingsError(422, listError);
    const accounts = group('claude').accounts as Record<string, unknown>[] | undefined;
    const account = accounts?.find((a) => a.name === target.account);
    if (!account) throw new SettingsError(400, `Claude account "${target.account}" is not configured in ${path} (claude.accounts)`);
    if (value === 'inherit') delete account.memory;
    else account.memory = value === 'on';
  } else {
    const memory = group('memory');
    if (target.project !== undefined) {
      const project = canonicalProject(target.project), projects = memory.projects ?? [];
      if (!Array.isArray(projects)) throw new SettingsError(422, `Invalid memory.projects in ${path}`);
      memory.projects = projects.filter((p) => !(object(p) && typeof p.path === 'string' && canonicalProject(p.path) === project));
      if (value !== 'inherit') (memory.projects as unknown[]).push({ path: project, enabled: value === 'on' });
    } else if (value === 'inherit') delete memory.enabled;
    else memory.enabled = value === 'on';
    const r = ConfigFile.shape.memory.safeParse(memory);
    if (!r.success) throw new SettingsError(422, `memory in ${path} is invalid: ${r.error.issues.map((i) => `${['memory', ...i.path].join('.')}: ${i.message}`).join('; ')}`);
  }
}

/** Set or remove (inherit) one memory opt-in in the home file, with Settings' atomic writer: a concurrent edit fails with 409. */
export function switchMemory(home: string, target: SwitchTarget, value: MemorySetting): void {
  const path = join(home, 'config.json'), { raw, data } = read(path);
  applyMemorySetting(data, home, target, value);
  writeConfig(path, data, revision(raw));
}
