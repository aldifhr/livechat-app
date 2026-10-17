export interface BubbleJoinedProps {
  user: string
  time: string
  profileUrl?: string
}

export function BubbleJoined({ user, time, profileUrl }: BubbleJoinedProps) {
  return (
    <div
      style={{ backgroundColor: '#27272a', borderColor: '#3f3f46' }}
      className="w-fit max-w-[calc(100%-2rem)] min-w-0 rounded-[4px_14px_14px_14px] border px-3 py-1.5 text-xs shadow-sm"
    >
      <div className="flex items-center gap-1.5">
        {profileUrl ? (
          <a
            href={profileUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: '#ffffff' }}
            className="shrink-0 font-semibold hover:underline"
            title={`Buka @${user} di TikTok`}
          >
            {user}
          </a>
        ) : (
          <span style={{ color: '#ffffff' }} className="shrink-0 font-semibold">
            {user}
          </span>
        )}
        <span style={{ color: '#71717a' }} className="shrink-0 text-[10px] font-normal tabular-nums">
          {time}
        </span>
      </div>
      <p style={{ color: '#a1a1aa' }} className="mt-0.5 m-0 leading-snug">
        👋 joined to stream
      </p>
    </div>
  )
}
