/**
 * Signing out.
 *
 * The cookie is cleared by asking the browser to replace it with one that has
 * already expired. There is nothing to delete on the server, because a session
 * is not stored anywhere: it is a signed token, and an expired one is refused by
 * the same check that refuses a forged one.
 *
 * A plain form posts here, so signing out works with JavaScript off, and the
 * reply is a redirect back to the login page — a POST that answered with a page
 * would leave the address bar on an API URL.
 */

import 'server-only'

import { NextResponse } from 'next/server'
import { COOKIE_NAME } from '@/lib/session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(): Promise<NextResponse> {
  // A relative Location, deliberately. `NextResponse.redirect` needs an absolute
  // URL and builds it from the server's own address, which behind nginx is
  // `localhost:5184` — so the browser was being sent to a host that does not
  // resolve. The path is all the browser needs: it resolves it against the
  // address it just posted to, which is the public one.
  const response = new NextResponse(null, {
    status: 303,
    headers: { Location: '/login' },
  })
  response.headers.append('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`)
  return response
}
