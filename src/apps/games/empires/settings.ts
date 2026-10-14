import { useEffect, useRef, useSyncExternalStore } from 'react'

// Game settings and key bindings, kept in this browser. Volume and mute live with the sound
// (sound.ts); everything else is here.

export type Action =
  | 'panUp' | 'panDown' | 'panLeft' | 'panRight' | 'zoomIn' | 'zoomOut'
  | 'move' | 'attack' | 'stop' | 'patrol' | 'hold' | 'rally' | 'ability' | 'retreat' | 'guard'
  | 'station' | 'yard' | 'cyard' | 'build' | 'idle' | 'focus' | 'alert' | 'techTree' | 'pause' | 'fogGrid'
  | GroupAction

/** Control groups 1 to 9 and 0: the key selects the group; with the set or add modifier
 * (Settings.groupSet, groupAdd) it sets the group to the selection, or adds the selection to it. */
export type GroupAction = 'group1' | 'group2' | 'group3' | 'group4' | 'group5' | 'group6' | 'group7' | 'group8' | 'group9' | 'group0'
export const GROUP_ACTIONS: GroupAction[] = ['group1', 'group2', 'group3', 'group4', 'group5', 'group6', 'group7', 'group8', 'group9', 'group0']
/** The group an action selects: '1' to '9', or '0'. */
export const groupOf = (a: GroupAction) => a.slice(5)

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
  { id: 'yard', label: 'Select yard (again: the next one)', group: 'Selection' },
  { id: 'cyard', label: 'Select the Capital Yard', group: 'Selection' },
  { id: 'build', label: 'Build a yard (engineers or the station selected; the next one we lack)', group: 'Commands' },
  { id: 'idle', label: 'Select idle ships', group: 'Selection' },
  { id: 'focus', label: 'Look at selection', group: 'Selection' },
  { id: 'alert', label: 'Look at last alert', group: 'Selection' },
  { id: 'techTree', label: 'Tech tree', group: 'Game' },
  { id: 'fogGrid', label: 'Fog of war grid', group: 'Game' },
  { id: 'pause', label: 'Pause', group: 'Game' },
  ...GROUP_ACTIONS.map((id) => ({ id, label: `Control group ${groupOf(id)}`, group: 'Control groups' })),
]

// The orders used most sit around WASD, so the left hand never leaves it: Q stop, E attack move,
// R patrol, F ability.
export const DEFAULT_KEYS: Record<Action, string> = {
  panUp: 'w', panDown: 's', panLeft: 'a', panRight: 'd', zoomIn: '=', zoomOut: '-',
  move: 'm', attack: 'e', stop: 'q', patrol: 'r', hold: 'g', rally: 'y', ability: 'f', retreat: 'j', guard: 'v',
  station: 'h', yard: 'u', cyard: 'o', build: 'b', idle: 'i', focus: 'c', alert: ' ', techTree: 'k', pause: 'p', fogGrid: 'f2',
  group1: '1', group2: '2', group3: '3', group4: '4', group5: '5', group6: '6', group7: '7', group8: '8', group9: '9', group0: '0',
}

/** The defaults before they moved next to WASD. Saved keys that still match them all move along;
 * a layout someone changed by hand is theirs and stays. */
const OLD_KEYS: Partial<Record<Action, string>> = { attack: 'r', stop: 'x', patrol: 't', ability: 'q', focus: 'f' }
function migrateKeys(keys: Record<Action, string>): Record<Action, string> {
  const moved = Object.keys(OLD_KEYS) as Action[]
  return moved.every((a) => keys[a] === OLD_KEYS[a]) ? { ...keys, ...Object.fromEntries(moved.map((a) => [a, DEFAULT_KEYS[a]])) } : keys
}

/** Keys that can't be bound: they already mean something everywhere in the game. */
export const RESERVED = new Set(['escape', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'tab'])

/** The modifiers for setting a control group and adding to one. Alt is never one: the OS uses
 * Alt+number for workspaces (and Firefox on Linux for its tabs). Ctrl stands for Cmd on a Mac. */
export type GroupMod = 'ctrl' | 'shift' | 'ctrl+shift'
export const GROUP_MODS: GroupMod[] = ['ctrl', 'shift', 'ctrl+shift']
export const modName = (m: GroupMod) => (m === 'ctrl' ? 'Ctrl' : m === 'shift' ? 'Shift' : 'Ctrl+Shift')
/** The modifiers held with a key: '' for none, null for a mix that means nothing to groups (Alt). */
export function modOf(e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }): GroupMod | '' | null {
  if (e.altKey) return null
  const ctrl = e.ctrlKey || e.metaKey
  return ctrl && e.shiftKey ? 'ctrl+shift' : ctrl ? 'ctrl' : e.shiftKey ? 'shift' : ''
}
/** The control group a key press is about ('1' to '9', '0'), whatever modifiers are held: by the
 * key bound to it, or for a number-row (or keypad) binding, by where the key is, since Shift turns
 * the number row into symbols ('!' for 1). */
export function groupKeyOf(keys: Record<Action, string>, e: { key: string; code?: string }): string | null {
  const k = e.key.toLowerCase()
  const digit = /^(?:Digit|Numpad)(\d)$/.exec(e.code ?? '')?.[1]
  for (const a of GROUP_ACTIONS) if (keys[a] === k || (digit !== undefined && keys[a] === digit)) return groupOf(a)
  return null
}

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
  keys: Record<Action, string>
  /** Control groups: the modifier that sets a group to the selection, and the one that adds to it. */
  groupSet: GroupMod
  groupAdd: GroupMod
}

const KEY = 'mvlos.empires.settings'
const DEFAULTS: Settings = { cameraSpeed: 1, edgeScroll: 'fullscreen', bars: 'damaged', rings: true, toasts: true, fogGrid: false, lockedShips: true, ranges: true, daySound: true, keys: { ...DEFAULT_KEYS }, groupSet: 'ctrl', groupAdd: 'shift' }

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
      keys: migrateKeys({ ...DEFAULT_KEYS, ...(v.keys && typeof v.keys === 'object' ? v.keys : {}) }),
      ...groupMods(v.groupSet, v.groupAdd),
    }
  } catch {
    return DEFAULTS
  }
}

/** Saved modifiers, or the defaults; the two are never the same. */
function groupMods(set: unknown, add: unknown): Pick<Settings, 'groupSet' | 'groupAdd'> {
  const ok = (m: unknown): m is GroupMod => GROUP_MODS.includes(m as GroupMod)
  const s = ok(set) ? set : DEFAULTS.groupSet
  const a = ok(add) ? add : DEFAULTS.groupAdd
  return s === a ? { groupSet: DEFAULTS.groupSet, groupAdd: DEFAULTS.groupAdd } : { groupSet: s, groupAdd: a }
}

/** Pick the modifier for setting (or adding to) groups; if the other one used it, they swap. */
export function setGroupMod(which: 'groupSet' | 'groupAdd', m: GroupMod) {
  const other = which === 'groupSet' ? 'groupAdd' : 'groupSet'
  setSettings(current[other] === m ? { [which]: m, [other]: current[which] } : { [which]: m })
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
export const resetKeys = () => setSettings({ keys: { ...DEFAULT_KEYS }, groupSet: DEFAULTS.groupSet, groupAdd: DEFAULTS.groupAdd })

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
