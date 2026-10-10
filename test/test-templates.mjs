/**
 * Sound-template tests.
 *
 * Templates are data, so the whole catalogue can be checked without an
 * AudioContext: that every template has notes, that no note is degenerate, that
 * an unknown id falls back to something real rather than to nothing. A template
 * that renders as silence or throws is the failure this catches, and it is one
 * that would otherwise only show up by ear.
 *
 *   node test/test-templates.mjs
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

const dir = mkdtempSync(join(tmpdir(), 'templates-test-'))
writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }))

const tscBin = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
const tsc = spawnSync(
  process.execPath,
  [
    tscBin,
    join(pkgRoot, 'src', 'lib', 'templates.ts'),
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

const { TEMPLATES, resolveTemplate, templateDurationMs } = await import(
  pathToFileURL(join(dir, 'lib', 'templates.js')).href
)

console.log('the catalogue')
check('there are templates to choose from', TEMPLATES.length >= 4, String(TEMPLATES.length))
check('every id is unique', new Set(TEMPLATES.map((t) => t.id)).size === TEMPLATES.length)
check('every label is non-empty', TEMPLATES.every((t) => t.label.trim() !== ''))
check('the first one is the chime the app shipped with', TEMPLATES[0].id === 'chime', TEMPLATES[0].id)

console.log('no template is degenerate')
for (const t of TEMPLATES) {
  check(`${t.id} has notes`, t.notes.length > 0)
  check(`${t.id} keeps its gain in range`, t.gain > 0 && t.gain <= 1, String(t.gain))
  check(`${t.id} notes all start at or after zero`, t.notes.every((n) => n.delayMs >= 0))
  check(`${t.id} notes all last longer than nothing`, t.notes.every((n) => n.durationMs > 0))
  check(`${t.id} note levels stay in range`, t.notes.every((n) => n.level > 0 && n.level <= 1))
  check(`${t.id} note frequencies are audible`, t.notes.every((n) => n.frequency >= 20 && n.frequency <= 20000))
}

console.log('an unknown id falls back to something real')
// A saved id from a build that offered a template this one dropped must resolve
// to a playable sound, not to nothing — otherwise the setting silently goes dead.
check('a made-up id resolves to the first template', resolveTemplate('nope').id === TEMPLATES[0].id)
check('null resolves too', resolveTemplate(null).id === TEMPLATES[0].id)
check('undefined resolves too', resolveTemplate(undefined).id === TEMPLATES[0].id)
check('a real id resolves to itself', resolveTemplate('coin').id === 'coin')

console.log('how long a template lasts')
// The last note's end, not the note count: a template whose final note starts
// late and rings is longer than its count suggests, and cutting speech off on the
// wrong length is only obvious by ear.
for (const t of TEMPLATES) {
  const expected = Math.max(...t.notes.map((n) => n.delayMs + n.durationMs))
  check(`${t.id} duration is its last note's end`, templateDurationMs(t) === expected, `${templateDurationMs(t)} vs ${expected}`)
  check(`${t.id} lasts longer than nothing`, templateDurationMs(t) > 0)
}

console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
