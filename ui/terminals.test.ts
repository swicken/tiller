import { afterEach, expect, it, vi } from 'vitest';
import { Terminal, type ITerminalOptions } from '@xterm/xterm';
import { createTerm, disposeTerm, shiftEnterKey, suggestionKey } from './terminals';
import { openExternalUrl } from './controls/externalLink';
import { toast } from './store';

const state = vi.hoisted(() => ({ native: true, theme: 'dark' as 'light' | 'dark', onTheme: [] as ((t: 'light' | 'dark') => void)[] }));
vi.mock('@xterm/xterm', () => ({ Terminal: vi.fn(class {
  options: ITerminalOptions;
  constructor(options: ITerminalOptions) { this.options = { ...options }; }
  loadAddon = vi.fn();
  open = vi.fn();
  dispose = vi.fn();
  attachCustomKeyEventHandler = vi.fn();
  input = vi.fn();
}) }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: vi.fn(class {}) }));
vi.mock('./url', () => ({ get IN_APP() { return state.native; } }));
vi.mock('./controls/externalLink', () => ({ openExternalUrl: vi.fn() }));
vi.mock('./theme', () => ({ currentTheme: () => state.theme, onThemeChange: (fn: (t: 'light' | 'dark') => void) => state.onTheme.push(fn) }));
vi.mock('./store', () => ({ toast: vi.fn(), getState: () => ({ nodes: { node: { kind: 'agent' }, shell: { kind: 'terminal' } } }) }));

afterEach(() => {
  disposeTerm('node');
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  state.native = true;
  state.theme = 'dark';
});

const lastTerm = () => vi.mocked(Terminal).mock.results.at(-1)!.value as { options: ITerminalOptions };
const setTheme = (t: 'light' | 'dark') => { state.theme = t; state.onTheme.forEach((fn) => fn(t)); };

it('opens with the resolved theme and lifts contrast in light only', () => {
  createTerm('node', {} as HTMLElement);
  expect(lastTerm().options).toMatchObject({ theme: { background: '#0e1116' }, minimumContrastRatio: 1 });
  disposeTerm('node');
  state.theme = 'light';
  createTerm('node', {} as HTMLElement);
  expect(lastTerm().options).toMatchObject({ theme: { background: '#ffffff' }, minimumContrastRatio: 4.5 });
});

it('switches open terminals when the app theme changes', () => {
  createTerm('node', {} as HTMLElement);
  const { options } = lastTerm();
  setTheme('light');
  expect(options).toMatchObject({ theme: { background: '#ffffff' }, minimumContrastRatio: 4.5 });
  setTheme('dark');
  expect(options).toMatchObject({ theme: { background: '#0e1116' }, minimumContrastRatio: 1 });
});

function linkHandler() {
  createTerm('node', {} as HTMLElement);
  const options = vi.mocked(Terminal).mock.calls.at(-1)![0] as ITerminalOptions;
  return options.linkHandler!;
}

function activate(url: string) {
  const handler = linkHandler();
  expect(handler.allowNonHttpProtocols).not.toBe(true);
  handler.activate({} as MouseEvent, url, { start: { x: 1, y: 1 }, end: { x: 6, y: 1 } });
}

it('opens terminal Markdown hyperlink targets through the native browser command', () => {
  vi.mocked(openExternalUrl).mockResolvedValue(undefined);
  activate('https://github.com/example/tiller/issues/38072');
  expect(openExternalUrl).toHaveBeenCalledExactlyOnceWith('https://github.com/example/tiller/issues/38072');
});

it('reports native browser failures instead of silently ignoring the click', async () => {
  vi.mocked(openExternalUrl).mockRejectedValue(new Error('No browser'));
  activate('https://example.com');
  await Promise.resolve();
  expect(toast).toHaveBeenCalledExactlyOnceWith('Could not open link: https://example.com', 'node', 'bad');
});

it('opens browser UI links in an isolated new tab', () => {
  state.native = false;
  const open = vi.fn();
  vi.stubGlobal('window', { open });
  activate('http://example.com/path?q=1#note');
  expect(open).toHaveBeenCalledExactlyOnceWith('http://example.com/path?q=1#note', '_blank', 'noopener,noreferrer');
  expect(openExternalUrl).not.toHaveBeenCalled();
});

it.each(['javascript:alert(1)', 'file:///tmp/file', 'mailto:a@example.com', '//example.com'])(
  'does not open unsafe terminal hyperlink targets: %s', (url) => {
    const open = vi.fn();
    vi.stubGlobal('window', { open });
    activate(url);
    state.native = false;
    activate(url);
    expect(openExternalUrl).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  },
);

function key(init: KeyboardEventInit & { type?: string; keyCode?: number }) {
  return { type: 'keydown', key: 'Enter', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, isComposing: false, keyCode: 13, preventDefault: vi.fn(), ...init } as unknown as KeyboardEvent;
}

it('sends LF for Shift+Enter in an agent node and swallows the rest of the key', () => {
  const input = vi.fn();
  const down = key({ shiftKey: true });
  expect(shiftEnterKey(down, true, input)).toBe(false);
  expect(down.preventDefault).toHaveBeenCalledOnce();
  expect(shiftEnterKey(key({ type: 'keypress', shiftKey: true }), true, input)).toBe(false);
  expect(shiftEnterKey(key({ type: 'keyup', shiftKey: true }), true, input)).toBe(false);
  expect(input).toHaveBeenCalledExactlyOnceWith('\n');
});

it.each([
  ['plain Enter', key({}), true],
  ['Option+Enter', key({ shiftKey: true, altKey: true }), true],
  ['Shift+Enter in a terminal node', key({ shiftKey: true }), false],
  ['Shift+Enter while composing', key({ shiftKey: true, isComposing: true }), true],
  ['Enter while composing (keyCode 229)', key({ keyCode: 229 }), true],
])('leaves %s to xterm', (_name, e, agent) => {
  const input = vi.fn();
  expect(shiftEnterKey(e, agent, input)).toBe(true);
  expect(input).not.toHaveBeenCalled();
  expect(e.preventDefault).not.toHaveBeenCalled();
});

it('routes Shift+Enter by the node kind at key time', () => {
  for (const id of ['node', 'shell']) {
    createTerm(id, {} as HTMLElement);
    const term = vi.mocked(Terminal).mock.results.at(-1)!.value as { attachCustomKeyEventHandler: ReturnType<typeof vi.fn>; input: ReturnType<typeof vi.fn> };
    const handler = term.attachCustomKeyEventHandler.mock.calls[0][0] as (e: KeyboardEvent) => boolean;
    expect(handler(key({ shiftKey: true }))).toBe(id === 'shell');
    expect(term.input.mock.calls).toEqual(id === 'shell' ? [] : [['\n']]);
    disposeTerm(id);
  }
});

it('inserts on Cmd+Enter and dismisses on Cmd+Backspace while a suggestion waits, keeping both keys from the shell', () => {
  const act = vi.fn();
  const down = key({ metaKey: true });
  expect(suggestionKey(down, true, act)).toBe(false); // false: xterm must not also send Enter, which would run the line
  expect(down.preventDefault).toHaveBeenCalledOnce();
  expect(suggestionKey(key({ type: 'keyup', metaKey: true }), true, act)).toBe(false);
  expect(suggestionKey(key({ key: 'Backspace', metaKey: true }), true, act)).toBe(false);
  expect(act.mock.calls).toEqual([['insert'], ['dismiss']]);
});

it('keeps a held Cmd+Enter from the shell after its insert clears the suggestion, so auto-repeat cannot send CR and run it', () => {
  const act = vi.fn();
  expect(suggestionKey(key({ metaKey: true }), true, act)).toBe(false);
  // The daemon has cleared the suggestion: pending is false from here on, yet the key is still held down.
  const repeat = key({ metaKey: true, repeat: true });
  expect(suggestionKey(repeat, false, act)).toBe(false);
  expect(repeat.preventDefault).toHaveBeenCalledOnce();
  expect(suggestionKey(key({ type: 'keypress', metaKey: true }), false, act)).toBe(false);
  expect(suggestionKey(key({ type: 'keyup', metaKey: true }), false, act)).toBe(false);
  expect(act.mock.calls).toEqual([['insert']]); // acted once, never again for the repeats
  // Released: the next Enter is the shell's again.
  expect(suggestionKey(key({}), false, act)).toBe(true);
  expect(suggestionKey(key({ metaKey: true }), false, act)).toBe(true);
});

it.each([
  ['Cmd+Enter with no suggestion', key({ metaKey: true }), false],
  ['plain Enter', key({}), true],
  ['Cmd+Shift+Enter', key({ metaKey: true, shiftKey: true }), true],
  ['Ctrl+Backspace', key({ key: 'Backspace', ctrlKey: true }), true],
  ['Cmd+K', key({ key: 'k', metaKey: true }), true],
])('leaves %s to the shell', (_name, e, pending) => {
  const act = vi.fn();
  expect(suggestionKey(e, pending, act)).toBe(true);
  expect(act).not.toHaveBeenCalled();
});
