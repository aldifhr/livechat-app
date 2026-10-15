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
 * Streams has its own address, separate from the overview and the legacy /admin
 * entry point, so the selected section is clear in the URL.
 */
const ITEMS = [
  { href: '/admin/dashboard', label: 'Overview', icon: '◫', hint: 'Live status and viewers across streams', exact: false },
  { href: '/admin/streams', label: 'Streams', icon: '◉', hint: 'Links and styling for each stream', exact: true },
  { href: '/admin/overlay', label: 'Overlay builder', icon: '✦', hint: 'Restyle one stream in detail', exact: false },
  { href: '/admin/live-preview', label: 'Live preview', icon: '▣', hint: 'Watch it at OBS size', exact: false },
  { href: '/admin/logs', label: 'Logs', icon: '≡', hint: 'What the backend has been saying', exact: false },
  { href: '/admin/about', label: 'About', icon: '⚙', hint: 'Addresses and account', exact: false },
]

export default function Sidebar() {
  const pathname = usePathname()

  return (
    <>
      <nav>
        <p className="side-caption">Workspace</p>
        {ITEMS.map((item) => {
          // Exact matching for the Streams page prevents /admin from lighting it
          // up while sitting on Overview or another section.
          const active = item.exact ? pathname === item.href : pathname.startsWith(item.href)
          return (
            <Link
              key={item.href}
              href={item.href}
              className="side-item"
              aria-current={active ? 'page' : undefined}
            >
              <span className="nav-icon" aria-hidden="true">{item.icon}</span>
              {item.label}
            </Link>
          )
        })}
      </nav>
      <p className="side-note">
        {ITEMS.find((item) =>
          item.exact ? pathname === item.href : pathname.startsWith(item.href),
        )?.hint}
      </p>
    </>
  )
}
