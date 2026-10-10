import { useEffect, useState } from 'react'
import { host } from '../lib/sidecar'
import { EMPTY_BACKEND, isReady, normaliseBaseUrl, type BackendConfig } from '../lib/backend'

/**
 * Where the backend lives, and which overlay to read.
 *
 * Its own dialog rather than a field in the model one: this is a server address
 * and an id, not a credential, and putting it next to an API key would make the
 * two look equally important when only one of them is.
 */

interface Props {
  open: boolean
  onClose: () => void
}

export function BackendSettings({ open, onClose }: Props) {
  const [config, setConfig] = useState<BackendConfig>(EMPTY_BACKEND)
  const [status, setStatus] = useState('')

  useEffect(() => {
    if (!open) return
    let active = true
    host
      .backendConfigGet()
      .then((saved) => {
        if (active) setConfig(saved)
      })
      .catch((error: unknown) => {
        if (active) setStatus(error instanceof Error ? error.message : String(error))
      })
    return () => {
      active = false
    }
  }, [open])

  if (!open) return null

  const set = <K extends keyof BackendConfig>(key: K, value: BackendConfig[K]) =>
    setConfig((previous) => ({ ...previous, [key]: value }))

  async function save() {
    try {
      await host.backendConfigSave({ ...config, baseUrl: normaliseBaseUrl(config.baseUrl) })
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
          Reading from the backend means the app no longer runs its own 85&nbsp;MB bridge. The
          overlay has to already be connected on the server — starting one there needs a write
          token, and this app has no way of holding one.
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
          <span className="field-label">Overlay id</span>
          <input
            className="input"
            placeholder="1b4fc5f7-36f0-4bab-bbf5-cb953dc4bfe9"
            value={config.overlayId}
            onChange={(e) => set('overlayId', e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
        </label>

        {status !== '' && <p className="modal-status modal-status-ok">{status}</p>}

        <div className="modal-actions">
          <span className="modal-spacer" />
          <button className="btn btn-small" onClick={onClose}>
            Close
          </button>
          <button className="btn btn-primary btn-small" onClick={save} disabled={!isReady(config)}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}