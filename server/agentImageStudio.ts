import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { User } from './auth.ts'
import { database } from './db.ts'
import { HttpError, json, readJson, SECURITY } from './http.ts'
import { checkRoom } from './quota.ts'
import { imageSettings, prepareImageGeneration, type ImageInput } from './agentImages.ts'
import { installedEmbeddings } from './agentModelIntel.ts'
import { sourceRaster } from './agentImageSources.ts'
import { applyPresetRules } from '../src/data/modelFamilies.ts'

// The Image Studio (src/apps/AgentsStudio.tsx): the owner drives a ComfyUI generation by hand, with
// no agent and no approval card, the way Generate another works in a thread. Everything goes
// through the same planner, graph builder, catalog checks, quota and one-job lock as generate_image
// (server/agentImages.ts); this file only adds the account's Studio thread, its history and uploads.
//
// The pictures are kept like any generated image: in agent_images, under a thread of the owner's.
// The Studio's thread is marked quick = 2, so no thread list, search or Spotlight answer shows it
// (those read quick = 0 and quick = 1). Deleting the account deletes it with everything else.

const STUDIO = 2
const UUID = /^[0-9a-f-]{36}$/
/** Uploaded sources: still PNGs (the Studio converts other pictures in the browser first). */
const UPLOAD_MAX = 12 * 1024 * 1024
/** One Generate press makes at most this many pictures, one after the other. */
export const STUDIO_BATCH_MAX = 8
/** The account's running Studio requests, so signing it out everywhere, a ban or deletion stops them. */
const runs = new Map<number, Set<AbortController>>()
/** Stops every Studio run an account has (server/agents.ts stopTurnsOf, from server/users.ts). */
export function stopStudioOf(userId: number) {
  for (const ctl of runs.get(userId) ?? []) ctl.abort()
}

/** The account's Studio thread, made on first use. */
export function studioThread(user: User): string {
  const db = database()
  const row = db.prepare('SELECT id FROM agent_threads WHERE user_id = ? AND quick = ? ORDER BY created_at LIMIT 1').get(user.id, STUDIO) as { id: string } | undefined
  if (row) return row.id
  const id = randomUUID(), now = Date.now()
  db.prepare("INSERT INTO agent_threads (id, user_id, title, mode, model, archived, created_at, updated_at, quick) VALUES (?, ?, 'Image Studio', 'quick', '', 0, ?, ?, ?)").run(id, user.id, now, now, STUDIO)
  return id
}

/** A stored PNG's size from its header, for uploads (which have no recorded settings). */
function pngSize(head: Uint8Array | null) {
  const b = head ? Buffer.from(head) : null
  return b && b.length >= 24 && b.toString('ascii', 12, 16) === 'IHDR' ? { width: b.readUInt32BE(16), height: b.readUInt32BE(20) } : { width: 0, height: 0 }
}

type ImageRow = { id: string; name: string; created_at: number; metadata: string | null; size: number; head: Uint8Array | null; studio: number }
/**
 * The Studio's pictures, newest first (`scope=all`: every generated picture of the account, for
 * picking an image-to-image source), with their recorded settings. Paged by `before` (an image id).
 */
export function studioImages(user: User, params: URLSearchParams) {
  const scope = params.get('scope') ?? 'studio'
  const limit = Number(params.get('limit') ?? 30)
  const before = params.get('before')
  if (!['studio', 'all'].includes(scope) || !Number.isInteger(limit) || limit < 1 || limit > 60 || (before !== null && !UUID.test(before))) throw new HttpError(400, 'Use scope studio or all, a limit from 1 to 60 and an optional before image id')
  const db = database(), thread = studioThread(user)
  const where = `t.user_id = ?${scope === 'studio' ? ' AND t.id = ?' : ''}`
  const args: (string | number)[] = scope === 'studio' ? [user.id, thread] : [user.id]
  const cursor = before ? db.prepare(`SELECT i.created_at, i.rowid AS position FROM agent_images i JOIN agent_threads t ON t.id = i.thread_id WHERE ${where} AND i.id = ?`).get(...args, before) as { created_at: number; position: number } | undefined : null
  if (before && !cursor) throw new HttpError(400, 'That page cursor is not one of these images')
  const rows = db.prepare(`SELECT i.id, i.name, i.created_at, i.metadata, length(i.body) AS size, substr(i.body, 1, 24) AS head, t.quick = ${STUDIO} AS studio
    FROM agent_images i JOIN agent_threads t ON t.id = i.thread_id WHERE ${where}${cursor ? ' AND (i.created_at < ? OR (i.created_at = ? AND i.rowid < ?))' : ''}
    ORDER BY i.created_at DESC, i.rowid DESC LIMIT ?`).all(...args, ...(cursor ? [cursor.created_at, cursor.created_at, cursor.position] : []), limit + 1) as ImageRow[]
  const images = rows.slice(0, limit).map((r) => {
    let settings: Record<string, unknown> | null = null
    try { settings = r.metadata ? JSON.parse(r.metadata) : null } catch { settings = null }
    const recorded = settings && typeof settings.width === 'number' && typeof settings.height === 'number' ? { width: settings.width, height: settings.height } : pngSize(r.head)
    return { id: r.id, name: r.name, url: `/api/agents/images/${r.id}`, size: r.size, ...recorded, created_at: r.created_at, studio: !!r.studio, settings }
  })
  return { thread, images, next_before: rows.length > limit ? images.at(-1)!.id : null }
}

/** A picture the owner brings in as an image-to-image source: kept in the Studio thread, no settings. */
export function studioUpload(user: User, body: unknown) {
  const input = body as { name?: unknown; data?: unknown } | null
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((k) => k !== 'name' && k !== 'data') || typeof input.name !== 'string' || typeof input.data !== 'string') throw new HttpError(400, 'Send { name, data } with the picture as base64 PNG')
  if (input.data.length > Math.ceil(UPLOAD_MAX * 4 / 3) + 4) throw new HttpError(413, 'Uploads must be at most 12 MiB')
  const bytes = Buffer.from(input.data, 'base64')
  const raster = sourceRaster(bytes, UPLOAD_MAX)
  if (raster.mime !== 'image/png') throw new HttpError(400, 'Upload a PNG')
  checkRoom(user, bytes.length)
  const id = randomUUID(), stem = input.name.replace(/\.[^.]*$/, '').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'picture'
  const name = `upload-${stem}.png`
  database().prepare('INSERT INTO agent_images (id, thread_id, name, body, created_at, metadata, backend_scope) VALUES (?, ?, ?, ?, ?, NULL, NULL)').run(id, studioThread(user), name, bytes, Date.now())
  return { id, name, url: `/api/agents/images/${id}`, size: bytes.length, width: raster.width, height: raster.height, created_at: Date.now(), studio: true, settings: null }
}

/** Deletes one of the Studio's own pictures (not a thread's). */
export function studioDelete(user: User, id: string) {
  const { changes } = database().prepare('DELETE FROM agent_images WHERE id = ? AND thread_id = ?').run(id, studioThread(user))
  if (!changes) throw new HttpError(404, 'No such Studio image')
}

const RUN_KEYS = new Set(['input', 'batch'])
/**
 * Generate (or refine, inpaint, remove, upscale) from the Studio, streamed as NDJSON: `start`,
 * `progress` (where ComfyUI is), `image` (the saved picture) per run, then `done`, or `error`. A
 * batch runs one picture after another, each seed one more than the last (or each random). The
 * first run is planned before anything is sent, so a bad request gets a plain HTTP error.
 * Closing the request cancels: the queued prompt is deleted and nothing more is saved.
 */
export async function studioRun(req: IncomingMessage, res: ServerResponse, user: User, body: unknown) {
  if (!imageSettings(user).url) throw new HttpError(409, 'Connect ComfyUI in Settings → Agents → Images first')
  const request = body as { input?: unknown; batch?: unknown } | null
  if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).some((k) => !RUN_KEYS.has(k))) throw new HttpError(400, 'Send { input, batch }')
  const batch = request.batch ?? 1
  if (typeof batch !== 'number' || !Number.isInteger(batch) || batch < 1 || batch > STUDIO_BATCH_MAX) throw new HttpError(400, `Batch must be 1 to ${STUDIO_BATCH_MAX}`)
  const raw = request.input
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, 'input must be an object of generation settings')
  const operation = (raw as ImageInput).operation ?? 'generate'
  if (batch > 1 && operation !== 'generate') throw new HttpError(400, 'Only a generation can run as a batch')
  // The same family rules the controls follow (src/data/modelFamilies.ts), applied once more here.
  const input = applyPresetRules(raw as ImageInput)
  const seed = input.seed
  const thread = studioThread(user)
  const ctl = new AbortController()
  res.on('close', () => { if (!res.writableEnded) ctl.abort() })
  const mine = runs.get(user.id) ?? new Set<AbortController>()
  runs.set(user.id, mine.add(ctl))
  const runInput = (i: number): ImageInput => (typeof seed === 'number' && i > 0 ? { ...input, seed: seed + i } : input)
  let plan: Awaited<ReturnType<typeof prepareImageGeneration>>
  try { plan = await prepareImageGeneration(user, thread, runInput(0), ctl.signal) } catch (e) { forget(user.id, ctl); throw e }
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', ...SECURITY })
  const send = (e: Record<string, unknown>) => { if (!res.writableEnded) res.write(`${JSON.stringify(e)}\n`) }
  try {
    for (let i = 0; i < batch; i++) {
      if (i > 0) plan = await prepareImageGeneration(user, thread, runInput(i), ctl.signal)
      send({ type: 'start', index: i, total: batch, width: plan.dimensions.width, height: plan.dimensions.height })
      const out = JSON.parse(await plan.run((progress) => send({ type: 'progress', index: i, progress })))
      send({ type: 'image', index: i, image: out.image })
    }
    send({ type: 'done' })
  } catch (e) {
    send(ctl.signal.aborted ? { type: 'done', cancelled: true } : { type: 'error', error: e instanceof Error ? e.message : 'Generation failed' })
  } finally {
    forget(user.id, ctl)
    res.end()
  }
}
function forget(userId: number, ctl: AbortController) {
  const mine = runs.get(userId)
  mine?.delete(ctl)
  if (mine && !mine.size) runs.delete(userId)
}

/** /api/agents/images/studio…: the signed-in owner's own Studio only. */
export async function handleStudioApi(req: IncomingMessage, res: ServerResponse, url: URL, method: string, user: User): Promise<boolean> {
  const path = url.pathname
  if (path === '/api/agents/images/studio' && method === 'GET') return json(res, 200, { thread: studioThread(user), configured: !!imageSettings(user).url, batchMax: STUDIO_BATCH_MAX }), true
  if (path === '/api/agents/images/studio/images' && method === 'GET') return json(res, 200, studioImages(user, url.searchParams)), true
  if (path === '/api/agents/images/studio/embeddings' && method === 'GET') {
    const s = imageSettings(user)
    return json(res, 200, { embeddings: s.url ? await installedEmbeddings(user, s, AbortSignal.timeout(10_000)) : [] }), true
  }
  if (path === '/api/agents/images/studio/upload' && method === 'POST') return json(res, 200, studioUpload(user, await readJson(req, Math.ceil(UPLOAD_MAX * 4 / 3) + 4096))), true
  if (path === '/api/agents/images/studio/run' && method === 'POST') return await studioRun(req, res, user, await readJson(req, 64 * 1024)), true
  const one = /^\/api\/agents\/images\/studio\/images\/([0-9a-f-]{36})$/.exec(path)
  if (one && method === 'DELETE') return studioDelete(user, one[1]), json(res, 200, { ok: true }), true
  return false
}
