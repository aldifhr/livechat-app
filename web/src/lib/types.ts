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
}
