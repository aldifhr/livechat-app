'use client'

/**
 * The theme switch.
 *
 * One button that flips light ↔ dark on each click. Two states, one click, no
 * menu: there is no third answer to pick from, so a dropdown would be a menu
 * with one choice in it.
 *
 * On a first visit — no cookie yet — the page follows the OS preference, and the
 * first click pins the opposite of whatever is showing. Once pinned, the choice
 * is written to a cookie so the server can render the right class on the next
 * request, and applied to `<html>` here so the current page flips without a
 * reload.
 *
 * The icon shows what a click does next rather than the current state: a sun
 * while it is dark (click for light), a moon while it is light. That is the
 * convention a one-button switch has settled on, and the title spells it out.
 */

import { useEffect, useState } from 'react'
import { Moon, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { motion, AnimatePresence, useReducedMotion } from 'motion/react'

const COOKIE = 'streamkit_theme'
type Theme = 'light' | 'dark'

/** Whether the OS currently asks for dark. */
function osPrefersDark(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

/** The pinned choice, or null when none has been made yet. */
function readCookie(): Theme | null {
  if (typeof document === 'undefined') return null
  const match = document.cookie.match(/(?:^|; )streamkit_theme=([^;]+)/)
  const value = match ? decodeURIComponent(match[1]) : ''
  return value === 'light' || value === 'dark' ? value : null
}

export default function ThemeToggle() {
  // What is actually showing right now, resolved from the cookie or the OS.
  const [theme, setTheme] = useState<Theme>('light')
  const [mounted, setMounted] = useState(false)
  const reduced = useReducedMotion()

  // Resolve after mount, not during render: the server does not know the cookie
  // or the OS preference, and rendering a guess is a hydration mismatch.
  useEffect(() => {
    setTheme(readCookie() ?? (osPrefersDark() ? 'dark' : 'light'))
    setMounted(true)
  }, [])

  const flip = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    document.cookie = `${COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`
    document.documentElement.classList.toggle('dark', next === 'dark')
  }

  const Icon = theme === 'dark' ? Sun : Moon
  const label = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={flip}
      aria-label={mounted ? label : 'Theme'}
      title={mounted ? label : 'Theme'}
      className="text-muted-foreground"
    >
      {/* The icon swaps with a small rotate-and-fade rather than blinking, so a
          click reads as one control changing rather than two icons trading
          places. `mode="wait"` keeps the outgoing icon from overlapping the
          incoming one. */}
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={theme}
          initial={reduced ? { opacity: 0 } : { opacity: 0, rotate: -90, scale: 0.6 }}
          animate={{ opacity: 1, rotate: 0, scale: 1 }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, rotate: 90, scale: 0.6 }}
          transition={{ duration: reduced ? 0.12 : 0.2, ease: [0.22, 0.61, 0.36, 1] }}
          className="grid place-items-center"
        >
          <Icon />
        </motion.span>
      </AnimatePresence>
    </Button>
  )
}
