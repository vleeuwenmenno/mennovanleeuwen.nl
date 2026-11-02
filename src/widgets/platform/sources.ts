import { browserChangeAffects, browserChangedElsewhere, browserEntrySeq, browserFilesReady, browserStoreIdentity, listBrowser, mkdirBrowser, readBrowserText, realBrowserEntry, refreshBrowserTree, writeBrowserFile } from '../../data/browserfs'
import { browserMountPoint, isBind, isBrowserType, isSeafileType, mounts, posixOf, whereIs } from '../../data/mounts'
import { cachedListing, listDir, mkdir, parseSf, readText, sfPath, writeText } from '../../data/seafile'
import { getAccount } from '../../os/account'
import { accountGuard } from '../../os/accountSpace'
import { HOME, resolvePath } from '../../terminal/vfs'
import { defaultFiles } from './defaults'
import { buildPackage, LIMITS, relativePath, sourceIdentityOf, type Files, type Snapshot, type SourceIdentity } from './package'
import { trustedSourcePath } from './trust'
export const WIDGET_HOME = `${HOME}/.local/share/mvlos/widgets`
function account() {
  const a = getAccount()
  if (!accountGuard() || a.status !== 'user' || !a.user) throw new Error('Sign in to author widget sources')
  return a.user.id
}
export async function sourceIdentity(path: string): Promise<SourceIdentity> {
  await browserFilesReady()
  const uid = account()
  const absolute = resolvePath(HOME, path)
  if (absolute !== path) throw new Error('Use a canonical absolute source path')
  const where = whereIs(absolute)
  if (where.kind === 'browser') {
    const id = browserStoreIdentity()
    if (!id || id.account !== uid) throw new Error('Browser source store is unavailable')
    return { kind: 'browser', ...id, path: where.path }
  }
  if (where.kind === 'sf') {
    const at = parseSf(where.sf)
    if (!at || where.ro) throw new Error('Writable Seafile source required')
    return { kind: 'seafile', account: uid, repo: at.repo, path: at.p }
  }
  throw new Error('Source must be in signed-in browser files or Seafile')
}
/** Where a recorded source shows up in the file tree now, or null when it is not mounted anywhere. */
export function sourcePath(identity: SourceIdentity): string | null {
  if (identity.kind === 'system') return identity.path
  if (identity.kind === 'seafile') return posixOf(sfPath(identity.repo, identity.path))
  const root = browserMountPoint()
  return root === null ? null : identity.path === '/' ? root : `${root === '/' ? '' : root}${identity.path}`
}
export function assertSource(identity: SourceIdentity) {
  sourceIdentityOf(identity)
  if (identity.kind === 'system') return
  if (account() !== identity.account) throw new Error('Source account changed')
  if (identity.kind === 'browser') {
    const current = browserStoreIdentity()
    if (!current || current.account !== identity.account || current.storeUUID !== identity.storeUUID) throw new Error('Source store changed')
  }
}
const join = (root: string, part: string) => `${root === '/' ? '' : root}/${part}`
/** Direct backing reads avoid nested mount aliases changing identity halfway through a build. */
export async function readSource(identity: SourceIdentity): Promise<Files> {
  assertSource(identity)
  if (identity.kind === 'system') return defaultFiles(identity.path.split('/').pop()!)
  const guard = { check: () => assertSource(identity) }
  const files: Files = Object.create(null)
  let count = 0, bytes = 0
  const walk = async (path: string, prefix: string, depth: number) => {
    assertSource(identity)
    if (depth > 8) throw new Error('Source nesting limit')
    const entries = identity.kind === 'browser'
      ? listBrowser(path).map(e => ({ name: e.path.split('/').pop()!, dir: e.dir, size: e.size }))
      : (await listDir(sfPath(identity.repo, path), 0, guard)).entries
    for (const entry of entries) {
      assertSource(identity)
      const relative = relativePath(`${prefix}${entry.name}`)
      if (++count > LIMITS.files) throw new Error('Source file limit')
      if (relative === 'dist' || relative.startsWith('dist/') || relative === 'build.json') continue
      const next = join(path, entry.name)
      if (entry.dir) await walk(next, `${relative}/`, depth + 1)
      else {
        if (entry.size > LIMITS.fileBytes || (bytes += entry.size) > LIMITS.sourceBytes) throw new Error('Source size limit')
        files[relative] = identity.kind === 'browser' ? await readBrowserText(next) : await readText(sfPath(identity.repo, next), guard)
      }
    }
  }
  await walk(identity.path, '', 0)
  assertSource(identity)
  return files
}
/** Clones are idempotent only when every source byte already matches. Never overwrites edits. */
export const cloneDefault = (kind: string, target: string) => cloneFiles(defaultFiles(kind), target)
/** The starter for a new custom widget (src/widgets/packages/custom-template, also documented in SDK.md). */
export const cloneTemplate = (target: string) => cloneFiles(defaultFiles('custom-template'), target)
async function cloneFiles(files: Files, target: string) {
  const identity = await sourceIdentity(target)
  if (identity.kind === 'system') throw new Error('System sources are immutable')
  await buildPackage(files)
  const root = identity.path
  const guard = { check: () => assertSource(identity) }
  const folders = new Set<string>()
  for (const path of Object.keys(files)) {
    const all = join(root, path).split('/').slice(1, -1)
    all.forEach((_, index) => folders.add(`/${all.slice(0, index + 1).join('/')}`))
  }
  for (const folder of [...folders].sort((a, b) => a.length - b.length)) {
    assertSource(identity)
    if (identity.kind === 'browser') await mkdirBrowser(folder, true)
    else {
      // list before create: an existing folder is fine; permission/network failures are not.
      const parent = folder.replace(/\/[^/]+$/, '') || '/'
      const name = folder.split('/').pop()
      if (!(await listDir(sfPath(identity.repo, parent), 0, guard)).entries.some(e => e.name === name && e.dir)) await mkdir(sfPath(identity.repo, folder), guard)
    }
  }
  const existing = await readSource(identity)
  if (Object.entries(existing).some(([path, text]) => files[path] !== text)) throw new Error('Clone folder contains edits; choose another folder')
  for (const [path, text] of Object.entries(files)) {
    if (existing[path] === text) continue
    assertSource(identity)
    if (identity.kind === 'browser') await writeBrowserFile(join(root, path), text)
    else await writeText(sfPath(identity.repo, join(root, path)), text, guard)
  }
  assertSource(identity)
  if ((await buildPackage(await readSource(identity))).digest !== (await buildPackage(files)).digest) throw new Error('Clone verification failed')
  return identity
}

// --- the canonical gate for persistent trust -------------------------------------------------------

/** Why a trusted source is refused. `definitive`: the package itself is gone or changed in its own
 * storage (not merely unreachable, or mounted differently on this device). */
export class TrustRefusal extends Error {
  definitive: boolean
  constructor(message: string, definitive = false) { super(message); this.definitive = definitive; this.name = 'TrustRefusal' }
}
const stable = (v: unknown): string => Array.isArray(v) ? `[${v.map(stable).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}` : JSON.stringify(v) ?? 'null'
type Stored = Exclude<SourceIdentity, { kind: 'system' }>

/**
 * The synchronous part of the gate, from what this device knows now (no I/O):
 * - the path is exactly `${WIDGET_HOME}/<manifest id>`, with no `.`/`..` and nothing a resolver would rewrite;
 * - the mount holding it is the one on home itself: the signed-in browser store or a writable Seafile
 *   library, not a bind mount, not read-only, and nothing else is mounted inside the folder;
 * - the folder resolves to exactly the `source` the installation recorded, and maps back to the path.
 */
function locate(source: SourceIdentity, id: string): Stored {
  const uid = account()
  const path = `${WIDGET_HOME}/${id}`
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(id) || resolvePath(HOME, path) !== path || path.split('/').slice(1).some(p => !p || p === '.' || p === '..')) throw new TrustRefusal('This package id cannot name a widget folder')
  const all = mounts()
  let best: (typeof all)[number] | null = null
  for (const m of all) if (path === m.target || path.startsWith(m.target === '/' ? '/' : `${m.target}/`)) if (!best || m.target.length >= best.target.length) best = m
  if (best && isBind(best)) throw new TrustRefusal('Only a folder in home\'s own storage can be trusted, not one reached through a bind mount')
  if (!best || best.target !== HOME) throw new TrustRefusal(`Only a folder in home's own storage can be trusted; ${WIDGET_HOME} is on another mount here`)
  if (best.options.includes('ro')) throw new TrustRefusal('The widget folder is on a read-only mount')
  if (!isBrowserType(best) && !(isSeafileType(best) && best.source !== 'seafile')) throw new TrustRefusal('Home is not in browser files or a Seafile library')
  if (all.some(m => m !== best && (m.target === path || m.target.startsWith(`${path}/`)))) throw new TrustRefusal('Something else is mounted inside the widget folder')
  const where = whereIs(path)
  let identity: Stored
  if (where.kind === 'browser') {
    const store = browserStoreIdentity()
    if (!store || store.account !== uid) throw new TrustRefusal('Browser files are not available here')
    identity = { kind: 'browser', account: store.account, storeUUID: store.storeUUID, path: where.path }
  } else if (where.kind === 'sf') {
    const at = parseSf(where.sf)
    if (!at || where.ro) throw new TrustRefusal('The widget folder is in a read-only Seafile library')
    identity = { kind: 'seafile', account: uid, repo: at.repo, path: at.p }
  } else throw new TrustRefusal('Home is not in browser files or a Seafile library here')
  let recorded: SourceIdentity
  try { recorded = sourceIdentityOf(source) } catch { throw new TrustRefusal('Invalid source identity') }
  if (stable(identity) !== stable(recorded)) throw new TrustRefusal(`This widget was not built from ${path.replace(HOME, '~')} on this device's storage`)
  if (identity.path !== trustedSourcePath(id) || sourcePath(identity) !== path) throw new TrustRefusal('The widget folder also appears under another path')
  return identity
}

/** What the folder and its storage look like on this device now, without I/O: `ok` with a record to
 * compare against the last check, `unknown` when a Seafile listing is not cached here, or refused. */
export type Sighting = { state: 'ok'; seen: string } | { state: 'unknown' } | { state: 'refused'; reason: string; definitive: boolean }
export function sightTrustedSource(source: SourceIdentity, packageId: string): Sighting {
  try {
    const identity = locate(source, packageId)
    const entries = identity.kind === 'browser' ? browserEntries(identity) : seafileEntries(identity)
    if (entries === undefined) return { state: 'unknown' }
    const where = mounts().map(m => [m.source, m.target, m.type, m.options.join(',')])
    return { state: 'ok', seen: stable([where, identity, entries]) }
  } catch (error) {
    return { state: 'refused', reason: error instanceof Error ? error.message : 'This widget cannot be trusted here', definitive: error instanceof TrustRefusal && error.definitive }
  }
}
/** Each step from the store root is a stored folder; every entry inside is a stored plain file or
 * folder (never a launcher entry projected from the synced list). The store has no links. */
function browserEntries(identity: Stored): unknown[] | undefined {
  const parts = identity.path.split('/').filter(Boolean)
  // Another tab changed something on the way to the folder or in it: this tab's memory is stale until
  // the folder is read again from the store (unknown: nothing runs until the full check has done that).
  for (const marker of browserChangedElsewhere().keys()) if (browserChangeAffects(marker, identity.path)) return undefined
  const out: unknown[] = []
  for (let i = 0; i <= parts.length; i++) {
    const at = `/${parts.slice(0, i).join('/')}`
    const entry = realBrowserEntry(at)
    if (!entry) throw new TrustRefusal(i === parts.length ? 'The widget folder was deleted' : `${at} was deleted`, true)
    if (!entry.dir) throw new TrustRefusal(`${at} is not a stored folder`, true)
    // Every write here gets a new number, whatever size and time say (same-size writes, clock rollback).
    out.push([at, browserEntrySeq(at)])
  }
  const walk = (dir: string, depth: number) => {
    if (depth > 8) throw new TrustRefusal('Source nesting limit')
    for (const e of [...listBrowser(dir)].sort((a, b) => a.path < b.path ? -1 : 1)) {
      const real = realBrowserEntry(e.path)
      if (out.length >= LIMITS.files * 2) throw new TrustRefusal('Source file limit')
      if (!real || real.dir !== e.dir) throw new TrustRefusal(`${e.path} is not a stored file or folder`)
      out.push([real.path, real.dir, real.size, real.mtime, real.type, browserEntrySeq(real.path)])
      if (real.dir) walk(real.path, depth + 1)
    }
  }
  walk(identity.path, 0)
  return out
}
/** The same from Seafile listings cached on this device (the gate lists them fresh). Only dirents
 * Seafile reports as `dir` or `file`; anything else, or no type, is refused, never resolved. */
function seafileEntries(identity: Extract<Stored, { kind: 'seafile' }>): unknown[] | undefined {
  const parts = identity.path.split('/').filter(Boolean)
  const out: unknown[] = []
  for (let i = 0; i < parts.length; i++) {
    const parent = `/${parts.slice(0, i).join('/')}`
    const listing = cachedListing(sfPath(identity.repo, parent))
    if (!listing) return undefined
    const entry = listing.entries.find(e => e.name === parts[i])
    const at = `${parent === '/' ? '' : parent}/${parts[i]}`
    if (!entry) throw new TrustRefusal(i === parts.length - 1 ? 'The widget folder was deleted' : `${at} was deleted`, true)
    if (entry.type !== 'dir' || !entry.dir) throw new TrustRefusal(`${at} is not a plain Seafile folder`)
    out.push([at, entry.id, entry.type])
  }
  let unknown = false
  const walk = (dir: string, depth: number) => {
    if (depth > 8) throw new TrustRefusal('Source nesting limit')
    const listing = cachedListing(sfPath(identity.repo, dir))
    if (!listing) { unknown = true; return }
    if (depth === 0 && listing.perm !== 'rw') throw new TrustRefusal('Writable Seafile source required')
    out.push([dir, listing.perm])
    for (const e of [...listing.entries].sort((a, b) => a.name < b.name ? -1 : 1)) {
      if (out.length >= LIMITS.files * 2 + parts.length) throw new TrustRefusal('Source file limit')
      if (e.type !== (e.dir ? 'dir' : 'file')) throw new TrustRefusal(`${join(dir, e.name)} is not a plain Seafile file or folder`)
      out.push([join(dir, e.name), e.type, e.size, e.mtime, e.id])
      if (e.dir) walk(join(dir, e.name), depth + 1)
    }
  }
  walk(identity.path, 0)
  return unknown ? undefined : out
}
/** Reads the folder, its ancestors and its entries again from the browser's IndexedDB store. */
async function refreshFromStore(identity: Stored) {
  try { await refreshBrowserTree(identity.path) } catch (error) { throw new TrustRefusal(`The widget folder cannot be read again: ${error instanceof Error ? error.message : 'browser storage unavailable'}`) }
  assertSource(identity)
}
/** Lists the path down to the folder and everything inside it again, from Seafile itself. */
async function listFresh(identity: Extract<Stored, { kind: 'seafile' }>) {
  const guard = { check: () => assertSource(identity) }
  const parts = identity.path.split('/').filter(Boolean)
  try {
    for (let i = 0; i < parts.length; i++) {
      const listing = await listDir(sfPath(identity.repo, `/${parts.slice(0, i).join('/')}`), 0, guard)
      const entry = listing.entries.find(e => e.name === parts[i])
      if (!entry || !entry.dir) return
    }
    const walk = async (dir: string, depth: number) => {
      if (depth > 8) return
      const listing = await listDir(sfPath(identity.repo, dir), 0, guard)
      for (const e of listing.entries) if (e.dir && e.type === 'dir') await walk(join(dir, e.name), depth + 1)
    }
    await walk(identity.path, 0)
  } catch (error) { throw new TrustRefusal(`The widget folder cannot be listed: ${error instanceof Error ? error.message : 'Seafile unavailable'}`) }
}

/**
 * The full gate, with I/O: `snapshot` must be exactly what is in the widget's canonical folder
 * `${WIDGET_HOME}/<manifest id>` right now, in home's own storage (see locate and the entry rules
 * above), and building the folder again must give the same digest. Returns what it saw, for
 * sightTrustedSource to compare later. Throws TrustRefusal with a reason a person can act on.
 * The browser store has no links (every entry is a plain file or folder written by browserfs) and
 * Seafile libraries hold only files and folders, so a link is refused as an unknown entry type
 * rather than resolved.
 */
export async function trustGate(source: SourceIdentity, snapshot: Snapshot): Promise<{ identity: SourceIdentity; seen: string }> {
  await browserFilesReady()
  const id = snapshot.manifest.id
  const identity = locate(source, id)
  // Never from this tab's memory alone: the folder is read again from where it is stored.
  if (identity.kind === 'seafile') await listFresh(identity)
  else await refreshFromStore(identity)
  const before = sightTrustedSource(source, id)
  if (before.state === 'refused') throw new TrustRefusal(before.reason, before.definitive)
  if (before.state === 'unknown') throw new TrustRefusal('The widget folder could not be listed')
  let built: Snapshot
  try { built = await buildPackage(await readSource(identity)) } catch (error) { throw new TrustRefusal(`The widget folder does not build: ${error instanceof Error ? error.message : 'build failed'}`) }
  if (built.digest !== snapshot.digest) throw new TrustRefusal('The folder changed since this revision was built; build and activate it again')
  if (identity.kind === 'seafile') await listFresh(identity)
  else await refreshFromStore(identity)
  const after = sightTrustedSource(source, id)
  if (after.state !== 'ok' || after.seen !== before.seen) throw new TrustRefusal(after.state === 'refused' ? after.reason : 'The widget folder changed while it was being checked; try again', after.state === 'refused' && after.definitive)
  assertSource(identity)
  return { identity, seen: after.seen }
}
