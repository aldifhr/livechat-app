/**
 * The dashboard's own password, hashed and checked in-process.
 *
 * The login is this app's own now — a page, not nginx's `auth_basic` dialog —
 * and the file it checks is an htpasswd file of bcrypt hashes. bcrypt is
 * implemented here with `bcryptjs` rather than by shelling out to `htpasswd`, for
 * two reasons: the password never has to leave this process — not on a command
 * line, which `ps` shows to every user on the box, and not down a pipe — and
 * there is no dependency on a tool being installed on the host for the console to
 * be able to change its own password.
 *
 * `bcryptjs` reads the hashes `htpasswd` writes: it emits and accepts `$2b$`,
 * `$2a$` and `$2y$` as the same algorithm, and nginx accepts all three in an
 * htpasswd file. That is what makes the existing file usable as-is rather than a
 * second format to keep in step — the hash already in the file is one this
 * checks.
 *
 * Two properties this module exists to guarantee:
 *
 *   - The live file is replaced atomically, and only after the new hash has been
 *     proven to work. A half-written password file reads as "no valid users" —
 *     every request 401s and the only way back in is a shell. Writing a scratch
 *     file, checking it, and renaming it over the original cannot leave the live
 *     file broken: `rename` is atomic, so a reader sees the old file or the new
 *     one, never a partial one.
 *
 *   - The replacement carries the original file's mode and ownership, so a
 *     rename cannot be the moment the file stops being readable by whatever
 *     needs it.
 */

import { chmod, chown, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import bcrypt from 'bcryptjs'

/** What a check against the stored hash concluded. */
export type VerifyResult = 'ok' | 'wrong' | 'no-user'

/**
 * The cost factor. Ten matches the file this replaces and is the usual default;
 * it is stated rather than left to a library default so it cannot drift.
 */
const COST = 10

/** A bcrypt hash, in any of the prefixes bcrypt uses. Anything else — an MD5
 *  `$apr1$` hash from an older file — cannot be checked by this module, and
 *  saying so is better than a "wrong password" the user cannot act on. */
const BCRYPT = /^\$2[aby]?\$\d{2}\$/

/** The hash stored for `user`, or null if the file has no line for them. */
function hashFor(text: string, user: string): string | null {
  const prefix = `${user}:`
  for (const line of text.split('\n')) {
    if (line.startsWith(prefix)) return line.slice(prefix.length).trim()
  }
  return null
}

/**
 * The bcrypt hash stored for `user`, or null if the file has no line for them.
 *
 * The session module needs this as well as `verifyPassword`: a session is signed
 * with a key derived from the hash in force, which is what makes a password
 * change invalidate every session that was signed with the old one.
 */
export async function passwordHash(file: string, user: string): Promise<string | null> {
  return hashFor(await readFile(file, 'utf8'), user)
}

/**
 * The last file read, keyed by path.
 *
 * `passwordHash` sits on the path of every gated request, twice: once by the
 * `auth_request` nginx makes and once by `proxy.ts` when the request reaches the
 * app. That is two reads and two `stat`s per request for a file whose contents
 * change perhaps twice a year, so the text is held here and re-read only when the
 * file on disk is observably a different file.
 *
 * The key is the stat that came back with the read, so an entry is only ever
 * served for the exact file it was read from. The inode is in the key as well as
 * the timestamp and size, and not as decoration: `setPassword` replaces the file
 * by rename, and a bcrypt hash is always the same length, so a write landing
 * within the same filesystem tick as the read it followed would move neither size
 * nor — at one-second resolution — mtime. The rename always lands on a new
 * inode, so that pair cannot be missed.
 */
interface CacheEntry {
  ino: number
  mtimeMs: number
  size: number
  text: string
}

const cache = new Map<string, CacheEntry>()

/**
 * The bcrypt hash stored for `user`, re-reading only when the file has changed.
 *
 * Same answer as `passwordHash` on every call. The difference is that this one is
 * safe to put on the request path, which is where it is needed.
 */
export async function passwordHashCached(file: string, user: string): Promise<string | null> {
  const info = await stat(file)
  const hit = cache.get(file)
  if (hit && hit.ino === info.ino && hit.mtimeMs === info.mtimeMs && hit.size === info.size) {
    return hashFor(hit.text, user)
  }

  const text = await readFile(file, 'utf8')
  cache.set(file, { ino: info.ino, mtimeMs: info.mtimeMs, size: info.size, text })
  return hashFor(text, user)
}

/** Drop the held copy of `file`, so the next question re-reads it. */
export function forgetPasswordHash(file: string): void {
  cache.delete(file)
}

/** Whether `password` is the one stored for `user` in the file at `file`. */
export async function verifyPassword(
  file: string,
  user: string,
  password: string,
): Promise<VerifyResult> {
  const stored = await passwordHashCached(file, user)
  if (stored === null) return 'no-user'
  if (!BCRYPT.test(stored)) {
    throw new Error(`the stored hash for "${user}" is not a bcrypt hash`)
  }
  return (await bcrypt.compare(password, stored)) ? 'ok' : 'wrong'
}

/**
 * Replace `user`'s password in `file`, leaving the file usable even if this
 * fails partway through.
 *
 * Every other line is kept as it was, so an htpasswd file with more than one
 * account is edited rather than rewritten down to one.
 */
export async function setPassword(file: string, user: string, password: string): Promise<void> {
  // Read and stat first: if the file is missing or unreadable this throws before
  // anything is written, and the caller reports a failure with the live file
  // untouched.
  const original = await stat(file)
  const existing = await readFile(file, 'utf8')

  const hash = await bcrypt.hash(password, COST)
  const prefix = `${user}:`
  const lines = existing.split('\n').filter((line) => line.trim() !== '')

  let replaced = false
  const next = lines.map((line) => {
    if (!line.startsWith(prefix)) return line
    replaced = true
    return prefix + hash
  })
  if (!replaced) next.push(prefix + hash)

  const scratch = join(dirname(file), `.${basename(file)}.${process.pid}.tmp`)
  try {
    await writeFile(scratch, next.join('\n') + '\n', 'utf8')

    // Prove the new hash before it is allowed to replace the working one: a hash
    // that did not verify would be a lockout, and the whole point of working on a
    // scratch file is that this check can fail without anyone being locked out.
    if (!(await bcrypt.compare(password, hash))) {
      throw new Error('the new password did not verify against its own hash')
    }

    // The replacement has to carry the same ownership and mode — otherwise the
    // rename that makes it live is the moment the file stops being readable by
    // whatever needs it.
    await chmod(scratch, original.mode & 0o777)
    await chown(scratch, original.uid, original.gid)

    await rename(scratch, file)
  } catch (cause) {
    await unlink(scratch).catch(() => {})
    throw cause
  } finally {
    // The file is a different file now. The inode in the cache key would catch it
    // on the next read either way; dropping it here means the change is visible to
    // whatever is already holding a derived session key as soon as it asks again,
    // rather than at the mercy of how the two stats happen to compare.
    forgetPasswordHash(file)
  }
}
