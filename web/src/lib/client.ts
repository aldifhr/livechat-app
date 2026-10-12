/**
 * The browser's way of asking for something.
 *
 * Every call goes to this app's own `/api/backend` route, which attaches the
 * token on the server. There is no token in this file, in `NEXT_PUBLIC_` anything,
 * or anywhere else the browser could read one — the credential lives in the
 * server's environment and stops here.
 */

'use client'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** Whether a status means the credential was refused rather than the call
 *  failing. Both mean "try again differently" but the fix is different. */
export function isAuthFailure(status: number): boolean {
  return status === 401 || status === 403
}

const BASE = '/api/backend'

type Query = Record<string, string | number | boolean | undefined>

async function request<T>(method: string, path: string, body?: unknown, query?: Query): Promise<T> {
  const url = new URL(`${BASE}${path}`, window.location.origin)
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value))
  }

  let response: Response
  try {
    response = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    })
  } catch (error) {
    throw new ApiError(0, error instanceof Error ? error.message : 'The request could not be sent')
  }

  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { detail?: string }
    throw new ApiError(response.status, payload.detail ?? `${method} ${path} failed`)
  }
  return (await response.json()) as T
}

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

/**
 * The overlay pages as this app serves them.
 *
 * Read from the page itself rather than a build-time constant, so a deployment
 * that moves the frontend domain does not have to rebuild for the links handed
 * to OBS to be right.
 */
const origin = typeof window === 'undefined' ? '' : window.location.origin

function overlayUrl(path: string, id: string, params?: Query): string {
  const url = new URL(path, origin)
  url.searchParams.set('room', id)
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value))
  }
  return url.toString()
}

export const api = {
  rooms: () => request<{ rooms: Room[] }>('GET', '/rooms'),
  status: (id: string) => request<RoomStatus>('GET', `/rooms/${id}/status`),
  connectHandle: (username: string) => request<Room>('POST', '/room-connect-by-username', { username }),
  connectRoom: (id: string) => request<Room>('POST', `/room-connect/${id}`),
  updateRoom: (id: string, change: { name?: string; username?: string }) =>
    request<Room>('PATCH', `/rooms/${id}`, change),
  deleteRoom: (id: string) => request<null>('DELETE', `/rooms/${id}`),
  // One URL per overlay so a customiser or a scene collection points at
  // exactly one page. The bare /overlay path still redirects, for links pasted
  // before the split.
  chatOverlay: (id: string, params?: Query) => overlayUrl('/overlay/chat-overlay', id, params),
  topChatterOverlay: (id: string, params?: Query) => overlayUrl('/overlay/top-chatter', id, params),
}