import { useCallback, useEffect, useRef, useState } from 'react'
import { host } from '../lib/sidecar'
import { EMPTY_CONFIG, EXAMPLE_BASE_URL, isReady, modelOptions, normaliseBaseUrl, type LlmConfig } from '../lib/llm'

/**
 * Endpoint settings for an OpenAI-compatible model.
 *
 * A dialog rather than another toolbar row: the toolbar is already competing with
 * the feed for height, and this is opened rarely and left alone in between.
 *
 * The key is typed here but stored by the host, in the app config directory. That
 * split is deliberate — a webview cannot reach the network at all under this app's
 * content security policy, so the request goes out from Rust, and the key never
 * has to be anywhere a page could read it.
 */

type Status =
  | { kind: 'idle'; text: '' }
  | { kind: 'busy'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'ok'; text: string }

interface Props {
  open: boolean
  onClose: () => void
}

export function LlmSettings({ open, onClose }: Props) {
  const [config, setConfig] = useState<LlmConfig>(EMPTY_CONFIG)
  const [models, setModels] = useState<string[]>([])
  const [status, setStatus] = useState<Status>({ kind: 'idle', text: '' })
  const [revealKey, setRevealKey] = useState(false)
  // Held so a save that lands after the dialog closes does not reopen it.
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  // Loaded when it opens rather than on mount: the config is read from disk, and
  // there is no reason to pay for that on every launch of the app.
  useEffect(() => {
    if (!open) return
    let active = true
    setStatus({ kind: 'busy', text: 'Loading saved settings…' })
    host
      .llmConfigGet()
      .then((saved) => {
        if (!active) return
        setConfig(saved)
        setModels(saved.model ? [saved.model] : [])
        setStatus({ kind: 'idle', text: '' })
      })
      .catch((error: unknown) => {
        if (!active) return
        setStatus({ kind: 'error', text: `Could not read the saved settings: ${message(error)}` })
      })
    return () => {
      active = false
    }
  }, [open])

  const set = useCallback(<K extends keyof LlmConfig>(key: K, value: LlmConfig[K]) => {
    setConfig((previous) => ({ ...previous, [key]: value }))
  }, [])

  async function fetchModels() {
    setStatus({ kind: 'busy', text: 'Asking the endpoint what it has…' })
    try {
      const found = await host.llmModels(normaliseBaseUrl(config.baseUrl), config.apiKey.trim())
      if (!alive.current) return
      setModels(found)
      setStatus(
        found.length === 0
          ? { kind: 'error', text: 'The endpoint answered, but listed no models.' }
          : { kind: 'ok', text: `${found.length} model${found.length === 1 ? '' : 's'} available.` },
      )
    } catch (error: unknown) {
      if (!alive.current) return
      // The host's message verbatim: "could not reach host" and "API key required"
      // are the two things that actually go wrong, and the user can only fix the
      // one they are told about.
      setStatus({ kind: 'error', text: message(error) })
    }
  }

  async function save() {
    setStatus({ kind: 'busy', text: 'Saving…' })
    try {
      await host.llmConfigSave({ ...config, baseUrl: normaliseBaseUrl(config.baseUrl), apiKey: config.apiKey.trim() })
      if (!alive.current) return
      setStatus({ kind: 'ok', text: 'Saved.' })
    } catch (error: unknown) {
      if (!alive.current) return
      setStatus({ kind: 'error', text: message(error) })
    }
  }

  async function forget() {
    setStatus({ kind: 'busy', text: 'Forgetting…' })
    try {
      await host.llmConfigClear()
      if (!alive.current) return
      setConfig(EMPTY_CONFIG)
      setModels([])
      setStatus({ kind: 'ok', text: 'Forgotten. The key is gone from disk.' })
    } catch (error: unknown) {
      if (!alive.current) return
      setStatus({ kind: 'error', text: message(error) })
    }
  }

  if (!open) return null

  const options = modelOptions(models, config.model)
  const ready = isReady(config)

  return (
    <div className="modal-scrim" onClick={onClose} role="presentation">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Model settings"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2 className="modal-title">Model</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <p className="modal-hint">
          Any OpenAI-compatible endpoint. The key is stored on this machine, never in the page, and
          every request is made by the app&rsquo;s host rather than this window.
        </p>

        <label className="field">
          <span className="field-label">Base URL</span>
          <input
            className="input"
            placeholder={EXAMPLE_BASE_URL}
            value={config.baseUrl}
            onChange={(e) => set('baseUrl', e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
        </label>

        <label className="field">
          <span className="field-label">API key</span>
          <span className="field-row">
            <input
              className="input"
              type={revealKey ? 'text' : 'password'}
              placeholder="sk-…"
              value={config.apiKey}
              onChange={(e) => set('apiKey', e.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
            <button className="btn btn-small" onClick={() => setRevealKey((v) => !v)}>
              {revealKey ? 'Hide' : 'Show'}
            </button>
          </span>
        </label>

        <label className="field">
          <span className="field-label">Model</span>
          <span className="field-row">
            <select
              className="input"
              value={config.model}
              onChange={(e) => set('model', e.target.value)}
              disabled={options.length === 0}
            >
              {options.length === 0 && <option value="">Fetch the list first</option>}
              {options.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
            <button className="btn btn-small" onClick={fetchModels} disabled={!ready || status.kind === 'busy'}>
              Fetch models
            </button>
          </span>
        </label>

        {status.text !== '' && (
          <p className={`modal-status modal-status-${status.kind}`}>{status.text}</p>
        )}

        <div className="modal-actions">
          <button className="btn btn-small" onClick={forget} disabled={status.kind === 'busy'}>
            Forget
          </button>
          <span className="modal-spacer" />
          <button className="btn btn-small" onClick={onClose}>
            Close
          </button>
          <button className="btn btn-primary btn-small" onClick={save} disabled={status.kind === 'busy'}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

/** Whatever the rejection was, as one line worth showing. */
function message(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  return String(error)
}