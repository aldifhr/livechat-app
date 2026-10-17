import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Joins class names for vendored UI components, letting a caller win over the
 * component's own defaults. `twMerge` is what makes that true: it drops the
 * earlier class when a later one sets the same Tailwind property, so a
 * `className="h-8"` passed into a trigger that ships `h-9` lands at `h-8`
 * instead of relying on stylesheet order.
 */
export function cn(...values: ClassValue[]): string {
  return twMerge(clsx(values))
}