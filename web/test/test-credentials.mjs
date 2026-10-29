/**
 * The dashboard password, checked and changed without a browser.
 *
 * The hash lives in the environment now, not in an htpasswd file, so the seam
 * these tests guard is different: the credential is read from
 * `STREAMKIT_DASHBOARD_PASSWORD_HASH`, and a change rewrites that line in the
 * `.env` file the deployment loads.
 *
 * The failure this is here to catch is the quiet one: a change that reports
 * success and leaves a credential nobody can sign in with — a lockout — or a
 * rewrite that damages the other secrets in the same file.
 *
 * Run with: npm test  (from web/)
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  hashPassword,
  isBcryptHash,
  passwordHash,
  passwordMatchesHash,
  verifyPassword,
} from '../src/lib/server/credentials.ts'
import { persistPasswordHash } from '../src/lib/server/envFile.ts'

let failures = 0
function check(name, ok) {
  if (ok) {
    console.log(`  ok    ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${name}`)
  }
}

const dir = mkdtempSync(join(tmpdir(), 'credentials-test-'))
const envFile = join(dir, '.env')

// The credential is read from the environment. Each check sets it explicitly so
// the tests do not depend on whatever the developer's own shell has.
function setHash(value) {
  if (value === undefined) delete process.env.STREAMKIT_DASHBOARD_PASSWORD_HASH
  else process.env.STREAMKIT_DASHBOARD_PASSWORD_HASH = value
}

// ---- reading the credential ----------------------------------------------

setHash(await hashPassword('secret123'))
check('a hash this module wrote is a bcrypt hash', isBcryptHash(passwordHash()))
check('the configured password is accepted', (await verifyPassword('secret123')) === 'ok')
check('a wrong password is refused', (await verifyPassword('nope')) === 'wrong')

setHash(undefined)
check('no hash configured is no-user, not a pass', (await verifyPassword('secret123')) === 'no-user')
check('and passwordHash is null', passwordHash() === null)

setHash('not-a-bcrypt-hash')
let threw = false
try {
  await verifyPassword('secret123')
} catch {
  threw = true
}
check('a non-bcrypt hash is a loud error, not a wrong password', threw)

// A hash with the other bcrypt prefixes must be readable — a deployment may have
// generated the hash with any tool that emits them.
setHash('$2y$10$DBi7IMJuagJ/FArM1VJT4.JZjrKYRx4GxFAOn.xiP65oei7/9FTVW')
check('a $2y$ hash is recognised', isBcryptHash(passwordHash()))

// ---- generating and proving a hash ---------------------------------------

const fresh = await hashPassword('a-new-secret')
check('a generated hash verifies against its own plaintext', await passwordMatchesHash('a-new-secret', fresh))
check('and refuses a different password', !(await passwordMatchesHash('other', fresh)))

// ---- rewriting the env file ----------------------------------------------

writeFileSync(
  envFile,
  [
    '# a comment that must survive',
    'STREAMKIT_TOKEN=backend-token-value',
    'STREAMKIT_SESSION_SECRET=session-secret-value',
    'STREAMKIT_DASHBOARD_PASSWORD_HASH=old-hash-value',
    'STREAMKIT_DASHBOARD_USER=admin',
    '',
  ].join('\n'),
  'utf8',
)
process.env.STREAMKIT_ENV_FILE = envFile

await persistPasswordHash(fresh)

const written = readFileSync(envFile, 'utf8')
check('the new hash is in the file', written.includes(`STREAMKIT_DASHBOARD_PASSWORD_HASH=${fresh}`))
check('the old hash is gone', !written.includes('old-hash-value'))
check('the backend token survives', written.includes('STREAMKIT_TOKEN=backend-token-value'))
check('the session secret survives', written.includes('STREAMKIT_SESSION_SECRET=session-secret-value'))
check('the comment survives', written.includes('# a comment that must survive'))
check('the other variable survives', written.includes('STREAMKIT_DASHBOARD_USER=admin'))
check('the file is still exactly as many lines as before', written.trimEnd().split('\n').length === 5)
check('the running process sees the new hash', passwordHash() === fresh)
check('the new password verifies in-process', (await verifyPassword('a-new-secret')) === 'ok')
check('no scratch file is left behind', readdirSync(dir).length === 1)

// A commented-out line is not the value in force, so it must be left alone rather
// than resurrected by the rewrite.
writeFileSync(
  envFile,
  ['# STREAMKIT_DASHBOARD_PASSWORD_HASH=disabled', 'STREAMKIT_TOKEN=t', ''].join('\n'),
  'utf8',
)
await persistPasswordHash(fresh)
const withComment = readFileSync(envFile, 'utf8')
check('a commented-out line is left as a comment', withComment.includes('# STREAMKIT_DASHBOARD_PASSWORD_HASH=disabled'))
check('and the live line is appended', withComment.includes(`\nSTREAMKIT_DASHBOARD_PASSWORD_HASH=${fresh}`))

// A file that does not exist is a failure to report, not a silent success that
// changed only the in-memory value.
process.env.STREAMKIT_ENV_FILE = join(dir, 'missing', '.env')
let failed = false
try {
  await persistPasswordHash(fresh)
} catch {
  failed = true
}
check('a missing env file fails the change', failed)

delete process.env.STREAMKIT_ENV_FILE
rmSync(dir, { recursive: true, force: true })

console.log()
if (failures > 0) {
  console.log(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')
