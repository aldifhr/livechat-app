/**
 * Reaching the backend.
 *
 * Every call leaves this Next server — the browser never talks to the backend
 * directly, and never sees its token. `STREAMKIT_TOKEN` is read here, at runtime,
 * from the environment: it is not inlined into a bundle, not prefixed with
 * NEXT_PUBLIC_, and not reachable from any client component. That is the whole
 * reason this is a server and not a static build — a token in a JS file is a
 * token anyone can read by viewing the page source.
 *
 * Reads still go through the same place even though the backend leaves them open,
 * so there is one code path rather than two and the URLs are never assembled in
 * two different ways.
 */

import 'server-only'

/** The backend, from the server's own environment. */
export const BACKEND =
  process.env.BACKEND_URL?.replace(/\/+$/, '') ?? 'https://kit-backend.aldifhr.my.id'

/** The overlay pages, which the dashboard hands to OBS. Same host as the backend
 *  by default because that is where they are served; set separately when a
 *  deployment splits them. */
export const OVERLAY_ORIGIN =
  process.env.OVERLAY_ORIGIN?.replace(/\/+$/, '') ?? BACKEND

/**
 * Whether a token is configured.
 *
 * Read by the server on each request rather than at module load, so a token added
 * to the environment does not need a restart to take effect — which is the reason
 * it lives in a file rather than baked into a build.
 */
export function hasToken(): boolean {
  return (process.env.STREAMKIT_TOKEN ?? '').trim() !== ''
}

/**
 * One request to the backend, with the token attached.
 *
 * `forwardToken: false` is used for the calls a page makes to read something. The
 * backend leaves those open, and forwarding a credential on a call that does not
 * need one means a future route that turns out to be write-capable would be
 * reached with the token attached by default rather than by a decision.
 */
export async function backendFetch<T>(
  path: string,
  init: RequestInit & { forwardToken?: boolean } = {},
): Promise<T> {
  const { forwardToken = true, ...request } = init

  const headers = new Headers(request.headers)
  if (forwardToken) {
    const token = (process.env.STREAMKIT_TOKEN ?? '').trim()
    if (token) headers.set('x-streamkit-token', token)
  }
  if (request.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }

  const response = await fetch(`${BACKEND}${path}`, {
    ...request,
    headers,
    // The backend is the source of truth for whether a room is connected, so a
    // page must never be answered from a cache that was filled a minute ago.
    cache: 'no-store',
  })

  if (!response.ok) {
    throw new BackendError(response.status, await response.text().catch(() => ''))
  }
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

/** A backend call that failed, carrying the status so a caller can tell a refused
 *  credential from a backend that is down. */
export class BackendError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'BackendError'
  }
}