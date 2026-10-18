/**
 * The dashboard's session cookie.
 *
 * The console used to be behind nginx's `auth_basic`, which is a browser dialog
 * with nothing behind it: no styling, no message when a password is wrong, and no
 * address a streamer can be sent. The login is a real page now, and what keeps
 * you signed in is a cookie this module signs and checks.
 *
 * Two decisions worth stating, because they are why this is safe:
 *
 *   - The signing key is derived from the CURRENT password hash, not from the
 *     secret alone. Changing the password therefore invalidates every cookie that
 *     was signed with the old one — with no session table to keep and nothing to
 *     remember to clear. That is the property a password change is FOR: whoever
 *     the old password was shared with loses access the moment it changes.
 *
 *   - The token carries its own expiry and is compared in constant time, so a
 *     token that is tampered with, truncated, or replayed after its expiry is
 *     refused without any lookup.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

/** The cookie's name. One name, so there is one thing to clear. */
export const COOKIE_NAME = 'streamkit_session'

/** How long a sign-in lasts. Long enough that a streamer is not typing a
 *  password mid-stream, short enough that a forgotten laptop is not a permanent
 *  door.
 *
 *  Seven days is the default because the cost of being wrong is lopsided: signing
 *  in again is one password, while a session that outlives its welcome is a stolen
 *  console for a week. A deployment that wants the older behaviour — and it is a
 *  defensible one for a single operator who signs in from one machine — sets
 *  STREAMKIT_SESSION_DAYS rather than editing this. */
/** Reads the configured lifetime, falling back to a week. Anything unreadable or
 *  nonsensical — zero, negative, NaN, `forever` — is a week, because an
 *  unparseable value must not become an unlimited session. */
export function sessionTtlMs(): number {
  const raw = process.env.STREAMKIT_SESSION_DAYS?.trim()
  if (!raw) return 7 * 24 * 60 * 60 * 1000
  const days = Number(raw)
  if (!Number.isFinite(days) || days <= 0) return 7 * 24 * 60 * 60 * 1000
  return days * 24 * 60 * 60 * 1000
}

/** Bumped if the token's shape ever changes, so tokens minted under the old
 *  shape fail closed rather than being read under new rules. */
const VERSION = 'v1'

export interface Session {
  user: string
  exp: number
}

/**
 * The key a session is signed with.
 *
 * Derived from the deployment secret AND the password hash in force, so the
 * signature covers both: rotating the secret signs everyone out, and so does
 * changing the password.
 */
export function sessionKey(secret: string, passwordHash: string): Buffer {
  return createHmac('sha256', secret).update(passwordHash).digest()
}

function b64(input: Buffer | string): string {
  return (typeof input === 'string' ? Buffer.from(input, 'utf8') : input).toString('base64url')
}

/** A signed token for `user`, valid for `ttlMs` from `now`. */
export function signSession(
  key: Buffer,
  user: string,
  now = Date.now(),
  ttlMs = sessionTtlMs(),
): string {
  const body = b64(JSON.stringify({ user, exp: now + ttlMs }))
  const mac = b64(createHmac('sha256', key).update(`${VERSION}.${body}`).digest())
  return `${VERSION}.${body}.${mac}`
}

/**
 * The session a token carries, or null if it is not one this key signed or has
 * expired.
 *
 * Everything is checked before anything is trusted: the shape, the signature in
 * constant time, and the expiry. A token that fails any of those is null, never a
 * partially-read payload.
 */
export function verifySession(key: Buffer, token: string, now = Date.now()): Session | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [version, body, mac] = parts
  if (version !== VERSION) return null

  const expected = createHmac('sha256', key).update(`${VERSION}.${body}`).digest()
  const given = Buffer.from(mac, 'base64url')
  // `timingSafeEqual` throws on a length mismatch, and a shorter forgery would
  // otherwise be compared only against its own length — check the length first,
  // then compare.
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  const session = parsed as Partial<Session> | null
  if (!session || typeof session.user !== 'string' || typeof session.exp !== 'number') return null
  if (!(session.exp > now)) return null
  return { user: session.user, exp: session.exp }
}

/**
 * The `Set-Cookie` value for a token.
 *
 * `Secure` always: the dashboard is only ever reached over HTTPS, and a cookie
 * that could travel over plain HTTP would be the one thing the redirect to HTTPS
 * exists to prevent. `HttpOnly` because no script here reads it. `SameSite=Lax`
 * so a cross-site POST cannot carry it, while an ordinary link still works.
 */
export function sessionCookie(
  token: string,
  maxAgeSec = Math.floor(sessionTtlMs() / 1000),
): string {
  return [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
  ].join('; ')
}
