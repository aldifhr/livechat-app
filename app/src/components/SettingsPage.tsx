import type { UseSettingsResult } from '../hooks/useSettings'
import { LookSection } from './settings/LookSection'
import { FeedSection } from './settings/FeedSection'
import { SoundsSection } from './settings/SoundsSection'

export function SettingsPage({ settings }: { settings: UseSettingsResult }) {
  return (
    <main className="page-view settings-page">
      <header className="page-view-head">
        <h1>Settings</h1>
        <p>Configure the app’s appearance, feed, and sounds.</p>
      </header>
      <LookSection settings={settings} set={settings.set} />
      <FeedSection settings={settings} set={settings.set} />
      <SoundsSection settings={settings} set={settings.set} />
    </main>
  )
}
