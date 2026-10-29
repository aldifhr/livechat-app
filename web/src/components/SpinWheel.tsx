'use client'

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'

/**
 * The spin wheel, drawn on a canvas.
 *
 * The wheel is the same idea the desktop app's `ts-spin-wheel` implemented, with
 * no dependency: that package peer-depends on React 17/18 and ships a UMD
 * bundle, which fights React 19 and SSR. Sectors are painted once, the canvas is
 * rotated with a CSS transition, and `spin(index)` aims it at one sector.
 *
 * It is decoration. The winner is derived from the committed seed before the wheel
 * moves — the stopping sector is aimed at that winner so the two agree, but nothing
 * about the result depends on the animation.
 */
export interface WheelSector {
  label: string
  color: string
  text?: string
}

export interface SpinWheelHandle {
  /** Spin, coming to rest on `targetIndex`. */
  spin: (targetIndex: number) => void
}

const SPIN_MS = 4200

const SpinWheel = forwardRef<SpinWheelHandle, {
  sectors: WheelSector[]
  size?: number
  onSpinEnd: (index: number) => void
}>(function SpinWheel({ sectors, size = 280, onSpinEnd }, ref) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [rotation, setRotation] = useState(0)
  const targetRef = useRef<number | null>(null)
  const settleRef = useRef<number | null>(null)
  const endRef = useRef(onSpinEnd)
  endRef.current = onSpinEnd

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = size * dpr
    canvas.height = size * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const r = size / 2
    const n = Math.max(1, sectors.length)
    const step = (Math.PI * 2) / n
    ctx.clearRect(0, 0, size, size)
    sectors.forEach((sector, i) => {
      const start = i * step
      ctx.beginPath()
      ctx.moveTo(r, r)
      ctx.arc(r, r, r - 2, start, start + step)
      ctx.closePath()
      ctx.fillStyle = sector.color
      ctx.fill()
      ctx.save()
      ctx.translate(r, r)
      ctx.rotate(start + step / 2)
      ctx.textAlign = 'right'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = sector.text ?? '#fff'
      ctx.font = `600 ${Math.max(9, Math.min(14, size / 26))}px system-ui, sans-serif`
      const label = sector.label.length > 16 ? `${sector.label.slice(0, 15)}…` : sector.label
      ctx.fillText(label, r - 10, 0)
      ctx.restore()
    })
  }, [sectors, size])

  useImperativeHandle(ref, () => ({
    spin(targetIndex: number) {
      const n = Math.max(1, sectors.length)
      const step = 360 / n
      // The pointer sits at the top (-90°). Aim the target sector's centre there,
      // with five extra turns so the motion reads as a spin and not a slide.
      const targetAngle = -(targetIndex * step + step / 2) - 90
      setRotation((prev) => {
        const base = prev - (prev % 360)
        return base + 360 * 5 + targetAngle
      })
      targetRef.current = targetIndex
      if (settleRef.current !== null) window.clearTimeout(settleRef.current)
      settleRef.current = window.setTimeout(() => {
        const index = targetRef.current
        targetRef.current = null
        if (index !== null) endRef.current(index)
      }, SPIN_MS + 120)
    },
  }), [sectors])

  useEffect(() => () => {
    if (settleRef.current !== null) window.clearTimeout(settleRef.current)
  }, [])

  return (
    <div className="relative inline-block" style={{ width: size, height: size }}>
      <span
        aria-hidden="true"
        className="absolute left-1/2 z-10 -translate-x-1/2"
        style={{
          top: -6,
          width: 0,
          height: 0,
          borderLeft: '11px solid transparent',
          borderRight: '11px solid transparent',
          borderTop: '18px solid var(--accent)',
        }}
      />
      <canvas
        ref={canvasRef}
        style={{
          width: size,
          height: size,
          transform: `rotate(${rotation}deg)`,
          transition: `transform ${SPIN_MS}ms cubic-bezier(0.17, 0.67, 0.16, 1)`,
        }}
      />
    </div>
  )
})

export default SpinWheel
