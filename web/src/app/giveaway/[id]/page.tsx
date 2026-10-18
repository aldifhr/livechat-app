import Link from 'next/link'
import { notFound } from 'next/navigation'
import { backendFetch, BackendError } from '@/lib/server/backend'
import { readCommit } from '@/lib/server/giveawayCommit'
import GiveawayVerifier from '@/components/GiveawayVerifier'

export const dynamic = 'force-dynamic'

type Entrant = {
  id: string
  nickname: string
  followed: boolean
  eligible: boolean
  keywordMessages: number
  reason?: string
}

type Draw = { drawnAt: string; pool: string[]; winner: string }
type GiveawayReport = {
  format: string
  streamer: string
  keyword: string
  durationMinutes: number
  prize: string
  winnerCount: number
  testMode: boolean
  startedAt: string | null
  closedAt: string | null
  entrants: Entrant[]
  eligibleCount: number
  draws: Draw[]
  commitHash?: string
  poolHash?: string
  revealSeed?: string
  randomness?: string
  /** The server-side commitment, and when the server fixed the seed. */
  commitId?: string
  committedAt?: string
}
type Snapshot = { id: string; createdAt: string; report: GiveawayReport }

function formatDate(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? '—'
    : `${date.toLocaleString('en-US', { timeZone: 'Asia/Jakarta' })} WIB`
}

export default async function GiveawaySnapshotPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!/^[A-Za-z0-9_-]{16}$/.test(id)) notFound()

  let snapshot: Snapshot
  try {
    snapshot = await backendFetch<Snapshot>(`/api/giveaways/snapshots/${id}`, { forwardToken: false })
  } catch (error) {
    if (error instanceof BackendError && error.status === 404) notFound()
    throw error
  }

  const { report } = snapshot
  if (report.format !== 'livechat-giveaway-audit-v1' || !Array.isArray(report.entrants) || !Array.isArray(report.draws)) notFound()
  const people = new Map(report.entrants.map((entrant) => [entrant.id, entrant]))
  const winners = new Set(report.draws.map((draw) => draw.winner))

  // The commitment lives on this server; the report carries its id. Reading it back
  // is what lets the page show a server timestamp for "committed before the draw",
  // rather than the operator's word for it.
  const commit = report.commitId ? await readCommit(report.commitId) : null
  const committedAt = commit?.committedAt ?? report.committedAt

  // Narrowed once here so the verifier gets the three hashes as strings rather than
  // as three optionals it would have to re-check.
  const verifiable =
    report.commitHash && report.poolHash
      ? {
          entrants: report.entrants,
          draws: report.draws,
          commitHash: report.commitHash,
          poolHash: report.poolHash,
          revealSeed: report.revealSeed,
        }
      : null

  return (
    <main className="mx-auto min-h-screen w-full max-w-4xl px-5 py-10 text-zinc-100 sm:px-8">
      <header className="mb-8 flex flex-wrap items-start justify-between gap-4 border-b border-zinc-800 pb-6">
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-emerald-400">Public giveaway snapshot</p>
          <h1 className="m-0 text-3xl font-bold tracking-tight">{report.prize?.trim() || 'Giveaway results'}</h1>
          <p className="mb-0 mt-2 text-sm text-zinc-400">A read-only report of the frozen entries and each winner draw.</p>
          {report.streamer && <p className="mb-0 mt-2 text-sm text-zinc-300">Stream by <strong>@{report.streamer.replace(/^@/, '')}</strong></p>}
        </div>
        <Link className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-200 transition hover:border-zinc-500" href="/">StreamTools</Link>
      </header>

      {report.testMode && <p className="mb-5 rounded-lg border border-amber-700/70 bg-amber-950/50 px-4 py-3 text-sm font-semibold text-amber-300">TEST RUN — these are fictional participants and not real giveaway results.</p>}

      <section className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ['Entry keyword', report.keyword || '—'],
          ['Eligible', `${report.eligibleCount ?? 0}`],
          ['Winners planned', `${report.winnerCount ?? 1}`],
          ['Prize', report.prize?.trim() || '—'],
        ].map(([label, value]) => <div key={label} className="rounded-xl border border-zinc-800 bg-zinc-900 p-4"><div className="text-[11px] uppercase tracking-wider text-zinc-500">{label}</div><div className="mt-2 break-words text-sm font-semibold">{value}</div></div>)}
      </section>

      <section className="mb-6 rounded-xl border border-zinc-800 bg-zinc-900 p-5">
        <h2 className="mb-4 mt-0 text-base font-semibold">Timeline</h2>
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div><dt className="text-zinc-500">Started</dt><dd className="mb-0 mt-1">{formatDate(report.startedAt)}</dd></div>
          <div><dt className="text-zinc-500">Entries closed</dt><dd className="mb-0 mt-1">{formatDate(report.closedAt)}</dd></div>
          <div><dt className="text-zinc-500">Snapshot published</dt><dd className="mb-0 mt-1">{formatDate(snapshot.createdAt)}</dd></div>
          <div><dt className="text-zinc-500">Entry rule</dt><dd className="mb-0 mt-1">Send a chat containing “{report.keyword}”; follow status must be detected during the session.</dd></div>
        </dl>
      </section>

      <section className="mb-6 rounded-xl border border-zinc-800 bg-zinc-900 p-5">
        <h2 className="mb-4 mt-0 text-base font-semibold">Winner draws ({report.draws.length})</h2>
        {report.draws.length === 0 ? <p className="m-0 text-sm text-zinc-400">No winner draw was recorded in this snapshot.</p> : <ol className="m-0 grid list-none gap-3 p-0 sm:grid-cols-2">
          {report.draws.map((draw, index) => {
            const winner = people.get(draw.winner)
            return <li key={`${draw.drawnAt}-${draw.winner}`} className="rounded-lg border border-emerald-900/80 bg-emerald-950/30 p-4"><div className="text-[11px] font-semibold uppercase tracking-wider text-emerald-400">Winner {index + 1}</div><div className="mt-1 break-all text-lg font-bold">{winner?.nickname || `@${draw.winner}`}</div><div className="mt-1 text-xs text-zinc-400">@{draw.winner} · drawn from {draw.pool.length} remaining eligible entries</div><div className="mt-2 text-[11px] text-zinc-500">{formatDate(draw.drawnAt)}</div></li>
          })}
        </ol>}
      </section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2"><h2 className="m-0 text-base font-semibold">Entry list ({report.entrants.length})</h2><p className="m-0 text-xs text-zinc-500">Repeated keyword messages still count as one entry.</p></div>
        <div className="max-h-[32rem] overflow-auto rounded-lg border border-zinc-800">
          <table className="w-full border-collapse text-left text-sm">
            <thead className="sticky top-0 bg-zinc-950 text-[11px] uppercase tracking-wider text-zinc-500"><tr><th className="px-3 py-2">Participant</th><th className="px-3 py-2">Entry</th><th className="px-3 py-2">Status</th></tr></thead>
            <tbody>{report.entrants.map((entrant) => <tr key={entrant.id} className="border-t border-zinc-800"><td className="px-3 py-2"><div className="font-medium">{entrant.nickname || `@${entrant.id}`}</div><div className="text-xs text-zinc-500">@{entrant.id}</div></td><td className="px-3 py-2 text-zinc-300">{entrant.keywordMessages > 1 ? `${entrant.keywordMessages} messages · 1 entry` : '1 entry'}</td><td className={`px-3 py-2 text-xs font-semibold ${entrant.eligible ? 'text-emerald-400' : 'text-zinc-500'}`}>{winners.has(entrant.id) ? 'Winner' : entrant.eligible ? 'Eligible' : entrant.reason || 'Not eligible'}</td></tr>)}</tbody>
          </table>
        </div>
        <p className="mb-0 mt-4 text-xs leading-relaxed text-zinc-500">Follow eligibility reflects follow events detected during the live session. This public snapshot records the submitted report; it is not a cryptographic proof that the application itself was unmodified.</p>
      </section>

      {(report.commitHash || report.poolHash || report.revealSeed) && (
        <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
          <h2 className="mb-4 mt-0 text-base font-semibold">Provably fair</h2>
          {report.randomness && <p className="mb-4 text-xs text-zinc-500">{report.randomness}</p>}
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            {report.commitHash && (
              <div className="break-all">
                <dt className="text-zinc-500">Commit hash (SHA-256 of seed)</dt>
                <dd className="mb-0 mt-1 font-mono text-xs">{report.commitHash}</dd>
              </div>
            )}
            {report.poolHash && (
              <div className="break-all">
                <dt className="text-zinc-500">Pool hash (SHA-256 of sorted entrants)</dt>
                <dd className="mb-0 mt-1 font-mono text-xs">{report.poolHash}</dd>
              </div>
            )}
            <div className="break-all sm:col-span-2">
              <dt className="text-zinc-500">Revealed seed</dt>
              {report.revealSeed ? (
                <>
                  <dd className="mb-0 mt-1 font-mono text-xs">{report.revealSeed}</dd>
                  <dd className="mb-0 mt-2 text-xs text-zinc-500">Verify: SHA-256(revealed_seed) === commitHash</dd>
                </>
              ) : (
                <dd className="mb-0 mt-1 text-xs text-amber-400">
                  This snapshot does not include the revealed seed, so its draws cannot be independently verified.
                </dd>
              )}
            </div>
          </dl>
        </section>
      )}

      {verifiable && (
        <div className="mt-6">
          <GiveawayVerifier report={verifiable} committedAt={committedAt} />
        </div>
      )}
    </main>
  )
}
