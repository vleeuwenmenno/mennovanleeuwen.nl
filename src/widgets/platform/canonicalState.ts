import { useSyncExternalStore } from 'react'
import { storageTransaction } from '../../os/storageTransaction'
import { getAccount, subscribeAccount } from '../../os/account'
import { accountGuard, accountKey, accountStorage, TAB_UID, widgetLegacyStage, widgetMigrationUnresolved } from '../../os/accountSpace'
import { getSyncedHydration, onSyncedHydration, reportSyncFailure, synced, type Synced, type SyncedHydration } from '../../os/synced'
import { bindPlacementAliases, changeSet, importPlaces, mergeSets, type WidgetPlace, type WidgetSet } from './placementSet'
import {
  applyPending, appendPending, configDelta, configsOf, emptyDelta, emptyPending, emptyWidgetState, importLegacy, mergeInstallationRecords, mergePending,
  mergeWidgetStates, normalizeConfigs, normalizePending, normalizeWidgetState, unconsumed,
  installationToken, placementAliases, stableJSON, type Configs, type InstallationRecords, type WidgetDelta, type WidgetState,
} from './canonicalModel'

export const WIDGET_STATE_KEY = 'widgets:state:v2'
const PENDING_KEY = 'mvlos.widgets.pending:v2'
const LEGACY_KEYS = ['widgets', 'widgets:placed', 'widgets:packages:v1', 'windows:desktop', 'windows:mobile'] as const
type LegacyMeta = { value: unknown; base: number; dirty: boolean }
function readJSON(key: string): unknown {
  const raw = accountStorage.getStrict(key) ?? widgetLegacyStage(key)
  if (raw === null) return null
  try { return JSON.parse(raw) } catch { throw new Error('Widget storage is unreadable; original data retained') }
}
// Each writer owns a separate key. A consumer cannot erase a concurrently appended journal.
const writer = crypto.randomUUID()
const ownJournalKey = `${PENDING_KEY}:${writer}`
let serial = 0
let journalReadFailed = false
function readJournals() {
  try {
    let found = normalizePending(readJSON(PENDING_KEY))
    for (const key of accountStorage.keysStrict(`${PENDING_KEY}:`)) found = mergePending(found, normalizePending(readJSON(key)))
    journalReadFailed = false
    return found
  } catch (error) { journalReadFailed = true; throw error }
}
let pending = emptyPending()
try { pending = readJournals() } catch (error) { reportSyncFailure(error) }
let journalTimer: ReturnType<typeof setTimeout> | undefined
let migrationSnapshot: SyncedHydration | null = null
const state = synced<WidgetState | null>(WIDGET_STATE_KEY, null, {
  normalize: normalizeWidgetState, merge: mergeWidgetStates, mergeTabs: true, preserveOnMergeError: true, serialize: storageTransaction,
  beforeRead: () => {
    if (widgetMigrationUnresolved()) throw new Error('Widget migration incomplete; original data retained')
    const raw = accountStorage.getStrict(`mvlos.sync.${WIDGET_STATE_KEY}`)
    if (raw === null) return
    try { if (normalizeWidgetState(JSON.parse(raw)?.value)) return } catch { /* invalid envelope */ }
    throw new Error('Widget state is unreadable; original data and journals retained')
  },
  prepare: value => {
    // Re-read ordinary account keys inside the canonical gate. A real account value always
    // overrides its staged legacy input; pending operations are then replayed on that baseline.
    const base = migrationSnapshot && !durableState() ? legacyState(migrationSnapshot) : value
    return base ? applyPending(base, mergePending(pending, readJournals()), !!value) : base
  },
  afterPersist: value => { if (value) { migrationSnapshot = null; finishJournal(value) } },
})

/** Old layout coordinates have no viewport metadata. Keep every number unchanged and record the
 * screen class from the layout key, so desktop migration still wins a tie with mobile. */
function layoutPlaces(raw: unknown, phone: boolean): WidgetSet {
  if (!Array.isArray(raw)) return { places: {}, removed: '' }
  const places: Record<string, WidgetPlace> = {}
  for (const w of raw) {
    if (!w || typeof w !== 'object') continue
    const kind = w.app === 'widget' ? w.props?.kind : w.app === 'sticky' ? 'sticky' : undefined
    const id = w.props?.id
    if (typeof kind !== 'string' || !kind || typeof id !== 'string' || !/^[^\s]{1,80}$/.test(id)) continue
    const num = (v: unknown, fallback = 0) => typeof v === 'number' && Number.isFinite(v) ? v : fallback
    Object.defineProperty(places, id, { value: { id, kind, x: num(w.x), y: num(w.y), w: num(w.w, 280), h: num(w.h, 260), vw: 0, vh: 0, phone, screenUnknown: true, ...(typeof w.stack === 'number' ? { stack: w.stack } : {}), ...(w.minimized ? { minimized: true } : {}), at: 0 }, enumerable: true })
  }
  return { places, removed: '' }
}
function legacyState(snapshot: SyncedHydration = {}): WidgetState {
  const staged = new Set<string>()
  const localLegacy = Object.fromEntries(LEGACY_KEYS.map(key => {
    const full = `mvlos.sync.${key}`, actual = accountStorage.getStrict(full)
    if (actual !== null) {
      try { return [key, JSON.parse(actual) as LegacyMeta] } catch { throw new Error('Widget storage is unreadable; original data retained') }
    }
    const fallback = widgetLegacyStage(full)
    if (fallback !== null) staged.add(key)
    try { return [key, fallback === null ? null : JSON.parse(fallback) as LegacyMeta] } catch { throw new Error('Widget migration snapshot invalid; original data retained') }
  }))
  const local = (key: string) => localLegacy[key]?.value
  const remote = (key: string) => snapshot[key]?.value
  const localConfigs = normalizeConfigs(local('widgets'))
  const remoteConfigs = normalizeConfigs(remote('widgets'))
  const configs = snapshot.widgets ? localLegacy.widgets?.dirty && !staged.has('widgets') ? { ...remoteConfigs, ...localConfigs } : remoteConfigs : localConfigs
  const localState = importLegacy(null, local('widgets:placed'), local('widgets:packages:v1'))
  const remoteState = importLegacy(null, remote('widgets:placed'), remote('widgets:packages:v1'))
  let result = {
    ...importLegacy(configs, null, null),
    placements: snapshot['widgets:placed'] && staged.has('widgets:placed') ? remoteState.placements : mergeSets(localState.placements, remoteState.placements),
    installations: snapshot['widgets:packages:v1'] && staged.has('widgets:packages:v1') ? remoteState.installations : mergeInstallationRecords(localState.installations, remoteState.installations),
  }
  for (const screen of ['desktop', 'mobile']) {
    const key = `windows:${screen}`
    for (const raw of snapshot[key] && staged.has(key) ? [remote(key)] : [local(key), remote(key)]) result = { ...result, placements: importPlaces(result.placements, Object.values(layoutPlaces(raw, screen === 'mobile').places)) }
  }
  return result
}

let ready = !!state.get() && !widgetMigrationUnresolved() && !journalReadFailed
function initialView() {
  const current = state.get()
  if (current) return current
  try { return applyPending(legacyState(), pending, false) }
  catch (error) { reportSyncFailure(error); return emptyWidgetState() }
}
let view = initialView()
const listeners = new Set<() => void>()
const remoteListeners = new Set<(remote: boolean) => void>()
const syncedListeners = new Set<() => void>()
let configs = configsOf(view)
let placements = bindPlacementAliases(view.placements, placementAliases(view, writer))
let installations = view.installations
function refresh(next: WidgetState, remote = false) {
  const configNext = configsOf(next)
  if (stableJSON(configNext) !== stableJSON(configs)) configs = configNext
  if (stableJSON(next.placements) !== stableJSON(placements) || stableJSON(next.remaps) !== stableJSON(view.remaps)) placements = bindPlacementAliases(next.placements, placementAliases(next, writer))
  if (stableJSON(next.installations) !== stableJSON(installations)) installations = next.installations
  view = next
  listeners.forEach(l => l())
  remoteListeners.forEach(l => l(remote))
}
const latestState = () => mergeWidgetStates(state.get(), normalizeWidgetState((readJSON(`mvlos.sync.${WIDGET_STATE_KEY}`) as LegacyMeta | null)?.value))
// Only the stored envelope proves receipts survived a failed write or a navigation.
const durableState = () => normalizeWidgetState((readJSON(`mvlos.sync.${WIDGET_STATE_KEY}`) as LegacyMeta | null)?.value)
function queue(delta: WidgetDelta) {
  pending = unconsumed(mergePending(pending, readJournals()), durableState())
  const next = appendPending(pending, writer, serial + 1, delta)
  const own = { operations: Object.fromEntries(Object.entries(next.operations).filter(([, op]) => op.writer === writer)) }
  if (!accountStorage.set(ownJournalKey, JSON.stringify(own))) throw new Error('Widget journal write refused; change not admitted')
  pending = next
  serial++
}
function finishJournal(committed: WidgetState) {
  pending = unconsumed(mergePending(pending, readJournals()), committed)
  // A successful in-memory set is not a durable receipt when storage is full/denied.
  // Only this writer can append here.
  const durable = committed
  const own = normalizePending(readJSON(ownJournalKey))
  if (durable && !Object.keys(unconsumed(own, durable).operations).length && accountStorage.getStrict(ownJournalKey) !== null) accountStorage.remove(ownJournalKey)
}
function pendingView() {
  const current = latestState()
  pending = unconsumed(mergePending(pending, readJournals()), durableState())
  return applyPending(current ?? legacyState(), pending, !!current)
}
const emptyJournal = () => stableJSON(pending) === stableJSON(emptyPending())

/** Absence before this gate means unknown, not removed. No empty canonical envelope is written
 * while /api/me is loading, or for an offline account whose /api/state has not succeeded. */
function hydrate(snapshot: SyncedHydration = {}) {
  if (!accountGuard()) return
  if (widgetMigrationUnresolved()) throw new Error('Widget migration incomplete; original data retained')
  const account = getAccount()
  if (account.status !== 'user' && account.status !== 'anon' && !(account.status==='off'&&account.resolved)) return
  if (account.status === 'user' && !getSyncedHydration()) return
  if (account.status !== 'user' && TAB_UID !== null) return
  // Unsupported/corrupt envelopes are not evidence that instances were removed. Keep the local
  // projection and queued edits rather than overwriting that account key with a migration.
  if (snapshot[WIDGET_STATE_KEY] && !normalizeWidgetState(snapshot[WIDGET_STATE_KEY].value)) return
  const current = latestState()
  pending = unconsumed(mergePending(pending, readJournals()), durableState())
  const next = current ?? legacyState(snapshot)
  if (!current) migrationSnapshot = snapshot
  // The serialized save merges other tabs' envelopes under the same IDB request scope before
  // writing data + receipts and cleaning this writer's journal.
  state.set(next)
  ready = true
  refresh(pendingView(), true)
  syncedListeners.forEach(l => l())
  if (!emptyJournal()) void state.persist?.().catch(reportSyncFailure)
}

function scheduleDrain() {
  if (!ready || journalTimer !== undefined || !accountGuard()) return
  journalTimer = setTimeout(() => { journalTimer = undefined; hydrateSafely(getSyncedHydration() ?? {}) }, 0)
}

/** True once a complete canonical envelope was loaded or staged for serialized persistence. Legacy layout imports
 * must never be admitted after this marker, including later writes from an old client. */
export const hasWidgetCutover = () => ready || !!state.get()
export const widgetsHydrated = () => ready
/** Installation activation must budget the combined envelope, including config tombstones and
 * placement history, rather than only its package projection. Include sync request overhead. */
export const canonicalInstallationBytes = (next: InstallationRecords) => new TextEncoder().encode(JSON.stringify({ value: { ...view, installations: next }, base: Number.MAX_SAFE_INTEGER })).length

function facade<T>(get: () => T, update: (next: T) => void): Synced<T> {
  const store: Synced<T> = {
    key: WIDGET_STATE_KEY,
    get,
    set(next) {
      if (!accountGuard()) return
      refresh(pendingView())
      const before = get()
      const after = typeof next === 'function' ? (next as (v: T) => T)(before) : next
      if (stableJSON(before) === stableJSON(after)) return
      update(after)
    },
    subscribe(l) { listeners.add(l); return () => { listeners.delete(l) } },
    use: () => useSyncExternalStore(store.subscribe, store.get),
    onRemote(l) {
      let before = get()
      const forward = (remote: boolean) => {
        const after = get()
        if (after === before) return
        before = after
        if (remote) l(after)
      }
      remoteListeners.add(forward)
      return () => { remoteListeners.delete(forward) }
    },
    async flush() {
      if (!ready) {
        if (widgetMigrationUnresolved()) throw new Error('Widget migration incomplete; original data retained')
        return
      }
      await state.persist?.()
      if (!accountGuard()) throw new Error('Account changed')
      const durable = normalizeWidgetState((readJSON(`mvlos.sync.${WIDGET_STATE_KEY}`) as LegacyMeta | null)?.value)
      if (!durable || Object.keys(unconsumed(normalizePending(readJSON(ownJournalKey)), durable).operations).length) throw new Error('Widget changes are not durably committed')
    },
    everSynced: state.everSynced,
    onSynced(l) {
      syncedListeners.add(l)
      if (ready) l()
      return () => { syncedListeners.delete(l) }
    },
  }
  return store
}
function commit() {
  refresh(pendingView())
  if (ready) void state.persist?.().catch(reportSyncFailure)
}

export const canonicalConfigs = facade<Configs>(() => configs, next => {
  queue(configDelta(configs, normalizeConfigs(next)))
  commit()
})
export const canonicalPlacements = facade<WidgetSet>(() => placements, next => {
  {
    const put = Object.fromEntries(Object.entries(next.places).filter(([key, p]) => stableJSON(p) !== stableJSON(placements.places[key])))
    const beforeRemoved = new Set(placements.removed.split(' '))
    const remove = next.removed.split(' ').filter(key => key && !beforeRemoved.has(key))
    const added = Object.entries(put).filter(([key, p]) => p.at > 0 && !Object.hasOwn(placements.places, key)).map(([key]) => key)
    queue({ ...emptyDelta(), placements: changeSet({ places: {}, removed: '' }, put, remove), added })
    commit()
  }
})
/** Parent installation layer supplies its package normalization/typing over this generic facade.
 * Recovering a revision only updates this projection; configs and placements are never rolled back. */
export const canonicalInstallations = facade<InstallationRecords>(() => installations, next => {
  {
    const edits = Object.fromEntries(Object.entries(next).filter(([id, value]) => stableJSON(value) !== stableJSON(installations[id])))
    queue({ ...emptyDelta(), installations: edits, expectedInstallations: Object.fromEntries(Object.keys(edits).map(id => [id, installationToken(installations[id])])) })
    commit()
  }
})

state.onRemote(next => {
  if (next && ready) try { refresh(pendingView(), true) } catch (error) { reportSyncFailure(error) }
})
state.onSynced(() => { if (ready) syncedListeners.forEach(l => l()) })
let hydrationRetry: ReturnType<typeof setTimeout> | undefined
let hydrationRetryDelay = 1000
function hydrateSafely(snapshot: SyncedHydration = {}) {
  try {
    hydrate(snapshot)
    if (hydrationRetry !== undefined) clearTimeout(hydrationRetry)
    hydrationRetry = undefined
    hydrationRetryDelay = 1000
  } catch (error) {
    reportSyncFailure(error)
    if (hydrationRetry === undefined && accountGuard()) {
      const delay = hydrationRetryDelay
      hydrationRetryDelay = Math.min(60_000, delay * 2)
      hydrationRetry = setTimeout(() => { hydrationRetry = undefined; hydrateSafely(getSyncedHydration() ?? snapshot) }, delay)
    }
  }
}
onSyncedHydration(hydrateSafely)
subscribeAccount(() => {
  const account = getAccount()
  if (account.status === 'anon' || account.status==='off'&&account.resolved) hydrateSafely()
})
// Modules may load after /api/me and /api/state, or after a guest was established.
if (ready && !emptyJournal()) {
  try { commit(); if (!emptyJournal()) scheduleDrain() } catch (error) { reportSyncFailure(error) }
}
if (!ready) hydrateSafely(getSyncedHydration() ?? {})

// A ready tab can consume a still-loading tab's unique operations, without owning its journal.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', event => {
    if (event.key?.startsWith(accountKey(`${PENDING_KEY}:`))) scheduleDrain()
  })
}
