/**
 * Pick the platform.
 *
 * The landing page says what this is; this page asks the one question that
 * decides everything after it. The two platforms want different input — a
 * TikTok handle, a YouTube video — so the form lives one level down, under the
 * platform, where its placeholder can be exact.
 *
 * Public: the connect route behind it carries no token, and the links it leads
 * to are the ones OBS loads with no credential.
 */

import Link from 'next/link'
import { productName } from '@/lib/server/config'

export const dynamic = 'force-dynamic'

const PLATFORMS = [
  { href: '/app/tiktok', name: 'TikTok', mark: '♪' },
] as const

export default function PickPlatform() {
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
        </section>
      </main>
    </div>
  )
}
