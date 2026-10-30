import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { NextRequest } from 'next/server'
import { BACKEND_ORIGIN } from '@/lib/server/backend'

export const dynamic = 'force-dynamic'

const OVERLAYS: Record<string, string> = {
  'chat-overlay': 'chat-overlay.html',
  'cat-overlay': 'cat-overlay.html',
  'top-chatter': 'top-chatter.html',
  'like-target': 'like-target.html',
}

/** Serve the overlay from this web host while pointing its live socket at the backend. */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
): Promise<Response> {
  const { name } = await params
  const file = OVERLAYS[name]
  if (!file) return new Response('Not found', { status: 404 })

  const html = await readFile(join(process.cwd(), 'public', 'overlay', file), 'utf8')
  // The origin a *browser* reaches the backend by, not the one this server uses:
  // the page opens its socket from the viewer's machine. The dashboard host, which
  // proxies /ws/ and the connect route through to the backend — so the backend
  // needs no listener on the internet. The static copies nginx serves off disk
  // fall back to `location.origin` and land on the same place.
  const payload = JSON.stringify({ baseUrl: BACKEND_ORIGIN })
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
  const rendered = html.replace('__OVERLAY_CONFIG__', payload)

  return new Response(rendered, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}
