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

  // Anything counted is something to show. Keying only on viewers and messages
  // meant a session that had received a gift, a follow and three shares still
  // read "Nothing yet" until somebody spoke — the panel denying events it had
  // already recorded. `people` is in the list for the same reason: a follower who
  // never chats is still somebody who was here.
  const live =
    snapshot.viewers > 0 ||
    snapshot.totalMessages > 0 ||
    snapshot.totalGifts > 0 ||
    snapshot.totalFollows > 0 ||
    snapshot.totalShares > 0 ||
    snapshot.diamonds > 0 ||
    snapshot.people > 0
  const chatterAvatars = snapshot.topChatters
    .map((chatter) => ({
      imageUrl: chatter.avatar,
      profileUrl: tiktokProfileUrl(chatter.id),
      label: chatter.nickname,
    }))
    .filter((chatter) => chatter.imageUrl && chatter.profileUrl)
  const visibleAvatars = chatterAvatars.slice(0, 5)

  return (
    <div className="stats-panel [flex:0_0_auto] [background:var(--panel)] [border-top:1px_solid_var(--line)]">
      <div className="stats-bar [display:flex] [align-items:center] [gap:10px] [padding:7px_20px]">
        <span className="stats-glance [padding:0_8px] [border-radius:999px] [background:var(--panel-2)] [color:var(--text)] [font-size:11px] [font-variant-numeric:tabular-nums]" title="Watching now">
          <RollingNumber value={snapshot.viewers} />
        </span>
        <span className="stats-glance [padding:0_8px] [border-radius:999px] [background:var(--panel-2)] [color:var(--text)] [font-size:11px] [font-variant-numeric:tabular-nums]" title="Chat messages per minute">
          {snapshot.messagesPerMinute.toLocaleString()}/min
        </span>
        {visibleAvatars.length > 0 && (
          <AvatarCircles
            avatarUrls={visibleAvatars}
            numPeople={Math.max(0, snapshot.topChatters.length - visibleAvatars.length)}
          />
        )}
        {snapshot.diamonds > 0 && (
          <span className="stats-glance stats-diamonds [padding:0_8px] [border-radius:999px] [background:var(--panel-2)] [color:var(--text)] [font-size:11px] [font-variant-numeric:tabular-nums] [color:var(--gold)]" title="Diamonds sent this session">
            {snapshot.diamonds.toLocaleString()} ◆
          </span>
        )}

        <button className="btn btn-small stats-reset [padding:9px_14px] [background:var(--panel-2)] [border:1px_solid_var(--line)] [border-radius:var(--radius)] [color:var(--text)] [font:inherit] [cursor:pointer] [white-space:nowrap] [&:hover:not(:disabled)]:[border-color:var(--muted)] [&:disabled]:[opacity:0.45] [&:disabled]:[cursor:not-allowed] [padding:4px_10px] [font-size:12px] [margin-left:auto]" onClick={() => stats.reset()}>
          Reset
        </button>
      </div>

      <div className="stats-body [display:flex] [flex-direction:column] [gap:14px] [padding:16px_20px_18px] [border-top:1px_solid_var(--line)]">
          {!live ? (
            <p className="stats-empty [margin:4px_0] [color:var(--muted)] [font-size:12px]">Nothing yet. Connect to a room and the numbers fill in.</p>
          ) : (
            <>
              <div className="stat-tiles [display:grid] [grid-template-columns:repeat(auto-fit,_minmax(112px,_1fr))] [gap:10px]">
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
    <div className={`stat-tile [position:relative] [overflow:hidden] [min-height:78px] [padding:12px_14px] [background:linear-gradient(145deg,_color-mix(in_srgb,_var(--panel-2)_92%,_white_8%),_var(--panel-2))] [border:1px_solid_var(--line)] [border-radius:12px] [box-shadow:inset_0_1px_rgba(255,_255,_255,_0.025)] [&::before]:[position:absolute] [&::before]:[top:0] [&::before]:[left:14px] [&::before]:[width:26px] [&::before]:[height:2px] [&::before]:[border-radius:0_0_3px_3px] [&::before]:[background:var(--accent)] [&::before]:[opacity:0.65] [&::before]:[content:'']${gold ? ' stat-tile-gold' : ''}`}>
      <div className="stat-value [font-size:22px] [font-weight:700] [font-variant-numeric:tabular-nums] [line-height:1.2]">{value}</div>
      <div className="stat-label [color:var(--muted)] [font-size:11px] [text-transform:uppercase] [letter-spacing:0.05em]">{label}</div>
      {hint && <div className="stat-hint [color:var(--muted)] [font-size:11px] [font-variant-numeric:tabular-nums]">{hint}</div>}
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
      y: { formatter: (value) => `${(value ?? 0).toLocaleString()} viewers` },
      marker: { show: true },
    },
    noData: { text: 'Waiting for viewer data' },
  }), [categories, peak, values])

  return (
    <div className="spark [min-width:0] [padding:14px_14px_8px] [color:#202832] [background:#fff] [border:1px_solid_#e2e7ec] [border-radius:14px] [overflow:hidden] [&_.apexcharts-canvas]:[max-width:100%] [&_.apexcharts-svg]:[max-width:100%] [&_.apexcharts-line]:[stroke:#111] [&_.apexcharts-line]:[stroke-width:3px]">
      <div className="spark-head [display:flex] [align-items:flex-start] [justify-content:space-between] [gap:12px] [margin-bottom:2px]">
        <div>
          <span className="spark-name [display:block] [color:#202832] [font-size:13px] [font-weight:650] [letter-spacing:0.01em]">Audience trend</span>
          <span className="spark-subtitle [display:block] [margin-top:2px] [color:#66717d] [font-size:10px]">Live viewers over this session</span>
        </div>
        <div className="spark-current [display:flex] [align-items:center] [gap:6px] [padding:4px_9px] [border:1px_solid_#dedede] [border-radius:999px] [background:#f5f5f5]">
          <span className="spark-live-dot [width:6px] [height:6px] [border-radius:50%] [background:#111] [box-shadow:0_0_9px_rgb(0_0_0_/_24%)]" />
          <span className="spark-now [font-size:16px] [font-weight:600] [font-variant-numeric:tabular-nums] [color:#202832]">{now.toLocaleString()}</span>
          <span className="spark-current-label [color:#66717d] [font-size:10px]">viewers</span>
        </div>
      </div>
      <Chart options={options} series={series} type="line" height={230} />
    </div>
  )
}
