/**
 * The check nginx makes before it lets a request through.
 *
 * This is what replaced `auth_basic`: nginx does not read a password file any
 * more, it sends the request's cookie here and gets a yes or a no. A 204 means
 * the cookie is a session this server signed and has not expired; a 401 means
 * anything else, and nginx answers the visitor with the login page.
 *
 * It answers nothing but the status — no body, no reason — because the only
 * caller is nginx and the only two answers it acts on are "let it through" and
 * "ask them to sign in".
 */

import 'server-only'

import { cookies } from 'next/headers'
import { passwordHashCached } from '@/lib/htpasswd'
import { dashboardUser, passwordFile, sessionSecret } from '@/lib/config'
import { COOKIE_NAME, sessionKey, verifySession } from '@/lib/session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function refused(): Response {
  return new Response(null, { status: 401 })
}

async function verify(): Promise<Response> {
  const secret = sessionSecret()
  if (!secret) return refused()

  const store = await cookies()
  const token = store.get(COOKIE_NAME)?.value
  if (!token) return refused()

  // The key is derived from the hash in force, so this also refuses a cookie
  // that was valid until the password changed — which is the point of deriving
  // it from the hash rather than storing a session.
  const hash = await passwordHashCached(passwordFile, dashboardUser).catch(() => null)
  if (!hash) return refused()

  if (!verifySession(sessionKey(secret, hash), token)) return refused()
  return new Response(null, { status: 204 })
}

// nginx's `auth_request` subrequest keeps the method of the request it is
// checking, so a POST to a gated route arrives here as a POST.
export const GET = verify
export const POST = verify
