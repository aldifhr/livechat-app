/**
 * Tests for the AI decisions.
 *
 * Every function here is pure, and every one of them exists because of a way it
 * can be wrong that a screenshot would not show. The batch is chosen wrongly and
 * the same messages are re-sent on every pass; an index is off by one and a row
 * that was never flagged is removed; a stored mode is one a previous build
 * offered and the feature silently stops. None of those is visible without
 * reading what actually went out.
 *
 *   node test/test-ai.mjs
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

// `ai.ts` and `types.ts` are pure, so they are compiled and imported rather than
// reimplemented. `types.ts` is compiled alongside because it is the shape the
// feed rows are asserted against.
const dir = mkdtempSync(join(tmpdir(), 'ai-test-'))
writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }))

const tscBin = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
const tsc = spawnSync(
  process.execPath,
  [
    tscBin,
    join(pkgRoot, 'src', 'lib', 'ai.ts'),
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

const {
  clampSeconds,
  describeVerdict,
  isModerating,
  MODERATION_BATCH,
  MODERATION_MODES,
  numberedLines,
  pendingModeration,
  resolveModeration,
  streamTopic,
  REPLY_MAX_SECONDS,
  REPLY_MIN_SECONDS,
} = await import(pathToFileURL(join(dir, 'lib', 'ai.js')).href)

/** A feed row, with only the fields these functions read. */
const chat = (nickname, text, extra = {}) => ({
  key: `${nickname}-${text}`,
  platform: 'tiktok',
  kind: 'chat',
  nickname,
  id: nickname,
  avatar: '',
  timestamp: 0,
  text,
  ...extra,
})

console.log('a mode from a settings file')
check('off is off', isModerating('off') === false)
check('flag is moderating', isModerating('flag') === true)
check('block is moderating', isModerating('block') === true)
check('every mode has a label', MODERATION_MODES.every((m) => m.label !== '' && m.hint !== ''))

check('a saved mode survives', resolveModeration('block') === 'block')
check('nothing saved is off', resolveModeration(undefined) === 'off')
check('nothing at all is off', resolveModeration(null) === 'off')
// A mode a previous build offered and this one dropped. Left as-is it would reach
// the selector as a value nothing answers to: a blank dropdown and, because `off`
// is the only safe reading of a mode nobody picked, a feature silently stopped.
check('a mode this build dropped is off', resolveModeration('mute') === 'off')
check('a near-miss is not a match', resolveModeration('Block') === 'off')
check('a number is not a mode', resolveModeration(2) === 'off')

console.log('which messages a pass sends')
check('an empty feed sends nothing', pendingModeration([], new Set()).length === 0)
// The set is what stops the same message being judged on every pass for as long
// as the room is open.
const once = pendingModeration([chat('ana', 'hi')], new Set(['ana-hi']))
check('an already-decided message is skipped', once.length === 0)
const fresh = pendingModeration([chat('ana', 'hi')], new Set())
check('an undecided one is not', fresh.length === 1)

// Only chat has anything to moderate. A join is a viewer appearing and a gift is
// an event, and neither is something a model can judge as harmful.
const mixed = pendingModeration(
  [
    { ...chat('ana', ''), kind: 'join' },
    { ...chat('bud', ''), kind: 'gift' },
    { ...chat('cal', ''), kind: 'answer' },
    chat('dee', 'hello'),
  ],
  new Set(),
)
check('joins, gifts and answers are not moderated', mixed.length === 1 && mixed[0].nickname === 'dee', JSON.stringify(mixed.map((i) => i.nickname)))

// TikTok filtered it, so the platform has already dealt with it. Re-judging it
// spends a slot in the batch to reach the same conclusion.
const filtered = pendingModeration([chat('ana', 'buy this', { isFiltered: true }), chat('bud', 'hi')], new Set())
check('a message TikTok filtered is left out', filtered.length === 1 && filtered[0].nickname === 'bud', JSON.stringify(filtered.map((i) => i.nickname)))

// A message that is only an emote has no words to judge, and it would spend one
// of twenty-five slots doing it.
check('an emote-only message is left out', pendingModeration([chat('ana', '   ')], new Set()).length === 0)

// Already marked, because a previous pass flagged it. Sending it again would let
// a later pass re-label a row the streamer has already acted on.
check('an already-flagged message is left out', pendingModeration([chat('ana', 'hi', { moderation: { label: 'spam', reason: '' } })], new Set()).length === 0)

console.log('the batch is bounded and the right end of it')
const many = Array.from({ length: MODERATION_BATCH + 20 }, (_, at) => chat(`u${at}`, `m${at}`))
const capped = pendingModeration(many, new Set())
check('the cap holds', capped.length === MODERATION_BATCH, String(capped.length))
// The newest, not the oldest: a pass runs every few seconds, and the messages it
// skipped have been pushed further out of view than the ones it did not.
check('the newest are the ones sent', capped.at(-1).text === `m${many.length - 1}`, capped.at(-1).text)
check('the oldest are the ones dropped', capped[0].text === 'm20', capped[0].text)
// And the order goes back to the order they arrived, because the prompt reads
// better in order and an index means nothing else.
check('the batch is in arrival order', capped.map((i) => i.text).join(',') === many.slice(20).map((_, at) => `m${at + 20}`).join(','))

console.log('the lines the model is given')
const batch = [chat('ana', 'hello there'), chat('bud', 'hi')]
const { lines, keys } = numberedLines(batch)
check('numbered from one', JSON.stringify(lines) === JSON.stringify(['1: ana: hello there', '2: bud: hi']), JSON.stringify(lines))
check('the keys travel with them', JSON.stringify(keys) === JSON.stringify(['ana-hello there', 'bud-hi']), JSON.stringify(keys))
// The verdict maps back by index into `keys`, so the two halves being returned
// together is what keeps them in step. Here: index 0 is ana's.
check('index zero is the first line', keys[0] === batch[0].key)
// Two people saying the same thing. An index still tells them apart; the text
// alone would not. The keys here are distinct because `useFeed` builds them from
// a per-item sequence — this helper's composite key is only good enough for the
// cases above, where every message is unique.
const twins = numberedLines([chat('ana', 'same', { key: 'k1' }), chat('ana', 'same', { key: 'k2' })])
check('identical messages stay distinguishable', twins.keys[0] === 'k1' && twins.keys[1] === 'k2', JSON.stringify(twins.keys))
check('identical messages still number apart', JSON.stringify(twins.lines) === JSON.stringify(['1: ana: same', '2: ana: same']), JSON.stringify(twins.lines))
check('a blank message has no line', numberedLines([chat('ana', '  ')]).lines.length === 0)
check('an empty batch is empty', JSON.stringify(numberedLines([]).lines) === '[]')

console.log('a flag, described for the log')
const ana = chat('ana', 'hi')
check('name, category and reason', describeVerdict({ index: 0, label: 'hate', reason: 'slur aimed at the streamer' }, ana) === 'ana: hate — slur aimed at the streamer', describeVerdict({ index: 0, label: 'hate', reason: 'slur aimed at the streamer' }, ana))
// The log's job is to let a streamer go back and find the message, so the sender
// is in it. And a verdict with no reason reads as a sentence, not as a stray dash.
check('a reason that is not there leaves no dangling dash', describeVerdict({ index: 0, label: 'spam', reason: '  ' }, ana) === 'ana: spam', describeVerdict({ index: 0, label: 'spam', reason: '  ' }, ana))
check('a nameless sender still reads as a line', describeVerdict({ index: 0, label: 'spam', reason: '' }, chat('', 'hi')) === 'someone: spam', describeVerdict({ index: 0, label: 'spam', reason: '' }, chat('', 'hi')))

console.log('seconds between answers')
check('a number inside the range is kept', clampSeconds(60) === 60)
check('rounded', clampSeconds(61.4) === 61)
// Zero would mean a request per tick and a negative one a timer that never
// fires. Both are one keystroke in a field that is being typed into.
check('zero is raised to the floor', clampSeconds(0) === REPLY_MIN_SECONDS)
check('a negative is raised to the floor', clampSeconds(-30) === REPLY_MIN_SECONDS)
check('past the ceiling is lowered', clampSeconds(99999) === REPLY_MAX_SECONDS)
// A number field passes `NaN` through halfway through an edit, and `setInterval`
// with that would stop the feature for the rest of the session over one keystroke.
check('not a number is the floor, not NaN', clampSeconds(Number('')) === REPLY_MIN_SECONDS)
check('a non-number argument is the floor', clampSeconds(undefined) === REPLY_MIN_SECONDS)
// Infinity is not finite either, and takes the same road. A number field cannot
// produce one, so this is about the function being safe to call from anywhere.
check('infinity is the floor too', clampSeconds(Number.POSITIVE_INFINITY) === REPLY_MIN_SECONDS)
check('every result is a usable interval', [0, -1, NaN, Infinity, 30, 900].every((v) => clampSeconds(v) * 1000 > 0))

console.log('what the stream is')
check('handle and title', streamTopic({ target: 'ana', title: 'ranked grind' }) === '@ana — ranked grind', streamTopic({ target: 'ana', title: 'ranked grind' }))
check('a title on its own', streamTopic({ target: '', title: 'ranked grind' }) === 'ranked grind', streamTopic({ target: '', title: 'ranked grind' }))
check('a handle on its own', streamTopic({ target: 'ana', title: '' }) === '@ana', streamTopic({ target: 'ana', title: '' }))
// An empty topic is omitted by the caller rather than sent as "@ — ", which is a
// sentence the model would try to make sense of.
check('neither is empty', streamTopic({ target: '', title: '' }) === '')
check('whitespace is not a title', streamTopic({ target: '  ', title: '  ' }) === '')
check('the handle is trimmed', streamTopic({ target: '  ana  ', title: '' }) === '@ana', streamTopic({ target: '  ana  ', title: '' }))

console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)