import type { ViewSettings } from '../../hooks/useSettings'
import type { SetSetting } from './shared'
import type { ReactNode } from 'react'
import { Section } from './Section'

interface Props {
  settings: ViewSettings
  set: SetSetting
}

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

/**
 * A labelled run of toggles inside a section.
 *
 * Three different kinds of setting share this section — how the feed looks, what
 * fires on events, and how the message is spoken — and lumping them into one grid
 * is what made it unreadable: a row of eleven checkboxes with no grouping, where
 * "hide the joins" sat between a gift sound and an auto-reply. Each group gets a
 * small caption so the eye can find the one it wants without reading every label.
 */
function ToggleGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="toggle-group">
      <span className="toggle-group-label">{label}</span>
      <div className="settings-toggles">{children}</div>
    </div>
  )
}

/**
 * The chat feed: how rows look, what fires on them, and how they are spoken.
 *
 * Purely the saved settings and no state of its own — every one of these is a
 * checkbox or a text field written straight through to `localStorage`, which is
 * why this section needs nothing but the settings object and its setter.
 */
export function FeedSection({ settings, set }: Props) {
  return (
    <Section title="Feed" section="feed">
      <ToggleGroup label="What the feed looks like">
        {FEED_TOGGLES.map((option) => (
          <label key={option.key} className="toggle" title={option.hint}>
            <input
              type="checkbox"
              checked={Boolean(settings[option.key])}
              onChange={(e) => set(option.key, e.target.checked)}
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
              onChange={(e) => set(option.key, e.target.checked)}
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
          onChange={(e) => set('myHandle', e.target.value)}
          spellCheck={false}
          autoComplete="off"
        />
        <span className="field-note">
          Comma-separated. A message naming any of these is highlighted, and alerted on if the mention
          alert is on. Leave empty for no highlights at all.
        </span>
      </label>

      <ToggleGroup label="How messages are spoken">
        {ALERT_TOGGLES.filter((option) => !option.needs || settings[option.needs]).map((option) => (
          <label key={option.key} className="toggle" title={option.hint}>
            <input
              type="checkbox"
              checked={Boolean(settings[option.key])}
              onChange={(e) => set(option.key, e.target.checked)}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </ToggleGroup>
    </Section>
  )
}
