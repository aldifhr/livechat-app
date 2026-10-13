/**
 * The password file, checked and changed without a browser.
 *
 * The hashing is done in-process with bcryptjs, but the file it reads and writes
 * is the one nginx checks and `htpasswd` writes. So the tests here are mostly
 * about that seam: the file must stay a file nginx and `htpasswd` accept, and the
 * hashes `htpasswd` already wrote must stay checkable by this code.
 *
 * The failure this is here to catch is the quiet one: a change that reports
 * success and leaves a file nginx no longer accepts — a lockout.
 *
 * Run with: npm test  (from web/)
 */

import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setPassword, verifyPassword } from '../src/lib/htpasswd.ts'

let failures = 0
function check(name, ok) {
  if (ok) {
    console.log(`  ok    ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${name}`)
  }
}

/** Whether the real `htpasswd` accepts `password` for `user` in `file` — the
 *  same check nginx makes, through the same tool. */
function htpasswdAccepts(file, user, password) {
  try {
    execFileSync('htpasswd', ['-vi', file, user], {
      input: `${password}\n`,
      stdio: ['pipe', 'ignore', 'ignore'],
    })
    return true
  } catch {
    return false
  }
}

const dir = mkdtempSync(join(tmpdir(), 'htpasswd-test-'))
const file = join(dir, 'streamtools.htpasswd')

// Created by the real tool, at the deployed cost, so the format under test is the
// format in production — `htpasswd` writes `$2y$`, and reading that is the case
// that matters for a file that already exists.
execFileSync('htpasswd', ['-c', '-iB', '-C', '10', file, 'admin'], {
  input: 'secret123\n',
  stdio: ['pipe', 'ignore', 'ignore'],
})
chmodSync(file, 0o640)
const before = statSync(file)
check('the file starts as an htpasswd $2y$ hash', readFileSync(file, 'utf8').startsWith('admin:$2y$'))

check('a password htpasswd wrote is accepted', (await verifyPassword(file, 'admin', 'secret123')) === 'ok')
check('a wrong password is refused', (await verifyPassword(file, 'admin', 'nope')) === 'wrong')
check(
  'an unknown account is reported as such, not as a wrong password',
  (await verifyPassword(file, 'someone', 'secret123')) === 'no-user',
)

await setPassword(file, 'admin', 'a-new-secret')

check('the new password works', (await verifyPassword(file, 'admin', 'a-new-secret')) === 'ok')
check('the old password no longer works', (await verifyPassword(file, 'admin', 'secret123')) === 'wrong')

// The hash this writes is one nginx and htpasswd must also accept — that is what
// makes it a drop-in for the file rather than a second format.
check('htpasswd accepts the hash this wrote', htpasswdAccepts(file, 'admin', 'a-new-secret'))
check('htpasswd refuses a wrong password against it', !htpasswdAccepts(file, 'admin', 'secret123'))

const after = statSync(file)
check('the file keeps its mode', (after.mode & 0o777) === (before.mode & 0o777))
check('the file keeps its owner and group', after.uid === before.uid && after.gid === before.gid)

const lines = readFileSync(file, 'utf8').trim().split('\n')
check('the file is still exactly one admin line', lines.length === 1 && lines[0].startsWith('admin:'))
check('no scratch file is left behind', readdirSync(dir).length === 1)

// A file with a second account: changing one must not drop the other.
const two = join(dir, 'two.htpasswd')
execFileSync('htpasswd', ['-c', '-iB', '-C', '10', two, 'admin'], {
  input: 'first-pass\n',
  stdio: ['pipe', 'ignore', 'ignore'],
})
execFileSync('htpasswd', ['-iB', '-C', '10', two, 'guest'], {
  input: 'guest-pass\n',
  stdio: ['pipe', 'ignore', 'ignore'],
})
await setPassword(two, 'admin', 'changed-pass')
check('the other account survives a change', (await verifyPassword(two, 'guest', 'guest-pass')) === 'ok')
check('the changed account works', (await verifyPassword(two, 'admin', 'changed-pass')) === 'ok')
check('the two-account file still has two lines', readFileSync(two, 'utf8').trim().split('\n').length === 2)

rmSync(dir, { recursive: true, force: true })

console.log()
if (failures > 0) {
  console.log(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')
