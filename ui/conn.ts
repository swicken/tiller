import type { ClientMessage, ServerMessage } from '../src/shared/protocol';
import { applyServer, getState, setConnected, update } from './store';
import { getTerm } from './terminals';
import { armOnFirstClick, handleNativeNotification, handleNotify, handleQuestion, initializeNativeNotifications } from './notify';
import { IN_APP, token } from './url';

let ws: WebSocket | undefined;
let attempt = 0;
let loadedSha: string | undefined;
let usageTimer: ReturnType<typeof setTimeout> | undefined;

export function send(m: ClientMessage) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
}

/** Discovery runs only on a connected explicit overview request, never on a timer. */
export function refreshUsage() {
  if (ws?.readyState !== WebSocket.OPEN || getState().usageSources === undefined) return;
  clearTimeout(usageTimer);
  update(() => ({ usageScanning: true }));
  send({ t: 'usageRefresh' });
  usageTimer = setTimeout(() => update(() => ({ usageScanning: false })), 5000);
}

/** Tell the daemon whether this window is in front, so it skips OS notifications for the node being looked at. */
const sendVisibility = () => send({ t: 'visibility', focused: document.hasFocus() && !document.hidden });

export function connect() {
  armOnFirstClick();
  for (const ev of ['focus', 'blur']) addEventListener(ev, sendVisibility);
  document.addEventListener('visibilitychange', sendVisibility);
  open();
}

function open() {
  const sock = (ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`));
  sock.onopen = () => {
    attempt = 0;
    send({ t: 'auth', token: token(), client: IN_APP ? 'app' : 'browser' });
    sendVisibility();
    if (IN_APP) void initializeNativeNotifications(send);
    setConnected(true); // TermViews re-attach on this transition
  };
  sock.onmessage = (e) => {
    let m: ServerMessage;
    try { m = JSON.parse(String(e.data)); } catch { return; }
    if (m.t === 'usageSources' || m.t === 'error') clearTimeout(usageTimer);
    if (m.t === 'snapshot' && m.update?.runtimeSha) {
      loadedSha ??= m.update.runtimeSha;
      if (loadedSha !== m.update.runtimeSha) return location.reload();
    }
    if (m.t === 'data') getTerm(m.id)?.term.write(m.data);
    else if (m.t === 'notify') handleNotify(m);
    else if (m.t === 'nativeNotify') void handleNativeNotification(m, send);
    else {
      if (m.t === 'question') handleQuestion(m.question);
      applyServer(m);
    }
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    clearTimeout(usageTimer);
    setConnected(false, attempt + 1);
    setTimeout(open, Math.min(10000, 500 * 2 ** attempt++));
  };
}
