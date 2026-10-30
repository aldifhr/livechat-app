'use client'

/**
 * The console's sidebar.
 *
 * A column of destinations, each a real address. The active one is read from the
 * URL so it cannot drift from what is on screen — there is no second copy of
 * "where am I" to fall out of sync.
 *
 * The shape is the product's own, not a generic rail: chunky rounded tiles, a
 * hard offset shadow under the active one, and bold labels. A muted grey hover
 * and a 2px tick would read as any other admin panel; this reads as StreamKit.
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
import AccountMenu from './AccountMenu'

export default function AppSidebar({
  collapsed,
  user,
}: {
  collapsed: boolean
  user: string
}) {
  const pathname = usePathname()
  const items = navItems()

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-3 pt-1">
        <p
          className={cn(
            'px-3 pt-1 pb-2 text-[10px] font-extrabold tracking-[0.16em] text-muted-foreground uppercase transition-opacity',
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
                'group relative flex min-h-11 items-center gap-3 rounded-xl border-2 border-transparent px-2.5 text-[13px] font-bold text-muted-foreground no-underline',
                'transition-[background,color,box-shadow,transform] duration-100',
                'hover:bg-accent-tint hover:text-accent hover:no-underline',
                active &&
                  'border-accent-dim bg-accent text-accent-ink shadow-[0_3px_0_0_var(--accent-dim)]',
                collapsed && 'justify-center px-0',
              )}
            >
              <span
                className={cn(
                  'grid size-7 shrink-0 place-items-center rounded-lg text-faint transition-colors',
                  'bg-muted group-hover:bg-transparent group-hover:text-accent',
                  active && 'bg-accent-ink/15 text-accent-ink group-hover:text-accent-ink',
                )}
              >
                <Icon className="size-4" />
              </span>
              <span className={cn('truncate', collapsed && 'hidden')}>{item.label}</span>
            </Link>
          )
        })}
      </nav>

      {/* The footer: the account menu, and a line that says the dashboard is
          talking to a backend with a credential — the one thing an operator
          wants to know before a write silently 401s. */}
      <div className={cn('mt-3 px-3 pt-3', collapsed && 'px-2')}>
        <div className="mb-3 h-px bg-border" />
        <AccountMenu user={user} collapsed={collapsed} />
      </div>
    </div>
  )
}
