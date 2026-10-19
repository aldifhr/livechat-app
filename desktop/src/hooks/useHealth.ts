import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * How long a connected room may stay silent before it is called stalled.
 *
 * A quiet room is normal: a stream with a handful of viewers can say nothing for
 * minutes. This has to be long enough to avoid false alarms and short enough that
 * a socket which died silently is noticed rather than sitting there looking fine.
 */
export const SILENT_AFTER_MS = 120000

export type Health = 'connecting' | 'healthy' | 'quiet' | 'stalled'

export interface RoomHealth {
  /** How the room is doing. */
  health: Health
  /** Called on every frame, from the event handler. */
  markAlive: () => void
}

/**
 * Notices a connection that stopped talking without saying so.
 *
 * The socket can die without either side noticing: the UI keeps showing
 * "Connected" and the only symptom is that the chat goes still. This times the
 * silence so the status line can admit it does not know what is going on instead
 * of continuing to claim a connection it no longer has.
 */
export function useHealth(connected: () => boolean): RoomHealth {
  const lastSeen = useRef<number | undefined>(undefined)
  const [tick, setTick] = useState(0)

  const markAlive = useCallback(() => {
    lastSeen.current = Date.now()
  }, [])

  // Ten seconds is coarse on purpose: this only needs to notice a two-minute
  // silence, and re-rendering on every message would defeat the point of batching.
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 10000)
    return () => clearInterval(timer)
  }, [])

  let health: Health = 'connecting'

  if (connected()) {
    const seen = lastSeen.current
    if (seen === undefined) {
      // Connected but nothing has arrived yet. Not a stall: the handshake has only
      // just finished and a slow room may take a while to say anything.
      health = 'quiet'
    } else {
      const silentFor = Date.now() - seen
      if (silentFor > SILENT_AFTER_MS) health = 'stalled'
      else if (silentFor > 30000) health = 'quiet'
      else health = 'healthy'
    }
  }

  void tick // read on the next render, which is what re-runs this calculation
  return { health, markAlive }
}
