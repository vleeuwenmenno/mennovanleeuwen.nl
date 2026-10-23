import { useSyncExternalStore } from 'react'
import { api, getAccount, subscribeAccount } from './account'
import { accountFrozen, accountGuard, accountKey, accountStorage, TAB_ACCOUNT } from './accountSpace'

// State that follows the user between devices: notes, window layouts, desktop icons, launchers,
// dock order. Every store keeps its value in localStorage, so visitors get it per browser.
// Signed in, it is also saved to the server (/api/state/<key>, server/state.ts) and loaded from
// there on sign-in and whenever the tab comes back into view.
//
// Conflicts: the server refuses a save made on top of an older version. The store then merges
// (if it knows how, e.g. notes by id) or takes the server's copy.
//
// A store made with `yieldWhenNew` takes the server's copy over a local one that was never saved to
// the account (a browser signing in for the first time), instead of merging: the window layout,
// whose merge keeps the local one, would otherwise put a new browser's opening windows over the
// account's.
//
// Two tabs of one browser: a tab only takes in another tab's save (the storage event), it never
// writes from there. A store with `mergeTabs` keeps both tabs' changes by merging right before it
// saves: it reads what is stored, merges it into its own value with `merge`, and writes that.
//
// Each value is kept in this tab's account space (src/os/accountSpace.ts): another account's tab
// never reads it, and this tab writes and sends nothing once the browser is signed in as someone
// else (accountGuard). An answer from the server that arrives after that is dropped.

type Meta<T> = { value: T; /** server version this value is based on */ base: number; /** changed since */ dirty: boolean }
type Remote = { value: unknown; updatedAt: number }

export type Synced<T> = {
  key: string
  get: () => T
  set: (next: T | ((v: T) => T)) => void
  use: () => T
  subscribe: (l: () => void) => () => void
  /** Called when a newer value arrives from the server or another tab (not for local changes). */
  onRemote: (l: (v: T) => void) => () => void
  /** Whether this browser's copy was ever saved to or loaded from the account. */
  everSynced: () => boolean
  /** Called after account metadata is established, after any remote value callbacks. */
  onSynced: (l: () => void) => () => void
}

type Internal = Synced<unknown> & {
  meta: () => Meta<unknown>
  adopt: (r: Remote, dirty?: boolean, notify?: boolean) => void
  pushed: (updatedAt: number, sent: unknown) => void
  reset: () => void
  merge?: (local: unknown, remote: unknown) => unknown
  normalize: (v: unknown) => unknown
  yieldWhenNew?: boolean
  onIncoming?: (remote: unknown) => void
}

const stores = new Map<string, Internal>()
/**
 * Set while an account's state is being cleared from this browser (src/os/account.ts), right
 * before the page starts again: nothing may write it back, or the next account would get it.
 */
let forgetting = false
if (typeof window !== 'undefined') window.addEventListener('mvlos:forget', () => (forgetting = true))
const frozen = () => forgetting || accountFrozen()
/** The store's key as written before account spaces (accountStorage puts it in this tab's space). */
const storageKey = (key: string) => `mvlos.sync.${key}`

function readMeta<T>(key: string, fallback: T, legacyKey?: string, normalize?: (v: unknown) => T): Meta<T> {
  try {
    const raw = accountStorage.get(storageKey(key))
    if (raw) {
      const m = JSON.parse(raw) as Meta<unknown>
      return { value: normalize ? normalize(m.value) : (m.value as T), base: m.base ?? 0, dirty: !!m.dirty }
    }
    const legacy = legacyKey && accountStorage.get(legacyKey)
    if (legacy) return { value: normalize ? normalize(JSON.parse(legacy)) : (JSON.parse(legacy) as T), base: 0, dirty: true }
  } catch {
    /* fall back */
  }
  return { value: fallback, base: 0, dirty: false }
}

export function synced<T>(
  key: string,
  fallback: T,
  opts: {
    legacyKey?: string
    normalize?: (v: unknown) => T
    merge?: (local: T, remote: T) => T
    /** A copy never saved to the account takes the account's on the first pull (see reconcile). */
    yieldWhenNew?: boolean
    /** Merge what another tab saved into this tab's value (with `merge`) right before saving. */
    mergeTabs?: boolean
    /** Sees every newer value from the server or another tab before any merge can drop it. */
    onIncoming?: (remote: unknown) => void
  } = {},
): Synced<T> {
  let meta = readMeta(key, fallback, opts.legacyKey, opts.normalize)
  const listeners = new Set<() => void>()
  const remoteListeners = new Set<(v: T) => void>()
  const syncedListeners = new Set<() => void>()
  const emitSynced = () => {
    if (meta.base > 0) syncedListeners.forEach((l) => l())
  }
  const emit = () => listeners.forEach((l) => l())
  const normalize = (v: unknown) => (opts.normalize ? opts.normalize(v) : (v as T))
  const save = () => {
    if (frozen() || !accountGuard()) return
    let others = false
    // Another tab's save this tab hasn't heard of yet: merged in first.
    const raw = opts.mergeTabs && opts.merge ? accountStorage.get(storageKey(key)) : null
    if (raw !== null)
      try {
        const stored = JSON.parse(raw) as Meta<unknown>
        const theirs = normalize(stored.value)
        const merged = opts.merge!(meta.value, theirs)
        others = JSON.stringify(merged) !== JSON.stringify(meta.value)
        const base = Math.max(meta.base, stored.base ?? 0)
        meta = { value: others ? merged : meta.value, base, dirty: meta.dirty || !!stored.dirty || (base > meta.base && JSON.stringify(merged) !== JSON.stringify(theirs)) }
      } catch {
        /* not readable: written over */
      }
    accountStorage.set(storageKey(key), JSON.stringify(meta))
    // Another tab's changes came along: show them, as when they arrive by themselves.
    if (others) {
      emit()
      remoteListeners.forEach((l) => l(meta.value))
    }
  }

  const store: Synced<T> = {
    key,
    get: () => meta.value,
    set(next) {
      const value = typeof next === 'function' ? (next as (v: T) => T)(meta.value) : next
      if (value === meta.value) return
      meta = { ...meta, value, dirty: true }
      save()
      emit()
      emitSynced()
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
    everSynced: () => meta.base > 0,
    onSynced(l) {
      syncedListeners.add(l)
      if (meta.base > 0) l()
      return () => {
        syncedListeners.delete(l)
      }
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
      emitSynced()
    },
    pushed(updatedAt, sent) {
      // Still dirty if it changed while the request was out.
      meta = { ...meta, base: updatedAt, dirty: meta.value !== sent }
      save()
      emitSynced()
      if (meta.dirty) schedulePush(key)
    },
    reset() {
      meta = { value: fallback, base: 0, dirty: false }
      accountStorage.remove(storageKey(key))
      emit()
    },
    merge: opts.merge as Internal['merge'],
    normalize,
    yieldWhenNew: opts.yieldWhenNew,
    onIncoming: opts.onIncoming,
  }
  stores.set(key, internal)

  // Another tab saved: show the same value here, and tell those following remote changes (the
  // window manager moves its windows to match), or this tab's next save would undo that one.
  if (typeof window !== 'undefined')
    window.addEventListener('storage', (e) => {
      if (e.key !== accountKey(storageKey(key)) || frozen()) return
      const before = meta.value
      meta = readMeta(key, fallback, undefined, opts.normalize)
      if (e.newValue !== null) opts.onIncoming?.(meta.value)
      emit()
      if (JSON.stringify(meta.value) !== JSON.stringify(before)) remoteListeners.forEach((l) => l(meta.value))
      emitSynced()
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
export const getSyncStatus = () => status
export const subscribeSyncStatus = (l: () => void) => {
  statusListeners.add(l)
  return () => statusListeners.delete(l)
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
  if (getAccount().status !== 'user' || frozen()) return
  clearTimeout(timers.get(key))
  timers.set(key, setTimeout(() => push(key), PUSH_DELAY))
}

async function push(key: string) {
  timers.delete(key)
  const s = stores.get(key)
  if (!s || getAccount().status !== 'user' || frozen()) return
  const { value, base } = s.meta()
  setStatus({ state: 'syncing', at: status.at })
  try {
    const r = await api<Remote & { conflict?: boolean }>(`/api/state/${encodeURIComponent(key)}`, { method: 'PUT', json: { value, base } })
    // The browser was signed in as someone else while the request was out: not this tab's answer.
    if (frozen() || !accountGuard()) return
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
    s.onIncoming?.(remote.value)
    // A copy never saved to the account (base 0) gives way to the account's, if the store says so.
    if (local.dirty && s.merge && !(s.yieldWhenNew && local.base === 0)) {
      // Both changed: keep both sides' edits and save the result on top of the server's version.
      // The server's copy is read as the store reads its own (an older format, junk) first.
      const theirs = s.normalize(remote.value)
      const merged = s.merge(local.value, theirs)
      const differs = JSON.stringify(merged) !== JSON.stringify(theirs)
      // Nothing new to show when the merge kept this tab's own value.
      s.adopt({ value: merged, updatedAt: remote.updatedAt }, differs, merged !== local.value)
      if (differs) void push(s.key)
    } else s.adopt(remote)
  } else if (local.dirty) void push(s.key)
}

/** Loads every synced key from the server and reconciles it with the local copy. */
export function pullAll(): Promise<void> {
  if (getAccount().status !== 'user' || frozen()) return Promise.resolve()
  if (pulling) return pulling
  lastPull = Date.now()
  setStatus({ state: 'syncing', at: status.at })
  pulling = api<Record<string, Remote>>('/api/state')
    .then((remote) => {
      if (frozen() || !accountGuard()) return
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
    if (getAccount().status !== 'user' || frozen() || !accountGuard()) return
    for (const [key, t] of timers) {
      clearTimeout(t)
      const s = stores.get(key)
      if (!s) continue
      const { value, base } = s.meta()
      fetch(`/api/state/${encodeURIComponent(key)}`, { method: 'PUT', keepalive: true, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-MvL-Account': TAB_ACCOUNT }, body: JSON.stringify({ value, base }) }).catch(() => {})
    }
  })
}
