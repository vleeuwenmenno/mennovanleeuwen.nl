import { defaultBuild, isBuiltin } from './defaults'
import { synced } from '../../os/synced'
import { getAccount } from '../../os/account'
import { accountGuard } from '../../os/accountSpace'
import { record, verifySnapshot, type Snapshot, type SourceIdentity } from './package'
import { assertSource } from './sources'
export type Revision = { source: SourceIdentity; snapshot: Snapshot }
export type Installation = { schema: 1; instance: string; kind: 'weather' | 'sticky'; generation: number; active: Revision; previous?: Revision }
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
  if (!record(raw)) return {}
  const out: Installations = {}
  for (const [id, value] of Object.entries(raw).slice(0, 32)) {
    if (/^[\w-]{1,80}$/.test(id) && record(value) && value.schema === 1 && value.instance === id && ['weather', 'sticky'].includes(String(value.kind)) && Number.isSafeInteger(value.generation) && Number(value.generation) > 0 && record(value.active) && record(value.active.source) && record(value.active.snapshot)) out[id] = value as Installation
  }
  return out
}
export const installations = synced<Installations>('widgets:packages:v1', {}, { normalize, merge: mergeInstallations, mergeTabs: true })
export const installation = (id: string) => installations.get()[id]
export async function activate(instance: string, kind: Installation['kind'], revision: Revision, expectedGeneration: number) {
  assertSource(revision.source)
  if (!accountGuard() || !getAccount().user) throw new Error('Sign in to install a package')
  const account = getAccount().user!.id
  if (!/^[\w-]{1,80}$/.test(instance) || !['weather', 'sticky'].includes(kind) || !Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) throw new Error('Invalid installation identity')
  const snapshot = await verifySnapshot(revision.snapshot)
  if (snapshot.manifest.capabilities.some(c => !(kind === 'sticky' ? ['note.read', 'note.write'] : ['weather.read']).includes(c))) throw new Error('Capabilities do not match instance resource')
  assertSource(revision.source)
  if (!accountGuard() || getAccount().user?.id !== account) throw new Error('Account changed')
  const fallback = { source: { kind: 'system' as const, path: `/usr/share/mvlos/widgets/${kind}` }, snapshot: await defaultBuild(kind) }
  assertSource(revision.source)
  if (!accountGuard() || getAccount().user?.id !== account) throw new Error('Account changed')
  let conflict = false
  installations.set(all => {
    const current = all[instance]
    if (current?.active.snapshot.digest === snapshot.digest && JSON.stringify(current.active.source) === JSON.stringify(revision.source)) return all
    if ((current?.generation ?? 0) !== expectedGeneration) { conflict = true; return all }
    if (!current && Object.keys(all).length >= 12) { conflict = true; return all }
    const next: Installations = { ...all, [instance]: { schema: 1, instance, kind, generation: expectedGeneration + 1, active: { source: revision.source, snapshot }, previous: current?.active ?? fallback } }
    if (new TextEncoder().encode(JSON.stringify(next)).length > 480 * 1024) { conflict = true; return all }
    return next
  })
  if (conflict) throw new Error('Installation changed; reload before activating')
}
export async function recover(instance: string, expectedGeneration: number) {
  const current = installation(instance)
  if (!current?.previous || current.generation !== expectedGeneration) throw new Error('Previous revision unavailable or installation changed')
  await activate(instance, current.kind, current.previous, expectedGeneration)
}
/** Identity grants are local to this live account session, never accepted from imported/synced files. */
const grants = new Set<string>()
const grantKey = (instance: string, revision: Revision) => JSON.stringify([getAccount().user?.id ?? 'guest', instance, revision.source, revision.snapshot.digest])
export function allowRevision(instance: string, revision: Revision) {
  assertSource(revision.source)
  if (!accountGuard()) throw new Error('Account revoked')
  grants.add(grantKey(instance, revision))
}
export function hasGrant(instance: string, revision: Revision) {
  try { assertSource(revision.source) } catch { return false }
  return accountGuard() && (revision.source.kind === 'system' && isBuiltin(revision.source.path, revision.snapshot.digest) || grants.has(grantKey(instance, revision)))
}
export const revokeRevision = (instance: string, revision: Revision) => grants.delete(grantKey(instance, revision))

if (typeof window !== 'undefined') window.addEventListener('mvlos:forget', () => grants.clear())
