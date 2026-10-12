import type { ViewSettings } from '../../hooks/useSettings'
import type { SetSetting } from './shared'
import { clampSeconds, REPLY_MAX_SECONDS, REPLY_MIN_SECONDS } from '../../lib/ai'
import { Section } from './Section'

interface Props {
  settings: ViewSettings
  set: SetSetting
  /** Whether a model is configured, decided once for the whole dialog. */
  ready: boolean
}

/**
 * The model answering viewers on its own, unprompted.
 *
 * Takes `ready` as a prop rather than asking about the model itself: the answer
 * belongs to the Model section, and a second copy of it could disagree with the
 * first for the frame between a keystroke and the re-render after it — which is
 * exactly when the user is looking at the toggle they just enabled.
 */
export function AnswersSection({ settings, set, ready }: Props) {
  return (
    <Section title="AI answers" section="replies">
      <p className="modal-hint">
        The model reads the same chat and answers on its own, so the room keeps moving while you are
        busy. It is told it may stay quiet, and usually does; what it does say appears in the feed as
        an AI row. This is the one that costs a request — the greeting bot in Panels above is free and
        only fires on &ldquo;hi&rdquo;.
      </p>

      {/* Without a model this feature is dead, and a toggle that can be switched
          on with nothing behind it is the reason it looked broken: it ran, asked,
          got "no endpoint configured" back, and logged it where nobody was
          looking. Said here, before it is switched on, so the state is honest. */}
      {!ready && (
        <p className="modal-hint modal-hint-warn">
          Set up a model under Model below first — this needs one to answer, and will stay silent until
          there is one.
        </p>
      )}

      <div className="settings-toggles">
        <label
          className="toggle"
          title={ready ? 'Let the model answer viewers without being asked' : 'Set up a model first'}
        >
          <input
            type="checkbox"
            checked={settings.aiReply}
            disabled={!ready}
            onChange={(e) => set('aiReply', e.target.checked)}
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
          disabled={!ready}
          onChange={(e) => set('aiReplySeconds', clampSeconds(Number(e.target.value)))}
        />
        <span className="field-note">
          A floor, not a schedule. Between {REPLY_MIN_SECONDS} and {REPLY_MAX_SECONDS} seconds; the
          model decides whether to say anything at all.
        </span>
      </label>

      <label className="field">
        <span className="field-label">How it should behave</span>
        <textarea
          className="input"
          rows={3}
          placeholder="Keep it dry. Never answer anything about how much we have."
          value={settings.aiReplyPersona}
          disabled={!ready}
          onChange={(e) => set('aiReplyPersona', e.target.value)}
        />
        <span className="field-note">
          Added to the model&rsquo;s own instructions, which take these over. Leave empty for the
          defaults.
        </span>
      </label>
    </Section>
  )
}
