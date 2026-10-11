import { useCallback, useEffect, useRef, useState } from 'react'
import { host } from '../lib/sidecar'
import { EMPTY_CONFIG, EXAMPLE_BASE_URL, isReady, modelOptions, normaliseBaseUrl, type LlmConfig } from '../lib/llm'
import {
  clampNumber,
  clampRows,
  OVERLAY_DELAY,
  OVERLAY_MAX_ROWS,
  OVERLAY_PORT,
  OVERLAY_SIZE,
  type OverlayStyle,
} from '../lib/overlay'
import {
  clampSeconds,
  MODERATION_INTERVAL_MS,
  MODERATION_MODES,
  REPLY_MAX_SECONDS,
  REPLY_MIN_SECONDS,
} from '../lib/ai'
import { DENSITIES, FONTS, THEMES } from '../lib/theme'
import { TEMPLATES } from '../lib/templates'
import { invalidateCustomSound, playSound, resolveAudio, releaseAudio } from '../lib/player'
import { EMPTY_WEBHOOK, EXAMPLE_WEBHOOK_URL, isWebhookReady, type WebhookConfig } from '../lib/webhook'
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

/**
 * One group of settings, collapsed behind its title.
 *
 * The dialog holds seven groups and used to render every one of them open in a
 * single scroll — so reaching the model settings meant scrolling past theme, font,
 * density, panels, feed, sounds and webhook, most of which a user touches once and
 * never again. Each group is a native `<details>`, collapsed by default: the titles
 * are a table of contents you scan at a glance, and opening one hides the other six
 * rather than pushing them further down.
 *
 * Native `<details>` rather than JS state because the open/closed behaviour is the
 * browser's, not something to rebuild: keyboard, screen readers and the disclosure
 * triangle all work without a line of code, and there is no `openSection` state to
 * keep in step.
 *
 * `defaultOpen` keeps the two groups people return to — Look and the model — in the
 * state most useful on open, while the rarely-touched ones stay shut.
 */
function Section({
  title,
  defaultOpen = false,
  section,
  children,
}: {
  title: string
  defaultOpen?: boolean
  section?: string
  children: React.ReactNode
}) {
  return (
    <details className="settings-section" data-section={section} open={defaultOpen}>
      <summary className="settings-heading">{title}</summary>
      <div className="settings-body">{children}</div>
    </details>
  )
}

/**
 * A labelled run of toggles inside a section.
 *
 * The Feed section holds three different kinds of setting — how the feed looks,
 * what fires on events, and how the message is spoken — and lumping them into one
 * grid is what made it unreadable: a row of eleven checkboxes with no grouping,
 * where "hide the joins" sat between a gift sound and an auto-reply. Each group
 * gets a small caption so the eye can find the one it wants without reading every
 * label.
 */
function ToggleGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="toggle-group">
      <span className="toggle-group-label">{label}</span>
      <div className="settings-toggles">{children}</div>
    </div>
  )
}

interface Props {
  open: boolean
  settings: UseSettingsResult
  /**
   * The room the app is reading, for the overlay link.
   *
   * Passed in rather than read from a module: the overlay is pointed at whatever
   * this window is pointed at, and a link naming a different room is a link that
   * shows somebody else's chat on somebody's stream.
   */
  roomTarget?: string
  /** The connected room's id, so the overlay link can name it directly. */
  roomId?: string
  onClose: () => void
}

/** The reading toggles, in the order they read. */
const PANEL_TOGGLES: { key: keyof ViewSettings; label: string; hint: string }[] = [
  { key: 'showStats', label: 'Stats panel', hint: 'Session numbers below the chat' },
  { key: 'showLog', label: 'Log panel', hint: 'What the bridge reported, below the chat' },
]

/**
 * What the feed looks like.
 *
 * Split out from the sound and alert toggles on purpose: these change what is on
 * screen, and the ones below change what you hear and get told about. Rendered as
 * one mixed grid, a user scanning for "hide the joins" reads past gift sounds and
 * mention alerts to find it — the same reason the groups are sections rather than
 * one long list.
 */
const FEED_TOGGLES: { key: keyof ViewSettings; label: string; hint: string }[] = [
  { key: 'compact', label: 'Compact', hint: 'One line per message, no avatars' },
  { key: 'hideJoins', label: 'Hide joins', hint: 'Drop "X joined the stream" rows' },
  { key: 'hideFiltered', label: 'Hide filtered', hint: 'Drop messages TikTok already filtered' },
  { key: 'showModeratorBadge', label: 'Moderator badge', hint: 'Show the MOD badge on chat rows' },
  { key: 'alwaysOnTop', label: 'On top', hint: 'Keep the window above others' },
]

/**
 * What fires on a gift or a mention, and whether the app talks back.
 *
 * Its own group because it is the "notify me" cluster — sound, toast, voice, the
 * mention highlight and the greeting reply — and someone setting those up is
 * making one decision ("how loud should this be"), not reading them off a list
 * mixed with how the feed is laid out.
 */
const EVENT_TOGGLES: { key: keyof ViewSettings; label: string; hint: string }[] = [
  { key: 'giftSound', label: 'Gift sound', hint: 'Chime when a gift arrives' },
  { key: 'joinSound', label: 'Join sound', hint: 'A soft tap when somebody new arrives' },
  { key: 'giftNotice', label: 'Gift notice', hint: 'Raise a desktop toast when a gift arrives' },
  { key: 'giftVoice', label: 'Say gifts', hint: 'Announce each gift with the neural voice' },
  { key: 'mentionAlert', label: 'Mention alert', hint: 'A sound when a message names you' },
  { key: 'autoReply', label: 'Auto-reply', hint: 'Answer a greeting (hi, halo, hai) with a line of its own' },
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
  {
    key: 'mentionVoice',
    label: 'Say mentions',
    hint: 'Speak the sender when a message names you',
    needs: 'mentionAlert',
  },
]

export function SettingsDialog({ open, settings, roomTarget = '', roomId = '', onClose }: Props) {
  const [config, setConfig] = useState<LlmConfig>(EMPTY_CONFIG)
  // What is actually on disk, so a test can say whether it is testing the fields
  // in front of the user or the settings the features will really use.
  const [savedModel, setSavedModel] = useState<LlmConfig>(EMPTY_CONFIG)
  const [models, setModels] = useState<string[]>([])
  const [status, setStatus] = useState<Status>({ kind: 'idle', text: '' })
  const [revealKey, setRevealKey] = useState(false)
const [webhook, setWebhook] = useState<WebhookConfig>(EMPTY_WEBHOOK)
  const [revealToken, setRevealToken] = useState(false)
  // The overlay's own status and link. Separate from `status`, which belongs to
  // the model fields above: one is "can I save a key", the other is "is there a
  // server for OBS to talk to", and sharing a line between them means one of
  // them overwrites the other's answer.
  const [overlayStatus, setOverlayStatus] = useState<Status>({ kind: 'idle', text: '' })
  const [overlayUrl, setOverlayUrl] = useState('')
  // A preview context, separate from the one the alerts use, so previewing a
  // sound does not compete with a gift that fires while the dialog is open.
  const previewContextRef = useRef<AudioContext | null>(null)
  // The dialog made this context, so the dialog closes it. On unmount rather than
  // on close, because a closed dialog stays mounted and its context is still the
  // one a reopened dialog would preview through.
  useEffect(
    () => () => {
      previewContextRef.current = releaseAudio(previewContextRef.current)
    },
    [],
  )
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
            setSavedModel(saved)
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

  // The webhook is read on its own, so a save takes effect on the next gift without
  // reopening the dialog and without a restart.
  useEffect(() => {
    if (!open) return
    let active = true
    host
      .webhookConfigGet()
      .then((saved) => {
        if (!active) return
        setWebhook(saved)
      })
      .catch(() => {
        // An unconfigured webhook is the default state, not a fault.
      })
    return () => {
      active = false
    }
  }, [open])

  const setConfigField = useCallback(<K extends keyof LlmConfig>(key: K, value: LlmConfig[K]) => {
    setConfig((previous) => ({ ...previous, [key]: value }))
  }, [])

  const setWebhookField = useCallback(<K extends keyof WebhookConfig>(key: K, value: WebhookConfig[K]) => {
    setWebhook((previous) => ({ ...previous, [key]: value }))
  }, [])

  // Saved as it is typed rather than behind a Save button, like every other setting
  // in this dialog — the host reads the config at send time, so a change lands on
  // the next gift with nothing to press.
  useEffect(() => {
    if (!open) return
    void host.webhookConfigSave(webhook).catch(() => {
      // A read-only config directory is not worth interrupting the dialog over; the
      // test button will say the send failed if it comes to that.
    })
  }, [open, webhook])

  async function testWebhook() {
    setStatus({ kind: 'busy', text: 'Sending a test gift…' })
    try {
      const said = await host.webhookTest()
      if (!alive.current) return
      setStatus({ kind: 'ok', text: said })
    } catch (error: unknown) {
      if (!alive.current) return
      // The host's message verbatim: "404" and "401" are fixed differently, and the
      // user can only fix the one they are told about.
      setStatus({ kind: 'error', text: message(error) })
    }
  }

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
    const saved = { ...config, baseUrl: normaliseBaseUrl(config.baseUrl), apiKey: config.apiKey.trim() }
    setStatus({ kind: 'busy', text: 'Saving…' })
    try {
      await host.llmConfigSave(saved)
      if (!alive.current) return
      // Kept in step with the fields, because "Test model" compares the two to say
      // whether it is testing what is on screen or what is on disk. A copy left
      // behind here would have it report unsaved changes forever.
      setConfig(saved)
      setSavedModel(saved)
      setStatus({ kind: 'ok', text: 'Saved.' })
    } catch (error: unknown) {
      if (!alive.current) return
      setStatus({ kind: 'error', text: message(error) })
    }
  }

  /**
   * Asks the model one trivial question and shows the answer.
   *
   * For "is my LLM working", which nothing else in the app answers. Fetching the
   * model list proves the address and the key; a completion is a different
   * request, and a proxy that lists models and then refuses to answer them passes
   * one of those checks and fails the other. With the ask panel gone there was no
   * way left to see a model say anything without switching a live feature on and
   * reading the log for it.
   *
   * Reads the *saved* settings rather than the fields, because that is what the
   * features use. Testing what is in the form would answer a different question
   * from the one being asked, and would say yes while moderation quietly failed
   * against an unsaved key.
   *
   * Says what is missing instead of failing obscurely: the three ways this cannot
   * work are an unset endpoint, an unset model, and an endpoint that will not
   * answer, and only the host knows which.
   */
  async function testModel() {
    setStatus({ kind: 'busy', text: 'Asking the model…' })
    // Said before the call rather than after: someone who has just typed a new key
    // and pressed this is testing the *old* one, and a green result while they are
    // looking at the new key is the most misleading thing this dialog can do.
    const unsaved = normaliseBaseUrl(config.baseUrl) !== savedModel.baseUrl
      || config.apiKey.trim() !== savedModel.apiKey
      || config.model !== savedModel.model
    try {
      const answer = await host.llmTest()
      if (!alive.current) return
      const said = answer.trim() === '' ? 'it answered with nothing' : answer.trim()
      setStatus({
        kind: 'ok',
        text: `The saved model answered: ${said}${unsaved ? ' — but you have unsaved changes above.' : ''}`,
      })
    } catch (error: unknown) {
      if (!alive.current) return
      setStatus({
        kind: 'error',
        text: `The model did not answer — ${message(error)}${unsaved ? ' (it tested the saved settings, not these fields)' : ''}`,
      })
    }
  }

  async function forgetModel() {
    setStatus({ kind: 'busy', text: 'Forgetting…' })
    try {
      await host.llmConfigClear()
      if (!alive.current) return
setConfig(EMPTY_CONFIG)
          setSavedModel(EMPTY_CONFIG)
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

  /** The styling, as the host wants it: one object rather than six fields. */
  function overlayStyle(): OverlayStyle {
    return {
      size: settings.overlaySize,
      max: settings.overlayMax,
      delay: settings.overlayDelay,
      bg: settings.overlayBg,
      nameColour: settings.overlayNameColour,
      textColour: settings.overlayTextColour,
      font: settings.overlayFont,
    }
  }

  /**
   * Builds the link and puts it on the clipboard.
   *
   * Both in one action on purpose. A button that only built it would leave the
   * one step that actually matters — getting it into OBS — as something to do by
   * hand, right when the link has styling in it that is tedious to retype.
   *
   * Clipboard access is not something the page can count on: the permission is
   * asked for and can be refused, and a webview with no focus never gets it. So
   * the URL is shown as well as copied, and a failure says so rather than leaving
   * a button that looks like it worked.
   */
  async function copyOverlayLink() {
    setOverlayStatus({ kind: 'busy', text: 'Building the link…' })
    try {
      // Pass the room id when there is one: the link becomes a bare `?room=<id>`,
      // which is one parameter nothing has to resolve. Falls back to the handle
      // when there is no id yet (not connected), which the page resolves itself.
      const url = await host.overlayUrl(roomTarget, overlayStyle(), roomId || undefined)
      if (!alive.current) return
      setOverlayUrl(url)
      try {
        await navigator.clipboard.writeText(url)
        if (!alive.current) return
        setOverlayStatus({
          kind: 'ok',
          text: `Copied. Add a Browser source in OBS and paste it in.${roomTarget ? '' : ' Set a handle above first.'}`,
        })
      } catch {
        if (!alive.current) return
        setOverlayStatus({ kind: 'error', text: 'Could not reach the clipboard — copy the link below.' })
      }
    } catch (error: unknown) {
      if (!alive.current) return
      setOverlayStatus({ kind: 'error', text: message(error) })
    }
  }

  /**
   * Asks the host whether the overlay server is answering.
   *
   * Offered as a button rather than shown as a standing status because the two
   * failures it distinguishes — not running, and something else holding the port
   * — need different answers, and only this can tell them apart.
   */
  async function checkOverlay() {
    setOverlayStatus({ kind: 'busy', text: 'Checking…' })
    try {
      const running = await host.overlayRunning()
      if (!alive.current) return
      setOverlayStatus(
        running
          ? { kind: 'ok', text: `Serving on port ${OVERLAY_PORT}.` }
          : {
              kind: 'error',
              text: `Nothing is answering on port ${OVERLAY_PORT} — either this app could not bind it, or something else already has it.`,
            },
      )
    } catch (error: unknown) {
      if (!alive.current) return
      setOverlayStatus({ kind: 'error', text: message(error) })
    }
  }

  /**
   * Opens the preview in a real browser.
   *
   * The host does it, not `window.open`: the page cannot navigate anywhere under
   * the app's content security policy, and a Preview button that silently does
   * nothing is worse than no button — it reads as the overlay being broken when
   * the overlay is the part that works.
   */
  async function openOverlay(url: string) {
    setOverlayStatus({ kind: 'busy', text: 'Opening the preview…' })
    try {
      await host.overlayOpen(url)
      if (!alive.current) return
      setOverlayStatus({
        kind: 'ok',
        text: 'Opened in your browser. It looks the same there as it will in OBS.',
      })
    } catch (error: unknown) {
      if (!alive.current) return
      setOverlayStatus({ kind: 'error', text: message(error) })
    }
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

        <Section title="Look" defaultOpen>
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
        </Section>

        <Section title="Panels">
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
        </Section>

        <Section title="Feed" section="feed">
          <ToggleGroup label="What the feed looks like">
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
          </ToggleGroup>

          <ToggleGroup label="What fires on a gift or mention">
            {EVENT_TOGGLES.map((option) => (
              <label key={option.key} className="toggle" title={option.hint}>
                <input
                  type="checkbox"
                  checked={Boolean(settings[option.key])}
                  onChange={(e) => settings.set(option.key, e.target.checked as never)}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </ToggleGroup>

          <label className="field">
            <span className="field-label">My handles</span>
            <input
              className="input"
              placeholder="yourname, othername"
              value={settings.myHandle}
              onChange={(e) => settings.set('myHandle', e.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
            <span className="field-note">
              Comma-separated. A message naming any of these is highlighted, and alerted on if the
              mention alert is on. Leave empty for no highlights at all.
            </span>
          </label>

          <ToggleGroup label="How messages are spoken">
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
          </ToggleGroup>
        </Section>

        <Section title="Sounds" section="sounds">
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

            <label className="field">
              <span className="field-label">Join knock</span>
              <span className="field-row">
                <select
                  className="input"
                  value={settings.joinTemplate}
                  onChange={(e) => settings.set('joinTemplate', e.target.value)}
                >
                  {TEMPLATES.map((t) => (
                    <option key={t.id} value={t.id} title={t.hint}>
                      {t.label}
                    </option>
                  ))}
                </select>
                <button className="btn btn-small" onClick={() => preview(settings.joinTemplate)} title="Hear it">
                  ▶
                </button>
              </span>
              <span className="field-note">Played at most every couple of seconds, however many arrive.</span>
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
        </Section>

        <Section title="Webhook" section="webhook">
          <p className="modal-hint">
            When a gift arrives, its details are posted to the URL below so another app can react — an
            overlay, an alert, a bot. The token is stored on this machine and sent from the app&rsquo;s host,
            never from this window.
          </p>

          <label className="toggle">
            <input
              type="checkbox"
              checked={webhook.enabled}
              onChange={(e) => setWebhookField('enabled', e.target.checked)}
            />
            <span>Send gifts to a webhook</span>
          </label>

          <label className="field">
            <span className="field-label">Webhook URL</span>
            <input
              className="input"
              placeholder={EXAMPLE_WEBHOOK_URL}
              value={webhook.url}
              onChange={(e) => setWebhookField('url', e.target.value)}
              spellCheck={false}
              autoComplete="off"
              disabled={!webhook.enabled}
            />
            <span className="field-note">
              Where the gift is posted. Left empty, nothing is sent even when the toggle is on.
            </span>
          </label>

          <label className="field">
            <span className="field-label">Webhook token</span>
            <span className="field-row">
              <input
                className="input"
                type={revealToken ? 'text' : 'password'}
                placeholder="optional"
                value={webhook.token}
                onChange={(e) => setWebhookField('token', e.target.value)}
                spellCheck={false}
                autoComplete="off"
                disabled={!webhook.enabled}
              />
              <button
                type="button"
                className="btn btn-small"
                onClick={() => setRevealToken((v) => !v)}
                disabled={!webhook.enabled}
              >
                {revealToken ? 'Hide' : 'Show'}
              </button>
            </span>
            <span className="field-note">
              Sent as an Authorization header, not in the URL — a token in a query string ends up in the
              receiving server&rsquo;s access log. Leave empty to send no header.
            </span>
          </label>

          <div className="modal-actions">
            <span className="modal-spacer" />
            <button
              className="btn btn-small"
              onClick={testWebhook}
              disabled={!webhook.enabled || !isWebhookReady(webhook) || status.kind === 'busy'}
              title="Send one test gift and show what came back"
            >
              HTTP test
            </button>
          </div>
        </Section>

        <Section title="Model" defaultOpen>
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
            <button
              className="btn btn-small"
              onClick={testModel}
              disabled={status.kind === 'busy'}
              title="Ask the model one question and show what it answers"
            >
              {status.kind === 'busy' ? 'Working…' : 'Test model'}
            </button>
            <span className="modal-spacer" />
            <button className="btn btn-small" onClick={onClose}>
              Close
            </button>
            <button className="btn btn-primary btn-small" onClick={saveModel} disabled={status.kind === 'busy'}>
              Save model
            </button>
          </div>
        </Section>

        <Section title="Content moderation" section="moderation">
          <p className="modal-hint">
            Every {MODERATION_INTERVAL_MS / 1000} seconds the messages nobody has looked at yet go to
            the model in one batch, and it names the ones worth acting on. Uses the model set up
            above, and nothing is sent while it is off.
          </p>

          <label className="field">
            <span className="field-label">When a message is flagged</span>
            <select
              className="input"
              value={settings.moderation}
              onChange={(e) => settings.set('moderation', e.target.value as ViewSettings['moderation'])}
            >
              {MODERATION_MODES.map((mode) => (
                <option key={mode.id} value={mode.id} title={mode.hint}>
                  {mode.label}
                </option>
              ))}
            </select>
            <span className="field-note">
              {settings.moderation === 'block'
                ? 'Flagged messages leave the feed. Each one is recorded in the log panel, with who sent it.'
                : settings.moderation === 'flag'
                  ? 'Flagged messages stay on screen, marked with the reason. You decide what to do about them.'
                  : 'Nothing is sent to the model.'}
            </span>
          </label>

          <label className="field">
            <span className="field-label">Your rules</span>
            <textarea
              className="input"
              rows={3}
              placeholder="Swearing is fine. Links to gift-card sites are not."
              value={settings.moderationRules}
              onChange={(e) => settings.set('moderationRules', e.target.value)}
            />
            <span className="field-note">
              Added to the model&rsquo;s own judgement, which takes these over. Leave empty for the
              defaults.
            </span>
          </label>
        </Section>

        <Section title="AI answers" section="replies">
          <p className="modal-hint">
            The model reads the same chat and answers on its own, so the room keeps moving while you
            are busy. It is told it may stay quiet, and usually does; what it does say appears in the
            feed as an AI row. This is the one that costs a request — the greeting bot
            in Panels above is free and only fires on &ldquo;hi&rdquo;.
          </p>

          <div className="settings-toggles">
            <label className="toggle" title="Let the model answer viewers without being asked">
              <input
                type="checkbox"
                checked={settings.aiReply}
                onChange={(e) => settings.set('aiReply', e.target.checked)}
              />
              <span>Let the model answer</span>
            </label>
          </div>

          <label className="field">
            <span className="field-label">Seconds between answers</span>
            <input
              className="input"
              type="number"
              min={REPLY_MIN_SECONDS}
              max={REPLY_MAX_SECONDS}
              step={5}
              value={settings.aiReplySeconds}
              onChange={(e) => settings.set('aiReplySeconds', clampSeconds(Number(e.target.value)))}
            />
            <span className="field-note">
              A floor, not a schedule. Between {REPLY_MIN_SECONDS} and {REPLY_MAX_SECONDS} seconds;
              the model decides whether to say anything at all.
            </span>
          </label>

          <label className="field">
            <span className="field-label">How it should behave</span>
            <textarea
              className="input"
              rows={3}
              placeholder="Keep it dry. Never answer anything about how much we have."
              value={settings.aiReplyPersona}
              onChange={(e) => settings.set('aiReplyPersona', e.target.value)}
            />
            <span className="field-note">
              Added to the model&rsquo;s own instructions, which take these over. Leave empty for the
              defaults.
            </span>
          </label>
        </Section>

        <Section title="Stream overlay" section="overlay">
          <p className="modal-hint">
            A chat you can put straight on the stream. Copy the link, add a{' '}
            <strong>Browser</strong> source in OBS, paste it in, and leave it. It reads the same chat
            straight from the backend, so it keeps working while this window is closed.
          </p>

          {/* The numbers and colours in a grid — but only the controls, not their
              notes. A long note crammed into a grid cell wraps into a tall ragged
              tower beside its own input; the two notes that need explaining (delay
              and background) are pulled out below and span the full width, so the
              grid stays a tidy row of label-and-control. */}
          <div className="settings-grid">
            <label className="field">
              <span className="field-label">Text size</span>
              <input
                className="input"
                type="number"
                min={OVERLAY_SIZE.min}
                max={OVERLAY_SIZE.max}
                value={settings.overlaySize}
                onChange={(e) =>
                  settings.set('overlaySize', clampNumber(e.target.value, OVERLAY_SIZE.min, OVERLAY_SIZE.max, 22))
                }
              />
            </label>

            <label className="field">
              <span className="field-label">Messages on screen</span>
              <input
                className="input"
                type="number"
                min={OVERLAY_MAX_ROWS.min}
                max={OVERLAY_MAX_ROWS.max}
                value={settings.overlayMax}
                onChange={(e) => settings.set('overlayMax', clampRows(e.target.value, 8))}
              />
            </label>

            <label className="field">
              <span className="field-label">Time between messages</span>
              <input
                className="input"
                type="number"
                min={OVERLAY_DELAY.min}
                max={OVERLAY_DELAY.max}
                step={50}
                value={settings.overlayDelay}
                onChange={(e) =>
                  settings.set('overlayDelay', Math.round(clampNumber(e.target.value, OVERLAY_DELAY.min, OVERLAY_DELAY.max, 500)))
                }
              />
            </label>

            <label className="field">
              <span className="field-label">Name colour</span>
              <input
                className="input overlay-colour"
                type="color"
                value={settings.overlayNameColour}
                onChange={(e) => settings.set('overlayNameColour', e.target.value)}
              />
            </label>

            <label className="field">
              <span className="field-label">Text colour</span>
              <input
                className="input overlay-colour"
                type="color"
                value={settings.overlayTextColour}
                onChange={(e) => settings.set('overlayTextColour', e.target.value)}
              />
            </label>

            <label className="field">
              <span className="field-label">Background</span>
              <input
                className="input"
                type="range"
                min={0}
                max={100}
                step={5}
                value={Math.round(settings.overlayBg * 100)}
                onChange={(e) => settings.set('overlayBg', clampNumber(e.target.value, 0, 100, 0) / 100)}
              />
            </label>
          </div>

          <div className="overlay-notes">
            <span className="field-note">
              {settings.overlayDelay} ms between messages. A busy room talks faster than anyone reads, so
              without a gap the last {settings.overlayMax} land together and read as a wall.
            </span>
            <span className="field-note">
              {settings.overlayBg === 0
                ? 'No background — the video shows through.'
                : `${Math.round(settings.overlayBg * 100)}% black behind each line.`}
            </span>
          </div>

          <label className="field">
            <span className="field-label">Font</span>
            <input
              className="input"
              placeholder='"Segoe UI", system-ui, sans-serif'
              value={settings.overlayFont}
              onChange={(e) => settings.set('overlayFont', e.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
            <span className="field-note">
              A CSS font stack. A name with spaces in it has to be quoted, the way CSS wants it.
            </span>
          </label>

          <div className="field">
            <span className="field-label">Link for OBS</span>
            <span className="field-row">
              <button
                className="btn btn-small btn-primary"
                onClick={copyOverlayLink}
                disabled={overlayStatus.kind === 'busy'}
              >
                {overlayStatus.kind === 'busy' ? 'Copying…' : 'Copy link'}
              </button>
              <button className="btn btn-small" onClick={checkOverlay} disabled={overlayStatus.kind === 'busy'}>
                Check server
              </button>
              {overlayUrl !== '' && (
                <button className="btn btn-small" onClick={() => openOverlay(overlayUrl)} title="Open it in a browser">
                  Preview
                </button>
              )}
            </span>
            <span className="field-note">{overlayStatus.text}</span>
            {overlayUrl !== '' && <code className="overlay-url">{overlayUrl}</code>}
          </div>
        </Section>
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
