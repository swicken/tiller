import { harnessFor, isAgentKind, profileFor, type Effort, type Harness, type Isolation, type NodeRecord, type Profile, type Role } from '../shared/protocol.js';
import { isSupportedEffort } from '../shared/harness-policy.js';
import { profileDefaults, type Config } from './config.js';
import { roleFor } from './launch.js';
import type { SpawnRequest } from './manager.js';
import type { Preset } from './presets.js';

/** The request's target checked, with a generic agent child's harness filled in from its agent parent (`parent`, req.parentId's record). */
export function spawnTarget(req: SpawnRequest, parent?: NodeRecord): SpawnRequest {
  if (req.kind === 'terminal' && req.harness) throw new Error('terminal nodes cannot select a harness');
  if (req.kind === 'claude' && req.harness && req.harness !== 'claude') throw new Error('use kind "agent" for a non-Claude harness');
  // Generic agent children inherit their parent's CLI unless explicitly selected.
  if (req.kind === 'agent' && !req.harness && req.parentId) {
    if (parent && isAgentKind(parent.kind)) req = { ...req, harness: harnessFor(parent) };
  }
  return req;
}

/** A node's model and effort defaults on `harness`: its profile's harness config, then legacy Claude role defaults. */
export const nodeDefaults = (config: Config, harness: Harness, n: { profile?: Profile; parentId: string | null; role?: Role }) =>
  profileDefaults(config, harness, profileFor(n.profile, n.parentId, n.role), roleFor(n.role, n.parentId));

export interface SpawnPolicyInput {
  req: SpawnRequest;
  /** The new node's harness; absent for a terminal. */
  adapterId?: Harness;
  config: Config;
  /** req.parentId's record, with its live permission mode and the preset its current process launched with, if any. */
  parent?: { rec: NodeRecord; observedMode?: string; launchedPreset?: Partial<Preset> };
  loadPreset(name: string): Partial<Preset>;
  /** The new node's Claude account; may refuse. */
  account(): string | undefined;
  /** The adapter's check of the resolved permissionMode and preset; may refuse. */
  validate(permissionMode: string | undefined, preset: Partial<Preset>): void;
}

export interface SpawnPolicy {
  role?: Role;
  profile?: Profile;
  model?: string;
  effort?: Effort;
  explicit?: ('model' | 'effort')[];
  account?: string;
  permissionMode?: string;
  isolation: Isolation;
}

/**
 * A spawn's resolved fields and its policy refusals, in order (see NodeManager.spawn). IO enters only through the
 * injected callbacks, each called at its point in that order, so the first refusal wins as it would inline.
 */
export function resolveSpawn(i: SpawnPolicyInput): SpawnPolicy {
  const { req, adapterId, config } = i, parentId = req.parentId ?? null;
  if (req.preset && !adapterId) throw new Error('a preset is for agent nodes only');
  const p: Partial<Preset> = req.preset ? i.loadPreset(req.preset) : {};
  const role = req.role ?? p.role, isOrchestrator = roleFor(role, parentId) === 'orchestrator';
  const profile = adapterId ? profileFor(req.profile ?? p.profile, parentId, role) : undefined;
  const defaults: Pick<NodeRecord, 'model' | 'effort'> = adapterId ? nodeDefaults(config, adapterId, { profile, parentId, role }) : {};
  const model = req.model ?? p.model ?? defaults.model, effort = req.effort ?? p.effort ?? defaults.effort;
  // A follow-up's model and effort come from the archived node, so its own record says which were chosen.
  const explicit = req.followup ? req.followup.explicit : (['model', 'effort'] as const).filter((k) => (req[k] ?? p[k]) !== undefined);
  if (adapterId === 'codex' && effort && !isSupportedEffort('codex', effort)) throw new Error(`unsupported Codex effort: ${effort}`);
  const parent = i.parent?.rec;
  const account = i.account();
  // Other harnesses cannot carry Claude restrictions. Only the human, a same-harness parent,
  // or an unrestricted Claude parent may select them. This is not a process sandbox.
  if (adapterId && adapterId !== 'claude' && !req.byHuman && !(parent && isAgentKind(parent.kind) && harnessFor(parent) === adapterId)) {
    const mode = i.parent?.observedMode ?? parent?.permissionMode;
    // A restored/armed node has no launch snapshot. Its preset file may have changed since the old process;
    // do not infer that process's restrictions from today's file. A successful launch establishes the snapshot.
    if (parent?.preset && !i.parent?.launchedPreset) {
      throw new Error(`refused: Claude preset restrictions are unknown until the parent launches; only the human may spawn ${adapterId === 'pi' ? 'Pi' : 'Codex'}`);
    }
    const preset = i.parent?.launchedPreset ?? {};
    const restricted = preset.tools !== undefined || preset.disallowedTools !== undefined || preset.maxTurns !== undefined;
    if (!parent || !isAgentKind(parent.kind) || mode !== 'bypassPermissions' || restricted) {
      throw new Error(`refused: only the human or an unrestricted agent parent may spawn ${adapterId === 'pi' ? 'Pi' : 'Codex'}; Claude requires effective permissionMode bypassPermissions and no preset tools, disallowedTools or maxTurns restrictions`);
    }
  }
  const inherited = req.byHuman || !parent || (adapterId && adapterId !== 'claude') || (adapterId && harnessFor(parent) !== adapterId)
    ? undefined : i.parent?.observedMode ?? parent.permissionMode;
  const permissionMode = req.permissionMode ?? p.permissionMode ?? (inherited === 'bypassPermissions' ? undefined : inherited);
  if (permissionMode === 'bypassPermissions' && !req.byHuman) throw new Error('refused: only the human may spawn a node with permissionMode bypassPermissions');
  if (adapterId) i.validate(permissionMode, p);
  const isolation = req.isolation ?? p.isolation ?? (!adapterId || isOrchestrator ? 'none' : config.worktrees.isolation);
  if (isolation !== 'none' && !adapterId) throw new Error(`isolation "${isolation}" is for agent nodes only`);
  return { role, profile, model, effort, explicit, account, permissionMode, isolation };
}

/**
 * Restart's re-resolved model and effort: those the spawn did not choose (NodeRecord.explicit) from the current config.
 * A legacy record without explicit counts what its preset sets as chosen; an unloadable preset keeps both.
 */
export function restartSelection(rec: NodeRecord, config: Config, loadPreset: (name: string) => Partial<Preset>): { fresh: Pick<NodeRecord, 'model' | 'effort'> } | { error: string } {
  const harness = harnessFor(rec), d = nodeDefaults(config, harness, rec);
  let explicit = rec.explicit;
  if (!explicit && rec.preset) {
    try {
      const p = loadPreset(rec.preset);
      explicit = (['model', 'effort'] as const).filter((k) => p[k] !== undefined);
    } catch { explicit = ['model', 'effort']; }
  }
  const fresh = { ...(explicit?.includes('model') ? {} : { model: d.model }), ...(explicit?.includes('effort') ? {} : { effort: d.effort }) };
  if (fresh.effort && !isSupportedEffort(harness, fresh.effort)) return { error: `unsupported ${harness} effort: ${fresh.effort}` };
  return { fresh };
}
