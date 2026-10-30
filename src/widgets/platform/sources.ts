import { browserFilesReady, browserStoreIdentity, listBrowser, mkdirBrowser, readBrowserText, writeBrowserFile } from '../../data/browserfs'
import { whereIs } from '../../data/mounts'
import { listDir, mkdir, parseSf, readText, sfPath, writeText } from '../../data/seafile'
import { getAccount } from '../../os/account'
import { accountGuard } from '../../os/accountSpace'
import { HOME, resolvePath } from '../../terminal/vfs'
import { defaultFiles } from './defaults'
import { buildPackage, LIMITS, relativePath, sourceIdentityOf, type Files, type SourceIdentity } from './package'
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
