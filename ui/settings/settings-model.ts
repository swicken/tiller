import { PROFILES, type ClaudeAccountView, type Harness, type UsageSource } from '../../src/shared/protocol';
import { SETTINGS_FIELDS, type SettingsField } from '../../src/shared/settings';
export type { SettingsSnapshot } from '../../src/shared/settings';
import type { SettingsSnapshot } from '../../src/shared/settings';
export type { SettingsScope as Scope } from '../../src/shared/settings';
export type Field = SettingsField & { help?: string };
const fieldHelp: Record<string, string> = {
  'notifications.kinds.needsYou': 'An agent is waiting for your input or approval.',
  'notifications.kinds.errored': 'An agent encounters an error.',
  'notifications.kinds.done': 'Level for the tree completion summary, or each finished turn when summaries are off.',
  'notifications.kinds.exited': 'An agent process exits.',
  'notifications.treeDoneSummary': 'Notify once all agents, including the root, finish. Terminals do not count; pending work and gates delay the summary.',
  'claude.account': 'Which Claude account root nodes run in; a choice in the new-node dialog wins, and children inherit their parent’s. Stored in ~/.tiller/config.json, never in the repository.',
  'claude.inheritMcpServers': 'Load your user and plugin MCP servers alongside Tiller’s. A project’s .mcp.json servers stay off. Off gives Claude nodes only Tiller’s server.',
  'pi.extensions': 'Which of your Pi extensions Pi nodes load besides Tiller’s: all, none, or one package source per line as written in your Pi settings, such as npm:pi-web-access. A listed package must be installed.',
  'limits.maxDepth': 'Maximum number of nested agent generations.',
  'limits.maxChildren': 'Maximum live children per agent.',
  'limits.stallMinutes': 'Minutes without progress before an agent is considered stalled.',
  'limits.maxMessagesPer10Min': 'Maximum messages one agent can send to one recipient in ten minutes.',
  'worktrees.isolation': 'Default isolation for Claude workers when spawn options do not specify it.',
  'worktrees.branchPrefix': 'Prefix used when creating worktree branches.',
  'worktrees.mergeStyle': 'Default strategy for merging worktree branches.',
  'daemon.resumeOnStart': 'Resume eligible sessions when the daemon starts.',
  'daemon.resumeMaxAgeDays': 'Oldest session age eligible for automatic resume, in days.',
  'daemon.sessionsKeepDays': 'Days to retain a session directory after its root closes.',
  'daemon.digestAfterMinutes': 'Minutes away from the app before returning shows an activity digest.',
  'daemon.maxLiveNodes': 'Maximum live nodes managed by the daemon.',
  'daemon.maxWorking': 'Maximum Claude agents working at once. Additional spawns queue. Zero means unlimited.',
};
function field(key: string, label: string, extra: { help?: string } = {}): Field {
  const metadata = SETTINGS_FIELDS.find((entry) => entry.key === key);
  if (!metadata) throw new Error(`Missing settings metadata: ${key}`);
  return { ...metadata, help: fieldHelp[key], label: label.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase()), ...extra };
}
export const profileFields = (harness: Harness): Field[] => PROFILES.flatMap((profile) => [
  field(`profiles.${harness}.${profile}.model`, `${profile} model`, { help: harness === 'pi' ? 'Provider/model ID accepted by Pi.' : 'Model ID accepted by this harness.' }),
  field(`profiles.${harness}.${profile}.effort`, `${profile} effort`),
]);
export const groups: { title: string; homeOnly?: boolean; help?: string; fields: Field[] }[] = [
  { title: 'Notifications', help: 'Choose how Tiller gets your attention when agents need you or finish work.', fields: [
    ...['needsYou', 'errored', 'done', 'exited'].map((kind) => field(`notifications.kinds.${kind}`, kind)),
    field('notifications.treeDoneSummary', 'One completion summary per tree'),
    field('notifications.quietHours', 'Quiet hours', { help: 'Local time HH:MM-HH:MM; can cross midnight. Needs-you banners remain visible without sound.' }),
  ] },
  { title: 'Limits', help: 'Spawn caps apply to agents; the human is exempt.', fields: ['maxDepth', 'maxChildren', 'stallMinutes', 'maxMessagesPer10Min'].map((key) => field(`limits.${key}`, key)) },
  { title: 'Worktrees', help: 'Control repository isolation, branches, and worktree lifecycle commands.', fields: [
    field('worktrees.isolation', 'Default isolation'), field('worktrees.branchPrefix', 'Branch prefix'),
    field('worktrees.taskBranch', 'Task branch', { help: 'Must contain {slug}.' }), field('worktrees.mergeStyle', 'Merge style'),
    ...['include', 'protected', 'setup', 'teardown'].map((key) => field(`worktrees.${key}`, key, { help: key === 'include' ? 'One pattern per line. Inherit to use .worktreeinclude; an empty list copies nothing.' : key === 'protected' ? 'One branch per line. An empty list protects no branches.' : 'One shell command per line. Saving does not execute commands.' })),
  ] },
  { title: 'Claude', help: 'Settings for Claude nodes.', fields: [field('claude.account', 'Claude account'), field('claude.inheritMcpServers', 'Inherit MCP servers')] },
  { title: 'Pi', help: 'Settings for Pi nodes.', fields: [field('pi.extensions', 'Extensions')] },
  { title: 'Approvals & checks', help: 'Control when agents need your approval and what must pass before work is complete.', fields: [
    field('approvals.close', 'Close nodes without approval', { help: 'Choose when agents can close nodes without asking you first.' }),
    field('approvals.merge', 'Merge without approval', { help: 'Allow agents to merge their work without asking you first.' }),
    field('gate.command', 'Check command', { help: 'Must pass before a worker reports success. Saving does not run it. Use the inherited value to remove this scope’s gate.' }),
    field('gate.retries', 'Retry attempts', { help: 'Additional attempts allowed after a completion check fails.' }), field('gate.timeoutMinutes', 'Timeout (minutes)', { help: 'Maximum time each completion check can run.' }),
  ] },
  { title: 'Legacy Claude roles', help: 'Fallback model and effort for legacy Claude role defaults. Task profiles take precedence.', fields: ['orchestrator', 'worker'].flatMap((role) => [field(`roles.${role}.model`, `${role} model`), field(`roles.${role}.effort`, `${role} effort`)]) },
  { title: 'Daemon', homeOnly: true, help: 'Global daemon settings. maxWorking = 0 means unlimited.', fields: [field('daemon.resumeOnStart', 'Resume on start'), ...['resumeMaxAgeDays', 'sessionsKeepDays', 'digestAfterMinutes', 'maxLiveNodes', 'maxWorking'].map((key) => field(`daemon.${key}`, key))] },
];
export function formatValue(value: unknown): string { return value === undefined ? 'Harness default / unset' : typeof value === 'string' ? value : JSON.stringify(value); }
export function inputValue(value: unknown, field: Field): string {
  return value === undefined ? '' : field.type === 'lines' && Array.isArray(value) ? value.join('\n') : String(value);
}
// null removes only the explicit target-layer value; untouched inherited fields never enter changes.
export function buildChanges(snapshot: SettingsSnapshot, drafts: Record<string, string | null>, fields: Field[]): Record<string, unknown | null> {
  const changes: Record<string, unknown | null> = {};
  for (const [key, raw] of Object.entries(drafts)) {
    const f = fields.find((f) => f.key === key);
    if (!f) throw new Error(`Unknown field: ${key}`);
    let value: unknown = raw;
    if (raw !== null) {
      if (f.type === 'number') { if (!raw.trim() || !Number.isFinite(Number(raw))) throw new Error(`${f.label}: enter a number.`); value = Number(raw); }
      else if (f.type === 'boolean') value = raw === 'true';
      else if (f.type === 'lines') {
        const lines = raw === '' ? [] : raw.split('\n').filter((line) => line.trim());
        const keyword = lines.find((line) => f.keywords?.includes(line.trim()));
        if (keyword && lines.length > 1) throw new Error(`${f.label}: put ${keyword.trim()} on its own, without other lines.`);
        value = keyword ? keyword.trim() : lines;
      }
      else if (!raw.trim()) throw new Error(`${f.label}: enter a value or use the inherited default.`);
    }
    if (value === null ? Object.hasOwn(snapshot.values, key) : JSON.stringify(value) !== JSON.stringify(snapshot.values[key])) changes[key] = value;
  }
  return changes;
}

/** The error of a claudeAccounts reply for an invalid accounts config: the daemon sends it as one view with no login command. */
export const accountsError = (accounts?: ClaudeAccountView[]) => (accounts?.length === 1 && accounts[0].error && !accounts[0].loginCommand ? accounts[0].error : undefined);

/** An account option: its name (with markDefault, " (default)" on the default one) and login state. */
export const accountOptionLabel = (a: ClaudeAccountView, markDefault = false) => `${a.name}${markDefault && a.isDefault ? ' (default)' : ''} · ${a.loggedIn ? [a.email, a.orgName].filter(Boolean).join(', ') || 'logged in' : a.loggedIn === false ? 'not logged in' : 'login unknown'}`;

/** Where the saved Claude account of root nodes comes from, at this scope. */
export function accountStatus(snapshot: SettingsSnapshot): string {
  const { effective, project } = snapshot.claudeAccount ?? {};
  if (snapshot.scope === 'home') return effective ? `Root nodes outside listed projects run in ${effective}.` : 'No default: root nodes outside listed projects use Claude’s default home.';
  if (project && project === snapshot.projectPath) return `This repository runs in ${effective}.`;
  if (project) return `Currently from ${effective} via ${project}.`;
  return effective ? `Currently from the global default (${effective}).` : 'Currently no account: Claude’s default home.';
}

export function cliStatus(source?: Pick<UsageSource, 'installed' | 'executableStatus'>): string {
  if (source?.installed === false) return 'Not detected';
  if (source?.installed !== true) return 'Unknown';
  if (source.executableStatus === 'broken') return 'Detected · version check failed';
  if (source.executableStatus === 'ready') return 'Detected · ready';
  return 'Detected · check unknown';
}

// The API snapshot resolves one reset at a time. It cannot reliably identify a
// lower-layer profile versus a legacy-role fallback from source paths alone.
export function fieldPreview(snapshot: SettingsSnapshot, drafts: Record<string, string | null>, field: Field) {
  const drafted = Object.hasOwn(drafts, field.key);
  const explicit = drafted ? drafts[field.key] !== null : Object.hasOwn(snapshot.values, field.key);
  const profile = /^profiles\.claude\.([^.]+)\.(model|effort)$/.exec(field.key);
  const role = profile?.[1] === 'orchestrator' ? 'orchestrator' : 'worker';
  const profileValueWins = drafted ? drafts[field.key] !== null : explicit && snapshot.values[field.key] === snapshot.entries[field.key]?.value;
  const previewUnavailable = !!profile && Object.hasOwn(drafts, `roles.${role}.${profile[2]}`) && !profileValueWins;
  const entry = previewUnavailable ? undefined : drafted ? drafts[field.key] === null ? snapshot.inherited[field.key] : { value: drafts[field.key], source: 'Unsaved change' } : snapshot.entries[field.key];
  const raw = previewUnavailable && !explicit ? '' : drafted && drafts[field.key] !== null ? drafts[field.key]! : inputValue(explicit ? snapshot.values[field.key] : snapshot.inherited[field.key]?.value, field);
  return { drafted, explicit, entry, raw, previewUnavailable };
}

export function optionLabel(key: string, value: string): string {
  const labels: Record<string, Record<string, string>> = {
    'approvals.close': { never: 'Always ask for approval', done: 'When all nodes are finished', always: 'Always allow' },
    'worktrees.isolation': { none: 'Shared working directory', worktree: 'Separate worktree' },
    'worktrees.mergeStyle': { merge: 'Merge commit', squash: 'Squash merge', 'ff-only': 'Fast-forward only' },
  };
  return labels[key]?.[value] ?? ({ banner: 'Banner', sound: 'Banner and sound', silent: 'Silent', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Maximum' }[value] ?? value);
}
