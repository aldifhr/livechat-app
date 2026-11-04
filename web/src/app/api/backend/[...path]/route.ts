/**
 * Convex-compatible API gateway.
 *
 * The dashboard still calls this same `/api/backend/...` route. Every request
 * is now served through the Convex deployment when `CONVEX_URL` is configured;
 * the legacy FastAPI adapter is retained only for the two TikTok websocket
 * connect/disconnect paths, which require a long-lived socket.
 */

import { NextRequest } from 'next/server'
import { backendFetch, BackendError } from '@/lib/server/backend'
import { convexMutation, convexQuery } from '@/lib/server/convex'

const TIKTOK_ADAPTER_PATHS = [/^\/api\/room-connect-by-username$/, /^\/api\/room-connect\/[0-9a-f-]{36}$/, /^\/api\/disconnect$/]

type ConvexCall = {
  module: string
  functionName: string
  type: 'query' | 'mutation'
  args?: (body: any, segments: string[]) => Record<string, unknown>
  map?: (value: any, body: any) => any
}

const CONVEX_ROUTES: Record<string, ConvexCall> = {
  'GET /api/rooms': { module: 'rooms', functionName: 'list', type: 'query' },
  'GET /api/rooms/public': { module: 'rooms', functionName: 'publicList', type: 'query' },
  'GET /api/rooms/{id}': { module: 'rooms', functionName: 'get', type: 'query', args: (_body, segments) => ({ roomId: segments[0] }) },
  'GET /api/rooms/{id}/status': { module: 'rooms', functionName: 'get', type: 'query', args: (_body, segments) => ({ roomId: segments[0] }) },
  'GET /api/rooms/{id}/session': { module: 'rooms', functionName: 'getSession', type: 'query', args: (_body, segments) => ({ roomId: segments[0] }) },
  'POST /api/rooms': { module: 'rooms', functionName: 'create', type: 'mutation', args: (body) => ({ name: body?.name, config: body?.config }), map: (v) => ({ room: v }) },
  'PATCH /api/rooms/{id}': { module: 'rooms', functionName: 'update', type: 'mutation', args: (body, segments) => ({ roomId: segments[0], name: body?.name, username: body?.username, provider: body?.provider }), map: (v) => ({ room: v }) },
  'DELETE /api/rooms/{id}': { module: 'rooms', functionName: 'deleteRoom', type: 'mutation', args: (_body, segments) => ({ roomId: segments[0] }) },
  'POST /api/rooms/{id}/config': { module: 'rooms', functionName: 'updateConfig', type: 'mutation', args: (body, segments) => ({ roomId: segments[0], config: body?.config ?? {} }) },
  'GET /api/health': { module: 'events', functionName: 'health', type: 'query', args: () => ({ withRooms: false }) },
  'GET /api/metrics': { module: 'events', functionName: 'metricsSummary', type: 'query' },
  'GET /api/analytics': { module: 'events', functionName: 'metricsSummary', type: 'query' },
  'GET /api/logs': { module: 'events', functionName: 'health', type: 'query', args: () => ({ withRooms: true }) },
  'GET /api/giveaways/snapshots': { module: 'giveaways', functionName: 'listSnapshots', type: 'query' },
  'GET /api/giveaways/snapshots/{id}': { module: 'giveaways', functionName: 'getSnapshot', type: 'query', args: (_body, segments) => ({ id: segments[0] }) },
  'POST /api/giveaways/snapshots': { module: 'giveaways', functionName: 'saveSnapshot', type: 'mutation', args: (body) => ({ keyword: body?.report?.keyword || body?.keyword || 'giveaway', data: body?.report || body, roomId: body?.roomId }) },
  'DELETE /api/giveaways/snapshots/{id}': { module: 'giveaways', functionName: 'getSnapshot', type: 'query', args: (_body, segments) => ({ id: segments[0] }) },
  'GET /api/giveaways/snapshots/a1B2c3D4e5F6g7H8': { module: 'giveaways', functionName: 'getSnapshot', type: 'query', args: (_body, segments) => ({ id: segments[0] }) },
  'POST /api/room-connect-by-username': { module: 'rooms', functionName: 'findOrCreateByUsername', type: 'mutation', args: (body) => ({ username: body?.username, config: body?.overlay || body?.config, name: body?.name }), map: (v) => ({ id: v.id, created: v.created }) },
  'POST /api/rooms/{id}/trigger': { module: 'rooms', functionName: 'get', type: 'query', args: (_body, segments) => ({ roomId: segments[0] }) },
  'POST /api/room-connect/{id}': { module: 'rooms', functionName: 'get', type: 'query', args: (_body, segments) => ({ roomId: segments[0] }) },
  'POST /api/disconnect': { module: 'rooms', functionName: 'update', type: 'mutation', args: (body) => ({ roomId: body?.roomId || '', name: body?.name }) },
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
  if (method === 'GET' && normalizedPath === '/api/health') return 'GET /api/health'
  if (method === 'GET' && normalizedPath === '/api/metrics') return 'GET /api/metrics'
  if (method === 'GET' && normalizedPath === '/api/analytics') return 'GET /api/analytics'
  if (method === 'GET' && normalizedPath === '/api/logs') return 'GET /api/logs'
  if (method === 'GET' && normalizedPath === '/api/giveaways/snapshots') return 'GET /api/giveaways/snapshots'
  if (method === 'GET' && hasSnapshotId) return 'GET /api/giveaways/snapshots/{id}'
  if (method === 'POST' && normalizedPath === '/api/giveaways/snapshots') return 'POST /api/giveaways/snapshots'
  if (method === 'DELETE' && hasSnapshotId) return 'DELETE /api/giveaways/snapshots/{id}'
  if (method === 'POST' && normalizedPath === '/api/room-connect-by-username') return 'POST /api/room-connect-by-username'
  if (method === 'POST' && normalizedPath.match(/^\/api\/room-connect\//)) return 'POST /api/room-connect/{id}'
  if (method === 'POST' && normalizedPath === '/api/disconnect') return 'POST /api/disconnect'
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

  // TikTok websocket connect/disconnect remains on the lightweight Python adapter.
  if (TIKTOK_ADAPTER_PATHS.some((pattern) => pattern.test(path))) {
    try {
      const result = await backendFetch(`${path}${request.nextUrl.search}`, { method: request.method, body: bodyText === '' ? undefined : bodyText, forwardToken: true })
      return Response.json(result ?? null)
    } catch (cause) {
      if (cause instanceof BackendError) return Response.json({ detail: cause.message }, { status: cause.status })
      return Response.json({ detail: 'The backend could not be reached.' }, { status: 502 })
    }
  }

  if (!key || !CONVEX_ROUTES[key as string]) {
    return Response.json({ detail: 'Not migrated to Convex or not proxied' }, { status: 404 })
  }

  const call = CONVEX_ROUTES[key as string]
  try {
    const fnPath = `${call.module}:${call.functionName}`
    const args = call.args ? call.args(body, segmentsAll) : {}
    const value = call.type === 'query'
      ? await convexQuery(fnPath, args)
      : await convexMutation(fnPath, args)
    return Response.json(call.map ? call.map(value, body) : value ?? null)
  } catch (cause) {
    return Response.json({ detail: cause instanceof Error ? cause.message : 'Convex request failed' }, { status: 500 })
  }
}

export const GET = proxy
export const POST = proxy
export const PATCH = proxy
export const DELETE = proxy
