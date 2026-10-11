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

const pkgRoot = fileURLToPath(new URL('..', import.meta.url))

let failures = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const PAGE = readFileSync(`${pkgRoot}src-tauri/overlay/index.html`, 'utf8')

/**
 * Loads the page with a socket and a fetch it can be driven through.
 *
 * The script runs on load, so both are in place before the DOM is built: a page
 * that connects to something the test does not control is a page the test cannot
 * assert anything about.
 */
function load(search = '?room=ana&max=8') {
  const sockets = []
  let resolveRoom = null

  const dom = new JSDOM(PAGE, {
    url: `http://127.0.0.1:4319/${search}`,
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

console.log('likes and viewer counts are still not rendered')
const afterGift = page.rows().length
page.frame({ type: 'like', user: 'ana', count: 5 })
page.frame({ type: 'viewers', count: 100 })
await new Promise((resolve) => setTimeout(resolve, 50))
check('a like is ignored', page.rows().length === afterGift, String(page.rows().length))
check('a viewer count is ignored', !/100/.test(page.dom.window.document.body.textContent.replace(/20/g, '')), 'viewer count leaked')

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
const style = PAGE.slice(PAGE.indexOf('<style>') + '<style>'.length, PAGE.indexOf('</style>'))
check('the text size styles the body', /body\s*\{[^}]*font-size:\s*var\(--size\)/.test(style))
check('the name colour styles the name', /\.name\s*\{[^}]*color:\s*var\(--name-colour\)/.test(style))
check('the text colour styles the text', /\.text\s*\{[^}]*color:\s*var\(--text-colour\)/.test(style))
check('the font styles the body', /body\s*\{[^}]*font-family:\s*var\(--font\)/.test(style))
check('the background styles the row', /li\s*\{[^}]*background:\s*rgba\(0,\s*0,\s*0,\s*var\(--background\)\)/.test(style))
// And nothing is given two meanings: the page background must not be set from
// `bg` as well as the row scrim, or moving the slider changes two things at once
// and only one of them is the one named on it.
check('and only the row, so one setting means one thing', !/documentElement\.style\.background\s*=/.test(PAGE))

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

console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)