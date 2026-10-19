import { useEffect, useRef } from 'react'
import { type SidecarEvent } from '../lib/sidecar'
import { useRoomEvents } from './useRoomEvents'
import { useAudioPlayer } from './useAudioPlayer'
import { say, hush } from '../lib/voice'
import { shouldPlayChatSound, ttsText } from '../lib/sound'
import type { VoiceOptions } from '../lib/voices'

/**
 * What a new chat message does besides appear in the feed: a blip, and speech.
 *
 * The blip has a minimum gap because chat arrives several times a second. Speech
 * uses the shared FIFO voice queue, so network synthesis and active playback never
 * cause a chat line to be silently discarded.
 *
 * The blip is a template or a custom file, played through the shared player. The
 * voice is a neural one, synthesised by the host and returned as audio — the
 * platform's own speech synthesiser is a formant synthesiser and sounds like a
 * screen reader, which is the whole reason this does not use it. Sending the text
 * to be spoken is what that voice costs, and it is why the setting is opt-in.
 *
 * Everything is guarded. A host that cannot reach the voice service, a runtime
 * with no Web Audio, a decode that fails — each must yield silence and a working
 * app, never an exception from the feed handler they fire from.
 */

interface Options {
  chatSound: boolean
  chatTts: boolean
  /** Pace, language and volume for the voice, from the settings the user picked. */
  voice: VoiceOptions
  /** Which synthesised template the blip uses when there is no custom file. */
  templateId: string
  /** A user-picked sound file, played instead of the template when set. */
  customPath: string
  soundVolume: number
  soundGapMs: number
}

export function useChatAlerts({ chatSound, chatTts, voice, templateId, customPath, soundVolume, soundGapMs }: Options): void {
  const { play } = useAudioPlayer()
  const lastBlipAt = useRef<number | null>(null)

  useRoomEvents((event: SidecarEvent) => {
    if (event.type !== 'chat') return
    if (!chatSound && !chatTts) return

    if (chatSound) {
      const now = Date.now()
      if (shouldPlayChatSound(chatSound, lastBlipAt.current, now, soundGapMs)) {
        lastBlipAt.current = now
        void play(templateId, customPath, soundVolume / 100)
      }
    }

    if (chatTts) say(ttsText(event.text), voice, 'chat')
  }, [chatSound, chatTts, voice.pace, voice.language, voice.volume, templateId, customPath, soundVolume, soundGapMs])

  // Turned off: forget when the last blip was, so turning it back on does not wait
  // out a gap that started while it was off. The shared voice queue is tagged by
  // source so turning chat speech off leaves gift announcements alone.
  useEffect(() => {
    if (!chatSound) lastBlipAt.current = null
  }, [chatSound])
  useEffect(() => {
    if (!chatTts) hush('chat')
  }, [chatTts])
}
