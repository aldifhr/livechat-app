import type { ReactNode } from 'react'
import ConsoleShell from '@/components/ConsoleShell'

// Rendered per request, not at build time. Next would otherwise prerender these
// pages and freeze whatever STREAMKIT_TOKEN happened to be set to when the build
// ran — so adding or rotating a token would need a rebuild to take effect, which
// is the one thing this move away from a static build was supposed to fix.
export const dynamic = 'force-dynamic'

/**
 * The console's shell.
 *
 * Every signed-in page lives under this group, so the top bar and sidebar render
 * once and the page beside them swaps. The group adds no path segment — the
 * console is the root, and there is one platform, so there is no `/app/tiktok`
 * to sit under.
 */
export default function ConsoleLayout({ children }: { children: ReactNode }) {
  return <ConsoleShell>{children}</ConsoleShell>
}
