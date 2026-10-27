import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { openExternalUrl } from './controls/externalLink';
import { getState, toast } from './store';
import { isAgentKind } from '../src/shared/protocol';
import { IN_APP } from './url';

export interface Term { term: Terminal; fit: FitAddon }
const terms = new Map<string, Term>();

const DARK: ITheme = {
  background: '#0e1116', foreground: '#d8dee6', cursor: '#d8dee6', selectionBackground: '#2f4a73',
  black: '#1b212a', red: '#f85149', green: '#3fb950', yellow: '#e3b341', blue: '#5b9cf5', magenta: '#bc8cff', cyan: '#4cc9e0', white: '#c9d1d9',
  brightBlack: '#6e7a8a', brightRed: '#ff7b72', brightGreen: '#56d364', brightYellow: '#f2cc60', brightBlue: '#79b8ff', brightMagenta: '#d2a8ff', brightCyan: '#76e3ea', brightWhite: '#f0f4f8',
};
const LIGHT: ITheme = {
  background: '#ffffff', foreground: '#24292f', cursor: '#24292f', selectionBackground: '#b6d4fe',
  black: '#24292f', red: '#cf222e', green: '#1a7f37', yellow: '#9a6700', blue: '#0550ae', magenta: '#8250df', cyan: '#0a7e8c', white: '#6e7781',
  brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#116329', brightYellow: '#7d4e00', brightBlue: '#0969da', brightMagenta: '#6639ba', brightCyan: '#1b7c83', brightWhite: '#8c959f',
};

const scheme = matchMedia('(prefers-color-scheme: light)');
const theme = () => (scheme.matches ? LIGHT : DARK);
scheme.addEventListener('change', () => terms.forEach(({ term }) => (term.options.theme = theme())));

export function getTerm(id: string): Term | undefined {
  return terms.get(id);
}

export function createTerm(id: string, el: HTMLElement): Term {
  // xterm 6 renders with the DOM renderer unless an addon is loaded, which keeps WKWebView happy.
  const term = new Terminal({
    fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace',
    fontSize: 13,
    cursorBlink: true,
    scrollback: 5000,
    theme: theme(),
    linkHandler: {
      activate: (_event, url) => {
        if (!/^https?:\/\//i.test(url)) return;
        if (IN_APP) {
          void openExternalUrl(url).catch(() => toast(`Could not open link: ${url}`, id, 'bad'));
        } else {
          window.open(url, '_blank', 'noopener,noreferrer');
        }
      },
    },
  });
  term.attachCustomKeyEventHandler((e) => shiftEnterKey(e, isAgentNode(id), (data) => term.input(data)));
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(el);
  const t = { term, fit };
  terms.set(id, t);
  return t;
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

export function disposeTerm(id: string) {
  terms.get(id)?.term.dispose();
  terms.delete(id);
}
