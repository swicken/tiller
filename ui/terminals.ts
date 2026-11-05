import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { openExternalUrl } from './controls/externalLink';
import { getState, toast } from './store';
import { isAgentKind } from '../src/shared/protocol';
import { IN_APP } from './url';
import { currentTheme, onThemeChange, type Theme } from './theme';

export interface Term { term: Terminal; fit: FitAddon }
const terms = new Map<string, Term>();

const DARK: ITheme = {
  background: '#0e1116', foreground: '#d8dee6', cursor: '#d8dee6', selectionBackground: '#2f4a73',
  black: '#1b212a', red: '#f85149', green: '#3fb950', yellow: '#e3b341', blue: '#5b9cf5', magenta: '#bc8cff', cyan: '#4cc9e0', white: '#c9d1d9',
  brightBlack: '#6e7a8a', brightRed: '#ff7b72', brightGreen: '#56d364', brightYellow: '#f2cc60', brightBlue: '#79b8ff', brightMagenta: '#d2a8ff', brightCyan: '#76e3ea', brightWhite: '#f0f4f8',
};
const LIGHT: ITheme = {
  background: '#ffffff', foreground: '#24292f', cursor: '#24292f', selectionBackground: '#b6d4fe',
  black: '#24292f', red: '#cf222e', green: '#1a7f37', yellow: '#9a6700', blue: '#0550ae', magenta: '#8250df', cyan: '#0a7e8c', white: '#4b535c',
  brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#116329', brightYellow: '#7d4e00', brightBlue: '#0969da', brightMagenta: '#6639ba', brightCyan: '#1b7c83', brightWhite: '#32383f',
};

// The terminal follows the app. xterm lifts low-contrast text in light only; dark renders as before.
const themeOptions = (t: Theme) => (t === 'light' ? { theme: LIGHT, minimumContrastRatio: 4.5 } : { theme: DARK, minimumContrastRatio: 1 });
onThemeChange((t) => terms.forEach(({ term }) => Object.assign(term.options, themeOptions(t))));

export function getTerm(id: string): Term | undefined {
  return terms.get(id);
}

/** `keys` sees each key event first, as xterm's custom key handler does: return false to keep the key from the terminal. */
export function createTerm(id: string, el: HTMLElement, keys?: (e: KeyboardEvent) => boolean): Term {
  // xterm 6 renders with the DOM renderer unless an addon is loaded, which keeps WKWebView happy.
  const term = new Terminal({
    fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace',
    fontSize: 13,
    cursorBlink: true,
    scrollback: 5000,
    ...themeOptions(currentTheme()),
    linkHandler: { activate: (_event, url) => openLink(url, id) },
  });
  term.attachCustomKeyEventHandler((e) => (keys?.(e) ?? true) && shiftEnterKey(e, isAgentNode(id), (data) => term.input(data)));
  const fit = new FitAddon();
  term.loadAddon(fit);
  // Plain-text URLs in terminal output; OSC 8 hyperlinks go through linkHandler above.
  term.loadAddon(new WebLinksAddon((_event, url) => openLink(url, id)));
  term.open(el);
  const t = { term, fit };
  terms.set(id, t);
  return t;
}

// Terminal output is untrusted, so only http(s) links open, whether OSC 8 or plain text.
function openLink(url: string, id: string) {
  if (!/^https?:\/\//i.test(url)) return;
  if (IN_APP) {
    void openExternalUrl(url).catch(() => toast(`Could not open link: ${url}`, id, 'bad'));
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

const isAgentNode = (id: string) => { const n = getState().nodes[id]; return !!n && isAgentKind(n.kind); };

/**
 * xterm sends CR for Shift+Enter, which submits an agent's prompt. In an agent node send LF (Ctrl+J)
 * instead: Claude Code, Pi and Codex all read it as "insert newline". Returns false when it handled the key.
 */
export function shiftEnterKey(e: KeyboardEvent, agent: boolean, input: (data: string) => void): boolean {
  if (!agent || e.key !== 'Enter' || !e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return true;
  if (e.isComposing || e.keyCode === 229) return true; // IME composition owns Enter
  if (e.type === 'keydown') { e.preventDefault(); input('\n'); }
  return false; // also swallow the keypress/keyup so xterm sends no CR
}

/**
 * Cmd+Enter inserts and Cmd+Backspace dismisses a waiting suggested command from the shell, so the keyboard alone is
 * enough. While a suggestion waits, those keys never reach the shell, so Cmd+Enter cannot also send Enter and run the line.
 */
export function suggestionKey(e: KeyboardEvent, pending: boolean, act: (action: 'insert' | 'dismiss') => void): boolean {
  // The suggestion clears as soon as the first keydown acts, so a held key's auto-repeats must not reach the shell either:
  // a repeated Cmd+Enter would send CR and run the inserted line. A fresh press always starts over: macOS browsers send
  // no keyup for a key released while Cmd is down, so the keyup cannot be what ends it.
  if (e.type === 'keydown' && !e.repeat) held = undefined;
  if (held === e.key) {
    if (e.type === 'keyup') held = undefined;
    if (e.type === 'keydown') e.preventDefault();
    return false;
  }
  if (!pending || !e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return true;
  const action = e.key === 'Enter' ? 'insert' : e.key === 'Backspace' ? 'dismiss' : undefined;
  if (!action) return true;
  if (e.type === 'keydown') { e.preventDefault(); held = e.key; act(action); }
  return false; // also swallow the keypress/keyup
}
// ponytail: one held key for all terminals, since only the focused one gets keys.
let held: string | undefined;

export function disposeTerm(id: string) {
  terms.get(id)?.term.dispose();
  terms.delete(id);
}
