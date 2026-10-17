/**
 * Synthesizes short pleasant sound alerts using Web Audio API.
 * Completely zero-asset, requires no external sound files.
 */

export type ChimeType = 'gift' | 'follow' | 'comment'

export function playChime(type: ChimeType) {
  if (typeof window === 'undefined') return
  try {
    const AudioContextClass =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const ctx = new AudioContextClass()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain)
    gain.connect(ctx.destination)
    const now = ctx.currentTime

    if (type === 'gift') {
      // Cheerful 2-tone chime (G5 -> C6)
      osc.frequency.setValueAtTime(783.99, now)
      osc.frequency.setValueAtTime(1046.5, now + 0.1)
      gain.gain.setValueAtTime(0.15, now)
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35)
      osc.start(now)
      osc.stop(now + 0.35)
    } else if (type === 'follow') {
      // Warm chime tone (E5)
      osc.frequency.setValueAtTime(659.25, now)
      gain.gain.setValueAtTime(0.1, now)
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25)
      osc.start(now)
      osc.stop(now + 0.25)
    } else {
      // Soft gentle 'pop' for incoming chat comments
      osc.frequency.setValueAtTime(520, now)
      gain.gain.setValueAtTime(0.05, now)
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.1)
      osc.start(now)
      osc.stop(now + 0.1)
    }
  } catch {}
}
