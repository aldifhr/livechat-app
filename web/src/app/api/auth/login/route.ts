/**
 * Signing in.
 *
 * One field: the password. The account is `dashboardUser` from the config, not
 * something the visitor types — this is a single deployment's console, so the
 * name is a fact of the deployment and asking for it would only be asking them
 * to guess it. The password is the one thing not known in advance.
 *
 * The password is the one in the htpasswd file this app also changes, and it is
 * checked here in-process — the password never leaves this server, and it is not
 * compared anywhere a shell or nginx can see it.
 *
 * What comes back is a cookie, not a browser credential: nginx no longer holds
 * the password, it asks this app whether the cookie is a session it signed. That
 * is what makes the login a page instead of the browser's own dialog.
 */

import 'server-only'

import { NextRequest, NextResponse } from 'next/server'
import { passwordHashCached, verifyPassword } from '@/lib/htpasswd'
import { dashboardUser, passwordFile, sessionSecret } from '@/lib/config'
import { sessionCookie, sessionKey, signSession } from '@/lib/session'
import { isSameOrigin } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function refuse(detail: string, status: number): NextResponse {
  return NextResponse.json({ detail }, { status })
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Same-origin only. A sign-in posted from another site would be handing this
  // server a password the visitor did not mean to give it. `isSameOrigin` for
  // what counts as another site.
  if (!isSameOrigin(request)) return refuse('Cross-site requests are not accepted.', 403)

  const secret = sessionSecret()
  if (!secret) {
    return refuse('This server has no session secret, so nobody can sign in.', 500)
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return refuse('Expected a JSON body.', 400)
  }

  // A `user` is still accepted if something sends one — an older page, a script
  // — but it is not required and it is not trusted: the account is the
  // configured one either way. Accepting it and ignoring it means a stale client
  // cannot be used to sign in as a different account by naming it.
  const { password } = (body ?? {}) as { user?: unknown; password?: unknown }
  if (typeof password !== 'string') {
    return refuse('A password is required.', 400)
  }

  const user = dashboardUser

  let check: Awaited<ReturnType<typeof verifyPassword>>
  try {
    check = await verifyPassword(passwordFile, user, password)
  } catch {
    return refuse('The password file could not be read.', 500)
  }

  // One message for both a missing account and a wrong password: which names
  // exist is not something a login form should be willing to tell anyone.
  if (check !== 'ok') {
    return refuse('That password is not correct.', 401)
  }

  const hash = await passwordHashCached(passwordFile, user).catch(() => null)
  if (!hash) return refuse('The password file could not be read.', 500)

  // The session is signed with a key derived from the password hash in force, so
  // changing the password invalidates every cookie signed with the old one — the
  // property a password change exists to have, with no session table to keep.
  const token = signSession(sessionKey(secret, hash), user)

  const response = NextResponse.json({ ok: true })
  response.headers.append('Set-Cookie', sessionCookie(token))
  return response
}
