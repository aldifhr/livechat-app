'use client'

/**
 * One heading per console page, visually hidden.
 *
 * The console's visible titles are rendered by each section as h2/h3, which
 * reads fine on screen but leaves the document outline without an h1. Screen
 * readers and heading-based navigation need one. The Excel editor already
 * renders its own visible h1, so it is excluded here rather than given a
 * duplicate.
 */

import { usePathname } from 'next/navigation'

const TITLES: Array<[RegExp, string]> = [
  [/^\/dashboard/, 'Overview'],
  [/^\/streams/, 'Streams'],
  [/^\/logs/, 'Backend log'],
  [/^\/setting\/change-password/, 'Change password'],
  [/^\/about/, 'About StreamKit'],
  [/^\/admin/, 'Console'],
  [/^\/stream\/[^/]+\/overlay\//, 'Overlay builder'],
  [/^\/stream\//, 'Stream'],
]

export default function ConsoleHeading() {
  const pathname = usePathname() || ''
  if (pathname.includes('/excel-text')) return null
  const title = TITLES.find(([pattern]) => pattern.test(pathname))?.[1] ?? 'StreamKit console'
  return <h1 className="sr-only">{title}</h1>
}
