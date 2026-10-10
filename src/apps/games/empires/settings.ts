import { useSyncExternalStore } from 'react'

// Game settings and key bindings, kept in this browser. Volume and mute live with the sound
// (sound.ts); everything else is here.

export type Action =
  | 'panUp' | 'panDown' | 'panLeft' | 'panRight' | 'zoomIn' | 'zoomOut'
  | 'move' | 'attack' | 'stop' | 'patrol' | 'hold' | 'rally' | 'ability'
  | 'station' | 'idle' | 'focus' | 'alert' | 'techTree' | 'pause'

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
  { id: 'station', label: 'Select station', group: 'Selection' },
  { id: 'idle', label: 'Select idle ships', group: 'Selection' },
  { id: 'focus', label: 'Look at selection', group: 'Selection' },
  { id: 'alert', label: 'Look at last alert', group: 'Selection' },
  { id: 'techTree', label: 'Tech tree', group: 'Game' },
  { id: 'pause', label: 'Pause', group: 'Game' },
]

export const DEFAULT_KEYS: Record<Action, string> = {
  panUp: 'w', panDown: 's', panLeft: 'a', panRight: 'd', zoomIn: '=', zoomOut: '-',
  move: 'm', attack: 'r', stop: 'x', patrol: 't', hold: 'g', rally: 'y', ability: 'q',
  station: 'h', idle: 'i', focus: 'f', alert: ' ', techTree: 'k', pause: 'p',
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
  keys: Record<Action, string>
}

const KEY = 'mvlos.empires.settings'
const DEFAULTS: Settings = { cameraSpeed: 1, edgeScroll: 'fullscreen', bars: 'damaged', rings: true, toasts: true, keys: { ...DEFAULT_KEYS } }

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
      keys: { ...DEFAULT_KEYS, ...(v.keys && typeof v.keys === 'object' ? v.keys : {}) },
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
