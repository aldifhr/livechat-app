import type { ViewSettings } from '../../hooks/useSettings'
import type { SetSetting } from './shared'
import { MODERATION_INTERVAL_MS, MODERATION_MODES } from '../../lib/ai'
import { Section } from './Section'

interface Props {
  settings: ViewSettings
  set: SetSetting
}

/**
 * What the model does about messages nobody has looked at yet.
 *
 * Reads the saved settings rather than holding any of its own, because the model
 * it uses is the one configured in the Model section — a second copy here would
 * drift from the fields the user just filled in.
 */
export function ModerationSection({ settings, set }: Props) {
  return (
    <Section title="Content moderation" section="moderation">
      <p className="modal-hint">
        Every {MODERATION_INTERVAL_MS / 1000} seconds the messages nobody has looked at yet go to the
        model in one batch, and it names the ones worth acting on. Uses the model set up above, and
        nothing is sent while it is off.
      </p>

      <label className="field">
        <span className="field-label">When a message is flagged</span>
        <select
          className="input"
          value={settings.moderation}
          onChange={(e) => set('moderation', e.target.value as ViewSettings['moderation'])}
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
          onChange={(e) => set('moderationRules', e.target.value)}
        />
        <span className="field-note">
          Added to the model&rsquo;s own judgement, which takes these over. Leave empty for the defaults.
        </span>
      </label>
    </Section>
  )
}
