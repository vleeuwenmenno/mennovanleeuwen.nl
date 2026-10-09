import type { MenuItem } from '../os/ContextMenu'
import { synced } from '../os/synced'

// Per-widget settings (a weather widget's place and units, any widget's tilt), keyed by the
// widget's id. Kept in this browser, synced when signed in; where the widget sits on the desktop
// is part of the window layout instead.

type Configs = Record<string, Record<string, unknown>>

const store = synced<Configs>('widgets', {}, { normalize: (v) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Configs) : {}) })

/** This widget's settings over `defaults`. */
export function useWidgetConfig<C extends Record<string, unknown>>(id: string, defaults: C): C {
  const all = store.use()
  return { ...defaults, ...(all[id] as Partial<C> | undefined) }
}

export const getWidgetConfig = <C extends Record<string, unknown>>(id: string, defaults: C): C => ({ ...defaults, ...(store.get()[id] as Partial<C> | undefined) })

export function setWidgetConfig(id: string, patch: Record<string, unknown>) {
  store.set((all) => ({ ...all, [id]: { ...all[id], ...patch } }))
}

export function dropWidgetConfig(id: string) {
  store.set((all) => {
    if (!(id in all)) return all
    const next = { ...all }
    delete next[id]
    return next
  })
}

/** A random slant that reads as "put down by hand": 0.8 to 3.5 degrees either way. */
export const randomTilt = () => Math.round((Math.random() < 0.5 ? -1 : 1) * (0.8 + Math.random() * 2.7) * 10) / 10

export const TILTS: [string, number][] = [
  ['Straight', 0],
  ['A little left', -2],
  ['A little right', 2],
  ['Far left', -4.5],
  ['Far right', 4.5],
]

/** The "Tilt ›" menu for a widget that keeps its tilt in its config. */
export function tiltMenu(id: string, current: number): MenuItem {
  return {
    label: 'Tilt',
    submenu: [
      ...TILTS.map(([label, tilt]) => ({ label, checked: current === tilt, onSelect: () => setWidgetConfig(id, { tilt }) })),
      { separator: true as const },
      { label: 'Random', onSelect: () => setWidgetConfig(id, { tilt: randomTilt() }) },
    ],
  }
}

/** The usual way to make a widget whose settings start with a random tilt. */
export function createWithTilt() {
  const id = crypto.randomUUID().slice(0, 8)
  setWidgetConfig(id, { tilt: randomTilt() })
  return id
}
