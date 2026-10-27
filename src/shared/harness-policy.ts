/** Agent CLIs supported by Tiller. Legacy records default to Claude. */
export const HARNESSES = ['claude', 'pi', 'codex'] as const;
export type Harness = (typeof HARNESSES)[number];
export const HARNESS_LABELS: Record<Harness, string> = { claude: 'Claude', pi: 'Pi', codex: 'Codex' };

/** Task behavior, independent of the coordination role and selected harness. */
export const PROFILES = ['orchestrator', 'implementation', 'explorer', 'mechanical', 'reviewer'] as const;
export type Profile = (typeof PROFILES)[number];
export const PROFILE_LABELS: Record<Profile, string> = {
  orchestrator: 'Orchestrator', implementation: 'Implementation', explorer: 'Explorer', mechanical: 'Mechanical worker', reviewer: 'Reviewer',
};

/** Spawn/config effort vocabulary; each harness can accept a subset. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];
export const HARNESS_EFFORTS = {
  claude: EFFORTS,
  pi: EFFORTS,
  codex: ['low', 'medium', 'high', 'xhigh'],
} as const;

export const isSupportedEffort = (harness: Harness, effort: string): boolean =>
  (HARNESS_EFFORTS[harness] as readonly string[]).includes(effort);
