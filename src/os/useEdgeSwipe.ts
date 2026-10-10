import { useEffect, useRef, type RefObject } from 'react'

/** How far in from the element's left edge a swipe may start: wide enough to clear Android's back gesture strip. */
const EDGE = 40
const DISTANCE = 50

/**
 * Drawers on phones (Files' places, Zed's project panel): a finger swiped right from the left edge
 * of `ref` opens one, and swiped left anywhere closes it again. Touch only; nothing while `enabled`
 * is false.
 */
export function useEdgeSwipe(ref: RefObject<HTMLElement | null>, { enabled, open, onOpen, onClose }: { enabled: boolean; open: boolean; onOpen: () => void; onClose: () => void }) {
  // The latest callbacks, so the listeners are not added again on every render.
  const latest = useRef({ open, onOpen, onClose })
  latest.current = { open, onOpen, onClose }
  useEffect(() => {
    const el = ref.current
    if (!el || !enabled) return
    let start: { x: number; y: number; edge: boolean } | null = null
    const down = (e: TouchEvent) => {
      if (e.touches.length !== 1) return void (start = null)
      const t = e.touches[0]
      start = { x: t.clientX, y: t.clientY, edge: t.clientX - el.getBoundingClientRect().left < EDGE }
    }
    const move = (e: TouchEvent) => {
      if (!start) return
      const t = e.touches[0]
      const dx = t.clientX - start.x
      const dy = t.clientY - start.y
      // Mostly up or down: a scroll, not a swipe.
      if (Math.abs(dy) > 30 && Math.abs(dy) > Math.abs(dx)) return void (start = null)
      if (dx > DISTANCE && start.edge && !latest.current.open) {
        start = null
        latest.current.onOpen()
      } else if (dx < -DISTANCE && latest.current.open) {
        start = null
        latest.current.onClose()
      }
    }
    const end = () => (start = null)
    el.addEventListener('touchstart', down, { passive: true })
    el.addEventListener('touchmove', move, { passive: true })
    el.addEventListener('touchend', end)
    el.addEventListener('touchcancel', end)
    return () => {
      el.removeEventListener('touchstart', down)
      el.removeEventListener('touchmove', move)
      el.removeEventListener('touchend', end)
      el.removeEventListener('touchcancel', end)
    }
  }, [ref, enabled])
}
