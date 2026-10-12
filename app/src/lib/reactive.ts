import { useEffect } from 'react'
import { attach, detachHandler, type SidecarEvent } from './sidecar'

/**
 * The subscription boilerplate every alert hook repeats.
 *
 * Six hooks each opened with the same four lines — an `active` flag, an `attach`,
 * a cleanup that flips the flag and detaches, and a `platform !== 'tiktok'` guard
 * at the top of the handler. Copied six times, it is six places a missed `active`
 * check leaks a handler across a settings toggle and a forgotten detach delivers
 * frames to an unmounted hook. One copy, one place to get the teardown right.
 *
 * The `active` flag is here rather than left to each handler because a detached
 * handler is not the same as a silenced one: between the effect re-running and the
 * old cleanup firing, a frame can arrive at a handler whose hook has moved on.
 * Gating on `active` closes that window; relying on detach alone does not.
 */

/**
 * Runs `handler` for every frame from a TikTok room, for as long as the component
 * lives, and stops cleanly when the deps change or it unmounts.
 *
 * Frames from the bridge itself are filtered out — a hook here cares about what
 * the room is doing, not whether the reader is connected. The `active` guard
 * suppresses a frame that lands after the effect was told to stop but before its
 * cleanup ran, so a handler never acts on stale state.
 */
export function useRoomEvents(
  handler: (event: SidecarEvent & { platform: 'tiktok' }) => void,
  deps: unknown[],
): void {
  useEffect(() => {
    let active = true

    const wrapped = (event: SidecarEvent) => {
      if (!active) return
      if (event.platform !== 'tiktok') return
      handler(event as SidecarEvent & { platform: 'tiktok' })
    }

    attach(wrapped)
    return () => {
      active = false
      // Taken back off rather than merely muted: the listener set outlives the
      // effect, and this re-runs on every dep change — so without the detach a
      // toggle leaks a handler each time it fires.
      detachHandler(wrapped)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}
