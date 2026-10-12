import 'server-only'

/**
 * The settings, read on the server at request time.
 *
 * Deliberately not `NEXT_PUBLIC_*`. That prefix is a promise that the value is
 * public, and there is nothing here worth making: the client needs the two
 * overlay URLs, and those come from the origin it is already on. Reading them
 * here instead means a domain or a name change is an environment variable and a
 * restart, not a rebuild — which is the whole reason this stopped being a static
 * build.
 */

/** Where the overlay pages live. Defaults to nothing, in which case the client
 *  falls back to its own origin, which is correct when this app serves them. */
export const overlayOrigin = process.env.OVERLAY_ORIGIN?.replace(/\/+$/, '')

/** Shown in the header and the page title. */
export const productName = process.env.PRODUCT_NAME ?? 'StreamKit'

export const tagline = process.env.TAGLINE ?? 'Live chat overlays for streaming.'

/** Whether the server holds a credential. The console says so plainly when it
 *  does not, because writes failing for this reason are otherwise
 *  indistinguishable from the app being broken. */
export const tokenConfigured = (process.env.STREAMKIT_TOKEN ?? '').trim() !== ''

/**
 * The wordmark, split so the accent can be coloured.
 *
 * "StreamKit" becomes ["Stream", "Kit"], so the stylesheet can tint the second
 * half without the name being written twice. A name with no capital to break on
 * is returned whole rather than guessed at — an accent in the wrong place would
 * be a misspelling rather than a style.
 */
export function splitWordmark(name: string): [string, string] {
  const at = name.search(/[A-Z]/)
  if (at <= 0) return [name, '']
  return [name.slice(0, at), name.slice(at)]
}