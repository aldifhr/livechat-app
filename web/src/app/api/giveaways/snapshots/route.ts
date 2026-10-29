import { backendFetch, BackendError } from '@/lib/server/backend'
import { originAllowed } from '@/lib/server/giveawayOrigin'

const MAX_BYTES = 2 * 1024 * 1024
const RATE_WINDOW_MS = 60 * 60 * 1000
const RATE_LIMIT = 4
const requests = new Map<string, number[]>()

function clientKey(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  return request.headers.get('x-real-ip')?.trim() || forwarded || 'unknown'
}

/**
 * The dashboard's own origin publishing a snapshot.
 *
 * Same-origin only, and the check is the host the request arrived on rather than
 * the header alone — a same-origin POST carries its own `Origin`, so comparing
 * the two is what makes it a check rather than a passthrough.
 */
function allowedByRate(request: Request): boolean {
  const now = Date.now()
  const key = clientKey(request)
  const recent = (requests.get(key) ?? []).filter((time) => now - time < RATE_WINDOW_MS)
  if (recent.length >= RATE_LIMIT) {
    requests.set(key, recent)
    return false
  }
  recent.push(now)
  requests.set(key, recent)
  if (requests.size > 5000) {
    for (const [entry, times] of requests) {
      if (times.every((time) => now - time >= RATE_WINDOW_MS)) requests.delete(entry)
      if (requests.size <= 4000) break
    }
  }
  return true
}

async function boundedBody(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > MAX_BYTES) throw new RangeError('Report exceeds the 2 MB limit.')
  if (!request.body) throw new SyntaxError('A report body is required.')

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_BYTES) {
      await reader.cancel()
      throw new RangeError('Report exceeds the 2 MB limit.')
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown
}

export async function POST(request: Request): Promise<Response> {
  if (!originAllowed(request)) {
    return Response.json({ detail: 'This app origin cannot publish giveaway reports.' }, { status: 403 })
  }
  if (!allowedByRate(request)) {
    return Response.json({ detail: 'Too many reports from this connection. Try again later.' }, { status: 429 })
  }
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    return Response.json({ detail: 'Send the report as application/json.' }, { status: 415 })
  }

  try {
    const payload = await boundedBody(request)
    if (!payload || typeof payload !== 'object' || !('report' in payload)) {
      return Response.json({ detail: 'The giveaway report is invalid.' }, { status: 400 })
    }
    const report = (payload as { report: unknown }).report
    if (!report || typeof report !== 'object' || Array.isArray(report)) {
      return Response.json({ detail: 'The giveaway report is invalid.' }, { status: 400 })
    }
    const value = report as Record<string, unknown>
    if (
      value.format !== 'livechat-giveaway-audit-v1' || typeof value.testMode !== 'boolean' ||
      typeof value.keyword !== 'string' || value.keyword.length > 32 ||
      typeof value.streamer !== 'string' || value.streamer.length > 128 ||
      typeof value.prize !== 'string' || value.prize.length > 80 ||
      !Number.isInteger(value.durationMinutes) || Number(value.durationMinutes) < 1 || Number(value.durationMinutes) > 30 ||
      !Number.isInteger(value.winnerCount) || Number(value.winnerCount) < 1 || Number(value.winnerCount) > 100 ||
      !Array.isArray(value.entrants) || value.entrants.length > 20_000 ||
      !Array.isArray(value.draws) || value.draws.length < 1 || value.draws.length > 100
    ) {
      return Response.json({ detail: 'Only completed giveaway reports can be published.' }, { status: 400 })
    }
    const validEntrants = value.entrants.every((entrant) => {
      if (!entrant || typeof entrant !== 'object' || Array.isArray(entrant)) return false
      const person = entrant as Record<string, unknown>
      return typeof person.id === 'string' && person.id.length <= 128 &&
        typeof person.nickname === 'string' && person.nickname.length <= 200 &&
        typeof person.followed === 'boolean' && typeof person.eligible === 'boolean' &&
        Number.isInteger(person.keywordMessages) && Number(person.keywordMessages) >= 1 &&
        (person.reason === undefined || (typeof person.reason === 'string' && person.reason.length <= 100))
    })
    const validDraws = value.draws.every((draw) => {
      if (!draw || typeof draw !== 'object' || Array.isArray(draw)) return false
      const item = draw as Record<string, unknown>
      return typeof item.winner === 'string' && Array.isArray(item.pool) && item.pool.length <= 20_000 &&
        item.pool.every((id) => typeof id === 'string' && id.length <= 128) && typeof item.drawnAt === 'string'
    })
    if (!validEntrants || !validDraws) return Response.json({ detail: 'The entrant or draw data is invalid.' }, { status: 400 })

    const saved = await backendFetch<{ id: string; createdAt: string }>('/api/giveaways/snapshots', {
      method: 'POST',
      body: JSON.stringify({ report: value }),
    })
    return Response.json({ id: saved.id, createdAt: saved.createdAt }, { status: 201 })
  } catch (cause) {
    if (cause instanceof RangeError) {
      return Response.json({ detail: cause.message }, { status: 413 })
    }
    if (cause instanceof SyntaxError) {
      return Response.json({ detail: 'The report JSON is invalid.' }, { status: 400 })
    }
    const status = cause instanceof BackendError ? cause.status : 502
    return Response.json({ detail: cause instanceof Error ? cause.message : 'The report could not be published.' }, { status })
  }
}
