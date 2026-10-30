// How the dock behaves: always shown, auto-hidden while a window covers it or is maximized (the
// default), or always auto-hidden. Windows that snap or maximize leave room for the dock when it
// can be there. Snapped windows can also be told to ignore the dock and use the full height.

import { flagPref } from './localPref'

export type DockMode = 'show' | 'maximized' | 'hide'

const KEY = 'mvlos.dock.mode'
const DOCK_RESERVE = 86 // dock height (76) plus a 10px gap

export const DOCK_MODES: [DockMode, string][] = [
  ['show', 'Always show'],
  ['maximized', 'Auto-hide when a window covers it'],
  ['hide', 'Always auto-hide'],
]

export function getDockMode(): DockMode {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'show' || v === 'hide' ? v : 'maximized'
  } catch {
    return 'maximized'
  }
}

export function setDockMode(mode: DockMode) {
  try {
    localStorage.setItem(KEY, mode)
  } catch {
    /* not persisted */
  }
  applyDockReserve()
  window.dispatchEvent(new Event('mvlos:dock'))
  // Snapped windows re-fit on resize; reuse that so they make or take back room for the dock.
  window.dispatchEvent(new Event('resize'))
}

/** Whether snapped windows keep room for the dock (on by default); off, they use the height below it. This device only. */
export const snapReservePref = flagPref('mvlos.dock.snapReserve', true)

// A change re-fits the snapped windows the same way a dock mode change does.
snapReservePref.subscribe(() => window.dispatchEvent(new Event('resize')))

/** Space snapped windows keep free at the bottom: none when the dock always hides or the preference is off. */
export const snapReserve = () => (getDockMode() === 'hide' || !snapReservePref.get() ? 0 : DOCK_RESERVE)

/** Space a maximized window keeps free at the bottom: only when the dock always shows. Not affected by the snap preference. */
export const maxReserve = () => (getDockMode() === 'show' ? DOCK_RESERVE : 0)

/** Maximized windows only make room when the dock always shows. */
export function applyDockReserve() {
  document.documentElement.style.setProperty('--dock-reserve', getDockMode() === 'show' ? `${DOCK_RESERVE}px` : '0px')
}
