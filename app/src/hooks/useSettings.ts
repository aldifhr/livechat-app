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
import {
  NORMAL_PACE,
  knownPace,
  clampVolume,
  resolveLanguage,
  DEFAULT_LANGUAGE,
  TTS_VOLUME_MAX,
} from '../lib/voices'

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
  /**
   * Fold repeated identical messages into one row with a count.
   *
   * A setting rather than the component state it used to be, because it lived on
   * the toolbar as a glanceable switch and moving it behind the gear took that
   * away — and with it went the only thing making it stick. As local state it was
   * reset on every launch, so a streamer who had turned it off had to do it again
   * every time, which is the sort of setting nobody bothers to configure.
   */
  collapse: boolean
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
  /** Answer a greeting with a line of its own, so a newcomer is not met with
   *  silence. Off by default: it makes the app talk, which has to be asked for. */
  autoReply: boolean
  /** Show the session stats panel at the bottom of the window. */
  showStats: boolean
  /** Show the in-app log panel at the bottom of the window. */
  showLog: boolean
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
  /**
   * How fast the room is read aloud.
   *
   * One value for all three speaking settings, because they are the same mouth —
   * one place to choose how it reads, rather than a separate picker on chat and
   * another on gifts that could disagree.
   */
  ttsPace: string
  /**
   * The language the room is read in.
   *
   * One value for the same reason as the pace, and for a second one: the service
   * offers exactly one voice per language, so the language *is* the voice. Two
   * pickers could only ever disagree about which voice the room should be read in.
   */
  ttsLanguage: string
  /**
   * How loud the voice is, 0..1.
   *
   * Applied to the audio on the page rather than to the synthesis, so it costs
   * nothing and costs nothing to change. Full by default: the voice service has no
   * idea what else is playing, so a level that was right for it can be wrong for a
   * stream with music under it.
   */
  ttsVolume: number
  /** Which synthesised sound a gift plays. */
  giftTemplate: string
  /** Which synthesised sound a chat message plays. */
  chatTemplate: string
  /** Which synthesised sound an arrival plays. */
  joinTemplate: string
  /**
   * A sound file the user picked for gifts, played instead of `giftTemplate`.
   *
   * A path, not the audio itself: the file stays where it is and the app reads it
   * when it fires. Empty means no custom file for this event, and its template is
   * used instead.
   *
   * One path per event rather than the single shared one this used to be. A gift
   * is rare and worth a flourish; chat arrives several a second and needs
   * something short, so one file forced to serve both was a file that suited
   * neither — picking one meant the blip was as loud as the chime.
   */
  giftSoundPath: string
  /** A sound file for chat blips, played instead of `chatTemplate`. */
  chatSoundPath: string
  /** A sound file for arrivals, played instead of `joinTemplate`. */
  joinSoundPath: string
}

export const DEFAULT_SETTINGS: ViewSettings = {
  fontScale: 1,
  theme: 'default',
  font: 'sans',
  density: 'cozy',
  compact: false,
  collapse: true,
  hideJoins: false,
  hideFiltered: false,
  showModeratorBadge: true,
  alwaysOnTop: false,
  giftSound: true,
  joinSound: false,
  giftNotice: true,
  autoReply: false,
  showStats: true,
  showLog: true,
  chatSound: false,
  chatTts: false,
  giftVoice: false,
  myHandle: '',
  mentionAlert: false,
  mentionVoice: false,
  ttsPace: NORMAL_PACE,
  ttsLanguage: DEFAULT_LANGUAGE,
  ttsVolume: TTS_VOLUME_MAX,
  giftTemplate: 'chime',
  chatTemplate: 'blip',
  joinTemplate: 'pop',
  giftSoundPath: '',
  chatSoundPath: '',
  joinSoundPath: '',
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
    const parsed = JSON.parse(raw) as Partial<ViewSettings> & { customSoundPath?: string }
    // An older build had ONE custom file for gifts, chat and joins at once. It is
    // carried into all three rather than dropped: reverting a streamer's pick to
    // the built-ins would look like the file they chose had been forgotten. The
    // old key is destructured out so it does not linger in what we save back.
    const { customSoundPath, ...saved } = parsed
    const legacy = typeof customSoundPath === 'string' ? customSoundPath : ''
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      // A theme or font a previous build offered and this one dropped would
      // otherwise reach the stylesheet as a `data-theme` nothing answers to,
      // leaving the app unstyled and the switcher pointing at a dead option.
      theme: resolveTheme(saved.theme),
      font: resolveFont(saved.font),
      density: resolveDensity(saved.density),
      // A pace a previous build offered and this one dropped. Left alone it would
      // leave the picker showing nothing selected and the host falling back on
      // every message, so it settles on the default here instead.
      ttsPace: knownPace(saved.ttsPace ?? '') ? (saved.ttsPace as string) : DEFAULT_SETTINGS.ttsPace,
      // Same reasoning as the pace: a language code this build no longer offers
      // would reach the host as a `tl` it has never sent, and the room would be
      // read in whatever voice the service answered for a code it did not know.
      ttsLanguage: resolveLanguage(saved.ttsLanguage),
      // Clamped rather than checked, because unlike a name this one has no "is
      // this a value we offer" question — it has a range, and the range is all.
      ttsVolume: clampVolume(saved.ttsVolume ?? DEFAULT_SETTINGS.ttsVolume),
      // A build before the split wrote no per-event path at all, so a missing one
      // falls back to the file that used to serve every event.
      giftSoundPath: saved.giftSoundPath ?? legacy,
      chatSoundPath: saved.chatSoundPath ?? legacy,
      joinSoundPath: saved.joinSoundPath ?? legacy,
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
    // attributes rather than being baked into each theme.
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