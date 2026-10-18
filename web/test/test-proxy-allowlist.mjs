/**
 * Every path the browser client asks for must be one the proxy will forward.
 *
 * The proxy rebuilds the backend path from the catch-all segments, so
 * `/api/backend/health` becomes `/api/health`, and `ALLOWED` is matched against
 * *that* rather than against the address the browser used. That indirection is
 * what let three separate paths reach the proxy and be refused with 404 "Not
 * proxied" while the code looked correct:
 *
 *   - `/api/rooms/{id}/trigger` was missing from the list at all, so the one route
 *     that could prove an overlay's styling worked was unreachable.
 *   - `/api/health` was written as `/^\/health$/` — the bare backend route, with no
 *     prefix. It matched nothing.
 *   - and then, in a different direction, as `/^\/api\/backend\/health$/` — this
 *     proxy's own URL, which is not the path being tested either. It also matched
 *     nothing.
 *
 * The failure is nasty because it is silent in the worst way: the page reports
 * "the backend did not answer", which is true and is not the problem. A path that
 * is refused looks exactly like a backend that is down.
 *
 * So this reads the two files and checks one against the other. It is a text test
 * rather than an import, because the route is `server-only` and because the thing
 * worth pinning is the literal in the source: a test that imported the array would
 * keep passing if the array were right by accident.
 *
 * Run with node, like the other suites here:
 *
 *     node test/test-proxy-allowlist.mjs
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src')

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

const routeSource = readFileSync(join(SRC, 'app', 'api', 'backend', '[...path]', 'route.ts'), 'utf8')
const clientSource = readFileSync(join(SRC, 'lib', 'client.ts'), 'utf8')

// The patterns, as they are written. `/^\/api\/rooms$/` and friends are literals in
// a plain array with no interpolation, so reading them out of the source is exact
// rather than approximate — and it is the literal that matters, since a regex built
// some other way would not be the one in the file.
const listBody = routeSource.slice(
  routeSource.indexOf('const ALLOWED = [') + 'const ALLOWED = ['.length,
  routeSource.indexOf('];', routeSource.indexOf('const ALLOWED = [')),
)
const patterns = [...listBody.matchAll(/\/(.*)\/(?=,\s*$)/gm)].map((m) => new RegExp(m[1]))

console.log(`read ${patterns.length} patterns from ALLOWED`)

check('the list was found and is not empty', patterns.length > 0, `got ${patterns.length}`)

// Every path the client builds, taken from its own `request(...)` calls. `BASE` is
// `/api/backend`, which the proxy strips, so a client path of `/rooms` is matched
// as `/api/rooms` — the same arithmetic the proxy does, so the two cannot disagree
// about what a path is.
const BASE = clientSource.match(/const BASE = '([^']+)'/)
check('the client base was found', BASE !== null)
check(
  'and it is the one the proxy strips',
  BASE[1] === '/api/backend',
  `got ${BASE[1]}`,
)

// Every call site, whichever quoting it uses. Most of the paths in this file are
// template literals — `/rooms/${id}/session` — so matching only the single-quoted
// ones would have checked the three least interesting calls and skipped every
// room-scoped path, which is where the missing `/trigger` was hiding.
//
// The generic is matched loosely rather than as `<[^>]*>`: the call sites are
// written as `request<{ rooms: Room[] }>` and `request<{ status: string }>`, whose
// shapes close at a `>` a naive pattern cannot see.
const calls = [
  ...clientSource.matchAll(/request<[\s\S]*?>\(\s*'(\w+)'\s*,\s*(?:'([^']+)'|`([^`]+)`)/g),
].map((m) => ({ method: m[1], path: m[2] ?? m[3] ?? '' }))
check('the client calls were found', calls.length >= 12, `got ${calls.length}`)

// A representative room id, substituted for every `${...}` in a template path. The
// patterns are written against `[0-9a-f-]{36}` because that is what `store` mints,
// so a real id has to match or the pattern is wrong. Giveaway snapshots carry a
// different id — `secrets.token_urlsafe(12)` in the backend's giveaway store, i.e.
// 16 url-safe characters — so substituting a UUID there made the snapshot GET fail
// its pattern no matter how correctly the pattern was written. The substitute is
// therefore chosen per position: a snapshot id where the hole sits in a snapshot
// path, a UUID everywhere else.
const UUID = '61ea70c9-6d36-4a6a-bf94-b648532447bb'
const SNAPSHOT_ID = 'a1B2c3D4e5F6g7H8'
const fullPath = (path) =>
  `/api${path.replace(
    /(?<=\/giveaways\/snapshots\/)\$\{[^}]*\}/g,
    SNAPSHOT_ID,
  ).replace(/\$\{[^}]*\}/g, UUID)}`

const missing = calls.filter(({ path }) => !patterns.some((p) => p.test(fullPath(path))))

check(
  `every one of the ${calls.length} client paths is forwarded`,
  missing.length === 0,
  missing.map((m) => `${m.method} ${m.path} -> ${fullPath(m.path)}`).join('; '),
)

// The two paths this suite exists for, named explicitly so a regression says which
// one broke rather than making someone diff a list.
check('the manual trigger is forwarded', patterns.some((p) => p.test(`/api/rooms/${UUID}/trigger`)))
check('the health probe is forwarded', patterns.some((p) => p.test('/api/health')))
check('the metrics probe is forwarded', patterns.some((p) => p.test('/api/metrics')))
check('the analytics aggregate is forwarded', patterns.some((p) => p.test('/api/analytics')))

// And the shapes the patterns are written against. `[0-9a-f-]{36}` is a uuid as
// `store` mints it, so a real one has to match the room patterns too.
check('a real room id matches the room pattern', patterns.some((p) => p.test(`/api/rooms/${UUID}`)))
check('a real room id matches its status pattern', patterns.some((p) => p.test(`/api/rooms/${UUID}/status`)))
check('a real room id matches its session pattern', patterns.some((p) => p.test(`/api/rooms/${UUID}/session`)))

// A path nobody should reach. The list is the whole of what this route will
// forward, so a pattern written too loosely is a hole rather than a nuisance.
check('the token gate itself is not forwarded', !patterns.some((p) => p.test('/api/rooms?token=x')))
check('a made-up path is not forwarded', !patterns.some((p) => p.test('/api/secrets')))

console.log(`\nall checks passed (${passed})`)
