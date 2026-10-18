/**
 * First-In-First-Out (FIFO) Audio Queue for Text-to-Speech.
 * Ensures incoming chat messages are read completely one by one without cutting each other off.
 */

'use client'

import { TTS_MAX_CHARS } from '../tts'

const ttsQueue: string[] = []
let isTtsPlaying = false
let activeTtsAudio: HTMLAudioElement | null = null

export function clearTtsQueue() {
  ttsQueue.length = 0
  if (activeTtsAudio) {
    activeTtsAudio.pause()
    activeTtsAudio = null
  }
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    try {
      window.speechSynthesis.cancel()
    } catch {}
  }
  isTtsPlaying = false
}

function playNextTts() {
  if (ttsQueue.length === 0) {
    isTtsPlaying = false
    activeTtsAudio = null
    return
  }

  isTtsPlaying = true
  const text = ttsQueue.shift()!
  const clean = text.slice(0, TTS_MAX_CHARS)
  const url = `/api/tts?q=${encodeURIComponent(clean)}`
  const audio = new Audio(url)
  activeTtsAudio = audio

  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    activeTtsAudio = null
    playNextTts()
  }

  audio.onended = finish
  audio.onerror = () => {
    // Fallback to browser native speech synthesis if audio fetch fails
    if ('speechSynthesis' in window) {
      try {
        const utterance = new SpeechSynthesisUtterance(text)
        utterance.rate = 1.05
        utterance.pitch = 1.25
        const voices = window.speechSynthesis.getVoices()
        const femaleIdVoice =
          voices.find(
            (v) =>
              (v.lang.startsWith('id') || v.lang.startsWith('ID')) &&
              (v.name.toLowerCase().includes('gadis') ||
                v.name.toLowerCase().includes('siti') ||
                v.name.toLowerCase().includes('female') ||
                v.name.toLowerCase().includes('google')),
          ) || voices.find((v) => v.lang.startsWith('id') || v.lang.startsWith('ID'))

        if (femaleIdVoice) utterance.voice = femaleIdVoice
        utterance.onend = finish
        utterance.onerror = finish
        window.speechSynthesis.speak(utterance)
        return
      } catch {}
    }
    finish()
  }

  const playPromise = audio.play()
  if (playPromise !== undefined) {
    playPromise.catch(() => {
      audio.onerror?.(new Event('error'))
    })
  }
}

export function speakText(text: string) {
  if (typeof window === 'undefined') return
  const trimmed = text.trim()
  if (!trimmed) return

  // Bound queue size to prevent memory buildup during busy live chat
  if (ttsQueue.length >= 30) {
    ttsQueue.shift()
  }
  ttsQueue.push(trimmed)

  if (!isTtsPlaying) {
    playNextTts()
  }
}
