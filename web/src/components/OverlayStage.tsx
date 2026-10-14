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

import { useEffect, useRef, useState } from 'react'

interface Props {
  /** The overlay's address. Empty renders nothing rather than an empty frame. */
  url: string
  /** What this frame is, for anybody reading the page rather than the screen. */
  title: string
  /**
   * How the frame is sized.
   *
   * `canvas` is a fixed rectangle, which is what a browser source is: the box does
   * not change when messages arrive, so the overlay grows inside it the way it
   * grows on a stream. `fit` is the frame that grows to its content and scales
   * itself down to be seen whole.
   *
   * They answer different questions and one of them is wrong in each context.
   * Beside a form, `fit` is wrong: a quiet chat reported 60px, so the frame became
   * 60px inside a stage with a 520px floor — a small white strip floating in a
   * black box — and then grew to three quarters of the panel as the room warmed
   * up. The box was reporting the content instead of standing still while the
   * content moved. `canvas` keeps the rectangle fixed and lets the overlay do
   * exactly what it does on a stream.
   *
   * Full screen, `canvas` is wrong: judging whether a ten-row leaderboard fits
   * means seeing all of it at once, and a fixed rectangle clips it.
   */
  variant?: 'canvas' | 'fit'
  /** The tallest a `fit` frame may be before it is scaled down. */
  maxHeight?: number
  /** The canvas a `canvas` frame represents, in CSS pixels. */
  canvas?: { width: number; height: number }
}

/** OBS's default stream canvas. */
const DEFAULT_CANVAS = { width: 1920, height: 1080 }

export default function OverlayStage({
  url,
  title,
  variant = 'fit',
  maxHeight = 520,
  canvas = DEFAULT_CANVAS,
}: Props) {
  const [reportedHeight, setReportedHeight] = useState<number | null>(null)
  const [boxWidth, setBoxWidth] = useState(0)
  const box = useRef<HTMLDivElement | null>(null)

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

  // The canvas variant needs the box's width to know how far to scale the canvas
  // down. Measured on the box rather than the window, because the box is what the
  // panel layout decided: it changes when the window does not — the sidebar moving
  // from beside it to above it is enough.
  useEffect(() => {
    const node = box.current
    if (!node || variant !== 'canvas') return
    const observer = new ResizeObserver(() => setBoxWidth(node.clientWidth))
    observer.observe(node)
    setBoxWidth(node.clientWidth)
    return () => observer.disconnect()
  }, [variant])

  if (!url) return null

  // Both variants show the page rather than composite it, and a page with a
  // transparent body still gets an opaque base from the browser. Asking the page
  // for a backdrop is the only thing that reaches it: an iframe element's own
  // background is ignored, verified rather than assumed, so there is nothing to
  // set from out here.
  const staged = new URL(url)
  staged.searchParams.set('backdrop', 'dark')
  const framed = staged.toString()

  if (variant === 'canvas') {
    // The canvas at its real pixel size, scaled into the box. The overlay page
    // fills its iframe the way it fills a browser source — `html, body { height:
    // 100% }` — so the iframe being canvas-sized is what makes the box stand still
    // while messages arrive underneath it.
    const scale = boxWidth > 0 ? boxWidth / canvas.width : 1
    return (
      <div
        className="preview-canvas"
        ref={box}
        style={{ aspectRatio: `${canvas.width} / ${canvas.height}` }}
      >
        <div
          className="preview-canvas-inner"
          style={{
            width: `${canvas.width}px`,
            height: `${canvas.height}px`,
            transform: `scale(${scale})`,
          }}
        >
          <iframe src={framed} title={title} />
        </div>
      </div>
    )
  }

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
      <iframe src={framed} title={title} style={frameStyle} />
    </div>
  )
}