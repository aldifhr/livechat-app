/**
 * The pieces every settings section shares.
 *
 * The dialog was one file of eleven hundred lines holding nine sections, so
 * changing the overlay's colour meant reading the webhook's token handling and
 * the model's request code to find out what else used them. Each section is now
 * its own module and this holds the three things more than one of them needs.
 *
 * `Status` and `message()` are here because the sections report outcomes through
 * one shared line. `useStillMounted` is here because four sections await a host
 * call and must not set state on a component that has gone.
 */

import { useEffect, useRef } from 'react'
import type { ViewSettings } from '../../hooks/useSettings'

/**
 * Writes one saved setting.
 *
 * The exact signature from `useSettings`, restated here so a section can take it
 * as a prop. Hand-writing a looser version (`(key, value: never) => void`) looks
 * like it works and does not: `never` is only assignable to `never`, so every
 * real call site fails to compile.
 */
export type SetSetting = <K extends keyof ViewSettings>(key: K, value: ViewSettings[K]) => void

/** What a section has to say about the last thing the user asked it to do. */
export type Status =
  | { kind: 'idle'; text: '' }
  | { kind: 'busy'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'ok'; text: string }

/** Whatever the rejection was, as one line worth showing. */
export function message(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * A ref that goes false when this component unmounts.
 *
 * Four sections await a host call before they can say what happened. The dialog
 * used to stay mounted while it was closed, so a slow answer arriving after the
 * user closed the window found a component still on screen and was safe. The
 * sections unmount with the dialog, so that answer can now land on nothing — and
 * React warns about setting state on an unmounted component, which is noise the
 * user reads as a failure they caused.
 *
 * Each section gets its own rather than sharing one, so a section that unmounts
 * cannot cancel another's in-flight work.
 */
export function useStillMounted() {
  const stillMounted = useRef(true)
  useEffect(() => {
    stillMounted.current = true
    return () => {
      stillMounted.current = false
    }
  }, [])
  return stillMounted
}