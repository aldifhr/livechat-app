/**
 * The dashboard's own gate.
 *
 * nginx checks the session too, and that check is the one that matters — it is
 * the one an attacker cannot skip. This runs as well because nginx's check can
 * only say "let it through or ask them to sign in": it cannot tell the dashboard
 * what to do with the request once it is through, and a page that renders while
 * the API proxy beside it refuses every call is a broken console rather than a
 * login prompt.
 *
 * So a request that reaches the app without a session is sent to /login, with
 * where it was trying to go. That is what makes the gate a page: the address is
 * the login, the failure is a sentence on it, and the visitor lands where they
 * were headed once they are in.
 *
 * The overlay pages are not Next routes — nginx serves them from disk — so they
 * never come through here, which is why they keep working with no session at all.
 *
 * This file is `proxy.ts`, not `middleware.ts`: Next 16 renamed the convention
 * and the export. It runs on the Node runtime, which is not optional any more —
 * the session is signed with a key derived from the password file, and reading
 * that file is what makes a password change sign everyone out. A Proxy file
 * cannot carry a `runtime` export; Node is what it always is.
 */

import { NextRequest, NextResponse } from 'next/server'
import { COOKIE_NAME } from '@/lib/server/session'
import { isSessionValid } from '@/lib/server/auth'

function hasSession(request: NextRequest): Promise<boolean> {
  return isSessionValid(request.cookies.get(COOKIE_NAME)?.value)
}

/** Paths that are reachable without signing in. */
function isOpen(pathname: string): boolean {
  return (
    pathname === '/login' ||
    pathname.startsWith('/api/auth/') ||
    // The landing page is public: it is what tells a visitor this is a product
    // and gives them the link to sign in.
    pathname === '/' ||
    // The overlay pages. Open because they ARE open — the login page says so in
    // as many words, and OBS cannot type a password, so a gate on them would only
    // mean a link that works for nobody.
    //
    // In production nginx never gets this far: it serves these from disk, and the
    // two requests have never met. This is here so that `next dev` answers them
    // the same way the server does, rather than redirecting a browser source to a
    // login form — which is what happened, and looked exactly like the overlays
    // being broken.
    pathname.startsWith('/overlay/') ||
    // Giveaway reports are public, unguessable snapshot links. Creation is
    // bounded and validated by its route handler; private dashboard APIs remain gated.
    /^\/giveaway\/[A-Za-z0-9_-]{16}$/.test(pathname) ||
    pathname === '/api/giveaways/snapshots' ||
    // Giveaway commitments. Open at the proxy so the giveaway page can reach
    // them without a session, and gated inside the route by origin: the
    // dashboard same-origin only.
    pathname === '/api/giveaways/commit' ||
    pathname.startsWith('/api/giveaways/commit/') ||
    pathname === '/api/tts' ||
    // OBS docks: public browser source for OBS, mirrors the stream home page.
    // No session — OBS cannot type a password, same reason as overlays.
    pathname === '/docks' ||
    pathname.startsWith('/docks/') ||
    // The one write an overlay may make with no credential. The backend
    // exempts this path from its own token gate; this is the app's session
    // check letting it past so the backend gets to answer at all.
    pathname === '/api/backend/room-connect-by-username' ||
    // Docks is a public OBS browser source, and these are the three reads it
    // makes: the room list for its platform picker, and the two per-room reads
    // behind the badge. The backend answers all three without a token — the
    // room list it serves publicly carries no config and no styling. Without
    // this the page rendered and every number on it was blank.
    pathname === '/api/backend/rooms/public' ||
    /^\/api\/backend\/rooms\/[0-9a-f-]{36}\/(status|session)$/.test(pathname) ||
    // Next's own static assets, which carry no data.
    pathname.startsWith('/_next/') ||
    pathname === '/favicon.ico'
  )
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl
  if (isOpen(pathname)) return NextResponse.next()

  if (await hasSession(request)) return NextResponse.next()

  // An API call is answered with a status, not a page. A redirect would arrive
  // at a fetch as a 200 carrying the login page's HTML, which reads as success
  // and then fails on the JSON — the caller cannot tell it needs to sign in.
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ detail: 'Sign in to continue.' }, { status: 401 })
  }

  const login = new URL('/login', request.url)
  // Only the path and query travel; the origin is this request's own.
  login.searchParams.set('next', pathname + request.nextUrl.search)
  return NextResponse.redirect(login)
}

export const config = {
  // Everything except the static assets, which never carry data and are fetched
  // on every page load — running the check for each one would be a file read per
  // chunk for no benefit.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
