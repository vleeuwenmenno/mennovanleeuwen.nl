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

/** Whether a window may take the keyboard on its own (when it opens): not while Spotlight or the
 * launcher is up, which a window restored at start-up (?newtab) would otherwise type into. */
export const mayTakeFocus = () => current === null

// What Spotlight starts with when opened through openSpotlight (an amount's "Open in Spotlight").
let spotlightQuery = ''

/** Opens Spotlight with `query` already typed. */
export function openSpotlight(query = '') {
  spotlightQuery = query
  setOverlay('spotlight')
}

/** The text Spotlight opens with; cleared once it has opened (clearSpotlightQuery), so the next time is empty. */
export const spotlightStartQuery = () => spotlightQuery
export const clearSpotlightQuery = () => void (spotlightQuery = '')

export const toggleOverlay =(o: Exclude<Overlay, null>) => setOverlay(current === o ? null : o)

export function useOverlay() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => current,
  )
}
