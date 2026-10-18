'use client'

/**
 * Copy a string, and say that it happened.
 *
 * One implementation of this because the confirmation is the whole of the
 * feedback: a clipboard write has no other visible result, so a page that does not
 * report it leaves the only way to tell success from failure to be pasting the link
 * into OBS and finding out there.
 *
 * The window is short on purpose — long enough to notice, not so long that it is
 * still claiming success while a second link is being copied.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

export function useCopy(resetMs = 1500) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | null>(null)

  // The timeout is cleared on unmount rather than left to fire: a card that
  // unmounts mid-confirmation would otherwise call a setter belonging to a
  // component that is gone.
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    },
    [],
  )

  const copy = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text)
        setCopied(true)
        if (timer.current !== null) window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => {
          timer.current = null
          setCopied(false)
        }, resetMs)
        return true
      } catch {
        // Clipboard access is refused in some contexts and there is no honest way
        // to paste on the operator's behalf. The button drops back to its resting
        // label rather than claiming a copy that did not happen.
        setCopied(false)
        return false
      }
    },
    [resetMs],
  )

  return { copied, copy }
}
