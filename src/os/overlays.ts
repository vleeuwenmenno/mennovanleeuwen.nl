import { useSyncExternalStore } from 'react'

// Which full-screen overlay is showing: the app launcher, Spotlight, or neither. A tiny store so
// the dock, the top bar and the global Ctrl+K shortcut can all toggle them.

export type Overlay = 'launchpad' | 'spotlight' | null

let current: Overlay = null
const listeners = new Set<() => void>()

export function setOverlay(o: Overlay) {
  current = o
  listeners.forEach((l) => l())
}

export const toggleOverlay = (o: Exclude<Overlay, null>) => setOverlay(current === o ? null : o)

export function useOverlay() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => current,
  )
}
