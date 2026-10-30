import 'server-only'

import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
 * The dashboard's password lives in `STREAMKIT_DASHBOARD_PASSWORD_HASH` as a
 * bcrypt hash, and is read by `lib/server/credentials` — which reads the variable
 * directly rather than through here, so it can be tested under plain `node`
 * without pulling in `server-only`.
 */

/** The account name, used only to label the session. The password is the whole
 *  credential; this is a fact of the deployment, not something a visitor types. */
export const dashboardUser = process.env.STREAMKIT_DASHBOARD_USER ?? 'admin'

/**
 * Where runtime state that is not source lives — giveaway commitments, and
 * anything else a running deployment has to keep.
 *
 * Not an environment variable. A deployment should not have to spell out a
 * filesystem path just to start, and the only place this ever differed was
 * Vercel, whose bundle is read-only: `/tmp` is the one writable place there, so
 * the platform decides rather than the operator.
 */
export const dataDir = process.env.VERCEL
  ? join(tmpdir(), 'streamkit')
  : join(process.cwd(), '.data')

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