/**
 * Backend/frontend contract check through the real Next.js gateway.
 *
 *   STREAMKIT_SESSION=... node bench/contract-check.mjs http://127.0.0.1:5184
 *
 * The expected shapes come from web/src/lib/types.ts and from the gateway's
 * own response mapping. A throwaway room is created and deleted. No secrets
 * are printed; the session value is only sent as a cookie.
 */

const BASE = (process.argv[2] || 'http://127.0.0.1:5184').replace(/\/+$/, '')
const SESSION = process.env.STREAMKIT_SESSION || ''
const WS_BASE = (process.env.STREAMKIT_WS_URL || 'http://127.0.0.1:8004').replace(/\/+$/, '')
if (!SESSION) throw new Error('STREAMKIT_SESSION is required')

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail && !ok ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const has = (obj, keys) => keys.every((k) => Object.prototype.hasOwnProperty.call(obj ?? {}, k))

async function call(method, path, body) {
  const response = await fetch(`${BASE}/api/backend${path}`, {
    method,
    headers: {
      cookie: `streamkit_session=${SESSION}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000),
  })
  const text = await response.text()
  let value = null
  try { value = text ? JSON.parse(text) : null } catch {}
  return { status: response.status, value }
}

const readRoutes = [
  ['GET', '/rooms', (v) => has(v, ['rooms']) && Array.isArray(v.rooms)],
  ['GET', '/rooms/public', (v) => has(v, ['rooms']) && Array.isArray(v.rooms)],
  ['GET', '/health', (v) => has(v, ['status'])],
  ['GET', '/metrics', (v) => typeof v === 'object' && v !== null],
  ['GET', '/analytics', (v) => has(v, ['total_rooms', 'total_viewers', 'total_peak_viewers', 'total_diamonds', 'total_events', 'rooms', 'topGifters'])],
  ['GET', '/logs', (v) => has(v, ['entries', 'total', 'capacity']) && (v.entries ?? []).every((e) => has(e, ['at', 'level', 'source', 'message']))],
]

for (const [method, path, assert] of readRoutes) {
  const r = await call(method, path)
  check(`${method} ${path}`, r.status === 200 && assert(r.value), `HTTP ${r.status} ${JSON.stringify(r.value)?.slice(0, 140)}`)
}

const created = await call('POST', '/rooms', { name: 'contract-check', provider: 'tiktok' })
const room = created.value?.room
check('POST /rooms returns a Room', created.status === 200 && has(room, ['id', 'name', 'username', 'config', 'createdAt']), JSON.stringify(created.value)?.slice(0, 140))
if (room) {
  const id = room.id
  const cases = [
    ['GET', `/rooms/${id}`, (v) => has(v, ['id', 'name', 'username', 'config', 'createdAt'])],
    ['GET', `/rooms/${id}/status`, (v) => has(v, ['type', 'connected', 'message'])],
    ['GET', `/rooms/${id}/session`, (v) => has(v, ['connected', 'totals', 'repeats', 'viewers', 'viewers_age', 'peak_viewers', 'peak_viewers_age', 'live_seconds', 'total_diamonds', 'topGifters'])],
    ['PATCH', `/rooms/${id}`, (v) => has(v, ['room']), { name: 'contract-check-2' }],
    ['POST', `/rooms/${id}/config`, (v) => has(v, ['status']), { config: { overlayMax: 3 } }],
    ['POST', `/rooms/${id}/trigger`, (v) => has(v, ['ok']), { kind: 'alert', text: 'contract check' }],
    ['POST', `/hooks/${id}`, (v) => has(v, ['ok']), { kind: 'alert', text: 'contract check hook' }],
  ]
  for (const [method, path, assert, body] of cases) {
    const r = await call(method, path, body)
    check(`${method} ${path}`, r.status === 200 && assert(r.value), `HTTP ${r.status} ${JSON.stringify(r.value)?.slice(0, 140)}`)
  }

  // The gateway must pass the baked overlay config to the browser over WS.
  await new Promise((resolve) => {
    const ws = new WebSocket(`${WS_BASE.replace(/^http/, 'ws')}/ws/overlay/${id}`)
    let frames = 0
    let done = false
    const timer = setTimeout(() => { ws.close(); resolve() }, 2500)
    ws.onmessage = (event) => {
      const frame = JSON.parse(event.data)
      if (frames === 0) check('WS first frame is config', frame.type === 'config' && has(frame, ['config']))
      if (frames === 1) check('WS second frame is status', frame.type === 'status' && has(frame, ['connected', 'message']))
      if (++frames === 2) { done = true; clearTimeout(timer); ws.close(); resolve() }
    }
    ws.onerror = () => { if (!done) { clearTimeout(timer); check('WS opens', false); resolve() } }
  })

  await call('DELETE', `/rooms/${id}`)
}

console.log(`\n${failures ? `${failures} contract mismatch(es)` : 'all contract checks passed'}`)
process.exitCode = failures ? 1 : 0
