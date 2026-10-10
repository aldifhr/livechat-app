import { useEffect, useState } from 'react'
import { host } from '../lib/sidecar'
import {
  normaliseBaseUrl,
  normaliseUsername,
  type BackendConfig,
} from '../lib/backend'

/**
 * Where the backend lives, and which stream to read.
 *
 * Its own dialog rather than a field in the model one: this is a server address
 * and a handle, not a credential, and putting it next to an API key would make
 * the two look equally important when only one of them is.
 */

interface Props {
  open: boolean
  /** What the app already has. Seeding from this rather than re-reading the host
   *  on open is what stops a slow answer landing on top of what was typed. */
  config: BackendConfig
  onClose: () => void
  /** Called with what was saved, so the toolbar's handle stays in step. */
  onSaved: (config: BackendConfig) => void
}

export function BackendSettings({ open, config: current, onClose, onSaved }: Props) {
  const [config, setConfig] = useState<BackendConfig>(current)
  const [status, setStatus] = useState('')

  useEffect(() => {
    if (!open) return
    setConfig(current)
    setStatus('')
  }, [open, current])

  if (!open) return null

  const set = <K extends keyof BackendConfig>(key: K, value: BackendConfig[K]) =>
    setConfig((previous) => ({ ...previous, [key]: value }))

  async function save() {
    const saved: BackendConfig = {
      baseUrl: normaliseBaseUrl(config.baseUrl),
      username: normaliseUsername(config.username),
    }
    try {
      await host.backendConfigSave(saved)
      // Handed up rather than left in this dialog: the toolbar shows whether a
      // backend is set up, and it has no other way to learn the answer.
      onSaved(saved)
      setStatus('Saved.')
    } catch (error: unknown) {
      setStatus(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <div className="modal-scrim" onClick={onClose} role="presentation">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Backend settings"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2 className="modal-title">Backend</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <p className="modal-hint">
          Reading from the backend means the app no longer runs its own 85&nbsp;MB bridge. Give the
          streamer&rsquo;s handle: the backend finds or creates the room for it and starts it reading.
        </p>

        <label className="field">
          <span className="field-label">Backend URL</span>
          <input
            className="input"
            placeholder="https://kit-backend.example"
            value={config.baseUrl}
            onChange={(e) => set('baseUrl', e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
        </label>

        <label className="field">
          <span className="field-label">Streamer</span>
          <input
            className="input"
            placeholder="mybasic.indonesia"
            value={config.username}
            onChange={(e) => set('username', e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
          <span className="field-note">
            A pasted profile link works too — it is read down to the handle.
          </span>
        </label>

        {status !== '' && <p className="modal-status modal-status-ok">{status}</p>}

        <div className="modal-actions">
          <span className="modal-spacer" />
          <button className="btn btn-small" onClick={onClose}>
            Close
          </button>
          <button className="btn btn-primary btn-small" onClick={save} disabled={normaliseUsername(config.username) === '' && normaliseBaseUrl(config.baseUrl) === ''}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}