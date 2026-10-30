import { useSyncExternalStore } from 'react'
import { api, getAccount, subscribeAccount } from './account'
import { accountFrozen, accountGuard, accountKey, accountStorage, TAB_ACCOUNT, widgetLegacyStage, WIDGET_NOTE_CACHE_KEY } from './accountSpace'
import { storageTransaction } from './storageTransaction'

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

/** A successful whole-account read, including keys absent from the account. Unlike onSynced,
 * this does not require a key to have a server version. Consumers can atomically migrate keys
 * only after every existing store has reconciled. A failed/offline read never establishes it. */
export type SyncedHydration = Readonly<Record<string, Remote>>
let hydration: SyncedHydration | null = null
const hydrationListeners = new Set<(snapshot: SyncedHydration) => void>()
export const getSyncedHydration = () => hydration
export function onSyncedHydration(l: (snapshot: SyncedHydration) => void) {
  hydrationListeners.add(l)
  if (hydration) l(hydration)
  return () => { hydrationListeners.delete(l) }
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
  /** Wait for serialized durable persistence, when configured. */
  flush?: () => Promise<void>
  /** Request a durable pass even when no optimistic value changed (serialized stores only). */
  persist?: () => Promise<void>
  /** Called after account metadata is established, after any remote value callbacks. */
  onSynced: (l: () => void) => () => void
}

type Internal = Synced<unknown> & {
  verify?: () => void
  meta: () => Meta<unknown>
  adopt: (r: Remote, dirty?: boolean, notify?: boolean) => void
  pushed: (updatedAt: number, sent: unknown) => void
  /** Whether the value is the server's copy at its base, as far as this tab knows. */
  sameAsServer: () => boolean
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
// Only cooperating clients write this checkpoint, under storageTransaction. It is live account
// state, never a migration input or an ordinary key that an older client might be writing.
class NoteCacheReadError extends Error {}
function readNoteCache(): Meta<unknown> | null {
  const raw = accountStorage.getStrict(WIDGET_NOTE_CACHE_KEY)
  if (raw === null) return null
  try {
    const entry = JSON.parse(raw)
    if (!entry || !Array.isArray(entry.value) || !Number.isFinite(entry.base) || entry.base < 0 || typeof entry.dirty !== 'boolean') throw new Error('Invalid note cache')
    return entry
  } catch { throw new NoteCacheReadError('Widget note cache unreadable') }
}
/** A clean older cache is a superseded server snapshot, not a local edit. In particular it
 * must not resurrect a note whose tombstone has since expired on the server. */
function mergeNoteCache<T>(candidate: Meta<T>, stored: Meta<unknown> | null, normalize: (v: unknown) => T, merge?: (a: T, b: T) => T): Meta<T> {
  if (!stored) return candidate
  const other = { ...stored, value: normalize(stored.value) }
  const [newer, older] = candidate.base >= other.base ? [candidate, other] : [other, candidate]
  const value = merge && (older.dirty || older.base === newer.base && newer.dirty) ? merge(newer.value, older.value) : newer.value
  return { value, base: newer.base, dirty: newer.dirty || JSON.stringify(value) !== JSON.stringify(newer.value) }
}

function readMeta<T>(key: string, fallback: T, legacyKey?: string, normalize?: (v: unknown) => T, strict = false, onStage?: () => void, onFailure?: (error: unknown) => void): Meta<T> {
  try {
    let raw = strict || key === 'notes' ? accountStorage.getStrict(storageKey(key)) : accountStorage.get(storageKey(key))
    if (raw === null && key === 'notes') {
      const cached = readNoteCache()
      if (cached) {
        onStage?.()
        return { ...cached, value: normalize ? normalize(cached.value) : cached.value as T }
      }
    }
    if (raw === null) { raw = widgetLegacyStage(storageKey(key)); if (raw !== null) onStage?.() }
    if (raw !== null) {
      const m = JSON.parse(raw) as Meta<unknown>
      if (key === 'notes' && !Array.isArray(m?.value)) throw new NoteCacheReadError('Widget notes unreadable')
      return { value: normalize ? normalize(m.value) : (m.value as T), base: m.base ?? 0, dirty: !!m.dirty }
    }
    const legacy = legacyKey && (strict ? accountStorage.getStrict(legacyKey) : accountStorage.get(legacyKey))
    if (legacy) return { value: normalize ? normalize(JSON.parse(legacy)) : (JSON.parse(legacy) as T), base: 0, dirty: true }
  } catch (error) {
    if (strict) throw error
    onFailure?.(error)
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
    /** A failed canonical merge must preserve the durable copy and pending operation journal. */
    preserveOnMergeError?: boolean
    /** Canonical stores serialize every durable write, including remote metadata updates. */
    serialize?: <R>(run: () => R) => Promise<R>
    /** Both hooks run synchronously inside serialize, never during optimistic admission. */
    beforeRead?: () => void
    prepare?: (value: T) => T
    afterPersist?: (value: T) => void
    /** Sees every newer value from the server or another tab before any merge can drop it. */
    onIncoming?: (remote: unknown) => void
  } = {},
): Synced<T> {
  let stageOnly = false, noteReadError = false, noteMemoryFallback = false
  const noteFailure = (error: unknown) => {
    if (key !== 'notes') return
    noteReadError = true
    // Fully blocked browser storage still permits ordinary notes in memory. A specific unreadable
    // snapshot/cache must never be mistaken for an empty store and overwritten.
    if (!(error instanceof NoteCacheReadError) && !(error instanceof Error && error.message.startsWith('Widget migration snapshot'))) {
      try { Object.keys(localStorage) } catch { noteMemoryFallback = true }
    }
  }
  let meta = readMeta(key, fallback, opts.legacyKey, opts.normalize, false, () => { stageOnly = true }, noteFailure)
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
  let persistence: Promise<void> = Promise.resolve()
  const serialized = (run: () => void) => {
    const task = persistence.catch(() => {}).then(() => (opts.serialize ?? storageTransaction)(() => {
      if (frozen() || !accountGuard()) throw new Error('Widget persistence cancelled: account authority changed')
      run()
    }))
    persistence = task
    void task.catch(reportSyncFailure)
  }
  const saveNow = () => {
    if (frozen() || !accountGuard()) return
    if (noteReadError) {
      if (noteMemoryFallback) return // Storage may recover: never overwrite a value we could not read.
      throw new Error('Widget note storage unavailable; reload to retry')
    }
    if (stageOnly) {
      // Sync bookkeeping must not materialize a staged input into an ordinary shared key.
      // If another tab established that key, it is the account's authoritative value.
      const actual = accountStorage.getStrict(storageKey(key))
      if (actual === null) {
        if (key === 'notes') {
          const candidate = mergeNoteCache(meta, readNoteCache(), normalize, opts.merge)
          if (!accountStorage.set(WIDGET_NOTE_CACHE_KEY, JSON.stringify(candidate))) throw new Error('Widget note cache write refused; reload or retry')
          const changed = JSON.stringify(meta.value) !== JSON.stringify(candidate.value)
          meta = candidate
          if (changed) { emit(); remoteListeners.forEach(l => l(meta.value)) }
        }
        return
      }
      const stored = JSON.parse(actual) as Meta<unknown>
      if (key === 'notes' && !Array.isArray(stored?.value)) throw new NoteCacheReadError('Widget notes unreadable')
      meta = { value: normalize(stored.value), base: stored.base ?? 0, dirty: !!stored.dirty }
      stageOnly = false
      learn(); emit(); remoteListeners.forEach(l => l(meta.value)); emitSynced()
      return
    }
    opts.beforeRead?.()
    let others = false
    // Preparation may produce receipts. Keep them speculative until the write succeeds.
    let candidate = meta
    // Another tab's save this tab hasn't heard of yet: merged in first.
    const raw = opts.mergeTabs && opts.merge ? (opts.serialize || key === 'notes' ? accountStorage.getStrict(storageKey(key)) : accountStorage.get(storageKey(key))) : null
    // A real edit may be the first ordinary Notes write after staging. Include a cache update
    // this tab has not heard yet, just as mergeTabs includes a pending ordinary storage event.
    const noteCache = raw === null && key === 'notes' && opts.mergeTabs && opts.merge ? readNoteCache() : null
    if (raw !== null || noteCache)
      try {
        const stored = noteCache ?? JSON.parse(raw!) as Meta<unknown>
        if (key === 'notes' && !Array.isArray(stored?.value)) throw new NoteCacheReadError('Widget notes unreadable')
        const theirs = normalize(stored.value)
        const merged = opts.merge!(candidate.value, theirs)
        others = JSON.stringify(merged) !== JSON.stringify(candidate.value)
        const base = Math.max(candidate.base, stored.base ?? 0)
        // Unsaved only for what is unsaved here, or what the stored copy brought that wasn't saved
        // yet. Not for the stored copy's flag alone: that is often this tab's own earlier write
        // (or another tab's copy of it), and taking it in again after every save kept both tabs
        // saving the same value to the server forever.
        candidate = { value: others ? merged : candidate.value, base, dirty: candidate.dirty || (!!stored.dirty && others) || (base > candidate.base && JSON.stringify(merged) !== JSON.stringify(theirs)) }
      } catch (error) {
        if (opts.preserveOnMergeError || key === 'notes') throw error
        /* not readable: written over */
      }
    if (opts.prepare) {
      const value = opts.prepare(candidate.value)
      if (JSON.stringify(value) !== JSON.stringify(candidate.value)) { candidate = { ...candidate, value, dirty: true }; others = true }
    }
    const durable = candidate
    const saved = accountStorage.set(storageKey(key), JSON.stringify(durable))
    if (opts.serialize && !saved) throw new Error('Widget storage write refused; pending changes retained')
    meta = candidate
    if (saved) opts.afterPersist?.(durable.value)
    if (opts.prepare && meta.dirty) schedulePush(key)
    // Another tab's changes came along: show them, as when they arrive by themselves.
    if (others) {
      emit()
      remoteListeners.forEach((l) => l(meta.value))
    }
  }

  let saveQueued: object | undefined
  let retrySave = false
  const save = () => {
    if (!opts.serialize && !(key === 'notes' && stageOnly)) return saveNow()
    if (saveQueued) return
    const ticket = {}
    saveQueued = ticket
    serialized(() => { saveQueued = undefined; saveNow(); retrySave = false })
    void persistence.catch(() => { retrySave = true }).finally(() => {
      if (saveQueued === ticket) saveQueued = undefined
    })
  }
  const flush = async () => {
    // One bounded retry per caller. Permanent storage denial surfaces as an error, while a
    // transient denial can recover without requiring another user edit.
    if (retrySave && !saveQueued) save()
    for (;;) { const prior = persistence; await prior; if (prior === persistence) return }
  }

  const store: Synced<T> = {
    key,
    ...(opts.serialize || key === 'notes' ? { flush, persist: async () => { save(); await flush() } } : {}),
    get: () => meta.value,
    set(next) {
      if (noteReadError && !noteMemoryFallback) throw new Error('Widget note storage unavailable; reload to retry')
      const value = typeof next === 'function' ? (next as (v: T) => T)(meta.value) : next
      // Nothing changed (the same value made again): nothing to save or send.
      if (value === meta.value || JSON.stringify(value) === JSON.stringify(meta.value)) return
      const before = meta, wasStageOnly = stageOnly
      meta = { ...meta, value, dirty: true }
      stageOnly = false
      try { save() } catch (error) { meta = before; stageOnly = wasStageOnly; throw error }
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
    ...(key === 'notes' ? { verify: () => { if (noteReadError) throw new Error('Widget note storage unavailable; reload to retry') } } : {}),
    meta: () => meta,
    adopt(r, dirty = false, notify = true) {
      const before = meta, previousKnown = known
      meta = { value: normalize(r.value), base: r.updatedAt, dirty }
      if (!dirty) known = { base: r.updatedAt, json: JSON.stringify(meta.value) }
      try { save() } catch (error) { meta = before; known = previousKnown; throw error }
      emit()
      if (notify) remoteListeners.forEach((l) => l(meta.value))
      emitSynced()
    },
    pushed(updatedAt, sent) {
      const before = meta, previousKnown = known
      known = { base: updatedAt, json: JSON.stringify(sent) }
      // Still dirty if it changed while the request was out.
      meta = { ...meta, base: updatedAt, dirty: meta.value !== sent && JSON.stringify(meta.value) !== known.json }
      try { save() } catch (error) { meta = before; known = previousKnown; throw error }
      emitSynced()
      if (meta.dirty) schedulePush(key)
    },
    sameAsServer: () => !!known && known.base === meta.base && known.json === JSON.stringify(meta.value),
    clean() {
      const before = meta
      meta = { ...meta, dirty: false }
      try { save() } catch (error) { meta = before; throw error }
      emitSynced()
    },
    reset() {
      known = null
      meta = { value: fallback, base: 0, dirty: false }
      if (opts.serialize) serialized(() => accountStorage.remove(storageKey(key)))
      else accountStorage.remove(storageKey(key))
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
      if ((e.key !== accountKey(storageKey(key)) && !(key === 'notes' && e.key === accountKey(WIDGET_NOTE_CACHE_KEY))) || frozen()) return
      const receive = () => {
        const before = meta.value
        let incomingStage = false
        const incoming = readMeta(key, fallback, undefined, opts.normalize, !!opts.serialize, () => { incomingStage = true }, noteFailure)
        if (noteReadError) return
        // A storage notification must not discard this tab's unpersisted optimistic edits.
        if (key === 'notes' && stageOnly && incomingStage) {
          // A cache event can arrive while this tab's newer remote adoption is queued at the
          // gate. Preserve that candidate; replacing it here would lose an acknowledged pull.
          meta = mergeNoteCache(meta, incoming, normalize, opts.merge)
        } else if (opts.serialize && meta.dirty && opts.merge) {
          const value = opts.merge(meta.value, incoming.value)
          meta = { value, base: Math.max(meta.base, incoming.base), dirty: JSON.stringify(value) !== JSON.stringify(incoming.value) || incoming.dirty }
        } else meta = incoming
        stageOnly = incomingStage
        learn()
        if (e.newValue !== null) opts.onIncoming?.(meta.value)
        emit()
        if (JSON.stringify(meta.value) !== JSON.stringify(before)) remoteListeners.forEach(l => l(meta.value))
        emitSynced()
      }
      if (opts.serialize) serialized(receive)
      else receive()
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
  // A different store's network activity cannot make an unreadable note cache look healthy.
  // Such a store remains read-only until reload; keep the failure visible for that lifetime.
  if (s.state === 'syncing' || s.state === 'synced') for (const store of stores.values()) {
    try { store.verify?.() } catch (error) {
      s = { state: 'error', at: status.at, error: error instanceof Error ? error.message : 'State storage unavailable' }
      break
    }
  }
  status = s
  statusListeners.forEach((l) => l())
}
/** A local canonical-state failure is still a sync failure; keep the durable copy for retry. */
export const reportSyncFailure = (error: unknown) => setStatus({ state: 'error', at: status.at, error: error instanceof Error ? error.message : 'State synchronization failed' })
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
  if (s.flush) {
    try { await s.flush() } catch (error) {
      paceOf(key).errors = Math.min(paceOf(key).errors + 1, 16)
      reportSyncFailure(error)
      return schedulePush(key, 1000)
    }
  }
  // Another timer may have reached this await while persistence was blocked in another tab.
  // Recheck ownership after the await so only one request can claim this store.
  if (frozen() || !accountGuard() || inFlight.has(key)) return
  const { value, base } = s.meta()
  const pace = paceOf(key)
  counted(key)
  inFlight.add(key)
  setStatus({ state: 'syncing', at: status.at })
  try {
    const r = await api<Remote & { conflict?: boolean }>(`/api/state/${encodeURIComponent(key)}`, { method: 'PUT', json: { value, base } })
    // The browser was signed in as someone else while the request was out: not this tab's answer.
    if (frozen() || !accountGuard()) return
    pace.errors = 0
    if (r.conflict) reconcile(s, r)
    else s.pushed(r.updatedAt, value)
    if (s.flush) await s.flush()
    setStatus({ state: 'synced', at: Date.now() })
  } catch (e) {
    pace.errors = Math.min(pace.errors + 1, 16)
    setStatus({ state: 'error', at: status.at, error: (e as Error).message })
  } finally {
    inFlight.delete(key)
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
    .then(async (remote) => {
      if (frozen() || !accountGuard()) return
      for (const s of stores.values()) { s.verify?.(); reconcile(s, remote[s.key]) }
      await Promise.all([...stores.values()].flatMap(s => s.flush ? [s.flush()] : []))
      if (frozen() || !accountGuard()) return
      hydration = remote
      hydrationListeners.forEach((l) => l(remote))
      await Promise.all([...stores.values()].flatMap(s => s.flush ? [s.flush()] : []))
      if (frozen() || !accountGuard()) return
      if (status.state !== 'error') setStatus({ state: 'synced', at: Date.now() })
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
      hydration = null
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
      const send = () => {
        if (frozen() || !accountGuard()) return
        const { value, base } = s.meta()
        fetch(`/api/state/${encodeURIComponent(key)}`, { method: 'PUT', keepalive: true, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-MvL-Account': TAB_ACCOUNT }, body: JSON.stringify({ value, base }) }).catch(() => {})
      }
      if (s.flush) void s.flush().then(send, reportSyncFailure)
      else send()
    }
  })
  // Back from the back/forward cache: the page runs on, so what it hadn't saved is saved now
  // (the last saves sent on leaving may not have made it).
  window.addEventListener('pageshow', (e) => {
    if (!(e as PageTransitionEvent).persisted) return
    for (const key of pending) if (!timers.has(key) && stores.get(key)?.meta().dirty) schedulePush(key)
  })
}
