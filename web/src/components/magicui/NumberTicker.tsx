'use client'

import { animate, motion, useMotionValue, useReducedMotion, useTransform } from 'motion/react'
import { useEffect } from 'react'

/** NumberTicker pattern for live dashboard totals. */
export default function NumberTicker({ value }: { value: number }) {
  const count = useMotionValue(0)
  const rounded = useTransform(count, (current) => Math.round(current).toLocaleString())
  const reduceMotion = useReducedMotion()

  useEffect(() => {
    const controls = animate(count, value, {
      duration: reduceMotion ? 0 : 0.65,
      ease: [0.22, 0.61, 0.36, 1],
    })
    return () => controls.stop()
  }, [count, reduceMotion, value])

  return <motion.span aria-label={value.toLocaleString()}>{rounded}</motion.span>
}
