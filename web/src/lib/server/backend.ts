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

/** The backend, from the server's own environment.
 *
 * Loopback by default: the backend binds 127.0.0.1:8000 and runs on the same box
 * as this server, so the default used to be a public hostname that sent every
 * dashboard call out to the router and back — and made the backend's own listener
 * look like something this app depended on. It does not. `BACKEND_URL` overrides
 * it for a split deployment.
 */
export const BACKEND =
  process.env.BACKEND_URL?.replace(/\/+$/, '') ?? 'http://127.0.0.1:8000'

/**
 * The backend as a *browser* has to reach it.
 *
 * Deliberately a different constant from `BACKEND`, and the split is the whole
 * point. This server fetches the backend over loopback; a page that opens the
 * overlay socket — the dashboard's giveaway runner, the injected overlay config —
 * is running in somebody else's browser, where `127.0.0.1` is their own machine
 * and not this one. It used to be one constant serving both, which left a choice
 * between a public hostname for server-side fetches (a round trip out to the
 * router and back on every dashboard call, and a backend that had to be on the
 * internet) and a loopback address handed to the browser (a socket that could
 * never open).
 *
 * The dashboard host is the default because that host already proxies `/ws/` and
 * `/api/room-connect-by-username` through to the backend, so the backend needs no
 * public listener of its own. `BACKEND_ORIGIN` overrides it for a split
 * deployment.
 */
export const BACKEND_ORIGIN =
  process.env.BACKEND_ORIGIN?.replace(/\/+$/, '') ?? 'https://streamtools.aldifhr.my.id'

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
    // A backend that stops answering — wedged, not down; it still accepts the
    // connection — used to leave this request open until the browser's own
    // timeout, holding the caller's state in its "loading" branch. Ten seconds
    // is several times the slowest legitimate call on this dashboard.
    signal: AbortSignal.timeout(10_000),
  })

  if (!response.ok) {
    throw new BackendError(response.status, await describe_failure(response))
  }
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

/** Statuses an intermediary produces when it could not reach the backend, rather
 *  than anything the backend decided. */
const UNREACHABLE: Record<number, string> = {
  502: 'The backend could not be reached.',
  503: 'The backend is not accepting requests.',
  504: 'The backend did not answer in time.',
}

/**
 * What to say about a call that did not succeed.
 *
 * The body is not the message. It used to be — `response.text()` went straight
 * into the error — and that put two different things in front of the operator:
 *
 *   - **The backend's own errors, as raw JSON.** FastAPI answers a 404 with
 *     `{"detail":"Room not found"}`, so the page rendered
 *     `{"detail":"Room not found"}` with the braces and the quotes. Every
 *     refusal in the console was a line of JSON.
 *
 *   - **An intermediary's error page, verbatim.** The backend sits behind its own
 *     nginx, so a restart or an early close comes back as a 502 carrying a page
 *     of HTML — and six lines of `<center><h1>502 Bad Gateway</h1></center>` were
 *     the error message on the page. Whoever saw it was told what nginx said
 *     rather than what was wrong, which is the one thing the sentence was for.
 *
 * So the body is read for the one field the backend actually uses to explain
 * itself, and anything else is a sentence about the status. An intermediary's
 * 502 means the backend is unreachable, which is what the `catch` below already
 * says when the request never got an answer at all — so the two now agree
 * instead of one being a sentence and the other a web page.
 *
 * A `detail` that is not a string — FastAPI's 422 answers with a list of objects —
 * is deliberately not rendered. A validation report is for whoever wrote the
 * request, and the one reading this is an operator told a button did nothing.
 */
async function describe_failure(response: Response): Promise<string> {
  const body = await response.text().catch(() => '')
  if (body) {
    try {
      const parsed: unknown = JSON.parse(body)
      if (parsed && typeof parsed === 'object' && 'detail' in parsed) {
        const detail = (parsed as { detail: unknown }).detail
        if (typeof detail === 'string' && detail) return detail
      }
    } catch {
      // Not JSON, so not the backend's own vocabulary. Whatever it is, it is not
      // a sentence to show somebody.
    }
  }
  return UNREACHABLE[response.status] ?? `The backend answered ${response.status}.`
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