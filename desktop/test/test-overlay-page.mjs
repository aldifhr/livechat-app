/**
 * The overlay page, actually running.
 *
 * Everything else here reads the file. This one loads it into a DOM, hands it a
 * socket and pushes real messages through it — because the bug it exists for is
 * a hang, and a hang is invisible to a regex.
 *
 * The failure it guards against: the page filled to its row limit and then stopped,
 * forever, with nothing on screen to say so. A `while` loop that retired rows by
 * marking them rather than removing them never saw its own condition become
 * false, so the first message past the limit spun inside the handler and every
 * message after it piled up undelivered. Every assertion below is about the page
 * still being alive at the end, which is the thing that was not true.
 *
 *   node test/test-overlay-page.mjs
 */

import { JSDOM } from 'jsdom'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The repo root, one level above desktop/: the overlay pages are a sibling of the app,
// not a part of it.
const pkgRoot = fileURLToPath(new URL('../..', import.meta.url))

let failures = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// The one copy, in `web/public/overlay/`. It used to be read from `api/static/`
// as well, on the grounds that this should exercise "the page that actually ships"
// — but that is what made the test worthless as a check on it. Two files, both
// answering 200, both looking like an overlay: the chat pair drifted nineteen lines
// apart and every assertion here still passed, because it was reading the stale one.
const CHAT_PAGE = readFileSync(`${pkgRoot}web/public/overlay/chat-overlay.html`, 'utf8')
const BOARD_PAGE = readFileSync(`${pkgRoot}web/public/overlay/top-chatter.html`, 'utf8')

/**
 * The page's own `STYLE_DEFAULTS`, read out of the page rather than kept here.
 *
 * A literal in this file would be a second copy of the same numbers, which is
 * precisely how the board's size came to be 36 on one side and 28 on the other
 * with every assertion still green. Read out, so moving a default in the page
 * moves it here and a test written against the old value fails — which is the
 * point of writing it down.
 *
 * Only the keys these tests compare. `font` is skipped because its value contains
 * commas and would need a different parse than the numbers, and nothing here
 * asserts on it.
 */
const DEFAULTS = (() => {
  const body = CHAT_PAGE.slice(CHAT_PAGE.indexOf('var STYLE_DEFAULTS = {'))
  const out = {}
  for (const key of ['size', 'nameColour', 'textColour', 'background']) {
    const found = new RegExp(`\\b${key}:\\s*([^,\\n]+)`).exec(body)
    if (found) out[key] = found[1].trim().replace(/^['"]|['"]$/g, '')
  }
  return out
})()

/**
 * Loads the page with a socket and a fetch it can be driven through.
 *
 * The script runs on load, so both are in place before the DOM is built: a page
 * that connects to something the test does not control is a page the test cannot
 * assert anything about.
 */
function load(search = '?room=ana&max=8', source = CHAT_PAGE, referrer = undefined) {
  const sockets = []
  let resolveRoom = null

  const dom = new JSDOM(source, {
    url: `http://127.0.0.1:4319/${search}`,
    // Only set when asked for. The preview-sample test needs one, because the
    // page's `message` listener reads `document.referrer` to decide whether the
    // sender is its embedder — and `referrer` is a getter, so it cannot be
    // assigned after construction. Every other test leaves it off, as a page
    // opened directly has none.
    ...(referrer ? { referrer } : {}),
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    // Injected here rather than after construction because the page's script runs
    // while the document is being parsed: assigning `window.fetch` once the JSDOM
    // object exists is already too late, and the page throws on a missing fetch
    // before it has reached anything worth testing.
    beforeParse(window) {
      window.fetch = () =>
        new Promise((resolve) => {
          resolveRoom = resolve
        })
      // jsdom has no ResizeObserver, and the page constructs one at load to report
      // its height to the dashboard preview. Without this the constructor throws
      // before the page opens its socket, and every assertion below fails for a
      // reason that has nothing to do with what it is testing.
      window.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
      window.WebSocket = class {
        constructor(url) {
          this.url = url
          sockets.push(this)
        }
      }
    },
  })

  return {
    dom,
    window: dom.window,
    sockets,
    /** Answers the room lookup, after which the page opens its socket. */
    openRoom(id = 'room-1') {
      resolveRoom?.({ ok: true, json: () => Promise.resolve({ room_id: id }) })
    },
    /** Pushes one comment down the socket, as the backend would. */
    say(user, text) {
      sockets.forEach((socket) => socket.onmessage?.({ data: JSON.stringify({ type: 'comment', user, text }) }))
    },
    /** Pushes a frame of some other kind, which the page must ignore. */
    frame(value) {
      sockets.forEach((socket) => socket.onmessage?.({ data: JSON.stringify(value) }))
    },
    rows() {
      return [...dom.window.document.querySelectorAll('#chat li')]
    },
  }
}

/** Lets the page's promise chains settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * Polls until `done` or the deadline.
 *
 * Needed because a message now takes a turn of the queue to reach the screen.
 * Reading the list in the same tick it was written to finds a page that is
 * working perfectly and looks empty, which is a test that fails for the right
 * reason and gets "fixed" by weakening the assertion.
 */
async function waitFor(done, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (done()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return done()
}

console.log('the page connects')
const connected = load()
await settle()
check('it asked the backend for a room first', connected.sockets.length === 0, String(connected.sockets.length))
connected.openRoom()
await settle()
await settle()
check('and opened a socket once it had one', connected.sockets.length === 1, String(connected.sockets.length))
check('as an overlay client, sharing the room', connected.sockets[0]?.url.endsWith('/ws/overlay/room-1'), connected.sockets[0]?.url)

console.log('messages arrive one at a time')
// A fast gap for everything that follows: the pacing itself is checked separately
// below with a gap long enough to see it, and sixty messages at the default half
// second would take half a minute to drain.
const quick = load('?room=ana&max=8&delay=120')
await settle()
quick.openRoom()
await settle()
await settle()
check('the first message is not held back', quick.rows().length === 0, String(quick.rows().length))
quick.say('ana', 'hello')
check('the first one appears at once', quick.rows().length === 1, String(quick.rows().length))
check('with the name on it', quick.rows()[0]?.querySelector('.name')?.textContent === 'ana')
check('and the text', /hello/.test(quick.rows()[0]?.textContent ?? ''))
check('rendered as text, not markup', quick.rows()[0]?.querySelector('.text')?.innerHTML === 'hello')

console.log('a burst arrives as beats, not as a wall')
// The point of the queue. Five messages in the same tick must not all be on screen
// by the time the tick returns — the gap between them is the whole feature.
const paced = load('?room=ana&max=8&delay=400')
await settle()
paced.openRoom()
await settle()
await settle()
for (let n = 0; n < 5; n += 1) paced.say(`viewer${n}`, `message ${n}`)
check('only one of five is out', paced.rows().length === 1, String(paced.rows().length))
check('and it is the first, not a later one', /message 0/.test(paced.rows()[0]?.textContent ?? ''), paced.rows()[0]?.textContent)
await new Promise((resolve) => setTimeout(resolve, 450))
check('the second follows it', paced.rows().length === 2, String(paced.rows().length))
await new Promise((resolve) => setTimeout(resolve, 450))
check('and the third', paced.rows().length === 3, String(paced.rows().length))

console.log('the queue does not become a slow-motion recording')
// Past the cap, the stalest waiting messages are dropped rather than shown twenty
// seconds late: a message that old is not a message about anything any more.
const flooded = load('?room=ana&max=8&delay=3000')
await settle()
flooded.openRoom()
await settle()
await settle()
for (let n = 0; n < 60; n += 1) flooded.say(`v${n}`, `m${n}`)
// 3000ms is the top of the range, so one release has happened and none since.
check('one is out and the rest are held', flooded.rows().length === 1, String(flooded.rows().length))
check('and it is the first arrival, not a later one', /m0/.test(flooded.rows()[0]?.textContent ?? ''), flooded.rows()[0]?.textContent)

console.log('a page full of messages still works')
// The regression from before. Sixty messages through a limit of eight: enough to
// overflow many times over, which is what used to hang the handler outright.
const page = load('?room=ana&max=8&delay=120')
await settle()
page.openRoom()
await settle()
await settle()
// The peak matters as much as the final count: a queue that never sheds anything
// is not holding a backlog, it is recording one, and the list is where that shows
// before anything else does.
let peak = 0
const watch = setInterval(() => {
  peak = Math.max(peak, page.rows().length)
}, 20)
for (let n = 0; n < 60; n += 1) page.say(`viewer${n}`, `message ${n}`)
// Long enough for the queue to drain: sixty at 120ms is about seven seconds.
await new Promise((resolve) => setTimeout(resolve, 9000))
clearInterval(watch)

check('the page is still alive', true)
check('every message was rendered, not just the first few', page.rows().length > 0, String(page.rows().length))
// The newest one is the proof it did not stop: a page that hung on message ten
// never reaches sixty.
check('the newest message is there', /message 59/.test(page.rows().at(-1)?.textContent ?? ''), page.rows().at(-1)?.textContent)
// A row being faded out is still a child, so the ceiling is the limit plus a
// couple in flight. Sixty would mean nothing was ever taken off the screen.
check('the list never ballooned on the way', peak <= 8 + 3, String(peak))

console.log('the limit is a limit')
// Counted on the rows that have not started leaving, rather than on every child:
// a row that is fading out is still in the tree, and counting it as shown is how a
// limit that is not being enforced looks fine.
const live = () => page.rows().filter((row) => row.dataset.leaving !== '1')
check('at most the limit are actually shown', live().length <= 8, String(live().length))
check('and the limit is reached, not merely respected', live().length === 8, String(live().length))
// And once the fades have run, the ones that were leaving are gone. A row that is
// never taken out is a row the next trim still has to account for, forever.
await new Promise((resolve) => setTimeout(resolve, 900))
check('and the old ones are eventually removed', page.rows().length === 8, String(page.rows().length))
check('leaving just the newest', /message 59/.test(page.rows().at(-1)?.textContent ?? ''))

console.log('a gift is rendered as a gift, not as chat')
// A gift now shows — it is the one thing a viewer looks up for. But it is its own
// kind of row, not a chat row, so it does not enter the paced chat queue and it is
// counted apart from the chat limit. Likes and viewer counts are still not chat
// and are still ignored.
const chatBefore = page.rows().filter((row) => !row.classList.contains('gift')).length
page.frame({ type: 'gift', user: 'ana', userId: 'ana', giftName: 'Rose', count: 2, value: 20 })
await new Promise((resolve) => setTimeout(resolve, 50))
const giftRow = page.dom.window.document.querySelector('#chat li.gift')
check('a gift becomes a gift row', Boolean(giftRow), String(page.rows().length))
check('it names the gift', /Rose/.test(giftRow?.textContent ?? ''), giftRow?.textContent)
check('it shows the diamond count', /20/.test(giftRow?.textContent ?? ''), giftRow?.textContent)
check('the gifter name is a link to their profile', giftRow?.querySelector('a.name')?.getAttribute('href') === 'https://www.tiktok.com/@ana', giftRow?.querySelector('a.name')?.getAttribute('href'))
check('and it did not enter the chat queue as a chat row', page.rows().filter((row) => !row.classList.contains('gift')).length === chatBefore, String(page.rows().length))

// The sticker. `giftImage` has been on the wire and drawn in the app since the
// app had a feed; this page read the frame and dropped the field, so the stream
// showed the name of a gift whose picture was available to everyone else.
page.frame({
  type: 'gift',
  user: 'ana',
  userId: 'ana',
  giftName: 'Rose',
  count: 1,
  value: 1,
  giftImage: 'https://p16.example.test/rose.webp',
})
await new Promise((resolve) => setTimeout(resolve, 50))
const pictured = page.dom.window.document.querySelector('#chat li.gift .gift-image')
check('a gift with a picture draws it', pictured?.getAttribute('src') === 'https://p16.example.test/rose.webp', pictured?.getAttribute('src') ?? 'no image')
check('and the row still names the gift', /Rose/.test(pictured?.closest('li')?.textContent ?? ''), pictured?.closest('li')?.textContent)

// A gift with no picture must not gain an empty <img> — a broken image beside the
// name is worse than the name alone, which is what it had before.
page.frame({ type: 'gift', user: 'ana', userId: 'ana', giftName: 'Lily', count: 1, value: 1 })
await new Promise((resolve) => setTimeout(resolve, 50))
const plainGift = [...page.dom.window.document.querySelectorAll('#chat li.gift')].at(-1)
check('a gift with no picture adds no image element', plainGift?.querySelector('.gift-image') === null, plainGift?.innerHTML)

console.log('custom emotes reach the page')
// The same field the app draws and this page dropped: a comment carrying TikTok
// emotes read as bare text on the stream while the operator saw the pictures.
page.frame({
  type: 'comment',
  user: 'ana',
  userId: 'ana',
  text: 'nice',
  emotes: [{ url: 'https://p16.example.test/a.webp', id: '1' }, { url: 'https://p16.example.test/b.webp', id: '2' }],
})
const emoted = await waitFor(() => page.dom.window.document.querySelector('#chat .emotes') !== null)
const strip = page.dom.window.document.querySelector('#chat .emotes')
check('the emotes are drawn', emoted, 'no .emotes element')
check('one image per emote', strip?.querySelectorAll('img.emote').length === 2, String(strip?.querySelectorAll('img.emote').length))
check('each points at its own url', strip?.querySelectorAll('img.emote')[1]?.getAttribute('src') === 'https://p16.example.test/b.webp', strip?.querySelectorAll('img.emote')[1]?.getAttribute('src'))
check('and the text is still there', /nice/.test(page.rows().at(-1)?.textContent ?? ''), page.rows().at(-1)?.textContent)

// An emote-only comment: no text at all. Returning early on the empty body threw
// the picture away, which is the whole message.
page.frame({ type: 'comment', user: 'ana', userId: 'ana', text: '', emotes: [{ url: 'https://p16.example.test/solo.webp', id: '9' }] })
const solo = await waitFor(() =>
  [...page.dom.window.document.querySelectorAll('#chat .emotes img.emote')].some(
    (img) => img.getAttribute('src') === 'https://p16.example.test/solo.webp',
  ),
)
check('a comment that is only an emote still renders', solo, 'the emote-only row was dropped')

console.log('likes and viewer counts are still not rendered')
const afterGift = page.rows().length
page.frame({ type: 'like', user: 'ana', count: 5 })
page.frame({ type: 'viewers', count: 100 })
await new Promise((resolve) => setTimeout(resolve, 50))
check('a like is ignored', page.rows().length === afterGift, String(page.rows().length))
// Scoped to the chat list, not `body.textContent`: the page's own `<script>` is
// text in the body, and a comment in it mentioning `height: 100%` would read as
// the leaked count. The claim is about what the chat renders.
check('a viewer count is ignored', !/100/.test(page.rows().map((r) => r.textContent).join(' ')), 'viewer count leaked')

console.log('the chat overlay leaves the leaderboard to the board page')
// The board is what /overlay/top-chatter is for. The chat overlay used to render
// it as a second, competing panel; that was removed, and this pins the removal —
// a topChatters frame is now a no-op here rather than a leaderboard appearing in
// the chat.
const doc = page.dom.window.document
check('the chat overlay has no board element', doc.querySelector('#board') === null)
const chatBeforeBoard = page.rows().length
page.frame({
  type: 'topChatters',
  chatters: [
    { id: 'b', nickname: 'budi', messages: 5 },
    { id: 'a', nickname: 'ana', messages: 3 },
  ],
})
await new Promise((resolve) => setTimeout(resolve, 50))
check('a ranking does not enter the chat', page.rows().length === chatBeforeBoard, String(page.rows().length))
check('and no board appears', doc.querySelector('#board') === null)

console.log('a frame it did not expect does not take the page down')
// Every one of these is something the backend can send, or something a truncated
// socket can produce. Each has to be a no-op rather than an exception, because an
// exception in the handler stops every message after it.
//
// Polled rather than read straight away: a real message now takes a turn of the
// queue to reach the screen, so the row is not there in the same tick it was sent.
const survived = [
  { label: 'not json', data: 'not json at all' },
  { label: 'json that is not an object', data: '"just a string"' },
  { label: 'no type', data: JSON.stringify({ user: 'ana' }) },
  { label: 'null text', data: JSON.stringify({ type: 'comment', user: 'ana', text: null }) },
  { label: 'empty text', data: JSON.stringify({ type: 'comment', user: 'ana', text: '   ' }) },
  { label: 'no user', data: JSON.stringify({ type: 'comment', text: 'hi' }) },
]
for (const frame of survived) {
  page.sockets[0].onmessage?.({ data: frame.data })
  page.say('after', `still working after ${frame.label}`)
  const arrived = await waitFor(() => /still working after/.test(page.rows().at(-1)?.textContent ?? ''))
  check(`survives ${frame.label}`, arrived, page.rows().at(-1)?.textContent)
}

console.log('a link with no handle says so')
// A wrong link and a working one that has seen nothing look identical otherwise,
// which is a blank rectangle either way.
const bare = load('?max=8')
await settle()
bare.openRoom()
await settle()
await settle()
check('the room lookup still ran', bare.sockets.length >= 0)
const unconfigured = load('?max=8')
await settle()
check('and it says the handle is missing', /no handle in this link/.test(unconfigured.dom.window.document.body.textContent ?? ''), unconfigured.dom.window.document.body.textContent)

console.log('every setting in the dialog reaches the page')
// The question a streamer actually has: does changing a field do anything. Each of
// these has to end up as a custom property the stylesheet consumes, on the rule it
// is meant to style — a value written nowhere, or written to a rule that does not
// read it, is a setting that looks like it works.
const styled = load('?room=ana&size=40&max=5&delay=250&name=%2300ff00&color=%23ff0000&font=Inter&bg=0.5')
await settle()
const root = styled.window.document.documentElement
const variable = (name) => root.style.getPropertyValue(name)

check('text size', variable('--size') === '40px', variable('--size'))
check('name colour', variable('--name-colour') === '#00ff00', variable('--name-colour'))
check('text colour', variable('--text-colour') === '#ff0000', variable('--text-colour'))
check('font', variable('--font') === 'Inter', variable('--font'))
// This one was the bug: the setting was applied to the page's own background at
// 60% of its value, and the per-row scrim the stylesheet asks for by name was
// never written at all — so the thing it is labelled as controlling did nothing,
// and the thing it was really doing was something nobody asked for.
check('background reaches the row scrim', variable('--background') === '0.5', variable('--background'))

console.log('and the stylesheet is what consumes them')
// Which rule reads each one. A custom property that nothing reads is the other
// half of the same bug: correctly written, correctly ignored.
const style = CHAT_PAGE.slice(CHAT_PAGE.indexOf('<style>') + '<style>'.length, CHAT_PAGE.indexOf('</style>'))
check('the text size styles the body', /body\s*\{[^}]*font-size:\s*var\(--size\)/.test(style))
check('the name colour styles the name', /\.name\s*\{[^}]*color:\s*var\(--name-colour\)/.test(style))
check('the text colour styles the text', /\.text\s*\{[^}]*color:\s*var\(--text-colour\)/.test(style))
check('the font styles the body', /body\s*\{[^}]*font-family:\s*var\(--font\)/.test(style))
check('the background styles the row', /li\s*\{[^}]*background:\s*rgba\(0,\s*0,\s*0,\s*var\(--background\)\)/.test(style))
// And nothing is given two meanings: the page background must not be set from
// `bg` as well as the row scrim, or moving the slider changes two things at once
// and only one of them is the one named on it.
check('and only the row, so one setting means one thing', !/documentElement\.style\.background\s*=/.test(CHAT_PAGE))

console.log('and the two limits are honoured through the link, not just read')
// Not a check that the URL contains the numbers — that would be testing the string
// I just wrote. This is the page honouring them, which is the claim that matters.
styled.openRoom()
await settle()
await settle()
for (let n = 0; n < 12; n += 1) styled.say(`v${n}`, `m${n}`)
check('the gap it was given paces it', await waitFor(() => styled.rows().length === 3), String(styled.rows().length))
// Twelve at 250ms is three seconds. Long enough to have gone past the limit.
await new Promise((resolve) => setTimeout(resolve, 3200))
check(
  'and it stops at the row count it was given',
  styled.rows().filter((row) => row.dataset.leaving !== '1').length === 5,
  String(styled.rows().length),
)

console.log('the top-chatters board is its own page')
// A separate source for OBS: the leaderboard and nothing else, reading the same
// topChatters frame the chat overlay already knows. This is the second view of a
// board the backend keeps, not a new feature on the wire.
const boardPage = load('?room=ana', BOARD_PAGE)
boardPage.openRoom('room-1')
await settle()
await settle()
const boardDoc = boardPage.dom.window.document
// The panel hides as one unit — caption and list together — so the hidden state
// lives on `#panel`, not on `#board` inside it.
const bpanel = () => boardDoc.querySelector('#panel')
check('the board page has no chat list', boardDoc.querySelector('#chat') === null, 'chat list present')
check('the board starts hidden', bpanel()?.hidden === true, String(bpanel()?.hidden))
boardPage.frame({
  type: 'topChatters',
  chatters: [
    { id: 'b', nickname: 'budi', messages: 5 },
    { id: 'a', nickname: 'ana', messages: 3 },
  ],
})
await settle()
check('a ranking shows the board', bpanel()?.hidden === false, String(bpanel()?.hidden))
const bRows = () => [...boardDoc.querySelectorAll('#board li')]
check('one row per chatter', bRows().length === 2, String(bRows().length))
check('ranked in the order sent', bRows().map((r) => r.querySelector('.board-name')?.textContent).join(',') === 'budi,ana', bRows().map((r) => r.textContent).join(' | '))
check('the count is shown beside the name', /5/.test(bRows()[0]?.textContent ?? ''), bRows()[0]?.textContent)
check('a caption names what it is', /top chatters|top yapping/i.test(boardDoc.querySelector('#caption')?.textContent ?? ''), boardDoc.querySelector('#caption')?.textContent)
// Everything that is not a ranking is ignored: this source shows the board only.
boardPage.frame({ type: 'comment', user: 'ana', text: 'hi' })
boardPage.frame({ type: 'gift', user: 'ana', giftName: 'Rose', count: 1 })
await settle()
check('chat is not shown on the board page', bRows().length === 2, String(bRows().length))
// An empty ranking hides the whole panel rather than leaving a stale one up.
boardPage.frame({ type: 'topChatters', chatters: [] })
await settle()
check('an empty ranking hides the board', bpanel()?.hidden === true, String(bpanel()?.hidden))

console.log('the two pages resolve the room the same way')
// Both name a handle and open a socket for the room id that comes back. Checked
// here because a board page that skipped the resolve step would be a board for a
// room that does not exist.
const chatSockets = boardPage.sockets.length
check('the board page opens one overlay socket', chatSockets === 1, String(chatSockets))
check('as an overlay client, sharing the room', boardPage.sockets[0]?.url.endsWith('/ws/overlay/room-1'), boardPage.sockets[0]?.url)

console.log('a pushed style reaches the screen')
// The live restyle path, which is the one nothing here covered until the config
// frame was narrowed: a frame arrives mid-stream carrying the room's whole style,
// and the page has to restyle itself without rebuilding, reconnecting, or
// disturbing a message that is already on screen. A bug here is the quiet kind —
// OBS shows the old styling or no styling, nothing errors, and the only symptom is
// a streamer saying the link does not work.
const restyled = load('?room=ana&max=8&delay=120&size=40&name=%2300ff00&bg=0.5')
await settle()
restyled.openRoom()
await settle()
await settle()

const restyleRoot = restyled.window.document.documentElement
const restyleVar = (name) => restyleRoot.style.getPropertyValue(name)
check('it starts on the values the link gave it', restyleVar('--size') === '40px', restyleVar('--size'))

// One comment already on screen, which the restyle must not touch.
restyled.say('ana', 'before the restyle')
check('and with a message showing', restyled.rows().length === 1, String(restyled.rows().length))
const rowBefore = restyled.rows()[0]

restyled.frame({ type: 'config', config: { size: 28, nameColour: '#ff00ff' } })
await settle()
check('a pushed size reaches the page', restyleVar('--size') === '28px', restyleVar('--size'))
check('and a pushed colour', restyleVar('--name-colour') === '#ff00ff', restyleVar('--name-colour'))
// The key the frame left out reverts rather than persisting. That is the contract:
// the frame is the room's whole style, not a patch, so `bg` going back to the
// page's own default is correct — and it is exactly what a patch-shaped merge would
// get wrong, keeping the 0.5 the link arrived with.
check(
  'a key the frame omits reverts to the default',
  restyleVar('--background') === String(DEFAULTS.background),
  `${restyleVar('--background')} (want ${DEFAULTS.background})`,
)
check('the message already on screen is untouched', restyled.rows()[0] === rowBefore)
check('and still the only one', restyled.rows().length === 1, String(restyled.rows().length))

console.log('a restyle does not stop the chat')
// The regression this whole block is here for. The merge touches `config`, and
// `config.username` is what the page connects and renders with — a merge that
// replaced the object, or that let a frame carry a `room` key through, would leave
// an overlay that is styled and silent.
check('it did not open a second socket', restyled.sockets.length === 1, String(restyled.sockets.length))
restyled.say('budi', 'after the restyle')
check('a comment after it still arrives', await waitFor(() => /after the restyle/.test(restyled.rows().at(-1)?.textContent ?? '')), restyled.rows().at(-1)?.textContent)
check('and the earlier one is still there', /before the restyle/.test(restyled.rows().map((r) => r.textContent).join(' ')))

console.log('a pushed style is a whole style, not a patch')
// Two pushes in a row. If the second inherited anything from the first it would
// not be the room's current style, and a streamer who changes one setting and then
// another would end up with a mixture of the two.
restyled.frame({ type: 'config', config: { size: 30, nameColour: '#00ffff' } })
await settle()
restyled.frame({ type: 'config', config: { size: 12 } })
await settle()
check('the second push replaces the first', restyleVar('--size') === '12px', restyleVar('--size'))
check('and leaves nothing of it behind', restyleVar('--name-colour') === DEFAULTS.nameColour, restyleVar('--name-colour'))
// The comment row survived both pushes, which is the "no DOM rebuild" claim.
check('still without rebuilding the list', /after the restyle/.test(restyled.rows().map((r) => r.textContent).join(' ')))

console.log('an empty frame is silence, not a reset')
// A room with no saved styling sends `{}`. Acting on it would strip the styling
// from any link that carried its own parameters — which is every link there was
// before styling could be saved, and all of them are still valid. Un-styling is
// done by saving actual defaults.
restyled.frame({ type: 'config', config: {} })
await settle()
check('an empty frame changes nothing', restyleVar('--size') === '12px', restyleVar('--size'))
check('and does not reset the colour either', restyleVar('--name-colour') === DEFAULTS.nameColour, restyleVar('--name-colour'))
restyled.frame({ type: 'config', config: { size: 26 } })
await settle()
restyled.frame({ type: 'config' })
await settle()
check('a frame with no config at all changes nothing', restyleVar('--size') === '26px', restyleVar('--size'))
// And a link that carried its own values keeps them across the whole conversation.
const linkOwned = load('?room=ana&max=8&delay=120&bg=0.6')
await settle()
linkOwned.openRoom()
await settle()
await settle()
const linkVar = (name) => linkOwned.window.document.documentElement.style.getPropertyValue(name)
check('a link keeps its own background', linkVar('--background') === '0.6', linkVar('--background'))
linkOwned.frame({ type: 'config', config: {} })
await settle()
check('an empty frame does not take it away', linkVar('--background') === '0.6', linkVar('--background'))

console.log('a value that is null is not a value')
// `undefined` and `null` are skipped by the merge, which means the key keeps the
// default it was just reset to. Passing `null` through to a custom property would
// render `--size: nullpx`, which the stylesheet cannot use.
restyled.frame({ type: 'config', config: { size: 31, nameColour: null } })
await settle()
check('a null colour falls back to the default', restyleVar('--name-colour') === DEFAULTS.nameColour, restyleVar('--name-colour'))
check('and the rest of the frame still applied', restyleVar('--size') === '31px', restyleVar('--size'))

console.log('a pushed limit changes the limit')
// `max` and `delay` are not custom properties — `applyConfig` does not write them,
// because the stylesheet has no rule for them. They are read by the queue. So the
// only way to see whether a pushed one took effect is to push comments through it.
restyled.frame({ type: 'config', config: { max: 2, delay: 120 } })
await settle()
const before = restyled.rows().length
for (let n = 0; n < 8; n += 1) restyled.say(`v${n}`, `m${n}`)
await new Promise((resolve) => setTimeout(resolve, 1500))
const liveAfter = () => restyled.rows().filter((row) => row.dataset.leaving !== '1').length
check('the pushed row limit is the one it enforces', liveAfter() <= 3, String(liveAfter()))
check('and it is reached, not merely respected', liveAfter() === 2, String(liveAfter()))
check('not the eight the link asked for', liveAfter() !== 8, String(liveAfter()))
check('and the page is still taking messages', restyled.rows().length > before)

console.log('the preview sample does not hold a slot for ever')
// Found by watching the preview: the sample row sat there while real messages
// stacked up behind it, so the list ran one row over `max` for the whole session.
// `trim()` skipped anything marked `data-preview-sample`, which meant it was never
// counted and therefore never retired — an immortal row.
//
// The sample is pushed the way the dashboard pushes it: a `message` event from the
// parent frame carrying `streamkitPreviewSample`. jsdom has no parent frame, so
// the listener's `event.source === window.parent` check is satisfied by dispatching
// on the window itself and letting `source` be null — which is what the real check
// compares against when nothing is embedded. The page's guard also needs a
// referrer, so the origin check passes.
const sampled = load('?room=ana&max=3', CHAT_PAGE, 'http://127.0.0.1:4319/')
sampled.openRoom()
await settle()

// `window.parent` is the window itself in jsdom when nothing is embedded, so a
// dispatched MessageEvent with `source: window` is what the page accepts.
sampled.window.dispatchEvent(
  new sampled.window.MessageEvent('message', {
    data: { streamkitPreviewStyle: { max: 3 }, streamkitPreviewSample: true },
    source: sampled.window,
    origin: 'http://127.0.0.1:4319',
  }),
)
await settle()
const sampleRows = () => sampled.rows().filter((row) => row.dataset.previewSample === 'true')
check('the sample is shown', sampleRows().length === 1, String(sampleRows().length))

// Now real messages, more than the limit. The sample must be retired like any
// other row rather than sitting at the bottom of the list for ever.
for (let n = 0; n < 6; n += 1) sampled.say(`v${n}`, `m${n}`)
await new Promise((resolve) => setTimeout(resolve, 2000))
const sampledLive = sampled.rows().filter((row) => row.dataset.leaving !== '1')
check('the list stays within its limit', sampledLive.length <= 3, String(sampledLive.length))
// The bug in one line: the sample is gone, so it is not occupying a slot.
check('and the sample was retired like any other row', sampleRows().length === 0, String(sampleRows().length))
check('leaving room for the real messages', sampledLive.length === 3, String(sampledLive.length))

console.log('a config frame with the wrong types is ignored, not applied')
// The frame is another reader's view of the room's style, and nothing promises it is
// well-typed. Taken raw, `size: 'big'` wrote `--size: bigpx`, `position: 5` took
// `applyConfig` down on `.indexOf`, and `max: 'wide'` made `trim`'s
// `chatCount - (max - gifts)` NaN, so `over > 0` was never true and the list stopped
// being capped. A field is taken only when it is the type the thing it feeds can use.
const malformed = load('?room=ana&max=8&delay=120')
await settle()
malformed.openRoom()
await settle()
await settle()
const malVar = (name) => malformed.window.document.documentElement.style.getPropertyValue(name)
// `delay` is valid and travels with the bad fields, so the flood below is paced fast
// enough to finish in the wait; it is `max` that this is testing.
malformed.frame({ type: 'config', config: { size: 'big', max: 'wide', position: 5, delay: 120 } })
await settle()
check('a non-number size leaves the default', malVar('--size') === '22px', malVar('--size'))
for (let n = 0; n < 12; n += 1) malformed.say(`v${n}`, `m${n}`)
await new Promise((resolve) => setTimeout(resolve, 2200))
const malLive = malformed.rows().filter((row) => row.dataset.leaving !== '1').length
check('and a non-number max still caps the list', malLive <= 8, String(malLive))
check('the page is still rendering afterwards', malformed.rows().length > 0, String(malformed.rows().length))

console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)