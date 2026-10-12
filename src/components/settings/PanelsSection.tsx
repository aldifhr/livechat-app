import type { ViewSettings } from '../../hooks/useSettings'
import type { SetSetting } from './shared'
import { Section } from './Section'

interface Props {
  settings: ViewSettings
  set: SetSetting
}

/** The reading toggles, in the order they read. */
const PANEL_TOGGLES: { key: keyof ViewSettings; label: string; hint: string }[] = [
  { key: 'showStats', label: 'Stats panel', hint: 'Session numbers below the chat' },
  { key: 'showLog', label: 'Log panel', hint: 'What the bridge reported, below the chat' },
]

/**
 * The two bars along the bottom of the window.
 *
 * Their own group because they are chrome rather than content: somebody turning a
 * panel on is deciding what the window looks like, which is the same decision as
 * Look and nothing to do with the feed above them.
 */
export function PanelsSection({ settings, set }: Props) {
  return (
    <Section title="Panels">
      <div className="settings-toggles">
        {PANEL_TOGGLES.map((option) => (
          <label key={option.key} className="toggle" title={option.hint}>
            <input
              type="checkbox"
              checked={Boolean(settings[option.key])}
              onChange={(e) => set(option.key, e.target.checked)}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
    </Section>
  )
}
