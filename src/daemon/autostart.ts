// `tl autostart`: a launchd user agent that starts bin/tld at login and relaunches it after a crash, but not after a
// clean exit such as `tl stop`.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { daemonPort } from './home.js';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LABEL = 'com.tiller.daemon';
export const TLD = fileURLToPath(new URL('../../bin/tld', import.meta.url));
export const plistPath = (label = LABEL): string => join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);

export interface Agent { label: string; program: string; env: Record<string, string>; log: string }

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The agent's plist. KeepAlive SuccessfulExit false relaunches the daemon when it exits with a failure, not with 0. */
export function plist(a: Agent): string {
  const env = Object.entries(a.env).map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(a.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(a.program)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(a.log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(a.log)}</string>
</dict>
</plist>
`;
}

const target = (label: string) => `gui/${process.getuid!()}/${label}`;
const launchctl = (...args: string[]) => spawnSync('launchctl', args, { encoding: 'utf8' });
const check = (r: ReturnType<typeof launchctl>, what: string) => {
  if (r.status !== 0) throw new Error(`launchctl ${what} failed: ${(r.stderr || r.stdout).trim()}`);
};

/** Whether launchd has the agent loaded, and the pid of its daemon when one is running. */
export function agentStatus(label = LABEL, path = plistPath(label)): { installed: boolean; loaded: boolean; pid?: number } {
  const r = launchctl('print', target(label));
  const pid = r.status === 0 ? Number(/^\s*pid = (\d+)/m.exec(r.stdout)?.[1]) || undefined : undefined;
  return { installed: existsSync(path), loaded: r.status === 0, ...(pid ? { pid } : {}) };
}

/** Compare the installed agent's explicit home and effective port before using it for a daemon restart. */
export function agentMatches(home: string, port: number, path = plistPath()): boolean {
  try {
    const r = spawnSync('plutil', ['-extract', 'EnvironmentVariables', 'json', '-o', '-', path], { encoding: 'utf8' });
    if (r.status !== 0) return false;
    const env = JSON.parse(r.stdout) as Record<string, unknown>;
    if (env.TL_HOME !== home) return false;
    return daemonPort(home, typeof env.TL_PORT === 'string' ? env.TL_PORT : '') === port;
  } catch { return false; }
}

/**
 * Write the plist, load it and start the daemon (it exits 0 if another daemon already has the port). RunAtLoad covers
 * login; an agent bootstrapped mid-session is left pending (macOS 26: "pended nondemand spawn = speculative"), hence kickstart.
 */
export function install(a: Agent, path = plistPath(a.label)): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, plist(a));
  check(launchctl('bootstrap', `gui/${process.getuid!()}`, path), 'bootstrap');
  kickstart(a.label);
}

/** Unload the agent (launchd stops a daemon it started, with SIGTERM) and delete the plist. */
export function uninstall(label = LABEL, path = plistPath(label)): void {
  if (agentStatus(label).loaded) check(launchctl('bootout', target(label)), 'bootout');
  rmSync(path, { force: true });
}

/** Start the loaded agent's daemon, for `tl reload`, so the new daemon stays under launchd. */
export const kickstart = (label = LABEL): void => check(launchctl('kickstart', target(label)), 'kickstart');
