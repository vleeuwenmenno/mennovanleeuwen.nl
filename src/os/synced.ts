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

type Meta<T> = {
  value: T
  /** server version this value is based on */
  base: number
  /** changed since */
  dirty: boolean
  /**
   * Set when the page closed while a save was out (see pagehide): the write ids of the saves
   * this value may have lost to, its own saves whose answers never came (the one out, the one
   * sent on closing; more if the page came back and closed again before it was settled). The
   * last one went out on top of the version before the one out, so if that got through, the
   * server refused it. A server version made by any of them is this page's own (see reconcile).
   */
  final?: { ids: string[] }
}

const MAX_FINAL_IDS = 16
const finalOf = (v: unknown): Meta<unknown>['final'] => {
  const ids = (v as { ids?: unknown } | null)?.ids
  return Array.isArray(ids) && ids.length && ids.every((i) => typeof i === 'string') ? { ids: ids as string[] } : undefined
}
/** Both marks' ids (the newest kept when there are too many). */
const joinFinal = (a: Meta<unknown>['final'], b: Meta<unknown>['final']) => ({ ids: [...new Set([...(a?.ids ?? []), ...(b?.ids ?? [])])].slice(-MAX_FINAL_IDS) })
/** `writeId`: the id of the save that made this version (none for versions saved before ids, or by the server itself). */
type Remote = { value: unknown; updatedAt: number; writeId?: string }

/** A new id for a save (server/state.ts keeps the one that made the current version). */
const newWriteId = () => {
  try {
    return crypto.randomUUID()
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
  }
}

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
  pushed: (updatedAt: number, sent: unknown, writeId: string) => void
  /** Whether the value is the server's copy at its base, as far as this tab knows. */
  sameAsServer: () => boolean
  /** The page is closing with save `out` still out and save `sent` sent now (write ids): kept with the value (Meta.final). */
  closing: (out: string, sent: string) => void
  /** Counts the times the value was replaced from elsewhere (see synced's `epoch`). */
  epoch: () => number
  /** Keeps the unsaved value as it is, on top of the server's version `updatedAt`. */
  rebase: (updatedAt: number) => void
  /** Marks the value saved (it already is, on the server). */
  clean: () => void
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
      const final = finalOf(m.final)
      return { value: normalize ? normalize(m.value) : (m.value as T), base: m.base ?? 0, dirty: !!m.dirty, ...(final ? { final } : {}) }
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
  /** The server's copy at a version, as last sent or received here (a save of the same is skipped). */
  let known: { base: number; json: string } | null = null
  /** A copy marked saved is the server's at its base. */
  const learn = () => {
    if (!meta.dirty && meta.base > 0) known = { base: meta.base, json: JSON.stringify(meta.value) }
  }
  learn()
  const listeners = new Set<() => void>()
  const remoteListeners = new Set<(v: T) => void>()
  const syncedListeners = new Set<() => void>()
  const emitSynced = () => {
    if (meta.base > 0) syncedListeners.forEach((l) => l())
  }
  const emit = () => listeners.forEach((l) => l())
  const normalize = (v: unknown) => (opts.normalize ? opts.normalize(v) : (v as T))
  /**
   * Bumped whenever the value is replaced by one from elsewhere (another tab's copy, the
   * server's): a save sent before that is no part of the value now, so its write id never goes
   * into this value's closing mark (see pagehide).
   */
  let epoch = 0
  // Known gap, as on main: another tab whose storage event about a closing mark hasn't arrived
  // yet writes its own copy over the stored one (an answer to an unrelated save, a pull), and the
  // value that mark protected is gone. Taking the stored copy over instead was tried and could
  // attach this tab's newer save to the older value.
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
        // Unsaved only for what is unsaved here, or what the stored copy brought that wasn't saved
        // yet. Not for the stored copy's flag alone: that is often this tab's own earlier write
        // (or another tab's copy of it), and taking it in again after every save kept both tabs
        // saving the same value to the server forever.
        meta = { value: others ? merged : meta.value, base, dirty: meta.dirty || (!!stored.dirty && others) || (base > meta.base && JSON.stringify(merged) !== JSON.stringify(theirs)) }
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
      // Nothing changed (the same value made again): nothing to save or send.
      if (value === meta.value || JSON.stringify(value) === JSON.stringify(meta.value)) return
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
      // Another version than this page's own (reconcile keeps the value when it is): the mark goes.
      epoch++
      meta = { value: normalize(r.value), base: r.updatedAt, dirty }
      if (!dirty) known = { base: r.updatedAt, json: JSON.stringify(meta.value) }
      save()
      emit()
      if (notify) remoteListeners.forEach((l) => l(meta.value))
      emitSynced()
    },
    pushed(updatedAt, sent, writeId) {
      known = { base: updatedAt, json: JSON.stringify(sent) }
      // The closing mark only goes with the answer to one of its own saves (the page came back
      // from the back/forward cache), not with another tab's or another save's.
      const final = meta.final && !meta.final.ids.includes(writeId) ? meta.final : undefined
      // Still dirty if it changed while the request was out.
      meta = { value: meta.value, base: updatedAt, dirty: meta.value !== sent && JSON.stringify(meta.value) !== known.json, ...(final ? { final } : {}) }
      save()
      emitSynced()
      if (meta.dirty) schedulePush(key)
    },
    sameAsServer: () => !!known && known.base === meta.base && known.json === JSON.stringify(meta.value),
    closing(out, sent) {
      // Closing again before an earlier mark was settled (back from the back/forward cache):
      // its ids still count, the server may hold a version one of them made.
      meta = { ...meta, final: joinFinal(meta.final, { ids: [out, sent] }) }
      save()
    },
    rebase(updatedAt) {
      meta = { value: meta.value, base: updatedAt, dirty: true }
      save()
    },
    clean() {
      meta = { ...meta, dirty: false }
      save()
      emitSynced()
    },
    reset() {
      known = null
      epoch++
      meta = { value: fallback, base: 0, dirty: false }
      accountStorage.remove(storageKey(key))
      emit()
    },
    merge: opts.merge as Internal['merge'],
    epoch: () => epoch,
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
      epoch++
      learn()
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

// Every save goes through schedulePush. A store that keeps saving (more than BURST times within
// BURST_WINDOW) is held back, twice as long with each save after that, up to a minute, until it
// has been quiet for longer than it was held back: whatever goes wrong between tabs, devices and
// merges, no store can keep the server busy. A failed save is tried again, also waiting twice as
// long each time. One save per store is out at a time; a change made meanwhile goes out after
// it, whatever its answer.
const BURST = 10
const BURST_WINDOW = 20_000
const MAX_BACKOFF = 60_000
type Pace = { sent: number[]; level: number; last: number; errors: number }
const paces = new Map<string, Pace>()
const inFlight = new Set<string>()
/** The save out for a key: its write id, and the store's epoch when it was sent. */
const outId = new Map<string, { id: string; epoch: number }>()
/** Keys with a save asked for here that hasn't gone through yet (pagehide sends them). */
const pending = new Set<string>()
const paceOf = (key: string) => {
  let p = paces.get(key)
  if (!p) paces.set(key, (p = { sent: [], level: 0, last: 0, errors: 0 }))
  return p
}
const penalty = (level: number) => Math.min(MAX_BACKOFF, 1000 * 2 ** level)

/** How long `key` has to wait before its next save may go out. */
function backoff(key: string, now = Date.now()): number {
  const p = paceOf(key)
  p.sent = p.sent.filter((t) => now - t < BURST_WINDOW)
  // Quiet for longer than it was held back (and than the window): back to normal.
  if (p.level > 0 && now - p.last > Math.max(BURST_WINDOW, 2 * penalty(p.level))) p.level = 0
  const wait = Math.max(p.level > 0 ? penalty(p.level) : 0, p.errors > 0 ? penalty(p.errors) : 0)
  return Math.max(0, wait - (now - p.last))
}

/** A save going out now: counted, and the store held back further if it keeps saving. */
function counted(key: string, now = Date.now()) {
  const p = paceOf(key)
  p.sent.push(now)
  p.last = now
  if (p.level > 0 || p.sent.length > BURST) p.level = Math.min(p.level + 1, 16)
}

/** For scripts/widgets-sync-check.ts: the pacing above, with a clock of its own. */
export const syncPacing = {
  backoff,
  counted,
  failed: (key: string) => void (paceOf(key).errors += 1),
  forget: (key: string) => void paces.delete(key),
}

function schedulePush(key: string, delay = PUSH_DELAY) {
  if (getAccount().status !== 'user' || frozen()) return
  pending.add(key)
  clearTimeout(timers.get(key))
  timers.set(key, setTimeout(() => void push(key), Math.max(delay, backoff(key))))
}

async function push(key: string) {
  timers.delete(key)
  const s = stores.get(key)
  if (!s || getAccount().status !== 'user' || frozen()) return
  // The one out now comes back first; this one stays pending and goes after it (see finally).
  if (inFlight.has(key)) return
  // Already the server's copy (a change made and undone, another tab's save): nothing to send.
  if (s.sameAsServer()) {
    if (s.meta().dirty) s.clean()
    pending.delete(key)
    return
  }
  const wait = backoff(key)
  if (wait > 0) return schedulePush(key, wait)
  const { value, base } = s.meta()
  const pace = paceOf(key)
  counted(key)
  inFlight.add(key)
  const writeId = newWriteId()
  outId.set(key, { id: writeId, epoch: s.epoch() })
  setStatus({ state: 'syncing', at: status.at })
  try {
    const r = await api<Remote & { conflict?: boolean }>(`/api/state/${encodeURIComponent(key)}`, { method: 'PUT', json: { value, base, writeId } })
    // The browser was signed in as someone else while the request was out: not this tab's answer.
    if (frozen() || !accountGuard()) return
    pace.errors = 0
    if (r.conflict) reconcile(s, r)
    else s.pushed(r.updatedAt, value, writeId)
    setStatus({ state: 'synced', at: Date.now() })
  } catch (e) {
    pace.errors = Math.min(pace.errors + 1, 16)
    setStatus({ state: 'error', at: status.at, error: (e as Error).message })
  } finally {
    inFlight.delete(key)
    outId.delete(key)
    // Still unsaved (changed while it was out, or the save failed): saved next, unless something
    // already asked for that. A failed one waits (backoff, by its errors).
    if (!s.meta().dirty) pending.delete(key)
    else if (!timers.has(key) && !frozen() && accountGuard()) schedulePush(key)
  }
}

function reconcile(s: Internal, remote: Remote | undefined) {
  const local = s.meta()
  if (!remote) {
    if (local.dirty) schedulePush(s.key, 0)
    return
  }
  if (remote.updatedAt > local.base) {
    s.onIncoming?.(remote.value)
    // The page closed with a save out, and the server's version is one that a save of this page
    // made (by its write id: nothing was saved since, here or elsewhere): the last save on closing
    // was refused for being on top of the version before it. Kept, and saved on top. Stores that
    // merge already keep it.
    if (local.final && local.dirty && !s.merge && remote.writeId !== undefined && local.final.ids.includes(remote.writeId)) {
      s.rebase(remote.updatedAt)
      schedulePush(s.key, 0)
      return
    }
    // A copy never saved to the account (base 0) gives way to the account's, if the store says so.
    if (local.dirty && s.merge && !(s.yieldWhenNew && local.base === 0)) {
      // Both changed: keep both sides' edits and save the result on top of the server's version.
      // The server's copy is read as the store reads its own (an older format, junk) first.
      const theirs = s.normalize(remote.value)
      const merged = s.merge(local.value, theirs)
      const differs = JSON.stringify(merged) !== JSON.stringify(theirs)
      // Nothing new to show when the merge kept this tab's own value.
      s.adopt({ value: merged, updatedAt: remote.updatedAt }, differs, merged !== local.value)
      if (differs) schedulePush(s.key, 0)
    } else s.adopt(remote)
  } else if (local.dirty) schedulePush(s.key, 0)
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
    // Every save asked for and not through yet, with or without a timer (one waiting for a save
    // still out has none). The timers go: a save coming back after this must not take one still
    // listed as already asking for the next save.
    const keys = new Set([...pending, ...timers.keys()])
    for (const t of timers.values()) clearTimeout(t)
    timers.clear()
    for (const key of keys) {
      const s = stores.get(key)
      // The server's copy, as far as this tab knows, unless a save is still out: then the server
      // may be about to hold that save's value instead (a change undone meanwhile), so send it.
      if (!s || !s.meta().dirty || (!inFlight.has(key) && s.sameAsServer())) continue
      // A save still out may get through before this one, which is then refused (it is on top of
      // the version before): the next page load keeps this value if so (see reconcile).
      const writeId = newWriteId()
      const out = outId.get(key)
      // Only a save of this value's own past (not one sent before the value was replaced).
      if (out && out.epoch === s.epoch() && !s.merge) s.closing(out.id, writeId)
      const { value, base } = s.meta()
      fetch(`/api/state/${encodeURIComponent(key)}`, { method: 'PUT', keepalive: true, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-MvL-Account': TAB_ACCOUNT }, body: JSON.stringify({ value, base, writeId }) }).catch(() => {})
    }
  })
  // Back from the back/forward cache: the page runs on, so what it hadn't saved is saved now
  // (the last saves sent on leaving may not have made it).
  window.addEventListener('pageshow', (e) => {
    if (!(e as PageTransitionEvent).persisted) return
    for (const key of pending) if (!timers.has(key) && stores.get(key)?.meta().dirty) schedulePush(key)
  })
}
