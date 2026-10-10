import { createWriteStream, openAsBlob } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable, Transform, pipeline as streamPipeline } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebStream } from 'node:stream/web'
import { createGunzip, createInflateRaw, crc32 } from 'node:zlib'
import { archiveFormat, type ArchiveFormat } from '../src/data/archive.ts'
import { readTar, scanTar, TarError } from '../src/data/tar.ts'
import { METHODS, readZip, type ZipEntry, type ZipIndex } from '../src/data/zip.ts'
import type { User } from './auth.ts'
import { HttpError } from './http.ts'
import { fileLink, guard, listDir, mkdir, repoId, seafPath } from './seafile.ts'

// Unpacking an archive that is in Seafile into a Seafile folder, here on the server. Each chosen
// file is unpacked to a temporary file, checked against the size the archive gives (and a ZIP's
// CRC), and uploaded with Seafile's upload API, which also makes the folders. A job runs on its
// own; the page polls it for progress and can cancel it.
//
// - ZIP: the table of contents and then each chosen file's own bytes are read with ranges, never
//   the whole archive. Stored and deflated files unpack; other methods and password-protected
//   entries are reported and left out.
// - Tar: listed header to header with ranges (src/data/tar.ts), each file read with a range.
// - Gzipped tar: no way in but from the start, so it is read through once (streamed, never
//   stored), for the listing and again to unpack; up to MAX_TGZ.
// Links in tars are listed, not unpacked. Every format is read by our own code and Node's zlib.

export type Clash = 'replace' | 'keep' | 'skip'

type Done = { path: string; how: 'inflating' | 'extracting' | 'creating' | 'skipped' }
type Job = {
  id: string
  user: number
  /** The archive, and the folder it unpacks into */
  zip: { repo: string; path: string }
  into: { repo: string; path: string }
  total: number
  totalBytes: number
  done: Done[]
  bytes: number
  current: string | null
  errors: { path: string; error: string }[]
  state: 'running' | 'done' | 'failed' | 'cancelled'
  error: string | null
  abort: AbortController
}

const jobs = new Map<string, Job>()
/** What one file and one job may unpack to, against archives that lie about sizes. */
const MAX_FILE = 8 * 1024 ** 3
const MAX_TOTAL = 32 * 1024 ** 3
const MAX_ENTRIES = 20_000
/** A gzipped tar is read through whole, so only up to this size (packed)... */
const MAX_TGZ = 2 * 1024 ** 3
/** ...and only as long as it unpacks to no more than this. */
const MAX_TGZ_UNPACKED = 64 * 1024 ** 3
const PARALLEL = 3
const KEEP_FINISHED = 30 * 60_000

/** An archive path as a safe relative path: no leading slash, no "..", forward slashes. */
function safeRel(path: string): string | null {
  const parts = path.replace(/\\/g, '/').split('/').filter((p) => p && p !== '.')
  if (parts.some((p) => p === '..' || p.includes('\0') || p.length > 255)) return null
  return parts.join('/') || null
}

/** One byte range of the archive. */
async function range(url: string, from: number, to: number, signal?: AbortSignal): Promise<Response> {
  const res = await fetch(url, { headers: { Range: `bytes=${from}-${to}` }, signal })
  if (res.status !== 206) {
    await res.body?.cancel().catch(() => {})
    throw new Error(`Seafile's file server answered ${res.status} to a range`)
  }
  return res
}

/** The whole archive, as a stream (for gzipped tars). */
async function whole(url: string, signal?: AbortSignal): Promise<Readable> {
  const res = await fetch(url, { signal })
  if (!res.ok || !res.body) {
    await res.body?.cancel().catch(() => {})
    throw new Error(`Seafile's file server answered ${res.status}`)
  }
  return Readable.fromWeb(res.body as WebStream<Uint8Array>)
}

/** A gzipped tar's contents, unzipped as they come. A failed or stopped download ends the
 * unzipped stream with its error (pipe() alone would leave it unhandled, which ends the process). */
async function tgzStream(url: string, signal?: AbortSignal): Promise<Readable> {
  return streamPipeline(await whole(url, signal), createGunzip(), () => {})
}

/** Where a file's data starts: after its local header, whose name and extra lengths can differ. */
async function dataStart(url: string, e: ZipEntry, signal: AbortSignal): Promise<number> {
  const head = new Uint8Array(await (await range(url, e.offset, e.offset + 29, signal)).arrayBuffer())
  const v = new DataView(head.buffer)
  if (v.getUint32(0, true) !== 0x04034b50) throw new Error('its local header is damaged')
  return e.offset + 30 + v.getUint16(26, true) + v.getUint16(28, true)
}

// --- reading archives ----------------------------------------------------------------------------

type Opened = { repo: string; path: string; format: ArchiveFormat; url: string; size: number; id: string }

/** An archive in Seafile: its format (by name), size, content id and a download link. */
async function openArchive(user: User, repo: string, path: string): Promise<Opened> {
  await guard(user, repo)
  const name = path.split('/').pop()!
  const format = archiveFormat(name)
  if (!format) throw new HttpError(415, 'Only ZIP and tar archives (.tar, .tar.gz, .tgz) open here')
  const parent = path.split('/').slice(0, -1).join('/') || '/'
  const entry = (await listDir(user, repo, parent)).entries.find((e) => e.name === name && !e.dir)
  if (!entry) throw new HttpError(404, 'No such archive')
  if (format === 'tgz' && entry.size > MAX_TGZ) throw new HttpError(413, `A gzipped tar has to be read through whole, so only up to ${MAX_TGZ / 1024 ** 3} GB are opened here`)
  const { url } = await fileLink(user, repo, path, 'download')
  return { repo, path, format, url, size: entry.size, id: entry.id }
}

async function readIndex(a: Opened): Promise<ZipIndex> {
  try {
    if (a.format === 'zip') return await readZip(a.url, a.size)
    if (a.format === 'tar') return await readTar(async (from, to) => new Uint8Array(await (await range(a.url, from, to)).arrayBuffer()), a.size)
    const entries: ZipEntry[] = []
    await scanTar(await tgzStream(a.url), (e) => void entries.push(e), { maxBytes: MAX_TGZ_UNPACKED })
    return { entries, size: a.size, comment: '', zip64: false, format: 'tgz' }
  } catch (e) {
    // zlib says "incorrect header check" for a .tgz that is not gzipped.
    const message = (e as Error).message
    throw new HttpError(422, e instanceof TarError || a.format === 'zip' ? message : /header check|unexpected end/i.test(message) ? `This is not a gzipped tar (${message})` : message)
  }
}

// Listings are kept a while (by the file's content id), so opening one and then unpacking from it
// (or a terminal listing it twice) does not read a gzipped tar through each time.
const indexes = new Map<string, { at: number; index: Promise<ZipIndex> }>()
const INDEX_TTL = 10 * 60_000

async function indexOf(user: User, a: Opened): Promise<ZipIndex> {
  const key = `${user.id}:${a.repo}:${a.path}:${a.id}:${a.size}`
  const hit = indexes.get(key)
  if (hit && Date.now() - hit.at < INDEX_TTL) return hit.index
  const index = readIndex(a)
  index.catch(() => indexes.delete(key))
  indexes.set(key, { at: Date.now(), index })
  for (const [k, v] of indexes) if (indexes.size > 8 || Date.now() - v.at > INDEX_TTL) indexes.delete(k)
  return index
}

/** What an archive holds (for Archive and the terminal; ZIPs the page can also read itself). */
export async function listArchive(user: User, repo: unknown, path: unknown): Promise<ZipIndex> {
  const a = await openArchive(user, repoId(repo), seafPath(path))
  return indexOf(user, a)
}

/** One file from a tar, unpacked, to save on the computer (ZIPs: the page reads those itself). */
export async function archiveFile(user: User, repo: unknown, path: unknown, entry: unknown): Promise<{ name: string; size: number; body: Readable }> {
  const a = await openArchive(user, repoId(repo), seafPath(path))
  if (a.format === 'zip') throw new HttpError(400, 'ZIPs are read by the page')
  const want = String(entry ?? '')
  const e = (await indexOf(user, a)).entries.find((x) => x.path === want && !x.dir)
  if (!e) throw new HttpError(404, 'No such file in the archive')
  if (e.link !== undefined) throw new HttpError(422, `That is a link (to ${e.link}), not a file`)
  const name = want.split('/').pop()!
  if (a.format === 'tar') {
    if (!e.size) return { name, size: 0, body: Readable.from([]) }
    const res = await range(a.url, e.offset, e.offset + e.size - 1)
    return { name, size: e.size, body: Readable.fromWeb(res.body as WebStream<Uint8Array>) }
  }
  // Gzipped: read through up to the file, send it on, and stop there.
  const out = new PassThrough()
  const stop = new AbortController()
  const done = new Error('done')
  void (async () => {
    await scanTar(
      await tgzStream(a.url, stop.signal),
      async (x, data) => {
        if (x.path !== want || x.dir) return
        for await (const chunk of data) if (!out.write(chunk)) await new Promise((r) => out.once('drain', r))
        throw done
      },
      { maxBytes: MAX_TGZ_UNPACKED },
    )
  })()
    .then(
      () => out.destroy(new Error('The file was not found reading the archive through')),
      (err) => (err === done ? out.end() : out.destroy(err as Error)),
    )
    .finally(() => stop.abort())
  out.on('close', () => stop.abort())
  return { name, size: e.size, body: out }
}

// --- unpacking -----------------------------------------------------------------------------------

type Known = Map<string, Set<string> | null>

/** The names in a folder (folders with a slash), cached per job; null when it does not exist. */
async function namesIn(user: User, repo: string, path: string, known: Known): Promise<Set<string> | null> {
  if (known.has(path)) return known.get(path)!
  const names = await listDir(user, repo, path)
    .then((l) => new Set(l.entries.map((e) => (e.dir ? `${e.name}/` : e.name))))
    .catch(() => null)
  known.set(path, names)
  return names
}

/** Makes a folder and its parents in a library, as far as they are missing. */
async function mkdirs(user: User, repo: string, path: string, known: Known) {
  let at = ''
  for (const part of path.split('/').filter(Boolean)) {
    const parent = at || '/'
    at = `${at}/${part}`
    const names = await namesIn(user, repo, parent, known)
    if (names?.has(`${part}/`)) continue
    await mkdir(user, { repo, path: at })
    names?.add(`${part}/`)
    known.set(at, new Set())
  }
}

/**
 * Starts unpacking. `entries` are paths in the archive (a folder takes everything in it); none
 * means all. `base` is the archive folder they are taken from (stripped from their paths).
 * `decisions` overrides `clash` per file (the terminal's unzip asks file by file).
 */
export async function startExtract(
  user: User,
  body: { repo?: string; path?: string; into?: { repo?: string; path?: string }; entries?: string[]; base?: string; clash?: Clash; decisions?: Record<string, Clash> },
): Promise<{ id: string; total: number; totalBytes: number }> {
  const zip = { repo: repoId(body.repo), path: seafPath(body.path) }
  const into = { repo: repoId(body.into?.repo), path: seafPath(body.into?.path) }
  const clash: Clash = body.clash === 'replace' || body.clash === 'skip' ? body.clash : 'keep'
  await guard(user, into.repo)
  if ([...jobs.values()].filter((j) => j.user === user.id && j.state === 'running').length >= 3) throw new HttpError(429, 'Three archives are unpacking already; wait for one to finish')
  const archive = await openArchive(user, zip.repo, zip.path)
  const index = await indexOf(user, archive)

  // What to unpack, and where each one goes.
  const base = (body.base ?? '').replace(/^\/+|\/+$/g, '')
  const wanted = Array.isArray(body.entries) && body.entries.length ? body.entries.map((p) => String(p).replace(/^\/+|\/+$/g, '')) : null
  const plan = index.entries
    .filter((e) => !wanted || wanted.some((w) => e.path === w || e.path.startsWith(`${w}/`)))
    .map((e) => {
      const inBase = base ? (e.path.startsWith(`${base}/`) ? e.path.slice(base.length + 1) : null) : e.path
      return { e, rel: inBase === null ? null : safeRel(inBase) }
    })
    .filter((x): x is { e: ZipEntry; rel: string } => !!x.rel)
  if (!plan.length) throw new HttpError(400, 'Nothing to unpack')
  if (plan.length > MAX_ENTRIES) throw new HttpError(413, `That is more than ${MAX_ENTRIES} entries`)
  const files = plan.filter((x) => !x.e.dir)
  const totalBytes = files.reduce((a, x) => a + x.e.size, 0)
  if (totalBytes > MAX_TOTAL) throw new HttpError(413, 'That unpacks to more than 32 GB')

  const job: Job = { id: crypto.randomUUID(), user: user.id, zip, into, total: files.length, totalBytes, done: [], bytes: 0, current: null, errors: [], state: 'running', error: null, abort: new AbortController() }
  jobs.set(job.id, job)
  void run(job, user, archive, plan, clash, body.decisions ?? {}).finally(() => {
    job.current = null
    setTimeout(() => jobs.delete(job.id), KEEP_FINISHED)
  })
  return { id: job.id, total: job.total, totalBytes }
}

async function run(job: Job, user: User, archive: Opened, plan: { e: ZipEntry; rel: string }[], clash: Clash, decisions: Record<string, Clash>) {
  const signal = job.abort.signal
  const { url, format } = archive
  const known: Known = new Map()
  const root = job.into.path.replace(/\/$/, '')
  const tmp = await mkdtemp(join(tmpdir(), 'mvlos-unzip-'))
  let upload: string | null = null
  const uploadLink = async (fresh = false) => (upload && !fresh ? upload : (upload = (await fileLink(user, job.into.repo, job.into.path, 'upload')).url))
  const how = (e: ZipEntry): Done['how'] => (format === 'tgz' || e.method === 8 ? 'inflating' : 'extracting')

  /** Where a file goes, and whether it goes at all (null: skipped, as asked, for one already there). */
  const place = async (e: ZipEntry, rel: string) => {
    if (e.link !== undefined) throw new Error(`it is a link (to ${e.link}), which is not unpacked here`)
    if (e.encrypted) throw new Error('it is password-protected, which is not supported here')
    if (format === 'zip' && e.method !== 0 && e.method !== 8) throw new Error(`${METHODS[e.method] ?? `method ${e.method}`} compression is not supported here`)
    if (e.size > MAX_FILE) throw new Error('it unpacks to more than 8 GB')
    const parts = rel.split('/')
    const name = parts.pop()!
    const dir = parts.join('/')
    const folder = `${root}${dir ? `/${dir}` : ''}` || '/'
    const choice = decisions[rel] ?? clash
    const there = !!(await namesIn(user, job.into.repo, folder, known))?.has(name)
    if (there && choice === 'skip') {
      job.done.push({ path: rel, how: 'skipped' })
      return null
    }
    return { name, dir, folder, replace: there && choice === 'replace' }
  }

  /** Counts what passes, and stops a file that grows past the size the archive gives it. */
  const checker = (e: ZipEntry) => {
    const t = { size: 0, crc: 0, stream: null as unknown as Transform }
    t.stream = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        t.size += chunk.length
        job.bytes += chunk.length
        if (t.size > e.size) return cb(new Error('it unpacks to more than the archive says'))
        if (format === 'zip') t.crc = crc32(chunk, t.crc)
        cb(null, chunk)
      },
    })
    return t
  }
  const verify = (e: ZipEntry, t: { size: number; crc: number }) => {
    if (t.size !== e.size) throw new Error(`it unpacked to ${t.size} bytes instead of ${e.size}`)
    if (format === 'zip' && t.crc >>> 0 !== e.crc >>> 0) throw new Error('its checksum does not match (the archive is damaged)')
  }

  /** Uploads an unpacked file into its folder. */
  const send = async (file: string, rel: string, e: ZipEntry, at: { name: string; dir: string; folder: string; replace: boolean }) => {
    const post = async (link: string) => {
      const form = new FormData()
      form.append('file', await openAsBlob(file), at.name)
      form.append('parent_dir', job.into.path)
      if (at.dir) form.append('relative_path', at.dir)
      if (at.replace) form.append('replace', '1')
      return fetch(`${link}?ret-json=1`, { method: 'POST', body: form, signal })
    }
    let res = await post(await uploadLink())
    if (res.status === 403 || res.status === 401) res = await post(await uploadLink(true))
    if (!res.ok) throw new Error((await res.text().catch(() => '')) || `Seafile answered ${res.status}`)
    known.delete(at.folder)
    job.done.push({ path: rel, how: how(e) })
  }

  /** ZIP and tar: one file, read with ranges, unpacked to disk, checked, uploaded. */
  const one = async (e: ZipEntry, rel: string) => {
    const at = await place(e, rel)
    if (!at) return
    job.current = rel
    const file = join(tmp, crypto.randomUUID())
    try {
      const t = checker(e)
      if (format === 'tar' && e.size > 0) {
        const res = await range(url, e.offset, e.offset + e.size - 1, signal)
        await pipeline(Readable.fromWeb(res.body as WebStream<Uint8Array>), t.stream, createWriteStream(file), { signal })
      } else if (format === 'zip' && e.compressed > 0) {
        const start = await dataStart(url, e, signal)
        const res = await range(url, start, start + e.compressed - 1, signal)
        const source = Readable.fromWeb(res.body as WebStream<Uint8Array>)
        if (e.method === 8) await pipeline(source, createInflateRaw(), t.stream, createWriteStream(file), { signal })
        else await pipeline(source, t.stream, createWriteStream(file), { signal })
      } else await pipeline(Readable.from([]), t.stream, createWriteStream(file), { signal })
      verify(e, t)
      await send(file, rel, e, at)
    } finally {
      await rm(file, { force: true })
    }
  }

  /** A gzipped tar: read through once; each chosen file is written out as it passes and uploaded
   * while the reading goes on (a few at a time, so the temporary files stay few). */
  const stream = async (queue: { e: ZipEntry; rel: string }[]) => {
    const wanted = new Map(queue.map((x) => [x.e.path, x]))
    const uploads = new Set<Promise<void>>()
    const fail = (rel: string) => (err: Error) => {
      if (!signal.aborted) job.errors.push({ path: rel, error: err.message })
    }
    await scanTar(
      await tgzStream(url, signal),
      async (e, data) => {
        if (signal.aborted) throw new Error('cancelled')
        const item = wanted.get(e.path)
        if (!item) return
        wanted.delete(e.path)
        const at = await place(item.e, item.rel).catch((err: Error) => (fail(item.rel)(err), null))
        if (!at) return
        job.current = item.rel
        const file = join(tmp, crypto.randomUUID())
        try {
          const t = checker(item.e)
          await pipeline(Readable.from(data), t.stream, createWriteStream(file), { signal })
          verify(item.e, t)
        } catch (err) {
          await rm(file, { force: true })
          return fail(item.rel)(err as Error)
        }
        const task = send(file, item.rel, item.e, at)
          .catch(fail(item.rel))
          .finally(() => {
            uploads.delete(task)
            return rm(file, { force: true })
          })
        uploads.add(task)
        if (uploads.size >= PARALLEL) await Promise.race(uploads)
      },
      { maxBytes: MAX_TGZ_UNPACKED },
    ).finally(() => Promise.all(uploads))
    // Anything the listing had that reading it through again did not find (the file changed).
    for (const x of wanted.values()) fail(x.rel)(new Error('it was not found reading the archive through'))
  }

  try {
    await mkdirs(user, job.into.repo, job.into.path, known)
    // Folders listed on their own, made even when they stay empty.
    for (const { rel } of plan.filter((x) => x.e.dir)) {
      if (signal.aborted) break
      await mkdirs(user, job.into.repo, `${root}/${rel}`, known)
      job.done.push({ path: `${rel}/`, how: 'creating' })
    }
    const queue = plan.filter((x) => !x.e.dir)
    if (format === 'tgz') await stream(queue)
    else {
      let next = 0
      const worker = async () => {
        while (!signal.aborted) {
          const item = queue[next++]
          if (!item) return
          await one(item.e, item.rel).catch((err: Error) => {
            if (!signal.aborted) job.errors.push({ path: item.rel, error: err.message })
          })
        }
      }
      await Promise.all(Array.from({ length: PARALLEL }, worker))
    }
    job.state = signal.aborted ? 'cancelled' : 'done'
  } catch (err) {
    job.state = signal.aborted ? 'cancelled' : 'failed'
    job.error = (err as Error).message
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

/** A job's progress; `since` leaves out the finished files the caller has seen already. `count`
 * is that cursor (folders made count too); `files` is how many of the `total` files are through
 * (unpacked, skipped or failed), for a progress line. */
export function extractStatus(user: User, id: unknown, since: unknown) {
  const job = jobs.get(String(id))
  if (!job || job.user !== user.id) throw new HttpError(404, 'No such job')
  const from = Math.max(0, Number(since) || 0)
  return { id: job.id, state: job.state, error: job.error, total: job.total, totalBytes: job.totalBytes, bytes: job.bytes, current: job.current, count: job.done.length, files: job.done.filter((d) => d.how !== 'creating').length + job.errors.length, done: job.done.slice(from), errors: job.errors, into: job.into }
}

export function cancelExtract(user: User, id: unknown) {
  const job = jobs.get(String(id))
  if (!job || job.user !== user.id) throw new HttpError(404, 'No such job')
  job.abort.abort()
}
