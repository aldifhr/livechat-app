/**
 * One wire contract, three spellings, and they must agree.
 *
 * The backend emits overlay frames from `api/events.py`. The dashboard's type
 * for them lives in `shared/events.ts`, and the runtime list the socket handler
 * filters against lives in `web/src/hooks/useRoomEvents.ts`. Three files, one
 * contract, and nothing at runtime checks them against each other:
 *
 *   - A TypeScript type is erased at runtime, so `tsc` is the only thing that
 *     ever reads the union, and it reads it as a shape rather than as a set of
 *     strings. A kind the backend sends and the union lacks is invisible to it.
 *   - A Python constant nobody imports is dead code, and a `SERIALISERS` entry
 *     with no constant is unreachable — `to_wire` looks the serialiser up by
 *     `event.kind`, so the key is the only thing that matters and the constant
 *     is decoration.
 *   - The `FRAME_KINDS` array is the one with teeth: a kind missing from it is
 *     dropped at the socket, silently, on a page that looks fine.
 *
 * So this reads all three out of the source as text and compares them. Text
 * rather than import, for the same reason `test-proxy-allowlist.mjs` does it:
 * the literal in the file is the thing worth pinning, and a test that imported
 * the array would keep passing if the array were right by accident.
 *
 * The four kinds this suite was written for — `share`, `alert`, `error` and
 * `config` — were all emitted by the backend and absent from the union. Two of
 * them (`error`, `config`) are not constants at all: they are raw string
 * literals inside `emit_error` and `emit_config`, so they are collected from
 * those call sites rather than from the constants block. That asymmetry is the
 * point of the `serialisers cover the constants` check below.
 *
 * Run with node, like the other suites here:
 *
 *     node test/test-event-contract.mjs
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')

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

const eventsSource = readFileSync(join(REPO, 'shared', 'events.ts'), 'utf8')
const hookSource = readFileSync(
  join(REPO, 'web', 'src', 'hooks', 'useRoomEvents.ts'),
  'utf8',
)
const apiSource = readFileSync(join(REPO, 'api', 'events.py'), 'utf8')

// ---------------------------------------------------------------------------
// Spelling 1 — the union in shared/events.ts
// ---------------------------------------------------------------------------

// The union body, from `export type OverlayEventFrame =` to the end of the
// declaration. Slicing rather than matching the whole file keeps this honest if
// another union is ever added to the file.
const unionStart = eventsSource.indexOf('export type OverlayEventFrame =')
check('the OverlayEventFrame union was found', unionStart !== -1)
const unionBody = eventsSource.slice(unionStart)

// Every member's discriminator. A member is `  | NameFrame` on its own line and
// the `type: '...'` sits inside the interface above it, so the literals are
// collected from the interfaces rather than from the union's member names —
// the names are not the contract, the string is.
const unionTypes = [
  ...new Set([...unionBody.matchAll(/^\s{2}\|\s*(\w+)\s*$/gm)].map((m) => m[1])),
]
check('the union has members', unionTypes.length > 0, `got ${unionTypes.length}`)

const unionKinds = unionTypes
  .map((name) => {
    // The interface that declares this member, found by name so the search does
    // not depend on declaration order.
    const at = eventsSource.indexOf(`export interface ${name} `)
    if (at === -1) return null
    const body = eventsSource.slice(at, eventsSource.indexOf('\n}', at))
    const literal = body.match(/^\s*type:\s*'([^']+)'/m)
    return literal ? literal[1] : null
  })
  .filter(Boolean)

check(
  'every union member declares a type literal',
  unionKinds.length === unionTypes.length,
  `${unionKinds.length} of ${unionTypes.length}`,
)

// ---------------------------------------------------------------------------
// Spelling 2 — FRAME_KINDS in useRoomEvents.ts
// ---------------------------------------------------------------------------

const kindsStart = hookSource.indexOf('const FRAME_KINDS = [')
check('the FRAME_KINDS array was found', kindsStart !== -1)
const kindsBody = hookSource.slice(
  kindsStart + 'const FRAME_KINDS = ['.length,
  hookSource.indexOf('] as const', kindsStart),
)
const frameKinds = [...kindsBody.matchAll(/'([^']+)'/g)].map((m) => m[1])

check(
  'the FRAME_KINDS array is not empty',
  frameKinds.length > 0,
  `got ${frameKinds.length}`,
)
check(
  'and it has no duplicates',
  new Set(frameKinds).size === frameKinds.length,
  `${frameKinds.length} entries, ${new Set(frameKinds).size} distinct`,
)

// The guard has to exist and has to be the thing the socket handler calls,
// otherwise the array is decoration and the cast it replaced is still in place.
check('the isOverlayFrame guard is exported', /export function isOverlayFrame\(/.test(hookSource))
check(
  'and the socket handler filters through it',
  /if \(isOverlayFrame\(frame\)\)/.test(hookSource),
)
check(
  'and the blind cast is gone',
  !/JSON\.parse\(event\.data\) as OverlayEventFrame/.test(hookSource),
  'the old cast is still there',
)

// ---------------------------------------------------------------------------
// Spelling 3 — api/events.py
// ---------------------------------------------------------------------------

// The constants block: `NAME = "value"` lines above the first `@dataclass`.
const constantsAt = apiSource.indexOf('\n@dataclass')
check('the constants block was found', constantsAt !== -1)
const constantsBody = apiSource.slice(0, constantsAt)
const constants = [
  ...new Set(
    [...constantsBody.matchAll(/^([A-Z][A-Z0-9_]*)\s*=\s*"([^"]+)"\s*$/gm)].map(
      (m) => m[2],
    ),
  ),
]
check(
  'the kind constants were found',
  constants.length > 0,
  `got ${constants.length}`,
)

// The SERIALISERS dict keys. They are written as bare names — `COMMENT: _comment`
// — so the key is the constant's *name*, and the value it stands for has to be
// resolved through the constants block above. That indirection is exactly why
// the two can drift: a key can name a constant that was renamed, and Python
// would raise at import, but a key can equally be added for a kind no constant
// names and nothing would complain.
const serialisersAt = apiSource.indexOf('SERIALISERS: dict[str, Callable[[Event], dict[str, Any]]] = {')
check('the SERIALISERS dict was found', serialisersAt !== -1)
const serialisersBody = apiSource.slice(
  serialisersAt,
  apiSource.indexOf('\n}', serialisersAt),
)
const serialiserKeys = [
  ...new Set([...serialisersBody.matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1])),
]
check(
  'the SERIALISERS keys were found',
  serialiserKeys.length > 0,
  `got ${serialiserKeys.length}`,
)

const constantNames = new Map(
  [...constantsBody.matchAll(/^([A-Z][A-Z0-9_]*)\s*=\s*"([^"]+)"\s*$/gm)].map(
    (m) => [m[1], m[2]],
  ),
)

// A constant with no serialiser is dead: `to_wire` looks the serialiser up by
// `event.kind`, so a kind that reaches `emit` without one is rewritten into an
// `alert` carrying the kind's own name — visible while developing, and a
// silently wrong frame in production.
const unserialised = [...constantNames.entries()].filter(
  ([name]) => !serialiserKeys.includes(name),
)
check(
  'every kind constant has a serialiser',
  unserialised.length === 0,
  unserialised.map(([n, v]) => `${n}="${v}"`).join(', '),
)

// The other direction: a serialiser key that names no constant is unreachable,
// because nothing can construct an `Event` with that kind.
const unresolved = serialiserKeys.filter((key) => !constantNames.has(key))
check(
  'every serialiser key names a constant',
  unresolved.length === 0,
  unresolved.join(', '),
)

// The two kinds the backend emits as raw literals rather than through the
// constants/serialiser path. Collected from the broadcast call sites, because
// that is the only place they exist.
const literalKinds = [
  ...new Set(
    [...apiSource.matchAll(/\{\s*"type":\s*"([a-z]+)"/g)].map((m) => m[1]),
  ),
].filter((kind) => !constants.includes(kind))
check(
  'the literal-emitted kinds were found',
  literalKinds.length > 0,
  `got ${literalKinds.length}: ${literalKinds.join(', ')}`,
)

const apiKinds = [...new Set([...constants, ...literalKinds])].sort()

// ---------------------------------------------------------------------------
// The agreement itself
// ---------------------------------------------------------------------------

const sorted = (list) => [...list].sort()
const show = (list) => list.join(', ')

check(
  'the union and FRAME_KINDS list the same kinds',
  JSON.stringify(sorted(unionKinds)) === JSON.stringify(sorted(frameKinds)),
  `union: ${show(sorted(unionKinds))} | hook: ${show(sorted(frameKinds))}`,
)

check(
  'the union and the backend emit the same kinds',
  JSON.stringify(sorted(unionKinds)) === JSON.stringify(sorted(apiKinds)),
  `union: ${show(sorted(unionKinds))} | api: ${show(sorted(apiKinds))}`,
)

check(
  'and FRAME_KINDS and the backend agree too',
  JSON.stringify(sorted(frameKinds)) === JSON.stringify(sorted(apiKinds)),
  `hook: ${show(sorted(frameKinds))} | api: ${show(sorted(apiKinds))}`,
)

// The four this suite was written for, named so a regression says which one
// broke rather than making someone diff a list.
for (const kind of ['share', 'alert', 'error', 'config']) {
  check(`the '${kind}' kind is in all three`, unionKinds.includes(kind) && frameKinds.includes(kind) && apiKinds.includes(kind))
}

// The two status fields, which are not kinds and so are not in any of the three
// lists above. They are carried only when true, so a client that predates them
// reads nothing new — which is exactly why they went unnoticed: nothing broke.
for (const field of ['liveEnded', 'waiting']) {
  check(
    `StatusFrame declares '${field}'`,
    new RegExp(`\\b${field}\\?:`).test(
      eventsSource.slice(
        eventsSource.indexOf('export interface StatusFrame'),
        eventsSource.indexOf('export interface ShareFrame'),
      ),
    ),
  )
  check(
    `and the backend sends '${field}'`,
    new RegExp(`payload\\["${field}"\\]`).test(apiSource),
  )
}

console.log(`\nall checks passed (${passed})`)
