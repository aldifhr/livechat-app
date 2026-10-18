/**
 * The session cookie, signed and checked without a browser.
 *
 * What matters here is the seam the whole login rests on: a token this server
 * signed must be accepted, and everything else must not. "Everything else" is
 * the long list — a token signed with a different key, one whose body was edited,
 * one that has expired, one that is truncated, one from a future version. Each
 * of those is a way in if the check is sloppy, so each is a case below.
 *
 * Run with: npm test  (from web/)
 */

import { sessionCookie, sessionKey, signSession, verifySession, COOKIE_NAME } from '../src/lib/server/session.ts'

let failures = 0
function check(name, ok) {
  if (ok) {
    console.log(`  ok    ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${name}`)
  }
}

const secret = 'a-deployment-secret'
const hash = '$2y$10$abcdefghijklmnopqrstuvabcdefghijklmnopqrstuvabcdefghi'
const key = sessionKey(secret, hash)

const now = 1_700_000_000_000
const token = signSession(key, 'admin', now)

const session = verifySession(key, token, now + 1000)
check('a token this key signed is accepted', session !== null)
check('the session names the user it was minted for', session?.user === 'admin')
check('the session carries an expiry', typeof session?.exp === 'number' && session.exp > now)

// The signature is what makes the token unforgeable, so a different key must not
// be able to produce one this accepts — that is the entire point of signing it.
check('another key refuses the token', verifySession(sessionKey('other', hash), token, now) === null)

// Changing the password changes the hash, and the key is derived from the hash.
// This is the property that signs every old device out on a password change.
check('a different password hash refuses the token', verifySession(sessionKey(secret, '$2y$10$other'), token, now) === null)

check('an expired token is refused', verifySession(key, token, now + 31 * 24 * 60 * 60 * 1000) === null)

// A token whose body was edited to name another user, with the signature left as
// it was: the signature no longer covers the body, so it must be refused.
const [version, body, mac] = token.split('.')
const forgedBody = Buffer.from(JSON.stringify({ user: 'root', exp: now + 10 ** 12 }), 'utf8').toString('base64url')
check('an edited body is refused', verifySession(key, `${version}.${forgedBody}.${mac}`, now) === null)

check('a truncated token is refused', verifySession(key, token.slice(0, -4), now) === null)
check('a token with no signature is refused', verifySession(key, `${version}.${body}`, now) === null)
check('an empty token is refused', verifySession(key, '', now) === null)
check('a token from another version is refused', verifySession(key, `v2.${body}.${mac}`, now) === null)
check('garbage is refused rather than throwing', verifySession(key, 'not-a-token', now) === null)

// The cookie attributes are what keep the token out of scripts and off plain
// HTTP; a missing one is a real weakening, so each is asserted.
const cookie = sessionCookie(token)
check('the cookie carries the session name', cookie.startsWith(`${COOKIE_NAME}=${token}`))
check('the cookie is HttpOnly', cookie.includes('HttpOnly'))
check('the cookie is Secure', cookie.includes('Secure'))
check('the cookie is SameSite=Lax', cookie.includes('SameSite=Lax'))
check('the cookie is scoped to the whole site', cookie.includes('Path=/'))
check('the cookie has a max-age', /Max-Age=\d+/.test(cookie))

// Signing out is the same cookie with no age; the browser drops it.
const cleared = sessionCookie('', 0)
check('the cleared cookie expires immediately', cleared.includes('Max-Age=0'))

console.log()
if (failures > 0) {
  console.log(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')
