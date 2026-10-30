/**
 * The console's navigation, in one place.
 *
 * The sidebar and the command palette both read from here, so an address is
 * written once and a section cannot be in one and missing from the other. The
 * icons are lucide names rather than glyphs: the sidebar sets them in a rounded
 * tile and the palette in a menu row, and a text character cannot be sized or
 * coloured the way either needs.
 *
 * There is one platform, so the addresses carry no platform segment — the console
 * is the root, and a stream lives at `/stream/@handle`.
 */

import type { LucideIcon } from 'lucide-react'
import {
  LayoutDashboard,
  Radio,
  BarChart3,
  Gift,
  ScrollText,
  Info,
} from 'lucide-react'

export type NavItem = {
  href: string
  label: string
  icon: LucideIcon
  /** Shown under the label in the command palette. */
  hint: string
}

/** The sections of the console, in the order they are shown. */
export function navItems(): NavItem[] {
  return [
    { href: '/dashboard', label: 'Overview', icon: LayoutDashboard, hint: 'Live status and viewers' },
    { href: '/streams', label: 'Streams', icon: Radio, hint: 'Links and styling for each stream' },
    { href: '/analytics', label: 'Analytics', icon: BarChart3, hint: 'Session totals across streams' },
    { href: '/giveaways', label: 'Giveaways', icon: Gift, hint: 'Published giveaway snapshots' },
    { href: '/logs', label: 'Logs', icon: ScrollText, hint: 'What the backend has been saying' },
    { href: '/about', label: 'About', icon: Info, hint: 'Addresses and the dashboard password' },
  ]
}
