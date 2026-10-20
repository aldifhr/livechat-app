import type { ReactNode } from 'react'
import ConsoleShell from '@/components/ConsoleShell'

// Rendered per request, not at build time. Next would otherwise prerender these
// pages and freeze whatever STREAMKIT_TOKEN happened to be set to when the build
// ran — so adding or rotating a token would need a rebuild to take effect, which
// is the one thing this move away from a static build was supposed to fix.
export const dynamic = 'force-dynamic'

/**
 * The admin console's shell.
 *
 * The sidebar is here rather than in each page because it is the thing that stays
 * put: a layout renders once and the page beside it swaps. Each item in it is a
 * real address, so a tab is something you can link to, send to somebody, or come
 * back to with the back button — none of which works when the active tab lives in
 * component state.
 */
export default function AdminLayout({ children }: { children: ReactNode }) {
  return <ConsoleShell>{children}</ConsoleShell>
}
