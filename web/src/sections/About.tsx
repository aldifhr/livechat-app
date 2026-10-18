'use client'

/**
 * Addresses and account.
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

import PasswordPanel from '@/components/PasswordPanel'
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

      <div className="panel">
        <h3>Password</h3>
        <p className="muted">
          This dashboard is behind a password, and this is where you change it. Changing it here changes the
          login on the server too — and signs out every device that was signed in with the old one, because
          the session is signed with the password itself.
        </p>
        <PasswordPanel />
      </div>

      <div className="panel">
        <h3>Who can write what</h3>
        <p className="muted">
          This dashboard is behind a password, and its own server attaches the backend's credential to the
          calls it forwards. The token is read from the server's environment at request time — it is not in
          the page, not in the bundle, and not in any NEXT_PUBLIC_ variable, so nothing here can be read by
          opening the source.
        </p>
        <p className="muted">
          The overlay pages are not behind the password, and the event stream they read is open too: OBS
          cannot present a credential, and an overlay that asked for one would show a password box on
          stream. That stream carries chat, gifts and viewer counts, and nothing that can change anything.
        </p>
      </div>
    </>
  )
}