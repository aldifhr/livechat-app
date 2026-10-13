'use client'

/**
 * Changing the console's password from the console.
 *
 * The password belongs to nginx's login, not to this app, and the change is sent
 * to a server route that edits the file nginx reads. Nothing here knows or keeps
 * the password: it is typed, posted, and dropped.
 *
 * The fields are cleared on success and the note says the browser will ask again,
 * because the credential the browser has cached is now the old one — the next
 * request it makes will be refused and it will prompt. Saying so is the
 * difference between that prompt reading as "it worked" and as "it broke".
 */

import { useState } from 'react'

type Outcome = { kind: 'ok' | 'error'; text: string }

export default function PasswordPanel() {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<Outcome | null>(null)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (next !== confirm) {
      setOutcome({ kind: 'error', text: 'The two new passwords do not match.' })
      return
    }

    setBusy(true)
    setOutcome(null)
    try {
      const response = await fetch('/api/account/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current, next }),
        cache: 'no-store',
      })
      const payload = (await response.json().catch(() => ({}))) as { detail?: string }

      if (!response.ok) {
        setOutcome({ kind: 'error', text: payload.detail ?? 'The password could not be changed.' })
        return
      }

      setCurrent('')
      setNext('')
      setConfirm('')
      setOutcome({
        kind: 'ok',
        text: 'Password changed. Your browser will ask you to sign in again on the next page.',
      })
    } catch {
      setOutcome({ kind: 'error', text: 'The request could not be sent.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit}>
      {outcome && <div className={`notice ${outcome.kind === 'ok' ? 'ok' : 'error'}`}>{outcome.text}</div>}

      <div className="field">
        <label htmlFor="pw-current">Current password</label>
        <input
          id="pw-current"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(event) => setCurrent(event.target.value)}
          required
        />
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="pw-next">New password</label>
          <input
            id="pw-next"
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(event) => setNext(event.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="pw-confirm">Repeat new password</label>
          <input
            id="pw-confirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            required
          />
        </div>
      </div>

      <button type="submit" className="primary" disabled={busy}>
        {busy ? 'Changing…' : 'Change password'}
      </button>
    </form>
  )
}
