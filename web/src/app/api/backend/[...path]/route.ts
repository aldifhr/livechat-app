/**
 * The API proxy.
 *
 * One handler for every backend call, so there is a single place where the token
 * is attached and a single place to look when a call needs to be made
 * unauthenticated. The browser talks only to this route: it has no idea the
 * backend exists, and it is not holding a credential.
 *
 * The path is forwarded rather than remapped, because a rewrite table here would
 * be a second list of the backend's routes that could drift from the real one.
 */

import { NextRequest } from 'next/server'
import { backendFetch, BackendError } from '@/lib/backend'

/**
 * Everything the dashboard can ask for, as paths below this route.
 *
 * Matched against the backend path rebuilt from the catch-all segments, so the
 * shapes are the backend's own (`/api/rooms`, not `rooms`) and stay readable
 * against its routes. Anything else is refused here rather than forwarded, so
 * this route cannot be used as an open proxy to the backend.
 */
const ALLOWED = [
  /^\/api\/rooms$/,
  /^\/api\/rooms\/[0-9a-f-]{36}$/,
  /^\/api\/rooms\/[0-9a-f-]{36}\/status$/,
  /^\/api\/rooms\/[0-9a-f-]{36}\/config$/,
  /^\/api\/room-connect-by-username$/,
  /^\/api\/room-connect\/[0-9a-f-]{36}$/,
  /^\/api\/disconnect$/,
]

/** Methods that change something. Reads are forwarded without the token. */
const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE'])

function allowed(path: string): boolean {
  return ALLOWED.some((pattern) => pattern.test(path))
}

async function proxy(request: NextRequest): Promise<Response> {
  // Rebuilt rather than read off the URL: the catch-all hands over segments, so
  // `nextUrl.pathname` here is this app's own /api/backend/... — a path the
  // backend has never heard of.
  const segments = request.nextUrl.pathname.split('/').filter(Boolean).slice(2)
  const path = `/api/${segments.join('/')}`

  if (!allowed(path)) {
    return Response.json({ detail: 'Not proxied' }, { status: 404 })
  }

  const method = request.method
  const body = MUTATING.has(method) ? await request.text() : undefined

  try {
    const result = await backendFetch(path, {
      method,
      body: body === '' ? undefined : body,
      // The token rides on the calls that change something. A read does not need
      // it, and attaching a credential to a call that does not require one is how
      // a route ends up reachable with it by accident.
      forwardToken: MUTATING.has(method),
    })
    return Response.json(result ?? null)
  } catch (cause) {
    if (cause instanceof BackendError) {
      return Response.json({ detail: cause.message }, { status: cause.status })
    }
    return Response.json({ detail: 'The backend could not be reached' }, { status: 502 })
  }
}

export const GET = proxy
export const POST = proxy
export const PATCH = proxy
export const DELETE = proxy