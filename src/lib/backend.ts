/**
 * The backend as a source, and how a typed URL is read.
 *
 * The URL is a normal web address here rather than a socket one: the host is what
 * opens the socket, and it is better at deciding the scheme than a string the
 * user typed. `https` in means `wss` out, so this only has to strip and trim.
 */

export interface BackendConfig {
  /** Origin, optionally with a path: `https://kit-backend.example`. */
  baseUrl: string
  /** Which overlay's room to read. One overlay is one connected room. */
  overlayId: string
}

export const EMPTY_BACKEND: BackendConfig = { baseUrl: '', overlayId: '' }

/** Where the app's chat comes from. */
export type EventSource = 'bridge' | 'backend'

/**
 * A base URL as typed, ready for the host to turn into a socket address.
 *
 * Trailing slashes come off because the host joins the socket path itself, and
 * two of them is a path the backend does not serve.
 */
export function normaliseBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '')
}

/** Whether there is enough to ask the host to connect. */
export function isReady(config: BackendConfig): boolean {
  return normaliseBaseUrl(config.baseUrl) !== '' && config.overlayId.trim() !== ''
}