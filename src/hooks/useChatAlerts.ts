import { useEffect, useRef } from 'react'
import { attach, detachHandler, type SidecarEvent } from '../lib/sidecar'
import { playSound, resolveAudio } from '../lib/player'
import { shouldPlayChatSound, ttsText, CHAT_TTS_GAP_MS } from '../lib/sound'

/**
 * What a new chat message does besides appear in the feed: a blip, and speech.
 *
 * Both are gapped the same way the gift sound is — a minimum gap between sounds,
 * because chat arrives several a second in an active room and one blip per
 * message is a buzz rather than a signal. Speech gets the longer gap: a tap that
 * overlaps the next tap is merely busy, but two sentences overlapping are
 * unintelligible.
 *
 * The blip is a template or a custom file, played through the shared player.
 * Speech uses the Web Speech API the webview already has, so there is nothing to
 * install and no asset to ship. Both are guarded: a runtime without the audio or
 * speech APIs gets silence and a working app, never an exception from the feed
 * handler they fire from.
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

type SpeechSynthesisLike = {
  speak(utterance: SpeechSynthesisUtterance): void
  cancel(): void
}

type SpeechSynthesisUtteranceCtor = new (text: string) => SpeechSynthesisUtterance

/** The browser's speech synthesis, or null when there isn't one. */
function resolveSpeech(): SpeechSynthesisLike | null {
  const scope = globalThis as typeof globalThis & {
    speechSynthesis?: SpeechSynthesisLike
    SpeechSynthesisUtterance?: SpeechSynthesisUtteranceCtor
  }
  if (!scope.speechSynthesis || !scope.SpeechSynthesisUtterance) return null
  return scope.speechSynthesis
}

export function useChatAlerts({ chatSound, chatTts, ttsNames, templateId, customPath }: Options): void {
  const audioRef = useRef<AudioContext | null>(null)
  const lastBlipAt = useRef<number | null>(null)
  const lastSpokeAt = useRef<number | null>(null)

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

    const speak = (nickname: string, text: string) => {
      const spoken = ttsText(nickname, text, ttsNames)
      if (spoken === '') return

      const now = Date.now()
      if (lastSpokeAt.current !== null && now - lastSpokeAt.current < CHAT_TTS_GAP_MS) return
      lastSpokeAt.current = now

      const synth = resolveSpeech()
      const Utterance = (globalThis as typeof globalThis & {
        SpeechSynthesisUtterance?: SpeechSynthesisUtteranceCtor
      }).SpeechSynthesisUtterance
      if (!synth || !Utterance) return

      // The previous sentence is cut off, not queued: a live room does not wait,
      // and a queue of half-finished sentences is worse than dropping one.
      try {
        synth.cancel()
        synth.speak(new Utterance(spoken))
      } catch {
        // A voice service that refuses is not worth interrupting the feed over.
      }
    }

    const handle = (event: SidecarEvent) => {
      if (!active) return
      if (event.type !== 'chat') return
      if (event.platform !== 'tiktok') return
      if (!chatSound && !chatTts) return
      blip()
      if (chatTts) speak(event.nickname, event.text)
    }

    attach(handle)
    return () => {
      active = false
      detachHandler(handle)
    }
  }, [chatSound, chatTts, ttsNames, templateId, customPath])

  // Turned off: forget when the last sound was, so turning it back on does not
  // wait out a gap that started while it was off.
  useEffect(() => {
    if (!chatSound) lastBlipAt.current = null
  }, [chatSound])
  useEffect(() => {
    if (!chatTts) {
      lastSpokeAt.current = null
      try {
        resolveSpeech()?.cancel()
      } catch {
        // Nothing to cancel, or the service is gone; either way, not fatal.
      }
    }
  }, [chatTts])
}
