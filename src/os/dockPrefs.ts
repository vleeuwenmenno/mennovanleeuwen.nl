// How the dock behaves: always shown (default), auto-hidden only while a window is maximized, or
// always auto-hidden. Windows that snap or maximize leave room for the dock when it can be there.

export type DockMode = 'show' | 'maximized' | 'hide'

const KEY = 'mvlos.dock.mode'
const DOCK_RESERVE = 86 // dock height (76) plus a 10px gap

export const DOCK_MODES: [DockMode, string][] = [
  ['show', 'Always show'],
  ['maximized', 'Auto-hide when a window is maximized'],
  ['hide', 'Always auto-hide'],
]

export function getDockMode(): DockMode {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'maximized' || v === 'hide' ? v : 'show'
  } catch {
    return 'show'
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

/** Space snapped windows keep free at the bottom: none only when the dock always hides. */
export const snapReserve = () => (getDockMode() === 'hide' ? 0 : DOCK_RESERVE)

/** Maximized windows only make room when the dock always shows. */
export function applyDockReserve() {
  document.documentElement.style.setProperty('--dock-reserve', getDockMode() === 'show' ? `${DOCK_RESERVE}px` : '0px')
}
