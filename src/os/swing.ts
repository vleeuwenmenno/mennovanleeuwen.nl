import { useEffect, useRef, useSyncExternalStore } from 'react'

// The wiggle while dragging, for notes and widgets (a window with note chrome) and for desktop
// icons. Both are on unless turned off in Settings > Appearance; kept in this browser.

export type SwingKind = 'notes' | 'icons'
type SwingPrefs = Record<SwingKind, boolean>

const KEY = 'mvlos.swing'
const DEFAULTS: SwingPrefs = { notes: true, icons: true }
const listeners = new Set<() => void>()
let prefs: SwingPrefs = read()

function read(): SwingPrefs {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<SwingPrefs>
    return { notes: v.notes !== false, icons: v.icons !== false }
  } catch {
    return DEFAULTS
  }
}

export const getSwing = () => prefs
export function setSwing(patch: Partial<SwingPrefs>) {
  prefs = { ...prefs, ...patch }
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs))
  } catch {
    /* not persisted */
  }
  listeners.forEach((l) => l())
}
export const useSwingPrefs = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    getSwing,
  )

/**
 * Notes hang from their tape: dragging one sways it like a pendulum, the faster the further, and
 * letting go lets it swing back and settle. Desktop icons being dragged do the same. A damped spring on one angle (--swing, in degrees),
 * written straight to the element so React doesn't re-render 60 times a second.
 */
export function useSwing(ref: { current: HTMLElement | null }, kind: SwingKind) {
  const s = useRef({ angle: 0, vel: 0, target: 0, lastX: 0, lastT: 0, dragging: false, frame: 0, prev: 0 })
  const reduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

  const step = (now: number) => {
    const st = s.current
    const dt = Math.min(0.05, (now - st.prev) / 1000 || 0.016)
    st.prev = now
    // While dragging, the push fades when the pointer stops; after letting go it is gone.
    st.target = st.dragging ? st.target * Math.pow(0.02, dt) : 0
    st.vel += (110 * (st.target - st.angle) - 7 * st.vel) * dt
    st.angle += st.vel * dt
    const el = ref.current
    if (!st.dragging && Math.abs(st.angle) < 0.05 && Math.abs(st.vel) < 0.5) {
      st.angle = st.vel = 0
      st.frame = 0
      el?.style.removeProperty('--swing')
      el?.style.removeProperty('transition')
      return
    }
    el?.style.setProperty('--swing', `${st.angle.toFixed(2)}deg`)
    st.frame = requestAnimationFrame(step)
  }
  const run = () => {
    if (s.current.frame) return
    // Inline, not a class: React rewrites className on re-render. No transition fighting the frames.
    ref.current?.style.setProperty('transition', 'none')
    s.current.prev = performance.now()
    s.current.frame = requestAnimationFrame(step)
  }

  useEffect(() => () => cancelAnimationFrame(s.current.frame), [])

  return {
    start(x: number) {
      if (reduced || !getSwing()[kind]) return
      Object.assign(s.current, { dragging: true, lastX: x, lastT: performance.now() })
      run()
    },
    move(x: number) {
      const st = s.current
      if (!st.dragging) return
      const now = performance.now()
      const v = (x - st.lastX) / Math.max(8, now - st.lastT) // px per ms
      st.lastX = x
      st.lastT = now
      // Moving right leaves the bottom behind, to the left: a clockwise turn about the tape.
      st.target = Math.max(-10, Math.min(10, st.target * 0.5 + v * 6))
    },
    end() {
      s.current.dragging = false
    },
  }
}
