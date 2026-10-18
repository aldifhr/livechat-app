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

/** Shown in the header and the page title. */
export const productName = process.env.PRODUCT_NAME ?? 'StreamKit'

export const tagline = process.env.TAGLINE ?? 'Live chat overlays for streaming.'

/** Whether the server holds a credential. The console says so plainly when it
 *  does not, because writes failing for this reason are otherwise
 *  indistinguishable from the app being broken. */
export const tokenConfigured = (process.env.STREAMKIT_TOKEN ?? '').trim() !== ''

/**
 * Where the dashboard's password is kept.
 *
 * Under /var/lib rather than /etc/nginx because the service runs with
 * `ProtectSystem=full`: /etc is read-only to it, so a password change could
 * never be written there — it would fail at the last step, in production only.
 * nginx no longer reads this file either: it asks this app whether a request
 * carries a valid session, and the app is what knows the password.
 */
export const passwordFile = process.env.STREAMKIT_HTPASSWD ?? '/var/lib/streamtools/htpasswd'

/** The account in that file. */
export const dashboardUser = process.env.STREAMKIT_DASHBOARD_USER ?? 'admin'

/**
 * The key sessions are signed with.
 *
 * Empty when unset, and the routes treat empty as "no session can be issued or
 * accepted" rather than falling back to a built-in default — a default anyone
 * could read would sign anyone in.
 */
export function sessionSecret(): string {
  return (process.env.STREAMKIT_SESSION_SECRET ?? '').trim()
}

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