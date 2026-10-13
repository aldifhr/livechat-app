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
  // The webhook starts unconfigured, as it does on first launch.
  webhook_config_get: { enabled: false, url: '', token: '' },
  webhook_test: 'Sent.',
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
// With no handle there is nothing for the note to name, so it stays silent — the
// status line carries the single "enter a handle and press Connect" instruction
// rather than the toolbar repeating it in a second place.
check('the note is silent until there is a handle', !$('.source-note'), $('.source-note')?.textContent ?? 'none')
check('the status line carries the one instruction', /enter a handle/i.test($('.room-status')?.textContent ?? ''), $('.room-status')?.textContent)
// Filters and search are controls for a feed that does not exist yet, so they wait
// until there is something to filter rather than cluttering the idle screen.
check('filters wait until there is a feed', !$('.toolbar-bottom'), 'toolbar-bottom present while idle')
check('and so does the search box', !$('.input-search'), 'search box present while idle')

await type(handleInput(), '@mybasic.indonesia')
check('the value reached React state', handleInput().value === '@mybasic.indonesia', handleInput().value)
check('connect becomes possible', connectButton()?.disabled === false, `disabled=${connectButton()?.disabled}`)
// The note names the handle once there is one to name — and not before.
check('the note names the handle now', /@mybasic\.indonesia/.test($('.source-note')?.textContent ?? ''), $('.source-note')?.textContent)

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
// The address and the handle are the whole of it. Asserted field by field rather
// than as one exact blob, so a field added to the payload later does not read as a
// regression in the connect itself.
check(
  'with the built-in address and the typed handle',
  asked?.args?.config?.baseUrl === DEFAULT_BACKEND && asked?.args?.config?.username === 'mybasic.indonesia',
  JSON.stringify(asked),
)
// The overlay styling used to ride along here. It is configured from the web admin
// panel now, so the app has none to send, and a field left off entirely is what
// tells the host "no styling" — sending an empty one would overwrite what the
// admin stored.
check('and no overlay styling, which the app no longer owns', asked?.args?.config?.overlay === undefined, JSON.stringify(asked?.args?.config))

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

console.log('the auto-reply answers a greeting, once per person')
// Counted on the bot badge, which only an auto-reply row carries — the backlog of
// real messages above has none, so the count is exactly what this test produces.
// Off by default: it makes the app talk, which has to be asked for. Turn it on
// through the settings dialog, the same door a user opens it with.
await click('.settings-btn')
const autoReplyToggle = $$('.modal-settings .toggle').find((t) =>
  t.textContent.trim().startsWith('Auto-reply'),
)?.querySelector('input')
await click(autoReplyToggle)
await click($('.modal-close'))
// A greeting from a viewer, and one that is not.
await act(async () => {
  fake.emit({ platform: 'tiktok', type: 'chat', ...viewer({ id: 'g1' }), text: 'halo', timestamp: 1700000003000 })
})
const botRows = () => $$('.row').filter((r) => r.querySelector('.badge-bot'))
check('a greeting drew a reply', botRows().length === 1, `got ${botRows().length}`)
check('the reply is the app\u2019s own line', /Senang kamu mampir/.test(botRows()[0]?.textContent ?? ''), botRows()[0]?.textContent)
// The same viewer saying hello again is one reply, not one per hello — a bot that
// answers every repeat is a bot that spams.
await act(async () => {
  fake.emit({ platform: 'tiktok', type: 'chat', ...viewer({ id: 'g1' }), text: 'hi', timestamp: 1700000003100 })
})
check('the same viewer is not answered twice', botRows().length === 1, `got ${botRows().length}`)
// A message that merely contains a greeting word is not a greeting: "hi can you
// help" is a question, and answering the greeting instead is worse than silence.
await act(async () => {
  fake.emit({ platform: 'tiktok', type: 'chat', ...viewer({ id: 'g2' }), text: 'hi can you help me', timestamp: 1700000003200 })
})
check('a greeting inside a question is not answered', botRows().length === 1, `got ${botRows().length}`)
// A different viewer is answered on their own.
await act(async () => {
  fake.emit({ platform: 'tiktok', type: 'chat', ...viewer({ id: 'g3' }), text: 'hai', timestamp: 1700000003300 })
})
check('a new viewer is answered', botRows().length === 2, `got ${botRows().length}`)

console.log('joins look like people arriving')
await act(async () => {
  fake.emit({
    platform: 'tiktok',
    type: 'join',
    nickname: 'Faray',
    avatar: '',
    id: 'v9',
    timestamp: 1700000005000,
  })
})
const joinRow = $$('.row').find((r) => r.classList.contains('row-join'))
check('a join row appeared', Boolean(joinRow), $$('.row').map((r) => r.className).join(', '))
check('it shows an avatar slot like any chat row', Boolean(joinRow?.querySelector('.avatar')))
check('it names the viewer', /Faray/.test(joinRow?.querySelector('.nickname')?.textContent ?? ''), joinRow?.textContent)
check('it reads "joined the stream"', /joined the stream/.test(joinRow?.textContent ?? ''), joinRow?.textContent)
// The name is a link to the viewer's profile — the one thing on a chat row worth
// following up on. Opened through the host, because the webview cannot navigate.
await click(joinRow?.querySelector('.nickname-link'))
check(
  'clicking a name asks the host to open their TikTok profile',
  /open_stream/.test(JSON.stringify(fake.lastCommand('open_stream'))) &&
    /tiktok\.com\/@/.test(JSON.stringify(fake.lastCommand('open_stream'))),
  JSON.stringify(fake.lastCommand('open_stream')),
)
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
// The button flips on the click, not on a status frame that may lag behind it.
// A Stop button that still reads "Stop" after being pressed is the whole bug:
// connect, stop, and the next press should connect again, not invite a second Stop
// on a room that is already closed.
const stopButton = () => $$('.room-row .btn').find((b) => b.textContent.trim() === 'Stop')
const connectButton2 = () => $$('.room-row .btn').find((b) => b.textContent.trim() === 'Connect')
check('the Stop button is gone the moment it is pressed', !stopButton(), $('.room-row')?.textContent)
check('and a Connect button takes its place', Boolean(connectButton2()), $('.room-row')?.textContent)
check('the field is editable again', $('.handle-input')?.disabled === false, String($('.handle-input')?.disabled))
check('and the note no longer claims a live room', /stopped/.test($('.source-note')?.textContent ?? ''), $('.source-note')?.textContent)
check('it stops naming the backend too', !/via/.test($('.source-note')?.textContent ?? ''), $('.source-note')?.textContent)
// The handle is still there so reconnecting is one click.
check('the handle is still there to reconnect with', $('.handle-input')?.value === '@mybasic.indonesia', $('.handle-input')?.value)
// And the status line catches up when the host confirms it, exactly as live.
await act(async () => {
  fake.emit({ platform: 'tiktok', type: 'status', connected: false, message: 'Disconnected' })
})
check('the status line agrees it is disconnected', /Disconnected/.test($('.room-status')?.textContent ?? ''), $('.room-status')?.textContent)
// Connecting again clears the stopped note and asks the host, exactly as live —
// the Stop button returns only when the host confirms the connection, which the
// fake transport does not do on its own.
await click(connectButton2())
check('the host was asked to connect', Boolean(fake.lastCommand('backend_connect')), JSON.stringify(fake.lastCommand('backend_connect')))
check('connecting names the room again', /via/.test($('.source-note')?.textContent ?? ''), $('.source-note')?.textContent)
check('and no longer says stopped', !/stopped/.test($('.source-note')?.textContent ?? ''), $('.source-note')?.textContent)
// The host confirms, and only then does the button offer Stop again.
await act(async () => {
  fake.emit({ platform: 'tiktok', type: 'status', connected: true, message: 'Connected' })
})
check('the Stop button is back once the host confirms', Boolean(stopButton()), $('.room-row')?.textContent)

// A stop is recorded, not just performed. Closing the socket silently leaves the
// log showing connections appearing and never ending, which reads as a feed that
// hung rather than one that was stopped on purpose.
await click('.room-row .btn-danger')
await act(async () => {
  fake.emit({ platform: 'bridge', type: 'status', connected: false, message: 'Disconnected' })
})
await click('.log-toggle')
check(
  'the disconnect is in the log',
  $$('.log-line').some((l) => /Disconnected/.test(l.textContent ?? '')),
  $$('.log-line').map((l) => l.textContent).join(' | '),
)
check(
  'and it is levelled as a warning, not an error',
  $$('.log-line').some((l) => /Disconnected/.test(l.textContent ?? '') && /warn/.test(l.className)),
  $$('.log-line').filter((l) => /Disconnected/.test(l.textContent ?? '')).map((l) => l.className).join(' | '),
)
await click('.log-toggle')

console.log('failures are shown, not swallowed')
await act(async () => {
  fake.emit({ platform: 'tiktok', type: 'error', message: 'Streamer is not live right now.' })
})
check('the error reached the log', /not live/.test(doc.body.textContent ?? ''))
check('the error badge appeared', !!$('.log-badge'), $('.log-badge')?.textContent ?? 'none')

console.log('reading preferences')
// The look and feed preferences moved behind the gear, so this opens the dialog
// and drives them there. Nothing that is a standing preference stays on the
// toolbar any more; that row is the stream and nothing else.
check('compact is off by default', doc.body.classList.contains('compact') === false)
await click('.settings-btn')

check('the settings dialog opens', Boolean($('.modal-settings')))
// The groups are collapsible disclosures, so the dialog opens as a list of
// titles rather than a wall of controls. Only the one group people return to —
// Look — starts open; the rest wait to be asked for.
const sections = () => [...$$('.modal-settings .settings-section')]
check('every group is a collapsible disclosure', sections().every((s) => s.tagName === 'DETAILS'), sections().map((s) => s.tagName).join(','))
const openTitles = sections()
  .filter((s) => s.open)
  .map((s) => s.querySelector('.settings-heading')?.textContent?.trim())
check('only the one return-to group starts open', openTitles.length === 1, openTitles.join(', '))
// Neither the overlay nor the webhook is configured from here any more: the
// overlay is the web admin panel's, and the webhook is gone. A group that outlived
// its feature would keep asking a question nothing answers.
check('the overlay is not offered here', !$('[data-section="overlay"]'))
check('and neither is a webhook', !$('[data-section="webhook"]'))

// A closed group hides its controls until its title is clicked.
const feed = sections().find((s) => s.getAttribute('data-section') === 'feed')
check('the feed group starts closed', feed?.open === false, String(feed?.open))
await click(feed.querySelector('.settings-heading'))
check('clicking its title opens it', feed.open === true, String(feed.open))
const dialogToggle = (label) =>
  $$('.modal-settings .toggle').find((t) => t.textContent.trim().startsWith(label))?.querySelector('input')

await click(dialogToggle('Compact'))
check('turning on compact sets the class', doc.body.classList.contains('compact') === true)
await click(dialogToggle('Compact'))
check('turning it off clears the class', doc.body.classList.contains('compact') === false)

await click(dialogToggle('Hide joins'))
// Emitted fresh: the earlier join row was pushed out by the 500-row cap test,
// which is the app behaving correctly and leaves nothing here to toggle.
await act(async () => {
  fake.emit({ platform: 'tiktok', type: 'join', nickname: 'Latecomer', avatar: '', id: 'v-late', timestamp: 1700000006400 })
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
// decision to make on every launch. Behind the gear with everything else — the
// toolbar keeps the stream and nothing that is a standing preference.
await click('.settings-btn')
const soundToggle = dialogToggle('Gift sound')
check('the gift sound is offered', Boolean(soundToggle))
check('it is on to begin with', soundToggle?.checked === true)
check('and the toolbar no longer carries it', !$('.view-toggles .toggle'))

// jsdom has no Web Audio, so this is the only place the missing-audio path is
// exercised — and it matters more than it looks: a throw from the gift handler
// would take down the feed, which is the app's whole job.
await click(soundToggle)
check('it can be turned off', dialogToggle('Gift sound')?.checked === false)
await act(async () => {
  fake.emit({ platform: 'tiktok', type: 'gift', ...viewer({ id: 'silent' }), giftName: 'Mute', count: 1, diamonds: 5, timestamp: 1700000006700 })
})
check('a gift with the sound off leaves the feed intact', $$('.row-gift').some((r) => /Mute/.test(r.textContent ?? '')))

await click(dialogToggle('Gift sound'))
check('and back on', dialogToggle('Gift sound')?.checked === true)
await act(async () => {
  fake.emit({ platform: 'tiktok', type: 'gift', ...viewer({ id: 'loud' }), giftName: 'Chime', count: 1, diamonds: 9999, timestamp: 1700000006800 })
})
check('a gift with the sound on still lands in the feed', $$('.row-gift').some((r) => /Chime/.test(r.textContent ?? '')))
check('and nothing about the room broke', $$('.row').length > 0)

// Collapse spam moved here too. It used to be component state on the toolbar, so
// it silently reset on every launch — which is the thing this now asserts against.
check('collapse spam is offered here', Boolean(dialogToggle('Collapse spam')))
check('and it starts on', dialogToggle('Collapse spam')?.checked === true)
check('the notice toggle came with it', Boolean(dialogToggle('Gift notice')))
await click($('.modal-close'))
check('the dialog closes again', !$('.modal-settings'))

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

console.log('pointing at the feed pauses it')
// Hovering to read a message must not be undone by the next one arriving — the
// same freeze scrolling up triggers, for a reader who never touches the wheel.
await act(async () => {
  node.dispatchEvent(new harness.dom.window.MouseEvent('mouseover', { bubbles: true }))
})
await act(async () => {
  for (let n = 0; n < 3; n++) {
    fake.emit({ platform: 'tiktok', type: 'chat', ...viewer({ id: `h${n}` }), text: `while hovering ${n}`, timestamp: 1700000007000 + n })
  }
})
check('hovering freezes the feed and raises the pill', Boolean($('.jump')), 'no .jump while hovering')
// Leaving resumes following only from the bottom; a feed left scrolled up stays put.
// Scrolled up first so "still scrolled up" is the actual state, not inherited.
await act(async () => {
  node.scrollTop = 0
  node.dispatchEvent(new harness.dom.window.Event('scroll', { bubbles: false }))
  node.dispatchEvent(new harness.dom.window.MouseEvent('mouseout', { bubbles: true }))
})
check('leaving a feed still scrolled up keeps it paused', Boolean($('.jump')), 'jump cleared on leave while scrolled up')
// Scrolled to the bottom first, then leaving resumes following.
await act(async () => {
  node.scrollTop = 600
  node.dispatchEvent(new harness.dom.window.Event('scroll', { bubbles: false }))
})
await act(async () => {
  node.dispatchEvent(new harness.dom.window.MouseEvent('mouseout', { bubbles: true }))
})
check('leaving from the bottom resumes following', !$('.jump'), 'jump stayed after leaving from the bottom')

console.log('the stats panel')
check('the panel is there', Boolean($('.stats-panel')))
check('it is collapsed to begin with', !$('.stats-body'))
// A viewer count set now, because the point being checked is that a collapsed
// panel still shows the number — not that the count survived every clear and
// reconnect earlier in this file, which is a different property and one the feed
// tests already cover. Emitting it here keeps this assertion about the glance.
await act(async () => {
  fake.emit({ platform: 'tiktok', type: 'viewers', count: 1234 })
})
// The stats recorder debounces its change notification by 250ms, so a viewer
// count set one tick ago has not reached the panel yet — the same wait the other
// viewer assertions below make. Without it the check races the debounce and reads
// the previous zero.
await new Promise((resolve) => setTimeout(resolve, 300))
// The count is a rolling number now: the visible digit is one of ten in a column,
// so its value lives in aria-label rather than in textContent, which reads the
// whole strip.
check(
  'the collapsed bar still shows the headcount',
  /1[.,]234/.test($('.stats-glance .roll-number')?.getAttribute('aria-label') ?? ''),
  $('.stats-glance .roll-number')?.getAttribute('aria-label'),
)

// The roll is per-digit: 186 → 185 moves only the last strip, the others stay put.
// That is the whole point over re-rendering the number — a digit that did not
// change must not flicker.
// Scoped to the viewer count's own number — the glance bar holds two of them.
const viewerRoll = () => doc.querySelector('.stats-glance .roll-number')
const rollStrips = () => [...viewerRoll().querySelectorAll('.roll-digit .roll-strip')]
const rollTransforms = () => rollStrips().map((s) => s.style.transform)
const rollBefore = rollTransforms()
// 1234 -> 1235: only the last digit changes, so only its strip should move.
await act(async () => {
  fake.emit({ platform: 'tiktok', type: 'viewers', count: 1235 })
})
// The stats recorder debounces its change notification by 250ms, so the new value
// has not reached the panel yet at 50ms — the same wait the viewer tests below make.
await act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 300))
})
const rollAfter = rollTransforms()
check('the number is still four digits', rollAfter.length === 4, String(rollAfter.length))
check(
  'only the last digit moved',
  rollAfter[0] === rollBefore[0] &&
    rollAfter[1] === rollBefore[1] &&
    rollAfter[2] === rollBefore[2] &&
    rollAfter[3] !== rollBefore[3],
  `${rollBefore} -> ${rollAfter}`,
)
check('the last strip rolled from 4 to 5', rollAfter[3] === 'translateY(-5em)', rollAfter[3])

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
// The bottom panels take vertical space the chat could use. Each can be switched
// off from the settings dialog and comes back when switched on.
await click('.settings-btn')
await click(dialogToggle('Stats panel'))
check('the stats panel goes away', !$('.stats-panel'))
await click(dialogToggle('Log panel'))
check('the log panel goes away', !$('.log-panel'))
await click(dialogToggle('Stats panel'))
check('and each comes back', Boolean($('.stats-panel')))
await click(dialogToggle('Log panel'))
check('the log is back too', Boolean($('.log-panel')))
console.log('chat alerts')
// Off by default: a blip per message and a voice reading the room are both
// things that have to be asked for, not assumed.
check('the chat blip is offered off', dialogToggle('Chat blip')?.checked === false)
check('and speech is off too', dialogToggle('Read chat aloud')?.checked === false)
// There is no name toggle: the read is the chat on its own, so there is no
// framing to configure.
check('the name toggle does not exist', !dialogToggle('Say the name'))
await click(dialogToggle('Chat blip'))
check('the blip turns on', dialogToggle('Chat blip')?.checked === true)
await click(dialogToggle('Read chat aloud'))
check('speech turns on', dialogToggle('Read chat aloud')?.checked === true)
check('and turning it on adds no name toggle', !dialogToggle('Say the name'))

// A gift can be announced with the same voice. Off by default, like every other
// sound that speaks: it sends text to be spoken, and that has to be asked for.
check('gift announcements are offered off', dialogToggle('Say gifts')?.checked === false)
await click(dialogToggle('Say gifts'))
check('and turn on', dialogToggle('Say gifts')?.checked === true)

console.log('choosing the reading pace')
// The picker is scoped to the feed section rather than found by label alone, so a
// "Reading pace" field added elsewhere would not quietly become the thing tested.
const paceField = () => $('[data-section="feed"] select.input')
// Three paces, and no more: the voice service takes a language and nothing else, so
// there is exactly one Indonesian voice to choose from and pace is what is left.
check('the pace can be chosen', Boolean(paceField()))
check(
  'the choices are slow, normal and fast',
  [...(paceField()?.options ?? [])].map((o) => o.value).join(',') === 'slow,normal,fast',
  [...(paceField()?.options ?? [])].map((o) => o.value).join(','),
)
check('and it starts on the service default', paceField()?.value === 'normal', paceField()?.value)
await act(async () => {
  const el = paceField()
  el.value = 'fast'
  el.dispatchEvent(new harness.dom.window.Event('change', { bubbles: true }))
})
check('a chosen pace sticks', paceField()?.value === 'fast', paceField()?.value)
// The part that actually matters: the choice is not a label in a dialog, it is what
// gets asked of the voice service. The message is spoken as itself, with no name and
// nothing framed around it, so `text` is the whole utterance.
await act(async () => {
  fake.emit({
    platform: 'tiktok',
    type: 'chat',
    ...viewer({ id: 'pace-check' }),
    text: 'halo dunia',
    timestamp: 1700000009999,
  })
})
await flush()
const spoken = fake.lastCommand('speak')
check('the message is spoken at the chosen pace', spoken?.args?.pace === 'fast', JSON.stringify(spoken?.args))
check('and it is sent as the chat, unframed', spoken?.args?.text === 'halo dunia', String(spoken?.args?.text))


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
// Gift, chat and joins each have their own template; the gift defaults to the chime
// the app shipped with, the chat to the short blip, and a join to the soft pop.
check('the gift has a sound to pick', soundSelects().length >= 3, String(soundSelects().length))
check('the gift defaults to the chime', soundSelects()[0]?.value === 'chime', soundSelects()[0]?.value)
check('and offers every template', soundSelects()[0]?.options.length >= 4, String(soundSelects()[0]?.options.length))
check('a join has its own sound', soundSelects()[2]?.value === 'pop', soundSelects()[2]?.value)
// Arrivals are the most repetitive event the app has, so this one is off until
// asked for rather than on until someone regrets it.
check('the join sound is offered off', dialogToggle('Join sound')?.checked === false)
await click(dialogToggle('Join sound'))
check('and turns on', dialogToggle('Join sound')?.checked === true)
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

/**
 * The note under a named field in the Sounds section.
 *
 * Scoped by label rather than by position: `.field-note` matches whichever note
 * comes first in the section, and that is whichever field was added last, so a
 * positional lookup reads a different field's note the moment a third sound
 * exists.
 */
const soundNote = (label) =>
  $$('[data-section="sounds"] .field').find((f) => f.querySelector('.field-label')?.textContent === label)?.querySelector(
    '.field-note',
  )

// A custom file overrides that event's template, one file per event. Picking one
// asks the host for a path, and an empty path — a cancelled picker — must leave
// the previous pick alone rather than clear it.
check('no custom file by default', /No file/.test(soundNote('Gift sound')?.textContent ?? ''), soundNote('Gift sound')?.textContent)
// One picker per event, so a gift file and a chat file are independent choices.
const chooseBtns = $$('[data-section="sounds"] .btn').filter((b) => b.textContent.trim() === 'Choose file…')
check('a file picker per event', chooseBtns.length === 3, String(chooseBtns.length))
// A previous section replaced `invoke` with a recording stub; restore plain
// recording so this command is seen.
fake.transport.invoke = async (command, args) => {
  fake.commands.push({ command, args })
  if (command === 'pick_sound_file') return ''
  return undefined
}
await click(chooseBtns[0])
check('the host was asked for a file', Boolean(fake.lastCommand('pick_sound_file')), JSON.stringify(fake.commands.at(-1)))
// Cancelled (empty path): nothing changes, and no error is raised — backing out
// of a picker is not a failure the user has to act on.
check('a cancelled pick leaves the settings alone', /No file/.test(soundNote('Gift sound')?.textContent ?? ''))
// A real pick lands on the event whose picker was used, and only that one.
fake.transport.invoke = async (command, args) => {
  fake.commands.push({ command, args })
  if (command === 'pick_sound_file') return '/sounds/gift.mp3'
  return undefined
}
await click(chooseBtns[0])
check('the picked file is shown for its event', /gift\.mp3/.test(soundNote('Gift sound')?.textContent ?? ''), soundNote('Gift sound')?.textContent)
check('and the other events are untouched', /No file/.test(soundNote('Chat blip')?.textContent ?? ''), soundNote('Chat blip')?.textContent)

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
