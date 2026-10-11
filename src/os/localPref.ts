import { useSyncExternalStore } from 'react'

// A preference an app keeps in this browser only, under its own localStorage key. Reading and
// writing it through one of these, rather than straight from localStorage, keeps every window of
// the app and its pane in Settings → Apps showing the same value the moment it changes. Another
// tab's change arrives through the storage event. Synced preferences use os/synced.ts instead.

export type LocalPref<T> = {
  get: () => T
  set: (next: T | ((v: T) => T)) => void
  use: () => T
  subscribe: (l: () => void) => () => void
}

/**
 * One value under `key`. `parse` gets the stored text (null when there is none, or when it could
 * not be read) and must always return a usable value; `format` turns a value back into text.
 */
export function localPref<T>(key: string, parse: (raw: string | null) => T, format: (v: T) => string = (v) => JSON.stringify(v)): LocalPref<T> {
  const read = () => {
    try {
      return parse(localStorage.getItem(key))
    } catch {
      return parse(null)
    }
  }
  let value = read()
  const listeners = new Set<() => void>()
  const emit = () => listeners.forEach((l) => l())
  if (typeof window !== 'undefined')
    window.addEventListener('storage', (e) => {
      if (e.key !== key && e.key !== null) return
      value = read()
      emit()
    })
  const pref: LocalPref<T> = {
    get: () => value,
    set(next) {
      const v = typeof next === 'function' ? (next as (v: T) => T)(value) : next
      if (Object.is(v, value)) return
      value = v
      try {
        localStorage.setItem(key, format(v))
      } catch {
        // Private mode: the change still applies until the page closes.
      }
      emit()
    },
    subscribe(l) {
      listeners.add(l)
      return () => void listeners.delete(l)
    },
    use: () => useSyncExternalStore(pref.subscribe, pref.get, pref.get),
  }
  return pref
}

/**
 * Several preferences kept together as JSON under one key, the way most apps already store
 * theirs. What is missing takes its default; `normalize` may tidy the rest. Keys this code does
 * not know about are kept as they were, in case something else still reads them.
 */
export function jsonPref<T extends object>(key: string, defaults: T, normalize: (v: T) => T = (v) => v): LocalPref<T> & { patch: (p: Partial<T>) => void } {
  const pref = localPref<T>(key, (raw) => {
    const v = raw ? (JSON.parse(raw) as unknown) : null
    return normalize({ ...defaults, ...(v && typeof v === 'object' && !Array.isArray(v) ? v : {}) })
  })
  return { ...pref, patch: (p) => pref.set((v) => ({ ...v, ...p })) }
}

/** On or off under `key` as '1' or '0'; anything else stored is `fallback`. */
export const flagPref = (key: string, fallback: boolean) =>
  localPref<boolean>(
    key,
    (raw) => (raw === '1' ? true : raw === '0' ? false : fallback),
    (v) => (v ? '1' : '0'),
  )

/** A number between 0 and 1 under `key`, as text; anything else stored is `fallback`. */
export const levelPref = (key: string, fallback: number) =>
  localPref<number>(
    key,
    (raw) => {
      const v = raw === null || raw === '' ? NaN : Number(raw)
      return Number.isFinite(v) && v >= 0 && v <= 1 ? v : fallback
    },
    String,
  )
