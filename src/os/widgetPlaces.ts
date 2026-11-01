import { viewH, viewW } from './uiScale'
import { canonicalPlacements, hasWidgetCutover } from '../widgets/platform/canonicalState'
import { changeSet, newKey, nextAt, importPlaces, num, liveWidgets as liveSet, type WidgetPlace, type WidgetSet } from '../widgets/platform/placementSet'
export { changeSet, entriesOf, mergeSets, newKey, nextAt, normalizeSet, placedOnPhone, removedKeys, wins } from '../widgets/platform/placementSet'
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
/** Called after widgets were moved over from a window layout (the window manager shows them). */
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
