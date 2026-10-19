/**
 * Overlay-settings tests.
 *
 * Every value here ends up in a URL that something else loads, so the decisions
 * worth checking are all about values that were not what they look like: a colour
 * field that carries a CSS declaration, a size field mid-edit reading `NaN`, a
 * font stack holding a semicolon. None of those is visible until OBS is on
 * screen, which is the worst place to find it.
 *
 *   node test/test-overlay.mjs
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// The app package root, and the repository root above it: the module under test
// lives in shared/, a sibling of the app rather than a part of it.
const pkgRoot = fileURLToPath(new URL('..', import.meta.url))
const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

let failures = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// `overlay.ts` is pure, so it is compiled and imported rather than reimplemented.
const dir = mkdtempSync(join(tmpdir(), 'overlay-test-'))
writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }))

const tscBin = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
const tsc = spawnSync(
  process.execPath,
  [
    tscBin,
    join(repoRoot, 'shared', 'overlay.ts'),
    '--outDir', dir,
    '--rootDir', repoRoot,
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
  clampNumber,
  clampRows,
  isSafeColour,
  OVERLAY_DELAY,
  OVERLAY_DEFAULT_STYLE,
  OVERLAY_MAX_ROWS,
  OVERLAY_SIZE,
  resolveColour,
  resolveOverlayFont,
  resolveStyle,
} = await import(pathToFileURL(join(dir, 'shared', 'overlay.js')).href)

console.log('a colour that is only a colour')
check('a hex triplet', isSafeColour('#f0a'))
check('a hex triplet with alpha', isSafeColour('#f0a8'))
check('a full hex triplet', isSafeColour('#ffd76a'))
check('a full hex triplet with alpha', isSafeColour('#ffd76a80'))
check('uppercase is fine', isSafeColour('#FFD76A'))
check('a keyword', isSafeColour('white'))
check('a keyword in any case', isSafeColour('WHITE'))
check('surrounding space is not a reason to refuse', isSafeColour('  #ffffff  '))

// The values that turn a style parameter into something else entirely. Each is a
// query parameter the page drops straight into a custom property.
check('a declaration is not a colour', !isSafeColour('red; background: url(https://elsewhere/x)'))
check('a url is not a colour', !isSafeColour('url(https://elsewhere)'))
check('a gradient is not a colour', !isSafeColour('linear-gradient(red, blue)'))
check('an expression is not a colour', !isSafeColour('var(--nope)'))
check('an rgb is not a colour', !isSafeColour('rgb(1,2,3)'))
check('a name that is not in the list is not a colour', !isSafeColour('rebeccapurple'))
check('a variable reference is not a colour', !isSafeColour('$x'))
check('an empty field is not a colour', !isSafeColour('   '))
check('five hex digits are not six', !isSafeColour('#ffd76a0'))
check('two hex digits are not three', !isSafeColour('#ff'))

console.log('an unusable colour falls back rather than passing through')
check('a safe one is kept', resolveColour('#ffd76a', '#fff') === '#ffd76a')
check('a declaration falls back', resolveColour('red; x:y', '#fff') === '#fff')
check('a non-string falls back', resolveColour(42, '#fff') === '#fff')
check('nothing at all falls back', resolveColour(undefined, '#fff') === '#fff')

console.log('numbers that are not numbers')
check('a number in range is kept', clampNumber(24, 8, 96, 22) === 24)
check('below the floor is raised', clampNumber(2, 8, 96, 22) === OVERLAY_SIZE.min)
check('above the ceiling is lowered', clampNumber(500, 8, 96, 22) === OVERLAY_SIZE.max)
// A number field passes `NaN` through halfway through an edit, and `NaN` becomes
// a URL carrying `NaN` and a font size of nothing at all.
check('an empty field is the default, not zero', clampNumber('', 8, 96, 22) === 22)
check('NaN is the default', clampNumber(Number.NaN, 8, 96, 22) === 22)
check('a word is the default', clampNumber('wide', 8, 96, 22) === 22)
check('nothing at all is the default', clampNumber(undefined, 8, 96, 22) === 22)
check('null is the default too', clampNumber(null, 8, 96, 22) === 22)
// Non-finite is missing rather than enormous. Infinity is not a size anybody
// meant to ask for, and rounding it to the ceiling would look like it worked.
check('infinity is the default', clampNumber(Number.POSITIVE_INFINITY, 8, 96, 22) === 22)
check('a numeric string is read as a number', clampNumber('30', 8, 96, 22) === 30)
check('and whitespace around one still is', clampNumber(' 30 ', 8, 96, 22) === 30)

console.log('the gap between messages')
check('a value in range is kept', resolveStyle({ delay: 250 }).delay === 250)
check('rounded, because a fractional timer is not a thing', resolveStyle({ delay: 249.6 }).delay === 250)
// Below the floor the messages come faster than anyone reads them, which is the
// wall of text this setting exists to stop.
check('below the floor is raised', resolveStyle({ delay: 10 }).delay === OVERLAY_DELAY.min)
check('past the ceiling is lowered', resolveStyle({ delay: 99_999 }).delay === OVERLAY_DELAY.max)
// A number field passes `NaN` through halfway through an edit, and a gap that is
// not a number is a message that appears at some unpredictable time or never.
check('NaN is the default', resolveStyle({ delay: Number.NaN }).delay === 500)
check('a blank field is the default', resolveStyle({ delay: '' }).delay === 500)
check('nothing at all is the default', resolveStyle({}).delay === 500)
// And the default has to be one the page would also accept, or the link in the
// settings and the page that serves it disagree about the same number.
check('the default is inside its own bounds', resolveStyle({ delay: OVERLAY_DEFAULT_STYLE.delay }).delay === OVERLAY_DEFAULT_STYLE.delay)

console.log('rows are whole numbers')
check('a whole number is kept', clampRows(8, 8) === 8)
check('a fraction is rounded, not floored', clampRows(7.6, 8) === 8)
check('zero rows is raised to one', clampRows(0, 8) === OVERLAY_MAX_ROWS.min)
check('an absurd count is lowered', clampRows(500, 8) === OVERLAY_MAX_ROWS.max)
check('NaN is the default', clampRows(Number.NaN, 8) === 8)

console.log('a font stack that cannot end a declaration')
check('a quoted stack is kept', resolveOverlayFont('"Segoe UI", system-ui, sans-serif') === '"Segoe UI", system-ui, sans-serif')
check('a single name is kept', resolveOverlayFont('Inter'))
// A semicolon is where one CSS declaration stops and the next begins. This value
// is written into a custom property with no escaping, so one here would let
// whatever follows be applied too.
check('a semicolon is refused', resolveOverlayFont('Inter; color: red') === OVERLAY_DEFAULT_STYLE.font)
check('a brace is refused', resolveOverlayFont('Inter } body { display: none') === OVERLAY_DEFAULT_STYLE.font)
check('an opening brace is refused', resolveOverlayFont('Inter{') === OVERLAY_DEFAULT_STYLE.font)
check('a newline is refused', resolveOverlayFont('Inter\nsans-serif') === OVERLAY_DEFAULT_STYLE.font)
check('an empty field falls back', resolveOverlayFont('   ') === OVERLAY_DEFAULT_STYLE.font)
check('an absurdly long stack falls back', resolveOverlayFont('a'.repeat(500)) === OVERLAY_DEFAULT_STYLE.font)
check('a non-string falls back', resolveOverlayFont(42) === OVERLAY_DEFAULT_STYLE.font)

console.log('a styling read back out of storage')
check('nothing saved gives the defaults', JSON.stringify(resolveStyle(undefined)) === JSON.stringify(OVERLAY_DEFAULT_STYLE), JSON.stringify(resolveStyle(undefined)))
check('nothing at all gives the defaults', JSON.stringify(resolveStyle(null)) === JSON.stringify(OVERLAY_DEFAULT_STYLE))
const saved = resolveStyle({ size: 30, max: 12, bg: 0.4, nameColour: '#00ff00', textColour: 'black', font: 'Inter' })
check('a good one is taken as given', saved.size === 30 && saved.max === 12 && saved.bg === 0.4, JSON.stringify(saved))
check('including its colours', saved.nameColour === '#00ff00' && saved.textColour === 'black')
check('and its font', saved.font === 'Inter')
const junk = resolveStyle({ size: Number.NaN, max: -3, bg: 9, nameColour: 'evil', textColour: 'red;x', font: 'a;b' })
check('and a bad one falls back field by field', junk.size === 22 && junk.max === 1 && junk.bg === 1, JSON.stringify(junk))
check('leaving the ones that were fine alone', junk.nameColour === OVERLAY_DEFAULT_STYLE.nameColour && junk.font === OVERLAY_DEFAULT_STYLE.font)
// One poisoned field must not take the rest down with it, and must not leave the
// overlay unconfigured either.
check('the result is always complete', Object.keys(junk).length === Object.keys(OVERLAY_DEFAULT_STYLE).length)
// Resolving twice changes nothing: whatever comes out is something a second pass
// would accept, which is what makes it safe to run on load and on every change.
check('every resolved styling is itself safe', JSON.stringify(resolveStyle(junk)) === JSON.stringify(junk))

console.log('the defaults the page agrees with')
check('the size bounds are the ones the page enforces', OVERLAY_SIZE.min === 8 && OVERLAY_SIZE.max === 96)
check('the row bounds are the ones the page enforces', OVERLAY_MAX_ROWS.min === 1 && OVERLAY_MAX_ROWS.max === 50)
check('a default size inside its own bounds', OVERLAY_DEFAULT_STYLE.size >= OVERLAY_SIZE.min && OVERLAY_DEFAULT_STYLE.size <= OVERLAY_SIZE.max)
check('a default row count inside its own bounds', OVERLAY_DEFAULT_STYLE.max >= OVERLAY_MAX_ROWS.min && OVERLAY_DEFAULT_STYLE.max <= OVERLAY_MAX_ROWS.max)
// The page has its own copy of these numbers and no way to read this file, so a
// default that fell outside its own range would render differently in OBS than
// the settings say.
check('the defaults pass the same check the saved ones do', JSON.stringify(resolveStyle(OVERLAY_DEFAULT_STYLE)) === JSON.stringify(OVERLAY_DEFAULT_STYLE))
check('the default colours are colours the page will accept', isSafeColour(OVERLAY_DEFAULT_STYLE.nameColour) && isSafeColour(OVERLAY_DEFAULT_STYLE.textColour))
check('the default font is a font the page will accept', resolveOverlayFont(OVERLAY_DEFAULT_STYLE.font) === OVERLAY_DEFAULT_STYLE.font)
check('the default background is see-through', OVERLAY_DEFAULT_STYLE.bg === 0)

console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)