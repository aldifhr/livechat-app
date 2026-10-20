/**
 * The console's shell: sidebar, account menu and the page beside them.
 *
 * Shared by `/admin/*` and the platform dashboards under `/app/*`, so both read
 * as the same console. Rendered on the server because it reads the environment;
 * the token itself never crosses into the browser.
 */

import type { ReactNode } from 'react'
import { tokenConfigured, productName, splitWordmark } from '@/lib/server/config'
import Sidebar from '@/components/Sidebar'
import AccountMenu from '@/components/AccountMenu'
import { ToastProvider } from '@/components/Toast'
import BlurFade from '@/components/magicui/BlurFade'

export default function ConsoleShell({ children }: { children: ReactNode }) {
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
