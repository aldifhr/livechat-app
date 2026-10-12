/**
 * Addresses and account.
 *
 * Exists so the two domains are named in one place on the page. A streamer who
 * has to work out whether a link belongs to the dashboard or the backend from the
 * address bar is being asked to guess, and guessing here means pasting a token
 * into the wrong box.
 */

import { API_BASE } from '../lib/api'

const ADDRESSES = [
  { label: 'This dashboard', value: window.location.origin },
  { label: 'Chat overlay (paste into OBS)', value: `${API_BASE}/overlay/` },
  { label: 'Top chatters overlay', value: `${API_BASE}/topchatter/` },
  { label: 'Backend API', value: API_BASE },
]

export default function About() {
  return (
    <>
      <div className="page-head">
        <div>
          <h2>About</h2>
          <p className="muted" style={{ margin: 0 }}>
            Two addresses, two jobs. The dashboard is yours; the overlays belong to the backend so they keep
            working when this page is closed.
          </p>
        </div>
      </div>

      <div className="panel">
        <h3>Addresses</h3>
        {ADDRESSES.map((entry) => (
          <div className="row" key={entry.label}>
            <div className="grow">
              <div>{entry.label}</div>
              <div className="faint mono">{entry.value}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="panel">
        <h3>Reading and writing</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          The backend's read routes are open, which is what lets OBS load an overlay with no credential at
          all. Its write routes need the API token, which is held in this tab only and never sent anywhere
          except as a header on those calls.
        </p>
      </div>
    </>
  )
}