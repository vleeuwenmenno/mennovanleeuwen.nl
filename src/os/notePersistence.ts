import { changedNotes, mergeNotes, normalizeNotes, type Note } from '../data/noteModel'
import { storageTransaction } from './storageTransaction'

export const NOTE_STATE_KEY = 'mvlos.notes:state:v1'
export const NOTE_PENDING_PREFIX = 'mvlos.notes:pending:v1:'
export const NOTE_INPUTS_FENCE_KEY = 'mvlos.notes:inputs-consumed:v1'
/** Startup authority can become ready without a reload. A failed data read cannot. */
export class NoteStartupPending extends Error {}
class NoteSnapshotBusy extends NoteStartupPending {}
export type NoteMeta = { value: Note[]; base: number; dirty: boolean }
type Remote = { value: unknown; updatedAt: number }
type State = NoteMeta & {
  schema: 1
  generation: string | null
  revision?: string
  server: Note[]
  edits: Note[]
  /** Input notes whose initial migration has not been acknowledged yet. */
  migration: string[]
  consumed: string[]
}
type Operation = { generation: string | null; changes: Note[] }
const json = JSON.stringify
const keyIn = (space: string, key: string) => space + key.slice('mvlos.'.length)
// Persistence validity cannot change as the clock advances. In particular, an unacknowledged
// purge must continue to dominate its old live server row however long the browser is offline.
const canonical = (value: unknown) => { const notes = normalizeNotes(value, false); return mergeNotes(notes, notes) }
const validBase = (base: unknown): base is number => typeof base === 'number' && Number.isFinite(base) && base >= 0
const validGeneration = (value: unknown): value is string | null => value === null || typeof value === 'string'

export function parseNoteMeta(raw: string): NoteMeta {
  const m = JSON.parse(raw)
  if (!m || !Array.isArray(m.value) || (m.base !== undefined && !validBase(m.base)) || (m.dirty !== undefined && typeof m.dirty !== 'boolean')) throw new Error('Note storage is unreadable; originals retained')
  return { value: canonical(m.value), base: m.base ?? 0, dirty: !!m.dirty }
}
function project(state: State): State {
  const server = canonical(state.server), edits = canonical(state.edits)
  // A server acknowledgement dominates only changes it actually contains. Missing notes do
  // not erase legitimate offline edits. Unedited old rows never enter this set in the first place.
  const byId = new Map(server.map(n => [n.id, n]))
  const unsaved = edits.filter(n => {
    const saved = byId.get(n.id)
    return !saved || json(mergeNotes([n], [saved])) !== json([saved])
  })
  const pendingIds = new Set(unsaved.map(note => note.id))
  const migration = state.migration.filter(id => pendingIds.has(id))
  return { ...state, server, edits: unsaved, migration, value: mergeNotes(server, unsaved), dirty: unsaved.length > 0 }
}
function initial(meta: NoteMeta, generation: string | null): State {
  return project({ ...meta, schema: 1, generation, server: meta.dirty ? [] : meta.value, edits: meta.dirty ? meta.value : [], migration: meta.dirty ? meta.value.map(note => note.id) : [], consumed: [] })
}
function checkpoint(raw: string | null): State | null {
  if (raw === null) return null
  const s = JSON.parse(raw)
  if (!s || s.schema !== 1 || !validGeneration(s.generation) || (s.revision !== undefined && typeof s.revision !== 'string') || !validBase(s.base) || !Array.isArray(s.server) || !Array.isArray(s.edits) || !Array.isArray(s.value) || typeof s.dirty !== 'boolean' || !Array.isArray(s.consumed) || s.consumed.some((id: unknown) => typeof id !== 'string')) throw new Error('Note checkpoint is unreadable; originals retained')
  if (s.migration !== undefined && (!Array.isArray(s.migration) || s.migration.some((id: unknown) => typeof id !== 'string'))) throw new Error('Note migration continuation is unreadable; originals retained')
  // Checkpoints written before this field cannot distinguish imports from other pending edits.
  // Conservatively preserve their unsaved revisions across the one-time protocol upgrade.
  const state = project({ ...s, migration: s.migration ?? canonical(s.edits).map(note => note.id) })
  if (json(canonical(s.value)) !== json(state.value)) throw new Error('Note checkpoint projection is inconsistent; originals retained')
  return state
}
function operationKeys(space: string, generation: string | null): string[] {
  const prefix = keyIn(space, NOTE_PENDING_PREFIX) + encodeURIComponent(generation ?? 'initial') + ':'
  return Object.keys(localStorage).filter(k => k.startsWith(prefix)).sort()
}
function inputFence(raw: string | null, space: string): { pending: Note[] } | null {
  if (raw === null) return null
  const fence = JSON.parse(raw)
  if (!fence || fence.schema !== 1 || fence.space !== space || !validGeneration(fence.generation) || !validGeneration(fence.checkpoint) || !Array.isArray(fence.pending)) throw new Error('Note input fence is unreadable; originals retained')
  return { pending: canonical(fence.pending) }
}
const migrationPending = (state: State) => {
  const ids = new Set(state.migration)
  return state.edits.filter(note => ids.has(note.id))
}
/** Called only under the shared gate, after a checkpoint was written and verified. Logout
 * repairs this fence before deleting that checkpoint. Neither source keys nor stages change. */
export function sealNoteInputs(space: string) {
  const key = keyIn(space, NOTE_INPUTS_FENCE_KEY)
  const previous = localStorage.getItem(key)
  inputFence(previous, space) // Never overwrite an unreadable ownership/continuation record.
  const state = checkpoint(localStorage.getItem(keyIn(space, NOTE_STATE_KEY)))
  if (!state) return // No durable consumption yet: a failed transfer must remain retryable.
  const raw = json({ schema: 1, space, generation: state.generation, checkpoint: state.revision ?? null, pending: migrationPending(state) })
  if (raw !== previous) localStorage.setItem(key, raw)
  if (localStorage.getItem(key) !== raw) throw new Error('Note input fence was not verified; checkpoint retained')
}
function load(space: string, generation: string | null, fallback: () => NoteMeta | null) {
  const stateKey = keyIn(space, NOTE_STATE_KEY), fenceKey = keyIn(space, NOTE_INPUTS_FENCE_KEY)
  const currentGeneration = () => localStorage.getItem(keyIn(space, 'mvlos.revocation:v1')) === generation
  for (let attempt = 0; attempt < 8; attempt++) {
    if (!currentGeneration()) throw new NoteStartupPending('Note snapshot account authority changed')
    const raw = localStorage.getItem(stateKey), fenceRaw = localStorage.getItem(fenceKey)
    const saved = checkpoint(raw), fence = inputFence(fenceRaw, space)
    // Even a revoked checkpoint proves that legacy inputs already crossed cutover. If logout
    // could not write the fence, it leaves this proof and unacknowledged migration revisions
    // in place. Other old-generation note values and journal records cannot replay.
    const useFallback = !saved && !fence
    const input = useFallback ? fallback() : null
    const keys = operationKeys(space, generation)
    const records = keys.map(key => [key, localStorage.getItem(key)] as const)
    const inputAgain = useFallback ? fallback() : null
    const keysAgain = operationKeys(space, generation)
    const fenceAgain = localStorage.getItem(fenceKey), rawAgain = localStorage.getItem(stateKey)
    if (!currentGeneration()) throw new NoteStartupPending('Note snapshot account authority changed')
    // The checkpoint revision prevents ABA. Immutable records cannot be replaced, and the two
    // key enumerations detect admissions. No callback or mutation sees a torn collection.
    if (raw !== rawAgain || fenceRaw !== fenceAgain || json(input) !== json(inputAgain)) continue
    const removed = keys.filter(key => !keysAgain.includes(key))
    if (removed.some(key => !saved?.consumed.includes(key))) throw new Error('Uncommitted note journal disappeared; originals retained')
    if (json(keys) !== json(keysAgain)) continue
    const pending: [string, Operation][] = records.map(([key, record]) => {
      if (record === null) throw new Error('Note journal unavailable; originals retained')
      const op = JSON.parse(record)
      if (!op || op.generation !== generation || !Array.isArray(op.changes)) throw new Error('Note journal unreadable; originals retained')
      return [key, { generation, changes: canonical(op.changes) }]
    })
    const continuation = saved ? migrationPending(saved) : fence?.pending
    let state = saved?.generation === generation ? saved : initial(continuation ? { value: continuation, base: 0, dirty: continuation.length > 0 } : input ?? { value: [], base: 0, dirty: false }, generation)
    for (const [key, op] of pending) if (!state.consumed.includes(key)) state = { ...state, edits: mergeNotes(state.edits, op.changes) }
    return { state: project(state), pending, present: !!saved || !!fence || input !== null || pending.length > 0 }
  }
  // Contention is recoverable on the next storage event or explicit retry, not corrupt data.
  throw new NoteSnapshotBusy('Note snapshot kept changing; retry after concurrent writes settle')
}
/** Visitor transfer includes admitted edits even if its last tab closed before checkpointing. */
export function readNoteProjection(space: string, generation: string | null, fallback: () => NoteMeta | null): NoteMeta | null {
  const snapshot = load(space, generation, fallback)
  return snapshot.present ? snapshot.state : null
}

/** One protocol for edits, hydration, acknowledgements, storage events and reloads.
 * Journal writes are immutable admission records. Checkpoints and their receipts are serialized;
 * no note value is copied to an ordinary key, and a stale full snapshot is never an edit. */
export function noteReplica(space: string, generation: string | null, guard: () => boolean, fallback: () => NoteMeta, changed: () => void, failed: (error: unknown) => void) {
  let view: NoteMeta = { value: [], base: 0, dirty: false }, unreadable: unknown
  let work = Promise.resolve(), retry = false, scheduled = false
  const remotes: Remote[] = []
  const authority = () => { if (!guard()) throw new NoteStartupPending('Note persistence waiting for account authority') }
  const publish = (meta: NoteMeta) => {
    const value = json(meta.value) === json(view.value) ? view.value : meta.value
    const different = value !== view.value || meta.base !== view.base || meta.dirty !== view.dirty
    view = { value, base: meta.base, dirty: meta.dirty }
    if (different) changed()
  }
  try { authority(); view = load(space, generation, fallback).state } catch (error) { unreadable = error }
  const verify = () => {
    if (unreadable instanceof NoteStartupPending) {
      try {
        authority()
        const state = load(space, generation, fallback).state
        unreadable = undefined
        publish(state)
      } catch (error) { unreadable = error }
    }
    if (unreadable instanceof NoteStartupPending) throw unreadable
    if (unreadable) throw new Error('Note storage unavailable; reload to retry', { cause: unreadable })
  }
  const commit = () => {
    authority(); verify()
    let { state, pending } = load(space, generation, fallback)
    // Remote replies are observations of server state, not whole-array local edits. Apply them
    // over the latest durable baseline, then replay only the dirty note revisions.
    const count = remotes.length
    for (const remote of remotes.slice(0, count)) {
      if (!validBase(remote.updatedAt) || !Array.isArray(remote.value)) throw new Error('Remote notes unreadable')
      if (remote.updatedAt < state.base) continue
      const server = remote.updatedAt === state.base ? mergeNotes(state.server, canonical(remote.value)) : canonical(remote.value)
      state = project({ ...state, base: remote.updatedAt, server })
    }
    // Receipt retention is bounded by extant immutable records, not browser/tab lifetime.
    state = { ...state, consumed: pending.map(([key]) => key) }
    let raw = json(state)
    if (localStorage.getItem(keyIn(space, NOTE_STATE_KEY)) !== raw) {
      state = { ...state, revision: crypto.randomUUID() }
      raw = json(state)
    }
    if (new TextEncoder().encode(raw).length > 2 * 1024 * 1024) throw new Error('Note checkpoint limit reached; edits retained')
    authority()
    if (localStorage.getItem(keyIn(space, NOTE_STATE_KEY)) !== raw) localStorage.setItem(keyIn(space, NOTE_STATE_KEY), raw)
    if (localStorage.getItem(keyIn(space, NOTE_STATE_KEY)) !== raw) throw new Error('Note checkpoint was not verified; journals retained')
    sealNoteInputs(space)
    remotes.splice(0, count)
    // No speculative receipt can remove a journal. On a failed deletion, the next load skips
    // the already-committed operation using the receipt and retries cleanup.
    for (const [key] of pending) { authority(); localStorage.removeItem(key) }
    publish(state)
  }
  const save = () => {
    if (scheduled || !guard()) return
    scheduled = true
    const task = work.catch(() => {}).then(() => storageTransaction(() => { scheduled = false; commit() }))
    work = task
    void task.then(() => { retry = false }, error => { scheduled = false; retry = true; failed(error) })
  }
  const flush = async () => {
    verify()
    if (retry || remotes.length) save()
    let startupRetried = false
    for (;;) {
      const previous = work
      try { await previous } catch (error) {
        // A one-shot unavailable migration-state read is not an empty source. Retry the
        // same retained observation once; persistent uncertainty still blocks hydration.
        if (!(error instanceof NoteStartupPending) || startupRetried) throw error
        startupRetried = true
        save()
        continue
      }
      if (previous === work) return
    }
  }
  return {
    get: () => view,
    verify,
    set(next: Note[] | ((notes: Note[]) => Note[])) {
      authority(); verify()
      const { state: fresh, pending } = load(space, generation, fallback)
      const before = typeof next === 'function' ? fresh.value : view.value
      const after = typeof next === 'function' ? next(fresh.value) : next
      const changes = changedNotes(before, after)
      if (!changes.length) { publish(fresh); return }
      if (pending.length >= 256) throw new Error('Note journal limit reached; edit not admitted')
      const key = keyIn(space, NOTE_PENDING_PREFIX) + encodeURIComponent(generation ?? 'initial') + ':' + crypto.randomUUID()
      const raw = json({ generation, changes })
      if (new TextEncoder().encode(raw).length > 1024 * 1024) throw new Error('Note edit limit reached; edit not admitted')
      authority()
      localStorage.setItem(key, raw)
      authority()
      publish(project({ ...fresh, edits: mergeNotes(fresh.edits, changes) }))
      save()
    },
    receive(remote?: Remote) { authority(); verify(); if (remote) remotes.push(remote); save() },
    refresh() { authority(); verify(); publish(load(space, generation, fallback).state); save() },
    flush,
    reset() { remotes.length = 0; publish({ value: [], base: 0, dirty: false }) },
  }
}
