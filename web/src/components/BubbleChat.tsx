export interface BubbleChatProps {
  user: string
  text?: string
  time: string
  profileUrl?: string
}

/**
 * A chat message, as it appears in the dock.
 *
 * The dock is an OBS browser source drawn over video, so the bubble is a solid
 * light card with a black border: it has to stay readable over whatever is behind
 * it, and a translucent one would take its contrast from the stream. The corner
 * with the avatar is squared off so the row reads as coming from the face beside
 * it.
 */
export function BubbleChat({ user, text, time, profileUrl }: BubbleChatProps) {
  return (
    <div className="w-fit max-w-[calc(100%-2rem)] min-w-0 rounded-[4px_14px_14px_14px] border-2 border-line bg-raised px-3 py-1.5 text-xs text-text">
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
      <p className="m-0 mt-0.5 min-w-0 leading-snug font-medium break-words">{text}</p>
    </div>
  )
}
