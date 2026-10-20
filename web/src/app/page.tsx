/**
 * The landing page is the platform picker.
 *
 * It used to be a marketing page: two feature cards, three benefits, a mock
 * overlay, and two buttons that both led to a login. Nobody arriving here wanted
 * a pitch — they wanted a chat overlay — and the thing that produces one is
 * `/app`. So `/` renders the same choice directly, and the pitch is gone rather
 * than moved, because a page whose only call to action is "sign in" is not what
 * this site is for.
 *
 * The dashboard is still at `/admin` for styling, analytics and giveaways; the
 * picker links there once, for anyone who came to manage a stream they already
 * have.
 */

import Link from 'next/link'
import { productName } from '@/lib/server/config'

export const dynamic = 'force-dynamic'

const PLATFORMS = [
  { href: '/app/youtube', name: 'YouTube', mark: '▶' },
  { href: '/app/tiktok', name: 'TikTok', mark: '♪' },
] as const

export default function Landing() {
  return (
    <div className="landing">
      <header className="landing-header">
        <Link href="/" className="landing-brand" aria-label={`${productName} home`}>
          <span className="brand-symbol" aria-hidden="true">S</span>
          <span className="landing-wordmark">{productName}</span>
        </Link>
        <nav className="landing-nav" aria-label="Main navigation">
          <Link href="/admin/streams">Dashboard</Link>
        </nav>
      </header>

      <main className="landing-main">
        <section className="app-pick">
          <p className="eyebrow"><span className="live-dot" /> New overlay</p>
          <h1>Choose your <span>platform.</span></h1>
          <p className="muted">
            Connect one stream and copy its browser source link into OBS.
          </p>

          <div className="platform-pick">
            {PLATFORMS.map((platform) => (
              <Link key={platform.href} href={platform.href} className="platform-btn">
                <span className="platform-mark" aria-hidden="true">{platform.mark}</span>
                <span>{platform.name}</span>
                <span className="platform-go" aria-hidden="true">→</span>
              </Link>
            ))}
          </div>

          <p className="faint tight-caption">
            Already have a stream? <Link href="/admin/streams">Style it in the dashboard</Link>.
          </p>
        </section>
      </main>
    </div>
  )
}
