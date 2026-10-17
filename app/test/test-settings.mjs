/**
 * Settings read-back tests.
 *
 * A settings profile is written by one build and read by another, so the only
 * interesting inputs are the ones this build did not write: a value from a
 * removed feature, a field that did not exist yet, a hand-edited file, a number
 * outside the range the control offers. None of that shows up in the app as an
 * error — it shows up as a setting that silently stops taking effect, which is
 * why it is pinned here rather than left to the dialog.
 *
 * The bug these tests were written for: `fontScale` was clamped on the ctrl+scroll
 * path but never on the way out of `localStorage`, so a profile carrying
 * `fontScale: 999` reached `--feed-font-scale` and set the feed's type to 999x.
 */

import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
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

// Bundled rather than compiled with tsc: the schema imports `zod`, and a bare
// specifier inside a tsc-emitted file would be resolved from the temp dir, which
// has no node_modules above it. Vite resolves from the project root instead.
const outDir = mkdtempSync(join(tmpdir(), 'settings-test-'))
writeFileSync(join(outDir, 'entry.ts'), "export * from '@/lib/settings-schema'\n")
const { build } = await import('vite')
await build({
  root: pkgRoot,
  logLevel: 'error',
  define: { 'process.env.NODE_ENV': '"development"' },
  build: {
    outDir,
    emptyOutDir: false,
    minify: false,
    target: 'esnext',
    lib: {
      entry: join(outDir, 'entry.ts'),
      formats: ['es'],
      fileName: () => 'settings.js',
    },
  },
})
writeFileSync(join(outDir, 'package.json'), JSON.stringify({ type: 'module' }))
symlinkSync(join(pkgRoot, 'node_modules'), join(outDir, 'node_modules'), 'junction')

const { parseSettings, DEFAULT_SETTINGS } = await import(
  pathToFileURL(join(outDir, 'settings.js')).href
)

const loaded = (over = {}) => parseSettings(over)

console.log('nothing to read')
check('no profile at all is the defaults', JSON.stringify(parseSettings(undefined)) === JSON.stringify(DEFAULT_SETTINGS))
check(
  'the defaults survive a round trip',
  JSON.stringify(parseSettings(DEFAULT_SETTINGS)) === JSON.stringify(DEFAULT_SETTINGS),
)
check(
  'a profile that is not an object is the defaults',
  JSON.stringify(parseSettings('nonsense')) === JSON.stringify(DEFAULT_SETTINGS),
)
check(
  'an array is not a profile',
  JSON.stringify(parseSettings([1, 2, 3])) === JSON.stringify(DEFAULT_SETTINGS),
)

console.log('the feed type')
check('a font scale past the top is pulled back to it', loaded({ fontScale: 999 }).fontScale === 2)
check('a font scale below the floor is pulled back to it', loaded({ fontScale: 0.01 }).fontScale === 0.75)
check('a font scale that is not a number is the default', loaded({ fontScale: 'big' }).fontScale === 1)
check('a font scale is kept when it is in range', loaded({ fontScale: 1.25 }).fontScale === 1.25)

console.log('choices this build no longer offers')
check('an unknown theme falls back', loaded({ theme: 'neon' }).theme === 'default')
check('an unknown font falls back', loaded({ font: 'comic' }).font === 'sans')
check('an unknown density falls back', loaded({ density: 'spacious' }).density === 'cozy')
check('an unknown pace falls back', loaded({ ttsPace: 'glacial' }).ttsPace === DEFAULT_SETTINGS.ttsPace)
check('an unknown language falls back', loaded({ ttsLanguage: 'tl' }).ttsLanguage === DEFAULT_SETTINGS.ttsLanguage)
check('a known language is kept', loaded({ ttsLanguage: 'ja' }).ttsLanguage === 'ja')
check('a theme of the right name survives', loaded({ theme: 'brutalism' }).theme === 'brutalism')

console.log('numbers outside the range')
check('a volume over 100 is pulled back to 100', loaded({ giftSoundVolume: 5000 }).giftSoundVolume === 100)
check('a negative volume is pulled back to 0', loaded({ chatSoundVolume: -3 }).chatSoundVolume === 0)
check('a gap past half a minute is pulled back', loaded({ giftSoundGapMs: 999999 }).giftSoundGapMs === 30000)
check('a gap below a tenth of a second is pulled back', loaded({ joinSoundGapMs: 1 }).joinSoundGapMs === 100)
check('ttsVolume over 1 becomes 1, not a throwing Audio', loaded({ ttsVolume: 7 }).ttsVolume === 1)
check('ttsVolume below 0 becomes 0', loaded({ ttsVolume: -7 }).ttsVolume === 0)
check('a popup duration is whole seconds', loaded({ giftPopupDurationSeconds: 3.7 }).giftPopupDurationSeconds === 4)
check('a popup duration past the top is pulled back', loaded({ giftPopupDurationSeconds: 99 }).giftPopupDurationSeconds === 10)

console.log('the build that had one custom sound for every event')
const legacy = loaded({
  customSoundPath: '/sounds/chime.wav',
  giftTemplate: 'chime',
  chatTemplate: 'blip',
})
check('the gift keeps the file it was picked for', legacy.giftSoundPath === '/sounds/chime.wav')
check('chat gets it too, since that build shared one file', legacy.chatSoundPath === '/sounds/chime.wav')
check('and arrivals', legacy.joinSoundPath === '/sounds/chime.wav')
check(
  'follows do not, because that build had no path for them',
  legacy.followSoundPath === '' && legacy.shareSoundPath === '',
)
check('the old key is gone from what we save back', !('customSoundPath' in legacy))

console.log('the build that had no per-event paths at all')
const noPaths = loaded({ customSoundPath: '/sounds/pop.wav' })
check('an existing per-event path wins over the shared one', loaded({
  customSoundPath: '/sounds/pop.wav',
  giftSoundPath: '/sounds/gift.wav',
}).giftSoundPath === '/sounds/gift.wav')

console.log('removed features')
const stripped = loaded({ myHandle: 'ana', mentionAlert: true, mentionVoice: true })
check('a removed setting is not carried forward', !('myHandle' in stripped))
check('nor the next one', !('mentionAlert' in stripped))
check('nor the last', !('mentionVoice' in stripped))
check('and the rest of the profile still loads', stripped.theme === DEFAULT_SETTINGS.theme)

console.log('values of the wrong type')
check('a string where a switch belongs is the default, not a truthy one', loaded({ showModeratorBadge: 'yes' }).showModeratorBadge === DEFAULT_SETTINGS.showModeratorBadge)
check('a number where a switch belongs is the default', loaded({ alwaysOnTop: 1 }).alwaysOnTop === DEFAULT_SETTINGS.alwaysOnTop)
check('a path that is not a string is empty', loaded({ giftSoundPath: null }).giftSoundPath === '')
check('an unknown field is dropped rather than saved back', !('somethingNew' in loaded({ somethingNew: 1 })))

console.log('')
if (failures > 0) {
  console.log(`${failures} failed`)
  process.exit(1)
}
console.log('all settings checks passed')