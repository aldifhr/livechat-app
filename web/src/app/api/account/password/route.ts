/**
 * Changing the dashboard password.
 *
 * The password being changed is this dashboard's own login — the one the login
 * page checks — and it lives in the environment, as a bcrypt hash. That is why
 * this route does not touch the backend or `STREAMKIT_TOKEN`. The hashing is done
 * in-process (see `lib/server/credentials`) rather than by shelling out, so the
 * password never touches a command line, and the new hash is written back into
 * `.env` by `lib/server/envFile` — atomically, and only after it has been proven
 * to verify.
 *
 * It sits behind the session gate like every other /api route, so the caller is
 * already signed in. The current password is still asked for and checked, for
 * two reasons: a stolen session should not let someone silently lock the owner
 * out, and it is what makes a cross-site request useless — an attacker can make
 * the browser send the change, but cannot supply a password it does not know.
 */

import 'server-only'

import { NextRequest } from 'next/server'
import { hashPassword, passwordMatchesHash, verifyPassword } from '@/lib/server/credentials'
import { persistPasswordHash } from '@/lib/server/envFile'
import { isSameOrigin } from '@/lib/server/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** bcrypt hashes at most 72 bytes; a longer password would be silently cut. A
 *  newline would too, since the hash is written as one `.env` line. Refuse both. */
const MIN_BYTES = 8
const MAX_BYTES = 72

function refuse(detail: string, status: number): Response {
  return Response.json({ detail }, { status })
}

export async function POST(request: NextRequest): Promise<Response> {
  // Same-origin only. A change triggered from another site would be carrying this
  // browser's cached credentials; the current-password check below is the real
  // gate, and this refuses the attempt before it even reaches that. `isSameOrigin`
  // for what counts as another site.
  if (!isSameOrigin(request)) return refuse('Cross-site requests are not accepted.', 403)

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return refuse('Expected a JSON body.', 400)
  }

  const { current, next } = (body ?? {}) as { current?: unknown; next?: unknown }
  if (typeof current !== 'string' || typeof next !== 'string') {
    return refuse('Both the current and the new password are required.', 400)
  }
  if (Buffer.byteLength(next, 'utf8') < MIN_BYTES) {
    return refuse(`The new password must be at least ${MIN_BYTES} characters.`, 400)
  }
  if (Buffer.byteLength(next, 'utf8') > MAX_BYTES) {
    return refuse('The new password is too long (at most 72 bytes).', 400)
  }
  if (next.includes('\n') || next.includes('\r')) {
    return refuse('The new password cannot contain a line break.', 400)
  }
  if (next === current) {
    return refuse('The new password is the same as the current one.', 400)
  }

  let check: Awaited<ReturnType<typeof verifyPassword>>
  try {
    check = await verifyPassword(current)
  } catch {
    return refuse('The dashboard password is not configured correctly.', 500)
  }
  if (check === 'no-user') {
    return refuse('No dashboard password is configured on this server.', 500)
  }
  if (check === 'wrong') {
    return refuse('That is not the current password.', 403)
  }

  // Hash, then prove the hash verifies against its own plaintext before it is
  // allowed anywhere near the live file. A hash that did not verify would be a
  // lockout, and this is the last point at which that can be caught.
  const hash = await hashPassword(next)
  if (!(await passwordMatchesHash(next, hash))) {
    return refuse('The new password could not be verified.', 500)
  }

  try {
    await persistPasswordHash(hash)
  } catch {
    return refuse('The password could not be saved. The server\'s .env is not writable.', 500)
  }

  return Response.json({ ok: true })
}
