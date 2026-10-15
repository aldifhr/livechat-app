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
import type { OverlayStyle } from '@shared/overlay'

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
  /** Unsaved chat style to apply immediately in the preview iframe. */
  previewStyle?: OverlayStyle
}

/** OBS's default stream canvas. */
const DEFAULT_CANVAS = { width: 1920, height: 1080 }

export default function OverlayStage({
  url,
  title,
  variant = 'fit',
  maxHeight = 520,
  canvas = DEFAULT_CANVAS,
  previewStyle,
}: Props) {
  const [reportedHeight, setReportedHeight] = useState<number | null>(null)
  const [boxWidth, setBoxWidth] = useState(0)
  const row = useRef<HTMLDivElement | null>(null)
  const frame = useRef<HTMLIFrameElement | null>(null)

  const syncPreviewStyle = () => {
    if (!previewStyle) return
    frame.current?.contentWindow?.postMessage(
      {
        streamkitPreviewStyle: {
          size: previewStyle.size,
          nameColour: previewStyle.nameColour,
          textColour: previewStyle.textColour,
          background: previewStyle.bg,
          max: previewStyle.max,
          delay: previewStyle.delay,
          font: previewStyle.font,
          position: previewStyle.position,
          maxWidth: previewStyle.maxWidth,
          bubbleOpacity: previewStyle.bubbleOpacity,
          giftColour: previewStyle.giftColour,
        },
      },
      window.location.origin,
    )
  }

  useEffect(() => {
    syncPreviewStyle()
  }, [previewStyle])

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

  // How far to scale the canvas down, measured on the ROW that holds it.
  //
  // Not on the canvas, and that is not a detail: the canvas is sized from this
  // number, so measuring it is a feedback loop. Each observation returns the
  // already-scaled width, which produces the next, smaller scale — observed
  // shrinking 492, 344, 198, 52 as a canvas that never changed. The row's width
  // comes from the layout around it and does not depend on the answer.
  //
  // Measured on the row rather than the window for the same reason the builder
  // has its own: the space beside the controls is not the window. It changes when
  // the window does not — the sidebar moving from beside it to above it is enough.
  useEffect(() => {
    const node = row.current
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
    // Fits both ways, not just by width. Constraining to the width alone is right
    // for a landscape canvas in a wide panel and wrong for a vertical one: a
    // 1080x1920 canvas scaled to a 490px column comes out 870px tall, which pushes
    // the controls it sits beside off the page.
    const scale =
      boxWidth > 0 ? Math.min(boxWidth / canvas.width, maxHeight / canvas.height) : 1
    return (
      <div className="preview-canvas-row" ref={row}>
        <div
          className="preview-canvas"
          style={{
            width: `${Math.round(canvas.width * scale)}px`,
            height: `${Math.round(canvas.height * scale)}px`,
          }}
        >
          <div
            className="preview-canvas-inner"
            style={{
              width: `${canvas.width}px`,
              height: `${canvas.height}px`,
              transform: `scale(${scale})`,
            }}
          >
            <iframe ref={frame} src={framed} title={title} onLoad={syncPreviewStyle} />
          </div>
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
      <iframe ref={frame} src={framed} title={title} style={frameStyle} onLoad={syncPreviewStyle} />
    </div>
  )
}
