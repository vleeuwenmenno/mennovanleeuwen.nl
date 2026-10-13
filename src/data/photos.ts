import { useEffect, useSyncExternalStore } from 'react'
import { api } from '../os/account'
import { synced } from '../os/synced'
import { sfPath } from './seafile'

// The Photos app's data (server/photos.ts does the work): which sources are set up, the months
// there are photos in and each month's photos, a photo's details, albums and favourites, from
// Seafile (the server's index of the folders chosen) or Immich. Both answer the same way, so the
// app only ever says which one it asks.

export type SourceId = 'seafile' | 'immich'

export type Item = {
  id: string
  /** when it was taken, on the photographer's clock (ms, as if UTC) */
  wall: number
  video: boolean
  fav: boolean
  ratio: number
  duration: number | null
  v: string
  /** Seafile: where it is (seafile://…), for dragging it to Files and moving it */
  path?: string
}
export type Bucket = { key: string; month: string; count: number }
export type Album = { id: string; name: string; count: number; cover: string | null; detail: string | null }

export type Info = {
  id: string
  name: string
  kind: 'image' | 'video'
  size: number | null
  taken: number
  takenFrom: 'exif' | 'video' | 'file' | 'immich'
  offset: string | null
  width: number | null
  height: number | null
  make: string | null
  model: string | null
  lens: string | null
  exposure: number | null
  fnumber: number | null
  iso: number | null
  focal: number | null
  focal35: number | null
  lat: number | null
  lon: number | null
  alt: number | null
  place: string | null
  favourite: boolean
  duration: number | null
  repo?: string
  path?: string
  library?: string
  web?: string
}

export type Job = {
  state: 'waiting' | 'listing' | 'reading' | 'done' | 'failed'
  started: number
  finished: number | null
  folders: number
  files: number
  toRead: number
  read: number
  added: number
  removed: number
  skipped: { repo: string; library: string; why: string }[]
  errors: string[]
  capped: boolean
}

export type PhotoFolder = { repo: string; path: string; library: string | null; name: string; encrypted: boolean; locked: boolean; count: number }
export type ImmichInfo = { url: string; name: string | null; email: string | null; version: string }
export type Status = { seafile: { sources: PhotoFolder[]; job: Job | null; scannedAt: number | null } | null; immich: ImmichInfo | null }

/** The app's choices that follow the user between devices: the source shown (when both are set up) and the grid's zoom. */
export const photosPrefs = synced<{ source: SourceId | null; zoom: number }>('photos', { source: null, zoom: 2 })

/** The viewer's offset from UTC (minutes, as getTimezoneOffset), for dates that are real instants. */
const tz = () => new Date().getTimezoneOffset()

/** File and video times are instants: on the viewer's clock. EXIF and Immich's are the photographer's already. */
export const wallOf = (info: Pick<Info, 'taken' | 'takenFrom'>) => (info.takenFrom === 'file' || info.takenFrom === 'video' ? info.taken - new Date(info.taken).getTimezoneOffset() * 60_000 : info.taken)

export type Filter = { album?: string | null; favourites?: boolean }
const query = (f: Filter, extra: Record<string, string> = {}) => {
  const q = new URLSearchParams({ tz: String(tz()), ...extra })
  if (f.album) q.set('album', f.album)
  if (f.favourites) q.set('fav', '1')
  return q
}

export const getBuckets = (source: SourceId, f: Filter) => api<Bucket[]>(`/api/photos/${source}/buckets?${query(f)}`)
export const getBucket = async (source: SourceId, key: string, f: Filter): Promise<Item[]> =>
  (await api<[string, number, number, number, number | null, string, string?][]>(`/api/photos/${source}/bucket?${query(f, { key })}`)).map(([id, wall, flags, ratio, duration, v, where]) => ({
    id,
    wall,
    video: (flags & 1) !== 0,
    fav: (flags & 2) !== 0,
    ratio,
    duration,
    v,
    ...(where ? { path: sfPath(where.slice(0, 36), where.slice(36) || '/') } : {}),
  }))
export const getInfo = (source: SourceId, id: string) => api<Info>(`/api/photos/${source}/info?id=${encodeURIComponent(id)}`)
export const getAlbums = (source: SourceId) => api<Album[]>(`/api/photos/${source}/albums`)
export const setFavourite = (source: SourceId, id: string, on: boolean) => api(`/api/photos/${source}/favourite`, { method: 'PUT', json: { id, on } })

// --- The selection: many at once ---------------------------------------------------------------------
// The server takes up to BATCH ids a request (server/photos.ts), so a big selection goes in turns.

const BATCH = 200
const batches = (ids: string[]) => Array.from({ length: Math.ceil(ids.length / BATCH) }, (_, i) => ids.slice(i * BATCH, (i + 1) * BATCH))

export async function setFavourites(source: SourceId, ids: string[], on: boolean) {
  for (const part of batches(ids)) await api(`/api/photos/${source}/favourite`, { method: 'PUT', json: { ids: part, on } })
}

/**
 * Moves photos to the source's own trash (Seafile's library trash, Immich's trash). Answers the
 * ids it took and the tokens that undo it; when a batch fails after others went, it stops there.
 */
export async function trashPhotos(source: SourceId, ids: string[]): Promise<{ trashed: string[]; undo: string[]; error: string | null }> {
  const trashed: string[] = []
  const undo: string[] = []
  for (const part of batches(ids)) {
    try {
      const r = await api<{ trashed: string[]; undo: string; error: string | null }>(`/api/photos/${source}/trash`, { method: 'POST', json: { ids: part } })
      trashed.push(...r.trashed)
      undo.push(r.undo)
      if (r.error) return { trashed, undo, error: r.error }
    } catch (e) {
      if (!trashed.length) throw e
      return { trashed, undo, error: (e as Error).message }
    }
  }
  return { trashed, undo, error: null }
}

/** Undoes trashPhotos: answers how many came back, and the names of any that did not. */
export async function restorePhotos(source: SourceId, undo: string[]): Promise<{ restored: number; failed: string[] }> {
  let restored = 0
  const failed: string[] = []
  for (const token of undo) {
    const r = await api<{ restored: string[]; failed: string[] }>(`/api/photos/${source}/restore`, { method: 'POST', json: { undo: token } })
    restored += r.restored.length
    failed.push(...r.failed)
  }
  return { restored, failed }
}

/** How many days Immich keeps its trash (null: not known). */
export const immichTrashDays = () => api<{ days: number | null }>('/api/photos/immich/trashinfo').then((r) => r.days)

/** The most photos in one ZIP (the server's cap too). */
export const MAX_ZIP = 2000

/** Saves photos as one ZIP, made on the server as it downloads (the browser's own download, so it streams to disk). */
export async function downloadZip(source: SourceId, ids: string[]) {
  const { url } = await api<{ url: string }>(`/api/photos/${source}/zip`, { method: 'POST', json: { ids } })
  const a = document.createElement('a')
  a.href = url
  a.download = ''
  a.rel = 'noopener'
  a.click()
}

/** Seafile: moves photos into a folder. `kept`: it is inside one of the chosen folders, so they stay in the timeline. */
export async function movePhotos(ids: string[], to: { repo: string; path: string }): Promise<{ moved: number; kept: boolean }> {
  let moved = 0
  let kept = true
  for (const part of batches(ids)) {
    const r = await api<{ moved: number; kept: boolean }>('/api/photos/seafile/move', { method: 'POST', json: { ids: part, to } })
    moved += r.moved
    kept = r.kept
  }
  return { moved, kept }
}

/** Immich: adds photos to an album. */
export async function addToAlbum(album: string, ids: string[]): Promise<{ added: number; already: number; failed: number }> {
  const sum = { added: 0, already: 0, failed: 0 }
  for (const part of batches(ids)) {
    const r = await api<typeof sum>('/api/photos/immich/album', { method: 'POST', json: { album, ids: part } })
    sum.added += r.added
    sum.already += r.already
    sum.failed += r.failed
  }
  return sum
}

/** The most Immich photos one drag brings along: each is downloaded when it is dropped. */
export const MAX_DRAG_DOWNLOADS = 50

/** Immich photos as files, downloaded through the server (for a drop on Files, Mail or Agents). */
export async function immichFiles(ids: string[]): Promise<File[]> {
  return Promise.all(
    ids.slice(0, MAX_DRAG_DOWNLOADS).map(async (id) => {
      const res = await fetch(originalUrl('immich', id, true), { credentials: 'same-origin' })
      if (!res.ok) throw new Error(`Immich answered ${res.status}`)
      const name = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(res.headers.get('content-disposition') ?? '')?.[1]
      const blob = await res.blob()
      return new File([blob], name ? decodeURIComponent(name) : `${id}.jpg`, { type: blob.type })
    }),
  )
}

/** "this photo", "3 videos", "5 items": what is chosen, for questions and notes. */
export function countOf(items: { video: boolean }[], n = items.length): string {
  const videos = items.filter((i) => i.video).length
  const kind = videos === 0 ? 'photo' : videos === items.length ? 'video' : 'item'
  return n === 1 ? `this ${kind}` : `${n.toLocaleString()} ${kind}s`
}

export type ThumbSize = 'small' | 'medium' | 'large'
export const thumbUrl = (source: SourceId, id: string, size: ThumbSize, v = '') => `/api/photos/${source}/thumb?id=${encodeURIComponent(id)}&size=${size}${v ? `&v=${v}` : ''}`
export const originalUrl = (source: SourceId, id: string, download = false) => `/api/photos/${source}/original?id=${encodeURIComponent(id)}${download ? '&download=1' : ''}`

/** Pictures a browser shows as they are; others (HEIC, TIFF) show as their large thumbnail. */
export const webShows = (name: string) => /\.(jpe?g|png|webp|gif|avif)$/i.test(name)

// --- Status: shared by every Photos window, asked again every second while a walk runs ---------------

let status: Status | null = null
let statusError: string | null = null
let loading: Promise<void> | null = null
let poll: ReturnType<typeof setTimeout> | null = null
let version = 0
const listeners = new Set<() => void>()
const emit = () => {
  version++
  listeners.forEach((l) => l())
}

export function loadStatus(): Promise<void> {
  loading ??= api<Status>('/api/photos/status')
    .then(
      (s) => {
        status = s
        statusError = null
      },
      (e: Error) => void (statusError = e.message),
    )
    .finally(() => {
      loading = null
      emit()
      if (poll) clearTimeout(poll)
      const job = status?.seafile?.job
      if (job && !job.finished && listeners.size) poll = setTimeout(() => void loadStatus(), 1000)
    })
  return loading
}

const setStatus = (s: Status) => {
  status = s
  emit()
  void loadStatus()
}

export function useStatus(): { status: Status | null; error: string | null; version: number } {
  useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => version,
  )
  useEffect(() => {
    if (!status && !loading) void loadStatus()
  }, [])
  return { status, error: statusError, version }
}

export const setSources = async (sources: { repo: string; path: string }[]) => setStatus(await api<Status>('/api/photos/sources', { method: 'PUT', json: { sources } }))
export const suggestFolders = () => api<{ repo: string; path: string; library: string; name: string }[]>('/api/photos/suggest')
export async function rescan() {
  await api('/api/photos/scan', { method: 'POST' })
  await loadStatus()
}

export async function linkImmich(url: string, key: string) {
  await api<ImmichInfo>('/api/integrations/immich', { method: 'POST', json: { url, key } })
  await loadStatus()
}
export async function unlinkImmich() {
  await api('/api/integrations/immich', { method: 'DELETE' })
  await loadStatus()
}

// --- Formatting -------------------------------------------------------------------------------------

const UTC = { timeZone: 'UTC' } as const
export const monthTitle = (month: string) => new Date(`${month}-01T00:00:00Z`).toLocaleDateString(undefined, { ...UTC, month: 'long', year: 'numeric' })
export const dayTitle = (wall: number) => {
  const d = new Date(wall)
  const today = new Date()
  const sameYear = d.getUTCFullYear() === today.getFullYear()
  return d.toLocaleDateString(undefined, { ...UTC, weekday: 'short', day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) })
}
export const fullDate = (wall: number) => new Date(wall).toLocaleString(undefined, { ...UTC, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })
export const duration = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`
export const exposureText = (s: number) => (s >= 1 ? `${Math.round(s * 10) / 10} s` : `1/${Math.round(1 / s)} s`)
export const coordinates = (lat: number, lon: number) => `${Math.abs(lat).toFixed(5)}° ${lat < 0 ? 'S' : 'N'}, ${Math.abs(lon).toFixed(5)}° ${lon < 0 ? 'W' : 'E'}`
