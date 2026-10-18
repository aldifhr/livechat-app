import 'server-only'

/**
 * Who may commit a giveaway draw.
 *
 * The dashboard is same-origin; the desktop app is a foreign origin and publishes
 * from its webview, so it is named here the way the snapshot route names it. A
 * commitment is a claim about a giveaway the caller is running, and the reveal
 * returns the seed — so this is the whole gate: the proxy lets the path through
 * unauthenticated (the app has no session), and the route decides by origin.
 */

export const ALLOWED_ORIGINS = new Set([
  'http://tauri.localhost',
  'https://tauri.localhost',
  'tauri://localhost',
  'http://localhost:5183',
  'http://127.0.0.1:5183',
])

export function corsHeaders(origin: string | null): HeadersInit {
  const headers: Record<string, string> = { Vary: 'Origin' }
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin
    headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS'
    headers['Access-Control-Allow-Headers'] = 'Content-Type'
    headers['Access-Control-Max-Age'] = '600'
  }
  return headers
}

/** The dashboard itself (same-origin) or the desktop app. */
export function originAllowed(request: Request): boolean {
  const origin = request.headers.get('origin')
  if (!origin) return false
  if (ALLOWED_ORIGINS.has(origin)) return true
  try {
    return new URL(origin).host === request.headers.get('host')
  } catch {
    return false
  }
}
