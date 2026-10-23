import { randomInt, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { User } from './auth.ts'
import { database, decrypt, encrypt } from './db.ts'
import { guardedFetch, readCapped } from './egress.ts'
import { HttpError, json, readJson, SECURITY, UNTRUSTED } from './http.ts'
import { checkRoom } from './quota.ts'

// Small, server-owned ComfyUI graphs, following Diffu's checkpoint / diffusion loader approach.
// No arbitrary graphs, remote URLs, or backend credentials are accepted from a model tool call.
const NAME = 'agents-comfyui'
export const PRESETS = ['sd15', 'sdxl', 'z_image', 'z_image_turbo'] as const
export type Preset = (typeof PRESETS)[number]
export type ImageSettings = { url: string; token: string; preset: Preset; model: string; clip: string; vae: string }
const defaults = (): ImageSettings => ({ url: '', token: '', preset: 'sdxl', model: '', clip: '', vae: '' })
export function imageSettings(user: User): ImageSettings {
  const row = database().prepare('SELECT secret FROM integrations WHERE user_id = ? AND name = ?').get(user.id, NAME) as { secret: string } | undefined
  return row ? { ...defaults(), ...JSON.parse(decrypt(row.secret)) } : defaults()
}
const view = (s: ImageSettings) => ({ ...s, token: !!s.token })
export function saveImageSettings(user: User, input: Record<string, unknown>) {
  const s = imageSettings(user)
  for (const key of ['url', 'token', 'model', 'clip', 'vae'] as const) {
    if (input[key] === undefined || (key === 'token' && input[key] === '')) continue
    if (typeof input[key] !== 'string' || input[key].length > 2048) throw new HttpError(400, `Invalid ${key}`)
    s[key] = input[key].trim()
  }
  if (input.clearToken === true) s.token = ''
  if (input.preset !== undefined) {
    if (!PRESETS.includes(input.preset as Preset)) throw new HttpError(400, 'Choose a supported image preset')
    s.preset = input.preset as Preset
  }
  if (s.url) {
    let u: URL
    try { u = new URL(s.url) } catch { throw new HttpError(400, 'Enter a ComfyUI HTTP(S) URL') }
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new HttpError(400, 'Use an HTTP(S) URL without credentials, query or fragment')
    s.url = u.href.replace(/\/+$/, '')
  }
  if (/[\r\n]/.test(s.token)) throw new HttpError(400, 'Invalid authorization token')
  database().prepare('INSERT INTO integrations (user_id, name, secret, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, name) DO UPDATE SET secret = excluded.secret').run(user.id, NAME, encrypt(JSON.stringify(s)), Date.now())
  return view(s)
}

export type ImageOverrides = Partial<Pick<ImageSettings, 'preset' | 'model' | 'clip' | 'vae'>> & { width?: number; height?: number; seed?: number | null }
const CONFIG_KEYS = new Set(['preset', 'model', 'clip', 'vae', 'width', 'height', 'seed'])
export function validateImageOverrides(value: unknown): ImageOverrides {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Image overrides must be an object')
  const input = value as Record<string, unknown>
  if (Object.keys(input).some((key) => !CONFIG_KEYS.has(key))) throw new HttpError(400, 'Only preset, model, clip, vae, width, height and seed can be overridden')
  const out: ImageOverrides = {}
  if ('preset' in input) {
    if (!PRESETS.includes(input.preset as Preset)) throw new HttpError(400, 'Choose a supported image preset')
    out.preset = input.preset as Preset
  }
  for (const key of ['model', 'clip', 'vae'] as const) {
    if (!(key in input)) continue
    if (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > 2048 || /[\x00-\x1f]/.test(input[key])) throw new HttpError(400, `Choose an installed ${key}`)
    out[key] = input[key] // Preserve the exact catalog identifier, including separators and spaces.
  }
  for (const key of ['width', 'height'] as const) {
    if (!(key in input)) continue
    const v = input[key]
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 256 || v > 1536 || v % 64) throw new HttpError(400, 'Image dimensions must be multiples of 64 between 256 and 1536')
    out[key] = v
  }
  if ('seed' in input) {
    const v = input.seed
    if (v !== null && (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0)) throw new HttpError(400, 'Seed must be random (null) or a non-negative safe integer')
    out.seed = v as number | null
  }
  return out
}
function ownImageThread(user: User, thread: string) {
  const row = database().prepare('SELECT image_config FROM agent_threads WHERE id = ? AND user_id = ?').get(thread, user.id) as { image_config: string | null } | undefined
  if (!row) throw new HttpError(404, 'No such thread')
  return row
}
function effectiveConfig(s: ImageSettings, overrides: ImageOverrides) {
  const preset = overrides.preset ?? s.preset
  return { preset, model: overrides.model ?? s.model, clip: overrides.clip ?? s.clip, vae: overrides.vae ?? s.vae, width: overrides.width ?? (preset === 'sd15' ? 512 : 1024), height: overrides.height ?? (preset === 'sd15' ? 512 : 1024), seed: overrides.seed ?? null }
}
export function threadImageSettings(user: User, thread: string) {
  const row = ownImageThread(user, thread)
  const overrides = row.image_config ? validateImageOverrides(JSON.parse(row.image_config)) : {}
  const s = imageSettings(user)
  // No URL, token or auth flags enter thread data, tool results, or shared exports.
  return { overrides, defaults: effectiveConfig(s, {}), effective: effectiveConfig(s, overrides) }
}
export async function saveThreadImageSettings(user: User, thread: string, value: unknown) {
  ownImageThread(user, thread)
  const overrides = validateImageOverrides(value)
  const s = imageSettings(user)
  const effective = effectiveConfig(s, overrides)
  if (effective.width * effective.height > 1536 * 1024) throw new HttpError(400, 'Image area must not exceed 1536 × 1024 pixels')
  // Resetting to defaults must also work with an offline or disconnected backend.
  if (['preset', 'model', 'clip', 'vae'].some((key) => key in overrides)) {
    const catalog = await imageCatalog(user)
    const models = effective.preset.startsWith('z_image') ? catalog.diffusionModels : catalog.checkpoints
    if (!models.includes(effective.model)) throw new HttpError(400, 'Choose an installed model for the selected preset')
    if (effective.preset.startsWith('z_image') && (!catalog.clips.includes(effective.clip) || !catalog.vaes.includes(effective.vae) || !catalog.clipTypes.includes('lumina2'))) throw new HttpError(400, 'Z-Image requires an installed lumina2 text encoder and VAE')
    // Explicit inactive encoder/VAE overrides must still refer to real catalog assets.
    if (overrides.clip && !catalog.clips.includes(overrides.clip) || overrides.vae && !catalog.vaes.includes(overrides.vae)) throw new HttpError(400, 'Choose an installed text encoder and VAE')
  }
  database().prepare('UPDATE agent_threads SET image_config = ? WHERE id = ? AND user_id = ?').run(Object.keys(overrides).length ? JSON.stringify(overrides) : null, thread, user.id)
  return threadImageSettings(user, thread)
}

async function request(user: User, s: ImageSettings, path: string, signal: AbortSignal, body?: unknown) {
  if (!s.url) throw new HttpError(409, 'Configure ComfyUI in Settings → Apps → Agents → Images first')
  // Egress checks every request, pinning DNS for non-admins; LAN endpoints are admin-only.
  const res = await guardedFetch(user, `${s.url}${path}`, {
    method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
    headers: { ...(s.token ? { Authorization: `Bearer ${s.token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  }).catch((error: unknown) => {
    if (signal.aborted) throw error
    if (error instanceof HttpError) throw error
    throw new HttpError(502, 'ComfyUI did not answer; check the connection settings')
  })
  if (!res.ok) {
    await res.body?.cancel().catch(() => {})
    throw new HttpError(502, `ComfyUI answered ${res.status}; check the connection and selected models`)
  }
  return res
}
async function readJSON(user: User, s: ImageSettings, path: string, signal: AbortSignal, body?: unknown): Promise<Record<string, any>> {
  const bytes = await readCapped(await request(user, s, path, signal, body), 8 * 1024 * 1024)
  try { return JSON.parse(bytes.toString()) } catch { throw new HttpError(502, 'ComfyUI returned invalid JSON') }
}
type NodeInfo = Record<string, { input?: { required?: Record<string, unknown[]>; optional?: Record<string, unknown[]> } }>
const options = (info: NodeInfo, node: string, field: string): string[] => {
  const list = (info[node]?.input?.required?.[field] ?? info[node]?.input?.optional?.[field])?.[0]
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string').slice(0, 2000) : []
}
// Query only the built-in classes our presets use. A full /object_info can contain many
// megabytes of unrelated custom-node metadata. Keep both each response and the total bounded.
const IMAGE_NODES = ['CheckpointLoaderSimple', 'UNETLoader', 'CLIPLoader', 'VAELoader', 'CLIPTextEncode', 'EmptyLatentImage', 'KSampler', 'VAEDecode', 'SaveImage'] as const
const NODE_INFO_LIMIT = 1024 * 1024
const CATALOG_LIMIT = 4 * 1024 * 1024
export async function imageCatalog(user: User, signal = AbortSignal.timeout(30_000), s = imageSettings(user)) {
  const info: NodeInfo = {}
  const limit = AbortSignal.any([signal, AbortSignal.timeout(30_000)])
  let remaining = CATALOG_LIMIT
  for (const node of IMAGE_NODES) {
    const cap = Math.min(NODE_INFO_LIMIT, remaining)
    try {
      const bytes = await readCapped(await request(user, s, `/object_info/${node}`, limit), cap)
      remaining -= bytes.length
      let value: unknown
      try { value = JSON.parse(bytes.toString()) } catch { throw new HttpError(502, `ComfyUI returned invalid JSON for ${node}`) }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(502, `ComfyUI returned invalid node metadata for ${node}`)
      const definition = (value as NodeInfo)[node]
      // ComfyUI answers {} for an unavailable class. Leave it absent so graph validation
      // can distinguish a missing required node from an empty list of installed models.
      if (definition !== undefined) {
        if (!definition || typeof definition !== 'object' || Array.isArray(definition)) throw new HttpError(502, `ComfyUI returned invalid node metadata for ${node}`)
        info[node] = definition
      }
    } catch (error) {
      if (limit.aborted) throw new HttpError(504, 'ComfyUI model discovery was cancelled or timed out; try refreshing the models')
      if (error instanceof HttpError && error.status === 413) throw new HttpError(502, cap < NODE_INFO_LIMIT
        ? 'ComfyUI model discovery exceeds the 4 MiB total metadata limit; reduce oversized node metadata and retry'
        : `ComfyUI metadata for ${node} exceeds the 1 MiB per-node limit; reduce that node’s metadata and retry`)
      if (error instanceof HttpError) throw new HttpError(error.status, `Could not discover ${node}: ${error.message}`)
      throw error
    }
  }
  return { presets: PRESETS, checkpoints: options(info, 'CheckpointLoaderSimple', 'ckpt_name'), diffusionModels: options(info, 'UNETLoader', 'unet_name'), clips: options(info, 'CLIPLoader', 'clip_name'), vaes: options(info, 'VAELoader', 'vae_name'), nodes: Object.keys(info), clipTypes: options(info, 'CLIPLoader', 'type'), samplers: options(info, 'KSampler', 'sampler_name'), schedulers: options(info, 'KSampler', 'scheduler') }
}
export type ImageInput = { prompt?: unknown; negative_prompt?: unknown; width?: unknown; height?: unknown; seed?: unknown }
type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>
export function imageWorkflow(s: ImageSettings, input: ImageInput) {
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 6000) throw new HttpError(400, 'Supply an image prompt of 1–6000 characters')
  if (input.negative_prompt !== undefined && (typeof input.negative_prompt !== 'string' || input.negative_prompt.length > 6000)) throw new HttpError(400, 'Negative prompt must be at most 6000 characters')
  const dimension = (v: unknown) => {
    if (v === undefined) return s.preset === 'sd15' ? 512 : 1024
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 256 || v > 1536 || v % 64) throw new HttpError(400, 'Image dimensions must be multiples of 64 between 256 and 1536')
    return v
  }
  const width = dimension(input.width), height = dimension(input.height)
  if (width * height > 1536 * 1024) throw new HttpError(400, 'Image area must not exceed 1536 × 1024 pixels')
  const seed = input.seed === undefined ? randomInt(2 ** 48 - 1) : input.seed
  if (typeof seed !== 'number' || !Number.isSafeInteger(seed) || seed < 0) throw new HttpError(400, 'Seed must be a non-negative safe integer')
  const diffusion = s.preset.startsWith('z_image'), turbo = s.preset === 'z_image_turbo'
  if (!s.model || (diffusion && (!s.clip || !s.vae))) throw new HttpError(409, 'Select the model and required text encoder/VAE in Agents → Images settings')
  if (turbo && input.negative_prompt) throw new HttpError(400, 'Z-Image Turbo uses a positive prompt only')
  const graph: Graph = {}
  const node = (id: string, class_type: string, inputs: Record<string, unknown>) => (graph[id] = { class_type, inputs }, [id, 0])
  const model = diffusion ? node('1', 'UNETLoader', { unet_name: s.model, weight_dtype: 'default' }) : node('1', 'CheckpointLoaderSimple', { ckpt_name: s.model })
  const clip = diffusion ? node('2', 'CLIPLoader', { clip_name: s.clip, type: 'lumina2' }) : ['1', 1]
  const vae = diffusion ? node('3', 'VAELoader', { vae_name: s.vae }) : ['1', 2]
  const positive = node('4', 'CLIPTextEncode', { clip, text: input.prompt.trim() })
  const negative = node('5', 'CLIPTextEncode', { clip, text: input.negative_prompt ?? '' })
  const latent = node('6', 'EmptyLatentImage', { width, height, batch_size: 1 })
  const samples = node('7', 'KSampler', { model, positive, negative, latent_image: latent, seed, steps: turbo ? 8 : diffusion ? 20 : 25, cfg: turbo ? 1 : diffusion ? 4 : 7, sampler_name: 'euler', scheduler: 'simple', denoise: 1 })
  const images = node('8', 'VAEDecode', { samples, vae })
  node('9', 'SaveImage', { images, filename_prefix: 'agents/generated' })
  return { graph, width, height, seed }
}

const active = new Set<number>()
export async function generateImage(user: User, thread: string, input: ImageInput, signal: AbortSignal) {
  // Check ownership here too: callers cannot write an artifact into another account's thread.
  if (!database().prepare('SELECT 1 FROM agent_threads WHERE id = ? AND user_id = ?').get(thread, user.id)) throw new HttpError(404, 'No such thread')
  if (active.has(user.id)) throw new HttpError(409, 'An image is already generating for this account')
  const { effective } = threadImageSettings(user, thread)
  const s = { ...imageSettings(user), preset: effective.preset, model: effective.model, clip: effective.clip, vae: effective.vae }
  const workflow = imageWorkflow(s, { ...effective, seed: effective.seed ?? undefined, ...input })
  checkRoom(user, 1024 * 1024)
  const limit = AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)])
  active.add(user.id)
  let promptId: string | null = null
  try {
    const catalog = await imageCatalog(user, limit, s)
    const diffusion = s.preset.startsWith('z_image')
    if (!(diffusion ? catalog.diffusionModels : catalog.checkpoints).includes(s.model) || (diffusion && (!catalog.clips.includes(s.clip) || !catalog.vaes.includes(s.vae) || !catalog.clipTypes.includes('lumina2')))) throw new HttpError(409, 'Selected models are not installed in ComfyUI; refresh Images settings')
    if (Object.values(workflow.graph).some((n) => !catalog.nodes.includes(n.class_type)) || !catalog.samplers.includes('euler') || !catalog.schedulers.includes('simple')) throw new HttpError(409, 'ComfyUI is missing nodes or sampler options required by this preset')
    const submitted = await readJSON(user, s, '/prompt', limit, { prompt: workflow.graph, client_id: randomUUID() })
    if (typeof submitted.prompt_id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(submitted.prompt_id)) throw new HttpError(502, 'ComfyUI did not return a prompt ID')
    promptId = submitted.prompt_id
    for (;;) {
      limit.throwIfAborted()
      const history = await readJSON(user, s, `/history/${encodeURIComponent(promptId)}`, limit)
      const job = history[promptId]
      if (job?.status?.status_str === 'error') throw new HttpError(502, 'ComfyUI generation failed; check its model compatibility and available memory')
      const output = job?.outputs?.['9']?.images?.[0]
      if (output) {
        if (output.type !== 'output' || typeof output.filename !== 'string' || typeof output.subfolder !== 'string') throw new HttpError(502, 'ComfyUI returned an invalid image reference')
        const params = new URLSearchParams({ filename: output.filename, subfolder: output.subfolder, type: 'output' })
        const bytes = await readCapped(await request(user, s, `/view?${params}`, limit), 20 * 1024 * 1024)
        // SaveImage writes PNG. Reject arbitrary content from an incorrectly configured server.
        if (!bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new HttpError(502, 'ComfyUI did not return a PNG image')
        limit.throwIfAborted()
        const id = randomUUID(), name = `generated-${id}.png`
        checkRoom(user, bytes.length)
        database().prepare('INSERT INTO agent_images (id, thread_id, name, body, created_at) VALUES (?, ?, ?, ?, ?)').run(id, thread, name, bytes, Date.now())
        return { image: { id, name, url: `/api/agents/images/${id}`, size: bytes.length, width: workflow.width, height: workflow.height, seed: workflow.seed, preset: s.preset }, message: 'Image saved privately to this thread. Show its link to the user.' }
      }
      if (job?.status?.completed) throw new HttpError(502, 'ComfyUI finished without an image')
      await delay(1000, undefined, { signal: limit })
    }
  } catch (error) {
    // Delete only our queued prompt. Never use /interrupt: it can stop another client's GPU job.
    if (promptId) await request(user, s, '/queue', AbortSignal.timeout(3000), { delete: [promptId] }).then((r) => r.body?.cancel()).catch(() => {})
    if (limit.aborted) throw new HttpError(signal.aborted ? 499 : 504, signal.aborted ? 'Image generation cancelled. An already running ComfyUI job may finish, but its output will not be saved here.' : 'Image generation timed out after 10 minutes')
    throw error
  } finally { active.delete(user.id) }
}

export async function handleImageApi(req: IncomingMessage, res: ServerResponse, url: URL, method: string, user: User): Promise<boolean> {
  const session = /^\/api\/agents\/images\/threads\/([0-9a-f-]{36})$/.exec(url.pathname)
  if (session) {
    if (method === 'GET') return json(res, 200, threadImageSettings(user, session[1])), true
    if (method === 'PUT') return json(res, 200, await saveThreadImageSettings(user, session[1], await readJson(req, 16 * 1024))), true
    if (method === 'DELETE') return json(res, 200, await saveThreadImageSettings(user, session[1], {})), true
  }
  if (url.pathname === '/api/agents/images/settings') {
    if (method === 'GET') return json(res, 200, view(imageSettings(user))), true
    if (method === 'PUT') return json(res, 200, saveImageSettings(user, await readJson(req, 16 * 1024))), true
    if (method === 'DELETE') {
      database().prepare('DELETE FROM integrations WHERE user_id = ? AND name = ?').run(user.id, NAME)
      return json(res, 200, view(defaults())), true
    }
  }
  if (url.pathname === '/api/agents/images/catalog' && method === 'GET') return json(res, 200, await imageCatalog(user)), true
  const image = /^\/api\/agents\/images\/([0-9a-f-]{36})$/.exec(url.pathname)
  if (image && (method === 'GET' || method === 'HEAD')) {
    const row = database().prepare('SELECT i.body, i.name FROM agent_images i JOIN agent_threads t ON t.id = i.thread_id WHERE i.id = ? AND t.user_id = ?').get(image[1], user.id) as { body: Uint8Array; name: string } | undefined
    if (!row) throw new HttpError(404, 'No such image')
    res.writeHead(200, { ...SECURITY, ...UNTRUSTED, 'Content-Type': 'image/png', 'Content-Length': row.body.length, 'Content-Disposition': `inline; filename="${row.name}"`, 'Cache-Control': 'private, no-store' }).end(method === 'HEAD' ? undefined : row.body)
    return true
  }
  return false
}
