// The overlay pages, and the fact there is exactly one copy of each.
//
// This file used to guard a duplication: `web/public/overlay/*.html` for the host that
// nginx serves to OBS, and a hand-kept twin in `backend/static/*.html` for the backend
// to serve and to bake `?room=` styling into. Nothing copied one to the other, so they
// drifted. They did drift — the chat pair was nineteen lines apart at the time this was
// last touched, and the eight assertions in `test-overlay-page.mjs` were reading the
// stale twin, so a feature that had shipped to the dashboard was failing its own tests.
//
// The duplication is gone. The pages are served by nginx from disk, off the dashboard
// host, because a browser source in OBS has to keep working while the dashboard
// restarts — it cannot depend on a server rendering a page. The styling the backend used
// to bake in was already being pushed to every overlay as a `config` frame the moment
// its socket opened, so it arrived twice, and only on an address no link pointed at.
//
// So there is no second copy left to compare. What this guards now is the shape of the
// one that remains: that it is well-formed, that every page on disk is actually routed
// and actually addressable, that its defaults still agree with the shared contract, and
// that nobody quietly adds a second copy back.
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const overlayDir = `${repoRoot}/web/public/overlay`

let failed = 0
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const pages = readdirSync(overlayDir).filter(f => f.endsWith('.html')).sort()
check('the overlay pages are there', pages.length > 0, `${pages.length} found`)

console.log('there is only one copy of each')
// The drift above was possible only because a second file existed. Assert its absence,
// because the way it comes back is someone adding a route and copying the file next to
// it "just to be safe" — which is how it started.
{
  const backendStatic = `${repoRoot}/backend/static`
  if (existsSync(backendStatic)) {
    const strays = readdirSync(backendStatic).filter(f => f.endsWith('.html'))
    check(
      'no overlay HTML left in backend/static',
      strays.length === 0,
      strays.join(', ') + ' — the pages are served by nginx from web/public; a copy here is how they drifted before',
    )
  } else {
    check('no overlay HTML left in backend/static', true)
  }
  const router = `${repoRoot}/backend/routes/overlay.py`
  check(
    'backend/routes/overlay.py is gone',
    !existsSync(router),
    existsSync(router) ? 'the backend serves overlay pages again, and a second copy of each will follow' : '',
  )
}

console.log('and each page is well-formed')
for (const file of pages) {
  const source = readFileSync(`${overlayDir}/${file}`, 'utf8')

  // The Next route bakes `{ baseUrl }` into this slot so the page's socket can reach
  // the backend. A copy that lost the placeholder would silently fall back to its own
  // origin and sit there reconnecting to a host with no /ws/ on it.
  check(`the ${file} page has the __OVERLAY_CONFIG__ placeholder`, source.includes('__OVERLAY_CONFIG__'))

  // The style block has to be well-formed, and a brace count alone will not say so.
  //
  // An edit once landed between `background: transparent;` and the `overflow: hidden;`
  // that followed it, closing the `html, body` rule early and leaving two declarations
  // and a stray brace outside any rule. The browser drops them without a word: no console
  // error, page renders, and the board quietly lost `overflow: hidden` — so content could
  // run past the canvas in OBS, which is the one thing this page must never do. A brace
  // count catches the early close; the walk catches the declaration left outside it.
  const style = source.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? ''
  check(`the ${file} page has a style block`, style.length > 0)

  let depth = 0
  let minDepth = 0
  for (const ch of style) {
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth < minDepth) minDepth = depth
    }
  }
  check(`the ${file} stylesheet closes every rule it opens`, depth === 0, `depth ${depth}`)
  check(`the ${file} stylesheet closes nothing it did not open`, minDepth === 0, `depth ${minDepth}`)

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
    if (level === 0 && text.includes(':') && !text.includes('{')) stray.push(text)
  }
  check(
    `the ${file} stylesheet has no declaration outside a rule`,
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
 * OBS. The page cannot import that module — it is a standalone file, served as a
 * static asset by nginx with no TypeScript anywhere near it — so it repeats the
 * defaults, and the whole arrangement rests on the two agreeing.
 *
 * They did not agree. Raising the board's default text size changed the shared
 * module and left the page at 28, so an unstyled board rendered at 28 while the
 * slider beside it said 36. This walks both and compares, because the alternative
 * is finding out from a stream.
 */
const shared = readFileSync(`${repoRoot}/shared/overlay.ts`, 'utf8')
const chat = readFileSync(`${overlayDir}/chat-overlay.html`, 'utf8')
const board = readFileSync(`${overlayDir}/top-chatter.html`, 'utf8')

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
  check(`the ${label} default matches`, a !== undefined && a === b, a === b ? '' : `shared=${a} page=${b}`)
}

console.log('and each page agrees with itself')
// The comparisons above are page-against-shared. This one is a page against its own
// second copy of the same idea, which is the pair that had drifted.
//
// `STYLE_DEFAULTS` is what the merge resets to before applying a pushed style, so it
// is the page's answer to "what does no styling look like". The config read a few lines
// up is the page's answer to the same question, on load. Two copies of one concept, in
// one file, written out separately — so they can differ, and a test comparing either
// against `shared/` alone will not see it, because each of them still matches the shared
// module.
//
// It did differ, on the chat page: `background` was 0 on load and 0.05 in
// `STYLE_DEFAULTS`, so an overlay that opened fully transparent acquired a faint scrim
// the first time the backend pushed a style for a room whose saved config had no `bg`
// in it. Nothing errored and no assertion failed: the page rendered, and rendered
// differently than it had a moment earlier.
//
// Both pages, because a check covering only the one that happened to be wrong leaves
// the other free to drift the same way.
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

console.log('and every page is actually reachable')
// The list of pages is read off disk, and the routing is hand-written in two places:
// the Next route handler for development, and nginx for production. A page added to
// `web/public/overlay/` and not wired into either is a file nothing points at — which is
// exactly how the cat overlay shipped: staged for nginx, listed on the stream page, and
// 404ing from the one link a streamer was ever handed.
{
  const route = readFileSync(`${repoRoot}/web/src/app/overlay/[name]/route.ts`, 'utf8')
  const routed = new Set(
    [...route.matchAll(/'([a-z0-9-]+)':\s*'([a-z0-9-]+\.html)'/g)].map(m => m[2]),
  )
  for (const file of pages) {
    check(`the ${file} page has a route in app/overlay/[name]`, routed.has(file), 'add it to OVERLAYS in route.ts')
  }

  const nginx = readFileSync(`${repoRoot}/deploy/nginx/snippets/streamtools-overlays.conf`, 'utf8')
  const block = nginx.match(/location ~ \^\/overlay\/\(([^)]+)\)\\\.html\$/)
  const inNginx = new Set((block?.[1] ?? '').split('|'))
  // The slash before `{` is optional so this matches both spellings of each address;
  // the captured group leaves it off, which is what the check below wants to compare.
  const rewrites = [...nginx.matchAll(/location = (\/overlay\/[a-z0-9-]+)\/?\s*\{/g)].map(m => m[1])
  for (const file of pages) {
    const slug = file.replace(/\.html$/, '')
    check(`the ${file} page is addressable in nginx`, inNginx.has(slug), 'add it to the location ~ regex in streamtools-overlays.conf')
    // Both spellings, because a pasted URL will not always have the trailing slash and
    // a 404 there is a black rectangle in OBS rather than an error anyone reads.
    const both = new Set(
      [...nginx.matchAll(new RegExp(`location = (/overlay/${slug}/?)\\s*\\{`, 'g'))].map(m => m[1]),
    )
    check(
      `the ${file} page answers with and without a trailing slash`,
      both.has(`/overlay/${slug}`) && both.has(`/overlay/${slug}/`),
      `found ${[...both].join(', ') || 'nothing'} — add "location = /overlay/${slug}" and "/overlay/${slug}/" in streamtools-overlays.conf`,
    )
  }

  // The dashboard hands out extensionless URLs built from its own origin, so those are
  // the addresses that have to resolve. `/overlay` and `/topchatter` are the two older
  // spellings, kept because links pasted before the split still point at them.
  const nextConfig = readFileSync(`${repoRoot}/web/next.config.ts`, 'utf8')
  check(
    'the bare /overlay still redirects, for links pasted before the split',
    /source: '\/overlay',\s*destination: '\/overlay\/chat-overlay'/.test(nextConfig),
    'add it to rewrites() in next.config.ts',
  )
}

console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`)
process.exit(failed === 0 ? 0 : 1)