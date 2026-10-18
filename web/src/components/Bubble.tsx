interface BubbleProps {
  nickname: string
  message: string
  avatar?: string
  isGift?: boolean
  isFollow?: boolean
}

export function Bubble({ nickname, message, avatar, isGift, isFollow }: BubbleProps) {
  if (isGift) {
    return (
      <div className="flex items-center gap-1.5 rounded-lg border border-amber-800/50 bg-amber-950/30 px-2 py-1 text-xs">
        <span>🎁</span>
        <span className="font-medium text-zinc-200">{nickname}</span>
        <span className="text-zinc-400">sent {message}</span>
      </div>
    )
  }

  if (isFollow) {
    return (
      <div className="flex items-center gap-1.5 rounded-lg border border-pink-800/50 bg-pink-950/30 px-2 py-1 text-xs">
        <span>💖</span>
        <span className="font-medium text-zinc-200">{nickname}</span>
        <span className="text-zinc-400">followed</span>
      </div>
    )
  }

  return (
    <div className="flex items-start gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs leading-relaxed">
      {avatar ? (
        <img
          src={avatar}
          alt=""
          className="mt-0.5 h-4 w-4 shrink-0 rounded-full bg-zinc-800 object-cover"
          loading="lazy"
        />
      ) : null}
      <span className="shrink-0 font-medium text-zinc-300">{nickname}</span>
      <span className="min-w-0 break-words text-zinc-400">{message}</span>
    </div>
  )
}
