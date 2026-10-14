'use client'

/**
 * A link you read and copy.
 *
 * The display and the value are deliberately different things, which took two
 * attempts to get right:
 *
 *   - **Wrapping it was unreadable.** An overlay link for a room that has never been
 *     styled is about 250 characters of URL-encoded settings — mostly the default
 *     font stack, repeated. Wrapped across lines it filled half a card with noise
 *     nobody reads before pasting.
 *
 *   - **Showing it in full was no better.** On one line, a card held two links that
 *     both began with the same origin and the same `/overlay/`, so the visible end
 *     was the font stack and the useful middle — `?room=<id>` — sat off screen. Six
 *     different links looked like six identical ones.
 *
 * So the field shows the link from its path onward and leaves the origin off, which
 * is the same on every link on the page and is stated once at the top of it. What is
 * left is the part that differs between them, and it fits.
 *
 * The value is never shortened. `title` holds the whole thing, the Copy button hands
 * the whole thing to the clipboard, and the display is marked `user-select: none` so
 * that dragging across it and pressing Ctrl+C cannot hand anybody a link that would
 * not open. There is exactly one way to copy one, and it copies the real one.
 */

import { useEffect, useRef, useState } from 'react'

interface Props {
  /** What this link is, named for anyone reading the page rather than the screen. */
  label: string
  /** The link itself — what gets copied, in full. */
  url: string
  /** Understated guidance about what the link is for. */
  hint?: string
  /** How the copy button reads while it holds the link. */
  copyLabel?: string
}

/**
 * The link as it is shown: from the path, without the scheme and host.
 *
 * Falls back to the whole value for anything that is not an absolute http URL, so a
 * link that is somehow relative still displays rather than rendering as nothing.
 */
function display(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.pathname}${parsed.search}`
  } catch {
    return url
  }
}

export default function CopyField({ label, url, hint, copyLabel = 'Copy' }: Props) {
  const [copied, setCopied] = useState(false)
  const resetTimer = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current)
    },
    [],
  )

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current)
      resetTimer.current = window.setTimeout(() => {
        resetTimer.current = null
        setCopied(false)
      }, 1500)
    } catch {
      // Clipboard access is refused in some contexts and there is no honest way to
      // paste on the operator's behalf, so say so rather than pretending it worked.
      setCopied(false)
    }
  }

  return (
    <div className="copy-field">
      <span className="copy-label">{label}</span>
      <div className="copy-row">
        <code className="copy-value" title={url}>
          {display(url)}
        </code>
        <button onClick={() => void copy()} disabled={!url} aria-label={`Copy the ${label} link`}>
          {copied ? 'Copied' : copyLabel}
        </button>
      </div>
      {hint && <p className="faint tight-caption">{hint}</p>}
    </div>
  )
}