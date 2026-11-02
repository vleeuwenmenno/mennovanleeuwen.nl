import { useSyncExternalStore } from 'react'
import { updateDesktop } from './desktopStore'
import { MAX_PAGES } from './homePages'
import { viewW } from './uiScale'

// The phone's home screens: which page is showing, how many there are, whether they are being
// arranged, and which pages hold something (so only an empty one can be taken away). The pages
// themselves are a horizontal scroller (`.desk-scroll`, styles.css) that snaps to each page.

export type HomeUi = {
  page: number
  count: number
  editing: boolean
  /** Items per page, as drawn: icons (Desktop.tsx) and widgets/notes (Shell.tsx). */
  icons: number[]
  widgets: number[]
}

let ui: HomeUi = { page: 0, count: 1, editing: false, icons: [], widgets: [] }
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())
const same = (a: number[], b: number[]) => a.length === b.length && a.every((n, i) => n === b[i])

export const homeUi = {
  get: () => ui,
  set(patch: Partial<HomeUi>) {
    const next = { ...ui, ...patch }
    if (next.page === ui.page && next.count === ui.count && next.editing === ui.editing && same(next.icons, ui.icons) && same(next.widgets, ui.widgets)) return
    ui = next
    emit()
  },
  subscribe(l: () => void) {
    listeners.add(l)
    return () => void listeners.delete(l)
  },
}
export const useHomeUi = () => useSyncExternalStore(homeUi.subscribe, homeUi.get)

export const homeScroller = () => (typeof document === 'undefined' ? null : document.querySelector<HTMLElement>('.desk-scroll'))

export function goToPage(page: number, smooth = true) {
  const el = homeScroller()
  if (!el) return
  const target = Math.max(0, Math.min(MAX_PAGES - 1, page))
  el.scrollTo({ left: target * viewW(), behavior: smooth && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'instant' })
  homeUi.set({ page: target })
}

/** The page the scroller is on (the nearest one). */
export const pageAtScroll = () => Math.max(0, Math.round((homeScroller()?.scrollLeft ?? 0) / Math.max(1, viewW())))

export const itemsOnPage = (page: number, u: HomeUi = ui) => (u.icons[page] ?? 0) + (u.widgets[page] ?? 0)

/** Makes room for one more page (up to MAX_PAGES). Returns the new page's index, or null at the limit. */
export function addHomePage(): number | null {
  const count = ui.count
  if (count >= MAX_PAGES) return null
  updateDesktop((s) => ({ ...s, mobilePages: count + 1 }))
  // The count follows the stored value on the next render; the pager needs it now.
  homeUi.set({ count: count + 1 })
  return count
}

/** Called by the pieces that know how to move their items down a page when one is removed. */
const shifters = new Set<(removed: number) => void>()
export function onPageRemoved(fn: (removed: number) => void) {
  shifters.add(fn)
  return () => void shifters.delete(fn)
}

/** Takes an empty page away; later pages move down one. Items are never deleted: refuses a page with any. */
export function removeHomePage(page: number): boolean {
  if (ui.count <= 1 || page < 0 || page >= ui.count || itemsOnPage(page) > 0) return false
  shifters.forEach((fn) => fn(page))
  const count = ui.count - 1
  updateDesktop((s) => ({ ...s, mobilePages: count }))
  homeUi.set({ count, page: Math.min(ui.page, count - 1) })
  goToPage(Math.min(page, count - 1), false)
  return true
}

/**
 * Held at the left or right edge while dragging something: after a moment the screen turns to the
 * next page (and, on the last one, makes a new page). Keeps going while the finger stays there.
 */
export function edgeDwell(canCreate: () => boolean) {
  const EDGE = 28
  const FIRST = 550
  const REPEAT = 750
  let side = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  const stop = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }
  const fire = () => {
    timer = null
    if (!side) return
    const target = pageAtScroll() + side
    if (target < 0) return
    if (target >= ui.count) {
      if (!canCreate() || addHomePage() === null) return
      requestAnimationFrame(() => requestAnimationFrame(() => goToPage(target)))
    } else goToPage(target)
    timer = setTimeout(fire, REPEAT)
  }
  return {
    /** Screen x of the pointer. */
    update(clientX: number) {
      const now = clientX < EDGE ? -1 : clientX > window.innerWidth - EDGE ? 1 : 0
      if (now === side) return
      side = now
      stop()
      if (side) timer = setTimeout(fire, FIRST)
    },
    end() {
      side = 0
      stop()
    },
  }
}
