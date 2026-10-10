/**
 * Backend-settings tests.
 *
 * The URL is the whole configuration, and both ways of getting it wrong fail in a
 * way that looks like something else: a missing scheme reports as "could not
 * connect", and a half-filled pair reports as "it did nothing".
 *
 *   node sidecar/test-backend.mjs
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

const dir = mkdtempSync(join(tmpdir(), 'backend-test-'))
writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }))

const tscBin = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
const tsc = spawnSync(
  process.execPath,
  [
    tscBin,
    join(pkgRoot, 'src', 'lib', 'backend.ts'),
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

const { isReady, normaliseBaseUrl } = await import(pathToFileURL(join(dir, 'lib', 'backend.js')).href)

console.log('a backend URL as typed')
check('an empty field stays empty', normaliseBaseUrl('') === '')
check('whitespace is not a URL', normaliseBaseUrl('   ') === '')
// The scheme is the host's business, not the page's — it needs to know that
// https means wss. All this has to do is stop the user typing a trailing slash
// and getting a path the backend does not serve.
check('a trailing slash comes off', normaliseBaseUrl('https://kit.example/') === 'https://kit.example')
check('several come off', normaliseBaseUrl('https://kit.example///') === 'https://kit.example')
check('a path is left alone', normaliseBaseUrl('https://kit.example/streamkit') === 'https://kit.example/streamkit')
check('space is trimmed', normaliseBaseUrl('  http://127.0.0.1:8000  ') === 'http://127.0.0.1:8000')
check('http is not upgraded here', normaliseBaseUrl('http://kit.example') === 'http://kit.example')

console.log('enough to connect with')
check('neither field', !isReady({ baseUrl: '', overlayId: '' }))
check('only the url', !isReady({ baseUrl: 'https://kit.example', overlayId: '' }))
check('only the overlay', !isReady({ baseUrl: '', overlayId: 'abc' }))
check('a blank overlay is not an overlay', !isReady({ baseUrl: 'https://kit.example', overlayId: '   ' }))
check('a slash-only url is not a url', !isReady({ baseUrl: '/', overlayId: 'abc' }))
check('both', isReady({ baseUrl: 'https://kit.example', overlayId: 'abc' }))

console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)