/**
 * What the app remembers between runs, and how a profile written by some earlier
 * build is turned back into something this one can use.
 *
 * The type and the schema are written out separately on purpose. The type carries
 * the reasoning behind each preference, and that reasoning is most of what makes
 * the file worth reading; inferring the type from the schema would keep the two
 * from drifting but throw every comment away. The `satisfies` in `parseSettings`
 * is the guard that turns a drift between them into a build error instead of a
 * setting that quietly stops being saved.
 *
 * A settings file outlives the build that wrote it. Fields get added, renamed and
 * removed, values get quoted wrong by a hand edit, and a build once stored
 * `customSoundPath` for five events that now each keep their own. So every field
 * here is validated on the way back in, against the catalogue this build actually
 * offers, rather than trusted because it came out of our own `localStorage`.
 */

import { z } from 'zod'
import { DENSITIES, FONTS, THEMES, type DensityId, type FontId, type ThemeId } from './theme'
import {
  DEFAULT_LANGUAGE,
  NORMAL_PACE,
  TTS_LANGUAGES,
  TTS_PACES,
  TTS_VOLUME_MAX,
} from './voices'

export interface ViewSettings {
  /** Scales the feed's type. Driven by ctrl+scroll. */
  fontScale: number
  /** The look of the whole app, applied with Tailwind classes on the app root. */
  theme: ThemeId
  /** The typeface the whole app is set in with a Tailwind font utility. */
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
  /** Follow new chat automatically or keep following only while at the feed tail. */
  autoScrollMode: 'always' | 'smart'
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
   * information within a minute of its being turned on.
   */
  joinSound: boolean
  /** Play a sound when somebody follows. */
  followSound: boolean
  /** Play a sound when somebody shares the stream. */
  shareSound: boolean
  giftSoundVolume: number
  chatSoundVolume: number
  joinSoundVolume: number
  followSoundVolume: number
  shareSoundVolume: number
  giftSoundGapMs: number
  chatSoundGapMs: number
  joinSoundGapMs: number
  followSoundGapMs: number
  shareSoundGapMs: number
  /** Show a popup when somebody sends a gift. */
  giftPopup: boolean
  /** How long a gift popup stays visible, in seconds. */
  giftPopupDurationSeconds: number
  /** Width preset for the gift popup. */
  giftPopupSize: 'small' | 'medium' | 'large'
  /** Screen position for the gift popup. */
  giftPopupPosition: 'center' | 'top' | 'bottom'
  /** Show a popup when somebody follows. */
  followPopup: boolean
  /** Show a popup when somebody shares the stream. */
  sharePopup: boolean
  /** Raise a desktop toast when a gift arrives. */
  giftNotice: boolean
  /**
   * Answer a greeting with a line of its own, so a newcomer is not met with
   * silence. Off by default: it makes the app talk, which has to be asked for.
   */
  autoReply: boolean
  /** Play a short blip when a new chat message arrives. */
  chatSound: boolean
  /** Read new chat messages aloud with the system voice. */
  chatTts: boolean
  /** Announce gifts with the neural voice. */
  giftVoice: boolean
  /** Announce follows with the neural voice. */
  followVoice: boolean
  /** Announce shares with the neural voice. */
  shareVoice: boolean
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
  /** Which synthesised sound a follow plays. */
  followTemplate: string
  /** Which synthesised sound a share plays. */
  shareTemplate: string
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
  /** A sound file for follows, played instead of `followTemplate`. */
  followSoundPath: string
  /** A sound file for shares, played instead of `shareTemplate`. */
  shareSoundPath: string
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
  autoScrollMode: 'smart',
  showModeratorBadge: true,
  alwaysOnTop: false,
  giftSound: true,
  joinSound: false,
  followSound: true,
  shareSound: true,
  giftSoundVolume: 100,
  chatSoundVolume: 100,
  joinSoundVolume: 100,
  followSoundVolume: 100,
  shareSoundVolume: 100,
  giftSoundGapMs: 4000,
  chatSoundGapMs: 500,
  joinSoundGapMs: 2000,
  followSoundGapMs: 1500,
  shareSoundGapMs: 1500,
  giftPopup: true,
  giftPopupDurationSeconds: 3,
  giftPopupSize: 'small',
  giftPopupPosition: 'center',
  followPopup: true,
  sharePopup: true,
  giftNotice: true,
  autoReply: false,
  chatSound: false,
  chatTts: false,
  giftVoice: false,
  followVoice: false,
  shareVoice: false,
  ttsPace: NORMAL_PACE,
  ttsLanguage: DEFAULT_LANGUAGE,
  ttsVolume: TTS_VOLUME_MAX,
  giftTemplate: 'chime',
  chatTemplate: 'blip',
  joinTemplate: 'pop',
  followTemplate: 'chirp',
  shareTemplate: 'retro',
  giftSoundPath: '',
  chatSoundPath: '',
  joinSoundPath: '',
  followSoundPath: '',
  shareSoundPath: '',
}

const FONT_SCALE_MIN = 0.75
const FONT_SCALE_MAX = 2

const GAP_MIN_MS = 100
const GAP_MAX_MS = 30000
const POPUP_SECONDS_MIN = 1
const POPUP_SECONDS_MAX = 10

/**
 * Rounds to two places rather than merely clamping.
 *
 * A slider dragged at full resolution would otherwise write a dozen settings
 * changes on the way to 100%, and every one of them is a `localStorage` write.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.round(Math.min(max, Math.max(min, value)) * 100) / 100
}

/** The feed's type, bounded. Exported because ctrl+scroll nudges it. */
export function clampFontScale(value: number): number {
  return clamp(value, FONT_SCALE_MIN, FONT_SCALE_MAX)
}

/**
 * A number that is pulled back into range rather than rejected.
 *
 * Clamping and falling back are different answers to different mistakes. A value
 * of 150 for a volume is someone who dragged past the end, and the nearest real
 * setting is what they meant; a value of `"loud"` is not a number at all and there
 * is no near-miss for it, so that one takes the default. `ttsVolume` is the other
 * case: `Audio.volume` throws `IndexSizeError` on anything outside 0..1, so an
 * out-of-range number is not a cosmetic problem but a voice throwing inside the
 * playback path, which is caught and read as "the voice service is unreachable".
 */
function bounded(min: number, max: number, fallback: number) {
  return z.number().catch(fallback).transform((value) => clamp(value, min, max))
}

/**
 * A saved choice that this build may no longer offer.
 *
 * Both catalogues are read rather than restated, so a theme or a pace added to
 * `theme.ts` or `voices.ts` is valid here the moment it is added there. Returning
 * the fallback rather than the unknown string matters: an unrecognised theme would
 * otherwise reach `document.body.dataset.theme` as a body attribute no stylesheet
 * answers to, leaving the app unstyled with the switcher pointing at a theme that
 * does nothing. Same for a pace, which would leave the picker showing nothing
 * selected and the host falling back on every message, and a language, which
 * would reach the voice service as a `tl` it has never sent.
 */
function offered<T extends string>(options: readonly T[], fallback: T) {
  return z.enum(options as [T, ...T[]]).catch(fallback)
}

const themeIds = THEMES.map((theme) => theme.id)
const fontIds = FONTS.map((font) => font.id)
const densityIds = DENSITIES.map((density) => density.id)
const paceValues = TTS_PACES.map((pace) => pace.value)
const languageValues = TTS_LANGUAGES.map((language) => language.value)

export const SettingsSchema = z.object({
  fontScale: bounded(FONT_SCALE_MIN, FONT_SCALE_MAX, DEFAULT_SETTINGS.fontScale),
  theme: offered(themeIds, DEFAULT_SETTINGS.theme),
  font: offered(fontIds, DEFAULT_SETTINGS.font),
  density: offered(densityIds, DEFAULT_SETTINGS.density),
  compact: z.boolean().catch(DEFAULT_SETTINGS.compact),
  collapse: z.boolean().catch(DEFAULT_SETTINGS.collapse),
  hideJoins: z.boolean().catch(DEFAULT_SETTINGS.hideJoins),
  hideFiltered: z.boolean().catch(DEFAULT_SETTINGS.hideFiltered),
  autoScrollMode: offered(['always', 'smart'] as const, DEFAULT_SETTINGS.autoScrollMode),
  showModeratorBadge: z.boolean().catch(DEFAULT_SETTINGS.showModeratorBadge),
  alwaysOnTop: z.boolean().catch(DEFAULT_SETTINGS.alwaysOnTop),
  giftSound: z.boolean().catch(DEFAULT_SETTINGS.giftSound),
  joinSound: z.boolean().catch(DEFAULT_SETTINGS.joinSound),
  followSound: z.boolean().catch(DEFAULT_SETTINGS.followSound),
  shareSound: z.boolean().catch(DEFAULT_SETTINGS.shareSound),
  giftSoundVolume: bounded(0, 100, DEFAULT_SETTINGS.giftSoundVolume),
  chatSoundVolume: bounded(0, 100, DEFAULT_SETTINGS.chatSoundVolume),
  joinSoundVolume: bounded(0, 100, DEFAULT_SETTINGS.joinSoundVolume),
  followSoundVolume: bounded(0, 100, DEFAULT_SETTINGS.followSoundVolume),
  shareSoundVolume: bounded(0, 100, DEFAULT_SETTINGS.shareSoundVolume),
  giftSoundGapMs: bounded(GAP_MIN_MS, GAP_MAX_MS, DEFAULT_SETTINGS.giftSoundGapMs),
  chatSoundGapMs: bounded(GAP_MIN_MS, GAP_MAX_MS, DEFAULT_SETTINGS.chatSoundGapMs),
  joinSoundGapMs: bounded(GAP_MIN_MS, GAP_MAX_MS, DEFAULT_SETTINGS.joinSoundGapMs),
  followSoundGapMs: bounded(GAP_MIN_MS, GAP_MAX_MS, DEFAULT_SETTINGS.followSoundGapMs),
  shareSoundGapMs: bounded(GAP_MIN_MS, GAP_MAX_MS, DEFAULT_SETTINGS.shareSoundGapMs),
  giftPopup: z.boolean().catch(DEFAULT_SETTINGS.giftPopup),
  giftPopupDurationSeconds: bounded(
    POPUP_SECONDS_MIN,
    POPUP_SECONDS_MAX,
    DEFAULT_SETTINGS.giftPopupDurationSeconds,
  ).transform(Math.round),
  giftPopupSize: offered(['small', 'medium', 'large'] as const, DEFAULT_SETTINGS.giftPopupSize),
  giftPopupPosition: offered(
    ['center', 'top', 'bottom'] as const,
    DEFAULT_SETTINGS.giftPopupPosition,
  ),
  followPopup: z.boolean().catch(DEFAULT_SETTINGS.followPopup),
  sharePopup: z.boolean().catch(DEFAULT_SETTINGS.sharePopup),
  giftNotice: z.boolean().catch(DEFAULT_SETTINGS.giftNotice),
  autoReply: z.boolean().catch(DEFAULT_SETTINGS.autoReply),
  chatSound: z.boolean().catch(DEFAULT_SETTINGS.chatSound),
  chatTts: z.boolean().catch(DEFAULT_SETTINGS.chatTts),
  giftVoice: z.boolean().catch(DEFAULT_SETTINGS.giftVoice),
  followVoice: z.boolean().catch(DEFAULT_SETTINGS.followVoice),
  shareVoice: z.boolean().catch(DEFAULT_SETTINGS.shareVoice),
  ttsPace: offered(paceValues, DEFAULT_SETTINGS.ttsPace),
  ttsLanguage: offered(languageValues, DEFAULT_SETTINGS.ttsLanguage),
  ttsVolume: bounded(0, 1, DEFAULT_SETTINGS.ttsVolume),
  giftTemplate: z.string().catch(DEFAULT_SETTINGS.giftTemplate),
  chatTemplate: z.string().catch(DEFAULT_SETTINGS.chatTemplate),
  joinTemplate: z.string().catch(DEFAULT_SETTINGS.joinTemplate),
  followTemplate: z.string().catch(DEFAULT_SETTINGS.followTemplate),
  shareTemplate: z.string().catch(DEFAULT_SETTINGS.shareTemplate),
  giftSoundPath: z.string().catch(DEFAULT_SETTINGS.giftSoundPath),
  chatSoundPath: z.string().catch(DEFAULT_SETTINGS.chatSoundPath),
  joinSoundPath: z.string().catch(DEFAULT_SETTINGS.joinSoundPath),
  followSoundPath: z.string().catch(DEFAULT_SETTINGS.followSoundPath),
  shareSoundPath: z.string().catch(DEFAULT_SETTINGS.shareSoundPath),
})

/**
 * Rewrites the shape a build that is no longer around would have written.
 *
 * Runs before the schema rather than inside it, because a migration moves whole
 * fields across and a schema cannot express that. An older build had ONE custom
 * file for gifts, chat and joins at once: it is carried into all three rather than
 * dropped, because reverting a streamer's pick to the built-ins would look like the
 * file they chose had been forgotten. Follows and shares get nothing — that build
 * had no per-event path for them, so handing them the shared file would be
 * inventing a choice nobody made.
 *
 * The keys belonging to removed features are deleted rather than left to the
 * schema, so that saving the profile afterwards cleans them out of `localStorage`
 * instead of carrying them forever. `z.object` drops anything else unrecognised on
 * its own, which is what makes that tidy-up hold for keys no code still names.
 */
function carryLegacy(input: unknown): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return {}
  const saved: Record<string, unknown> = { ...(input as Record<string, unknown>) }
  const legacy = typeof saved.customSoundPath === 'string' ? saved.customSoundPath : ''
  delete saved.customSoundPath
  delete saved.myHandle
  delete saved.mentionAlert
  delete saved.mentionVoice
  if (saved.giftSoundPath === undefined) saved.giftSoundPath = legacy
  if (saved.chatSoundPath === undefined) saved.chatSoundPath = legacy
  if (saved.joinSoundPath === undefined) saved.joinSoundPath = legacy
  if (saved.followSoundPath === undefined) saved.followSoundPath = ''
  if (saved.shareSoundPath === undefined) saved.shareSoundPath = ''
  return saved
}

/**
 * Turns whatever was in `localStorage` into settings this build can act on.
 *
 * The `satisfies` is the whole reason the type is written out separately from the
 * schema: it fails the build when a field is added to one and forgotten in the
 * other, which is the failure mode that costs a setting silently, one build at a
 * time, with nothing in the app to show for it.
 */
export function parseSettings(input: unknown): ViewSettings {
  const parsed = SettingsSchema.parse(carryLegacy(input))
  return parsed satisfies ViewSettings
}