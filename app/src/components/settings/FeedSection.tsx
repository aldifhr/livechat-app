import type { ViewSettings } from '../../hooks/useSettings'
import { message, type SetSetting, type Status } from './shared'
import type { ReactNode } from 'react'
import { useState } from 'react'
import { Section } from './Section'
import { TTS_LANGUAGES, TTS_PACES, languageSample } from '../../lib/voices'
import { preview } from '../../lib/voice'

interface Props {
  settings: ViewSettings
  set: SetSetting
}

type ToggleOption = { key: keyof ViewSettings; label: string; hint: string }

/**
 * What the feed looks like.
 *
 * Split out from the sound and alert toggles on purpose: these change what is on
 * screen, and the ones below change what you hear and get told about. Rendered as
 * one mixed grid, a user scanning for "hide the joins" has to read every unrelated
 * toggle to find it — the same reason the groups are sections rather than one long
 * list.
 *
 * The collapse switch was on the toolbar for as long as there was a toolbar to
 * put it on. It reads like something that belongs with the feed, because it changes
 * the feed, and the toolbar kept only the stream itself — so it lives here now
 * with the other things that decide which rows exist.
 */
const FEED_TOGGLES: { key: keyof ViewSettings; label: string; hint: string }[] = [
  { key: 'compact', label: 'Compact', hint: 'One line per message, no avatars' },
  { key: 'collapse', label: 'Collapse spam', hint: 'Fold identical consecutive messages into one row' },
  { key: 'hideJoins', label: 'Hide joins', hint: 'Drop "X joined the stream" rows' },
  { key: 'hideFiltered', label: 'Hide filtered', hint: 'Drop messages TikTok already filtered' },
  { key: 'showModeratorBadge', label: 'Moderator badge', hint: 'Show the MOD badge on chat rows' },
  { key: 'alwaysOnTop', label: 'On top', hint: 'Keep the window above others' },
]

/**
 * What fires on an event, and whether the app talks back.
 *
 * Its own group because it is the "notify me" cluster — sound, toast, voice, the
 * greeting reply — and someone setting those up is
 * making one decision ("how loud should this be"), not reading them off a list
 * mixed with how the feed is laid out.
 */
const EVENT_TOGGLES: { key: keyof ViewSettings; label: string; hint: string }[] = [
  { key: 'giftSound', label: 'Gift sound', hint: 'Chime when a gift arrives' },
  { key: 'joinSound', label: 'Join sound', hint: 'A soft tap when somebody new arrives' },
  { key: 'followSound', label: 'Follow sound', hint: 'Play a short sound when somebody follows' },
  { key: 'shareSound', label: 'Share sound', hint: 'Play a short sound when somebody shares' },
  { key: 'giftNotice', label: 'Gift notice', hint: 'Raise a desktop toast when a gift arrives' },
  { key: 'giftVoice', label: 'Say gifts', hint: 'Announce each gift with the neural voice' },
  { key: 'followVoice', label: 'Say follows', hint: 'Announce each new follower with the neural voice' },
  { key: 'shareVoice', label: 'Say shares', hint: 'Announce each stream share with the neural voice' },
  { key: 'autoReply', label: 'Auto-reply', hint: 'Automatically reply when someone greets the chat' },
]

const POPUP_TOGGLES: { key: keyof ViewSettings; label: string; hint: string }[] = [
  { key: 'giftPopup', label: 'Gift popup', hint: 'Show a popup when somebody sends a gift' },
  { key: 'followPopup', label: 'Follow popup', hint: 'Show a popup when somebody follows' },
  { key: 'sharePopup', label: 'Share popup', hint: 'Show a popup when somebody shares the stream' },
]

/**
 * Alerts on a new chat message.
 *
 * Separate from the gift toggles because chat is the frequent case and gifts are
 * rare; a sound per message would be unbearable if it shared the gift's defaults.
 */
const ALERT_TOGGLES: {
  key: keyof ViewSettings
  label: string
  hint: string
}[] = [
  { key: 'chatSound', label: 'Chat blip', hint: 'A short tap when a new message arrives' },
  { key: 'chatTts', label: 'Read chat aloud', hint: 'Speak new messages with the neural voice' },
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
    <div className="toggle-group [display:flex] [flex-direction:column] [gap:6px]">
      <span className="toggle-group-label [color:var(--muted)] [font-size:10px] [font-weight:600] [text-transform:uppercase] [letter-spacing:0.06em]">{label}</span>
      <div className="settings-toggles [&_.toggle]:[min-width:0] [&_.toggle_span]:[min-width:0] [&_.toggle_span]:[overflow-wrap:anywhere] [display:grid] [grid-template-columns:repeat(auto-fit,_minmax(140px,_1fr))] [gap:8px_12px]">{children}</div>
    </div>
  )
}

/**
 * How the voice sounds: which language, how fast, how loud, and a sample.
 *
 * One block for all three speaking settings rather than a control on each, for the
 * same reason the voice itself is shared: they are the same mouth, so a control per
 * setting could only ever disagree with itself.
 *
 * Shown whether or not anything is speaking. It used to hide itself until one of the
 * three toggles was on, on the reasoning that with nothing being spoken there is
 * nothing to set — which was defensible for a three-option pace picker and is not
 * defensible here, because the Tester is how you decide whether you want the voice
 * at all. Hidden until it is on, it was unreachable exactly when it was needed: a
 * settings dialog whose TTS section only appears after you have already turned TTS
 * on is a dialog you cannot use to find out what turning it on does.
 *
 * This one block holds state of its own, which the rest of the section does not:
 * the Tester has to await a network round trip and report what came of it, and
 * there is nowhere for that to live but here.
 */
function VoiceSettings({ settings, set }: Props) {
  const [status, setStatus] = useState<Status>({ kind: 'idle', text: '' })

  const chosen = TTS_PACES.find((p) => p.value === settings.ttsPace)
  const percent = Math.round(settings.ttsVolume * 100)

  /**
   * Speaks the sample in the language it is testing, and says whether it worked.
   *
   * Reports the failure rather than swallowing it, which is the only reason this is
   * not just a call to the same function the chat reader uses: a tester that
   * reported "done" while the voice service was unreachable is precisely the voice
   * setting that quietly does nothing.
   */
  async function test() {
    setStatus({ kind: 'busy', text: 'Asking the voice…' })
    try {
      await preview(languageSample(settings.ttsLanguage), {
        pace: settings.ttsPace,
        language: settings.ttsLanguage,
        volume: settings.ttsVolume,
      })
      setStatus({ kind: 'ok', text: 'That is the voice as configured.' })
    } catch (error: unknown) {
      setStatus({ kind: 'error', text: `The voice did not answer — ${message(error)}` })
    }
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-3 mt-2">
        <label className="field [display:flex] [flex-direction:column] [gap:5px]">
          <span className="field-label [color:var(--muted)] [font-size:11px] [text-transform:uppercase] [letter-spacing:0.06em]">Language</span>
          <select
            className="input [flex:1] [min-width:0] [padding:9px_12px] [background:var(--panel-2)] [border:1px_solid_var(--line)] [border-radius:var(--radius)] [color:var(--text)] [font:inherit] [outline:none] [&:focus]:[border-color:var(--accent)] [&::placeholder]:[color:var(--muted)] appearance-none cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 [&_option]:bg-app-panel-2 [&_option]:text-app-text"
            value={settings.ttsLanguage}
            onChange={(e) => set('ttsLanguage', e.target.value)}
          >
            {TTS_LANGUAGES.map((language) => (
              <option key={language.value} value={language.value}>
                {language.label}
              </option>
            ))}
          </select>
        </label>

        <label className="field [display:flex] [flex-direction:column] [gap:5px]">
          <span className="field-label [color:var(--muted)] [font-size:11px] [text-transform:uppercase] [letter-spacing:0.06em]">Reading pace</span>
          <select className="input [flex:1] [min-width:0] [padding:9px_12px] [background:var(--panel-2)] [border:1px_solid_var(--line)] [border-radius:var(--radius)] [color:var(--text)] [font:inherit] [outline:none] [&:focus]:[border-color:var(--accent)] [&::placeholder]:[color:var(--muted)] appearance-none cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 [&_option]:bg-app-panel-2 [&_option]:text-app-text" value={settings.ttsPace} onChange={(e) => set('ttsPace', e.target.value)}>
            {TTS_PACES.map((p) => (
              <option key={p.value} value={p.value} title={p.note}>
                {p.label}
              </option>
            ))}
          </select>
        </label>

        <label className="field col-span-2 [display:flex] [flex-direction:column] [gap:5px]">
          <span className="field-label [color:var(--muted)] [font-size:11px] [text-transform:uppercase] [letter-spacing:0.06em]">Volume</span>
          <span className="field-row min-h-9 [display:flex] [align-items:center] [gap:8px] [&_.input]:[min-width:0] [&_.btn]:[flex:0_0_auto]">
            <input
              className="slider [flex:1] [min-width:0] [height:4px] [margin:0] [appearance:none] [background:var(--panel-2)] [border:1px_solid_var(--line)] [border-radius:999px] [outline:none] [cursor:pointer] [&::-webkit-slider-thumb]:[appearance:none] [&::-webkit-slider-thumb]:[width:14px] [&::-webkit-slider-thumb]:[height:14px] [&::-webkit-slider-thumb]:[background:var(--accent)] [&::-webkit-slider-thumb]:[border:none] [&::-webkit-slider-thumb]:[border-radius:50%] [&::-moz-range-thumb]:[width:14px] [&::-moz-range-thumb]:[height:14px] [&::-moz-range-thumb]:[background:var(--accent)] [&::-moz-range-thumb]:[border:none] [&::-moz-range-thumb]:[border-radius:50%] [&::-moz-range-progress]:[height:4px] [&::-moz-range-progress]:[background:var(--accent)]"
              type="range"
              min={0}
              max={100}
              step={5}
              value={percent}
              onChange={(e) => set('ttsVolume', Number(e.target.value) / 100)}
            />
            <span className="slider-readout [flex:0_0_auto] [min-width:34px] [color:var(--muted)] [font-size:11px] [font-variant-numeric:tabular-nums] [text-align:right]">{percent}%</span>
          </span>
        </label>
      </div>

      <span className="field-row voice-tester [display:flex] [align-items:center] [gap:8px] [&_.input]:[min-width:0] [&_.btn]:[flex:0_0_auto] [flex-wrap:wrap]">
        <button className="btn btn-small [padding:9px_14px] [background:var(--panel-2)] [border:1px_solid_var(--line)] [border-radius:var(--radius)] [color:var(--text)] [font:inherit] [cursor:pointer] [white-space:nowrap] [&:hover:not(:disabled)]:[border-color:var(--muted)] [&:disabled]:[opacity:0.45] [&:disabled]:[cursor:not-allowed] [padding:4px_10px] [font-size:12px]" onClick={test} disabled={status.kind === 'busy'}>
          {status.kind === 'busy' ? 'Speaking…' : '▶ Test the voice'}
        </button>
        {status.text !== '' && (
          <span className={`modal-status [margin:0] [font-size:12px] [overflow-wrap:anywhere] modal-status-${status.kind} ${status.kind === 'error' ? 'text-app-accent' : status.kind === 'ok' ? 'text-app-green' : status.kind === 'busy' ? 'text-app-gold' : ''}`}>{status.text}</span>
        )}
      </span>

      <p className="field-note m-0 w-full leading-relaxed mt-2 [color:var(--muted)] [font-size:11px]">
        Reads chat and gifts. {chosen?.note ?? TTS_PACES[1].note} The sample text is sent to the voice
        service.
      </p>
    </>
  )
}


/**
 * The chat feed: how rows look, what fires on them, and how they are spoken.
 *
 * Every one of these is a checkbox or a text field written straight through to
 * `localStorage`, except the voice block, which holds the Tester's status because
 * a test that awaits a network round trip has nowhere else to say what came of it.
 */
export function FeedSection({ settings, set }: Props) {
  const [category, setCategory] = useState<'display' | 'popups' | 'events' | 'chat'>('display')
  const categories = [
    { id: 'display', label: 'Display' },
    { id: 'popups', label: 'Popups' },
    { id: 'events', label: 'Event alerts' },
    { id: 'chat', label: 'Chat & voice' },
  ] as const

  function toggles(options: ToggleOption[]) {
    return options.map((option) => (
      <label key={option.key} className="toggle [display:inline-flex] [align-items:center] [gap:6px] [color:var(--muted)] [font-size:13px] [cursor:pointer] [user-select:none]" title={option.hint}>
        <input
          type="checkbox"
          checked={Boolean(settings[option.key])}
          onChange={(e) => set(option.key, e.target.checked)}
        />
        <span>{option.label}</span>
      </label>
    ))
  }

  return (
    <Section title="Feed" section="feed">
      <div className="feed-category-tabs [display:flex] [gap:6px] [padding:4px] [border:1px_solid_var(--line)] [border-radius:10px] [background:var(--panel-2)] [overflow-x:auto]" role="tablist" aria-label="Feed setting categories">
        {categories.map((item) => (
          <button
            key={item.id}
            className={`feed-category-tab [flex:1_0_auto] [border:0] [border-radius:7px] [padding:7px_11px] [color:var(--muted)] [background:transparent] [font:inherit] [font-size:11px] [cursor:pointer] [transition:color_140ms_ease,_background_140ms_ease] [&:hover]:[color:var(--text)] [&.is-active]:[color:var(--text)] [&.is-active]:[background:var(--panel)] [&.is-active]:[box-shadow:inset_0_0_0_1px_var(--line)]${category === item.id ? ' is-active' : ''}`}
            type="button"
            role="tab"
            aria-selected={category === item.id}
            onClick={() => setCategory(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="feed-category-panel [min-height:92px]" role="tabpanel">
        {category === 'display' && <>
          <ToggleGroup label="Feed appearance and visibility">{toggles(FEED_TOGGLES)}</ToggleGroup>
          <label className="field mt-3 [display:flex] [flex-direction:column] [gap:5px]">
            <span className="field-label [color:var(--muted)] [font-size:11px] [text-transform:uppercase] [letter-spacing:0.06em]">Auto-scroll</span>
            <select
              className="input [flex:1] [min-width:0] [padding:9px_12px] [background:var(--panel-2)] [border:1px_solid_var(--line)] [border-radius:var(--radius)] [color:var(--text)] [font:inherit] [outline:none] [&:focus]:[border-color:var(--accent)] [&::placeholder]:[color:var(--muted)] appearance-none cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 [&_option]:bg-app-panel-2 [&_option]:text-app-text"
              value={settings.autoScrollMode}
              onChange={(e) => set('autoScrollMode', e.target.value as ViewSettings['autoScrollMode'])}
            >
              <option value="smart">Pause when I scroll up</option>
              <option value="always">Always follow latest</option>
            </select>
            <span className="field-note [color:var(--muted)] [font-size:11px]">Choose whether new messages should pull the feed to the bottom.</span>
          </label>
        </>}
        {category === 'popups' && <>
          <ToggleGroup label="Choose which events show a popup">{toggles(POPUP_TOGGLES)}</ToggleGroup>
          <div className="grid grid-cols-2 gap-3 mt-3">
            <label className="field [display:flex] [flex-direction:column] [gap:5px]">
              <span className="field-label [color:var(--muted)] [font-size:11px] [text-transform:uppercase] [letter-spacing:0.06em]">Gift popup duration</span>
              <span className="field-row min-h-9 [display:flex] [align-items:center] [gap:8px] [&_.input]:[min-width:0] [&_.btn]:[flex:0_0_auto]">
                <input
                  className="slider [flex:1] [min-width:0] [height:4px] [margin:0] [appearance:none] [background:var(--panel-2)] [border:1px_solid_var(--line)] [border-radius:999px] [outline:none] [cursor:pointer] [&::-webkit-slider-thumb]:[appearance:none] [&::-webkit-slider-thumb]:[width:14px] [&::-webkit-slider-thumb]:[height:14px] [&::-webkit-slider-thumb]:[background:var(--accent)] [&::-webkit-slider-thumb]:[border:none] [&::-webkit-slider-thumb]:[border-radius:50%] [&::-moz-range-thumb]:[width:14px] [&::-moz-range-thumb]:[height:14px] [&::-moz-range-thumb]:[background:var(--accent)] [&::-moz-range-thumb]:[border:none] [&::-moz-range-thumb]:[border-radius:50%] [&::-moz-range-progress]:[height:4px] [&::-moz-range-progress]:[background:var(--accent)]"
                  type="range"
                  min={1}
                  max={10}
                  step={1}
                  value={settings.giftPopupDurationSeconds}
                  onChange={(e) => set('giftPopupDurationSeconds', Number(e.target.value))}
                />
                <span className="slider-readout [flex:0_0_auto] [min-width:34px] [color:var(--muted)] [font-size:11px] [font-variant-numeric:tabular-nums] [text-align:right]">{settings.giftPopupDurationSeconds}s</span>
              </span>
              <span className="field-note [color:var(--muted)] [font-size:11px]">How long a gift popup stays on screen.</span>
            </label>
            <label className="field [display:flex] [flex-direction:column] [gap:5px]">
              <span className="field-label [color:var(--muted)] [font-size:11px] [text-transform:uppercase] [letter-spacing:0.06em]">Gift popup size</span>
              <select
                className="input [flex:1] [min-width:0] [padding:9px_12px] [background:var(--panel-2)] [border:1px_solid_var(--line)] [border-radius:var(--radius)] [color:var(--text)] [font:inherit] [outline:none] [&:focus]:[border-color:var(--accent)] [&::placeholder]:[color:var(--muted)] appearance-none cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 [&_option]:bg-app-panel-2 [&_option]:text-app-text"
                value={settings.giftPopupSize}
                onChange={(e) => set('giftPopupSize', e.target.value as ViewSettings['giftPopupSize'])}
              >
                <option value="small">Small</option>
                <option value="medium">Medium</option>
                <option value="large">Large</option>
              </select>
            </label>
            <label className="field col-span-2 [display:flex] [flex-direction:column] [gap:5px]">
              <span className="field-label [color:var(--muted)] [font-size:11px] [text-transform:uppercase] [letter-spacing:0.06em]">Gift popup position</span>
              <select
                className="input [flex:1] [min-width:0] [padding:9px_12px] [background:var(--panel-2)] [border:1px_solid_var(--line)] [border-radius:var(--radius)] [color:var(--text)] [font:inherit] [outline:none] [&:focus]:[border-color:var(--accent)] [&::placeholder]:[color:var(--muted)] appearance-none cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 [&_option]:bg-app-panel-2 [&_option]:text-app-text"
                value={settings.giftPopupPosition}
                onChange={(e) => set('giftPopupPosition', e.target.value as ViewSettings['giftPopupPosition'])}
              >
                <option value="center">Center</option>
                <option value="top">Top</option>
                <option value="bottom">Bottom, above navigation</option>
              </select>
            </label>
          </div>
        </>}
        {category === 'events' && <ToggleGroup label="Sounds and alerts for live events">{toggles(EVENT_TOGGLES)}</ToggleGroup>}
        {category === 'chat' && <>
          <ToggleGroup label="Chat alerts">
            {toggles(ALERT_TOGGLES)}
          </ToggleGroup>
          <VoiceSettings settings={settings} set={set} />
        </>}
      </div>
    </Section>
  )
}
