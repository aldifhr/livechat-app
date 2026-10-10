/**
 * Endpoint-settings tests.
 *
 * Two of the three functions here exist because of a way they can be wrong that a
 * screenshot would not show: a base URL pasted without a scheme fails as a
 * connection error rather than as the typo it is, and a model the endpoint has
 * retired drops the user's selection on the next launch with nothing said about
 * it.
 *
 *   node test/test-llm.mjs
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

// `llm.ts` is pure, so it is compiled and imported rather than reimplemented.
const dir = mkdtempSync(join(tmpdir(), 'llm-test-'))
writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }))

const tscBin = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
const tsc = spawnSync(
  process.execPath,
  [
    tscBin,
    join(pkgRoot, 'src', 'lib', 'llm.ts'),
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

const { isReady, modelOptions, normaliseBaseUrl } = await import(pathToFileURL(join(dir, 'lib', 'llm.js')).href)

console.log('a base URL as typed')
check('an empty field stays empty', normaliseBaseUrl('') === '')
check('whitespace is not a URL', normaliseBaseUrl('   ') === '')
// The common case is a bare `host:port/v1` off a terminal. Without a scheme the
// request fails as "could not connect", which reads as a network problem rather
// than as the typo it is. 198.51.100.0/24 is the range reserved for examples, so
// this stays an example rather than reaching for whatever host is to hand.
check('a bare host:port gets a scheme', normaliseBaseUrl('198.51.100.7:8080/v1') === 'http://198.51.100.7:8080/v1')
check('surrounding space is trimmed', normaliseBaseUrl('  https://h/v1  ') === 'https://h/v1')
check('an existing scheme is left alone', normaliseBaseUrl('https://h/v1') === 'https://h/v1')
check('http is not upgraded to https', normaliseBaseUrl('http://h/v1') === 'http://h/v1')
check('a trailing slash comes off', normaliseBaseUrl('https://h/v1/') === 'https://h/v1')
check('several trailing slashes come off', normaliseBaseUrl('https://h/v1///') === 'https://h/v1')
check('a port is not mistaken for a scheme', normaliseBaseUrl('localhost:11434/v1') === 'http://localhost:11434/v1')
check('normalising twice changes nothing', normaliseBaseUrl(normaliseBaseUrl('  h:1/v1/ ')) === 'http://h:1/v1')

console.log('enough to spend a request on')
check('neither field filled', !isReady({ baseUrl: '', apiKey: '', model: '' }))
check('only the url', !isReady({ baseUrl: 'https://h/v1', apiKey: '', model: '' }))
check('only the key', !isReady({ baseUrl: '', apiKey: 'sk-x', model: '' }))
check('a model does not count as enough', !isReady({ baseUrl: 'https://h/v1', apiKey: '', model: 'gpt' }))
check('both filled', isReady({ baseUrl: 'https://h/v1', apiKey: 'sk-x', model: '' }))
check('a space is not a key', !isReady({ baseUrl: 'https://h/v1', apiKey: '   ', model: '' }))

console.log('the model list')
check('empty stays empty', JSON.stringify(modelOptions([], '')) === '[]')
check('sorted', JSON.stringify(modelOptions(['c', 'a', 'b'], '')) === '["a","b","c"]')
check('duplicates dropped', JSON.stringify(modelOptions(['a', 'a', 'b'], '')) === '["a","b"]')
check('blanks dropped', JSON.stringify(modelOptions(['a', '', '  ', 'b'], '')) === '["a","b"]')

console.log('a saved model the endpoint no longer lists')
// Providers retire models. Dropping it would leave the user's selection showing
// as unset with nothing explaining why.
const kept = modelOptions(['b', 'c'], 'a')
check('the saved model is still offered', kept[0] === 'a', JSON.stringify(kept))
check('and the rest follow it', JSON.stringify(kept.slice(1)) === '["b","c"]')
check('it is not duplicated when it is listed', JSON.stringify(modelOptions(['a', 'b'], 'a')) === '["a","b"]')
check('a whitespace selection is not a selection', JSON.stringify(modelOptions(['a'], '   ')) === '["a"]')

console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)