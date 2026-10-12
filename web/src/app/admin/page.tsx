import { tokenConfigured, productName, splitWordmark } from '@/lib/config'
import { BACKEND } from '@/lib/backend'
import Admin from '@/components/Admin'

// Rendered per request, not at build time. Next would otherwise prerender this
// page and freeze whatever STREAMKIT_TOKEN happened to be set to when the build
// ran — so adding or rotating a token would need a rebuild to take effect, which
// is the one thing this move away from a static build was supposed to fix.
export const dynamic = 'force-dynamic'

/**
 * The console.
 *
 * A server component that reads the environment and hands the client only what
 * it cannot fetch: the wordmark, and whether a credential is present. The token
 * itself never crosses this boundary.
 */
export default function AdminPage() {
  return (
    <Admin
      wordmark={splitWordmark(productName)}
      tokenConfigured={tokenConfigured}
      backend={BACKEND}
    />
  )
}