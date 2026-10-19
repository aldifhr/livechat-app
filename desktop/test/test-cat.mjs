/**
 * The cat overlay, actually stepped.
 *
 * Everything else here reads the page as text. This one loads the sprite code into a DOM,
 * hands it a canvas that swallows every call, and drives each pose through a full mode.
 * A typo in a new mode's channel — a `P.hop` that is never initialised, a `setMode` name
 * with no entry in `M` — is invisible to a regex and fatal at runtime; the only thing that
 * catches it is running the frame.
 *
 * There is no `canvas` package here, so the context is a stub with no pixels behind it.
 * That is the point: these assertions are about the page surviving the frame, not about
 * what the frame looks like. `test:overlay` reads the pixels the headless browser draws.
 *
 *   node test/test-cat.mjs
 */

import { JSDOM } from 'jsdom'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const pkgRoot = fileURLToPath(new URL('../..', import.meta.url))
const CAT_PAGE = readFileSync(`${pkgRoot}web/public/overlay/cat-overlay.html`, 'utf8')

let failures = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** A 2D context with the shape the page draws through, and no pixels behind it. */
function fakeCtx() {
  const blank = () => ({ data: new Uint8ClampedArray(96 * 96 * 4) })
  return {
    fillStyle: '',
    imageSmoothingEnabled: false,
    fillRect() {}, clearRect() {}, save() {}, restore() {},
    translate() {}, scale() {}, setTransform() {}, drawImage() {}, putImageData() {},
    getImageData: blank,
    createImageData: blank,
  }
}

const dom = new JSDOM(CAT_PAGE, {
  url: 'http://127.0.0.1:4319/overlay/cat-overlay.html?room=ana',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  beforeParse(window) {
    window.HTMLCanvasElement.prototype.getContext = () => fakeCtx()
    window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
    // The loop advances only when this file says so.
    window.requestAnimationFrame = () => 0
    // jsdom has no WebSocket. The page only opens one because the URL names a room,
    // and the status assertions below drive it through this stub.
    window.WebSocket = class {
      constructor(url) {
        this.url = url
        window.sockets.push(this)
      }
      close() {}
    }
    window.sockets = []
  },
})

const { window } = dom

// The page builds its toolbar and opens on `sit` at parse time; this is the state every
// assertion below builds on.
check(
  'the page loads and leaves setMode/upd/render on the scope',
  typeof window.setMode === 'function' && typeof window.upd === 'function' && typeof window.render === 'function',
)

// The modes that carry a pose channel of their own, then every mode that does not — a new
// channel that breaks the shared pose blend shows up on the old modes too, not just its own.
const MODES = [
  'scratch', 'blep', 'sneeze',
  'walk', 'flop', 'jump', 'sit', 'sleep', 'vibe', 'stare', 'yawn', 'wash',
]

for (const mode of MODES) {
  let threw = ''
  try {
    window.setMode(mode)
    // Ten seconds at 60Hz: long enough that the longest mode ends and hands off, so the
    // transition out of a pose is exercised as well as the pose itself.
    for (let i = 0; i < 600; i += 1) {
      window.upd(1 / 60)
      window.render()
    }
  } catch (e) {
    threw = String((e && e.message) || e)
  }
  check(`${mode} runs a full mode without throwing`, threw === '', threw)
}

/**
 * Pushes one frame down the page's socket, the way the backend would.
 *
 * The status assertions need this: `offline` is module-scope state the page only
 * changes from a frame, and reading it from outside is the only way to tell a
 * sleeping cat that is asleep for the right reason from one that merely happens to
 * be in `sleep`.
 */
function frame(value) {
  const socket = window.sockets[0]
  if (!socket) throw new Error('the page did not open a socket')
  socket.onmessage({ data: JSON.stringify(value) })
}

const mode = () => window.eval('C.mode')
const isOffline = () => window.eval('offline')

console.log('the cat sleeps while the streamer is offline')
// The backend sends a status frame on attach and on every edge, so a page opened
// after a stream ended has to sleep immediately rather than wait out the idle timer.
// Before this the cat wandered around a dead room for three minutes, and a `waiting`
// status (the streamer not live, the backend polling for them) meant that for hours.
for (const [label, status] of [
  ['plain offline', { type: 'status', connected: false, message: 'Offline' }],
  ['live ended', { type: 'status', connected: false, message: 'no longer live', liveEnded: true }],
  ['waiting for a streamer who is not live', { type: 'status', connected: false, connecting: true, waiting: true, message: 'not live — waiting' }],
]) {
  frame({ type: 'status', connected: true, message: 'Connected' })
  frame({ type: 'comment', user: 'ana', text: 'hi' })
  frame(status)
  check(`${label} puts the cat to sleep at once`, mode() === 'sleep', mode())
  check(`${label} is remembered as offline`, isOffline() === true)
}

// A handshake in flight is a second, not an outage. Sleeping on it would put the cat
// down on every reconnect.
frame({ type: 'status', connected: true, message: 'Connected' })
frame({ type: 'status', connected: false, connecting: true, message: 'Connecting to @ana' })
check('a handshake in flight is not offline', isOffline() === false && mode() !== 'sleep', mode())

console.log('a sleeping cat stays asleep while offline')
// The offline sleep is a state, not a mood: the idle timer and the auto-mode timer
// must not stand the cat back up, and neither must an event that arrives anyway.
frame({ type: 'status', connected: false, message: 'Offline' })
frame({ type: 'gift', user: 'ana', giftName: 'Rose', count: 1, value: 5 })
for (let i = 0; i < 600; i += 1) window.upd(1 / 60)
check('a gift does not wake an offline cat', mode() === 'sleep' && isOffline() === true, mode())
window.eval('boop()')
check('a boop does not wake an offline cat', mode() === 'sleep', mode())

console.log('the cat wakes when the stream comes back')
frame({ type: 'status', connected: true, message: 'Connected to @ana' })
check('a live status wakes the cat', mode() !== 'sleep' && isOffline() === false, mode())
frame({ type: 'comment', user: 'ana', text: 'back' })
for (let i = 0; i < 60; i += 1) window.upd(1 / 60)
check('and events react again', mode() !== 'sleep', mode())

console.log('a gift, a like and a follow are not the same thing')
// They used to share one reaction, so a single like threw the same jump as a gift and
// a busy room left the cat permanently in the air. The wire carries `value` on a gift
// and nothing comparable on a like, so the tiers can only be about gifts.
const particles = (type) => window.eval(`pts.filter(p => p.t === '${type}').length`)
const clearParticles = () => window.eval('pts.length = 0')
const jumpBoost = () => window.eval('C.jumpBoost')

frame({ type: 'status', connected: true, message: 'Connected' })
window.eval("setMode('sit')")
clearParticles()
frame({ type: 'like', user: 'ana', count: 5 })
check('a like does not launch the cat', mode() === 'sit', mode())
check('a like still throws a few hearts', particles('heart') > 0 && particles('heart') <= 4, String(particles('heart')))
check('a like adds no stars', particles('star') === 0)

clearParticles()
frame({ type: 'follow', user: 'ana' })
check('a follow settles into vibe', mode() === 'vibe', mode())
check('a follow throws hearts', particles('heart') > 0)
check('a follow adds no stars', particles('star') === 0)

for (const [label, value, minHearts] of [
  ['a small gift', 5, 6],
  ['a mid gift', 100, 10],
  ['a large gift', 1000, 16],
]) {
  window.eval("setMode('sit')")
  clearParticles()
  frame({ type: 'gift', user: 'ana', giftName: 'Rose', count: 1, value })
  check(`${label} jumps`, mode() === 'jump', mode())
  check(`${label} throws at least ${minHearts} hearts`, particles('heart') >= minHearts, String(particles('heart')))
}

// The tiers are only cosmetic if the jump is the same height for all of them.
window.eval("setMode('sit')")
frame({ type: 'gift', user: 'ana', giftName: 'Rose', count: 1, value: 5 })
const smallBoost = jumpBoost()
window.eval("setMode('sit')")
frame({ type: 'gift', user: 'ana', giftName: 'Lion', count: 1, value: 1000 })
const largeBoost = jumpBoost()
check('a large gift jumps higher than a small one', largeBoost > smallBoost, `${smallBoost} vs ${largeBoost}`)

window.eval("setMode('sit')")
clearParticles()
frame({ type: 'gift', user: 'ana', giftName: 'Lion', count: 1, value: 1000 })
check('a large gift adds stars', particles('star') > 0, String(particles('star')))

// A gift with no `value` at all is the smallest tier, not a crash.
window.eval("setMode('sit')")
frame({ type: 'gift', user: 'ana', giftName: 'Rose', count: 1 })
check('a gift with no value still jumps', mode() === 'jump', mode())

// The boost belongs to the jump that asked for it. Left on the cat, every later
// idle jump would inherit the height of the last big gift.
window.eval("setMode('walk')")
check('the boost is cleared by the next mode', jumpBoost() === 1, String(jumpBoost()))

dom.window.close()

if (failures) {
  console.log(`\n${failures} failed`)
  process.exit(1)
}
console.log('\nall passed')
