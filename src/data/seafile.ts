import { useEffect, useState, useSyncExternalStore } from 'react'
import { api, getAccount, subscribeAccount, useAccount } from '../os/account'
import { synced } from '../os/synced'
import type { AppId, WinState } from '../os/wm'
import { kindOfName, type FileKind } from '../terminal/vfs'
import { seafileHome, setHomeMount, setPlaceMount, useMounts } from './mounts'
import { isArchive } from './archive'

export { useSeafileHome } from './mounts'

// The linked Seafile account, for Files, Zed, the Viewer and the desktop (server/seafile.ts does
// the talking). A Seafile path is seafile://<library id>/<path in the library>, so it travels in
// window props like any other path. Where Seafile shows up (home, the places, /mnt/seafile) is
// /etc/fstab's to say (data/mounts.ts): "Use as home", the primary library and mapped places are
// lines in it, so Files, the desktop and the terminal all agree.

export const SF = 'seafile://'

export type Library = { id: string; name: string; type: 'mine' | 'shared' | 'group' | 'public'; owner: string | null; encrypted: boolean; permission: 'r' | 'rw'; size: number; mtime: number }
export type Entry = { name: string; dir: boolean; size: number; mtime: number; id: string; locked?: boolean }
export type Listing = { perm: 'r' | 'rw'; entries: Entry[] }

/** seafile://<repo>/a/b → { repo, p: '/a/b' }; null for any other path. */
export function parseSf(path: string): { repo: string; p: string } | null {
  if (!path.startsWith(SF)) return null
  const rest = path.slice(SF.length)
  const i = rest.indexOf('/')
  return i < 0 ? { repo: rest, p: '/' } : { repo: rest.slice(0, i), p: rest.slice(i) || '/' }
}

export const sfPath = (repo: string, p = '/') => `${SF}${repo}${p === '/' ? '' : p.replace(/\/+$/, '')}`
export const isSf = (path: string) => path.startsWith(SF)

// --- settings ------------------------------------------------------------------------------------

export type SeafilePrefs = {
  /** The primary library as home (Desktop, Documents... in Files and on the desktop) */
  home: boolean
  /** The primary library's id; null picks "My Library" */
  primary: string | null
  /** Minutes an encrypted library stays unlocked before its password is asked again */
  lockMinutes: number
  /** With Seafile as home: the site's own desktop icons next to the Seafile Desktop folder's (off: only Seafile's) */
  siteIcons: boolean
  /** Files' Trash is Seafile's (each library's own), instead of the site's pretend one */
  trash: boolean
  /** Where New Document and friends make their files; null: Documents in home */
  officeFolder: string | null
  /** New Document, New Spreadsheet and New Presentation on the desktop too */
  officeDesktop: boolean
  /** Places mapped to folders of your choosing (any library); unmapped ones are the same-named folder of the primary library */
  places: Partial<Record<PlaceId, string>>
}

export type PlaceId = 'home' | 'desktop' | 'documents' | 'downloads' | 'music' | 'pictures' | 'videos'
export const PLACES: { id: PlaceId; label: string; folder: string }[] = [
  { id: 'home', label: 'Home', folder: '' },
  { id: 'desktop', label: 'Desktop', folder: 'Desktop' },
  { id: 'documents', label: 'Documents', folder: 'Documents' },
  { id: 'downloads', label: 'Downloads', folder: 'Downloads' },
  { id: 'music', label: 'Music', folder: 'Music' },
  { id: 'pictures', label: 'Pictures', folder: 'Pictures' },
  { id: 'videos', label: 'Videos', folder: 'Videos' },
]

const prefs = synced<SeafilePrefs>('seafile', { home: true, primary: null, lockMinutes: 30, siteIcons: true, trash: true, officeFolder: null, officeDesktop: false, places: {} }, {
  normalize: (v) => {
    const o = (v ?? {}) as Partial<SeafilePrefs>
    return { home: o.home !== false, primary: typeof o.primary === 'string' ? o.primary : null, lockMinutes: [5, 15, 30, 55].includes(o.lockMinutes as number) ? (o.lockMinutes as number) : 30, siteIcons: o.siteIcons !== false, trash: o.trash !== false, officeFolder: typeof o.officeFolder === 'string' && o.officeFolder.startsWith(SF) ? o.officeFolder : null, officeDesktop: o.officeDesktop === true, places: Object.fromEntries(Object.entries(o.places ?? {}).filter(([k, v]) => PLACES.some((p) => p.id === k) && typeof v === 'string' && v.startsWith(SF))) }
  },
})
/** The settings as stored, before fstab has its say (fstab is written from these at first). */
export const getSeafilePrefsStored = prefs.get

/** The settings, with home and the primary library as fstab has them. */
export function getSeafilePrefs(): SeafilePrefs {
  const p = prefs.get()
  const h = seafileHome()
  return { ...p, home: !!h.home, primary: h.library?.id ?? p.primary, places: h.mapped }
}
export function useSeafilePrefs(): SeafilePrefs {
  prefs.use()
  useMounts()
  return getSeafilePrefs()
}
/** Home and the primary library change fstab's home line; the rest are plain settings. */
export function setSeafilePrefs(patch: Partial<SeafilePrefs>) {
  const now = getSeafilePrefs()
  prefs.set((p) => ({ ...p, ...patch }))
  if ('home' in patch || 'primary' in patch) {
    const home = patch.home ?? now.home
    const primary = patch.primary ?? now.primary ?? primaryOf(libraries, null)?.id ?? null
    setHomeMount(home ? primary : null)
  }
}

// --- libraries -----------------------------------------------------------------------------------

let libraries: Library[] | null = null
let librariesError: string | null = null
let librariesLoading: Promise<void> | null = null
const libListeners = new Set<() => void>()
const emitLibs = () => libListeners.forEach((l) => l())

/** The libraries if loaded (null before, or without Seafile), for code outside React. */
export const getLibraries = () => libraries
export const subscribeLibraries = (l: () => void) => {
  libListeners.add(l)
  return () => libListeners.delete(l)
}

export function loadLibraries(fresh = false): Promise<void> {
  if (!getAccount().seafile) return Promise.resolve()
  if (librariesLoading && !fresh) return librariesLoading
  librariesLoading = api<Library[]>('/api/seafile/libraries')
    .then((l) => {
      libraries = l
      librariesError = null
    })
    .catch((e: Error) => {
      librariesError = e.message
    })
    .finally(emitLibs)
  return librariesLoading
}

// Linking, unlinking or relinking starts over.
let linkedAs: string | null = null
subscribeAccount(() => {
  const s = getAccount().seafile
  const id = s ? `${s.url} ${s.username}` : null
  if (id === linkedAs) return
  linkedAs = id
  libraries = null
  librariesError = null
  librariesLoading = null
  dirCache.clear()
  unlocks = {}
  emitLibs()
  emitDirs()
  emitUnlocks()
})

/** The libraries, loading them on first use; null until they are there (or without Seafile). */
export function useLibraries(): { libraries: Library[] | null; error: string | null } {
  const account = useAccount()
  const libs = useSyncExternalStore(
    (l) => {
      libListeners.add(l)
      return () => libListeners.delete(l)
    },
    () => libraries,
  )
  useEffect(() => {
    if (account.seafile && !libraries && !librariesLoading) void loadLibraries()
  }, [account.seafile])
  return { libraries: account.seafile ? libs : null, error: librariesError }
}

/** The primary library: the one picked, else "My Library", else the first of your own. */
export function primaryOf(libs: Library[] | null, primary: string | null): Library | null {
  if (!libs?.length) return null
  return libs.find((l) => l.id === primary) ?? libs.find((l) => l.type === 'mine' && l.name === 'My Library') ?? libs.find((l) => l.type === 'mine') ?? libs[0]
}

/** The default folder of a place: the same-named folder in the primary library. */
export const defaultPlace = (library: Library, id: PlaceId) => {
  const folder = PLACES.find((p) => p.id === id)!.folder
  return folder ? `${sfPath(library.id)}/${folder}` : sfPath(library.id)
}

/** Maps a place onto a folder (a bind line in fstab), or back to home's own (null). */
export const setPlace = (id: PlaceId, path: string | null) => setPlaceMount(id, path)

export const libraryName = (repo: string) => libraries?.find((l) => l.id === repo)?.name ?? 'Seafile'
export const getLibrary = (repo: string) => libraries?.find((l) => l.id === repo) ?? null

// --- folders -------------------------------------------------------------------------------------

type DirState = { listing: Listing | null; error: string | null; status: number | null; loading: boolean }
const dirCache = new Map<string, DirState & { at: number }>()
const dirListeners = new Set<() => void>()
let dirVersion = 0
const emitDirs = () => {
  dirVersion++
  dirListeners.forEach((l) => l())
}

class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** Like api(), but keeps the status (423 is a locked library). */
async function call<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init
  const res = await fetch(path, { ...rest, credentials: 'same-origin', headers: json !== undefined ? { 'Content-Type': 'application/json' } : undefined, body: json !== undefined ? JSON.stringify(json) : rest.body })
  const body = await res.json().catch(() => null)
  if (res.status === 423) throw new ApiError(423, 'That library is locked: open it in Files and give its password first')
  if (!res.ok) throw new ApiError(res.status, body?.error ?? `Request failed (${res.status})`)
  return body as T
}

function fetchDir(path: string) {
  const at = parseSf(path)
  if (!at) return
  const prev = dirCache.get(path)
  dirCache.set(path, { listing: prev?.listing ?? null, error: null, status: null, loading: true, at: Date.now() })
  emitDirs()
  call<Listing>(`/api/seafile/dir?repo=${encodeURIComponent(at.repo)}&p=${encodeURIComponent(at.p)}`)
    .then((listing) => dirCache.set(path, { listing, error: null, status: null, loading: false, at: Date.now() }))
    .catch((e: ApiError) => dirCache.set(path, { listing: null, error: e.message, status: e.status ?? null, loading: false, at: Date.now() }))
    .finally(emitDirs)
}

/** Lists again: the folder itself, or everything under a library or path prefix. */
export function refreshDirs(prefix: string) {
  for (const key of [...dirCache.keys()]) if (key === prefix || key.startsWith(prefix.endsWith('/') ? prefix : prefix + '/')) dirCache.delete(key)
  // A download link is for the file as it was: anything changed in there gets new ones.
  for (const key of [...downloads.keys()]) if (key === prefix || key.startsWith(prefix.endsWith('/') ? prefix : prefix + '/')) downloads.delete(key)
  emitDirs()
}

/** A folder's listing, fetched on first use and again when older than `maxAge` ms. */
export function useDir(path: string | null, maxAge = 30_000): DirState & { reload: () => void } {
  useSyncExternalStore(
    (l) => {
      dirListeners.add(l)
      return () => dirListeners.delete(l)
    },
    () => dirVersion,
  )
  const hit = path ? dirCache.get(path) : undefined
  useEffect(() => {
    if (!path || !isSf(path)) return
    const h = dirCache.get(path)
    if (!h || (!h.loading && Date.now() - h.at > maxAge)) fetchDir(path)
  }, [path, hit, maxAge])
  return { listing: hit?.listing ?? null, error: hit?.error ?? null, status: hit?.status ?? null, loading: hit ? hit.loading : !!path && isSf(path), reload: () => path && fetchDir(path) }
}

/**
 * A folder's listing for code that can wait (the terminal): from the cache while fresh, else
 * asked for. Rejects with the status kept (423: an encrypted library that is locked).
 */
export async function listDir(path: string, maxAge = 30_000): Promise<Listing> {
  const hit = dirCache.get(path)
  if (hit?.listing && !hit.loading && Date.now() - hit.at < maxAge) return hit.listing
  const at = parseSf(path)!
  try {
    const listing = await call<Listing>(`/api/seafile/dir?repo=${encodeURIComponent(at.repo)}&p=${encodeURIComponent(at.p)}`)
    dirCache.set(path, { listing, error: null, status: null, loading: false, at: Date.now() })
    return listing
  } catch (e) {
    const err = e as ApiError
    dirCache.set(path, { listing: null, error: err.message, status: err.status ?? null, loading: false, at: Date.now() })
    throw err
  } finally {
    emitDirs()
  }
}

/** What the cache knows of a folder right now, without asking: its listing, or the failure (status). */
export function cachedDir(path: string): { listing: Listing | null; status: number | null } | null {
  const hit = dirCache.get(path)
  return hit && !hit.loading ? { listing: hit.listing, status: hit.status } : null
}

/** The status a Seafile call failed with (423: locked), if it kept one. */
export const errorStatus = (e: unknown): number | null => (e instanceof ApiError ? e.status : null)

export async function mkdir(path: string): Promise<string> {
  const at = parseSf(path)!
  const { path: made } = await call<{ path: string }>('/api/seafile/dir', { method: 'POST', json: { repo: at.repo, path: at.p } })
  refreshDirs(sfPath(at.repo, at.p.split('/').slice(0, -1).join('/') || '/'))
  return sfPath(at.repo, made)
}

// --- files ---------------------------------------------------------------------------------------

// Download links can be used again for an hour; kept for a few minutes so going back and forth
// between pictures does not ask Seafile every time.
const downloads = new Map<string, { at: number; url: Promise<string> }>()

/** A link on Seafile's file server: download (reusable for an hour), upload into a folder, update a file. */
export async function fileLink(path: string, op: 'download' | 'upload' | 'update'): Promise<string> {
  if (op === 'download') {
    const hit = downloads.get(path)
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit.url
    const url = linkFor(path, op)
    downloads.set(path, { at: Date.now(), url })
    url.catch(() => downloads.delete(path))
    return url
  }
  return linkFor(path, op)
}

async function linkFor(path: string, op: 'download' | 'upload' | 'update'): Promise<string> {
  const at = parseSf(path)!
  const { url } = await call<{ url: string }>(`/api/seafile/link?repo=${encodeURIComponent(at.repo)}&p=${encodeURIComponent(at.p)}&op=${op}`)
  return url
}

/** A file's text, straight from Seafile's file server. */
export async function readText(path: string): Promise<string> {
  const res = await fetch(await fileLink(path, 'download'))
  if (!res.ok) throw new Error(`Seafile answered ${res.status}`)
  return res.text()
}

/** Overwrites a file with new text (the editor's save). */
export async function writeText(path: string, text: string) {
  const at = parseSf(path)!
  const dir = at.p.split('/').slice(0, -1).join('/') || '/'
  const link = await fileLink(sfPath(at.repo, dir), 'update')
  const form = new FormData()
  form.append('file', new Blob([text], { type: 'text/plain' }), at.p.split('/').pop()!)
  form.append('target_file', at.p)
  const res = await fetch(`${link}?ret-json=1`, { method: 'POST', body: form })
  if (!res.ok) throw new Error((await res.text().catch(() => '')) || `Seafile answered ${res.status}`)
  refreshDirs(sfPath(at.repo, dir))
}

/** A hook for a file's download link (for images, video, audio and PDFs). */
export function useFileLink(path: string | null): { url: string | null; error: string | null; status: number | null } {
  const [state, setState] = useState<{ url: string | null; error: string | null; status: number | null }>({ url: null, error: null, status: null })
  useEffect(() => {
    if (!path) return
    let live = true
    setState({ url: null, error: null, status: null })
    fileLink(path, 'download')
      .then((url) => live && setState({ url, error: null, status: null }))
      .catch((e: ApiError) => live && setState({ url: null, error: e.message, status: e.status ?? null }))
    return () => {
      live = false
    }
  }, [path])
  return state
}

// --- encrypted libraries -------------------------------------------------------------------------

let unlocks: Record<string, number> = {}
const unlockListeners = new Set<() => void>()
const emitUnlocks = () => unlockListeners.forEach((l) => l())

export async function unlock(repo: string, password: string) {
  const { until } = await call<{ until: number }>('/api/seafile/unlock', { method: 'POST', json: { repo, password, minutes: prefs.get().lockMinutes } })
  unlocks = { ...unlocks, [repo]: until }
  emitUnlocks()
  refreshDirs(sfPath(repo))
}

export async function lock(repo: string) {
  await call('/api/seafile/lock', { method: 'POST', json: { repo } })
  const { [repo]: _, ...rest } = unlocks
  unlocks = rest
  emitUnlocks()
  refreshDirs(sfPath(repo))
}

/** When each unlocked library locks again, outside React. */
export const getUnlocks = () => unlocks

/** When each unlocked library locks again. */
export function useUnlocks(): Record<string, number> {
  return useSyncExternalStore(
    (l) => {
      unlockListeners.add(l)
      return () => unlockListeners.delete(l)
    },
    () => unlocks,
  )
}

/** Picks up libraries unlocked in another tab or window of this browser before a reload. */
export async function loadUnlocks() {
  if (!getAccount().seafile) return
  unlocks = await call<Record<string, number>>('/api/seafile/unlock').catch(() => unlocks)
  emitUnlocks()
}

// --- opening -------------------------------------------------------------------------------------

type Opener = { open: (app: AppId, props?: WinState['props']) => void; openNew: (app: AppId, props?: WinState['props']) => void }

/** Saves a file from Seafile through the browser's own download. */
export async function download(path: string) {
  const a = document.createElement('a')
  a.href = await fileLink(path, 'download')
  a.download = path.split('/').pop() ?? ''
  a.rel = 'noopener'
  a.click()
}

/**
 * Opens a Seafile path the way Files and the desktop do: folders in Files, text and code in Zed,
 * pictures in Preview, video in Player, music in Omamp, PDFs in PDF; anything else downloads.
 */
export function openSeafile(wm: Opener, path: string, opts: { dir?: boolean; how?: 'default' | 'zed' | 'viewer' | 'preview' | 'player' | 'amp' | 'pdf' | 'office' | 'archive' } = {}): Promise<void> {
  const name = path.split('/').pop() ?? ''
  const kind: FileKind = kindOfName(name, opts.dir)
  const how = opts.how ?? 'default'
  if (kind === 'folder') return Promise.resolve(wm.openNew('files', { path }))
  if (how === 'zed' || (how === 'default' && (kind === 'text' || kind === 'markdown'))) return Promise.resolve(wm.open('zed', { path, view: kind === 'markdown' ? 'preview' : undefined, t: String(Date.now()) }))
  if (how === 'preview' || (how === 'default' && kind === 'image')) return Promise.resolve(wm.openNew('preview', { path }))
  if (how === 'amp' || (how === 'default' && kind === 'audio')) return Promise.resolve(wm.openNew('amp', { path, t: String(Date.now()) }))
  if (how === 'player' || (how === 'default' && kind === 'video')) return Promise.resolve(wm.openNew('player', { path }))
  if (how === 'pdf' || (how === 'default' && kind === 'pdf')) return Promise.resolve(wm.openNew('pdf', { path }))
  if (how === 'archive' || (how === 'default' && isArchive(name))) return Promise.resolve(wm.openNew('archive', { path }))
  if (how === 'office' || (how === 'default' && kind === 'document' && getAccount().seafile?.office)) return Promise.resolve(wm.openNew('office', { path }))
  if (how === 'viewer') return Promise.resolve(wm.openNew('viewer', { path }))
  return download(path)
}

// --- changing things -----------------------------------------------------------------------------

const parentPath = (path: string) => {
  const at = parseSf(path)!
  return sfPath(at.repo, at.p.split('/').slice(0, -1).join('/') || '/')
}

/** Renames a file or folder; answers its new path. */
export async function renameItem(path: string, name: string, dir: boolean): Promise<string> {
  const at = parseSf(path)!
  const { path: made } = await call<{ path: string }>('/api/seafile/rename', { method: 'POST', json: { repo: at.repo, path: at.p, dir, name } })
  refreshDirs(parentPath(path))
  if (dir) refreshDirs(path)
  return sfPath(at.repo, made)
}

/** A new empty file (Office files get Seafile's blank template); answers its path. */
export async function createFile(path: string): Promise<string> {
  const at = parseSf(path)!
  const { path: made } = await call<{ path: string }>('/api/seafile/file', { method: 'POST', json: { repo: at.repo, path: at.p } })
  refreshDirs(parentPath(path))
  return sfPath(at.repo, made)
}

/** Groups paths by the folder they are in: Seafile's batch calls work per folder. */
function byFolder(paths: string[]) {
  const groups = new Map<string, { repo: string; parent: string; names: string[] }>()
  for (const path of paths) {
    const at = parseSf(path)
    if (!at || at.p === '/') continue
    const parent = at.p.split('/').slice(0, -1).join('/') || '/'
    const key = `${at.repo}:${parent}`
    if (!groups.has(key)) groups.set(key, { repo: at.repo, parent, names: [] })
    groups.get(key)!.names.push(at.p.split('/').pop()!)
  }
  return [...groups.values()]
}

/** Deletes files and folders (into the library's trash on Seafile, where they can be restored). */
export async function deleteItems(paths: string[]) {
  for (const g of byFolder(paths)) {
    await call('/api/seafile/delete', { method: 'POST', json: g })
    refreshDirs(sfPath(g.repo, g.parent))
  }
  for (const p of paths) refreshDirs(p)
}

/** Moves or copies into a folder; taken names get " (1)". */
export async function transferItems(op: 'move' | 'copy', paths: string[], into: string) {
  const to = parseSf(into)!
  for (const g of byFolder(paths)) {
    await call('/api/seafile/transfer', { method: 'POST', json: { op, from: { repo: g.repo, parent: g.parent }, names: g.names, to: { repo: to.repo, parent: to.p } } })
    refreshDirs(sfPath(g.repo, g.parent))
  }
  refreshDirs(into)
  if (op === 'move') for (const p of paths) refreshDirs(p)
}

/** Move within a library, copy into another one (as file managers do); Ctrl copies, Shift moves. */
export function dropOp(paths: string[], into: string, keys: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }): 'move' | 'copy' {
  if (keys.ctrlKey || keys.metaKey) return 'copy'
  if (keys.shiftKey) return 'move'
  const repo = parseSf(into)?.repo
  return paths.every((p) => parseSf(p)?.repo === repo) ? 'move' : 'copy'
}

/** Whether `into` is one of `paths` or inside one (a folder cannot go into itself). */
export const isInside = (paths: string[], into: string) => paths.some((p) => into === p || into.startsWith(p + '/'))

// Cut, copy and paste, shared by every Files window and the desktop.
let clipboard: { op: 'move' | 'copy'; paths: string[] } | null = null
const clipListeners = new Set<() => void>()
export function setClipboard(next: typeof clipboard) {
  clipboard = next
  clipListeners.forEach((l) => l())
}
export const getClipboard = () => clipboard
export const useClipboard = () =>
  useSyncExternalStore(
    (l) => {
      clipListeners.add(l)
      return () => clipListeners.delete(l)
    },
    () => clipboard,
  )

// Files dragged between Files windows and the desktop. The paths ride along in the drag's data;
// they are kept here too, because a dragover cannot read the data, only its type.
export const DRAG_FILES = 'application/x-mvlos-seafile'
let dragged: string[] | null = null
export const setDragged = (paths: string[] | null) => void (dragged = paths)
export const getDragged = () => dragged

// --- trash ---------------------------------------------------------------------------------------

export type TrashItem = { name: string; parent: string; dir: boolean; size: number; deleted: number; commit: string }

/** A page of a library's trash, newest first; pass `scan` from the last page for the next. */
export const listTrash = (repo: string, scan: string | null = null) =>
  call<{ items: TrashItem[]; more: boolean; scan: string | null }>(`/api/seafile/trash?repo=${encodeURIComponent(repo)}&p=%2F${scan ? `&scan=${encodeURIComponent(scan)}` : ''}`)

/** What was in a deleted folder when it went. */
export const listTrashDir = (repo: string, commit: string, path: string) =>
  call<Entry[]>(`/api/seafile/trash?repo=${encodeURIComponent(repo)}&commit=${encodeURIComponent(commit)}&p=${encodeURIComponent(path)}`)

/** Puts deleted things back where they were; lists their folders again. */
export async function restoreTrash(repo: string, commit: string, paths: string[]) {
  const res = await call<{ restored: string[]; failed: { path: string; error: string }[] }>('/api/seafile/trash/restore', { method: 'POST', json: { repo, commit, paths } })
  for (const p of res.restored) refreshDirs(sfPath(repo, p.split('/').slice(0, -1).join('/') || '/'))
  return res
}

/** Empties a library's trash of what was deleted more than `days` ago (0: everything). Cannot be undone. */
export const cleanTrash = (repo: string, days: number) => call('/api/seafile/trash/clean', { method: 'POST', json: { repo, days } })

// How long a library keeps its history, which is how long its trash keeps things: days, -1 for
// ever, 0 for not at all (a delete is then for good). Remembered for a minute, as it is asked
// before every delete.

const histories = new Map<string, { days: Promise<number>; at: number }>()

export function historyDays(repo: string): Promise<number> {
  const known = histories.get(repo)
  if (known && Date.now() - known.at < 60_000) return known.days
  const days = call<{ days: number }>(`/api/seafile/history?repo=${encodeURIComponent(repo)}`).then((r) => r.days)
  days.catch(() => histories.delete(repo))
  histories.set(repo, { days, at: Date.now() })
  return days
}

export async function setHistoryDays(repo: string, days: number): Promise<number> {
  const res = await call<{ days: number }>('/api/seafile/history', { method: 'POST', json: { repo, days } })
  histories.set(repo, { days: Promise.resolve(res.days), at: Date.now() })
  return res.days
}

/** What a delete confirmation says: the trash, or (in a library without history) that it is for good. */
export async function deleteNote(paths: string[]): Promise<{ body: string; final: boolean }> {
  const one = paths.length === 1
  const repos = [...new Set(paths.map((p) => parseSf(p)?.repo).filter((r): r is string => !!r))]
  const days = await Promise.all(repos.map((r) => historyDays(r).catch(() => null)))
  const none = repos.filter((_, i) => days[i] === 0)
  if (none.length) {
    const names = none.map((r) => libraries?.find((l) => l.id === r)?.name ?? 'This library').join(' and ')
    return { final: true, body: `${names} keeps no history, so ${one ? 'it is' : 'they are'} deleted for good. This cannot be undone. (Files → Trash can turn history on.)` }
  }
  return { final: false, body: `${one ? 'It goes' : 'They go'} to the library's trash on Seafile, where you can restore ${one ? 'it' : 'them'} (Files → Trash).` }
}

/** The account's storage: what its own libraries take, and its quota (null: none). */
export const getQuota = () => call<{ used: number; total: number | null }>('/api/seafile/quota')

/** A share link to copy: the file's or folder's existing one, or a new one. */
export async function shareLink(path: string): Promise<{ url: string; made: boolean }> {
  const at = parseSf(path)!
  return call('/api/seafile/share', { method: 'POST', json: { repo: at.repo, path: at.p } })
}

/** The same file or folder in Seafile's own web interface. */
export function seafileWebUrl(path: string): string | null {
  const base = getAccount().seafile?.url
  const at = parseSf(path)
  if (!base || !at) return null
  return `${base}/library/${at.repo}/${encodeURIComponent(libraryName(at.repo))}${at.p === '/' ? '/' : at.p.split('/').map(encodeURIComponent).join('/')}`
}
