/**
 * The connection survives a frontend reload, so the UI has to catch up.
 *
 * `tauri:dev` reloads the webview on every code change. That replaces the whole
 * frontend while the Rust process keeps reading the stream — deliberately, the
 * same way the reader survives the window being hidden to the tray. The new page
 * therefore starts from an idle room: the button says Connect and the badge says
 * "Not connected" while chat rows are still arriving, because nothing ever
 * stopped the reader.
 *
 * The fix is a snapshot, not a reconnect. This suite mounts the app the way a
 * reload does — a fresh page with the host already reading — and checks that the
 * status, the handle, the viewers and the feed all agree with the host again.
 *
 * What is pinned:
 *
 *   * a reloaded page recovers the connected state, the handle and the room;
 *   * the recovered state does not depend on a frame arriving afterwards;
 *   * frames from the recovered session are read;
 *   * a straggler from an older session is dropped, which is what makes the
 *     session in the snapshot worth carrying;
 *   * a host that reports nothing running leaves the page idle, so a reload after
 *     a Stop does not invent a connection;
 *   * the snapshot is not logged as an event that never happened.
 *
 *   node test/test-reload.mjs
 */

import { fakeTransport, flush, installDom, loadApp } from './dom.mjs'

process.env.NODE_ENV = 'development'

let failures = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const { entry } = await loadApp()
const { App, setTransport } = await import(entry)

const harness = installDom()
const React = (await import('react')).default
const { createRoot } = await import('react-dom/client')
const { act } = React

const doc = harness.dom.window.document
const $ = (selector) => doc.querySelector(selector)
const $$ = (selector) => [...doc.querySelectorAll(selector)]

const viewer = (over = {}) => ({ nickname: 'eko', id: 'u1', avatar: '', platform: 'tiktok', ...over })

/**
 * Mounts the app with the host already reading `snapshot`.
 *
 * `snapshot: null` stands for a host with nothing running — the state a reload
 * after a Stop must land in.
 */
async function mountWith(snapshot) {
  const fake = fakeTransport(snapshot ? { backend_status: snapshot } : {})
  setTransport(fake.transport)

  const container = doc.createElement('div')
  doc.body.append(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(React.createElement(App))
  })
  // The snapshot is fetched in an effect, so it lands a microtask after the mount.
  await flush()
  await act(async () => {})
  return { fake, root, container }
}

/** The state a host is in mid-stream, as `BackendState::snapshot` builds it. */
const LIVE = {
  type: 'status',
  platform: 'tiktok',
  connected: true,
  username: 'mybasic.indonesia',
  roomId: 'room-7',
  title: 'a title',
  viewers: 1234,
  session: 3,
  snapshot: true,
}

console.log('a reloaded page recovers the connection it was already reading')
const live = await mountWith(LIVE)
// The bug in one line: before the snapshot this read "Not connected" with a
// Connect button, over a feed that was still filling.
check(
  'the status names the room being read',
  /mybasic\.indonesia/.test($('.room-status')?.textContent ?? ''),
  $('.room-status')?.textContent,
)
check('the button offers Stop, not Connect', Boolean($('.room-row .btn-danger')), $('.room-row')?.textContent)
check('no Connect button is offered', !$$('.room-row .btn').some((b) => b.textContent.trim() === 'Connect'))
// The handle is in the field so the page does not look like it was never set up.
// No `@`: `normaliseUsername` strips it, and the field shows the bare handle.
check('the handle is filled in', $('.handle-input')?.value === 'mybasic.indonesia', $('.handle-input')?.value)
check('the field is locked while connected', $('.handle-input')?.disabled === true)
// The viewers figure comes back with it — the headcount is part of "what the
// reader is doing", and a page that showed 0 beside a live room would be wrong.
check(
  'the viewer count came back',
  /1[.,]234/.test($('.viewers .roll-number')?.getAttribute('aria-label') ?? ''),
  $('.viewers')?.textContent ?? $('.room-status')?.textContent,
)

console.log('the snapshot is state, not an event that happened')
// Applying it must not write a log line: nothing occurred, the page simply
// forgot. A "Connected to @x" line that never happened would mislead anyone
// reading the log to work out why a stream went quiet.
await act(async () => {
  $(doc.querySelector('.log-toggle') ? '.log-toggle' : 'body')?.click?.()
})
check(
  'no connection line was logged by the recovery',
  !$$('.log-line').some((l) => /Connected to @/.test(l.textContent ?? '')),
  $$('.log-line').map((l) => l.textContent).join(' | '),
)

console.log('a straggler from an older session is dropped')
// Emitted *before* any frame of the live session, which is the only order that
// tests the snapshot: were the session not adopted from it, `liveSession` would
// still be null, this frame would look like the first of a new session, and it
// would be accepted — a row from a room the page is no longer watching.
await act(async () => {
  live.fake.emit({ platform: 'tiktok', type: 'chat', ...viewer(), text: 'older session', session: 2, timestamp: 1700000001100 })
})
check(
  'the older frame is ignored',
  !$$('.row').some((r) => /older session/.test(r.textContent ?? '')),
  $$('.row').map((r) => r.textContent).join(' | '),
)

console.log('frames from the recovered session are read')
await act(async () => {
  live.fake.emit({ platform: 'tiktok', type: 'chat', ...viewer(), text: 'after reload', session: 3, timestamp: 1700000001000 })
})
check(
  'a chat frame from that session lands',
  $$('.row').some((r) => /after reload/.test(r.textContent ?? '')),
  $$('.row').map((r) => r.textContent).join(' | '),
)

await act(async () => {
  live.root.unmount()
})
live.container.remove()

console.log('a reload after a Stop comes back idle, not connected')
// The same code path, told nothing is running. A page that invented a connection
// here would show Stop over a reader that is gone — the same lie, reversed.
const idle = await mountWith({ ...LIVE, connected: false, username: '', roomId: '', title: '', viewers: null, session: 4 })
check('the button offers Connect', Boolean($$('.room-row .btn').find((b) => b.textContent.trim() === 'Connect')), $('.room-row')?.textContent)
check('and no Stop button is offered', !$('.room-row .btn-danger'))
check(
  'the status does not name a room',
  !/mybasic\.indonesia/.test($('.room-status')?.textContent ?? ''),
  $('.room-status')?.textContent,
)
await act(async () => {
  idle.root.unmount()
})
idle.container.remove()

console.log('a reload while the reader runs but is not live comes back to Stop')
// The reader is running while the stream is not live — a handshake in flight, or
// the source waiting for the streamer's live to start. `connected` alone would
// have the page offer Connect over a reader that still exists; the snapshot says
// `running`, so the control offered is the Stop that matches.
const waiting = await mountWith({
  ...LIVE,
  connected: false,
  running: true,
  username: '',
  roomId: '',
  title: '',
  viewers: null,
  session: 5,
})
check('the button offers Stop, not Connect', Boolean($('.room-row .btn-danger')), $('.room-row')?.textContent)
check('no Connect button is offered', !$$('.room-row .btn').some((b) => b.textContent.trim() === 'Connect'))
check(
  'the status does not read as idle',
  !/Not connected/.test($('.room-status')?.textContent ?? ''),
  $('.room-status')?.textContent,
)
await act(async () => {
  waiting.root.unmount()
})
waiting.container.remove()

console.log('a host with no answer leaves the page idle')
// An older host, or one whose command failed. Nothing to recover is the same as
// nothing running — the page must not be left in a half-state.
const none = await mountWith(null)
check('Connect is offered', Boolean($$('.room-row .btn').find((b) => b.textContent.trim() === 'Connect')), $('.room-row')?.textContent)
check('the status reads as not connected', /Not connected/.test($('.room-status')?.textContent ?? ''), $('.room-status')?.textContent)
await act(async () => {
  none.root.unmount()
})
none.container.remove()

setTransport(null)
harness.restore()

console.log(`\n${failures === 0 ? 'all passed' : `${failures} failed`}`)
process.exit(failures === 0 ? 0 : 1)
