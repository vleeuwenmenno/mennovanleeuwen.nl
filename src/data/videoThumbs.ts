import { useEffect, useState } from 'react'
import { getAccount } from '../os/account'
import { lookup } from '../terminal/fs'
import { filesPrefs } from './appPrefs'
import { readBrowserBlob } from './browserfs'
import { streamOf } from './media'
import { getLibraries, getLibrary, getUnlocks, loadLibraries, parseSf } from './seafile'

// A frame from a video, as its icon in Files, on the desktop and in Photos. Seafile makes video
// thumbnails only when its server is set up for them (ENABLE_VIDEO_THUMBNAIL, with ffmpeg on the
// Seahub host; off by default), and never in encrypted libraries. So it is asked first, and when it
// has none the browser makes one itself: a hidden, muted <video> loads the file's header, seeks to
// a tenth of the way in (or a second, for short clips), and that frame is drawn onto a canvas and
// kept as a small WebP. Seafile's videos come through this site (/api/seafile/stream, which answers
// byte ranges), so the canvas is not tainted and only the header and the bytes around that one
// frame are read; files kept in this browser come from their blob.
//
// The frames are kept in IndexedDB, per account, keyed by the file and its version (so a changed
// file gets a new one), at most MAX_ENTRIES of them and MAX_BYTES in all, the least recently shown
// going first. Only tiles on screen ask, at most two frames are made at a time, a tile scrolled
// away or a window closed stops its work, and what failed is not tried again that visit, nor for
// a day after (that is kept too, as a row without a picture).
// Nothing ever plays, so nothing is ever heard.

/** The videos a browser can usually open (an mkv or mov with a codec it lacks falls back to the icon). */
export const videoThumbable = (name: string) => /\.(mp4|m4v|mov|webm|mkv|ogv)$/i.test(name)

export type VideoThumb = { url: string; duration: number | null }

/** The longest side of a frame kept, enough for Files' gallery at 200%. */
const MAX_PX = 480
const MAX_AT_ONCE = 2
const MAX_ENTRIES = 2000
const MAX_BYTES = 50 * 1024 * 1024
/**
 * Seafile's file server ignores byte ranges in encrypted libraries, so the stream route reads
 * everything before the frame (and a header at the end, everything) through this server.
 */
const MAX_ENCRYPTED = 64 * 1024 * 1024
const STEP_TIMEOUT = 20_000
/** How long a video that gave no frame is left alone. */
const FAILED_FOR = 86_400_000

// --- this page's memory ---------------------------------------------------------------------------

/** Frames already shown on this page (blob: addresses), the oldest let go past MEMORY. */
const memory = new Map<string, VideoThumb>()
const MEMORY = 400
const failed = new Set<string>()

function remember(key: string, thumb: VideoThumb) {
  memory.delete(key)
  memory.set(key, thumb)
  while (memory.size > MEMORY) {
    const [oldest, t] = memory.entries().next().value!
    memory.delete(oldest)
    URL.revokeObjectURL(t.url)
  }
}

/** How busy it is, for checks (exposed on window.__videoThumbs in development). */
const stats = { making: 0, most: 0, made: 0, cached: 0, failed: 0 }
if (import.meta.env.DEV && typeof window !== 'undefined') (window as unknown as { __videoThumbs: typeof stats }).__videoThumbs = stats

// --- IndexedDB (every use fails soft: without it, frames are just made again) ----------------------

/** A frame, or (blob null) a video that gave none, as of `used`. */
type Row = { key: string; blob: Blob | null; duration: number | null; used: number; bytes: number }
const STORE = 'frames'
const dbName = (userId: number) => `mvlos-video-thumbs-${userId}`
let dbFor: { user: number; db: Promise<IDBDatabase | null> } | null = null

function db(): Promise<IDBDatabase | null> {
  const user = getAccount().user?.id
  if (user === undefined || typeof indexedDB === 'undefined') return Promise.resolve(null)
  if (dbFor?.user === user) return dbFor.db
  void dbFor?.db.then((d) => d?.close())
  const opening = new Promise<IDBDatabase | null>((resolve) => {
    try {
      const req = indexedDB.open(dbName(user), 1)
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'key' }).createIndex('used', 'used')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  dbFor = { user, db: opening }
  return opening
}

const settle = <T>(req: IDBRequest<T>) =>
  new Promise<T | null>((resolve) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(null)
  })

async function cacheGet(key: string): Promise<Row | null> {
  try {
    const d = await db()
    if (!d) return null
    const row = await settle(d.transaction(STORE, 'readonly').objectStore(STORE).get(key) as IDBRequest<Row | undefined>)
    if (!row) return null
    if (!row.blob) return Date.now() - row.used < FAILED_FOR ? row : null
    // Shown again: the least recently shown go first when it is full (written at most hourly).
    if (Date.now() - row.used > 3_600_000) void settle(d.transaction(STORE, 'readwrite').objectStore(STORE).put({ ...row, used: Date.now() }))
    return row
  } catch {
    return null
  }
}

/** Entries and bytes kept, counted once per page and then kept up to date here. */
let tally: { count: number; bytes: number } | null = null

async function cachePut(key: string, blob: Blob | null, duration: number | null) {
  try {
    const d = await db()
    if (!d) return
    const bytes = blob?.size ?? 0
    await settle(d.transaction(STORE, 'readwrite').objectStore(STORE).put({ key, blob, duration, used: Date.now(), bytes } satisfies Row))
    if (tally) {
      tally.count++
      tally.bytes += bytes
    }
    if (!tally || tally.count > MAX_ENTRIES || tally.bytes > MAX_BYTES) await prune(d)
  } catch {
    // Full or gone: it is made again next time.
  }
}

/** Counts what is kept and, past either cap, deletes the least recently shown down to 90% of it. */
function prune(d: IDBDatabase): Promise<void> {
  return new Promise((resolve) => {
    try {
      const tx = d.transaction(STORE, 'readwrite')
      const rows: { key: string; bytes: number }[] = []
      const cursor = tx.objectStore(STORE).index('used').openCursor()
      cursor.onsuccess = () => {
        const c = cursor.result
        if (c) {
          const r = c.value as Row
          rows.push({ key: r.key, bytes: r.bytes || 0 })
          return c.continue()
        }
        let count = rows.length
        let bytes = rows.reduce((n, r) => n + r.bytes, 0)
        if (count > MAX_ENTRIES || bytes > MAX_BYTES)
          for (const r of rows) {
            if (count <= MAX_ENTRIES * 0.9 && bytes <= MAX_BYTES * 0.9) break
            tx.objectStore(STORE).delete(r.key)
            count--
            bytes -= r.bytes
          }
        tally = { count, bytes }
      }
      tx.oncomplete = tx.onerror = tx.onabort = () => resolve()
    } catch {
      resolve()
    }
  })
}

/** Deletes this account's frames on this browser (with its files, when the account goes). */
export async function wipeVideoThumbs(userId = getAccount().user?.id) {
  if (userId === undefined || typeof indexedDB === 'undefined') return
  if (dbFor?.user === userId) {
    void dbFor.db.then((d) => d?.close())
    dbFor = null
  }
  tally = null
  await new Promise<void>((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(dbName(userId))
      req.onsuccess = req.onerror = req.onblocked = () => resolve()
    } catch {
      resolve()
    }
  })
}

// --- two at a time --------------------------------------------------------------------------------

const abortError = () => new DOMException('Stopped', 'AbortError')
const waiting: { go: () => void; signal: AbortSignal }[] = []

/** Waits for one of the MAX_AT_ONCE places; the answer gives it back. */
function place(signal: AbortSignal): Promise<() => void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError())
    const take = () => {
      stats.making++
      stats.most = Math.max(stats.most, stats.making)
      let given = false
      resolve(() => {
        if (given) return
        given = true
        stats.making--
        next()
      })
    }
    if (stats.making < MAX_AT_ONCE) return take()
    const entry = { go: take, signal }
    waiting.push(entry)
    signal.addEventListener(
      'abort',
      () => {
        const i = waiting.indexOf(entry)
        if (i >= 0) waiting.splice(i, 1)
        reject(abortError())
      },
      { once: true },
    )
  })
}

function next() {
  while (stats.making < MAX_AT_ONCE && waiting.length) {
    const w = waiting.shift()!
    if (!w.signal.aborted) w.go()
  }
}

// --- making one ---------------------------------------------------------------------------------

/** Waits for a media event, failing on an error, a timeout or `signal`. */
function once(v: HTMLVideoElement, event: string, signal: AbortSignal, ms = STEP_TIMEOUT): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (e?: unknown) => {
      clearTimeout(timer)
      v.removeEventListener(event, ok)
      v.removeEventListener('error', bad)
      signal.removeEventListener('abort', stop)
      if (e) reject(e)
      else resolve()
    }
    const ok = () => done()
    const bad = () => done(new Error(v.error?.message || 'The browser cannot open this video'))
    const stop = () => done(abortError())
    const timer = setTimeout(() => done(new Error('The video took too long')), ms)
    v.addEventListener(event, ok)
    v.addEventListener('error', bad)
    signal.addEventListener('abort', stop)
  })
}

const toBlob = (canvas: HTMLCanvasElement, type: string, quality: number) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality))

/** A picture drawn small as WebP (JPEG where the browser cannot write WebP). */
async function encode(source: CanvasImageSource, width: number, height: number): Promise<Blob> {
  const scale = Math.min(1, MAX_PX / Math.max(width, height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  canvas.getContext('2d')!.drawImage(source, 0, 0, canvas.width, canvas.height)
  const webp = await toBlob(canvas, 'image/webp', 0.72)
  const blob = webp?.type === 'image/webp' ? webp : await toBlob(canvas, 'image/jpeg', 0.78)
  if (!blob) throw new Error('No picture came out')
  return blob
}

/** One frame of the video at `src`, and how long it is. Muted, never played. */
async function grab(src: string, signal: AbortSignal): Promise<{ blob: Blob; duration: number | null }> {
  const v = document.createElement('video')
  v.muted = true
  v.defaultMuted = true
  v.volume = 0
  v.playsInline = true
  v.preload = 'metadata'
  v.disableRemotePlayback = true
  try {
    const meta = once(v, 'loadedmetadata', signal)
    v.src = src
    await meta
    if (!v.videoWidth || !v.videoHeight) throw new Error('No picture in it')
    const duration = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : null
    const at = duration === null ? 1 : duration < 10 ? Math.min(1, duration / 2) : duration / 10
    const seeked = once(v, 'seeked', signal)
    v.currentTime = at
    await seeked
    if (v.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) await once(v, 'canplay', signal)
    return { blob: await encode(v, v.videoWidth, v.videoHeight), duration }
  } finally {
    // Stops any reading still going on.
    v.removeAttribute('src')
    v.load()
  }
}

/** Seafile's own thumbnail, drawn small; null when it makes none. */
async function seafileThumb(repo: string, p: string, signal: AbortSignal): Promise<Blob | null> {
  const res = await fetch(`/api/seafile/thumb?repo=${encodeURIComponent(repo)}&p=${encodeURIComponent(p)}&size=512`, { signal }).catch((e) => {
    if (signal.aborted) throw e
    return null
  })
  if (!res?.ok || !res.headers.get('content-type')?.startsWith('image/')) return null
  const bitmap = await createImageBitmap(await res.blob()).catch(() => null)
  if (!bitmap) return null
  try {
    return await encode(bitmap, bitmap.width, bitmap.height)
  } finally {
    bitmap.close()
  }
}

/** Whether Seafile makes video thumbnails: asked until it has made one, or turned down three. */
const seafileMakes = { made: 0, missed: 0 }
const askSeafile = () => seafileMakes.made > 0 || seafileMakes.missed < 3

/** Not made, and not to be tried again this visit (a reason the next attempt would not change). */
class Skip extends Error {}
/** Not made, but maybe later (a locked library). */
class NotNow extends Error {}
/** Not tried: it gave no frame lately (kept in IndexedDB). */
class GaveNone extends Error {}

type Want = { path: string; size: number | null; seafileFirst: boolean }

async function make(want: Want, signal: AbortSignal): Promise<{ blob: Blob; duration: number | null }> {
  const at = parseSf(want.path)
  if (at) {
    if (!getLibraries()) await loadLibraries()
    const encrypted = getLibrary(at.repo)?.encrypted ?? false
    if (encrypted && !((getUnlocks()[at.repo] ?? 0) > Date.now())) throw new NotNow('Locked')
    if (encrypted && (want.size === null || want.size > MAX_ENCRYPTED)) throw new Skip('Too big to read through an encrypted library')
    const free = await place(signal)
    try {
      if (!encrypted && want.seafileFirst && askSeafile()) {
        const blob = await seafileThumb(at.repo, at.p, signal)
        if (blob) {
          seafileMakes.made++
          return { blob, duration: null }
        }
        seafileMakes.missed++
      }
      return await grab(streamOf(want.path)!, signal)
    } finally {
      free()
    }
  }
  const node = lookup(want.path)
  if (node?.type !== 'file' || !node.browser) throw new Skip('Not a file with real bytes')
  const free = await place(signal)
  let url: string | null = null
  try {
    url = URL.createObjectURL(await readBrowserBlob(node.browser))
    return await grab(url, signal)
  } finally {
    if (url) URL.revokeObjectURL(url)
    free()
  }
}

// --- asking for one -----------------------------------------------------------------------------

type Job = { promise: Promise<VideoThumb | null>; ctrl: AbortController; askers: number }
const jobs = new Map<string, Job>()

/** The frame for `key`: from IndexedDB, else made. Shared by everyone asking; stopped when they all let go. */
function obtain(key: string, want: Want): { promise: Promise<VideoThumb | null>; release: () => void } {
  let job = jobs.get(key)
  if (!job) {
    const ctrl = new AbortController()
    const promise = (async () => {
      const row = await cacheGet(key)
      if (ctrl.signal.aborted) throw abortError()
      if (row?.blob) {
        stats.cached++
        return { blob: row.blob, duration: row.duration }
      }
      if (row) throw new GaveNone()
      const made = await make(want, ctrl.signal)
      stats.made++
      void cachePut(key, made.blob, made.duration)
      return made
    })().then(
      ({ blob, duration }) => {
        const thumb = { url: URL.createObjectURL(blob), duration }
        remember(key, thumb)
        return thumb
      },
      (e: unknown) => {
        if (!(e instanceof DOMException && e.name === 'AbortError') && !(e instanceof NotNow)) {
          failed.add(key)
          stats.failed++
          if (!(e instanceof GaveNone)) void cachePut(key, null, null)
        }
        return null
      },
    )
    job = { promise, ctrl, askers: 0 }
    jobs.set(key, job)
    void promise.finally(() => jobs.get(key) === job && jobs.delete(key))
  }
  const j = job
  j.askers++
  let released = false
  return {
    promise: j.promise,
    release() {
      if (released) return
      released = true
      if (--j.askers > 0) return
      j.ctrl.abort()
      if (jobs.get(key) === j) jobs.delete(key)
    },
  }
}

/**
 * A video's frame for a tile, once the element given to `ref` is on screen. `version` changes
 * when the file does (its mtime and size, or Seafile's file id); `size` is its bytes, when known.
 * `seafileFirst: false` skips asking Seafile (Photos has just asked it).
 */
export function useVideoThumb(path: string | null, version: string, opts: { size?: number | null; seafileFirst?: boolean } = {}): { ref: (el: Element | null) => void; thumb: VideoThumb | null } {
  const on = filesPrefs.use().videoThumbs
  const user = getAccount().user?.id
  const name = path?.split('/').pop() ?? ''
  const key = on && path && user !== undefined && videoThumbable(decodeURIComponent(name)) ? `${user}:${path}@${version}` : null
  const [el, setEl] = useState<Element | null>(null)
  const [visible, setVisible] = useState(false)
  const [got, setGot] = useState<{ key: string; thumb: VideoThumb | null } | null>(null)
  const known = key ? memory.get(key) : undefined

  useEffect(() => {
    if (!el || !key || known) return
    const io = new IntersectionObserver((entries) => setVisible(entries.some((e) => e.isIntersecting)), { rootMargin: '120px' })
    io.observe(el)
    return () => io.disconnect()
  }, [el, key, !!known])

  useEffect(() => {
    if (!key || known || !visible || failed.has(key) || !path) return
    let live = true
    const req = obtain(key, { path, size: opts.size ?? null, seafileFirst: opts.seafileFirst ?? true })
    void req.promise.then((thumb) => live && setGot({ key, thumb }))
    return () => {
      live = false
      req.release()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, visible, !!known])

  return { ref: setEl, thumb: key ? (known ?? (got?.key === key ? got.thumb : null)) : null }
}
