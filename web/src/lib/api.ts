/**
 * Talking to the backend.
 *
 * Every call the dashboard makes goes through here, for one reason: the write
 * routes are behind the backend's own token, and a token that reached the client
 * bundle would be readable by anyone who opens the page. It is not baked into the
 * build — the operator pastes it once per browser session and it is held in
 * sessionStorage, which dies with the tab, rather than localStorage where it
 * would sit readable on a shared machine for a year.
 *
 * Reads are open on the backend on purpose: OBS loads the overlay with no
 * credential at all, so the room list is not behind the token either.
 */

/** Where the backend lives. Overridable at build time for a staging deploy. */
export const API_BASE: string =
  (import.meta.env.VITE_API_BASE as string | undefined) ?? 'https://kit-backend.aldifhr.my.id'

const TOKEN_KEY = 'streamtools.token'

/** The token for this browser session, or empty if none has been entered. */
export function token(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? ''
  } catch {
    // Private browsing modes throw on sessionStorage access rather than
    // returning null. A dashboard that cannot store its token is a dashboard that
    // asks for it again on every write, which is worse than not remembering it.
    return ''
  }
}

export function setToken(value: string): void {
  try {
    if (value) sessionStorage.setItem(TOKEN_KEY, value)
    else sessionStorage.removeItem(TOKEN_KEY)
  } catch {
    // Nothing to do: the token is then held in memory only, which still works for
    // this page load and simply is not remembered.
  }
}

/** Whether a write can be attempted at all. */
export function hasToken(): boolean {
  return token() !== ''
}

/**
 * A failed request, carrying the status so a caller can tell "your token is
 * wrong" (401/403) from "the backend is down" (everything else) — which are
 * different problems with different fixes.
 */
export class ApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

/** Whether a status means the token was rejected rather than the call failing. */
export function isAuthFailure(status: number): boolean {
  return status === 401 || status === 403
}

type Query = Record<string, string | number | boolean | undefined>

/**
 * One request, with the token attached when there is one.
 *
 * The token goes on every call rather than only the writes so that a wrong token
 * surfaces on the first read that hits a gated route, instead of looking fine
 * until a button is pressed.
 */
async function request<T>(method: string, path: string, body?: unknown, query?: Query): Promise<T> {
  const url = new URL(path, API_BASE)
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value))
  }

  const headers: Record<string, string> = {}
  const current = token()
  if (current) headers['x-streamkit-token'] = current
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  let response: Response
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (error) {
    // A network-level failure is never the caller's fault and never means the
    // token is wrong, so it does not carry a status: `isAuthFailure` has to be
    // able to tell it apart.
    throw new ApiError(0, error instanceof Error ? error.message : 'The backend could not be reached')
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new ApiError(
      response.status,
      detail || `${method} ${path} failed with ${response.status}`,
    )
  }
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

/** A room as the backend describes it. */
export interface Room {
  id: string
  name: string
  username: string
  config: Record<string, unknown>
  createdAt: number
}

export interface RoomStatus {
  connected: boolean
  username?: string
  message?: string
  viewers?: number
}

export const api = {
  rooms: () => request<{ rooms: Room[] }>('GET', '/api/rooms'),
  room: (id: string) => request<Room>('GET', `/api/rooms/${id}`),
  status: (id: string) => request<RoomStatus>('GET', `/api/rooms/${id}/status`),
  createRoom: (name: string) => request<Room>('POST', '/api/rooms', { name }),
  deleteRoom: (id: string) => request<void>('DELETE', `/api/rooms/${id}`),
  saveConfig: (id: string, config: Record<string, unknown>) =>
    request<Room>('POST', `/api/rooms/${id}/config`, { config }),
  /** The address a streamer pastes into OBS. */
  overlayUrl: (id: string, params?: Query) => {
    const url = new URL('/overlay/', API_BASE)
    url.searchParams.set('room', id)
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    return url.toString()
  },
  topChatterUrl: (id: string, params?: Query) => {
    const url = new URL('/topchatter/', API_BASE)
    url.searchParams.set('room', id)
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    return url.toString()
  },
}