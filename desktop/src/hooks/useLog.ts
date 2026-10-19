import { useCallback, useMemo, useRef, useState } from 'react'
import type { LogLevel } from '../lib/sidecar'

/**
 * The app's log.
 *
 * A busy room produces hundreds of events a minute, so feed events are counted
 * rather than logged one line each — a log you cannot scroll is not a log. What
 * is kept is the lifecycle and anything that went wrong: those are the lines
 * that explain a connection that stopped updating.
 */

/**
 * The app's log buffer cap — matches MAX_ITEMS on the feed so neither panel
 * grows unbounded, and both shed the oldest rows at the same threshold.
 */
const MAX_ENTRIES = 200

export interface LogEntry {
  key: string
  level: LogLevel
  message: string
  at: number
}

export interface UseLogResult {
  entries: LogEntry[]
  push: (level: LogLevel, message: string) => void
  clear: () => void
  /** Events received but not written out, broken down by kind. */
  tallies: Record<string, number>
  bump: (kind: string) => void
}

export function useLog(): UseLogResult {
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [tallies, setTallies] = useState<Record<string, number>>({})

  // Same reasoning as the feed: a ref, because it must be correct inside a state
  // updater and a plain counter would be one render behind under a burst.
  const sequence = useRef(0)

  const push = useCallback((level: LogLevel, message: string) => {
    sequence.current += 1
    const key = `${Date.now()}-${sequence.current}`
    setEntries((previous) => {
      const next = [...previous, { key, level, message, at: Date.now() }]
      return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next
    })
  }, [])

  const bump = useCallback((kind: string) => {
    setTallies((previous) => ({ ...previous, [kind]: (previous[kind] ?? 0) + 1 }))
  }, [])

  const clear = useCallback(() => {
    setEntries([])
    setTallies({})
    sequence.current = 0
  }, [])

  return useMemo(
    () => ({ entries, push, clear, tallies, bump }),
    [entries, push, clear, tallies, bump],
  )
}