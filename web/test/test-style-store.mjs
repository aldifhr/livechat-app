/**
 * The stored form of a style, checked without a browser.
 *
 * The failure this is here to catch is the silent one. A room's saved styling is
 * stored under namespaced keys — `overlaySize`, `overlayBg` — while every reader in
 * the app uses plain field names. Hand the stored form to a reader expecting field
 * names and it finds nothing, falls back to its defaults, and reports success. The
 * styling is gone and nothing anywhere says so.
 *
 * So: the real config that was on disk is the input, and the style that comes out
 * has to be the one that was saved. Run with: npm test (from web/)
 */

import {
  BOARD_DEFAULT_STYLE,
  chatStyleFromQuery,
  chatStyleToQuery,
  chatStyleToStored,
  boardStyleToStored,
  boardStyleFromQuery,
  resolveBoardStyle,
  resolveStyle,
  styleFromStored,
  OVERLAY_DEFAULT_STYLE,
} from '../../shared/overlay.ts'

let failures = 0
function check(name, ok) {
  if (ok) {
    console.log(`  ok    ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${name}`)
  }
}

// The exact config that was on the room store at the time this was written, keys
// and all. Not a shape invented for the test — a copy of the real thing.
const ON_DISK = {
  overlaySize: 30,
  overlayNameColour: '#ff00aa',
  overlayTextColour: '#00ffcc',
  overlayBg: 0.42,
  overlayMax: 12,
  overlayDelay: 900,
  overlayFont: '"Comic Sans MS", cursive',
}

const read = resolveStyle(styleFromStored(ON_DISK))

check('a stored size comes back', read.size === 30)
check('a stored max comes back', read.max === 12)
check('a stored delay comes back', read.delay === 900)
check('a stored background comes back as bg', read.bg === 0.42)
check('a stored name colour comes back', read.nameColour === '#ff00aa')
check('a stored text colour comes back', read.textColour === '#00ffcc')
check('a stored font comes back', read.font === '"Comic Sans MS", cursive')

// The whole point: a field the reader asks for by its own name has to be filled.
check('nothing fell back to the default size', read.size !== OVERLAY_DEFAULT_STYLE.size)
check('nothing fell back to the default colour', read.nameColour !== OVERLAY_DEFAULT_STYLE.nameColour)

// An unstyled room must look exactly as it always did: no config, all defaults.
const bare = resolveStyle(styleFromStored({}))
check('an empty config gives the defaults', JSON.stringify(bare) === JSON.stringify(OVERLAY_DEFAULT_STYLE))
check('a missing config gives the defaults too', JSON.stringify(resolveStyle(styleFromStored(null))) === JSON.stringify(OVERLAY_DEFAULT_STYLE))
check('a non-object config gives the defaults', JSON.stringify(resolveStyle(styleFromStored('nonsense'))) === JSON.stringify(OVERLAY_DEFAULT_STYLE))

// A config carrying keys that mean nothing here must not become styling.
const noisy = resolveStyle(styleFromStored({ ...ON_DISK, somethingElse: 'x', overlay: { a: 1 } }))
check('unknown keys are ignored', noisy.size === 30 && noisy.font === ON_DISK.overlayFont)

// A round trip through the stored form loses nothing.
const saved = chatStyleToStored(read)
const reread = resolveStyle(styleFromStored(saved))
check('a style survives being written and read back', JSON.stringify(reread) === JSON.stringify(read))

// Values the page would refuse are clamped on the way out, not carried through.
const wild = resolveStyle(styleFromStored({ ...ON_DISK, overlaySize: 9000, overlayBg: 47, overlayMax: -3 }))
check('an absurd stored size is clamped', wild.size <= 96)
check('an absurd stored background is clamped', wild.bg >= 0 && wild.bg <= 1)
check('a negative stored max is clamped', wild.max >= 1)

// The board reads the same stored config under different rules, and has one field
// the chat does not have at all.
const board = resolveBoardStyle(styleFromStored({ ...ON_DISK, overlayTitle: 'Top Yapping' }))
check('the board reads the shared fields', board.size === 30 && board.max === 12 && board.bg === 0.42)
check('the board reads its own title', board.title === 'Top Yapping')
check('a board with no title gets the default', resolveBoardStyle(styleFromStored({})).title === BOARD_DEFAULT_STYLE.title)

const boardSaved = boardStyleToStored(board)
check('the board writes its title', boardSaved.overlayTitle === 'Top Yapping')
check('the board leaves the chat delay alone', !('overlayDelay' in boardSaved))
check('a board round trip is lossless for its own fields', resolveBoardStyle(styleFromStored(boardSaved)).title === 'Top Yapping')

// The stored form and the query form are different vocabularies. Conflating them is
// the mistake that started all this, so it is pinned: what goes in a link is not
// what goes in the store.
check('a link spells it bg, the store spells it overlayBg', 'bg' in chatStyleToQuery(read) && 'overlayBg' in saved)
check('a link has no namespaced key', !Object.keys(chatStyleToQuery(read)).some((k) => k.startsWith('overlay')))
check('the store has no bare key', !Object.keys(saved).some((k) => !k.startsWith('overlay')))
check('a link and a store agree on the value', chatStyleToQuery(read).size === String(saved.overlaySize))

// And the two are genuinely separate readers, not one wearing the other's keys.
const viaLink = chatStyleFromQuery('?' + new URLSearchParams(chatStyleToQuery(read)).toString())
check('the link reader and the store reader agree', viaLink.size === read.size && viaLink.bg === read.bg)
const viaBoardLink = boardStyleFromQuery('?' + new URLSearchParams({ size: '44', title: 'Chattiest' }).toString())
check('the board link reader is independent', viaBoardLink.size === 44 && viaBoardLink.title === 'Chattiest' && viaBoardLink.max === BOARD_DEFAULT_STYLE.max)

console.log()
if (failures > 0) {
  console.log(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')