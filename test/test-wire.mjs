/**
 * The wire contract between the Rust host and the TypeScript app.
 *
 * These two are joined by a hand-written `json!` map in `backend.rs` and a
 * hand-written union in `sidecar.ts`, with no schema, no codegen and no type
 * shared between them: the Rust side emits plain JSON and the TypeScript side
 * asserts the shape by casting. So a field can be renamed on one side and
 * nothing complains.
 *
 * That already happened. `SidecarEvent` declared `viewerId` on the join variant
 * while `to_app_event` sent `id`, so every join arrived with `id: undefined`.
 * Both sides were tested — the Rust test asserted `join["id"]`, the TS test
 * emitted `viewerId` — and both were green, because each half was pinned to
 * itself and nothing crossed the seam. Two viewers arriving inside the collapse
 * window then folded into one row.
 *
 * So this test reads both files and compares them against each other, which is
 * the only place the mismatch is visible. It is deliberately a source-reading
 * test rather than a runtime one: the shapes only exist as source text.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const pkgRoot = fileURLToPath(new URL('..', import.meta.url))

let failures = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/**
 * The keys `to_app_event` writes, per output type.
 *
 * Read out of the `json!({ ... })` blocks rather than kept as a literal, so a
 * field added on the Rust side reaches this test without anyone remembering to
 * update a second list — which is the failure mode that produced the original
 * bug.
 */
function rustFrames(source) {
  const body = source.slice(source.indexOf('pub fn to_app_event'))
  const frames = new Map()
  // Each arm is `"<input type>" => json!({ ... })`. Keys inside are the output.
  const arm = /"([a-z]+)"\s*=>\s*json!\(\{([\s\S]*?)\}\)/g
  let match
  while ((match = arm.exec(body)) !== null) {
    const [, inputType, chunk] = match
    const keys = new Set()
    const key = /"([A-Za-z][A-Za-z0-9]*)"\s*:/g
    let k
    while ((k = key.exec(chunk)) !== null) keys.add(k[1])
    const outType = /"type"\s*:\s*"([a-z]+)"/.exec(chunk)
    frames.set(inputType, { outType: outType ? outType[1] : inputType, keys })
  }
  return frames
}

/**
 * The fields `SidecarEvent` declares, per variant.
 *
 * Required fields only. Optional ones (`isBot?`, `giftImage?`) are things the
 * app or a source may add later, so demanding the host always send them would
 * be wrong; what must hold is that every required field is actually produced.
 */
function tsVariants(source) {
  const union = source.slice(source.indexOf('export type SidecarEvent'))
  const variants = new Map()
  // Variants are `| {` ... `}`, and they are written in two shapes: a block that
  // is one line (`| { type: 'like'; nickname: string; ... }`) and a block spread
  // over several. Both have to be read, or a variant written on one line is
  // missed and its fields get attributed to whichever block did match.
  const block = /\|?\s*\{([^}]*)\}/g
  let match
  while ((match = block.exec(union)) !== null) {
    const chunk = match[1]
    const named = /type:\s*'([a-z]+)'/.exec(chunk)
    if (!named) continue
    const required = new Set()
    const optional = new Set()
    // Fields run to the end of the object; `type` names the variant and is not
    // a field, and a `?` marks one the host may legitimately omit.
    const field = /(?:^|[;{\n])\s*([A-Za-z][A-Za-z0-9]*)\s*(\??)\s*:/g
    let f
    while ((f = field.exec(chunk)) !== null) {
      if (f[1] === 'type') continue
      ;(f[2] ? optional : required).add(f[1])
    }
    variants.set(named[1], { required, optional })
  }
  return variants
}

const rust = rustFrames(readFileSync(join_(pkgRoot, 'src-tauri', 'src', 'backend.rs'), 'utf8'))
const ts = tsVariants(readFileSync(join_(pkgRoot, 'src', 'lib', 'sidecar.ts'), 'utf8'))

function join_(...parts) {
  return parts.join('/')
}

console.log('the host emits what the app reads')
check('the Rust map was read', rust.size >= 9, `found ${rust.size} arms`)
check('the TS union was read', ts.size >= 9, `found ${ts.size} variants`)

// Every type the host produces must exist on the TS side, or the app drops it.
for (const [inputType, frame] of rust) {
  const variant = ts.get(frame.outType)
  check(
    `'${inputType}' reaches a '${frame.outType}' variant`,
    Boolean(variant),
    variant ? '' : `no TS variant declares type: '${frame.outType}'`,
  )
  if (!variant) continue

  // A field the app treats as required must actually be emitted. `url` is not a
  // frame field: it belongs to the inline `emotes` element type, which is read
  // out of the enclosing chat variant, so it is not on the frame itself.
  for (const field of variant.required) {
    if (field === 'type' || field === 'platform' || field === 'url') continue
    check(
      `'${inputType}' emits the required '${field}'`,
      frame.keys.has(field),
      `host sends: ${[...frame.keys].join(',')}`,
    )
  }
}

// Only a person-bearing frame is keyed on an id. `viewers` is a headcount and
// `status`/`error` are about the room, and none of them names anybody, so
// demanding an id there would be demanding a field that should not exist.
const PERSON_BEARING = new Set(['comment', 'like', 'gift', 'join', 'follow', 'share'])
for (const [inputType, frame] of rust) {
  if (!PERSON_BEARING.has(inputType)) continue
  const variant = ts.get(frame.outType)
  if (!variant) continue
  check(
    `'${inputType}' carries an id, and the app reads an id`,
    frame.keys.has('id') && variant.required.has('id'),
    `host: ${[...frame.keys].join(',')} | app: ${[...variant.required].join(',')}`,
  )
}

console.log('the names line up')
// The reverse direction: a field the app requires but the host renamed is the
// bug this file exists for, so the join id is pinned explicitly and by name.
const joinArm = rust.get('join')
const joinVariant = ts.get('join')
check('the host sends join id', joinArm?.keys.has('id') === true)
check('the app reads join id', joinVariant?.required.has('id') === true)
// `viewerId` is pinned by name because it was the field the host never sent, and
// nothing in either language noticed. The search is over the source of the two
// files that would have to change, excluding this file's own comment about it.
const appSource = readFileSync(join_(pkgRoot, 'src', 'lib', 'sidecar.ts'), 'utf8')
const hookSource = readFileSync(join_(pkgRoot, 'src', 'hooks', 'useChat.ts'), 'utf8')
check(
  'the app no longer declares viewerId',
  !/\bviewerId\b\s*[:?]/.test(appSource),
  'the host sends id, so viewerId could only ever read as undefined',
)
check('nothing in the app reads viewerId', !/\bviewerId\b/.test(hookSource))

if (failures) {
  console.log(`\n${failures} failed`)
  process.exit(1)
}
console.log('\nall passed')