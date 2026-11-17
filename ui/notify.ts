import type { Question, ServerMessage } from '../src/shared/protocol';
import { rootOf } from './sidebar/sessions';
import { getState, recordActivity, selectNode, toast, type Tone } from './store';
import { IN_APP } from './url';

type Notify = Extract<ServerMessage, { t: 'notify' }>;

const TONE: Record<Notify['kind'], Tone> = { done: 'ok', needsYou: 'warn', errored: 'bad', exited: 'info' };

let ctx: AudioContext | undefined;
const lastNotified = new Map<string, number>();

/** At most one chime per node every 5 s. */
function throttled(id: string): boolean {
  const now = Date.now();
  if (now - (lastNotified.get(id) ?? 0) < 5000) return true;
  lastNotified.set(id, now);
  return false;
}

function tone(freq: number, at: number, dur: number) {
  const c = (ctx ??= new AudioContext());
  const o = c.createOscillator();
  const g = c.createGain();
  o.frequency.value = freq;
  g.gain.setValueAtTime(0.15, c.currentTime + at);
  g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + at + dur);
  o.connect(g).connect(c.destination);
  o.start(c.currentTime + at);
  o.stop(c.currentTime + at + dur);
}

function chime(kind: Notify['kind']) {
  if (kind === 'exited') return;
  try {
    void ctx?.resume();
    if (kind === 'done') { tone(880, 0, 0.15); tone(1175, 0.15, 0.25); }
    else { tone(330, 0, 0.2); tone(262, 0.25, 0.3); }
  } catch { /* audio unavailable */ }
}

export function handleNotify(m: Notify) {
  const text = m.body ? `${m.title}: ${m.body}` : m.title;
  recordActivity(text, m.id, TONE[m.kind]);
  if (m.kind === 'errored' || m.kind === 'needsYou') toast(text, m.id, TONE[m.kind]);
  // Raw events are in-app feedback only; OS delivery requires a separate daemon-approved offer.
  if (!IN_APP && !throttled(m.id)) chime(m.kind);
}

/**
 * A question message, handled before the store takes it. Only a new open question counts as news: a snapshot never
 * comes here, and a change to one we already hold is not asked again. The toast is skipped when its words are already
 * on screen (the reminder shows the session's first question) because the person is looking at that session.
 */
export function handleQuestion(q: Question) {
  const { questions, nodes, session } = getState();
  if (questions[q.id] || q.state !== 'open') return;
  recordActivity(`${nodes[q.nodeId]?.title ?? q.nodeId} asks: ${q.question}`, q.nodeId, 'warn');
  if (!IN_APP && !throttled(q.nodeId)) chime('needsYou');
  if (session !== rootOf(nodes, q.nodeId) || !document.hasFocus()) toast(q.question, q.nodeId, 'warn', q.id);
}

/** Browsers only allow audio to start from a user gesture. */
export function armOnFirstClick() {
  addEventListener('click', () => { ctx ??= new AudioContext(); }, { once: true });
}

type NativeNotify = Extract<ServerMessage, { t: 'nativeNotify' }>;
type NativeReply = Extract<import('../src/shared/protocol').ClientMessage, { t: 'nativeNotifyReady' | 'nativeNotifyResult' }>;
let actionListener: Promise<unknown> | undefined;

function nativeInvoke(command: string, args: object = {}): Promise<unknown> {
  const tauri = (window as import('./hooks').TauriWindow).__TAURI_INTERNALS__;
  if (!tauri) return Promise.reject(new Error('Native notification plugin unavailable. Rebuild and relaunch Tiller.'));
  return tauri.invoke(command, args);
}

/** Advertise capability only after the official plugin can report notification clicks. */
export async function initializeNativeNotifications(reply: (message: NativeReply) => void) {
  if (!IN_APP) return;
  try {
    const plugin = await import('@tauri-apps/plugin-notification');
    actionListener ??= plugin.onAction((event) => {
      const id = event.notification?.extra?.nodeId;
      if (typeof id !== 'string') return;
      selectNode(id);
      void nativeInvoke('plugin:window|show').then(() => nativeInvoke('plugin:window|set_focus')).catch((error) => toast(`Cannot focus notification: ${String(error)}`, id, 'bad'));
    }).catch((error) => { actionListener = undefined; throw error; });
    await actionListener;
    reply({ t: 'nativeNotifyReady', ok: true });
  } catch (error) {
    const message = String(error);
    toast(`Native notifications unavailable: ${message}`, undefined, 'bad');
    reply({ t: 'nativeNotifyReady', ok: false, error: message.slice(0, 1000) });
  }
}

/** Raw notify events never call this; this payload was approved and dispatched once by the daemon. */
export async function handleNativeNotification(message: NativeNotify, reply: (message: NativeReply) => void) {
  try {
    if (!IN_APP || !actionListener) throw new Error('Native notifications are not ready.');
    await actionListener;
    const plugin = await import('@tauri-apps/plugin-notification');
    if (!await plugin.isPermissionGranted() && await plugin.requestPermission() !== 'granted') throw new Error('Notifications are not allowed. Enable them in system settings.');
    const { id, title, subtitle, body, sound } = message.notification;
    // The official sendNotification wrapper returns void. Await its command to observe submission rejection.
    await nativeInvoke('plugin:notification|notify', { options: { title, body: subtitle ? `${subtitle}\n${body}` : body, ...(sound ? { sound: 'NSUserNotificationDefaultSoundName' } : {}), extra: { nodeId: id } } });
    reply({ t: 'nativeNotifyResult', requestId: message.requestId, ok: true });
  } catch (error) {
    const detail = String(error);
    toast(`Native notification: ${detail}`, message.notification.id, 'bad');
    reply({ t: 'nativeNotifyResult', requestId: message.requestId, ok: false, error: detail.slice(0, 1000) });
  }
}
