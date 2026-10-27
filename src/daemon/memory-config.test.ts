import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyMemorySetting, memoryOn, switchMemory } from './memory-config.js';

let dir: string, home: string, repo: string, homeFile: string, projectFile: string;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'tl-memcfg-')));
  home = join(dir, 'home'); repo = join(dir, 'ws', 'repo');
  fs.mkdirSync(home); fs.mkdirSync(join(repo, 'sub'), { recursive: true });
  homeFile = join(home, 'config.json'); projectFile = join(repo, '.tiller', 'config.json');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });
const writeHome = (data: unknown) => fs.writeFileSync(homeFile, JSON.stringify(data));
const writeProject = (data: unknown) => { fs.mkdirSync(join(repo, '.tiller'), { recursive: true }); fs.writeFileSync(projectFile, JSON.stringify(data)); };
const homeData = () => JSON.parse(fs.readFileSync(homeFile, 'utf8'));
const work = (memory?: boolean) => ({ name: 'work', configDir: join(dir, 'claude-work'), ...(memory === undefined ? {} : { memory }) });

describe('memoryOn', () => {
  it('is off by default and creates no file', () => {
    expect(memoryOn(home, repo, undefined)).toEqual({ on: false, source: 'default' });
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it('follows the global memory.enabled', () => {
    writeHome({ memory: { enabled: true } });
    expect(memoryOn(home, repo, undefined)).toEqual({ on: true, source: `memory.enabled in ${homeFile}` });
    expect(memoryOn(home, null, undefined).on).toBe(true);
  });

  it('lets a project file turn memory off but never on', () => {
    writeHome({ memory: { enabled: true } });
    writeProject({ memory: { enabled: false } });
    expect(memoryOn(home, repo, undefined)).toEqual({ on: false, source: `memory.enabled in ${projectFile}` });
    writeHome({ memory: { projects: [{ path: repo, enabled: true }] }, claude: { accounts: [work(true)] } });
    expect(memoryOn(home, repo, 'work').on).toBe(false); // the project file beats a project entry and the account
    writeHome({});
    writeProject({ memory: { enabled: true } });
    expect(memoryOn(home, repo, undefined)).toEqual({ on: false, source: 'default' });
  });

  it('uses the longest memory.projects entry containing the project', () => {
    writeHome({ memory: { enabled: true, projects: [{ path: join(dir, 'ws'), enabled: false }, { path: repo, enabled: true }, { path: join(repo, 'sub'), enabled: false }] } });
    expect(memoryOn(home, repo, undefined)).toEqual({ on: true, source: `memory.projects ${repo} in ${homeFile}` });
    expect(memoryOn(home, join(repo, 'sub'), undefined).on).toBe(false);
    expect(memoryOn(home, join(dir, 'ws', 'other'), undefined).on).toBe(false);
    expect(memoryOn(home, join(dir, 'elsewhere'), undefined)).toEqual({ on: true, source: `memory.enabled in ${homeFile}` });
    expect(memoryOn(home, join(dir, 'ws', 'repo2'), undefined).on).toBe(false); // a sibling with a common prefix is not inside repo
  });

  it('treats an account memory false as a ceiling no project entry lifts', () => {
    writeHome({ memory: { enabled: true, projects: [{ path: repo, enabled: true }] }, claude: { accounts: [work(false)] } });
    expect(memoryOn(home, repo, 'work')).toEqual({ on: false, source: `claude.accounts work.memory in ${homeFile}` });
    expect(memoryOn(home, repo, undefined).on).toBe(true); // another account is unaffected
  });

  it('opts in by account below a project entry and above the global value', () => {
    writeHome({ memory: { projects: [{ path: repo, enabled: false }] }, claude: { accounts: [work(true)] } });
    expect(memoryOn(home, repo, 'work').on).toBe(false);
    expect(memoryOn(home, join(dir, 'elsewhere'), 'work')).toEqual({ on: true, source: `claude.accounts work.memory in ${homeFile}` });
    writeHome({ memory: { enabled: true }, claude: { accounts: [work()] } });
    expect(memoryOn(home, repo, 'work')).toEqual({ on: true, source: `memory.enabled in ${homeFile}` }); // unset: no say
  });

  it('uses claude.account for an undefined account, else skips the account steps', () => {
    writeHome({ memory: { enabled: true }, claude: { accounts: [work(false)], account: 'work' } });
    expect(memoryOn(home, repo, undefined)).toEqual({ on: false, source: `claude.accounts work.memory in ${homeFile}` });
    writeHome({ claude: { accounts: [work(true)], account: 'work' } });
    expect(memoryOn(home, repo, undefined).on).toBe(true);
    writeHome({ memory: { enabled: true }, claude: { accounts: [work(false)] } });
    expect(memoryOn(home, repo, undefined)).toEqual({ on: true, source: `memory.enabled in ${homeFile}` });
  });

  it('fails closed for a named account while claude.accounts is invalid or lacks it', () => {
    writeHome({ memory: { enabled: true }, claude: { accounts: [work(true), work(true)] } });
    expect(memoryOn(home, repo, 'work')).toMatchObject({ on: false, source: expect.stringContaining('duplicate account name work') });
    expect(memoryOn(home, repo, undefined).on).toBe(true); // no account: nothing to fail on
    writeHome({ memory: { enabled: true }, claude: { accounts: [work(true)] } });
    expect(memoryOn(home, repo, 'gone')).toMatchObject({ on: false, source: expect.stringContaining('"gone" is not configured') });
    writeHome({ memory: { enabled: true }, claude: { accounts: [work(true)], account: 'gone' } });
    expect(memoryOn(home, repo, undefined).on).toBe(false);
  });
});

describe('switchMemory', () => {
  it('sets and removes the global opt-in, keeping other settings', () => {
    writeHome({ approvals: { close: 'done' }, custom: 1 });
    switchMemory(home, {}, 'on');
    expect(homeData()).toEqual({ approvals: { close: 'done' }, custom: 1, memory: { enabled: true } });
    expect(memoryOn(home, repo, undefined).on).toBe(true);
    switchMemory(home, {}, 'off');
    expect(homeData().memory).toEqual({ enabled: false });
    switchMemory(home, {}, 'inherit');
    expect(homeData().memory).toEqual({});
  });

  it('creates the home file when there is none', () => {
    switchMemory(home, {}, 'on');
    expect(homeData()).toEqual({ memory: { enabled: true } });
  });

  it('replaces a project entry by its exact canonical path and removes it on inherit', () => {
    writeHome({ memory: { projects: [{ path: repo, enabled: false }, { path: join(repo, 'sub'), enabled: true }, { path: `${repo}/`, enabled: false }] } });
    switchMemory(home, { project: join(repo, 'sub', '..') }, 'on');
    expect(homeData().memory.projects).toEqual([{ path: join(repo, 'sub'), enabled: true }, { path: repo, enabled: true }]);
    expect(memoryOn(home, repo, undefined)).toEqual({ on: true, source: `memory.projects ${repo} in ${homeFile}` });
    switchMemory(home, { project: repo }, 'inherit');
    expect(homeData().memory.projects).toEqual([{ path: join(repo, 'sub'), enabled: true }]);
    expect(memoryOn(home, repo, undefined).on).toBe(false);
  });

  it('sets and removes an account opt-in, refusing an unknown account or both targets', () => {
    writeHome({ claude: { accounts: [work()] } });
    switchMemory(home, { account: 'work' }, 'off');
    expect(homeData().claude.accounts).toEqual([work(false)]);
    switchMemory(home, { account: 'work' }, 'inherit');
    expect(homeData().claude.accounts).toEqual([work()]);
    expect(() => switchMemory(home, { account: 'gone' }, 'on')).toThrow(/"gone" is not configured/);
    expect(() => switchMemory(home, { account: 'work', project: repo }, 'on')).toThrow(/not both/);
    expect(homeData().claude.accounts).toEqual([work()]);
  });

  it('applyMemorySetting changes the given data in place and writes nothing', () => {
    writeHome({ claude: { accounts: [work()] } });
    const bytes = fs.readFileSync(homeFile, 'utf8'), data = homeData();
    applyMemorySetting(data, home, { account: 'work' }, 'on');
    applyMemorySetting(data, home, { project: repo }, 'off');
    applyMemorySetting(data, home, {}, 'on');
    expect(data).toEqual({ claude: { accounts: [work(true)] }, memory: { enabled: true, projects: [{ path: repo, enabled: false }] } });
    expect(() => applyMemorySetting(data, home, { account: 'gone' }, 'on')).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => applyMemorySetting({ memory: 5 }, home, {}, 'on')).toThrow(expect.objectContaining({ status: 422 }));
    expect(fs.readFileSync(homeFile, 'utf8')).toBe(bytes);
  });

  it('refuses to write over a concurrent edit', () => {
    writeHome({ custom: 1 });
    const fsync = fs.fsyncSync;
    vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => { fsync(fd); fs.writeFileSync(homeFile, JSON.stringify({ custom: 2 })); });
    expect(() => switchMemory(home, {}, 'on')).toThrow(expect.objectContaining({ status: 409 }));
    expect(homeData()).toEqual({ custom: 2 });
    expect(fs.readdirSync(home)).toEqual(['config.json']); // no temp file left
  });
});
