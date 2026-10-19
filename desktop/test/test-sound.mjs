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

// Emotes are read as words, which is the commonest way a chat line reads wrong:
// a message ending `[thanks]` was spoken ending in "thanks".
console.log('emotes are not spoken')
check('a trailing emote is dropped', ttsText('kadang gw kek gitu [thanks]') === 'kadang gw kek gitu', ttsText('kadang gw kek gitu [thanks]'))
check('several go at once', ttsText('halo [heart] [smile] dunia') === 'halo dunia', ttsText('halo [heart] [smile] dunia'))
// A space, not nothing: two words separated only by an emote must not fuse.
check('words either side stay apart', ttsText('halo[heart]dunia') === 'halo dunia', ttsText('halo[heart]dunia'))
// A message that was nothing but emotes has nothing left to say, and speaking it
// would hold an empty utterance against the next message.
check('an emote-only message speaks nothing', ttsText('[thanks] [heart]') === '', JSON.stringify(ttsText('[thanks] [heart]')))
check('and neither does a lone one', ttsText('[thanks]') === '')
// Real Unicode emoji are already silent at the service — measured, a message with
// one in it returns byte-identical audio — so they are left exactly as written.
check('real emoji are left alone', ttsText('halo 🙏 dunia') === 'halo 🙏 dunia', ttsText('halo 🙏 dunia'))
// A mention is written `@handle`, so it is not an emote and is read as the word the
// viewer typed. Brackets are only ever emotes on this platform.
check('a mention is still read', ttsText('halo @bittersweetbynajla') === 'halo @bittersweetbynajla', ttsText('halo @bettersweetbynajla'))
// And the cut still counts characters after the emotes are gone, so a wall of
// emotes cannot smuggle an unbounded read past the length cap.
check('the length cap still applies', ttsText(`${'x'.repeat(200)} [thanks] [heart]`).length <= TTS_MAX_CHARS + 1)

console.log('an emoji at the cut is not sliced in half')
// `slice` counts UTF-16 code units, so a message whose 120th unit is the high
// half of an emoji is cut between the surrogate pair. The lone surrogate is not
// valid UTF-16: `JSON.stringify` emits `\ud83d` and the host's parser rejects the
// whole request, so the message is not spoken at all. Cutting on code points
// keeps the emoji whole.
{
  const cutAtEmoji = `${'a'.repeat(TTS_MAX_CHARS - 1)}😀${'b'.repeat(10)}`
  const said = ttsText(cutAtEmoji)
  // No lone surrogate survives: every high surrogate is followed by a low one.
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(said)
  check('no lone surrogate in the result', !lone, JSON.stringify(said.slice(-6)))
  // The real proof: the string survives a JSON round trip, which is the hop that
  // rejected it before. A lone surrogate throws here (or comes back replaced).
  const roundTripped = JSON.parse(JSON.stringify({ text: said })).text
  check('the result survives a JSON round trip', roundTripped === said, JSON.stringify(said.slice(-6)))
  check('and the emoji at the cut is still whole', said.includes('😀'), JSON.stringify(said.slice(-6)))
  // And the same for a run of emoji with no ASCII in front.
  const allEmoji = ttsText('😀'.repeat(TTS_MAX_CHARS + 5))
  check('a run of emoji is cut cleanly too', !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(allEmoji), JSON.stringify(allEmoji.slice(-6)))
}

// Spoken playback is serialized, so the gap is only a pause for phrasing, not a
// cooldown that measures against the blip's — the two no longer race, and the old
// "speech waits longer than a blip" ordering claim stopped describing anything
// when TTS moved to a serialized queue. What still matters is that the pause
// exists: back-to-back utterances with no gap at all read as one run-on line.
check('spoken messages still get a phrasing pause', CHAT_TTS_GAP_MS > 0, String(CHAT_TTS_GAP_MS))

console.log('what a gift sounds like when spoken')
check('a gift is announced with its sender and quantity', giftAnnouncement('ana', 'Rose', 1) === 'ana mengirim 1 Rose', giftAnnouncement('ana', 'Rose', 1))
check('a repeat quantity is spoken with the gift name', giftAnnouncement('ana', 'Rose', 3) === 'ana mengirim 3 Rose', giftAnnouncement('ana', 'Rose', 3))
check('a gift announcement never includes diamond value', !/diamonds?/.test(giftAnnouncement('ana', 'Rose', 1)), giftAnnouncement('ana', 'Rose', 1))
check('a nameless sender still gets named', /Someone/.test(giftAnnouncement('', 'Rose', 1)), giftAnnouncement('', 'Rose', 1))
check('a gift with no name in the catalogue still reads as a gift', /a gift/.test(giftAnnouncement('ana', '', 1)), giftAnnouncement('ana', '', 1))

console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
