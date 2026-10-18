import { NextRequest, NextResponse } from 'next/server'
import { createCommit } from '@/lib/server/giveawayCommit'
import { ALLOWED_ORIGINS, corsHeaders, originAllowed } from '@/lib/server/giveawayOrigin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Fix a seed for a frozen pool, before any winner is drawn.
 *
 * Open at the proxy (the desktop app has no session) and gated here by origin:
 * the dashboard same-origin, or the app's webview. The seed never comes back — only
 * its hash and the moment it was fixed. The seed is revealed at `/commit/{id}`.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const origin = request.headers.get('origin')
  const headers = corsHeaders(origin)
  if (!originAllowed(request)) {
    return NextResponse.json({ detail: 'This origin cannot commit a giveaway.' }, { status: 403, headers })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ detail: 'Expected a JSON body.' }, { status: 400, headers })
  }
  const poolHash = (body as { poolHash?: unknown } | null)?.poolHash
  if (typeof poolHash !== 'string' || !/^[0-9a-f]{64}$/.test(poolHash)) {
    return NextResponse.json({ detail: 'A pool hash is required.' }, { status: 400, headers })
  }
  return NextResponse.json(await createCommit(poolHash), { status: 201, headers })
}

export async function OPTIONS(request: NextRequest): Promise<Response> {
  const origin = request.headers.get('origin')
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return new Response(null, { status: 403 })
  return new Response(null, { status: 204, headers: corsHeaders(origin) })
}
