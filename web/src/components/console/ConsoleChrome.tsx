'use client'

/**
 * The interactive part of the console shell.
 *
 * The shell is a server component because it reads the environment; this is the
 * client boundary that owns the one piece of state the chrome has — whether the
 * sidebar is collapsed — and renders the top bar, the sidebar and the command
 * palette around the page.
 *
 * The collapsed state is written to a cookie so the server's next render starts
 * at the right width. `document.cookie` rather than a fetch: it is one small
 * value, it has to be present on the next request, and a round trip to the
 * server to remember a UI toggle would be a request per click.
 */

import { useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import TopBar from './TopBar'
import AppSidebar from './AppSidebar'
import CommandPalette from './CommandPalette'
import BlurFade from '@/components/magicui/BlurFade'

const SIDEBAR_COOKIE = 'streamkit_sidebar'

export default function ConsoleChrome({
  productName,
  head,
  tail,
  user,
  defaultCollapsed,
  children,
}: {
  productName: string
  head: string
  tail: string
  user: string
  defaultCollapsed: boolean
  children: ReactNode
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed)
  const [paletteOpen, setPaletteOpen] = useState(false)

  const toggle = () => {
    setCollapsed((was) => {
      const next = !was
      document.cookie = `${SIDEBAR_COOKIE}=${next ? 'collapsed' : 'expanded'}; path=/; max-age=31536000; samesite=lax`
      return next
    })
  }

  return (
    <>
      <TopBar
        productName={productName}
        head={head}
        tail={tail}
        collapsed={collapsed}
        onToggleSidebar={toggle}
        onOpenPalette={() => setPaletteOpen(true)}
      />
      <div className="flex flex-1">
        <aside
          className={cn(
            'sticky top-14 hidden h-[calc(100svh-3.5rem)] shrink-0 flex-col border-r-2 border-border bg-sidebar py-4 transition-[width] duration-200 md:flex',
            collapsed ? 'w-[76px]' : 'w-64',
          )}
        >
          <AppSidebar collapsed={collapsed} user={user} />
        </aside>
        <main className="min-w-0 flex-1">
          <div className="mx-auto w-full max-w-[1200px] px-5 py-6 sm:px-8 sm:py-8">
            <BlurFade>{children}</BlurFade>
          </div>
        </main>
      </div>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </>
  )
}
