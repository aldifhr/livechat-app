import LivePreview from '@/sections/LivePreview'

/**
 * The live preview, on its own address.
 *
 * Separate from the builder because a preview is watched, not edited: it belongs
 * on a second screen at the size OBS will actually render, which is a window you
 * navigate to rather than a panel beside a form. The builder links here with the
 * current style already in the query string, so arriving here shows exactly what
 * the link you would paste into OBS produces.
 */
export default function LivePreviewPage() {
  return <LivePreview />
}