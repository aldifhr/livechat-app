import Docks from '@/sections/Docks'
import { BACKEND_ORIGIN } from '@/lib/server/backend'

export const dynamic = 'force-dynamic'

/**
 * The docks console: `/docks?room=<id>`.
 *
 * The socket origin is read here, on the server, and handed to the client —
 * the same constant the overlay route bakes into its pages. This page is
 * served from the Vercel host as well as the VPS one, and only the backend
 * host proxies `/ws/`, so the page's own origin is not a safe default for
 * the socket. `?ws=` and `?backend=` still point it anywhere, for a local
 * backend.
 */
export default function DocksPage() {
  return <Docks backendOrigin={BACKEND_ORIGIN} />
}
