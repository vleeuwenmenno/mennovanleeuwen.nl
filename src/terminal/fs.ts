import { reserve, textWork } from './bounds'
import { downloadJson, downloadText } from './download'
import { boundedJson } from './jq-safe'
import { browserFilesReady, browserText, listBrowser, mkdirBrowser, readBrowserBlob, readBrowserText, removeBrowser, setBrowserMode, statBrowser, transferBrowser, writeBrowserFile } from '../data/browserfs'
import { browserMountPoint, getFstab, isSeafileType, libraryNames, mounts, setFstab, whereIs } from '../data/mounts'
import { cachedDir, createFile, deleteItems, errorStatus, getLibraries, historyDays, listDir, loadLibraries, mkdir as sfMkdir, parseSf, readBlob, readText, renameItem, SF, sfPath, transferItems, uploadBlob, writeText, type Entry, type IoGuard } from '../data/seafile'
import { getAccount } from '../os/account'
import { writeTmp } from './commands'
import { CmdError, DeniedError } from './types'
import { writeError } from './devices'
import { cvMode } from '../os/cvMode'
import { keptRc, RC_NAME, RC_PATH, setKeptRc } from './rcfile'
import { HOME, kindOfName, lookup as siteLookup, resolvePath, type DirNode, type FileNode, type Node } from './vfs'
import { allows, carrySfModes, dropSfModes, setSfMode, sfModeOf, userOwns, type Access } from './modes'
import { fileOperands, hasNoFileOperands, type Policy } from './policy'
import type { Budget } from './limits'

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
const READERS = new Set(['cat', 'less', 'more', 'bat', 'lolcat', 'xxd', 'hexdump', 'od', 'sha384sum', 'head', 'tail', 'wc', 'grep', 'egrep', 'sort', 'uniq', 'jq', 'sha1sum', 'sha256sum', 'sha512sum', 'md5sum', 'nano', 'cp', 'diff', 'base64'])
/** Commands that look after themselves (sudo runs its command, which is prepared then). */
const SELF_SERVED = new Set(['fscrypt', 'mount', 'umount', 'findmnt', 'lsblk', 'sudo', 'echo', 'man', 'help', 'clear', 'history', 'visited'])
const ALWAYS_RECURSIVE = new Set(['find', 'fd', 'tree', 'du'])
const MAYBE_RECURSIVE = new Set(['grep', 'egrep', 'ls', 'rm', 'cp', 'chmod'])

const usesSeafile = () => mounts().some((m) => isSeafileType(m) || m.options.includes('bind'))

class FsError extends CmdError {}

/** Fetches one Seafile folder; a locked library or a dead connection is an error for `cmd`. */
async function fetchDir(sf: string, cmd: string, arg: string | null, actor: Actor = false) {
  try {
    await listDir(sf, 30_000, ioGuard(actor))
    return true
  } catch (e) {
    checkActor(actor)
    if (typeof actor !== 'boolean' && actor.policy && errorStatus(e) === null) throw e
    const status = errorStatus(e)
    if (!arg || status === 404) return false
    if (status === 423) throw new FsError(`${cmd}: cannot access '${arg}': Required key not available`)
    throw new FsError(`${cmd}: cannot access '${arg}': Transport endpoint is not connected`)
  }
}

async function fetchText(sf: string, e: Entry, actor: Actor = false) {
  const hit = texts.get(sf)
  if (hit && hit.mtime === e.mtime) { textWork(boundActor(actor), hit.text.length); return }
  texts.set(sf, { text: await readText(sf, ioGuard(actor)), mtime: e.mtime })
}

/** One path: its folder's listing, its own if it is a folder, and its text if `read`. */
async function ensure(abs: string, cmd: string, arg: string | null, read: boolean, actor: Actor = false): Promise<string | null> {
  checkActor(actor)
  if (typeof actor !== 'boolean') {
    const why = actor.policy?.read(abs)
    if (why) throw err(why)
  }
  let w = whereIs(abs)
  if (w.kind === 'missing' && w.loading) {
    await loadLibraries(false, ioGuard(actor))
    checkActor(actor)
    w = whereIs(abs)
  }
  if (w.kind !== 'sf' || w.sf === SF) return null
  // The work folder's own listing is enough; do not fetch its unauthorized parent.
  const parent = typeof actor !== 'boolean' && actor.policy?.grant.root === abs ? null : sfParent(w.sf)
  if (parent && !(await fetchDir(parent, cmd, arg, actor))) return null
  checkActor(actor)
  const e = sfEntry(w.sf)
  if (!parent || e?.dir) {
    await fetchDir(w.sf, cmd, arg, actor)
    return w.sf
  }
  if (e && read && typeof actor !== 'boolean' && actor.budget && e.size > MAX_TEXT) { actor.budget.stop('memory'); throw err('msh: file metadata exceeds text limit') }
  if (e && read && e.size <= MAX_TEXT) await fetchText(w.sf, e, actor).catch(error => { if (typeof actor !== 'boolean' && actor.policy) throw error })
  return null
}

/** Everything under a Seafile folder, breadth first, as far as the limits go. */
async function ensureTree(root: string, cmd: string, read: boolean, actor: Actor = false) {
  const queue = [root]
  let dirs = 0
  let files = 0
  while (queue.length && dirs < MAX_DIRS) {
    const batch = queue.splice(0, 6)
    dirs += batch.length
    await Promise.all(
      batch.map(async (sf) => {
        checkActor(actor)
        if (!(await fetchDir(sf, cmd, null, actor))) return
        checkActor(actor)
        for (const e of cachedDir(sf)?.listing?.entries ?? []) {
          const child = `${sf}/${e.name}`
          if (e.dir) queue.push(child)
          else if (read && files < MAX_FILES && e.size <= MAX_RECURSIVE_TEXT && ['text', 'markdown', 'link'].includes(kindOfName(e.name))) {
            files++
            await fetchText(child, e, actor).catch(() => {})
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
export async function prepare(cwd: string, cmd: string, args: string[], actor: Actor = false) {
  checkActor(actor)
  // Data operands are never filesystem paths; cancellation still precedes this return.
  if (hasNoFileOperands(cmd)) return
  if (typeof actor !== 'boolean' && actor.policy) {
    const why = actor.policy.command(cmd, args, cwd)
    if (why) throw err(why)
  }
  const paths = typeof actor === 'boolean' || !actor.policy ? args : fileOperands(cmd, args)
  if (typeof actor !== 'boolean' && actor.policy) {
    for (const path of [cwd, ...paths.map((p) => resolvePath(cwd, p))]) {
      const why = actor.policy.tree(path)
      if (why) throw err(why)
    }
  }

  // The browser's files load once, right after sign-in; the first command waits for that.
  if (browserMountPoint() && (typeof actor === 'boolean' || !actor.policy)) await browserFilesReady()
  if (!usesSeafile() || !getAccount().seafile || SELF_SERVED.has(cmd)) return
  if (!getLibraries() || (typeof actor !== 'boolean' && actor.policy)) await loadLibraries(false, ioGuard(actor))
  const read = READERS.has(cmd)
  const recursive = ALWAYS_RECURSIVE.has(cmd) || (MAYBE_RECURSIVE.has(cmd) && args.some((a) => /^-[a-zA-Z]*[rR]/.test(a) || a === '--recursive'))
  await ensure(cwd, cmd, null, false, actor)
  const roots: string[] = []
  for (const a of paths) {
    if (!a || a === '-' || ((typeof actor === 'boolean' || !actor.policy) && a.startsWith('-'))) continue
    const abs = resolvePath(cwd, a)
    const dir = await ensure(abs, cmd, a, read, actor)
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
    if (t === SF) for (const l of getLibraries() ?? []) await ensureTree(sfPath(l.id), cmd, read && cmd === 'grep', actor)
    else await ensureTree(t, cmd, read && (cmd === 'grep' || cmd === 'egrep'), actor)
  }
}

/** Tab completion's folder, fetched so the picker can list it. */
export async function prepareFolder(abs: string) {
  if (!usesSeafile() || !getAccount().seafile) return
  await ensure(abs, 'complete', null, false).catch(() => {})
}

/** A Seafile file's text for an editor: fetched now, whatever its age. */
export async function readFileText(abs: string, root = false, actor: Actor = false): Promise<{ text: string; ro: boolean } | null> {
  checkActor(actor)
  const outside = typeof actor === 'boolean' ? null : actor.policy?.read(abs)
  if (outside) throw err(outside)
  const node = lookup(abs)
  if (!node || node.type !== 'file') return null
  // A mode set with chmod can forbid the read; the callers that show it say so (DeniedError).
  if (!allows(abs, node, 'r', root)) throw new DeniedError('Permission denied')
  if (node.browser) {
    if (typeof actor !== 'boolean' && actor.policy) throw err('msh: browser-backed file reads are unavailable to agents; use a Seafile work folder')
    return { text: await readBrowserText(node.browser), ro: false }
  }
  // The site's own files under the browser mount: readable, and saving makes the browser's copy.
  if (!node.sf) {
    const text = cachedText(abs, node, actor)
    return { text, ro: abs !== '/etc/fstab' && abs !== RC_PATH && !abs.startsWith('/tmp/') && whereIs(abs).kind !== 'browser' }
  }
  checkActor(actor)
  const text = await readText(node.sf, ioGuard(actor))
  textWork(boundActor(actor), text.length, 1)
  texts.set(node.sf, { text, mtime: node.mtime ?? 0 })
  return { text, ro: !!node.ro }
}

// --- writing --------------------------------------------------------------------------------------

/**
 * Who is writing: root or not, and for an agent's terminal call the policy that confines it. A plain
 * boolean is the old way to say "root or not" and means no policy (the user's own writes: Zed, Files).
 */
export type Actor = boolean | { root: boolean; policy?: Policy; signal?: AbortSignal; budget?: Budget }
const boundActor = (actor: Actor) => typeof actor === 'boolean' ? {} : actor
/** A shared cached-content boundary used by command readers, scripts and redirects. */
export function cachedText(abs: string, node: FileNode, actor: Actor): string {
  checkActor(actor)
  if (typeof actor !== 'boolean' && actor.policy) {
    const outside = actor.policy.read(abs)
    if (outside) throw err(outside)
    if (node.browser) throw err('msh: browser-backed file reads are unavailable to agents; use a Seafile work folder')
    if (!node.sf && !node.dev && !abs.startsWith('/tmp/')) throw err('msh: dynamic site files are unavailable to agents; use a work-folder file')
  }
  // Device content generators allocate up to 64 KiB when called.
  if (node.dev) textWork(boundActor(actor), node.dev.major === 1 && node.dev.minor === 3 ? 0 : 65536)
  const text = node.content()
  textWork(boundActor(actor), text.length)
  return text
}
function ioGuard(actor: Actor, check = () => checkActor(actor)): IoGuard | undefined {
  if (typeof actor === 'boolean') return undefined
  const ctx = { ...actor, signal: actor.signal ?? new AbortController().signal }
  return { check, signal: actor.signal,
    json: actor.budget || actor.policy ? response => downloadJson(response, ctx) : undefined,
    text: actor.budget || actor.policy ? response => downloadText(response, ctx) : undefined,
    snapshot: actor.budget || actor.policy ? async value => { const text = await boundedJson(value, ctx); textWork(ctx, text.length) } : undefined,
  }
}
const isRoot = (a: Actor) => (typeof a === 'boolean' ? a : a.root)
/** An agent call's policy refusing a write: the command's own error. */
export function checkActor(a: Actor) {
  if (typeof a === 'boolean') return
  a.signal?.throwIfAborted()
  if (a.policy?.grant.root) {
    const why = a.policy.tree(a.policy.grant.root)
    if (why) throw err(why)
  }
  if (a.policy && !a.budget) throw err('msh: agent budget required')
  if (a.budget?.step()) throw err(`msh: ${a.budget.stopped} limit reached`)
}
function mayWrite(a: Actor, abs: string, op: 'write' | 'delete' = 'write') {
  checkActor(a)
  const why = typeof a === 'boolean' ? null : a.policy?.write(abs, op)
  if (why) throw err(why)
}
/** The actor a command's context stands for. */
export const actorOf = (ctx: { root?: boolean; policy?: Policy; signal?: AbortSignal; budget?: Budget }): Actor => ({ root: !!ctx.root, policy: ctx.policy, signal: ctx.signal, budget: ctx.budget })

const guarded = <A extends unknown[], R>(actor: Actor, fn: (...args: A) => R) => (...args: A): R => {
  checkActor(actor)
  return fn(...args)
}

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
export async function setMode(abs: string, mode: number | null, who: Actor = false): Promise<void> {
  const root = isRoot(who)
  mayWrite(who, abs)
  if (typeof who !== 'boolean' && who.policy && whereIs(abs).kind !== 'local') throw err('chmod: agent mode changes currently require local /tmp files')
  const node = lookup(abs)
  if (!node) throw err(`chmod: cannot access '${abs}': No such file or directory`)
  const w = whereIs(abs)
  const refuse = (why: string) => err(`chmod: changing permissions of '${abs}': ${why}`)
  if (w.kind === 'missing') throw refuse('Transport endpoint is not connected')
  if (node.browser) {
    await guarded(who, setBrowserMode)(node.browser, mode).catch(() => {
      throw refuse('Operation not permitted')
    })
    return
  }
  if (node.sf && !node.ro && node.sf !== SF) return guarded(who, setSfMode)(node.sf, mode)
  if (w.kind === 'local' && abs.startsWith('/tmp/')) {
    const kept = siteLookup(abs)
    if (kept) kept.mode = mode ?? undefined
    return
  }
  // The site's own files, /bin, /etc, read-only libraries: nothing here can be changed.
  throw refuse(!root && !userOwns(abs, node) ? 'Operation not permitted' : 'Read-only file system')
}

/** Writes a file: /tmp, Seafile, or /etc/fstab (root only). `append` adds to the end, like >>. */
export async function writeFile(cwd: string, target: string, content: string, append: boolean, actor: Actor = false, who = 'msh') {
  const root = isRoot(actor)
  const abs = resolvePath(cwd, target)
  mayWrite(actor, abs)
  // A device swallows what is written to it (the disks refuse it).
  const written = abs.startsWith('/dev/') ? lookup(abs) : null
  if (written?.type === 'file' && written.dev) {
    const refused = writeError(who, target, written.dev, root)
    if (refused) throw refused
    return
  }
  if (abs === '/etc/fstab') {
    if (!root) throw err(`${who}: permission denied: ${target}`)
    guarded(actor, setFstab)(append ? `${getFstab().replace(/\n?$/, '\n')}${content}` : content)
    return
  }
  const w = whereIs(abs)
  if (w.kind === 'missing') throw err(`${who}: ${target}: Transport endpoint is not connected`)
  if (lookup(abs)) need(abs, 'w', `${who}: ${target}`, root)
  else needParent(abs, `${who}: ${target}`, root)
  if (abs === RC_PATH && w.kind === 'local' && !cvMode()) {
    const prev = keptRc()
    reserve(boundActor(actor), content.length * 4 + 1)
    const body = content && !content.endsWith('\n') ? `${content}\n` : content
    guarded(actor, setKeptRc)(append && prev ? (prev.endsWith('\n') ? prev + body : `${prev}\n${body}`) : body)
    return
  }
  if (w.kind === 'local') return guarded(actor, writeTmp)('/', w.path, content, append, actor, who)
  if (w.kind === 'browser') {
    await browserFilesReady()
    const node = lookup(abs)
    if (node?.type === 'dir') throw err(`${who}: is a directory: ${target}`)
    await browserFolder(parentOf(abs), who, target, actor)
    reserve(boundActor(actor), content.length * 4 + 1)
    const body = content && !content.endsWith('\n') ? `${content}\n` : content
    let text = body
    if (append && node) {
      const prev = node.browser ? await readBrowserText(node.browser) : node.content()
      text = prev && !prev.endsWith('\n') ? `${prev}\n${body}` : prev + body
    }
    await guarded(actor, writeBrowserFile)(w.path, text).catch(asCmdError(who))
    return
  }
  if (w.ro || w.sf === SF) throw err(`${who}: read-only file system: ${target}`)
  await ensure(abs, who, target, false, actor)
  checkActor(actor)
  const e = sfEntry(w.sf)
  if (e === undefined) throw err(`${who}: no such file or directory: ${target}`)
  if (e?.dir) throw err(`${who}: is a directory: ${target}`)
  reserve(boundActor(actor), content.length * 4 + 1)
  const body = content && !content.endsWith('\n') ? `${content}\n` : content
  let text = body
  if (append && e) {
    const prev = await readText(w.sf, ioGuard(actor))
    reserve(boundActor(actor), prev.length + body.length + 1)
    text = prev && !prev.endsWith('\n') ? `${prev}\n${body}` : prev + body
  }
  if (!e) {
    guarded(actor, dropSfModes)(w.sf)
    await guarded(actor, createFile)(w.sf, ioGuard(actor, () => mayWrite(actor, abs)))
  }
  reserve(boundActor(actor), text.length * 4)
  await guarded(actor, writeText)(w.sf, text, ioGuard(actor, () => mayWrite(actor, abs)))
  texts.set(w.sf, { text, mtime: Date.now() })
  await listDir(sfParent(w.sf)!, 0, ioGuard(actor)).catch(() => {})
}

/** A browser store refusal (a full disk, say) as the command's own error. */
const asCmdError = (who: string) => (e: Error) => {
  throw err(`${who}: ${e.message}`)
}

/**
 * Makes sure a folder on the browser mount exists in the browser, so a file can go in it: one of
 * the site's own folders there (games/, Pictures/) is made in the browser on first write.
 */
async function browserFolder(absDir: string, who: string, arg: string, actor: Actor = false) {
  const w = whereIs(absDir)
  if (w.kind !== 'browser') throw err(`${who}: cannot create '${arg}': Read-only file system`)
  if (statBrowser(w.path)?.dir) return
  if (lookup(absDir)?.type !== 'dir') throw err(`${who}: cannot create '${arg}': No such file or directory`)
  await guarded(actor, mkdirBrowser)(w.path, true).catch(asCmdError(who))
}

/** For a write: a path's Seafile location, or the error to give (`what` is the command and verb). */
function writable(abs: string, arg: string, what: string): string {
  const w = whereIs(abs)
  if (w.kind === 'missing') throw err(`${what} '${arg}': Transport endpoint is not connected`)
  if (w.kind !== 'sf' || w.ro || w.sf === SF) throw err(`${what} '${arg}': Read-only file system`)
  return w.sf
}

export async function makeDir(cwd: string, arg: string, parents: boolean, actor: Actor = false) {
  const root = isRoot(actor)
  const abs = resolvePath(cwd, arg)
  mayWrite(actor, abs)
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
      await makeDir('/', parentOf(abs), true, actor)
    }
    await browserFolder(parentOf(abs), 'mkdir', arg, actor)
    await guarded(actor, mkdirBrowser)(where.path, true).catch(asCmdError('mkdir'))
    return
  }
  const sf = writable(abs, arg, 'mkdir: cannot create directory')
  const parent = parentOf(abs)
  await ensure(parent, 'mkdir', null, false, actor)
  if (!lookup(parent)) {
    if (!parents) throw err(`mkdir: cannot create directory '${arg}': No such file or directory`)
    await makeDir('/', parent, true, actor)
  }
  guarded(actor, dropSfModes)(sf)
  await guarded(actor, sfMkdir)(sf, ioGuard(actor, () => mayWrite(actor, abs)))
  await listDir(sfParent(sf)!, 0, ioGuard(actor)).catch(() => {})
}

export async function touchFile(cwd: string, arg: string, actor: Actor = false) {
  const root = isRoot(actor)
  const abs = resolvePath(cwd, arg)
  mayWrite(actor, abs)
  if (lookup(abs)) return
  needParent(abs, `touch: cannot touch '${arg}'`, root)
  if (abs === RC_PATH && whereIs(abs).kind === 'local' && !cvMode()) return guarded(actor, setKeptRc)('')
  if (abs.startsWith('/tmp/')) return guarded(actor, writeTmp)('/', abs, '', true, actor)
  const where = whereIs(abs)
  if (where.kind === 'browser') {
    if (!lookup(parentOf(abs))) throw err(`touch: cannot touch '${arg}': No such file or directory`)
    await browserFolder(parentOf(abs), 'touch', arg, actor)
    await guarded(actor, writeBrowserFile)(where.path, '').catch(asCmdError('touch'))
    return
  }
  const sf = writable(abs, arg, 'touch: cannot touch')
  if (!lookup(parentOf(abs))) throw err(`touch: cannot touch '${arg}': No such file or directory`)
  guarded(actor, dropSfModes)(sf)
  await guarded(actor, createFile)(sf, ioGuard(actor, () => mayWrite(actor, abs)))
  await listDir(sfParent(sf)!, 0, ioGuard(actor)).catch(() => {})
}

/**
 * rm: Seafile puts what it deletes in the library's trash, so this one is forgiving. Except in a
 * library that keeps no history: there it is gone for good, so `ask` (rm without -f) gets a say.
 */
export async function removePath(cwd: string, arg: string, opts: { recursive: boolean; force: boolean; dir: boolean; ask?: (question: string) => Promise<boolean>; root?: Actor }) {
  const abs = resolvePath(cwd, arg)
  mayWrite(opts.root ?? false, abs, 'delete')
  const node = lookup(abs)
  if (!node) {
    if (opts.force) return
    throw err(`rm: cannot remove '${arg}': No such file or directory`)
  }
  if (node.type === 'dir' && typeof opts.root !== 'boolean' && opts.root?.policy) throw err('rm: directory removal is unavailable to agents; remove verified individual files')
  needParent(abs, `rm: cannot remove '${arg}'`, isRoot(opts.root ?? false))
  if (node.type === 'dir' && !opts.recursive && !(opts.dir && node.children.size === 0)) throw err(`rm: cannot remove '${arg}': ${opts.dir ? 'Directory not empty' : 'Is a directory'}`)
  if (abs.startsWith('/tmp/')) {
    ;(siteLookup(parentOf(abs)) as DirNode).children.delete(baseOf(abs))
    return
  }
  if (abs === RC_PATH && node.type === 'file' && !node.sf && !node.browser) return guarded(opts.root ?? false, setKeptRc)(null)
  const w = whereIs(abs)
  if (w.kind === 'sf' && parseSf(w.sf)?.p === '/') throw err(`rm: cannot remove '${arg}': Device or resource busy`)
  if (w.kind === 'browser') {
    // Kept in this browser: there is no trash, so rm (without -f) asks first.
    if (w.path === '/') throw err(`rm: cannot remove '${arg}': Device or resource busy`)
    if (!node.browser) throw err(`rm: cannot remove '${arg}': Read-only file system`)
    if (opts.ask && !opts.force && node.type === 'dir' && !(await opts.ask(`rm: remove '${arg}' and everything in it for good? Files in this browser have no trash [y/N]`))) return
    await guarded(opts.root ?? false, removeBrowser)(node.browser)
    return
  }
  const sf = writable(abs, arg, 'rm: cannot remove')
  if (opts.ask && !opts.force) {
    const repo = parseSf(sf)!.repo
    if ((await historyDays(repo, ioGuard(opts.root ?? false)).catch(error => { checkActor(opts.root ?? false); if (typeof opts.root !== 'boolean' && opts.root?.policy) throw error; return null })) === 0) {
      const name = getLibraries()?.find((l) => l.id === repo)?.name ?? 'this library'
      if (!(await opts.ask(`rm: ${name} keeps no history: remove '${arg}' for good? [y/N]`))) return
    }
  }
  await guarded(opts.root ?? false, deleteItems)([sf], ioGuard(opts.root ?? false, () => mayWrite(opts.root ?? false, abs, 'delete')))
  texts.delete(sf)
  guarded(opts.root ?? false, dropSfModes)(sf)
  await listDir(sfParent(sf)!, 0, ioGuard(opts.root ?? false)).catch(() => {})
}

/**
 * mv and cp: into a folder, or onto a new name (replacing a file of that name). The modes chmod
 * set go along with what is moved or copied.
 */
export async function transfer(op: 'move' | 'copy', cwd: string, srcArg: string, destArg: string, recursive: boolean, actor: Actor = false) {
  const root = isRoot(actor)
  const cmd = op === 'move' ? 'mv' : 'cp'
  const src = resolvePath(cwd, srcArg)
  if (typeof actor !== 'boolean' && actor.policy && [src, resolvePath(cwd, destArg)].some(p => whereIs(p).kind !== 'local')) throw err(`${cmd}: agent transfers currently require local /tmp files`)
  if (op === 'move') mayWrite(actor, src, typeof actor !== 'boolean' && actor.policy ? 'delete' : 'write')
  else if (typeof actor !== 'boolean' && actor.policy?.read(src)) throw err(actor.policy.read(src)!)
  const node = lookup(src)
  if (node?.type === 'dir' && typeof actor !== 'boolean' && actor.policy) throw err(`${cmd}: directory transfers are unavailable to agents; copy verified individual files`)
  let dest = resolvePath(cwd, destArg)
  if (node && lookup(dest)?.type === 'dir') dest = join(dest, baseOf(src))
  mayWrite(actor, dest)
  if (typeof actor !== 'boolean' && actor.policy && node?.sf && whereIs(dest).kind === 'sf' && !(op === 'move' && parentOf(src) === parentOf(dest))) {
    const staged = join(parentOf(dest), baseOf(src))
    mayWrite(actor, staged)
    if (staged !== dest && lookup(staged)) throw err(`${cmd}: intermediate destination already exists; use an unused name`)
  }
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
      if (at.kind === 'sf') guarded(actor, dropSfModes)(at.sf)
      else if (lookup(to)?.mode !== undefined) await setMode(to, null, actor).catch(() => {})
    }
  }
  await move(op, cwd, srcArg, destArg, recursive, actor)
  if (!node || dest === src) return
  const fromSf = sfOf(src)
  const toSf = whereIs(dest)
  if (fromSf && toSf.kind === 'sf') return guarded(actor, carrySfModes)(fromSf.sf, toSf.sf, op === 'copy')
  for (const [rel, mode] of kept) {
    const to = dest + rel
    if (lookup(to)?.mode === mode) continue
    const at = whereIs(to)
    if (at.kind === 'sf') guarded(actor, setSfMode)(at.sf, mode)
    else await setMode(to, mode, actor).catch(() => {})
  }
}

async function move(op: 'move' | 'copy', cwd: string, srcArg: string, destArg: string, recursive: boolean, actor: Actor) {
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
    if (existing?.sf) await guarded(actor, deleteItems)([existing.sf])
    const sameFolder = parentOf(src) === into
    if (op === 'move' && sameFolder) await guarded(actor, renameItem)(fromSf.sf, name, node.type === 'dir')
    else {
      mayWrite(actor, join(into, baseOf(src)))
      await guarded(actor, transferItems)(op, [fromSf.sf], toSf.sf)
      if (baseOf(src) !== name) await guarded(actor, renameItem)(`${toSf.sf}/${baseOf(src)}`, name, node.type === 'dir')
    }
    for (const sf of [sfParent(fromSf.sf), toSf.sf]) if (sf) await listDir(sf, 0).catch(() => {})
    return
  }
  // Within the browser: its own move and copy.
  const toBrowser = whereIs(into).kind === 'browser'
  if (node.browser && toBrowser) {
    const existing = lookup(dest)
    if (existing?.type === 'dir') throw err(`${cmd}: cannot overwrite directory '${destArg}' with non-directory`)
    await browserFolder(into, cmd, destArg, actor)
    if (existing?.browser) await guarded(actor, removeBrowser)(existing.browser)
    await guarded(actor, transferBrowser)(op, node.browser, (whereIs(dest) as { path: string }).path).catch(asCmdError(cmd))
    return
  }
  if (typeof actor !== 'boolean' && actor.policy) {
    if (node.type !== 'file' || fromSf || node.browser || whereIs(dest).kind !== 'local') throw err(`${cmd}: unsupported agent transfer`)
    await writeFile('/', dest, cachedText(src, node, actor), false, actor, cmd)
    if (op === 'move') await removePath('/', src, { recursive: false, force: true, dir: false, root: actor })
    return
  }
  // Across Seafile, the browser and /tmp: the bytes are carried over, folders and all.
  const movable = !!fromSf || !!node.browser || src.startsWith('/tmp/')
  if (op === 'move' && (!movable || fromSf?.ro)) throw err(`mv: cannot move '${srcArg}': Read-only file system`)
  if (node.type === 'dir' && fromSf) await ensureTree(fromSf.sf, cmd, false)
  await copyAcross(src, dest, cmd, destArg, actor)
  if (op === 'move') await removePath('/', src, { recursive: true, force: true, dir: false, root: actor })
}

/** A file's bytes, wherever it is. */
async function bytesOf(node: FileNode): Promise<Blob> {
  if (node.browser) return readBrowserBlob(node.browser)
  if (node.sf) return readBlob(node.sf)
  return new Blob([node.content()], { type: 'text/plain' })
}

/** Copies a file or folder to a new place on another filesystem (the browser, Seafile, /tmp). */
async function copyAcross(src: string, dest: string, cmd: string, destArg: string, actor: Actor) {
  mayWrite(actor, dest)
  const node = lookup(src)
  if (!node) return
  const into = parentOf(dest)
  const w = whereIs(into)
  const cannot = (why: string) => err(`${cmd}: cannot create ${node.type === 'dir' ? 'directory' : 'regular file'} '${destArg}': ${why}`)
  if (node.type === 'dir') {
    if (lookup(dest)?.type !== 'dir') await makeDir('/', dest, true, actor)
    for (const name of node.children.keys()) await copyAcross(join(src, name), join(dest, name), cmd, destArg, actor)
    return
  }
  if (lookup(dest)?.type === 'dir') throw err(`${cmd}: cannot overwrite directory '${destArg}' with non-directory`)
  if (w.kind === 'browser') {
    await browserFolder(into, cmd, destArg, actor)
    await guarded(actor, writeBrowserFile)((whereIs(dest) as { path: string }).path, await bytesOf(node)).catch(asCmdError(cmd))
  } else if (w.kind === 'sf') {
    if (w.ro || w.sf === SF) throw cannot('Read-only file system')
    await guarded(actor, uploadBlob)(w.sf, baseOf(dest), await bytesOf(node), { signal: typeof actor === 'boolean' ? undefined : actor.signal, check: () => mayWrite(actor, dest) })
    await listDir(w.sf, 0).catch(() => {})
  } else if (w.kind === 'local' && dest.startsWith('/tmp/')) {
    guarded(actor, writeTmp)('/', dest, await (await bytesOf(node)).text(), false, actor, cmd)
  } else throw cannot(w.kind === 'missing' ? 'Transport endpoint is not connected' : 'Read-only file system')
}
