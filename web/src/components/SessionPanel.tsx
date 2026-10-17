/**
 * What one stream has accumulated this session.
 *
 * The backend counted all of this before anybody could see it — `eventlog` kept
 * peaks, diamonds, leaderboards and repeat arrivals from the first commit — and
 * the counter was the reason the numbers could not be invented in the browser
 * where a second definition of "peak viewers" would have started. The session
 * endpoint is the backend's own answer, read out rather than recomputed, so this
 * panel can only ever disagree with the overlay about a stream if the two were
 * asked at different moments.
 *
 * Read together with the status rather than beside it. A badge and these numbers
 * fetched separately can describe two different moments, which is a number that is
 * wrong and no way to tell it is.
 */

import type { RoomSession } from '@/lib/types'

/** Seconds as something readable, or an em dash when there is no session. */
function duration(seconds: number | null): string {
  if (!seconds) return '—'
  const whole = Math.floor(seconds)
  if (whole < 60) return `${whole}s`
  const minutes = Math.floor(whole / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

/** Only the leaders that exist. An empty list renders nothing rather than a heading
 *  over a gap. */
function Leaders({
  label,
  people,
  unit,
}: {
  label: string
  people: RoomSession['topGifters']
  unit: string
}) {
  const top = people.slice(0, 3)
  if (top.length === 0) return null
  return (
    <p className="session-leaders">
      <span className="faint">{label}:</span>{' '}
      {top.map((person, index) => (
        <span key={person.id}>
          {index > 0 && ', '}
          <strong>{person.nickname}</strong>{' '}
          <span className="faint">
            {(person.diamonds ?? 0).toLocaleString()} {unit}
          </span>
        </span>
      ))}
    </p>
  )
}

export default function SessionPanel({ session }: { session: RoomSession }) {
  const events = Object.values(session.totals).reduce((sum, n) => sum + n, 0)
  const idle = !session.connected && events === 0 && session.total_diamonds === 0
  if (idle) return null

  return (
    <div className="session">
      <p className="copy-label">This session</p>
      <dl className="session-grid">
        <Stat label="Live for" value={duration(session.live_seconds)} />
        <Stat
          label="Peak viewers"
          value={session.peak_viewers ? session.peak_viewers.toLocaleString() : '—'}
        />
        <Stat
          label="Diamonds"
          value={session.total_diamonds ? session.total_diamonds.toLocaleString() : '—'}
        />
        <Stat label="Events" value={events ? events.toLocaleString() : '—'} />
      </dl>
      <Leaders label="Top gifters" people={session.topGifters} unit="diamonds" />
    </div>
  )
}
