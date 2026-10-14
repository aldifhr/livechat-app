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
}

export const OVERLAY_DEFAULT_STYLE: OverlayStyle = {
  size: 22,
  max: 8,
  delay: 500,
  bg: 0,
  nameColour: '#ffd76a',
  textColour: '#ffffff',
  font: '"Segoe UI", system-ui, sans-serif',
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
  size: 28,
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
  }
}