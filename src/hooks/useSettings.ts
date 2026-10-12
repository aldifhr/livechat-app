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
import { clampRows, clampNumber, resolveColour, resolveOverlayFont, OVERLAY_DELAY, OVERLAY_SIZE } from '../lib/overlay'
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
  /** Play a sound when a gift arrives. */
  giftSound: boolean
  /**
   * A sound when somebody new arrives.
   *
   * Off by default, like the chat blip: arrivals are the most repetitive event the
   * app has, and a sound per person in a filling room is a sound that stops being
   * information within a minute of being turned on.
   */
  joinSound: boolean
  /** Raise a desktop toast when a gift arrives. */
  giftNotice: boolean
  /** Post each gift to the configured webhook. Off by default: it sends data about
   *  the room to a third party, and that has to be asked for. */
  webhook: boolean
  /** Answer a greeting with a line of its own, so a newcomer is not met with
   *  silence. Off by default: it makes the app talk, which has to be asked for. */
  autoReply: boolean
  /** Show the session stats panel at the bottom of the window. */
  showStats: boolean
  /** Show the in-app log panel at the bottom of the window. */
  showLog: boolean
  /**
   * How the OBS overlay looks.
   *
   * Six flat fields rather than one nested object, because this is what the
   * settings file has always been: flat, and every field readable in
   * `localStorage` without knowing how anything else is shaped. They only become
   * a group in one place — the query string of the link that gets pasted.
   *
   * These change what OBS is showing, not what the app is showing, which is why
   * they are here and not read off the live feed: a streamer tweaks the size
   * until it fits their scene, and that should not require a room to be running.
   */
  overlaySize: number
  /** How many messages are on screen at once. */
  overlayMax: number
  /** Milliseconds between one message appearing and the next. */
  overlayDelay: number
  /** 0 is no backdrop at all, 1 is an opaque panel. */
  overlayBg: number
  overlayNameColour: string
  overlayTextColour: string
  overlayFont: string
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
  /** Which synthesised sound an arrival plays. */
  joinTemplate: string
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
  joinSound: false,
  giftNotice: true,
  webhook: false,
  autoReply: false,
  showStats: true,
  showLog: true,
  overlaySize: 22,
  overlayMax: 8,
  overlayDelay: 500,
  overlayBg: 0,
  overlayNameColour: '#ffd76a',
  overlayTextColour: '#ffffff',
  overlayFont: '"Segoe UI", system-ui, sans-serif',
  chatSound: false,
  chatTts: false,
  giftVoice: false,
  myHandle: '',
  mentionAlert: false,
  mentionVoice: false,
  ttsNames: true,
  giftTemplate: 'chime',
  chatTemplate: 'blip',
  joinTemplate: 'pop',
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
      // And the overlay's styling, for the same reason. These end up in a URL
      // that the host pastes into a query string, so a size of `NaN` would become
      // a link that renders nothing and a font of anything at all would be a way
      // to end the value it sits in.
      overlaySize: clampNumber(saved.overlaySize, OVERLAY_SIZE.min, OVERLAY_SIZE.max, DEFAULT_SETTINGS.overlaySize),
      overlayMax: clampRows(saved.overlayMax, DEFAULT_SETTINGS.overlayMax),
      overlayDelay: Math.round(
        clampNumber(saved.overlayDelay, OVERLAY_DELAY.min, OVERLAY_DELAY.max, DEFAULT_SETTINGS.overlayDelay),
      ),
      overlayBg: clampNumber(saved.overlayBg, 0, 1, DEFAULT_SETTINGS.overlayBg),
      overlayNameColour: resolveColour(saved.overlayNameColour, DEFAULT_SETTINGS.overlayNameColour),
      overlayTextColour: resolveColour(saved.overlayTextColour, DEFAULT_SETTINGS.overlayTextColour),
      overlayFont: resolveOverlayFont(saved.overlayFont),
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