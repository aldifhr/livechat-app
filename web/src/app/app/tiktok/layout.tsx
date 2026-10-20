import type { ReactNode } from 'react'
import ConsoleShell from '@/components/ConsoleShell'

// Rendered per request, not at build time: the shell reads the environment for the
// token warning. Pages opt into dynamic themselves; the shell needs it too.
export const dynamic = 'force-dynamic'

/**
 * One platform's console.
 *
 * `/app/<platform>` and everything under it share this shell, so the sidebar
 * stays put while the page beside it swaps — the same reason the admin console
 * puts its sidebar in a layout.
 */
export default function PlatformLayout({ children }: { children: ReactNode }) {
  return <ConsoleShell>{children}</ConsoleShell>
}
