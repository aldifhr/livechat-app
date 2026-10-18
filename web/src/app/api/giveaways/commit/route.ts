import { NextRequest, NextResponse } from 'next/server'
import { createCommit } from '@/lib/server/giveawayCommit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Fix a seed for a frozen pool, before any winner is drawn.
 *
 * Behind the session gate (everything under `/api/` is), so only the signed-in
 * operator can commit — a commitment is a claim about a giveaway they are running.
 * The seed never comes back here; `GET`/`POST` on the commitment's own address
 * reveals it after the draw.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ detail: 'Expected a JSON body.' }, { status: 400 })
  }
  const poolHash = (body as { poolHash?: unknown } | null)?.poolHash
  if (typeof poolHash !== 'string' || !/^[0-9a-f]{64}$/.test(poolHash)) {
    return NextResponse.json({ detail: 'A pool hash is required.' }, { status: 400 })
  }
  return NextResponse.json(await createCommit(poolHash), { status: 201 })
}
