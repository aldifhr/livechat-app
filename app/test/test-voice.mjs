/**
 * Voice-claim tests.
 *
 * The bug these guard: `say()` used to cut off whatever was already speaking,
 * and it measured the gap between utterances from when the request was *sent*
 * rather than from when the audio *ended*. Since synthesis is a network round
 * trip that can outlast the gap, a second message arriving while the first was
 * still being fetched would pause the first one — the reader heard only the
 * opening half of each sentence.
 *
 * The rules, in the order they are checked:
 *   1. A sentence already being spoken runs to its end. Nothing takes the slot;
 *      `hush()` is the only way anything is cut off.
 *   2. The voice is claimed for the whole synthesis round trip, not just for
 *      playback — otherwise a message arriving mid-fetch is synthesised into a
 *      sentence that cuts off the first one.
 *   3. The gap is measured from the end of the previous utterance.
 *   4. A synthesis that fails OR returns empty releases the claim; a voice that
 *      went quiet once must not stay silent for the rest of the session.
 *
 *   node test/test-voice.mjs
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pkgRoot = fileURLToPath(new URL('..', import.meta.url))

let failures = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// `voice.ts` depends on `host.speak`, which reaches the Tauri sidecar. The test
// doubles the module graph so the import resolves: a stub `sidecar` whose
// `host.speak` returns a data URL the page-side Audio can be handed, and a
// `sound` re-export carrying the gap constant.
const dir = mkdtempSync(join(tmpdir(), 'voice-test-'))
mkdirSync(join(dir, 'app', 'src', 'lib'), { recursive: true })
// The real `voice.js` is emitted alongside the compiled `sidecar.js` and
// `sound.js` — its imports resolve against the compiled files, not the stubs.
// The stubs are written FIRST so the compiler's `files` list does not pick them
// up, and the compiled output OVERWRITES them. To keep the stubs, they are
// written after the compile, into the same directory.
writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }))
writeFileSync(
  join(dir, 'app', 'src', 'lib', 'sidecar.js'),
  `export const host = {
     speak: async (text) => globalThis.__speakSpy(text),
   }\n`,
)
writeFileSync(
  join(dir, 'app', 'src', 'lib', 'sound.js'),
  `export const CHAT_TTS_GAP_MS = 1800\n`,
)
// The stub modules are written OUTSIDE `src`, and `rootDir` is `src`, so the
// compiler would refuse to emit anything beside it. The paths are handed in
// through a tsconfig instead: `voice.ts` imports `./sidecar`, and the stub sits
// next to the emitted file in `dir`, so the emitted `voice.js` resolves it.
writeFileSync(
  join(dir, 'tsconfig.json'),
  JSON.stringify({
    compilerOptions: {
      rootDir: pkgRoot,
      outDir: dir,
      module: 'esnext',
      target: 'es2020',
      moduleResolution: 'bundler',
      skipLibCheck: true,
      rootDir: join(pkgRoot, '..'),
      baseUrl: pkgRoot,
      paths: { '@shared/*': ['../shared/*'] },
    },
    files: [join(pkgRoot, 'src', 'lib', 'voice.ts')],
  }),
)

const tscBin = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
const tsc = spawnSync(process.execPath, [tscBin, '-p', join(dir, 'tsconfig.json')], {
  encoding: 'utf8',
})
if (tsc.status !== 0) {
  console.log('tsc failed:', tsc.stdout, tsc.stderr, tsc.error)
  process.exit(1)
}

// The compiler emitted the real `sidecar.js` and `sound.js` into the output
// directory, overwriting the stubs. They are written back now: `voice.js`
// imports them, and the test needs the stub `host.speak` rather than the real
// one, which reaches for a Tauri sidecar that does not exist under node.
writeFileSync(
  join(dir, 'app', 'src', 'lib', 'sidecar.js'),
  `export const host = {
     speak: async (text) => globalThis.__speakSpy(text),
   }\n`,
)
writeFileSync(
  join(dir, 'app', 'src', 'lib', 'sound.js'),
  `export const CHAT_TTS_GAP_MS = 1800\n`,
)

// The browser pieces `voice.ts` touches — `Audio` — do not exist under node, and
// neither does the DOM it would need. The module is imported with them stubbed:
// `Audio` records construction and play calls, and the test drives `ended`
// itself by firing the listener it registered.
class FakeAudio {
  static instances = []
  constructor(src) {
    this.src = src
    this.paused = false
    this.removed = false
    this.played = false
    this.listeners = {}
    FakeAudio.instances.push(this)
  }
  addEventListener(name, fn) {
    ;(this.listeners[name] ??= []).push(fn)
  }
  removeEventListener(name, fn) {
    this.listeners[name] = (this.listeners[name] ?? []).filter((f) => f !== fn)
  }
  async play() {
    this.played = true
  }
  pause() {
    this.paused = true
  }
  removeAttribute() {
    this.removed = true
  }
  end() {
    for (const fn of this.listeners.ended ?? []) fn()
  }
}
globalThis.Audio = FakeAudio

// A speak spy the test controls: it records what was asked, and resolves with a
// data URL when released.
const asked = []
let releaseSpeak = null
globalThis.__speakSpy = async (text) => {
  asked.push(text)
  await new Promise((resolve) => {
    releaseSpeak = resolve
  })
  return 'data:audio/mpeg;base64,AAAA'
}

// Vite resolves extensionless imports at build time; raw node ESM does not.
// The emitted `voice.js` carries `from './sidecar'` and `from './sound'`, so the
// extensions are appended here — the import specifier is the only thing the test
// needs to change about the compiled output.
const { readFileSync } = await import('node:fs')
const voiceJsPath = join(dir, 'app', 'src', 'lib', 'voice.js')
const voiceJs = readFileSync(voiceJsPath, 'utf8')
  .replace(/from '\.\/sidecar'/g, "from './sidecar.js'")
  .replace(/from '\.\/sound'/g, "from './sound.js'")
writeFileSync(voiceJsPath, voiceJs)

const { say, hush } = await import(pathToFileURL(voiceJsPath).href)

/** Fires the pending speak resolution and lets the awaiting code run. */
async function flush() {
  releaseSpeak?.()
  await new Promise((r) => setTimeout(r, 10))
  releaseSpeak = null
}

async function reset() {
  hush()
  FakeAudio.instances.length = 0
  asked.length = 0
  await new Promise((r) => setTimeout(r, 0))
}

console.log('a sentence already speaking is not cut off')
{
  await reset()
  say('halo')
  await flush()
  const first = FakeAudio.instances.at(-1)
  check('the first sentence is playing', first?.played === true)

  // A second message while the first is mid-sentence: the reader must hear the
  // first one out. Cutting it off is the bug.
  say('apa kabar')
  await flush()
  check('the first sentence is still playing', first.paused === false)
  check('the second one was not synthesised', asked.length === 1, `asked=${asked.length}`)
}

console.log('an empty synthesis releases the claim')
{
  // The host can answer with '' — no audio for this text. That is not "play it
  // later": nothing was played, and the claim must come back. Left set, every
  // later `say()` returns at the busy check and the reader is silent for the rest
  // of the session. This is the path the `catch` below does not cover.
  await reset()
  let calls = 0
  globalThis.__speakSpy = async (text) => {
    asked.push(text)
    calls += 1
    return calls === 1 ? '' : 'data:audio/mpeg;base64,AAAA'
  }
  say('halo')
  await flush()
  check('nothing played for the empty answer', FakeAudio.instances.length === 0)
  say('apa kabar')
  await flush()
  check('the next utterance is still attempted', asked.length === 2, `asked=${asked.length}`)
  check('and it plays', FakeAudio.instances.length === 1, FakeAudio.instances.length)

  globalThis.__speakSpy = async (text) => {
    asked.push(text)
    await new Promise((resolve) => {
      releaseSpeak = resolve
    })
    return 'data:audio/mpeg;base64,AAAA'
  }
}

console.log('the voice is claimed for the whole round trip')
{
  await reset()
  // The first request is in flight — synthesis has not returned yet.
  say('halo')
  // A second message arriving mid-synthesis must not start a second synthesis
  // that will cut the first one off when it returns.
  say('apa kabar')
  check('only one synthesis was started', asked.length === 1, `asked=${asked.length}`)
  await flush()
  check('and the first one is what plays', FakeAudio.instances.length === 1)
}

console.log('the gap is measured from the end, not the request')
{
  await reset()
  say('halo')
  await flush()
  FakeAudio.instances.at(-1).end()
  // Immediately after the first ended: inside the gap, dropped.
  say('apa kabar')
  await flush()
  check('inside the gap it is dropped', asked.length === 1, `asked=${asked.length}`)
  // Past the gap: heard.
  await new Promise((r) => setTimeout(r, 1810))
  say('sudah selesai')
  await flush()
  check('past the gap it is heard', asked.length === 2, `asked=${asked.length}`)
}

console.log('hush stops everything and forgets the gap')
{
  await reset()
  say('halo')
  await flush()
  const first = FakeAudio.instances.at(-1)
  hush()
  check('the sentence is paused', first.paused === true)
  check('the source is cleared', first.removed === true)

  // Forgetting the gap: the next sentence is heard immediately, not after a wait.
  // `asked` counts every utterance that reached `host.speak` — the first one in
  // this scenario plus this one. `hush` cancels the *claim* and the pending
  // synthesis, but the request that was already in flight still counts as asked.
  say('apa kabar')
  await flush()
  check('the next one is not held by the old gap', asked.length === 2, `asked.length=${asked.length}`)
}

console.log('hush during synthesis cancels the pending utterance')
{
  await reset()
  say('halo')
  // Still mid-round-trip: hush must stop it from ever starting.
  hush()
  await flush()
  check('nothing was played', FakeAudio.instances.length === 0)
}

console.log('a failed synthesis releases the claim')
{
  await reset()
  globalThis.__speakSpy = async (text) => {
    asked.push(text)
    throw new Error('unreachable')
  }
  say('halo')
  await flush()
  check('nothing played', FakeAudio.instances.length === 0)
  // The voice must not stay silent for the rest of the session because one
  // synthesis failed.
  say('apa kabar')
  await flush()
  check('the next utterance is still attempted', asked.length === 2, `asked.length=${asked.length}`)

  globalThis.__speakSpy = async (text) => {
    asked.push(text)
    await new Promise((resolve) => {
      releaseSpeak = resolve
    })
    return 'data:audio/mpeg;base64,AAAA'
  }
}

console.log('empty text speaks nothing')
{
  await reset()
  say('   ')
  await flush()
  check('nothing was asked', asked.length === 0, `asked.length=${asked.length}`)
}

console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
