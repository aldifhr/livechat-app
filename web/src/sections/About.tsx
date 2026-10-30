'use client'

/**
 * Addresses.
 *
 * Exists so the domains are named in one place on the page. Someone who has to
 * work out whether a link belongs to the dashboard or the backend from the address
 * bar is being asked to guess, and guessing here means pasting the wrong address
 * into OBS.
 *
 * The overlay addresses come from this page's own origin rather than a constant,
 * because the pages are served by the same host that serves this — so there is one
 * domain to hand out and nothing to keep in step.
 */

import { useOrigin } from '@/hooks/useBrowser'

export default function About({ backend }: { backend?: string }) {
  // After mount rather than during render: the server has no window, and a
  // `typeof window` branch here means the addresses arrive with the wrong origins
  // and React throws the page away to rebuild it.
  const origin = useOrigin()

  // `href` only where there is something to open. The overlay addresses are for
  // pasting into OBS, and a click there would open a bare canvas in a tab rather
  // than do the thing the row is for — so those stay text, and the rows that lead
  // somewhere real are the ones that are links.
  const addresses: { label: string; value: string; href?: string }[] = [
    { label: 'This dashboard', value: origin },
    { label: 'Chat overlay (paste into OBS)', value: `${origin}/overlay/chat-overlay` },
  ]
  if (backend) {
    addresses.push({ label: 'Backend API', value: backend })
    // The sticker gallery has been served since the gifts were downloaded and
    // nothing linked it, so the only way to reach it was to know the path. It is a
    // page, not an API, so it opens in a tab.
    addresses.push({ label: 'Gift sticker gallery', value: `${backend}/gifts/`, href: `${backend}/gifts/` })
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h2>About</h2>
          <p className="muted">
            One domain for everything you paste, and the backend behind it. The overlays are served from here
            too, so a stream keeps them even when this dashboard is closed.
          </p>
        </div>
      </div>

      <div className="panel">
        <h3>Addresses</h3>
        {addresses.map((entry) => (
          <div className="row" key={entry.label}>
            <div className="grow">
              <div>{entry.label}</div>
              {entry.href ? (
                <a className="faint mono" href={entry.href} target="_blank" rel="noopener noreferrer">
                  {entry.value}
                </a>
              ) : (
                <div className="faint mono">{entry.value}</div>
              )}
            </div>
          </div>
        ))}
      </div>
    </>
  )
}