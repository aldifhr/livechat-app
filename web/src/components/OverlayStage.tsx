'use client'

/**
 * The real overlay, shown at the size OBS will show it.
 *
 * An iframe of the actual page rather than a picture of it, so what is watched here
 * is exactly what OBS will load — including the socket, the comments, and the live
 * styling the room pushes into it. Pointed at by room alone, so a slider moved in
 * the builder changes this without anything being re-pointed.
 *
 * The scaling is the whole reason this is its own component. Two things have to be
 * true at once, and the obvious version gets the first one right by breaking the
 * second:
 *
 *   1. Nothing is clipped. A ten-row leaderboard at 28px is ~580px tall, and a frame
 *      locked to `aspect-ratio: 16 / 9` cuts the last row off with no scrollbar and
 *      no error — which reads as a broken overlay rather than as a frame too short
 *      for it.
 *   2. The whole overlay is visible at once, without scrolling. A preview you have
 *      to scroll to see the bottom of is not a preview of what OBS shows; it is a
 *      preview of the top of it, which is the thing the fixed rectangle was meant
 *      to settle.
 *
 * Growing the frame to its natural height satisfies (1) and fails (2). So the frame
 * is laid out at its full height and then scaled down to fit the space it has: every
 * row is present in the box, and the box is small enough to be seen whole. That is
 * what a browser source is too — OBS scales the page into whatever rectangle the
 * operator drew, and this does the same thing.
 *
 * The scale is measured against the VIEWPORT, not against the frame element. A
 * ResizeObserver on the frame cannot give the width the scale needs: the frame's
 * width comes from its parent and its height comes from the iframe it contains, so
 * the measurement the transform is computed from would depend on the transform — the
 * observer would be measuring the thing it is meant to size. The viewport is
 * upstream of all of it and stable.
 */

import { useEffect, useState } from 'react'

interface Props {
  /** The overlay's address. Empty renders nothing rather than an empty frame. */
  url: string
  /** What this frame is, for anybody reading the page rather than the screen. */
  title: string
  /**
   * The tallest the frame may be, in pixels, before it is scaled down.
   *
   * A share of the window when this page is the subject; a fixed height when it is
   * sitting beside controls, where the space is whatever the layout left over.
   */
  maxHeight: number
}

export default function OverlayStage({ url, title, maxHeight }: Props) {
  const [reportedHeight, setReportedHeight] = useState<number | null>(null)

  // A new overlay is a new height; the old one belongs to the page being left.
  useEffect(() => {
    setReportedHeight(null)
    function onMessage(event: MessageEvent) {
      // Any origin: this is a preview of a page this dashboard itself served, and
      // the only thing taken from the message is a number that is clamped before it
      // is used as a height.
      const height = (event.data as { streamkitHeight?: unknown } | null)?.streamkitHeight
      if (typeof height === 'number' && Number.isFinite(height) && height > 0) {
        setReportedHeight(Math.min(Math.ceil(height), 4000))
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [url])

  if (!url) return null

  const ceiling = Math.max(220, maxHeight)

  const scale =
    reportedHeight === null
      ? 1
      : // Only ever shrinks: an overlay shorter than the space is shown at its real
        // size, because scaling a 200px chat up to fill a 520px frame would be
        // previewing a font size nobody chose.
        Math.min(1, ceiling / reportedHeight)

  const frameStyle =
    reportedHeight === null
      ? undefined
      : {
          // The full height, then scaled: the frame is laid out whole and the
          // transform only changes how much of the page it occupies.
          height: `${reportedHeight}px`,
          transform: `scale(${scale})`,
          transformOrigin: 'top left',
        }

  // The space the scaled frame actually occupies, so whatever sits below it is not
  // left reserving the untransformed height.
  const occupied = reportedHeight === null ? undefined : Math.round(reportedHeight * scale)

  return (
    <div className="preview-stage" style={occupied ? { height: `${occupied}px` } : undefined}>
      <iframe src={url} title={title} style={frameStyle} />
    </div>
  )
}