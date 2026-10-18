import 'server-only'

import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * Giveaway commitments, held by the server rather than the operator's browser.
 *
 * The proof a draw was fair is that its winning seed was fixed before the draw and
 * could not have been chosen to favour anyone. A hash the operator computes — and
 * reveals in the same breath as the seed — proves nothing: the operator knows the
 * pool when they close entries and could grind seeds offline until one lands on a
 * winner they like. So the seed is generated here, kept secret until the draw, and
 * only its hash is handed back.
 *
 * The file lives beside the password hash (same directory, same reason: it is state
 * a running deployment must keep), written atomically so a crash mid-save cannot
 * leave a truncated file behind.
 */

type Commit = { seed: string; poolHash: string; committedAt: string; revealed: boolean }
type Store = Record<string, Commit>

const DATA_DIR = process.env.STREAMKIT_HTPASSWD
  ? dirname(process.env.STREAMKIT_HTPASSWD)
  : join(process.cwd(), '.data')
const FILE = join(DATA_DIR, 'giveaway-commits.json')

function hash(seed: string): string {
  return createHash('sha256').update(seed).digest('hex')
}

// One writer at a time. Read-modify-write on a shared file races under concurrent
// requests — two commits landing together would keep only the last one's entry.
let chain: Promise<unknown> = Promise.resolve()
function serialize<T>(work: () => Promise<T>): Promise<T> {
  const next = chain.then(work, work)
  chain = next.catch(() => {})
  return next
}

async function read(): Promise<Store> {
  try {
    return JSON.parse(await readFile(FILE, 'utf8')) as Store
  } catch {
    return {}
  }
}

async function write(store: Store): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true })
  const tmp = `${FILE}.tmp`
  await writeFile(tmp, JSON.stringify(store), 'utf8')
  await rename(tmp, FILE)
}

/** Fix a seed for a frozen pool. Returns the commitment's id and the seed's hash. */
export async function createCommit(poolHash: string): Promise<{ id: string; commitHash: string; committedAt: string }> {
  return serialize(async () => {
    const store = await read()
    const id = randomBytes(12).toString('base64url')
    const seed = randomBytes(32).toString('hex')
    const committedAt = new Date().toISOString()
    store[id] = { seed, poolHash, committedAt, revealed: false }
    await write(store)
    return { id, commitHash: hash(seed), committedAt }
  })
}

/** The seed for a commitment, revealed. Null when the id is unknown. */
export async function revealCommit(id: string): Promise<{ seed: string } | null> {
  return serialize(async () => {
    const store = await read()
    const entry = store[id]
    if (!entry) return null
    entry.revealed = true
    await write(store)
    return { seed: entry.seed }
  })
}

/** A commitment's public parts — never the seed. Null when the id is unknown. */
export async function readCommit(
  id: string,
): Promise<{ commitHash: string; poolHash: string; committedAt: string; revealed: boolean } | null> {
  const store = await read()
  const entry = store[id]
  if (!entry) return null
  return { commitHash: hash(entry.seed), poolHash: entry.poolHash, committedAt: entry.committedAt, revealed: entry.revealed }
}
