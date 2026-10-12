import OverlayBuilder from '@/sections/OverlayBuilder'

/**
 * The overlay builder.
 *
 * The room being styled lives in the query string rather than in component state,
 * which is what makes the URL shareable: the address bar on this page is the whole
 * style, and it is the same string the builder hands you for OBS. Opening it on
 * somebody else's screen shows what they are seeing rather than the defaults.
 *
 * The builder reads ?room= itself on mount rather than taking it as a prop, so
 * pasting a room id into this address works the same as clicking through to it.
 */
export default function OverlayBuilderPage() {
  return <OverlayBuilder />
}