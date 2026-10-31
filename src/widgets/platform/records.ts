import { CUSTOM_KIND, LIMITS, isInstanceKind, record, type InstanceKind, type Snapshot, type SourceIdentity } from './package.ts'
/** Pure installation-record logic: no React, no storage. Shared by the host layer and its node checks. */
export type Revision = { source: SourceIdentity; snapshot: Snapshot }
export type Installation = { schema: 1; instance: string; kind: InstanceKind; generation: number; active: Revision; previous?: Revision }
/** A removed custom widget. Higher generation than any live record it replaces, so removal syncs and never resurrects. */
export type Tombstone = { schema: 1; instance: string; kind: typeof CUSTOM_KIND; generation: number; removed: true }
export type Installations = Record<string, Installation>
export const INSTALLATION_LIMIT = 12
/** Tombstones are tiny but never forgotten; this only bounds a runaway account. */
export const RECORD_LIMIT = 64
export const INSTANCE_ID = /^[\w-]{1,80}$/
const generationOf = (v: unknown) => record(v) && Number.isSafeInteger(v.generation) && Number(v.generation) > 0 ? Number(v.generation) : 0
export function isTombstone(value: unknown): value is Tombstone {
  return record(value) && value.removed === true && value.schema === 1 && value.kind === CUSTOM_KIND && typeof value.instance === 'string' && generationOf(value) > 0 && Object.keys(value).length === 5
}
export const tombstone = (instance: string, generation: number): Tombstone => ({ schema: 1, instance, kind: CUSTOM_KIND, generation, removed: true })
export function mergeInstallations(local: Record<string, unknown>, remote: Record<string, unknown>): Record<string, unknown> {
  const out = { ...remote }
  for (const [id, value] of Object.entries(local)) {
    const other = out[id]
    if (!other || generationOf(value) > generationOf(other) || generationOf(value) === generationOf(other) && JSON.stringify(value) > JSON.stringify(other)) out[id] = value
  }
  return out
}
/** Live, structurally valid records only. Corrupt or unknown entries are dropped from the typed view, never replaced. */
export function normalizeInstallations(raw: unknown): Installations {
  const out: Installations = Object.create(null) as Installations
  if (!record(raw)) return out
  for (const [id, value] of Object.entries(raw)) {
    if (INSTANCE_ID.test(id) && record(value) && value.schema === 1 && value.instance === id && isInstanceKind(value.kind) && Number.isSafeInteger(value.generation) && Number(value.generation) > 0 && record(value.active) && record(value.active.source) && record(value.active.snapshot)) out[id] = value as Installation
  }
  return out
}
export const customInstallations = (live: Installations) => Object.values(live).filter(value => value.kind === CUSTOM_KIND)
/** Why a new record cannot be admitted, or '' when it can. Existing records may always be updated. */
export function admission(raw: Record<string, unknown>, instance: string): string {
  if (Object.hasOwn(raw, instance)) return ''
  const keys = Object.keys(raw)
  if (keys.filter(id => !isTombstone(raw[id])).length >= INSTALLATION_LIMIT) return `Installation limit reached (${INSTALLATION_LIMIT} records); existing revisions remain editable, or remove a custom widget`
  if (keys.length >= RECORD_LIMIT) return 'Too many removed widget records; contact the owner'
  return ''
}
/** Custom state is bounded and revisioned: an effect only applies on the state it was computed from. */
export function customRevision(state: unknown): string {
  const json = JSON.stringify(state === undefined ? null : state)
  let hash = 2166136261
  for (let i = 0; i < json.length; i++) hash = Math.imul(hash ^ json.charCodeAt(i), 16777619) >>> 0
  return `custom:${json.length}:${hash.toString(36)}`
}
export function customInput(state: unknown, holdsState: boolean, now: number) {
  const day = new Date(now)
  const today = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
  const stored = state === undefined ? null : state
  return { now, today, ...(holdsState ? { state: stored, revision: customRevision(stored) } : {}) }
}
export const CUSTOM_STATE_LIMIT = LIMITS.customStateBytes
