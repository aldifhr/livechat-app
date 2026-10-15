/**
 * Shared API shape — imported by both the server-side client (`backend.ts`) and
 * the browser client (`client.ts`). These are pure type declarations, so there is
 * no runtime import here: neither module pulls the other across the React
 * server/client boundary, and the types never need to.
 */

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
  /** The backend is still working on it. Distinct from `connected: false` because
   *  "connecting" and "offline" are different answers and collapsing them into
   *  one badge tells an operator to wait when they should press Connect. */
  connecting?: boolean
  /** The streamer has no live right now, and the backend is polling for one —
   *  up to two hours. Distinct from `connecting`, which means a handshake is in
   *  flight: this is a wait, and a badge that said "Connecting" for it described
   *  something that was not happening. */
  waiting?: boolean
  /** The stream ended and nothing will retry it. A terminal state the backend goes
   *  out of its way to name: a room in it needs a fresh Connect, and a badge that
   *  only said "offline" would send the reader looking for a connection problem
   *  that is not there. */
  liveEnded?: boolean
}
