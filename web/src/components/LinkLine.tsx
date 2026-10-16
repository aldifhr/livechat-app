'use client'

/**
 * A link you copy without reading.
 *
 * The card this was made for had three of these showing their links in full, each
 * wrapping across three lines of monospace, so the loudest thing on every card was
 * a room id. A room id is the one part of an overlay link nobody reads: it is
 * identical on all three links for that stream, it differs only between streams,
 * and the operator pastes the whole thing into OBS without looking at it. Three
 * blocks of it said "these cards are made of links" and nothing else.
 *
 * So the URL is not shown here — but it is not removed either. The card keeps all
 * three behind one disclosure for the times it genuinely does need reading, and the
 * button hands over the whole link, never a shortened view of one.
 *
 * Which is the reason the label is a label and not a target: there is exactly one
 * way to copy a link here, and it copies the real one.
 */

import { useCopy } from '@/lib/useCopy'

interface Props {
  /** What this link is, named for anyone reading the page rather than the screen. */
  label: string
  /** The link itself — what gets copied, in full. */
  url: string
}

export default function LinkLine({ label, url }: Props) {
  const { copied, copy } = useCopy()

  return (
    <div className="link-line">
      <span className="link-line-label">{label}</span>
      <button onClick={() => void copy(url)} disabled={!url} aria-label={`Copy the ${label} link`}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}
