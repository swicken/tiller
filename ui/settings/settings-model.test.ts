import { describe, expect, it } from 'vitest';
import type { ClaudeAccountView } from '../../src/shared/protocol';
import { accountsError, accountStatus, buildChanges, cliStatus, fieldPreview, groups, isMemoryChoice, memoryChoices, memoryFields, memoryStatus, profileFields, staleDrafts, type SettingsSnapshot } from './settings-model';
const snapshot: SettingsSnapshot = { scope: 'project', path: '/tmp/project/.tiller/config.json', projectPath: '/tmp/project', revision: 'a', values: { 'limits.maxDepth': 3, 'worktrees.include': ['local'], 'approvals.merge': true }, entries: {}, inherited: {} };
const fields = [...groups.flatMap((g) => g.fields), ...profileFields('codex')];
describe('settings drafts', () => {
  it('leaves inherited and untouched fields absent', () => {
    expect(buildChanges(snapshot, {}, fields)).toEqual({});
    expect(buildChanges(snapshot, { 'profiles.codex.explorer.model': null }, fields)).toEqual({});
  });
  it('resets only an explicit local value and preserves empty lists and false', () => {
    expect(buildChanges(snapshot, { 'limits.maxDepth': null, 'worktrees.include': '', 'approvals.merge': 'false' }, fields)).toEqual({ 'limits.maxDepth': null, 'worktrees.include': [], 'approvals.merge': false });
  });
  it('omits unchanged values and converts numeric drafts', () => {
    expect(buildChanges(snapshot, { 'limits.maxDepth': '3' }, fields)).toEqual({});
    expect(buildChanges(snapshot, { 'limits.maxDepth': '0' }, fields)).toEqual({ 'limits.maxDepth': 0 });
  });
  it('rejects empty or nonfinite numeric drafts before sending', () => {
    for (const value of ['', 'abc', 'Infinity']) expect(() => buildChanges(snapshot, { 'limits.maxDepth': value }, fields)).toThrow('enter a number');
  });
  it('saves a single all or none line of pi.extensions as that word, and anything else as a list', () => {
    expect(buildChanges(snapshot, { 'pi.extensions': 'none' }, fields)).toEqual({ 'pi.extensions': 'none' });
    expect(buildChanges(snapshot, { 'pi.extensions': 'npm:a\nnpm:b' }, fields)).toEqual({ 'pi.extensions': ['npm:a', 'npm:b'] });
    expect(() => buildChanges(snapshot, { 'pi.extensions': 'all\nnpm:a' }, fields)).toThrow('put all on its own');
    expect(() => buildChanges(snapshot, { 'pi.extensions': 'npm:a\n none' }, fields)).toThrow('put none on its own');
    expect(buildChanges(snapshot, { 'pi.extensions': '' }, fields)).toEqual({ 'pi.extensions': [] }); // an empty list loads none
  });
  it('keeps model IDs literal and rejects blank strings without treating them as resets', () => {
    expect(buildChanges(snapshot, { 'profiles.codex.explorer.model': 'model/custom-id' }, fields)).toEqual({ 'profiles.codex.explorer.model': 'model/custom-id' });
    expect(() => buildChanges(snapshot, { 'profiles.codex.explorer.model': '' }, fields)).toThrow('use the inherited default');
  });
});

describe('CLI executable status', () => {
  it('keeps unknown and absent distinct from detected executables', () => {
    expect(cliStatus()).toBe('Unknown');
    expect(cliStatus({ installed: null, executableStatus: 'unknown' })).toBe('Unknown');
    expect(cliStatus({ installed: false })).toBe('Not detected');
    expect(cliStatus({ installed: true })).toBe('Detected · check unknown');
  });
  it('shows a broken version check separately from missing installation', () => {
    expect(cliStatus({ installed: true, executableStatus: 'broken' })).toBe('Detected · version check failed');
    expect(cliStatus({ installed: true, executableStatus: 'ready' })).toBe('Detected · ready');
  });
});


describe('Claude previews with pending legacy role edits', () => {
  const implementationModel = profileFields('claude').find((field) => field.key === 'profiles.claude.implementation.model')!;
  const explorerModel = profileFields('claude').find((field) => field.key === 'profiles.claude.explorer.model')!;
  const implementationEffort = profileFields('claude').find((field) => field.key === 'profiles.claude.implementation.effort')!;
  // Global worker=sonnet; repository worker=opus; repository profile=custom.
  const state: SettingsSnapshot = { ...snapshot, values: { 'roles.worker.model': 'opus', [implementationModel.key]: 'custom' }, entries: { [implementationModel.key]: { value: 'custom', source: snapshot.path }, [explorerModel.key]: { value: 'opus', source: snapshot.path }, [implementationEffort.key]: { value: 'high', source: '/home/config.json' } }, inherited: { [implementationModel.key]: { value: 'opus', source: snapshot.path } } };
  it('withholds reset and untouched fallback predictions rather than showing the old opus value', () => {
    const drafts = { [implementationModel.key]: null, 'roles.worker.model': 'haiku' };
    for (const field of [implementationModel, explorerModel]) expect(fieldPreview(state, drafts, field)).toMatchObject({ previewUnavailable: true, entry: undefined, raw: '' });
    expect(fieldPreview(state, drafts, implementationEffort)).toMatchObject({ previewUnavailable: false, entry: { value: 'high' } });
    expect(buildChanges(state, drafts, [...profileFields('claude'), ...groups.flatMap((g) => g.fields)])).toEqual({ [implementationModel.key]: null, 'roles.worker.model': 'haiku' });
  });
  it('keeps explicit profile drafts and valid saved profile overrides independent of role changes', () => {
    expect(fieldPreview(state, { 'roles.worker.model': 'haiku' }, implementationModel)).toMatchObject({ previewUnavailable: false, entry: { value: 'custom' } });
    expect(fieldPreview(state, { [implementationModel.key]: 'sonnet', 'roles.worker.model': null }, implementationModel)).toMatchObject({ previewUnavailable: false, entry: { value: 'sonnet' } });
    expect(fieldPreview(state, { [implementationModel.key]: null, 'roles.worker.effort': 'low' }, implementationModel)).toMatchObject({ previewUnavailable: false, entry: { value: 'opus' } });
  });
});

describe('scope inheritance and reset previews', () => {
  const depth = fields.find((field) => field.key === 'limits.maxDepth')!;
  const include = fields.find((field) => field.key === 'worktrees.include')!;
  const merge = fields.find((field) => field.key === 'approvals.merge')!;
  const state: SettingsSnapshot = {
    ...snapshot,
    values: { 'limits.maxDepth': 0, 'worktrees.include': [], 'approvals.merge': false },
    entries: {
      'limits.maxDepth': { value: 0, source: snapshot.path },
      'worktrees.include': { value: [], source: snapshot.path },
      'approvals.merge': { value: false, source: snapshot.path },
    },
    inherited: {
      'limits.maxDepth': { value: 5, source: '/home/config.json' },
      'worktrees.include': { value: ['.env', 'local/*'], source: '/home/config.json' },
      'approvals.merge': { value: true, source: 'default' },
    },
  };
  it('treats zero, false and empty arrays as explicit values with their own source', () => {
    for (const [field, raw] of [[depth, '0'], [include, ''], [merge, 'false']] as const) {
      expect(fieldPreview(state, {}, field)).toMatchObject({
        drafted: false, explicit: true, raw,
        entry: { value: state.values[field.key], source: state.path },
      });
    }
  });
  it('previews reset from the lower scope while leaving the saved snapshot intact', () => {
    const drafts = { [depth.key]: null, [include.key]: null, [merge.key]: null };
    for (const [field, raw] of [[depth, '5'], [include, '.env\nlocal/*'], [merge, 'true']] as const) {
      expect(fieldPreview(state, drafts, field)).toMatchObject({
        drafted: true, explicit: false, raw, entry: state.inherited[field.key],
      });
    }
    expect(buildChanges(state, drafts, fields)).toEqual(drafts);
    expect(state.values).toEqual({ 'limits.maxDepth': 0, 'worktrees.include': [], 'approvals.merge': false });
  });
  it('keeps an explicit override even when it matches the inherited value', () => {
    const inherited: SettingsSnapshot = { ...state, values: {}, entries: state.inherited };
    expect(fieldPreview(inherited, {}, depth)).toMatchObject({ explicit: false, raw: '5', entry: state.inherited[depth.key] });
    expect(buildChanges(inherited, { [depth.key]: '5' }, fields)).toEqual({ [depth.key]: 5 });
    expect(fieldPreview(inherited, { [depth.key]: '5' }, depth)).toMatchObject({
      explicit: true, drafted: true, raw: '5', entry: { value: '5', source: 'Unsaved change' },
    });
  });
  it('resets a global override to its built-in source', () => {
    const global: SettingsSnapshot = { ...state, scope: 'home', projectPath: null, path: '/home/config.json', inherited: { [depth.key]: { value: 3, source: 'default' } } };
    expect(fieldPreview(global, { [depth.key]: null }, depth)).toMatchObject({
      explicit: false, raw: '3', entry: { value: 3, source: 'default' },
    });
    expect(buildChanges(global, { [depth.key]: null }, fields)).toEqual({ [depth.key]: null });
  });
  it('represents absent harness defaults as unset rather than a literal value', () => {
    const effort = profileFields('pi').find((field) => field.key === 'profiles.pi.implementation.effort')!;
    const unset: SettingsSnapshot = { ...state, values: {}, entries: { [effort.key]: { value: undefined, source: 'default' } }, inherited: { [effort.key]: { value: undefined, source: 'default' } } };
    expect(fieldPreview(unset, {}, effort)).toMatchObject({ explicit: false, raw: '', entry: { value: undefined, source: 'default' } });
    expect(buildChanges(unset, { [effort.key]: null }, [effort])).toEqual({});
  });
});

describe('Claude account setting', () => {
  const at = (claudeAccount: SettingsSnapshot['claudeAccount'], scope: 'project' | 'home' = 'project'): SettingsSnapshot => ({ ...snapshot, scope, claudeAccount });
  it('says where the effective account comes from', () => {
    expect(accountStatus(at({ effective: 'work', project: '/tmp/project' }))).toBe('This repository runs in work.');
    expect(accountStatus(at({ effective: 'work', project: '/tmp' }))).toBe('Currently from work via /tmp.');
    expect(accountStatus(at({ effective: 'personal' }))).toBe('Currently from the global default (personal).');
    expect(accountStatus(at({}))).toBe('Currently no account: Claude’s default home.');
    expect(accountStatus(at({ effective: 'personal' }, 'home'))).toBe('Root nodes outside listed projects run in personal.');
  });
  it('saves a chosen account and its removal like other select fields', () => {
    expect(buildChanges(snapshot, { 'claude.account': 'work' }, fields)).toEqual({ 'claude.account': 'work' });
    expect(buildChanges({ ...snapshot, values: { 'claude.account': 'work' } }, { 'claude.account': null }, fields)).toEqual({ 'claude.account': null });
  });
  it('recognizes the single error view of an invalid accounts config', () => {
    expect(accountsError([{ name: 'claude.accounts', projects: [], isDefault: false, loggedIn: null, loginCommand: '', error: 'bad' }])).toBe('bad');
    expect(accountsError([{ name: 'work', projects: [], isDefault: false, loggedIn: null, loginCommand: 'x', error: 'probe failed' }])).toBeUndefined();
  });
});

describe('memory settings', () => {
  const accounts = [{ name: 'personal', projects: [], isDefault: true, loggedIn: true, loginCommand: 'x' }, { name: 'work', projects: [], isDefault: false, loggedIn: true, loginCommand: 'y' }];
  const base = groups.find((g) => g.title === 'Memory')!.fields;
  const keys = (scope: 'home' | 'project', list: ClaudeAccountView[] = accounts) => memoryFields(base, scope, list).map((f) => f.key);
  it('lists the global switch, then each account, then the size limit at home scope', () => {
    expect(keys('home')).toEqual(['memory.enabled', 'claude.accounts.personal.memory', 'claude.accounts.work.memory', 'memory.maxMB']);
  });
  it('shows only the repository choice at project scope', () => {
    expect(keys('project')).toEqual(['memory.project']);
  });
  it('shows no account fields while the account list is loading, empty or invalid', () => {
    expect(memoryFields(base, 'home').map((f) => f.key)).toEqual(['memory.enabled', 'memory.maxMB']);
    expect(keys('home', [])).toEqual(['memory.enabled', 'memory.maxMB']);
    expect(keys('home', [{ name: 'claude.accounts', projects: [], isDefault: false, loggedIn: null, loginCommand: '', error: 'bad' }])).toEqual(['memory.enabled', 'memory.maxMB']);
  });
  it('labels an account’s Off as a ceiling and a repository’s as plain Off', () => {
    expect(memoryChoices('claude.accounts.work.memory')).toEqual([['', 'No account setting'], ['true', 'On'], ['false', 'Off (a ceiling: no repository setting turns it on)']]);
    expect(memoryChoices('memory.project')).toEqual([['', 'Inherit'], ['true', 'On'], ['false', 'Off']]);
    expect(['memory.project', 'claude.accounts.work.memory'].every(isMemoryChoice)).toBe(true);
    expect(['memory.enabled', 'memory.maxMB', 'claude.account'].some(isMemoryChoice)).toBe(false);
  });
  it('saves true, false and removal of an account value and a repository value', () => {
    const f = memoryFields(base, 'home', accounts).concat(memoryFields(base, 'project'));
    const saved: SettingsSnapshot = { ...snapshot, values: { 'claude.accounts.work.memory': false, 'memory.project': true } };
    expect(buildChanges(snapshot, { 'claude.accounts.work.memory': 'false', 'memory.project': 'true' }, f)).toEqual({ 'claude.accounts.work.memory': false, 'memory.project': true });
    expect(buildChanges(saved, { 'claude.accounts.work.memory': null, 'memory.project': null }, f)).toEqual({ 'claude.accounts.work.memory': null, 'memory.project': null });
    expect(buildChanges(saved, { 'claude.accounts.work.memory': 'false', 'memory.project': 'true' }, f)).toEqual({});
  });
  it('skips a draft whose account field is gone instead of failing the whole save', () => {
    const f = memoryFields(base, 'home', accounts.slice(0, 1));
    const drafts = { 'claude.accounts.work.memory': 'true', 'memory.maxMB': '64' };
    expect(staleDrafts(drafts, f)).toEqual(['claude.accounts.work.memory']);
    expect(buildChanges(snapshot, drafts, f)).toEqual({ 'memory.maxMB': 64 });
    expect(() => buildChanges(snapshot, { 'nope.field': 'x' }, f)).toThrow('Unknown field'); // only memory accounts are forgiven
  });
  it('checks memory.maxMB against the size floor locally as a number', () => {
    expect(buildChanges(snapshot, { 'memory.maxMB': '64' }, memoryFields(base, 'home'))).toEqual({ 'memory.maxMB': 64 });
    expect(base.find((f) => f.key === 'memory.maxMB')?.min).toBe(16);
  });
  it('words the saved verdict for each scope', () => {
    expect(memoryStatus(snapshot)).toBeUndefined();
    expect(memoryStatus({ ...snapshot, scope: 'home', memory: { on: false, source: 'default' } })).toBe('The global setting is off (default).');
    expect(memoryStatus({ ...snapshot, memory: { on: true, source: 'memory.projects /r in /h/config.json', account: 'work' } })).toBe('Memory is on for root nodes here (account work): memory.projects /r in /h/config.json.');
    expect(memoryStatus({ ...snapshot, memory: { on: false, source: 'memory.enabled in /r/.tiller/config.json' } })).toBe('Memory is off for root nodes here: memory.enabled in /r/.tiller/config.json.');
  });
});
