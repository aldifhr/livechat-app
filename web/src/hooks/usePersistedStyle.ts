'use client'

/**
 * A style that survives being closed, and is only written when asked.
 *
 * The editor used to hold its style in React state and nothing else, which meant a
 * refresh threw away everything the operator had set. The backend has had a route
 * for saving a room's styling the whole time — it even broadcasts to the overlays
 * watching that room — and this is the caller.
 *
 * Saving is explicit: `patch` edits the working copy and marks it dirty, and
 * `save` is what writes it. There is no debounce, because a save that happens on
 * its own is a save the operator did not ask for and cannot see the moment of —
 * the status is shown next to a button they pressed, or it is not shown at all.
 *
 * Three things it has to get right, and each one has a way of failing quietly:
 *
 *   - **Loading.** A room's saved styling comes from `room.config`, read through
 *     `styleFromStored` and clamped by the shared resolver. Falling back to the
 *     query string only happens for a room that has never been styled, because
 *     that is where a link pasted before this existed carries its own styling.
 *
 *   - **Not erasing the other overlay.** Both overlays save into one room record
 *     and the store replaces that record wholesale, so a save sends the config the
 *     room already had with its own fields spread over it. Sending only the fields
 *     being changed would be a shorter way to lose the other overlay's styling.
 *
 *   - **Not losing a concurrent save.** Two customizers share one room record. A
 *     save merges into `base` rather than replacing it, so a save from the other
 *     panel that landed first is not undone by this one.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/client/api'
import type { Room } from '@/lib/types'

/** What the operator is told about the save, so nothing here is a guess. */
export type SaveState =
  /** Untouched since it loaded. */
  | 'idle'
  /** Edited, not yet written. */
  | 'dirty'
  /** A write is in flight. */
  | 'saving'
  /** Written. */
  | 'saved'
  /** Refused. The styling is still on screen; it just is not stored. */
  | 'failed'

interface PersistedStyle<S> {
  /** The style as it stands. Change it through `patch`. */
  current: S
  /** Applies an edit to the working copy. Does not write. */
  patch: (change: Partial<S>) => void
  /** Where the save has got to. */
  state: SaveState
  /** Whether there is an unwritten edit (including one that failed to write). */
  dirty: boolean
  /** Writes the working copy to the room. No-op when there is nowhere to save. */
  save: () => void
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
  /** Whether this style is already the room's saved one. */
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
  const latest = useRef<S>(current)
  const disposed = useRef(false)

  useEffect(() => {
    latest.current = current
  }, [current])

  useEffect(() => {
    disposed.current = false
    return () => {
      disposed.current = true
    }
  }, [])

  // Load whenever the room, or the room's own saved styling, changes. Keyed on the
  // config rather than the room object so a poll that returns the same styling does
  // not throw away edits in progress.
  const saved = room?.config
  useEffect(() => {
    const config = saved ?? {}
    base.current = { ...config }
    latest.current = read(structuredClone(config))
    setCurrent(latest.current)
    setState('idle')
    // `read` is a closure rebuilt every render; depending on it would reload on
    // every keystroke and undo the edit being made.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, saved])

  const patch = useCallback(
    (change: Partial<S>) => {
      const next = { ...latest.current, ...change }
      latest.current = next
      setCurrent(next)
      if (!roomId) return

      // Back to what the room already had — a control set to the value it started
      // on is not an edit, so the button goes quiet again.
      if (isSameAsStored?.(next, base.current)) {
        setState('idle')
        return
      }
      setState('dirty')
    },
    [roomId, isSameAsStored],
  )

  const save = useCallback(() => {
    if (!roomId) return
    const fields = write(latest.current)
    const before = base.current
    setState('saving')
    api
      .saveStyle(roomId, before, fields)
      .then(() => {
        if (disposed.current) return
        // Merge, not replace: a concurrent save from the other customizer may have
        // already moved base.current past `before`, and overwriting it here would
        // lose that save.
        base.current = { ...before, ...fields }
        setState('saved')
      })
      .catch(() => {
        if (disposed.current) return
        setState('failed')
      })
  }, [roomId, write])

  return {
    current,
    patch,
    state,
    // A failed write stays dirty so the button is still there to try again.
    dirty: state === 'dirty' || state === 'failed',
    save,
    enabled: roomId !== '',
  }
}
