/**
 * Persisting a new dashboard password hash into `.env`.
 *
 * The hash is the credential store, and it lives in the environment file. Changing
 * the password therefore means rewriting one line of that file — and doing it the
 * way a credential file has to be done:
 *
 *   - The new hash is proven to verify against its own plaintext before the file
 *     is touched. A hash that did not verify would be a lockout, and the whole
 *     point of working on a scratch copy is that this check can fail without
 *     anyone being locked out.
 *
 *   - The live file is replaced by `rename`, which is atomic: a reader sees the
 *     old file or the new one, never a half-written one. A truncated env file is a
 *     deployment that cannot start.
 *
 *   - Every other line is kept as it was. The file holds the backend token and the
 *     session secret too, and a password change must not disturb them.
 *
 * `process.env` is updated in the same breath, so the change takes effect on the
 * next request rather than at the next restart — the running server already has
 * the file's contents in memory and does not re-read it.
 *
 * No `server-only` import: the test suite runs this under plain `node`, which
 * cannot resolve the `server-only` shim. The route that calls it carries the
 * server-only guarantee.
 */

import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** The variable whose line is rewritten. */
const KEY = 'STREAMKIT_DASHBOARD_PASSWORD_HASH'

/**
 * The env file to edit.
 *
 * `.env` beside the running server, which is what Next loads. A deployment that
 * keeps its environment elsewhere sets `STREAMKIT_ENV_FILE`; the change route
 * then edits that file instead, and one that is not writable reports the failure
 * rather than silently changing only the in-memory value.
 */
function envFile(): string {
  return process.env.STREAMKIT_ENV_FILE?.trim() || join(process.cwd(), '.env')
}

/**
 * A hash as it has to appear in the file.
 *
 * A bcrypt hash is full of `$` — `$2b$10$...` — and Next.js expands `$` in an
 * `.env` value as a reference to another variable, so an unescaped hash is read
 * back as `$2b$10` with the salt and digest silently dropped. It then fails the
 * bcrypt check and the password appears to have been rejected. `\$` is the
 * escape the loader understands: it reads back as a literal `$`, so the hash
 * survives the round trip. The in-memory value below is the real hash, not this.
 */
function fileValue(hash: string): string {
  return hash.replace(/\$/g, '\\$')
}

/** The file's text with the hash line replaced, or appended if it is not there. */
function withHash(text: string, hash: string): string {
  const line = `${KEY}=${fileValue(hash)}`
  const lines = text.split('\n')
  let replaced = false
  const next = lines.map((existing) => {
    // Match the key at the start of a line, ignoring a leading `export ` and any
    // spacing around `=`. A commented-out line is left alone: it is not the value
    // in force, and rewriting it would resurrect something deliberately disabled.
    if (/^\s*#/.test(existing)) return existing
    if (new RegExp(`^\\s*(?:export\\s+)?${KEY}\\s*=`).test(existing)) {
      replaced = true
      return line
    }
    return existing
  })
  if (!replaced) {
    // A trailing newline on the last real line, so the append lands on its own.
    if (next.length > 0 && next[next.length - 1] !== '') next.push('')
    next.push(line)
  }
  return next.join('\n')
}

/**
 * Write `hash` into the env file and into the running process.
 *
 * The caller is responsible for having generated and verified the hash; this is
 * the persistence step alone.
 */
export async function persistPasswordHash(hash: string): Promise<void> {
  const file = envFile()
  const scratch = `${file}.${process.pid}.tmp`

  // Read first: a missing or unreadable file throws before anything is written,
  // and the caller reports a failure with the live file untouched.
  const existing = await readFile(file, 'utf8')

  try {
    await writeFile(scratch, withHash(existing, hash), 'utf8')
    await rename(scratch, file)
  } catch (cause) {
    await unlink(scratch).catch(() => {})
    throw cause
  }

  // The file is what a restart reads; this is what the running server reads. Both
  // have to move together, or the change appears to work and then reverts.
  process.env[KEY] = hash
}

/** Whether the env file is present and writable enough to change the password. */
export async function envFileReadable(): Promise<boolean> {
  try {
    await readFile(envFile(), 'utf8')
    return true
  } catch {
    return false
  }
}
