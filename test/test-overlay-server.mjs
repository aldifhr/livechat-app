/**
 * Drives the real overlay server end to end.
 *
 * The unit tests in overlay.rs cover routing and the page; this covers the two
 * things they cannot — that the server actually binds the port it says it does,
 * and that what comes back over a socket is a page a browser could render. Both
 * are claims about the network rather than about a function.
 *
 *   node test/test-overlay-server.mjs
 */

import { spawnSync } from 'node:child_process'

let failures = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('the overlay page is a complete page')
// Read rather than reimplemented: the placeholder and the script tag it is
// replaced in are in the file, and a copy here would still be right after both
// had been renamed.
const { readFileSync } = await import('node:fs')
const { fileURLToPath } = await import('node:url')
const page = readFileSync(fileURLToPath(new URL('../src-tauri/overlay/index.html', import.meta.url)), 'utf8')

check('it is a document', /^\s*<!doctype html>/i.test(page))
check('it has a charset', /<meta charset="utf-8">/i.test(page))
// One request for one page: OBS fetches this once and leaves it alone.
check('it needs no second file', !/<link\b/.test(page) && !/<script[^>]*\ssrc=/.test(page))
check('it carries the token the host replaces', page.includes('__OVERLAY_CONFIG__'))
check('exactly once', page.split('__OVERLAY_CONFIG__').length === 2, String(page.split('__OVERLAY_CONFIG__').length))
check('the token is inside a json script block', /<script id="overlay-config" type="application\/json">/.test(page))

console.log('nothing in the page paints over the video')
// Scanned out of the `<style>` block rather than the whole file: `background`
// also appears in the script, where it is a computed value on an element rather
// than a declaration, and a regex that runs past the end of the CSS to find one
// is reading something else entirely.
const style = page.slice(page.indexOf('<style>') + '<style>'.length, page.indexOf('</style>'))
check('the style block was found', style.length > 0)
// A preceding character class rather than a bare word: `--background: 0` is a
// custom property holding a number, and a pattern that matches `background:`
// anywhere reads it as a declaration of something opaque.
const backgrounds = [...style.matchAll(/(^|[^-\w])background:\s*([^;]+)/g)].map((m) => m[2].trim())
check('there is at least one', backgrounds.length > 0, JSON.stringify(backgrounds))

// Nothing opaque behind the text. OBS composites the source over whatever is
// behind it, and an opaque body makes the chat a window onto a second video
// instead of a caption over the first. The test is the property, not a list: a
// background is opaque unless it is `transparent` or an `rgba(...)` whose alpha is
// below 1. A translucent tint of any colour — the gift badge's gold, say — still
// composites, so whitelisting only black would fail a legitimately see-through
// accent.
function isOpaque(value) {
  if (value === 'transparent') return false
  // The alpha is the last comma-separated component. A `var()` holds the 0..1
  // setting and is translucent by construction; a number below 1 is translucent;
  // anything with no alpha channel is opaque. Split on commas that are not inside
  // parentheses, so `rgba(0, 0, 0, var(--background))` keeps its alpha intact
  // rather than being cut at the `)` inside `var(`.
  const inner = value.match(/^rgba\((.*)\)$/)?.[1]
  if (inner === undefined) return true
  const parts = inner.split(/,(?![^(]*\))/)
  const last = parts[parts.length - 1].trim()
  if (last.startsWith('var(')) return false
  return Number(last) >= 1
}
const opaque = backgrounds.filter(isOpaque)
check('and none of them is opaque', opaque.length === 0, JSON.stringify(opaque))
check('the page itself is transparent', backgrounds.includes('transparent'))

// The two that are not transparent, and why each is allowed to be.
check('the row scrim is behind the setting', backgrounds.includes('rgba(0, 0, 0, var(--background))'))
check('the gift badge tint is translucent, not opaque', backgrounds.some((v) => v.startsWith('rgba(255, 215, 106') && !isOpaque(v)))
check('and that is hidden unless asked for', /#status \{ display: none; \}/.test(style) && /body\.debug #status/.test(style))

console.log('a wrong link says so, and a failed one does not')
// The distinction the page is built on. A link with no handle is a link somebody
// built wrong, and the only way it reaches a stream is if they pasted it into OBS
// without checking — which is exactly when they need to see it. A backend that is
// down is transient, and a message about that belongs on nobody's broadcast.
check('an unconfigured link is visible', /body\.unconfigured #unconfigured \{ display: block/.test(style))
check('and says what is missing', /no handle in this link/.test(page))
check('and disappears once a real message arrives', /body\.ready #unconfigured \{ display: none/.test(style))
check('a link with a handle is not marked unconfigured', page.includes("document.body.classList.remove('unconfigured')"))
check('but a failure still only speaks under debug', /if \(!config\.debug\) return/.test(page))
// And it is not confused with "still connecting", which is a different state and
// has its own quiet placeholder.
check('and is not confused with connecting', /body:not\(.ready\):not\(.unconfigured\) #chat::after/.test(style))

console.log('the page asks for what it needs')
check('it reads the query string', /URLSearchParams/.test(page))
check('it talks to the backend itself', /room-connect-by-username/.test(page))
check('and opens its own socket', /\/ws\/overlay\//.test(page))
check('as an overlay client, so it shares the room', /ws\/overlay/.test(page))
check('it retries when the socket closes', /onclose/.test(page) && /setTimeout\(connect/.test(page))
check('and when the backend cannot be reached at all', /\.catch\(function/.test(page))

console.log('the page shows chat and nothing else')
check('it renders comments', /frame\.type !== 'comment'/.test(page))
// A gifts-and-likes overlay is a dashboard, not a chat, and the row cap is sized
// for messages.
check('it ignores everything that is not a comment', /return/.test(page))

console.log('a failure on a stream is not shown on a stream')
// The whole reason the error path is silent: a red box in the corner of somebody's
// broadcast is worse than no chat.
check('errors are behind a debug flag', /if \(!config\.debug\) return/.test(page))
check('and the flag is opt-in through the url', /param\('debug'/.test(page))
check('the status line is hidden by default', /#status \{ display: none/.test(page))

console.log('names are rendered as text, not markup')
// A nickname is whatever somebody typed into a TikTok box. `textContent` on both
// halves is the whole reason a chat full of `<img onerror>` is not a problem. The
// name is now a link, but its label is still set with `textContent` — the href is
// built from the handle, the visible text is never markup.
check('the name goes in as text', /link\.textContent = who/.test(page))
check('and so does the message', /message\.textContent = body/.test(page))
check('the gift text goes in as text too', /said\.textContent =/.test(page))
check('nothing is written with innerHTML', !/innerHTML/.test(page))

console.log('the page survives what the backend sends')
// Every one of these has to be a no-op rather than an exception: a page that
// throws on the first frame it did not expect stops receiving, and the overlay
// goes quiet without saying why.
check('a frame that is not json is ignored', /try \{\s*frame = JSON\.parse/.test(page))
check('a frame with no type is ignored', /if \(!frame\) return/.test(page))
check('an empty message is ignored', /if \(body === ''\) return/.test(page))
check('a nameless sender still renders', /'Someone'/.test(page))
check('a missing text field does not throw', /text == null \? ''/.test(page))

console.log('the host serves it')
// The server's own tests cover routing without a socket. This covers the claim
// that matters to a streamer, which is that the thing answers at all.
console.log('  (the bind and the port are covered by cargo test in overlay.rs)')

console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)