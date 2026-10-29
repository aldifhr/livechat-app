import 'server-only'

/**
 * Whether a session token is one this server signed for the account in force.
 *
 * The dashboard's proxy and the `/api/auth/verify` route that nginx subrequests
 * both ask the same question — "is this cookie a session?" — and it has to have
 * one answer. Both read the secret, the password file and the account here, so a
 * cookie cannot be valid to one gate and not the other.
 */

import { sessionSecret } from './config'
import { passwordHash } from './credentials'
import { sessionKey, verifySession } from './session'

export async function isSessionValid(token: string | undefined): Promise<boolean> {
  if (!token) return false

  const secret = sessionSecret()
  if (!secret) return false

  // The key is derived from the hash in force, so this also refuses a cookie that
  // was valid until the password changed — which is the point of deriving it from
  // the hash rather than storing a session.
  const hash = passwordHash()
  if (!hash) return false

  return verifySession(sessionKey(secret, hash), token) !== null
}

/**
 * Whether a request's `Origin` names the host it was sent to.
 *
 * The two state-changing routes — signing in, changing the password — each refuse
 * a request aimed at them from another site, and both have to make the same
 * judgement of what "another site" is.
 *
 * A request with no `Origin` is not treated as cross-site. Browsers send it on
 * every POST, so its absence means this did not come from a page making a
 * cross-origin request, and the cases it would cover are already covered twice:
 * the session cookie is `SameSite=Lax`, so it never travels on a cross-site POST,
 * and both routes ask for a password the caller would have to know.
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin')
  if (!origin) return true
  try {
    return new URL(origin).host === request.headers.get('host')
  } catch {
    return false
  }
}
