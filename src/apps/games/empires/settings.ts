import { useEffect, useRef, useSyncExternalStore } from 'react'

// Game settings and key bindings, kept in this browser. Volume and mute live with the sound
// (sound.ts); everything else is here.

export type Action =
  | 'panUp' | 'panDown' | 'panLeft' | 'panRight' | 'zoomIn' | 'zoomOut'
  | 'move' | 'attack' | 'stop' | 'patrol' | 'hold' | 'rally' | 'ability' | 'retreat' | 'guard'
  | 'station' | 'idle' | 'focus' | 'alert' | 'techTree' | 'pause' | 'fogGrid'

export const ACTIONS: { id: Action; label: string; group: string }[] = [
  { id: 'panUp', label: 'Camera up', group: 'Camera' },
  { id: 'panDown', label: 'Camera down', group: 'Camera' },
  { id: 'panLeft', label: 'Camera left', group: 'Camera' },
  { id: 'panRight', label: 'Camera right', group: 'Camera' },
  { id: 'zoomIn', label: 'Zoom in', group: 'Camera' },
  { id: 'zoomOut', label: 'Zoom out', group: 'Camera' },
  { id: 'move', label: 'Move', group: 'Commands' },
  { id: 'attack', label: 'Attack move', group: 'Commands' },
  { id: 'stop', label: 'Stop', group: 'Commands' },
  { id: 'patrol', label: 'Patrol', group: 'Commands' },
  { id: 'hold', label: 'Cycle stance (hold, maneuver, roam)', group: 'Commands' },
  { id: 'rally', label: 'Rally point', group: 'Commands' },
  { id: 'ability', label: 'Use ability', group: 'Commands' },
  { id: 'retreat', label: 'Hyperspace retreat (gunships and up)', group: 'Commands' },
  { id: 'guard', label: 'Guard a ship or structure', group: 'Commands' },
  { id: 'station', label: 'Select station', group: 'Selection' },
  { id: 'idle', label: 'Select idle ships', group: 'Selection' },
  { id: 'focus', label: 'Look at selection', group: 'Selection' },
  { id: 'alert', label: 'Look at last alert', group: 'Selection' },
  { id: 'techTree', label: 'Tech tree', group: 'Game' },
  { id: 'fogGrid', label: 'Fog of war grid', group: 'Game' },
  { id: 'pause', label: 'Pause', group: 'Game' },
]

// The orders used most sit around WASD, so the left hand never leaves it: Q stop, E attack move,
// R patrol, F ability.
export const DEFAULT_KEYS: Record<Action, string> = {
  panUp: 'w', panDown: 's', panLeft: 'a', panRight: 'd', zoomIn: '=', zoomOut: '-',
  move: 'm', attack: 'e', stop: 'q', patrol: 'r', hold: 'g', rally: 'y', ability: 'f', retreat: 'j', guard: 'v',
  station: 'h', idle: 'i', focus: 'c', alert: ' ', techTree: 'k', pause: 'p', fogGrid: 'f2',
}

/** The defaults before they moved next to WASD. Saved keys that still match them all move along;
 * a layout someone changed by hand is theirs and stays. */
const OLD_KEYS: Partial<Record<Action, string>> = { attack: 'r', stop: 'x', patrol: 't', ability: 'q', focus: 'f' }
function migrateKeys(keys: Record<Action, string>): Record<Action, string> {
  const moved = Object.keys(OLD_KEYS) as Action[]
  return moved.every((a) => keys[a] === OLD_KEYS[a]) ? { ...keys, ...Object.fromEntries(moved.map((a) => [a, DEFAULT_KEYS[a]])) } : keys
}

/** Keys that can't be bound: they already mean something everywhere in the game. */
export const RESERVED = new Set(['escape', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'tab', ...'123456789'])

/** A key as stored: lower-case letters, everything else as the browser names it. */
export const keyOf = (e: KeyboardEvent) => (e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase())
export const keyName = (k: string) => (k === ' ' ? 'Space' : k.length === 1 ? k.toUpperCase() : k[0].toUpperCase() + k.slice(1))

export type Settings = {
  /** Camera pan speed multiplier. */
  cameraSpeed: number
  /** Scroll by moving the mouse to the screen edge: never, only when the game fills the page, or always. */
  edgeScroll: 'off' | 'fullscreen' | 'always'
  /** Which ships show health bars. */
  bars: 'damaged' | 'always' | 'selected'
  /** Faint rings under ships in their side's colour. */
  rings: boolean
  /** Toast messages for builds, captures and research. */
  toasts: boolean
  /** The fog of war grid overlay: where sight ends, cell by cell. */
  fogGrid: boolean
  /** Ships the station isn't upgraded enough for still show in the shipyard, greyed out. */
  lockedShips: boolean
  /** Rings for each weapon's range (and the sensors) round the ship or structure under the pointer;
   * on a touch screen, round the selected ones. */
  ranges: boolean
  /** Galactic conquest's soft tick when a day ends (payday): it comes often, so it can be switched off. */
  daySound: boolean
  /** Ships and stations that have a procedural model are drawn with it; off, every unit shows its
   * sprite (to compare while the models are a preview). */
  models: boolean
  keys: Record<Action, string>
}

const KEY = 'mvlos.empires.settings'
const DEFAULTS: Settings = { cameraSpeed: 1, edgeScroll: 'fullscreen', bars: 'damaged', rings: true, toasts: true, fogGrid: false, lockedShips: true, ranges: true, daySound: true, models: true, keys: { ...DEFAULT_KEYS } }

function read(): Settings {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Settings> | null
    if (!v || typeof v !== 'object') return DEFAULTS
    return {
      cameraSpeed: typeof v.cameraSpeed === 'number' ? Math.min(2.5, Math.max(0.4, v.cameraSpeed)) : DEFAULTS.cameraSpeed,
      edgeScroll: v.edgeScroll === 'off' || v.edgeScroll === 'always' ? v.edgeScroll : 'fullscreen',
      bars: v.bars === 'always' || v.bars === 'selected' ? v.bars : 'damaged',
      rings: v.rings !== false,
      toasts: v.toasts !== false,
      fogGrid: v.fogGrid === true,
      lockedShips: v.lockedShips !== false,
      ranges: v.ranges !== false,
      daySound: v.daySound !== false,
      models: v.models !== false,
      keys: migrateKeys({ ...DEFAULT_KEYS, ...(v.keys && typeof v.keys === 'object' ? v.keys : {}) }),
    }
  } catch {
    return DEFAULTS
  }
}

let current = read()
const listeners = new Set<() => void>()

export const getSettings = () => current
export function setSettings(next: Partial<Settings>) {
  current = { ...current, ...next }
  try {
    localStorage.setItem(KEY, JSON.stringify(current))
  } catch {
    // Private mode: the change still applies for this visit.
  }
  for (const l of listeners) l()
}
export const resetKeys = () => setSettings({ keys: { ...DEFAULT_KEYS } })

/** Bind a key to an action; whatever had that key before gets this action's old key. */
export function bindKey(action: Action, key: string) {
  const keys = { ...current.keys }
  const clash = (Object.keys(keys) as Action[]).find((a) => a !== action && keys[a] === key)
  if (clash) keys[clash] = keys[action]
  keys[action] = key
  setSettings({ keys })
}

export function useSettings() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    getSettings,
    getSettings,
  )
}

/** Which action a key press means, if any. */
export const actionFor = (keys: Record<Action, string>, key: string) => (Object.keys(keys) as Action[]).find((a) => keys[a] === key)

// Settings → Apps → Games can ask the game to show its own settings or key bindings: the main menu
// or the battle menu opens that panel when it shows, now or (for a window still opening) within a
// few seconds. Asked for and not shown by then (the galaxy map has no such panel), it is dropped.
export type AskedPanel = 'settings' | 'keys'
let asked: { panel: AskedPanel; at: number } | null = null
const askListeners = new Set<() => void>()

export function askPanel(panel: AskedPanel) {
  asked = { panel, at: Date.now() }
  for (const l of askListeners) l()
}

/** Calls `open` with a panel asked for from Settings, once, while the component is mounted. */
export function useAskedPanel(open: (panel: AskedPanel) => void) {
  const ref = useRef(open)
  ref.current = open
  useEffect(() => {
    const take = () => {
      if (!asked) return
      const { panel, at } = asked
      asked = null
      if (Date.now() - at < 5000) ref.current(panel)
    }
    take()
    askListeners.add(take)
    return () => void askListeners.delete(take)
  }, [])
}
