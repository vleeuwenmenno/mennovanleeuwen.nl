import { randomInt, randomUUID } from 'node:crypto'
import { chmodSync, createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { accounts, type User } from './auth.ts'
import { cancelQueuedPrompt, claimComfyJob, imagesFirst, imageBackendScope, imageSettings, readJSON, releaseComfyJob, request, uploadSource } from './agentImages.ts'
import { imageSource, sourceRaster } from './agentImageSources.ts'
import { buildVideoGraph, fitVideoNodes, nodeChoices, videoGraphProblem, type VideoNodeSchema, type VideoRender } from './agentVideoGraphs.ts'
import { applyComfyMessage, openComfySocket, progressState, queuePosition } from './comfyProgress.ts'
import { database, dataDir, decrypt, encrypt, onUserGone } from './db.ts'
import { guardedFetch, readCapped } from './egress.ts'
import { HttpError, json, readJson, SECURITY, UNTRUSTED } from './http.ts'
import { withoutPrivateRequest } from './privateRequest.ts'
import { checkRoom, limitLabel, roomLeft } from './quota.ts'
import { pushToUser } from './webpush.ts'
import type { ImageProgress } from '../src/data/imageModels.ts'
import { effectiveSeconds, emptyVideoModels, FAMILY_LABEL, FAMILY_RULES, H3_NODES, H3_SAMPLING, JOB_ACTIVE, LTX_NODES, missingVideoModels, resolveVideoModels, VIDEO_FAMILIES, VIDEO_FPS, VIDEO_NODES, videoFrameCount, videoParameterProblem, type VideoCatalog, type VideoFamily, type VideoJobStatus, type VideoModelSettings } from '../src/data/videoModels.ts'
import { compileProject, defaultProject, lanesFromPlan, normalizeProject, validateVideoPromptPlan, type Keyframe, type VideoProject } from '../src/data/videoPlan.ts'

// The Video Studio's server (src/apps/video/): projects, keyframe pictures, render jobs and the
// videos they make, all the signed-in account's own and checked on every route.
//
// Renders run here, not in the browser: a job is a row (agent_video_jobs) that a worker in this
// process takes when the account's ComfyUI slot is free (one job at a time per account, shared
// with the Image Studio and generate_image: claimComfyJob in server/agentImages.ts). Closing the
// tab does not stop it. The prompt id is stored as soon as ComfyUI answers; a restart marks a job
// that was uploading, running or saving `interrupted` (ComfyUI may still finish it, but its output
// is not collected), and queued jobs simply run when the server is back. Cancel deletes only our
// own queued prompt, never /interrupt, so another client's GPU job is never stopped.
//
// The videos are files: DATA_DIR/videos/<user>/<id>.mp4 (directories 0700, files 0600), checked
// to be MP4 (an `ftyp` box) and at most OUTPUT_MAX, and counted against the account's storage
// (server/quota.ts sums agent_videos.bytes). They are served with byte ranges so the player can
// seek. Deleting the account removes the folder.

const MODELS = 'video-models'
/** At most this many renders waiting per account (the running one included). */
export const MAX_QUEUED = 4
const OUTPUT_MAX = 512 * 1024 * 1024
const SOURCE_MAX = 12 * 1024 * 1024
/** A render's deadline (VIDEO_DEADLINE_MIN, default 30 minutes). */
const deadlineMs = () => Math.max(1, Number(process.env.VIDEO_DEADLINE_MIN) || 30) * 60_000
const UUID = /^[0-9a-f-]{36}$/

// --- model settings ------------------------------------------------------------------------------

export function videoModelSettings(user: User): VideoModelSettings {
  const row = database().prepare('SELECT secret FROM integrations WHERE user_id = ? AND name = ?').get(user.id, MODELS) as { secret: string } | undefined
  const base = emptyVideoModels()
  if (!row) return base
  try {
    const saved = JSON.parse(decrypt(row.secret)) as Partial<VideoModelSettings>
    for (const f of VIDEO_FAMILIES) base[f] = { ...base[f], ...(saved[f] ?? {}) }
  } catch {
    /* sealed with another SESSION_SECRET: start over */
  }
  return base
}

export function saveVideoModelSettings(user: User, body: unknown): VideoModelSettings {
  const input = body as Record<string, Record<string, unknown>> | null
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((k) => !VIDEO_FAMILIES.includes(k as VideoFamily))) throw new HttpError(400, 'Send the model files per family: { minimax_h3: {…}, ltx25: {…} }')
  const s = videoModelSettings(user)
  for (const f of VIDEO_FAMILIES) {
    const patch = input[f]
    if (patch === undefined) continue
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new HttpError(400, `Invalid ${f} settings`)
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in s[f])) throw new HttpError(400, `Unknown setting ${k}`)
      if (typeof v !== 'string' || v.length > 2048 || /[\x00-\x1f]/.test(v)) throw new HttpError(400, `Invalid ${k}`)
      ;(s[f] as Record<string, string>)[k] = v
    }
  }
  database().prepare('INSERT INTO integrations (user_id, name, secret, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, name) DO UPDATE SET secret = excluded.secret').run(user.id, MODELS, encrypt(JSON.stringify(s)), Date.now())
  return s
}

// --- what ComfyUI has for video ------------------------------------------------------------------

const NODE_INFO_LIMIT = 1024 * 1024
const CATALOG_LIMIT = 6 * 1024 * 1024
/** A catalog per account and backend, for a minute: planning and the editor ask often. */
const catalogs = new Map<number, { scope: string; at: number; value: { catalog: VideoCatalog; schemas: Record<string, VideoNodeSchema> } }>()

export async function videoCatalog(user: User, signal: AbortSignal = AbortSignal.timeout(30_000), fresh = false) {
  const s = imageSettings(user)
  if (!s.url) throw new HttpError(409, 'Connect ComfyUI in Settings → Image & Video Studio first')
  const scope = imageBackendScope(user, s)
  const cached = catalogs.get(user.id)
  if (!fresh && cached && cached.scope === scope && Date.now() - cached.at < 60_000) return cached.value
  const schemas: Record<string, VideoNodeSchema> = {}
  let remaining = CATALOG_LIMIT
  for (const node of VIDEO_NODES) {
    const res = await request(user, s, `/object_info/${node}`, signal, undefined, true)
    if (res.status === 404) { await res.body?.cancel(); continue }
    const bytes = await readCapped(res, Math.min(NODE_INFO_LIMIT, remaining))
    remaining -= bytes.length
    let value: unknown
    try { value = JSON.parse(bytes.toString()) } catch { throw new HttpError(502, `ComfyUI returned invalid JSON for ${node}`) }
    const def = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>)[node] : undefined
    if (def && typeof def === 'object' && !Array.isArray(def)) schemas[node] = def as VideoNodeSchema
  }
  const missing = (nodes: readonly string[]) => nodes.filter((n) => !schemas[n] || schemas[n].api_node)
  const native = schemas.MiniMaxH3ImageToVideo
  const h3Missing = missing(H3_NODES)
  const ltxMissing = missing(LTX_NODES)
  const catalog: VideoCatalog = {
    families: {
      minimax_h3: h3Missing.length ? { ok: false, error: `ComfyUI is missing ${h3Missing.slice(0, 4).join(', ')}${h3Missing.length > 4 ? '…' : ''} for MiniMax H3.` } : native?.output?.[0] !== 'CONDITIONING' ? { ok: false, error: 'MiniMax H3 needs the native MiniMaxH3ImageToVideo node, not the API node.' } : { ok: true, error: '' },
      ltx25: ltxMissing.length ? { ok: false, error: `ComfyUI is missing ${ltxMissing.slice(0, 4).join(', ')}${ltxMissing.length > 4 ? '…' : ''} for LTX 2.5.` } : { ok: true, error: '' },
    },
    models: nodeChoices(schemas.UNETLoader, 'unet_name'),
    clips: nodeChoices(schemas.CLIPLoader, 'clip_name'),
    vaes: nodeChoices(schemas.VAELoader, 'vae_name'),
    loras: nodeChoices(schemas.LoraLoaderModelOnly, 'lora_name'),
    latentUpscalers: nodeChoices(schemas.LatentUpscaleModelLoader, 'model_name'),
    samplers: nodeChoices(schemas.KSamplerSelect, 'sampler_name'),
    schedulers: nodeChoices(schemas.BasicScheduler, 'scheduler'),
  }
  const value = { catalog, schemas }
  catalogs.set(user.id, { scope, at: Date.now(), value })
  return value
}

// --- keyframe pictures ----------------------------------------------------------------------------

type SourceRow = { id: string; name: string; mime: string; body: Uint8Array; width: number; height: number }
const sourceView = (r: Omit<SourceRow, 'body'>) => ({ id: r.id, name: r.name, width: r.width, height: r.height, url: `/api/video/sources/${r.id}` })

function insertSource(user: User, name: string, bytes: Buffer, origin: string | null = null) {
  const raster = sourceRaster(bytes, SOURCE_MAX)
  checkRoom(user, bytes.length)
  const id = randomUUID()
  const clean = name.replace(/[^\w. -]+/g, '-').slice(0, 120) || 'picture'
  database().prepare('INSERT INTO agent_video_sources (id, user_id, name, mime, body, width, height, created_at, origin_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, user.id, clean, raster.mime, bytes, raster.width, raster.height, Date.now(), origin)
  return sourceView({ id, name: clean, mime: raster.mime, width: raster.width, height: raster.height })
}

/** A keyframe the browser prepared (cropped to the clip's size): { name, data } with base64 PNG data. */
export function uploadVideoSource(user: User, body: unknown) {
  const input = body as { name?: unknown; data?: unknown } | null
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((k) => k !== 'name' && k !== 'data') || typeof input.name !== 'string' || typeof input.data !== 'string') throw new HttpError(400, 'Send { name, data } with the picture as base64 PNG')
  if (input.data.length > Math.ceil((SOURCE_MAX * 4) / 3) + 4) throw new HttpError(413, 'Keyframes must be at most 12 MiB')
  const bytes = Buffer.from(input.data, 'base64')
  if (sourceRaster(bytes, SOURCE_MAX).mime !== 'image/png') throw new HttpError(400, 'Upload the keyframe as a PNG')
  return insertSource(user, input.name, bytes)
}

/** A copy of one of the account's own pictures (a generated image id or attachment:<message>:<n>), as a keyframe. */
export function videoSourceFromImage(user: User, id: unknown) {
  // The same picture copied again (Make video… twice, a second plan) is the copy made before.
  if (typeof id === 'string') {
    const kept = database().prepare('SELECT id, name, mime, width, height FROM agent_video_sources WHERE user_id = ? AND origin_id = ? ORDER BY created_at DESC LIMIT 1').get(user.id, id) as Omit<SourceRow, 'body'> | undefined
    if (kept) return sourceView(kept)
  }
  const source = imageSource(user, id)
  return insertSource(user, source.name, source.bytes, typeof id === 'string' ? id : null)
}

/** How long a keyframe nothing uses yet is kept: one just uploaded is saved into its project a moment later. */
const SOURCE_GRACE_MS = 60 * 60_000
/**
 * Deletes the account's keyframes that no project and no waiting or running render uses (and that
 * are older than SOURCE_GRACE_MS): a changed or removed keyframe stops counting against the quota.
 */
export function sweepSources(userId: number, now = Date.now()) {
  const db = database()
  const used = new Set<string>()
  for (const r of db.prepare('SELECT data FROM agent_video_projects WHERE user_id = ?').all(userId) as { data: string }[]) {
    for (const seg of normalizeProject(JSON.parse(r.data)).segments) for (const k of [seg.firstFrame, seg.lastFrame]) if (k) used.add(k.sourceId)
  }
  for (const r of db.prepare(`SELECT render FROM agent_video_jobs WHERE user_id = ? AND status IN (${JOB_ACTIVE.map(() => '?').join(', ')})`).all(userId, ...JOB_ACTIVE) as { render: string }[]) {
    const render = JSON.parse(r.render) as { first?: string | null; last?: string | null }
    for (const k of [render.first, render.last]) if (k) used.add(k)
  }
  const old = db.prepare('SELECT id FROM agent_video_sources WHERE user_id = ? AND created_at < ?').all(userId, now - SOURCE_GRACE_MS) as { id: string }[]
  const gone = old.filter((r) => !used.has(r.id))
  for (const r of gone) db.prepare('DELETE FROM agent_video_sources WHERE id = ? AND user_id = ?').run(r.id, userId)
  return gone.length
}

function ownSource(user: User, id: string): SourceRow {
  const row = database().prepare('SELECT id, name, mime, body, width, height FROM agent_video_sources WHERE id = ? AND user_id = ?').get(id, user.id) as SourceRow | undefined
  if (!row) throw new HttpError(404, 'No such keyframe picture')
  return row
}

// --- projects ------------------------------------------------------------------------------------

type ProjectRow = { id: string; revision: number; title: string; data: string; origin: string; thread_id: string | null; created_at: number; updated_at: number }
const PROJECT_MAX = 256 * 1024

function projectView(r: ProjectRow) {
  return { id: r.id, revision: r.revision, origin: r.origin, thread_id: r.thread_id, created_at: r.created_at, updated_at: r.updated_at, project: normalizeProject(JSON.parse(r.data)) }
}

function ownProject(user: User, id: string): ProjectRow {
  if (!UUID.test(id)) throw new HttpError(404, 'No such video project')
  const row = database().prepare('SELECT id, revision, title, data, origin, thread_id, created_at, updated_at FROM agent_video_projects WHERE id = ? AND user_id = ?').get(id, user.id) as ProjectRow | undefined
  if (!row) throw new HttpError(404, 'No such video project')
  return row
}

/** Keyframes must be the account's own pictures. */
function checkKeyframes(user: User, project: VideoProject) {
  for (const seg of project.segments) for (const k of [seg.firstFrame, seg.lastFrame]) if (k) ownSource(user, k.sourceId)
}

export function listProjects(user: User) {
  const rows = database().prepare('SELECT id, revision, title, data, origin, thread_id, created_at, updated_at FROM agent_video_projects WHERE user_id = ? ORDER BY updated_at DESC LIMIT 200').all(user.id) as ProjectRow[]
  return rows.map((r) => {
    const p = normalizeProject(JSON.parse(r.data))
    const seg = p.segments[0]
    return { id: r.id, title: r.title, revision: r.revision, origin: r.origin, updated_at: r.updated_at, family: p.family, duration: seg.duration, width: p.width, height: p.height, firstFrame: seg.firstFrame ? sourceView({ id: seg.firstFrame.sourceId, name: seg.firstFrame.name, mime: '', width: seg.firstFrame.width, height: seg.firstFrame.height }).url : null }
  })
}

export function createProject(user: User, body: unknown, origin: 'studio' | 'agent' = 'studio', thread: string | null = null) {
  const raw = (body as { project?: unknown } | null)?.project
  const project = raw === undefined ? defaultProject() : normalizeProject(raw)
  checkKeyframes(user, project)
  const data = JSON.stringify(project)
  if (data.length > PROJECT_MAX) throw new HttpError(413, 'This project is too large')
  checkRoom(user, data.length)
  const id = randomUUID(), now = Date.now()
  database().prepare('INSERT INTO agent_video_projects (id, user_id, revision, title, data, origin, thread_id, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)').run(id, user.id, project.title, data, origin, thread, now, now)
  return projectView(ownProject(user, id))
}

/** A save names the revision it was based on: an older one (another tab or device saved since) is refused with the current one. */
export function saveProject(user: User, id: string, body: unknown) {
  const row = ownProject(user, id)
  const input = body as { revision?: unknown; project?: unknown } | null
  if (!input || typeof input !== 'object' || typeof input.revision !== 'number') throw new HttpError(400, 'Send { revision, project }')
  if (input.revision !== row.revision) throw new HttpError(409, 'This project was changed elsewhere since: reload it')
  const project = normalizeProject(input.project)
  checkKeyframes(user, project)
  const data = JSON.stringify(project)
  if (data.length > PROJECT_MAX) throw new HttpError(413, 'This project is too large')
  checkRoom(user, Math.max(0, data.length - row.data.length))
  database().prepare('UPDATE agent_video_projects SET revision = revision + 1, title = ?, data = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(project.title, data, Date.now(), id, user.id)
  sweepSources(user.id)
  return projectView(ownProject(user, id))
}

export function deleteProject(user: User, id: string) {
  ownProject(user, id)
  database().prepare('DELETE FROM agent_video_projects WHERE id = ? AND user_id = ?').run(id, user.id)
  sweepSources(user.id)
}

// --- rendering ------------------------------------------------------------------------------------

/** What a job keeps: the checked settings it runs with, and the keyframes by source id. */
type StoredRender = VideoRender & { first: string | null; last: string | null; title: string }
type JobRow = { id: string; user_id: number; project_id: string; status: VideoJobStatus; render: string; backend_scope: string; prompt_id: string | null; progress: string | null; error: string | null; video_id: string | null; origin: string; created_at: number; started_at: number | null; ended_at: number | null }

/** About how large a clip will be, for the quota check before queueing: ~1.2 bits per pixel per frame, at least 8 MB. */
const estimateBytes = (r: Pick<VideoRender, 'width' | 'height' | 'family' | 'duration'>) => Math.max(8 * 1024 * 1024, Math.round((r.width * r.height * videoFrameCount(r.family, r.duration) * 1.2) / 8))

/**
 * Everything a render needs, checked before anything is queued: ComfyUI connected, the lanes
 * compile into a valid plan, the duration and size fit the model, the model files are installed
 * and the graph matches this ComfyUI's nodes, the keyframes are the account's, and there is room.
 */
export async function prepareRender(user: User, projectId: string, signal: AbortSignal) {
  const row = ownProject(user, projectId)
  const project = normalizeProject(JSON.parse(row.data))
  const seg = project.segments[0]
  const family = project.family
  const settings = imageSettings(user)
  if (!settings.url) throw new HttpError(409, 'Connect ComfyUI in Settings → Image & Video Studio first')
  const problem = videoParameterProblem(family, seg.duration, project.width, project.height)
  if (problem) throw new HttpError(400, problem)
  const compiled = compileProject(project)
  if (compiled.problems.length) throw new HttpError(400, compiled.problems[0])
  if (!compiled.prompt.trim()) throw new HttpError(400, 'The prompt is empty')
  if (seg.lastFrame && !FAMILY_RULES[family].lastFrame) throw new HttpError(400, `${FAMILY_LABEL[family]} does not take a last frame: remove it, or switch to MiniMax H3.`)
  for (const k of [seg.firstFrame, seg.lastFrame]) if (k) ownSource(user, k.sourceId)
  const { catalog, schemas } = await videoCatalog(user, signal)
  if (!catalog.families[family].ok) throw new HttpError(409, catalog.families[family].error)
  const models = resolveVideoModels(family, videoModelSettings(user)[family], catalog)
  const missing = missingVideoModels(family, models)
  if (missing) throw new HttpError(409, missing)
  if (seg.turbo && !models.turboLora) throw new HttpError(409, 'Turbo needs the H3 Turbo LoRA: pick it in Settings → Image & Video Studio → Video, or switch Turbo off.')
  const seed = seg.seed >= 0 ? seg.seed : randomInt(0, 2 ** 32)
  const render: StoredRender = {
    family, models, prompt: compiled.prompt, width: project.width, height: project.height, duration: seg.duration, seed,
    steps: H3_SAMPLING.steps, turbo: seg.turbo, turboStrength: H3_SAMPLING.turboStrength, turboSteps: H3_SAMPLING.turboSteps,
    first: seg.firstFrame?.sourceId ?? null, last: family === 'minimax_h3' ? (seg.lastFrame?.sourceId ?? null) : null, title: project.title,
  }
  const built = buildVideoGraph(render, { first: render.first ? 'first.png' : undefined, last: render.last ? 'last.png' : undefined })
  fitVideoNodes(built.graph, schemas)
  const graphProblem = videoGraphProblem(built.graph, schemas)
  if (graphProblem) throw new HttpError(409, graphProblem)
  checkRoom(user, estimateBytes(render))
  const effective = effectiveSeconds(family, seg.duration)
  const summary = {
    title: `Render a video · ${FAMILY_LABEL[family]}`,
    rows: [
      ['Project', project.title],
      ['Length', `${seg.duration} s (${effective.toFixed(2)} s, ${built.frames} frames at ${VIDEO_FPS} fps)`],
      ['Size', `${project.width} × ${project.height}`],
      ['Keyframes', [seg.firstFrame ? `first: ${seg.firstFrame.name}` : '', render.last && seg.lastFrame ? `last: ${seg.lastFrame.name}` : ''].filter(Boolean).join(' · ') || 'none (text only)'],
      ['Seed', String(seed)],
      ['Runs on', 'your ComfyUI; takes minutes of its GPU'],
    ] as [string, string][],
    // The whole prompt (at most 16 000 characters): the card scrolls it.
    body: compiled.prompt,
  }
  return { project: row, render, summary, scope: imageBackendScope(user, settings) }
}

const jobView = (r: JobRow) => {
  const render = JSON.parse(r.render) as StoredRender
  return {
    id: r.id, project_id: r.project_id, status: r.status, error: r.error, video_id: r.video_id, origin: r.origin, created_at: r.created_at, started_at: r.started_at, ended_at: r.ended_at,
    progress: r.progress ? (JSON.parse(r.progress) as ImageProgress) : null,
    title: render.title, family: render.family, duration: render.duration, width: render.width, height: render.height, seed: render.seed,
  }
}
export type VideoJobView = ReturnType<typeof jobView>

function ownJob(user: User, id: string): JobRow {
  const row = UUID.test(id) ? (database().prepare('SELECT * FROM agent_video_jobs WHERE id = ? AND user_id = ?').get(id, user.id) as JobRow | undefined) : undefined
  if (!row) throw new HttpError(404, 'No such render')
  return row
}

const activeJobs = (userId: number) => (database().prepare(`SELECT COUNT(*) AS n FROM agent_video_jobs WHERE user_id = ? AND status IN (${JOB_ACTIVE.map(() => '?').join(', ')})`).get(userId, ...JOB_ACTIVE) as { n: number }).n

/** Queues a render of a project (checked by prepareRender first); the worker starts it when the account's ComfyUI slot is free. */
export async function startRender(user: User, projectId: string, origin: 'studio' | 'agent', signal: AbortSignal, prepared?: Awaited<ReturnType<typeof prepareRender>>) {
  if (activeJobs(user.id) >= MAX_QUEUED) throw new HttpError(429, `${MAX_QUEUED} renders are already waiting or running: let one finish, or cancel one`)
  const p = prepared ?? (await prepareRender(user, projectId, signal))
  // Counted again with nothing awaited before the insert: parallel requests cannot pass the limit together.
  if (activeJobs(user.id) >= MAX_QUEUED) throw new HttpError(429, `${MAX_QUEUED} renders are already waiting or running: let one finish, or cancel one`)
  const id = randomUUID()
  database().prepare('INSERT INTO agent_video_jobs (id, user_id, project_id, segment, status, render, backend_scope, origin, created_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)').run(id, user.id, projectId, 'queued', JSON.stringify(p.render), p.scope, origin, Date.now())
  // The worker is not the request's: it keeps going when the tab (and this request) closes.
  withoutPrivateRequest(() => pump())
  return jobView(ownJob(user, id))
}

export function listJobs(user: User, params: URLSearchParams) {
  const active = params.get('active') === '1'
  const rows = database().prepare(`SELECT * FROM agent_video_jobs WHERE user_id = ?${active ? ` AND status IN (${JOB_ACTIVE.map(() => '?').join(', ')})` : ''} ORDER BY created_at DESC LIMIT 50`).all(user.id, ...(active ? JOB_ACTIVE : [])) as JobRow[]
  return rows.map(jobView)
}

const setJob = (id: string, patch: Partial<Pick<JobRow, 'status' | 'prompt_id' | 'progress' | 'error' | 'video_id' | 'started_at' | 'ended_at'>>) => {
  const keys = Object.keys(patch) as (keyof typeof patch)[]
  if (!keys.length) return
  database().prepare(`UPDATE agent_video_jobs SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => patch[k] ?? null), id)
}

/** Running jobs by id, to cancel them. */
const running = new Map<string, { user: number; ctl: AbortController }>()

export function cancelJob(user: User, id: string) {
  const row = ownJob(user, id)
  if (!JOB_ACTIVE.includes(row.status)) return jobView(row)
  const live = running.get(id)
  if (live) live.ctl.abort(new HttpError(499, 'cancelled'))
  else setJob(id, { status: 'cancelled', ended_at: Date.now(), progress: null })
  return jobView(ownJob(user, id))
}

/** Stops every render an account has (signed out everywhere, banned or deleted: server/agents.ts stopTurnsOf). */
export function stopVideosOf(userId: number) {
  database().prepare(`UPDATE agent_video_jobs SET status = 'cancelled', ended_at = ? WHERE user_id = ? AND status = 'queued'`).run(Date.now(), userId)
  for (const [, live] of running) if (live.user === userId) live.ctl.abort(new HttpError(499, 'cancelled'))
}

let pumping = false
let again = false
let retry: ReturnType<typeof setTimeout> | null = null
const accountOf = (userId: number): User | null => accounts().find((u) => u.id === userId) ?? null

/** Starts every queued job whose account has a free ComfyUI slot; looks again soon while some wait on a busy slot. */
function pump() {
  if (pumping) return void (again = true)
  pumping = true
  try {
    const queued = database().prepare("SELECT * FROM agent_video_jobs WHERE status = 'queued' ORDER BY created_at").all() as JobRow[]
    let waiting = false
    for (const job of queued) {
      if ([...running.values()].some((r) => r.user === job.user_id)) { waiting = true; continue }
      // Pictures go first: one waiting for the slot, or an Image Studio batch between its pictures.
      if (imagesFirst(job.user_id) || !claimComfyJob(job.user_id, 'video')) { waiting = true; continue }
      const ctl = new AbortController()
      running.set(job.id, { user: job.user_id, ctl })
      void runJob(job, ctl).finally(() => {
        running.delete(job.id)
        releaseComfyJob(job.user_id)
        pump()
      })
    }
    if (waiting && !retry) retry = setTimeout(() => ((retry = null), pump()), 2000)
  } finally {
    pumping = false
    if (again) (again = false), pump()
  }
}

/** The saved video in a finished ComfyUI job's outputs: SaveVideo lists it under `images` on some versions, `videos` or `gifs` on others. */
function videoOutput(outputs: unknown) {
  const o = outputs && typeof outputs === 'object' ? (outputs as Record<string, unknown>) : {}
  for (const key of ['videos', 'gifs', 'images', 'video']) {
    const list = o[key]
    const item = Array.isArray(list) ? list.find((v) => v && typeof v === 'object' && typeof (v as { filename?: unknown }).filename === 'string' && /\.(mp4|m4v|mov|webm)$/i.test((v as { filename: string }).filename)) : undefined
    if (item) return item as { filename: string; subfolder?: unknown; type?: unknown }
  }
  return null
}

function userDir(userId: number) {
  const root = join(dataDir(), 'videos')
  for (const d of [root, join(root, String(userId))]) {
    mkdirSync(d, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') chmodSync(d, 0o700)
  }
  return join(root, String(userId))
}
const videoFile = (userId: number, id: string) => join(dataDir(), 'videos', String(userId), `${id}.mp4`)

async function runJob(job: JobRow, ctl: AbortController) {
  const user = accountOf(job.user_id)
  const fail = (error: string, status: VideoJobStatus = 'failed') => setJob(job.id, { status, error, ended_at: Date.now(), progress: null })
  if (!user) return fail('The account is gone or banned.', 'cancelled')
  const render = JSON.parse(job.render) as StoredRender
  const s = imageSettings(user)
  if (imageBackendScope(user, s) !== job.backend_scope) return fail('The ComfyUI connection changed after this render was queued: render again.')
  const limit = AbortSignal.any([ctl.signal, AbortSignal.timeout(deadlineMs())])
  let promptId: string | null = null
  let socket: { close: () => void } | null = null
  let lastWrite = 0
  const progress = (p: ImageProgress, force = false) => {
    if (!force && Date.now() - lastWrite < 700) return
    lastWrite = Date.now()
    setJob(job.id, { progress: JSON.stringify(p) })
  }
  let partial: string | null = null
  try {
    setJob(job.id, { status: 'uploading', started_at: Date.now(), progress: JSON.stringify({ phase: 'loading' }) })
    const names: { first?: string; last?: string } = {}
    for (const slot of ['first', 'last'] as const) {
      const sourceId = render[slot]
      if (!sourceId) continue
      const row = ownSource(user, sourceId)
      const name = `mvl-video-${randomUUID()}.${row.mime === 'image/jpeg' ? 'jpg' : row.mime === 'image/webp' ? 'webp' : 'png'}`
      await uploadSource(user, s, { bytes: Buffer.from(row.body), mime: row.mime }, name, limit)
      names[slot] = name
    }
    const built = buildVideoGraph(render, names)
    fitVideoNodes(built.graph, (await videoCatalog(user, limit)).schemas)
    const state = progressState()
    const clientId = randomUUID()
    let wake: (() => void) | null = null
    socket = await openComfySocket(user, s.url, s.token, clientId, limit, (message) => {
      if (applyComfyMessage(state, message, promptId, built.steps, built.progress) && state.progress) progress(state.progress)
      if (state.finished) wake?.()
    }).catch(() => null)
    const submitted = await readJSON(user, s, '/prompt', limit, { prompt: built.graph, client_id: clientId })
    if (typeof submitted.prompt_id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(submitted.prompt_id)) throw new HttpError(502, 'ComfyUI did not return a prompt ID')
    promptId = submitted.prompt_id
    setJob(job.id, { status: 'running', prompt_id: promptId, progress: JSON.stringify({ phase: 'queued' }) })
    for (;;) {
      limit.throwIfAborted()
      if (!state.started) {
        const place = await readJSON(user, s, '/queue', limit).then((q) => queuePosition(q, promptId!)).catch((e) => { if (limit.aborted) throw e; return null })
        if (place === 'running') state.started = true
        else if (place !== null) progress({ phase: 'queued', position: place })
      }
      const history = await readJSON(user, s, `/history/${encodeURIComponent(promptId)}`, limit)
      const entry = history[promptId]
      if (entry?.status?.status_str === 'error') {
        const failure = Array.isArray(entry.status.messages) ? entry.status.messages.find((m: unknown) => Array.isArray(m) && m[0] === 'execution_error')?.[1] : undefined
        const what = (v: unknown, n: number) => (typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, n) : '')
        throw new HttpError(502, `ComfyUI failed${what(failure?.node_type, 80) ? ` in ${what(failure?.node_type, 80)}` : ''}${what(failure?.exception_message, 240) ? `: ${what(failure?.exception_message, 240)}` : '; check the models and the GPU memory'}`)
      }
      const output = videoOutput(entry?.outputs?.[built.outputNode])
      if (output) {
        if ((output.type !== undefined && output.type !== 'output') || typeof output.subfolder !== 'string') throw new HttpError(502, 'ComfyUI returned an invalid video reference')
        setJob(job.id, { status: 'saving', progress: JSON.stringify({ phase: 'saving' }) })
        const id = randomUUID()
        const dir = userDir(user.id)
        partial = join(dir, `${id}.part`)
        const bytes = await download(user, s, output.filename, output.subfolder, partial, limit)
        limit.throwIfAborted()
        try {
          checkRoom(user, bytes)
        } catch (e) {
          rmSync(partial, { force: true })
          throw new HttpError(413, `${(e as Error).message}. The finished video (${Math.ceil(bytes / 1024 / 1024)} MB) was not kept.`)
        }
        renameSync(partial, videoFile(user.id, id))
        partial = null
        const frames = videoFrameCount(render.family, render.duration)
        const name = `${render.title.replace(/[^\w -]+/g, '').trim().slice(0, 60) || 'video'}.mp4`
        const settings = { family: render.family, models: render.models, prompt: render.prompt, seed: render.seed, steps: render.turbo ? render.turboSteps : render.steps, turbo: render.turbo, duration: render.duration, first: render.first, last: render.last }
        database().prepare('INSERT INTO agent_videos (id, user_id, project_id, job_id, name, bytes, width, height, frames, fps, settings, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, user.id, job.project_id, job.id, name, bytes, render.width, render.height, frames, VIDEO_FPS, JSON.stringify(settings), Date.now())
        setJob(job.id, { status: 'done', video_id: id, ended_at: Date.now(), progress: null })
        void pushToUser(user, { title: 'Your video is ready', body: render.title, tag: `video-${job.id}`, url: `/?open=videostudio&project=${job.project_id}` }).catch(() => {})
        return
      }
      if (entry?.status?.completed) throw new HttpError(502, 'ComfyUI finished without a video')
      const pause = new AbortController()
      wake = () => pause.abort()
      if (!state.finished) await delay(1500, undefined, { signal: AbortSignal.any([limit, pause.signal]) }).catch(() => {})
      wake = null
      state.finished = false
    }
  } catch (error) {
    if (promptId) await cancelQueuedPrompt(user, s, promptId)
    if (ctl.signal.aborted) return fail('Cancelled. A render ComfyUI had already started may finish there, but its video is not kept.', 'cancelled')
    if (limit.aborted) return fail(`The render took longer than ${Math.round(deadlineMs() / 60_000)} minutes and was stopped.`)
    fail(error instanceof Error ? error.message : 'The render failed')
    void pushToUser(user, { title: 'A video render failed', body: render.title, tag: `video-${job.id}`, url: `/?open=videostudio&project=${job.project_id}` }).catch(() => {})
  } finally {
    socket?.close()
    if (partial) rmSync(partial, { force: true })
  }
}

/**
 * Streams ComfyUI's video to `path` through one pipeline (so a full disk, a broken connection or a
 * cancel all end it, and the file goes): at most OUTPUT_MAX and never more than the account has room
 * for (refused before reading when ComfyUI says the size up front), and an MP4 (an ftyp box first).
 */
async function download(user: User, s: ReturnType<typeof imageSettings>, filename: string, subfolder: string, path: string, signal: AbortSignal): Promise<number> {
  const params = new URLSearchParams({ filename, subfolder, type: 'output' })
  const res = await guardedFetch(user, `${s.url}/view?${params}`, { redirect: 'manual', headers: s.token ? { Authorization: `Bearer ${s.token}` } : {}, signal: AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)]) })
  if (!res.ok || !res.body) {
    await res.body?.cancel().catch(() => {})
    throw new HttpError(502, `ComfyUI answered ${res.status} for the video`)
  }
  const room = roomLeft(user.id)
  const full = (bytes: number) => new HttpError(413, `Your storage is full (${limitLabel()}): delete old videos or threads first. The finished video (${Math.ceil(bytes / 1024 / 1024)} MB) was not kept.`)
  const announced = Number(res.headers.get('content-length'))
  if (Number.isFinite(announced) && announced > OUTPUT_MAX) {
    await res.body.cancel().catch(() => {})
    throw new HttpError(413, `The video is larger than ${OUTPUT_MAX / 1024 / 1024} MB`)
  }
  if (Number.isFinite(announced) && announced > room) {
    await res.body.cancel().catch(() => {})
    throw full(announced)
  }
  const cap = Math.min(OUTPUT_MAX, room)
  let size = 0
  let head = Buffer.alloc(0)
  const guard = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      size += chunk.length
      if (size > cap) return done(cap < OUTPUT_MAX ? full(size) : new HttpError(413, `The video is larger than ${OUTPUT_MAX / 1024 / 1024} MB`))
      if (head.length < 12) head = Buffer.concat([head, chunk]).subarray(0, 12)
      done(null, chunk)
    },
  })
  try {
    await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), guard, createWriteStream(path, { mode: 0o600 }), { signal })
    if (head.length < 12 || head.toString('ascii', 4, 8) !== 'ftyp') throw new HttpError(502, 'ComfyUI did not return an MP4 video')
  } catch (error) {
    rmSync(path, { force: true })
    throw error
  }
  return size
}

/** After a restart: what was uploading, running or saving cannot be followed any more. Queued jobs go on. */
export function recoverVideoJobs() {
  withoutPrivateRequest(() => {
    database().prepare(`UPDATE agent_video_jobs SET status = 'interrupted', error = ?, ended_at = ?, progress = NULL WHERE status IN ('uploading', 'running', 'saving')`).run('The server restarted during this render. ComfyUI may still finish it, but the video was not collected: render again.', Date.now())
    // Half-written downloads of those jobs (nothing is downloading yet: the worker starts below).
    const root = join(dataDir(), 'videos')
    if (existsSync(root)) {
      for (const user of readdirSync(root, { withFileTypes: true })) {
        if (!user.isDirectory()) continue
        for (const f of readdirSync(join(root, user.name))) if (f.endsWith('.part')) rmSync(join(root, user.name, f), { force: true })
      }
    }
    pump()
  })
  // Keyframes nothing uses any more, for every account, now and then (saves and deletes sweep their own).
  const sweep = () => withoutPrivateRequest(() => {
    for (const r of database().prepare('SELECT DISTINCT user_id FROM agent_video_sources').all() as { user_id: number }[]) sweepSources(r.user_id)
  })
  setInterval(sweep, 6 * 3600_000).unref()
}

// --- videos --------------------------------------------------------------------------------------

type VideoRow = { id: string; project_id: string | null; job_id: string | null; name: string; bytes: number; width: number; height: number; frames: number; fps: number; settings: string; created_at: number }
const videoView = (r: VideoRow) => ({ id: r.id, project_id: r.project_id, job_id: r.job_id, name: r.name, size: r.bytes, width: r.width, height: r.height, frames: r.frames, fps: r.fps, duration: r.frames / r.fps, url: `/api/video/media/${r.id}`, created_at: r.created_at, settings: JSON.parse(r.settings) as Record<string, unknown> })

export function listVideos(user: User, params: URLSearchParams) {
  const project = params.get('project')
  const before = Number(params.get('before') ?? 0)
  const rows = database().prepare(`SELECT id, project_id, job_id, name, bytes, width, height, frames, fps, settings, created_at FROM agent_videos WHERE user_id = ?${project ? ' AND project_id = ?' : ''}${before ? ' AND created_at < ?' : ''} ORDER BY created_at DESC LIMIT 31`).all(user.id, ...(project ? [project] : []), ...(before ? [before] : [])) as VideoRow[]
  return { videos: rows.slice(0, 30).map(videoView), next_before: rows.length > 30 ? rows[29].created_at : null }
}

function ownVideo(user: User, id: string): VideoRow {
  const row = UUID.test(id) ? (database().prepare('SELECT id, project_id, job_id, name, bytes, width, height, frames, fps, settings, created_at FROM agent_videos WHERE id = ? AND user_id = ?').get(id, user.id) as VideoRow | undefined) : undefined
  if (!row) throw new HttpError(404, 'No such video')
  return row
}

export function deleteVideo(user: User, id: string) {
  ownVideo(user, id)
  database().prepare('DELETE FROM agent_videos WHERE id = ? AND user_id = ?').run(id, user.id)
  rmSync(videoFile(user.id, id), { force: true })
}

/** The video, with byte ranges (one range: what players ask for), so it can be seeked without loading all of it. */
export function sendVideo(req: IncomingMessage, res: ServerResponse, user: User, id: string, head: boolean) {
  const row = ownVideo(user, id)
  const file = videoFile(user.id, id)
  if (!existsSync(file)) throw new HttpError(404, 'The video file is missing')
  const size = statSync(file).size
  const base = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-cache', 'Content-Disposition': `inline; filename="${row.name.replace(/"/g, '')}"`, ...SECURITY, ...UNTRUSTED }
  const range = typeof req.headers.range === 'string' ? req.headers.range : null
  let start = 0, end = size - 1, status = 200
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
    if (!m || (m[1] === '' && m[2] === '')) return void res.writeHead(416, { ...base, 'Content-Range': `bytes */${size}` }).end()
    if (m[1] === '') start = Math.max(0, size - Number(m[2]))
    else (start = Number(m[1])), (end = m[2] === '' ? size - 1 : Math.min(size - 1, Number(m[2])))
    if (start > end || start >= size) return void res.writeHead(416, { ...base, 'Content-Range': `bytes */${size}` }).end()
    status = 206
  }
  res.writeHead(status, { ...base, 'Content-Length': String(end - start + 1), ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) })
  if (head) return void res.end()
  const stream = createReadStream(file, { start, end })
  res.on('close', () => stream.destroy())
  // A file that went away or a read error mid-way: end the response rather than leave it hanging.
  stream.on('error', () => res.destroy())
  stream.pipe(res)
}

// --- picture sources for the keyframe picker -------------------------------------------------------

/** Pictures sent in the account's threads (not generated ones: those come from the Studio's list), newest first. */
export function threadPictures(user: User, params: URLSearchParams) {
  const before = Number(params.get('before') ?? 0)
  const rows = database().prepare(`SELECT m.id AS message, m.thread_id AS thread, a.key AS position, json_extract(a.value, '$.name') AS name, m.created_at AS at
    FROM agent_messages m JOIN agent_threads t ON t.id = m.thread_id, json_each(m.attachments) a
    WHERE t.user_id = ? AND t.quick IN (0, 1) AND m.role = 'user' AND json_extract(a.value, '$.kind') = 'image'${before ? ' AND m.id < ?' : ''}
    ORDER BY m.id DESC, a.key LIMIT 41`).all(user.id, ...(before ? [before] : [])) as { message: number; thread: string; position: number; name: string; at: number }[]
  return {
    pictures: rows.slice(0, 40).map((r) => ({ id: `attachment:${r.message}:${r.position}`, name: String(r.name ?? 'picture'), url: `/api/agents/threads/${r.thread}/messages/${r.message}/attachments/${r.position}` })),
    next_before: rows.length > 40 ? rows[39].message : null,
  }
}

// --- the agent's tools -------------------------------------------------------------------------------

/**
 * plan_video: an agent lays out a clip (a plan in validateVideoPromptPlan's shape, and optionally
 * a picture of the thread's as the first or last frame). It is saved as a Video Studio project the
 * user can open and edit; nothing renders. Plan errors go back to the model to fix.
 */
export function planVideoTool(user: User, thread: string, args: Record<string, unknown>) {
  const allowed = new Set(['title', 'family', 'duration', 'aspect', 'source_image_id', 'last_image_id', 'plan', 'project_id'])
  const extra = Object.keys(args).filter((k) => !allowed.has(k))
  if (extra.length) throw new HttpError(400, `Unknown arguments: ${extra.join(', ')}`)
  const family: VideoFamily = args.family === 'ltx25' ? 'ltx25' : 'minimax_h3'
  const rules = FAMILY_RULES[family]
  const duration = typeof args.duration === 'number' ? args.duration : family === 'ltx25' ? 5 : 10
  if (!Number.isFinite(duration) || duration < rules.minSeconds || duration > rules.maxSeconds || (rules.wholeSeconds && !Number.isInteger(duration))) throw new HttpError(400, `${FAMILY_LABEL[family]} takes ${rules.wholeSeconds ? 'a whole number of seconds' : 'a duration'} from ${rules.minSeconds} to ${rules.maxSeconds}.`)
  if (args.last_image_id !== undefined && !rules.lastFrame) throw new HttpError(400, 'Only MiniMax H3 takes a last frame.')
  const hasFirstFrame = args.source_image_id !== undefined, hasLastFrame = args.last_image_id !== undefined
  const checked = validateVideoPromptPlan(args.plan, { duration, hasFirstFrame, hasLastFrame })
  if (!checked.ok) throw new HttpError(400, checked.error)
  const ratio = typeof args.aspect === 'string' && /^\d{1,2}:\d{1,2}$/.test(args.aspect) ? Number(args.aspect.split(':')[0]) / Number(args.aspect.split(':')[1]) : 16 / 9
  // Only a project this thread's agent made can be replaced; anything else gets a new project.
  // Checked before any picture is copied.
  const replace = typeof args.project_id === 'string' && UUID.test(args.project_id)
    ? (database().prepare("SELECT id, revision FROM agent_video_projects WHERE id = ? AND user_id = ? AND origin = 'agent' AND thread_id = ?").get(args.project_id, user.id, thread) as { id: string; revision: number } | undefined)
    : undefined
  const frame = (id: unknown): Keyframe | null => {
    if (id === undefined) return null
    const s = videoSourceFromImage(user, id)
    return { sourceId: s.id, name: s.name, width: s.width, height: s.height, prepared: false }
  }
  const first = frame(args.source_image_id), last = frame(args.last_image_id)
  const base = defaultProject(family)
  // A first frame sets the clip's shape unless the agent named one.
  const shape = typeof args.aspect === 'string' ? ratio : first ? first.width / first.height : ratio
  const short = family === 'ltx25' ? 704 : 768
  const size = shape >= 1 ? { width: Math.round((short * shape) / rules.step) * rules.step, height: short } : { width: short, height: Math.round(short / shape / rules.step) * rules.step }
  const clamp = (v: number) => Math.min(rules.maxSide, Math.max(rules.minSide, v))
  const project: VideoProject = {
    ...base,
    title: typeof args.title === 'string' && args.title.trim() ? args.title.trim().slice(0, 120) : 'Planned video',
    width: clamp(size.width), height: clamp(size.height),
    style: checked.value.style, speakers: checked.value.speakers, soundscape: checked.value.soundscape, music: checked.value.music ?? '',
    segments: [{ ...base.segments[0], duration, firstFrame: first, lastFrame: last, lanes: lanesFromPlan(checked.value) }],
  }
  const saved = replace ? saveProject(user, replace.id, { revision: replace.revision, project }) : createProject(user, { project }, 'agent', thread)
  const compiled = compileProject(saved.project)
  return {
    project_id: saved.id,
    ...(typeof args.project_id === 'string' ? { replaced: !!replace, ...(replace ? {} : { note: 'project_id was not a plan of this thread: a new project was made instead.' }) } : {}),
    title: saved.project.title,
    family: FAMILY_LABEL[family],
    duration,
    effective_seconds: Number(effectiveSeconds(family, duration).toFixed(2)),
    size: `${saved.project.width} × ${saved.project.height}`,
    shots: checked.value.shots.length,
    problems: compiled.problems,
    prompt_preview: compiled.prompt.slice(0, 800),
    message: 'Saved as a Video Studio project; nothing is rendering. The app shows it with Open in Video Studio. Rendering takes minutes of the user\'s GPU: call render_video with this project_id only when the user asks for it (they approve each render).',
  }
}

/** render_video, checked: what the approval card shows, and the call that queues it once allowed. */
export async function prepareRenderTool(user: User, args: Record<string, unknown>, signal: AbortSignal) {
  if (Object.keys(args).some((k) => k !== 'project_id') || typeof args.project_id !== 'string') throw new HttpError(400, 'Supply project_id from plan_video')
  const projectId = args.project_id
  const prepared = await prepareRender(user, projectId, signal)
  return {
    summary: prepared.summary,
    run: async () => {
      const job = await startRender(user, projectId, 'agent', signal, prepared)
      return JSON.stringify({ job_id: job.id, project_id: projectId, status: job.status, message: 'Queued on the user\'s ComfyUI. It runs on the server for minutes, also with the tab closed; the user sees it in the Video Studio and gets a notification. Do not wait for it or check on it in this turn.' })
    },
  }
}

// --- routes ----------------------------------------------------------------------------------------

/** /api/video/…: the signed-in account's own projects, keyframes, renders and videos. */
export async function handleVideoApi(req: IncomingMessage, res: ServerResponse, url: URL, method: string, user: User): Promise<boolean> {
  const path = url.pathname
  const read = method === 'GET' || method === 'HEAD'
  if (path === '/api/video' && read) return json(res, 200, { configured: !!imageSettings(user).url, maxQueued: MAX_QUEUED }), true
  if (path === '/api/video/catalog' && read) {
    const { catalog } = await videoCatalog(user, AbortSignal.timeout(30_000), url.searchParams.has('fresh'))
    const chosen = videoModelSettings(user)
    return json(res, 200, { catalog, chosen, resolved: Object.fromEntries(VIDEO_FAMILIES.map((f) => [f, resolveVideoModels(f, chosen[f], catalog)])) }), true
  }
  if (path === '/api/video/models') {
    if (read) return json(res, 200, videoModelSettings(user)), true
    if (method === 'PUT') return json(res, 200, saveVideoModelSettings(user, await readJson(req, 16 * 1024))), true
  }
  if (path === '/api/video/projects') {
    if (read) return json(res, 200, { projects: listProjects(user) }), true
    if (method === 'POST') return json(res, 200, createProject(user, await readJson(req, PROJECT_MAX + 1024))), true
  }
  const project = /^\/api\/video\/projects\/([0-9a-f-]{36})$/.exec(path)?.[1]
  if (project) {
    if (read) return json(res, 200, projectView(ownProject(user, project))), true
    if (method === 'PUT') {
      try {
        return json(res, 200, saveProject(user, project, await readJson(req, PROJECT_MAX + 1024))), true
      } catch (e) {
        if (e instanceof HttpError && e.status === 409) return json(res, 409, { error: e.message, current: projectView(ownProject(user, project)) }), true
        throw e
      }
    }
    if (method === 'DELETE') return deleteProject(user, project), json(res, 200, { ok: true }), true
  }
  const render = /^\/api\/video\/projects\/([0-9a-f-]{36})\/render$/.exec(path)?.[1]
  if (render && method === 'POST') return json(res, 200, await startRender(user, render, 'studio', AbortSignal.timeout(60_000))), true
  if (path === '/api/video/sources' && method === 'POST') {
    const body = await readJson<Record<string, unknown>>(req, Math.ceil((SOURCE_MAX * 4) / 3) + 4096)
    return json(res, 200, body && typeof body === 'object' && 'image_id' in body && Object.keys(body).length === 1 ? videoSourceFromImage(user, body.image_id) : uploadVideoSource(user, body)), true
  }
  const source = /^\/api\/video\/sources\/([0-9a-f-]{36})$/.exec(path)?.[1]
  if (source && read) {
    const row = ownSource(user, source)
    res.writeHead(200, { ...SECURITY, ...UNTRUSTED, 'Content-Type': row.mime, 'Content-Length': row.body.length, 'Cache-Control': 'private, max-age=86400' }).end(method === 'HEAD' ? undefined : row.body)
    return true
  }
  if (path === '/api/video/pictures' && read) return json(res, 200, threadPictures(user, url.searchParams)), true
  if (path === '/api/video/jobs' && read) return json(res, 200, { jobs: listJobs(user, url.searchParams) }), true
  const job = /^\/api\/video\/jobs\/([0-9a-f-]{36})$/.exec(path)?.[1]
  if (job && read) return json(res, 200, jobView(ownJob(user, job))), true
  if (job && method === 'DELETE') return json(res, 200, cancelJob(user, job)), true
  if (path === '/api/video/videos' && read) return json(res, 200, listVideos(user, url.searchParams)), true
  const media = /^\/api\/video\/media\/([0-9a-f-]{36})$/.exec(path)?.[1]
  if (media && read) return sendVideo(req, res, user, media, method === 'HEAD'), true
  const video = /^\/api\/video\/videos\/([0-9a-f-]{36})$/.exec(path)?.[1]
  if (video && method === 'DELETE') return deleteVideo(user, video), json(res, 200, { ok: true }), true
  return false
}

// Deleting the account deletes its rows (ON DELETE CASCADE); its video files go here.
onUserGone((userId) => {
  catalogs.delete(userId)
  rmSync(join(dataDir(), 'videos', String(userId)), { recursive: true, force: true })
})
