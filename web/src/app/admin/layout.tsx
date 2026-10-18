import type { ReactNode } from 'react'
import { tokenConfigured, productName, splitWordmark } from '@/lib/server/config'
import Sidebar from '@/components/Sidebar'
import AccountMenu from '@/components/AccountMenu'
import { ToastProvider } from '@/components/Toast'
import BlurFade from '@/components/magicui/BlurFade'

// Rendered per request, not at build time. Next would otherwise prerender these
// pages and freeze whatever STREAMKIT_TOKEN happened to be set to when the build
// ran — so adding or rotating a token would need a rebuild to take effect, which
// is the one thing this move away from a static build was supposed to fix.
export const dynamic = 'force-dynamic'

/**
 * The console's shell.
 *
 * The sidebar is here rather than in each page because it is the thing that stays
 * put: a layout renders once and the page beside it swaps. Each item in it is a
 * real address, so a tab is something you can link to, send to somebody, or come
 * back to with the back button — none of which works when the active tab lives in
 * component state.
 *
 * A server component that reads the environment and hands the client only what it
 * cannot fetch: the wordmark, and whether a credential is present. The token
 * itself never crosses this boundary.
 */
export default function AdminLayout({ children }: { children: ReactNode }) {
  const [head, tail] = splitWordmark(productName)

  return (
    <div className="admin">
      <aside className="sidebar">
        <div className="brand-lockup">
          <span className="brand-symbol" aria-hidden="true">S</span>
          <div className="brand-copy">
            <span className="wordmark">
              {head}
              {tail && <span>{tail}</span>}
            </span>
            <span className="brand-caption">LIVE STUDIO</span>
          </div>
        </div>
        <Sidebar />
        <AccountMenu />
      </aside>
      <main className="content">
        {!tokenConfigured && (
          <div className="notice error">
            This server has no API token, so creating and connecting rooms will be refused. Set
            STREAMKIT_TOKEN in the environment and restart.
          </div>
        )}
        {/* Wrapped here rather than around the whole shell: the toasts belong to
            the console's own actions, and the sidebar does not raise any. */}
        <ToastProvider>
          <BlurFade>{children}</BlurFade>
        </ToastProvider>
      </main>
    </div>
  )
}
