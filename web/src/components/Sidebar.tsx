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
 * entry point, so the selected section is clear in the URL. A stream's own page
 * sits under it, and matching is on path segments so that page counts as Streams.
 */
type Item = {
  href: string
  label: string
  icon: string
  hint: string
}

const SECTIONS = {
  overview: { label: 'Overview', icon: '◫', hint: 'Live status and viewers across streams' },
  streams: { label: 'Streams', icon: '◉', hint: 'Links and styling for each stream' },
  logs: { label: 'Logs', icon: '≡', hint: 'What the backend has been saying' },
  analytics: { label: 'Analytics', icon: '▥', hint: 'Session totals across every stream' },
  giveaways: { label: 'Giveaways', icon: '◈', hint: 'Published giveaway snapshots' },
} as const

/** The platform a `/app/<platform>/...` address belongs to, if it is one. */
const PLATFORMS = ['tiktok', 'youtube'] as const

export default function Sidebar() {
  const pathname = usePathname()
  const segments = pathname.split('/').filter(Boolean)
  const platform =
    segments[0] === 'app' && (PLATFORMS as readonly string[]).includes(segments[1] ?? '')
      ? segments[1]
      : null
  // The platform pages live at `/app/<platform>`, so their Overview and Streams
  // are addresses under it. Logs, analytics and giveaways are account-wide rather
  // than per stream, so they stay at `/admin`.
  const base = platform ? `/app/${platform}` : '/admin'

  // A platform page shows its own Overview, Streams, Analytics and Giveaways.
  // The admin console currently exposes only Logs; the rest of its sections are
  // still being moved to the platform addresses, so a sidebar entry to a page
  // that is not ready yet is worse than no entry.
  const ITEMS: Item[] = platform
    ? [
        { href: base, ...SECTIONS.overview },
        { href: `${base}/streams`, ...SECTIONS.streams },
        { href: `${base}/analytics`, ...SECTIONS.analytics },
        { href: `${base}/giveaways`, ...SECTIONS.giveaways },
      ]
    : [{ href: '/admin/logs', ...SECTIONS.logs }]

  return (
    <>
      <nav>
        <p className="side-caption">Workspace</p>
        {ITEMS.map((item) => {
          // Prefix matching, so a stream's own page at /admin/streams/@handle still
          // lights Streams up. `/admin` does not match it — the section is longer
          // than the entry point that redirects into it — so the legacy address
          // cannot light this up while another section is on screen.
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`)
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
        {ITEMS.find((item) => pathname === item.href || pathname.startsWith(`${item.href}/`))
          ?.hint}
      </p>
    </>
  )
}
