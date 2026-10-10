/**
 * Gift-sound tests.
 *
 * The chime is synthesised, so nothing about it can be checked by ear from a test
 * run. What can be checked is the decision of *whether* to sound at all, and that
 * is where a mistake is both easy and expensive: a gift wave arrives as one frame
 * per member, and a gap that is too short turns one wave into twenty overlapping
 * notes, which is worse than no sound at all.
 *
 *   node test/test-sound.mjs
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
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

// `sound.ts` is pure, so it is compiled and imported rather than reimplemented.
const dir = mkdtempSync(join(tmpdir(), 'sound-test-'))
writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }))

const tscBin = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
const tsc = spawnSync(
  process.execPath,
  [
    tscBin,
    join(pkgRoot, 'src', 'lib', 'sound.ts'),
    '--outDir', dir,
    '--rootDir', join(pkgRoot, 'src'),
    '--module', 'esnext',
    '--target', 'es2020',
    '--moduleResolution', 'bundler',
    '--skipLibCheck',
  ],
  { encoding: 'utf8' },
)
if (tsc.status !== 0) {
  console.log('tsc failed:', tsc.stdout, tsc.stderr, tsc.error)
  process.exit(1)
}

const { GIFT_SOUND_GAP_MS, giftChord, giftPitch, shouldPlayGiftSound } = await import(
  pathToFileURL(join(dir, 'lib', 'sound.js')).href
)

const T0 = 1_700_000_000_000

console.log('the sound is optional')
check('off means silence', !shouldPlayGiftSound(false, null, T0))
check('off stays silent after one has played', !shouldPlayGiftSound(false, T0, T0 + 60_000))

console.log('the first gift is always heard')
// The gap is measured from the last sound, and nothing has sounded yet. Measuring
// it from the start of time instead would let this through by accident.
check('with nothing played yet, it rings', shouldPlayGiftSound(true, null, T0))
check('and that holds however long the session has been going', shouldPlayGiftSound(true, null, T0 + 86_400_000))

console.log('a wave is one sound')
// The case the gap exists for: TikTok sends a frame per member, so five identical
// gifts in a burst are one event as far as anyone watching is concerned.
check('the second gift inside the gap is dropped', !shouldPlayGiftSound(true, T0, T0 + 100))
check('and so is the fifth', !shouldPlayGiftSound(true, T0, T0 + GIFT_SOUND_GAP_MS - 1))
check('the next wave is heard', shouldPlayGiftSound(true, T0, T0 + GIFT_SOUND_GAP_MS))
check('exactly at the gap, not before it', shouldPlayGiftSound(true, T0, T0 + GIFT_SOUND_GAP_MS))
check('the gap is long enough to matter', GIFT_SOUND_GAP_MS >= 2000, String(GIFT_SOUND_GAP_MS))

console.log('the pitch carries the value')
check('a gift with no value on the wire still sounds', giftPitch(0) > 0)
check('a bigger gift is a higher note', giftPitch(1000) > giftPitch(100), `${giftPitch(1000)} vs ${giftPitch(100)}`)
check('but only by an octave at most', giftPitch(999_999) <= giftPitch(500) * 2, String(giftPitch(999_999)))
check('a room that is simply loud does not climb forever', giftPitch(100_000) === giftPitch(500))
// A missing or malformed field must not produce a silent chime: `NaN` reaching an
// oscillator's frequency is exactly the kind of thing that throws.
check('NaN falls back rather than propagating', Number.isFinite(giftPitch(Number.NaN)))
check('a negative value falls back', Number.isFinite(giftPitch(-50)))
check('Infinity falls back', Number.isFinite(giftPitch(Number.POSITIVE_INFINITY)))

console.log('the chime itself')
const chord = giftChord(600)
check('it is two notes', chord.length === 2)
check('a fifth apart, not an octave', Math.abs(chord[1].frequency / chord[0].frequency - 1.5) < 0.001, String(chord[1].frequency / chord[0].frequency))
check('the second note follows the first', chord[1].delayMs > chord[0].delayMs)
check('and not by so much it reads as two sounds', chord[1].delayMs < 200, String(chord[1].delayMs))

console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)