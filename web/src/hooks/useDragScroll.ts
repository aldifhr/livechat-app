'use client'

import { useRef, type MouseEvent } from 'react'

/**
 * Hook for smooth horizontal drag-to-scroll on mouse events,
 * while allowing clicks when not dragged beyond the threshold.
 */
export function useDragScroll<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const isDragging = useRef(false)
  const startX = useRef(0)
  const scrollLeft = useRef(0)
  const hasMoved = useRef(false)

  const onMouseDown = (e: MouseEvent) => {
    const el = ref.current
    if (!el) return
    isDragging.current = true
    hasMoved.current = false
    startX.current = e.pageX - el.offsetLeft
    scrollLeft.current = el.scrollLeft
  }

  const onMouseMove = (e: MouseEvent) => {
    if (!isDragging.current) return
    const el = ref.current
    if (!el) return
    e.preventDefault()
    const x = e.pageX - el.offsetLeft
    const walk = x - startX.current
    if (Math.abs(walk) > 4) {
      hasMoved.current = true
    }
    el.scrollLeft = scrollLeft.current - walk
  }

  const onMouseUpOrLeave = () => {
    isDragging.current = false
  }

  return {
    ref,
    hasMoved,
    events: {
      onMouseDown,
      onMouseMove,
      onMouseUp: onMouseUpOrLeave,
      onMouseLeave: onMouseUpOrLeave,
    },
  }
}
