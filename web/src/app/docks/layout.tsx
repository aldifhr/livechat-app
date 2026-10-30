/**
 * The dock's own layout.
 *
 * A dock is an OBS browser source drawn over video, so the page behind it has to
 * be transparent — the console's cream background would show as a solid block
 * over the stream. The root layout sets a background on `body`; this overrides it
 * for the dock only, and the page itself paints nothing it does not have to.
 *
 * `color-scheme: light` because the dock's bubbles are light cards with black
 * borders, and a browser that assumed dark would render the scrollbars and form
 * controls against the wrong background.
 */
import type { ReactNode } from 'react'

export const dynamic = 'force-dynamic'

export default function DocksLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <style>{`html,body{background:transparent!important;color-scheme:light}`}</style>
      {children}
    </>
  )
}
