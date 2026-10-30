import { useSyncExternalStore } from 'react'
import { getAccount, subscribeAccount } from '../../os/account'
import { accountGuard, accountKey, accountStorage, TAB_UID } from '../../os/accountSpace'
import { getSyncedHydration, onSyncedHydration, reportSyncFailure, synced, type Synced, type SyncedHydration } from '../../os/synced'
import { changeSet, importPlaces, mergeSets, type WidgetPlace, type WidgetSet } from './placementSet'
import {
  applyPending, appendPending, configDelta, configsOf, emptyDelta, emptyPending, importLegacy, mergeInstallationRecords, mergePending,
  mergeWidgetStates, normalizeConfigs, normalizePending, normalizeWidgetState, unconsumed,
  stableJSON, withConfigs, type Configs, type InstallationRecords, type WidgetDelta, type WidgetState,
} from './canonicalModel'

export const WIDGET_STATE_KEY = 'widgets:state:v2'
const PENDING_KEY = 'mvlos.widgets.pending:v2'
const LEGACY_KEYS = ['widgets', 'widgets:placed', 'widgets:packages:v1', 'windows:desktop', 'windows:mobile'] as const
type LegacyMeta = { value: unknown; base: number; dirty: boolean }
function readJSON(key: string): unknown {
  try { return JSON.parse(accountStorage.get(key) ?? 'null') } catch { return null }
}
const localLegacy = Object.fromEntries(LEGACY_KEYS.map(key => [key, readJSON(`mvlos.sync.${key}`) as LegacyMeta | null]))
// Each writer owns a separate key. A consumer cannot erase a concurrently appended journal.
const writer = crypto.randomUUID()
const ownJournalKey = `${PENDING_KEY}:${writer}`
let serial = 0
function readJournals() {
  let found = normalizePending(readJSON(PENDING_KEY))
  for (const key of accountStorage.keys(`${PENDING_KEY}:`)) found = mergePending(found, normalizePending(readJSON(key)))
  return found
}
let pending = readJournals()
let journalTimer: ReturnType<typeof setTimeout> | undefined
const state = synced<WidgetState | null>(WIDGET_STATE_KEY, null, { normalize: normalizeWidgetState, merge: mergeWidgetStates, mergeTabs: true, preserveOnMergeError: true })

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
  const local = (key: string) => localLegacy[key]?.value
  const remote = (key: string) => snapshot[key]?.value
  const localConfigs = normalizeConfigs(local('widgets'))
  const remoteConfigs = normalizeConfigs(remote('widgets'))
  const configs = snapshot.widgets ? localLegacy.widgets?.dirty ? { ...remoteConfigs, ...localConfigs } : remoteConfigs : localConfigs
  const localState = importLegacy(null, local('widgets:placed'), local('widgets:packages:v1'))
  const remoteState = importLegacy(null, remote('widgets:placed'), remote('widgets:packages:v1'))
  let result = {
    ...importLegacy(configs, null, null),
    placements: mergeSets(localState.placements, remoteState.placements),
    installations: mergeInstallationRecords(localState.installations, remoteState.installations),
  }
  for (const screen of ['desktop', 'mobile']) {
    const key = `windows:${screen}`
    for (const raw of [local(key), remote(key)]) result = { ...result, placements: importPlaces(result.placements, Object.values(layoutPlaces(raw, screen === 'mobile').places)) }
  }
  return result
}

let ready = !!state.get()
function initialView() {
  const current = state.get()
  if (current) return current
  try { return applyPending(legacyState(), pending, false) }
  catch (error) { reportSyncFailure(error); return legacyState() }
}
let view = initialView()
const listeners = new Set<() => void>()
const remoteListeners = new Set<(remote: boolean) => void>()
const syncedListeners = new Set<() => void>()
let configs = configsOf(view)
let placements = view.placements
let installations = view.installations
function refresh(next: WidgetState, remote = false) {
  const configNext = configsOf(next)
  if (stableJSON(configNext) !== stableJSON(configs)) configs = configNext
  if (stableJSON(next.placements) !== stableJSON(placements)) placements = next.placements
  if (stableJSON(next.installations) !== stableJSON(installations)) installations = next.installations
  view = next
  listeners.forEach(l => l())
  remoteListeners.forEach(l => l(remote))
}
const latestState = () => mergeWidgetStates(state.get(), normalizeWidgetState((readJSON(`mvlos.sync.${WIDGET_STATE_KEY}`) as LegacyMeta | null)?.value))
function queue(delta: WidgetDelta) {
  pending = unconsumed(mergePending(pending, readJournals()), latestState())
  pending = appendPending(pending, writer, serial + 1, delta)
  serial++
  const own = { operations: Object.fromEntries(Object.entries(pending.operations).filter(([, op]) => op.writer === writer)) }
  accountStorage.set(ownJournalKey, JSON.stringify(own))
}
function finishJournal() {
  pending = unconsumed(mergePending(pending, readJournals()), latestState())
  // A successful in-memory set is not a durable receipt when storage is full/denied.
  // Only this writer can append here, and ready writers never append again.
  const durable = normalizeWidgetState((readJSON(`mvlos.sync.${WIDGET_STATE_KEY}`) as LegacyMeta | null)?.value)
  const own = normalizePending(readJSON(ownJournalKey))
  if (durable && !Object.keys(unconsumed(own, durable).operations).length && accountStorage.get(ownJournalKey) !== null) accountStorage.remove(ownJournalKey)
}
function pendingView() {
  const current = latestState()
  pending = unconsumed(mergePending(pending, readJournals()), current)
  return applyPending(current ?? legacyState(), pending, !!current)
}
const emptyJournal = () => stableJSON(pending) === stableJSON(emptyPending())

/** Absence before this gate means unknown, not removed. No empty canonical envelope is written
 * while /api/me is loading, or for an offline account whose /api/state has not succeeded. */
function hydrate(snapshot: SyncedHydration = {}) {
  if (!accountGuard()) return
  const account = getAccount()
  if (account.status !== 'user' && account.status !== 'anon' && !(account.status==='off'&&account.resolved)) return
  if (account.status === 'user' && !getSyncedHydration()) return
  if (account.status !== 'user' && TAB_UID !== null) return
  // Unsupported/corrupt envelopes are not evidence that instances were removed. Keep the local
  // projection and queued edits rather than overwriting that account key with a migration.
  if (snapshot[WIDGET_STATE_KEY] && !normalizeWidgetState(snapshot[WIDGET_STATE_KEY].value)) return
  const current = latestState()
  pending = unconsumed(mergePending(pending, readJournals()), current)
  const next = applyPending(current ?? legacyState(snapshot), pending, !!current)
  // save() merges other tabs' envelopes before writing, so simultaneous first cutovers converge.
  state.set(next)
  ready = true
  finishJournal()
  refresh(state.get()!, true)
  syncedListeners.forEach(l => l())
  if (!emptyJournal()) scheduleDrain()
}

function scheduleDrain() {
  if (!ready || journalTimer !== undefined || !accountGuard()) return
  journalTimer = setTimeout(() => { journalTimer = undefined; hydrateSafely(getSyncedHydration() ?? {}) }, 0)
}

/** True only once a complete canonical envelope was loaded or committed. Legacy layout imports
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
      const current = latestState()
      if (!ready) refresh(pendingView())
      else if (current && stableJSON(current) !== stableJSON(view)) refresh(current)
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
    everSynced: state.everSynced,
    onSynced(l) {
      syncedListeners.add(l)
      if (ready) l()
      return () => { syncedListeners.delete(l) }
    },
  }
  return store
}
function commit(next: WidgetState) {
  state.set(next)
  refresh(state.get()!)
}

export const canonicalConfigs = facade<Configs>(() => configs, next => {
  if (ready) commit(withConfigs(view, normalizeConfigs(next)))
  else {
    queue(configDelta(configs, normalizeConfigs(next)))
    refresh(pendingView())
  }
})
export const canonicalPlacements = facade<WidgetSet>(() => placements, next => {
  if (ready) commit({ ...view, placements: mergeSets(next, view.placements) })
  else {
    const put = Object.fromEntries(Object.entries(next.places).filter(([key, p]) => stableJSON(p) !== stableJSON(placements.places[key])))
    const beforeRemoved = new Set(placements.removed.split(' '))
    const remove = next.removed.split(' ').filter(key => key && !beforeRemoved.has(key))
    const added = Object.entries(put).filter(([key, p]) => p.at > 0 && !Object.hasOwn(placements.places, key)).map(([key]) => key)
    queue({ ...emptyDelta(), placements: changeSet({ places: {}, removed: '' }, put, remove), added })
    refresh(pendingView())
  }
})
/** Parent installation layer supplies its package normalization/typing over this generic facade.
 * Recovering a revision only updates this projection; configs and placements are never rolled back. */
export const canonicalInstallations = facade<InstallationRecords>(() => installations, next => {
  if (ready) commit({ ...view, installations: mergeInstallationRecords(next, view.installations) })
  else {
    const edits = Object.fromEntries(Object.entries(next).filter(([id, value]) => stableJSON(value) !== stableJSON(installations[id])))
    queue({ ...emptyDelta(), installations: edits })
    refresh(pendingView())
  }
})

state.onRemote(next => {
  if (next && ready) refresh(next, true)
})
state.onSynced(() => { if (ready) syncedListeners.forEach(l => l()) })
function hydrateSafely(snapshot: SyncedHydration = {}) {
  try { hydrate(snapshot) } catch (error) { reportSyncFailure(error) }
}
onSyncedHydration(hydrateSafely)
subscribeAccount(() => {
  const account = getAccount()
  if (account.status === 'anon' || account.status==='off'&&account.resolved) hydrateSafely()
})
// Modules may load after /api/me and /api/state, or after a guest was established.
if (ready && !emptyJournal()) {
  try { commit(applyPending(latestState()!, pending, true)); finishJournal(); if (!emptyJournal()) scheduleDrain() } catch (error) { reportSyncFailure(error) }
}
if (!ready) hydrateSafely(getSyncedHydration() ?? {})

// A ready tab can consume a still-loading tab's unique operations, without owning its journal.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', event => {
    if (event.key?.startsWith(accountKey(`${PENDING_KEY}:`))) scheduleDrain()
  })
}
