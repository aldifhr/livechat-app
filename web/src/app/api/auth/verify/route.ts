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
import { COOKIE_NAME } from '@/lib/session'
import { isSessionValid } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function verify(): Promise<Response> {
  const store = await cookies()
  const valid = await isSessionValid(store.get(COOKIE_NAME)?.value)
  return new Response(null, { status: valid ? 204 : 401 })
}

// nginx's `auth_request` subrequest keeps the method of the request it is
// checking, so a POST to a gated route arrives here as a POST.
export const GET = verify
export const POST = verify
