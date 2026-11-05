/**
 * API gateway — every request is served by Convex, except the TikTok
 * connect/disconnect paths, which need a long-lived socket and therefore go to
 * the Node TikTok bridge in `backend/`.
 */

import { NextRequest } from 'next/server'
import { backendFetch, BackendError } from '@/lib/server/backend'
import { convexMutation, convexQuery } from '@/lib/server/convex'

const TIKTOK_BRIDGE_PATHS = [
  /^\/api\/room-connect-by-username$/,
  /^\/api\/room-connect\/[0-9a-f-]{36}$/,
  /^\/api\/connect$/,
  /^\/api\/disconnect$/,
]

type ConvexCall = {
  module: string
  functionName: string
  type: 'query' | 'mutation'
  args?: (body: any, segments: string[], search: URLSearchParams) => Record<string, unknown>
  map?: (value: any, body: any) => any
}

const roomStatus = (r: any) => ({
  type: 'status',
  connected: !!r?.connected,
  connecting: !!r?.connecting,
  waiting: !!r?.waiting,
  liveEnded: !!r?.liveEnded,
  message: r?.statusMessage || (r?.connected ? 'Connected' : 'Offline'),
  viewers: r?.viewers ?? 0,
})

const CONVEX_ROUTES: Record<string, ConvexCall> = {
  'GET /api/rooms': { module: 'rooms', functionName: 'list', type: 'query', map: (v) => ({ rooms: v }) },
  'GET /api/rooms/public': { module: 'rooms', functionName: 'publicList', type: 'query', map: (v) => ({ rooms: v }) },
  'GET /api/rooms/{id}': { module: 'rooms', functionName: 'get', type: 'query', args: (_b, s) => ({ roomId: s[1] }) },
  'GET /api/rooms/{id}/status': { module: 'rooms', functionName: 'getByExternal', type: 'query', args: (_b, s) => ({ externalId: s[1] }), map: roomStatus },
  'GET /api/rooms/{id}/session': { module: 'rooms', functionName: 'getSession', type: 'query', args: (_b, s) => ({ roomId: s[1] }) },
  'POST /api/rooms': { module: 'rooms', functionName: 'create', type: 'mutation', args: (body) => ({ name: body?.name || 'Untitled', username: body?.username, config: body?.config, provider: body?.provider }) },
  'PATCH /api/rooms/{id}': { module: 'rooms', functionName: 'update', type: 'mutation', args: (body, s) => ({ roomId: s[1], name: body?.name, username: body?.username, provider: body?.provider }) },
  'DELETE /api/rooms/{id}': { module: 'rooms', functionName: 'deleteRoom', type: 'mutation', args: (_b, s) => ({ roomId: s[1] }) },
  'POST /api/rooms/{id}/config': { module: 'rooms', functionName: 'updateConfig', type: 'mutation', args: (body, s) => ({ roomId: s[1], config: body?.config ?? {} }) },
  'GET /api/health': { module: 'events', functionName: 'health', type: 'query', args: (_b, _s, search) => ({ withRooms: search.get('rooms') === '1' }) },
  'GET /api/metrics': { module: 'events', functionName: 'metricsSummary', type: 'query' },
  'GET /api/analytics': { module: 'rooms', functionName: 'analytics', type: 'query', args: (_b, _s, search) => ({ provider: search.get('provider') || undefined }) },
  'GET /api/logs': { module: 'events', functionName: 'listLogs', type: 'query', args: (_b, _s, search) => ({ limit: Number(search.get('limit') || 200), level: search.get('level') || undefined, q: search.get('q') || undefined }) },
  'GET /api/giveaways/snapshots': { module: 'giveaways', functionName: 'listSnapshots', type: 'query', map: (v) => ({ snapshots: v }) },
  'GET /api/giveaways/snapshots/{id}': { module: 'giveaways', functionName: 'getSnapshot', type: 'query', args: (_b, s) => ({ id: s[2] }) },
  'POST /api/giveaways/snapshots': { module: 'giveaways', functionName: 'saveSnapshot', type: 'mutation', args: (body) => ({ keyword: body?.report?.keyword || body?.keyword || 'giveaway', data: body?.report || body, roomId: body?.roomId }) },
  'DELETE /api/giveaways/snapshots/{id}': { module: 'giveaways', functionName: 'deleteSnapshot', type: 'mutation', args: (_b, s) => ({ id: s[2] }) },
  'POST /api/rooms/{id}/trigger': { module: 'events', functionName: 'trigger', type: 'mutation', args: (body, s) => ({ roomId: s[1], kind: body?.kind || 'alert', user: body?.user, userId: body?.user_id || body?.userId, text: body?.text, title: body?.title, icon: body?.icon, count: body?.count, diamonds: body?.diamonds, months: body?.months }) },
  'POST /api/hooks/{id}': { module: 'events', functionName: 'trigger', type: 'mutation', args: (body, s) => ({ roomId: s[1], kind: body?.kind || 'alert', user: body?.user, userId: body?.user_id || body?.userId, text: body?.text || (body?.amount != null ? String(body.amount) : undefined), title: body?.title, icon: body?.icon, amount: body?.amount }) },
}

function matchKey(method: string, normalizedPath: string, hasRoomId: boolean, hasSnapshotId: boolean): string | null {
  if (method === 'GET' && normalizedPath === '/api/rooms') return 'GET /api/rooms'
  if (method === 'GET' && normalizedPath === '/api/rooms/public') return 'GET /api/rooms/public'
  if (method === 'GET' && hasRoomId && normalizedPath.endsWith('/session')) return 'GET /api/rooms/{id}/session'
  if (method === 'GET' && hasRoomId && normalizedPath.endsWith('/status')) return 'GET /api/rooms/{id}/status'
  if (method === 'GET' && hasRoomId) return 'GET /api/rooms/{id}'
  if (method === 'POST' && normalizedPath === '/api/rooms') return 'POST /api/rooms'
  if (method === 'PATCH' && hasRoomId) return 'PATCH /api/rooms/{id}'
  if (method === 'DELETE' && hasRoomId) return 'DELETE /api/rooms/{id}'
  if (method === 'POST' && hasRoomId && normalizedPath.endsWith('/config')) return 'POST /api/rooms/{id}/config'
  if (method === 'POST' && hasRoomId && normalizedPath.endsWith('/trigger')) return 'POST /api/rooms/{id}/trigger'
  if (method === 'POST' && normalizedPath.match(/^\/api\/hooks\/[^/]+$/)) return 'POST /api/hooks/{id}'
  if (method === 'GET' && normalizedPath === '/api/health') return 'GET /api/health'
  if (method === 'GET' && normalizedPath === '/api/metrics') return 'GET /api/metrics'
  if (method === 'GET' && normalizedPath === '/api/analytics') return 'GET /api/analytics'
  if (method === 'GET' && normalizedPath === '/api/logs') return 'GET /api/logs'
  if (method === 'GET' && normalizedPath === '/api/giveaways/snapshots') return 'GET /api/giveaways/snapshots'
  if (method === 'GET' && hasSnapshotId) return 'GET /api/giveaways/snapshots/{id}'
  if (method === 'POST' && normalizedPath === '/api/giveaways/snapshots') return 'POST /api/giveaways/snapshots'
  if (method === 'DELETE' && hasSnapshotId) return 'DELETE /api/giveaways/snapshots/{id}'
  return null
}

function parseBody(text: string | undefined): any {
  if (!text) return {}
  try { return JSON.parse(text) } catch { return {} }
}

async function proxy(request: NextRequest): Promise<Response> {
  const segmentsAll = request.nextUrl.pathname.split('/').filter(Boolean).slice(2)
  const path = `/api/${segmentsAll.join('/')}`
  const normalizedPath = path.replace(/\/[0-9a-f-]{36}(?=\/|$)/, '/{id}')
  const bodyText = ['POST', 'PATCH', 'DELETE'].includes(request.method) ? await request.text() : undefined
  const body = parseBody(bodyText)
  const hasRoomId = Boolean(path.match(/^\/api\/rooms\/[^/]+/))
  const hasSnapshotId = Boolean(path.match(/^\/api\/giveaways\/snapshots\/[^/]+/))
  const key = matchKey(request.method, normalizedPath, hasRoomId, hasSnapshotId)

  // TikTok connect/disconnect needs a long-lived socket: the Node bridge.
  if (TIKTOK_BRIDGE_PATHS.some((p) => p.test(path))) {
    try {
      const result = await backendFetch(`${path}${request.nextUrl.search}`, { method: request.method, body: bodyText === '' ? undefined : bodyText })
      return Response.json(result ?? null)
    } catch (cause) {
      if (cause instanceof BackendError) return Response.json({ detail: cause.message }, { status: cause.status })
      return Response.json({ detail: 'The TikTok bridge could not be reached.' }, { status: 502 })
    }
  }

  if (!key || !CONVEX_ROUTES[key as string]) {
    return Response.json({ detail: 'Not proxied' }, { status: 404 })
  }

  const call = CONVEX_ROUTES[key as string]
  try {
    const fnPath = `${call.module}:${call.functionName}`
    const args = call.args ? call.args(body, segmentsAll, request.nextUrl.searchParams) : {}
    const value = call.type === 'query'
      ? await convexQuery(fnPath, args)
      : await convexMutation(fnPath, args)
    if ((value as any)?.notFound) return Response.json({ detail: 'Room not found' }, { status: 404 })

    // Room mutations answer with the room, like the old API did.
    if (key === 'POST /api/rooms' || key === 'PATCH /api/rooms/{id}') {
      const roomId = (value as any)?.id || segmentsAll.at(-1)
      const room = await convexQuery('rooms:get', { roomId })
      return Response.json({ room })
    }
    if (key === 'POST /api/rooms/{id}/config' || key === 'DELETE /api/rooms/{id}') {
      return Response.json({ status: 'ok' })
    }
    if (key === 'GET /api/giveaways/snapshots/{id}' && !value) {
      return Response.json({ detail: 'Giveaway report not found' }, { status: 404 })
    }
    return Response.json(call.map ? call.map(value, body) : value ?? null)
  } catch (cause) {
    return Response.json({ detail: cause instanceof Error ? cause.message : 'Convex request failed' }, { status: 500 })
  }
}

export const GET = proxy
export const POST = proxy
export const PATCH = proxy
export const DELETE = proxy
