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
  { key: 'giftSoundPath', templateKey: 'giftTemplate', volumeKey: 'giftSoundVolume', gapKey: 'giftSoundGapMs', label: 'Gift sound' },
  { key: 'chatSoundPath', templateKey: 'chatTemplate', volumeKey: 'chatSoundVolume', gapKey: 'chatSoundGapMs', label: 'Chat blip' },
  { key: 'joinSoundPath', templateKey: 'joinTemplate', volumeKey: 'joinSoundVolume', gapKey: 'joinSoundGapMs', label: 'Join knock' },
  { key: 'followSoundPath', templateKey: 'followTemplate', volumeKey: 'followSoundVolume', gapKey: 'followSoundGapMs', label: 'Follow sound' },
  { key: 'shareSoundPath', templateKey: 'shareTemplate', volumeKey: 'shareSoundVolume', gapKey: 'shareSoundGapMs', label: 'Share sound' },
] as const satisfies ReadonlyArray<{
  key: 'giftSoundPath' | 'chatSoundPath' | 'joinSoundPath' | 'followSoundPath' | 'shareSoundPath'
  templateKey: 'giftTemplate' | 'chatTemplate' | 'joinTemplate' | 'followTemplate' | 'shareTemplate'
  volumeKey: 'giftSoundVolume' | 'chatSoundVolume' | 'joinSoundVolume' | 'followSoundVolume' | 'shareSoundVolume'
  gapKey: 'giftSoundGapMs' | 'chatSoundGapMs' | 'joinSoundGapMs' | 'followSoundGapMs' | 'shareSoundGapMs'
  label: string
}>

/** The file's name alone: the directory is noise in a row this narrow. */
function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

/**
 * What each event sounds like, and the file that overrides that event's template.
 *
 * The one section holding an AudioContext, so it is also the one releasing it.
 * The context is created on the first preview rather than on mount, because a
 * dialog nobody plays a sound in should not hold an audio thread for as long as
 * the app is open.
 *
 * A row per event, stacked — not the `.settings-grid` the Look section uses.
 * That grid floors each cell at 120px, sized for a lone select; a sound row is a
 * select PLUS up to three buttons, so three of them side by side overflowed the
 * dialog into a horizontal scrollbar and wrapped every note mid-sentence.
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
  function preview(templateId: string, customPath: string, volume: number) {
    previewContextRef.current ??= resolveAudio()
    void playSound(previewContextRef.current, templateId, customPath, volume / 100)
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
      setStatus({ kind: 'ok', text: `Using ${basename(path)}` })
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
        applies to its own event only, so a gift and a chat line can sound nothing alike.
      </p>

      <div className="sound-rows">
        {EVENTS.map((event) => {
          const customPath = settings[event.key]
          const volume = settings[event.volumeKey]
          const gapMs = settings[event.gapKey]
          const busy = status.kind === 'busy'
          return (
            // A div, not a label: a label wrapping a select AND the buttons beside
            // it forwards a click anywhere inside to the select, so reaching for
            // "Choose file…" would drop the template list open at the same time.
            <div className="field" key={event.key}>
              <span className="field-label">{event.label}</span>
              <span className="field-row">
                <select
                  className="input"
                  aria-label={`${event.label} template`}
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
                  onClick={() => preview(settings[event.templateKey], customPath, volume)}
                  title="Hear it"
                >
                  ▶
                </button>
                <button
                  className="btn btn-small"
                  onClick={() => pickCustom(event.key)}
                  disabled={busy}
                  title={customPath ? 'Change the file this event plays' : 'Choose a file for this event'}
                >
                  {customPath ? 'Change file…' : 'Choose file…'}
                </button>
                {customPath && (
                  <button className="btn btn-small" onClick={() => clearCustom(event.key)} disabled={busy}>
                    Use template
                  </button>
                )}
              </span>
              <span className="field-note">
                {customPath ? basename(customPath) : 'No file — the template is used.'}
              </span>
              <span className="sound-event-options">
                <label className="sound-volume-control">
                  <span className="field-note">Volume</span>
                  <input
                    className="slider"
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={volume}
                    aria-label={`${event.label} volume`}
                    onChange={(e) => set(event.volumeKey, Number(e.target.value))}
                  />
                  <span className="slider-readout">{volume}%</span>
                </label>
                <label className="sound-gap-control">
                  <span className="field-note">Cooldown</span>
                  <input
                    className="input"
                    type="number"
                    min={100}
                    max={30000}
                    step={100}
                    value={gapMs}
                    aria-label={`${event.label} cooldown in milliseconds`}
                    onChange={(e) => set(event.gapKey, Math.min(30000, Math.max(100, Number(e.target.value) || 100)))}
                  />
                  <span className="field-note">ms</span>
                </label>
              </span>
            </div>
          )
        })}
      </div>

      <span className="field-note">Each event has its own volume and cooldown. Cooldown is in milliseconds.</span>
    </Section>
  )
}
