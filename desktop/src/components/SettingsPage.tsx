import type { UseSettingsResult } from '../hooks/useSettings'
import { LookSection } from './settings/LookSection'
import { FeedSection } from './settings/FeedSection'
import { SoundsSection } from './settings/SoundsSection'

export function SettingsPage({ settings }: { settings: UseSettingsResult }) {
  return (
    <main className="page-view settings-page flex min-h-0 flex-1 flex-col gap-3.5 overflow-auto p-5 [flex:1_1_auto] [min-height:0] [overflow:auto] [padding:20px] [&_.stats-panel]:[width:min(900px,_100%)] [&_.stats-panel]:[margin:0_auto] [&_.stats-panel]:[border:1px_solid_var(--line)] [&_.stats-panel]:[border-radius:var(--radius)] [&_.log-panel]:[width:min(900px,_100%)] [&_.log-panel]:[margin:0_auto] [&_.log-panel]:[border:1px_solid_var(--line)] [&_.log-panel]:[border-radius:var(--radius)] [&_.stats-body]:[max-height:none] [&_.stats-body]:[overflow:visible] [&_.log-panel]:[display:flex] [&_.log-panel]:[min-height:180px] [&_.log-panel]:[flex-direction:column] [&_.log-list]:[flex:1_1_auto] [&_.log-list]:[max-height:none] [&_.log-list]:[min-height:120px]">
      <header className="page-view-head mx-auto mb-[18px] w-full max-w-[900px] [margin:0_auto_18px] [width:min(900px,_100%)] [&_h1]:[margin:0] [&_h1]:[font-size:20px] [&_p]:[margin:4px_0_0] [&_p]:[color:var(--muted)] [&_p]:[font-size:12px]">
        <h1 className="m-0 text-xl">Settings</h1>
        <p className="mt-1 mb-0 text-xs text-app-muted">Configure the app’s appearance, feed, and sounds.</p>
      </header>
      <LookSection settings={settings} set={settings.set} />
      <FeedSection settings={settings} set={settings.set} />
      <SoundsSection settings={settings} set={settings.set} />
    </main>
  )
}
