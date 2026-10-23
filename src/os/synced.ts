import { useSyncExternalStore } from 'react'
import { ACCOUNT_STORAGE_KEY, api, browserAccountTag, getAccount, subscribeAccount, type Account } from './account'

// State that follows the user between devices: notes, window layouts, desktop icons, launchers,
// dock order. Every store keeps its value in localStorage, so visitors get it per browser.
// Signed in, it is also saved to the server (/api/state/<key>, server/state.ts) and loaded from
// there on sign-in and whenever the tab comes back into view.
//
// Conflicts: the server refuses a save made on top of an older version. The store then merges
// (if it knows how, e.g. notes by id) or takes the server's copy.
//
// Whose state it is. Tabs of one browser share its storage and its sign-in cookie, so a tab can
// hold one account's state while another tab signs out or in as someone else. That state must
// never reach the other account, in this browser or on the server:
// - Each tab takes an owner once, as it starts: the account this browser holds then (its marker,
//   `mvlos.account`, see src/os/account.ts), as `u:<id>`, or `visitor`. A visitor's tab that signs
//   in takes that account as its owner, once (what was done as a visitor joins the account).
// - Everything a tab saves is tagged with its owner. A tab only takes in values tagged with its
//   owner, untagged ones (saved before tags: the account at load's) and a visitor's; another
//   account's value found as a tab starts is dropped (the account's own copy comes with the pull).
// - Before every save to this browser and every pull from or push to the server, the tab checks
//   its owner is still the account: its own account (as it loaded) and the browser's marker, as
//   far as that has said its owner before (a marker this tab failed to write, storage being full,
//   is no sign of a switch). A mismatch, another account's value turning up, or another tab
//   changing the marker stops the tab: it writes and sends nothing more, and starts again.
// - Requests say whose state they carry (X-MvL-Account); the server refuses them when the cookie
//   is someone else's by now (server/api.ts), and an answer that comes back after the account
//   changed is dropped.

type Meta<T> = {
  value: T
  /** server version this value is based on */
  base: number
  /** changed since */
  dirty: boolean
}
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
/**
 * Set while an account's state is being cleared from this browser (src/os/account.ts), right
 * before the page starts again, or once this tab stopped (see stop): nothing may write it back,
 * or the next account would get it.
 */
let frozen = false
if (typeof window !== 'undefined') window.addEventListener('mvlos:forget', () => (frozen = true))
const storageKey = (key: string) => `mvlos.sync.${key}`

// ---------------------------------------------------------------------------------------------
// Whose state this tab holds (see the top)

/** This tab's owner: `u:<id>` or `visitor`, taken as it starts; null while storage can't be read. */
let owner: string | null = browserAccountTag()
/** Whether the browser's marker has said this tab's owner: only then is it a sign of anything. */
let markerSeen = owner !== null && owner !== 'visitor'
const tagOf = (a: Account): string | null => (a.status === 'user' ? `u:${a.user!.id}` : a.status === 'anon' ? 'visitor' : null)
/** Whether a stored value's tag lets this tab take it in. */
const takes = (tag: unknown) => owner === null || tag === undefined || tag === owner || tag === 'visitor'
const tagIn = (raw: string | null): unknown => {
  try {
    return raw ? (JSON.parse(raw) as { owner?: unknown }).owner : undefined
  } catch {
    return undefined
  }
}

let stopped = false
/** This tab holds another account's state now: nothing more goes in or out, and the page starts again. */
function stop() {
  if (stopped) return
  stopped = frozen = true
  for (const t of timers.values()) clearTimeout(t)
  timers.clear()
  try {
    location.reload()
  } catch {
    /* not in a page */
  }
}
/** Whether this tab stopped syncing because the account changed under it (see stop). */
export const syncStopped = () => stopped

/**
 * Whether this tab may still save and sync its state: its owner is the account it is signed in
 * as (once known), and the browser's marker hasn't moved on from it. A visitor's tab signing in
 * (or one whose storage can't be read) takes the account as its owner here, once. Stops the tab
 * on a mismatch.
 */
function ownsState(): boolean {
  if (frozen) return false
  const tag = tagOf(getAccount())
  if (tag !== null && tag !== owner) {
    if ((owner === 'visitor' || owner === null) && tag !== 'visitor') {
      owner = tag
      markerSeen = browserAccountTag() === owner
    } else if (owner !== null) {
      stop()
      return false
    }
  }
  if (markerSeen) {
    const now = browserAccountTag()
    if (now !== null && now !== owner) {
      stop()
      return false
    }
  }
  return true
}

if (typeof window !== 'undefined')
  // Another tab signed in, out or as someone else. (Only this counts as a change of the marker: a
  // marker this tab failed to write itself is not one.)
  window.addEventListener('storage', (e) => {
    if (e.key !== ACCOUNT_STORAGE_KEY || owner === null) return
    if ((e.newValue ? `u:${e.newValue}` : 'visitor') !== owner) stop()
  })

/** What this tab's requests say about whose state they carry (server/api.ts refuses another account's). */
function holdsHeader(): Record<string, string> {
  const id = owner?.startsWith('u:') ? owner.slice(2) : getAccount().user?.id
  return id !== undefined ? { 'X-MvL-Account': String(id) } : {}
}
/** The server's answer when the browser is signed in as another account by now. */
const ACCOUNT_CHANGED = 'Signed in as another account'

// ---------------------------------------------------------------------------------------------

function readMeta<T>(key: string, fallback: T, legacyKey?: string, normalize?: (v: unknown) => T): Meta<T> {
  try {
    const raw = localStorage.getItem(storageKey(key))
    if (raw) {
      const m = JSON.parse(raw) as Meta<unknown> & { owner?: unknown }
      // Another account's: not this tab's.
      if (!takes(m.owner)) return { value: fallback, base: 0, dirty: false }
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
  // Starting: another account's value left here (by a tab that had not stopped yet) is not taken
  // in, and goes, so it can't turn up later.
  try {
    const raw = localStorage.getItem(storageKey(key))
    if (raw && !takes(tagIn(raw))) localStorage.removeItem(storageKey(key))
  } catch {
    /* storage can't be used: nothing kept in it either */
  }
  let meta = readMeta(key, fallback, opts.legacyKey, opts.normalize)
  const listeners = new Set<() => void>()
  const remoteListeners = new Set<(v: T) => void>()
  const emit = () => listeners.forEach((l) => l())
  const save = () => {
    if (!ownsState()) return
    try {
      localStorage.setItem(storageKey(key), JSON.stringify(owner !== null ? { ...meta, owner } : meta))
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

  // Another tab saved: show the same value here, and tell those following remote changes (the
  // window manager moves its windows to match), or this tab's next save would undo that one.
  // Another account's value means this tab is out of date: it stops.
  if (typeof window !== 'undefined')
    window.addEventListener('storage', (e) => {
      if (e.key !== storageKey(key) || frozen) return
      let raw: string | null = null
      try {
        raw = localStorage.getItem(storageKey(key))
      } catch {
        return
      }
      if (raw !== null && !takes(tagIn(raw))) return stop()
      const before = meta.value
      meta = readMeta(key, fallback, undefined, opts.normalize)
      emit()
      if (JSON.stringify(meta.value) !== JSON.stringify(before)) remoteListeners.forEach((l) => l(meta.value))
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
  if (getAccount().status !== 'user' || frozen) return
  clearTimeout(timers.get(key))
  timers.set(key, setTimeout(() => push(key), PUSH_DELAY))
}

async function push(key: string) {
  timers.delete(key)
  const s = stores.get(key)
  if (!s || getAccount().status !== 'user' || !ownsState()) return
  const { value, base } = s.meta()
  setStatus({ state: 'syncing', at: status.at })
  try {
    const r = await api<Remote & { conflict?: boolean }>(`/api/state/${encodeURIComponent(key)}`, { method: 'PUT', json: { value, base }, headers: holdsHeader() })
    // The account changed while the request was out: the answer is not this tab's.
    if (!ownsState()) return
    if (r.conflict) reconcile(s, r)
    else s.pushed(r.updatedAt, value)
    setStatus({ state: 'synced', at: Date.now() })
  } catch (e) {
    if ((e as Error).message === ACCOUNT_CHANGED) return stop()
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
  if (getAccount().status !== 'user' || !ownsState()) return Promise.resolve()
  if (pulling) return pulling
  lastPull = Date.now()
  setStatus({ state: 'syncing', at: status.at })
  pulling = api<Record<string, Remote>>('/api/state', { headers: holdsHeader() })
    .then((remote) => {
      // The account changed while the request was out: not this tab's state.
      if (!ownsState()) return
      for (const s of stores.values()) reconcile(s, remote[s.key])
      setStatus({ state: 'synced', at: Date.now() })
    })
    .catch((e: Error) => (e.message === ACCOUNT_CHANGED ? stop() : setStatus({ state: 'error', at: status.at, error: e.message })))
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
    if (getAccount().status !== 'user' || !ownsState()) return
    for (const [key, t] of timers) {
      clearTimeout(t)
      const s = stores.get(key)
      if (!s) continue
      const { value, base } = s.meta()
      fetch(`/api/state/${encodeURIComponent(key)}`, { method: 'PUT', keepalive: true, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...holdsHeader() }, body: JSON.stringify({ value, base }) }).catch(() => {})
    }
  })
}
