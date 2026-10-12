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

export default function About({ backend }: { backend?: string }) {
  // Read during render rather than at module scope: `window` does not exist when
  // this module is first evaluated on the server.
  const origin = typeof window === 'undefined' ? '' : window.location.origin

  const addresses = [
    { label: 'This dashboard', value: origin },
    { label: 'Chat overlay (paste into OBS)', value: `${origin}/overlay/chat-overlay` },
    { label: 'Top chatters overlay', value: `${origin}/overlay/top-chatter` },
  ]
  if (backend) addresses.push({ label: 'Backend API', value: backend })

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
              <div className="faint mono">{entry.value}</div>
            </div>
          </div>
        ))}
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
          The overlay pages are behind the same password, but the event stream they read is not: OBS cannot
          present a credential, and an overlay that asked for one would show a password box on stream. That
          stream carries chat, gifts and viewer counts, and nothing that can change anything.
        </p>
      </div>
    </>
  )
}