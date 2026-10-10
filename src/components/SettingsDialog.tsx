import { useCallback, useEffect, useRef, useState } from 'react'
import { host } from '../lib/sidecar'
import { EMPTY_CONFIG, EXAMPLE_BASE_URL, isReady, modelOptions, normaliseBaseUrl, type LlmConfig } from '../lib/llm'
import { DENSITIES, FONTS, THEMES } from '../lib/theme'
import { TEMPLATES } from '../lib/templates'
import { invalidateCustomSound, playSound, resolveAudio } from '../lib/player'
import type { UseSettingsResult, ViewSettings } from '../hooks/useSettings'

/**
 * Everything about how the app looks and what it shows, behind one gear.
 *
 * These were spread across the toolbar and the bottom of the window — theme,
 * font and density on their own row, the model on a button, the stats/log/ask
 * panels taking three collapsed bars at the bottom. The result was a window you
 * had to scroll to configure and a feed squeezed between rows of controls. This
 * dialog is where all of it lives: the toolbar keeps only what belongs to the
 * stream itself — the handle, connect, filters — and a single gear opens the rest.
 *
 * The model fields moved here too, so there is one place for every setting
 * rather than a second dialog that opens from the first one's toolbar.
 */

type Status =
  | { kind: 'idle'; text: '' }
  | { kind: 'busy'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'ok'; text: string }

interface Props {
  open: boolean
  settings: UseSettingsResult
  onClose: () => void
}

/** The reading toggles, in the order they read. */
const PANEL_TOGGLES: { key: keyof ViewSettings; label: string; hint: string }[] = [
  { key: 'showStats', label: 'Stats panel', hint: 'Session numbers below the chat' },
  { key: 'showLog', label: 'Log panel', hint: 'What the bridge reported, below the chat' },
  { key: 'showAsk', label: 'Ask panel', hint: 'Ask the model about the chat, below the chat' },
]

const FEED_TOGGLES: { key: keyof ViewSettings; label: string; hint: string }[] = [
  { key: 'compact', label: 'Compact', hint: 'One line per message, no avatars' },
  { key: 'hideJoins', label: 'Hide joins', hint: 'Drop "X joined the stream" rows' },
  { key: 'hideFiltered', label: 'Hide filtered', hint: 'Drop messages TikTok already filtered' },
  { key: 'showModeratorBadge', label: 'Moderator badge', hint: 'Show the MOD badge on chat rows' },
  { key: 'alwaysOnTop', label: 'On top', hint: 'Keep the window above others' },
  { key: 'giftSound', label: 'Gift sound', hint: 'Chime when a gift arrives' },
  { key: 'giftNotice', label: 'Gift notice', hint: 'Raise a desktop toast when a gift arrives' },
  { key: 'giftVoice', label: 'Say gifts', hint: 'Announce each gift with the neural voice' },
]

/**
 * Alerts on a new chat message.
 *
 * Separate from the gift toggles because chat is the frequent case and gifts the
 * rare one, and a sound per message would be unbearable if it shared the gift's
 * defaults. `ttsNames` only shows while speech is on — a name is spoken as part
 * of the message, so with speech off there is nothing for it to modify.
 */
const ALERT_TOGGLES: {
  key: keyof ViewSettings
  label: string
  hint: string
  needs?: keyof ViewSettings
}[] = [
  { key: 'chatSound', label: 'Chat blip', hint: 'A short tap when a new message arrives' },
  { key: 'chatTts', label: 'Read chat aloud', hint: 'Speak new messages with the system voice' },
  { key: 'ttsNames', label: 'Say the name', hint: 'Speak the sender before each message', needs: 'chatTts' },
]

export function SettingsDialog({ open, settings, onClose }: Props) {
  const [config, setConfig] = useState<LlmConfig>(EMPTY_CONFIG)
  const [models, setModels] = useState<string[]>([])
  const [status, setStatus] = useState<Status>({ kind: 'idle', text: '' })
  const [revealKey, setRevealKey] = useState(false)
  // A preview context, separate from the one the alerts use, so previewing a
  // sound does not compete with a gift that fires while the dialog is open.
  const previewContextRef = useRef<AudioContext | null>(null)
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

  const setConfigField = useCallback(<K extends keyof LlmConfig>(key: K, value: LlmConfig[K]) => {
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

  async function saveModel() {
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

  async function forgetModel() {
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

  // Plays a sound once, through the preview context, so the user hears what they
  // picked before trusting it to fire on a gift. A custom file wins over the
  // template, exactly as it does when a real event fires — a preview that sounded
  // different from the real thing would be worse than no preview.
  function preview(templateId: string) {
    previewContextRef.current ??= resolveAudio()
    void playSound(previewContextRef.current, templateId, settings.customSoundPath)
  }

  async function pickCustom() {
    setStatus({ kind: 'busy', text: 'Choose a sound file…' })
    try {
      const path = await host.pickSoundFile()
      if (!alive.current) return
      // Cancelled: an empty path. The previous pick is left alone rather than
      // cleared, because backing out of a picker is not a request to forget.
      if (path === '') {
        setStatus({ kind: 'idle', text: '' })
        return
      }
      // The old file's decoded buffer is dropped, so the next play reads the new
      // one instead of replaying what was cached under the old path.
      invalidateCustomSound()
      settings.set('customSoundPath', path)
      setStatus({ kind: 'ok', text: `Using ${path.split(/[\\/]/).pop()}` })
    } catch (error: unknown) {
      if (!alive.current) return
      setStatus({ kind: 'error', text: message(error) })
    }
  }

  function clearCustom() {
    invalidateCustomSound()
    settings.set('customSoundPath', '')
    setStatus({ kind: 'ok', text: 'Back to the built-in sounds.' })
  }

  if (!open) return null

  const options = modelOptions(models, config.model)
  const ready = isReady(config)

  return (
    <div className="modal-scrim" onClick={onClose} role="presentation">
      <div
        className="modal modal-settings"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2 className="modal-title">Settings</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <section className="settings-section">
          <h3 className="settings-heading">Look</h3>
          <div className="settings-grid">
            <label className="field">
              <span className="field-label">Theme</span>
              <select
                className="input"
                value={settings.theme}
                onChange={(e) => settings.set('theme', e.target.value as ViewSettings['theme'])}
              >
                {THEMES.map((t) => (
                  <option key={t.id} value={t.id} title={t.hint}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span className="field-label">Font</span>
              <select
                className="input"
                value={settings.font}
                onChange={(e) => settings.set('font', e.target.value as ViewSettings['font'])}
              >
                {FONTS.map((f) => (
                  <option key={f.id} value={f.id} title={f.hint}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span className="field-label">Density</span>
              <select
                className="input"
                value={settings.density}
                onChange={(e) => settings.set('density', e.target.value as ViewSettings['density'])}
              >
                {DENSITIES.map((d) => (
                  <option key={d.id} value={d.id} title={d.hint}>
                    {d.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </section>

        <section className="settings-section">
          <h3 className="settings-heading">Panels</h3>
          <div className="settings-toggles">
            {PANEL_TOGGLES.map((option) => (
              <label key={option.key} className="toggle" title={option.hint}>
                <input
                  type="checkbox"
                  checked={Boolean(settings[option.key])}
                  onChange={(e) => settings.set(option.key, e.target.checked as never)}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
        </section>

        <section className="settings-section">
          <h3 className="settings-heading">Feed</h3>
          <div className="settings-toggles">
            {FEED_TOGGLES.map((option) => (
              <label key={option.key} className="toggle" title={option.hint}>
                <input
                  type="checkbox"
                  checked={Boolean(settings[option.key])}
                  onChange={(e) => settings.set(option.key, e.target.checked as never)}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
          <div className="settings-toggles">
            {ALERT_TOGGLES.filter((option) => !option.needs || settings[option.needs]).map((option) => (
              <label key={option.key} className="toggle" title={option.hint}>
                <input
                  type="checkbox"
                  checked={Boolean(settings[option.key])}
                  onChange={(e) => settings.set(option.key, e.target.checked as never)}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
        </section>

        <section className="settings-section" data-section="sounds">
          <h3 className="settings-heading">Sounds</h3>
          <p className="modal-hint">
            A custom file, if you pick one, plays instead of any template — for gifts and chat alike.
            Backing out of the picker keeps the file you already have.
          </p>

          <div className="settings-grid">
            <label className="field">
              <span className="field-label">Gift sound</span>
              <span className="field-row">
                <select
                  className="input"
                  value={settings.giftTemplate}
                  onChange={(e) => settings.set('giftTemplate', e.target.value)}
                >
                  {TEMPLATES.map((t) => (
                    <option key={t.id} value={t.id} title={t.hint}>
                      {t.label}
                    </option>
                  ))}
                </select>
                <button className="btn btn-small" onClick={() => preview(settings.giftTemplate)} title="Hear it">
                  ▶
                </button>
              </span>
            </label>

            <label className="field">
              <span className="field-label">Chat blip</span>
              <span className="field-row">
                <select
                  className="input"
                  value={settings.chatTemplate}
                  onChange={(e) => settings.set('chatTemplate', e.target.value)}
                >
                  {TEMPLATES.map((t) => (
                    <option key={t.id} value={t.id} title={t.hint}>
                      {t.label}
                    </option>
                  ))}
                </select>
                <button className="btn btn-small" onClick={() => preview(settings.chatTemplate)} title="Hear it">
                  ▶
                </button>
              </span>
            </label>
          </div>

          <div className="field">
            <span className="field-label">Custom sound</span>
            <span className="field-row">
              <button className="btn btn-small" onClick={pickCustom} disabled={status.kind === 'busy'}>
                {settings.customSoundPath ? 'Change file…' : 'Choose file…'}
              </button>
              {settings.customSoundPath && (
                <button className="btn btn-small" onClick={clearCustom} disabled={status.kind === 'busy'}>
                  Use built-in
                </button>
              )}
              <button className="btn btn-small" onClick={() => preview(settings.giftTemplate)} title="Hear it">
                ▶
              </button>
            </span>
            <span className="field-note">
              {settings.customSoundPath
                ? settings.customSoundPath.split(/[\\/]/).pop()
                : 'No file — the templates above are used.'}
            </span>
          </div>
        </section>

        <section className="settings-section">
          <h3 className="settings-heading">Model</h3>
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
              onChange={(e) => setConfigField('baseUrl', e.target.value)}
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
                onChange={(e) => setConfigField('apiKey', e.target.value)}
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
                onChange={(e) => setConfigField('model', e.target.value)}
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
            <button className="btn btn-small" onClick={forgetModel} disabled={status.kind === 'busy'}>
              Forget
            </button>
            <span className="modal-spacer" />
            <button className="btn btn-small" onClick={onClose}>
              Close
            </button>
            <button className="btn btn-primary btn-small" onClick={saveModel} disabled={status.kind === 'busy'}>
              Save model
            </button>
          </div>
        </section>
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
