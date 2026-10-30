'use client'

import { useEffect, useState } from 'react'
import { sha256, deriveWinnerFromSeed } from '@/lib/giveaway'

/** The parts of a report this checker reads. */
type VerifiableReport = {
  entrants: { id: string; eligible: boolean }[]
  draws: { winner: string; pool: string[]; drawnAt: string }[]
  commitHash: string
  poolHash: string
  revealSeed?: string
}

/** `null` means the check could not run — the report does not carry what it needs. */
type Check = { label: string; ok: boolean | null; detail?: string }

/**
 * Recomputes a giveaway report in the reader's own browser.
 *
 * This is the whole point of the published hashes: not to be displayed, but to be
 * checked. Every winner is `SHA-256(seed + '|' + sorted(pool))` folded into an
 * index, so anyone with the report can reproduce it — and the commitment's
 * `committedAt` timestamp, if present, is what distinguishes "the seed fixes the
 * result" from "the seed was fixed before the result".
 *
 * A report that omits the revealed seed (an older snapshot, or a run before the
 * seed was published) still gets its pool checks here; the seed-dependent checks
 * say so rather than passing quietly.
 */
export default function GiveawayVerifier({ report, committedAt }: { report: VerifiableReport; committedAt?: string }) {
  const [checks, setChecks] = useState<Check[] | null>(null)

  useEffect(() => {
    let cancelled = false

    async function run() {
      const out: Check[] = []
      const seed = report.revealSeed
      const eligible = report.entrants.filter((entrant) => entrant.eligible).map((entrant) => entrant.id)

      out.push(
        seed
          ? { label: 'The revealed seed matches its committed hash', ok: (await sha256(seed)) === report.commitHash }
          : { label: 'The revealed seed matches its committed hash', ok: null, detail: 'no revealed seed in this report' },
      )

      out.push({
        label: 'The eligible list matches the committed pool hash',
        ok: (await sha256([...eligible].sort().join('|'))) === report.poolHash,
        detail: `${eligible.length} eligible`,
      })

      if (report.draws[0]) {
        const first = report.draws[0].pool
        out.push({
          label: 'The first draw pool is the eligible list',
          ok: first.length === eligible.length && eligible.every((id) => first.includes(id)),
        })
      }

      if (committedAt && report.draws[0]) {
        out.push({
          label: 'The seed was committed before the first draw',
          ok: new Date(committedAt).getTime() <= new Date(report.draws[0].drawnAt).getTime(),
          detail: `committed ${new Date(committedAt).toLocaleString('en-US', { timeZone: 'Asia/Jakarta' })} WIB`,
        })
      }

      let previous: { pool: string[]; winner: string } | null = null
      for (let index = 0; index < report.draws.length; index++) {
        const draw = report.draws[index]
        const derived = seed ? await deriveWinnerFromSeed(seed, draw.pool) : null
        out.push(
          seed
            ? { label: `Winner ${index + 1} follows from the seed and the pool`, ok: derived === draw.winner, detail: `${draw.winner} from ${draw.pool.length}` }
            : { label: `Winner ${index + 1} follows from the seed and the pool`, ok: null, detail: 'no revealed seed in this report' },
        )
        const prior = previous
        if (prior) {
          const expected = prior.pool.filter((id) => id !== prior.winner)
          out.push({
            label: `Pool ${index + 1} is pool ${index} minus winner ${index}`,
            ok: expected.length === draw.pool.length && expected.every((id) => draw.pool.includes(id)),
          })
        }
        previous = { pool: draw.pool, winner: draw.winner }
      }

      if (!cancelled) setChecks(out)
    }

    void run()
    return () => {
      cancelled = true
    }
  }, [report, committedAt])

  const failed = checks?.filter((check) => check.ok === false).length ?? 0
  const skipped = checks?.filter((check) => check.ok === null).length ?? 0
  const summary =
    failed > 0
      ? { text: `${failed} check${failed === 1 ? '' : 's'} failed — this report does not reproduce.`, tone: 'text-bad' }
      : skipped > 0
        ? { text: `Checked what this report allows; ${skipped} check${skipped === 1 ? '' : 's'} need the revealed seed, which it does not include.`, tone: 'text-[#fbbf24]' }
        : { text: 'All checks passed.', tone: 'text-accent' }

  return (
    <section className="rounded-card border border-line-soft bg-raised p-5">
      <h2 className="mt-0 mb-2 text-base font-semibold">Verify it yourself</h2>
      <p className="mt-0 mb-4 text-xs leading-relaxed text-dim">
        These checks run in your browser, not on the server. A winner is <code className="text-text">SHA-256(seed + &quot;|&quot; + sorted_pool)</code> folded into an index, so the report alone is enough to reproduce every draw.
      </p>
      {checks === null ? (
        <p className="m-0 text-sm text-dim">Checking…</p>
      ) : (
        <>
          <ul className="m-0 grid list-none gap-2 p-0 text-sm">
            {checks.map((check, index) => (
              <li key={index} className="flex items-start gap-2">
                <span className={check.ok === true ? 'text-accent' : check.ok === false ? 'text-bad' : 'text-faint'} aria-hidden="true">
                  {check.ok === true ? '✓' : check.ok === false ? '✗' : '–'}
                </span>
                <span className="text-text">
                  {check.label}
                  {check.detail && <span className="text-faint"> — {check.detail}</span>}
                </span>
              </li>
            ))}
          </ul>
          <p className={`mt-4 mb-0 text-sm font-semibold ${summary.tone}`} role="status">
            {summary.text}
          </p>
        </>
      )}
    </section>
  )
}
