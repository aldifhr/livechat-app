/**
 * The giveaway's provably-fair core, shared by the desktop app and the web.
 *
 * The winner is not picked by a random number generator at draw time: a seed is
 * committed (its SHA-256 published) before any entry is drawn, and each winner is
 * `SHA-256(seed + '|' + sorted_pool)` folded into an index. Anyone with the
 * revealed seed and the pool can recompute it, which is the whole point of an audit
 * report. The wheel on screen is decoration; this is the draw.
 *
 * One copy rather than two. It lived inline in each client before, and a drift
 * between them would mean a snapshot published from the app could not be verified
 * by the steps the web prints — which is exactly the guarantee the report is for.
 */

/** SHA-256 of a string, hex-encoded. */
export async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** A fresh 32-byte seed, hex-encoded. Only used where no server commitment exists. */
export function generateSeed(): string {
  const buf = new Uint8Array(32)
  crypto.getRandomValues(buf)
  return Array.from(buf).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Derive the winner from the committed seed and the frozen pool.
 *
 * Deterministic: `SHA-256(seed + '|' + sorted_pool.join('|'))`, first 8 hex chars
 * as a 32-bit integer, modulo the pool size. The pool is sorted first so the result
 * depends on who is in it and not on the order they were collected in.
 */
export async function deriveWinnerFromSeed(seed: string, pool: string[]): Promise<string | null> {
  if (!seed || pool.length === 0) return null
  const sorted = [...pool].sort()
  const input = seed + '|' + sorted.join('|')
  const digest = await sha256(input)
  const index = parseInt(digest.slice(0, 8), 16) % pool.length
  return pool[index]
}

/** One participant in the frozen entry list. */
export interface GiveawayEntrant {
  id: string
  nickname: string
  followed: boolean
  eligible: boolean
  keywordMessages: number
  reason?: string
}

/** One winner draw: who won, and the pool it was drawn from. */
export interface GiveawayDraw {
  drawnAt: string
  pool: string[]
  winner: string
}

/** The audit report published as a public snapshot. */
export interface GiveawayReport {
  format: 'livechat-giveaway-audit-v1'
  streamer: string
  keyword: string
  durationMinutes: number
  prize: string
  winnerCount: number
  testMode: boolean
  startedAt: string | null
  closedAt: string | null
  entrants: GiveawayEntrant[]
  eligibleCount: number
  draws: GiveawayDraw[]
  randomness: string
  commitHash: string
  poolHash: string
  revealSeed: string
  /** The server-side commitment this draw is anchored to, and when it was made. */
  commitId?: string
  committedAt?: string
  note: string
}
