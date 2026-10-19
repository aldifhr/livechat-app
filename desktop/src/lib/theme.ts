/**
 * The catalogue of looks, and how a choice is turned into a body class.
 *
 * Pure so the list, the fallback and the merge are checked without a window.
 * Theme, font and density selections are applied as Tailwind classes by App.
 *
 * `default` is the black and white look. It stays in the list rather than being
 * the absence of a theme, because "no theme" and "the first theme" are the same
 * code path here and pretending otherwise is how a switcher ends up with an
 * empty row it cannot recover from.
 */

export type ThemeId = 'default' | 'brutalism'
export type FontId = 'sans' | 'mono'
/** How much air the layout puts around things. */
export type DensityId = 'cozy' | 'compact' | 'roomy'

export interface ThemeMeta {
  id: ThemeId
  label: string
  hint: string
}

export interface FontMeta {
  id: FontId
  label: string
  hint: string
}

export interface DensityMeta {
  id: DensityId
  label: string
  hint: string
}

export const THEMES: ThemeMeta[] = [
  { id: 'default', label: 'Black & White', hint: 'Monochrome dark theme' },
  { id: 'brutalism', label: 'Brutalism', hint: 'Hard borders, raw blocks, no rounding' },
]

export const FONTS: FontMeta[] = [
  { id: 'sans', label: 'Sans', hint: 'The interface font' },
  { id: 'mono', label: 'Mono', hint: 'One fixed width, for code-like chat' },
]

export const DENSITIES: DensityMeta[] = [
  { id: 'compact', label: 'Compact', hint: 'Tight rows, more chat on screen' },
  { id: 'cozy', label: 'Cozy', hint: 'The default spacing' },
  { id: 'roomy', label: 'Roomy', hint: 'Loose rows, easier to read from across a room' },
]
