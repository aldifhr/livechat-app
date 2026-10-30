'use client'

import { useState } from 'react'

export interface UserAvatarProps {
  avatar?: string
  user: string
  profileUrl?: string
}

export function UserAvatar({ avatar, user, profileUrl }: UserAvatarProps) {
  const [failed, setFailed] = useState(false)
  const initial = (user.trim()[0] || '?').toUpperCase()

  const avatarCircle = (
    <div className="relative flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-raised text-xs font-semibold text-dim ring-1 ring-line/60 transition-all hover:ring-accent">
      <span>{initial}</span>
      {avatar && !failed && (
        <img
          src={avatar}
          alt=""
          onError={() => setFailed(true)}
          className="absolute inset-0 h-full w-full rounded-full object-cover"
          loading="lazy"
          referrerPolicy="no-referrer"
        />
      )}
    </div>
  )

  if (profileUrl) {
    return (
      <a
        href={profileUrl}
        target="_blank"
        rel="noopener noreferrer"
        title={`Buka @${user} di TikTok`}
        className="shrink-0 rounded-full hover:scale-105 active:scale-95 transition-transform"
      >
        {avatarCircle}
      </a>
    )
  }

  return avatarCircle
}
