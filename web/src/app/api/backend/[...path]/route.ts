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
  /^\/api\/rooms\/[0-9a-f-]{36}\/session$/,
  // The manual trigger, for testing an overlay's styling without waiting for a real
  // gift on a real stream. A write, so the token rides on it via `MUTATING`; it was
  // missing from this list entirely, which made the one route that could prove the
  // styling worked unreachable from the dashboard.
  /^\/api\/rooms\/[0-9a-f-]{36}\/trigger$/,
  /^\/api\/room-connect-by-username$/,
  /^\/api\/room-connect\/[0-9a-f-]{36}$/,
  /^\/api\/disconnect$/,
  /^\/api\/analytics$/,
  /^\/api\/health$/,
  /^\/api\/metrics$/,
  // Giveaway snapshots: the desktop app (no credential) POSTs from its
  // Tauri webview to this proxy, and the public snapshot page reads the
  // result. The backend exempts this path from its own token gate for
  // the same reason — the published link is meant to be opened by anyone.
  /^\/api\/giveaways\/snapshots$/,
  /^\/api\/giveaways\/snapshots\/[A-Za-z0-9_-]{16}$/,
  /^\/api\/rooms\/[0-9a-f-]{36}\/session$/,

  // The backend's own log records. A read, and the backend gates it on the token
  // rather than on the method — so it is in `SENSITIVE_READ` below too, or the
  // proxy would forward it with no credential and the page would always be empty.
  /^\/api\/logs$/,
]

/** Methods that change something. Reads are forwarded without the token.
 *
 *  Every name here is also exported as a handler below. A method listed but not
 *  exported is one the app refuses with a 405 before this list is ever consulted,
 *  so a reader checking `MUTATING` against the exports should find them equal —
 *  and a method that IS exported but missing here would be forwarded as a read,
 *  with no token attached, which is the opposite of what it does. */
const MUTATING = new Set(['POST', 'PATCH', 'DELETE'])

/**
 * Reads that carry the token too, because the backend gates them like a write.
 *
 * `/api/rooms*` answers with every streamer's handle and overlay config, and the
 * backend refuses it without the token. The overlay pages never read it — they
 * open a WebSocket and POST the exempt connect route — so this proxy is the only
 * reader that has to attach the credential.
 *
 * `/api/health` is here for a different reason and answers a different question.
 * The backend serves it to anyone — an orchestrator probes it with no credential
 * and must keep being able to — but it withholds the per-room map unless the
 * caller holds the write token, because each entry names a streamer. Without this
 * the proxy forwarded the read with nothing attached, the map never arrived, and
 * the status page reported "no rooms have connected yet" for a backend with five
 * of them running: a section that could only ever show one thing, showing the
 * wrong one. The counts are not gated and nothing about that changes; only the map
 * is, and this dashboard is behind the session and already reads every handle
 * from `/api/rooms`, so it is not reaching anything new.
 */
const SENSITIVE_READ = /^\/api\/(rooms(\/|$)|logs$|analytics$)/
// Giveaway snapshots are deliberately NOT sensitive-read: the desktop
// app has no token, and the public snapshot page must load without one.
// Without this exclusion the proxy would forward the read with no
// credential and the backend would answer 401.
const PUBLIC_READ = /^\/api\/giveaways\/snapshots/

// Session stats for the OBS docks page: viewer counts, diamonds, totals.
// These are aggregate numbers, not room configs — the docks page is a
// public browser source in OBS and cannot carry a token. The same data
// is already visible on the overlay.
const DOCKS_READ = /^\/api\/rooms\/[0-9a-f-]{36}\/session$/

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

  // The query string travels with the path. It was dropped silently before:
  // `client.ts` builds `URLSearchParams` for every call that takes a `query`, and
  // none of it ever reached the backend, so a filtered or paginated request would
  // have answered as if unfiltered. Rebuilt from the same `nextUrl` the path came
  // from, so the two cannot disagree.
  const query = request.nextUrl.search

  const method = request.method
  const body = MUTATING.has(method) ? await request.text() : undefined
  const forwardToken = MUTATING.has(method) || (SENSITIVE_READ.test(path) && !PUBLIC_READ.test(path) && !DOCKS_READ.test(path))

  try {
    const result = await backendFetch(`${path}${query}`, {
      method,
      body: body === '' ? undefined : body,
      // The token rides on the calls that change something, and on the room
      // reads the backend gates. A read that needs no credential gets none:
      // attaching one where it is not required is how a route ends up reachable
      // with it by accident.
      forwardToken,
    })
    return Response.json(result ?? null)
  } catch (cause) {
    if (cause instanceof BackendError) {
      return Response.json({ detail: cause.message }, { status: cause.status })
    }
    // A fetch that threw rather than answered: no response at all, so the backend
    // is unreachable rather than refusing. Same sentence as the 502 an intermediary
    // produces for the same situation, because it is the same situation.
    return Response.json({ detail: 'The backend could not be reached.' }, { status: 502 })
  }
}

export const GET = proxy
export const POST = proxy
export const PATCH = proxy
export const DELETE = proxy