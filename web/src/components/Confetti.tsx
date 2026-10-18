'use client'

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react'
import confetti from 'canvas-confetti'
import type { CreateTypes, Options as ConfettiOptions } from 'canvas-confetti'

/**
 * A confetti canvas with an imperative `fire`, so a winner reveal can pop it
 * without the caller holding any state. Duplicated from the app's `ui/confetti`:
 * same `canvas-confetti` dependency, same ref shape, minus the context provider
 * nothing here consumed.
 */
export type ConfettiRef = {
  fire: (options?: ConfettiOptions) => Promise<void> | void
}

type Props = React.ComponentPropsWithRef<'canvas'> & {
  options?: ConfettiOptions
  /** Fire once on mount. The giveaway reveals on its own, so it never does. */
  manualstart?: boolean
}

const Confetti = forwardRef<ConfettiRef, Props>(function Confetti(
  { options, manualstart = false, className, ...rest },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const instanceRef = useRef<CreateTypes | null>(null)
  const optionsRef = useRef(options)

  useEffect(() => {
    optionsRef.current = options
  }, [options])

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas) {
      instanceRef.current = confetti.create(canvas, { resize: true, useWorker: true })
    }
    return () => {
      instanceRef.current?.reset()
      instanceRef.current = null
    }
  }, [])

  const fire = useCallback(async (opts: ConfettiOptions = {}) => {
    try {
      await instanceRef.current?.({ ...optionsRef.current, ...opts })
    } catch {
      // A confetti failure is cosmetic; the winner is already announced.
    }
  }, [])

  useImperativeHandle(ref, () => ({ fire }), [fire])

  useEffect(() => {
    if (!manualstart) void fire()
  }, [manualstart, fire])

  return <canvas ref={canvasRef} className={className} {...rest} />
})

export default Confetti
