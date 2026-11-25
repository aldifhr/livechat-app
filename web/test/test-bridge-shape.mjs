/**
 * The bridge's wire frames vs the TypeScript union the web client trusts.
 *
 * test-event-contract.mjs compares the three *lists* of kind names as source
 * text. It cannot catch a shape drift: frames.js emitting `giftName` while the
 * union says `name`, or a brand-new field the client has no type for. This suite
 * imports the real toFrame() and checks what it actually produces against the
 * field names declared in shared/events.ts.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { toFrame, FRAME_KINDS } from '../../backend/frames.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const union = readFileSync(join(ROOT, 'shared', 'events.ts'), 'utf8')

let passed = 0
function check(label, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  ok   ${label}`) }
  else { console.log(`  FAIL ${label}   ${detail}`); process.exit(1) }
}

// Every field name the union's member interfaces declare. A frame carrying a
// key that is nowhere in the file is exactly the drift this suite is for.
const start = union.indexOf('export type OverlayEventFrame =')
check('the OverlayEventFrame union was found', start !== -1)
const unionFields = new Set(
  [...union.matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]*)\??:/gm)].map((m) => m[1]),
)
check('the union declares fields', unionFields.size > 0, `got ${unionFields.size}`)

// One rich TikTok event, shaped to satisfy every branch of toFrame().
const fixture = {
  user: {
    nickname: 'Fixture User', uniqueId: 'fixture', userId: 'u1', id: 'u1',
    profilePictureUrl: { urls: [{ url: 'https://example.invalid/a.png' }] },
    avatarLarger: 'https://example.invalid/a.png', isModerator: false,
  },
  comment: 'fixture message', content: 'fixture message',
  startContent: { title: 'Fixture?', optionList: [{ displayContent: 'A' }, { displayContent: 'B' }] },
  likeCount: 3, totalLikeCount: 42, repeatCount: 2, repeatEnd: false,
  gift: { id: 1, name: 'Rose', diamondCount: 1 },
  months: 12, displayType: 'ttlive_follow', socialType: 'follow',
  viewerCount: 7, title: 'fixture', text: 'fixture', count: 2, diamonds: 4,
  mentionUsers: [],
}

check('the bridge exports FRAME_KINDS', Array.isArray(FRAME_KINDS) && FRAME_KINDS.length > 0)

// These kinds are not produced by toFrame(): they come from the status helper,
// the error/config emitters and the manual trigger hook. Pin their emitters
// separately rather than pretending toFrame handles them.
const NON_TOFRAme = new Set(['alert', 'status', 'error', 'config'])
const serverSource = readFileSync(join(ROOT, 'backend', 'server.js'), 'utf8')
for (const kind of NON_TOFRAme) {
  check(`${kind} has an emitter outside toFrame`, serverSource.includes(`type: '${kind}'`) || serverSource.includes('statusFrame('), `no emitter for ${kind}`)
}

for (const kind of FRAME_KINDS.filter((k) => !NON_TOFRAme.has(k))) {
  let frame = null
  try { frame = toFrame(kind, fixture) } catch (cause) {
    check(`${kind} does not throw on a rich event`, false, cause.message)
    continue
  }
  check(`${kind} produces a frame`, frame !== null && typeof frame === 'object', `got ${JSON.stringify(frame)}`)
  if (!frame) continue
  check(`${kind} keeps its own type`, frame.type === kind, `got ${frame.type}`)
  const unknown = Object.keys(frame).filter((key) => !unionFields.has(key) && key !== 'type')
  check(`${kind} emits no field the TS union lacks`, unknown.length === 0, `unknown: ${unknown.join(', ')}`)
}

console.log(`\nall checks passed (${passed})`)
