import type { ViewSettings } from '../../hooks/useSettings'
import type { SetSetting } from './shared'
import { DENSITIES, FONTS, THEMES } from '../../lib/theme'
import { Section } from './Section'

interface Props {
  settings: ViewSettings
  set: SetSetting
}

/**
 * Theme, font and density — the three that decide what the app looks like.
 *
 * First and open by default, because this is where somebody comes when the window
 * does not suit them, and it should not be behind a disclosure they have to find.
 */
export function LookSection({ settings, set }: Props) {
  return (
    <Section title="Look" defaultOpen>
      <div className="settings-grid">
        <label className="field">
          <span className="field-label">Theme</span>
          <select
            className="input"
            value={settings.theme}
            onChange={(e) => set('theme', e.target.value as ViewSettings['theme'])}
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
            onChange={(e) => set('font', e.target.value as ViewSettings['font'])}
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
            onChange={(e) => set('density', e.target.value as ViewSettings['density'])}
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
  )
}
