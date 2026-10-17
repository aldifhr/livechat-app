import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { NextRequest } from 'next/server'
import { BACKEND } from '@/lib/backend'

export const dynamic = 'force-dynamic'

const OVERLAYS: Record<string, string> = {
  'chat-overlay': 'chat-overlay.html',
  'top-chatter': 'top-chatter.html',
  'cat-overlay': 'cat-overlay.html',
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
  const payload = JSON.stringify({ baseUrl: BACKEND })
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
