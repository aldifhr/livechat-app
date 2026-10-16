'use client'

/**
 * The sign-in form.
 *
 * One field, because there is one account. This dashboard is a single
 * deployment's console, not a service with users: the account is a fact of the
 * configuration, not something the visitor supplies, so asking for a username
 * would be asking them to guess a name that is already decided. The password is
 * the only thing not known in advance, so it is the only thing asked for.
 *
 * The password is typed, posted, and dropped — nothing here stores it, and the
 * server answers with a cookie rather than the browser's own credential. On
 * success the page is loaded for real rather than navigated to with the client
 * router: a full load is the one thing guaranteed to carry the new cookie on the
 * very next request, with no router cache in between to answer from the 401 that
 * sent us here.
 */

import { useState } from 'react'

export default function LoginForm({ next }: { next: string }) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
        cache: 'no-store',
        // 15s: user is actively waiting on a form, so a generous bound — but a
        // wedged backend must not leave the button spinning indefinitely.
        signal: AbortSignal.timeout(15_000),
      })
      const payload = (await response.json().catch(() => ({}))) as { detail?: string }

      if (!response.ok) {
        setError(payload.detail ?? 'Sign in failed.')
        setPassword('')
        return
      }

      window.location.assign(next)
    } catch {
      setError('The request could not be sent.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit}>
      {error && <div className="notice error">{error}</div>}

      <div className="field">
        <label htmlFor="login-password">Password</label>
        <input
          id="login-password"
          className="w-full"
          name="password"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
      </div>

      <button type="submit" className="primary" disabled={busy}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  )
}
