/**
 * The dashboard for one stream.
 *
 * What the operator came for after connecting: the chat on screen, and every
 * overlay link for it. It replaced "here is a URL, go find the page that manages
 * it" — the connect form used to end on a single chat link, which is one of five
 * overlays and none of the styling.
 *
 * The room comes from `?room=`, because that is what the connect step knows and
 * what every other link in the product already carries. The platform segment in
 * the path is for the person reading the address bar, not for the page: the room
 * record says which platform it reads, and a second source of truth in the URL
 * can only disagree with it.
 */

'use client'

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Suspense, useEffect, useState } from 'react'
import { api } from '@/lib/client/api'
import { streamLinks, LINK_LABELS } from '@/lib/client/streamLinks'
import { profilePath } from '@/lib/client/streamLinks'
import type { Room, StreamProvider } from '@/lib/types'

function Dashboard({ provider }: { provider: StreamProvider }) {
  const params = useSearchParams()
  const roomId = params.get('room') || ''
  const [room, setRoom] = useState<Room | null>(null)
  const [copied, setCopied] = useState('')

  useEffect(() => {
    if (!roomId) return
    // Read the room rather than trusting the URL: this is where its handle and
    // name come from, and the dashboard link to the stream's styling page needs
    // the handle to build a stable address.
    api.rooms()
      .then(({ rooms }) => setRoom(rooms.find((r) => r.id === roomId) ?? null))
      .catch(() => setRoom(null))
  }, [roomId])

  if (!roomId) {
    return (
      <div className="landing">
        <main className="landing-main">
          <section className="app-pick">
            <h1>No stream <span>selected.</span></h1>
            <p className="muted">Connect one first.</p>
            <div className="app-actions">
              <Link className="btn primary" href="/app">Connect a stream</Link>
            </div>
          </section>
        </main>
      </div>
    )
  }

  const links = streamLinks(roomId)

  const copy = (label: string, url: string) => {
    void navigator.clipboard.writeText(url)
    setCopied(label)
    window.setTimeout(() => setCopied(''), 1500)
  }

  return (
    <div className="landing">
      <header className="landing-header">
        <Link href="/" className="landing-brand" aria-label="Home">
          <span className="brand-symbol" aria-hidden="true">S</span>
          <span className="landing-wordmark">StreamKit</span>
        </Link>
        <nav className="landing-nav" aria-label="Main navigation">
          <Link href="/app">← Change platform</Link>
        </nav>
      </header>

      <main className="landing-main">
        <section className="app-pick" style={{ maxWidth: 720 }}>
          <p className="eyebrow">
            <span className="live-dot" /> {provider}
          </p>
          <h1>{room?.username || room?.name || 'Your stream'}</h1>

          <div className="overlay-link">
            <iframe
              src={`/docks/${provider}?room=${roomId}`}
              title="Live chat preview"
              style={{ width: '100%', height: 360, border: 0, borderRadius: 8 }}
            />
          </div>

          <h2 style={{ marginTop: '1.5rem' }}>Browser source links</h2>
          <p className="faint tight-caption">
            Paste one into an OBS browser source. It keeps working when this page is closed.
          </p>

          <div className="platform-pick">
            {Object.entries(links).map(([key, url]) => (
              <button
                key={key}
                className="platform-btn"
                onClick={() => copy(key, url)}
                style={{ textAlign: 'left' }}
              >
                <span>{LINK_LABELS[key as keyof typeof LINK_LABELS]}</span>
                <span className="platform-go">
                  {copied === key ? 'Copied' : 'Copy'}
                </span>
              </button>
            ))}
          </div>

          <p className="faint tight-caption">
            Styling, analytics and giveaways live in{' '}
            <Link href={profilePath(room?.username || '', roomId)}>the dashboard</Link>.
          </p>
        </section>
      </main>
    </div>
  )
}

export default function DashboardPage({ provider }: { provider: StreamProvider }) {
  // `useSearchParams` needs a Suspense boundary in the App Router.
  return (
    <Suspense fallback={null}>
      <Dashboard provider={provider} />
    </Suspense>
  )
}
