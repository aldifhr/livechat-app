import 'server-only'

import { ConvexHttpClient } from 'convex/browser'

/**
 * The public Convex origin. A deployment that sets CONVEX_URL (the VPS
 * service sets it to loopback) uses that; everyone else — Vercel included —
 * reaches the same deployment through its public host, which nginx routes to
 * Convex. No admin key is required: the functions themselves are the API.
 */
const PUBLIC_CONVEX_URL = 'https://kit-backend.aldifhr.my.id'

const convexUrl = () => {
  const url = (process.env.CONVEX_URL || process.env.NEXT_PUBLIC_CONVEX_URL || PUBLIC_CONVEX_URL).replace(/\/+$/, '')
  return url
}

const adminKey = () => (process.env.CONVEX_ADMIN_KEY || '').trim()

/** The write token Convex functions require. Attached here so every call
 *  site sends it without remembering to. */
const apiToken = () => (process.env.STREAMKIT_TOKEN || '').trim()

async function callViaHttpClient(kind: 'query' | 'mutation', path: string, args: Record<string, unknown>) {
  const client = new ConvexHttpClient(convexUrl())
  if (adminKey()) (client as any).setAdminAuth(adminKey())
  const withToken = { ...args, ...(apiToken() ? { token: apiToken() } : {}) }
  return kind === 'query' ? client.query(path as any, withToken) : client.mutation(path as any, withToken)
}

export async function convexQuery<T>(path: string, args: Record<string, unknown> = {}): Promise<T> {
  return (await callViaHttpClient('query', path.includes(':') ? path : `${path.replace(/^\/api\//, '').replace(/^\//, '')}:default`, args)) as T
}

export async function convexMutation<T>(path: string, args: Record<string, unknown> = {}): Promise<T> {
  return (await callViaHttpClient('mutation', path.includes(':') ? path : `${path.replace(/^\/api\//, '').replace(/^\//, '')}:default`, args)) as T
}

export async function convexAction<T>(path: string, args: Record<string, unknown> = {}): Promise<T> {
  const client = new ConvexHttpClient(convexUrl())
  if (adminKey()) (client as any).setAdminAuth(adminKey())
  return (await client.action((path.includes(':') ? path : `${path.replace(/^\/api\//, '').replace(/^\//, '')}:default`) as any, args)) as T
}
