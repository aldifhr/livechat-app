import 'server-only'

import { ConvexHttpClient } from 'convex/browser'

const convexUrl = () => {
  const url = (process.env.CONVEX_URL || process.env.NEXT_PUBLIC_CONVEX_URL || '').replace(/\/+$/, '')
  if (!url) throw new Error('Convex deployment URL is not configured')
  return url
}

const adminKey = () => (process.env.CONVEX_ADMIN_KEY || '').trim()

async function callViaHttpClient(kind: 'query' | 'mutation', path: string, args: Record<string, unknown>) {
  const client = new ConvexHttpClient(convexUrl())
  if (adminKey()) (client as any).setAdminAuth(adminKey())
  return kind === 'query' ? client.query(path as any, args) : client.mutation(path as any, args)
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
