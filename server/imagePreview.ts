import type { ServerResponse } from 'node:http'
import { Worker } from 'node:worker_threads'
import type { User } from './auth.ts'
import { HttpError, SECURITY, UNTRUSTED } from './http.ts'
import { privateAuthorityCheck, privateSignal, requirePrivateRequest } from './privateRequest.ts'
import type { PreviewJob, PreviewResult } from './imagePreviewWorker.ts'

// Small PNG previews of the account's own pictures (generated images and pictures kept with
// Agents messages), for thumbnails and inline display: a 1024² picture is about 2.7 MB as a PNG,
// and a Studio page of 60 thumbnails was 162 MB on the wire before this. The original stays
// exactly where it was, byte for byte, and is still what full views, downloads, edits and
// sources use. Previews are made on demand in one worker thread and kept only in memory, briefly,
// per account; nothing derived is written to disk and nothing is cached by the browser (the
// responses are `no-store` like the originals). Anything the worker can't shrink faithfully, or
// can't shrink right now (queue full, too slow, too big), gets the original instead: once, from
// the same request, so there is never a retry loop.

/** Longest side of a preview, in pixels: thumbnails ask for 384, inline pictures for 768. */
export const PREVIEW_SIZES: ReadonlySet<number> = new Set([384, 768])
/** Largest original sent to the worker (its stored bytes). */
const MAX_INPUT = 32 * 1024 * 1024
/** Largest original by its header; checked before inflating (an RGBA row buffer is ~4 B a pixel). */
const MAX_PIXELS = 4096 * 4096
/** Largest preview the worker may return. */
const MAX_OUTPUT = 2 * 1024 * 1024
/** Jobs waiting or running; more than this and the request gets the original at once. */
const MAX_JOBS = 12
/** From admission to an answer; a running job past it is stopped with its worker. */
const DEADLINE_MS = 15_000
/** All settled previews together, and how long one is kept after it is made. */
const CACHE_BYTES = 48 * 1024 * 1024
const CACHE_MS = 10 * 60_000
/** A worker with nothing to do for this long exits. */
const IDLE_MS = 30_000

/** One picture the account owns. `exists` is asked again before every cache hit and after decoding. */
export type PreviewSource = {
  /** Stable per picture and its stored size, e.g. `img:<uuid>:<bytes>` */
  key: string
  /** Stored size of the original, known without loading it. */
  bytes: number
  /** Whether it is a PNG that the worker may try (before loading the body). */
  png: boolean
  exists: () => boolean
  load: () => Buffer | null
  /** The original response, exactly as its own endpoint sends it. */
  original: () => { type: string; body: Buffer; headers?: Record<string, string> }
}

type Entry = { userId: number; png: Buffer; at: number }
const cache = new Map<string, Entry>()
let cached = 0
const drop = (key: string) => {
  const e = cache.get(key)
  if (e) { cached -= e.png.length; cache.delete(key) }
}
function remember(key: string, entry: Entry) {
  drop(key)
  cache.set(key, entry)
  cached += entry.png.length
  // Expired ones go, then the least recently used (Map order: a hit re-inserts its entry) until it fits.
  const now = Date.now()
  for (const [k, e] of cache) if (now - e.at >= CACHE_MS) drop(k)
  for (const [k] of cache) {
    if (cached <= CACHE_BYTES) break
    drop(k)
  }
}
setInterval(() => { const now = Date.now(); for (const [k, e] of cache) if (now - e.at >= CACHE_MS) drop(k) }, 60_000).unref()

type Job = { id: number; bytes: Buffer; size: number; resolve: (r: PreviewResult | null) => void; signal?: AbortSignal; timer: ReturnType<typeof setTimeout>; started: boolean; abort: () => void }
const queue: Job[] = []
let running: Job | null = null
let worker: Worker | null = null
let idle: ReturnType<typeof setTimeout> | null = null
let nextId = 1

function stopWorker() {
  if (idle) clearTimeout(idle)
  idle = null
  const w = worker
  worker = null
  void w?.terminate()
}

function finish(job: Job, result: PreviewResult | null) {
  clearTimeout(job.timer)
  job.signal?.removeEventListener('abort', job.abort)
  const at = queue.indexOf(job)
  if (at >= 0) queue.splice(at, 1)
  if (running === job) {
    running = null
    // A job that didn't answer (cancelled, too slow) is still busy in the worker: stop it.
    if (!result) stopWorker()
  }
  job.resolve(result)
  pump()
}

function pump() {
  if (running || !queue.length) {
    if (!running && !queue.length && worker && !idle) idle = setTimeout(stopWorker, IDLE_MS)
    return
  }
  if (idle) { clearTimeout(idle); idle = null }
  const job = queue[0]
  if (!worker) {
    let w: Worker
    try { w = new Worker(new URL('./imagePreviewWorker.ts', import.meta.url), { resourceLimits: { maxOldGenerationSizeMb: 64 } }) }
    catch { queue.shift(); job.resolve(null); clearTimeout(job.timer); job.signal?.removeEventListener('abort', job.abort); return pump() }
    w.on('message', (r: PreviewResult) => { if (worker === w && running?.id === r.id) finish(running, r) })
    w.on('error', () => { if (worker === w) { worker = null; if (running) finish(running, null) } })
    w.on('exit', () => { if (worker === w) { worker = null; if (running) finish(running, null) } })
    w.unref()
    worker = w
  }
  queue.shift()
  running = job
  job.started = true
  const bytes = job.bytes.buffer.slice(job.bytes.byteOffset, job.bytes.byteOffset + job.bytes.length) as ArrayBuffer
  job.bytes = Buffer.alloc(0)
  worker.postMessage({ id: job.id, bytes, size: job.size, maxPixels: MAX_PIXELS, maxOutput: MAX_OUTPUT } satisfies PreviewJob, [bytes])
}

/**
 * Null when it was cancelled, timed out or the worker failed. Each request gets its own job: a job
 * is never shared with another request (or account), so no pending result outlives or crosses the
 * authority that asked for it; only a settled, rechecked preview is cached.
 */
function shrink(bytes: Buffer, size: number, signal?: AbortSignal): Promise<PreviewResult | null> {
  return new Promise((resolve) => {
    const job: Job = { id: nextId++, bytes, size, resolve, signal, started: false, timer: setTimeout(() => finish(job, null), DEADLINE_MS), abort: () => finish(job, null) }
    if (signal?.aborted) { clearTimeout(job.timer); resolve(null); return }
    signal?.addEventListener('abort', job.abort, { once: true })
    queue.push(job)
    pump()
  })
}

/** Jobs waiting or running, and settled previews held (for checks). */
export const previewState = () => ({ jobs: queue.length + (running ? 1 : 0), cached: cache.size, cachedBytes: cached, worker: !!worker })
/** Forget every cached preview (checks, and an account's sign-out everywhere does not need it: hits recheck). */
export const clearPreviews = () => { for (const k of [...cache.keys()]) drop(k) }

function send(res: ServerResponse, head: boolean, type: string, body: Buffer | null, mark: string, extra: Record<string, string> = {}) {
  res.writeHead(200, { ...SECURITY, ...UNTRUSTED, ...extra, 'Content-Type': type, ...(body ? { 'Content-Length': String(body.length) } : {}), 'Cache-Control': 'private, no-store', 'X-Preview': mark }).end(head ? undefined : body ?? undefined)
}

/**
 * Answers a preview request for `source`, which the caller has found among the user's own
 * pictures. The session (the private request's authority, which the worker does not have) is
 * checked again before a cache hit, after the job and before anything is written.
 */
export async function servePreview(res: ServerResponse, user: User, head: boolean, source: PreviewSource, size: number): Promise<void> {
  if (!PREVIEW_SIZES.has(size)) throw new HttpError(404, 'No such preview size')
  requirePrivateRequest(user)
  const check = privateAuthorityCheck(), signal = privateSignal()
  const key = `${user.id}:${source.key}:${size}`
  const fallback = () => {
    check()
    if (!source.exists()) throw new HttpError(404, 'No such image')
    const o = source.original()
    send(res, head, o.type, o.body, 'original', o.headers)
  }
  const hit = cache.get(key)
  if (hit && (hit.userId !== user.id || Date.now() - hit.at >= CACHE_MS)) drop(key)
  else if (hit) {
    if (!source.exists()) { drop(key); throw new HttpError(404, 'No such image') }
    check()
    remember(key, { ...hit })
    return send(res, head, 'image/png', hit.png, String(size))
  }
  // A HEAD learns the type without anything being decoded.
  if (head) return source.png && source.bytes <= MAX_INPUT ? send(res, true, 'image/png', null, String(size)) : fallback()
  // Admitted before the body is loaded: not a PNG, too big, or no room in the queue.
  if (!source.png || source.bytes > MAX_INPUT || queue.length + (running ? 1 : 0) >= MAX_JOBS) return fallback()
  const bytes = source.load()
  if (!bytes) throw new HttpError(404, 'No such image')
  const result = await shrink(bytes, size, signal)
  signal?.throwIfAborted()
  check()
  if (!source.exists()) throw new HttpError(404, 'No such image')
  if (!result?.ok) return fallback()
  const png = Buffer.from(result.png)
  remember(key, { userId: user.id, png, at: Date.now() })
  send(res, false, 'image/png', png, String(size))
}
