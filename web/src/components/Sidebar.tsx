/**
 * The navigation rail.
 *
 * A plain list of buttons rather than links to routes: the sections are views of
 * the same page, and a link implies somewhere you can be sent — a refresh, a
 * shared URL, a back button — none of which applies to a tab.
 */

/** The sections of the console. Declared here rather than imported from the page
 *  that switches between them, because both need the list of them and a type
 *  that lives in the consumer is a type the producer has to import back. */
export type Section = 'rooms' | 'overlay' | 'about'

const ITEMS: { id: Section; label: string; hint: string }[] = [
  { id: 'rooms', label: 'Rooms', hint: 'Streams on the backend' },
  { id: 'overlay', label: 'Overlay builder', hint: 'Style and preview' },
  { id: 'about', label: 'About', hint: 'Addresses and account' },
]

export default function Sidebar({
  section,
  onSelect,
}: {
  section: Section
  onSelect: (next: Section) => void
}) {
  return (
    <aside className="sidebar">
      <span className="wordmark">
        Stream<span>Kit</span>
      </span>
      <nav>
        {ITEMS.map((item) => (
          <button
            key={item.id}
            // The styling, including the selected state, is in the stylesheet.
            // aria-current is what says "this is the tab you are on" to assistive
            // tech and to the CSS alike, so the two never disagree.
            className="side-item"
            aria-current={section === item.id ? 'page' : undefined}
            onClick={() => onSelect(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <p className="side-note">
        {ITEMS.find((item) => item.id === section)?.hint}
        <br />
        <br />
        The overlay is served by the backend, so it keeps working when this dashboard is closed.
      </p>
    </aside>
  )
}