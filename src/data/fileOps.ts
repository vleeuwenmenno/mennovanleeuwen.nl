import { prepare, removePath, transfer as fsTransfer, makeDir, lookup as fsLookup } from '../terminal/fs'
import { browserFilesReady, browserParent, mkdirBrowser, readBrowserBlob, statBrowser, writeBrowserFile } from './browserfs'
import { posixOf, whereIs } from './mounts'
import { createFile, deleteItems, deleteNote, download, getLibrary, isSf, mkdir, parseSf, readBlob, renameItem, SF, transferItems } from './seafile'

// Changing files from Files, Zed and the desktop, wherever they are: Seafile (seafile:// paths)
// or this browser (data/browserfs.ts, reached by their place in the filesystem, like ~/Documents
// without Seafile). Seafile does its own moves and copies; anything else, the browser and moves
// between the two, goes through the terminal's filesystem (terminal/fs.ts), which carries the
// bytes over.

/** A path's place in the browser's store, when it is on the browser mount (stored there or not). */
export function browserPathOf(path: string): string | null {
  if (isSf(path)) return null
  const w = whereIs(path)
  return w.kind === 'browser' ? w.path : null
}

/** Whether a file or folder is kept in this browser (not one of the site's own files beneath it). */
export const inBrowser = (path: string) => {
  const p = browserPathOf(path)
  return p !== null && !!statBrowser(p)
}

/** Whether things can be made in this folder: a Seafile library you may write to, or the browser. */
export function canWriteFolder(dir: string): boolean {
  if (isSf(dir)) return dir !== SF && getLibrary(parseSf(dir)!.repo)?.permission === 'rw'
  return browserPathOf(dir) !== null && fsLookup(dir)?.type === 'dir'
}

/** Whether this file or folder can be renamed, moved or deleted (not a library, not the site's own). */
export const canChange = (path: string) => (isSf(path) ? parseSf(path)!.p !== '/' : inBrowser(path) && browserPathOf(path) !== '/')

/** The filesystem path for a Seafile path (where it is mounted), or the path itself. */
const posix = (path: string) => (isSf(path) ? posixOf(path) : path)

const parentOf = (p: string) => p.replace(/\/[^/]*$/, '') || '/'
const nameOf = (p: string) => p.split('/').pop() || ''

/** A name not taken in the folder yet: "untitled.txt", then "untitled 2.txt". */
function freeName(dir: string, name: string): string {
  const taken = (n: string) => !!fsLookup(`${dir === '/' ? '' : dir}/${n}`)
  if (!taken(name)) return name
  const dot = name.lastIndexOf('.')
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  for (let n = 2; ; n++) if (!taken(`${stem} ${n}${ext}`)) return `${stem} ${n}${ext}`
}

/** Runs a terminal filesystem call, giving its error without the command name in front. */
async function fs<T>(work: () => Promise<T>): Promise<T> {
  await browserFilesReady()
  try {
    return await work()
  } catch (e) {
    throw new Error((e as Error).message.replace(/^[\w-]+: (?:cannot [\w ]+ '[^']*': )?/, ''))
  }
}

/** A new folder; answers its path. */
export async function makeFolder(path: string): Promise<string> {
  if (isSf(path)) return mkdir(path)
  return fs(async () => {
    await makeDir('/', path, false)
    return path
  })
}

/** A new empty file, renamed when the name is taken; answers its path. */
export async function makeFile(path: string): Promise<string> {
  if (isSf(path)) return createFile(path)
  const dir = parentOf(path)
  const made = `${dir === '/' ? '' : dir}/${freeName(dir, nameOf(path))}`
  const store = browserPathOf(made)
  if (store === null) throw new Error('Read-only file system')
  await browserFilesReady()
  await writeBrowserFile(store, '')
  return made
}

/** Renames a file or folder in its folder; answers its new path. */
export async function renamePath(path: string, name: string, dir: boolean): Promise<string> {
  if (isSf(path)) return renameItem(path, name, dir)
  const to = `${parentOf(path) === '/' ? '' : parentOf(path)}/${name}`
  if (fsLookup(to)) throw new Error(`${name} already exists here`)
  return fs(async () => {
    await fsTransfer('move', '/', path, to, true)
    return to
  })
}

/** What deleting these means, for the dialog: Seafile's trash, or gone for good. */
export async function deleteNoteFor(paths: string[]): Promise<{ body: string; final: boolean }> {
  const sf = paths.filter(isSf)
  const local = paths.length - sf.length
  const note = sf.length ? await deleteNote(sf) : null
  if (!local) return note!
  const here = `${local === 1 ? 'It is' : 'They are'} kept in this browser, which has no trash: ${local === 1 ? 'it is' : 'they are'} gone for good.`
  return { body: note ? `${note.body} ${here}` : here, final: true }
}

/** Deletes files and folders: into Seafile's trash, or for good from the browser. */
export async function removePaths(paths: string[]) {
  const sf = paths.filter(isSf)
  if (sf.length) await deleteItems(sf)
  for (const p of paths.filter((x) => !isSf(x))) await fs(() => removePath('/', p, { recursive: true, force: true, dir: false }))
}

/**
 * Moves or copies into a folder. Seafile to Seafile is Seafile's own; the rest (the browser, and
 * between the browser and Seafile) goes through the filesystem, which needs Seafile mounted
 * (it is, at /mnt/seafile, unless fstab says otherwise).
 */
export async function transferPaths(op: 'move' | 'copy', paths: string[], into: string) {
  const sfOnes = isSf(into) ? paths.filter(isSf) : []
  if (sfOnes.length) await transferItems(op, sfOnes, into)
  const rest = paths.filter((p) => !sfOnes.includes(p))
  if (!rest.length) return
  const to = posix(into)
  if (!to) throw new Error('That Seafile folder is not mounted anywhere (see /etc/fstab)')
  for (const p of rest) {
    const from = posix(p)
    if (!from) throw new Error(`${nameOf(p)} is in Seafile but not mounted anywhere (see /etc/fstab)`)
    await fs(async () => {
      await prepare('/', 'cp', ['-r', from, to])
      await fsTransfer(op, '/', from, to, true)
    })
  }
}

/** Which a drop does: copy with Ctrl, move with Shift; otherwise move within one place, copy between places. */
export function dropOpFor(paths: string[], into: string, keys: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }): 'move' | 'copy' {
  if (keys.ctrlKey || keys.metaKey) return 'copy'
  if (keys.shiftKey) return 'move'
  const place = (p: string) => (isSf(p) ? `sf:${parseSf(p)?.repo}` : browserPathOf(p) !== null ? 'browser' : 'site')
  return paths.every((p) => place(p) === place(into)) ? 'move' : 'copy'
}

/** A file's bytes, wherever it is. */
export async function readBytes(path: string): Promise<Blob> {
  if (isSf(path)) return readBlob(path)
  const node = fsLookup(path)
  if (!node || node.type !== 'file') throw new Error(`${nameOf(path)}: no such file`)
  if (node.browser) return readBrowserBlob(node.browser)
  if (node.sf) return readBlob(node.sf)
  return new Blob([node.content()], { type: 'text/plain' })
}

/**
 * An editor's save into the browser: the text exactly as typed. One of the site's own files
 * under ~ (README.md, say) gets the browser's copy, over it.
 */
export async function saveText(path: string, text: string) {
  const store = browserPathOf(path)
  if (store === null) throw new Error('Read-only file system')
  await browserFilesReady()
  const folder = browserParent(store)
  if (!statBrowser(folder)) {
    if (fsLookup(parentOf(path))?.type !== 'dir') throw new Error(`${parentOf(path)}: no such folder`)
    await mkdirBrowser(folder, true)
  }
  await writeBrowserFile(store, text)
}

/** Saves a file to the computer: Seafile hands out a link, anything else is saved from here. */
export async function downloadFile(path: string) {
  if (isSf(path)) return download(path)
  const blob = await readBytes(path)
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = nameOf(path)
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
}
