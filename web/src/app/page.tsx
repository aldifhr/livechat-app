import Link from 'next/link'
import { productName, splitWordmark, tagline } from '@/lib/config'

// Per request, for the same reason as /admin: the name and the copy come from
// the environment, and a prerendered page would freeze them at build time.
export const dynamic = 'force-dynamic'

const FEATURES = [
  {
    title: 'Chat overlay',
    body: 'Comments, gifts and joins, styled with your colours and your font. The link is the whole configuration — read it back and you know what OBS was pointed at.',
  },
  {
    title: 'Top chatters',
    body: 'A leaderboard that counts who actually talked, so the busiest voice in the room is the one on screen.',
  },
  {
    title: 'Preview before you go live',
    body: 'The preview is the overlay itself in a box, not a screenshot of it. What you tune is what OBS loads.',
  },
  {
    title: 'Any machine',
    body: 'The overlay is served over the web, so the stream laptop can restart mid-show without taking the overlay with it.',
  },
]

/**
 * The landing page. A server component: there is nothing here that needs the
 * browser, so shipping no JavaScript for it is the point.
 */
export default function Landing() {
  const [head, tail] = splitWordmark(productName)

  return (
    <div className="landing">
      <header className="topbar">
        <span className="wordmark">
          {head}
          {tail && <span>{tail}</span>}
        </span>
        <nav>
          {/* A real link, so the console has an address that can be bookmarked,
              opened in a new tab and pasted — none of which a button can do. */}
          <Link className="cta" href="/admin">
            Open the dashboard
          </Link>
        </nav>
      </header>

      <main className="hero">
        <div>
          <h1>Live chat that looks like it belongs on stream.</h1>
          {tagline && <p>{tagline}</p>}
          <p>
            Point OBS at a link, pick your colours, and the comments roll up the screen while you talk. No
            scene to build, no browser source to configure by hand.
          </p>
          <div className="hero-actions">
            <Link className="cta primary" href="/admin">
              Build an overlay
            </Link>
            <a className="cta" href="/overlay/" target="_blank" rel="noreferrer">
              See a live overlay
            </a>
          </div>
        </div>
      </main>

      <section className="features">
        {FEATURES.map((feature) => (
          <div className="feature" key={feature.title}>
            <h3>{feature.title}</h3>
            <p>{feature.body}</p>
          </div>
        ))}
      </section>

      <footer className="footer">
        <span>{productName}</span>
        <span className="faint">Chat overlays for streaming.</span>
      </footer>
    </div>
  )
}