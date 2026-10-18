'use client'

import { useEffect } from 'react'

/**
 * Run `callback` once, then on every `intervalMs` beat, until unmount or until the
 * callback's identity changes.
 *
 * Four pages had the same three lines — call it, set an interval, clear it on
 * teardown — and each restated the same `void` dance. The callback owns its own
 * state and error handling; this only owns the clock.
 */
export function usePoll(callback: () => void, intervalMs: number): void {
  useEffect(() => {
    callback()
    const timer = window.setInterval(callback, intervalMs)
    return () => window.clearInterval(timer)
  }, [callback, intervalMs])
}
