'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

/**
 * The console's navigation.
 *
 * Each item is a real address rather than a piece of component state. That is the
 * whole difference between this and a set of buttons: an address can be copied,
 * pasted into a chat, bookmarked, and reached with the back button. A streamer who
 * sends somebody "the overlay builder for my room" can send a link, and it opens
 * on that room — with a button there is no such thing as a link.
 *
 * The active item is read from the URL, so it cannot drift from what is on screen:
 * there is no second copy of "where am I" to fall out of sync.
 *
 * "Rooms" is the index of this layout rather than /admin/rooms, so the address of
 * the console's home is the address you land on after signing in.
 */
const ITEMS = [
  { href: '/admin', label: 'Rooms', hint: 'Streams on the backend', exact: true },
  { href: '/admin/overlay', label: 'Overlay builder', hint: 'Style and preview', exact: false },
  { href: '/admin/about', label: 'About', hint: 'Addresses and account', exact: false },
]

export default function Sidebar() {
  const pathname = usePathname()

  return (
    <>
      <nav>
        {ITEMS.map((item) => {
          // Exact matching only for the index: without it /admin would light up
          // while sitting on /admin/overlay, and the sidebar would claim you are
          // somewhere you are not.
          const active = item.exact ? pathname === item.href : pathname.startsWith(item.href)
          return (
            <Link
              key={item.href}
              href={item.href}
              className="side-item"
              aria-current={active ? 'page' : undefined}
            >
              {item.label}
            </Link>
          )
        })}
      </nav>
      <p className="side-note">
        {ITEMS.find((item) => pathname === item.href || pathname.startsWith(item.href))?.hint}
        <br />
        <br />
        The overlay is served over the web, so it keeps working when this dashboard is closed.
      </p>
    </>
  )
}