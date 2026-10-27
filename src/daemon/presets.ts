// Spawn presets: <cwd>/.tiller/agents/<name>.md, else <home>/agents/<name>.md. Read fresh on every call.
// Frontmatter uses Claude agent-definition fields (model, tools, disallowedTools, permissionMode, maxTurns) plus
// tiller's effort, isolation and role; the body replaces the role prompt text.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { EFFORTS, ISOLATIONS, PROFILES, ROLES } from '../shared/protocol.js';

export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'] as const;

const toolList = z.preprocess((v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : v), z.array(z.string().min(1)));
const Frontmatter = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  model: z.string().min(1).optional(),
  tools: toolList.optional(),
  disallowedTools: toolList.optional(),
  permissionMode: z.enum(PERMISSION_MODES).optional(),
  maxTurns: z.coerce.number().int().positive().optional(),
  effort: z.enum(EFFORTS).optional(),
  isolation: z.enum(ISOLATIONS).optional(),
  role: z.enum(ROLES).optional(),
  profile: z.enum(PROFILES).optional(),
});

export type Preset = Omit<z.infer<typeof Frontmatter>, 'name'> & { name: string; body: string; source: string };

const NAME = /^[\w.-]+$/;

const presetDirs = (cwd: string, home: string): string[] => [join(cwd, '.tiller', 'agents'), join(home, 'agents')];

/**
 * Parses `---` frontmatter of `key: value` lines, where a value may be `[a, b]` or followed by `- item` lines, then
 * the body. Unknown keys are ignored, as Claude ignores them; a bad value throws naming the file.
 */
export function parsePreset(text: string, source: string): Preset {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(text);
  const fields: Record<string, string | string[]> = {};
  let last: string | undefined;
  for (const line of (m?.[1] ?? '').split(/\r?\n/)) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && last) { fields[last] = [...(Array.isArray(fields[last]) ? fields[last] : []), unquote(item[1])]; continue; }
    const kv = /^([A-Za-z]\w*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    last = kv[1];
    const v = kv[2].trim();
    fields[last] = v.startsWith('[') && v.endsWith(']') ? v.slice(1, -1).split(',').map(unquote).filter(Boolean) : unquote(v);
  }
  const r = Frontmatter.safeParse(Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== '')));
  if (!r.success) throw new Error(`invalid preset ${source}: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const { name: _, ...rest } = r.data;
  return { ...rest, name: basename(source, '.md'), body: (m ? m[2] : text).trim(), source };
}

const unquote = (s: string) => s.trim().replace(/^(['"])(.*)\1$/, '$2');

/** The preset `name` for `cwd`: the repo file wins over the home file. Throws when neither exists or it is invalid. */
export function loadPreset(name: string, cwd: string, home: string): Preset {
  if (!NAME.test(name)) throw new Error(`invalid preset name: ${name}`);
  for (const dir of presetDirs(cwd, home)) {
    const path = join(dir, `${name}.md`);
    if (existsSync(path)) return parsePreset(readFileSync(path, 'utf8'), path);
  }
  throw new Error(`no preset "${name}" in ${presetDirs(cwd, home).join(' or ')}`);
}

/** Every preset in effect for `cwd`, by name; an invalid file is listed with its error instead. */
export function listPresets(cwd: string, home: string): (Preset | { name: string; source: string; error: string })[] {
  const seen = new Map<string, Preset | { name: string; source: string; error: string }>();
  for (const dir of presetDirs(cwd, home)) {
    let files: string[] = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort(); } catch { continue; }
    for (const f of files) {
      const name = basename(f, '.md'), path = join(dir, f);
      if (seen.has(name) || !NAME.test(name)) continue;
      try { seen.set(name, parsePreset(readFileSync(path, 'utf8'), path)); } catch (e) { seen.set(name, { name, source: path, error: (e as Error).message }); }
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// The reviewer sets no permissionMode so it inherits its parent's: plan mode would ask the human before every
// tiller MCP call, report_outcome included, and without Edit and Write any inherited mode is read-only enough.
export const DEFAULT_PRESETS = {
  reviewer: `---
name: reviewer
description: Reviews a worker's branch or diff against its brief, runs the checks and reports findings without fixing anything.
disallowedTools: Edit, Write, NotebookEdit
isolation: none
effort: medium
role: worker
profile: reviewer
---
# Reviewer

You review another node's work; you have not seen its reasoning, only its result. Your brief names the worker (node id or branch) and its brief. From the main checkout, read what changed with \`git diff <base>...<branch>\` or \`tl diff <id>\`, check it against the brief, and run the project's checks (tests, type checks) where you can. Look for correctness bugs, missed requirements, unsafe changes and needless complexity. Do not fix anything and do not edit files.

When done, call report_outcome: "succeeded" if the work meets the brief, "failed" if it does not. Put the verdict in summary, and each finding in openQuestions as "<severity>: <file:line> <problem>", most severe first (blocker, major, minor). Put what you ran and its result in verified. Your parent is told when the outcome is recorded, so do not also send it a summary.
`,
  researcher: `---
name: researcher
description: Read-only research in the codebase and on the web; changes nothing.
tools: Read, Grep, Glob, WebSearch, WebFetch
isolation: none
role: worker
profile: explorer
---
# Researcher

You answer a question by reading code, documents and the web. You have no shell and cannot edit files or run git commands that change anything. Cite file:line references and URLs for what you found, say plainly what you could not confirm, and when done call report_outcome with the answer in summary; your parent is told when it is recorded, so do not also send it a summary.
`,
} as const;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * Writes the built-in presets into <home>/agents. <home>/agents/.builtin.json records a hash of what tiller last
 * wrote, so a file that still matches it is refreshed when the built-in changes, and a file the user edited stays.
 */
export function ensurePresets(home: string): void {
  const dir = join(home, 'agents'), recordPath = join(dir, '.builtin.json');
  mkdirSync(dir, { recursive: true });
  let record: Record<string, string> = {};
  try { record = JSON.parse(readFileSync(recordPath, 'utf8')); } catch { /* no record yet */ }
  for (const [name, text] of Object.entries(DEFAULT_PRESETS)) {
    const path = join(dir, `${name}.md`);
    let current: string | undefined;
    try { current = readFileSync(path, 'utf8'); } catch { /* missing */ }
    if (current !== text) {
      if (current !== undefined) {
        if (sha256(current) !== record[name]) continue; // edited, or written before the record existed: keep it
        console.error(`tiller: refreshed built-in preset ${path}`);
      }
      writeFileSync(path, text);
    }
    record[name] = sha256(text);
  }
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
}
