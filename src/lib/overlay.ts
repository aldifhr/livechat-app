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

/** The port the host serves the overlay on. Mirrors `overlay::PORT`. */
export const OVERLAY_PORT = 4319

/** The address a streamer actually pastes into OBS. */
export function overlayOrigin(): string {
  return `http://127.0.0.1:${OVERLAY_PORT}/`
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

/** A font stack with nothing in it that would end the value. */
export function resolveFont(value: unknown): string {
  if (typeof value !== 'string') return OVERLAY_DEFAULT_STYLE.font
  const text = value.trim()
  if (text === '' || text.length > 120) return OVERLAY_DEFAULT_STYLE.font
  // No `;`, no `{`, no newline. Those three are what a CSS declaration is made
  // of, and this value is written into a custom property without escaping.
  if (/[;{}\n\r]/.test(text)) return OVERLAY_DEFAULT_STYLE.font
  return text
}

/**
 * A font stack with nothing in it that would end the value.
 *
 * Named apart from `theme.ts`'s `resolveFont`, which answers a different
 * question: that one picks from a catalogue, this one decides whether a string is
 * safe to put in a URL. Two functions under one name answering two questions is
 * how a call site ends up quietly asking the wrong one.
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

/** A styling read out of storage, with anything unusable replaced. */
export function resolveStyle(saved: Partial<OverlayStyle> | null | undefined): OverlayStyle {
  return {
    size: clampNumber(saved?.size, OVERLAY_SIZE.min, OVERLAY_SIZE.max, OVERLAY_DEFAULT_STYLE.size),
    max: clampRows(saved?.max, OVERLAY_DEFAULT_STYLE.max),
    bg: clampNumber(saved?.bg, 0, 1, OVERLAY_DEFAULT_STYLE.bg),
    nameColour: resolveColour(saved?.nameColour, OVERLAY_DEFAULT_STYLE.nameColour),
    textColour: resolveColour(saved?.textColour, OVERLAY_DEFAULT_STYLE.textColour),
    font: resolveOverlayFont(saved?.font),
  }
}