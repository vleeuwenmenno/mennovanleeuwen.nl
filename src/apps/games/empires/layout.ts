import { useSyncExternalStore } from 'react'
import type { DockId } from './dock'

// Where the floating windows are. A window that hasn't been moved sits in its own default spot, so
// a layout only holds the ones that were. Layouts can be saved by name, in this browser, and
// loaded again. Battles and the galactic conquest map keep theirs apart (each its own store):
//  - In a battle (the tactical map, the unit card, the selection, the fleet inventory, the
//    economy) the layout lasts for that battle: a new one starts from the layout marked as the
//    start layout, or from the defaults.
//  - On the galaxy map (its map, the planet dock, the fleets, the economy) the layout is kept as
//    it is between visits.

/** Where a moved window sits: at a spot (pixels from the screen's top left), or on a dock point
 * (dock.ts), which it keeps as the screen is resized. Layouts saved before dock points hold spots only. */
export type Pos = { x: number; y: number } | { dock: DockId }
export type Layout = Record<string, Pos>
type Saved = { layouts: Record<string, Layout>; start: string | null; current?: Layout }

export type LayoutStore = ReturnType<typeof createLayoutStore>

function createLayoutStore(key: string, keepCurrent = false) {
  const readSaved = (): Saved => {
    try {
      const v = JSON.parse(localStorage.getItem(key) ?? 'null') as Partial<Saved> | null
      if (v && typeof v === 'object' && v.layouts && typeof v.layouts === 'object')
        return { layouts: v.layouts, start: typeof v.start === 'string' && v.start in v.layouts ? v.start : null, current: v.current && typeof v.current === 'object' ? v.current : undefined }
    } catch {
      // Unreadable: start without saved layouts.
    }
    return { layouts: {}, start: null }
  }
  let saved = readSaved()
  let current: Layout = keepCurrent ? { ...(saved.current ?? {}) } : {}
  const writeSaved = () => {
    try {
      localStorage.setItem(key, JSON.stringify(keepCurrent ? { ...saved, current } : saved))
    } catch {
      // Private mode: kept for this visit only.
    }
  }
  /** Bumped on every change, so windows and the menu redraw. */
  let version = 0
  const listeners = new Set<() => void>()
  const changed = () => {
    version++
    if (keepCurrent) writeSaved()
    for (const l of listeners) l()
  }
  return {
    panelPos: (id: string): Pos | undefined => current[id],
    /** A window was moved (or `undefined`: put back in its default spot). */
    setPanelPos(id: string, pos: Pos | undefined) {
      current = { ...current }
      if (pos) current[id] = pos
      else delete current[id]
      changed()
    },
    /** Every window back in its default spot. */
    resetLayout() {
      current = {}
      changed()
    },
    /** A new battle: the start layout if one is marked, else the defaults. */
    beginLayout() {
      current = saved.start ? { ...saved.layouts[saved.start] } : {}
      changed()
    },
    saveLayout(name: string) {
      saved = { ...saved, layouts: { ...saved.layouts, [name]: { ...current } } }
      writeSaved()
      changed()
    },
    loadLayout(name: string) {
      const l = saved.layouts[name]
      if (!l) return
      current = { ...l }
      changed()
    },
    deleteLayout(name: string) {
      const layouts = { ...saved.layouts }
      delete layouts[name]
      saved = { layouts, start: saved.start === name ? null : saved.start }
      writeSaved()
      changed()
    },
    /** Mark a saved layout as the one every new battle starts from (or null for the defaults). */
    setStartLayout(name: string | null) {
      saved = { ...saved, start: name }
      writeSaved()
      changed()
    },
    savedLayouts: () => Object.keys(saved.layouts).sort((a, b) => a.localeCompare(b)),
    startLayout: () => saved.start,
    /** Whether any window has been moved. */
    layoutMoved: () => Object.keys(current).length > 0,
    /** Redraws whatever reads the layout when it changes; returns its version. */
    useLayoutVersion() {
      return useSyncExternalStore(
        (l) => {
          listeners.add(l)
          return () => listeners.delete(l)
        },
        () => version,
        () => version,
      )
    },
  }
}

export const battleLayout = createLayoutStore('mvlos.empires.layouts')
export const galaxyLayout = createLayoutStore('mvlos.empires.galaxyLayouts', true)

export const { panelPos, setPanelPos, resetLayout, beginLayout, saveLayout, loadLayout, deleteLayout, setStartLayout, savedLayouts, startLayout, layoutMoved, useLayoutVersion } = battleLayout
