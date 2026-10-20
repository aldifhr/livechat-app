/**
 * Pick the platform first.
 *
 * Two buttons, stacked, each with its own background. The connection form asks
 * for a different thing on each platform — a TikTok handle, a YouTube video — so
 * one box with a dropdown makes the operator choose a format before they have
 * chosen a platform, and the placeholder has to guess. A page per platform lets
 * each form say exactly what it wants.
 *
 * Public, like `/docks`: the connect route behind it has no session and no
 * token, and the overlays it hands out are public by design. Putting a login in
 * front of this would be a login in front of a link OBS has to load.
 */

import Link from 'next/link'
import { productName } from '@/lib/server/config'

export const dynamic = 'force-dynamic'

const PLATFORMS = [
  { href: '/app/youtube', name: 'YouTube', mark: '▶' },
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
          <Link href="/">Home</Link>
        </nav>
      </header>

      <main className="landing-main">
        <section className="app-pick">
          <p className="eyebrow"><span className="live-dot" /> New overlay</p>
          <h1>Choose your <span>platform.</span></h1>

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
