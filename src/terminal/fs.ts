import { getFstab, isSeafileType, libraryNames, mounts, setFstab, whereIs } from '../data/mounts'
import { cachedDir, createFile, deleteItems, errorStatus, getLibraries, listDir, loadLibraries, mkdir as sfMkdir, parseSf, readText, renameItem, SF, sfPath, transferItems, writeText, type Entry } from '../data/seafile'
import { getAccount } from '../os/account'
import { writeTmp } from './commands'
import { CmdError } from './types'
import { kindOfName, lookup as siteLookup, resolvePath, type DirNode, type FileNode, type Node } from './vfs'

// The filesystem as the terminal sees it: the site's own files (vfs.ts), with whatever /etc/fstab
// mounts on top (data/mounts.ts): Seafile libraries under /mnt/seafile, a library on ~, bind
// mounts. Commands are synchronous, so before one runs, prepare() fetches the Seafile folders (and,
// for cat, grep and friends, the file contents) it is going to need; lookup() then answers from
// those caches. Writing (>, touch, mkdir, rm, mv, cp, nano) goes straight to Seafile.

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
  return { type: 'file', name: e.name, sf, ro, size: e.size, mtime: e.mtime, content: () => texts.get(sf)?.text ?? '' }
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

/** Names a folder gains on top of its own: mount points right inside it. */
function extraChildren(abs: string): Map<string, Node> {
  const out = new Map<string, Node>()
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
  let node: Node | null = w.kind === 'local' ? siteLookup(w.path) : w.kind === 'sf' ? sfNode(w.sf, abs === '/' ? '' : baseOf(abs), w.ro) : null
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
const MAYBE_RECURSIVE = new Set(['grep', 'egrep', 'ls', 'rm', 'cp'])

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
export async function readFileText(abs: string): Promise<{ text: string; ro: boolean } | null> {
  const node = lookup(abs)
  if (!node || node.type !== 'file') return null
  if (!node.sf) return { text: node.content(), ro: abs !== '/etc/fstab' && !abs.startsWith('/tmp/') }
  const text = await readText(node.sf)
  texts.set(node.sf, { text, mtime: node.mtime ?? 0 })
  return { text, ro: !!node.ro }
}

// --- writing --------------------------------------------------------------------------------------

const err = (msg: string) => new CmdError(msg)

/** Writes a file: /tmp, Seafile, or /etc/fstab (root only). `append` adds to the end, like >>. */
export async function writeFile(cwd: string, target: string, content: string, append: boolean, root = false, who = 'msh') {
  const abs = resolvePath(cwd, target)
  if (abs === '/etc/fstab') {
    if (!root) throw err(`${who}: permission denied: ${target}`)
    setFstab(append ? `${getFstab().replace(/\n?$/, '\n')}${content}` : content)
    return
  }
  const w = whereIs(abs)
  if (w.kind === 'missing') throw err(`${who}: ${target}: Transport endpoint is not connected`)
  if (w.kind === 'local') return writeTmp('/', w.path, content, append)
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
  if (!e) await createFile(w.sf)
  await writeText(w.sf, text)
  texts.set(w.sf, { text, mtime: Date.now() })
  await listDir(sfParent(w.sf)!, 0).catch(() => {})
}

/** For a write: a path's Seafile location, or the error to give (`what` is the command and verb). */
function writable(abs: string, arg: string, what: string): string {
  const w = whereIs(abs)
  if (w.kind === 'missing') throw err(`${what} '${arg}': Transport endpoint is not connected`)
  if (w.kind === 'local' || w.ro || w.sf === SF) throw err(`${what} '${arg}': Read-only file system`)
  return w.sf
}

export async function makeDir(cwd: string, arg: string, parents: boolean) {
  const abs = resolvePath(cwd, arg)
  const existing = lookup(abs)
  if (existing) {
    if (parents && existing.type === 'dir') return
    throw err(`mkdir: cannot create directory '${arg}': File exists`)
  }
  if (abs.startsWith('/tmp/')) throw err(`mkdir: cannot create directory '${arg}': /tmp is flat here, files only`)
  const sf = writable(abs, arg, 'mkdir: cannot create directory')
  const parent = parentOf(abs)
  await ensure(parent, 'mkdir', null, false)
  if (!lookup(parent)) {
    if (!parents) throw err(`mkdir: cannot create directory '${arg}': No such file or directory`)
    await makeDir('/', parent, true)
  }
  await sfMkdir(sf)
  await listDir(sfParent(sf)!, 0).catch(() => {})
}

export async function touchFile(cwd: string, arg: string) {
  const abs = resolvePath(cwd, arg)
  if (lookup(abs)) return
  if (abs.startsWith('/tmp/')) return writeTmp('/', abs, '', true)
  const sf = writable(abs, arg, 'touch: cannot touch')
  if (!lookup(parentOf(abs))) throw err(`touch: cannot touch '${arg}': No such file or directory`)
  await createFile(sf)
  await listDir(sfParent(sf)!, 0).catch(() => {})
}

/** rm: Seafile puts what it deletes in the library's trash, so this one is forgiving. */
export async function removePath(cwd: string, arg: string, opts: { recursive: boolean; force: boolean; dir: boolean }) {
  const abs = resolvePath(cwd, arg)
  const node = lookup(abs)
  if (!node) {
    if (opts.force) return
    throw err(`rm: cannot remove '${arg}': No such file or directory`)
  }
  if (node.type === 'dir' && !opts.recursive && !(opts.dir && node.children.size === 0)) throw err(`rm: cannot remove '${arg}': ${opts.dir ? 'Directory not empty' : 'Is a directory'}`)
  if (abs.startsWith('/tmp/')) {
    ;(siteLookup('/tmp') as DirNode).children.delete(baseOf(abs))
    return
  }
  const w = whereIs(abs)
  if (w.kind === 'sf' && parseSf(w.sf)?.p === '/') throw err(`rm: cannot remove '${arg}': Device or resource busy`)
  const sf = writable(abs, arg, 'rm: cannot remove')
  await deleteItems([sf])
  texts.delete(sf)
  await listDir(sfParent(sf)!, 0).catch(() => {})
}

/** mv and cp: into a folder, or onto a new name (replacing a file of that name). */
export async function transfer(op: 'move' | 'copy', cwd: string, srcArg: string, destArg: string, recursive: boolean) {
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
  // Across: only files, carried as text.
  if (node.type === 'dir') throw err(`${cmd}: cannot ${op} '${srcArg}' to '${destArg}': Operation not supported`)
  if (op === 'move' && !fromSf && !src.startsWith('/tmp/')) throw err(`mv: cannot move '${srcArg}': Read-only file system`)
  const text = fromSf ? await readText(fromSf.sf) : node.content()
  await writeFile('/', dest, text, false, false, cmd).catch((e: Error) => {
    throw err(e.message.replace(/^(cp|mv): (.*): (.*)$/, `${cmd}: cannot create regular file '${destArg}': $3`))
  })
  if (op === 'move') await removePath('/', src, { recursive: false, force: true, dir: false })
}
