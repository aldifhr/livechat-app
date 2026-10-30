'use client'

/**
 * Motion for a list that arrives a row at a time.
 *
 * A run of siblings that all fade in at once reads as a single block appearing;
 * the same run staggered by a few tens of milliseconds reads as a list being
 * laid down, which is what it is. The stagger is a fixed step per child, and a
 * long list simply finishes proportionally later — which is why the step is
 * small (40ms) and the lists here are short.
 *
 * `Reveal` covers one element; this covers the run. Both reduce to opacity-only
 * when the OS asks for reduced motion, so the content still appears — it just
 * does not travel.
 */

import { motion, useReducedMotion, type Variants } from 'motion/react'
import type { ReactNode } from 'react'

const EASE = [0.22, 0.61, 0.36, 1] as const

export function Stagger({
  children,
  className,
  step = 0.04,
  as = 'div',
}: {
  children: ReactNode
  className?: string
  /** Seconds between one child and the next. */
  step?: number
  /** The container element. `tbody` for a run of table rows. */
  as?: 'div' | 'ul' | 'tbody'
}) {
  const reduced = useReducedMotion()

  const container: Variants = {
    hidden: {},
    shown: {
      transition: { staggerChildren: reduced ? 0 : step, delayChildren: reduced ? 0 : 0.05 },
    },
  }

  const Component = motion[as]
  return (
    <Component className={className} variants={container} initial="hidden" animate="shown">
      {children}
    </Component>
  )
}

/** One row inside a `Stagger`. Renders the element `as` names, default `div`. */
export function StaggerItem({
  children,
  className,
  as = 'div',
}: {
  children: ReactNode
  className?: string
  as?: 'div' | 'li' | 'tr'
}) {
  const reduced = useReducedMotion()

  const variants: Variants = {
    hidden: reduced ? { opacity: 0 } : { opacity: 0, y: 10 },
    shown: {
      opacity: 1,
      y: 0,
      transition: { duration: reduced ? 0.15 : 0.4, ease: EASE },
    },
  }

  const Component = motion[as]
  return (
    <Component className={className} variants={variants}>
      {children}
    </Component>
  )
}
