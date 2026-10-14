// The overlay pages exist twice, and both are served.
//
// `web/public/overlay/*.html` is what nginx serves to OBS on the dashboard host,
// and `backend/static/*.html` is what the backend serves on the kit-backend host
// (and reads to bake `?room=` styling). Nothing copies one to the other — they are
// edited by hand — so they drift, and the last time they did, kit-backend served a
// page with the leaderboard mixed into the chat and none of the mention styling,
// while the dashboard served the corrected one. Nothing failed: both addresses
// answered 200 and both looked like an overlay.
//
// `web/public` is the canonical copy. It is the one the dashboard hands to OBS
// (`OVERLAY_ORIGIN` points at the dashboard host) and the one the deliberate
// changes land in — the board removed from the chat overlay, the mention styling
// added — so it is the one that describes what the overlay is meant to be. The
// backend copy must match it, or the kit-backend host serves a different page.
//
// This replaces `test-overlay-server.mjs`, which guarded the same thing and was
// deleted, taking the guard with it.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

const PAIRS = [
  ['chat overlay', 'web/public/overlay/chat-overlay.html', 'backend/static/overlay.html'],
  ['top chatters', 'web/public/overlay/top-chatter.html', 'backend/static/topchatter.html'],
]

let failed = 0
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('the overlay pages are the same file on both hosts')
for (const [label, served, backend] of PAIRS) {
  const a = readFileSync(`${repoRoot}/${served}`, 'utf8')
  const b = readFileSync(`${repoRoot}/${backend}`, 'utf8')
  check(
    `the ${label} page matches`,
    a === b,
    a === b ? '' : `${served} and ${backend} differ — copy web/public over backend/static`,
  )
  // The backend bakes `?room=` styling by string replacement; a copy that lost the
  // placeholder would silently serve the default styling instead of the room's.
  check(`the ${label} page still has the __OVERLAY_CONFIG__ placeholder`, b.includes('__OVERLAY_CONFIG__'))

  // The style block has to be well-formed, and a brace count alone will not say so.
  //
  // An edit once landed between `background: transparent;` and the `overflow:
  // hidden;` that followed it, closing the `html, body` rule early and leaving two
  // declarations and a stray brace outside any rule. The browser drops them without
  // a word: no console error, page renders, and the board quietly lost
  // `overflow: hidden` — so content could run past the canvas in OBS, which is the
  // one thing this page must never do. A brace count catches the early close; the
  // walk catches the declaration that ended up outside it.
  const style = b.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? ''
  check(`the ${label} page has a style block`, style.length > 0)

  let depth = 0
  let minDepth = 0
  for (const ch of style) {
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth < minDepth) minDepth = depth
    }
  }
  check(`the ${label} stylesheet closes every rule it opens`, depth === 0, `depth ${depth}`)
  check(`the ${label} stylesheet closes nothing it did not open`, minDepth === 0, `depth ${minDepth}`)

  // Every declaration outside any rule is a declaration the browser ignores.
  // Comments come out first: they are prose here, and a line of it that happens to
  // contain a colon reads as a declaration to anything walking the source.
  const bare = style.replace(/\/\*[\s\S]*?\*\//g, '')
  const stray = []
  let level = 0
  for (const line of bare.split('\n')) {
    const text = line.trim()
    if (!text) continue
    for (const ch of line) {
      if (ch === '{') level++
      else if (ch === '}') level--
    }
    if (level < 0) level = 0
    if (level === 0 && text.includes(':') && !text.includes('{')) {
      stray.push(text)
    }
  }
  check(
    `the ${label} stylesheet has no declaration outside a rule`,
    stray.length === 0,
    stray.slice(0, 2).join(' | '),
  )
}


/*
 * The defaults, on both sides.
 *
 * `shared/overlay.ts` holds the settings and their bounds because the builder and
 * the page are two readers of one thing: a value the dashboard thinks is fine and
 * the page clamps anyway shows one number in the console and a different one in
 * OBS. The page cannot import that module — it is a standalone file, served by a
 * backend that has no TypeScript — so it repeats the defaults, and the whole
 * arrangement rests on the two copies staying equal.
 *
 * They did not stay equal. Raising the board's default text size changed the shared
 * module and left the page at 28, so an unstyled board rendered at 28 while the
 * slider beside it said 36. This walks both and compares, because the alternative
 * is finding out from a stream.
 */
const shared = readFileSync(`${repoRoot}/shared/overlay.ts`, 'utf8')
const chat = readFileSync(`${repoRoot}/web/public/overlay/chat-overlay.html`, 'utf8')
const board = readFileSync(`${repoRoot}/web/public/overlay/top-chatter.html`, 'utf8')

function sharedDefault(block, field) {
  return new RegExp(`export const ${block}[\\s\\S]*?\\b${field}: ([\\d.]+)`).exec(shared)?.[1]
}
function pageDefault(source, pattern) {
  return new RegExp(pattern).exec(source)?.[1]
}

console.log('the defaults agree on both sides')
const DEFAULTS = [
  ['chat size', sharedDefault('OVERLAY_DEFAULT_STYLE', 'size'),
    pageDefault(chat, "number\\('size', typeof bakedSize === 'number' \\? bakedSize : ([\\d.]+)")],
  ['chat max', sharedDefault('OVERLAY_DEFAULT_STYLE', 'max'),
    pageDefault(chat, "number\\('max', typeof bakedMax === 'number' \\? bakedMax : ([\\d.]+)")],
  ['chat delay', sharedDefault('OVERLAY_DEFAULT_STYLE', 'delay'),
    pageDefault(chat, "number\\('delay', typeof bakedDelay === 'number' \\? bakedDelay : ([\\d.]+)")],
  ['chat bg', sharedDefault('OVERLAY_DEFAULT_STYLE', 'bg'),
    pageDefault(chat, "number\\('bg', typeof bakedBg === 'number' \\? bakedBg : ([\\d.]+)")],
  ['board size', sharedDefault('BOARD_DEFAULT_STYLE', 'size'),
    pageDefault(board, "number\\('size', typeof baked\\.size === 'number' \\? baked\\.size : ([\\d.]+)")],
  ['board bg', sharedDefault('BOARD_DEFAULT_STYLE', 'bg'),
    pageDefault(board, "number\\('bg', typeof baked\\.background === 'number' \\? baked\\.background : ([\\d.]+)")],
]

for (const [label, a, b] of DEFAULTS) {
  check(
    `the ${label} default matches`,
    a !== undefined && a === b,
    a === b ? '' : `shared=${a} page=${b}`,
  )
}

console.log('and each page agrees with itself')
// The comparisons above are page-against-shared. This one is a page against its own
// second copy of the same idea, which is the pair that had drifted.
//
// `STYLE_DEFAULTS` is what the merge resets to before applying a pushed style, so
// it is the page's answer to "what does no styling look like". The `config` literal
// a few lines up is the page's answer to the same question, on load. Two copies of
// one concept, in one file, written out separately — so they can differ, and a
// test comparing either against `shared/` alone will not see it, because each of
// them still matches the shared module.
//
// It did differ, on the chat page: `background` was 0 on load and 0.05 in
// `STYLE_DEFAULTS`, so an overlay that opened fully transparent acquired a faint
// scrim the first time the backend pushed a style for a room whose saved config had
// no `bg` in it. Nothing errored and no assertion failed: the page rendered, and
// rendered differently than it had a moment earlier.
//
// Both pages, because a check covering only the one that happened to be wrong
// leaves the other free to drift the same way.
const RESET_CHECKS = [
  ['chat', chat, "number\\('size', typeof bakedSize === 'number' \\? bakedSize : ([\\d.]+)",
    "number\\('max', typeof bakedMax === 'number' \\? bakedMax : ([\\d.]+)",
    "number\\('delay', typeof bakedDelay === 'number' \\? bakedDelay : ([\\d.]+)",
    "number\\('bg', typeof bakedBg === 'number' \\? bakedBg : ([\\d.]+)"],
  ['board', board, "number\\('size', typeof baked\\.size === 'number' \\? baked\\.size : ([\\d.]+)",
    "number\\('max', typeof baked\\.max === 'number' \\? baked\\.max : ([\\d.]+)",
    null,
    "number\\('bg', typeof baked\\.background === 'number' \\? baked\\.background : ([\\d.]+)"],
]
// Only the numbers. Colours and font stacks are strings, and a string has no
// single spelling to read out of both places — that is what `shared/overlay.ts` and
// `test:overlay.mjs` are for.
const NUMERIC_RESET_KEYS = ['size', 'max', 'delay', 'background']

for (const [pageName, source, ...patterns] of RESET_CHECKS) {
  const styleDefaults = source.slice(source.indexOf('var STYLE_DEFAULTS = {'))
  NUMERIC_RESET_KEYS.forEach((key, index) => {
    const pattern = patterns[index]
    if (!pattern) return
    const onLoad = pageDefault(source, pattern)
    if (onLoad === undefined) return
    const reset = new RegExp(`\\b${key}:\\s*([^,\\n]+)`)
      .exec(styleDefaults)?.[1]
      ?.trim()
      .replace(/^['"]|['"]$/g, '')
    check(
      `${pageName}: resetting ${key} gives back what loading with no styling gives`,
      reset === onLoad,
      reset === onLoad ? '' : `on load=${onLoad} after a reset=${reset}`,
    )
  })
}

console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
