import { useMemo, useSyncExternalStore } from 'react'
import { defaultBuild, isBuiltin } from './defaults'
import type { Synced } from '../../os/synced'
import { canonicalInstallations, canonicalInstallationBytes, widgetsHydrated } from './canonicalState'
import { getAccount } from '../../os/account'
import { accountGuard } from '../../os/accountSpace'
import { isWidgetKind, supportsCapabilities, record, verifySnapshot, type Snapshot, type SourceIdentity, type WidgetKind } from './package'
import { assertSource } from './sources'
export type Revision = { source: SourceIdentity; snapshot: Snapshot }
/** Why an activation or recovery did not happen, so the UI can offer the right action. Messages stay user-readable. */
export type InstallFailureCode = 'conflict' | 'limit' | 'budget' | 'unhydrated' | 'storage' | 'signin'
export class InstallFailure extends Error {
  code: InstallFailureCode
  constructor(code: InstallFailureCode, message: string) { super(message); this.code = code; this.name = 'InstallFailure' }
}
export type Installation = { schema: 1; instance: string; kind: WidgetKind; generation: number; active: Revision; previous?: Revision }
type Installations = Record<string, Installation>
export function mergeInstallations(local: Installations, remote: Installations): Installations {
  const out = { ...remote }
  for (const [id, value] of Object.entries(local)) {
    const other = out[id]
    if (!other || value.generation > other.generation || value.generation === other.generation && JSON.stringify(value) > JSON.stringify(other)) out[id] = value
  }
  return out
}
function normalize(raw: unknown): Installations {
  if (!record(raw)) return Object.create(null) as Installations
  const out: Installations = Object.create(null) as Installations
  for (const [id, value] of Object.entries(raw)) {
    if (/^[\w-]{1,80}$/.test(id) && record(value) && value.schema === 1 && value.instance === id && isWidgetKind(value.kind) && Number.isSafeInteger(value.generation) && Number(value.generation) > 0 && record(value.active) && record(value.active.source) && record(value.active.snapshot)) out[id] = value as Installation
  }
  return out
}
export const installations: Synced<Installations> = { ...canonicalInstallations, get: () => normalize(canonicalInstallations.get()), set: next => canonicalInstallations.set(all => { const current=normalize(all);return {...all,...(typeof next==='function'?next(current):next)} }), use: useInstallationRecords, onRemote: listener => canonicalInstallations.onRemote(raw=>listener(normalize(raw))) }
function useInstallationRecords(){const raw=canonicalInstallations.use();return useMemo(()=>normalize(raw),[raw])}
export const installation = (id: string) => installations.get()[id]
export const installationIdentity = (value?: Installation) => JSON.stringify([value?.generation ?? 0, value?.active.snapshot.digest, value?.active.source, value?.previous?.snapshot?.digest, value?.previous?.source])
/** Presence is independent of validity: corrupt/unknown records must never select a default. */
export const useInstallationPresence = (id: string) => Object.hasOwn(canonicalInstallations.use(), id)
export function installationVersion(id: string) {
  const raw = canonicalInstallations.get()[id]
  const valid = normalize({ [id]: raw })[id]
  return { generation: record(raw) && Number.isSafeInteger(raw.generation) && Number(raw.generation) > 0 ? Number(raw.generation) : 0, identity: valid ? installationIdentity(valid) : JSON.stringify(['unavailable', raw]) }
}
export async function activate(instance: string, kind: Installation['kind'], revision: Revision, expectedGeneration: number, expectedIdentity = installationVersion(instance).identity) {
  assertSource(revision.source)
  if (!accountGuard() || !getAccount().user) throw new InstallFailure('signin', 'Sign in to install a package')
  const account = getAccount().user!.id
  if (!/^[\w-]{1,80}$/.test(instance) || !isWidgetKind(kind) || !Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) throw new Error('Invalid installation identity')
  const snapshot = await verifySnapshot(revision.snapshot)
  if (!supportsCapabilities(kind, snapshot.manifest.capabilities)) throw new Error('Capabilities do not match instance resource')
  assertSource(revision.source)
  if (!accountGuard() || getAccount().user?.id !== account) throw new Error('Account changed')
  const fallback = { source: { kind: 'system' as const, path: `/usr/share/mvlos/widgets/${kind}` }, snapshot: await defaultBuild(kind) }
  assertSource(revision.source)
  if (!accountGuard() || getAccount().user?.id !== account) throw new Error('Account changed')
  if (!widgetsHydrated()) throw new InstallFailure('unhydrated', 'Widget state is not hydrated; retry activation after sync')
  let conflict = null as InstallFailure | null
  installations.set(all => {
    const current = all[instance]
    if (current?.active.snapshot.digest === snapshot.digest && JSON.stringify(current.active.source) === JSON.stringify(revision.source)) return all
    const version = installationVersion(instance)
    if (version.generation !== expectedGeneration || version.identity !== expectedIdentity || !Number.isSafeInteger(expectedGeneration + 1)) { conflict = new InstallFailure('conflict', 'Installation changed; reload before activating'); return all }
    const raw = canonicalInstallations.get()
    if (!Object.hasOwn(raw, instance) && Object.keys(raw).length >= 12) { conflict = new InstallFailure('limit', 'Installation limit reached (12 records); existing revisions remain editable'); return all }
    const next: Installations = { ...all, [instance]: { schema: 1, instance, kind, generation: expectedGeneration + 1, active: { source: revision.source, snapshot }, previous: current?.active ?? fallback } }
    if (canonicalInstallationBytes({ ...raw, ...next }) > 480 * 1024) { conflict = new InstallFailure('budget', 'Widget state exceeds the 480 KiB installation budget'); return all }
    return next
  })
  if (conflict) throw conflict
  try { await installations.flush?.() } catch (error) {
    if (error instanceof Error && error.message === 'Account changed') throw error
    throw new InstallFailure('storage', `Not saved: ${error instanceof Error ? error.message : 'storage failure'}. The earlier saved revision is intact; the new one is active in this session only until it is saved.`)
  }
  if (!accountGuard() || getAccount().user?.id !== account) throw new Error('Account changed')
  const installed = installation(instance)
  if (installed?.active.snapshot.digest !== snapshot.digest || JSON.stringify(installed.active.source) !== JSON.stringify(revision.source)) throw new InstallFailure('conflict', 'Installation changed; reload before activating')
}
export async function recover(instance: string, expectedGeneration: number, expectedIdentity = installationIdentity(installation(instance))) {
  const current = installation(instance)
  if (!current?.previous || current.generation !== expectedGeneration || installationIdentity(current) !== expectedIdentity) throw new InstallFailure('conflict', 'Previous revision unavailable or installation changed')
  await activate(instance, current.kind, current.previous, expectedGeneration, expectedIdentity)
}
/** Identity grants are local to this live account session, never accepted from imported/synced files. */
const grants = new Set<string>()
const grantListeners = new Set<() => void>()
const notifyGrants = () => grantListeners.forEach(listener => listener())
const subscribeGrants = (listener: () => void) => { grantListeners.add(listener); return () => { grantListeners.delete(listener) } }
/** Activation can finish after host verification. Consent changes must be observable independently. */
export const useRevisionGrant = (instance: string, revision: Revision | null) => useSyncExternalStore(subscribeGrants, () => !!revision && hasGrant(instance, revision))
const grantKey = (instance: string, revision: Revision) => JSON.stringify([getAccount().user?.id ?? 'guest', instance, revision.source, revision.snapshot.digest])
export function allowRevision(instance: string, revision: Revision) {
  assertSource(revision.source)
  if (!accountGuard()) throw new Error('Account revoked')
  const key = grantKey(instance, revision)
  if (!grants.has(key)) { grants.add(key); notifyGrants() }
}
export function hasGrant(instance: string, revision: Revision) {
  try { assertSource(revision.source) } catch { return false }
  return accountGuard() && (revision.source.kind === 'system' && isBuiltin(revision.source.path, revision.snapshot.digest) || grants.has(grantKey(instance, revision)))
}
export const revokeRevision = (instance: string, revision: Revision) => {
  const removed = grants.delete(grantKey(instance, revision))
  if (removed) notifyGrants()
  return removed
}

if (typeof window !== 'undefined') for (const event of ['mvlos:forget', 'mvlos:account-changed']) window.addEventListener(event, () => { grants.clear(); notifyGrants() })
