/**
 * Statistics tests.
 *
 * The viewer rate and the leaderboard are the two numbers a streamer would act on,
 * and both are wrong in ways no screenshot would show: a rate that keeps counting
 * after a room goes quiet, or a leaderboard ordered by gift value that buries the
 * person who has actually been talking. So the conditions are pinned here.
 *
 *   node test/test-stats.mjs
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

// `stats.ts` is pure, so it is compiled and imported rather than reimplemented —
// a reimplementation would test the copy rather than the shipped one.
const dir = mkdtempSync(join(tmpdir(), 'stats-test-'))
writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }))

const tscBin = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
const tsc = spawnSync(
  process.execPath,
  [
    tscBin,
    join(pkgRoot, 'src', 'lib', 'stats.ts'),
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
  RATE_BUCKETS,
  SPARK_SAMPLES,
  addToBucket,
  emptyBuckets,
  ratePerMinute,
  rankChatters,
  sparkPath,
} = await import(pathToFileURL(join(dir, 'lib', 'stats.js')).href)

const NOW = 1_700_000_000_000
/** N events in the second beginning at `at`. */
const inSecond = (buckets, at, n) => {
  let next = buckets
  for (let i = 0; i < n; i += 1) next = addToBucket(next, at)
  return next
}

console.log('the rate window')
check('an empty window is a rate of zero', ratePerMinute(emptyBuckets(), NOW) === 0)
check('the ring covers a whole minute', RATE_BUCKETS === 60, String(RATE_BUCKETS))

let buckets = inSecond(emptyBuckets(), NOW, 12)
check('events in this second count', ratePerMinute(buckets, NOW) === 12, String(ratePerMinute(buckets, NOW)))
check('and are still counted a second later', ratePerMinute(buckets, NOW + 1000) === 12)

console.log('events a few milliseconds apart share a second')
// Arrivals are not spaced to the clock. Keying the bucket on the raw timestamp
// makes each of these its own bucket and a room sending forty messages a second
// reports a rate of one.
let burst = emptyBuckets()
for (let n = 0; n < 12; n += 1) burst = addToBucket(burst, NOW + n * 37)
check('a burst inside one second is counted whole', ratePerMinute(burst, NOW + 500) === 12, String(ratePerMinute(burst, NOW + 500)))

buckets = inSecond(buckets, NOW + 30_000, 5)
check('events across seconds add up', ratePerMinute(buckets, NOW + 31_000) === 17)

console.log('a quiet room falls to zero')
// The case the ring exists for: nothing has been written for most of a minute, so
// almost every slot is stale. Reading those as zero is what makes the number
// mean "right now" rather than "on average over the session".
buckets = inSecond(emptyBuckets(), NOW, 40)
check('a minute later the room is silent', ratePerMinute(buckets, NOW + 60_000) === 0, String(ratePerMinute(buckets, NOW + 60_000)))
check('but the burst itself is still inside a shorter window', ratePerMinute(buckets, NOW + 59_000) === 40)

console.log('a reused slot is not an accumulating one')
buckets = inSecond(emptyBuckets(), NOW, 3)
// Same ring slot, 60 seconds later — the slot is claimed afresh, so the old
// count must not be carried across the boundary.
buckets = inSecond(buckets, NOW + 60_000, 2)
check('the second minute is counted on its own', ratePerMinute(buckets, NOW + 60_500) === 2, String(ratePerMinute(buckets, NOW + 60_500)))

console.log('frames that arrive out of order still count')
buckets = inSecond(emptyBuckets(), NOW - 400, 4)
check('a slightly stale timestamp is inside the window', ratePerMinute(buckets, NOW) === 4, String(ratePerMinute(buckets, NOW)))

console.log('sparklines')
check('nothing to draw', sparkPath([], 100, 30).line === '')
check('one sample draws one point', (sparkPath([5], 100, 30).line.match(/L/g) ?? []).length === 0)
check('five samples draw five points', (sparkPath([1, 2, 3, 4, 5], 100, 30).line.match(/L/g) ?? []).length === 4)

const rising = sparkPath([1, 5, 10], 100, 30)
check('the area closes to the baseline', rising.area.endsWith('Z'))
check('the area starts where the line starts', rising.area.startsWith(rising.line))
// Scaled to its own range: a room steady at 300 for an hour must not draw a flat
// line along the floor, which is what a zero-based chart would show.
const points = rising.line.slice(1).split('L').map((p) => Number(p.split(',')[1]))
check('the lowest point is at the bottom', points[0] === Math.max(...points), rising.line)
check('the highest point is at the top', points.at(-1) === Math.min(...points), rising.line)

const flat = sparkPath([4, 4, 4], 100, 30)
const flatPoints = flat.line.slice(1).split('L').map((p) => Number(p.split(',')[1]))
check('a room that never moved draws through the middle', flatPoints.every((y) => y === flatPoints[0]), flat.line)
check('the sparkline is bounded to a sensible history', SPARK_SAMPLES > 0 && SPARK_SAMPLES <= 1000, String(SPARK_SAMPLES))

console.log('the leaderboard')
const chatter = (over) => ({
  id: 'u',
  nickname: 'someone',
  avatar: '',
  platform: 'tiktok',
  messages: 0,
  gifts: 0,
  diamonds: 0,
  follows: 0,
  shares: 0,
  ...over,
})

const ranked = rankChatters(
  [
    chatter({ id: 'a', nickname: 'quiet', messages: 2, diamonds: 500 }),
    chatter({ id: 'b', nickname: 'talker', messages: 40, diamonds: 1 }),
    chatter({ id: 'c', nickname: 'silent', messages: 0, gifts: 0, follows: 0, shares: 0 }),
  ],
  10,
)
// Someone who has said one enormous gift has done something worth showing, but
// ranking them above the person who has talked all evening reads as a bug.
check('messages outrank gift value', ranked.map((c) => c.id).join(',') === 'b,a', ranked.map((c) => c.id).join(','))
check('someone who only watched is not ranked', !ranked.some((c) => c.id === 'c'))

check('a gift-only person is still ranked', rankChatters([chatter({ id: 'g', gifts: 1, diamonds: 9 })], 10).length === 1)
check('a follow counts as having been there', rankChatters([chatter({ id: 'f', follows: 1 })], 10).length === 1)
check('the list is capped', rankChatters(Array.from({ length: 50 }, (_, i) => chatter({ id: `u${i}`, messages: i })), 10).length === 10)

// Two people on the same count must not swap places on every event, which reads as
// the whole panel flickering.
const tie = rankChatters(
  [chatter({ id: 'z', nickname: 'zoe', messages: 5 }), chatter({ id: 'y', nickname: 'amy', messages: 5 })],
  10,
)
check('equal rows are ordered by name', tie.map((c) => c.nickname).join(',') === 'amy,zoe', tie.map((c) => c.nickname).join(','))

console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)