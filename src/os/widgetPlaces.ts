import { localX, mobileWidgetRect, pageOfX } from './homePages'
import { synced } from './synced'
import { viewH, viewW } from './uiScale'
import { accountGuard } from './accountSpace'
import { canonicalPlacements, hasWidgetCutover, widgetsHydrated } from '../widgets/platform/canonicalState'
import { changeSet, newKey, nextAt, importPlaces, num, normalizeSet, mergeSets, phoneOrder, liveWidgets as liveSet, type WidgetPlace, type WidgetSet } from '../widgets/platform/placementSet'
export { changeSet, entriesOf, mergeSets, newKey, nextAt, normalizeSet, phoneOrder, placedOnPhone, removedKeys, wins } from '../widgets/platform/placementSet'
export type { WidgetPlace, WidgetSet } from '../widgets/platform/placementSet'

export const widgetPlaces = canonicalPlacements
export const liveWidgets = (set: WidgetSet = widgetPlaces.get()) => liveSet(set)

/**
 * Adds widgets from an older window layout that the set doesn't know yet (not even as removed),
 * with `at: 0` so any later change elsewhere wins. Untouched migrations can be upgraded
 * by the equal-counter preference (desktop first). Returns whether anything changed.
 */
export function importWidgets(found: Omit<WidgetPlace, 'at'>[]): boolean {
  // Once the canonical envelope exists, old clients' layout writes are never input again.
  if (hasWidgetCutover()) return false
  if (importPlaces(widgetPlaces.get(), found) === widgetPlaces.get()) return false
  widgetPlaces.set(cur => importPlaces(cur, found))
  imported.forEach((l) => l())
  return true
}

/** Explicit new-client placement gesture. Legacy layout import must never call this. */
export function placeWidgets(found: Omit<WidgetPlace,'at'>[]) {
  widgetPlaces.set(set=>{
    let next=set
    for(const value of found){const existing=Object.entries(next.places).find(([,p])=>p.id===value.id);const key=existing?.[0]??newKey(next,value.id);next=changeSet(next,{[key]:{...value,at:nextAt(existing?.[1])}})}
    return next
  })
  imported.forEach(listener=>listener())
}

const imported = new Set<() => void>()
/** Reproject widget windows after legacy import or deferred mobile initialization. */
export function onImport(l: () => void) {
  imported.add(l)
  return () => {
    imported.delete(l)
  }
}

type LayoutWindow = { app?: unknown; x?: unknown; y?: unknown; w?: unknown; h?: unknown; minimized?: unknown; stack?: unknown; props?: Record<string, unknown> }

/**
 * Moves the widgets a saved window layout holds (from before widgets had a set of their own, or
 * saved by an older release) into the set. Called with every layout this browser loads, and with
 * every newer one from the server or another tab before a merge can drop it (synced's
 * onIncoming), so a widget whose only copy is in the account's layout is never lost. The
 * layouts are per kind of screen, so this screen's size says what kind the places are for.
 */
export function importLayoutWidgets(saved: unknown): boolean {
  if (!Array.isArray(saved)) return false
  const vw = typeof window === 'undefined' ? 0 : viewW()
  const vh = typeof window === 'undefined' ? 0 : viewH()
  const found: Omit<WidgetPlace, 'at'>[] = []
  for (const w of saved as LayoutWindow[]) {
    if (!w || typeof w !== 'object') continue
    // Before widgets, a sticky was its own app.
    const kind = w.app === 'widget' ? w.props?.kind : w.app === 'sticky' ? 'sticky' : undefined
    const id = w.props?.id
    if (typeof kind !== 'string' || typeof id !== 'string' || !kind || !id) continue
    found.push({ id, kind, x: num(w.x), y: num(w.y), w: num(w.w, 280), h: num(w.h, 260), vw, vh, screenUnknown: true, ...(typeof w.stack === 'number' ? { stack: w.stack } : {}), ...(w.minimized ? { minimized: true } : {}) })
  }
  return found.length > 0 && importWidgets(found)
}

/**
 * Whether a window layout arriving from elsewhere replaces this tab's windows. Normally not while
 * this tab has changes it hasn't saved yet (they would be lost). But a browser that never had the
 * account's layout takes the first copy of it that comes (from the server, or from another tab
 * that got it), even then: its own opening windows count as changes the moment they are fitted.
 * Another tab's copy that never reached the account (its opening windows) doesn't count as that.
 */
export function layoutGate(neverSynced: boolean) {
  let first = neverSynced
  const accept = (accountCopy: boolean, pendingEdits: boolean): boolean => {
    if (first && accountCopy) {
      first = false
      return true
    }
    return !pendingEdits
  }
  return Object.assign(accept, {
    consume: () => {
      first = false
    },
  })
}

/** Null means inherit the legacy shared setup until the first explicit mobile edit. An empty
 * set is intentional (all mobile widgets removed), and must never fall back to the desktop. */
export const mobileWidgetPlaces = synced<WidgetSet | null>('widgets:placed:mobile', null, {
  normalize: (v) => v == null ? null : normalizeSet(v),
  merge: (a, b) => a === null ? b : b === null ? a : mergeSets(a, b),
  mergeTabs: true,
})
export const widgetsForScreen = (desktop: WidgetSet, mobile: WidgetSet | null, phone: boolean): WidgetSet =>
  phone ? mobile ?? desktop : desktop
// Until canonical hydration, the inherited desktop is unknown. Keep only explicit edits,
// never an empty snapshot or a callback that could later close over a different account/view.
type PendingMobile = { delta: WidgetSet; width: number; height: number; stop: (() => void)[] }
let pendingMobile: PendingMobile | undefined
let mobileDisposed = false
const EMPTY_MOBILE: WidgetSet = { places: {}, removed: '' }
const applyMobile = (base: WidgetSet, delta: WidgetSet, rebase = false) => changeSet(base,
  rebase ? Object.fromEntries(Object.entries(delta.places).map(([key, place]) => [key, { ...place, at: Math.max(place.at, (base.places[key]?.at ?? -1) + 1) }])) : delta.places,
  delta.removed ? delta.removed.split(' ') : [])
export const screenWidgets = (phone: boolean): WidgetSet => {
  if (!phone) return widgetPlaces.get()
  const base = mobileWidgetPlaces.get() ?? widgetPlaces.get()
  return pendingMobile ? applyMobile(migrateMobileWidgets(base, pendingMobile.width, pendingMobile.height), pendingMobile.delta) : base
}
function clearPendingMobile() {
  const pending = pendingMobile
  pendingMobile = undefined
  pending?.stop.forEach(stop => stop())
}
function disposeMobile() {
  mobileDisposed = true
  clearPendingMobile()
}
function finishPendingMobile() {
  const pending = pendingMobile
  if (!pending || mobileDisposed) return
  if (!accountGuard()) { disposeMobile(); return }
  // A separate mobile set from another tab is also a complete base; it needs no desktop seed.
  if (!widgetsHydrated() && mobileWidgetPlaces.get() === null) return
  mobileWidgetPlaces.set(current => applyMobile(migrateMobileWidgets(current ?? widgetPlaces.get(), pending.width, pending.height), pending.delta, true))
  clearPendingMobile()
  // A local commit is not an onRemote event. Reconcile the WM even when hydration's desktop
  // projection was unchanged (for example an empty inherited account).
  imported.forEach(listener => listener())
}
export function changeScreenWidgets(phone: boolean, fn: (set: WidgetSet) => WidgetSet) {
  if (!phone) { widgetPlaces.set(fn); return }
  if (mobileDisposed || !accountGuard()) return
  if (!pendingMobile && (widgetsHydrated() || mobileWidgetPlaces.get() !== null)) {
    mobileWidgetPlaces.set(current => fn(migrateMobileWidgets(current ?? widgetPlaces.get(), viewW(), viewH())))
    return
  }
  const width = pendingMobile?.width ?? viewW(), height = pendingMobile?.height ?? viewH()
  const before = migrateMobileWidgets(screenWidgets(true), width, height)
  const after = fn(before)
  const put = Object.fromEntries(Object.entries(after.places).filter(([key, place]) => JSON.stringify(place) !== JSON.stringify(before.places[key])))
  const beforeRemoved = new Set(before.removed.split(' '))
  const remove = [...new Set([
    ...after.removed.split(' ').filter(key => key && !beforeRemoved.has(key)),
    ...Object.keys(before.places).filter(key => !after.places[key]),
  ])]
  if (!Object.keys(put).length && !remove.length) return
  const delta = changeSet(pendingMobile?.delta ?? EMPTY_MOBILE, put, remove)
  if (!pendingMobile) {
    const pending: PendingMobile = { delta, width, height, stop: [] }
    pendingMobile = pending
    if (typeof window !== 'undefined') {
      const hide = (event: PageTransitionEvent) => { if (!event.persisted) disposeMobile() }
      window.addEventListener('pagehide', hide)
      window.addEventListener('mvlos:forget', disposeMobile)
      window.addEventListener('mvlos:account-changed', disposeMobile)
      pending.stop.push(() => {
        window.removeEventListener('pagehide', hide)
        window.removeEventListener('mvlos:forget', disposeMobile)
        window.removeEventListener('mvlos:account-changed', disposeMobile)
      })
    }
    // onSynced can call synchronously when already ready; don't leak the unsubscribe it returns.
    const watch = (stop: () => void) => { if (pendingMobile === pending) pending.stop.push(stop); else stop() }
    watch(mobileWidgetPlaces.onRemote(finishPendingMobile))
    watch(widgetPlaces.onSynced(finishPendingMobile))
  } else pendingMobile.delta = delta
  finishPendingMobile()
}
if (import.meta.hot) import.meta.hot.dispose(disposeMobile)

/**
 * A phone page was removed (it was empty): every saved widget on a later page moves down one, as
 * a whole set: the same widget under two keys, kinds this build does not know, and older places
 * (frozen here first, pages included). Only the page changes; width, height and the place on the
 * page stay as saved.
 */
export function shiftMobilePagesAfter(set: WidgetSet, removed: number, width: number, height: number): WidgetSet {
  const frozen = migrateMobileWidgets(set, width, height)
  const places = { ...frozen.places }
  phoneOrder(frozen).forEach(([key, p], index) => {
    const here = p.page === undefined ? mobileWidgetRect(p, index, width, height) : null
    const page = p.page ?? pageOfX(here!.x)
    if (p.page !== undefined && page <= removed) return
    if (p.page === undefined && page <= removed) {
      places[key] = { ...p, page, x: localX(here!.x), y: here!.y, at: nextAt(p) }
      return
    }
    places[key] = { ...p, ...(here ? { x: localX(here.x), y: here.y } : {}), page: page - 1, at: nextAt(p) }
  })
  return { ...frozen, places }
}

/** Where each saved widget sits on the phone's pages, known kinds or not (for what counts as an empty page). */
export function mobileWidgetPageCounts(set: WidgetSet, width: number, height: number): number[] {
  const counts: number[] = []
  phoneOrder(set).forEach(([, p], index) => {
    const page = p.page ?? pageOfX(mobileWidgetRect(p, index, width, height).x)
    counts[page] = (counts[page] ?? 0) + 1
  })
  return Array.from(counts, (n) => n ?? 0)
}

/** Freeze the old column's ordered starting coordinates on first edit, without touching its source.
 * Otherwise deleting an earlier legacy entry would change every later entry's row on reload. */
export function migrateMobileWidgets(set: WidgetSet, width: number, height: number): WidgetSet {
  // The same order widgetsShown (wm.tsx) projects them in: equal ids and stacks keep one index.
  const ordered = phoneOrder(set)
  return { ...set, places: Object.fromEntries(ordered.map(([key, p], index) => {
    if (p.homeGrid) return [key, p]
    // The page it was on (from the screen it was saved on) is frozen with its coordinates, since
    // vh is replaced by this screen's: otherwise a later edit would move untouched widgets between pages.
    const r = mobileWidgetRect(p, index, width, height)
    return [key, { ...p, w: r.w, h: r.h, x: localX(r.x), y: r.y, page: pageOfX(r.x), homeGrid: true, phone: true, vw: width, vh: height, at: nextAt(p) }]
  })) }
}
