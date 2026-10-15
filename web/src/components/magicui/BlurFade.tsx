'use client'

import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'

/**
 * Small route transition based on Magic UI's BlurFade pattern. Keeping the
 * animation boundary here means the admin pages can remain independently
 * readable components and only the page content is hydrated for transitions.
 */
export default function BlurFade({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const reduceMotion = useReducedMotion()

  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={pathname}
        initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8, filter: 'blur(5px)' }}
        animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
        exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -4, filter: 'blur(3px)' }}
        transition={{ duration: reduceMotion ? 0.12 : 0.24, ease: [0.22, 0.61, 0.36, 1] }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  )
}
