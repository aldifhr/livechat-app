'use client'

/**
 * Motion for a page that is otherwise a server component.
 *
 * The landing page reads the product name out of `lib/config.ts`, which is
 * `server-only` — so it cannot become a client component to get `motion`, and
 * moving the copy to the client to make that possible would put the whole page
 * in the bundle for two fades. So the boundary is here instead: the page stays
 * on the server and passes finished markup down, and only this wrapper is
 * hydrated.
 *
 * `whileInView` rather than `animate` for everything below the fold. A page that
 * animates its hero on load and then animates the rest of itself on load is a
 * page whose lower half is still moving while nobody has scrolled to it, which
 * is the moment the effect stops being a welcome and starts being a delay.
 *
 * A rise of 12px and no more. The page is typographic: the type is set tight and
 * near the top of its line box, so a larger entrance offset shows the shape of
 * the motion more than it shows the text, and what arrives is a paragraph
 * sliding up rather than a page appearing.
 */

import { motion, useReducedMotion, type Variants } from 'motion/react'
import type { ReactNode } from 'react'

/** One eased curve for everything, so nothing on the page moves at its own pace. */
const EASE = [0.22, 0.61, 0.36, 1] as const

interface Props {
  children: ReactNode
  /** Seconds. Used to stagger a run of siblings by hand — there are four. */
  delay?: number
  /** How far up it comes from. Ignored when reduced motion is asked for. */
  rise?: number
  /** Animate when it scrolls into view rather than on load. The default above the
   *  fold, where waiting for a scroll that is already done is a delay. */
  inView?: boolean
  className?: string
}

export default function Reveal({ children, delay = 0, rise = 12, inView = false, className }: Props) {
  const reduced = useReducedMotion()

  // Reduced motion is not "no animation" — it is no *motion*. The page still
  // appears, it just does not travel. Collapsing both to opacity 0 would leave a
  // blank page for anyone whose OS asked for stillness, which is the one thing
  // they asked not to have to sit through.
  const from = reduced ? { opacity: 0 } : { opacity: 0, y: rise }
  const to = reduced ? { opacity: 1 } : { opacity: 1, y: 0 }

  const variants: Variants = {
    hidden: from,
    shown: to,
  }

  const transition = { duration: reduced ? 0.15 : 0.5, delay: reduced ? 0 : delay, ease: EASE }

  const shared = {
    variants,
    transition,
    ...(inView
      ? { initial: 'hidden' as const, whileInView: 'shown' as const, viewport: { once: true, amount: 0.4 } }
      : { initial: 'hidden' as const, animate: 'shown' as const }),
  }

  return (
    <motion.div className={className} {...shared}>
      {children}
    </motion.div>
  )
}
