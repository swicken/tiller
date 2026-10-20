import { describe, expect, it } from 'vitest';
import { buildChanges, cliStatus, fieldPreview, groups, profileFields, type SettingsSnapshot } from './settings-model';
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
