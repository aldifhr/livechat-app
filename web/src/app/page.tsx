import Link from 'next/link'
import { productName, splitWordmark, tagline } from '@/lib/server/config'
import Reveal from '@/components/Reveal'

export const dynamic = 'force-dynamic'

const FEATURES = [
  {
    index: '01',
    title: 'Chat overlay',
    body: 'Show comments, joins, and gifts in a stream-ready layout. Tune the size, colors, and pace to fit your scene.',
    mark: 'Aa',
  },
  {
    index: '02',
    title: 'Top chatters',
    body: 'Give active viewers a place on screen with a live leaderboard that follows the conversation.',
    mark: '↗',
  },
]

const BENEFITS = [
  { title: 'Preview before you go live', body: 'See the actual overlay while you adjust it.' },
  { title: 'One link for OBS', body: 'Copy a browser source link and keep it when you restyle.' },
  { title: 'Works across devices', body: 'Your overlays are served from the web.' },
]

export default function Landing() {
  const [head, tail] = splitWordmark(productName)

  return (
    <div className="landing" id="top">
      <header className="landing-header">
        <Link href="/" className="landing-brand" aria-label={`${productName} home`}>
          <span className="brand-symbol" aria-hidden="true">S</span>
          <span className="landing-wordmark">{head}{tail && <span>{tail}</span>}</span>
        </Link>
        <nav className="landing-nav" aria-label="Main navigation">
          <a href="#features">Features</a>
          <Link href="/app">App <span aria-hidden="true">↗</span></Link>
        </nav>
      </header>

      <main className="landing-main">
        <section className="landing-hero">
          <div className="landing-copy">
            <Reveal>
              <p className="eyebrow"><span className="live-dot" /> Live chat tools for creators</p>
            </Reveal>
            <Reveal delay={0.06}>
              <h1>Make your live chat part of the <span>show.</span></h1>
            </Reveal>
            <Reveal delay={0.13}>
              <div className="landing-description">
                {tagline && <p className="landing-tagline">{tagline}</p>}
                <p>Bring comments and top chatters into your stream with overlays you can style and preview before going live.</p>
              </div>
              <div className="landing-actions">
                <Link href="/app" className="btn primary landing-primary">
                  Set up your overlays <span aria-hidden="true">↗</span>
                </Link>
                <a href="#features" className="landing-secondary">Explore features <span aria-hidden="true">↓</span></a>
              </div>
              <div className="landing-proof" aria-label="Three setup steps">
                <span><b>01</b> Connect a stream</span>
                <span><b>02</b> Copy into OBS</span>
                <span><b>03</b> Go live</span>
              </div>
            </Reveal>
          </div>

          <Reveal className="landing-visual-wrap" delay={0.18}>
            <div className="landing-visual-glow" aria-hidden="true" />
            <div className="overlay-mock" aria-label="Example chat overlay preview">
              <div className="mock-topbar">
                <div className="mock-window-dots" aria-hidden="true"><i /><i /><i /></div>
                <span>OVERLAY PREVIEW</span>
                <span className="mock-live"><span className="live-dot" /> LIVE</span>
              </div>
              <div className="mock-stream">
                <div className="mock-message">
                  <span className="mock-avatar avatar-a">J</span>
                  <span><b>jules</b><small>this is so good ✨</small></span>
                </div>
                <div className="mock-message">
                  <span className="mock-avatar avatar-b">M</span>
                  <span><b>mika</b><small>hello from the chat!</small></span>
                </div>
                <div className="mock-event"><span aria-hidden="true">✦</span> alex sent a gift</div>
              </div>
              <div className="mock-footer"><span className="mock-footer-mark" /> Chat overlay <span className="mock-pulse">●</span></div>
            </div>
            <p className="visual-caption">A clear, customizable view of your live chat.</p>
          </Reveal>
        </section>

        <section id="features" className="landing-features">
          <div className="section-intro">
            <div>
              <p className="eyebrow">Everything in one place</p>
              <h2>From setup to stream, <span>keep it simple.</span></h2>
            </div>
            <p>One dashboard for the links, styling, and preview you need to get your overlays on screen.</p>
          </div>
          <div className="feature-grid">
            {FEATURES.map((feature, i) => (
              <Reveal key={feature.index} inView delay={i * 0.08}>
                <article className="feature-card">
                  <div className="feature-card-top"><span>{feature.index}</span><span className="feature-mark" aria-hidden="true">{feature.mark}</span></div>
                  <h3>{feature.title}</h3>
                  <p>{feature.body}</p>
                </article>
              </Reveal>
            ))}
          </div>
        </section>

        <section className="landing-benefits" aria-label="More features">
          {BENEFITS.map((item, i) => (
            <article key={item.title}>
              <span className="benefit-index">0{i + 3}</span>
              <div><h3>{item.title}</h3><p>{item.body}</p></div>
            </article>
          ))}
        </section>

        <section className="landing-cta">
          <div>
            <p className="eyebrow">Ready when you are</p>
            <h2>Your next stream starts <span>here.</span></h2>
          </div>
          <Link href="/app" className="btn primary landing-primary">
            Connect a stream <span aria-hidden="true">↗</span>
          </Link>
        </section>
      </main>

      <footer className="landing-footer">
        <span className="landing-wordmark">{head}{tail && <span>{tail}</span>}</span>
        <span>{tagline || 'Live chat overlays, made clear.'}</span>
        <a href="#top">Back to top ↑</a>
      </footer>
    </div>
  )
}
