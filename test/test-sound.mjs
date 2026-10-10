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

const { GIFT_SOUND_GAP_MS, GIFT_SOUND_GAIN, giftChord, giftPitch, shouldPlayGiftSound, CHAT_SOUND_GAP_MS, CHAT_NOTE_MS, chatBlip, shouldPlayChatSound, ttsText, TTS_MAX_CHARS, CHAT_TTS_GAP_MS, giftAnnouncement } = await import(
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

console.log('the chat blip')
const blip = chatBlip()
check('it is one short note', blip.durationMs === CHAT_NOTE_MS && CHAT_NOTE_MS < 200, String(blip.durationMs))
check('and quieter than the gift chime', blip.gain < GIFT_SOUND_GAIN, `${blip.gain} vs ${GIFT_SOUND_GAIN}`)
check('and higher, so the two do not read the same', blip.frequency > giftPitch(0), `${blip.frequency} vs ${giftPitch(0)}`)

console.log('a chat blip is not one per message')
check('off means silence', !shouldPlayChatSound(false, null, T0))
check('the first message blips', shouldPlayChatSound(true, null, T0))
check('a message inside the gap is dropped', !shouldPlayChatSound(true, T0, T0 + 100))
check('the next one after the gap blips', shouldPlayChatSound(true, T0, T0 + CHAT_SOUND_GAP_MS))
check('the gap is shorter than the gift gap, since chat is busier', CHAT_SOUND_GAP_MS < GIFT_SOUND_GAP_MS, String(CHAT_SOUND_GAP_MS))

console.log('what gets spoken')
check('an empty message speaks nothing', ttsText('ana', '   ', true) === '')
check('a message with no name is just the text', ttsText('ana', 'halo', false) === 'halo')
check('a message with a name says who', ttsText('ana', 'halo', true) === 'ana says: halo')
check('a blank name still says something', ttsText('', 'halo', true) === 'Someone says: halo')
check('runs of whitespace collapse to one', ttsText('ana', 'a   b', false) === 'a b')
// A long message is cut with an ellipsis, not silently truncated — the ellipsis
// is what tells a listener it was cut rather than that the message ended there.
check('a long message is cut', ttsText('ana', 'x'.repeat(TTS_MAX_CHARS + 50), false).endsWith('…'))
check('and the cut keeps the length bounded', ttsText('ana', 'x'.repeat(1000), false).length <= TTS_MAX_CHARS + 1)
check('a short message is left whole', ttsText('ana', 'x'.repeat(10), false) === 'x'.repeat(10))
// Speech needs a longer gap than the blip: overlapping taps are busy, but
// overlapping sentences are unintelligible.
check('speech waits longer than a blip does', CHAT_TTS_GAP_MS > CHAT_SOUND_GAP_MS, String(CHAT_TTS_GAP_MS))

console.log('what a gift sounds like when spoken')
check('a gift is announced with its sender', /ana mengirim Rose/.test(giftAnnouncement('ana', 'Rose', 1, 0)), giftAnnouncement('ana', 'Rose', 1, 0))
check('a repeat count is spoken, not repeated', /kali 3/.test(giftAnnouncement('ana', 'Rose', 3, 0)), giftAnnouncement('ana', 'Rose', 3, 0))
check('the value is spoken as diamonds, because a bare number says nothing', /99 diamonds/.test(giftAnnouncement('ana', 'Rose', 1, 99)), giftAnnouncement('ana', 'Rose', 1, 99))
check('a nameless sender still gets named', /Someone/.test(giftAnnouncement('', 'Rose', 1, 0)), giftAnnouncement('', 'Rose', 1, 0))
check('a gift with no name in the catalogue still reads as a gift', /a gift/.test(giftAnnouncement('ana', '', 1, 0)), giftAnnouncement('ana', '', 1, 0))
check('no diamonds means no diamond count', !/diamonds/.test(giftAnnouncement('ana', 'Rose', 1, 0)), giftAnnouncement('ana', 'Rose', 1, 0))

console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)