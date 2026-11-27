/**
 * Smoke check for the public handle-connector: the endpoint must actually
 * persist a room, not just answer with a UUID. A past regression returned 200
 * with a room_id while the JSONB insert failed silently, so the dashboard
 * showed an error a moment later.
 *
 *   STREAMKIT_TOKEN=... node bench/smoke-connect.mjs http://127.0.0.1:8004
 */

const BASE = (process.argv[2] || 'http://127.0.0.1:8004').replace(/\/+$/, '')
const TOKEN = process.env.STREAMKIT_TOKEN || ''
if (!TOKEN) throw new Error('STREAMKIT_TOKEN is required')

const rpc = async (path, args) => {
  const r = await fetch(`${BASE}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-streamkit-token': TOKEN },
    body: JSON.stringify({ path, args: { ...args, token: TOKEN } }),
  })
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`)
  return r.json()
}

const username = `smoke-${Date.now()}`
const answer = await fetch(`${BASE}/api/room-connect-by-username`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username, provider: 'tiktok' }),
}).then((r) => r.json())

const room = (await rpc('rooms:list', {})).find((r) => r.id === answer.room_id)
if (!room) throw new Error(`connect answered ${answer.room_id} but no room was stored`)
if (room.username !== username) throw new Error(`stored username mismatch: ${room.username}`)
await rpc('rooms:deleteRoom', { roomId: answer.room_id })
console.log(`ok  handle connector persisted @${username} (${answer.room_id})`)
