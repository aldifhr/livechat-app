/**
 * The chat overlay: a link a streamer pastes into OBS.
 *
 * The host owns the URL because two of its parts are not the page's to know — the
 * backend address is a file on disk and the handle is whatever was typed into the
 * toolbar. Everything else is styling, and styling lives in the query string so
 * that the link is an honest description of what is on screen: read it back and
 * you can tell what OBS was pointed at, without asking the app.
 *
 * That leaves this module holding the parts that are decisions rather than
 * transport — what the settings are called, what their bounds are, and what a
 * value nobody set falls back to. Each of those is a place where a bad default
 * is invisible until somebody is live, which is the worst time to find it.
 */

/** How the overlay reads the settings it was given. */
export interface OverlayStyle {
  /** Text size in px. */
  size: number
  /** How many messages are on screen at once. */
  max: number
  /**
   * Milliseconds between one message appearing and the next.
   *
   * Not a decoration setting. Rendered straight through, a busy room puts its last
   * eight messages on screen in a tenth of a second and the viewer sees a wall; at
   * this pace the same eight arrive as eight readable beats. Which is right depends
   * on how fast the room talks and how much of the screen the chat takes, so it is
   * the one styling value here that a streamer is expected to change.
   */
  delay: number
  /** 0 is no backdrop at all, 1 is an opaque panel. */
  bg: number
  /** The sender's name. */
  nameColour: string
  /** The message. */
  textColour: string
  /** A CSS font stack, quoted names and all. */
  font: string
  /** Which corner of the OBS canvas the chat grows from. */
  position: OverlayPosition
  /** Maximum chat column width, measured in ems at the current text size. */
  maxWidth: number
  /** Studio bubble opacity, from transparent to opaque. */
  bubbleOpacity: number
  /** Accent for gift rows and their diamond count. */
  giftColour: string
}

export type OverlayPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

export const OVERLAY_DEFAULT_STYLE: OverlayStyle = {
  size: 22,
  max: 8,
  delay: 500,
  // 0, and deliberately: the video is meant to show through. The backdrop sits
  // behind each line rather than behind the whole list precisely so it can be off
  // by default — a panel over a stream reads as a dialog box. It is raised by the
  // slider when a scene is too bright for the text-shadow to carry alone, and
  // that is a decision about the video, which the dashboard cannot see.
  bg: 0,
  nameColour: '#ffd76a',
  textColour: '#ffffff',
  font: '"Segoe UI", system-ui, sans-serif',
  position: 'bottom-left',
  maxWidth: 34,
  bubbleOpacity: 0.82,
  giftColour: '#ffd76a',
}

/**
 * The bounds the page enforces too.
 *
 * Repeated on this side on purpose: the page is loaded by something else and is
 * handed whatever is in the URL, so a value the app thinks is fine but the page
 * clamps anyway would show up as a number in OBS that does not match the one in
 * the settings. Keeping them identical is what makes the link mean what it says.
 */
export const OVERLAY_SIZE = { min: 8, max: 96 }
export const OVERLAY_MAX_ROWS = { min: 1, max: 50 }
/**
 * The bounds on the gap between two messages.
 *
 * The same numbers the page enforces. Twelve hundredths of a second is as fast as
 * it reads as anything other than one block of text; three seconds is a single
 * message sitting alone long enough for the room to have moved on.
 */
export const OVERLAY_DELAY = { min: 120, max: 3000 }
export const OVERLAY_MAX_WIDTH = { min: 18, max: 64 }

const OVERLAY_POSITIONS: readonly OverlayPosition[] = [
  'top-left', 'top-right', 'bottom-left', 'bottom-right',
]

export function resolveOverlayPosition(value: unknown): OverlayPosition {
  return typeof value === 'string' && OVERLAY_POSITIONS.includes(value as OverlayPosition)
    ? value as OverlayPosition
    : OVERLAY_DEFAULT_STYLE.position
}

/**
 * A colour, or nothing.
 *
 * A hex triplet, a hex triplet with alpha, or one of the handful of CSS colour
 * keywords — not anything else. This value ends up in a query string that the
 * page drops into a custom property, so a free-text field would be a way to put
 * `red; background: url(https://elsewhere)` into that string. Refusing it here
 * means the page can trust what it was given, rather than each value being
 * re-checked where it is used.
 */
export function isSafeColour(value: string): boolean {
  const text = value.trim()
  if (/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(text)) return true
  return ['white', 'black', 'red', 'green', 'blue', 'yellow', 'cyan', 'magenta', 'orange', 'pink'].includes(
    text.toLowerCase(),
  )
}

/** A colour, or the default. Used on every value loaded from storage. */
export function resolveColour(value: unknown, fallback: string): string {
  return typeof value === 'string' && isSafeColour(value) ? value.trim() : fallback
}

/**
 * A number inside its bounds.
 *
 * Storage, a number field and a hand-edited query string all produce values that
 * are not numbers, or are numbers outside the range. Two of those are the same
 * bug: `Number('')` is `0`, so a field that has been cleared would arrive as
 * zero rather than as nothing, and a font size of zero renders nothing at all
 * while looking perfectly configured.
 */
export function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  // A blank is missing, not zero. Checked before the conversion, because the
  // conversion is where a blank becomes a number.
  if (value === null || value === undefined || value === '') return fallback
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

/** A whole number of rows, which is what the page counts in. */
export function clampRows(value: unknown, fallback: number): number {
  return Math.round(clampNumber(value, OVERLAY_MAX_ROWS.min, OVERLAY_MAX_ROWS.max, fallback))
}

/**
 * A font stack with nothing in it that would end the value.
 *
 * The only font resolver on this side. There used to be a second, `resolveFont`,
 * byte-for-byte identical and called by nobody — it existed only because the name
 * clashes with `theme.ts`'s `resolveFont`, which answers a different question
 * (picking from a catalogue rather than validating a string). Two functions under
 * one name is how a call site ends up asking the wrong one, so the survivor is
 * named for what it resolves.
 */
export function resolveOverlayFont(value: unknown): string {
  if (typeof value !== 'string') return OVERLAY_DEFAULT_STYLE.font
  const text = value.trim()
  if (text === '' || text.length > 120) return OVERLAY_DEFAULT_STYLE.font
  // No `;`, no `{`, no newline. Those three are what a CSS declaration is made
  // of, and this value is written into a custom property without escaping.
  if (/[;{}\n\r]/.test(text)) return OVERLAY_DEFAULT_STYLE.font
  return text
}

/**
 * A chat style read out of a query string.
 *
 * Here rather than in each customizer because the customizer and the page are two
 * readers of one string: a value one of them accepts and the other clamps would
 * show one number in the dashboard and a different one in OBS. An absent parameter
 * is missing, not zero — `clampNumber` treats a null from `URLSearchParams.get` as
 * absent, which is what stops a cleared field arriving as a size of zero.
 */
export function chatStyleFromQuery(search: string): OverlayStyle {
  const q = new URLSearchParams(search)
  const raw = (key: string) => q.get(key)
  return {
    size: clampNumber(raw('size'), OVERLAY_SIZE.min, OVERLAY_SIZE.max, OVERLAY_DEFAULT_STYLE.size),
    max: clampRows(raw('max'), OVERLAY_DEFAULT_STYLE.max),
    delay: Math.round(
      clampNumber(raw('delay'), OVERLAY_DELAY.min, OVERLAY_DELAY.max, OVERLAY_DEFAULT_STYLE.delay),
    ),
    bg: clampNumber(raw('bg'), 0, 1, OVERLAY_DEFAULT_STYLE.bg),
    nameColour: resolveColour(raw('name'), OVERLAY_DEFAULT_STYLE.nameColour),
    textColour: resolveColour(raw('color'), OVERLAY_DEFAULT_STYLE.textColour),
    font: resolveOverlayFont(raw('font')),
    position: resolveOverlayPosition(raw('position')),
    maxWidth: clampNumber(raw('width'), OVERLAY_MAX_WIDTH.min, OVERLAY_MAX_WIDTH.max, OVERLAY_DEFAULT_STYLE.maxWidth),
    bubbleOpacity: clampNumber(raw('bubble'), 0, 1, OVERLAY_DEFAULT_STYLE.bubbleOpacity),
    giftColour: resolveColour(raw('gift'), OVERLAY_DEFAULT_STYLE.giftColour),
  }
}

/** A chat style as the query parameters the page reads. */
export function chatStyleToQuery(style: OverlayStyle): Record<string, string> {
  return {
    size: String(style.size),
    max: String(style.max),
    delay: String(style.delay),
    bg: String(style.bg),
    name: style.nameColour,
    color: style.textColour,
    font: style.font,
    position: style.position,
    width: String(style.maxWidth),
    bubble: String(style.bubbleOpacity),
    gift: style.giftColour,
  }
}

// --------------------------------------------------------------------------
// the top-chatters board
// --------------------------------------------------------------------------

/** The title printed above the ranking. */
export const OVERLAY_DEFAULT_TITLE = 'Top Yapping'

/**
 * The bound on that title.
 *
 * The page drops it into the DOM as text, so there is no markup to guard against —
 * the reason for a cap is that a run of whitespace or a sentence would wrap the
 * heading out of a panel sized for one line. A value over the cap falls back rather
 * than being truncated mid-word, so what is on screen is always a complete title.
 */
export const OVERLAY_TITLE_MAX = 40

/** A title, or the default. */
export function resolveTitle(value: unknown): string {
  if (typeof value !== 'string') return OVERLAY_DEFAULT_TITLE
  const text = value.trim()
  return text === '' || text.length > OVERLAY_TITLE_MAX ? OVERLAY_DEFAULT_TITLE : text
}

/**
 * The board's styling.
 *
 * Its own type rather than `OverlayStyle`, because the two pages read different
 * parameters: the board ignores the message gap entirely and carries a title the
 * chat overlay has no place for. Reusing one type would mean a delay slider that
 * does nothing and a title field on the wrong customizer.
 */
export interface BoardStyle {
  /** Text size in px. */
  size: number
  /** How many chatters are listed. */
  max: number
  /** How opaque the gray panel is. */
  bg: number
  /** The rank numbers and the message counts. */
  nameColour: string
  /** The names. */
  textColour: string
  /** A CSS font stack, quoted names and all. */
  font: string
  /** The heading above the ranking. */
  title: string
}

export const BOARD_DEFAULT_STYLE: BoardStyle = {
  // 36 rather than 28. On a 1920px canvas 28px is 1.5% of the width, and the
  // preview made that visible: the board read as a small card in the corner of a
  // stream rather than as something the audience is meant to look at. A
  // leaderboard is the graphic a scene points at, so it is set at a size where it
  // is legible from the couch.
  size: 36,
  max: 10,
  bg: 0.9,
  nameColour: OVERLAY_DEFAULT_STYLE.nameColour,
  textColour: OVERLAY_DEFAULT_STYLE.textColour,
  font: OVERLAY_DEFAULT_STYLE.font,
  title: OVERLAY_DEFAULT_TITLE,
}

/** A board style read out of a query string — the mirror of `chatStyleFromQuery`. */
export function boardStyleFromQuery(search: string): BoardStyle {
  const q = new URLSearchParams(search)
  const raw = (key: string) => q.get(key)
  return {
    size: clampNumber(raw('size'), OVERLAY_SIZE.min, OVERLAY_SIZE.max, BOARD_DEFAULT_STYLE.size),
    max: clampRows(raw('max'), BOARD_DEFAULT_STYLE.max),
    bg: clampNumber(raw('bg'), 0, 1, BOARD_DEFAULT_STYLE.bg),
    nameColour: resolveColour(raw('name'), BOARD_DEFAULT_STYLE.nameColour),
    textColour: resolveColour(raw('color'), BOARD_DEFAULT_STYLE.textColour),
    font: resolveOverlayFont(raw('font')),
    title: resolveTitle(raw('title')),
  }
}

/** A board style as the query parameters the page reads. */
export function boardStyleToQuery(style: BoardStyle): Record<string, string> {
  return {
    size: String(style.size),
    max: String(style.max),
    bg: String(style.bg),
    name: style.nameColour,
    color: style.textColour,
    font: style.font,
    title: style.title,
  }
}

/** A styling read out of storage, with anything unusable replaced. */
export function resolveStyle(saved: Partial<OverlayStyle> | null | undefined): OverlayStyle {
  return {
    size: clampNumber(saved?.size, OVERLAY_SIZE.min, OVERLAY_SIZE.max, OVERLAY_DEFAULT_STYLE.size),
    max: clampRows(saved?.max, OVERLAY_DEFAULT_STYLE.max),
    delay: Math.round(clampNumber(saved?.delay, OVERLAY_DELAY.min, OVERLAY_DELAY.max, OVERLAY_DEFAULT_STYLE.delay)),
    bg: clampNumber(saved?.bg, 0, 1, OVERLAY_DEFAULT_STYLE.bg),
    nameColour: resolveColour(saved?.nameColour, OVERLAY_DEFAULT_STYLE.nameColour),
    textColour: resolveColour(saved?.textColour, OVERLAY_DEFAULT_STYLE.textColour),
    font: resolveOverlayFont(saved?.font),
    position: resolveOverlayPosition(saved?.position),
    maxWidth: clampNumber(saved?.maxWidth, OVERLAY_MAX_WIDTH.min, OVERLAY_MAX_WIDTH.max, OVERLAY_DEFAULT_STYLE.maxWidth),
    bubbleOpacity: clampNumber(saved?.bubbleOpacity, 0, 1, OVERLAY_DEFAULT_STYLE.bubbleOpacity),
    giftColour: resolveColour(saved?.giftColour, OVERLAY_DEFAULT_STYLE.giftColour),
  }
}

/** A board styling read out of storage, with anything unusable replaced. */
export function resolveBoardStyle(saved: Partial<BoardStyle> | null | undefined): BoardStyle {
  return {
    size: clampNumber(saved?.size, OVERLAY_SIZE.min, OVERLAY_SIZE.max, BOARD_DEFAULT_STYLE.size),
    max: clampRows(saved?.max, BOARD_DEFAULT_STYLE.max),
    bg: clampNumber(saved?.bg, 0, 1, BOARD_DEFAULT_STYLE.bg),
    nameColour: resolveColour(saved?.nameColour, BOARD_DEFAULT_STYLE.nameColour),
    textColour: resolveColour(saved?.textColour, BOARD_DEFAULT_STYLE.textColour),
    font: resolveOverlayFont(saved?.font),
    title: resolveTitle(saved?.title),
  }
}

// --------------------------------------------------------------------------
// the stored form
// --------------------------------------------------------------------------

/**
 * The keys a room's styling is saved under, and the field each one means.
 *
 * The store spells them `overlaySize`, `overlayBg` and the rest — namespaced,
 * because a room's config can hold more than the overlay's styling and an
 * unnamespaced `size` would be ambiguous. `resolveStyle` above reads plain field
 * names. Handing it a stored config unchanged therefore resets every field to its
 * default without a word of complaint, which is how a room's saved styling is lost
 * without anything looking broken.
 *
 * So every crossing between the stored form and the field names goes through here.
 * It is a rename and nothing else: no clamping, no defaults — that is
 * `resolveStyle`'s job, and doing it once in one place is what keeps a value from
 * being treated two different ways on the way in and on the way out.
 *
 * `overlayTitle` is here because the board's heading is part of what the operator
 * sets. It is deliberately not in the backend's `OVERLAY_STORE_KEYS` whitelist —
 * that whitelist guards the unauthenticated connect path, and this writes through
 * the config route, which is behind the session gate.
 */
const STORED_TO_FIELD = {
  overlaySize: 'size',
  overlayMax: 'max',
  overlayDelay: 'delay',
  overlayBg: 'bg',
  overlayNameColour: 'nameColour',
  overlayTextColour: 'textColour',
  overlayFont: 'font',
  overlayPosition: 'position',
  overlayMaxWidth: 'maxWidth',
  overlayBubbleOpacity: 'bubbleOpacity',
  overlayGiftColour: 'giftColour',
  overlayTitle: 'title',
} as const

/** A field name a stored config can carry. */
type StyleField = (typeof STORED_TO_FIELD)[keyof typeof STORED_TO_FIELD]

/**
 * The fields a stored config can carry, once renamed.
 *
 * One type for both shapes, because a single stored config carries fields for both
 * overlays: a chat style is read from the subset that means something to it, and a
 * board style from the subset that means something to it. Neither is wrong about a
 * field the other owns.
 */
export type StoredStyle = Partial<OverlayStyle> & Partial<Pick<BoardStyle, 'title'>>

/**
 * A room's stored config as style fields, ready for `resolveStyle`.
 *
 * An empty object for a room that has never been styled, which `resolveStyle`
 * turns into the defaults — the same thing a room with no config has always shown,
 * so an unstyled room looks exactly as it did.
 */
export function styleFromStored(config: Record<string, unknown> | null | undefined): StoredStyle {
  const out: Record<string, unknown> = {}
  if (!config || typeof config !== 'object') return out as StoredStyle
  for (const [stored, field] of Object.entries(STORED_TO_FIELD) as [string, StyleField][]) {
    const value = (config as Record<string, unknown>)[stored]
    if (value !== undefined && value !== null) out[field] = value
  }
  return out as StoredStyle
}

/** A chat style as the config to save it under — the inverse of `styleFromStored`. */
export function chatStyleToStored(style: OverlayStyle): Record<string, unknown> {
  return {
    overlaySize: style.size,
    overlayMax: style.max,
    overlayDelay: style.delay,
    overlayBg: style.bg,
    overlayNameColour: style.nameColour,
    overlayTextColour: style.textColour,
    overlayFont: style.font,
    overlayPosition: style.position,
    overlayMaxWidth: style.maxWidth,
    overlayBubbleOpacity: style.bubbleOpacity,
    overlayGiftColour: style.giftColour,
  }
}

/**
 * A board style as the config to save it under.
 *
 * Deliberately carrying no `overlayDelay`. Both overlays save into one room record
 * and the store replaces that record wholesale rather than merging, so the fields a
 * save does not mention have to come from somewhere else — and the caller gets
 * there by sending the room's existing config with this spread over it. The chat's
 * delay is the board's business only in the sense that overwriting it would be a
 * change nobody asked for, so it is left out and therefore preserved.
 */
export function boardStyleToStored(style: BoardStyle): Record<string, unknown> {
  return {
    overlaySize: style.size,
    overlayMax: style.max,
    overlayBg: style.bg,
    overlayNameColour: style.nameColour,
    overlayTextColour: style.textColour,
    overlayFont: style.font,
    overlayTitle: style.title,
  }
}
