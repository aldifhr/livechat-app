/**
 * Reading preferences.
 *
 * One place for everything about how the feed looks and what it shows, so a new
 * setting is a field here and a control in the toolbar rather than a new prop
 * threaded through every component. Persisted to localStorage, because settings
 * that reset on every launch are settings nobody changes.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { host } from '../lib/sidecar'
import { resolveDensity, resolveFont, resolveTheme, type DensityId, type FontId, type ThemeId } from '../lib/theme'

export interface ViewSettings {
  /** Scales the feed's type. Driven by ctrl+scroll. */
  fontScale: number
  /** The look of the whole app, applied as a `data-theme` on <body>. */
  theme: ThemeId
  /** The typeface the whole app is set in, as a `data-font` on <body>. */
  font: FontId
  /** How much air the layout puts around things. */
  density: DensityId
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
  /** Show the session stats panel at the bottom of the window. */
  showStats: boolean
  /** Show the in-app log panel at the bottom of the window. */
  showLog: boolean
  /** Show the ask-the-model panel at the bottom of the window. */
  showAsk: boolean
  /** Play a short blip when a new chat message arrives. */
  chatSound: boolean
  /** Read new chat messages aloud with the system voice. */
  chatTts: boolean
  /** Announce gifts with the neural voice. */
  giftVoice: boolean
  /**
   * The handles that count as "me", comma-separated.
   *
   * More than one because a person streams under one name and chats under
   * another, and a mention of either is a mention of them. Empty means nothing is
   * highlighted and no mention is alerted on — which is the default, because a
   * highlight that fires on the wrong name is worse than none.
   */
  myHandle: string
  /** Play a sound when a message mentions one of those handles. */
  mentionAlert: boolean
  /**
   * Speak the sender's name when a message mentions one of those handles.
   *
   * Its own setting rather than the gift one. They were sharing a flag, which
   * meant the spoken mention was unreachable unless "Say gifts" was also on,
   * and turning that on enabled this as a side effect nobody could see.
   */
  mentionVoice: boolean
  /** Speak the sender's name before each message read aloud. */
  ttsNames: boolean
  /** Which synthesised sound a gift plays. */
  giftTemplate: string
  /** Which synthesised sound a chat message plays. */
  chatTemplate: string
  /**
   * A sound file the user picked, played instead of any template.
   *
   * A path, not the audio itself: the file stays where it is and the app reads it
   * when it fires. Empty means no custom sound, and a template is used instead.
   */
  customSoundPath: string
}

export const DEFAULT_SETTINGS: ViewSettings = {
  fontScale: 1,
  theme: 'default',
  font: 'sans',
  density: 'cozy',
  compact: false,
  hideJoins: false,
  hideFiltered: false,
  showModeratorBadge: true,
  alwaysOnTop: false,
  giftSound: true,
  giftNotice: true,
  showStats: true,
  showLog: true,
  showAsk: true,
  chatSound: false,
  chatTts: false,
  giftVoice: false,
  myHandle: '',
  mentionAlert: false,
  mentionVoice: false,
  ttsNames: true,
  giftTemplate: 'chime',
  chatTemplate: 'blip',
  customSoundPath: '',
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
    const saved = JSON.parse(raw) as Partial<ViewSettings>
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      // A theme or font a previous build offered and this one dropped would
      // otherwise reach the stylesheet as a `data-theme` nothing answers to,
      // leaving the app unstyled and the switcher pointing at a dead option.
      theme: resolveTheme(saved.theme),
      font: resolveFont(saved.font),
      density: resolveDensity(saved.density),
    }
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
    // One attribute each, read by the stylesheet. The theme restyles the whole
    // app; the font and density are orthogonal to it, so they ride on their own
    // attributes rather than being baked into each theme — otherwise picking the
    // pixel theme would lock the font to pixel, and there is no reason it must.
    document.body.dataset.theme = settings.theme
    document.body.dataset.font = settings.font
    document.body.dataset.density = settings.density
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

  // Memoised, because this object is spread into every consumer's props and
  // dependencies. A fresh literal on each render made `settings` a changed value
  // on every message arriving, so effects keyed on it tore down and rebuilt.
  return useMemo(
    () => ({ ...settings, set, nudgeFontScale }),
    [settings, set, nudgeFontScale],
  )
}

function clamp(value: number, min: number, max: number): number {
  return Math.round(Math.min(max, Math.max(min, value)) * 100) / 100
}