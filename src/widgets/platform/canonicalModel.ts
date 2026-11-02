import { EMPTY, mergeSets, normalizeSet, removedKeys, type WidgetSet } from './placementSet'

export type Configs = Record<string, Record<string, unknown>>
export type ConfigRecord = { at: number; value?: Record<string, unknown>; removed?: true }
export type InstallationRecords = Record<string, unknown>
/** The presence of this envelope is the migration marker. Never saved separately from its data. */
export type WidgetState = {
  schema: 2
  configs: Record<string, ConfigRecord>
  placements: WidgetSet
  installations: InstallationRecords
  /** Durable high-water marks for every admitted writer. Never evicted. */
  consumed?: Record<string, number>
  /** Writer-local original placement key -> permanent remapped key. */
  remaps?: Record<string, Record<string, string>>
}
export const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const own = (v: object, key: string) => Object.hasOwn(v, key)
const counter = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
export const emptyWidgetState = (): WidgetState => ({ schema: 2, configs: {}, placements: EMPTY, installations: {} })

/** Config ties compare data, independent of object insertion order on either device. */
export function stableJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJSON).join(',')}]`
  if (record(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableJSON(value[k])}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}
const same = (a: unknown, b: unknown) => stableJSON(a) === stableJSON(b)
export function normalizeConfigs(raw: unknown): Configs {
  return record(raw) ? Object.fromEntries(Object.entries(raw).filter(([, v]) => record(v))) as Configs : {}
}

/** Validation of package contents remains the installation layer's responsibility. Persistence
 * keeps immutable revisions whole and uses exactly its generation/serialized-identity ordering. */
export function normalizeInstallations(raw: unknown): InstallationRecords {
  return record(raw) ? Object.fromEntries(Object.entries(raw)) : {}
}
export function mergeInstallationRecords(local: InstallationRecords, remote: InstallationRecords): InstallationRecords {
  const out = { ...remote }
  for (const [id, value] of Object.entries(local)) {
    const other = out[id]
    const generation = (v: unknown) => record(v) && Number.isSafeInteger(v.generation) && Number(v.generation) > 0 ? Number(v.generation) : 0
    if (!own(out, id) || generation(value) > generation(other) || generation(value) === generation(other) && stableJSON(value) > stableJSON(other)) Object.defineProperty(out, id, { value, enumerable: true, writable: true, configurable: true })
  }
  return out
}
export function normalizeWidgetState(raw: unknown): WidgetState | null {
  if (!record(raw) || raw.schema !== 2 || !record(raw.configs) || !record(raw.placements) || !record(raw.placements.places) || typeof raw.placements.removed !== 'string' || !record(raw.installations)) return null
  const configs = Object.fromEntries(Object.entries(raw.configs).flatMap<[string, ConfigRecord]>(([id, v]) => {
    if (!record(v) || !counter(v.at)) return []
    if (v.removed === true) return [[id, { at: v.at, removed: true }]]
    return record(v.value) ? [[id, { at: v.at, value: v.value }]] : []
  })) as WidgetState['configs']
  const consumed = normalizeConsumed(raw.consumed), remaps = normalizeRemaps(raw.remaps)
  if (!consumed || !remaps) return null
  return { schema: 2, configs, placements: normalizeSet(raw.placements), installations: normalizeInstallations(raw.installations), ...(Object.keys(consumed).length ? { consumed } : {}), ...(Object.keys(remaps).length ? { remaps } : {}) }
}
export function mergeWidgetStates(local: WidgetState | null, remote: WidgetState | null): WidgetState | null {
  if (!local) return remote
  if (!remote) return local
  const configs = { ...remote.configs }
  for (const [id, value] of Object.entries(local.configs)) {
    const other = own(configs, id) ? configs[id] : undefined
    // At the same counter deletion beats a live copy, then a stable data tie-break.
    if (!other || value.at > other.at || value.at === other.at && (Number(!!value.removed) > Number(!!other.removed) || !!value.removed === !!other.removed && stableJSON(value) > stableJSON(other))) Object.defineProperty(configs, id, { value, enumerable: true, writable: true, configurable: true })
  }
  const consumed = mergeConsumed(local.consumed, remote.consumed), remaps = mergeRemaps(local.remaps, remote.remaps)
  return { schema: 2, configs, placements: mergeSets(local.placements, remote.placements), installations: mergeInstallationRecords(local.installations, remote.installations), ...(Object.keys(consumed).length ? { consumed } : {}), ...(Object.keys(remaps).length ? { remaps } : {}) }
}
export const configsOf = (state: WidgetState): Configs => Object.fromEntries(Object.entries(state.configs).flatMap(([id, v]) => v.removed ? [] : [[id, v.value!]]))
export function withConfigs(state: WidgetState, next: Configs, now = Date.now()): WidgetState {
  const before = configsOf(state)
  const configs = { ...state.configs }
  for (const id of new Set([...Object.keys(before), ...Object.keys(next)])) {
    if (own(before, id) === own(next, id) && same(before[id], next[id])) continue
    Object.defineProperty(configs, id, { value: { at: Math.max(now, (state.configs[id]?.at ?? 0) + 1), ...(own(next, id) ? { value: next[id] } : { removed: true }) }, enumerable: true, writable: true, configurable: true })
  }
  return { ...state, configs }
}

/** Legacy records are inputs only while no canonical envelope exists. Import counters start at
 * zero so any canonical edit wins. Geometry, note identity and tombstones use the original set. */
export function importLegacy(configs: unknown, placements: unknown, installations: unknown): WidgetState {
  return { schema: 2, configs: Object.fromEntries(Object.entries(normalizeConfigs(configs)).map(([id, value]) => [id, { at: 0, value }])), placements: normalizeSet(placements), installations: normalizeInstallations(installations) }
}

export const JOURNAL_LIMITS = Object.freeze({ writers: 256, operations: 1024, remaps: 1024 })
const WRITER = /^[a-zA-Z0-9-]{1,80}$/
const frontier = (value: Record<string, number> | undefined, id: string) => value && own(value, id) ? value[id] : 0
const sequence = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0
function normalizeConsumed(value: unknown): Record<string, number> | null {
  if (value === undefined) return {}
  if (!record(value) || Object.keys(value).length > JOURNAL_LIMITS.writers || Object.entries(value).some(([id, n]) => !WRITER.test(id) || !sequence(n))) return null
  return Object.fromEntries(Object.entries(value)) as Record<string, number>
}
function mergeConsumed(a: Record<string, number> = {}, b: Record<string, number> = {}) {
  const out = Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].sort().map(id => [id, Math.max(frontier(a, id), frontier(b, id))]))
  // Never forget a writer to make room: an old tab could then replay its consumed gestures.
  if (Object.keys(out).length > JOURNAL_LIMITS.writers) throw new Error('Widget migration writer limit reached; pending changes retained')
  return out
}
function normalizeRemaps(raw: unknown): NonNullable<WidgetState['remaps']> | null {
  if (raw === undefined) return {}
  if (!record(raw) || Object.keys(raw).length > JOURNAL_LIMITS.writers) return null
  let count = 0
  for (const [writer, keys] of Object.entries(raw)) {
    if (!WRITER.test(writer) || !record(keys)) return null
    for (const [from, to] of Object.entries(keys)) if (++count > JOURNAL_LIMITS.remaps || !/^[^\s]{1,80}$/.test(from) || typeof to !== 'string' || !/^[^\s]{1,80}$/.test(to)) return null
  }
  return Object.fromEntries(Object.entries(raw).map(([writer, keys]) => [writer, { ...keys as Record<string, string> }]))
}
function mergeRemaps(a: WidgetState['remaps'] = {}, b: WidgetState['remaps'] = {}) {
  const out = Object.fromEntries(Object.entries(b).map(([writer, keys]) => [writer, { ...keys }]))
  for (const [writer, keys] of Object.entries(a)) {
    const merged = { ...(own(out, writer) ? out[writer] : {}) }
    for (const [from, to] of Object.entries(keys)) {
      if (own(merged, from) && merged[from] !== to) throw new Error('Conflicting widget placement identity; pending changes retained')
      Object.defineProperty(merged, from, { value: to, enumerable: true, configurable: true, writable: true })
    }
    Object.defineProperty(out, writer, { value: merged, enumerable: true, configurable: true, writable: true })
  }
  if (!normalizeRemaps(out)) throw new Error('Widget placement identity limit reached; pending changes retained')
  return out
}
export type ConfigEdit = { at: number; patch: Record<string, unknown>; unset: string[]; removed?: true }
export type WidgetDelta = { configs: Record<string, ConfigEdit>; placements: WidgetSet; added: string[]; installations: InstallationRecords; expectedInstallations?: Record<string, string> }
export const emptyDelta = (): WidgetDelta => ({ configs: {}, placements: EMPTY, added: [], installations: {} })
export type PendingOperation = { writer: string; sequence: number; at: number; delta: WidgetDelta }
/** Account-scoped durable operation log. A writer retains its complete unconsumed prefix. */
export type PendingWidgets = { operations: Record<string, PendingOperation> }
export const emptyPending = (): PendingWidgets => ({ operations: {} })
function normalizeDelta(raw: unknown): WidgetDelta {
  if (!record(raw)) return emptyDelta()
  return {
    configs: Object.fromEntries(Object.entries(record(raw.configs) ? raw.configs : {}).filter(([, e]) => record(e) && counter(e.at) && record(e.patch) && Array.isArray(e.unset) && e.unset.every(k => typeof k === 'string'))) as WidgetDelta['configs'],
    placements: normalizeSet(raw.placements), installations: normalizeInstallations(raw.installations),
    added: Array.isArray(raw.added) ? raw.added.filter((k): k is string => typeof k === 'string') : [],
    ...(record(raw.expectedInstallations) ? { expectedInstallations: Object.fromEntries(Object.entries(raw.expectedInstallations).filter(([,v]) => typeof v === 'string')) as Record<string,string> } : {}),
  }
}
const deltaEmpty = (d: WidgetDelta) => !Object.keys(d.configs).length && !Object.keys(d.placements.places).length && !d.placements.removed && !Object.keys(d.installations).length
export function normalizePending(raw: unknown): PendingWidgets {
  if (!record(raw)) return emptyPending()
  if (record(raw.operations)) {
    return { operations: Object.fromEntries(Object.entries(raw.operations).flatMap(([id, op]) => record(op) && typeof op.writer === 'string' && WRITER.test(op.writer) && sequence(op.sequence) && counter(op.at) && id === `${op.writer}:${op.sequence}` ? [[id, { writer: op.writer, sequence: op.sequence, at: op.at, delta: normalizeDelta(op.delta) }]] : [])) }
  }
  // Compatibility with the unreleased aggregate journal: identical retained copies have one ID.
  const delta = normalizeDelta(raw)
  if (deltaEmpty(delta)) return emptyPending()
  let a = 2166136261, b = 5381
  for (const ch of stableJSON(delta)) { a = Math.imul(a ^ ch.charCodeAt(0), 16777619) >>> 0; b = (Math.imul(b, 33) ^ ch.charCodeAt(0)) >>> 0 }
  const writer = `legacy-${a.toString(16)}-${b.toString(16)}`
  return { operations: { [`${writer}:1`]: { writer, sequence: 1, at: Math.max(0, ...Object.values(delta.configs).map(v => v.at), ...Object.values(delta.placements.places).map(v => v.at)), delta } } }
}
export function mergePending(local: PendingWidgets, remote: PendingWidgets): PendingWidgets {
  const operations = { ...remote.operations }
  for (const [id, value] of Object.entries(local.operations)) if (!own(operations, id) || stableJSON(value) > stableJSON(operations[id])) Object.defineProperty(operations, id, { value, enumerable: true, configurable: true, writable: true })
  return { operations }
}
export function unconsumed(pending: PendingWidgets, state: WidgetState | null): PendingWidgets {
  return { operations: Object.fromEntries(Object.entries(pending.operations).filter(([, op]) => op.sequence > frontier(state?.consumed, op.writer))) }
}
export function appendPending(pending: PendingWidgets, writer: string, n: number, delta: WidgetDelta): PendingWidgets {
  if (!WRITER.test(writer) || !sequence(n)) throw new Error('Invalid widget journal identity')
  if (Object.keys(pending.operations).length >= JOURNAL_LIMITS.operations) throw new Error('Too many pending widget changes; wait for account hydration')
  const at = Math.max(0, ...Object.values(delta.configs).map(v => v.at), ...Object.values(delta.placements.places).map(v => v.at))
  return mergePending(pending, { operations: { [`${writer}:${n}`]: { writer, sequence: n, at, delta } } })
}
/** Each gesture is a patch, not the entire retained view from another tab. */
export function configDelta(before: Configs, after: Configs): WidgetDelta {
  const configs: WidgetDelta['configs'] = {}
  for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (own(before, id) === own(after, id) && same(before[id], after[id])) continue
    const patch: Record<string, unknown> = {}, unset: string[] = []
    if (own(after, id)) for (const key of new Set([...Object.keys(before[id] ?? {}), ...Object.keys(after[id])])) {
      if (same(before[id]?.[key], after[id][key]) && own(before[id] ?? {}, key) === own(after[id], key)) continue
      if (own(after[id], key)) Object.defineProperty(patch, key, { value: after[id][key], enumerable: true, configurable: true, writable: true })
      else unset.push(key)
    }
    Object.defineProperty(configs, id, { value: { at: Date.now(), patch, unset, ...(!own(after, id) ? { removed: true } : {}) }, enumerable: true, configurable: true, writable: true })
  }
  return { ...emptyDelta(), configs }
}
/** A compact installation precondition, including unavailable presence. */
export function installationToken(raw: unknown): string {
  if (!record(raw) || !record(raw.active) || !record(raw.active.snapshot)) return stableJSON(['unavailable', raw])
  const previous = record(raw.previous) ? raw.previous : undefined
  return stableJSON([raw.generation, raw.kind, raw.active.snapshot.digest, raw.active.source, record(previous?.snapshot) ? previous.snapshot.digest : null, previous?.source])
}
/** Only unambiguous lineage can translate a captured placement key. The originating writer's
 * own mapping disambiguates concurrent additions of the same logical widget. */
export function placementAliases(state: WidgetState, preferredWriter: string): Record<string,string|null> {
  const keys: Record<string,string|null> = Object.create(null)
  for (const mapping of Object.values(state.remaps ?? {})) for (const [from,to] of Object.entries(mapping)) {
    keys[from] = !Object.hasOwn(keys,from) || keys[from] === to ? to : null
  }
  Object.assign(keys, state.remaps?.[preferredWriter] ?? {})
  return keys
}
function applyDelta(state: WidgetState, pending: WidgetDelta, canonicalExists: boolean, at: number, writer: string): WidgetState {
  const configs = configsOf(state)
  for (const [id, edit] of Object.entries(pending.configs)) {
    if (edit.removed) delete configs[id]
    else {
      const value = { ...(Object.hasOwn(configs, id) ? configs[id] : {}), ...edit.patch }
      for (const key of edit.unset) delete value[key]
      Object.defineProperty(configs, id, { value, enumerable: true, configurable: true, writable: true })
    }
  }
  const removed = removedKeys(state.placements), added = new Set(pending.added)
  let remaps = state.remaps ?? {}
  const mapped = (key: string) => own(remaps, writer) && own(remaps[writer], key) ? remaps[writer][key] : key
  const puts = Object.fromEntries(Object.entries(pending.placements.places).filter(([, p]) => !canonicalExists || p.at > 0).map(([original, p]) => {
    let key = mapped(original)
    if (key === original && removed.has(original) && added.has(original)) {
      let hash = 2166136261
      for (const ch of stableJSON([original, p])) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619) >>> 0
      key = `${p.id.slice(0, 60)}~pending-${hash.toString(36)}`
      remaps = mergeRemaps(remaps, { [writer]: { [original]: key } })
    }
    return [key, p.at > 0 ? { ...p, at: Math.max(p.at, (state.placements.places[key]?.at ?? 0) + 1) } : p]
  }))
  const removals = [...new Set((pending.placements.removed ? pending.placements.removed.split(' ') : []).flatMap(key => [key, mapped(key)]))].sort().join(' ')
  // Use the original gesture stamp, never the time a stale tab happens to hydrate.
  const next = withConfigs(state, configs, at)
  for (const [id, edit] of Object.entries(pending.configs)) if (edit.removed && !next.configs[id]?.removed) Object.defineProperty(next.configs, id, { value: { at: Math.max(at, (state.configs[id]?.at ?? 0) + 1), removed: true }, enumerable: true, configurable: true, writable: true })
  const accepted = Object.fromEntries(Object.entries(pending.installations).filter(([id,value]) => {
    const expected = pending.expectedInstallations?.[id]
    return expected === undefined || expected === installationToken(state.installations[id]) || same(value,state.installations[id])
  }))
  return { ...next, placements: mergeSets({ places: puts, removed: removals }, state.placements), installations: mergeInstallationRecords(accepted, state.installations), ...(Object.keys(remaps).length ? { remaps } : {}) }
}
export function applyPending(state: WidgetState, pending: PendingWidgets, canonicalExists: boolean): WidgetState {
  let next = state
  const remaining = Object.values(unconsumed(pending, state).operations)
  const writers = new Map<string, PendingOperation[]>()
  for (const op of remaining) writers.set(op.writer, [...writers.get(op.writer) ?? [], op])
  for (const ops of writers.values()) ops.sort((a, b) => a.sequence - b.sequence)
  // Merge writer prefixes by original gesture time. Clock rollback cannot reorder one writer.
  for (let count = 0; writers.size && count < JOURNAL_LIMITS.operations; count++) {
    const op = [...writers.values()].map(ops => ops[0]).sort((a, b) => a.at - b.at || a.writer.localeCompare(b.writer))[0]
    if (op.sequence !== frontier(next.consumed, op.writer) + 1) throw new Error('Incomplete widget journal; pending changes retained')
    const consumed = mergeConsumed(next.consumed, { [op.writer]: op.sequence })
    next = { ...applyDelta(next, op.delta, canonicalExists, op.at, op.writer), consumed }
    const ops = writers.get(op.writer)!
    ops.shift()
    if (!ops.length) writers.delete(op.writer)
  }
  return next
}
