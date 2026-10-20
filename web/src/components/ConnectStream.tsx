/**
 * Connect one stream and hand back its overlay link.
 *
 * One form for both platforms, parameterised — the two differ in three values
 * (label, placeholder, validation message) and everything after the connect is
 * the same call, so a second copy of this page would be a second copy of the
 * connect flow to keep in step.
 */

'use client'

import Link from 'next/link'
import { useState } from 'react'
import { api, ApiError } from '@/lib/client/api'
import { profilePath } from '@/lib/client/streamLinks'
import type { StreamProvider } from '@/lib/types'

type Copy = {
  title: string
  label: string
  placeholder: string
  hint: string
  example: string
}

const COPY: Record<StreamProvider, Copy> = {
  youtube: {
    title: 'YouTube',
    label: 'Video id or link',
    placeholder: 'xgzRSS31nu4 or youtube.com/live/…',
    hint: 'A live stream or its finished chat. The id is the 11 characters after v=.',
    example: 'https://www.youtube.com/live_chat?is_popout=1&v=xgzRSS31nu4',
  },
  tiktok: {
    title: 'TikTok',
    label: 'TikTok username',
    placeholder: '@username or username',
    hint: 'The account that is live right now. The @ is optional.',
    example: '@itsmandyg',
  },
}

export default function ConnectPage({ provider }: { provider: StreamProvider }) {
  const copy = COPY[provider]
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState<{ roomId: string; link: string } | null>(null)

  const submit = async () => {
    const raw = value.trim()
    if (raw === '') return
    setBusy(true)
    setError('')
    try {
      const answer = await api.connectHandle(raw, provider)
      // Build the overlay link from the answer's own room id. Reading it back
      // from the room list instead would cost a round trip and could race the
      // store write that just created it.
      setDone({ roomId: answer.room_id, link: api.chatOverlay(answer.room_id) })
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause.message
          : 'The stream could not be connected.',
      )
    } finally {
      setBusy(false)
    }
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
        <section className="app-pick">
          <p className="eyebrow"><span className="live-dot" /> {copy.title}</p>
          <h1>Connect a <span>stream.</span></h1>

          {done ? (
            <>
              <p className="muted">
                Connected. Paste this into an OBS browser source — it keeps working
                when this page is closed.
              </p>
              <div className="overlay-link">
                <code>{done.link}</code>
              </div>
              <div className="app-actions">
                <button
                  className="btn primary"
                  onClick={() => void navigator.clipboard.writeText(done.link)}
                >
                  Copy link
                </button>
                <Link className="btn" href={`/docks?room=${done.roomId}`}>
                  Open preview
                </Link>
                <Link className="btn" href="/app">
                  Connect another
                </Link>
              </div>
              <p className="faint tight-caption">
                Manage styling and the other overlays from{' '}
                <Link href={profilePath(value.trim().replace(/^@/, ''), done.roomId)}>
                  the stream's page
                </Link>{' '}
                in the dashboard.
              </p>
            </>
          ) : (
            <>
              <label className="field">
                <span>{copy.label}</span>
                <input
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  onKeyDown={(event) => event.key === 'Enter' && void submit()}
                  placeholder={copy.placeholder}
                  autoFocus
                  spellCheck={false}
                />
              </label>
              <p className="faint tight-caption">{copy.hint}</p>
              {error && <div className="notice error">{error}</div>}
              <div className="app-actions">
                <button
                  className="btn primary"
                  onClick={() => void submit()}
                  disabled={busy || value.trim() === ''}
                >
                  {busy ? 'Connecting…' : 'Connect'}
                </button>
              </div>
              <p className="faint tight-caption">Example: <code>{copy.example}</code></p>
            </>
          )}
        </section>
      </main>
    </div>
  )
}
