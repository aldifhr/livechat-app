import { useEffect, useRef } from 'react'
import { type SidecarEvent } from '../lib/sidecar'
import { useRoomEvents } from '../lib/reactive'
import { playMention, releaseAudio, resolveAudio } from '../lib/player'
import { shouldPlayMentionAlert } from '../lib/sound'
import { mentionsMe, myHandles } from '../lib/mentions'
import { say } from '../lib/voice'
import type { VoiceOptions } from '../lib/voices'

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
  /** Pace, language and volume for the voice, from the settings the user picked. */
  speech: VoiceOptions
}

export function useMentionAlert({ myHandle, sound, voice, speech }: Options): void {
  // Its own context rather than the shared player's: a mention plays `playMention`,
  // a fixed two-note figure, not a template or a file — so there is nothing for the
  // player to choose. The lifecycle is the same, so it borrows the same release
  // helper rather than a second copy of it.
  const audioRef = useRef<AudioContext | null>(null)
  const lastPlayedAt = useRef<number | null>(null)

  // Parsed once per change to the field rather than per message: the feed is the
  // busiest path in the app and a mention is checked against every chat row.
  const mine = myHandles(myHandle)

  useRoomEvents((event: SidecarEvent) => {
    if (event.type !== 'chat') return
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
      // Ordinary: a mention waits behind whatever chat sentence is still being
      // read rather than cutting it off. The name is short enough that waiting
      // costs almost nothing, and a reader that is interrupted mid-sentence is
      // worse than one that hears the mention a beat later.
      say(`${who} menyebut kamu`, speech)
    }
  }, [mine.join(','), sound, voice, speech.pace, speech.language, speech.volume])

  // This hook made its own context, so this hook closes it. Released on unmount
  // only: the effect above re-runs on a setting change far more often than the
  // component unmounts, and closing there would cut a sound off mid-play.
  useEffect(
    () => () => {
      audioRef.current = releaseAudio(audioRef.current)
    },
    [],
  )

  // Off: forget when the last alert was, so turning it back on does not wait out a
  // gap that started while it was off. Watches both channels, because either one
  // alone still lets the alert fire — watching only the sound left voice-only use
  // carrying a timestamp and silencing the first mention after a re-enable.
  useEffect(() => {
    if (!sound && !voice) lastPlayedAt.current = null
  }, [sound, voice])
}
