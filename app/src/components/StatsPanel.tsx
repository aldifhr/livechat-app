import { useMemo } from 'react'
import Chart from 'react-apexcharts'
import type { ApexOptions } from 'apexcharts'
import { useStats, type StatsRecorder } from '../hooks/useStats'
import { RollingNumber } from './RollingNumber'
import { AvatarCircles } from './ui/avatar-circles'
import { tiktokProfileUrl } from '../lib/platforms'

/**
 * The session readout.
 *
 * Rendered as a full page selected from the Dock. The stats survive the feed's
 * cap: the feed drops its oldest rows, so a long session can still be read here.
 */

interface Props {
  stats: StatsRecorder
}

export function StatsPanel({ stats }: Props) {
  const snapshot = useStats(stats)

  const live = snapshot.viewers > 0 || snapshot.totalMessages > 0
  const chatterAvatars = snapshot.topChatters
    .map((chatter) => ({
      imageUrl: chatter.avatar,
      profileUrl: tiktokProfileUrl(chatter.id),
      label: chatter.nickname,
    }))
    .filter((chatter) => chatter.imageUrl && chatter.profileUrl)
  const visibleAvatars = chatterAvatars.slice(0, 5)

  return (
    <div className="stats-panel">
      <div className="stats-bar">
        <span className="stats-glance" title="Watching now">
          <RollingNumber value={snapshot.viewers} />
        </span>
        <span className="stats-glance" title="Chat messages per minute">
          {snapshot.messagesPerMinute.toLocaleString()}/min
        </span>
        {visibleAvatars.length > 0 && (
          <AvatarCircles
            avatarUrls={visibleAvatars}
            numPeople={Math.max(0, snapshot.topChatters.length - visibleAvatars.length)}
          />
        )}
        {snapshot.diamonds > 0 && (
          <span className="stats-glance stats-diamonds" title="Diamonds sent this session">
            {snapshot.diamonds.toLocaleString()} ◆
          </span>
        )}

        <button className="btn btn-small stats-reset" onClick={() => stats.reset()}>
          Reset
        </button>
      </div>

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
  const series = useMemo(() => [{ name: 'Viewers', data: values }], [values])
  const categories = useMemo(() => {
    const step = Math.max(1, Math.ceil((values.length - 1) / 5))
    return values.map((_, index) => {
      if (index === values.length - 1) return 'Now'
      if (index % step !== 0) return ''
      const secondsAgo = (values.length - 1 - index) * 5
      return secondsAgo >= 60 ? `-${Math.round(secondsAgo / 60)}m` : `-${secondsAgo}s`
    })
  }, [values])
  const options = useMemo<ApexOptions>(() => ({
    chart: {
      type: 'line',
      height: 230,
      background: 'transparent',
      sparkline: { enabled: false },
      toolbar: {
        show: true,
        tools: {
          download: false,
          selection: false,
          zoom: false,
          zoomin: false,
          zoomout: false,
          pan: false,
          reset: false,
        },
      },
      zoom: { enabled: false },
      parentHeightOffset: 0,
      foreColor: '#626b75',
      animations: {
        enabled: true,
        easing: 'easeinout',
        speed: 450,
        animateGradually: { enabled: false },
        dynamicAnimation: { enabled: true, speed: 350 },
      },
    },
    theme: { mode: 'light' },
    colors: ['#111111'],
    dataLabels: { enabled: false },
    stroke: { curve: 'straight', width: 3, lineCap: 'round', colors: ['#111111'] },
    grid: {
      borderColor: '#e4e8ed',
      strokeDashArray: 0,
      padding: { left: 8, right: 12, top: 0, bottom: 0 },
    },
    xaxis: {
      categories,
      tickAmount: 5,
      labels: {
        show: true,
        rotate: 0,
        hideOverlappingLabels: true,
        style: { colors: '#626b75', fontSize: '10px' },
      },
      axisBorder: { show: false },
      axisTicks: { show: false },
      tooltip: { enabled: false },
    },
    yaxis: {
      min: 0,
      max: Math.max(peak, 1) * 1.15,
      tickAmount: 3,
      labels: {
        formatter: (value) => Math.round(value).toLocaleString(),
        style: { colors: '#626b75', fontSize: '10px' },
      },
    },
    // A fresh session starts with a single real sample. Keep its point visible
    // until the next sample gives ApexCharts two points to connect as a line.
    markers: { size: 0, hover: { size: 4, sizeOffset: 2 }, strokeWidth: 2 },
    tooltip: {
      theme: 'light',
      x: { show: false },
      y: { formatter: (value) => `${value.toLocaleString()} viewers` },
      marker: { show: true },
    },
    noData: { text: 'Waiting for viewer data' },
  }), [categories, peak, values])

  return (
    <div className="spark">
      <div className="spark-head">
        <div>
          <span className="spark-name">Audience trend</span>
          <span className="spark-subtitle">Live viewers over this session</span>
        </div>
        <div className="spark-current">
          <span className="spark-live-dot" />
          <span className="spark-now">{now.toLocaleString()}</span>
          <span className="spark-current-label">viewers</span>
        </div>
      </div>
      <Chart options={options} series={series} type="line" height={230} />
    </div>
  )
}
