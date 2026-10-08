import { useSyncExternalStore } from 'react'

// Desktop icon state shared by the Desktop and Files' Trash view: where each icon sits, what it is
// called, and which icons are in the trash. Remembered per browser, so a visitor's tidy (or messy)
// desktop survives a reload.

export type IconPos = { col: number; row: number }
export type DesktopState = {
  positions: Record<string, IconPos>
  names: Record<string, string>
  trashed: string[]
}

const KEY = 'mvlos.desktop.v1'
const empty: DesktopState = { positions: {}, names: {}, trashed: [] }

function load(): DesktopState {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? { ...empty, ...JSON.parse(raw) } : empty
  } catch {
    return empty
  }
}

let state = load()
const listeners = new Set<() => void>()

export function updateDesktop(fn: (s: DesktopState) => DesktopState) {
  state = fn(state)
  try {
    localStorage.setItem(KEY, JSON.stringify(state))
  } catch {
    /* not persisted */
  }
  listeners.forEach((l) => l())
}

export function useDesktop() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => state,
  )
}

export const trashIcons = (ids: string[]) => updateDesktop((s) => ({ ...s, trashed: [...new Set([...s.trashed, ...ids])] }))
export const restoreIcons = (ids: string[]) => updateDesktop((s) => ({ ...s, trashed: s.trashed.filter((t) => !ids.includes(t)) }))
export const resetLayout = () => updateDesktop((s) => ({ ...s, positions: {} }))
