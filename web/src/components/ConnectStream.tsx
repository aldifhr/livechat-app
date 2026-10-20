/**
 * Connect one stream, then go to its dashboard.
 *
 * One form for both platforms, parameterised — the two differ in three values
 * (label, placeholder, example) and everything after the connect is the same
 * call, so a second copy of this page would be a second copy of the connect flow
 * to keep in step.
 *
 * A successful connect navigates to `/app/<platform>/dashboard?room=<id>`
 * rather than printing the overlay URL here. The URL is one of five overlays and
 * the page that manages all of them is the dashboard; showing a link and asking
 * the operator to carry it somewhere was a dead end in the middle of the flow.
 */

'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { api, ApiError } from '@/lib/client/api'
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
  const router = useRouter()
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async () => {
    const raw = value.trim()
    if (raw === '') return
    setBusy(true)
    setError('')
    try {
      const answer = await api.connectHandle(raw, provider)
      router.push(`/app/${provider}/dashboard?room=${answer.room_id}`)
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause.message
          : 'The stream could not be connected.',
      )
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
        </section>
      </main>
    </div>
  )
}
