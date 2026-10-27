import { HARNESSES, PROFILES, HARNESS_EFFORTS, EFFORTS } from './harness-policy.js';

/** Human/admin Settings HTTP contract. null removes an explicit override. */
export type SettingsScope = 'project' | 'home';
export interface SettingsEntry { value?: unknown; source: string }
export interface SettingsSnapshot {
  scope: SettingsScope;
  path: string;
  projectPath: string | null;
  revision: string;
  values: Record<string, unknown>;
  entries: Record<string, SettingsEntry>;
  inherited: Record<string, SettingsEntry>;
  /** Revision of the home file. claude.account always lives there, so a project-scope account change is checked against it. */
  homeRevision?: string;
  /**
   * claude.account, the account a root node here runs in, and the claude.accounts `projects` entry that decides it (absent:
   * the global default or none). At project scope, values['claude.account'] is the account listing this repo's exact path.
   */
  claudeAccount?: { effective?: string; project?: string };
}
export interface SettingsUpdate { scope: SettingsScope; nodeId?: string; revision: string; changes: Record<string, unknown | null>; /** Required for a project-scope claude.account change. */ homeRevision?: string }
/**
 * POST /api/settings body that replaces claude.accounts in the home file, matched by name: a kept account keeps its projects.
 * account (claude.account) is required when none are configured yet, and refused after: it has its own setting. create: the
 * daemon makes a new or changed configDir (mode 0700) first; otherwise it must already be a directory. openedWith: the account
 * names the form was opened with; a file listing other names (added or removed since) is a 409, as a stale revision is.
 */
export interface ClaudeAccountsSave { scope: 'home'; revision: string; openedWith: string[]; claudeAccounts: { account?: string; accounts: { name: string; configDir?: string; create?: boolean }[] } }
/** A Claude account name (claude.accounts[].name, claude.account), checked by the daemon and the setup form alike. */
export const CLAUDE_ACCOUNT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
export const CLAUDE_ACCOUNT_NAME_RULE = 'a name is 1-32 letters, digits, _ or -, starting with a letter or digit';
/** GET /api/settings?claudeConfigDir=PATH: what is there (~/ expanded), and why it can never be a configDir (error). */
export interface ClaudeConfigDirCheck { exists: boolean; directory: boolean; error?: string }
export interface SettingsField {
  key: string; label: string; type: 'text' | 'number' | 'boolean' | 'select' | 'lines';
  options?: readonly string[]; min?: number; integer?: boolean; description?: string;
  /** lines only: words that a single line saves as that string instead of a list. */
  keywords?: readonly string[];
}
/** Portable defaults used only after explicit profiles and legacy Claude roles.
 * Sonnet/Haiku aliases can resolve to older provider models without effort support:
 * https://code.claude.com/docs/en/model-config#adjust-effort-level
 */
export const SETTINGS_PROFILE_DEFAULTS: { [Harness in typeof HARNESSES[number]]: Record<typeof PROFILES[number], { model?: string; effort?: (typeof HARNESS_EFFORTS)[Harness][number] }> } = {
  claude: {
    orchestrator: { model: 'opus' }, implementation: { model: 'sonnet' },
    explorer: { model: 'haiku' }, mechanical: { model: 'haiku' }, reviewer: { model: 'opus' },
  },
  codex: {
    orchestrator: { model: 'gpt-6-astra', effort: 'medium' }, implementation: { model: 'gpt-6.1-sol', effort: 'medium' },
    explorer: { model: 'gpt-6-luna', effort: 'high' }, mechanical: { model: 'gpt-6-luna', effort: 'low' }, reviewer: { model: 'gpt-6.1-sol', effort: 'high' },
  },
  pi: { orchestrator: {}, implementation: {}, explorer: {}, mechanical: {}, reviewer: {} },
};
const field = (key: string, type: SettingsField['type'], extra: Partial<SettingsField> = {}): SettingsField => ({ key, label: key.split('.').at(-1)!, type, ...extra });
export const SETTINGS_FIELDS: SettingsField[] = [
  ...HARNESSES.flatMap(h => PROFILES.flatMap(p => [field(`profiles.${h}.${p}.model`, 'text'), field(`profiles.${h}.${p}.effort`, 'select', { options: HARNESS_EFFORTS[h] })])),
  ...['orchestrator', 'worker'].flatMap(r => [field(`roles.${r}.model`, 'text'), field(`roles.${r}.effort`, 'select', { options: EFFORTS })]),
  field('claude.inheritMcpServers', 'boolean'),
  // Options are the configured claude.accounts names. Home scope sets claude.account; project scope lists the repo under that account's projects, in the home file.
  field('claude.account', 'select', { options: [] }),
  field('pi.extensions', 'lines', { keywords: ['all', 'none'] }),
  field('approvals.close', 'select', { options: ['never', 'done', 'always'] }), field('approvals.merge', 'boolean'),
  field('worktrees.isolation', 'select', { options: ['none', 'worktree'] }),
  field('worktrees.mergeStyle', 'select', { options: ['merge', 'squash', 'ff-only'] }),
  ...['branchPrefix', 'taskBranch'].map(k => field(`worktrees.${k}`, 'text')),
  ...['include', 'setup', 'teardown', 'protected'].map(k => field(`worktrees.${k}`, 'lines')),
  field('gate.command', 'text'), field('gate.retries', 'number', { min: 0, integer: true }), field('gate.timeoutMinutes', 'number', { min: 0 }),
  field('daemon.resumeOnStart', 'boolean'),
  ...['resumeMaxAgeDays', 'sessionsKeepDays', 'digestAfterMinutes', 'maxLiveNodes', 'maxWorking'].map(k => field(`daemon.${k}`, 'number', { min: 0, integer: k.startsWith('max') })),
  ...['needsYou', 'done', 'errored', 'exited'].map(k => field(`notifications.kinds.${k}`, 'select', { options: ['banner', 'sound', 'silent'] })),
  field('notifications.treeDoneSummary', 'boolean'), field('notifications.quietHours', 'text'),
  ...['maxDepth', 'maxChildren', 'stallMinutes', 'maxMessagesPer10Min'].map(k => field(`limits.${k}`, 'number', { min: 0, integer: k !== 'stallMinutes' })),
];
