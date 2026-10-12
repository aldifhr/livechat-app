import { useEffect, useRef, useState } from 'react'

/**
 * A number whose digits roll when they change, like an odometer.
 *
 * Each digit is a vertical strip of 0–9 that slides to the new value; a digit that
 * did not change does not move. So 186 → 185 rolls only the last digit down from 6
 * to 5, and 186 → 286 rolls only the first — the rest stay put, which is what makes
 * it read as the number changing rather than the whole thing flickering.
 *
 * Rendered as real text, not an image or a canvas: the strip is a column of spans
 * translated by `transform`, so it stays selectable, scales with the font, and
 * animates on the compositor rather than triggering layout every frame.
 */

/** How long one digit takes to roll to its new value. */
const ROLL_MS = 320

/** One digit: a 0–9 strip translated to show `value`. */
function Digit({ value }: { value: number }) {
  return (
    <span className="roll-digit" aria-hidden="true">
      {/* The strip. Ten rows tall; translated up by `value` rows to bring the
          wanted digit into the window. `will-change` keeps it on the GPU. */}
      <span className="roll-strip" style={{ transform: `translateY(-${value}em)` }}>
        {Array.from({ length: 10 }, (_, n) => (
          <span className="roll-cell" key={n}>
            {n}
          </span>
        ))}
      </span>
    </span>
  )
}

/**
 * The rolling number.
 *
 * `value` is the current number; when it changes, only the digits that differ
 * animate. Digit count grows and shrinks with the number, and a leading digit
 * appearing (9 → 10) is handled by rendering the new length immediately.
 */
export function RollingNumber({ value }: { value: number }) {
  // The digits of the value currently on screen, so a re-render that did not change
  // the number does not re-trigger a roll. Held as the string we last drew.
  const shown = useRef(String(value))
  const [digits, setDigits] = useState<number[]>(() => String(value).split('').map(Number))
  const [commas, setCommas] = useState<boolean[]>(() => groupMap(String(value)))

  useEffect(() => {
    const next = String(value)
    if (next === shown.current) return
    shown.current = next
    setDigits(next.split('').map(Number))
    setCommas(groupMap(next))
  }, [value])

  return (
    // `aria-label` carries the real value, and the strip is hidden from assistive
    // tech and from text selection: the visible digit is one of ten in a column, and
    // read as text the whole column would be "0123456789". The label is the truth.
    <span className="roll-number" aria-label={value.toLocaleString()} role="text">
      {digits.map((d, i) => (
        // Keyed by position from the right so a digit keeps its identity as the
        // number grows — otherwise 9 → 10 would remount every digit and roll them
        // all instead of just the new one.
        <span className="roll-slot" key={digits.length - i} style={{ transitionDuration: `${ROLL_MS}ms` }}>
          <Digit value={d} />
          {commas[i] && <span className="roll-comma">,</span>}
        </span>
      ))}
    </span>
  )
}

/**
 * Where a thousands separator goes, by position from the left.
 *
 * Matches `toLocaleString`'s grouping so the rolling number reads the same as the
 * plain one beside it — a number whose commas drifted from every other figure on
 * screen would look wrong rather than animated.
 */
function groupMap(text: string): boolean[] {
  const digits = text.length
  const marks: boolean[] = []
  for (let i = 0; i < digits; i++) {
    const fromRight = digits - 1 - i
    marks.push(fromRight > 0 && fromRight % 3 === 0)
  }
  return marks
}
