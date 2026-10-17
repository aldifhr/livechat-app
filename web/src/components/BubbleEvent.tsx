export interface BubbleEventProps {
  type: 'gift' | 'like' | 'follow'
  user: string
  time: string
  giftName?: string
  profileUrl?: string
}

export function BubbleEvent({
  type,
  user,
  time,
  giftName,
  profileUrl,
}: BubbleEventProps) {
  const isGift = type === 'gift'
  const isFollow = type === 'follow'

  return (
    <div
      style={{
        backgroundColor: isGift ? '#2a1a08' : isFollow ? '#2a101b' : '#27272a',
        borderColor: isGift ? '#854d0e' : isFollow ? '#9d174d' : '#3f3f46',
      }}
      className="w-fit max-w-[calc(100%-2rem)] min-w-0 rounded-[4px_14px_14px_14px] border px-3 py-1.5 text-xs shadow-sm"
    >
      <div className="flex items-center gap-1.5">
        {profileUrl ? (
          <a
            href={profileUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: isGift ? '#fcd34d' : isFollow ? '#f472b6' : '#ffffff' }}
            className="shrink-0 font-semibold hover:underline"
            title={`Buka @${user} di TikTok`}
          >
            {user}
          </a>
        ) : (
          <span
            style={{ color: isGift ? '#fcd34d' : isFollow ? '#f472b6' : '#ffffff' }}
            className="shrink-0 font-semibold"
          >
            {user}
          </span>
        )}
        <span style={{ color: '#71717a' }} className="shrink-0 text-[10px] font-normal tabular-nums">
          {time}
        </span>
      </div>
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
    </div>
  )
}
