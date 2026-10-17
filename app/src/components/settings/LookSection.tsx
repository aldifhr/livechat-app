import type { ViewSettings } from '../../hooks/useSettings'
import type { SetSetting } from './shared'
import { DENSITIES, FONTS, THEMES } from '../../lib/theme'
import { Section } from './Section'
import { NativeSelect, NativeSelectOption } from '../ui/native-select'

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
      <div className="settings-grid [display:grid] [grid-template-columns:repeat(auto-fit,_minmax(120px,_1fr))] [gap:10px] [align-items:start] [&_.input]:[flex:0_0_auto]">
        <label className="field [display:flex] [flex-direction:column] [gap:5px]">
          <span className="field-label [color:var(--muted)] [font-size:11px] [text-transform:uppercase] [letter-spacing:0.06em]">Theme</span>
          <NativeSelect
            wrapperClassName="w-full"
            className="input w-full min-w-0 [background:var(--panel-2)] [color:var(--text)]"
            value={settings.theme}
            onChange={(e) => set('theme', e.target.value as ViewSettings['theme'])}
          >
            {THEMES.map((t) => (
              <NativeSelectOption key={t.id} value={t.id} title={t.hint}>
                {t.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>

        <label className="field [display:flex] [flex-direction:column] [gap:5px]">
          <span className="field-label [color:var(--muted)] [font-size:11px] [text-transform:uppercase] [letter-spacing:0.06em]">Font</span>
          <NativeSelect
            wrapperClassName="w-full"
            className="input w-full min-w-0 [background:var(--panel-2)] [color:var(--text)]"
            value={settings.font}
            onChange={(e) => set('font', e.target.value as ViewSettings['font'])}
          >
            {FONTS.map((f) => (
              <NativeSelectOption key={f.id} value={f.id} title={f.hint}>
                {f.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>

        <label className="field [display:flex] [flex-direction:column] [gap:5px]">
          <span className="field-label [color:var(--muted)] [font-size:11px] [text-transform:uppercase] [letter-spacing:0.06em]">Density</span>
          <NativeSelect
            wrapperClassName="w-full"
            className="input w-full min-w-0 [background:var(--panel-2)] [color:var(--text)]"
            value={settings.density}
            onChange={(e) => set('density', e.target.value as ViewSettings['density'])}
          >
            {DENSITIES.map((d) => (
              <NativeSelectOption key={d.id} value={d.id} title={d.hint}>
                {d.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
      </div>
    </Section>
  )
}
