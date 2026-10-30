/**
 * The four overlay pages share a socket client, and it must stay shared.
 *
 * `web/public/overlay/` holds four standalone HTML files — chat-overlay,
 * cat-overlay, top-chatter, like-target — and each carries its own copy of the
 * same WebSocket client: build the URL, resolve a handle to a room id, open the
 * socket, reconnect when it drops. They are separate copies on purpose. See the
 * header of chat-overlay.html:
 *
 *     One file, on purpose. This page is loaded by OBS, not by a person: it is
 *     fetched once when a source is added and then left alone for the length of
 *     a stream. Everything it needs is inline for that reason — a second request
 *     is a second thing that can be slow, and a page that is still arriving is a
 *     page showing nothing on someone's stream.
 *
 * So the duplication is the design, not an accident, and this suite exists to
 * keep the four copies from drifting rather than to collapse them. What it pins:
 *
 *   - the URL is built the same way everywhere, and in particular that the
 *     http->ws conversion happens. cat-overlay.html splits it across two
 *     statements (`const base=BASE.replace(...)` then `base+'/ws/overlay/'+...`)
 *     where the other three write it as one expression. Both are the same
 *     arithmetic; this test normalises whitespace so the two spellings compare
 *     equal, and would fail on a file that skipped the conversion entirely.
 *   - the reconnect beat. 3000 ms after a socket *close*, 5000 ms after a
 *     *resolve* failure. These are two different failures and the two numbers
 *     are deliberate, not a disagreement: a dropped socket is retried quickly
 *     because the backend is probably still there, while a handle that will not
 *     resolve is retried slowly because something is actually wrong.
 *   - every page parses frames defensively and drops what it cannot read.
 *
 * Run with node, like the other suites here:
 *
 *     node test/test-overlay-clients.mjs
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OVERLAY = join(HERE, '..', 'public', 'overlay')

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

/** Whitespace-free, so a one-expression and a two-statement spelling compare equal. */
const squash = (text) => text.replace(/\s+/g, '')

const PAGES = [
  { file: 'chat-overlay.html', resolves: true, socket: 'socket' },
  { file: 'cat-overlay.html', resolves: false, socket: 'chatSocket' },
  { file: 'top-chatter.html', resolves: true, socket: 'socket' },
  { file: 'like-target.html', resolves: true, socket: 'socket' },
]

const sources = new Map()
for (const page of PAGES) {
  sources.set(page.file, readFileSync(join(OVERLAY, page.file), 'utf8'))
}

check('all four overlay pages were read', sources.size === PAGES.length)

// ---------------------------------------------------------------------------
// The URL
// ---------------------------------------------------------------------------

for (const page of PAGES) {
  const flat = squash(sources.get(page.file))

  // The http->ws conversion. Without it the URL is `https://…` handed to the
  // WebSocket constructor, which throws a SyntaxError and the overlay is dark
  // with a console error nobody reads on a stream.
  check(
    `${page.file} converts http to ws`,
    flat.includes("replace(/^http/,'ws')"),
  )

  // The path, and the room id encoded. `encodeURIComponent` matters because a
  // room id is a UUID today but the handle form reaches this code too, and a
  // handle can carry characters that are not legal in a path segment.
  check(`${page.file} appends the overlay path`, flat.includes("'/ws/overlay/'"))
  check(`${page.file} encodes the room id`, flat.includes('encodeURIComponent(roomId)'))

  // And the order: the conversion has to happen before the path is appended,
  // or the page would build `http…/ws/overlay/…` and hand that to the socket.
  const convertAt = flat.indexOf("replace(/^http/,'ws')")
  const pathAt = flat.indexOf("'/ws/overlay/'")
  check(
    `${page.file} converts before it appends the path`,
    convertAt !== -1 && pathAt !== -1 && convertAt < pathAt,
    `convert at ${convertAt}, path at ${pathAt}`,
  )
}

// The one thing that must NOT appear: a socket opened on a URL that never went
// through the conversion. Written as a negative because it is the failure this
// suite is really for — a fifth overlay, or an edit to one of these four, that
// builds `new WebSocket(base + '/ws/overlay/' + id)` from the raw origin.
for (const page of PAGES) {
  const flat = squash(sources.get(page.file))
  const raw = /newWebSocket\((?:BASE|config\.baseUrl|location\.origin)/.test(flat)
  check(`${page.file} never opens a socket on a raw origin`, !raw)
}

// ---------------------------------------------------------------------------
// The reconnect beat
// ---------------------------------------------------------------------------

for (const page of PAGES) {
  const source = sources.get(page.file)

  // A dropped socket is retried on a short beat. Every page does this, and the
  // handler is the one that owns the retry — `onerror` deliberately does not
  // schedule one, because `close` always follows `error` and doing it in both
  // would open two connections per failure.
  const closeBeat = [...source.matchAll(/setTimeout\(\s*connect\w*,\s*(\d+)\s*\)/g)]
    .map((m) => Number(m[1]))
    .filter((ms) => ms === 3000)
  check(
    `${page.file} retries a closed socket after 3000 ms`,
    closeBeat.length >= 1,
    `found ${closeBeat.length}`,
  )
}

// A handle that will not resolve is retried on a longer beat. Only the three
// pages that resolve handles have this path; cat-overlay takes a room id from
// its link and never calls the resolve endpoint.
for (const page of PAGES.filter((p) => p.resolves)) {
  const source = sources.get(page.file)
  const resolveBeat = [...source.matchAll(/setTimeout\(\s*connect\w*,\s*(\d+)\s*\)/g)]
    .map((m) => Number(m[1]))
    .filter((ms) => ms === 5000)
  check(
    `${page.file} retries a failed resolve after 5000 ms`,
    resolveBeat.length >= 1,
    `found ${resolveBeat.length}`,
  )
}

// And cat-overlay is the documented exception: no resolve step, so no 5000 ms
// beat anywhere. Pinned so that adding one is a decision rather than a drift.
const cat = sources.get('cat-overlay.html')
check(
  'cat-overlay has no resolve step, which is why it has no 5000 ms beat',
  !cat.includes('/api/room-connect-by-username') &&
    !/setTimeout\(\s*connect\w*,\s*5000\s*\)/.test(cat),
)

// ---------------------------------------------------------------------------
// Defensive parsing
// ---------------------------------------------------------------------------

for (const page of PAGES) {
  const source = sources.get(page.file)
  const flat = squash(source)
  // A frame that is not JSON must not stop the next good one. Every page wraps
  // the parse; the difference is only in what it does with the failure.
  check(`${page.file} parses frames defensively`, /try\{[^}]*JSON\.parse/.test(flat))

  // And the field access has to be covered too, or a `null` frame — which is
  // what `JSON.parse("null")` returns — throws on `frame.type` and takes the
  // handler with it. Two spellings, both safe: an explicit `if (!frame) return`
  // after a parse that has its own catch, or the field access sitting inside the
  // same try as the parse. cat-overlay uses the second, the other three the
  // first, and this accepts either rather than pinning one house style.
  const guarded = /if\(!frame\)return/.test(flat)
  const innerTry = [...flat.matchAll(/try\{((?:[^{}]|\{[^{}]*\})*)\}catch/g)]
    .some((m) => m[1].includes('JSON.parse') && m[1].includes('frame.type'))
  check(
    `${page.file} covers the field access, not just the parse`,
    guarded || innerTry,
    `explicit guard: ${guarded}, inside the parse's try: ${innerTry}`,
  )
}

// ---------------------------------------------------------------------------
// The one thing all four must keep agreeing on: the endpoint they resolve to
// ---------------------------------------------------------------------------

for (const page of PAGES.filter((p) => p.resolves)) {
  check(
    `${page.file} resolves through the backend's own route`,
    sources.get(page.file).includes('/api/room-connect-by-username'),
  )
}

console.log(`\nall checks passed (${passed})`)
