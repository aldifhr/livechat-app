import { NextResponse } from 'next/server'
import { revealCommit } from '@/lib/server/giveawayCommit'
import { originAllowed } from '@/lib/server/giveawayOrigin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Reveal a commitment's seed, so the draw can be computed.
 *
 * Called once, at the first draw, by the dashboard's own giveaway page. After
 * this the seed is public (it is published in the report) — which is the point:
 * it was fixed before anyone could see it, and every winner derives from it.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  if (!originAllowed(request)) {
    return NextResponse.json({ detail: 'This origin cannot reveal a giveaway.' }, { status: 403 })
  }
  const { id } = await params
  const revealed = await revealCommit(id)
  if (!revealed) return NextResponse.json({ detail: 'Commitment not found.' }, { status: 404 })
  return NextResponse.json(revealed)
}
