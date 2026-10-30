'use client'

/**
 * The theme switch.
 *
 * Three states — light, dark, and follow the system — because a two-state toggle
 * has no way back to "whatever my OS says", which is where most people start.
 * The choice is written to a cookie so the server can render the right class on
 * the next request, and applied to `<html>` here so the current page flips
 * without a reload.
 *
 * The icon shows what a click does next rather than the current state: a sun
 * while it is dark (click for light), a moon while it is light. That is the
 * convention a one-button switch has settled on, and the title spells it out.
 */

import { useEffect, useState } from 'react'
import { Moon, Sun, Monitor } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

const COOKIE = 'streamkit_theme'
type Theme = 'light' | 'dark' | 'system'

function readCookie(): Theme {
  if (typeof document === 'undefined') return 'system'
  const match = document.cookie.match(/(?:^|; )streamkit_theme=([^;]+)/)
  const value = match ? decodeURIComponent(match[1]) : 'system'
  return value === 'light' || value === 'dark' ? value : 'system'
}

function apply(theme: Theme) {
  const dark =
    theme === 'dark' ||
    (theme !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.classList.toggle('dark', dark)
}

export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('system')
  const [mounted, setMounted] = useState(false)

  // Read the cookie after mount, not during render: the server does not know it
  // and rendering a guess is a hydration mismatch.
  useEffect(() => {
    setTheme(readCookie())
    setMounted(true)
  }, [])

  const choose = (next: Theme) => {
    setTheme(next)
    document.cookie = `${COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`
    apply(next)
  }

  const Icon = theme === 'dark' ? Sun : theme === 'light' ? Moon : Monitor

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon" aria-label="Theme" className="text-muted-foreground" />}
      >
        {/* Before mount the server-rendered icon is a guess; the monitor is the
            neutral one, so the first frame does not claim a mode it may not be. */}
        {mounted ? <Icon /> : <Monitor />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => choose('light')}>Light</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => choose('dark')}>Dark</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => choose('system')}>System</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
