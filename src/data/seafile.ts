import { useEffect, useState, useSyncExternalStore } from 'react'
import { api, getAccount, subscribeAccount, useAccount } from '../os/account'
import { synced } from '../os/synced'

// The linked Seafile account, for Files, Zed, the Viewer and the desktop (server/seafile.ts does
// the talking). A Seafile path is seafile://<library id>/<path in the library>, so it travels in
// window props like any other path. With "Use as home" on, the primary library is home: its
// Desktop, Documents, Downloads... folders are the ones in Files' Places and on the desktop.

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
}

const prefs = synced<SeafilePrefs>('seafile', { home: true, primary: null, lockMinutes: 30 }, {
  normalize: (v) => {
    const o = (v ?? {}) as Partial<SeafilePrefs>
    return { home: o.home !== false, primary: typeof o.primary === 'string' ? o.primary : null, lockMinutes: [5, 15, 30, 55].includes(o.lockMinutes as number) ? (o.lockMinutes as number) : 30 }
  },
})
export const useSeafilePrefs = prefs.use
export const getSeafilePrefs = prefs.get
export const setSeafilePrefs = (patch: Partial<SeafilePrefs>) => prefs.set((p) => ({ ...p, ...patch }))

// --- libraries -----------------------------------------------------------------------------------

let libraries: Library[] | null = null
let librariesError: string | null = null
let librariesLoading: Promise<void> | null = null
const libListeners = new Set<() => void>()
const emitLibs = () => libListeners.forEach((l) => l())

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

/** Home in Seafile (seafile://<primary>), or null when Seafile is not home. */
export function useSeafileHome(): { home: string | null; library: Library | null } {
  const { libraries } = useLibraries()
  const p = useSeafilePrefs()
  const library = primaryOf(libraries, p.primary)
  return { home: p.home && library ? sfPath(library.id) : null, library }
}

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

export async function mkdir(path: string): Promise<string> {
  const at = parseSf(path)!
  const { path: made } = await call<{ path: string }>('/api/seafile/dir', { method: 'POST', json: { repo: at.repo, path: at.p } })
  refreshDirs(sfPath(at.repo, at.p.split('/').slice(0, -1).join('/') || '/'))
  return sfPath(at.repo, made)
}

// --- files ---------------------------------------------------------------------------------------

/** A link on Seafile's file server: download (reusable for an hour), upload into a folder, update a file. */
export async function fileLink(path: string, op: 'download' | 'upload' | 'update'): Promise<string> {
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
