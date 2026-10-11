import { useEffect, useRef } from 'react'
import { attach, detachHandler, type SidecarEvent } from '../lib/sidecar'
import { playSound, releaseAudio, resolveAudio } from '../lib/player'
import { say, hush } from '../lib/voice'
import { shouldPlayChatSound, ttsText } from '../lib/sound'

/**
 * What a new chat message does besides appear in the feed: a blip, and speech.
 *
 * Both are gapped the same way the gift sound is — a minimum gap between sounds,
 * because chat arrives several a second in an active room and one blip per
 * message is a buzz rather than a signal. Speech gets the longer gap, and it has
 * to for a second reason here: the voice is synthesised over the network, so the
 * gap has to cover the round trip as well as the sentence, or the next request
 * goes out while the previous one is still being spoken.
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
  /** Speak the sender's name before the message. */
  ttsNames: boolean
  /** Which synthesised template the blip uses when there is no custom file. */
  templateId: string
  /** A user-picked sound file, played instead of the template when set. */
  customPath: string
}

export function useChatAlerts({ chatSound, chatTts, ttsNames, templateId, customPath }: Options): void {
  const audioRef = useRef<AudioContext | null>(null)
  const lastBlipAt = useRef<number | null>(null)

  useEffect(() => {
    let active = true

    const blip = () => {
      const now = Date.now()
      if (!shouldPlayChatSound(chatSound, lastBlipAt.current, now)) return
      lastBlipAt.current = now

      audioRef.current ??= resolveAudio()
      void playSound(audioRef.current, templateId, customPath).then((used) => {
        audioRef.current = used
      })
    }

    const handle = (event: SidecarEvent) => {
      if (!active) return
      if (event.type !== 'chat') return
      if (event.platform !== 'tiktok') return
      if (!chatSound && !chatTts) return
      blip()
      if (chatTts) say(ttsText(event.nickname, event.text, ttsNames))
    }

    attach(handle)
    return () => {
      active = false
      detachHandler(handle)
    }
  }, [chatSound, chatTts, ttsNames, templateId, customPath])

  // This hook made its own context, so this hook closes it — on unmount only,
  // because the effect above re-runs on every settings change and closing there
  // would cut a blip off mid-play.
  useEffect(
    () => () => {
      audioRef.current = releaseAudio(audioRef.current)
    },
    [],
  )

  // Turned off: forget when the last blip was, so turning it back on does not wait
  // out a gap that started while it was off. The voice is shared, so stopping it
  // here would also silence a gift announcement — that is left to its own hook.
  useEffect(() => {
    if (!chatSound) lastBlipAt.current = null
  }, [chatSound])
  useEffect(() => {
    if (!chatTts) hush()
  }, [chatTts])
}
