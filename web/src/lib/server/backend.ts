/**
 * The TikTok bridge, from the server's own environment.
 *
 * State no longer lives here: rooms, events, sessions, giveaways and logs are
 * all in Convex. This process is the small Node bridge in `backend/` — it holds
 * the long-lived TikTok socket and the overlay WebSocket fan-out, and pushes
 * every event into Convex mutations. Convex Functions cannot hold a socket
 * open for hours, which is why this bridge exists at all.
 */

import 'server-only'

/**
 * The bridge, from the server's own environment. The VPS service sets
 * BRIDGE_URL to loopback; everywhere else (Vercel included) the bridge is
 * reached through its public host — nginx routes the connect/disconnect
 * paths to it, so the public origin works for those calls.
 */
export const BACKEND =
  process.env.BRIDGE_URL?.replace(/\/+$/, '') ?? 'https://kit-backend.aldifhr.my.id'

/**
 * The backend as a *browser* has to reach it.
 *
 * The bridge's WebSocket and the Convex deployment share the kit-backend host:
 * nginx routes `/ws/` and `/api/room-connect*` to the bridge and everything
 * else to Convex. A page that opens the overlay socket runs in somebody else's
 * browser, where `127.0.0.1` is their own machine, so the baked origin has to
 * be the public host.
 */
export const BACKEND_ORIGIN =
  process.env.BACKEND_ORIGIN?.replace(/\/+$/, '') ?? 'https://kit-backend.aldifhr.my.id'

/** One request to the TikTok bridge. */
export async function backendFetch<T>(
  path: string,
  init: RequestInit & { forwardToken?: boolean } = {},
): Promise<T> {
  const { forwardToken: _forwardToken, ...request } = init

  const headers = new Headers(request.headers)
  if (request.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }

  const response = await fetch(`${BACKEND}${path}`, {
    ...request,
    headers,
    cache: 'no-store',
    signal: AbortSignal.timeout(30_000),
  })

  if (!response.ok) {
    throw new BackendError(response.status, await describe_failure(response))
  }
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

const UNREACHABLE: Record<number, string> = {
  502: 'The TikTok bridge could not be reached.',
  503: 'The TikTok bridge is not accepting requests.',
  504: 'The TikTok bridge did not answer in time.',
}

async function describe_failure(response: Response): Promise<string> {
  const body = await response.text().catch(() => '')
  if (body) {
    try {
      const parsed: unknown = JSON.parse(body)
      if (parsed && typeof parsed === 'object' && 'detail' in parsed) {
        const detail = (parsed as { detail: unknown }).detail
        if (typeof detail === 'string' && detail) return detail
      }
    } catch {}
  }
  return UNREACHABLE[response.status] ?? `The TikTok bridge answered ${response.status}.`
}

/** A bridge call that failed, carrying the status. */
export class BackendError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'BackendError'
  }
}
