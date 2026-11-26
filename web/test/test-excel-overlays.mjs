/**
 * The two Excel meme backgrounds — horizontal and vertical.
 *
 * These are not the four shared-client overlays (chat, cat, top-chatter,
 * like-target). They pair a static SVG artwork with a live HTML comment layer,
 * and that pairing has its own contract which the shared suite does not cover:
 *
 *   - the artwork and the live layer live in ONE fixed-aspect frame, sized in
 *     JS to `min(innerWidth/W, innerHeight/H)` and exposed as `--s`. The SVG
 *     scales by viewBox; every HTML dimension is `calc(Npx * var(--s,1))`.
 *     A CSS `transform: scale()` on the stage rasterises text and blurs on
 *     stream; `vw`/`vh` units let the HTML drift out of the letterboxed SVG
 *     when the browser source has a different aspect ratio. Both are pinned
 *     absent here.
 *   - the card geometry (width, margin, gap, padding) scales with `--s` too,
 *     not just the fonts — a raw-px card overruns the panel at small sizes and
 *     pushes its timestamp out of view.
 *   - the socket client still builds the URL the same way, reconnects on the
 *     same beats, parses defensively, and renders ONLY comment frames.
 *   - the copy is editable: marked `data-k` nodes are overwritten from query
 *     parameters, and the page carries the `__OVERLAY_CONFIG__` placeholder the
 *     route handler bakes the backend origin into.
 *
 * Run with node, like the other suites here:
 *
 *     node test/test-excel-overlays.mjs
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OVERLAY = join(HERE, '..', 'public', 'overlay')
const ROUTE = join(HERE, '..', 'src', 'app', 'overlay', '[name]', 'route.ts')

let passed = 0
function check(label, cond, detail = '') {
  if (cond) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    console.log(`  FAIL ${label}   ${detail}`)
    process.exit(1)
  }
}
const squash = (text) => text.replace(/\s+/g, '')

const PAGES = [
  { file: 'background-excel-vertical.html', name: 'background-excel-vertical', w: 1080, h: 1920, max: 2 },
]

const sources = new Map()
for (const page of PAGES) sources.set(page.file, readFileSync(join(OVERLAY, page.file), 'utf8'))
const route = readFileSync(ROUTE, 'utf8')
check('the Excel overlay page was read', sources.size === PAGES.length)

// ---------------------------------------------------------------------------
// Registered so the route handler actually serves them
// ---------------------------------------------------------------------------
for (const page of PAGES) {
  check(`${page.name} is registered in the OVERLAYS map`, route.includes(`'${page.name}': '${page.file}'`))
}

// ---------------------------------------------------------------------------
// The socket client (same arithmetic as the shared overlays)
// ---------------------------------------------------------------------------
for (const page of PAGES) {
  const flat = squash(sources.get(page.file))
  check(`${page.file} converts http to ws`, flat.includes("replace(/^http/,'ws')"))
  check(`${page.file} appends the overlay path`, flat.includes("'/ws/overlay/'"))
  check(`${page.file} encodes the room id`, flat.includes('encodeURIComponent(id)'))
  const convertAt = flat.indexOf("replace(/^http/,'ws')")
  const pathAt = flat.indexOf("'/ws/overlay/'")
  check(`${page.file} converts before it appends the path`, convertAt !== -1 && pathAt !== -1 && convertAt < pathAt)
  check(`${page.file} never opens a socket on a raw origin`, !/newWebSocket\((?:base|BASE|config\.baseUrl|location\.origin)\+/.test(flat))
}

// ---------------------------------------------------------------------------
// Reconnect beats: 3000 ms on close, 5000 ms on a failed resolve
// ---------------------------------------------------------------------------
for (const page of PAGES) {
  const source = sources.get(page.file)
  const beats = [...source.matchAll(/later\((\d+)\)/g)].map((m) => Number(m[1]))
  check(`${page.file} retries a closed socket after 3000 ms`, beats.includes(3000))
  check(`${page.file} retries a failed resolve after 5000 ms`, beats.includes(5000))
  check(`${page.file} resolves through the backend's own route`, source.includes('/api/room-connect-by-username'))
}

// ---------------------------------------------------------------------------
// Defensive parsing, and comment-only rendering
// ---------------------------------------------------------------------------
for (const page of PAGES) {
  const flat = squash(sources.get(page.file))
  check(`${page.file} parses frames defensively`, /try\{[^}]*JSON\.parse/.test(flat))
  // A null frame (JSON.parse("null")) must not throw on field access. These
  // pages guard with `if (frame && frame.type === 'comment')`.
  check(`${page.file} null-guards the frame before reading its type`, /if\((?:frame|fr)&&(?:frame|fr)\.type/.test(flat))
  check(`${page.file} renders only comment frames`, /fr?\.type==='comment'/.test(flat))
}

// ---------------------------------------------------------------------------
// The fixed-aspect frame: vector scale, never a transform, never vw/vh
// ---------------------------------------------------------------------------
for (const page of PAGES) {
  const source = sources.get(page.file)
  const flat = squash(source)
  check(`${page.file} never CSS-transforms the stage`, !source.includes('style.transform'))
  check(`${page.file} scales the SVG by viewBox at 100%`, source.includes('svg{display:block;width:100%;height:100%}'))
  check(
    `${page.file} fits the frame to its native ${page.w}x${page.h} aspect`,
    source.includes(`Math.min(innerWidth / ${page.w}, innerHeight / ${page.h})`),
  )
  check(`${page.file} exposes the scale as --s (string)`, /setProperty\('--s', String\([a-z]\)\)/.test(source))
  check(`${page.file} uses no vw/vh units`, !/[0-9.]+v[wh]\b/.test(source))
}

// ---------------------------------------------------------------------------
// Card geometry scales with --s, not just fonts (the timestamp-overflow bug)
// ---------------------------------------------------------------------------
for (const page of PAGES) {
  const source = sources.get(page.file)
  const card = (source.match(/\.live-card\{[^}]*\}/) || [''])[0]
  const head = (source.match(/\.live-head\{[^}]*\}/) || [''])[0]
  check(`${page.file} scales the card width`, /width:calc\([0-9]+px \* var\(--s,1\)\)/.test(card))
  check(`${page.file} scales the card margin`, /margin:[^;]*var\(--s,1\)/.test(card))
  check(`${page.file} scales the head gap`, /gap:calc\([0-9]+px \* var\(--s,1\)\)/.test(head))
  check(`${page.file} scales the text font`, /\.live-text\{[^}]*font-size:calc\([0-9.]+px \* var\(--s,1\)\)/.test(source))
}

// ---------------------------------------------------------------------------
// Editable copy + the baked config + the card cap
// ---------------------------------------------------------------------------
for (const page of PAGES) {
  const source = sources.get(page.file)
  check(`${page.file} marks editable copy with data-k`, source.includes('data-k="'))
  check(`${page.file} overwrites data-k from query parameters`, squash(source).includes("querySelectorAll('[data-k]')"))
  check(`${page.file} carries the baked config placeholder`, source.includes('__OVERLAY_CONFIG__'))
  check(`${page.file} caps the feed at ${page.max} cards`, source.includes(`MAX = ${page.max}`))
  check(`${page.file} trims old cards beyond the cap`, squash(source).includes('while(feed.children.length>MAX)feed.removeChild(feed.firstChild)'))
}

// The undo/redo pair in each artwork must be one shape mirrored, never two
// hand-drawn twins: the old redo had a translate(-10) fudge and sat visibly
// lower once LIVE Studio scaled the source.
for (const page of PAGES) {
  const source = sources.get(page.file)
  check(`${page.file} mirrors its forward arrow from one shape`, /<use href="#[^"]+" transform="translate\(\d+ 0\) scale\(-1 1\)"\/>/.test(source))
  check(`${page.file} has no hand-drawn arrow twin`, !/translate\(-10 0\)/.test(source))
  // The pair must sit on the same optical row as the X icon beside it, not
  // a few pixels low. Measured centres: vertical X=123, horizontal X=15.
  const expected = ['M770 116', 'points="778,100 778,132 756,116"']
  for (const fragment of expected) {
    check(`${page.file} keeps the arrows on the header row (${fragment.slice(0, 16)})`, source.includes(fragment))
  }
}

// Chat behaviour: a busy live must not replace a card before it is read,
// emoji initials must not split a surrogate pair, and a handle must be
// resolved only once across reconnects.
const script = sources.get('background-excel-vertical.html')
const flatScript = squash(script)
check('hole stops before the TOTAL row', script.includes('w: 960, h: 540'))
check('hole comment states the Comments-panel limit', script.includes('y+h <= 1404'))
check('the status note sits below the Comments header', script.includes('top:77.5%') && !script.includes('top:74.1667%'))
check('long comments use ellipsis on one line', /\.live-text\{[^}]*white-space:nowrap[^}]*text-overflow:ellipsis/.test(script))
check('avatar initials survive emoji usernames', script.includes('function initial(n)') && script.includes('Array.from(n)[0]'))
check('avatars do not leak a referrer to the CDN', flatScript.includes("img.referrerPolicy='no-referrer'"))
check('an @handle is normalised', flatScript.includes("room=(q.get('room')||'').trim().replace(/^@/,'')"))
check('missing room and missing base have different messages', script.includes('tambahkan ?room=<username atau id> di link') && script.includes('baseUrl kosong: __OVERLAY_CONFIG__ belum diganti'))
check('the resolved room id is cached', flatScript.includes('varresolved=null') && flatScript.includes('if(resolved){openSocket(resolved);return}') && flatScript.includes('resolved=d.room_id'))
check('frames go through the paced queue', flatScript.includes('functionpush(fr)') && flatScript.includes('},1800)') && flatScript.includes("if(fr&&fr.type==='comment')push(fr)"))
check('the socket opener no longer shadows window.open', script.includes('function openSocket(') && !script.includes('function open('))

// Status bar: the clock follows the device, and every icon shares the y=46 baseline.
const vertical = sources.get('background-excel-vertical.html')
check('status clock is live and localised', vertical.includes('data-k="time" data-live') && vertical.includes("toLocaleTimeString('id-ID'"))
check('a pinned ?time= freezes the live clock', vertical.includes("if (k === 'time') el.removeAttribute('data-live')"))
check('cellular uses a filled wedge, not four stubby bars', vertical.includes('M868 46 V39 L895 12') && !vertical.includes('x=\"880\" y=\"34\"'))
check('wifi arcs are bold with rounded caps', vertical.includes('stroke-width=\"5\" stroke-linecap=\"round\"'))

check('wifi dot shares the signal/battery baseline', vertical.includes('cy="42.5" r="3.5"') && !vertical.includes('cy="52"'))

console.log(`\nall checks passed (${passed})`)
