/**
 * The landing page.
 *
 * It says what the thing is and gets out of the way. No dashboard preview on the
 * front: a screenshot of somebody else's overlay tells a streamer less than the
 * two sentences below it, and it is the only thing on this page that would need
 * a token to load.
 */

export default function Landing({ onOpenAdmin }: { onOpenAdmin: () => void }) {
  return (
    <div className="landing">
      <header className="topbar">
        <span className="wordmark">
          Stream<span>Kit</span>
        </span>
        <nav>
          <button className="primary" onClick={onOpenAdmin}>
            Open the dashboard
          </button>
        </nav>
      </header>

      <main className="hero">
        <div>
          <h1>Live chat that looks like it belongs on stream.</h1>
          <p>
            Point OBS at a link, pick your colours, and the comments roll up the screen while you talk. No
            scene to build, no browser source to configure by hand.
          </p>
          <div className="hero-actions">
            <button className="primary" onClick={onOpenAdmin}>
              Build an overlay
            </button>
            <a href="https://kit-backend.aldifhr.my.id/topchatter/" target="_blank" rel="noreferrer">
              <button>See a live overlay</button>
            </a>
          </div>
        </div>
      </main>

      <section className="features">
        <div className="feature">
          <h3>Chat overlay</h3>
          <p>
            Comments, gifts and joins, styled with your colours and your font. The link is the whole
            configuration — read it back and you know what OBS was pointed at.
          </p>
        </div>
        <div className="feature">
          <h3>Top chatters</h3>
          <p>A leaderboard that counts who actually talked, so the busiest voice in the room is the one on screen.</p>
        </div>
        <div className="feature">
          <h3>Preview before you go live</h3>
          <p>
            The preview is the overlay itself in a box, not a screenshot of it. What you tune is what OBS
            loads.
          </p>
        </div>
        <div className="feature">
          <h3>Any machine</h3>
          <p>
            The overlay is served over the web, so the stream laptop can restart mid-show without taking the
            overlay with it.
          </p>
        </div>
      </section>

      <footer className="footer">
        <span>StreamKit</span>
        <span className="faint">Chat overlays for streaming.</span>
      </footer>
    </div>
  )
}