import { useEffect, useRef } from 'react'
import { attach, detachHandler, type SidecarEvent } from '../lib/sidecar'
import { playMention, resolveAudio } from '../lib/player'
import { shouldPlayMentionAlert } from '../lib/sound'
import { mentionsMe, myHandles } from '../lib/mentions'
import { say } from '../lib/voice'

/**
 * A sound and a spoken name when a message is addressed to me.
 *
 * The highlight in the feed has existed for a long time — `FeedRow` has known how
 * to mark a mention since before anything supplied it a name. This is the other
 * half: the same condition, heard rather than seen, for the case where the eyes
 * are on the stream and not on the chat.
 *
 * The sound is fixed rather than chosen, because its job is to be recognised
 * without being looked up: two notes rising, distinct from the chat blip's single
 * level tap and from the gift chime's two falling ones. A mention is something
 * that happened *to you*, and a blip is something that happened.
 *
 * When speech is on, the sender's name is said as well — because a highlight tells
 * you a row is about you and a name tells you who.
 */

interface Options {
  /** The comma-separated handles that count as me. */
  myHandle: string
  /** Play the alert sound. */
  sound: boolean
  /** Speak the sender's name with the shared voice. */
  voice: boolean
}

export function useMentionAlert({ myHandle, sound, voice }: Options): void {
  const audioRef = useRef<AudioContext | null>(null)
  const lastPlayedAt = useRef<number | null>(null)

  // Parsed once per change to the field rather than per message: the feed is the
  // busiest path in the app and a mention is checked against every chat row.
  const mine = myHandles(myHandle)

  useEffect(() => {
    let active = true

    const handle = (event: SidecarEvent) => {
      if (!active) return
      if (event.type !== 'chat') return
      if (event.platform !== 'tiktok') return
      if (!sound && !voice) return
      if (!mentionsMe(event.mentions, mine)) return

      const now = Date.now()
      if (!shouldPlayMentionAlert(sound || voice, lastPlayedAt.current, now)) return
      lastPlayedAt.current = now

      if (sound) {
        audioRef.current ??= resolveAudio()
        const context = audioRef.current
        if (context) {
          // Suspended until the user has interacted with the window; asking again
          // is cheap and is what makes the first alert audible at all.
          if (context.state === 'suspended') void context.resume()
          playMention(context)
        }
      }

      if (voice) {
        const who = event.nickname.trim() || 'Someone'
        say(`${who} menyebut kamu`)
      }
    }

    attach(handle)
    return () => {
      active = false
      detachHandler(handle)
    }
  }, [mine.join(','), sound, voice])

  // Off: forget when the last alert was, so turning it back on does not wait out a
  // gap that started while it was off.
  useEffect(() => {
    if (!sound) lastPlayedAt.current = null
  }, [sound])
}
