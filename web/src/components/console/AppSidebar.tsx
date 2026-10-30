'use client'

/**
 * The console's sidebar.
 *
 * A column of destinations, each a real address. The active one is read from the
 * URL so it cannot drift from what is on screen — there is no second copy of
 * "where am I" to fall out of sync.
 *
 * Collapsible to an icon rail. The width is a CSS variable on the shell so the
 * content beside it reflows with the same transition, and the state is kept in a
 * cookie by the shell rather than here, so the first paint is already the width
 * the operator chose rather than a flash of the default.
 */

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import { navItems } from './nav'

export default function AppSidebar({ collapsed }: { collapsed: boolean }) {
  const pathname = usePathname()
  const items = navItems()

  return (
    <nav className="flex flex-col gap-1 px-3">
      <p
        className={cn(
          'px-2 pt-1 pb-2 text-[11px] font-semibold tracking-[0.14em] text-muted-foreground uppercase transition-opacity',
          collapsed && 'opacity-0',
        )}
      >
        Workspace
      </p>
      {items.map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`)
        const Icon = item.icon
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            title={collapsed ? item.label : undefined}
            className={cn(
              'group relative flex h-9 items-center gap-3 rounded-lg px-2 text-sm font-medium text-muted-foreground no-underline transition-colors',
              'hover:bg-muted hover:text-foreground',
              active && 'bg-muted text-foreground',
              collapsed && 'justify-center px-0',
            )}
          >
            {active && (
              <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-primary" aria-hidden="true" />
            )}
            <Icon className="size-4 shrink-0" />
            <span className={cn('truncate transition-opacity', collapsed && 'hidden')}>{item.label}</span>
          </Link>
        )
      })}
    </nav>
  )
}
