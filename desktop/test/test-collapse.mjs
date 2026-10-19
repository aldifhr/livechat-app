/**
 * Repeat-collapse tests.
 *
 * Merging two different messages into one row is invisible in the UI — the row
 * just looks short — so the conditions are pinned here. The platform comparison
 * matters most: two rooms can be live at once in principle, and without it a
 * message from one could be counted as a repeat of the row above it.
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
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

// `collapse.ts` is pure, so it is compiled and imported rather than reimplemented.
const dir = mkdtempSync(join(tmpdir(), 'collapse-test-'))
mkdirSync(join(dir, 'hooks'), { recursive: true })
const source = join(dir, 'hooks', 'collapse.ts')
copyFileSync(join(pkgRoot, 'src', 'hooks', 'collapse.ts'), source)
writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }))

const tscBin = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
const tsc = spawnSync(
  process.execPath,
  [tscBin, source, '--outDir', dir, '--rootDir', dir, '--module', 'esnext', '--target', 'es2020', '--moduleResolution', 'bundler', '--skipLibCheck'],
  { encoding: 'utf8' },
)
if (tsc.status !== 0) {
  console.log('tsc failed:', tsc.stdout, tsc.stderr, tsc.error)
  process.exit(1)
}

// tsc emits next to the source rather than into --outDir for a single input file.
const { collapseDecides, MAX_ITEMS } = await import(pathToFileURL(join(dir, 'hooks', 'collapse.js')).href)

const ON = { windowMs: 2500, threshold: 2 }
const OFF = { windowMs: 0, threshold: 0 }

const row = (over = {}) => ({
  kind: 'chat',
  id: 'viewer-1',
  platform: 'tiktok',
  text: 'hello',
  timestamp: 1000,
  ...over,
})

console.log('what folds together')
check('same message, same person, in the window', collapseDecides(row(), row({ timestamp: 1500 }), ON))
check('a gap larger than the window does not fold', !collapseDecides(row(), row({ timestamp: 9000 }), ON))
check(
  'a gap just inside the window folds',
  collapseDecides(row(), row({ timestamp: 1000 + ON.windowMs - 1 }), ON),
)
check(
  'a gap exactly at the window does not fold',
  !collapseDecides(row(), row({ timestamp: 1000 + ON.windowMs }), ON),
)

console.log('what must stay separate')
check('a different message', !collapseDecides(row(), row({ text: 'goodbye' }), ON))
check('a different person', !collapseDecides(row(), row({ id: 'viewer-2' }), ON))
check('a different kind', !collapseDecides(row(), row({ kind: 'gift' }), ON))
check(
  'the same text from another room',
  !collapseDecides(row(), row({ platform: 'youtube' }), ON),
  'two rooms can share a nickname and a message',
)
check(
  'the same person in another room',
  !collapseDecides(row(), row({ platform: 'youtube', text: 'different' }), ON),
)
check('a different gift', !collapseDecides(row({ kind: 'gift', giftName: 'Rose' }), row({ kind: 'gift', giftName: 'Lily' }), ON))

console.log('edge cases')
check('nothing to fold into', !collapseDecides(undefined, row(), ON))
check('disabled collapse never folds', !collapseDecides(row(), row({ timestamp: 1100 }), OFF))
check('a zero threshold never folds', !collapseDecides(row(), row({ timestamp: 1100 }), { windowMs: 2500, threshold: 0 }))
check(
  'a frame far older than the row above it does not fold',
  // Rooms poll at different rates, so a frame can arrive with an older
  // timestamp than the row above it. Comparing with a plain subtraction gives a
  // negative gap, which passes any "under the window" test and merges the two.
  !collapseDecides(row({ timestamp: 5000 }), row({ timestamp: 100 }), ON),
)
check(
  'a slightly older frame still folds',
  // Being out of order by a little is normal and should not defeat collapsing.
  collapseDecides(row({ timestamp: 5000 }), row({ timestamp: 4500 }), ON),
)

console.log('bounds')
check('the list is capped', MAX_ITEMS > 0 && MAX_ITEMS <= 1000, String(MAX_ITEMS))

console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)