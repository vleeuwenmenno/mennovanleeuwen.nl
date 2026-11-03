import { getDockMode } from './dockPrefs'
import { setDeskBottomReserve } from './homeLayout'
import { setPageDock } from './homePages'

// How much of the bottom of the screen the home really cannot use. The dock's own height and
// its gap to the edge (with the phone's safe area inside it) are measured, and the phone's page
// dots sit right above it, so icons and widgets may use everything above those: no fixed numbers
// that were right for one dock size and one phone. Display only: nothing here is saved, and a
// change of dock size, screen, rotation or UI scale only re-lays out what is shown (resize event).

/** Space between the dock and the page dots, and between the dots and the lowest icon row, in px. */
const DOTS_GAP = 6
/** Also covers the 6px the dots' 40px buttons reach above their 28px pill. */
const ROW_GAP = 6
/** The desktop's lowest icon row clears the dock by this much. */
const DESK_GAP = 4

/** Height of the page dots when they are not drawn yet (styles in homeLayout.css). */
const DOTS_HEIGHT = 28

/** The bottom edge, in page px, that the dock occupies: its height plus its distance from the screen's edge. Null before the dock exists. */
export function dockEdge(): number | null {
  const dock = document.querySelector<HTMLElement>('.dock')
  if (!dock) return null
  // offsetHeight and the computed `bottom` are layout px, the unit the home is placed in (UI scale
  // included); getBoundingClientRect would be screen px.
  const bottom = parseFloat(getComputedStyle(dock).bottom)
  return dock.offsetHeight + (Number.isFinite(bottom) ? bottom : 0)
}

let last = { edge: -1, dots: -1, desk: -1 }

/** Measures the dock now and applies what it gives; true if anything changed. */
export function applyBottomReserve(): boolean {
  const edge = dockEdge()
  if (edge === null) return false
  const dotsEl = document.querySelector<HTMLElement>('.home-dots')
  const dots = dotsEl?.offsetHeight || DOTS_HEIGHT
  // A desktop whose dock always hides (and a mouse to bring it back) keeps nothing free for it.
  const hides = getDockMode() === 'hide' && !matchMedia('(pointer: coarse)').matches
  const desk = hides ? DESK_GAP : edge + DESK_GAP
  const page = edge + DOTS_GAP + dots + ROW_GAP
  if (Math.abs(edge - last.edge) < 0.5 && Math.abs(dots - last.dots) < 0.5 && desk === last.desk) return false
  last = { edge, dots, desk }
  document.documentElement.style.setProperty('--home-dock-edge', `${edge}px`)
  setPageDock(page)
  setDeskBottomReserve(desk)
  return true
}

/** Keeps the reserve in step with the dock (its size, the mode, the screen, UI scale). Returns the stop function. */
export function watchBottomReserve(): () => void {
  let frame = 0
  let tries = 0
  let observed: Element | null = null
  const ro = new ResizeObserver(() => update())
  const update = () => {
    const dock = document.querySelector('.dock')
    if (dock && dock !== observed) {
      if (observed) ro.unobserve(observed)
      ro.observe(dock)
      observed = dock
    }
    // Everything that lays the home out listens for resize; it runs again with the new reserve.
    if (applyBottomReserve()) window.dispatchEvent(new Event('resize'))
  }
  // The dock mounts a moment after the desktop does: look again until it is there.
  const find = () => {
    update()
    if (!observed && tries++ < 120) frame = requestAnimationFrame(find)
  }
  find()
  window.addEventListener('resize', update)
  window.addEventListener('mvlos:dock', update)
  return () => {
    cancelAnimationFrame(frame)
    ro.disconnect()
    window.removeEventListener('resize', update)
    window.removeEventListener('mvlos:dock', update)
  }
}
