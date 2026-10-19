/**
 * Reading preferences.
 *
 * One place for everything about how the feed looks and what it shows, so a new
 * setting is a field in `./lib/settings-schema` and a control in the toolbar
 * rather than a new prop threaded through every component. Persisted to
 * `localStorage`, because settings that reset on every launch are settings nobody
 * changes.
 *
 * What a saved profile means, which fields a build used to have, and what happens
 * to a value from a build that no longer exists: all of that is in the schema, not
 * here. This file is only the React half — read once, write on change, and hand
 * out one stable object.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { host } from '../lib/sidecar'
import { clampFontScale, parseSettings, type ViewSettings } from '../lib/settings-schema'

// Re-exported rather than moved silently: the settings sections and the shared
// settings helper type import it from the hook, and a settings type is not worth
// changing the import path over.
export type { ViewSettings } from '../lib/settings-schema'

export interface UseSettingsResult extends ViewSettings {
  set: <K extends keyof ViewSettings>(key: K, value: ViewSettings[K]) => void
  nudgeFontScale: (delta: number) => void
}

/** Held between runs, and read once at startup so the first paint is right. */
function load(): ViewSettings {
  try {
    const raw = localStorage.getItem('livechat.settings')
    // The schema defaults every field, so an absent profile and a profile of
    // nothing useful both land on the defaults without a branch here.
    return parseSettings(raw ? JSON.parse(raw) : undefined)
  } catch {
    // Unparseable JSON is not worth failing over: the app starts on defaults and
    // the next save overwrites whatever was there.
    return parseSettings(undefined)
  }
}

function save(settings: ViewSettings): void {
  try {
    localStorage.setItem('livechat.settings', JSON.stringify(settings))
  } catch {
    // A read-only profile is not worth failing over; the settings simply will not
    // survive a restart.
  }
}

export function useSettings(): UseSettingsResult {
  const [settings, setSettings] = useState<ViewSettings>(load)

  useEffect(() => {
    save(settings)
    // Theme, font, and density are rendered by Tailwind classes on the app root.
  }, [settings])

  useEffect(() => {
    // Window-level, so it is the host that owns it rather than a style that could
    // drift from what the window actually does.
    host.setAlwaysOnTop(settings.alwaysOnTop).catch(() => {
      // A window manager that refuses is not worth interrupting the user over.
    })
  }, [settings.alwaysOnTop])

  const set = useCallback(<K extends keyof ViewSettings>(key: K, value: ViewSettings[K]) => {
    setSettings((previous) => (previous[key] === value ? previous : { ...previous, [key]: value }))
  }, [])

  const nudgeFontScale = useCallback((delta: number) => {
    setSettings((previous) => ({
      ...previous,
      fontScale: clampFontScale(previous.fontScale + delta),
    }))
  }, [])

  // Memoised, because this object is spread into every consumer's props and
  // dependencies. A fresh literal on each render made `settings` a changed value
  // on every message arriving, so effects keyed on it tore down and rebuilt.
  return useMemo(
    () => ({ ...settings, set, nudgeFontScale }),
    [settings, set, nudgeFontScale],
  )
}