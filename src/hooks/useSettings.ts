/**
 * Reading preferences.
 *
 * One place for everything about how the feed looks and what it shows, so a new
 * setting is a field here and a control in the toolbar rather than a new prop
 * threaded through every component. Persisted to localStorage, because settings
 * that reset on every launch are settings nobody changes.
 */

import { useCallback, useEffect, useState } from 'react'
import { host } from '../lib/sidecar'

export interface ViewSettings {
  /** Scales the feed's type. Driven by ctrl+scroll. */
  fontScale: number
  /** One line per message with no avatar: far more rows fit on screen. */
  compact: boolean
  /** Hide "X joined the stream" rows entirely. */
  hideJoins: boolean
  /** Hide messages TikTok has filtered itself. */
  hideFiltered: boolean
  /** Show the moderator badge on chat rows. */
  showModeratorBadge: boolean
  /** Keep the window above others, for a second monitor. */
  alwaysOnTop: boolean
  /** Chime when a gift arrives. */
  giftSound: boolean
  /** Raise a desktop toast when a gift arrives. */
  giftNotice: boolean
}

export const DEFAULT_SETTINGS: ViewSettings = {
  fontScale: 1,
  compact: false,
  hideJoins: false,
  hideFiltered: false,
  showModeratorBadge: true,
  alwaysOnTop: false,
  giftSound: true,
  giftNotice: true,
}

const FONT_MIN = 0.75
const FONT_MAX = 2

/** Held between runs, and read once at startup so the first paint is right. */
function load(): ViewSettings {
  try {
    const raw = localStorage.getItem('livechat.settings')
    if (!raw) return DEFAULT_SETTINGS
    // Merged over the defaults so a build that adds a field does not leave older
    // saved settings missing it.
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<ViewSettings>) }
  } catch {
    return DEFAULT_SETTINGS
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

export interface UseSettingsResult extends ViewSettings {
  set: <K extends keyof ViewSettings>(key: K, value: ViewSettings[K]) => void
  nudgeFontScale: (delta: number) => void
}

export function useSettings(): UseSettingsResult {
  const [settings, setSettings] = useState<ViewSettings>(load)

  useEffect(() => {
    save(settings)
    // Applied to the root rather than each component, so it reaches the toolbar,
    // the log panel and the jump button as well as the feed.
    document.documentElement.style.setProperty('--feed-font-scale', String(settings.fontScale))
    document.body.classList.toggle('compact', settings.compact)
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
      fontScale: clamp(previous.fontScale + delta, FONT_MIN, FONT_MAX),
    }))
  }, [])

  return { ...settings, set, nudgeFontScale }
}

function clamp(value: number, min: number, max: number): number {
  return Math.round(Math.min(max, Math.max(min, value)) * 100) / 100
}