import { NextResponse } from 'next/server'
import { revealCommit } from '@/lib/server/giveawayCommit'
import { ALLOWED_ORIGINS, corsHeaders, originAllowed } from '@/lib/server/giveawayOrigin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Reveal a commitment's seed, so the draw can be computed.
 *
 * Called once, at the first draw, by the dashboard or the desktop app. After this
 * the seed is public (it is published in the report) — which is the point: it was
 * fixed before anyone could see it, and every winner derives from it.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const origin = request.headers.get('origin')
  const headers = corsHeaders(origin)
  if (!originAllowed(request)) {
    return NextResponse.json({ detail: 'This origin cannot reveal a giveaway.' }, { status: 403, headers })
  }
  const { id } = await params
  const revealed = await revealCommit(id)
  if (!revealed) return NextResponse.json({ detail: 'Commitment not found.' }, { status: 404, headers })
  return NextResponse.json(revealed, { headers })
}

export async function OPTIONS(request: Request): Promise<Response> {
  const origin = request.headers.get('origin')
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return new Response(null, { status: 403 })
  return new Response(null, { status: 204, headers: corsHeaders(origin) })
}
