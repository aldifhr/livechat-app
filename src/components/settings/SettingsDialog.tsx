import { useState } from 'react'
import type { UseSettingsResult } from '../../hooks/useSettings'
import type { Status } from './shared'
import { LookSection } from './LookSection'
import { PanelsSection } from './PanelsSection'
import { FeedSection } from './FeedSection'
import { SoundsSection } from './SoundsSection'
import { WebhookSection } from './WebhookSection'
import { OverlaySection } from './OverlaySection'

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
 * The nine sections are separate modules under `./settings/`. This file is only
 * the frame around them, which is what it was always doing — the nine groups were
 * already independent `<details>` blocks sharing nothing but the dialog chrome. As
 * one file of eleven hundred lines they shared a file too, so changing the
 * overlay's colour meant reading the webhook's token handling to find out what
 * else was in scope.
 *
 * Two things deliberately stay here rather than in a section. The status line is
 * shared: sounds and webhook both report through it, and the Model section is
 * where it renders, so lifting it keeps one answer rather than three. And the
 * saved model config is a hook's worth of state that the AI answers section needs
 * for a single boolean.
 */

interface Props {
  open: boolean
  settings: UseSettingsResult
  /**
   * The room the app is reading, for the overlay link.
   *
   * Passed in rather than read from a module: the overlay is pointed at whatever
   * this window is pointed at, and a link naming a different room is a link that
   * shows somebody else's chat on somebody's stream.
   */
  roomTarget?: string
  /** The connected room's id, so the overlay link can name it directly. */
  roomId?: string
  onClose: () => void
}

export function SettingsDialog({ open, settings, roomTarget = '', roomId = '', onClose }: Props) {
  // Shared by sounds and webhook: both are answers to "did that work".
  const [status, setStatus] = useState<Status>({ kind: 'idle', text: '' })

  if (!open) return null

  // The nine sections below, in the order they read. The order is load-bearing:
  // the UI tests find a field by what comes first in the document — the model key
  // is matched on its placeholder precisely because the webhook token is also a
  // password input and sits earlier.

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
        <SoundsSection settings={settings} set={settings.set} status={status} setStatus={setStatus} />
        <WebhookSection status={status} setStatus={setStatus} />
        <OverlaySection settings={settings} set={settings.set} roomTarget={roomTarget} roomId={roomId} />
      </div>
    </div>
  )
}