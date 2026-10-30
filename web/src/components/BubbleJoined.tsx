export interface BubbleJoinedProps {
  user: string
  time: string
  profileUrl?: string
}

/**
 * A viewer arriving, as it appears in the dock.
 *
 * A light card like a chat bubble, but the body is a quiet label rather than a
 * message — a join carries no text, so the only thing to say is that it happened.
 */
export function BubbleJoined({ user, time, profileUrl }: BubbleJoinedProps) {
  return (
    <div className="w-fit max-w-[calc(100%-2rem)] min-w-0 rounded-[4px_14px_14px_14px] border-2 border-line-soft bg-sunken px-3 py-1.5 text-xs text-text">
      <div className="flex items-center gap-1.5">
        {profileUrl ? (
          <a
            href={profileUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 font-extrabold text-text hover:underline"
            title={`Buka @${user} di TikTok`}
          >
            {user}
          </a>
        ) : (
          <span className="shrink-0 font-extrabold text-text">{user}</span>
        )}
        <span className="shrink-0 text-[10px] font-normal text-faint tabular-nums">{time}</span>
      </div>
      <p className="m-0 mt-0.5 leading-snug text-dim">👋 joined the stream</p>
    </div>
  )
}
