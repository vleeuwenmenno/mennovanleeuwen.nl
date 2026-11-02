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
export type TrustState = { grants: Record<string, TrustGrant>; revoked: Record<string, TrustRevocation> }

export const TRUST_LIMITS = Object.freeze({ grants: 64, revocationsPerInstance: 64, after: 64 })
const TRUST_ID = /^[a-f0-9-]{36}$/
const INSTANCE = /^[\w-]{1,80}$/
const PACKAGE = /^[a-z][a-z0-9-]{0,47}$/
const DIGEST = /^[a-f0-9]{64}$/
const time = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
const own = (v: object, key: string) => Object.hasOwn(v, key)
const put = <T>(out: Record<string, T>, key: string, value: T) => Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true })

export const emptyTrust = (): TrustState => ({ grants: {}, revoked: {} })
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
  return prune(out)
}

/** Revocations of one instance, by id. */
export const revocationsOf = (trust: TrustState, instance: string) => Object.values(trust.revoked).filter(r => r.instance === instance).map(r => r.id).sort()
/** Whether a grant has observed every current revocation of its instance. */
export const grantLive = (trust: TrustState, grant: TrustGrant) => revocationsOf(trust, grant.instance).every(id => grant.after.includes(id))

/** Grants defeated by a revocation stay defeated forever (revocations are never removed), so dropping them changes nothing but size. */
function prune(trust: TrustState): TrustState {
  const grants: Record<string, TrustGrant> = {}
  for (const [id, g] of Object.entries(trust.grants)) if (grantLive(trust, g)) put(grants, id, g)
  return { grants, revoked: trust.revoked }
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
  return prune({ grants, revoked })
}
export const trustEmpty = (t: TrustState) => !Object.keys(t.grants).length && !Object.keys(t.revoked).length

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
export function newGrant(trust: TrustState, subject: Omit<TrustSubject, 'kind' | 'account'>, id: string, at: number): TrustGrant {
  const after = revocationsOf(trust, subject.instance)
  if (after.length > TRUST_LIMITS.after) throw new Error('This widget was revoked too many times to trust it again; remove it and make a new one')
  if (Object.keys(trust.grants).length >= TRUST_LIMITS.grants) throw new Error('Too many trusted widgets; revoke one first')
  const grant = grantOf(id, { id, instance: subject.instance, package: subject.package, source: subject.source, digest: subject.digest, installation: subject.installation, at, after })
  if (!grant) throw new Error('Invalid trust record')
  return grant
}
export const newRevocation = (instance: string, id: string, revokedAt: number): TrustRevocation => {
  const r = revocationOf(id, { id, instance, revokedAt })
  if (!r) throw new Error('Invalid trust revocation')
  return r
}
