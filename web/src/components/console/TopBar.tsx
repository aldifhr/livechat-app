'use client'

/**
 * The console's top bar.
 *
 * The strip above the page: the sidebar toggle, the product mark, a search
 * affordance that opens the command palette, and the account menu. It is the
 * Linear/Vercel shape — a fixed bar the content scrolls under, with the
 * navigation it controls to its left.
 *
 * The search box is a button, not an input. Typing in it would do nothing the
 * palette does not, and a real input here would put a second, worse search
 * beside the one that already knows every destination.
 */

import Link from 'next/link'
import { PanelLeft, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import AccountMenu from './AccountMenu'
import ThemeToggle from './ThemeToggle'

export default function TopBar({
  productName,
  head,
  tail,
  user,
  collapsed,
  onToggleSidebar,
  onOpenPalette,
}: {
  productName: string
  head: string
  tail: string
  user: string
  collapsed: boolean
  onToggleSidebar: () => void
  onOpenPalette: () => void
}) {
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-background/80 px-3 backdrop-blur-md">
      <Button
        variant="ghost"
        size="icon"
        onClick={onToggleSidebar}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        className="text-muted-foreground"
      >
        <PanelLeft />
      </Button>

      <Link href="/" className="flex items-center gap-2.5 no-underline" aria-label={`${productName} home`}>
        <span className="grid size-7 place-items-center rounded-lg bg-primary/15 text-sm font-bold text-primary">
          {head.charAt(0) || 'S'}
        </span>
        <span className="text-sm font-semibold tracking-tight text-foreground">
          {head}
          {tail && <span className="text-primary">{tail}</span>}
        </span>
      </Link>

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
      <AccountMenu user={user} />
    </header>
  )
}
