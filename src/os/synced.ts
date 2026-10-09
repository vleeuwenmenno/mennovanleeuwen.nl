import { useSyncExternalStore } from 'react'
import { api, getAccount, subscribeAccount } from './account'

// State that follows the owner between devices: notes, window layouts, desktop icons, launchers,
// dock order. Every store keeps its value in localStorage, so visitors get it per browser.
// Signed in, it is also saved to the server (/api/state/<key>, server/state.ts) and loaded from
// there on sign-in and whenever the tab comes back into view.
//
// Conflicts: the server refuses a save made on top of an older version. The store then merges
// (if it knows how, e.g. notes by id) or takes the server's copy.

type Meta<T> = { value: T; /** server version this value is based on */ base: number; /** changed since */ dirty: boolean }
type Remote = { value: unknown; updatedAt: number }

export type Synced<T> = {
  key: string
  get: () => T
  set: (next: T | ((v: T) => T)) => void
  use: () => T
  subscribe: (l: () => void) => () => void
  /** Called when a newer value arrives from the server (not for local changes). */
  onRemote: (l: (v: T) => void) => () => void
}

type Internal = Synced<unknown> & {
  meta: () => Meta<unknown>
  adopt: (r: Remote, dirty?: boolean, notify?: boolean) => void
  pushed: (updatedAt: number, sent: unknown) => void
  reset: () => void
  merge?: (local: unknown, remote: unknown) => unknown
}

const stores = new Map<string, Internal>()
const storageKey = (key: string) => `mvlos.sync.${key}`

function readMeta<T>(key: string, fallback: T, legacyKey?: string, normalize?: (v: unknown) => T): Meta<T> {
  try {
    const raw = localStorage.getItem(storageKey(key))
    if (raw) {
      const m = JSON.parse(raw) as Meta<unknown>
      return { value: normalize ? normalize(m.value) : (m.value as T), base: m.base ?? 0, dirty: !!m.dirty }
    }
    const legacy = legacyKey && localStorage.getItem(legacyKey)
    if (legacy) return { value: normalize ? normalize(JSON.parse(legacy)) : (JSON.parse(legacy) as T), base: 0, dirty: true }
  } catch {
    /* fall back */
  }
  return { value: fallback, base: 0, dirty: false }
}

export function synced<T>(key: string, fallback: T, opts: { legacyKey?: string; normalize?: (v: unknown) => T; merge?: (local: T, remote: T) => T } = {}): Synced<T> {
  let meta = readMeta(key, fallback, opts.legacyKey, opts.normalize)
  const listeners = new Set<() => void>()
  const remoteListeners = new Set<(v: T) => void>()
  const emit = () => listeners.forEach((l) => l())
  const save = () => {
    try {
      localStorage.setItem(storageKey(key), JSON.stringify(meta))
    } catch {
      /* not persisted */
    }
  }
  const normalize = (v: unknown) => (opts.normalize ? opts.normalize(v) : (v as T))

  const store: Synced<T> = {
    key,
    get: () => meta.value,
    set(next) {
      const value = typeof next === 'function' ? (next as (v: T) => T)(meta.value) : next
      if (value === meta.value) return
      meta = { ...meta, value, dirty: true }
      save()
      emit()
      schedulePush(key)
    },
    subscribe(l) {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    use: () => useSyncExternalStore(store.subscribe, store.get),
    onRemote(l) {
      remoteListeners.add(l)
      return () => remoteListeners.delete(l)
    },
  }

  const internal: Internal = {
    ...(store as Synced<unknown>),
    meta: () => meta,
    adopt(r, dirty = false, notify = true) {
      meta = { value: normalize(r.value), base: r.updatedAt, dirty }
      save()
      emit()
      if (notify) remoteListeners.forEach((l) => l(meta.value))
    },
    pushed(updatedAt, sent) {
      // Still dirty if it changed while the request was out.
      meta = { ...meta, base: updatedAt, dirty: meta.value !== sent }
      save()
      if (meta.dirty) schedulePush(key)
    },
    reset() {
      meta = { value: fallback, base: 0, dirty: false }
      try {
        localStorage.removeItem(storageKey(key))
      } catch {
        /* nothing stored */
      }
      emit()
    },
    merge: opts.merge as Internal['merge'],
  }
  stores.set(key, internal)

  // Another tab saved: show the same value here.
  if (typeof window !== 'undefined')
    window.addEventListener('storage', (e) => {
      if (e.key !== storageKey(key)) return
      meta = readMeta(key, fallback, undefined, opts.normalize)
      emit()
    })

  return store
}

// ---------------------------------------------------------------------------------------------
// Talking to the server

const timers = new Map<string, ReturnType<typeof setTimeout>>()
const PUSH_DELAY = 800
let lastPull = 0
let pulling: Promise<void> | null = null

export type SyncStatus = { state: 'local' | 'syncing' | 'synced' | 'error'; at: number; error?: string }
let status: SyncStatus = { state: 'local', at: 0 }
const statusListeners = new Set<() => void>()
const setStatus = (s: SyncStatus) => {
  status = s
  statusListeners.forEach((l) => l())
}
export const useSyncStatus = () =>
  useSyncExternalStore(
    (l) => {
      statusListeners.add(l)
      return () => statusListeners.delete(l)
    },
    () => status,
  )

function schedulePush(key: string) {
  if (getAccount().status !== 'user') return
  clearTimeout(timers.get(key))
  timers.set(key, setTimeout(() => push(key), PUSH_DELAY))
}

async function push(key: string) {
  timers.delete(key)
  const s = stores.get(key)
  if (!s || getAccount().status !== 'user') return
  const { value, base } = s.meta()
  setStatus({ state: 'syncing', at: status.at })
  try {
    const r = await api<Remote & { conflict?: boolean }>(`/api/state/${encodeURIComponent(key)}`, { method: 'PUT', json: { value, base } })
    if (r.conflict) reconcile(s, r)
    else s.pushed(r.updatedAt, value)
    setStatus({ state: 'synced', at: Date.now() })
  } catch (e) {
    setStatus({ state: 'error', at: status.at, error: (e as Error).message })
  }
}

function reconcile(s: Internal, remote: Remote | undefined) {
  const local = s.meta()
  if (!remote) {
    if (local.dirty) void push(s.key)
    return
  }
  if (remote.updatedAt > local.base) {
    if (local.dirty && s.merge) {
      // Both changed: keep both sides' edits and save the result on top of the server's version.
      const merged = s.merge(local.value, remote.value)
      const differs = JSON.stringify(merged) !== JSON.stringify(remote.value)
      // Nothing new to show when the merge kept this tab's own value.
      s.adopt({ value: merged, updatedAt: remote.updatedAt }, differs, merged !== local.value)
      if (differs) void push(s.key)
    } else s.adopt(remote)
  } else if (local.dirty) void push(s.key)
}

/** Loads every synced key from the server and reconciles it with the local copy. */
export function pullAll(): Promise<void> {
  if (getAccount().status !== 'user') return Promise.resolve()
  if (pulling) return pulling
  lastPull = Date.now()
  setStatus({ state: 'syncing', at: status.at })
  pulling = api<Record<string, Remote>>('/api/state')
    .then((remote) => {
      for (const s of stores.values()) reconcile(s, remote[s.key])
      setStatus({ state: 'synced', at: Date.now() })
    })
    .catch((e: Error) => setStatus({ state: 'error', at: status.at, error: e.message }))
    .finally(() => (pulling = null))
  return pulling
}

/** Wires stores to the account: pull on sign-in, forget everything on sign-out. */
export function startSync() {
  let was = getAccount().status
  subscribeAccount(() => {
    const now = getAccount().status
    if (now === was) return
    if (now === 'user') void pullAll()
    if (was === 'user' && now === 'anon') {
      for (const s of stores.values()) s.reset()
      setStatus({ state: 'local', at: 0 })
    }
    was = now
  })
  // Coming back to the tab, and every 30 s while it's in view: another device may have changed
  // things (one small GET of every key).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - lastPull > 20_000) void pullAll()
  })
  setInterval(() => {
    if (document.visibilityState === 'visible' && Date.now() - lastPull > 25_000) void pullAll()
  }, 30_000)
  // Leaving: send pending saves right away.
  window.addEventListener('pagehide', () => {
    if (getAccount().status !== 'user') return
    for (const [key, t] of timers) {
      clearTimeout(t)
      const s = stores.get(key)
      if (!s) continue
      const { value, base } = s.meta()
      fetch(`/api/state/${encodeURIComponent(key)}`, { method: 'PUT', keepalive: true, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value, base }) }).catch(() => {})
    }
  })
}
