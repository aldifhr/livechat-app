'use client'

import { useEffect } from 'react'

/**
 * Run `callback` once, then on every `intervalMs` beat, until unmount or until the
 * callback's identity changes.
 *
 * Four pages had the same three lines — call it, set an interval, clear it on
 * teardown — and each restated the same `void` dance. The callback owns its own
 * state and error handling; this only owns the clock.
 *
 * `callback` must be stable — a `useCallback`, not an inline arrow. It is a
 * dependency of the effect below, so a fresh identity every render re-runs the
 * effect on every render, which fetches on every render. That is a runaway poll,
 * not a poll.
 */
export function usePoll(callback: () => void | Promise<void>, intervalMs: number): void {
  useEffect(() => {
    void callback()
    const timer = window.setInterval(() => void callback(), intervalMs)
    return () => window.clearInterval(timer)
  }, [callback, intervalMs])
}
