import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Harness, NodeRecord } from '../shared/protocol.js';
import { loadConfig, type Config } from './config.js';
import { NodeManager, type SpawnRequest } from './manager.js';
import type { Preset } from './presets.js';
import { PtySession } from './pty.js';
import { resolveSpawn, restartSelection, spawnTarget, type SpawnPolicyInput } from './spawn-policy.js';

const emptyHome = mkdtempSync(join(tmpdir(), 'tl-spawn-policy-config-'));
const base = loadConfig(null, emptyHome);
rmSync(emptyHome, { recursive: true, force: true });
/** The default config with claude implementation and legacy worker settings, and worktree isolation on. */
const config: Config = {
  ...base,
  profiles: { ...base.profiles, claude: { ...base.profiles.claude, implementation: { model: 'cfg-impl' } } },
  roles: { ...base.roles, worker: { model: 'legacy-model', effort: 'high' } },
  worktrees: { ...base.worktrees, isolation: 'worktree' },
};
const node = (over: Partial<NodeRecord>): NodeRecord => ({ id: 'n-p', parentId: null, kind: 'claude', title: 'parent', cwd: '/w', createdAt: 0, ...over });
const claudeParent = (permissionMode?: string, over: Partial<NodeRecord> = {}) => ({ rec: node({ permissionMode, ...over }), launchedPreset: {} });

/** resolveSpawn for a child of n-p with no presets but `presets`, recording which callbacks ran in `calls`. */
function resolve(req: Partial<SpawnRequest>, opts: Partial<SpawnPolicyInput> & { presets?: Record<string, Partial<Preset>> } = {}, calls: string[] = []) {
  const { presets = {}, ...rest } = opts;
  return resolveSpawn({
    req: { kind: 'claude', title: 'child', cwd: '/w', parentId: 'n-p', ...req }, config,
    adapterId: req.kind === 'terminal' ? undefined : req.harness ?? 'claude',
    loadPreset: (name) => { calls.push('loadPreset'); if (!presets[name]) throw new Error(`no preset "${name}"`); return presets[name]; },
    account: () => { calls.push('account'); return undefined; },
    validate: () => { calls.push('validate'); },
    ...rest,
  });
}

describe('spawnTarget', () => {
  const req = (over: Partial<SpawnRequest>): SpawnRequest => ({ kind: 'agent', title: 't', cwd: '/w', parentId: 'n-p', ...over });
  it('refuses a harness on a terminal and a non-Claude harness on kind claude', () => {
    expect(() => spawnTarget(req({ kind: 'terminal', harness: 'claude' }))).toThrow('terminal nodes cannot select a harness');
    expect(() => spawnTarget(req({ kind: 'claude', harness: 'pi' }))).toThrow('use kind "agent" for a non-Claude harness');
    expect(spawnTarget(req({ kind: 'claude', harness: 'claude' }))).toMatchObject({ harness: 'claude' });
  });
  it.each([
    ['an agent parent\'s harness', req({}), node({ kind: 'agent', harness: 'codex' }), 'codex'],
    ['claude for a kind claude parent', req({}), node({}), 'claude'],
    ['nothing from a terminal parent', req({}), node({ kind: 'terminal' }), undefined],
    ['nothing without a parent record', req({}), undefined, undefined],
    ['nothing for a root', req({ parentId: null }), node({ kind: 'agent', harness: 'codex' }), undefined],
    ['nothing over an explicit harness', req({ harness: 'pi' }), node({ kind: 'agent', harness: 'codex' }), 'pi'],
    ['nothing for kind claude', req({ kind: 'claude' }), node({ kind: 'agent', harness: 'codex' }), undefined],
  ] as const)('inherits %s', (_, r, parent, harness) => {
    expect(spawnTarget(r, parent).harness).toBe(harness);
  });
});

describe('resolveSpawn fields', () => {
  const presets = { p: { model: 'preset-model', effort: 'low', profile: 'reviewer' }, coordinator: { role: 'orchestrator' } } satisfies Record<string, Partial<Preset>>;
  it.each([
    ['config profile, then legacy role effort', {}, { role: undefined, profile: 'implementation', model: 'cfg-impl', effort: 'high' }],
    ['preset over config', { preset: 'p' }, { profile: 'reviewer', model: 'preset-model', effort: 'low' }],
    ['request over preset', { preset: 'p', model: 'req-model', effort: 'max', profile: 'mechanical' }, { profile: 'mechanical', model: 'req-model', effort: 'max' }],
    ['preset role picks the profile', { preset: 'coordinator' }, { role: 'orchestrator', profile: 'orchestrator', model: 'opus', effort: undefined }],
    ['root defaults to orchestrator', { parentId: null }, { profile: 'orchestrator', model: 'opus', effort: undefined }],
    ['no legacy roles off Claude', { kind: 'agent', harness: 'codex', byHuman: true }, { profile: 'implementation', model: 'gpt-6.1-sol', effort: 'medium' }],
    ['no profile or defaults for a terminal', { kind: 'terminal' }, { profile: undefined, model: undefined, effort: undefined }],
  ] as const)('%s', (_, req, want) => {
    expect(resolve(req as Partial<SpawnRequest>, { presets })).toMatchObject(want);
  });

  it.each([
    [{}, []],
    [{ model: 'm' }, ['model']],
    [{ preset: 'p' }, ['model', 'effort']],
    [{ preset: 'coordinator', effort: 'low' }, ['effort']],
    // A follow-up's record says what the archived node chose, whatever the request now carries.
    [{ model: 'm', followup: { explicit: ['effort'] } }, ['effort']],
    [{ model: 'm', followup: {} }, undefined],
  ] as const)('explicit for %o is %o', (req, explicit) => {
    expect(resolve(req as Partial<SpawnRequest>, { presets }).explicit).toEqual(explicit);
  });

  it('refuses an unsupported Codex effort from the request or preset, and only for Codex', () => {
    const codex = { kind: 'agent', harness: 'codex', byHuman: true } as const;
    expect(() => resolve({ ...codex, effort: 'max' })).toThrow('unsupported Codex effort: max');
    expect(() => resolve({ ...codex, preset: 'max' }, { presets: { max: { effort: 'max' } } })).toThrow('unsupported Codex effort: max');
    expect(resolve({ ...codex, preset: 'max', effort: 'high' }, { presets: { max: { effort: 'max' } } }).effort).toBe('high');
    expect(resolve({ effort: 'max' }).effort).toBe('max');
  });

  it('takes the account from the callback', () => {
    expect(resolve({}, { account: () => 'work' }).account).toBe('work');
  });

  it.each([
    ['a worker from config', {}, 'worktree'],
    ['an orchestrator role', { role: 'orchestrator' }, 'none'],
    ['a root', { parentId: null }, 'none'],
    ['a terminal', { kind: 'terminal' }, 'none'],
    ['the preset over config', { preset: 'none' }, 'none'],
    ['the request over the preset', { preset: 'none', isolation: 'worktree', role: 'orchestrator' }, 'worktree'],
  ] as const)('isolation for %s', (_, req, isolation) => {
    expect(resolve(req as Partial<SpawnRequest>, { presets: { none: { isolation: 'none' } } }).isolation).toBe(isolation);
  });
  it('refuses worktree isolation for a terminal', () => {
    expect(() => resolve({ kind: 'terminal', isolation: 'worktree' })).toThrow('isolation "worktree" is for agent nodes only');
  });
});

describe('resolveSpawn cross-harness restriction', () => {
  const ALLOWED = 'allowed';
  const HUMAN = /only the human or an unrestricted agent parent may spawn/;
  it.each([
    ['the human, under any parent', true, claudeParent('plan'), ALLOWED],
    ['no parent', false, undefined, HUMAN],
    ['a terminal parent in bypass', false, { rec: node({ kind: 'terminal', permissionMode: 'bypassPermissions' }) }, HUMAN],
    ['a same-harness parent, whatever its mode', false, { rec: node({ kind: 'agent', harness: 'SAME' as Harness, permissionMode: 'plan' }) }, ALLOWED],
    ['a Claude parent in bypass', false, claudeParent('bypassPermissions'), ALLOWED],
    ['a Claude parent not in bypass', false, claudeParent('plan'), HUMAN],
    ['a Claude parent with no mode', false, claudeParent(), HUMAN],
    ['a Claude parent observed in bypass over its record', false, { ...claudeParent('plan'), observedMode: 'bypassPermissions' }, ALLOWED],
    ['a Claude parent observed out of bypass', false, { ...claudeParent('bypassPermissions'), observedMode: 'plan' }, HUMAN],
    ['a bypass parent launched with tools', false, { ...claudeParent('bypassPermissions'), launchedPreset: { tools: [] } }, /no preset tools, disallowedTools or maxTurns/],
    ['a bypass parent launched with disallowedTools', false, { ...claudeParent('bypassPermissions'), launchedPreset: { disallowedTools: ['Write'] } }, /no preset tools/],
    ['a bypass parent launched with maxTurns', false, { ...claudeParent('bypassPermissions'), launchedPreset: { maxTurns: 1 } }, /no preset tools/],
    ['a bypass parent launched with a prompt-only preset', false, claudeParent('bypassPermissions', { preset: 'plain' }), ALLOWED],
    ['a bypass parent whose preset has not launched', false, { rec: node({ permissionMode: 'bypassPermissions', preset: 'plain' }) }, /preset restrictions are unknown until the parent launches; only the human may spawn/],
  ] as const)('%s', (_, byHuman, parent, want) => {
    for (const [harness, name] of [['codex', 'Codex'], ['pi', 'Pi']] as const) {
      // 'SAME' stands for the child's own harness.
      const p = parent && { ...parent, rec: { ...parent.rec, ...(parent.rec.harness === 'SAME' as Harness ? { harness } : {}) } };
      const run = () => resolve({ kind: 'agent', harness, byHuman }, { parent: p as SpawnPolicyInput['parent'] });
      if (want === ALLOWED) expect(run().permissionMode).toBeUndefined();
      else {
        expect(run).toThrow(want);
        expect(run).toThrow(`spawn ${name}`);
      }
    }
  });
});

describe('resolveSpawn permission mode', () => {
  it.each([
    ['the parent\'s recorded mode', {}, claudeParent('plan'), 'plan'],
    ['the parent\'s observed mode over its record', {}, { ...claudeParent('plan'), observedMode: 'acceptEdits' }, 'acceptEdits'],
    ['never bypass', {}, claudeParent('bypassPermissions'), undefined],
    ['never an observed bypass', {}, { ...claudeParent('plan'), observedMode: 'bypassPermissions' }, undefined],
    ['nothing for the human', { byHuman: true }, claudeParent('plan'), undefined],
    ['nothing without a parent', {}, undefined, undefined],
    ['nothing across harnesses', {}, { rec: node({ kind: 'agent', harness: 'codex', permissionMode: 'plan' }) }, undefined],
    ['the parent\'s mode for a terminal', { kind: 'terminal' }, claudeParent('plan'), 'plan'],
    ['the preset over the parent', { preset: 'edits' }, claudeParent('plan'), 'acceptEdits'],
    ['the request over the preset', { preset: 'edits', permissionMode: 'default' }, claudeParent('plan'), 'default'],
  ] as const)('inherits %s', (_, req, parent, mode) => {
    expect(resolve(req as Partial<SpawnRequest>, { parent, presets: { edits: { permissionMode: 'acceptEdits' } } }).permissionMode).toBe(mode);
  });

  it('does not inherit into a non-Claude child of the same harness', () => {
    expect(resolve({ kind: 'agent', harness: 'codex' }, { parent: { rec: node({ kind: 'agent', harness: 'codex', permissionMode: 'plan' }) } }).permissionMode).toBeUndefined();
  });

  it('lets only the human ask for bypassPermissions, from the request or a preset', () => {
    const BYPASS = 'refused: only the human may spawn a node with permissionMode bypassPermissions';
    const presets = { bypass: { permissionMode: 'bypassPermissions' as const } };
    expect(() => resolve({ permissionMode: 'bypassPermissions' })).toThrow(BYPASS);
    expect(() => resolve({ preset: 'bypass' }, { presets })).toThrow(BYPASS);
    expect(() => resolve({ kind: 'terminal', permissionMode: 'bypassPermissions' })).toThrow(BYPASS);
    expect(resolve({ permissionMode: 'bypassPermissions', byHuman: true }).permissionMode).toBe('bypassPermissions');
    expect(resolve({ preset: 'bypass', byHuman: true }, { presets }).permissionMode).toBe('bypassPermissions');
  });

  it('hands validate the resolved mode and preset, for agents only', () => {
    const seen: unknown[] = [];
    const preset = { model: 'x' };
    resolve({ preset: 'x', permissionMode: 'plan' }, { presets: { x: preset }, validate: (...a) => { seen.push(a); } });
    resolve({ kind: 'terminal' }, { validate: (...a) => { seen.push(a); } });
    expect(seen).toEqual([['plan', preset]]);
  });
});

describe('resolveSpawn refusal precedence', () => {
  it('calls loadPreset, account and validate in that order', () => {
    const calls: string[] = [];
    resolve({ preset: 'x' }, { presets: { x: {} } }, calls);
    expect(calls).toEqual(['loadPreset', 'account', 'validate']);
  });

  it.each([
    ['preset-for-agents before loading it', { kind: 'terminal', preset: 'x', isolation: 'worktree', permissionMode: 'bypassPermissions' }, 'a preset is for agent nodes only', []],
    ['loadPreset before Codex effort', { kind: 'agent', harness: 'codex', preset: 'missing', effort: 'max' }, 'no preset "missing"', ['loadPreset']],
    ['Codex effort before the account', { kind: 'agent', harness: 'codex', effort: 'max', permissionMode: 'bypassPermissions' }, 'unsupported Codex effort: max', []],
    ['the account before cross-harness', { kind: 'agent', harness: 'codex', account: 'x' }, 'account refused', ['account']],
    ['cross-harness before bypass', { kind: 'agent', harness: 'codex', permissionMode: 'bypassPermissions' }, /unrestricted agent parent/, ['account']],
    ['bypass before validate', { permissionMode: 'bypassPermissions' }, 'only the human may spawn a node with permissionMode bypassPermissions', ['account']],
    ['validate before isolation', { isolation: 'worktree' }, 'invalid', ['account', 'validate']],
    ['worktree-for-agents last', { kind: 'terminal', isolation: 'worktree' }, 'isolation "worktree" is for agent nodes only', ['account']],
  ] as const)('%s', (_, req, error, want) => {
    const calls: string[] = [];
    const account = () => { calls.push('account'); if ((req as Partial<SpawnRequest>).account) throw new Error('account refused'); return undefined; };
    const validate = () => { calls.push('validate'); throw new Error('invalid'); };
    expect(() => resolve(req as Partial<SpawnRequest>, { parent: claudeParent('plan'), account, validate }, calls)).toThrow(error);
    expect(calls).toEqual(want);
  });
});

describe('restartSelection', () => {
  const noPreset = (): never => { throw new Error('no preset'); };
  it.each([
    ['both when nothing was chosen', { explicit: [] }, { model: 'cfg-impl', effort: 'high' }],
    ['only effort after a chosen model', { explicit: ['model'] }, { effort: 'high' }],
    ['neither when both were chosen', { explicit: ['model', 'effort'] }, {}],
    ['both for a legacy record without a preset', {}, { model: 'cfg-impl', effort: 'high' }],
    ['what a legacy record\'s preset leaves unset', { preset: 'm' }, { effort: 'high' }],
    ['neither for a legacy record whose preset is gone', { preset: 'gone' }, {}],
    ['the recorded profile\'s config, then legacy role config', { explicit: [], profile: 'explorer' }, { model: 'legacy-model', effort: 'high' }],
    ['a root\'s orchestrator defaults', { explicit: [], parentId: null }, { model: 'opus', effort: undefined }],
  ] as const)('re-resolves %s', (_, over, fresh) => {
    const rec = node({ id: 'n-c', parentId: 'n-p', ...(over as Partial<NodeRecord>) });
    expect(restartSelection(rec, config, (name) => (name === 'm' ? { model: 'preset-model' } : noPreset()))).toEqual({ fresh });
  });

  it('does not load the preset of a record with explicit', () => {
    expect(restartSelection(node({ explicit: [], preset: 'gone' }), config, noPreset)).toEqual({ fresh: { model: 'opus', effort: undefined } });
  });

  it('refuses an effort the harness does not support, naming the harness', () => {
    const maxCodex = { ...config, profiles: { ...config.profiles, codex: { ...config.profiles.codex, implementation: { effort: 'max' } } } } as Config;
    expect(restartSelection(node({ kind: 'agent', harness: 'codex', parentId: 'n-p', explicit: [] }), maxCodex, noPreset)).toEqual({ error: 'unsupported codex effort: max' });
    expect(restartSelection(node({ kind: 'agent', harness: 'codex', parentId: 'n-p', explicit: ['effort'] }), maxCodex, noPreset)).toEqual({ fresh: { model: 'gpt-6.1-sol' } });
  });
});

describe('NodeManager.spawn refusal precedence', () => {
  let home: string;
  let m: NodeManager;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'tl-spawn-policy-'));
    m = new NodeManager({ home, shell: '/bin/sh' });
    vi.spyOn(PtySession, 'spawn').mockImplementation(() => ({ exited: true, kill() {}, terminate: async () => true, onData() {}, onExit() {} } as unknown as PtySession));
  });
  afterEach(async () => { await m.shutdown(); vi.restoreAllMocks(); rmSync(home, { recursive: true, force: true }); });

  it('reports the first refusal when a request breaks several rules, peeling them off in order', async () => {
    const parent = await m.spawn({ kind: 'claude', title: 'parent', cwd: home, byHuman: true, permissionMode: 'plan' });
    const before = m.list().length;
    const spawn = (extra: Partial<SpawnRequest>) => m.spawn({ kind: 'agent', title: 'child', cwd: home, parentId: parent.id, ...extra });
    let req: Partial<SpawnRequest> = { kind: 'terminal', harness: 'codex', preset: 'missing', isolation: 'worktree', base: 'b' };
    m.runtimes.get(parent.id)!.busy = 'changing harness';
    await expect(spawn(req)).rejects.toThrow('parent is changing harness');
    m.runtimes.get(parent.id)!.busy = undefined;
    const steps: [Partial<SpawnRequest>, string][] = [
      [{}, 'terminal nodes cannot select a harness'],
      [{ harness: undefined }, 'a preset is for agent nodes only'],
      [{ preset: undefined }, 'isolation "worktree" is for agent nodes only'],
      [{ isolation: undefined }, 'base is for isolation "worktree" or "detached" only'],
      [{ kind: 'claude', harness: 'codex' }, 'use kind "agent" for a non-Claude harness'],
      [{ kind: 'agent', preset: 'missing', effort: 'max', account: 'x', permissionMode: 'bypassPermissions' }, 'no preset "missing"'],
      [{ preset: undefined }, 'unsupported Codex effort: max'],
      [{ effort: undefined }, 'refused: only the human may choose a Claude account'],
      [{ account: undefined }, 'refused: only the human or an unrestricted agent parent may spawn Codex'],
    ];
    for (const [change, error] of steps) {
      req = { ...req, ...change };
      await expect(spawn(req)).rejects.toThrow(error);
    }
    m.applyHook(parent.id, { hook_event_name: 'UserPromptSubmit', permission_mode: 'bypassPermissions' });
    await expect(spawn(req)).rejects.toThrow('refused: only the human may spawn a node with permissionMode bypassPermissions');
    await expect(spawn({ ...req, permissionMode: 'plan' })).rejects.toThrow('Codex does not support Claude permissionMode');
    await expect(spawn({ ...req, permissionMode: undefined })).rejects.toThrow('base is for isolation "worktree" or "detached" only');
    expect(m.list()).toHaveLength(before);
  });
});
