export interface BubbleChatProps {
  user: string
  text?: string
  time: string
  profileUrl?: string
}

export function BubbleChat({ user, text, time, profileUrl }: BubbleChatProps) {
  return (
    <div
      style={{ backgroundColor: '#ffffff', borderColor: '#e4e4e7' }}
      className="w-fit max-w-[calc(100%-2rem)] min-w-0 rounded-[4px_14px_14px_14px] border px-3 py-1.5 text-xs shadow-sm"
    >
      <div className="flex items-center gap-1.5">
        {profileUrl ? (
          <a
            href={profileUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: '#000000' }}
            className="shrink-0 font-bold hover:underline"
            title={`Buka @${user} di TikTok`}
          >
            {user}
          </a>
        ) : (
          <span style={{ color: '#000000' }} className="shrink-0 font-bold">
            {user}
          </span>
        )}
        <span style={{ color: '#71717a' }} className="shrink-0 text-[10px] font-normal tabular-nums">
          {time}
        </span>
      </div>
      <p style={{ color: '#000000' }} className="mt-0.5 m-0 min-w-0 break-words font-medium leading-snug">
        {text}
      </p>
    </div>
  )
}
