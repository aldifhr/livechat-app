/**
 * Seconds as something readable, or an em dash when there is no value.
 *
 * One definition for the two places that print a duration — a stream's own
 * session panel and the analytics table — so the same session cannot read two
 * ways. `null` becomes an em dash rather than `0s`: nobody measured it, which is
 * not the same as a measured zero.
 */
export function formatDuration(seconds: number | null): string {
  if (!seconds) return '—'
  const whole = Math.floor(seconds)
  if (whole < 60) return `${whole}s`
  const minutes = Math.floor(whole / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}
