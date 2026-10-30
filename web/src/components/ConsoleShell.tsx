/**
 * The console's shell: a top bar, a collapsible sidebar, and the page beside
 * them.
 *
 * Rendered on the server because it reads the environment; the token itself never
 * crosses into the browser.
 *
 * The sidebar's collapsed state lives in a cookie rather than component state:
 * the shell is a server component, and a width the browser picks on mount is a
 * width that flashes from the default to the chosen one on every navigation. The
 * cookie is read here, so the first paint is already right.
 */

import type { ReactNode } from 'react'
import { cookies } from 'next/headers'
import { tokenConfigured, productName, splitWordmark, dashboardUser } from '@/lib/server/config'
import { ToastProvider } from '@/components/Toast'
import ConsoleChrome from '@/components/console/ConsoleChrome'

const SIDEBAR_COOKIE = 'streamkit_sidebar'

export default async function ConsoleShell({ children }: { children: ReactNode }) {
  const [head, tail] = splitWordmark(productName)
  const jar = await cookies()
  const collapsed = jar.get(SIDEBAR_COOKIE)?.value === 'collapsed'

  return (
    <div className="flex min-h-svh flex-col bg-background">
      {!tokenConfigured && (
        <div className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-center text-sm text-destructive">
          This server has no API token, so creating and connecting rooms will be refused. Set
          STREAMKIT_TOKEN in the environment and restart.
        </div>
      )}
      <ConsoleChrome
        productName={productName}
        head={head}
        tail={tail}
        user={dashboardUser}
        defaultCollapsed={collapsed}
      >
        {/* Wrapped here rather than around the whole shell: the toasts belong to
            the console's own actions, and the sidebar does not raise any. */}
        <ToastProvider>{children}</ToastProvider>
      </ConsoleChrome>
    </div>
  )
}
