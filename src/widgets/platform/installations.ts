import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { subscribeBrowserFiles } from '../../data/browserfs'
import { subscribeMounts } from '../../data/mounts'
import { subscribeDirs, subscribeLibraries } from '../../data/seafile'
import { defaultBuild, isBuiltin } from './defaults'
import type { Synced } from '../../os/synced'
import { canonicalInstallations, canonicalInstallationBytes, canonicalTrust, updateTrust, widgetsHydrated } from './canonicalState'
import { getAccount, subscribeAccount } from '../../os/account'
import { accountGuard } from '../../os/accountSpace'
import { CUSTOM_KIND, isInstanceKind, supportsCapabilities, record, verifySnapshot, type InstanceKind } from './package'
import { assertSource, sightTrustedSource, trustGate, TrustRefusal } from './sources'
import { effectiveGrant, grantGeneration, grantLive, newGrant, newRevocation, revocationsOf, type TrustGrant } from './trust'
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

/** The recorded grant for exactly this installation and revision, or null. Checks the signed-in
 * account, the installation identity, the package id, the source and the digest. A recorded grant
 * alone never lets a widget run: see trustStatus for the live source check on this device. */
export function persistentTrust(instance: string, revision: Revision | null, trust = canonicalTrust.get()): TrustGrant | null {
  if (!revision || !accountGuard()) return null
  const account = getAccount()
  const current = installation(instance)
  if (account.status !== 'user' || !account.user || !current || current.kind !== CUSTOM_KIND) return null
  if (current.active.snapshot.digest !== revision.snapshot.digest || JSON.stringify(current.active.source) !== JSON.stringify(revision.source)) return null
  try { assertSource(revision.source) } catch { return null }
  return effectiveGrant(trust, { instance, kind: current.kind, package: revision.snapshot.manifest.id, source: revision.source, digest: revision.snapshot.digest, installation: installationVersion(instance).identity, account: account.user.id })
}
/** Whether this instance has any trust decision left that a Revoke trust would end (a grant not yet
 * revoked, whatever revision it was for). */
export const retainsTrust = (instance: string, trust = canonicalTrust.get()) => Object.values(trust.grants).some(g => g.instance === instance && grantLive(trust, g))
export const useRetainsTrust = (instance: string) => retainsTrust(instance, canonicalTrust.use())

// --- live evidence: a recorded grant runs a widget only while its source is present and matching here ---
//
// Every device checks, with its own storage, that the trusted folder is still exactly there: the
// canonical path on home's own storage, the same source identity, plain entries only, and a rebuild
// that gives the pinned digest (trustGate, which reads the folder again from IndexedDB or Seafile, not
// from this tab's memory). The check leaves evidence: what it saw of the mounts, the folder and its
// entries (with browser-files mutation numbers). Evidence counts only while what this tab sees now is
// the same (checked synchronously on every render and on every execution and callback), while no
// other tab has announced a change there, and for at most TRUST_FRESH_MS on the monotonic clock; a
// hidden, frozen or resumed tab drops it. It is checked again halfway, while it still counts.
// Anything else, a missing or changed folder, another mount, a read-only library, an unknown entry
// type, a source that is not on this device, a check that stalls, fails closed: the widget asks
// (Allow once) like any revision. A passing re-check only restores an existing grant; it never makes one.

/** How long a check counts before it is repeated from storage (browser files too: another tab may
 * change them, and its announcement can be missed). */
export const TRUST_FRESH_MS = 20_000
/** A check that has not finished by then counts as failed (and nothing runs meanwhile). */
const CHECK_TIMEOUT_MS = 15_000
/** Evidence times come from the monotonic clock: setting the wall clock back cannot stretch them. A
 * device that was suspended, or a tab that was hidden or frozen, drops its Seafile evidence (the
 * monotonic clock may not count a suspension) and checks again. */
const clock = () => performance.now()
type Evidence = { seen: string; at: number }
const evidence = new Map<string, Evidence>()
const failures = new Map<string, { seen: string | null; at: number; reason: string }>()
const checking = new Map<string, Promise<void>>()
const evidenceListeners = new Set<() => void>()
const notifyEvidence = () => evidenceListeners.forEach(listener => listener())
const evidenceKey = (instance: string, revision: Revision, grant: TrustGrant) => JSON.stringify([getAccount().user?.id ?? 'guest', instance, revision.source, revision.snapshot.digest, grant.installation, grant.id])
/** `deleted`: this device sees the trusted folder gone from its own storage (the full check then confirms and revokes). */
export type TrustStatus = { state: 'none' } | { state: 'checking' } | { state: 'trusted' } | { state: 'refused'; reason: string; deleted?: true }
/** The persistent trust of exactly this revision on this device now, without I/O. Only `trusted` runs it. */
export function trustStatus(instance: string, revision: Revision | null, now = clock()): TrustStatus {
  const grant = persistentTrust(instance, revision)
  if (!grant || !revision) return { state: 'none' }
  const sight = sightTrustedSource(revision.source, revision.snapshot.manifest.id)
  if (sight.state === 'refused') return { state: 'refused', reason: sight.reason, ...(sight.definitive ? { deleted: true as const } : {}) }
  const key = evidenceKey(instance, revision, grant)
  const seen = sight.state === 'ok' ? sight.seen : null
  const fresh = (at: number) => now >= at && now - at < TRUST_FRESH_MS
  const proof = evidence.get(key)
  if (proof && seen !== null && proof.seen === seen && fresh(proof.at)) return { state: 'trusted' }
  const failed = failures.get(key)
  if (failed && failed.seen === seen && fresh(failed.at)) return { state: 'refused', reason: failed.reason }
  return { state: 'checking' }
}
/** Runs the full gate for a recorded grant on this device and records the outcome. One check at a time per grant. */
export function checkTrust(instance: string, revision: Revision): Promise<void> {
  const grant = persistentTrust(instance, revision)
  if (!grant) return Promise.resolve()
  const key = evidenceKey(instance, revision, grant)
  const running = checking.get(key)
  if (running) return running
  const run = (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const result = await Promise.race([trustEligibility(instance, revision), new Promise<TrustEligibility>(resolve => { timer = setTimeout(() => resolve({ ok: false, reason: 'Checking the widget folder took too long; it is checked again shortly' }), CHECK_TIMEOUT_MS) })]).finally(() => clearTimeout(timer))
    if (persistentTrust(instance, revision)?.id !== grant.id || evidenceKey(instance, revision, grant) !== key) return
    if (result.ok) { evidence.set(key, { seen: result.seen, at: clock() }); failures.delete(key) }
    else {
      evidence.delete(key)
      const sight = sightTrustedSource(revision.source, revision.snapshot.manifest.id)
      failures.set(key, { seen: sight.state === 'ok' ? sight.seen : null, at: clock(), reason: result.reason })
      // The package's folder is gone from its own storage: that ends the trust for good, on every
      // device, so a stale copy of the account state (or the same bytes put back) cannot restore it.
      if (result.deleted) await revokeTrust(instance).catch(() => {})
    }
  })().finally(() => { checking.delete(key); notifyEvidence() })
  checking.set(key, run)
  return run
}
/** Live persistent trust for a widget host: re-renders on anything that can change the answer, starts
 * the check when one is due, and repeats a Seafile check before its evidence runs out. */
export function useTrustStatus(instance: string, revision: Revision | null): TrustStatus {
  const [tick, setTick] = useState(0)
  const subscribe = useCallback((listener: () => void) => {
    const offs = [canonicalTrust.subscribe(listener), canonicalInstallations.subscribe(listener), subscribeBrowserFiles(listener), subscribeMounts(listener), subscribeDirs(listener), subscribeLibraries(listener), subscribeAccount(listener), subscribeGrants(listener)]
    evidenceListeners.add(listener)
    return () => { offs.forEach(off => off()); evidenceListeners.delete(listener) }
  }, [])
  const json = useSyncExternalStore(subscribe, () => JSON.stringify(trustStatus(instance, revision)))
  const status = useMemo(() => JSON.parse(json) as TrustStatus, [json])
  useEffect(() => {
    if (!revision || status.state === 'none') return
    if (status.state === 'checking' || status.state === 'refused' && status.deleted) { void checkTrust(instance, revision); return }
    // Re-check halfway through the evidence's life (it keeps counting meanwhile), and wake up when it would run out.
    const timer = setTimeout(() => { void checkTrust(instance, revision).finally(() => setTick(n => n + 1)) }, TRUST_FRESH_MS / 2)
    const expiry = setTimeout(() => setTick(n => n + 1), TRUST_FRESH_MS + 50)
    return () => { clearTimeout(timer); clearTimeout(expiry) }
  }, [json, tick, instance, revision])
  return status
}
/** May this revision run here now: a session grant (Allow once), or persistent trust with live evidence on this device. */
export const hasAccess = (instance: string, revision: Revision) => hasGrant(instance, revision) || trustStatus(instance, revision).state === 'trusted'

export type TrustEligibility = { ok: true; installation: string; seen: string } | { ok: false; reason: string; deleted?: boolean }
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
    const { seen } = await trustGate(current.active.source, snapshot)
    if (!accountGuard() || getAccount().user?.id !== account.user.id) return { ok: false, reason: 'Account changed' }
    if (installationVersion(instance).identity !== version.identity) return { ok: false, reason: 'Installation changed; build again' }
    return { ok: true, installation: version.identity, seen }
  } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : 'This widget cannot be trusted', deleted: error instanceof TrustRefusal && error.definitive } }
}
/** Before activation: could this build be trusted once it is the active revision? (Workshop checkbox.) */
export async function trustBuildEligibility(revision: Revision): Promise<TrustEligibility> {
  try {
    const account = getAccount()
    if (!accountGuard() || account.status !== 'user' || !account.user) return { ok: false, reason: 'Sign in to trust a widget' }
    if (revision.source.kind === 'system') return { ok: false, reason: 'Built-in sources are not custom widgets' }
    const snapshot = await verifySnapshot(revision.snapshot)
    if (!supportsCapabilities(CUSTOM_KIND, snapshot.manifest.capabilities)) return { ok: false, reason: 'This package asks for capabilities a custom widget cannot have' }
    const { seen } = await trustGate(revision.source, snapshot)
    return { ok: true, installation: '', seen }
  } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : 'This widget cannot be trusted' } }
}
/** The revocations of an instance this tab has seen now. Captured at the person's click and pinned
 * into the grant, so nothing that arrives while the check runs counts as seen. */
export const trustFrontier = (instance: string) => revocationsOf(canonicalTrust.get(), instance)
/** A gesture is a real click or key press by the person, delivered by the browser (`isTrusted`),
 * never a synthetic event from script, an agent, activation, build, recovery or sync. */
function genuine(gesture: unknown) {
  return typeof Event !== 'undefined' && gesture instanceof Event && gesture.isTrusted === true && gesture.type === 'click'
}
/** "Trust always": the person's own click on an eligible, installed custom widget. Re-checks the
 * canonical gate and the built bytes now, then records a grant pinned to this exact installation. */
export async function trustInstallation(instance: string, revision: Revision, gesture: Event, observed: readonly string[] = trustFrontier(instance)) {
  if (!genuine(gesture)) throw new Error('Trust needs your own click')
  const seen = [...observed].sort()
  if (!accountGuard() || getAccount().status !== 'user' || !getAccount().user) throw new Error('Sign in to trust a widget')
  const account = getAccount().user!.id
  if (!widgetsHydrated()) throw new InstallFailure('unhydrated', 'Widget state is not hydrated; retry after sync')
  const version = installationVersion(instance)
  const eligibility = await trustEligibility(instance, revision)
  if (!eligibility.ok) throw new Error(eligibility.reason)
  if (!accountGuard() || getAccount().user?.id !== account) throw new Error('Account changed')
  if (installationVersion(instance).identity !== version.identity || version.identity !== eligibility.installation) throw new InstallFailure('conflict', 'Installation changed; build and trust again')
  let revokedMeanwhile = false
  updateTrust(trust => {
    // A revocation that arrived after the click was not seen by the person: no grant, they decide again.
    if (JSON.stringify(revocationsOf(trust, instance)) !== JSON.stringify(seen)) { revokedMeanwhile = true; return null }
    if (persistentTrust(instance, revision, trust)) return null
    const made = newGrant(trust, { instance, package: revision.snapshot.manifest.id, source: revision.source, digest: revision.snapshot.digest, installation: version.identity }, crypto.randomUUID(), Date.now(), seen)
    return { grants: { [made.id]: made }, revoked: Object.fromEntries(seen.map(id => [id, trust.revoked[id]])), floors: { [instance]: grantGeneration(made) } }
  })
  if (revokedMeanwhile) throw new Error('Trust was revoked on another device while this was being checked; look again, then choose Trust always again')
  await canonicalTrust.flush?.()
  if (!accountGuard() || getAccount().user?.id !== account) throw new Error('Account changed')
  const grant = persistentTrust(instance, revision)
  if (!grant) throw new Error('Trust was not kept: it was revoked on another device meanwhile, or the widget changed')
  // The gate just ran on this device: its evidence counts until what it saw changes (or, for Seafile, runs out).
  evidence.set(evidenceKey(instance, revision, grant), { seen: eligibility.seen, at: clock() })
  notifyGrants(); notifyEvidence()
}
/** Revoke trust: one revocation for the instance (defeats every grant it has, here and on any
 * device that has not seen it yet), plus this session's own Allow once grants. Immediate. */
export async function revokeTrust(instance: string) {
  if (!accountGuard()) throw new Error('Account revoked')
  revokeSessionGrants(instance)
  try {
    updateTrust(() => {
      const r = newRevocation(instance, crypto.randomUUID(), Date.now())
      return { grants: {}, revoked: { [r.id]: r } }
    })
  } catch (error) { throw new Error(`Trust was not revoked: ${error instanceof Error ? error.message : 'storage failure'}. Allow once was ended; try again.`) }
  notifyGrants()
  try { await canonicalTrust.flush?.() } catch (error) { throw new Error(`Trust is revoked on this device but not saved to your account yet: ${error instanceof Error ? error.message : 'storage failure'}`) }
}

if (typeof window !== 'undefined') for (const event of ['mvlos:forget', 'mvlos:account-changed']) window.addEventListener(event, () => { grants.clear(); notifyGrants() })
if (typeof document !== 'undefined') {
  const dropTimedEvidence = () => { evidence.clear(); failures.clear(); notifyEvidence() }
  for (const event of ['visibilitychange', 'freeze', 'resume']) document.addEventListener(event, dropTimedEvidence)
  window.addEventListener('pageshow', dropTimedEvidence)
  window.addEventListener('online', dropTimedEvidence)
}
// A revocation this tab has not seen before (made here or synced from another device) also ends
// this tab's Allow once grants for that widget: Revoke trust stops it everywhere, at once.
const seenRevocations = new Set(Object.keys(canonicalTrust.get().revoked))
canonicalTrust.subscribe(() => {
  for (const r of Object.values(canonicalTrust.get().revoked)) if (!seenRevocations.has(r.id)) { seenRevocations.add(r.id); revokeSessionGrants(r.instance) }
})
