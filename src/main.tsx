import React, { useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import Overlay from './components/Overlay'
import { host } from './lib/sidecar'
import './styles.css'

/**
 * Picks which of the two windows this is.
 *
 * Both load this same bundle — one webview, one bridge process, one set of frames
 * — but they render different things, so the label decides before anything is
 * mounted. Asked of the host rather than read off the window object so the
 * webview needs no window permission to find out its own name.
 */
function Root() {
  const [label, setLabel] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    // A browser run has no host to ask: the bundle is still the main window's.
    host
      .windowLabel()
      .then((value) => {
        if (active) setLabel(value)
      })
      .catch(() => {
        if (active) setLabel('main')
      })
    return () => {
      active = false
    }
  }, [])

  // Nothing until the answer comes back, rather than the main window flashing up
  // inside the overlay for a frame.
  if (label === null) return null
  return label === 'overlay' ? <Overlay /> : <App />
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
)