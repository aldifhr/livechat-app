export interface BubbleEventProps {
  type: 'gift' | 'like' | 'follow' | 'subscription' | 'notice' | 'poll' | 'intro'
  user: string
  time: string
  giftName?: string
  profileUrl?: string
  /** Total months subscribed, on a `subscription` row. */
  months?: number
  /** The notice text, the poll question or the stream title. */
  text?: string
  /** Poll options, on a `poll` row. */
  options?: string[]
}

/**
 * The styles per kind. One table rather than a chain of ternaries: the kinds have
 * nothing in common beyond being a coloured bubble, and a ternary per field is
 * how the colours drifted the last time one was added.
 *
 * Each kind is a light card with a solid black border — the dock is drawn over
 * video and the bubble has to hold its contrast against anything — and the kind
 * is carried by the name colour and a tinted left edge, not by a dark fill.
 */
const STYLES = {
  gift: { name: '#b45309', edge: '#f5b942' },
  like: { name: '#e5484d', edge: '#e5484d' },
  follow: { name: '#be185d', edge: '#f472b6' },
  subscription: { name: '#1d4ed8', edge: '#60a5fa' },
  notice: { name: '#13102b', edge: '#8b83a6' },
  poll: { name: '#15803d', edge: '#4ade80' },
  intro: { name: '#4338ca', edge: '#818cf8' },
} as const

export function BubbleEvent({
  type,
  user,
  time,
  giftName,
  profileUrl,
  months,
  text,
  options,
}: BubbleEventProps) {
  const style = STYLES[type]

  return (
    <div
      style={{ borderLeftColor: style.edge, borderLeftWidth: 6 }}
      className="w-fit max-w-[calc(100%-2rem)] min-w-0 rounded-[4px_14px_14px_14px] border-2 border-line bg-raised px-3 py-1.5 text-xs text-text"
    >
      {/* A notice and a poll have no viewer behind them — the backend sends a
          name only when the event came from a person. The name block is skipped
          rather than rendered empty, which would leave a stray gap. */}
      {user && (
        <div className="flex items-center gap-1.5">
          {profileUrl ? (
            <a
              href={profileUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: style.name }}
              className="shrink-0 font-extrabold hover:underline"
              title={`Buka @${user} di TikTok`}
            >
              {user}
            </a>
          ) : (
            <span style={{ color: style.name }} className="shrink-0 font-extrabold">
              {user}
            </span>
          )}
          <span className="shrink-0 text-[10px] font-normal text-faint tabular-nums">{time}</span>
        </div>
      )}
      {!user && (
        <span className="text-[10px] font-normal text-faint tabular-nums">{time}</span>
      )}
      {type === 'like' && (
        <p className="m-0 mt-0.5 leading-snug text-dim">❤️ liked the stream</p>
      )}
      {type === 'follow' && (
        <p style={{ color: style.name }} className="m-0 mt-0.5 leading-snug font-bold">
          💖 followed
        </p>
      )}
      {type === 'gift' && (
        <p style={{ color: style.name }} className="m-0 mt-0.5 leading-snug font-bold">
          🎁 sent {giftName}
        </p>
      )}
      {type === 'subscription' && (
        <p style={{ color: style.name }} className="m-0 mt-0.5 leading-snug font-bold">
          ⭐ subscribed{(months ?? 0) > 1 ? ` · month ${months}` : ''}
        </p>
      )}
      {type === 'notice' && text && (
        <p className="m-0 mt-0.5 leading-snug text-dim">📢 {text}</p>
      )}
      {type === 'poll' && text && (
        <div className="mt-0.5">
          <p style={{ color: style.name }} className="m-0 leading-snug font-bold">
            📊 {text}
          </p>
          {options && options.length > 0 && (
            <ul className="mt-1 mb-0 list-disc space-y-0.5 pl-4 text-dim">
              {options.map((option, index) => (
                <li key={`${option}-${index}`}>{option}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {type === 'intro' && text && (
        <p style={{ color: style.name }} className="m-0 mt-0.5 leading-snug font-bold">
          🔴 went live · {text}
        </p>
      )}
    </div>
  )
}
