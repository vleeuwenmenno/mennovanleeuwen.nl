import { choose, ask } from '../os/Dialogs'
import { notify } from '../os/notify'
import { trashIcons } from '../os/desktopStore'
import { filePaths, keyOp, type Drag, type DragItem, type DropOp } from '../os/dnd'
import { lookup as fsLookup, prepare, transfer as fsTransfer } from '../terminal/fs'
import { canChange, canWriteFolder, deleteNoteFor, dropOpFor, readBytes, removePaths, transferPaths } from './fileOps'
import { extract } from './extract'
import { posixPath, removeLauncher, writeLauncherFile } from './launchers'
import { fileLink, isInside, isSf, libraryName, listDir, parseSf, refreshDirs, renameItem, transferItems } from './seafile'
import { folderOfPath, nameOfPath, transferInto, undoMove, type Clash, type TransferPort, type TransferResult } from './transferPlan'
import { uploadFiles } from './uploads'

// What a drop into a folder does, the same on the desktop, in Files (a folder, its empty space,
// the sidebar) and on a folder icon: files and folders move within one place and copy between
// places (Seafile's libraries, this browser), or copy with Ctrl or Alt held; names already there
// ask first (replace, keep both, skip). Files from the computer upload, rows from Archive unpack,
// and a launcher or an app becomes a .desktop file there. The last move can be undone (Ctrl+Z).

/** The real filesystem, for transferPlan.ts. */
export const filesPort: TransferPort = {
  async names(dir) {
    if (isSf(dir)) {
      const l = await listDir(dir, 0).catch(() => null)
      return new Set(l?.entries.map((e) => e.name) ?? [])
    }
    await prepare('/', 'ls', [dir]).catch(() => {})
    const node = fsLookup(dir)
    return new Set(node?.type === 'dir' ? [...node.children.keys()] : [])
  },
  transfer: (op, paths, into) => transferPaths(op, paths, into),
  async transferAs(op, from, to) {
    const into = folderOfPath(to)
    const name = nameOfPath(to)
    // Within Seafile: its own move or copy (it numbers a name that is taken), then the rename.
    if (isSf(from) && isSf(into)) {
      const before = await filesPort.names(into)
      await transferItems(op, [from], into)
      const after = await filesPort.names(into)
      const landed = after.has(nameOfPath(from)) && !before.has(nameOfPath(from)) ? nameOfPath(from) : ([...after].find((n) => !before.has(n)) ?? nameOfPath(from))
      if (landed !== name) await renameItem(`${into}/${landed}`, name, !!(await isDir(`${into}/${landed}`)))
      refreshDirs(into)
      return
    }
    // Anything else through the terminal's filesystem, which carries the bytes over.
    const a = posixPath(from)
    const dir = posixPath(into)
    if (!a || !dir) throw new Error(`${nameOfPath(from)} is in Seafile but not mounted anywhere (see /etc/fstab)`)
    await prepare('/', 'cp', ['-r', a, dir])
    await fsTransfer(op, '/', a, `${dir === '/' ? '' : dir}/${name}`, true)
    if (isSf(into)) refreshDirs(into)
    if (isSf(from)) refreshDirs(folderOfPath(from))
  },
  remove: (paths) => removePaths(paths),
}

async function isDir(path: string): Promise<boolean> {
  const l = await listDir(folderOfPath(path), 0).catch(() => null)
  return !!l?.entries.find((e) => e.name === nameOfPath(path))?.dir
}

/** A folder's name in a dialog: the library for its top, else the folder's own name. */
function folderName(dir: string) {
  const at = parseSf(dir)
  if (at) return at.p === '/' ? libraryName(at.repo) : at.p.split('/').pop()!
  return nameOfPath(dir) || '/'
}

/** Names already in the folder: replace, keep both, or skip them (null: cancel the lot). */
export async function askClash(names: string[], into: string): Promise<Clash | null> {
  const one = names.length === 1
  const where = folderName(into)
  const kept = isSf(into) ? ' (Seafile keeps the old one in the trash)' : ''
  const id = await choose({
    title: one ? `“${names[0]}” is already in ${where}` : `${names.length} items are already in ${where}`,
    body: `${one ? '' : `${names.slice(0, 5).join(', ')}${names.length > 5 ? ` and ${names.length - 5} more` : ''}. `}Replace ${one ? 'it' : 'them'}${kept}, keep both (the new ${one ? 'one gets' : 'ones get'} a number), or leave ${one ? 'it' : 'them'} out?`,
    buttons: [
      { id: 'cancel', label: 'Cancel' },
      { id: 'skip', label: 'Skip' },
      { id: 'keep', label: 'Keep both' },
      { id: 'replace', label: 'Replace', primary: true },
    ],
  })
  return id === 'replace' || id === 'keep' || id === 'skip' ? id : null
}

// --- accepting --------------------------------------------------------------------------------

/** What dropping this into `into` would do: null when that folder does not take it. */
export function folderOp(drag: Drag, into: string): DropOp | null {
  if (!canWriteFolder(into)) return null
  if (drag.os) return 'copy'
  const items = drag.items
  if (items.some((i) => i.kind === 'entries')) return 'copy'
  const paths = filePaths(items)
  if (paths.length) {
    if (isInside(paths, into)) return null
    // Only what may change can move; the site's own files copy.
    const fallback = paths.every(canChange) ? dropOpFor(paths, into, {}) : 'copy'
    const op = keyOp(drag.keys, fallback)
    if (op === 'move' && !paths.every(canChange)) return 'copy'
    if (op === 'move' && paths.every((p) => folderOfPath(p) === into)) return null
    return op
  }
  if (items.some((i) => i.kind === 'launcher' || i.kind === 'app')) return 'link'
  return null
}

/** Where things landed: their new paths, and the launcher ids of .desktop files among them. */
export type Landed = { path: string; launcherId?: string }[]

let lastMove: TransferResult | null = null

/** Drops into a folder. Answers what landed there (nothing when it was cancelled or failed). */
export async function dropIntoFolder(drag: Drag, into: string, op: DropOp): Promise<Landed> {
  const landed: Landed = []
  try {
    if (drag.os) {
      const picked = await drag.files()
      for (const n of new Set(picked.map((p) => (p.rel ? p.rel.split('/')[0] : p.file.name)))) landed.push({ path: `${into}/${n}` })
      await uploadFiles(picked, into)
      return landed
    }
    for (const i of drag.items) if (i.kind === 'entries') await extract(i.zip, into, { entries: i.entries, base: i.base, clash: 'keep' })
    const files = drag.items.filter((i): i is Extract<DragItem, { kind: 'file' }> => i.kind === 'file')
    if (files.length && (op === 'move' || op === 'copy')) {
      const result = await transferInto(filesPort, op, files.map((f) => f.path), into, (names) => askClash(names, into))
      if (result) {
        if (op === 'move' && result.moved.length) lastMove = result
        for (const m of result.moved) landed.push({ path: m.to, launcherId: files.find((f) => f.path === m.from)?.launcher?.id })
      }
    }
    // A launcher (or an app) becomes a .desktop file here.
    for (const i of drag.items) {
      if (i.kind === 'launcher') landed.push({ path: await writeLauncherFile(into, { id: i.id, label: i.label, url: i.url, glyph: i.glyph, image: i.image, app: i.app, props: i.props }), launcherId: i.id })
      if (i.kind === 'app') {
        const id = crypto.randomUUID().slice(0, 8)
        landed.push({ path: await writeLauncherFile(into, { id, label: i.label, url: '', app: i.app }), launcherId: id })
      }
    }
    if (isSf(into)) refreshDirs(into)
  } catch (e) {
    notify({ title: op === 'move' ? 'Could not move it' : 'Could not copy it', body: (e as Error).message, transient: true })
  }
  return landed
}

/** Ctrl+Z: puts back what the last drag moved. */
export async function undoLastMove(): Promise<boolean> {
  const last = lastMove
  if (!last) return false
  lastMove = null
  try {
    const n = await undoMove(filesPort, last)
    if (n) notify({ title: `Moved ${n === 1 ? nameOfPath(last.moved[0].from) : `${n} items`} back`, transient: true })
  } catch (e) {
    notify({ title: 'Could not move it back', body: (e as Error).message, transient: true })
  }
  return true
}
export const canUndoMove = () => !!lastMove

// --- the trash ----------------------------------------------------------------------------------

/** Whether the trash takes this drag: files that may be deleted, launchers, the desktop's own icons. */
export function trashOp(drag: Drag): DropOp | null {
  if (drag.os || !drag.items.length) return null
  return drag.items.every((i) => (i.kind === 'file' ? canChange(i.path) : i.kind === 'launcher' || i.kind === 'icon')) ? 'trash' : null
}

/** Into the trash: files after asking (Seafile's trash, or for good from the browser); launchers and icons straight away. */
export async function dropInTrash(drag: Drag) {
  const paths = filePaths(drag.items)
  for (const i of drag.items) if (i.kind === 'launcher') removeLauncher(i.id)
  const icons = drag.items.flatMap((i) => (i.kind === 'icon' ? [i.id] : []))
  if (icons.length) trashIcons(icons)
  if (!paths.length) return
  // Launchers alone go without asking, as they always have.
  const plain = drag.items.filter((i) => i.kind === 'file' && !i.launcher)
  const what = paths.length === 1 ? nameOfPath(paths[0]) : `${paths.length} items`
  if (plain.length) {
    const note = await deleteNoteFor(paths)
    if (!(await ask({ title: note.final ? `Delete ${what} for good?` : `Delete ${what}?`, body: note.body, confirm: 'Delete', danger: true }))) return
  }
  await removePaths(paths).catch((e: Error) => notify({ title: 'Could not delete it', body: e.message, transient: true }))
}

// --- to the computer ------------------------------------------------------------------------------

/** Download addresses made ahead (a drag cannot wait for one), by path. */
const downloads = new Map<string, string>()

/** Starts getting a file's download address, so a drag that follows can hand it to the computer. */
export function prepareDownload(path: string, size = 0) {
  if (downloads.has(path)) return
  downloads.set(path, '')
  if (isSf(path)) void fileLink(path, 'download').then((url) => downloads.set(path, url), () => downloads.delete(path))
  // Kept in this browser: its bytes as a blob: address (up to 50 MB; bigger ones save from the menu).
  else if (size <= 50 * 1024 * 1024) void readBytes(path).then((b) => downloads.set(path, URL.createObjectURL(b)), () => downloads.delete(path))
  else downloads.delete(path)
}

/** Chrome's DownloadURL for a file, when its address is ready: "type:name:url". */
export function downloadUrl(path: string): string | null {
  const url = downloads.get(path)
  return url ? `application/octet-stream:${nameOfPath(path).replace(/:/g, '_')}:${url}` : null
}
