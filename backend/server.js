// StreamKit TikTok bridge.
//
// The only process that holds a long-lived socket. Everything else — rooms,
// events, sessions, logs — lives in Convex (self-hosted at
// CONVEX_URL). This bridge:
//   1. connects to TikTok LIVE (tiktok-live-connector),
//   2. normalises each event to the overlay wire frame (frames.js),
//   3. appends it to Convex (events:appendEvent) and mirrors it to overlay
//      WebSocket clients at /ws/{overlay|room|customizer}/{roomId},
//   4. serves the connect/disconnect HTTP paths the dashboard and overlays use.
//
// Convex Functions cannot hold a socket open for hours, which is why this
// bridge exists. It holds no state of its own beyond live connections.

import http from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { ConvexHttpClient } from 'convex/browser'
import { WebSocketServer } from 'ws'
import { TikTokLiveConnection, WebcastEvent } from 'tiktok-live-connector'
import { toFrame, statusFrame, pageConfig } from './frames.js'

const PORT = Number(process.env.BRIDGE_PORT || 8001)
const CONVEX_URL = (process.env.CONVEX_URL || 'http://127.0.0.1:3210').replace(/\/+$/, '')
const ADMIN_KEY = (process.env.CONVEX_ADMIN_KEY || '').trim()
const SIGN_API_KEY = (process.env.SIGN_API_KEY || '').trim()
const API_TOKEN = (process.env.STREAMKIT_TOKEN || '').trim()

const convex = new ConvexHttpClient(CONVEX_URL)
// @ts-ignore SDK typing omits setAdminAuth on self-hosted client
if (ADMIN_KEY) convex.setAdminAuth(ADMIN_KEY)

async function q(path, args) { return convex.query(path, { ...args, ...(API_TOKEN ? { token: API_TOKEN } : {}) }) }
async function m(path, args) { return convex.mutation(path, { ...args, ...(API_TOKEN ? { token: API_TOKEN } : {}) }) }

async function log(level, source, message) {
  try { await m('events:appendLog', { level, source, message: String(message).slice(0, 500) }) } catch {}
}

// --- overlay WebSocket fan-out ---------------------------------------------
const clients = new Map() // ws -> { roomId, clientType }
const MAX_PER_ROOM = 5
const MAX_TOTAL = 200

function roomClients(roomId) {
  return [...clients.entries()].filter(([, c]) => c.roomId === roomId).map(([ws]) => ws)
}

function broadcast(roomId, frame) {
  const text = JSON.stringify(frame)
  for (const ws of roomClients(roomId)) {
    if (ws.readyState === 1) {
      try { ws.send(text) } catch {}
    }
  }
}

async function setStatus(roomId, s) {
  try {
    await m('rooms:setStatus', {
      roomId,
      connected: s.connected,
      connecting: s.connecting,
      waiting: s.waiting,
      liveEnded: s.liveEnded,
      message: s.message,
      viewers: s.viewers,
    })
  } catch {}
  broadcast(roomId, statusFrame(s))
}

// --- TikTok connections ------------------------------------------------------
const sources = new Map() // roomId -> { conn, username, running }

const EVENT_MAP = {
  [WebcastEvent.CHAT]: 'comment',
  [WebcastEvent.LIKE]: 'like',
  [WebcastEvent.GIFT]: 'gift',
  [WebcastEvent.MEMBER]: 'join',
  [WebcastEvent.FOLLOW]: 'follow',
  [WebcastEvent.SHARE]: 'share',
  [WebcastEvent.ROOM_USER]: 'viewers',
  [WebcastEvent.LIVE_INTRO]: 'intro',
  // SOCIAL carries follow/share by display type; handled below.
  [WebcastEvent.ROOM_NOTIFY]: 'notice',
  [WebcastEvent.SUB_NOTIFY]: 'subscription',
  [WebcastEvent.POLL_MESSAGE]: 'poll',
}

async function emit(roomId, kind, event) {
  const frame = toFrame(kind, event)
  if (!frame) return
  try {
    await m('events:appendEvent', {
      roomId,
      kind,
      // @ts-ignore third-party/untyped bridge surface
      user: frame.user || '',
      // @ts-ignore third-party/untyped bridge surface
      userId: frame.userId || frame.user || '',
      frame,
    })
  } catch (e) {
    await log('error', 'bridge.emit', e?.message || e)
  }
  // No direct broadcast here: the poller below fans out every Convex event,
  // so TikTok frames, manual triggers and hooks all reach overlays the same way.
}

// Poll Convex for new events in rooms with overlay clients, and fan them out.
// This is what makes a trigger posted through Convex reach a WebSocket overlay.
const lastSeen = new Map() // roomId -> Convex _creationTime of the last frame seen
const polling = new Set() // one in-flight poll per room; a slow Convex must not overlap
setInterval(async () => {
  const rooms = new Set([...clients.values()].map((c) => c.roomId))
  for (const roomId of rooms) {
    if (polling.has(roomId)) continue
    polling.add(roomId)
    try {
      // Never seed the cursor from the bridge clock: an event written between
      // the socket connect and the first poll would sit below it and be lost.
      // Ask Convex for its own last cursor instead.
      if (!lastSeen.has(roomId)) {
        lastSeen.set(roomId, await q('events:latestCursor', { roomId }))
        continue
      }
      // Drain a few full batches in one tick so a burst does not need 300ms
      // per 100 events to catch up. Ascending pagination cannot skip rows.
      for (let batch = 0; batch < 5; batch++) {
        const rows = await q('events:recentForRoom', { roomId, sinceCreationTime: lastSeen.get(roomId), limit: 100 })
        for (const row of rows || []) {
          broadcast(roomId, row.frame)
          if (row.cursor > lastSeen.get(roomId)) lastSeen.set(roomId, row.cursor)
        }
        if (!rows || rows.length < 100) break
      }
    } catch {} finally {
      polling.delete(roomId)
    }
  }
}, 300)

function wireSource(roomId, username) {
  // @ts-ignore connector typings omit EventEmitter.on
  const conn = new TikTokLiveConnection(username, SIGN_API_KEY ? { signApiKey: SIGN_API_KEY } : {})
  const entry = { conn, username, running: true, connecting: false, timer: null, attempts: 0 }
  sources.set(roomId, entry)

  // Auto-reconnect: a dropped socket on a room that is still meant to run
  // retries with backoff instead of sitting offline until a human presses
  // Connect. Stopped only by an explicit disconnect or by the live ending.
  entry.scheduleReconnect = (reason) => {
    if (!entry.running || entry.timer) return
    entry.attempts += 1
    const delay = Math.min(5_000 * entry.attempts, 60_000)
    log('warning', 'bridge.tiktok', `@${username} reconnect in ${delay / 1000}s (${reason})`).catch(() => {})
    entry.timer = setTimeout(async () => {
      entry.timer = null
      if (!entry.running) return
      await setStatus(roomId, { connected: false, connecting: true, message: `Reconnecting to @${username}…` })
      try {
        await entry.conn.connect()
        entry.attempts = 0
        await setStatus(roomId, { connected: true, message: `Connected to @${username}` })
      } catch (e) {
        const offline = /offline|not live|no live|isn'?t online|not online|useroffline/i.test(String(e?.message || e))
        await log('warning', 'bridge.tiktok', `${username}: ${e?.message || e}`)
        await setStatus(roomId, {
          connected: false,
          connecting: true,
          waiting: offline,
          message: offline ? `@${username} is not live yet` : `Could not connect to @${username}`,
        })
        entry.scheduleReconnect('still offline')
      }
    }, delay)
  }

  // @ts-ignore connector typings omit these event constants
  conn.on(WebcastEvent.CONNECTED ?? 'connected', async () => {
    entry.attempts = 0
    await log('info', 'bridge.tiktok', `connected @${username} room ${roomId}`)
    await setStatus(roomId, { connected: true, connecting: false, waiting: false, liveEnded: false, message: `Connected to @${username}` })
  })
  // @ts-ignore connector typings omit these event constants
  conn.on(WebcastEvent.DISCONNECTED ?? 'disconnected', async () => {
    // A dropped socket is not a stream end: clear a stale liveEnded only when we
    // still intend to run (reconnecting). If the stream genuinely ended
    // (running=false), preserve liveEnded so the room reads as ended, not offline.
    await setStatus(roomId, { connected: false, connecting: entry.running, waiting: false, ...(entry.running ? { liveEnded: false } : {}), message: `Disconnected from @${username}` })
    if (entry.running) entry.scheduleReconnect('socket dropped')
  })
  // @ts-ignore connector typings omit EventEmitter.on
  conn.on(WebcastEvent.STREAM_END ?? 'streamEnd', async () => {
    entry.running = false
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null }
    await setStatus(roomId, { connected: false, liveEnded: true, message: `@${username} is no longer live` })
  })
  // @ts-ignore connector typings omit EventEmitter.on
  conn.on('error', async (e) => {
    await log('error', 'bridge.tiktok', `${username}: ${e?.message || e}`)
  })

  for (const [evt, kind] of Object.entries(EVENT_MAP)) {
    // @ts-ignore connector typings omit EventEmitter.on
    conn.on(evt, (data) => emit(roomId, kind, data).catch(() => {}))
  }
  // SOCIAL: follow vs share.
  // @ts-ignore connector typings omit EventEmitter.on
  conn.on(WebcastEvent.SOCIAL, (data) => {
    const type = String(data.displayType ?? data.socialType ?? '').toLowerCase()
    const kind = type.includes('share') ? 'share' : 'follow'
    emit(roomId, kind, data).catch(() => {})
  })
  return entry
}

async function connectRoom(roomId, username) {
  const existing = sources.get(roomId)
  if (existing && existing.running && existing.username === username) {
    return { status: 'already-connected', username, room_id: roomId, connected: true }
  }
  if (existing) {
    existing.running = false
    try { await existing.conn.disconnect() } catch {}
    sources.delete(roomId)
  }
  const entry = wireSource(roomId, username)
  await setStatus(roomId, { connected: false, connecting: true, waiting: false, liveEnded: false, message: `Connecting to @${username}` })
  entry.conn.connect()
    .then(async () => {
      entry.attempts = 0
      await setStatus(roomId, { connected: true, connecting: false, waiting: false, liveEnded: false, message: `Connected to @${username}` })
    })
    .catch(async (e) => {
      const offline = /offline|not live|no live|isn'?t online|not online|useroffline/i.test(String(e?.message || e))
      await log('warning', 'bridge.tiktok', `${username}: ${e?.message || e}`)
      await setStatus(roomId, {
        connected: false,
        connecting: true,
        waiting: offline,
        liveEnded: false,
        message: offline ? `@${username} is not live yet` : `Could not connect to @${username}`,
      })
      entry.scheduleReconnect('initial connect failed')
    })
  return { status: 'connecting', username, room_id: roomId, provider: 'tiktok' }
}

async function disconnectRoom(roomId) {
  const existing = sources.get(roomId)
  if (existing) {
    existing.running = false
    if (existing.timer) { clearTimeout(existing.timer); existing.timer = null }
    try { await existing.conn.disconnect() } catch {}
    sources.delete(roomId)
    await setStatus(roomId, { connected: false, message: 'Disconnected' })
  }
  return { status: 'disconnected' }
}

// --- HTTP --------------------------------------------------------------------
const USERNAME_RE = /^[A-Za-z0-9._]{2,24}$/

function sendJson(res, obj, status = 200) {
  const body = JSON.stringify(obj)
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' })
  res.end(body)
}

const MAX_BODY_BYTES = 64 * 1024
async function readBody(req) {
  const chunks = []
  let bytes = 0
  for await (const c of req) {
    bytes += c.length
    if (bytes > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(c)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return {}
  try { return JSON.parse(text) } catch { return {} }
}

// The connect/disconnect paths drive a live stream, so they are privileged:
// only a caller holding STREAMKIT_TOKEN may use them. The dashboard proxy
// attaches it server-side; the public nginx vhost forwards these paths straight
// here, so without this check anyone on the internet could stop or start any
// room. `/api/room-connect-by-username` stays open by design — an overlay link
// naming a handle resolves through it with no credential — and `/health` is a
// read. Fail closed when no token is configured, mirroring Convex's own gate.
const TOKEN_HEADER = 'x-streamkit-token'
function hasApiToken(req) {
  if (!API_TOKEN) return false
  const given = String(req.headers[TOKEN_HEADER] || '').trim()
  if (given.length !== API_TOKEN.length) return false
  return timingSafeEqual(Buffer.from(given), Buffer.from(API_TOKEN))
}
function requireApiToken(req, res) {
  if (hasApiToken(req)) return true
  sendJson(res, { detail: 'Invalid or missing token' }, 401)
  return false
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  if (req.method === 'OPTIONS') return sendJson(res, {}, 204)
  try {
    if (url.pathname === '/health') {
      return sendJson(res, { status: 'ok', activeRooms: sources.size, websocketConnections: clients.size })
    }

    if (req.method === 'POST' && url.pathname === '/api/room-connect-by-username') {
      const body = await readBody(req)
      const username = String(body.username || '').trim().replace(/^@/, '')
      if (!USERNAME_RE.test(username) || ['.', '..', '...'].includes(username)) {
        return sendJson(res, { detail: 'username must be 2-24 characters of letters, digits, dot or underscore' }, 400)
      }
      const overlay = body.overlay && typeof body.overlay === 'object' ? body.overlay : {}
      const provider = String(body.provider || 'tiktok')
      if (provider !== 'tiktok') {
        return sendJson(res, { detail: 'unsupported provider' }, 400)
      }
      const found = await m('rooms:findOrCreateByUsername', { username, config: overlay, provider })
      const roomId = found.id
      const result = await connectRoom(roomId, username)
      return sendJson(res, { room_id: roomId, ...result })
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/room-connect/')) {
      if (!requireApiToken(req, res)) return
      const roomId = decodeURIComponent(url.pathname.split('/').pop())
      const room = await q('rooms:getByExternal', { externalId: roomId })
      if (!room?.username) return sendJson(res, { detail: 'room has no username configured; set one in the editor' }, 409)
      const result = await connectRoom(roomId, room.username)
      return sendJson(res, { room_id: roomId, ...result })
    }

    if (req.method === 'POST' && url.pathname === '/api/connect') {
      if (!requireApiToken(req, res)) return
      const body = await readBody(req)
      const username = String(body.username || '').trim().replace(/^@/, '')
      if (!username) return sendJson(res, { detail: 'username is required' }, 400)
      const roomId = body.room_id || 'default'
      const result = await connectRoom(roomId, username)
      return sendJson(res, { room_id: roomId, ...result })
    }

    if (req.method === 'POST' && url.pathname === '/api/disconnect') {
      if (!requireApiToken(req, res)) return
      const body = await readBody(req)
      return sendJson(res, await disconnectRoom(String(body.room_id || 'default')))
    }

    return sendJson(res, { detail: 'Not found' }, 404)
  } catch (e) {
    await log('error', 'bridge.http', `${req.method} ${url.pathname}: ${e?.message || e}`)
    return sendJson(res, { detail: e?.message || 'bridge error' }, 500)
  }
})

// --- WebSocket -----------------------------------------------------------------
const wss = new WebSocketServer({ server })
const CLIENT_TYPES = new Set(['room', 'customizer', 'overlay'])

wss.on('connection', async (ws, req) => {
  const url = new URL(req.url, 'http://localhost')
  const parts = url.pathname.split('/').filter(Boolean)
  const [prefix, clientType, roomIdRaw] = parts
  if (prefix !== 'ws' || !CLIENT_TYPES.has(clientType) || !roomIdRaw) {
    ws.close(1008, 'unknown client type')
    return
  }
  const roomId = decodeURIComponent(roomIdRaw)
  if (clients.size >= MAX_TOTAL || roomClients(roomId).length >= MAX_PER_ROOM) {
    ws.close(1013, 'server at capacity')
    return
  }
  clients.set(ws, { roomId, clientType })
  // Seed from Convex, not the local clock, so nothing written during connect is missed.
  if (!lastSeen.has(roomId)) lastSeen.set(roomId, await q('events:latestCursor', { roomId }).catch(() => Date.now()))

  // Opening frames: config first, then status — same order the old backend sent.
  try {
    const room = await q('rooms:getByExternal', { externalId: roomId })
    const config = pageConfig(room?.config || {})
    ws.send(JSON.stringify({ type: 'config', config }))
    ws.send(JSON.stringify(statusFrame({
      connected: !!room?.connected,
      connecting: !!room?.connecting,
      waiting: !!room?.waiting,
      liveEnded: !!room?.liveEnded,
      message: room?.statusMessage || (room?.connected ? 'Connected' : 'Offline'),
    })))
  } catch {}

  ws.on('message', async (data) => {
    let msg
    try { msg = JSON.parse(data.toString()) } catch { return }
    if (!msg || typeof msg !== 'object') return
    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }))
    } else if (msg.type === 'topChatters') {
      try {
        const chatters = await q('events:topChatters', { roomId, limit: 10 })
        ws.send(JSON.stringify({ type: 'topChatters', chatters }))
      } catch {}
    }
  })
  ws.on('close', () => clients.delete(ws))
  ws.on('error', () => clients.delete(ws))
})

server.listen(PORT, '127.0.0.1', async () => {
  console.log(`tiktok bridge listening on 127.0.0.1:${PORT}, convex ${CONVEX_URL}`)
  // A restart drops every live socket, so any room still marked connecting in
  // Convex is stale — clear it, or the dashboard sits on "Connecting" forever.
  // This is the crash-recovery path; SIGTERM below clears status on the way out.
  try {
    const rooms = await q('rooms:list', {})
    for (const room of rooms || []) {
      await m('rooms:setStatus', { roomId: room.id, connected: false, connecting: false, message: 'Offline' }).catch(() => {})
    }
  } catch {}
})

// systemd sends SIGTERM on restart/deploy. Without a handler the process dies
// mid-socket: TikTok sees an abrupt drop and the dashboard keeps showing LIVE
// until the next boot clears it. Close deliberately, mark rooms offline while
// we still can, then let the listeners drain before exiting.
let shuttingDown = false
async function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`${signal} received; closing TikTok sockets and overlay clients`)
  const force = setTimeout(() => process.exit(0), 5000)
  force.unref()
  for (const [roomId, entry] of sources) {
    entry.running = false
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null }
    try { await entry.conn.disconnect() } catch {}
    try {
      await m('rooms:setStatus', { roomId, connected: false, connecting: false, message: 'Offline' })
    } catch {}
  }
  sources.clear()
  for (const ws of clients.keys()) {
    try { ws.close(1001, 'bridge shutting down') } catch {}
  }
  clients.clear()
  await new Promise((resolve) => wss.close(resolve)).catch(() => {})
  await new Promise((resolve) => server.close(resolve)).catch(() => {})
  process.exit(0)
}
process.on('SIGTERM', () => { void shutdown('SIGTERM') })
process.on('SIGINT', () => { void shutdown('SIGINT') })
