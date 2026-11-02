import { useMemo, useSyncExternalStore } from 'react'
import { defaultBuild, isBuiltin } from './defaults'
import type { Synced } from '../../os/synced'
import { canonicalInstallations, canonicalInstallationBytes, canonicalTrust, widgetsHydrated } from './canonicalState'
import { getAccount } from '../../os/account'
import { accountGuard } from '../../os/accountSpace'
import { CUSTOM_KIND, isInstanceKind, supportsCapabilities, record, verifySnapshot, type InstanceKind } from './package'
import { assertSource, trustGate } from './sources'
import { effectiveGrant, newGrant, newRevocation, type TrustGrant } from './trust'
import { admission, INSTANCE_ID, isTombstone, mergeInstallations as mergeRecords, normalizeInstallations as normalize, tombstone, type Installation, type Installations, type Revision } from './records'
export type { Installation, Revision }
/** Why an activation or recovery did not happen, so the UI can offer the right action. Messages stay user-readable. */
export type InstallFailureCode = 'conflict' | 'limit' | 'budget' | 'unhydrated' | 'storage' | 'signin'
export class InstallFailure extends Error {
  code: InstallFailureCode
  constructor(code: InstallFailureCode, message: string) { super(message); this.code = code; this.name = 'InstallFailure' }
}
export const mergeInstallations = (local: Installations, remote: Installations) => mergeRecords(local, remote) as Installations
export const installations: Synced<Installations> = { ...canonicalInstallations, get: () => normalize(canonicalInstallations.get()), set: next => canonicalInstallations.set(all => { const current=normalize(all);return {...all,...(typeof next==='function'?next(current):next)} }), use: useInstallationRecords, onRemote: listener => canonicalInstallations.onRemote(raw=>listener(normalize(raw))) }
function useInstallationRecords(){const raw=canonicalInstallations.use();return useMemo(()=>normalize(raw),[raw])}
export const installation = (id: string) => installations.get()[id]
export const installationIdentity = (value?: Installation) => JSON.stringify([value?.generation ?? 0, value?.active.snapshot.digest, value?.active.source, value?.previous?.snapshot?.digest, value?.previous?.source])
/** Presence is independent of validity: corrupt/unknown records must never select a default. */
export const useInstallationPresence = (id: string) => Object.hasOwn(canonicalInstallations.use(), id)
/** A custom widget the user removed (here or on another device). Its placement may still be on the desktop. */
export const useInstallationRemoved = (id: string) => { const raw = canonicalInstallations.use(); return Object.hasOwn(raw, id) && isTombstone(raw[id]) }
export function installationVersion(id: string) {
  const raw = canonicalInstallations.get()[id]
  const valid = normalize({ [id]: raw })[id]
  return { generation: record(raw) && Number.isSafeInteger(raw.generation) && Number(raw.generation) > 0 ? Number(raw.generation) : 0, identity: valid ? installationIdentity(valid) : JSON.stringify(['unavailable', raw]) }
}
/** Activation never creates trust. The only option it takes is an explicit `trust: false`, so callers
 * (the agents' `widget activate` among them) can say so; trust comes only from trustInstallation. */
export type ActivateOptions = { trust?: false }
export async function activate(instance: string, kind: InstanceKind, revision: Revision, expectedGeneration: number, expectedIdentity = installationVersion(instance).identity, options: ActivateOptions = {}) {
  if (options.trust !== undefined && options.trust !== false) throw new Error('Activation cannot grant trust')
  assertSource(revision.source)
  if (!accountGuard() || !getAccount().user) throw new InstallFailure('signin', 'Sign in to install a package')
  const account = getAccount().user!.id
  if (kind === CUSTOM_KIND && revision.source.kind === 'system') throw new Error('Custom widgets come from a folder, not a system source')
  if (!INSTANCE_ID.test(instance) || !isInstanceKind(kind) || !Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) throw new Error('Invalid installation identity')
  const snapshot = await verifySnapshot(revision.snapshot)
  if (!supportsCapabilities(kind, snapshot.manifest.capabilities)) throw new Error('Capabilities do not match instance resource')
  assertSource(revision.source)
  if (!accountGuard() || getAccount().user?.id !== account) throw new Error('Account changed')
  const fallback = kind === CUSTOM_KIND ? undefined : { source: { kind: 'system' as const, path: `/usr/share/mvlos/widgets/${kind}` }, snapshot: await defaultBuild(kind) }
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
    if (isTombstone(raw[instance])) { conflict = new InstallFailure('conflict', 'This widget was removed; create a new one instead'); return all }
    if (current && current.kind !== kind) { conflict = new InstallFailure('conflict', 'Installation kind cannot change'); return all }
    const refusal = admission(raw, instance)
    if (refusal) { conflict = new InstallFailure(refusal.startsWith('Installation limit') ? 'limit' : 'conflict', refusal); return all }
    const previous = current?.active ?? fallback
    const next: Installations = { ...all, [instance]: { schema: 1, instance, kind, generation: expectedGeneration + 1, active: { source: revision.source, snapshot }, ...(previous ? { previous } : {}) } }
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
/** Removes a custom widget's installation (explicit user action). Builtins are never removable. */
export async function removeInstallation(instance: string, expectedGeneration: number, expectedIdentity = installationVersion(instance).identity) {
  if (!accountGuard() || !getAccount().user) throw new Error('Sign in to remove a widget')
  const account = getAccount().user!.id
  if (!widgetsHydrated()) throw new Error('Widget state is not hydrated; retry after sync')
  let conflict = ''
  installations.set(all => {
    const current = all[instance]
    const version = installationVersion(instance)
    if (!current || current.kind !== CUSTOM_KIND) { conflict = 'Only installed custom widgets can be removed'; return all }
    if (version.generation !== expectedGeneration || version.identity !== expectedIdentity || !Number.isSafeInteger(expectedGeneration + 1)) { conflict = 'Installation changed; reload before removing'; return all }
    return { [instance]: tombstone(instance, expectedGeneration + 1) } as unknown as Installations
  })
  if (conflict) throw new Error(conflict)
  await installations.flush?.()
  if (!accountGuard() || getAccount().user?.id !== account) throw new Error('Account changed')
  if (!isTombstone(canonicalInstallations.get()[instance])) throw new Error('Removal was not committed; reload and retry')
  // The tombstone already defeats every grant (the installation identity changed for good); the
  // revocation also keeps a stale copy of the old record from ever matching one again.
  // A failure to save it is not a failed removal: the tombstone alone already defeats every grant.
  await revokeTrust(instance).catch(() => {})
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
/** Every session grant of one instance, whatever revision. */
function revokeSessionGrants(instance: string) {
  let removed = false
  for (const key of grants) { try { if ((JSON.parse(key) as unknown[])[1] === instance) removed = grants.delete(key) || removed } catch { /* own keys only */ } }
  if (removed) notifyGrants()
}

// --- persistent trust ("Trust always") ----------------------------------------------------------

/** The live persistent grant for exactly this installation and revision, or null. Checks the
 * signed-in account, the installation identity, the package id, the source and the digest. */
export function persistentTrust(instance: string, revision: Revision | null, trust = canonicalTrust.get()): TrustGrant | null {
  if (!revision || !accountGuard()) return null
  const account = getAccount()
  const current = installation(instance)
  if (account.status !== 'user' || !account.user || !current || current.kind !== CUSTOM_KIND) return null
  if (current.active.snapshot.digest !== revision.snapshot.digest || JSON.stringify(current.active.source) !== JSON.stringify(revision.source)) return null
  try { assertSource(revision.source) } catch { return null }
  return effectiveGrant(trust, { instance, kind: current.kind, package: revision.snapshot.manifest.id, source: revision.source, digest: revision.snapshot.digest, installation: installationVersion(instance).identity, account: account.user.id })
}
export const useTrusted = (instance: string, revision: Revision | null) => {
  const trust = canonicalTrust.use()
  canonicalInstallations.use()
  return !!persistentTrust(instance, revision, trust)
}
/** May this revision run here now: a session grant (Allow once) or valid persistent trust. */
export const hasAccess = (instance: string, revision: Revision) => hasGrant(instance, revision) || !!persistentTrust(instance, revision)

export type TrustEligibility = { ok: true; installation: string } | { ok: false; reason: string }
/** Whether "Trust always" may be offered for this installed revision now, and if not, why. The same
 * check runs again when the person clicks. Only installed custom widgets in the canonical folder. */
export async function trustEligibility(instance: string, revision: Revision): Promise<TrustEligibility> {
  try {
    const account = getAccount()
    if (!accountGuard() || account.status !== 'user' || !account.user) return { ok: false, reason: 'Sign in to trust a widget' }
    const current = installation(instance)
    const version = installationVersion(instance)
    if (!current || current.kind !== CUSTOM_KIND) return { ok: false, reason: 'Only an installed custom widget can be trusted' }
    if (current.active.snapshot.digest !== revision.snapshot.digest || JSON.stringify(current.active.source) !== JSON.stringify(revision.source)) return { ok: false, reason: 'Activate this build first; only the active revision can be trusted' }
    const snapshot = await verifySnapshot(current.active.snapshot)
    if (!supportsCapabilities(CUSTOM_KIND, snapshot.manifest.capabilities)) return { ok: false, reason: 'This package asks for capabilities a custom widget cannot have' }
    await trustGate(current.active.source, snapshot)
    if (!accountGuard() || getAccount().user?.id !== account.user.id) return { ok: false, reason: 'Account changed' }
    if (installationVersion(instance).identity !== version.identity) return { ok: false, reason: 'Installation changed; build again' }
    return { ok: true, installation: version.identity }
  } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : 'This widget cannot be trusted' } }
}
/** Before activation: could this build be trusted once it is the active revision? (Workshop checkbox.) */
export async function trustBuildEligibility(revision: Revision): Promise<TrustEligibility> {
  try {
    const account = getAccount()
    if (!accountGuard() || account.status !== 'user' || !account.user) return { ok: false, reason: 'Sign in to trust a widget' }
    if (revision.source.kind === 'system') return { ok: false, reason: 'Built-in sources are not custom widgets' }
    const snapshot = await verifySnapshot(revision.snapshot)
    if (!supportsCapabilities(CUSTOM_KIND, snapshot.manifest.capabilities)) return { ok: false, reason: 'This package asks for capabilities a custom widget cannot have' }
    await trustGate(revision.source, snapshot)
    return { ok: true, installation: '' }
  } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : 'This widget cannot be trusted' } }
}
/** A gesture is a real click or key press by the person, delivered by the browser (`isTrusted`),
 * never a synthetic event from script, an agent, activation, build, recovery or sync. */
function genuine(gesture: unknown) {
  return typeof Event !== 'undefined' && gesture instanceof Event && gesture.isTrusted === true && gesture.type === 'click'
}
/** "Trust always": the person's own click on an eligible, installed custom widget. Re-checks the
 * canonical gate and the built bytes now, then records a grant pinned to this exact installation. */
export async function trustInstallation(instance: string, revision: Revision, gesture: Event) {
  if (!genuine(gesture)) throw new Error('Trust needs your own click')
  if (!accountGuard() || getAccount().status !== 'user' || !getAccount().user) throw new Error('Sign in to trust a widget')
  const account = getAccount().user!.id
  if (!widgetsHydrated()) throw new InstallFailure('unhydrated', 'Widget state is not hydrated; retry after sync')
  const version = installationVersion(instance)
  const eligibility = await trustEligibility(instance, revision)
  if (!eligibility.ok) throw new Error(eligibility.reason)
  if (!accountGuard() || getAccount().user?.id !== account) throw new Error('Account changed')
  if (installationVersion(instance).identity !== version.identity || version.identity !== eligibility.installation) throw new InstallFailure('conflict', 'Installation changed; build and trust again')
  let made: TrustGrant | null = null
  canonicalTrust.set(trust => {
    if (persistentTrust(instance, revision, trust)) return trust
    made = newGrant(trust, { instance, package: revision.snapshot.manifest.id, source: revision.source, digest: revision.snapshot.digest, installation: version.identity }, crypto.randomUUID(), Date.now())
    return { ...trust, grants: { ...trust.grants, [made.id]: made } }
  })
  await canonicalTrust.flush?.()
  if (!accountGuard() || getAccount().user?.id !== account) throw new Error('Account changed')
  notifyGrants()
  if (!persistentTrust(instance, revision)) throw new Error('Trust was not kept: it was revoked on another device meanwhile, or the widget changed')
}
/** Revoke trust: one revocation for the instance (defeats every grant it has, here and on any
 * device that has not seen it yet), plus this session's own Allow once grants. Immediate. */
export async function revokeTrust(instance: string) {
  if (!accountGuard()) throw new Error('Account revoked')
  revokeSessionGrants(instance)
  try {
    canonicalTrust.set(trust => {
      const r = newRevocation(instance, crypto.randomUUID(), Date.now())
      return { ...trust, revoked: { ...trust.revoked, [r.id]: r } }
    })
  } catch (error) { throw new Error(`Trust was not revoked: ${error instanceof Error ? error.message : 'storage failure'}. Allow once was ended; try again.`) }
  notifyGrants()
  try { await canonicalTrust.flush?.() } catch (error) { throw new Error(`Trust is revoked on this device but not saved to your account yet: ${error instanceof Error ? error.message : 'storage failure'}`) }
}

if (typeof window !== 'undefined') for (const event of ['mvlos:forget', 'mvlos:account-changed']) window.addEventListener(event, () => { grants.clear(); notifyGrants() })
// A revocation this tab has not seen before (made here or synced from another device) also ends
// this tab's Allow once grants for that widget: Revoke trust stops it everywhere, at once.
const seenRevocations = new Set(Object.keys(canonicalTrust.get().revoked))
canonicalTrust.subscribe(() => {
  for (const r of Object.values(canonicalTrust.get().revoked)) if (!seenRevocations.has(r.id)) { seenRevocations.add(r.id); revokeSessionGrants(r.instance) }
})
