/**
 * The two pages, and the little bit of routing between them.
 *
 * Hand-rolled rather than a router library: there are exactly two routes, the
 * paths are fixed, and the only reason to route at all is that /admin should have
 * a URL somebody can bookmark and paste into a browser. A library would be more
 * code than the thing it replaced.
 *
 * History is used rather than a hash so the URLs look like the rest of the web,
 * which means a refresh on /admin has to come back from the server — nginx falls
 * back to index.html for that.
 */

import { useEffect, useState } from 'react'
import Landing from './pages/Landing'
import Admin from './pages/Admin'

function currentPath(): string {
  return window.location.pathname.replace(/\/+$/, '') || '/'
}

export default function App() {
  const [path, setPath] = useState(currentPath)

  useEffect(() => {
    const onPop = () => setPath(currentPath())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  /** Navigating in-page, without a full load. */
  const go = (next: string) => {
    if (next === path) return
    window.history.pushState(null, '', next)
    setPath(next)
  }

  // A link that the browser handles, so it can be opened in a new tab and copied
  // as a real URL — which a div with an onClick cannot do.
  if (path === '/admin') return <Admin />
  return <Landing onOpenAdmin={() => go('/admin')} />
}