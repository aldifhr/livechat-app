'use client'

/**
 * Transient confirmations, shown after an action rather than in place of it.
 *
 * The pattern this replaces is the inline notice: a line of text that appears at
 * the top of the section and stays there. It has two problems for "the thing you
 * just did worked". It lives where the action did not happen — you click Delete
 * on a row near the bottom and the confirmation appears far above, off-screen if
 * the list is long. And it does not go away: a success message that sits there
 * until the next action reads as the current state of the world, so an operator
 * who connects one stream and walks away comes back to a page claiming something
 * is connected when the message is simply stale.
 *
 * A toast is the honest shape for that: it says what happened, at the edge of the
 * view, and leaves. The errors in these sections stay inline, because an error is
 * something to act on and should not disappear on a timer.
 *
 * A context rather than a hook per section, so the stack is one element owned by
 * the layout. Two sections cannot overlap each other's messages, and a toast
 * survives the section re-rendering — which is the normal case, since the action
 * that raised it usually also reloads the list underneath.
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'

type Toast = { id: number; text: string }

const ToastContext = createContext<(text: string) => void>(() => {})

/** How long a toast stays. Long enough to read a short sentence, short enough not
 *  to be mistaken for a status that is still true. */
const TTL_MS = 4000

export function useToast(): (text: string) => void {
  return useContext(ToastContext)
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(0)
  // The timers are tracked so a toast that is dismissed by hand, or a provider
  // that unmounts, does not leave one firing into a component that is gone.
  const timers = useRef(new Map<number, number>())

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id)
    if (timer !== undefined) {
      window.clearTimeout(timer)
      timers.current.delete(id)
    }
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const push = useCallback(
    (text: string) => {
      const id = nextId.current++
      setToasts((current) => [...current, { id, text }])
      timers.current.set(
        id,
        window.setTimeout(() => dismiss(id), TTL_MS),
      )
    },
    [dismiss],
  )

  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const timer of pending.values()) window.clearTimeout(timer)
      pending.clear()
    }
  }, [])

  return (
    <ToastContext.Provider value={push}>
      {children}
      {/* aria-live rather than an alert role: a confirmation is not an emergency,
          and a screen reader should hear it without the page being interrupted. */}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div className="toast" key={toast.id}>
            <span>{toast.text}</span>
            <button className="toast-close" onClick={() => dismiss(toast.id)} aria-label="Dismiss">
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
