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
export async function imageCatalog(user: User, signal = AbortSignal.timeout(30_000), s = imageSettings(user)) {
  const info = await readJSON(user, s, '/object_info', signal) as NodeInfo
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
  const s = imageSettings(user), workflow = imageWorkflow(s, input)
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
