import { useEffect, useSyncExternalStore } from 'react'
import { api } from '../os/account'
import { synced } from '../os/synced'

// The Photos app's data (server/photos.ts does the work): which sources are set up, the months
// there are photos in and each month's photos, a photo's details, albums and favourites, from
// Seafile (the server's index of the folders chosen) or Immich. Both answer the same way, so the
// app only ever says which one it asks.

export type SourceId = 'seafile' | 'immich'

export type Item = { id: string; /** when it was taken, on the photographer's clock (ms, as if UTC) */ wall: number; video: boolean; fav: boolean; ratio: number; duration: number | null; v: string }
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
  (await api<[string, number, number, number, number | null, string][]>(`/api/photos/${source}/bucket?${query(f, { key })}`)).map(([id, wall, flags, ratio, duration, v]) => ({ id, wall, video: (flags & 1) !== 0, fav: (flags & 2) !== 0, ratio, duration, v }))
export const getInfo = (source: SourceId, id: string) => api<Info>(`/api/photos/${source}/info?id=${encodeURIComponent(id)}`)
export const getAlbums = (source: SourceId) => api<Album[]>(`/api/photos/${source}/albums`)
export const setFavourite = (source: SourceId, id: string, on: boolean) => api(`/api/photos/${source}/favourite`, { method: 'PUT', json: { id, on } })

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
