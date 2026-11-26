/**
 * Integration check for the overlay event cursor.
 *
 * Inserts 150 events into a throwaway room and pages them back with the same
 * limit the bridge uses. The old implementation took the newest 100 and
 * filtered afterwards, so the first 50 of a burst vanished; this asserts all
 * 150 come back, in order, across two pages. The room is deleted afterwards.
 *
 * Run from web/ with a reachable self-hosted Convex:
 *   CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210 \
 *   CONVEX_SELF_HOSTED_ADMIN_KEY=... \
 *   STREAMKIT_TOKEN=... \
 *   node scripts/test-cursor-pagination.mjs
 */

import { ConvexHttpClient } from 'convex/browser'

const url = process.env.CONVEX_SELF_HOSTED_URL || 'http://127.0.0.1:3210'
const token = process.env.STREAMKIT_TOKEN || ''
if (!token) {
  console.error('STREAMKIT_TOKEN is required')
  process.exit(1)
}

const client = new ConvexHttpClient(url)
const check = (label, cond) => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${label}`)
  if (!cond) process.exitCode = 1
}

let roomId = ''
try {
  const room = await client.mutation('rooms:create', {
    name: `cursor-probe-${Date.now()}`,
    provider: 'tiktok',
    token,
  })
  roomId = room.id

  for (let i = 1; i <= 150; i++) {
    await client.mutation('events:appendEvent', {
      roomId,
      kind: 'alert',
      frame: { type: 'alert', text: `n-${i}` },
      token,
    })
  }

  let cursor = 0
  let pages = 0
  const seen = []
  while (true) {
    const rows = await client.query('events:recentForRoom', {
      roomId,
      sinceCreationTime: cursor,
      limit: 100,
      token,
    })
    pages++
    for (const row of rows) {
      seen.push(row.frame.text)
      cursor = Math.max(cursor, row.cursor)
    }
    if (rows.length < 100) break
    if (pages > 10) throw new Error('pagination did not terminate')
  }

  const expected = Array.from({ length: 150 }, (_, i) => `n-${i + 1}`)
  check('all 150 events came back', seen.length === 150)
  check('none were duplicated', new Set(seen).size === 150)
  check('two pages were enough', pages === 2)
  check('emission order was preserved', JSON.stringify(seen) === JSON.stringify(expected))
} finally {
  if (roomId) await client.mutation('rooms:deleteRoom', { roomId, token }).catch(() => {})
}
