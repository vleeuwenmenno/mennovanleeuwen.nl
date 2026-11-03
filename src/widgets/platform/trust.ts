import { record, sourceIdentityOf, type SourceIdentity } from './package.ts'

/**
 * Persistent "Trust always" for custom widgets. Pure data and merge rules: no React, no storage.
 *
 * A grant pins one installation exactly: the instance id, the package id, the source identity, the
 * snapshot digest and the installation identity it was made for. Anything else (an edit, a
 * recovered revision, another folder, a removed widget) simply does not match, and a grant that
 * does not match is ignored, never repaired.
 *
 * Revocation is causal, not timed. Every revocation has its own random id. A grant lists the ids of
 * every revocation of its instance that its device had observed when the person trusted it
 * (`after`). A grant counts only while every revocation of its instance is in that list, so:
 * - a revocation always defeats every grant made without seeing it (concurrent or stale), even if
 *   the clocks say the grant is newer;
 * - trusting again after a revocation works only on a device that has observed all current
 *   revocations of that instance;
 * - nothing ever removes a revocation, so a stale copy cannot bring a grant back.
 * `at` and `revokedAt` are informational only and never decide anything.
 */
export type TrustGrant = { id: string; instance: string; package: string; source: SourceIdentity; digest: string; installation: string; at: number; after: string[] }
export type TrustRevocation = { id: string; instance: string; revokedAt: number }
/** `floors`: per instance, the highest installation generation any grant was ever made for (a max
 * register). Grants below it are for installations that can never come back; keeping the floor
 * (rather than only dropping grants) makes pruning the same whichever order fragments merge in. */
export type TrustState = { grants: Record<string, TrustGrant>; revoked: Record<string, TrustRevocation>; floors?: Record<string, number> }

export const TRUST_LIMITS = Object.freeze({ grants: 64, revocationsPerInstance: 64, after: 64 })
const TRUST_ID = /^[a-f0-9-]{36}$/
const INSTANCE = /^[\w-]{1,80}$/
const PACKAGE = /^[a-z][a-z0-9-]{0,47}$/
const DIGEST = /^[a-f0-9]{64}$/
const time = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
const own = (v: object, key: string) => Object.hasOwn(v, key)
const put = <T>(out: Record<string, T>, key: string, value: T) => Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true })

export const emptyTrust = (): TrustState => ({ grants: {}, revoked: {} })
const generation = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0
/** Where a trusted package lives inside its storage: home's own `.local/share/mvlos/widgets/<package id>`. */
export const trustedSourcePath = (packageId: string) => `/.local/share/mvlos/widgets/${packageId}`

function grantOf(id: string, v: unknown): TrustGrant | null {
  if (!TRUST_ID.test(id) || !record(v) || v.id !== id || typeof v.instance !== 'string' || !INSTANCE.test(v.instance) || typeof v.package !== 'string' || !PACKAGE.test(v.package)) return null
  if (typeof v.digest !== 'string' || !DIGEST.test(v.digest) || typeof v.installation !== 'string' || v.installation.length > 4096 || !time(v.at)) return null
  if (!Array.isArray(v.after) || v.after.length > TRUST_LIMITS.after || v.after.some(r => typeof r !== 'string' || !TRUST_ID.test(r))) return null
  let source: SourceIdentity
  try { source = sourceIdentityOf(v.source) } catch { return null }
  if (source.kind === 'system' || Object.keys(v).some(k => !['id', 'instance', 'package', 'source', 'digest', 'installation', 'at', 'after'].includes(k))) return null
  return { id, instance: v.instance, package: v.package, source, digest: v.digest, installation: v.installation, at: v.at, after: [...new Set(v.after as string[])].sort() }
}
function revocationOf(id: string, v: unknown): TrustRevocation | null {
  if (!TRUST_ID.test(id) || !record(v) || v.id !== id || typeof v.instance !== 'string' || !INSTANCE.test(v.instance) || !time(v.revokedAt)) return null
  return { id, instance: v.instance, revokedAt: v.revokedAt }
}

/** Malformed entries carry no authority: a bad grant is dropped. A malformed revocation entry is
 * kept as a blocking revocation of its instance when the instance can still be read, so damage can
 * only take trust away. */
export function normalizeTrust(raw: unknown): TrustState {
  const out = emptyTrust()
  if (!record(raw)) return out
  if (record(raw.revoked)) for (const [id, v] of Object.entries(raw.revoked)) {
    const r = revocationOf(id, v)
    if (r) put(out.revoked, id, r)
    else if (TRUST_ID.test(id) && record(v) && typeof v.instance === 'string' && INSTANCE.test(v.instance)) put(out.revoked, id, { id, instance: v.instance, revokedAt: 0 })
  }
  if (record(raw.grants)) for (const [id, v] of Object.entries(raw.grants)) {
    const g = grantOf(id, v)
    if (g) put(out.grants, id, g)
  }
  if (record(raw.floors)) for (const [id, v] of Object.entries(raw.floors)) if (INSTANCE.test(id) && generation(v)) { out.floors ??= {}; put(out.floors, id, v) }
  return prune(out)
}

/** Revocations of one instance, by id. */
export const revocationsOf = (trust: TrustState, instance: string) => Object.values(trust.revoked).filter(r => r.instance === instance).map(r => r.id).sort()
/** Whether a grant has observed every current revocation of its instance. */
export const grantLive = (trust: TrustState, grant: TrustGrant) => revocationsOf(trust, grant.instance).every(id => grant.after.includes(id))

/** The installation generation a grant was made for (the first element of the installation identity). */
export function grantGeneration(g: TrustGrant): number {
  try { const v = JSON.parse(g.installation) as unknown; return Array.isArray(v) && Number.isSafeInteger(v[0]) && Number(v[0]) > 0 ? Number(v[0]) : 0 } catch { return 0 }
}
/**
 * Drops grants that can never count again, which changes nothing but size:
 * - a grant defeated by a revocation stays defeated forever (revocations are never removed);
 * - a grant for an older installation generation of its instance than another grant of that instance
 *   can never match again: installation generations only grow (a newer activation, recovery or
 *   removal always has a higher one), and a grant matches one exact installation identity.
 * Both rules depend only on the merged data, so every device prunes the same way.
 */
function prune(trust: TrustState): TrustState {
  // The floor folds in every grant's generation, live or not, before anything is dropped.
  const floors: Record<string, number> = {}
  for (const [id, n] of Object.entries(trust.floors ?? {})) put(floors, id, n)
  for (const g of Object.values(trust.grants)) { const n = grantGeneration(g); if (n > (own(floors, g.instance) ? floors[g.instance] : 0)) put(floors, g.instance, n) }
  const grants: Record<string, TrustGrant> = {}
  for (const [id, g] of Object.entries(trust.grants)) if (grantLive(trust, g) && grantGeneration(g) >= (own(floors, g.instance) ? floors[g.instance] : 0)) put(grants, id, g)
  return { grants, revoked: trust.revoked, ...(Object.keys(floors).length ? { floors } : {}) }
}

const stable = (v: unknown): string => Array.isArray(v) ? `[${v.map(stable).join(',')}]` : record(v) ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}` : JSON.stringify(v) ?? 'null'
/** Union of both sides; the same id is the same gesture, ties keep a stable data order. Commutative, associative, idempotent. */
export function mergeTrust(a: TrustState, b: TrustState): TrustState {
  const grants = { ...b.grants }, revoked = { ...b.revoked }
  for (const [id, g] of Object.entries(a.grants)) if (!own(grants, id) || stable(g) > stable(grants[id])) put(grants, id, g)
  for (const [id, r] of Object.entries(a.revoked)) {
    // The same revocation seen twice: keep the earliest informational time, deterministically.
    if (!own(revoked, id) || r.revokedAt < revoked[id].revokedAt || r.revokedAt === revoked[id].revokedAt && stable(r) > stable(revoked[id])) put(revoked, id, r)
  }
  const floors: Record<string, number> = { ...b.floors }
  for (const [id, n] of Object.entries(a.floors ?? {})) if (!own(floors, id) || n > floors[id]) put(floors, id, n)
  return prune({ grants, revoked, floors })
}
export const trustEmpty = (t: TrustState) => !Object.keys(t.grants).length && !Object.keys(t.revoked).length && !Object.keys(t.floors ?? {}).length

/** What a grant is checked against: the live installation, as the installation layer sees it now. */
export type TrustSubject = { instance: string; kind: string; package: string; source: SourceIdentity; digest: string; installation: string; account: number | null }
/** The live grant for exactly this installation, or null. Nothing here repairs or re-targets a grant. */
export function effectiveGrant(trust: TrustState, subject: TrustSubject): TrustGrant | null {
  if (subject.kind !== 'custom' || subject.account === null || subject.source.kind === 'system' || subject.source.account !== subject.account) return null
  if (subject.source.path !== trustedSourcePath(subject.package)) return null
  const source = stable(subject.source)
  for (const g of Object.values(trust.grants)) {
    if (g.instance !== subject.instance || g.package !== subject.package || g.digest !== subject.digest || g.installation !== subject.installation || stable(g.source) !== source) continue
    if (grantLive(trust, g)) return g
  }
  return null
}

/** A new grant made from what this device has observed now. */
/** `observed`: the revocations of the instance the person had seen when they clicked (captured at the
 * click, before any waiting). The grant records exactly those; one made meanwhile and not seen keeps
 * defeating it. Defaults to what `trust` holds, for callers that are the click itself. */
export function newGrant(trust: TrustState, subject: Omit<TrustSubject, 'kind' | 'account'>, id: string, at: number, observed?: readonly string[]): TrustGrant {
  const after = observed ? [...observed] : revocationsOf(trust, subject.instance)
  if (after.length > TRUST_LIMITS.after) throw new Error('This widget was revoked too many times to trust it again; remove it and make a new one')
  // This instance's own earlier grants are for older installations and are dropped when this one merges.
  if (Object.values(trust.grants).filter(g => g.instance !== subject.instance).length >= TRUST_LIMITS.grants) throw new Error('Too many trusted widgets; revoke one first')
  const grant = grantOf(id, { id, instance: subject.instance, package: subject.package, source: subject.source, digest: subject.digest, installation: subject.installation, at, after })
  if (!grant) throw new Error('Invalid trust record')
  return grant
}
export const newRevocation = (instance: string, id: string, revokedAt: number): TrustRevocation => {
  const r = revocationOf(id, { id, instance, revokedAt })
  if (!r) throw new Error('Invalid trust revocation')
  return r
}
