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
  return record(raw) ? Object.fromEntries(Object.entries(raw).filter(([, v]) => record(v) && Number.isSafeInteger(v.generation) && Number(v.generation) > 0)) : {}
}
export function mergeInstallationRecords(local: InstallationRecords, remote: InstallationRecords): InstallationRecords {
  const out = { ...remote }
  for (const [id, value] of Object.entries(local)) {
    const other = out[id]
    const generation = (v: unknown) => record(v) ? Number(v.generation) : 0
    if (!own(out, id) || generation(value) > generation(other) || generation(value) === generation(other) && JSON.stringify(value) > JSON.stringify(other)) Object.defineProperty(out, id, { value, enumerable: true, writable: true, configurable: true })
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
  return { schema: 2, configs, placements: normalizeSet(raw.placements), installations: normalizeInstallations(raw.installations) }
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
  return { schema: 2, configs, placements: mergeSets(local.placements, remote.placements), installations: mergeInstallationRecords(local.installations, remote.installations) }
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

export type ConfigEdit = { at: number; patch: Record<string, unknown>; unset: string[]; removed?: true }
/** Browser-local journal while account identity/hydration is unknown. It is not a cutover marker. */
export type PendingWidgets = { configs: Record<string, ConfigEdit>; placements: WidgetSet; added: string[]; installations: InstallationRecords }
export const emptyPending = (): PendingWidgets => ({ configs: {}, placements: EMPTY, added: [], installations: {} })
export function normalizePending(raw: unknown): PendingWidgets {
  if (!record(raw)) return emptyPending()
  return {
    configs: Object.fromEntries(Object.entries(record(raw.configs) ? raw.configs : {}).filter(([, e]) => record(e) && counter(e.at) && record(e.patch) && Array.isArray(e.unset) && e.unset.every(k => typeof k === 'string'))) as PendingWidgets['configs'],
    placements: normalizeSet(raw.placements), installations: normalizeInstallations(raw.installations),
    added: Array.isArray(raw.added) ? raw.added.filter((k): k is string => typeof k === 'string') : [],
  }
}
/** Merge the browser-local journals before saving or migrating, so tabs that start before the
 * account is known do not discard each other's queued instance edits on reload. */
export function mergePending(local: PendingWidgets, remote: PendingWidgets): PendingWidgets {
  const configs = Object.fromEntries([...new Set([...Object.keys(local.configs), ...Object.keys(remote.configs)])].map(id => {
    const a = Object.hasOwn(local.configs, id) ? local.configs[id] : undefined
    const b = Object.hasOwn(remote.configs, id) ? remote.configs[id] : undefined
    return [id, !b || a && (a.at > b.at || a.at === b.at && stableJSON(a) > stableJSON(b)) ? a : b]
  })) as PendingWidgets['configs']
  return { configs, placements: mergeSets(local.placements, remote.placements), added: [...new Set([...local.added, ...remote.added])].sort(), installations: mergeInstallationRecords(local.installations, remote.installations) }
}
export function queueConfigs(pending: PendingWidgets, before: Configs, after: Configs): PendingWidgets {
  const edits = { ...pending.configs }
  for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (own(before, id) === own(after, id) && same(before[id], after[id])) continue
    const old = own(edits, id) ? edits[id] : undefined
    const at = Math.max(Date.now(), (old?.at ?? 0) + 1)
    if (!own(after, id)) { Object.defineProperty(edits, id, { value: { at, patch: {}, unset: [], removed: true }, enumerable: true, configurable: true, writable: true }); continue }
    const patch = { ...old?.patch }
    const unset = new Set(old?.unset ?? [])
    for (const key of new Set([...Object.keys(before[id] ?? {}), ...Object.keys(after[id])])) {
      if (same(before[id]?.[key], after[id][key]) && own(before[id] ?? {}, key) === own(after[id], key)) continue
      if (own(after[id], key)) { Object.defineProperty(patch, key, { value: after[id][key], enumerable: true, configurable: true, writable: true }); unset.delete(key) }
      else { delete patch[key]; unset.add(key) }
    }
    Object.defineProperty(edits, id, { value: { at, patch, unset: [...unset] }, enumerable: true, configurable: true, writable: true })
  }
  return { ...pending, configs: edits }
}
export function applyPending(state: WidgetState, pending: PendingWidgets, canonicalExists: boolean, now = Date.now()): WidgetState {
  const configs = configsOf(state)
  for (const [id, edit] of Object.entries(pending.configs)) {
    if (edit.removed) delete configs[id]
    else {
      const value = { ...(Object.hasOwn(configs, id) ? configs[id] : {}), ...edit.patch }
      for (const key of edit.unset) delete value[key]
      Object.defineProperty(configs, id, { value, enumerable: true, configurable: true, writable: true })
    }
  }
  // A queued real gesture is later than the data just learned. Layout imports (at: 0) are not
  // gestures; once another device has cut over they are ignored, even for previously unseen ids.
  const removed = removedKeys(state.placements)
  const added = new Set(pending.added)
  const puts = Object.fromEntries(Object.entries(pending.placements.places).filter(([, p]) => !canonicalExists || p.at > 0).map(([original, p]) => {
    let key = original
    if (removed.has(key) && added.has(key)) {
      // A real add made before learning of an old removal gets a new entry key, just as newKey
      // would have given it with that knowledge. Replay uses the same key; identity stays p.id.
      let hash = 2166136261
      for (const ch of stableJSON([key, p])) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619) >>> 0
      key = `${p.id.slice(0, 60)}~pending-${hash.toString(36)}`
    }
    return [key, p.at > 0 ? { ...p, at: Math.max(p.at, (state.placements.places[key]?.at ?? 0) + 1) } : p]
  }))
  const next = withConfigs(state, configs, now)
  for (const [id, edit] of Object.entries(pending.configs)) {
    if (edit.removed && !next.configs[id]?.removed) Object.defineProperty(next.configs, id, { value: { at: Math.max(now, (state.configs[id]?.at ?? 0) + 1), removed: true }, enumerable: true, configurable: true, writable: true })
  }
  return { ...next, placements: mergeSets({ places: puts, removed: pending.placements.removed }, state.placements), installations: mergeInstallationRecords(pending.installations, state.installations) }
}
