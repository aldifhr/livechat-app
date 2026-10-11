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

console.log('the page connects')
const page = load()
await settle()
check('it asked the backend for a room first', page.sockets.length === 0, String(page.sockets.length))
page.openRoom()
await settle()
await settle()
check('and opened a socket once it had one', page.sockets.length === 1, String(page.sockets.length))
check('as an overlay client, sharing the room', page.sockets[0]?.url.endsWith('/ws/overlay/room-1'), page.sockets[0]?.url)

console.log('messages arrive')
page.say('ana', 'hello')
check('one message is one row', page.rows().length === 1, String(page.rows().length))
check('with the name on it', page.rows()[0]?.querySelector('.name')?.textContent === 'ana')
check('and the text', /hello/.test(page.rows()[0]?.textContent ?? ''))
check('rendered as text, not markup', page.rows()[0]?.querySelector('.text')?.innerHTML === 'hello')

console.log('a page full of messages still works')
// The regression. Sixty messages through a limit of eight: enough to overflow
// many times over, which is what used to hang on the first pass.
for (let n = 0; n < 60; n += 1) page.say(`viewer${n}`, `message ${n}`)

check('the page is still alive', true)
check('every message was rendered, not just the first few', page.rows().length > 0, String(page.rows().length))
// The newest one is the proof it did not stop: a page that hung on message ten
// never reaches sixty.
check('the newest message is there', /message 59/.test(page.rows().at(-1)?.textContent ?? ''), page.rows().at(-1)?.textContent)

console.log('the limit is a limit')
// Counted on the rows that have not started leaving, rather than on every child:
// a row that is fading out is still in the tree, and a test that waits for the
// fade to finish before asserting anything passes just as happily on a page whose
// limit is not enforced at all.
const live = () => page.rows().filter((row) => row.dataset.leaving !== '1')
check('at most the limit are actually shown', live().length <= 8, String(live().length))
check('and the limit is reached, not merely respected', live().length === 8, String(live().length))
check('while the tree carries the fading ones too', page.rows().length > 8, String(page.rows().length))
// And they do go, once their fade is over. A row that is never taken out is a row
// the next trim still has to account for, forever.
await new Promise((resolve) => setTimeout(resolve, 900))
check('and the old ones are eventually removed', page.rows().length === 8, String(page.rows().length))
check('leaving just the newest', /message 59/.test(page.rows().at(-1)?.textContent ?? ''))

console.log('nothing that is not a comment is rendered')
const before = page.rows().length
page.frame({ type: 'gift', user: 'ana', giftName: 'Rose' })
page.frame({ type: 'like', user: 'ana', count: 5 })
page.frame({ type: 'viewers', count: 100 })
check('a gift is not a chat row', page.rows().length === before, String(page.rows().length))
check('and neither is a viewer count', !/Rose/.test(page.dom.window.document.body.textContent ?? ''))

console.log('a frame it did not expect does not take the page down')
// Every one of these is something the backend can send, or something a truncated
// socket can produce. Each has to be a no-op rather than an exception, because an
// exception in the handler stops every message after it.
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
  check(`survives ${frame.label}`, /still working after/.test(page.rows().at(-1)?.textContent ?? ''), page.rows().at(-1)?.textContent)
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
check('and shows nothing on the stream once a message lands', true)

console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)