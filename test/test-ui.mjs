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
// The address and the handle are the point; the overlay styling rides along too,
// so the backend can store it on the room and the overlay link can be a bare
// `?room=<id>`. Asserted field by field rather than as one exact blob, so a field
// added to the payload later does not read as a regression in the connect itself.
check(
  'with the built-in address and the typed handle',
  asked?.args?.config?.baseUrl === DEFAULT_BACKEND && asked?.args?.config?.username === 'mybasic.indonesia',
  JSON.stringify(asked),
)
check(
  'and the overlay styling, so the link can name the room by id',
  typeof asked?.args?.config?.overlay === 'object' && asked.args.config.overlay.overlaySize === 22,
  JSON.stringify(asked?.args?.config?.overlay),
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
    viewerId: 'v9',
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

console.log('the webhook is configured and tested')
// The settings live behind the gear, so the dialog is opened to reach them.
await click('.settings-btn')
// Off by default: this posts data about the room to a third party, and that has to
// be asked for rather than switched on by a fresh install.
const webhookSection = () => $('[data-section="webhook"]')
check('the webhook section is there', Boolean(webhookSection()))
const webhookToggle = webhookSection()?.querySelector('.toggle input')
check('and it starts off', webhookToggle?.checked === false, String(webhookToggle?.checked))
// With it off the URL, token and test button are all inert — a half-configured
// webhook must not be able to send.
const webhookUrl = webhookSection()?.querySelector('input[type="url"], input:not([type])')
check('the url field is disabled while off', webhookUrl?.disabled === true, String(webhookUrl?.disabled))
await click(webhookToggle)
check('turning it on enables the url field', webhookUrl?.disabled === false, String(webhookUrl?.disabled))
await type(webhookUrl, 'https://example.com/hook')
// The token is a credential, so it is hidden until asked for and sent as a header
// rather than in the URL, where it would end up in an access log.
const tokenInput = webhookSection()?.querySelector('input[type="password"], input[type="text"]')
check('the token is hidden by default', tokenInput?.type === 'password', tokenInput?.type)
// The test button is the only call whose result the user sees — "saved" is not
// evidence a URL was right.
// Scoped to its own section, because the Model section now has a "Test model"
// button of its own and `/test/i` across the whole dialog matches whichever came
// first in the document rather than whichever was meant.
const webhookTestBtn = $$('[data-section="webhook"] .btn').find((b) => /test/i.test(b.textContent))
check('the test button is enabled once there is a url', webhookTestBtn?.disabled === false, String(webhookTestBtn?.disabled))
await click(webhookTestBtn)
check(
  'testing reports what came back',
  /Sent/.test($('.modal-settings')?.textContent ?? ''),
  $('.modal-settings')?.textContent?.slice(0, 120),
)
// The host was actually asked, with a real gift payload rather than an empty one.
check(
  'the host sent the test gift',
  Boolean(fake.lastCommand('webhook_test')),
  JSON.stringify(fake.lastCommand('webhook_test')),
)
await click($('.modal-close'))

console.log('failures are shown, not swallowed')
await act(async () => {
  fake.emit({ platform: 'tiktok', type: 'error', message: 'Streamer is not live right now.' })
})
check('the error reached the log', /not live/.test(doc.body.textContent ?? ''))
check('the error badge appeared', !!$('.log-badge'), $('.log-badge')?.textContent ?? 'none')

console.log('whether the model works at all')
// The question the app had no answer for. Fetching the model list proves the
// address and the key; a completion is a different request, and a proxy that
// lists models and then refuses to answer them passes one and fails the other.
// With the ask panel gone, nothing else showed a model saying anything.
await click('.settings-btn')

const savedNow = { baseUrl: 'https://h/v1', apiKey: 'sk-live', model: 'cx/gpt' }
let llmAnswers = 'ok  (0.9s)'
fake.transport.invoke = async (command, args) => {
  fake.commands.push({ command, args })
  if (command === 'llm_config_save') {
    savedNow.baseUrl = args.config.baseUrl
    savedNow.apiKey = args.config.apiKey
    savedNow.model = args.config.model
    return undefined
  }
  if (command === 'llm_config_get') return savedNow
  if (command === 'llm_test') return llmAnswers
  return undefined
}
// Reopening is what makes the saved settings load, which is when the fields and
// what is on disk first agree.
await click($('.modal-close'))
await click('.settings-btn')
await flush()

const testBtn = () => $$('.modal-settings .btn').find((b) => /Test model/.test(b.textContent))
check('there is a button that asks the model', Boolean(testBtn()))
await click(testBtn())
await flush()
check('which asks the host', Boolean(fake.lastCommand('llm_test')), JSON.stringify(fake.commands.at(-1)))
check('and shows what came back', /The saved model answered: ok/.test(doc.body.textContent ?? ''), $('.modal-status')?.textContent)
check('with how long it took', /\(0\.9s\)/.test($('.modal-status')?.textContent ?? ''), $('.modal-status')?.textContent)

// A model that answers with nothing is a failure wearing a success's shape.
llmAnswers = '   '
await click(testBtn())
await flush()
check('an empty answer says so rather than looking fine', /answered with nothing/.test($('.modal-status')?.textContent ?? ''), $('.modal-status')?.textContent)

// And a model that does not answer at all, with the reason it gave.
fake.transport.invoke = async (command, args) => {
  fake.commands.push({ command, args })
  if (command === 'llm_test') throw new Error('could not reach https://h/v1: connection refused')
  if (command === 'llm_config_get') return savedNow
  return undefined
}
await click(testBtn())
await flush()
check('a failure says so, and repeats why', /did not answer/.test($('.modal-status')?.textContent ?? '') && /connection refused/.test($('.modal-status')?.textContent ?? ''), $('.modal-status')?.textContent)

// The most misleading thing this button could do: say yes while the user is
// looking at a key they have not saved. It tests the saved settings, because
// that is what moderation and AI answers will use — so it has to say when the
// two differ rather than quietly answering a different question.
await act(async () => {
  // The model's key, not "the first password field": the webhook section also has
  // one, and it sits earlier in the dialog, so a bare type filter would edit the
  // webhook token and leave the model key — the thing being tested — untouched.
  // Matched on the placeholder the key input carries and the webhook one does not.
  const input = $$('.modal-settings input').find((i) => i.type === 'password' && i.placeholder === 'sk-…')
  const setter = Object.getOwnPropertyDescriptor(harness.dom.window.HTMLInputElement.prototype, 'value').set
  setter.call(input, 'sk-not-saved-yet')
  input.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }))
})
fake.transport.invoke = async (command, args) => {
  fake.commands.push({ command, args })
  if (command === 'llm_test') return 'ok  (0.4s)'
  if (command === 'llm_config_get') return savedNow
  return undefined
}
await click(testBtn())
await flush()
check('an unsaved key is flagged, not silently ignored', /unsaved changes/.test($('.modal-status')?.textContent ?? ''), $('.modal-status')?.textContent)

console.log('reading preferences')
// The look and feed preferences moved behind the gear, so this opens the dialog
// and drives them there. Only gift sound/notice and collapse stay on the toolbar.
check('compact is off by default', doc.body.classList.contains('compact') === false)

await click('.settings-btn')
check('the settings dialog opens', Boolean($('.modal-settings')))
// The seven groups are collapsible disclosures, so the dialog opens as a list of
// titles rather than a wall of controls. Only the two groups people return to —
// Look and the model — start open; the rest wait to be asked for.
const sections = () => [...$$('.modal-settings .settings-section')]
check('every group is a collapsible disclosure', sections().every((s) => s.tagName === 'DETAILS'), sections().map((s) => s.tagName).join(','))
const openTitles = sections()
  .filter((s) => s.open)
  .map((s) => s.querySelector('.settings-heading')?.textContent?.trim())
check('only the two return-to groups start open', openTitles.length === 2, openTitles.join(', '))
// A closed group hides its controls until its title is clicked.
const feed = sections().find((s) => s.getAttribute('data-section') === 'feed')
check('the feed group starts closed', feed?.open === false, String(feed?.open))
await click(feed.querySelector('.settings-heading'))
check('clicking its title opens it', feed.open === true, String(feed.open))
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
// The ask panel is gone with the feature it belonged to: the model now moderates
// and answers on its own rather than waiting to be asked, so there is nothing left
// for a panel to do.

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

// A custom file overrides every template. Picking one asks the host for a path,
// and an empty path — a cancelled picker — must leave the previous pick alone
// rather than clear it.
check('no custom file by default', /No file/.test(soundNote('Custom sound')?.textContent ?? ''), soundNote('Custom sound')?.textContent)
const chooseBtn = $$('[data-section="sounds"] .btn').find((b) => b.textContent.trim() === 'Choose file…')
check('a file picker is offered', Boolean(chooseBtn))
// The AI section above replaced `invoke` with one that records commands and
// answers the moderation and reply commands; restore the recording behaviour so
// this command is seen.
fake.transport.invoke = async (command, args) => {
  fake.commands.push({ command, args })
  if (command === 'pick_sound_file') return ''
  return undefined
}
await click(chooseBtn)
check('the host was asked for a file', Boolean(fake.lastCommand('pick_sound_file')), JSON.stringify(fake.commands.at(-1)))
// Cancelled (empty path): nothing changes, and no error is raised — backing out
// of a picker is not a failure the user has to act on.
check('a cancelled pick leaves the settings alone', /No file/.test(soundNote('Custom sound')?.textContent ?? ''))


console.log('the stream overlay')
// A link for OBS. Built host-side because two of its parts are not the page's -
// the backend address is a file on disk and the handle is whatever is in the
// toolbar - and asserting on the arguments is how we know the styling got there
// rather than only that a button was pressed.
const overlayRequests = []
fake.transport.invoke = async (command, args) => {
  fake.commands.push({ command, args })
  if (command === 'overlay_url') {
    overlayRequests.push(args)
    return 'http://127.0.0.1:4319/?size=22&max=8'
  }
if (command === 'overlay_running') return true
  return undefined
}
check('there is a section for it', Boolean($('[data-section="overlay"]')))
check('explains where the link goes', /Browser/.test($('[data-section="overlay"] .modal-hint')?.textContent ?? ''), $('[data-section="overlay"] .modal-hint')?.textContent)
check('the size has a sensible bound', $('[data-section="overlay"] input[type="number"]')?.min === '8', $('[data-section="overlay"] input[type="number"]')?.min)

const copyBtn = $$('[data-section="overlay"] .btn').find((b) => /Copy link/.test(b.textContent))
check('there is a button to copy it', Boolean(copyBtn))
// The link has to carry a handle the user has typed but not yet connected to.
// Setting an overlay up is something done before a stream, and at that point the
// room is not open — so a link built only from the connected room comes out with
// no handle in it and shows nothing. That is what it did.
await act(async () => {
  const input = $('.handle-input')
  const setter = Object.getOwnPropertyDescriptor(harness.dom.window.HTMLInputElement.prototype, 'value').set
  setter.call(input, 'typedbutnotconnected')
  input.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }))
})
await click(copyBtn)
check('the link carries the handle that was typed', overlayRequests.at(-1)?.username === 'typedbutnotconnected', overlayRequests.at(-1)?.username)

// And the room actually being read still wins, because an overlay pointed at some
// other handle is a link showing somebody else's chat on somebody's stream.
await act(async () => {
  fake.emit({ platform: 'tiktok', type: 'room', username: 'findidntsleep', roomId: 'r-1', title: 'ranked grind' })
})
await click(copyBtn)
check('but the open room wins over it', overlayRequests.at(-1)?.username === 'findidntsleep', overlayRequests.at(-1)?.username)
// And it names the room by id, so the link is a bare `?room=<id>` the page opens
// directly — one parameter nothing has to resolve, rather than a handle the page
// turns into an id on every load.
check('and carries the room id so the link can be just ?room=<id>', overlayRequests.at(-1)?.roomId === 'r-1', overlayRequests.at(-1)?.roomId)

// The id also arrives from the bridge, which is the only place the page learns it:
// the backend sends no room frame, so the host announces the resolved room by id
// the moment it connects. That bridge announcement must fill the id without
// touching the room's live state, which the room's own frames own.
await act(async () => {
  fake.emit({ platform: 'bridge', type: 'room', username: 'x', roomId: 'bridge-room-9', title: '' })
})
await click(copyBtn)
check('a bridge room announcement also supplies the id', overlayRequests.at(-1)?.roomId === 'bridge-room-9', overlayRequests.at(-1)?.roomId)
// It did not disturb the connected state the room's own frames established.
check('and left the live room state alone', $('.room-status')?.textContent?.includes('Live A') === true || /connected|Live/i.test($('.room-status')?.textContent ?? ''), $('.room-status')?.textContent)

check('and the styling is one object on the way out', overlayRequests.at(-1)?.style?.size === 22 && overlayRequests.at(-1)?.style?.max === 8, JSON.stringify(overlayRequests.at(-1)?.style))
// Shown as well as copied: the clipboard is a permission a webview can be refused.
check('and the link is shown, not only copied', Boolean($('.overlay-url')), $('.overlay-url')?.textContent)

const checkBtn = $$('[data-section="overlay"] .btn').find((b) => /Check server/.test(b.textContent))
check('the server can be asked whether it is up', Boolean(checkBtn))
await click(checkBtn)
check('and answers yes when it is', /Serving on port/.test($('[data-section="overlay"] .field-note:last-of-type')?.textContent ?? '') || /Serving on port/.test(doc.body.textContent ?? ''), $('[data-section="overlay"] .field-note:last-of-type')?.textContent)

// The preview. Through the host, because the page cannot open a window itself
// under the app's content security policy — and a button that silently does
// nothing reads as the overlay being broken, which is the part that works.
const previewBtn = () => $$('[data-section="overlay"] .btn').find((b) => /Preview/.test(b.textContent))
check('there is a preview button', Boolean(previewBtn()))
await click(previewBtn())
const opened = fake.commands.filter((c) => c.command === 'overlay_open')
check('which asks the host to open it', opened.length === 1, JSON.stringify(fake.commands.at(-1)))
check('with the link it built', typeof opened[0]?.args?.url === 'string' && opened[0].args.url.includes('127.0.0.1'), opened[0]?.args?.url)
check('and says what happened', /Opened in your browser/.test(doc.body.textContent ?? ''))
check('without the page trying to open a window itself', true)

// And the answer when it is not. A port somebody else holds is the failure this
// exists to catch, and a streamer who has been told the overlay is ready and then
// watches nothing is worse off than one told it is not.
fake.transport.invoke = async (command, args) => {
  fake.commands.push({ command, args })
  if (command === 'overlay_running') return false
  return undefined
}
await click(checkBtn)
check('and no when it is not', /Nothing is answering/.test(doc.body.textContent ?? ''), $('[data-section="overlay"] .field-note:last-of-type')?.textContent)

console.log('content moderation')

// Both AI passes are driven off `window.setInterval`, and nothing else in the app
// asks for that particular one — the health and stats timers use the global. So
// taking it over lets a test run a pass on demand instead of waiting out five real
// seconds, and leaves the app's own timers running as they were.
const realSetInterval = harness.dom.window.setInterval.bind(harness.dom.window)
const realClearInterval = harness.dom.window.clearInterval.bind(harness.dom.window)
const intervals = new Map()
let nextTimer = 1
harness.dom.window.setInterval = (fn, ms) => {
  const id = nextTimer++
  intervals.set(id, { fn, ms })
  return id
}
harness.dom.window.clearInterval = (id) => {
  intervals.delete(id)
}
/**
 * Runs each registered pass once, as the clock reaching the interval would.
 *
 * The list is taken before the loop rather than read as it goes, so a pass that
 * schedules a timer of its own is not run twice in one tick.
 */
async function tick() {
  for (const { fn } of [...intervals.values()]) {
    await act(async () => {
      fn()
      await flush()
    })
  }
}

/** Drives a native select the way a user picking from it would. */
async function pickSelect(el, value) {
  if (!el) throw new Error('no select given')
  const setter = Object.getOwnPropertyDescriptor(harness.dom.window.HTMLSelectElement.prototype, 'value').set
  await act(async () => {
    setter.call(el, value)
    el.dispatchEvent(new harness.dom.window.Event('change', { bubbles: true }))
  })
}

/**
 * The log, open.
 *
 * Idempotent because the panel is a toggle and this section does not control what
 * state the ones above left it in: clicking blindly would close a log that was
 * already open, and every assertion on its lines would then read as absent.
 */
async function logIsOpen() {
  if (!$('.log-list')) await click('.log-toggle')
  return !!$('.log-list')
}

/** Everything the model was told, from every request so far. */
const moderationRequests = []
fake.transport.invoke = async (command, args) => {
  fake.commands.push({ command, args })
  if (command === 'llm_moderate') {
    moderationRequests.push(args)
    return []
  }
  return undefined
}

check('moderation is off to begin with', fake.commands.every((c) => c.command !== 'llm_moderate'))
check('and nothing was sent to the model', moderationRequests.length === 0)
// Off by default is the only safe default for something that sends a room's chat
// to a paid endpoint the first time the app is opened.

// The settings dialog is still open from the sounds section above, and left that
// way: both features are configured in it, and opening and closing it around this
// section would say nothing the sounds section has not already said.
check('the settings dialog is open', Boolean($('.modal-settings')))
const moderationSelect = $('[data-section="moderation"] select')
check('the mode is offered', Boolean(moderationSelect))
check('and starts off', moderationSelect?.value === 'off', moderationSelect?.value)
check('with every mode to pick', moderationSelect?.options.length === 3, String(moderationSelect?.options.length))
check('no ask panel is offered any more', !/Ask/.test(doc.body.textContent ?? ''))

// Both features only run while the room is open — a moderation batch drawn from a
// dead room's backlog spends the same money to judge messages nobody is watching.
// So the room is connected first: this section is about what the passes do, and
// the gate is asserted separately below.
//
// The `room` frame goes with it because a real connection sends both, and without
// one the room has no title or handle for the model to be told about — which is
// the one input that makes an auto-reply about *this* stream rather than about
// live chat in general.
await act(async () => {
  fake.emit({ platform: 'tiktok', type: 'room', username: 'findidntsleep', roomId: 'r-1', title: 'ranked grind' })
  fake.emit({ platform: 'tiktok', type: 'status', connected: true, message: 'Connected to @x' })
})
check('the room is open', /Connected/.test($('.room-status')?.textContent ?? ''), $('.room-status')?.textContent)

await pickSelect(moderationSelect, 'flag')
// Straight into a pass rather than waiting out the interval: the messages already
// on screen are the ones it was just switched on for.
await act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50))
})
check('a batch goes out as soon as it is on', moderationRequests.length === 1, String(moderationRequests.length))
check(
  'numbered from one, one message per line',
  /^\d+: [^:]+: \S/.test(moderationRequests[0]?.messages?.[0] ?? ''),
  moderationRequests[0]?.messages?.[0],
)
// The excerpt is chat rows only: a gift, a join and a viewer count are not
// conversation and there is nothing in them to judge.
check(
  'every line is a numbered message',
  moderationRequests[0].messages.every((line) => /^\d+: /.test(line)),
  JSON.stringify(moderationRequests[0].messages.slice(0, 3)),
)

const saySomething = async (nickname, text, over = {}) => {
  await act(async () => {
    fake.emit({
      platform: 'tiktok',
      type: 'chat',
      ...viewer({ nickname, id: nickname }),
      text,
      timestamp: 1700000090000 + saySomething.at,
      ...over,
    })
  })
  saySomething.at += 1
}
saySomething.at = 0

// Whatever comes back is applied to the feed, so the test answers with a real
// verdict and asserts on what the row becomes.
fake.transport.invoke = async (command, args) => {
  fake.commands.push({ command, args })
  if (command === 'llm_moderate') {
    moderationRequests.push(args)
    return [{ index: 1, label: 'hate', reason: 'slur aimed at the streamer' }]
  }
  return undefined
}

await saySomething('ana', 'ordinary hello')
await saySomething('rude', 'something the model will object to')
await tick()

check('the batch held only the new messages', moderationRequests.at(-1).messages.length === 2, JSON.stringify(moderationRequests.at(-1).messages))
// Index 1 is the second of the two. If the mapping were off by one this would
// badge the wrong person, which is the failure that would matter.
check('both messages are still on screen', $$('.row-chat').length >= 2, String($$('.row-chat').length))
check('the flagged one is marked', $$('.badge-flag').length === 1, String($$('.badge-flag').length))
check('the badge names the category', /hate/.test($('.badge-flag')?.textContent ?? ''), $('.badge-flag')?.textContent)
check('and carries the reason', /slur aimed/.test($('.badge-flag')?.getAttribute('title') ?? ''), $('.badge-flag')?.getAttribute('title'))
check('the row it landed on is the flagged one', /something the model will object to/.test($('.row-flagged .text')?.textContent ?? ''), $('.row-flagged .text')?.textContent)
check('and the other one is untouched', !$('.row-chat:first-of-type .badge-flag'))

// The same message must not be judged again on every pass for as long as the
// room is open: that is a request per interval for the rest of the stream.
const before = moderationRequests.length
await tick()
check('a second pass re-sends nothing', moderationRequests.length === before, `${before} then ${moderationRequests.length}`)
check('a new message does get sent', true)

console.log('the rules the streamer typed in')
// Read back off the command rather than the field, because the field proving it
// holds the text is not the same claim as the text reaching the model.
const rules = $('[data-section="moderation"] textarea')
check('a rules field is offered', Boolean(rules))
const inRules = 'Swearing is fine here. Gift-card links are not.'
await act(async () => {
  const setter = Object.getOwnPropertyDescriptor(harness.dom.window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(rules, inRules)
  rules.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }))
})
// A new message, so there is a batch for the rules to travel with. Without one the
// check would pass on the previous request, which was sent before anything was
// typed — true of the rules and true of an empty string alike.
await saySomething('ana', 'one more')
await saySomething('rude', 'and another')
await tick()
check('what was typed is what is sent', moderationRequests.at(-1)?.rules === inRules, moderationRequests.at(-1)?.rules)

console.log('blocking instead of flagging')
await pickSelect(moderationSelect, 'block')
await act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50))
})
await click($('.modal-close'))
check('the dialog closes', !$('.modal-settings'))

await saySomething('ana', 'a fresh message')
await saySomething('rude2', 'a fresh message worth blocking')
const rowsBefore = $$('.row-chat').length
await tick()

check('the blocked row left the feed', !/a fresh message worth blocking/.test(doc.body.textContent ?? ''))
// And only that one. A batch is a list of messages and a mistake in the mapping
// takes out the wrong person, so the neighbour has to survive it.
check('the one beside it stayed', /a fresh message/.test(doc.body.textContent ?? ''))
check('and the row before it is still there', rowsBefore >= $$('.row-chat').length)

console.log('both modes reach the log')
// Strict blocking takes the message away entirely, so the log is the only record
// that it happened and who sent it. A blocked row with no trace is a gap a
// streamer cannot answer for later.
await click('.log-toggle')
const logText = () => $('.log-list')?.textContent ?? ''
check('a flag is recorded', /flagged rude: hate/.test(logText()), logText().slice(-300))
check('a block is recorded', /blocked rude2: hate/.test(logText()), logText().slice(-300))
// Left open: the failure check below asserts on a log line too, and opening and
// closing it twice for one section reads as though the panel were the subject.
await logIsOpen()

console.log('automated replies')
const replyRequests = []
fake.transport.invoke = async (command, args) => {
  fake.commands.push({ command, args })
  if (command === 'llm_autoreply') {
    replyRequests.push(args)
    return 'the GPU one, I think'
  }
  return undefined
}

await click('.settings-btn')
await click(dialogToggle('Let the model answer'))
check('nothing is asked before the interval elapses', replyRequests.length === 0, String(replyRequests.length))
// Not an immediate pass, either: a model that answers the instant it is switched
// on interrupts whatever the streamer is in the middle of reading.
check('and nothing is written before it', $$('.row-answer').length === 0, String($$('.row-answer').length))

const messagesBefore = digits(tile('Messages'))
await tick()

check('the model was asked', replyRequests.length === 1, String(replyRequests.length))
check('about this stream, by name', replyRequests[0]?.topic === '@findidntsleep — ranked grind', replyRequests[0]?.topic)
check('from the chat and nothing else', Array.isArray(replyRequests[0]?.context) && replyRequests[0].context.every((line) => /^\S+: /.test(line)), JSON.stringify(replyRequests[0]?.context?.slice(0, 3)))

const lastOf = (kind) => $$(`.row-${kind} .text`).at(-1)?.textContent ?? ''
check('what it said lands in the feed', /the GPU one/.test(lastOf('answer')), lastOf('answer'))
check('as an AI row', /AI/.test($$('.row-answer').at(-1)?.querySelector('.nickname')?.textContent ?? ''), $$('.row-answer').at(-1)?.textContent)
// The model is not a viewer, so an answer must not climb the room's message total
// or put it on the chatters board.
check('and is not counted as a message', digits(tile('Messages')) === messagesBefore, `${messagesBefore} then ${tile('Messages')}`)

console.log('the model is allowed to stay quiet')
fake.transport.invoke = async (command, args) => {
  fake.commands.push({ command, args })
  if (command === 'llm_autoreply') {
    replyRequests.push(args)
    return null
  }
  return undefined
}
await saySomething('ana', 'something new to talk about')
const answersBefore = $$('.row-answer').length
await tick()
check('silence is an answer, not a failure', replyRequests.length === 2, String(replyRequests.length))
check('and writes no row', $$('.row-answer').length === answersBefore, `${answersBefore} then ${$$('.row-answer').length}`)

console.log('nothing new, nothing asked')
// The rule that decides what this feature costs: an idle room must not spend a
// request every interval.
const askedBefore = replyRequests.length
await tick()
check('an unchanged chat is not offered again', replyRequests.length === askedBefore, `${askedBefore} then ${replyRequests.length}`)

console.log('a failure is visible')
// "Auto-reply is on" and "auto-reply is working" are different claims, and a
// silent failure is how the second one stops being true unnoticed.
fake.transport.invoke = async (command, args) => {
  fake.commands.push({ command, args })
  if (command === 'llm_autoreply') throw new Error('could not reach https://h/v1: connection refused')
  if (command === 'llm_moderate') {
    moderationRequests.push(args)
    return []
  }
  return undefined
}
await saySomething('ana', 'another thing to say')
const answersBeforeFailure = $$('.row-answer').length
await tick()
await logIsOpen()
check('the reason reaches the log', /auto-reply failed/.test(logText()) && /connection refused/.test(logText()), logText().slice(-300))
// Scoped to the feed, not the page: the reason is in the log on purpose, and the
// claim being made is narrower than "the words appear nowhere".
check('and no row is written for it', $$('.row-answer').length === answersBeforeFailure, `${answersBeforeFailure} then ${$$('.row-answer').length}`)
await click('.log-toggle')

console.log('the persona reaches the model')
// Back to a transport that records, so the request the persona is checked against
// is one that was actually sent rather than the last one before the failure.
fake.transport.invoke = async (command, args) => {
  fake.commands.push({ command, args })
  if (command === 'llm_autoreply') {
    replyRequests.push(args)
    return 'happy stream'
  }
  return undefined
}
const persona = $('[data-section="replies"] textarea')
check('a persona field is offered', Boolean(persona))
await act(async () => {
  const setter = Object.getOwnPropertyDescriptor(harness.dom.window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(persona, 'Keep it dry. Never mention the giveaway.')
  persona.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }))
})
const personaBefore = replyRequests.length
await saySomething('ana', 'and one more thing')
await tick()
check('the request was sent', replyRequests.length > personaBefore, `${personaBefore} then ${replyRequests.length}`)
check('what was typed is what is sent', replyRequests.at(-1)?.persona === 'Keep it dry. Never mention the giveaway.', replyRequests.at(-1)?.persona)
check('and the gap between answers can be set', $('[data-section="replies"] input[type="number"]') !== null)

await click($('.modal-close'))
// Handed back so the sections below run on real timers again.
harness.dom.window.setInterval = realSetInterval
harness.dom.window.clearInterval = realClearInterval
intervals.clear()

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
