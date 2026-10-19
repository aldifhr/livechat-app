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
 */
const STYLES = {
  gift: { bg: '#2a1a08', border: '#854d0e', name: '#fcd34d' },
  like: { bg: '#27272a', border: '#3f3f46', name: '#ffffff' },
  follow: { bg: '#2a101b', border: '#9d174d', name: '#f472b6' },
  subscription: { bg: '#0b2340', border: '#1d4ed8', name: '#93c5fd' },
  notice: { bg: '#27272a', border: '#3f3f46', name: '#a1a1aa' },
  poll: { bg: '#1a2a1a', border: '#3f6212', name: '#bef264' },
  intro: { bg: '#1a1a2a', border: '#4338ca', name: '#c7d2fe' },
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
      style={{ backgroundColor: style.bg, borderColor: style.border }}
      className="w-fit max-w-[calc(100%-2rem)] min-w-0 rounded-[4px_14px_14px_14px] border px-3 py-1.5 text-xs shadow-sm"
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
              className="shrink-0 font-semibold hover:underline"
              title={`Buka @${user} di TikTok`}
            >
              {user}
            </a>
          ) : (
            <span style={{ color: style.name }} className="shrink-0 font-semibold">
              {user}
            </span>
          )}
          <span style={{ color: '#71717a' }} className="shrink-0 text-[10px] font-normal tabular-nums">
            {time}
          </span>
        </div>
      )}
      {!user && (
        <span style={{ color: '#71717a' }} className="text-[10px] font-normal tabular-nums">
          {time}
        </span>
      )}
      {type === 'like' && (
        <p style={{ color: '#a1a1aa' }} className="mt-0.5 m-0 leading-snug">
          ❤️ liked the stream
        </p>
      )}
      {type === 'follow' && (
        <p style={{ color: '#f472b6' }} className="mt-0.5 m-0 font-medium leading-snug">
          💖 followed
        </p>
      )}
      {type === 'gift' && (
        <p style={{ color: '#fcd34d' }} className="mt-0.5 m-0 font-medium leading-snug">
          🎁 sent {giftName}
        </p>
      )}
      {type === 'subscription' && (
        <p style={{ color: '#93c5fd' }} className="mt-0.5 m-0 font-medium leading-snug">
          ⭐ subscribed{(months ?? 0) > 1 ? ` · month ${months}` : ''}
        </p>
      )}
      {type === 'notice' && text && (
        <p style={{ color: '#d4d4d8' }} className="mt-0.5 m-0 leading-snug">
          📢 {text}
        </p>
      )}
      {type === 'poll' && text && (
        <div className="mt-0.5">
          <p style={{ color: '#bef264' }} className="m-0 font-medium leading-snug">
            📊 {text}
          </p>
          {options && options.length > 0 && (
            <ul style={{ color: '#a3a3a3' }} className="mt-1 mb-0 list-disc space-y-0.5 pl-4">
              {options.map((option, index) => (
                <li key={`${option}-${index}`}>{option}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {type === 'intro' && text && (
        <p style={{ color: '#c7d2fe' }} className="mt-0.5 m-0 leading-snug">
          🔴 went live · {text}
        </p>
      )}
    </div>
  )
}
