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

const { GIFT_SOUND_GAP_MS, GIFT_SOUND_GAIN, giftChord, giftPitch, shouldPlayGiftSound, CHAT_SOUND_GAP_MS, CHAT_NOTE_MS, chatBlip, shouldPlayChatSound, JOIN_SOUND_GAP_MS, shouldPlayJoinSound, shouldPlaySound, ttsText, TTS_MAX_CHARS, CHAT_TTS_GAP_MS, giftAnnouncement } = await import(
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

console.log('the join knock')
check('off means silence', !shouldPlayJoinSound(false, null, T0))
check('the first arrival is heard', shouldPlayJoinSound(true, null, T0))
// TikTok batches its join events rather than sending one per viewer, so these
// arrive in bursts. Without a gap a burst is a burst of sounds.
check('a second arrival inside the gap is dropped', !shouldPlayJoinSound(true, T0, T0 + 100))
check('and so is one a moment before it ends', !shouldPlayJoinSound(true, T0, T0 + JOIN_SOUND_GAP_MS - 1))
check('the next one after the gap sounds', shouldPlayJoinSound(true, T0, T0 + JOIN_SOUND_GAP_MS))
// An arrival is worth less attention than a message, so the gap is longer than
// the blip's — but a person is not a gift, so it is shorter than the chime's.
check('it waits longer than a chat blip does', JOIN_SOUND_GAP_MS > CHAT_SOUND_GAP_MS, String(JOIN_SOUND_GAP_MS))
check('and less long than a gift chime does', JOIN_SOUND_GAP_MS < GIFT_SOUND_GAP_MS, String(JOIN_SOUND_GAP_MS))
// Turning it off and back on must not inherit the gap: that is the one state the
// shared helper cannot see, and it lives in the hook that clears it.
check('nothing played yet is always allowed', shouldPlayJoinSound(true, null, T0 + 86_400_000))

console.log('one gap rule, three events')
// The three wrappers are the same decision with a different number. A fourth copy
// of the rule is how two of them end up disagreeing about whether a first sound
// is allowed, so they are checked against the one they delegate to.
for (const [name, rule] of [
  ['gift', shouldPlayGiftSound],
  ['chat', shouldPlayChatSound],
  ['join', shouldPlayJoinSound],
]) {
  check(`${name}: off is silence`, rule(false, null, T0) === shouldPlaySound(false, null, T0, 1000))
  check(`${name}: the first is heard`, rule(true, null, T0) === shouldPlaySound(true, null, T0, 1000))
  check(`${name}: inside the gap is dropped`, rule(true, T0, T0 + 999, 1000) === shouldPlaySound(true, T0, T0 + 999, 1000))
  check(`${name}: at the gap is heard`, rule(true, T0, T0 + 1000, 1000) === shouldPlaySound(true, T0, T0 + 1000, 1000))
}

console.log('what gets spoken')
// The read is the chat on its own. A sender's name used to be prefixed to it, and
// the Indonesian voice turned the English framing word into "seiz" — a listener
// heard "size" after every name. Nothing is said but the message now.
check('an empty message speaks nothing', ttsText('   ') === '')
check('a message is spoken as written', ttsText('halo') === 'halo')
check('runs of whitespace collapse to one', ttsText('a   b') === 'a b')
// A long message is cut with an ellipsis, not silently truncated — the ellipsis
// is what tells a listener it was cut rather than that the message ended there.
check('a long message is cut', ttsText('x'.repeat(TTS_MAX_CHARS + 50)).endsWith('…'))
check('and the cut keeps the length bounded', ttsText('x'.repeat(1000)).length <= TTS_MAX_CHARS + 1)
check('a short message is left whole', ttsText('x'.repeat(10)) === 'x'.repeat(10))
// Nothing frames the message, so no framing word can be mispronounced into one.
check('no prefix is spoken', !/says|bilang|mengirim/i.test(ttsText('halo')))
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