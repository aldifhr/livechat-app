import { useMemo, useState } from 'react'
import { sparkPath } from '../lib/stats'
import { useStats, type StatsRecorder } from '../hooks/useStats'
import { RollingNumber } from './RollingNumber'

/**
 * The session readout.
 *
 * Collapsed by default and given the bottom of the window, because the chat is
 * what the app is for. What earns it a place here is that it survives the feed's
 * cap: the feed drops its oldest rows, these numbers do not, so a stream that has
 * been running for two hours can still be read at a glance.
 */

interface Props {
  stats: StatsRecorder
}

const SPARK_WIDTH = 240
const SPARK_HEIGHT = 34

export function StatsPanel({ stats }: Props) {
  const [open, setOpen] = useState(false)
  const snapshot = useStats(stats)

  const live = snapshot.viewers > 0 || snapshot.totalMessages > 0

  return (
    <div className={`stats-panel${open ? ' stats-open' : ''}`}>
      <div className="stats-bar">
        <button className="stats-toggle" onClick={() => setOpen((value) => !value)}>
          <span className={`log-caret${open ? ' log-caret-open' : ''}`}>▸</span>
          Stats
        </button>

        {/* Read even while collapsed: the whole point of a collapsed panel is that
            the number is visible without opening it. */}
        <span className="stats-glance" title="Watching now">
          <RollingNumber value={snapshot.viewers} />
        </span>
        <span className="stats-glance" title="Chat messages per minute">
          {snapshot.messagesPerMinute.toLocaleString()}/min
        </span>
        {snapshot.diamonds > 0 && (
          <span className="stats-glance stats-diamonds" title="Diamonds sent this session">
            {snapshot.diamonds.toLocaleString()} ◆
          </span>
        )}

        {open && (
          <button className="btn btn-small stats-reset" onClick={() => stats.reset()}>
            Reset
          </button>
        )}
      </div>

      {open && (
        <div className="stats-body">
          {!live ? (
            <p className="stats-empty">Nothing yet. Connect to a room and the numbers fill in.</p>
          ) : (
            <>
              <div className="stat-tiles">
                <Tile label="Watching" value={snapshot.viewers.toLocaleString()} />
                <Tile label="Peak" value={snapshot.peakViewers.toLocaleString()} />
                <Tile
                  label="Per minute"
                  value={snapshot.messagesPerMinute.toLocaleString()}
                  hint={`peak ${snapshot.peakMessagesPerMinute.toLocaleString()}`}
                />
                <Tile label="People" value={snapshot.people.toLocaleString()} />
                <Tile label="Messages" value={snapshot.totalMessages.toLocaleString()} />
                <Tile label="Gifts" value={snapshot.totalGifts.toLocaleString()} />
                {snapshot.diamonds > 0 && (
                  <Tile label="Diamonds" value={snapshot.diamonds.toLocaleString()} gold />
                )}
              </div>

              <Spark
                now={snapshot.viewers}
                peak={snapshot.peakViewers}
                values={snapshot.viewerSeries}
              />

              <div className="stat-board">
                <div className="stat-board-head">
                  <span>Top {snapshot.topChatters.length || ''} chatters</span>
                  <span className="stat-board-sub">
                    by messages · {snapshot.totalFollows.toLocaleString()} follows ·{' '}
                    {snapshot.totalShares.toLocaleString()} shares
                  </span>
                </div>
                {snapshot.topChatters.length === 0 ? (
                  <p className="stats-empty">No one has talked yet.</p>
                ) : (
                  <ol className="chatter-list">
                    {snapshot.topChatters.map((chatter, index) => (
                      <li key={chatter.id} className="chatter">
                        <span className="chatter-rank">{index + 1}</span>
                        {chatter.avatar ? (
                          <img className="chatter-avatar" src={chatter.avatar} alt="" loading="lazy" referrerPolicy="no-referrer" />
                        ) : (
                          <span className="chatter-avatar chatter-fallback" aria-hidden="true">
                            {(chatter.nickname.trim()[0] ?? '?').toUpperCase()}
                          </span>
                        )}
                        <span className="chatter-name">{chatter.nickname || 'Room'}</span>
                        {chatter.diamonds > 0 && (
                          <span className="chatter-diamonds">{chatter.diamonds.toLocaleString()} ◆</span>
                        )}
                        <span className="chatter-count">{chatter.messages.toLocaleString()}</span>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function Tile({
  label,
  value,
  hint,
  gold,
}: {
  label: string
  value: string
  hint?: string
  gold?: boolean
}) {
  return (
    <div className={`stat-tile${gold ? ' stat-tile-gold' : ''}`}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  )
}

/**
 * The room's viewer history.
 *
 * Drawn from the sampled series rather than from raw headcounts: TikTok reports
 * every few seconds, so plotting what arrived would make the chart flicker with
 * the sampling rather than describe the room.
 */
function Spark({ now, peak, values }: { now: number; peak: number; values: number[] }) {
  const path = useMemo(() => sparkPath(values, SPARK_WIDTH, SPARK_HEIGHT), [values])

  return (
    <div className="spark">
      <div className="spark-head">
        <span className="spark-name">Viewers</span>
        <span className="spark-now">{now.toLocaleString()}</span>
      </div>
      {values.length > 1 ? (
        <svg
          className="spark-svg"
          viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`Viewers, now ${now.toLocaleString()}, peak ${peak.toLocaleString()}`}
        >
          <defs>
            <linearGradient id="spark-viewers" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.35" />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={path.area} fill="url(#spark-viewers)" />
          <path d={path.line} fill="none" stroke="var(--accent)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        </svg>
      ) : (
        // One sample is a line with no direction to it; drawing a flat edge
        // across the box would imply a trend that was never measured.
        <div className="spark-empty">collecting…</div>
      )}
    </div>
  )
}