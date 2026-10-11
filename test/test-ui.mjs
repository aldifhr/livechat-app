/**
 * The UI, tested without launching the app.
 *
 * Every check runs in jsdom against the real components, with the transport to
 * the Rust host replaced by a fake. That is the point: no window, no debug port,
 * no WebView2, and no dependence on either platform being live — so this suite is
 * deterministic and takes milliseconds.
 *
 *   node test/test-ui.mjs
 */

import { fakeTransport, flush, installDom, loadApp } from './dom.mjs'

// Before React is imported: it picks its development or production build at load
// time, and the production build throws on `act`. Setting it afterwards is too
// late, which is a confusing failure to chase.
process.env.NODE_ENV = 'development'

const { entry } = await loadApp()
const { App, setTransport, DEFAULT_BASE_URL: DEFAULT_BACKEND } = await import(entry)

const harness = installDom()
const React = (await import('react')).default
const { createRoot } = await import('react-dom/client')
const { act } = React

const fake = fakeTransport({
  // Answers the one command that needs a real payload for the settings dialog to
  // have anything to show.
  llm_config_get: { baseUrl: '', apiKey: '', model: '' },
})
setTransport(fake.transport)

const root = createRoot(harness.container)
await act(async () => {
  root.render(React.createElement(App))
})
await flush()

const doc = harness.dom.window.document
let failures = 0

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const $ = (selector) => doc.querySelector(selector)
const $$ = (selector) => [...doc.querySelectorAll(selector)]

/** Sets a React-controlled input the way a user would. */
/** Accepts a selector or an element, so a test can address the second room's field. */
async function type(target, value) {
  const el = typeof target === 'string' ? $(target) : target
  if (!el) throw new Error(`no input matching ${target}`)
  const setter = Object.getOwnPropertyDescriptor(harness.dom.window.HTMLInputElement.prototype, 'value').set
  await act(async () => {
    setter.call(el, value)
    el.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }))
  })
}

async function click(selector) {
  const el = typeof selector === 'string' ? $(selector) : selector
  if (!el) throw new Error(`no element matching ${selector}`)
  await act(async () => {
    el.dispatchEvent(new harness.dom.window.MouseEvent('click', { bubbles: true }))
  })
}

const viewer = (over = {}) => ({ nickname: 'eko', id: 'u1', avatar: '', platform: 'tiktok', ...over })

console.log('the app mounts with nothing connected')
check('the empty prompt is shown', /No messages yet/.test($('.empty-title')?.textContent ?? ''))
// One room, so there is no platform picker to choose between and no per-room
// chip: both of those were ways of picking which room to read, and with one room
// neither has anything to pick.
check('no platform picker is offered', $$('.platform').length === 0)
check('no room chips are offered', !$('.room-filters'))
check('no source picker is offered', !$('.source-row'))
check('one room row', $$('.room-row').length === 1)
check('the log panel is closed', !$('.log-list'))
// Mounting connects to nothing. It does read the backend settings and sync the
// window state, and those are the only commands that may be sent unasked.
check(
  'nothing was connected just by mounting',
  fake.commands.every((c) => c.command !== 'backend_connect' && c.command !== 'backend_disconnect'),
  JSON.stringify(fake.commands),
)

console.log('the handle is asked for in front, not in a dialog')
// The address is built in, so the only thing a user has to supply is which stream
// to read. That question belongs where they land, not two clicks in.
const connectButton = () => $('.room-row .btn-primary')
const handleInput = () => $('.handle-input')
check('there is a handle field', Boolean(handleInput()))
check('it starts empty', handleInput().value === '')
check('connect is disabled until there is something to connect to', connectButton()?.disabled === true)
check('and the toolbar says what it wants', /Type the handle/.test($('.source-note')?.textContent ?? ''), $('.source-note')?.textContent)

await type(handleInput(), '@mybasic.indonesia')
check('the value reached React state', handleInput().value === '@mybasic.indonesia', handleInput().value)
check('connect becomes possible', connectButton()?.disabled === false, `disabled=${connectButton()?.disabled}`)

console.log('the handle is remembered without being asked twice')
// Debounced, so this waits rather than checking instantly.
await new Promise((done) => setTimeout(done, 600))
const remembered = fake.lastCommand('backend_config_save')
// Saved as configured rather than with the built-in address substituted in. The
// host applies that same default when it reads the field back, so writing it
// here only meant a user's first handle edit silently stored a backend address
// they had never chosen. What matters is that the field is carried, not filled.
check(
  'the address is saved as the user has it',
  remembered?.args?.config?.baseUrl === '',
  JSON.stringify(remembered?.args?.config),
)
check('and the handle without its @', remembered?.args?.config?.username === 'mybasic.indonesia', JSON.stringify(remembered?.args?.config))

console.log('connecting asks the host for the right thing')
await click(connectButton())
const asked = fake.lastCommand('backend_connect')
check(
  'with the built-in address and the typed handle',
  JSON.stringify(asked) ===
    JSON.stringify({
      command: 'backend_connect',
      args: { config: { baseUrl: DEFAULT_BACKEND, username: 'mybasic.indonesia' } },
    }),
  JSON.stringify(asked),
)

console.log('frames drive the feed')
await act(async () => {
  fake.emit({ platform: 'tiktok', type: 'status', connected: true, message: 'Connected to @x' })
})
check('the status updated', /Connected to @x/.test($('.room-status')?.textContent ?? ''))
check('the Stop button appeared', !!$('.room-row .btn-danger'))

await act(async () => {
  fake.emit({ platform: 'tiktok', type: 'room', username: 'x', roomId: '1', title: 'A title' })
  fake.emit({ platform: 'tiktok', type: 'viewers', count: 1234 })
  fake.emit({ platform: 'tiktok', type: 'chat', ...viewer(), text: 'halo dunia', timestamp: 1700000000000 })
  fake.emit({ platform: 'tiktok', type: 'gift', ...viewer({ id: 'u2' }), giftName: 'Rose', count: 3, diamonds: 3, timestamp: 1700000001000 })
})
check('two rows rendered', $$('.row').length === 2, String($$('.row').length))
check('the chat text is shown', $$('.row .text')[0]?.textContent === 'halo dunia')
check('the gift row names the gift', /Rose x3/.test($$('.row .event')[0]?.textContent ?? ''))
// A gift whose catalogue entry never arrived still has to render, with no space
// held open for a picture that is not coming.
await act(async () => {
  fake.emit({
    platform: 'tiktok',
    type: 'gift',
    ...viewer({ id: 'u2b' }),
    giftName: 'Galaksi',
    count: 1,
    diamonds: 7,
    giftImage: 'https://p16.example.test/galaksi.png',
    timestamp: 1700000001500,
  })
})
const picturedRow = $$('.row').find((r) => /Galaksi/.test(r.textContent ?? ''))
check('a gift with a picture shows it in the feed', picturedRow?.querySelector('.gift-image')?.getAttribute('src') === 'https://p16.example.test/galaksi.png', picturedRow?.innerHTML)
// Separators are locale-dependent — id-ID writes 1.234, en-US writes 1,234 — so
// the assertion matches the digits rather than the separator.
check('the viewer count is shown', /1[.,]234 watching/.test($('.room-status')?.textContent ?? ''), $('.room-status')?.textContent)
check('the room title is shown', $('.room-title')?.textContent === 'A title')
check('every row carries its platform tag', $$('.row .room-tag').every((t) => t.textContent === 'TT'))

console.log('the live ending is its own state, not an error')
// The whole point of the flag: a finished live and a dropped socket look the same
// from the feed, and putting them in one state would paint a normal outcome in
// the error colour and send the app looking for something to reconnect to.
await act(async () => {
  fake.emit({
    platform: 'tiktok',
    type: 'status',
    connected: false,
    liveEnded: true,
    message: '@mybasic.indonesia is no longer live',
  })
})
check(
  'the status says the live ended',
  /no longer live/.test($('.room-status')?.textContent ?? ''),
  $('.room-status')?.textContent,
)
check('and it is not styled as an error', !$('.status-error'), $('.room-status')?.className)
check('the ended state is applied', !!$('.status-ended'), $('.room-status')?.className)

// A dropped connection, by contrast, is not a finished live and must not claim to
// be one — otherwise the retry that follows a network blip never happens.
await act(async () => {
  fake.emit({ platform: 'tiktok', type: 'status', connected: false, message: 'Disconnected' })
})
check(
  'a plain disconnect does not say the live ended',
  !/no longer live/.test($('.room-status')?.textContent ?? ''),
  $('.room-status')?.textContent,
)

console.log('the feed respects its cap')
await act(async () => {
  for (let n = 0; n < 600; n++) {
    fake.emit({
      platform: 'tiktok',
      type: 'chat',
      ...viewer({ id: `u${n}` }),
      text: `msg ${n}`,
      timestamp: 1700000000000 + n,
    })
  }
})
const capped = $$('.row').length
check('the list is capped rather than unbounded', capped <= 500, String(capped))
// The feed reads like a chat log: oldest first, newest at the bottom.
const texts = $$('.row .text').map((el) => el.textContent)
check('the newest message is at the bottom', texts.at(-1) === 'msg 599', texts.slice(-2).join(' | '))
// Not "the first message is at the top": the cap evicted it long ago. What
// matters is that the order runs oldest to newest.
check(
  'the order runs oldest to newest',
  texts.every((t, i) => i === 0 || t === `msg ${100 + i}`),
  texts.slice(0, 3).join(' | '),
)
check('the newest row is the highlighted one', $$('.row').at(-1)?.classList.contains('row-new') === true)
// A filled background was mistaken for an error state in real use, so the marker
// is a leading rule and nothing paints the whole row.
const newestStyle = getComputedStyle($$('.row').at(-1))
check(
  'the highlight is a leading rule, not a fill',
  newestStyle.boxShadow.includes('inset'),
  newestStyle.boxShadow,
)

console.log('joins look like people arriving')
await act(async () => {
  fake.emit({
    platform: 'tiktok',
    type: 'join',
    nickname: 'Faray',
    avatar: '',
    viewerId: 'v9',
    timestamp: 1700000005000,
  })
})
const joinRow = $$('.row').find((r) => r.classList.contains('row-join'))
check('a join row appeared', Boolean(joinRow), $$('.row').map((r) => r.className).join(', '))
check('it shows an avatar slot like any chat row', Boolean(joinRow?.querySelector('.avatar')))
check('it names the viewer', /Faray/.test(joinRow?.querySelector('.nickname')?.textContent ?? ''), joinRow?.textContent)
check('it reads "joined the stream"', /joined the stream/.test(joinRow?.textContent ?? ''), joinRow?.textContent)
check('and it is not tagged either', !joinRow?.querySelector('.room-tag'))
// A join used to be an unnamed "1 joined" system line. Nothing like that may remain.
check('no nameless join rows exist', !$$('.row').some((r) => /\d+ joined/.test(r.textContent ?? '')))

console.log('filters narrow what is shown')
await click('.toolbar-bottom .chip')
await act(async () => {
  fake.emit({ platform: 'tiktok', type: 'like', ...viewer({ id: 'l1' }), count: 2, timestamp: 1700000002000 })
})
const allCount = $$('.row').length
await click([...$$('.toolbar-bottom .chip')].find((c) => c.textContent.trim().startsWith('Likes')))
const likeCount = $$('.row').length
check('the likes filter hides the other kinds', likeCount < allCount, `${likeCount} of ${allCount}`)
check('only like rows remain', $$('.row').every((r) => r.classList.contains('row-like')))
await click([...$$('.toolbar-bottom .chip')].find((c) => c.textContent.trim().startsWith('All')))

console.log('search narrows by name and text')
await type('.input-search', 'msg 599')
check('one row is left', $$('.row').length === 1, String($$('.row').length))
await type('.input-search', 'zzzz-no-such-thing')
check('nothing matches', $$('.row').length === 0)
check('the empty state explains why', /No messages match the current filter/.test($('.empty-hint')?.textContent ?? ''))
await type('.input-search', '')

console.log('reconnecting replaces the old room')
// Back to connected first: the live-ending assertions above left the room in the
// ended state, where the button is Connect rather than Stop, and this section is
// about what happens when a Stop is followed by a Connect. Driven from the state
// the test set up rather than left behind, so the two sections do not depend on
// each other's ordering.
await act(async () => {
  fake.emit({ platform: 'tiktok', type: 'status', connected: true, message: 'Connected to @x' })
})
await click('.room-row .btn-danger')
// The host confirms the close, exactly as the real one does — the row keeps its
// Stop button until then, so a test that skipped this would see the old state.
await act(async () => {
  fake.emit({ platform: 'tiktok', type: 'status', connected: false, message: 'Disconnected' })
})
await click('.room-row .btn-primary')
check(
  'the host was asked again',
  fake.commands.filter((c) => c.command === 'backend_connect').length === 2,
  JSON.stringify(fake.lastCommand('backend_connect')),
)

await act(async () => {
  fake.emit({ platform: 'tiktok', type: 'status', connected: true, message: 'tt up' })
  fake.emit({ platform: 'tiktok', type: 'room', username: 'mybasic.indonesia', roomId: '7', title: 'a title' })
  fake.emit({ platform: 'tiktok', type: 'chat', ...viewer(), text: 'from tiktok', timestamp: 1700000003000 })
})
check('the status updated', /tt up/.test($('.room-status')?.textContent ?? ''))
check('rows are shown again', $$('.row').some((r) => /from tiktok/.test(r.textContent ?? '')))
// With one room there is nothing to tell apart, so the per-room tag that used to
// sit on every row would be the same word repeated.
check('no room tag is left on the rows', $$('.row .room-tag').length === 0, String($$('.row .room-tag').length))

console.log('watching the stream')
await click('.watch-btn')
check(
  'the browser was asked for the stream',
  JSON.stringify(fake.lastCommand('open_stream')) ===
    JSON.stringify({ command: 'open_stream', args: { url: 'https://www.tiktok.com/@mybasic.indonesia/live' } }),
  JSON.stringify(fake.lastCommand('open_stream')),
)

console.log('stopping closes the reader')
// Before the stop: the note names the room being read, and the backend it reads it
// from. That is the state the assertions below compare against.
check('while connected it names the room and the backend', /@mybasic\.indonesia via/.test($('.source-note')?.textContent ?? ''), $('.source-note')?.textContent)
await click('.room-row .btn-danger')
check(
  'the host was asked to stop',
  JSON.stringify(fake.lastCommand('backend_disconnect')) === JSON.stringify({ command: 'backend_disconnect' }),
  JSON.stringify(fake.lastCommand('backend_disconnect')),
)
// The status line goes quiet because the host says so, exactly as it does live —
// the app does not assume a stop worked, it waits to be told.
await act(async () => {
  fake.emit({ platform: 'tiktok', type: 'status', connected: false, message: 'Disconnected' })
})
// The handle stays in the field so reconnecting is one click, but the note stops
// naming a live room. Leaving "@handle via backend" beside a Disconnected status
// reads as a connection that never stopped, which is the one thing a Stop button
// must never appear to have failed to do.
check('the handle is still there to reconnect with', $('.handle-input')?.value === '@mybasic.indonesia', $('.handle-input')?.value)
check('and the field is editable again', $('.handle-input')?.disabled === false, String($('.handle-input')?.disabled))
check('and the note no longer claims a live room', /stopped/.test($('.source-note')?.textContent ?? ''), $('.source-note')?.textContent)
check('it stops naming the backend too', !/via/.test($('.source-note')?.textContent ?? ''), $('.source-note')?.textContent)
check('and the status line agrees it is disconnected', /Disconnected/.test($('.room-status')?.textContent ?? ''), $('.room-status')?.textContent)
// Connecting again clears the stopped note, so the room is named as live once more.
await click($$('.room-row .btn').find((b) => b.textContent.trim() === 'Connect'))
check('connecting names the room again', /via/.test($('.source-note')?.textContent ?? ''), $('.source-note')?.textContent)
check('and no longer says stopped', !/stopped/.test($('.source-note')?.textContent ?? ''), $('.source-note')?.textContent)

console.log('failures are shown, not swallowed')
await act(async () => {
  fake.emit({ platform: 'tiktok', type: 'error', message: 'Streamer is not live right now.' })
})
check('the error reached the log', /not live/.test(doc.body.textContent ?? ''))
check('the error badge appeared', !!$('.log-badge'), $('.log-badge')?.textContent ?? 'none')

console.log('reading preferences')
// The look and feed preferences moved behind the gear, so this opens the dialog
// and drives them there. Only gift sound/notice and collapse stay on the toolbar.
check('compact is off by default', doc.body.classList.contains('compact') === false)

await click('.settings-btn')
check('the settings dialog opens', Boolean($('.modal-settings')))
const dialogToggle = (label) =>
  $$('.modal-settings .toggle').find((t) => t.textContent.trim().startsWith(label))?.querySelector('input')
const toolbarToggle = (label) =>
  $$('.view-toggles .toggle').find((t) => t.textContent.trim().startsWith(label))?.querySelector('input')

await click(dialogToggle('Compact'))
check('turning on compact sets the class', doc.body.classList.contains('compact') === true)
await click(dialogToggle('Compact'))
check('turning it off clears the class', doc.body.classList.contains('compact') === false)

await click(dialogToggle('Hide joins'))
// Emitted fresh: the earlier join row was pushed out by the 500-row cap test,
// which is the app behaving correctly and leaves nothing here to toggle.
await act(async () => {
  fake.emit({ platform: 'tiktok', type: 'join', nickname: 'Latecomer', avatar: '', viewerId: 'v-late', timestamp: 1700000006400 })
})
check('the toggle actually hides a join row', $$('.row-join').length === 0, String($$('.row-join').length))
await click(dialogToggle('Hide joins'))
check('and they come back when it is off', $$('.row-join').length === 1, String($$('.row-join').length))

await act(async () => {
  fake.emit({
    platform: 'tiktok',
    type: 'chat',
    ...viewer({ id: 'nof' }),
    text: 'this one TikTok filtered',
    timestamp: 1700000006500,
    isFiltered: true,
  })
})
check('a filtered message is shown by default', $$('.badge-filtered').length === 1)
await click(dialogToggle('Hide filtered'))
check('hide-filtered removes it', $$('.badge-filtered').length === 0)
await click(dialogToggle('Hide filtered'))
check('and brings it back', $$('.badge-filtered').length === 1)

await click($('.modal-close'))
check('the dialog closes', !$('.modal-settings'))

// On by default, and stored: whether a chime fires at 3am is a preference, not a
// decision to make on every launch. These stay on the toolbar — a glanceable
// switch you flip without opening anything.
const soundToggle = toolbarToggle('Gift sound')
check('the gift sound is offered', Boolean(soundToggle))
check('it is on to begin with', soundToggle?.checked === true)

// jsdom has no Web Audio, so this is the only place the missing-audio path is
// exercised — and it matters more than it looks: a throw from the gift handler
// would take down the feed, which is the app's whole job.
await click(soundToggle)
check('it can be turned off', toolbarToggle('Gift sound')?.checked === false)
await act(async () => {
  fake.emit({ platform: 'tiktok', type: 'gift', ...viewer({ id: 'silent' }), giftName: 'Mute', count: 1, diamonds: 5, timestamp: 1700000006700 })
})
check('a gift with the sound off leaves the feed intact', $$('.row-gift').some((r) => /Mute/.test(r.textContent ?? '')))

await click(toolbarToggle('Gift sound'))
check('and back on', toolbarToggle('Gift sound')?.checked === true)
await act(async () => {
  fake.emit({ platform: 'tiktok', type: 'gift', ...viewer({ id: 'loud' }), giftName: 'Chime', count: 1, diamonds: 9999, timestamp: 1700000006800 })
})
check('a gift with the sound on still lands in the feed', $$('.row-gift').some((r) => /Chime/.test(r.textContent ?? '')))
check('and nothing about the room broke', $$('.row').length > 0)

await act(async () => {
  fake.emit({
    platform: 'tiktok',
    type: 'chat',
    ...viewer({ id: 'mod' }),
    text: 'keep this room tidy',
    timestamp: 1700000006600,
    isModerator: true,
    mentions: ['someone_else'],
    emotes: [{ url: 'https://example.test/e.png', id: 'e1' }],
  })
})
check('a moderator is badged', $$('.badge-mod').length === 1)
check('the badge sits on the moderator row', /badge-mod/.test($$('.row').find((r) => /keep this room tidy/.test(r.textContent ?? ''))?.className ?? 'x') || Boolean($$('.badge-mod')[0]))
check('an emote image is rendered', $$('.emote').length === 1)
check('a mention of someone else is not highlighted', $$('.text-mention').length === 0)

console.log('the jump button stands in for autoscroll')

/**
 * Pretends the user scrolled up to read.
 *
 * jsdom does no layout, so every scrollHeight is 0 and the "am I at the bottom"
 * test would always pass. The node's metrics are stubbed to make the two states
 * distinguishable, which is the only way this behaviour can be tested here.
 */
async function scrollUp() {
  const node = $('.feed')
  Object.defineProperty(node, 'scrollHeight', { value: 1000, configurable: true })
  Object.defineProperty(node, 'clientHeight', { value: 400, configurable: true })
  node.scrollTop = 0
  await act(async () => {
    node.dispatchEvent(new harness.dom.window.Event('scroll', { bubbles: false }))
  })
}

await act(async () => {
  for (let n = 0; n < 5; n++) {
    fake.emit({ platform: 'tiktok', type: 'chat', ...viewer({ id: `s${n}` }), text: `scrolled away ${n}`, timestamp: 1700000006000 + n })
  }
})
check('no jump button while sitting at the bottom', !$('.jump'))

await scrollUp()
await act(async () => {
  for (let n = 0; n < 3; n++) {
    fake.emit({ platform: 'tiktok', type: 'chat', ...viewer({ id: `u${n}` }), text: `missed ${n}`, timestamp: 1700000007000 + n })
  }
})
check('the jump button appeared once messages were missed', Boolean($('.jump')), 'no .jump in the DOM')
check('it says how many were missed', /3 new messages/.test($('.jump')?.textContent ?? ''), $('.jump')?.textContent)
check('it did not scroll the list away', $('.feed').scrollTop === 0, String($('.feed').scrollTop))

// It has to keep counting, not freeze at the first message.
await act(async () => {
  fake.emit({ platform: 'tiktok', type: 'chat', ...viewer({ id: 'w1' }), text: 'and one more', timestamp: 1700000008000 })
})
check('the count keeps rising', /4 new messages/.test($('.jump')?.textContent ?? ''), $('.jump')?.textContent)

await click('.jump')
check('clicking it clears the count', !$('.jump'))
// scrollHeight, not scrollHeight - clientHeight: a browser clamps an
// over-large scrollTop to the true maximum, and jsdom does not.
check('and jumps to the bottom', $('.feed').scrollTop === 1000, String($('.feed').scrollTop))

// Reaching the bottom by hand has the same effect.
await scrollUp()
await act(async () => {
  for (let n = 0; n < 2; n++) {
    fake.emit({ platform: 'tiktok', type: 'chat', ...viewer({ id: `h${n}` }), text: `more ${n}`, timestamp: 1700000009000 + n })
  }
})
check('the button came back after scrolling up again', Boolean($('.jump')))

const node = $('.feed')
await act(async () => {
  node.scrollTop = 600
  node.dispatchEvent(new harness.dom.window.Event('scroll', { bubbles: false }))
})
check('scrolling to the bottom by hand clears it too', !$('.jump'))

console.log('the stats panel')
check('the panel is there', Boolean($('.stats-panel')))
check('it is collapsed to begin with', !$('.stats-body'))
// The whole point of a collapsed panel: the headline is visible without a click.
check('the collapsed bar still shows the headcount', /1[.,]234/.test($('.stats-glance')?.textContent ?? ''), $('.stats-glance')?.textContent)

await click('.stats-toggle')
check('it opens', Boolean($('.stats-body')))
const tile = (label) =>
  $$('.stat-tile').find((t) => t.querySelector('.stat-label')?.textContent === label)?.querySelector('.stat-value')?.textContent

/**
 * A stat's digits, with the locale's group separators removed.
 *
 * The panel renders through toLocaleString, so "11,296" and "11.296" are the same
 * number in two places and which one appears depends on the machine. Comparing
 * digits keeps these assertions about the value the panel computed rather than
 * about how the current locale writes it.
 */
const digits = (text) => (text ?? '').replace(/\D/g, '')

// Counted from a known zero: earlier sections pushed six hundred messages through
// on purpose, so anything asserted against the running totals would be a test of
// the order the sections happen to run in.
await click('.stats-reset')
await act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 300))
})
// Everything at zero means there is nothing to report, and the panel says so
// rather than filling with tiles of zeroes that read like real measurements.
check('reset clears it back to the empty state', /Nothing yet/.test($('.stats-empty')?.textContent ?? ''), $('.stats-body')?.textContent)

await act(async () => {
  fake.emit({ platform: 'tiktok', type: 'chat', ...viewer({ id: 'u0', nickname: 'satu' }), text: 'one', timestamp: 1700000010000 })
  fake.emit({ platform: 'tiktok', type: 'chat', ...viewer({ id: 'u1', nickname: 'dua' }), text: 'two', timestamp: 1700000010001 })
  fake.emit({ platform: 'tiktok', type: 'chat', ...viewer({ id: 'u2', nickname: 'tiga' }), text: 'three', timestamp: 1700000010002 })
  fake.emit({ platform: 'tiktok', type: 'gift', ...viewer({ id: 'u3', nickname: 'empat' }), giftName: 'Rose', count: 3, diamonds: 99, timestamp: 1700000010003 })
  // A like is a room-level pulse with nobody behind it, and a join is derived from
  // a first chat message — counting either would count those people twice.
  fake.emit({ platform: 'tiktok', type: 'like', ...viewer({ id: 'u4' }), count: 500, timestamp: 1700000010004 })
})
await act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 300))
})
check('messages are counted', tile('Messages') === '3', tile('Messages'))
check('each person is counted once', tile('People') === '4', tile('People'))
check('gifts are counted', tile('Gifts') === '1', tile('Gifts'))
check('diamonds are totalled', tile('Diamonds') === '99', tile('Diamonds'))
// All four events landed inside one second, so the minute they sit in holds
// exactly those four — no reliance on where the second boundary happened to fall.
check('the rate is over the last minute', tile('Per minute') === '4', tile('Per minute'))

// Two components subscribe to the same channel — the feed and the gift chime — and
// both attach during the same mount. Either landing a second registration on the
// transport delivers every frame twice, which shows up here as doubled totals
// rather than as anything a user could name.
check('one subscription, however many components asked for one', tile('Messages') === '3' && tile('Gifts') === '1', `${tile('Messages')} messages / ${tile('Gifts')} gifts`)

console.log('the ask panel')
// Records the exact excerpt the panel chose to send, so the assertions below are
// on what the model would actually be asked about.
const askedContext = []
// The model the panel talks to is the host's business, so the test answers the
// command with a fixed string and asserts on what the panel does with it — the
// transport is the same one every other command is already faked on.
fake.transport.invoke = async (command, args) => {
  if (command === 'llm_chat') {
    askedContext.push(args)
    return 'The room is talking about the weather.'
  }
  return undefined
}

check('the panel starts closed', !$('.ask-body'))
await click('.ask-toggle')
check('and opens', !!$('.ask-body'))
check(
  'with nothing to show yet',
  /appear in the feed/.test($('.ask-note')?.textContent ?? ''),
  $('.ask-note')?.textContent,
)

// A question with no room to be about. The button has to stay off rather than
// send the model an empty prompt and an empty excerpt, which is a call that
// costs money and can only come back useless.
await type('.ask-body input', '   ')
check('a blank question cannot be sent', $('.ask-body .btn-primary').disabled === true)

await type('.ask-body input', 'what is going on?')
check('a question enables the button', $('.ask-body .btn-primary').disabled === false)

// Sent by Enter rather than by clicking the button: the input is a one-liner and
// pressing Enter is what someone types into it will actually do.
await act(async () => {
  const input = $('.ask-body input')
  input.dispatchEvent(new harness.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
})
await flush()

check('the model was asked', askedContext.length === 1, JSON.stringify(askedContext))
check('the question went as typed', askedContext[0]?.question === 'what is going on?', askedContext[0]?.question)
// The excerpt is the chat rows only, in the shape chatContext builds — the same
// function the model is answering from. A gift in the room must not arrive as
// conversation, and a viewer count must not arrive at all.
const sentContext = askedContext[0]?.context ?? []
check(
  'every excerpt line is a chat message, not an event',
  sentContext.every((line) => typeof line === 'string' && /^\S+: /.test(line)),
  JSON.stringify(sentContext),
)
check(
  'no viewer count leaks into the excerpt',
  !sentContext.some((line) => /^viewers|watching/i.test(line)),
  JSON.stringify(sentContext),
)

// The exchange now lands in the feed rather than in the panel, so these assert
// on the rows it produces. Each later ask appends more rows, so the checks read
// the *last* row of each kind rather than the first — otherwise a second answer
// would still be compared against the first one's text.
const lastOf = (kind) => $$(`.row-${kind} .text`).at(-1)?.textContent ?? ''
check('the question is now a feed row', $$('.row-ask').length === 1, String($$('.row-ask').length))
check('the question text is shown', /what is going on\?/.test($('.row-ask .text')?.textContent ?? ''), $('.row-ask .text')?.textContent)
check('the answer is a feed row', $$('.row-answer').length === 1, String($$('.row-answer').length))
check('the answer text is shown', /The room is talking about the weather/.test($('.row-answer .text')?.textContent ?? ''), $('.row-answer .text')?.textContent)
check('the input is cleared after asking', $('.ask-body input').value === '', $('.ask-body input').value)
// Three chat messages were fed to the room just before this. The question and
// the answer must not have joined them, which is the whole reason they go through
// `push` and are skipped in the recorder — so the total stays at three.
check('neither the question nor the answer is counted as a chat message', digits(tile('Messages')) === '3', tile('Messages'))

// The model answering with nothing is a provider failure, not an empty chat, and
// it must not render as a blank row the user has to interpret — it lands saying
// so instead.
fake.transport.invoke = async (command) => {
  if (command === 'llm_chat') return '   '
  return undefined
}
await type('.ask-body input', 'again')
await click('.ask-body .btn-primary')
await flush()
check('an empty answer still lands, saying so', /answered with nothing/.test(lastOf('answer')), lastOf('answer'))

// A provider that fails outright. The reason reaches the feed rather than being
// swallowed, because "could not reach" and "wrong key" are fixed differently and
// only the host knows which it was.
fake.transport.invoke = async (command) => {
  if (command === 'llm_chat') throw new Error('could not reach https://h/v1: connection refused')
  return undefined
}
await type('.ask-body input', 'third time')
await click('.ask-body .btn-primary')
await flush()
check('a failed call puts its reason in the feed', /connection refused/.test(lastOf('answer')), lastOf('answer'))

console.log('the peak is never below the current count')
// Both are raised from the same frames, but on different clocks: the headcount
// updates whenever the platform reports one and the sample only on a timer, so a
// room that grows between two samples would otherwise show a peak under its own
// current number — which reads as a broken counter rather than a stale one.
await act(async () => {
  fake.emit({ platform: 'tiktok', type: 'viewers', count: 11_239 })
})
await act(async () => {
  fake.emit({ platform: 'tiktok', type: 'viewers', count: 11_296 })
})
await act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 300))
})
// The panel formats with toLocaleString, whose separator depends on the runtime
// locale. jsdom here does not match a browser's, so asserting the formatted
// string pinned this suite to whichever one it happened to run under — it failed
// with a comma against a test written for a period, and would flip the other way
// on a machine with a different locale. Asserting the digits leaves the locale
// to the renderer, which is where that choice belongs.
check('a rising headcount raises the peak with it', digits(tile('Peak')) === '11296', tile('Peak'))
check('and the current count is added across rooms', digits(tile('Watching')) === '11296', tile('Watching'))
await act(async () => {
  fake.emit({ platform: 'tiktok', type: 'viewers', count: 500 })
})
await act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 300))
})
check('a falling headcount does not lower the peak', digits(tile('Peak')) === '11296', tile('Peak'))
check('but the current count follows it down', digits(tile('Watching')) === '500', tile('Watching'))

const board = $$('.chatter').map((row) => row.querySelector('.chatter-name')?.textContent)
// All four spoke once each, so the order is the name tie-break and nothing else.
// Reshuffling equal rows on every arriving event would read as the panel
// flickering, so the tie-break has to be stable — the gift sender goes last on
// messages despite being worth the most diamonds.
check('equal rows keep a stable order', board.join(',') === 'dua,satu,tiga,empat', board.join(','))
check('everyone who took part is on the board', board.length === 4, board.join(','))
check('the gift value is shown beside its sender', $$('.chatter-diamonds').length === 1, $$('.chatter').map((r) => r.textContent).join(' | '))

console.log('the log panel')
await click('.log-toggle')
check('the log is open', !!$('.log-list'))
const lines = $$('.log-line')
check('the log has entries', lines.length > 0, String(lines.length))
check('every line has a level', lines.every((l) => /info|warn|error/.test(l.querySelector('.log-level')?.textContent ?? '')))
check('every line has a time', lines.every((l) => /\d{2}\.\d{2}\.\d{2}/.test(l.querySelector('.log-time')?.textContent ?? '')))
check('the log attributed the room', /tiktok:/.test($$('.log-message').map((m) => m.textContent).join(' ')))

console.log('clearing the chat')
// The feed has rows from every section above. Clear empties it without touching
// the connection — the button is a reading reset, not a disconnect.
check('the feed has rows to clear', $$('.row').length > 0, String($$('.row').length))
const clearButton = $$('.view-toggles .btn').find((b) => b.textContent.trim() === 'Clear')
check('the clear button is offered', Boolean(clearButton))
check('and is enabled while there is something to clear', clearButton?.disabled === false)
await click(clearButton)
check('the feed is emptied', $$('.row').length === 0, String($$('.row').length))
check('the empty state explains itself', /No messages yet/.test($('.empty-title')?.textContent ?? ''), $('.empty-title')?.textContent)
check('the clear button goes quiet when there is nothing to clear', $$('.view-toggles .btn').find((b) => b.textContent.trim() === 'Clear')?.disabled === true)

// New chat still arrives after a clear: clearing is a view reset, not a stop.
await act(async () => {
  fake.emit({ platform: 'tiktok', type: 'chat', ...viewer({ id: 'afterclear' }), text: 'still live', timestamp: 1700000011000 })
})
check('chat keeps arriving after a clear', $$('.row').some((r) => /still live/.test(r.textContent ?? '')))

console.log('panels can be turned off')
// The three bottom panels take vertical space the chat could use. Each can be
// switched off from the settings dialog and comes back when switched on.
await click('.settings-btn')
await click(dialogToggle('Stats panel'))
check('the stats panel goes away', !$('.stats-panel'))
await click(dialogToggle('Log panel'))
check('the log panel goes away', !$('.log-panel'))
await click(dialogToggle('Ask panel'))
check('the ask panel goes away', !$('.ask-panel'))
await click(dialogToggle('Stats panel'))
check('and each comes back', Boolean($('.stats-panel')))
await click(dialogToggle('Log panel'))
check('the log is back too', Boolean($('.log-panel')))
await click(dialogToggle('Ask panel'))
check('and the ask is back', Boolean($('.ask-panel')))

console.log('chat alerts')
// Off by default: a blip per message and a voice reading the room are both
// things that have to be asked for, not assumed.
check('the chat blip is offered off', dialogToggle('Chat blip')?.checked === false)
check('and speech is off too', dialogToggle('Read chat aloud')?.checked === false)
// The name toggle only exists while speech is on — with nothing being spoken,
// there is no sentence for a name to sit in front of.
check('the name toggle is hidden while speech is off', !dialogToggle('Say the name'))
await click(dialogToggle('Chat blip'))
check('the blip turns on', dialogToggle('Chat blip')?.checked === true)
await click(dialogToggle('Read chat aloud'))
check('speech turns on', dialogToggle('Read chat aloud')?.checked === true)
check('and now the name toggle appears', Boolean(dialogToggle('Say the name')))
check('on, since it is the useful default', dialogToggle('Say the name')?.checked === true)
await click(dialogToggle('Say the name'))
check('and can be turned off', dialogToggle('Say the name')?.checked === false)
// Turning speech off takes the name toggle with it again rather than leaving a
// control that silently does nothing.
await click(dialogToggle('Read chat aloud'))
check('speech off hides the name toggle again', !dialogToggle('Say the name'))

// A gift can be announced with the same voice. Off by default, like every other
// sound that speaks: it sends text to be spoken, and that has to be asked for.
check('gift announcements are offered off', dialogToggle('Say gifts')?.checked === false)
await click(dialogToggle('Say gifts'))
check('and turn on', dialogToggle('Say gifts')?.checked === true)

console.log('mentions of me')
// The highlight has existed in FeedRow for a long time; this is the half that was
// missing — a handle to compare against. Without one nothing is highlighted, which
// is the default: a highlight on the wrong name is worse than none.
check('no handles by default, so nothing is highlighted yet', $('[data-section="feed"] input[placeholder*="yourname"]')?.value === '', $('[data-section="feed"] input[placeholder*="yourname"]')?.value)
const handleField = () => $('[data-section="feed"] input[placeholder*="yourname"]')
await type(handleField(), 'ana')
check('the handle reaches the setting', handleField().value === 'ana', handleField().value)

// A message naming that handle is highlighted; one naming someone else is not.
await act(async () => {
  fake.emit({
    platform: 'tiktok',
    type: 'chat',
    ...viewer({ id: 'm1', nickname: 'budi' }),
    text: 'halo ana, nonton ya',
    timestamp: 1700000012000,
    mentions: ['ana'],
  })
})
check('a message naming me is highlighted', $$('.text-mention').length === 1, String($$('.text-mention').length))
check('and it is the right row', /halo ana/.test($('.text-mention')?.textContent ?? ''), $('.text-mention')?.textContent)

await act(async () => {
  fake.emit({
    platform: 'tiktok',
    type: 'chat',
    ...viewer({ id: 'm2', nickname: 'citra' }),
    text: 'halo budi, nonton ya',
    timestamp: 1700000012100,
    mentions: ['budi'],
  })
})
check('a message naming someone else is not', $$('.text-mention').length === 1, String($$('.text-mention').length))

// Case and a leading @ are the same person, because TikTok sends all three forms.
await act(async () => {
  fake.emit({
    platform: 'tiktok',
    type: 'chat',
    ...viewer({ id: 'm3', nickname: 'dewi' }),
    text: 'ANA lihat ini',
    timestamp: 1700000012200,
    mentions: ['@ANA'],
  })
})
check('case and a leading @ still count', $$('.text-mention').length === 2, String($$('.text-mention').length))

check('the mention alert is offered off', dialogToggle('Mention alert')?.checked === false)
await click(dialogToggle('Mention alert'))
check('and turns on', dialogToggle('Mention alert')?.checked === true)

console.log('sound templates and a custom file')
// Scoped to the Sounds section: the Look section above also has selects, and the
// first `.modal-settings select` is the theme, not a sound.
const soundSelects = () => $$('[data-section="sounds"] select')
// Gift and chat each have their own template; the gift defaults to the chime the
// app shipped with, the chat to the short blip.
check('the gift has a sound to pick', soundSelects().length >= 2, String(soundSelects().length))
check('the gift defaults to the chime', soundSelects()[0]?.value === 'chime', soundSelects()[0]?.value)
check('and offers every template', soundSelects()[0]?.options.length >= 4, String(soundSelects()[0]?.options.length))
// Choosing a different template writes it straight to settings, which persists
// it — the picker holds no state of its own.
await act(async () => {
  const select = soundSelects()[0]
  const setter = Object.getOwnPropertyDescriptor(harness.dom.window.HTMLSelectElement.prototype, 'value').set
  setter.call(select, 'coin')
  select.dispatchEvent(new harness.dom.window.Event('change', { bubbles: true }))
})
check('picking a template takes effect', soundSelects()[0]?.value === 'coin', soundSelects()[0]?.value)
// The chat blip is a separate select, so a gift sound choice does not change it.
check('the chat blip is its own choice', soundSelects()[1]?.value !== undefined)

// A custom file overrides every template. Picking one asks the host for a path,
// and an empty path — a cancelled picker — must leave the previous pick alone
// rather than clear it.
check('no custom file by default', /No file/.test($('[data-section="sounds"] .field-note')?.textContent ?? ''), $('[data-section="sounds"] .field-note')?.textContent)
const chooseBtn = $$('[data-section="sounds"] .btn').find((b) => b.textContent.trim() === 'Choose file…')
check('a file picker is offered', Boolean(chooseBtn))
// The ask section above replaced `invoke` with one that answers llm_chat but
// records nothing; restore the recording behaviour so this command is seen.
fake.transport.invoke = async (command, args) => {
  fake.commands.push({ command, args })
  if (command === 'pick_sound_file') return ''
  return undefined
}
await click(chooseBtn)
check('the host was asked for a file', Boolean(fake.lastCommand('pick_sound_file')), JSON.stringify(fake.commands.at(-1)))
// Cancelled (empty path): nothing changes, and no error is raised — backing out
// of a picker is not a failure the user has to act on.
check('a cancelled pick leaves the settings alone', /No file/.test($('[data-section="sounds"] .field-note')?.textContent ?? ''))

console.log('teardown')
await act(async () => {
  root.unmount()
})

// The regressions below were found by reading, not by a failing assertion, and
// each one is invisible from the outside: a row that renders the wrong number, an
// input that never fills. So they are driven directly rather than through the
// window.
const { useFeed, FeedRow } = await import(entry)

console.log('a repeated message repaints its counter')

async function feedWith(items) {
  const box = harness.dom.window.document.createElement('div')
  const { createRoot } = await import('react-dom/client')
  const mounted = createRoot(box)
  let api
  function Probe() {
    api = useFeed(items.collapse)
    return null
  }
  await act(async () => {
    mounted.render(React.createElement(Probe))
  })
  return { box, mounted, api: () => api }
}

const chat = (over = {}) => ({
  kind: 'chat',
  id: 'u1',
  platform: 'tiktok',
  text: 'hello',
  nickname: 'eko',
  avatar: '',
  timestamp: Date.now(),
  ...over,
})

const feedCase = await feedWith({ collapse: { threshold: 2, windowMs: 2500 } })
await act(async () => {
  feedCase.api().push(chat())
})
const first = feedCase.api().items[0]
await act(async () => {
  feedCase.api().push(chat({ timestamp: first.timestamp + 100 }))
})
check('the repeat folded into the same row', feedCase.api().items.length === 1, JSON.stringify(feedCase.api().items))
check('and its counter went up', feedCase.api().items[0].repeatCount === 2, String(feedCase.api().items[0].repeatCount))
check('while the row kept its key, so React does not remount it', feedCase.api().items[0].key === first.key)

// The bug: the row mutated its own item and handed the same object back, so every
// field the memo compared matched itself and the badge froze at 2.
await act(async () => {
  feedCase.api().push(chat({ timestamp: first.timestamp + 200 }))
})
check('a third repeat updates the count', feedCase.api().items[0].repeatCount === 3, String(feedCase.api().items[0].repeatCount))

console.log('the repeat badge actually renders')
const rowBox = harness.dom.window.document.createElement('div')
const { createRoot: rowRoot } = await import('react-dom/client')
const rowMounted = rowRoot(rowBox)
const item = { ...feedCase.api().items[0] }
await act(async () => {
  rowMounted.render(React.createElement(FeedRow, { item, isLast: true }))
})
check('the badge shows the count', (rowBox.textContent ?? '').includes('x3'), rowBox.textContent)
// Same object, new count: exactly what the old in-place mutation produced, and
// exactly what the memo must not be fooled by.
const bumped = { ...item, repeatCount: 4 }
await act(async () => {
  rowMounted.render(React.createElement(FeedRow, { item: bumped, isLast: true }))
})
check('and it repaints when the count changes', (rowBox.textContent ?? '').includes('x4'), rowBox.textContent)

console.log('editing your handles repaints the highlight')
const mentionRow = { ...item, kind: 'chat', text: 'hi ana', mentions: ['ana'] }
await act(async () => {
  rowMounted.render(React.createElement(FeedRow, { item: mentionRow, isLast: true, myNames: [] }))
})
check('not highlighted for someone else', !/text-mention/.test(rowBox.innerHTML), rowBox.innerHTML.slice(0, 200))
await act(async () => {
  rowMounted.render(React.createElement(FeedRow, { item: mentionRow, isLast: true, myNames: ['ana'] }))
})
check('highlighted once the handle matches', /text-mention/.test(rowBox.innerHTML), rowBox.innerHTML.slice(0, 200))
// Unchanged item, unchanged everything else — only the handles moved.
await act(async () => {
  rowMounted.render(React.createElement(FeedRow, { item: mentionRow, isLast: true, myNames: ['someone_else'] }))
})
check('and un-highlighted when it stops matching', !/text-mention/.test(rowBox.innerHTML), rowBox.innerHTML.slice(0, 200))

await act(async () => {
  rowMounted.unmount()
  feedCase.mounted.unmount()
})

setTransport(null)
harness.restore()

console.log(`\n${failures === 0 ? 'all passed' : `${failures} failed`}`)
process.exit(failures === 0 ? 0 : 1)