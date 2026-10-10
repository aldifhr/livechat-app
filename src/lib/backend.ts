/**
 * The backend as a source, and how a typed address and handle are read.
 *
 * The URL is a normal web address here rather than a socket one: the host is what
 * opens the socket, and it is better at deciding the scheme than a string the
 * user typed. `https` in means `wss` out, so this only has to strip and trim.
 *
 * What the user supplies is a handle, not a room id. The backend keys everything
 * by room and exposes no lookup, so the host resolves one from `GET /api/rooms`
 * — but nobody should have to read a UUID out of a dashboard to watch a stream.
 */

export interface BackendConfig {
  /** Origin, optionally with a path: `https://kit-backend.example`. */
  baseUrl: string
  /** The streamer's TikTok handle: `mybasic.indonesia`. */
  username: string
}

export const EMPTY_BACKEND: BackendConfig = { baseUrl: '', username: '' }

/**
 * A base URL as typed, ready for the host to turn into a socket address.
 *
 * Trailing slashes come off because the host joins the socket path itself, and
 * two of them is a path the backend does not serve.
 */
export function normaliseBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '')
}

/**
 * A handle as typed, reduced to what the backend has stored.
 *
 * The room is found by exact username match, so a handle pasted as a link and one
 * typed bare have to reduce to the same string — a disagreement here reads as a
 * missing stream rather than as a typo.
 */
export function normaliseUsername(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === '') return ''
  const fromUrl = /tiktok\.com\/@([^/?#]+)/i.exec(trimmed)
  const handle = fromUrl ? fromUrl[1] : trimmed.replace(/^@+/, '')
  return handle.split(/[/?#]/)[0].trim()
}

/** Whether there is enough to ask the host to connect. */
export function isReady(config: BackendConfig): boolean {
  return normaliseBaseUrl(config.baseUrl) !== '' && normaliseUsername(config.username) !== ''
}