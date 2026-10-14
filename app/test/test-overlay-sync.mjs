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
}

console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
