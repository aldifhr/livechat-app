import 'server-only'

/**
 * RPC client for the Python backend.
 *
 * The Next.js gateway still speaks the old function names (`rooms:list`,
 * `events:recentForRoom`, ...). Keeping that vocabulary here means the gateway,
 * its tests and every client helper stay unchanged while storage moves from
 * Convex to PostgreSQL. The Python service dispatches these names in one place.
 */

const DEFAULT_URL = 'http://127.0.0.1:8004'

const apiUrl = () =>
  (process.env.STREAMKIT_API_URL || process.env.PYTHON_API_URL || DEFAULT_URL).replace(/\/+$/, '')

const apiToken = () => (process.env.STREAMKIT_TOKEN || '').trim()

async function call(path: string, args: Record<string, unknown>): Promise<unknown> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  const token = apiToken()
  if (token) headers['x-streamkit-token'] = token

  let response: Response
  try {
    response = await fetch(`${apiUrl()}/rpc`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path, args: { ...args, ...(token ? { token } : {}) } }),
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    })
  } catch (cause) {
    throw new Error(`Python backend unreachable: ${cause instanceof Error ? cause.message : cause}`)
  }

  const text = await response.text()
  let value: unknown = null
  try {
    value = text ? JSON.parse(text) : null
  } catch {
    if (!response.ok) throw new Error(`Python backend returned HTTP ${response.status}`)
  }
  if (!response.ok) {
    const detail = (value as { detail?: string } | null)?.detail || `HTTP ${response.status}`
    throw new Error(detail)
  }
  return value
}

/** Function paths here always include their module prefix, e.g. `rooms:get`. */
export async function convexQuery<T>(path: string, args: Record<string, unknown> = {}): Promise<T> {
  return (await call(path.includes(':') ? path : `${path.replace(/^\/api\//, '').replace(/^\//, '')}:default`, args)) as T
}

export async function convexMutation<T>(path: string, args: Record<string, unknown> = {}): Promise<T> {
  return convexQuery<T>(path, args)
}

export async function convexAction<T>(path: string, args: Record<string, unknown> = {}): Promise<T> {
  return convexQuery<T>(path, args)
}
