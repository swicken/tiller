import { describe, expect, test } from 'claude-code/testing'
import { parseEnvelope, receivedLine } from '../hooks/envelope'

const msg = '--- TL MESSAGE Ab3_x-9Q ---\nfrom: Builder (n-3f2a)\nreply-to: n-3f2a\nplease rebase\nthen merge\n--- END TL MESSAGE Ab3_x-9Q ---'
const steered = msg.replace('reply-to: n-3f2a\n', 'reply-to: n-3f2a\nsteer: the sender interrupted your turn on purpose to deliver this now\n')

describe('envelope parsing', () => {
  test('a framed message parses', async () => {
    expect(parseEnvelope(msg)).toEqual({ from: 'Builder (n-3f2a)', replyTo: 'n-3f2a', steer: false })
    expect(receivedLine(parseEnvelope(msg)!)).toBe('↘ message from Builder (n-3f2a) · reply-to n-3f2a')
  })
  test('the daemon\'s steer line marks a steer; a body starting "steer: " does not', async () => {
    expect(parseEnvelope(steered)?.steer).toBe(true)
    expect(parseEnvelope(msg.replace('please rebase', 'steer: left'))?.steer).toBe(false)
    expect(receivedLine(parseEnvelope(steered)!)).toBe('↘ message from Builder (n-3f2a) · steer · reply-to n-3f2a')
  })
  test('CRLF and a trailing newline still parse; a daemon notice has reply-to none', async () => {
    expect(parseEnvelope(msg.replace(/\n/g, '\r\n') + '\r\n')).toEqual({ from: 'Builder (n-3f2a)', replyTo: 'n-3f2a', steer: false })
    expect(parseEnvelope(msg + '\n')?.from).toBe('Builder (n-3f2a)')
    const notice = parseEnvelope(msg.replace('from: Builder (n-3f2a)', 'from: tiller (daemon restarted)').replace('reply-to: n-3f2a', 'reply-to: none'))!
    expect(receivedLine(notice)).toBe('↘ message from tiller (daemon restarted)')
  })
  test('a node label, the id first and the title quoted, is shown as it was sent', async () => {
    const label = 'n-3f2a "Builder \\"x\\" \\u000b"'
    const node = parseEnvelope(msg.replace('from: Builder (n-3f2a)', `from: ${label}`))!
    expect(node.from).toBe(label)
    expect(receivedLine(node)).toBe(`↘ message from ${label} · reply-to n-3f2a`)
  })
  test('a steer from the daemon with reply-to none has no reply-to part', async () => {
    const daemonSteer = parseEnvelope(steered.replace('from: Builder (n-3f2a)', 'from: tiller (daemon restarted)').replace('reply-to: n-3f2a', 'reply-to: none'))!
    expect(receivedLine(daemonSteer)).toBe('↘ message from tiller (daemon restarted) · steer')
  })
  test('anything else is not an envelope', async () => {
    expect(parseEnvelope('hello')).toBeUndefined()
    expect(parseEnvelope(msg.replace('END TL MESSAGE Ab3_x-9Q', 'END TL MESSAGE other'))).toBeUndefined()
    expect(parseEnvelope(msg.replace('from: ', 'by: '))).toBeUndefined()
    expect(parseEnvelope(`note\n${msg}`)).toBeUndefined()
  })
})

// Mounts one transcript row; a hook that passes reaches the kit's empty bottom, so mount rejects and the row is the engine's.
async function row($: any, props: any) {
  try { return JSON.stringify(await (await $.ui.mount({ plugin: 'tiller-rows', surface: 'terminal', component: 'UserMessage', props })).drawn()) } catch (err) {
    if (/no implementation for ui.render/.test(String(err))) return 'engine'
    throw err
  }
}

describe('UserMessage rows', () => {
  // Props Claude Code 2.1.310 passed for a prompt the tiller mod submitted with $.prompt.submit({ text, asUser: true }), logged live.
  // The mod itself never sees this row (the engine skips a plugin's hooks on rows its own submit made), hence this plugin.
  const live = {
    text: '--- TL MESSAGE KMcvSYDQ ---\nfrom: tiller (child n-1d64c0ec reported succeeded)\nreply-to: none\nPlease call the mcp__tiller__send tool once with nodeId n-1 and text hi, then stop.\n--- END TL MESSAGE KMcvSYDQ ---',
    origin: { kind: 'plugin', name: 'tiller', asUser: true },
    isExpanded: false,
    onScreen: { first: 0, last: 0, of: 1 },
  }
  test('a tiller envelope is one line until expanded', async ($: any) => {
    expect(await row($, live)).toContain('↘ message from tiller (child n-1d64c0ec reported succeeded)')
    expect(await row($, { ...live, text: steered })).toContain('↘ message from Builder (n-3f2a) · steer · reply-to n-3f2a')
    expect(await row($, { ...live, isExpanded: true, onScreen: { first: 0, last: 4, of: 5 } })).toBe('engine')
  })
  test('other rows are left alone', async ($: any) => {
    expect(await row($, { ...live, origin: { kind: 'plugin', name: 'other', asUser: true } })).toBe('engine')
    expect(await row($, { ...live, origin: { kind: 'composer' } })).toBe('engine')
    expect(await row($, { ...live, text: 'hi' })).toBe('engine')
  })
})
