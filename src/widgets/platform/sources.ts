import { browserFilesReady, browserStoreIdentity, listBrowser, mkdirBrowser, readBrowserText, realBrowserEntry, writeBrowserFile } from '../../data/browserfs'
import { browserMountPoint, isBind, isBrowserType, isSeafileType, mounts, posixOf, whereIs } from '../../data/mounts'
import { listDir, mkdir, parseSf, readText, sfPath, writeText } from '../../data/seafile'
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

/**
 * Throws, with the reason a person can act on, unless `snapshot` is exactly what is in the widget's
 * canonical folder `${WIDGET_HOME}/<manifest id>` right now, in home's own storage:
 * - the path is that exact string, with no `.`/`..` and nothing a resolver would rewrite;
 * - the mount that holds it is the one on home itself: the signed-in browser store or a writable
 *   Seafile library, not a bind mount, not read-only, and nothing else is mounted inside the folder;
 * - its source identity resolves to the `source` the installation recorded, and maps back to the path;
 * - every folder from the storage root down, and every entry inside, is a stored plain folder or
 *   file: no projected launcher entries in the browser store, and only Seafile dirents whose
 *   reported type is `file` or `dir` (anything else, or no type at all, is refused);
 * - building the folder again gives the same digest.
 * The browser store has no links (every entry is a plain file or folder written by browserfs) and
 * Seafile libraries hold only files and folders, so a link is refused as an unknown entry type
 * rather than resolved.
 */
export async function trustGate(source: SourceIdentity, snapshot: Snapshot): Promise<SourceIdentity> {
  await browserFilesReady()
  account()
  const id = snapshot.manifest.id
  const path = `${WIDGET_HOME}/${id}`
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(id) || resolvePath(HOME, path) !== path || path.split('/').slice(1).some(p => !p || p === '.' || p === '..')) throw new Error('This package id cannot name a widget folder')
  const all = mounts()
  let best: (typeof all)[number] | null = null
  for (const m of all) if (path === m.target || path.startsWith(m.target === '/' ? '/' : `${m.target}/`)) if (!best || m.target.length >= best.target.length) best = m
  if (best && isBind(best)) throw new Error('Only a folder in home\'s own storage can be trusted, not one reached through a bind mount')
  if (!best || best.target !== HOME) throw new Error(`Only a folder in home's own storage can be trusted; ${WIDGET_HOME} is on another mount here`)
  if (best.options.includes('ro')) throw new Error('The widget folder is on a read-only mount')
  if (!isBrowserType(best) && !(isSeafileType(best) && best.source !== 'seafile')) throw new Error('Home is not in browser files or a Seafile library')
  if (all.some(m => m !== best && (m.target === path || m.target.startsWith(`${path}/`)))) throw new Error('Something else is mounted inside the widget folder')
  const identity = await sourceIdentity(path)
  if (JSON.stringify(identity) !== JSON.stringify(sourceIdentityOf(source))) throw new Error(`This widget was not built from ${path.replace(HOME, '~')}; build it from there to trust it`)
  if (identity.kind === 'system' || identity.path !== trustedSourcePath(id) || sourcePath(identity) !== path) throw new Error('The widget folder also appears under another path')
  await plainEntries(identity)
  const built = await buildPackage(await readSource(identity))
  if (built.digest !== snapshot.digest) throw new Error('The folder changed since this revision was built; build and activate it again')
  assertSource(identity)
  return identity
}
/** Each step below the storage root is a stored plain folder; each entry inside is a plain file or folder. */
async function plainEntries(identity: Exclude<SourceIdentity, { kind: 'system' }>) {
  const parts = identity.path.split('/').filter(Boolean)
  let count = 0
  if (identity.kind === 'browser') {
    for (let i = 0; i <= parts.length; i++) {
      const at = `/${parts.slice(0, i).join('/')}`
      if (!realBrowserEntry(at)?.dir) throw new Error(`${at} is not a stored folder`)
    }
    const walk = (dir: string, depth: number) => {
      if (depth > 8) throw new Error('Source nesting limit')
      for (const e of listBrowser(dir)) {
        const real = realBrowserEntry(e.path)
        if (++count > LIMITS.files) throw new Error('Source file limit')
        if (!real || real.dir !== e.dir) throw new Error(`${e.path} is not a stored file or folder`)
        if (e.dir) walk(e.path, depth + 1)
      }
    }
    walk(identity.path, 0)
    assertSource(identity)
    return
  }
  const guard = { check: () => assertSource(identity) }
  for (let i = 0; i < parts.length; i++) {
    const parent = `/${parts.slice(0, i).join('/')}`
    const listing = await listDir(sfPath(identity.repo, parent), 0, guard)
    const entry = listing.entries.find(e => e.name === parts[i])
    if (!entry || entry.type !== 'dir' || !entry.dir) throw new Error(`${parent === '/' ? '' : parent}/${parts[i]} is not a plain Seafile folder`)
  }
  const walk = async (dir: string, depth: number, top: boolean) => {
    if (depth > 8) throw new Error('Source nesting limit')
    const listing = await listDir(sfPath(identity.repo, dir), 0, guard)
    if (top && listing.perm !== 'rw') throw new Error('Writable Seafile source required')
    for (const e of listing.entries) {
      if (++count > LIMITS.files) throw new Error('Source file limit')
      if (e.type !== (e.dir ? 'dir' : 'file')) throw new Error(`${join(dir, e.name)} is not a plain Seafile file or folder`)
      if (e.dir) await walk(join(dir, e.name), depth + 1, false)
    }
  }
  await walk(identity.path, 0, true)
  assertSource(identity)
}
