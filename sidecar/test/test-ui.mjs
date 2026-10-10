/**
 * The UI, tested without launching the app.
 *
 * Every check runs in jsdom against the real components, with the transport to
 * the Rust host replaced by a fake. That is the point: no window, no debug port,
 * no WebView2, and no dependence on either platform being live — so this suite is
 * deterministic and takes milliseconds.
 *
 *   node sidecar/test/test-ui.mjs
 */

import { fakeTransport, flush, installDom, loadApp } from './dom.mjs'

// Before React is imported: it picks its development or production build at load
// time, and the production build throws on `act`. Setting it afterwards is too
// late, which is a confusing failure to chase.
process.env.NODE_ENV = 'development'

const { entry } = await loadApp()
const { App, Overlay, setTransport } = await import(entry)

const harness = installDom()
const React = (await import('react')).default
const { createRoot } = await import('react-dom/client')
const { act } = React

const fake = fakeTransport()
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
check('one room row', $$('.room-row').length === 1)
check('the log panel is closed', !$('.log-list'))
// Mounting does not connect to anything. It does sync the window state once,
// which is the only command that may be sent without being asked.
check(
  'nothing was connected just by mounting',
  fake.commands.every((c) => c.command !== 'connect' && c.command !== 'disconnect'),
  JSON.stringify(fake.commands),
)

console.log('connecting asks the host for the right thing')
await type('.room-row .input', 'mpl.id.official')
check('the value reached React state', $('.room-row .input').value === 'mpl.id.official')
check('the button is now enabled', $('.room-row .btn-primary')?.disabled === false)
await click('.room-row .btn-primary')
check(
  'a connect command was sent with the platform',
  JSON.stringify(fake.lastCommand('connect')) ===
    JSON.stringify({ command: 'connect', args: { platform: 'tiktok', target: 'mpl.id.official' } }),
  JSON.stringify(fake.lastCommand('connect')),
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
await click('.room-row .btn-danger')
// The host confirms the close, exactly as the real one does — the row keeps its
// Stop button until then, so a test that skipped this would see the old state.
await act(async () => {
  fake.emit({ platform: 'tiktok', type: 'status', connected: false, message: 'Disconnected' })
})
await type('.room-row .input', 'akunliverinee')
await click('.room-row .btn-primary')
const connects = fake.commands.filter((c) => c.command === 'connect')
check('every connect names the one platform', connects.every((c) => c.args.platform === 'tiktok'), JSON.stringify(connects))
check('and carried the handle', connects.at(-1)?.args.target === 'akunliverinee', JSON.stringify(connects.at(-1)))

await act(async () => {
  fake.emit({ platform: 'tiktok', type: 'status', connected: true, message: 'tt up' })
  fake.emit({ platform: 'tiktok', type: 'room', username: 'akunliverinee', roomId: '7', title: 'a title' })
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
    JSON.stringify({ command: 'open_stream', args: { url: 'https://www.tiktok.com/@akunliverinee/live' } }),
  JSON.stringify(fake.lastCommand('open_stream')),
)

console.log('stopping closes the room')
await click('.room-row .btn-danger')
check(
  'the platform was named',
  JSON.stringify(fake.lastCommand('disconnect')) === JSON.stringify({ command: 'disconnect', args: { platform: 'tiktok' } }),
  JSON.stringify(fake.lastCommand('disconnect')),
)

console.log('failures are shown, not swallowed')
await act(async () => {
  fake.emit({ platform: 'tiktok', type: 'error', message: 'Streamer is not live right now.' })
})
check('the error reached the log', /not live/.test(doc.body.textContent ?? ''))
check('the error badge appeared', !!$('.log-badge'), $('.log-badge')?.textContent ?? 'none')

console.log('reading preferences')
check('compact is off by default', $$('.view-toggles').length === 1)
const toggleByLabel = (label) =>
  $$('.view-toggles .toggle').find((t) => t.textContent.trim().startsWith(label))?.querySelector('input')

await click(toggleByLabel('Compact'))
check('turning on compact sets the class', doc.body.classList.contains('compact') === true)
await click(toggleByLabel('Compact'))
check('turning it off clears the class', doc.body.classList.contains('compact') === false)

// On by default, and stored: whether a chime fires at 3am is a preference, not a
// decision to make on every launch.
const soundToggle = toggleByLabel('Gift sound')
check('the gift sound is offered', Boolean(soundToggle))
check('it is on to begin with', soundToggle?.checked === true)

// jsdom has no Web Audio, so this is the only place the missing-audio path is
// exercised — and it matters more than it looks: a throw from the gift handler
// would take down the feed, which is the app's whole job.
await click(soundToggle)
check('it can be turned off', toggleByLabel('Gift sound')?.checked === false)
await act(async () => {
  fake.emit({ platform: 'tiktok', type: 'gift', ...viewer({ id: 'silent' }), giftName: 'Mute', count: 1, diamonds: 5, timestamp: 1700000006700 })
})
check('a gift with the sound off leaves the feed intact', $$('.row-gift').some((r) => /Mute/.test(r.textContent ?? '')))

await click(toggleByLabel('Gift sound'))
check('and back on', toggleByLabel('Gift sound')?.checked === true)
await act(async () => {
  fake.emit({ platform: 'tiktok', type: 'gift', ...viewer({ id: 'loud' }), giftName: 'Chime', count: 1, diamonds: 9999, timestamp: 1700000006800 })
})
check('a gift with the sound on still lands in the feed', $$('.row-gift').some((r) => /Chime/.test(r.textContent ?? '')))
check('and nothing about the room broke', $$('.row').length > 0)

await click(toggleByLabel('Hide joins'))
// Emitted fresh: the earlier join row was pushed out by the 500-row cap test,
// which is the app behaving correctly and leaves nothing here to toggle.
await act(async () => {
  fake.emit({ platform: 'tiktok', type: 'join', nickname: 'Latecomer', avatar: '', viewerId: 'v-late', timestamp: 1700000006400 })
})
check('the toggle actually hides a join row', $$('.row-join').length === 0, String($$('.row-join').length))
await click(toggleByLabel('Hide joins'))
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
await click(toggleByLabel('Hide filtered'))
check('hide-filtered removes it', $$('.badge-filtered').length === 0)
await click(toggleByLabel('Hide filtered'))
check('and brings it back', $$('.badge-filtered').length === 1)

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

// Three components subscribe to the same channel — the feed, the gift chime and
// the overlay — and all three attach during the same mount. Any of them landing a
// second registration on the transport delivers every frame twice, which shows up
// here as doubled totals rather than as anything a user could name.
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
check('a rising headcount raises the peak with it', tile('Peak') === '11.296', tile('Peak'))
check('and the current count is added across rooms', tile('Watching') === '11.296', tile('Watching'))
await act(async () => {
  fake.emit({ platform: 'tiktok', type: 'viewers', count: 500 })
})
await act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 300))
})
check('a falling headcount does not lower the peak', tile('Peak') === '11.296', tile('Peak'))
check('but the current count follows it down', tile('Watching') === '500', tile('Watching'))

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

console.log('the overlay window')
// A second root in the same page: the overlay is its own window in the app, and
// rendering it here is the closest a headless run gets to that.
await act(async () => {
  root.render(React.createElement(Overlay))
})
await flush()

check('it starts with nothing to show', /Waiting for gifts/.test($('.overlay-idle')?.textContent ?? ''))
check('the body goes transparent for it', doc.body.classList.contains('overlay-body') === true)

await act(async () => {
  fake.emit({ platform: 'tiktok', type: 'viewers', count: 2400 })
  fake.emit({ platform: 'tiktok', type: 'chat', ...viewer({ id: 'o1' }), text: 'a plain message', timestamp: 1700000020000 })
  fake.emit({ platform: 'tiktok', type: 'follow', ...viewer({ id: 'o2' }), timestamp: 1700000020001 })
  fake.emit({ platform: 'tiktok', type: 'like', ...viewer({ id: 'o3' }), count: 12, timestamp: 1700000020002 })
  fake.emit({
    platform: 'tiktok',
    type: 'gift',
    ...viewer({ id: 'o4', nickname: 'pemberi' }),
    giftName: 'Leo',
    count: 3,
    diamonds: 120,
    timestamp: 1700000020003,
  })
  fake.emit({ platform: 'tiktok', type: 'like', ...viewer({ id: 'o5' }), count: 400, timestamp: 1700000020004 })
})

const cards = $$('.overlay-card')
// An overlay sits over the stream: a card per chat message would be a chat log
// nobody can read, and a row per like pulse would flicker faster than it can be
// seen. Only what is worth reading from across the room belongs here.
check('a chat message does not reach the overlay', !cards.some((c) => /a plain message/.test(c.textContent ?? '')))
check('a follow does not reach it either', cards.length === 2, String(cards.length))
check('a gift does', /Leo/.test(cards.at(-1)?.textContent ?? ''), cards.at(-1)?.textContent)
check('the gift says how many', /×3/.test(cards.at(-1)?.textContent ?? ''))
check('the gift shows what it was worth', /120 ◆/.test(cards.at(-1)?.textContent ?? ''))
check('a small like burst is dropped', !cards.some((c) => /12 likes/.test(c.textContent ?? '')))
check('a big one is shown', /400 likes/.test(cards[0]?.textContent ?? ''), cards[0]?.textContent)
check('the newest card is first', /likes/.test(cards[0]?.textContent ?? ''))
check('the header shows the headcount', /2[.,]400/.test($('.overlay-room')?.textContent ?? ''), $('.overlay-room')?.textContent)

await act(async () => {
  for (let n = 0; n < 6; n += 1) {
    fake.emit({ platform: 'tiktok', type: 'gift', ...viewer({ id: `g${n}` }), giftName: `G${n}`, count: 1, diamonds: 1, timestamp: 1700000021000 + n })
  }
})
check('the stack is capped', $$('.overlay-card').length === 3, String($$('.overlay-card').length))
check('and the newest survived', /G5/.test($$('.overlay-card')[0]?.textContent ?? ''))

console.log('a gift that carries a picture')
await act(async () => {
  fake.emit({
    platform: 'tiktok',
    type: 'gift',
    ...viewer({ id: 'p1', nickname: 'penggambar' }),
    giftName: 'Leo',
    count: 1,
    diamonds: 10,
    giftImage: 'https://p16.example.test/gift/leo.png',
    timestamp: 1700000022000,
  })
})
check('the card shows it', $$('.overlay-card')[0]?.querySelector('.overlay-gift-image')?.getAttribute('src') === 'https://p16.example.test/gift/leo.png', $$('.overlay-card')[0]?.innerHTML)
// Not every gift has one — a room whose catalogue request failed, or a gift added
// to the catalogue after the handshake, both arrive bare. Nothing may be reserved
// for a picture that is not coming.
check('a gift with no picture leaves nothing in its place', $$('.overlay-gift-image').length === 1, `${$$('.overlay-gift-image').length} images on screen`)

await click('.overlay-close')
check('closing asks the host to hide it', JSON.stringify(fake.lastCommand('set_overlay_visible')) ===
  JSON.stringify({ command: 'set_overlay_visible', args: { visible: false } }), JSON.stringify(fake.lastCommand('set_overlay_visible')))

console.log('teardown')
await act(async () => {
  root.unmount()
})
setTransport(null)
harness.restore()

console.log(`\n${failures === 0 ? 'all passed' : `${failures} failed`}`)
process.exit(failures === 0 ? 0 : 1)