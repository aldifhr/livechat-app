import type { ViewSettings } from '../../hooks/useSettings'
import { useEffect, useRef, useState } from 'react'
import { host } from '../../lib/sidecar'
import { TEMPLATES } from '../../lib/templates'
import { invalidateCustomSound, playSound, resolveAudio, releaseAudio } from '../../lib/player'
import { message, useStillMounted, type SetSetting, type Status } from './shared'
import { Section } from './Section'

interface Props {
  settings: ViewSettings
  set: SetSetting
}

/**
 * Which settings key holds each event's custom file.
 *
 * The three rows are the same control with a different label, so they are driven
 * from one description rather than three near-identical blocks. A path field and a
 * template field per event: the file wins over the template, and both are per
 * event, so a loud gift chime and a soft chat blip no longer have to be the same
 * file or the same choice.
 */
const EVENTS = [
  { key: 'giftSoundPath', templateKey: 'giftTemplate', label: 'Gift sound' },
  { key: 'chatSoundPath', templateKey: 'chatTemplate', label: 'Chat blip' },
  { key: 'joinSoundPath', templateKey: 'joinTemplate', label: 'Join knock' },
] as const satisfies ReadonlyArray<{
  key: 'giftSoundPath' | 'chatSoundPath' | 'joinSoundPath'
  templateKey: 'giftTemplate' | 'chatTemplate' | 'joinTemplate'
  label: string
}>

/**
 * What each event sounds like, and the file that overrides that event's template.
 *
 * The one section holding an AudioContext, so it is also the one releasing it.
 * The context is created on the first preview rather than on mount, because a
 * dialog nobody plays a sound in should not hold an audio thread for as long as
 * the app is open.
 *
 * The status line is this section's own rather than the dialog's. It used to be
 * shared, so that picking a sound in here and firing a webhook in another section
 * could not leave two different answers on screen and the user reading the wrong
 * one. Sharing only earned its cost while there were two things to share between;
 * with the webhook gone this is the last section that reports at all, so threading
 * the state up to a parent that no longer reads it would be the dead weight the
 * sharing was avoiding.
 */
export function SoundsSection({ settings, set }: Props) {
  const [status, setStatus] = useState<Status>({ kind: 'idle', text: '' })
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
  function preview(templateId: string, customPath: string) {
    previewContextRef.current ??= resolveAudio()
    void playSound(previewContextRef.current, templateId, customPath)
  }

  async function pickCustom(key: (typeof EVENTS)[number]['key']) {
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
      set(key, path)
      setStatus({ kind: 'ok', text: `Using ${path.split(/[\\/]/).pop()}` })
    } catch (error: unknown) {
      if (!stillMounted.current) return
      setStatus({ kind: 'error', text: message(error) })
    }
  }

  function clearCustom(key: (typeof EVENTS)[number]['key']) {
    invalidateCustomSound()
    set(key, '')
    setStatus({ kind: 'ok', text: 'Back to the built-in sounds.' })
  }

  return (
    <Section title="Sounds" section="sounds">
      <p className="modal-hint">
        Each event has its own sound: pick a template, or choose a file to play instead. A file
        applies to its own event only, so a gift and a chat line can sound nothing alike. Backing
        out of the picker keeps the file you already have.
      </p>

      <div className="settings-grid">
        {EVENTS.map((event) => {
          const customPath = settings[event.key]
          return (
            <label className="field" key={event.key}>
              <span className="field-label">{event.label}</span>
              <span className="field-row">
                <select
                  className="input"
                  value={settings[event.templateKey]}
                  onChange={(e) => set(event.templateKey, e.target.value)}
                >
                  {TEMPLATES.map((t) => (
                    <option key={t.id} value={t.id} title={t.hint}>
                      {t.label}
                    </option>
                  ))}
                </select>
                <button
                  className="btn btn-small"
                  onClick={() => preview(settings[event.templateKey], customPath)}
                  title="Hear it"
                >
                  ▶
                </button>
                <button
                  className="btn btn-small"
                  onClick={() => pickCustom(event.key)}
                  disabled={status.kind === 'busy'}
                  title={customPath ? 'Change the file this event plays' : 'Choose a file for this event'}
                >
                  {customPath ? 'Change file…' : 'Choose file…'}
                </button>
                {customPath && (
                  <button
                    className="btn btn-small"
                    onClick={() => clearCustom(event.key)}
                    disabled={status.kind === 'busy'}
                  >
                    Use built-in
                  </button>
                )}
              </span>
              <span className="field-note">
                {customPath
                  ? customPath.split(/[\\/]/).pop()
                  : 'No file — the template is used.'}
              </span>
            </label>
          )
        })}
      </div>

      <span className="field-note">Join sounds play at most every couple of seconds, however many arrive.</span>
    </Section>
  )
}
