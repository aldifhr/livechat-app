'use client'

/**
 * A style that survives being closed.
 *
 * The editor used to hold its style in React state and nothing else, which meant a
 * refresh threw away everything the operator had set. The backend has had a route
 * for saving a room's styling the whole time — it even broadcasts to the overlays
 * watching that room — but nothing called it.
 *
 * This is the caller. Three things it has to get right, and each one has a way of
 * failing quietly:
 *
 *   - **Loading.** A room's saved styling comes from `room.config`, read through
 *     `styleFromStored` and clamped by the shared resolver. Falling back to the
 *     query string only happens for a room that has never been styled, because
 *     that is where a link pasted before this existed carries its own styling.
 *
 *   - **Not saving on load.** The load effect sets the style, which would trip a
 *     plain change effect and write the defaults straight back over the saved
 *     styling. Saving is therefore driven by edits, not by state changing.
 *
 *   - **Not erasing the other overlay.** Both overlays save into one room record
 *     and the store replaces that record wholesale, so a save sends the config the
 *     room already had with its own fields spread over it. Sending only the fields
 *     being changed would be a shorter way to lose the other overlay's styling.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../lib/client'
import type { Room } from '../lib/types'

/** What the operator is told about the save, so nothing here is a guess. */
export type SaveState =
  /** Untouched since it loaded. */
  | 'idle'
  /** An edit is waiting for the quiet period to pass. */
  | 'pending'
  /** Written. */
  | 'saved'
  /** Refused. The styling is still on screen; it just is not stored. */
  | 'failed'

/** How long after the last edit before the styling is written. */
const SAVE_DEBOUNCE_MS = 400

interface PersistedStyle<S> {
  /** The style as it stands. Change it through `patch`. */
  current: S
  /** Applies a change and schedules a save. */
  patch: (change: Partial<S>) => void
  /** Where the save has got to. */
  state: SaveState
  /** Whether there is anywhere to save to. */
  enabled: boolean
}

interface Options<S> {
  /** The room being styled, or undefined while the list is loading. */
  room: Room | undefined
  /** The style this room starts from when it has none saved. */
  fallback: S
  /** Reads a room's stored config into a style. */
  read: (stored: Record<string, unknown>) => S
  /** Writes a style into the stored form. */
  write: (style: S) => Record<string, unknown>
  /** Whether this style is already the room's saved one, so no save is pending. */
  isSameAsStored?: (style: S, stored: Record<string, unknown>) => boolean
}

export function usePersistedStyle<S extends object>({
  room,
  fallback,
  read,
  write,
  isSameAsStored,
}: Options<S>): PersistedStyle<S> {
  const [current, setCurrent] = useState<S>(fallback)
  const [state, setState] = useState<SaveState>('idle')

  const roomId = room?.id ?? ''

  // The config the room was last read with, and then whatever we have written since.
  // Read-modify-write is the only way to save one overlay's fields without the
  // store treating the write as the room's entire configuration.
  const base = useRef<Record<string, unknown>>({})
  const timer = useRef<number | null>(null)
  const latest = useRef<S>(current)
  const disposed = useRef(false)

  useEffect(() => {
    latest.current = current
  }, [current])

  useEffect(() => {
    disposed.current = false
    return () => {
      disposed.current = true
      if (timer.current !== null) window.clearTimeout(timer.current)
    }
  }, [])

  // Load whenever the room, or the room's own saved styling, changes. Keyed on the
  // config rather than the room object so a poll that returns the same styling does
  // not throw away edits in progress.
  const saved = room?.config
  useEffect(() => {
    const config = saved ?? {}
    base.current = { ...config }
    setCurrent(read(structuredClone(config)))
    setState('idle')
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
    // `read` and `fallback` are closures rebuilt every render; depending on them
    // would reload on every keystroke and undo the edit being made.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, saved])

  const patch = useCallback(
    (change: Partial<S>) => {
      const next = { ...latest.current, ...change }
      latest.current = next
      setCurrent(next)
      if (!roomId) return

      // Nothing to write if this is what the room already had — which is what a
      // control set back to the value it started on amounts to.
      if (isSameAsStored?.(next, base.current)) {
        if (timer.current !== null) {
          window.clearTimeout(timer.current)
          timer.current = null
        }
        setState('idle')
        return
      }

      setState('pending')
      if (timer.current !== null) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => {
        timer.current = null
        const fields = write(next)
        const before = base.current
        api
          .saveStyle(roomId, before, fields)
          .then(() => {
            if (disposed.current) return
            if (base.current === before) base.current = { ...before, ...fields }
            setState('saved')
          })
          .catch(() => {
            if (disposed.current) return
            setState('failed')
          })
      }, SAVE_DEBOUNCE_MS)
    },
    [roomId, write, isSameAsStored],
  )

  return { current, patch, state, enabled: roomId !== '' }
}