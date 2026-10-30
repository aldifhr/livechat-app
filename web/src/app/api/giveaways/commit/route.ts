import { NextRequest, NextResponse } from 'next/server'
import { createCommit } from '@/lib/server/giveawayCommit'
import { originAllowed } from '@/lib/server/giveawayOrigin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Fix a seed for a frozen pool, before any winner is drawn.
 *
 * Same-origin only: the only caller is the dashboard's own giveaway page. The
 * seed never comes back — only its hash and the moment it was fixed. The seed is
 * revealed at `/commit/{id}`.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!originAllowed(request)) {
    return NextResponse.json({ detail: 'This origin cannot commit a giveaway.' }, { status: 403 })
  }

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
