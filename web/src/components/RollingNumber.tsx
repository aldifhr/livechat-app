'use client'

import { useEffect, useRef, useState } from 'react'

const ROLL_MS = 320
const DIGIT_TRANSFORM_CLASSES = [
  '[transform:translateY(0)]',
  '[transform:translateY(-1em)]',
  '[transform:translateY(-2em)]',
  '[transform:translateY(-3em)]',
  '[transform:translateY(-4em)]',
  '[transform:translateY(-5em)]',
  '[transform:translateY(-6em)]',
  '[transform:translateY(-7em)]',
  '[transform:translateY(-8em)]',
  '[transform:translateY(-9em)]',
]

function Digit({ value, changed }: { value: number; changed: boolean }) {
  return (
    <span
      className={`relative inline-block h-[1em] overflow-hidden leading-none align-top${
        changed ? ' opacity-90' : ''
      }`}
      aria-hidden="true"
    >
      <span
        className={`flex flex-col transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-transform motion-reduce:transition-none ${
          DIGIT_TRANSFORM_CLASSES[value] ?? DIGIT_TRANSFORM_CLASSES[0]
        }`}
      >
        {Array.from({ length: 10 }, (_, n) => (
          <span
            className="flex h-[1em] items-center justify-center leading-none"
            key={n}
          >
            {n}
          </span>
        ))}
      </span>
    </span>
  )
}

function groupMap(text: string): boolean[] {
  const digits = text.length
  const marks: boolean[] = []
  for (let i = 0; i < digits; i++) {
    const fromRight = digits - 1 - i
    marks.push(fromRight > 0 && fromRight % 3 === 0)
  }
  return marks
}

export function RollingNumber({
  value,
  withCommas = true,
}: {
  value: number
  withCommas?: boolean
}) {
  const shown = useRef(String(value))
  const [digits, setDigits] = useState<number[]>(() =>
    String(value).split('').map(Number),
  )
  const [commas, setCommas] = useState<boolean[]>(() =>
    withCommas ? groupMap(String(value)) : [],
  )
  const [changedDigits, setChangedDigits] = useState<boolean[]>([])

  useEffect(() => {
    const next = String(value)
    if (next === shown.current) return
    const previous = shown.current
    const nextDigits = next.split('')
    const previousDigits = previous.split('')
    setChangedDigits(
      nextDigits.map((digit, index) => {
        const fromRight = nextDigits.length - 1 - index
        return previousDigits[previousDigits.length - 1 - fromRight] !== digit
      }),
    )
    shown.current = next
    setDigits(nextDigits.map(Number))
    if (withCommas) setCommas(groupMap(next))

    const timer = setTimeout(() => setChangedDigits([]), ROLL_MS)
    return () => clearTimeout(timer)
  }, [value, withCommas])

  return (
    <span
      className="inline-flex items-baseline tabular-nums"
      aria-label={value.toLocaleString()}
      role="img"
    >
      {digits.map((d, i) => (
        <span
          className="inline-flex items-baseline"
          key={digits.length - 1 - i}
        >
          <Digit value={d} changed={changedDigits[i] ?? false} />
          {withCommas && commas[i] && <span className="inline-block">,</span>}
        </span>
      ))}
    </span>
  )
}
