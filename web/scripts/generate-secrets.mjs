#!/usr/bin/env node
/**
 * Generate the secrets `.env` needs, and optionally write them in.
 *
 * A fresh checkout has no session secret and no password hash, and both have to
 * be correct before the dashboard will let anyone in. Doing that by hand means
 * knowing that the secret is 32 random bytes hex-encoded and that the password
 * has to be bcrypt-hashed — which is exactly the setup friction that had people
 * reaching for `htpasswd` and a file path that only existed on the server.
 *
 * This writes the three lines that matter:
 *
 *   STREAMKIT_SESSION_SECRET            a fresh 32-byte secret
 *   STREAMKIT_DASHBOARD_PASSWORD_HASH   a bcrypt hash of the password you choose
 *   STREAMKIT_DASHBOARD_USER            the account name (default: admin)
 *
 * Usage:
 *   node scripts/generate-secrets.mjs                 # print to stdout
 *   node scripts/generate-secrets.mjs --write         # write into web/.env
 *   node scripts/generate-secrets.mjs --write --password 'hunter2hunter2'
 *
 * With no `--password`, a strong one is generated and printed once. With no
 * `--write`, nothing on disk is touched — the lines are printed for you to paste.
 */

import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import bcrypt from 'bcryptjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ENV_FILE = join(HERE, '..', '.env')

const args = process.argv.slice(2)
const write = args.includes('--write')
const passwordFlag = args.indexOf('--password')
const userFlag = args.indexOf('--user')

const user = userFlag !== -1 ? args[userFlag + 1] : 'admin'

// A generated password is 24 bytes of base64url — long enough that it is not the
// weak link, and printable so it can be copied out of a terminal.
const password = passwordFlag !== -1 ? args[passwordFlag + 1] : randomBytes(24).toString('base64url')

if (passwordFlag !== -1 && (!password || password.length < 8)) {
  console.error('--password needs a value of at least 8 characters.')
  process.exit(1)
}

const secret = randomBytes(32).toString('hex')
const hash = bcrypt.hashSync(password, 10)

const lines = [
  `STREAMKIT_SESSION_SECRET=${secret}`,
  `STREAMKIT_DASHBOARD_USER=${user}`,
  `STREAMKIT_DASHBOARD_PASSWORD_HASH=${hash}`,
]

if (!write) {
  console.log('# Add these to web/.env (or run with --write to do it):\n')
  console.log(lines.join('\n'))
  console.log()
  console.log(`# Password: ${password}`)
  console.log('# (Shown once. Change it from the dashboard after signing in.)')
  process.exit(0)
}

// Merge into the existing file rather than replacing it: it holds the backend
// token and other settings that are not this script's to touch.
let existing = ''
try {
  existing = readFileSync(ENV_FILE, 'utf8')
} catch {
  // No file yet — the lines below create one.
}

const keys = new Set(lines.map((line) => line.split('=')[0]))
const kept = existing
  .split('\n')
  .filter((line) => line.trim() !== '' && !keys.has(line.split('=')[0]))

const merged = [...kept, ...lines].join('\n') + '\n'
writeFileSync(ENV_FILE, merged, 'utf8')

console.log(`Wrote ${ENV_FILE}`)
console.log(`  ${lines.map((line) => line.split('=')[0]).join('\n  ')}`)
console.log()
console.log(`Password: ${password}`)
console.log('(Shown once. Change it from the dashboard after signing in.)')
