/**
 * Shared API shape — imported by both the server-side client (`server/backend.ts`)
 * and the browser client (`client/api.ts`). These are pure type declarations, so
 * there is no runtime import here: neither module pulls the other across the React
 * server/client boundary, and the types never need to.
 */

/** A room as the backend describes it. */
export interface Room {
  id: string
  name: string
  username: string
  config: Record<string, unknown>
  createdAt: number
  /** Which platform this room reads. Absent on rooms created before the field
   *  existed, which are all TikTok — the backend fills the same default. */
  provider?: StreamProvider
}

/** The platforms a room can read. One string in two places: the request and the
 *  room record. `tiktok` is the default so every room and every stored config
 *  written before YouTube existed keeps meaning what it meant. */
export type StreamProvider = 'tiktok' | 'youtube'

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

/** One line from the backend's log. */
export interface LogEntry {
  /** ISO timestamp, UTC. */
  at: string
  level: 'debug' | 'info' | 'warning' | 'error' | 'critical'
  /** Which part of the backend said it, with the `streamkit.` prefix trimmed. */
  source: string
  message: string
  /** Present only when the record carried an exception. */
  traceback?: string
}

/** Aggregated session stats across all rooms, from `/api/analytics`. */
export interface AnalyticsSummary {
  total_rooms: number
  total_viewers: number
  total_peak_viewers: number
  total_diamonds: number
  total_events: number
  rooms: Array<{
    id: string
    username: string
    connected: boolean
    viewers: number
    peak_viewers: number
    total_diamonds: number
    events: number
    live_seconds: number | null
  }>
  /** Gifters summed across every room, by diamond value. */
  topGifters: SessionPerson[]
}

export interface LogPage {
  /** Newest first, which is how a log is read. */
  entries: LogEntry[]
  /** How many matched the filter, before the limit was applied. */
  total: number
  /** How many the backend keeps in total, so the page can say what it is not showing. */
  capacity: number
}

/** A chatter or gifter in a room's session leaderboard. */
export interface SessionPerson {
  id: string
  nickname: string
  diamonds?: number
}

/** A published giveaway snapshot (list view, without full report). */
export interface GiveawaySnapshot {
  id: string
  createdAt: string
  report: {
    format: string
    streamHandle: string
    isTestRun: boolean
    entrantCount: number
    winnerCount: number
  }
}

/**
 * What a room's current session has accumulated.
 *
 * In memory only: the backend accumulates as events arrive and forgets on
 * restart, so this describes the session running now. `live_seconds` survives a
 * disconnect, because a stream that just ended still has a length worth reading.
 */
export interface RoomSession {
  connected: boolean
  /** Per-kind event totals, e.g. `{ comment: 244, gift: 4 }`. */
  totals: Record<string, number>
  /** How many of each kind were the same person arriving twice. */
  repeats: Record<string, number>
  viewers: number | null
  /** Seconds since the last headcount, or null if none has arrived. */
  viewers_age: number | null
  peak_viewers: number
  peak_viewers_age: number | null
  /** How long the session has run, or null if it never connected. */
  live_seconds: number | null
  total_diamonds: number
  topGifters: SessionPerson[]
}
