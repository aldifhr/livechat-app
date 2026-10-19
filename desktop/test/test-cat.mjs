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
  url: 'http://127.0.0.1:4319/overlay/cat-overlay.html',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  beforeParse(window) {
    window.HTMLCanvasElement.prototype.getContext = () => fakeCtx()
    window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
    // The loop advances only when this file says so.
    window.requestAnimationFrame = () => 0
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

dom.window.close()

if (failures) {
  console.log(`\n${failures} failed`)
  process.exit(1)
}
console.log('\nall passed')
