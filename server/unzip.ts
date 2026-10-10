import { createWriteStream, openAsBlob } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebStream } from 'node:stream/web'
import { createInflateRaw, crc32 } from 'node:zlib'
import { METHODS, readZip, type ZipEntry } from '../src/data/zip.ts'
import type { User } from './auth.ts'
import { HttpError } from './http.ts'
import { fileLink, guard, listDir, mkdir, repoId, seafPath } from './seafile.ts'

// Unpacking a ZIP that is in Seafile into a Seafile folder, here on the server: the archive's table
// of contents and then each chosen file's own bytes are read with ranges (never the whole
// archive), unpacked to a temporary file, checked against its CRC and size, and uploaded with
// Seafile's upload API, which also makes the folders. A job runs on its own; the page polls it
// for progress and can cancel it. Stored and deflated files unpack; other methods and
// password-protected entries are reported and left out.

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
const PARALLEL = 3
const KEEP_FINISHED = 30 * 60_000

/** An archive path as a safe relative path: no leading slash, no "..", forward slashes. */
function safeRel(path: string): string | null {
  const parts = path.replace(/\\/g, '/').split('/').filter((p) => p && p !== '.')
  if (parts.some((p) => p === '..' || p.includes('\0') || p.length > 255)) return null
  return parts.join('/') || null
}

/** One byte range of the archive. */
async function range(url: string, from: number, to: number, signal: AbortSignal): Promise<Response> {
  const res = await fetch(url, { headers: { Range: `bytes=${from}-${to}` }, signal })
  if (res.status !== 206) {
    await res.body?.cancel().catch(() => {})
    throw new Error(`Seafile's file server answered ${res.status} to a range`)
  }
  return res
}

/** Where a file's data starts: after its local header, whose name and extra lengths can differ. */
async function dataStart(url: string, e: ZipEntry, signal: AbortSignal): Promise<number> {
  const head = new Uint8Array(await (await range(url, e.offset, e.offset + 29, signal)).arrayBuffer())
  const v = new DataView(head.buffer)
  if (v.getUint32(0, true) !== 0x04034b50) throw new Error('its local header is damaged')
  return e.offset + 30 + v.getUint16(26, true) + v.getUint16(28, true)
}

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
  await guard(user, zip.repo)
  await guard(user, into.repo)
  if ([...jobs.values()].filter((j) => j.user === user.id && j.state === 'running').length >= 3) throw new HttpError(429, 'Three archives are unpacking already; wait for one to finish')

  // The table of contents, from the end of the archive.
  const parent = zip.path.split('/').slice(0, -1).join('/') || '/'
  const name = zip.path.split('/').pop()!
  const size = (await listDir(user, zip.repo, parent)).entries.find((e) => e.name === name && !e.dir)?.size
  if (size === undefined) throw new HttpError(404, 'No such archive')
  const { url } = await fileLink(user, zip.repo, zip.path, 'download')
  const index = await readZip(url, size).catch((e: Error) => {
    throw new HttpError(422, e.message)
  })

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
  void run(job, user, url, plan, clash, body.decisions ?? {}).finally(() => {
    job.current = null
    setTimeout(() => jobs.delete(job.id), KEEP_FINISHED)
  })
  return { id: job.id, total: job.total, totalBytes }
}

async function run(job: Job, user: User, url: string, plan: { e: ZipEntry; rel: string }[], clash: Clash, decisions: Record<string, Clash>) {
  const signal = job.abort.signal
  const known: Known = new Map()
  const root = job.into.path.replace(/\/$/, '')
  const tmp = await mkdtemp(join(tmpdir(), 'mvlos-unzip-'))
  let upload: string | null = null
  const uploadLink = async (fresh = false) => (upload && !fresh ? upload : (upload = (await fileLink(user, job.into.repo, job.into.path, 'upload')).url))

  /** One file: its bytes unpacked to disk, counted and checked, then uploaded into its folder. */
  const one = async (e: ZipEntry, rel: string) => {
    if (e.encrypted) throw new Error('it is password-protected, which is not supported here')
    if (e.method !== 0 && e.method !== 8) throw new Error(`${METHODS[e.method] ?? `method ${e.method}`} compression is not supported here`)
    if (e.size > MAX_FILE) throw new Error('it unpacks to more than 8 GB')
    const parts = rel.split('/')
    const name = parts.pop()!
    const dir = parts.join('/')
    const folder = `${root}${dir ? `/${dir}` : ''}` || '/'
    const choice = decisions[rel] ?? clash
    const names = await namesIn(user, job.into.repo, folder, known)
    const there = !!names?.has(name)
    if (there && choice === 'skip') {
      job.done.push({ path: rel, how: 'skipped' })
      return
    }
    job.current = rel
    const file = join(tmp, crypto.randomUUID())
    try {
      let size = 0
      let crc = 0
      const check = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          size += chunk.length
          job.bytes += chunk.length
          if (size > e.size) return cb(new Error('it unpacks to more than the archive says'))
          crc = crc32(chunk, crc)
          cb(null, chunk)
        },
      })
      if (e.compressed > 0) {
        const start = await dataStart(url, e, signal)
        const res = await range(url, start, start + e.compressed - 1, signal)
        const source = Readable.fromWeb(res.body as WebStream<Uint8Array>)
        if (e.method === 8) await pipeline(source, createInflateRaw(), check, createWriteStream(file), { signal })
        else await pipeline(source, check, createWriteStream(file), { signal })
      } else await pipeline(Readable.from([]), check, createWriteStream(file), { signal })
      if (size !== e.size) throw new Error(`it unpacked to ${size} bytes instead of ${e.size}`)
      if (crc >>> 0 !== e.crc >>> 0) throw new Error('its checksum does not match (the archive is damaged)')

      const send = async (link: string) => {
        const form = new FormData()
        form.append('file', await openAsBlob(file), name)
        form.append('parent_dir', job.into.path)
        if (dir) form.append('relative_path', dir)
        if (there && choice === 'replace') form.append('replace', '1')
        return fetch(`${link}?ret-json=1`, { method: 'POST', body: form, signal })
      }
      let res = await send(await uploadLink())
      if (res.status === 403 || res.status === 401) res = await send(await uploadLink(true))
      if (!res.ok) throw new Error((await res.text().catch(() => '')) || `Seafile answered ${res.status}`)
      known.delete(folder)
      job.done.push({ path: rel, how: e.method === 8 ? 'inflating' : 'extracting' })
    } finally {
      await rm(file, { force: true })
    }
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
    job.state = signal.aborted ? 'cancelled' : 'done'
  } catch (err) {
    job.state = signal.aborted ? 'cancelled' : 'failed'
    job.error = (err as Error).message
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

/** A job's progress; `since` leaves out the finished files the caller has seen already. */
export function extractStatus(user: User, id: unknown, since: unknown) {
  const job = jobs.get(String(id))
  if (!job || job.user !== user.id) throw new HttpError(404, 'No such job')
  const from = Math.max(0, Number(since) || 0)
  return { id: job.id, state: job.state, error: job.error, total: job.total, totalBytes: job.totalBytes, bytes: job.bytes, current: job.current, count: job.done.length, done: job.done.slice(from), errors: job.errors, into: job.into }
}

export function cancelExtract(user: User, id: unknown) {
  const job = jobs.get(String(id))
  if (!job || job.user !== user.id) throw new HttpError(404, 'No such job')
  job.abort.abort()
}
