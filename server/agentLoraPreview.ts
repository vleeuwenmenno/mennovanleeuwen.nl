import type { IncomingMessage, ServerResponse } from 'node:http'
import type { User } from './auth.ts'
import { imageBackendScope, imageCatalog, imageSettings } from './agentImages.ts'
import { guardedFetch, readCapped } from './egress.ts'
import { HttpError, json, SECURITY, UNTRUSTED } from './http.ts'

// The composer's # picker: each installed LoRA with what LoRA Manager knows about it (title, base
// model, trigger words, tags, folder, size) and its own preview picture, served through this
// server from the account's configured ComfyUI, never from a URL the browser or the model gives.
// The list is ComfyUI's own installed LoRAs (imageCatalog), so nothing shows that would fail to
// generate; LoRA Manager only adds facts to the ones it can match exactly by folder and file.
// Without LoRA Manager every LoRA still shows, with the facts its name gives.

export type LoraDetail = { name: string; title: string; baseModel: string; triggers: string[]; tags: string[]; folder: string; size: number | null; hasPreview: boolean }

/** LoRA Manager's first page: the bound on how many LoRAs get facts and previews. */
const MANAGER_PAGE = 50
/** Names shown at all, as the existing installed list does. */
const INSTALLED_LIMIT = 2000
const PREVIEW_MAX = 384 * 1024
const PREVIEW_TIMEOUT = 5000
const PATHS_TTL = 30 * 60_000
const BYTES_TTL = 10 * 60_000
/** All cached previews together, every account. */
const CACHE_MAX = 8 * 1024 * 1024
const ACCOUNTS_MAX = 256

const normalized = (v: string) => v.replaceAll('\\', '/')
const leaf = (v: string) => normalized(v).split('/').pop() ?? v
const stem = (v: string) => leaf(v).replace(/\.[^.]+$/, '')
const short = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\x00-\x1f]/g, ' ').trim().slice(0, max) : '')
const words = (v: unknown, count: number, max: number) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim() && x.length <= max && !/[\x00-\x1f]/.test(x)).slice(0, count) : [])

/** What a name alone says: its file name as the title and its folder. */
const fromName = (name: string): LoraDetail => ({ name, title: stem(name).slice(0, 120), baseModel: '', triggers: [], tags: [], folder: normalized(name).split('/').slice(0, -1).join('/').slice(0, 200), size: null, hasPreview: false })

/**
 * The preview LoRA Manager names for this exact file: its own `/api/lm/previews?path=` beside the
 * model file (same folder, same stem), on the same backend. Anything else is ignored.
 */
export function sidecarPreview(previewUrl: unknown, filePath: string, backend: string): string | null {
  if (typeof previewUrl !== 'string' || previewUrl.length > 4096) return null
  let url: URL
  try { url = new URL(previewUrl, backend) } catch { return null }
  if (url.origin !== new URL(backend).origin || url.pathname !== '/api/lm/previews' || [...url.searchParams.keys()].some((k) => k !== 'path')) return null
  const path = url.searchParams.get('path') ?? ''
  const file = normalized(filePath), dir = file.slice(0, file.lastIndexOf('/') + 1), at = normalized(path)
  if (!dir || /[\x00-\x1f]/.test(path) || at.split('/').includes('..') || !at.startsWith(dir)) return null
  const s = stem(file), name = at.slice(dir.length)
  return [`${s}.png`, `${s}.jpg`, `${s}.jpeg`, `${s}.webp`, `${s}.preview.png`, `${s}.preview.jpg`, `${s}.preview.jpeg`, `${s}.preview.webp`].includes(name) ? `/api/lm/previews?path=${encodeURIComponent(path)}` : null
}

/** One LoRA Manager item joined to the installed name it is, exactly (folder + file), or null. */
export function managerDetail(item: unknown, installed: ReadonlyMap<string, string>, backend: string): { detail: LoraDetail; preview: string | null } | null {
  if (!item || typeof item !== 'object') return null
  const i = item as Record<string, any>
  if (typeof i.folder !== 'string' || typeof i.file_path !== 'string') return null
  const name = installed.get([normalized(i.folder), leaf(i.file_path)].filter(Boolean).join('/'))
  if (!name) return null
  const preview = sidecarPreview(i.preview_url, i.file_path, backend)
  const size = Number.isSafeInteger(i.file_size) && i.file_size >= 0 ? i.file_size : null
  return {
    detail: { name, title: short(i.model_name, 120) || stem(name).slice(0, 120), baseModel: short(i.base_model, 80) || short(i.civitai?.baseModel, 80), triggers: words(i.civitai?.trainedWords, 8, 120), tags: words(i.tags, 12, 40), folder: short(normalized(i.folder), 200), size, hasPreview: !!preview },
    preview,
  }
}

// Where each account's previews are on its backend (from its last list), and the bytes fetched.
const paths = new Map<number, { scope: string; expires: number; byName: Map<string, string> }>()
const bytes = new Map<string, { mime: string; body: Buffer; expires: number }>()
let cached = 0
const drop = (key: string) => { const hit = bytes.get(key); if (hit) { cached -= hit.body.length; bytes.delete(key) } }
function keep(key: string, value: { mime: string; body: Buffer; expires: number }) {
  drop(key)
  const now = Date.now()
  for (const [k, v] of bytes) if (v.expires < now) drop(k)
  // Oldest first (a Map keeps insertion order) until the new one fits.
  for (const k of bytes.keys()) { if (cached + value.body.length <= CACHE_MAX) break; drop(k) }
  bytes.set(key, value)
  cached += value.body.length
}
export const previewCacheBytes = () => cached

export async function loraDetails(user: User): Promise<{ loras: LoraDetail[]; total: number; truncated: boolean; manager: boolean }> {
  const catalog = await imageCatalog(user)
  const names = catalog.loras.slice(0, INSTALLED_LIMIT)
  const installed = new Map(names.map((n) => [normalized(n), n]))
  const s = imageSettings(user)
  const found = new Map<string, { detail: LoraDetail; preview: string | null }>()
  const duplicate = new Set<string>()
  let manager = false
  try {
    const res = await guardedFetch(user, `${s.url}/api/lm/loras/list?page=1&page_size=${MANAGER_PAGE}`, { redirect: 'manual', headers: s.token ? { Authorization: `Bearer ${s.token}` } : {}, signal: AbortSignal.timeout(3000) })
    if (res.ok) {
      const data = JSON.parse((await readCapped(res, 1024 * 1024)).toString()) as { items?: unknown }
      if (Array.isArray(data.items)) {
        manager = true
        for (const item of data.items.slice(0, MANAGER_PAGE)) {
          const hit = managerDetail(item, installed, s.url)
          if (!hit) continue
          if (found.has(hit.detail.name)) duplicate.add(hit.detail.name)
          found.set(hit.detail.name, hit)
        }
      }
    } else await res.body?.cancel().catch(() => {})
  } catch { /* LoRA Manager is optional: the names alone still list */ }
  for (const name of duplicate) found.delete(name)
  // Remember only this backend's preview paths, for this account, for a while.
  paths.delete(user.id)
  while (paths.size >= ACCOUNTS_MAX) paths.delete(paths.keys().next().value!)
  paths.set(user.id, { scope: imageBackendScope(user, s), expires: Date.now() + PATHS_TTL, byName: new Map([...found].flatMap(([n, h]) => (h.preview ? [[n, h.preview] as const] : []))) })
  return { loras: names.map((n) => found.get(n)?.detail ?? fromName(n)), total: catalog.loras.length, truncated: catalog.loras.length > names.length, manager }
}

const signature = (b: Buffer) => (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png' : b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff ? 'image/jpeg' : b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : null)

/** A LoRA's preview bytes, for its owner only: from the cache, else from their backend. */
export async function loraPreview(user: User, name: string): Promise<{ mime: string; body: Buffer }> {
  const s = imageSettings(user), scope = imageBackendScope(user, s)
  const known = paths.get(user.id)
  const path = known && known.expires > Date.now() && known.scope === scope ? known.byName.get(name) : undefined
  if (!path) throw new HttpError(404, 'No preview for that LoRA')
  const key = `${user.id}:${scope}:${name}`
  const hit = bytes.get(key)
  if (hit && hit.expires > Date.now()) return hit
  const res = await guardedFetch(user, `${s.url}${path}`, { redirect: 'manual', headers: s.token ? { Authorization: `Bearer ${s.token}` } : {}, signal: AbortSignal.timeout(PREVIEW_TIMEOUT) }).catch(() => {
    throw new HttpError(404, 'The preview could not be fetched')
  })
  const declared = res.headers.get('content-type')?.split(';')[0].trim()
  if (!res.ok || !['image/png', 'image/jpeg', 'image/webp'].includes(declared ?? '')) {
    await res.body?.cancel().catch(() => {})
    throw new HttpError(res.ok ? 415 : 404, res.ok ? 'The preview is not a picture' : 'No preview for that LoRA')
  }
  const body = await readCapped(res, PREVIEW_MAX).catch((e: unknown) => { throw e instanceof HttpError && e.status === 413 ? new HttpError(413, 'The preview is too big') : new HttpError(404, 'The preview could not be fetched') })
  // The header can be wrong (a WebP labelled JPEG): serve what the bytes are, or nothing.
  const mime = signature(body)
  if (!mime) throw new HttpError(415, 'The preview is not a picture')
  const value = { mime, body, expires: Date.now() + BYTES_TTL }
  keep(key, value)
  return value
}

export async function handleLoraPreviewApi(req: IncomingMessage, res: ServerResponse, url: URL, user: User): Promise<boolean> {
  if (req.method !== 'GET') return false
  if (url.pathname === '/api/agents/images/lora-details') return json(res, 200, await loraDetails(user)), true
  if (url.pathname === '/api/agents/images/lora-preview') {
    const name = url.searchParams.get('name') ?? ''
    if (!name || name.length > 2048) throw new HttpError(400, 'Name a LoRA')
    const { mime, body } = await loraPreview(user, name)
    res.writeHead(200, { ...SECURITY, ...UNTRUSTED, 'Content-Type': mime, 'Content-Length': body.length, 'Cache-Control': 'private, max-age=300' }).end(body)
    return true
  }
  return false
}
