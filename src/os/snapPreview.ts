import { useSyncExternalStore } from 'react'
import type { Geometry } from './wm'

// The outline shown while a window is dragged into a snap zone. One at a time, app-wide.

let current: Geometry | null = null
const listeners = new Set<() => void>()

export function setSnapPreview(g: Geometry | null) {
  if (g === current || (g && current && g.x === current.x && g.y === current.y && g.w === current.w && g.h === current.h)) return
  current = g
  listeners.forEach((l) => l())
}

export function useSnapPreview() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => current,
  )
}
