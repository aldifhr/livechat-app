/**
 * Mention tests.
 *
 * The rule is pure and the interesting part is entirely in the loose comparison:
 * TikTok is not consistent about whether a mention arrives with its `@`, in what
 * case, or against a display name rather than a handle. A strict comparison would
 * miss the mentions that matter and catch none of the ones that do not — which is
 * a feature that is off in the exact situation it was built for.
 *
 *   node test/test-mentions.mjs
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

const dir = mkdtempSync(join(tmpdir(), 'mentions-test-'))
writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }))

const tscBin = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
const tsc = spawnSync(
  process.execPath,
  [
    tscBin,
    join(pkgRoot, 'src', 'lib', 'mentions.ts'),
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

const { myHandles, mentionsMe } = await import(pathToFileURL(join(dir, 'lib', 'mentions.js')).href)

console.log('the handles from the field')
check('one handle', JSON.stringify(myHandles('ana')) === '["ana"]')
check('several, comma-separated', JSON.stringify(myHandles('ana,budi')) === '["ana","budi"]')
check('a leading @ is stripped', JSON.stringify(myHandles('@ana')) === '["ana"]')
check('and several of them', JSON.stringify(myHandles('@@ana')) === '["ana"]')
check('surrounding space is trimmed', JSON.stringify(myHandles('  ana  ')) === '["ana"]')
check('case is flattened, because TikTok sends all three', JSON.stringify(myHandles('ANA')) === '["ana"]')
check('a blank field is no handles at all', myHandles('').length === 0)
check('and a whitespace field is the same', myHandles('   ').length === 0)
check('blank entries between commas are dropped', JSON.stringify(myHandles('ana,,budi')) === '["ana","budi"]')
check('a trailing comma is not a handle', JSON.stringify(myHandles('ana,')) === '["ana"]')

console.log('whether a message names me')
// The whole point: these are the same person written four ways, and all four have
// to count or the alert is off exactly when it is needed.
check('an exact match', mentionsMe(['ana'], ['ana']))
check('case does not matter', mentionsMe(['ANA'], ['ana']))
check('a leading @ on the mention does not matter', mentionsMe(['@ana'], ['ana']))
check('both at once', mentionsMe(['@ANA'], ['ana']))
check('one of several handles', mentionsMe(['budi'], ['ana', 'budi']))
check('a mention among others', mentionsMe(['x', 'ana', 'y'], ['ana']))
check('someone else is not me', !mentionsMe(['budi'], ['ana']))
check('a substring is not a match', !mentionsMe(['anabelle'], ['ana']))
check('and neither is a prefix the other way', !mentionsMe(['an'], ['ana']))
// Guards: an empty anything is not a mention, which is what keeps a fresh install
// from highlighting the whole room.
check('no mentions at all', !mentionsMe(undefined, ['ana']))
check('an empty mention list', !mentionsMe([], ['ana']))
check('no handles configured', !mentionsMe(['ana'], []))
check('both empty', !mentionsMe([], []))
check('a blank mention entry is not a match', !mentionsMe(['   '], ['ana']))

console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
