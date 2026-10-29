import { browserFilesReady, browserText, listBrowser, mkdirBrowser, readBrowserBlob, readBrowserText, removeBrowser, setBrowserMode, statBrowser, transferBrowser, writeBrowserFile } from '../data/browserfs'
import { browserMountPoint, getFstab, isSeafileType, libraryNames, mounts, setFstab, whereIs } from '../data/mounts'
import { cachedDir, createFile, deleteItems, errorStatus, getLibraries, historyDays, listDir, loadLibraries, mkdir as sfMkdir, parseSf, readBlob, readText, renameItem, SF, sfPath, transferItems, uploadBlob, writeText, type Entry } from '../data/seafile'
import { getAccount } from '../os/account'
import { writeTmp } from './commands'
import { CmdError, DeniedError } from './types'
import { writeError } from './devices'
import { cvMode } from '../os/cvMode'
import { keptRc, RC_NAME, RC_PATH, setKeptRc } from './rcfile'
import { HOME, kindOfName, lookup as siteLookup, resolvePath, type DirNode, type FileNode, type Node } from './vfs'
import { allows, carrySfModes, dropSfModes, setSfMode, sfModeOf, userOwns, type Access } from './modes'

// The filesystem as the terminal sees it: the site's own files (vfs.ts), with whatever /etc/fstab
// mounts on top (data/mounts.ts): Seafile libraries under /mnt/seafile, a library on ~, bind
// mounts. Commands are synchronous, so before one runs, prepare() fetches the Seafile folders (and,
// for cat, grep and friends, the file contents) it is going to need; lookup() then answers from
// those caches. Writing (>, touch, mkdir, rm, mv, cp, nano) goes straight to Seafile.
//
// Signed in, the files kept in this browser (data/browserfs.ts) are mounted too, on ~ while home
// is not in Seafile. That mount lies over the site's own home (README.md, games/, the pictures):
// those stay readable, and what you write lands in the browser, over them where names meet.

/** File contents fetched for commands, by Seafile path, with the mtime they were read at. */
const texts = new Map<string, { text: string; mtime: number }>()
/** The biggest file cat, grep and nano read whole. */
export const MAX_TEXT = 2 * 1024 * 1024
/** For grep -r and friends: per file, and how many files and folders at most. */
const MAX_RECURSIVE_TEXT = 512 * 1024
const MAX_DIRS = 400
const MAX_FILES = 300

const parentOf = (path: string) => path.replace(/\/[^/]*$/, '') || '/'
const baseOf = (path: string) => path.split('/').pop() || '/'
const join = (dir: string, name: string) => (dir === '/' ? `/${name}` : `${dir}/${name}`)

/** A Seafile path's parent folder (null for a library itself). */
function sfParent(sf: string): string | null {
  const at = parseSf(sf)
  if (!at || at.p === '/') return null
  return sfPath(at.repo, at.p.split('/').slice(0, -1).join('/') || '/')
}

/** What the parent folder's listing says about a Seafile path, if it is in the cache. */
function sfEntry(sf: string): Entry | null | undefined {
  const parent = sfParent(sf)
  if (!parent) return undefined
  const hit = cachedDir(parent)
  if (!hit?.listing) return undefined
  return hit.listing.entries.find((e) => e.name === baseOf(parseSf(sf)!.p)) ?? null
}

function sfFile(sf: string, e: Entry, ro: boolean): FileNode {
  return { type: 'file', name: e.name, sf, ro, size: e.size, mtime: e.mtime, mode: sfModeOf(sf), content: () => texts.get(sf)?.text ?? '' }
}

function sfDir(sf: string, name: string, ro: boolean): DirNode {
  if (sf === SF)
    return {
      type: 'dir',
      name,
      sf,
      ro: true,
      get children() {
        const out = new Map<string, Node>()
        const names = libraryNames()
        for (const l of getLibraries() ?? []) out.set(names.get(l.id)!, sfDir(sfPath(l.id), names.get(l.id)!, l.permission === 'r'))
        return out
      },
    }
  return {
    type: 'dir',
    name,
    sf,
    ro,
    mode: sfModeOf(sf),
    get children() {
      const out = new Map<string, Node>()
      const listing = cachedDir(sf)?.listing
      const readOnly = ro || listing?.perm === 'r'
      for (const e of listing?.entries ?? []) out.set(e.name, e.dir ? sfDir(`${sf}/${e.name}`, e.name, readOnly) : sfFile(`${sf}/${e.name}`, e, readOnly))
      return out
    },
  }
}

/** A Seafile path as a node, from the caches; null when it is not there (or not fetched). */
function sfNode(sf: string, name: string, ro: boolean): Node | null {
  if (sf === SF) return sfDir(sf, name, true)
  const at = parseSf(sf)!
  const lib = getLibraries()?.find((l) => l.id === at.repo)
  if (getLibraries() && !lib) return null
  const readOnly = ro || lib?.permission === 'r'
  if (at.p === '/') return sfDir(sf, name, readOnly)
  const e = sfEntry(sf)
  if (e) return e.dir ? sfDir(sf, name, readOnly) : sfFile(sf, e, readOnly)
  if (e === null) return null
  return cachedDir(sf)?.listing ? sfDir(sf, name, readOnly) : null
}

/**
 * A path on the browser mount: the browser's file or folder, laid over whatever the site has at
 * the same place (a folder shows both; the browser's wins where names meet). The site's own
 * files there stay read-only: they have no `browser` field.
 */
function browserNode(abs: string, path: string): Node | null {
  const e = statBrowser(path)
  const site = siteLookup(abs)
  if (!e) return site
  const name = abs === '/' ? '' : baseOf(abs)
  if (!e.dir) return { type: 'file', name, browser: path, size: e.size, mtime: e.mtime, mode: e.mode, content: () => browserText(path) ?? '' }
  return {
    type: 'dir',
    name,
    browser: path,
    mtime: e.mtime,
    mode: e.mode,
    get children() {
      const out = new Map<string, Node>(site?.type === 'dir' ? site.children : [])
      for (const child of listBrowser(path)) {
        const n = browserNode(join(abs, baseOf(child.path)), child.path)
        if (n) out.set(baseOf(child.path), n)
      }
      return out
    },
  }
}

/** ~/.mvshrc where home is read-only: kept in this browser (rcfile.ts). */
function keptRcNode(): FileNode {
  const text = keptRc() ?? ''
  return { type: 'file', name: RC_NAME, ro: false, size: new TextEncoder().encode(text).length, content: () => keptRc() ?? '' }
}

/** Names a folder gains on top of its own: mount points right inside it. */
function extraChildren(abs: string): Map<string, Node> {
  const out = new Map<string, Node>()
  if (abs === HOME && keptRc() !== null && whereIs(RC_PATH).kind === 'local') out.set(RC_NAME, keptRcNode())
  for (const m of mounts()) {
    if (m.target === abs || parentOf(m.target) !== abs) continue
    const node = lookup(m.target)
    if (node) out.set(baseOf(m.target), node)
  }
  return out
}

/** Looks a path up through the mounts. */
export function lookup(abs: string): Node | null {
  const w = whereIs(abs)
  if (abs === '/etc/fstab' && w.kind === 'local') {
    const node = siteLookup(abs) as FileNode
    return { ...node, size: new TextEncoder().encode(node.content()).length, ro: true }
  }
  if (abs === RC_PATH && w.kind === 'local' && keptRc() !== null) return keptRcNode()
  let node: Node | null = w.kind === 'local' ? siteLookup(w.path) : w.kind === 'sf' ? sfNode(w.sf, abs === '/' ? '' : baseOf(abs), w.ro) : w.kind === 'browser' ? browserNode(abs, w.path) : null
  // A mount point that only exists because something is mounted on it.
  if (!node && mounts().some((m) => m.target === abs)) node = { type: 'dir', name: baseOf(abs), children: new Map() }
  if (node?.type !== 'dir') return node
  const extra = extraChildren(abs)
  if (!extra.size) return node
  const base = node
  return {
    ...base,
    get children() {
      return new Map([...base.children, ...extra])
    },
  }
}

/** Every path under a folder (find, grep -r), through the mounts; Seafile folders as far as fetched. */
export function walk(path: string, node: Node | null = lookup(path), depth = 0): string[] {
  if (!node) return []
  if (node.type === 'file' || depth > 40) return [path]
  const out = [path]
  for (const name of node.children.keys()) {
    const child = join(path, name)
    out.push(...walk(child, lookup(child), depth + 1))
  }
  return out
}

/** Where a path lives, in words, for errors: read-only, in Seafile, or here. */
export function sfOf(abs: string): { sf: string; ro: boolean } | null {
  const w = whereIs(abs)
  return w.kind === 'sf' ? { sf: w.sf, ro: w.ro } : null
}

// --- fetching ahead -------------------------------------------------------------------------------

/** Commands that read the contents of the files they are given. */
const READERS = new Set(['cat', 'less', 'more', 'head', 'tail', 'wc', 'grep', 'egrep', 'sort', 'uniq', 'jq', 'sha1sum', 'sha256sum', 'sha512sum', 'md5sum', 'nano', 'cp', 'diff', 'base64'])
/** Commands that look after themselves (sudo runs its command, which is prepared then). */
const SELF_SERVED = new Set(['fscrypt', 'mount', 'umount', 'findmnt', 'lsblk', 'sudo', 'echo', 'man', 'help', 'clear', 'history', 'visited'])
const ALWAYS_RECURSIVE = new Set(['find', 'fd', 'tree', 'du'])
const MAYBE_RECURSIVE = new Set(['grep', 'egrep', 'ls', 'rm', 'cp', 'chmod'])

const usesSeafile = () => mounts().some((m) => isSeafileType(m) || m.options.includes('bind'))

class FsError extends CmdError {}

/** Fetches one Seafile folder; a locked library or a dead connection is an error for `cmd`. */
async function fetchDir(sf: string, cmd: string, arg: string | null) {
  try {
    await listDir(sf)
    return true
  } catch (e) {
    const status = errorStatus(e)
    if (!arg || status === 404) return false
    if (status === 423) throw new FsError(`${cmd}: cannot access '${arg}': Required key not available`)
    throw new FsError(`${cmd}: cannot access '${arg}': Transport endpoint is not connected`)
  }
}

async function fetchText(sf: string, e: Entry) {
  const hit = texts.get(sf)
  if (hit && hit.mtime === e.mtime) return
  texts.set(sf, { text: await readText(sf), mtime: e.mtime })
}

/** One path: its folder's listing, its own if it is a folder, and its text if `read`. */
async function ensure(abs: string, cmd: string, arg: string | null, read: boolean): Promise<string | null> {
  let w = whereIs(abs)
  if (w.kind === 'missing' && w.loading) {
    await loadLibraries()
    w = whereIs(abs)
  }
  if (w.kind !== 'sf' || w.sf === SF) return null
  const parent = sfParent(w.sf)
  if (parent && !(await fetchDir(parent, cmd, arg))) return null
  const e = sfEntry(w.sf)
  if (!parent || e?.dir) {
    await fetchDir(w.sf, cmd, arg)
    return w.sf
  }
  if (e && read && e.size <= MAX_TEXT) await fetchText(w.sf, e).catch(() => {})
  return null
}

/** Everything under a Seafile folder, breadth first, as far as the limits go. */
async function ensureTree(root: string, cmd: string, read: boolean) {
  const queue = [root]
  let dirs = 0
  let files = 0
  while (queue.length && dirs < MAX_DIRS) {
    const batch = queue.splice(0, 6)
    dirs += batch.length
    await Promise.all(
      batch.map(async (sf) => {
        if (!(await fetchDir(sf, cmd, null))) return
        for (const e of cachedDir(sf)?.listing?.entries ?? []) {
          const child = `${sf}/${e.name}`
          if (e.dir) queue.push(child)
          else if (read && files < MAX_FILES && e.size <= MAX_RECURSIVE_TEXT && ['text', 'markdown', 'link'].includes(kindOfName(e.name))) {
            files++
            await fetchText(child, e).catch(() => {})
          }
        }
      }),
    )
  }
}

/**
 * Before a command runs: fetches what it will look at in Seafile. Paths in its arguments (and the
 * working folder), their contents for commands that read files, and whole trees for find, fd,
 * tree and -r. Throws the command's own error for a locked library or a lost connection.
 */
export async function prepare(cwd: string, cmd: string, args: string[]) {
  // These commands accept data arguments only; never interpret them as filesystem paths.
  // When combining with the actor-policy branch, retain its checkActor before this return.
  if (cmd === 'jq-safe' || cmd === 'mvl') return
  // The browser's files load once, right after sign-in; the first command waits for that.
  if (browserMountPoint()) await browserFilesReady()
  if (!usesSeafile() || !getAccount().seafile || SELF_SERVED.has(cmd)) return
  if (!getLibraries()) await loadLibraries()
  const read = READERS.has(cmd)
  const recursive = ALWAYS_RECURSIVE.has(cmd) || (MAYBE_RECURSIVE.has(cmd) && args.some((a) => /^-[a-zA-Z]*[rR]/.test(a) || a === '--recursive'))
  await ensure(cwd, cmd, null, false)
  const roots: string[] = []
  for (const a of args) {
    if (!a || (a.startsWith('-') && a !== '-')) continue
    const abs = resolvePath(cwd, a)
    const dir = await ensure(abs, cmd, a, read)
    if (dir || lookup(abs)?.type === 'dir') roots.push(abs)
  }
  if (!recursive) return
  if (!roots.length) roots.push(cwd)
  // Seafile under each starting point: the point itself, and anything mounted below it.
  const trees = new Set<string>()
  for (const r of roots) {
    const w = whereIs(r)
    if (w.kind === 'sf') trees.add(w.sf)
    for (const m of mounts()) {
      if (!(r === '/' || m.target.startsWith(`${r}/`))) continue
      const mw = whereIs(m.target)
      if (mw.kind === 'sf') trees.add(mw.sf)
    }
  }
  for (const t of trees) {
    if (t === SF) for (const l of getLibraries() ?? []) await ensureTree(sfPath(l.id), cmd, read && cmd === 'grep')
    else await ensureTree(t, cmd, read && (cmd === 'grep' || cmd === 'egrep'))
  }
}

/** Tab completion's folder, fetched so the picker can list it. */
export async function prepareFolder(abs: string) {
  if (!usesSeafile() || !getAccount().seafile) return
  await ensure(abs, 'complete', null, false).catch(() => {})
}

/** A Seafile file's text for an editor: fetched now, whatever its age. */
export async function readFileText(abs: string, root = false): Promise<{ text: string; ro: boolean } | null> {
  const node = lookup(abs)
  if (!node || node.type !== 'file') return null
  // A mode set with chmod can forbid the read; the callers that show it say so (DeniedError).
  if (!allows(abs, node, 'r', root)) throw new DeniedError('Permission denied')
  if (node.browser) return { text: await readBrowserText(node.browser), ro: false }
  // The site's own files under the browser mount: readable, and saving makes the browser's copy.
  if (!node.sf) return { text: node.content(), ro: abs !== '/etc/fstab' && abs !== RC_PATH && !abs.startsWith('/tmp/') && whereIs(abs).kind !== 'browser' }
  const text = await readText(node.sf)
  texts.set(node.sf, { text, mtime: node.mtime ?? 0 })
  return { text, ro: !!node.ro }
}

// --- writing --------------------------------------------------------------------------------------

const err = (msg: string) => new CmdError(msg)

/**
 * Refuses (Permission denied) when a path's mode, set by chmod, does not allow `access`. Paths
 * that do not exist are not this check's business; root passes.
 */
function need(abs: string, access: Access, what: string, root?: boolean) {
  const node = lookup(abs)
  if (node && !allows(abs, node, access, root)) throw err(`${what}: Permission denied`)
}

/** Writing a new name or removing one needs write permission on the folder it is in. */
const needParent = (abs: string, what: string, root?: boolean) => need(parentOf(abs), 'w', what, root)

/** Whether a file's mode can be set where it lives, and the error to give where it cannot. */
export async function setMode(abs: string, mode: number | null, root = false): Promise<void> {
  const node = lookup(abs)
  if (!node) throw err(`chmod: cannot access '${abs}': No such file or directory`)
  const w = whereIs(abs)
  const refuse = (why: string) => err(`chmod: changing permissions of '${abs}': ${why}`)
  if (w.kind === 'missing') throw refuse('Transport endpoint is not connected')
  if (node.browser) {
    await setBrowserMode(node.browser, mode).catch(() => {
      throw refuse('Operation not permitted')
    })
    return
  }
  if (node.sf && !node.ro && node.sf !== SF) return setSfMode(node.sf, mode)
  if (w.kind === 'local' && abs.startsWith('/tmp/')) {
    const kept = siteLookup(abs)
    if (kept) kept.mode = mode ?? undefined
    return
  }
  // The site's own files, /bin, /etc, read-only libraries: nothing here can be changed.
  throw refuse(!root && !userOwns(abs, node) ? 'Operation not permitted' : 'Read-only file system')
}

/** Writes a file: /tmp, Seafile, or /etc/fstab (root only). `append` adds to the end, like >>. */
export async function writeFile(cwd: string, target: string, content: string, append: boolean, root = false, who = 'msh') {
  const abs = resolvePath(cwd, target)
  // A device swallows what is written to it (the disks refuse it).
  const written = abs.startsWith('/dev/') ? lookup(abs) : null
  if (written?.type === 'file' && written.dev) {
    const refused = writeError(who, target, written.dev, root)
    if (refused) throw refused
    return
  }
  if (abs === '/etc/fstab') {
    if (!root) throw err(`${who}: permission denied: ${target}`)
    setFstab(append ? `${getFstab().replace(/\n?$/, '\n')}${content}` : content)
    return
  }
  const w = whereIs(abs)
  if (w.kind === 'missing') throw err(`${who}: ${target}: Transport endpoint is not connected`)
  if (lookup(abs)) need(abs, 'w', `${who}: ${target}`, root)
  else needParent(abs, `${who}: ${target}`, root)
  if (abs === RC_PATH && w.kind === 'local' && !cvMode()) {
    const prev = keptRc()
    const body = content && !content.endsWith('\n') ? `${content}\n` : content
    setKeptRc(append && prev ? (prev.endsWith('\n') ? prev + body : `${prev}\n${body}`) : body)
    return
  }
  if (w.kind === 'local') return writeTmp('/', w.path, content, append, root, who)
  if (w.kind === 'browser') {
    await browserFilesReady()
    const node = lookup(abs)
    if (node?.type === 'dir') throw err(`${who}: is a directory: ${target}`)
    await browserFolder(parentOf(abs), who, target)
    const body = content && !content.endsWith('\n') ? `${content}\n` : content
    let text = body
    if (append && node) {
      const prev = node.browser ? await readBrowserText(node.browser) : node.content()
      text = prev && !prev.endsWith('\n') ? `${prev}\n${body}` : prev + body
    }
    await writeBrowserFile(w.path, text).catch(asCmdError(who))
    return
  }
  if (w.ro || w.sf === SF) throw err(`${who}: read-only file system: ${target}`)
  await ensure(abs, who, target, false)
  const e = sfEntry(w.sf)
  if (e === undefined) throw err(`${who}: no such file or directory: ${target}`)
  if (e?.dir) throw err(`${who}: is a directory: ${target}`)
  const body = content && !content.endsWith('\n') ? `${content}\n` : content
  let text = body
  if (append && e) {
    const prev = await readText(w.sf)
    text = prev && !prev.endsWith('\n') ? `${prev}\n${body}` : prev + body
  }
  if (!e) {
    dropSfModes(w.sf)
    await createFile(w.sf)
  }
  await writeText(w.sf, text)
  texts.set(w.sf, { text, mtime: Date.now() })
  await listDir(sfParent(w.sf)!, 0).catch(() => {})
}

/** A browser store refusal (a full disk, say) as the command's own error. */
const asCmdError = (who: string) => (e: Error) => {
  throw err(`${who}: ${e.message}`)
}

/**
 * Makes sure a folder on the browser mount exists in the browser, so a file can go in it: one of
 * the site's own folders there (games/, Pictures/) is made in the browser on first write.
 */
async function browserFolder(absDir: string, who: string, arg: string) {
  const w = whereIs(absDir)
  if (w.kind !== 'browser') throw err(`${who}: cannot create '${arg}': Read-only file system`)
  if (statBrowser(w.path)?.dir) return
  if (lookup(absDir)?.type !== 'dir') throw err(`${who}: cannot create '${arg}': No such file or directory`)
  await mkdirBrowser(w.path, true).catch(asCmdError(who))
}

/** For a write: a path's Seafile location, or the error to give (`what` is the command and verb). */
function writable(abs: string, arg: string, what: string): string {
  const w = whereIs(abs)
  if (w.kind === 'missing') throw err(`${what} '${arg}': Transport endpoint is not connected`)
  if (w.kind !== 'sf' || w.ro || w.sf === SF) throw err(`${what} '${arg}': Read-only file system`)
  return w.sf
}

export async function makeDir(cwd: string, arg: string, parents: boolean, root = false) {
  const abs = resolvePath(cwd, arg)
  const existing = lookup(abs)
  if (existing) {
    if (parents && existing.type === 'dir') return
    throw err(`mkdir: cannot create directory '${arg}': File exists`)
  }
  if (abs.startsWith('/tmp/')) throw err(`mkdir: cannot create directory '${arg}': /tmp is flat here, files only`)
  needParent(abs, `mkdir: cannot create directory '${arg}'`, root)
  const where = whereIs(abs)
  if (where.kind === 'browser') {
    await browserFilesReady()
    if (!lookup(parentOf(abs))) {
      if (!parents) throw err(`mkdir: cannot create directory '${arg}': No such file or directory`)
      await makeDir('/', parentOf(abs), true, root)
    }
    await browserFolder(parentOf(abs), 'mkdir', arg)
    await mkdirBrowser(where.path, true).catch(asCmdError('mkdir'))
    return
  }
  const sf = writable(abs, arg, 'mkdir: cannot create directory')
  const parent = parentOf(abs)
  await ensure(parent, 'mkdir', null, false)
  if (!lookup(parent)) {
    if (!parents) throw err(`mkdir: cannot create directory '${arg}': No such file or directory`)
    await makeDir('/', parent, true, root)
  }
  dropSfModes(sf)
  await sfMkdir(sf)
  await listDir(sfParent(sf)!, 0).catch(() => {})
}

export async function touchFile(cwd: string, arg: string, root = false) {
  const abs = resolvePath(cwd, arg)
  if (lookup(abs)) return
  needParent(abs, `touch: cannot touch '${arg}'`, root)
  if (abs === RC_PATH && whereIs(abs).kind === 'local' && !cvMode()) return setKeptRc('')
  if (abs.startsWith('/tmp/')) return writeTmp('/', abs, '', true)
  const where = whereIs(abs)
  if (where.kind === 'browser') {
    if (!lookup(parentOf(abs))) throw err(`touch: cannot touch '${arg}': No such file or directory`)
    await browserFolder(parentOf(abs), 'touch', arg)
    await writeBrowserFile(where.path, '').catch(asCmdError('touch'))
    return
  }
  const sf = writable(abs, arg, 'touch: cannot touch')
  if (!lookup(parentOf(abs))) throw err(`touch: cannot touch '${arg}': No such file or directory`)
  dropSfModes(sf)
  await createFile(sf)
  await listDir(sfParent(sf)!, 0).catch(() => {})
}

/**
 * rm: Seafile puts what it deletes in the library's trash, so this one is forgiving. Except in a
 * library that keeps no history: there it is gone for good, so `ask` (rm without -f) gets a say.
 */
export async function removePath(cwd: string, arg: string, opts: { recursive: boolean; force: boolean; dir: boolean; ask?: (question: string) => Promise<boolean>; root?: boolean }) {
  const abs = resolvePath(cwd, arg)
  const node = lookup(abs)
  if (!node) {
    if (opts.force) return
    throw err(`rm: cannot remove '${arg}': No such file or directory`)
  }
  needParent(abs, `rm: cannot remove '${arg}'`, opts.root)
  if (node.type === 'dir' && !opts.recursive && !(opts.dir && node.children.size === 0)) throw err(`rm: cannot remove '${arg}': ${opts.dir ? 'Directory not empty' : 'Is a directory'}`)
  if (abs.startsWith('/tmp/')) {
    ;(siteLookup(parentOf(abs)) as DirNode).children.delete(baseOf(abs))
    return
  }
  if (abs === RC_PATH && node.type === 'file' && !node.sf && !node.browser) return setKeptRc(null)
  const w = whereIs(abs)
  if (w.kind === 'sf' && parseSf(w.sf)?.p === '/') throw err(`rm: cannot remove '${arg}': Device or resource busy`)
  if (w.kind === 'browser') {
    // Kept in this browser: there is no trash, so rm (without -f) asks first.
    if (w.path === '/') throw err(`rm: cannot remove '${arg}': Device or resource busy`)
    if (!node.browser) throw err(`rm: cannot remove '${arg}': Read-only file system`)
    if (opts.ask && !opts.force && node.type === 'dir' && !(await opts.ask(`rm: remove '${arg}' and everything in it for good? Files in this browser have no trash [y/N]`))) return
    await removeBrowser(node.browser)
    return
  }
  const sf = writable(abs, arg, 'rm: cannot remove')
  if (opts.ask && !opts.force) {
    const repo = parseSf(sf)!.repo
    if ((await historyDays(repo).catch(() => null)) === 0) {
      const name = getLibraries()?.find((l) => l.id === repo)?.name ?? 'this library'
      if (!(await opts.ask(`rm: ${name} keeps no history: remove '${arg}' for good? [y/N]`))) return
    }
  }
  await deleteItems([sf])
  texts.delete(sf)
  dropSfModes(sf)
  await listDir(sfParent(sf)!, 0).catch(() => {})
}

/**
 * mv and cp: into a folder, or onto a new name (replacing a file of that name). The modes chmod
 * set go along with what is moved or copied.
 */
export async function transfer(op: 'move' | 'copy', cwd: string, srcArg: string, destArg: string, recursive: boolean, root = false) {
  const cmd = op === 'move' ? 'mv' : 'cp'
  const src = resolvePath(cwd, srcArg)
  const node = lookup(src)
  let dest = resolvePath(cwd, destArg)
  if (node && lookup(dest)?.type === 'dir') dest = join(dest, baseOf(src))
  const kept: [string, number][] = []
  if (node && dest !== src) {
    const kind = node.type === 'dir' ? 'directory' : 'regular file'
    if (op === 'move') needParent(src, `mv: cannot move '${srcArg}'`, root)
    needParent(dest, `${cmd}: cannot create ${kind} '${destArg}'`, root)
    // A rename never reads the bytes; anything else (a copy, a move to another filesystem) does.
    const renames = op === 'move' && ((!!sfOf(src) && !!sfOf(parentOf(dest))) || (!!node.browser && whereIs(parentOf(dest)).kind === 'browser'))
    const overwritten: string[] = []
    for (const p of walk(src, node)) {
      const rel = p.slice(src.length)
      const from = lookup(p)
      const to = dest + rel
      if (from?.mode !== undefined) kept.push([rel, from.mode])
      if (from?.type === 'file' && !renames && !allows(p, from, 'r', root)) throw err(`${cmd}: cannot open '${srcArg}${rel}' for reading: Permission denied`)
      const there = lookup(to)
      if (there?.type !== 'file') {
        if (!there) needParent(to, `${cmd}: cannot create ${from?.type === 'dir' ? 'directory' : 'regular file'} '${destArg}${rel}'`, root)
        continue
      }
      if (from?.type === 'file' && !allows(to, there, 'w', root)) throw err(op === 'move' ? `mv: cannot move '${srcArg}${rel}' to '${destArg}${rel}': Permission denied` : `cp: cannot create regular file '${destArg}${rel}': Permission denied`)
      overwritten.push(to)
    }
    // What is replaced takes the new file's mode: the defaults, unless the source has its own.
    for (const to of overwritten) {
      const at = whereIs(to)
      if (at.kind === 'sf') dropSfModes(at.sf)
      else if (lookup(to)?.mode !== undefined) await setMode(to, null, true).catch(() => {})
    }
  }
  await move(op, cwd, srcArg, destArg, recursive, root)
  if (!node || dest === src) return
  const fromSf = sfOf(src)
  const toSf = whereIs(dest)
  if (fromSf && toSf.kind === 'sf') return carrySfModes(fromSf.sf, toSf.sf, op === 'copy')
  for (const [rel, mode] of kept) {
    const to = dest + rel
    if (lookup(to)?.mode === mode) continue
    const at = whereIs(to)
    if (at.kind === 'sf') setSfMode(at.sf, mode)
    else await setMode(to, mode, true).catch(() => {})
  }
}

async function move(op: 'move' | 'copy', cwd: string, srcArg: string, destArg: string, recursive: boolean, root: boolean) {
  const cmd = op === 'move' ? 'mv' : 'cp'
  const src = resolvePath(cwd, srcArg)
  const node = lookup(src)
  if (!node) throw err(`${cmd}: cannot stat '${srcArg}': No such file or directory`)
  if (node.type === 'dir' && op === 'copy' && !recursive) throw err(`cp: -r not specified; omitting directory '${srcArg}'`)
  let dest = resolvePath(cwd, destArg)
  const destNode = lookup(dest)
  if (destNode?.type === 'dir') dest = join(dest, baseOf(src))
  if (dest === src || dest.startsWith(`${src}/`)) throw err(`${cmd}: cannot ${op} '${srcArg}' to a subdirectory of itself, '${destArg}'`)
  const into = parentOf(dest)
  const name = baseOf(dest)
  const fromSf = sfOf(src)
  const toSf = sfOf(into)

  // Within Seafile: Seafile's own move and copy, then a rename for a new name.
  if (fromSf && toSf) {
    if (op === 'move' && fromSf.ro) throw err(`mv: cannot move '${srcArg}': Read-only file system`)
    if (toSf.ro) throw err(`${cmd}: cannot create ${node.type === 'dir' ? 'directory' : 'regular file'} '${destArg}': Read-only file system`)
    const existing = lookup(dest)
    if (existing?.type === 'dir') throw err(`${cmd}: cannot overwrite directory '${destArg}' with non-directory`)
    if (existing?.sf) await deleteItems([existing.sf])
    const sameFolder = parentOf(src) === into
    if (op === 'move' && sameFolder) await renameItem(fromSf.sf, name, node.type === 'dir')
    else {
      await transferItems(op, [fromSf.sf], toSf.sf)
      if (baseOf(src) !== name) await renameItem(`${toSf.sf}/${baseOf(src)}`, name, node.type === 'dir')
    }
    for (const sf of [sfParent(fromSf.sf), toSf.sf]) if (sf) await listDir(sf, 0).catch(() => {})
    return
  }
  // Within the browser: its own move and copy.
  const toBrowser = whereIs(into).kind === 'browser'
  if (node.browser && toBrowser) {
    const existing = lookup(dest)
    if (existing?.type === 'dir') throw err(`${cmd}: cannot overwrite directory '${destArg}' with non-directory`)
    await browserFolder(into, cmd, destArg)
    if (existing?.browser) await removeBrowser(existing.browser)
    await transferBrowser(op, node.browser, (whereIs(dest) as { path: string }).path).catch(asCmdError(cmd))
    return
  }
  // Across Seafile, the browser and /tmp: the bytes are carried over, folders and all.
  const movable = !!fromSf || !!node.browser || src.startsWith('/tmp/')
  if (op === 'move' && (!movable || fromSf?.ro)) throw err(`mv: cannot move '${srcArg}': Read-only file system`)
  if (node.type === 'dir' && fromSf) await ensureTree(fromSf.sf, cmd, false)
  await copyAcross(src, dest, cmd, destArg, root)
  if (op === 'move') await removePath('/', src, { recursive: true, force: true, dir: false, root: true })
}

/** A file's bytes, wherever it is. */
async function bytesOf(node: FileNode): Promise<Blob> {
  if (node.browser) return readBrowserBlob(node.browser)
  if (node.sf) return readBlob(node.sf)
  return new Blob([node.content()], { type: 'text/plain' })
}

/** Copies a file or folder to a new place on another filesystem (the browser, Seafile, /tmp). */
async function copyAcross(src: string, dest: string, cmd: string, destArg: string, root: boolean) {
  const node = lookup(src)
  if (!node) return
  const into = parentOf(dest)
  const w = whereIs(into)
  const cannot = (why: string) => err(`${cmd}: cannot create ${node.type === 'dir' ? 'directory' : 'regular file'} '${destArg}': ${why}`)
  if (node.type === 'dir') {
    if (lookup(dest)?.type !== 'dir') await makeDir('/', dest, true, root)
    for (const name of node.children.keys()) await copyAcross(join(src, name), join(dest, name), cmd, destArg, root)
    return
  }
  if (lookup(dest)?.type === 'dir') throw err(`${cmd}: cannot overwrite directory '${destArg}' with non-directory`)
  if (w.kind === 'browser') {
    await browserFolder(into, cmd, destArg)
    await writeBrowserFile((whereIs(dest) as { path: string }).path, await bytesOf(node)).catch(asCmdError(cmd))
  } else if (w.kind === 'sf') {
    if (w.ro || w.sf === SF) throw cannot('Read-only file system')
    await uploadBlob(w.sf, baseOf(dest), await bytesOf(node))
    await listDir(w.sf, 0).catch(() => {})
  } else if (w.kind === 'local' && dest.startsWith('/tmp/')) {
    writeTmp('/', dest, await (await bytesOf(node)).text(), false, root, cmd)
  } else throw cannot(w.kind === 'missing' ? 'Transport endpoint is not connected' : 'Read-only file system')
}
