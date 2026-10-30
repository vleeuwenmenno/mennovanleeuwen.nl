import { changedNotes, mergeNotes, normalizeNotes, type Note } from '../data/noteModel'
import { storageTransaction } from './storageTransaction'

export const NOTE_STATE_KEY = 'mvlos.notes:state:v1'
export const NOTE_PENDING_PREFIX = 'mvlos.notes:pending:v1:'
/** Startup authority can become ready without a reload. A failed data read cannot. */
export class NoteStartupPending extends Error {}
export type NoteMeta = { value: Note[]; base: number; dirty: boolean }
type Remote = { value: unknown; updatedAt: number }
type State = NoteMeta & {
  schema: 1
  generation: string | null
  server: Note[]
  edits: Note[]
  consumed: string[]
}
type Operation = { generation: string | null; changes: Note[] }
const json = JSON.stringify
const keyIn = (space: string, key: string) => space + key.slice('mvlos.'.length)
const canonical = (value: unknown) => { const notes = normalizeNotes(value); return mergeNotes(notes, notes) }
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
  return { ...state, server, edits: unsaved, value: mergeNotes(server, unsaved), dirty: unsaved.length > 0 }
}
function initial(meta: NoteMeta, generation: string | null): State {
  return project({ ...meta, schema: 1, generation, server: meta.dirty ? [] : meta.value, edits: meta.dirty ? meta.value : [], consumed: [] })
}
function checkpoint(space: string, generation: string | null): State | null {
  const raw = localStorage.getItem(keyIn(space, NOTE_STATE_KEY))
  if (raw === null) return null
  const s = JSON.parse(raw)
  if (!s || s.schema !== 1 || !validGeneration(s.generation) || !validBase(s.base) || !Array.isArray(s.server) || !Array.isArray(s.edits) || !Array.isArray(s.value) || typeof s.dirty !== 'boolean' || !Array.isArray(s.consumed) || s.consumed.some((id: unknown) => typeof id !== 'string')) throw new Error('Note checkpoint is unreadable; originals retained')
  // A logout may have advanced the generation but failed to delete some physical records.
  // They are retained, but cannot become this generation's state.
  if (s.generation !== generation) return null
  const state = project(s)
  if (json(canonical(s.value)) !== json(state.value)) throw new Error('Note checkpoint projection is inconsistent; originals retained')
  return state
}
function operations(space: string, generation: string | null): [string, Operation][] {
  const prefix = keyIn(space, NOTE_PENDING_PREFIX) + encodeURIComponent(generation ?? 'initial') + ':'
  const result: [string, Operation][] = []
  for (const key of Object.keys(localStorage).filter(k => k.startsWith(prefix)).sort()) {
    const raw = localStorage.getItem(key)
    if (raw === null) throw new Error('Note journal unavailable; originals retained')
    const op = JSON.parse(raw)
    if (!op || op.generation !== generation || !Array.isArray(op.changes)) throw new Error('Note journal unreadable; originals retained')
    result.push([key, { generation, changes: canonical(op.changes) }])
    // Admission's count limit is deliberately not a read limit: concurrent tabs can each
    // observe the last free slot. Every already-admitted record must remain replayable.
  }
  return result
}
function load(space: string, generation: string | null, fallback: () => NoteMeta) {
  let state = checkpoint(space, generation) ?? initial(fallback(), generation)
  const pending = operations(space, generation)
  for (const [key, op] of pending) if (!state.consumed.includes(key)) state = { ...state, edits: mergeNotes(state.edits, op.changes) }
  return { state: project(state), pending }
}
/** Visitor transfer includes admitted edits even if its last tab closed before checkpointing. */
export function readNoteProjection(space: string, generation: string | null, fallback: () => NoteMeta): NoteMeta {
  return load(space, generation, fallback).state
}
export const hasNoteProjection = (space: string, generation: string | null) => !!checkpoint(space, generation) || operations(space, generation).length > 0

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
    const raw = json(state)
    if (new TextEncoder().encode(raw).length > 2 * 1024 * 1024) throw new Error('Note checkpoint limit reached; edits retained')
    authority()
    if (localStorage.getItem(keyIn(space, NOTE_STATE_KEY)) !== raw) localStorage.setItem(keyIn(space, NOTE_STATE_KEY), raw)
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
      const fresh = load(space, generation, fallback).state
      const before = typeof next === 'function' ? fresh.value : view.value
      const after = typeof next === 'function' ? next(fresh.value) : next
      const changes = changedNotes(before, after)
      if (!changes.length) { publish(fresh); return }
      const pending = operations(space, generation)
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
