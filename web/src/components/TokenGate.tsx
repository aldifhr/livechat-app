/**
 * Where the API token goes.
 *
 * Shown at the top of the console rather than behind a login screen, because the
 * token is not a login: reads on the backend are open, and a page that refuses to
 * render until a secret is typed looks locked while it is not — the room list is
 * already sitting there in the DOM behind it.
 *
 * It lives in sessionStorage, so closing the tab forgets it. That is deliberate:
 * a token that outlives the session on a shared machine is a token somebody else
 * gets to use.
 */

import { useState } from 'react'
import { hasToken, setToken, token } from '../lib/api'

export default function TokenGate() {
  const [value, setValue] = useState('')
  const [set, setIsSet] = useState(hasToken())

  return (
    <div className="panel">
      <div className="token-bar">
        <strong>API token</strong>
        {set ? (
          <>
            <span className="badge live">set for this tab</span>
            <input
              type="password"
              value={token()}
              placeholder="paste a new token to replace it"
              onChange={(event) => setValue(event.target.value)}
              autoComplete="off"
            />
            <button
              onClick={() => {
                setToken(value)
                setValue('')
                setIsSet(true)
              }}
              disabled={value === ''}
            >
              Replace
            </button>
            <button
              onClick={() => {
                setToken('')
                setValue('')
                setIsSet(false)
              }}
            >
              Forget
            </button>
          </>
        ) : (
          <>
            <input
              type="password"
              value={value}
              placeholder="x-streamkit-token — needed for changes, not for reading"
              onChange={(event) => setValue(event.target.value)}
              autoComplete="off"
              onKeyDown={(event) => {
                if (event.key === 'Enter' && value !== '') {
                  setToken(value)
                  setValue('')
                  setIsSet(true)
                }
              }}
            />
            <button
              className="primary"
              disabled={value === ''}
              onClick={() => {
                setToken(value)
                setValue('')
                setIsSet(true)
              }}
            >
              Save for this tab
            </button>
          </>
        )}
      </div>
      <p className="faint" style={{ margin: '0.6rem 0 0' }}>
        Kept in this tab only, never in the page bundle. Without it you can read rooms; with it you can create
        and delete them.
      </p>
    </div>
  )
}