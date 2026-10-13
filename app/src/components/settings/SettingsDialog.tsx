import type { UseSettingsResult } from '../../hooks/useSettings'
import { LookSection } from './LookSection'
import { PanelsSection } from './PanelsSection'
import { FeedSection } from './FeedSection'
import { SoundsSection } from './SoundsSection'

/**
 * Everything about how the app looks and what it shows, behind one gear.
 *
 * These were spread across the toolbar and the bottom of the window — theme,
 * font and density on their own row, the model on a button, the stats/log/ask
 * panels taking three collapsed bars at the bottom. The result was a window you
 * had to scroll to configure and a feed squeezed between rows of controls. This
 * dialog is where all of it lives: the toolbar keeps only what belongs to the
 * stream itself — the handle, connect, filters — and a single gear opens the rest.
 *
 * The model fields moved here too, so there is one place for every setting
 * rather than a second dialog that opens from the first one's toolbar.
 *
 * The sections are separate modules under `./settings/`. This file is only the
 * frame around them, which is what it was always doing — the groups were already
 * independent `<details>` blocks sharing nothing but the dialog chrome. As one file
 * of eleven hundred lines they shared a file too, so changing one section's colour
 * meant reading another's token handling to find out what else was in scope.
 *
 * Two things used to live here that no longer do. The overlay was configured from
 * this dialog, along with the room it was pointed at, which is why this window
 * still took a `roomTarget` — it is built and served by the backend and configured
 * from the web admin panel instead, so neither the link nor the styling belongs to
 * a window that might be closed: an overlay has to keep working on its own. The
 * webhook went with it, and taking both removed the last thing this dialog shared
 * with another section, so the status line is now owned by the one section that
 * still reports through it.
 */

interface Props {
  open: boolean
  settings: UseSettingsResult
  onClose: () => void
}

export function SettingsDialog({ open, settings, onClose }: Props) {
  if (!open) return null

  // The sections below, in the order they read. The order is load-bearing: the UI
  // tests find a field by what comes first in the document.

  return (
    <div className="modal-scrim" onClick={onClose} role="presentation">
      <div
        className="modal modal-settings"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2 className="modal-title">Settings</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <LookSection settings={settings} set={settings.set} />
        <PanelsSection settings={settings} set={settings.set} />
        <FeedSection settings={settings} set={settings.set} />
        <SoundsSection settings={settings} set={settings.set} />
      </div>
    </div>
  )
}