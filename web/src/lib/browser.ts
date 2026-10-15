'use client'

/**
 * Reading the window from render, without the hydration warning.
 *
 * `typeof window === 'undefined' ? a : b` inside JSX is a hydration mismatch by
 * construction. The server takes one branch and the browser takes the other, so
 * the markup React built on the server is not the markup it finds, and it throws
 * the tree away and builds it again. The page still works, which is why this has
 * been sitting here: what it actually looks like is a page that loads twice, and
 * the warning names a dozen causes that have nothing to do with any of them.
 *
 * There were three of these and all three reported as the same bug while looking
 * like three different ones — a missing origin on the streams page, wrong
 * addresses on the about page, and a preview frame that resized itself the
 * instant it loaded.
 *
 * `useSyncExternalStore` is the primitive for a value the server does not have:
 * a snapshot for the client, a second one saying what the server should render,
 * and React renders the server's answer for the hydration pass and then swaps in
 * the client's. The markup matches, so nothing is thrown away, and the
 * correction is an ordinary re-render.
 *
 * The snapshots are plain strings and numbers on purpose. An object would be a
 * new value on every call, `useSyncExternalStore` compares with `Object.is`, and
 * a value that never compares equal is a render loop.
 */

import { useSyncExternalStore } from 'react'

/** Nothing to watch, so nothing ever asks for a re-render. */
function subscribeToNothing() {
  return () => {}
}

/**
 * This page's own origin — the domain an overlay link has to carry.
 *
 * Empty on the server, and empty for one frame in the browser too, which is the
 * point: a server that guessed a domain would be guessing.
 */
export function useOrigin(): string {
  return useSyncExternalStore(subscribeToNothing, () => window.location.origin, () => '')
}

/**
 * The window's width, and `fallback` for the server.
 *
 * A number for `fallback` rather than nothing, because a caller that compares it
 * to decide a layout needs a value to compare. Pass the width the design assumes
 * so the first paint is the wide layout on a phone and the wrong one for a frame.
 */
export function useViewportWidth(fallback: number): number {
  return useSyncExternalStore(onResize, () => window.innerWidth, () => fallback)
}

/** The window's height, and `fallback` for the server. `useViewportWidth` for why. */
export function useViewportHeight(fallback: number): number {
  return useSyncExternalStore(onResize, () => window.innerHeight, () => fallback)
}

function onResize(changed: () => void) {
  window.addEventListener('resize', changed)
  return () => window.removeEventListener('resize', changed)
}