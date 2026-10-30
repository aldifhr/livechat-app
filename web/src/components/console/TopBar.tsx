'use client'

/**
 * The console's top bar.
 *
 * The strip above the page: the sidebar toggle, a search affordance that opens
 * the command palette, and the theme switch. It is deliberately thin — the brand
 * and the account both live in the sidebar now, so this row carries only the
 * controls that are about the window rather than about where you are.
 *
 * The search box is a button, not an input. Typing in it would do nothing the
 * palette does not, and a real input here would put a second, worse search
 * beside the one that already knows every destination.
 */

import { ChevronLeft, ChevronRight, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import ThemeToggle from './ThemeToggle'

export default function TopBar({
  productName,
  collapsed,
  onToggleSidebar,
  onOpenPalette,
}: {
  productName: string
  head: string
  tail: string
  collapsed: boolean
  onToggleSidebar: () => void
  onOpenPalette: () => void
}) {
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b-2 border-border bg-background/80 px-3 backdrop-blur-md">
      <Button
        variant="ghost"
        size="icon"
        onClick={onToggleSidebar}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        className="text-muted-foreground"
      >
        {/* The chevron points the way the rail will move: left to collapse,
            right to bring it back. */}
        {collapsed ? <ChevronRight /> : <ChevronLeft />}
      </Button>

      <span className="text-sm font-semibold tracking-tight text-muted-foreground max-sm:hidden">
        {productName}
      </span>

      <button
        type="button"
        onClick={onOpenPalette}
        className={cn(
          'ml-auto flex h-8 items-center gap-2 rounded-lg border border-border bg-muted/40 pr-1.5 pl-2.5 text-sm text-muted-foreground',
          'transition-colors hover:border-border hover:bg-muted hover:text-foreground',
          'max-sm:w-8 max-sm:justify-center max-sm:px-0',
        )}
        aria-label="Open command palette"
      >
        <Search className="size-3.5" />
        <span className="max-sm:hidden">Search…</span>
        <kbd className="ml-2 hidden items-center gap-0.5 rounded border border-border bg-background px-1.5 font-mono text-[10px] text-muted-foreground sm:inline-flex">
          <span className="text-xs">⌘</span>K
        </kbd>
      </button>

      <ThemeToggle />
    </header>
  )
}
