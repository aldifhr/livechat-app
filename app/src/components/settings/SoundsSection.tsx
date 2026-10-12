import type { ViewSettings } from '../../hooks/useSettings'
import { useEffect, useRef } from 'react'
import { host } from '../../lib/sidecar'
import { TEMPLATES } from '../../lib/templates'
import { invalidateCustomSound, playSound, resolveAudio, releaseAudio } from '../../lib/player'
import { message, useStillMounted, type SetSetting, type Status } from './shared'
import { Section } from './Section'

interface Props {
  settings: ViewSettings
  set: SetSetting
  /**
   * The line the dialog shows about whatever was last attempted.
   *
   * Shared with the model and webhook sections rather than a status of their own:
   * they are all answers to "did that work", and three separate lines in three
   * places would mean the user reading the wrong one after clicking something in
   * another section.
   */
  status: Status
  setStatus: (status: Status) => void
}

/**
 * What each event sounds like, and the custom file that overrides all of it.
 *
 * The one section holding an AudioContext, so it is also the one releasing it.
 * The context is created on the first preview rather than on mount, because a
 * dialog nobody plays a sound in should not hold an audio thread for as long as
 * the app is open.
 */
export function SoundsSection({ settings, set, status, setStatus }: Props) {
  const previewContextRef = useRef<AudioContext | null>(null)
  // The dialog made this context, so the dialog closes it — on unmount, because a
  // context left open holds an audio thread for as long as the app runs.
  useEffect(
    () => () => {
      previewContextRef.current = releaseAudio(previewContextRef.current)
    },
    [],
  )
  const stillMounted = useStillMounted()

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
      if (!stillMounted.current) return
      // Cancelled: an empty path. The previous pick is left alone rather than
      // cleared, because backing out of a picker is not a request to forget.
      if (path === '') {
        setStatus({ kind: 'idle', text: '' })
        return
      }
      // The old file's decoded buffer is dropped, so the next play reads the new
      // one instead of replaying what was cached under the old path.
      invalidateCustomSound()
      set('customSoundPath', path)
      setStatus({ kind: 'ok', text: `Using ${path.split(/[\\/]/).pop()}` })
    } catch (error: unknown) {
      if (!stillMounted.current) return
      setStatus({ kind: 'error', text: message(error) })
    }
  }

  function clearCustom() {
    invalidateCustomSound()
    set('customSoundPath', '')
    setStatus({ kind: 'ok', text: 'Back to the built-in sounds.' })
  }

  return (
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
              onChange={(e) => set('giftTemplate', e.target.value)}
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
              onChange={(e) => set('chatTemplate', e.target.value)}
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
              onChange={(e) => set('joinTemplate', e.target.value)}
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
  )
}
