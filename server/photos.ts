import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { crc32 } from 'node:zlib'
import { writeZip, type ZipInput } from '../src/data/zip.ts'
import type { User } from './auth.ts'
import { requireUser } from './auth.ts'
import { database, onUserGone } from './db.ts'
import { HEAD, photoKind, readMeta, readMore, type Meta } from './exif.ts'
import { HttpError, json, readJson, SECURITY, UNTRUSTED } from './http.ts'
import { immich, immichFile, immichInfo, linkImmich, unlinkImmich, type ImmichInfo } from './immich.ts'
import { fileLink, libraries, listDir, removeItems, repoId, restore as restoreTrash, seafileInfo, seafPath, streamFile, thumbnail, transfer, trash as listTrash, unlocked, type Library } from './seafile.ts'

// The Photos app: a timeline of the photos and videos in the user's Seafile folders, or their
// Immich library, or both (the app switches between them; they are not merged).
//
// Both sources answer the same questions, so the app does not care which one it shows: the
// months there are photos in (buckets, with a count each), a month's photos (newest first), a
// photo's thumbnail, its details, its original, the albums, and favourites.
//
// Seafile knows nothing about photos, so this keeps an index (SQLite, per user) of the folders
// the user chose: a walk lists them (a folder whose Seafile id did not change since the last
// full walk is skipped whole), and each new or changed file's first 128 KB is read with a byte
// range for its EXIF (server/exif.ts). The walk runs in the background, a few requests at a time,
// with caps on files and folders, and the app shows how far it got. Encrypted libraries are only
// walked while unlocked, and their photos only show then.
//
// Immich indexes everything itself: its API is asked directly (server/immich.ts).

const MAX_FILES = 100_000
const MAX_FOLDERS = 20_000
const MAX_SOURCES = 50
/** Requests to Seafile one walk makes at a time (listings, then byte ranges). */
const CONCURRENCY = 4
/** Walks running at once across all users; the rest wait their turn. */
const MAX_JOBS = 2
/** How old the index may get before opening the app walks again. */
const STALE = 15 * 60_000

/**
 * A photo on the timeline: its id, when (wall clock), VIDEO and FAVOURITE, width / height, a
 * video's seconds, its version (for the thumbnail's address), and for Seafile where it is (the
 * library's id followed by the path).
 */
export type Item = [id: string, wall: number, flags: number, ratio: number, duration: number | null, version: string, where?: string]
/** Item flags. */
const VIDEO = 1
const FAVOURITE = 2

type Opts = { album: string | null; favourites: boolean; tz: number }
type Bucket = { key: string; month: string; count: number }
type Album = { id: string; name: string; count: number; cover: string | null; detail: string | null }
type Size = 'small' | 'medium' | 'large'
/** `etag` is null where the browser must not keep or revalidate the bytes (Immich's, an encrypted library's). */
type Thumb = { status: 200 | 304; type: string; body: Buffer | null; etag: string | null }

/** What the info panel shows, whichever source the photo is in. */
export type Info = {
  id: string
  name: string
  kind: 'image' | 'video'
  size: number | null
  /** The wall-clock time it was taken (ms as if UTC), and where that came from */
  taken: number
  takenFrom: 'exif' | 'video' | 'file' | 'immich'
  offset: string | null
  /** As shown (turned by the orientation) */
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
  /** Seafile: where it is, for Files and the Player */
  repo?: string
  path?: string
  library?: string
  /** Immich: the photo on Immich's own site */
  web?: string
}

interface Source {
  buckets(user: User, opts: Opts): Promise<Bucket[]>
  bucket(user: User, key: string, opts: Opts): Promise<Item[]>
  thumb(user: User, id: string, size: Size, etag: string | null): Promise<Thumb>
  info(user: User, id: string): Promise<Info>
  albums(user: User): Promise<Album[]>
  favourite(user: User, ids: string[], on: boolean): Promise<void>
  /** Into the source's own trash: Seafile's library trash, Immich's trash. Never for good. */
  trash(user: User, ids: string[]): Promise<Trashed>
  /** Puts back what one trash call took. */
  restore(user: User, undo: Undo): Promise<{ restored: string[]; failed: string[] }>
  /** A file for a ZIP of the selection, opened when its turn comes. */
  file(user: User, id: string, signal: AbortSignal): ZipInput
}

/** What a trash call did: the ids it took, what to keep for undoing it, and what went wrong partway. */
type Trashed = { ids: string[]; undo: Undo; error: string | null }
/** What undoing a trash call needs: Seafile's index rows as they were (to put back, ids and favourites included), Immich's ids. */
type Undo = { rows?: (Row & { thumb: Uint8Array | null })[]; ids?: string[] }

const db = () => database()
const ratioOf = (w: number | null, h: number | null, orientation: number | null) => (w && h ? Math.round(((orientation ?? 1) >= 5 ? h / w : w / h) * 1000) / 1000 : 1)

// =================================================================================================
// Seafile: the index

type Row = {
  id: number
  repo: string
  path: string
  kind: 'image' | 'video'
  size: number
  mtime: number
  file_id: string
  taken_at: number
  taken_src: string
  taken_offset: string | null
  width: number | null
  height: number | null
  orientation: number | null
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
  favourite: number
}

/**
 * The index is of one Seafile account: when another one is linked (or none is), what was
 * indexed of the old one goes, chosen folders included. Answers whether Seafile is linked.
 */
function seafileReady(user: User): boolean {
  const info = seafileInfo(user)
  const account = info ? `${info.url}|${info.username}` : null
  const row = db().prepare('SELECT seafile FROM photo_accounts WHERE user_id = ?').get(user.id) as { seafile: string } | undefined
  if ((row?.seafile ?? null) !== account) {
    if (row) for (const t of ['photos', 'photo_dirs', 'photo_sources']) db().prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(user.id)
    if (account) db().prepare('INSERT INTO photo_accounts (user_id, seafile) VALUES (?, ?) ON CONFLICT (user_id) DO UPDATE SET seafile = excluded.seafile, scanned_at = NULL').run(user.id, account)
    else db().prepare('DELETE FROM photo_accounts WHERE user_id = ?').run(user.id)
  }
  return !!account
}

function requireSeafile(user: User) {
  if (!seafileReady(user)) throw new HttpError(409, 'Seafile is not linked')
}

// The libraries as Seafile lists them for this account: the only proof that the account may see a
// library at all. It is never kept: every request (or operation) asks again, so a library that is
// revoked, deleted or locked disappears from Photos at once, and when Seafile cannot answer nothing
// is shown (the index holds only descriptive data, never who may see it).
type Flight = { running?: Promise<Library[]>; next?: Promise<Library[]> }
const flights = new Map<number, Flight>()

/**
 * One listing per request, without ever answering from before the request came in: a request waits
 * for the listing under way to end and is served by the next one, which every request that arrived
 * meanwhile shares. So at most one listing runs and one waits, however many thumbnails are asked at once.
 */
function fetchLibs(user: User): Promise<Library[]> {
  let f = flights.get(user.id)
  if (!f) flights.set(user.id, (f = {}))
  const flight = f
  const begin = () => {
    const p = libraries(user)
    const done = () => {
      if (flight.running === p) flight.running = undefined
    }
    p.then(done, done)
    flight.running = p
    return p
  }
  if (!flight.running) return begin()
  flight.next ??= flight.running
    .then(() => undefined, () => undefined)
    .then(() => {
      flight.next = undefined
      return begin()
    })
  return flight.next
}

/** The libraries this account has right now. Any failure is a generic 502: nothing of what is indexed may be shown on a guess. */
async function libs(user: User): Promise<Library[]> {
  try {
    return await fetchLibs(user)
  } catch (e) {
    if (e instanceof HttpError && e.status === 409) throw e
    throw new HttpError(502, 'Seafile is not available, so no photos are shown')
  }
}

/** The library a photo is in, if this account has it right now and it is open: 404 when not listed, 423 when encrypted and locked. */
function openLib(user: User, list: Library[], repo: string): Library {
  const lib = list.find((l) => l.id === repo)
  if (!lib) throw new HttpError(404, 'No such photo')
  if (lib.encrypted && !unlocked(user)[repo]) throw new HttpError(423, 'Locked')
  return lib
}

/** The libraries whose photos may be shown now: listed for the account and either plain or unlocked. */
const openRepos = (user: User, list: Library[]) => {
  const open = unlocked(user)
  return list.filter((l) => !l.encrypted || open[l.id]).map((l) => l.id)
}

type SourceRow = { repo: string; path: string }
const sourcesOf = (user: User) => db().prepare('SELECT repo, path FROM photo_sources WHERE user_id = ? ORDER BY repo, path').all(user.id) as SourceRow[]
const under = (path: string, root: string) => root === '/' || path === root || path.startsWith(root + '/')

/** The chosen folders, with each one's library, lock and number of photos. */
async function sourcesInfo(user: User, list: Library[]) {
  const open = unlocked(user)
  const counts = db().prepare('SELECT repo, path FROM photos WHERE user_id = ?').all(user.id) as { repo: string; path: string }[]
  // A folder whose library the list does not name (gone, revoked, unknown) is not named either.
  return sourcesOf(user).flatMap((s) => {
    const lib = list.find((l) => l.id === s.repo)
    if (!lib) return []
    return [{
      repo: s.repo,
      path: s.path,
      library: lib?.name ?? null,
      name: s.path === '/' ? (lib?.name ?? 'Library') : s.path.split('/').pop()!,
      encrypted: !!lib?.encrypted,
      locked: !!lib?.encrypted && !open[s.repo],
      count: counts.filter((c) => c.repo === s.repo && under(c.path, s.path)).length,
    }]
  })
}

/** Sets the chosen folders (folders inside another chosen one are left out), and walks them. */
function setSources(user: User, body: { sources?: { repo?: string; path?: string }[] }) {
  requireSeafile(user)
  if (!Array.isArray(body.sources) || body.sources.length > MAX_SOURCES) throw new HttpError(400, `Up to ${MAX_SOURCES} folders`)
  const wanted = body.sources.map((s) => ({ repo: repoId(s.repo), path: seafPath(s.path).replace(/(.)\/+$/, '$1') }))
  const kept = wanted.filter((s, i) => !wanted.some((o, j) => o.repo === s.repo && (j < i ? under(s.path, o.path) : o.path !== s.path && under(s.path, o.path))))
  const d = db()
  d.exec('BEGIN')
  try {
    d.prepare('DELETE FROM photo_sources WHERE user_id = ?').run(user.id)
    const add = d.prepare('INSERT OR IGNORE INTO photo_sources (user_id, repo, path) VALUES (?, ?, ?)')
    for (const s of kept) add.run(user.id, s.repo, s.path)
    // What is no longer under any chosen folder goes from the index.
    for (const t of ['photos', 'photo_dirs']) {
      const rows = d.prepare(`SELECT rowid AS id, repo, path FROM ${t} WHERE user_id = ?`).all(user.id) as { id: number; repo: string; path: string }[]
      const drop = d.prepare(`DELETE FROM ${t} WHERE rowid = ?`)
      for (const r of rows) if (!kept.some((s) => s.repo === r.repo && under(r.path, s.path))) drop.run(r.id)
    }
    d.exec('COMMIT')
  } catch (e) {
    d.exec('ROLLBACK')
    throw e
  }
  startScan(user)
}

/** Folders worth suggesting: named like photo folders, at the top of each library (or the library itself). */
const PHOTO_NAMES = /^(photos?|pictures|camera uploads|camera|dcim|foto'?s|afbeeldingen|bilder|images)$/i

async function suggestions(user: User): Promise<{ repo: string; path: string; library: string; name: string }[]> {
  requireSeafile(user)
  const chosen = sourcesOf(user)
  const open = unlocked(user)
  const list = (await libs(user)).filter((l) => !l.encrypted || open[l.id]).slice(0, 40)
  const found: { repo: string; path: string; library: string; name: string }[] = []
  await pool(list, CONCURRENCY, async (lib) => {
    if (PHOTO_NAMES.test(lib.name)) return void found.push({ repo: lib.id, path: '/', library: lib.name, name: lib.name })
    const dir = await listDir(user, lib.id, '/').catch(() => null)
    for (const e of dir?.entries ?? []) if (e.dir && PHOTO_NAMES.test(e.name)) found.push({ repo: lib.id, path: `/${e.name}`, library: lib.name, name: e.name })
  })
  return found.filter((f) => !chosen.some((c) => c.repo === f.repo && under(f.path, c.path))).sort((a, b) => a.library.localeCompare(b.library) || a.path.localeCompare(b.path))
}

/** Runs `fn` over `items`, `n` at a time. */
async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>) {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await fn(items[next++])
  }))
}

// --- The walk -----------------------------------------------------------------------------------

export type Job = {
  state: 'waiting' | 'listing' | 'reading' | 'done' | 'failed'
  started: number
  finished: number | null
  folders: number
  files: number
  /** New or changed files whose first bytes are to be read, and how many were */
  toRead: number
  read: number
  added: number
  removed: number
  /** Libraries left out of this walk, and why */
  skipped: { repo: string; library: string; why: string }[]
  errors: string[]
  capped: boolean
}

const jobs = new Map<number, Job>()
const cancels = new Map<number, AbortController>()
const waiting: (() => void)[] = []
let running = 0

onUserGone((id) => {
  cancels.get(id)?.abort()
  jobs.delete(id)
  flights.delete(id)
})

/** Starts a walk of the user's chosen folders, unless one is running already. */
export function startScan(user: User): Job {
  const current = jobs.get(user.id)
  if (current && (current.state === 'waiting' || current.state === 'listing' || current.state === 'reading')) return current
  const job: Job = { state: 'waiting', started: Date.now(), finished: null, folders: 0, files: 0, toRead: 0, read: 0, added: 0, removed: 0, skipped: [], errors: [], capped: false }
  jobs.set(user.id, job)
  const stop = new AbortController()
  cancels.set(user.id, stop)
  void (async () => {
    if (running >= MAX_JOBS) await new Promise<void>((r) => waiting.push(r))
    running++
    try {
      await scan(user, job, stop.signal)
      job.state = 'done'
      db().prepare('UPDATE photo_accounts SET scanned_at = ? WHERE user_id = ?').run(Date.now(), user.id)
    } catch (e) {
      job.state = 'failed'
      job.errors.push((e as Error).message)
    } finally {
      job.finished = Date.now()
      running--
      waiting.shift()?.()
      if (cancels.get(user.id) === stop) cancels.delete(user.id)
    }
  })()
  return job
}

/** Walks again when the last walk is older than STALE (opening the app asks for this). */
function freshen(user: User) {
  const row = db().prepare('SELECT scanned_at FROM photo_accounts WHERE user_id = ?').get(user.id) as { scanned_at: number | null } | undefined
  const job = jobs.get(user.id)
  if (job && !job.finished) return
  if (sourcesOf(user).length && (!row?.scanned_at || Date.now() - row.scanned_at > STALE) && (!job || Date.now() - (job.finished ?? 0) > STALE)) startScan(user)
}

async function scan(user: User, job: Job, signal: AbortSignal) {
  if (!seafileReady(user)) throw new Error('Seafile is not linked')
  const list = await libs(user)
  const open = unlocked(user)
  const d = db()
  const existing = new Map<string, { id: number; file_id: string; mtime: number }>()
  for (const r of d.prepare('SELECT id, repo, path, file_id, mtime FROM photos WHERE user_id = ?').all(user.id) as { id: number; repo: string; path: string; file_id: string; mtime: number }[]) existing.set(`${r.repo}${r.path}`, r)
  let total = existing.size

  for (const source of sourcesOf(user)) {
    if (signal.aborted) return
    const lib = list.find((l) => l.id === source.repo)
    if (!lib) {
      // The library is gone (deleted, or no longer shared): so are its photos.
      job.skipped.push({ repo: source.repo, library: source.repo, why: 'The library is gone' })
      job.removed += Number(d.prepare('DELETE FROM photos WHERE user_id = ? AND repo = ?').run(user.id, source.repo).changes)
      continue
    }
    if (lib.encrypted && !open[lib.id]) {
      job.skipped.push({ repo: lib.id, library: lib.name, why: 'Encrypted and locked: unlock it in Files to index it' })
      continue
    }

    // List the folders, a few at a time. A folder whose Seafile id is the one stored after the
    // last full walk has not changed, nor has anything in it: its photos stay as they are.
    job.state = 'listing'
    const known = new Map<string, string>()
    for (const r of d.prepare('SELECT path, dir_id FROM photo_dirs WHERE user_id = ? AND repo = ?').all(user.id, lib.id) as { path: string; dir_id: string }[]) known.set(r.path, r.dir_id)
    const dirs = new Map<string, string>() // path → id, as found now
    const unchanged: string[] = []
    const failed: string[] = []
    const seen = new Set<string>()
    const toRead: { path: string; size: number; mtime: number; fileId: string; kind: 'image' | 'video'; row: number | null }[] = []
    const queue = [source.path]
    let busy = 0
    const walkers = Array.from({ length: CONCURRENCY }, async () => {
      for (;;) {
        const folder = queue.shift()
        if (folder === undefined) {
          // Another walker may still add folders: wait for it.
          if (busy === 0 || signal.aborted) return
          await new Promise((r) => setTimeout(r, 20))
          continue
        }
        if (job.folders >= MAX_FOLDERS) {
          job.capped = true
          failed.push(folder)
          continue
        }
        busy++
        try {
          const listing = await listDir(user, lib.id, folder)
          job.folders++
          for (const e of listing.entries) {
            const path = `${folder === '/' ? '' : folder}/${e.name}`
            if (e.name.startsWith('.') || e.name === '@eaDir' || e.name === '#recycle') continue
            if (e.dir) {
              dirs.set(path, e.id)
              if (e.id && known.get(path) === e.id) unchanged.push(path)
              else queue.push(path)
              continue
            }
            const kind = photoKind(e.name)
            if (!kind) continue
            job.files++
            seen.add(path)
            const old = existing.get(`${lib.id}${path}`)
            if (old && old.file_id === e.id && old.mtime === e.mtime) continue
            if (!old && total >= MAX_FILES) {
              job.capped = true
              continue
            }
            if (!old) total++
            toRead.push({ path, size: e.size, mtime: e.mtime, fileId: e.id, kind, row: old?.id ?? null })
            job.toRead++
          }
        } catch (e) {
          failed.push(folder)
          if (job.errors.length < 20) job.errors.push(`${lib.name}${folder}: ${(e as Error).message}`)
        } finally {
          busy--
        }
      }
    })
    await Promise.all(walkers)
    if (signal.aborted) return

    // Read the new and changed files' first bytes, a few at a time; the timeline fills as they come in.
    job.state = 'reading'
    const insert = d.prepare(`INSERT INTO photos (user_id, repo, path, kind, size, mtime, file_id, taken_at, taken_src, taken_offset, width, height, orientation, make, model, lens, exposure, fnumber, iso, focal, focal35, lat, lon, alt, thumb)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (user_id, repo, path) DO UPDATE SET kind = excluded.kind, size = excluded.size, mtime = excluded.mtime, file_id = excluded.file_id, taken_at = excluded.taken_at,
        taken_src = excluded.taken_src, taken_offset = excluded.taken_offset, width = excluded.width, height = excluded.height, orientation = excluded.orientation, make = excluded.make,
        model = excluded.model, lens = excluded.lens, exposure = excluded.exposure, fnumber = excluded.fnumber, iso = excluded.iso, focal = excluded.focal, focal35 = excluded.focal35,
        lat = excluded.lat, lon = excluded.lon, alt = excluded.alt, thumb = excluded.thumb`)
    await pool(toRead, CONCURRENCY, async (f) => {
      if (signal.aborted) return
      const meta = await metaOf(user, lib.id, f.path, f.kind, f.size, signal).catch(() => null)
      const m = meta ?? emptyMeta
      const taken = m.taken ?? f.mtime
      insert.run(
        user.id, lib.id, f.path, f.kind, f.size, f.mtime, f.fileId, taken, m.taken === null ? 'mtime' : (m.takenSrc ?? 'exif'), m.offset,
        m.width, m.height, m.orientation, m.make, m.model, m.lens, m.exposure, m.fnumber, m.iso, m.focal, m.focal35, m.lat, m.lon, m.alt,
        // Seafile makes no thumbnails in encrypted libraries: the camera's own small preview stands in.
        lib.encrypted && m.thumb ? m.thumb : null,
      )
      job.read++
      if (f.row === null) job.added++
    })
    if (signal.aborted) return

    // What was not seen in the folders listed is gone; folders that failed or were skipped keep theirs.
    const kept = (path: string) => seen.has(path) || unchanged.some((u) => under(path, u)) || failed.some((u) => under(path, u))
    const drop = d.prepare('DELETE FROM photos WHERE id = ?')
    for (const [key, r] of existing) {
      if (!key.startsWith(lib.id)) continue
      const path = key.slice(lib.id.length)
      if (under(path, source.path) && !kept(path)) {
        drop.run(r.id)
        job.removed++
      }
    }

    // The folder ids, for the next walk to skip what did not change: only after a full walk.
    d.exec('BEGIN')
    try {
      const rows = d.prepare('SELECT rowid AS id, path FROM photo_dirs WHERE user_id = ? AND repo = ?').all(user.id, lib.id) as { id: number; path: string }[]
      const del = d.prepare('DELETE FROM photo_dirs WHERE rowid = ?')
      const complete = !failed.length && !job.capped
      for (const r of rows) if (under(r.path, source.path) && !(complete && unchanged.some((u) => r.path !== u && under(r.path, u)))) del.run(r.id)
      if (complete) {
        const add = d.prepare('INSERT OR REPLACE INTO photo_dirs (user_id, repo, path, dir_id) VALUES (?, ?, ?, ?)')
        for (const [path, id] of dirs) if (id) add.run(user.id, lib.id, path, id)
      }
      d.exec('COMMIT')
    } catch (e) {
      d.exec('ROLLBACK')
      throw e
    }
  }
}

const emptyMeta: Meta = readMeta(Buffer.alloc(0), 0).meta

/** A file's metadata, from its first bytes (and a second read when the walk asks for one). */
async function metaOf(user: User, repo: string, path: string, kind: 'image' | 'video', size: number, signal: AbortSignal): Promise<Meta | null> {
  const ext = path.toLowerCase().split('.').pop()
  // Nothing in WebM and Matroska is read; their date is the file's.
  if (ext === 'webm' || ext === 'mkv') return null
  const head = await readRange(user, repo, path, 0, Math.min(HEAD, size || HEAD), signal)
  let { meta, more } = readMeta(head, size)
  for (let i = 0; more && i < 2; i++) {
    // Encrypted libraries are read from the start up to the range (server/seafile.ts): not far.
    if (more.length > 1024 * 1024 || (kind === 'image' && more.start > 64 * 1024 * 1024)) break
    const buf = await readRange(user, repo, path, more.start, more.length, signal)
    more = readMore(buf, more, meta, size)
  }
  return meta
}

/** `length` bytes of a file from `start`, through the same route the players use (ranges work in encrypted libraries too). */
async function readRange(user: User, repo: string, path: string, start: number, length: number, signal: AbortSignal): Promise<Buffer> {
  const stop = AbortSignal.any([signal, AbortSignal.timeout(60_000)])
  const r = await streamFile(user, repo, path, `bytes=${start}-${start + length - 1}`, stop)
  if (!r.body) return Buffer.alloc(0)
  const reader = r.body.getReader()
  const chunks: Uint8Array[] = []
  let got = 0
  try {
    while (got < length) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      got += value.length
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return Buffer.concat(chunks).subarray(0, length)
}

// --- Seafile as a source -----------------------------------------------------------------------------

/** The filter for a timeline, an album or the favourites, leaving out locked libraries. */
function seafileWhere(user: User, opts: Opts, list: Library[]): { sql: string; params: (string | number)[] } {
  const parts = ['user_id = ?']
  const params: (string | number)[] = [user.id]
  const open = openRepos(user, list)
  if (open.length) {
    parts.push(`repo IN (${open.map(() => '?').join(', ')})`)
    params.push(...open)
  } else parts.push('0')
  if (opts.favourites) parts.push('favourite = 1')
  if (opts.album) {
    const repo = repoId(opts.album.slice(0, 36))
    const path = seafPath(opts.album.slice(36) || '/')
    parts.push('repo = ?')
    params.push(repo)
    if (path !== '/') {
      parts.push('(path = ? OR substr(path, 1, ?) = ?)')
      params.push(path, path.length + 1, `${path}/`)
    }
  }
  return { sql: parts.join(' AND '), params }
}

/** The time it was taken on the photographer's clock: EXIF already is; file and video times are turned into the viewer's. */
const WALL = "(CASE WHEN taken_src = 'exif' THEN taken_at ELSE taken_at - ? END)"

const rowOf = (user: User, id: string) => {
  requireSeafile(user)
  const row = /^\d{1,15}$/.test(id) ? (db().prepare('SELECT * FROM photos WHERE user_id = ? AND id = ?').get(user.id, Number(id)) as (Row & { thumb: Uint8Array | null }) | undefined) : undefined
  if (!row) throw new HttpError(404, 'No such photo')
  return row
}

/**
 * A photo's row, once its library is open to this account right now (asked of Seafile for this
 * request): a library the account no longer has is 404, an encrypted one that is locked 423,
 * and Seafile not answering 502, all before any stored preview, ETag, detail or file link leaves.
 */
async function openRow(user: User, id: string) {
  const row = rowOf(user, id)
  const lib = openLib(user, await libs(user), row.repo)
  return { row, lib, encrypted: lib.encrypted }
}

const SIZES: Record<Size, number> = { small: 256, medium: 512, large: 1024 }

const seafileSource: Source = {
  async buckets(user, opts) {
    requireSeafile(user)
    freshen(user)
    const w = seafileWhere(user, opts, await libs(user))
    const rows = db()
      .prepare(`SELECT strftime('%Y-%m', ${WALL} / 1000, 'unixepoch') AS month, COUNT(*) AS count FROM photos WHERE ${w.sql} GROUP BY month ORDER BY month DESC`)
      .all(opts.tz * 60_000, ...w.params) as { month: string; count: number }[]
    return rows.map((r) => ({ key: r.month, month: r.month, count: r.count }))
  },
  async bucket(user, key, opts) {
    requireSeafile(user)
    const m = /^(\d{4})-(\d{2})$/.exec(key)
    if (!m) throw new HttpError(400, 'Bad month')
    const from = Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)
    const to = Date.UTC(Number(m[1]), Number(m[2]), 1)
    const w = seafileWhere(user, opts, await libs(user))
    const rows = db()
      .prepare(`SELECT id, repo, path, kind, width, height, orientation, favourite, file_id, ${WALL} AS wall FROM photos WHERE ${w.sql} AND ${WALL} >= ? AND ${WALL} < ? ORDER BY wall DESC, path DESC`)
      .all(opts.tz * 60_000, ...w.params, opts.tz * 60_000, from, opts.tz * 60_000, to) as { id: number; repo: string; path: string; kind: string; width: number | null; height: number | null; orientation: number | null; favourite: number; file_id: string; wall: number }[]
    // Where each one is goes along: dragging a selection to Files needs its paths there and then.
    return rows.map((r) => [String(r.id), r.wall, (r.kind === 'video' ? VIDEO : 0) | (r.favourite ? FAVOURITE : 0), ratioOf(r.width, r.height, r.orientation), null, r.file_id.slice(0, 10), `${r.repo}${r.path}`])
  },
  async thumb(user, id, size, etag) {
    // The lock is checked first: no stored bytes and no 304 for a library that is locked now.
    const { row, encrypted } = await openRow(user, id)
    // An encrypted library's thumbnails are never kept by the browser, so locking takes effect at once.
    const tag = encrypted ? null : `"sf-${row.file_id}-${size}"`
    if (tag && etag === tag) return { status: 304, type: '', body: null, etag: tag }
    if (row.thumb) return { status: 200, type: 'image/jpeg', body: Buffer.from(row.thumb), etag: tag }
    const t = await thumbnail(user, row.repo, row.path, SIZES[size])
    return { status: 200, type: t.type, body: t.body, etag: tag }
  },
  async info(user, id) {
    const { row, lib } = await openRow(user, id)
    const turned = (row.orientation ?? 1) >= 5
    return {
      id: String(row.id),
      name: row.path.split('/').pop()!,
      kind: row.kind,
      size: row.size,
      taken: row.taken_at,
      takenFrom: row.taken_src === 'exif' ? 'exif' : row.taken_src === 'video' ? 'video' : 'file',
      offset: row.taken_offset,
      width: turned ? row.height : row.width,
      height: turned ? row.width : row.height,
      make: row.make,
      model: row.model,
      lens: row.lens,
      exposure: row.exposure,
      fnumber: row.fnumber,
      iso: row.iso,
      focal: row.focal,
      focal35: row.focal35,
      lat: row.lat,
      lon: row.lon,
      alt: row.alt,
      place: null,
      favourite: !!row.favourite,
      duration: null,
      repo: row.repo,
      path: row.path,
      library: lib.name,
    }
  },
  async albums(user) {
    requireSeafile(user)
    const out: Album[] = []
    const list = await libs(user)
    for (const s of await sourcesInfo(user, list)) {
      if (s.locked || !s.library) continue
      const id = `${s.repo}${s.path === '/' ? '' : s.path}`
      const w = seafileWhere(user, { album: id, favourites: false, tz: 0 }, list)
      const cover = db().prepare(`SELECT id FROM photos WHERE ${w.sql} AND kind = 'image' ORDER BY taken_at DESC LIMIT 1`).get(...w.params) as { id: number } | undefined
      out.push({ id, name: s.name, count: s.count, cover: cover ? String(cover.id) : null, detail: s.path === '/' ? s.library : `${s.library ?? ''}${s.path}` })
    }
    return out
  },
  async favourite(user, ids, on) {
    // Every id is checked first: one that is not this account's refuses the lot.
    const rows = ids.map((id) => rowOf(user, id))
    const list = await libs(user)
    for (const repo of new Set(rows.map((r) => r.repo))) openLib(user, list, repo)
    const set = db().prepare('UPDATE photos SET favourite = ? WHERE id = ? AND user_id = ?')
    for (const r of rows) set.run(on ? 1 : 0, r.id, user.id)
  },
  async trash(user, ids) {
    const rows = ids.map((id) => rowOf(user, id))
    await changeable(user, rows.map((r) => r.repo))
    // Seafile deletes per folder; each folder's photos leave the index as soon as Seafile has them.
    const done: typeof rows = []
    let error: string | null = null
    const drop = db().prepare('DELETE FROM photos WHERE id = ? AND user_id = ?')
    for (const g of byFolder(rows)) {
      try {
        await removeItems(user, { repo: g.repo, parent: g.parent, names: g.rows.map((r) => nameOf(r.path)) })
      } catch (e) {
        error = (e as Error).message
        break
      }
      for (const r of g.rows) drop.run(r.id, user.id)
      done.push(...g.rows)
    }
    if (!done.length) throw new HttpError(502, error ?? 'Seafile did not delete them')
    return { ids: done.map((r) => String(r.id)), undo: { rows: done }, error }
  },
  async restore(user, undo) {
    requireSeafile(user)
    const rows = undo.rows ?? []
    await changeable(user, rows.map((r) => r.repo))
    const restored: string[] = []
    const failed: string[] = []
    for (const g of byFolder(rows)) {
      // The library's trash, newest first, has each one with the commit that deleted it: the
      // newest deletion of that name in that folder is the one this put there.
      const found = new Map<string, { commit: string; deleted: number }>()
      let scan: string | null = null
      for (let page = 0; page < 5; page++) {
        const list = await listTrash(user, g.repo, g.parent, scan)
        for (const t of list.items) {
          if (t.dir || (t.parent.replace(/(.)\/+$/, '$1') || '/') !== g.parent) continue
          const was = found.get(t.name)
          if (!was || t.deleted > was.deleted) found.set(t.name, { commit: t.commit, deleted: t.deleted })
        }
        if (!list.more || g.rows.every((r) => found.has(nameOf(r.path)))) break
        scan = list.scan
      }
      const byCommit = new Map<string, Row[]>()
      for (const r of g.rows) {
        const f = found.get(nameOf(r.path))
        if (!f) failed.push(nameOf(r.path))
        else byCommit.set(f.commit, [...(byCommit.get(f.commit) ?? []), r])
      }
      for (const [commit, list] of byCommit) {
        const res = await restoreTrash(user, { repo: g.repo, commit, paths: list.map((r) => r.path) }).catch((e: Error) => ({ restored: [] as string[], failed: list.map((r) => ({ path: r.path, error: e.message })) }))
        const back = new Set(res.restored.map((p) => p.replace(/(.)\/+$/, '$1')))
        for (const r of list) {
          if (back.has(r.path)) {
            putBack(user, r as Row & { thumb: Uint8Array | null })
            restored.push(String(r.id))
          } else failed.push(nameOf(r.path))
        }
      }
    }
    return { restored, failed }
  },
  file(user, id, signal) {
    const row = rowOf(user, id)
    return {
      name: nameOf(row.path),
      mtime: row.mtime,
      open: async () => {
        const r = await streamFile(user, row.repo, row.path, undefined, signal)
        return r.body ? { body: r.body as unknown as AsyncIterable<Uint8Array>, size: Number(r.length) || row.size || null } : null
      },
    }
  },
}

const nameOf = (path: string) => path.split('/').pop()!

/** Index rows grouped by the folder they are in, as Seafile's batch calls want them. */
function byFolder<R extends { repo: string; path: string }>(rows: R[]): { repo: string; parent: string; rows: R[] }[] {
  const groups = new Map<string, { repo: string; parent: string; rows: R[] }>()
  for (const r of rows) {
    const parent = r.path.split('/').slice(0, -1).join('/') || '/'
    const key = `${r.repo}${parent}`
    if (!groups.has(key)) groups.set(key, { repo: r.repo, parent, rows: [] })
    groups.get(key)!.rows.push(r)
  }
  return [...groups.values()]
}

/**
 * Refuses changes in libraries that cannot take them: encrypted ones that are locked (their photos
 * do not even show then), and read-only ones (shared with the account for viewing only).
 */
async function changeable(user: User, repos: string[]) {
  const list = await libs(user)
  const open = unlocked(user)
  for (const repo of new Set(repos)) {
    const lib = list.find((l) => l.id === repo)
    if (!lib) throw new HttpError(404, 'No such photo')
    if (lib.encrypted && !open[repo]) throw new HttpError(423, `${lib.name} is encrypted and locked: unlock it in Files first`)
    if (lib.permission !== 'rw') throw new HttpError(403, `${lib.name} is read-only for you, so nothing in it can be changed or deleted`)
  }
}

const COLUMNS = ['id', 'user_id', 'repo', 'path', 'kind', 'size', 'mtime', 'file_id', 'taken_at', 'taken_src', 'taken_offset', 'width', 'height', 'orientation', 'make', 'model', 'lens', 'exposure', 'fnumber', 'iso', 'focal', 'focal35', 'lat', 'lon', 'alt', 'thumb', 'favourite'] as const

/** An index row back as it was (its id too, unless a new photo took it), unless a walk found the file again first. */
function putBack(user: User, row: Row & { thumb: Uint8Array | null }) {
  const values = COLUMNS.map((c) => (c === 'user_id' ? user.id : ((row as unknown as Record<string, unknown>)[c] ?? null))) as (string | number | Uint8Array | null)[]
  const d = db()
  const withId = d.prepare(`INSERT OR IGNORE INTO photos (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`).run(...values)
  if (Number(withId.changes)) return
  d.prepare(`INSERT OR IGNORE INTO photos (${COLUMNS.slice(1).join(', ')}) VALUES (${COLUMNS.slice(1).map(() => '?').join(', ')})`).run(...values.slice(1))
}

// =================================================================================================
// Immich as a source

type ImmichBucket = { timeBucket: string; count: number }
type ImmichAssets = { id: string[]; fileCreatedAt: string[]; localOffsetHours: number[]; isImage: boolean[]; isFavorite: boolean[]; ratio?: (number | null)[]; duration?: (string | number | null)[] }
type ImmichAsset = {
  id: string
  type: string
  originalFileName: string
  originalMimeType?: string
  fileCreatedAt: string
  localDateTime: string
  isFavorite: boolean
  duration?: string | number | null
  width?: number | null
  height?: number | null
  exifInfo?: {
    make?: string | null
    model?: string | null
    lensModel?: string | null
    exposureTime?: string | null
    fNumber?: number | null
    iso?: number | null
    focalLength?: number | null
    exifImageWidth?: number | null
    exifImageHeight?: number | null
    orientation?: string | null
    latitude?: number | null
    longitude?: number | null
    city?: string | null
    state?: string | null
    country?: string | null
    fileSizeInByte?: number | null
    dateTimeOriginal?: string | null
    timeZone?: string | null
  } | null
}

const uuid = (v: string) => {
  if (!/^[0-9a-f-]{36}$/i.test(v)) throw new HttpError(400, 'Bad id')
  return v
}

/** The timeline's filters, as Immich's query. */
function immichQuery(opts: Opts, extra: Record<string, string> = {}) {
  const q = new URLSearchParams(extra)
  if (opts.album) q.set('albumId', uuid(opts.album))
  else q.set('visibility', 'timeline')
  if (opts.favourites) q.set('isFavorite', 'true')
  return q
}

/** Immich 2 sends a video's length as "HH:MM:SS.mmm", Immich 3 as milliseconds. In seconds. */
function seconds(d: string | number | null | undefined): number | null {
  if (typeof d === 'number') return d > 0 ? Math.round(d / 1000) : null
  const m = d ? /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(d) : null
  const s = m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0
  return s > 0 ? Math.round(s) : null
}

/** "1/250" (or "0.004") in seconds. */
function exposureOf(v: string | null | undefined): number | null {
  if (!v) return null
  const [a, b] = v.split('/').map(Number)
  const s = b ? a / b : a
  return Number.isFinite(s) && s > 0 ? s : null
}

const immichSource: Source = {
  async buckets(user, opts) {
    const rows = await immich<ImmichBucket[]>(user, `/timeline/buckets?${immichQuery(opts)}`)
    return rows.map((b) => ({ key: b.timeBucket, month: b.timeBucket.slice(0, 7), count: b.count })).sort((a, b) => b.month.localeCompare(a.month))
  },
  async bucket(user, key, opts) {
    if (!/^\d{4}-\d{2}-\d{2}[\dT:.Z+-]*$/.test(key)) throw new HttpError(400, 'Bad month')
    const a = await immich<ImmichAssets>(user, `/timeline/bucket?${immichQuery(opts, { timeBucket: key })}`)
    const items: Item[] = a.id.map((id, i) => {
      const utc = Date.parse(a.fileCreatedAt[i].endsWith('Z') || /[+-]\d\d:?\d\d$/.test(a.fileCreatedAt[i]) ? a.fileCreatedAt[i] : `${a.fileCreatedAt[i]}Z`)
      const wall = utc + (a.localOffsetHours[i] ?? 0) * 3600_000
      return [id, wall, (a.isImage[i] ? 0 : VIDEO) | (a.isFavorite[i] ? FAVOURITE : 0), Math.round((a.ratio?.[i] ?? 1) * 1000) / 1000 || 1, a.isImage[i] ? null : seconds(a.duration?.[i]), '']
    })
    return items.sort((x, y) => y[1] - x[1])
  },
  async thumb(user, id, size, etag) {
    // No ETag and no 304: the answer depends on whose Immich key is asked, so every request goes upstream.
    const res = await immichFile(user, `/assets/${id}/thumbnail?size=${size === 'small' ? 'thumbnail' : 'preview'}`)
    const type = res.headers.get('content-type') ?? ''
    const body = Buffer.from(await res.arrayBuffer())
    if (!body.length) throw new HttpError(404, 'No thumbnail')
    return { status: 200, type, body, etag: null }
  },
  async info(user, id) {
    const a = await immich<ImmichAsset>(user, `/assets/${uuid(id)}`)
    const x = a.exifInfo ?? {}
    const turned = ['5', '6', '7', '8', '90', '-90', '270'].includes(String(x.orientation ?? ''))
    const w = x.exifImageWidth ?? a.width ?? null
    const h = x.exifImageHeight ?? a.height ?? null
    const link = immichInfo(user)
    return {
      id: a.id,
      name: a.originalFileName,
      kind: a.type === 'VIDEO' ? 'video' : 'image',
      size: x.fileSizeInByte ?? null,
      // localDateTime is the photographer's clock, written as if UTC: what the timeline shows too.
      taken: Date.parse(a.localDateTime) || Date.parse(a.fileCreatedAt) || 0,
      takenFrom: 'immich',
      offset: x.timeZone ?? null,
      width: turned ? h : w,
      height: turned ? w : h,
      make: x.make ?? null,
      model: x.model ?? null,
      lens: x.lensModel ?? null,
      exposure: exposureOf(x.exposureTime),
      fnumber: x.fNumber ?? null,
      iso: x.iso ?? null,
      focal: x.focalLength ?? null,
      focal35: null,
      lat: x.latitude ?? null,
      lon: x.longitude ?? null,
      alt: null,
      place: [x.city, x.state, x.country].filter(Boolean).join(', ') || null,
      favourite: a.isFavorite,
      duration: a.type === 'VIDEO' ? seconds(a.duration) : null,
      web: link ? `${link.url}/photos/${a.id}` : undefined,
    }
  },
  async albums(user) {
    const rows = await immich<{ id: string; albumName: string; assetCount: number; albumThumbnailAssetId: string | null; shared?: boolean }[]>(user, '/albums')
    return rows.map((a) => ({ id: a.id, name: a.albumName, count: a.assetCount, cover: a.albumThumbnailAssetId, detail: a.shared ? 'Shared' : null }))
  },
  async favourite(user, ids, on) {
    ids.forEach(uuid)
    if (ids.length === 1) await immich(user, `/assets/${ids[0]}`, { method: 'PUT', headers: JSON_TYPE, body: JSON.stringify({ isFavorite: on }) })
    else await immich(user, '/assets', { method: 'PUT', headers: JSON_TYPE, body: JSON.stringify({ ids, isFavorite: on }) })
  },
  async trash(user, ids) {
    ids.forEach(uuid)
    // Only the account's own: a partner's photos and those of shared albums are someone else's to delete.
    const me = await immichMe(user)
    const others: string[] = []
    await pool(ids, 6, async (id) => {
      const a = await immich<{ ownerId?: string }>(user, `/assets/${id}`)
      if (a.ownerId !== me) others.push(id)
    })
    if (others.length) throw new HttpError(403, `${others.length === ids.length ? (ids.length === 1 ? 'That one belongs' : 'They belong') : `${others.length} of them belong`} to someone else in Immich (shared with you): only its owner can delete it`)
    // force: false is Immich's trash; true would delete for good, which this never asks for.
    await immich(user, '/assets', { method: 'DELETE', headers: JSON_TYPE, body: JSON.stringify({ ids, force: false }) })
    return { ids, undo: { ids }, error: null }
  },
  async restore(user, undo) {
    const ids = (undo.ids ?? []).map(uuid)
    await immich<{ count: number }>(user, '/trash/restore/assets', { method: 'POST', headers: JSON_TYPE, body: JSON.stringify({ ids }) })
    return { restored: ids, failed: [] }
  },
  file(user, id, signal) {
    uuid(id)
    return {
      name: `${id}.jpg`,
      mtime: Date.now(),
      open: async () => {
        const r = await immichFile(user, `/assets/${id}/original`, { signal })
        if (!r.ok || !r.body) return null
        const name = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(r.headers.get('content-disposition') ?? '')?.[1]
        const modified = Date.parse(r.headers.get('last-modified') ?? '')
        return { body: r.body as unknown as AsyncIterable<Uint8Array>, size: Number(r.headers.get('content-length')) || null, name: name ? safeDecode(name) : undefined, mtime: modified || undefined }
      },
    }
  },
}

const JSON_TYPE = { 'Content-Type': 'application/json' }
const safeDecode = (s: string) => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** The linked Immich account's own id, briefly kept (per link: linking another account asks again). */
const meCache = new Map<string, { id: string; at: number }>()
async function immichMe(user: User): Promise<string> {
  const link = immichInfo(user)
  const key = `${user.id}|${link?.url}|${link?.email}`
  const hit = meCache.get(key)
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.id
  const me = await immich<{ id: string }>(user, '/users/me')
  meCache.set(key, { id: me.id, at: Date.now() })
  return me.id
}

// =================================================================================================
// Changing things in bulk: the selection's trash (and undo), albums, moving, and a ZIP of it

/** The most ids one request may name; the app sends a big selection in batches of this. */
export const MAX_BATCH = 200
/** The most photos one ZIP may hold. */
const MAX_ZIP = 2000

/** The ids in a request body: strings, at least one, at most `cap`, each once. */
function idsOf(v: unknown, cap = MAX_BATCH): string[] {
  if (!Array.isArray(v) || !v.length) throw new HttpError(400, 'No photos named')
  if (v.length > cap) throw new HttpError(413, `At most ${cap} photos at a time`)
  return [...new Set(v.map((x) => String(x)))]
}

// What one trash call took, for its Undo, kept here (not in the browser, so an undo cannot name
// anything else) for half an hour: a token per call, only good for the account that made it.
const UNDO_MS = 30 * 60_000
const undos = new Map<string, { user: number; source: string; at: number; undo: Undo }>()
const tokens = () => randomBytes(18).toString('base64url')
function keepUndo(user: User, source: string, undo: Undo): string {
  for (const [k, u] of undos) if (Date.now() - u.at > UNDO_MS) undos.delete(k)
  const token = tokens()
  undos.set(token, { user: user.id, source, at: Date.now(), undo })
  return token
}

// A ZIP of the selection: asked for with the ids (a POST), then fetched by the browser's own
// download with a short-lived token, so the file streams to disk instead of into the page.
const zips = new Map<string, { user: number; source: string; ids: string[]; at: number }>()
const ZIP_MS = 10 * 60_000

onUserGone((id) => {
  for (const m of [undos, zips]) for (const [k, v] of m) if (v.user === id) m.delete(k)
  for (const k of meCache.keys()) if (k.startsWith(`${id}|`)) meCache.delete(k)
})

/** Seafile: moves photos to another folder, and the index with them (or out of it, when that folder is not one of the chosen). */
async function moveSeafile(user: User, body: { ids?: unknown; to?: { repo?: string; path?: string } }) {
  const rows = idsOf(body.ids).map((id) => rowOf(user, id))
  const to = { repo: repoId(body.to?.repo), path: seafPath(body.to?.path ?? '/').replace(/(.)\/+$/, '$1') }
  await changeable(user, [...rows.map((r) => r.repo), to.repo])
  // Seafile would rename a clash to "name (1)": it is refused instead, so the index stays right.
  const there = new Set((await listDir(user, to.repo, to.path)).entries.map((e) => e.name.toLowerCase()))
  const moving = rows.filter((r) => !(r.repo === to.repo && (r.path.split('/').slice(0, -1).join('/') || '/') === to.path))
  const clash = moving.filter((r) => there.has(nameOf(r.path).toLowerCase()))
  if (clash.length) throw new HttpError(409, `Already in that folder: ${clash.slice(0, 3).map((r) => nameOf(r.path)).join(', ')}${clash.length > 3 ? ` and ${clash.length - 3} more` : ''}`)
  const kept = sourcesOf(user).some((s) => s.repo === to.repo && under(to.path, s.path))
  let moved = 0
  for (const g of byFolder(moving)) {
    await transfer(user, { op: 'move', from: { repo: g.repo, parent: g.parent }, names: g.rows.map((r) => nameOf(r.path)), to: { repo: to.repo, parent: to.path } })
    const d = db()
    for (const r of g.rows) {
      if (kept) d.prepare('UPDATE OR REPLACE photos SET repo = ?, path = ? WHERE id = ? AND user_id = ?').run(to.repo, `${to.path === '/' ? '' : to.path}/${nameOf(r.path)}`, r.id, user.id)
      else d.prepare('DELETE FROM photos WHERE id = ? AND user_id = ?').run(r.id, user.id)
    }
    moved += g.rows.length
  }
  return { moved, kept }
}

/** Immich: adds photos to one of the account's albums. */
async function addToAlbum(user: User, body: { album?: unknown; ids?: unknown }) {
  const album = uuid(String(body.album ?? ''))
  const ids = idsOf(body.ids).map(uuid)
  const res = await immich<{ id: string; success: boolean; error?: string }[]>(user, `/albums/${album}/assets`, { method: 'PUT', headers: JSON_TYPE, body: JSON.stringify({ ids }) })
  return { added: res.filter((r) => r.success).length, already: res.filter((r) => r.error === 'duplicate').length, failed: res.filter((r) => !r.success && r.error !== 'duplicate').length }
}

/** Seafile photos' libraries must be open to this account right now (asked of Seafile: 404, 423 locked, or 502 when that cannot be told): before a ZIP is made or sent, so no file name goes into an answer. */
async function guardZip(user: User, source: string, ids: string[]) {
  if (source !== 'seafile') return
  const repos = new Set(ids.map((i) => rowOf(user, i).repo))
  const list = await libs(user)
  for (const repo of repos) openLib(user, list, repo)
}

/** Streams the ZIP a token names: each file is fetched when its turn comes and piped on. */
async function sendZip(req: IncomingMessage, res: ServerResponse, token: string) {
  const user = requireUser(req)
  const z = zips.get(token)
  if (!z || z.user !== user.id || Date.now() - z.at > ZIP_MS) throw new HttpError(404, 'That download has expired: ask for it again')
  await guardZip(user, z.source, z.ids)
  const source = SOURCES[z.source]
  const gone = new AbortController()
  res.on('close', () => gone.abort())
  const inputs = z.ids.map((id) => source.file(user, id, gone.signal))
  const stamp = new Date().toISOString().slice(0, 10)
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="Photos ${stamp} (${z.ids.length}).zip"`,
    'Cache-Control': 'no-store',
    ...SECURITY,
    ...UNTRUSTED,
  })
  const stream = Readable.from(writeZip(inputs, { crc: (data, c) => crc32(data, c) }))
  stream.on('error', () => res.destroy())
  res.on('close', () => stream.destroy())
  stream.pipe(res)
}

const SOURCES: Record<string, Source> = { seafile: seafileSource, immich: immichSource }

// =================================================================================================
// Routes, under /api/photos (and Immich's link, under /api/integrations/immich)

/** What the app shows first: which sources are set up, Seafile's folders and its walk. */
async function status(user: User) {
  const seafile = seafileReady(user)
  const immichLink: ImmichInfo | null = immichInfo(user)
  // When Seafile cannot say which libraries are locked, no folder is named either.
  const sources = seafile ? await libs(user).then((list) => sourcesInfo(user, list)).then((s) => ({ sources: s, unavailable: false }), (e) => (e instanceof HttpError && e.status === 502 ? { sources: [], unavailable: true } : Promise.reject(e))) : null
  return {
    seafile: seafile && sources ? { sources: sources.sources, unavailable: sources.unavailable, job: jobs.get(user.id) ?? null, scannedAt: (db().prepare('SELECT scanned_at FROM photo_accounts WHERE user_id = ?').get(user.id) as { scanned_at: number | null } | undefined)?.scanned_at ?? null } : null,
    immich: immichLink,
  }
}

/** Only pictures pass as what they are: anything else from a source could run as this site. */
const IMAGE_TYPES = /^image\/(jpeg|png|webp|gif|avif)$/i

/** Pipes a fetch Response's body to the browser, cancelling it when the browser goes. */
function pipe(res: ServerResponse, body: ReadableStream<Uint8Array> | null) {
  if (!body) return void res.end()
  const stream = Readable.fromWeb(body as import('node:stream/web').ReadableStream)
  res.on('close', () => stream.destroy())
  stream.on('error', () => res.destroy())
  stream.pipe(res)
}

/** Resolves true when it answered the request. */
export async function handlePhotosApi(req: IncomingMessage, res: ServerResponse, url: URL, method: string): Promise<boolean> {
  const path = url.pathname
  const read = method === 'GET' || method === 'HEAD'
  const q = (k: string) => url.searchParams.get(k)

  if (path === '/api/integrations/immich') {
    if (method === 'POST') return json(res, 200, await linkImmich(requireUser(req), await readJson(req, 8 * 1024))), true
    if (method === 'DELETE') return unlinkImmich(requireUser(req)), json(res, 200, { ok: true }), true
    if (read) return json(res, 200, immichInfo(requireUser(req))), true
    return false
  }
  if (path === '/api/photos/status' && read) return json(res, 200, await status(requireUser(req))), true
  if (path === '/api/photos/sources' && method === 'PUT') {
    const user = requireUser(req)
    setSources(user, await readJson(req, 64 * 1024))
    return json(res, 200, await status(user)), true
  }
  if (path === '/api/photos/suggest' && read) return json(res, 200, await suggestions(requireUser(req))), true
  if (path === '/api/photos/scan' && method === 'POST') {
    const user = requireUser(req)
    requireSeafile(user)
    return json(res, 200, startScan(user)), true
  }

  if (path === '/api/photos/zip' && read) return await sendZip(req, res, q('t') ?? ''), true

  const m = /^\/api\/photos\/(seafile|immich)\/(buckets|bucket|thumb|info|albums|favourite|original|video|trash|restore|zip|move|album|trashinfo)$/.exec(path)
  if (!m) return false
  const user = requireUser(req)
  const [, name, op] = m
  const source = SOURCES[name]
  const opts: Opts = { album: q('album') || null, favourites: q('fav') === '1', tz: Math.max(-900, Math.min(900, Math.round(Number(q('tz')) || 0))) }
  const id = q('id') ?? ''

  if (op === 'buckets' && read) return json(res, 200, await source.buckets(user, opts)), true
  if (op === 'bucket' && read) return json(res, 200, await source.bucket(user, q('key') ?? '', opts)), true
  if (op === 'albums' && read) return json(res, 200, await source.albums(user)), true
  if (op === 'info' && read) return json(res, 200, await source.info(user, id)), true
  if (op === 'favourite' && method === 'PUT') {
    // One ({ id }) or many ({ ids }).
    const body = await readJson<{ id?: string; ids?: unknown; on?: boolean }>(req, 64 * 1024)
    await source.favourite(user, body.ids !== undefined ? idsOf(body.ids) : [String(body.id ?? '')], !!body.on)
    return json(res, 200, { ok: true }), true
  }
  // The selection into the source's trash; the answer's token undoes it (POST restore).
  if (op === 'trash' && method === 'POST') {
    const body = await readJson<{ ids?: unknown }>(req, 64 * 1024)
    const done = await source.trash(user, idsOf(body.ids))
    return json(res, 200, { trashed: done.ids, undo: keepUndo(user, name, done.undo), error: done.error }), true
  }
  if (op === 'restore' && method === 'POST') {
    const body = await readJson<{ undo?: string }>(req, 1024)
    const kept = undos.get(String(body.undo ?? ''))
    if (!kept || kept.user !== user.id || kept.source !== name || Date.now() - kept.at > UNDO_MS) throw new HttpError(404, 'Too late to undo here: restore them from the trash instead')
    undos.delete(String(body.undo))
    return json(res, 200, await source.restore(user, kept.undo)), true
  }
  // How long the trash keeps things, for the question before trashing: Immich's setting (Seafile's is per library, asked by the app).
  if (op === 'trashinfo' && read && name === 'immich') {
    const config = await immich<{ trashDays?: number }>(user, '/server/config').catch(() => null)
    return json(res, 200, { days: typeof config?.trashDays === 'number' ? config.trashDays : null }), true
  }
  if (op === 'zip' && method === 'POST') {
    const body = await readJson<{ ids?: unknown }>(req, 256 * 1024)
    const ids = idsOf(body.ids, MAX_ZIP)
    // Checked now, so a download never starts for someone else's photos.
    if (name === 'seafile') await guardZip(user, name, ids)
    else ids.forEach(uuid)
    const token = tokens()
    for (const [k, z] of zips) if (Date.now() - z.at > ZIP_MS) zips.delete(k)
    zips.set(token, { user: user.id, source: name, ids, at: Date.now() })
    return json(res, 200, { url: `/api/photos/zip?t=${token}` }), true
  }
  if (op === 'move' && method === 'POST' && name === 'seafile') return json(res, 200, await moveSeafile(user, await readJson(req, 64 * 1024))), true
  if (op === 'album' && method === 'POST' && name === 'immich') return json(res, 200, await addToAlbum(user, await readJson(req, 64 * 1024))), true
  if (op === 'thumb' && read) {
    const size: Size = q('size') === 'large' ? 'large' : q('size') === 'medium' ? 'medium' : 'small'
    const t = await source.thumb(user, id, size, typeof req.headers['if-none-match'] === 'string' ? req.headers['if-none-match'] : null)
    // Revalidate ordinary Seafile thumbnails after the account and current library access checks.
    // Immich and encrypted-library thumbnails have no validator and are never stored.
    const cache: Record<string, string> = t.etag ? { 'Cache-Control': 'private, no-cache', ETag: t.etag } : { 'Cache-Control': 'private, no-store' }
    if (t.status === 304) return res.writeHead(304, { ...cache, ...SECURITY }).end(), true
    if (!IMAGE_TYPES.test(t.type)) throw new HttpError(404, 'No thumbnail')
    res.writeHead(200, { 'Content-Type': t.type, 'Content-Length': String(t.body!.length), ...cache, ...SECURITY, ...UNTRUSTED }).end(method === 'HEAD' ? undefined : t.body)
    return true
  }
  // The whole file. Seafile's goes straight from its file server (a short-lived link, as Files
  // does); Immich's comes through here, with the key.
  if (op === 'original' && read) {
    if (name === 'seafile') {
      const { row } = await openRow(user, id)
      const { url: link } = await fileLink(user, row.repo, row.path, 'download')
      return res.writeHead(302, { Location: link, 'Cache-Control': 'no-store', ...SECURITY }).end(), true
    }
    const gone = new AbortController()
    res.on('close', () => gone.abort())
    const range = typeof req.headers.range === 'string' ? req.headers.range : undefined
    const r = await immichFile(user, `/assets/${uuid(id)}/original`, { range, signal: gone.signal })
    const type = r.headers.get('content-type') ?? ''
    const headers: Record<string, string> = { 'Content-Type': IMAGE_TYPES.test(type) || /^video\//i.test(type) ? type : 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store', ...SECURITY, ...UNTRUSTED }
    for (const h of ['content-length', 'content-range']) if (r.headers.get(h)) headers[h] = r.headers.get(h)!
    if (q('download')) {
      const filename = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(r.headers.get('content-disposition') ?? '')?.[1]
      headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(decodeURIComponent(filename ?? `${id}`))}`
    }
    res.writeHead(r.status, headers)
    if (method === 'HEAD') return await r.body?.cancel().catch(() => {}), res.end(), true
    return pipe(res, r.body), true
  }
  // Immich's video, transcoded for the web (or the original when it plays as it is), with ranges for seeking.
  if (op === 'video' && read && name === 'immich') {
    const gone = new AbortController()
    res.on('close', () => gone.abort())
    const range = typeof req.headers.range === 'string' ? req.headers.range : undefined
    const r = await immichFile(user, `/assets/${uuid(id)}/video/playback`, { range, signal: gone.signal })
    const type = r.headers.get('content-type') ?? ''
    const headers: Record<string, string> = { 'Content-Type': /^video\//i.test(type) ? type : 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store', ...SECURITY, ...UNTRUSTED }
    for (const h of ['content-length', 'content-range']) if (r.headers.get(h)) headers[h] = r.headers.get(h)!
    res.writeHead(r.status, headers)
    if (method === 'HEAD') return await r.body?.cancel().catch(() => {}), res.end(), true
    return pipe(res, r.body), true
  }
  return false
}
