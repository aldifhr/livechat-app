import 'server-only'

/**
 * Who may commit a giveaway draw.
 *
 * Same-origin, and nothing else. The desktop app that used to publish from its
 * own webview is gone, so there is no foreign origin left to allow: the only
 * caller is the dashboard's own giveaway page.
 *
 * A commitment is a claim about a giveaway the caller is running, and the reveal
 * returns the seed — so this is the whole gate. The proxy lets the path through
 * unauthenticated, and the route decides by origin.
 */
export function originAllowed(request: Request): boolean {
  const origin = request.headers.get('origin')
  if (!origin) return false
  try {
    return new URL(origin).host === request.headers.get('host')
  } catch {
    return false
  }
}
