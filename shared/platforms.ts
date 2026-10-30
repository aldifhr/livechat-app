/**
 * Shared TikTok platform utilities used by the web dashboard and overlays.
 */

const USERNAME = /^[A-Za-z0-9._]+$/

/**
 * Normalizes a raw handle or display name into a valid TikTok username.
 * Returns '' if it cannot be a valid username.
 */
export function tiktokUsername(raw: string): string {
  const name = raw.trim().replace(/^@+/, '').replace(/@/g, '_')
  return USERNAME.test(name) ? name : ''
}

/**
 * Builds a TikTok profile URL for a user handle or fallback name.
 * Returns '' when the name is not a valid username.
 */
export function tiktokProfileUrl(raw: string): string {
  const name = tiktokUsername(raw)
  return name === '' ? '' : `https://www.tiktok.com/@${encodeURIComponent(name)}`
}

/**
 * Builds a TikTok live stream player URL.
 */
export function tiktokLiveUrl(handle: string): string {
  const name = tiktokUsername(handle)
  return name === '' ? '' : `https://www.tiktok.com/@${encodeURIComponent(name)}/live`
}
