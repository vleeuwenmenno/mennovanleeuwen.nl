import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { User } from './auth.ts'
import { database, decrypt, encrypt, onUserGone } from './db.ts'
import { EgressError, guardedFetch, readCapped, rethrowEgress } from './egress.ts'
import { HttpError, json, readJson } from './http.ts'
import { privateRequestAuthority, withProviderLifetime } from './privateRequest.ts'
import { chatCompletionsStats, meter, type CallStats } from './agentStats.ts'
import type { Effort, ProviderModel } from './agentChatGPT.ts'

// Custom OpenAI-compatible API endpoints (Strata API over NetBird, vLLM, llama.cpp, LM Studio,
// LiteLLM, OpenRouter, etc.) as a chat provider for the Agents app. Up to 8 endpoints per account,
// stored encrypted in SQLite under integrations.name = 'agents-custom-openai'. Every outbound
// request goes through guardedFetch (so admins may reach LAN/NetBird/private addresses while
// non-admins are limited to public addresses).

const INTEGRATION = 'agents-custom-openai'
const MAX_ENDPOINTS = 8
const MAX_MANUAL_MODELS = 32
const ENDPOINT_ID = /^e[0-9a-f]{8}$/
const MODEL_ID = /^[\w.:/@+-]{1,140}$/
const FULL_MODEL = /^custom\/(e[0-9a-f]{8})\/(.+)$/
const MODELS_OK_TTL = 5 * 60_000
const MODELS_ERR_TTL = 30_000
const MAX_MODELS_BYTES = 2 * 1024 * 1024
const MAX_JSON_CHAT_BYTES = 16 * 1024 * 1024

type StoredEndpoint = {
  id: string
  name: string
  url: string
  apiKey: string
  manualModels: string[]
}

export type CustomEndpointView = {
  id: string
  name: string
  url: string
  hasKey: boolean
  manualModels: string[]
}

type ToolCall = { name: string; arguments: Record<string, unknown> }
type ChatMessage = { role: string; content: string; thinking?: string; tool_calls?: { function: ToolCall }[]; tool_name?: string; images?: string[] }
type ToolDef = { type: 'function'; function: { name: string; description: string; parameters: unknown } }
type Reply = { content: string; thinking: string; calls: ToolCall[]; used: number | null; stats?: CallStats }

// --- storage & credential versioning --------------------------------------------------------------

function readStored(user: Pick<User, 'id'>): StoredEndpoint[] {
  const row = database().prepare('SELECT secret FROM integrations WHERE user_id = ? AND name = ?').get(user.id, INTEGRATION) as { secret: string } | undefined
  if (!row) return []
  try {
    const parsed = JSON.parse(decrypt(row.secret)) as { endpoints?: unknown }
    if (!Array.isArray(parsed?.endpoints)) return []
    return parsed.endpoints
      .filter((e): e is StoredEndpoint => !!e && typeof e === 'object' && typeof (e as StoredEndpoint).id === 'string' && ENDPOINT_ID.test((e as StoredEndpoint).id) && typeof (e as StoredEndpoint).name === 'string' && typeof (e as StoredEndpoint).url === 'string')
      .map((e) => ({
        id: e.id,
        name: e.name,
        url: e.url,
        apiKey: typeof e.apiKey === 'string' ? e.apiKey : '',
        manualModels: Array.isArray(e.manualModels) ? e.manualModels.filter((m): m is string => typeof m === 'string' && MODEL_ID.test(m)).slice(0, MAX_MANUAL_MODELS) : [],
      }))
      .slice(0, MAX_ENDPOINTS)
  } catch {
    return []
  }
}

function writeStored(user: User, endpoints: StoredEndpoint[]) {
  if (!endpoints.length) {
    database().prepare('DELETE FROM integrations WHERE user_id = ? AND name = ?').run(user.id, INTEGRATION)
  } else {
    database()
      .prepare('INSERT INTO integrations (user_id, name, secret, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, name) DO UPDATE SET secret = excluded.secret')
      .run(user.id, INTEGRATION, encrypt(JSON.stringify({ endpoints })), Date.now())
  }
  invalidate(user.id)
}

const toView = (e: StoredEndpoint): CustomEndpointView => ({
  id: e.id,
  name: e.name,
  url: e.url,
  hasKey: !!e.apiKey,
  manualModels: e.manualModels,
})

const configVersion = new Map<number, number>()
const configChanged = new Set<(id: number) => void>()
const versionOf = (userId: number) => configVersion.get(userId) ?? 0
function onConfigChanged(fn: (id: number) => void) {
  configChanged.add(fn)
  return () => {
    configChanged.delete(fn)
  }
}

type CacheEntry = { at: number; ttl: number; pending: boolean; authority: object | undefined; value: Promise<ProviderModel[]> }
const modelCache = new Map<string, CacheEntry>()

function clearUserCache(userId: number) {
  const prefix = `${userId}:`
  for (const k of modelCache.keys()) if (k.startsWith(prefix)) modelCache.delete(k)
}

function invalidate(userId: number) {
  configVersion.set(userId, versionOf(userId) + 1)
  clearUserCache(userId)
  for (const fn of configChanged) fn(userId)
}

onUserGone((id) => invalidate(id))

function assertConfigVersion(user: User, version: number) {
  if (versionOf(user.id) !== version || !database().prepare('SELECT 1 FROM users WHERE id=? AND banned_at IS NULL').get(user.id)) {
    throw new HttpError(409, 'The OpenAI-compatible API settings changed while this was running: try again')
  }
}

export function listCustomOpenAI(user: User): CustomEndpointView[] {
  return readStored(user).map(toView)
}

export function customOpenAICount(user: User): number {
  return readStored(user).length
}

/** Parses `custom/<endpointId>/<modelId>`, or null when the string is not one. */
export function parseCustomModel(model: string): { endpointId: string; modelId: string } | null {
  const m = FULL_MODEL.exec(model)
  return m ? { endpointId: m[1], modelId: m[2] } : null
}

/** Whether the specific endpoint named by `custom/<endpointId>/<modelId>` is configured for this account. */
export function customOpenAIReady(user: User, model: string): boolean {
  const parsed = parseCustomModel(model)
  if (!parsed) return false
  return readStored(user).some((e) => e.id === parsed.endpointId)
}

// --- validation & URL normalization ---------------------------------------------------------------

function cleanName(v: unknown): string {
  const name = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : ''
  if (!name || name.length > 60) throw new HttpError(400, 'Give the endpoint a name (1 to 60 characters)')
  return name
}

function cleanUrl(v: unknown): string {
  const raw = typeof v === 'string' ? v.trim() : ''
  if (!raw || raw.length > 500) throw new HttpError(400, 'Enter the endpoint URL (starting with http:// or https://)')
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new HttpError(400, 'That is not a valid URL')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new HttpError(400, 'Only http:// and https:// URLs are supported')
  if (u.username || u.password) throw new HttpError(400, 'Do not put credentials in the URL; use the API key field instead')
  if (u.search || u.hash) throw new HttpError(400, 'Remove query parameters and fragments from the endpoint URL')
  let pathname = u.pathname.replace(/\/+$/, '')
  pathname = pathname.replace(/\/(?:chat\/completions|responses|models)$/i, '').replace(/\/+$/, '')
  return `${u.origin}${pathname}`
}

function cleanApiKey(v: unknown): string {
  if (v === undefined || v === null) return ''
  if (typeof v !== 'string') throw new HttpError(400, 'Bad API key')
  const key = v.trim()
  if (key.length > 1000 || /[\r\n]/.test(key)) throw new HttpError(400, 'API key is invalid')
  return key
}

function cleanManualModels(v: unknown): string[] {
  if (v === undefined || v === null) return []
  const list = typeof v === 'string' ? v.split(/[\n,]/) : Array.isArray(v) ? v : null
  if (!list) throw new HttpError(400, 'Manual models must be a list of model IDs')
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of list) {
    if (typeof item !== 'string') continue
    const id = item.trim()
    if (!id) continue
    if (!MODEL_ID.test(id)) throw new HttpError(400, `Invalid model ID "${id.slice(0, 60)}"`)
    if (!seen.has(id)) {
      seen.add(id)
      out.push(id)
    }
    if (out.length > MAX_MANUAL_MODELS) throw new HttpError(400, `At most ${MAX_MANUAL_MODELS} manual models per endpoint`)
  }
  return out
}

// --- model discovery & probing --------------------------------------------------------------------

const VISION_RE = /(?:^|[\s/_-])(?:vl|vision|llava|pixtral)|gemma-?[34]|gpt-4o|gpt-4\.1|gpt-5|claude-[34]|gemini|kimi-k2\.5|kimi-k3/i
const THINKING_RE = /reasoning|(?:^|[\s/_-])r1(?:\b|[_-])|qwq|deepseek-r|thinking|(?:^|[\s/_-])o[134](?:-|$)/i

type RawModel = {
  id?: unknown
  name?: unknown
  display_name?: unknown
  context_length?: unknown
  max_model_len?: unknown
  context_window?: unknown
  max_context_length?: unknown
  multimodal?: unknown
  input_modalities?: unknown
  capabilities?: { vision?: unknown; thinking?: unknown; reasoning?: unknown }
  architecture?: { modality?: unknown; input_modalities?: unknown }
  top_provider?: { context_length?: unknown }
}

function positiveInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : null
}

function toProviderModel(endpoint: Pick<StoredEndpoint, 'id' | 'name'>, modelId: string, raw?: RawModel): ProviderModel {
  const display =
    (typeof raw?.display_name === 'string' && raw.display_name.trim() && raw.display_name.trim() !== modelId ? raw.display_name.trim().slice(0, 60) : undefined) ??
    (typeof raw?.name === 'string' && raw.name.trim() && raw.name.trim() !== modelId ? raw.name.trim().slice(0, 60) : undefined)
  const contextLength =
    positiveInt(raw?.context_length) ??
    positiveInt(raw?.max_model_len) ??
    positiveInt(raw?.context_window) ??
    positiveInt(raw?.max_context_length) ??
    positiveInt(raw?.top_provider?.context_length) ??
    null
  const vision =
    raw?.capabilities?.vision === true ||
    (Array.isArray(raw?.input_modalities) && raw.input_modalities.includes('image')) ||
    (Array.isArray(raw?.architecture?.input_modalities) && raw.architecture.input_modalities.includes('image')) ||
    (typeof raw?.architecture?.modality === 'string' && raw.architecture.modality.toLowerCase().includes('image')) ||
    raw?.multimodal === true ||
    VISION_RE.test(modelId)
  const thinking = raw?.capabilities?.thinking === true || raw?.capabilities?.reasoning === true || THINKING_RE.test(modelId)
  return {
    name: `custom/${endpoint.id}/${modelId}`,
    ...(display ? { label: display } : {}),
    thinking,
    vision,
    contextLength,
    provider: 'custom',
    providerLabel: endpoint.name,
  }
}

function parseModelsBody(endpoint: Pick<StoredEndpoint, 'id' | 'name'>, body: unknown, manualModels: string[]): ProviderModel[] {
  const obj = body && typeof body === 'object' ? (body as { data?: unknown; models?: unknown }) : null
  const rawList = Array.isArray(obj?.data) ? obj.data : Array.isArray(obj?.models) ? obj.models : []
  const byId = new Map<string, ProviderModel>()
  for (const item of rawList) {
    if (typeof item === 'string') {
      const id = item.trim()
      if (MODEL_ID.test(id) && !byId.has(id)) byId.set(id, toProviderModel(endpoint, id))
      continue
    }
    if (!item || typeof item !== 'object') continue
    const raw = item as RawModel
    const id = typeof raw.id === 'string' ? raw.id.trim() : typeof raw.name === 'string' ? raw.name.trim() : ''
    if (!MODEL_ID.test(id) || byId.has(id)) continue
    byId.set(id, toProviderModel(endpoint, id, raw))
  }
  for (const id of manualModels) {
    if (!byId.has(id)) byId.set(id, toProviderModel(endpoint, id))
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name))
}

async function fetchModelsOnce(user: User, url: string, apiKey: string, timeoutMs: number): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  try {
    return await guardedFetch(user, `${url}/models`, { method: 'GET', headers, signal: AbortSignal.timeout(timeoutMs) })
  } catch (e) {
    rethrowEgress(e)
    throw new HttpError(502, 'Could not reach the endpoint')
  }
}

async function readModelsJson(res: Response): Promise<unknown> {
  const buf = await readCapped(res, MAX_MODELS_BYTES)
  try {
    return JSON.parse(buf.toString('utf8')) as unknown
  } catch {
    throw new HttpError(502, 'The endpoint did not return valid JSON from /models')
  }
}

/**
 * Probes an endpoint on save/test. When the URL has no path (`/`), tries `/v1/models` first and
 * falls back to `/models` on 404/405, storing `/v1` when `/v1/models` succeeded.
 */
async function probeEndpoint(
  user: User,
  endpoint: { id: string; name: string; url: string; apiKey: string; manualModels: string[] },
): Promise<{ url: string; models: ProviderModel[] }> {
  const parsed = new URL(endpoint.url)
  const bare = parsed.pathname === '/' || parsed.pathname === ''
  const candidates = bare ? [`${endpoint.url}/v1`, endpoint.url] : [endpoint.url]
  let lastStatus = 0
  for (let i = 0; i < candidates.length; i++) {
    const base = candidates[i]
    const res = await fetchModelsOnce(user, base, endpoint.apiKey, 8_000)
    if (res.ok) {
      const body = await readModelsJson(res)
      const list = parseModelsBody(endpoint, body, endpoint.manualModels)
      if (!list.length) throw new HttpError(400, 'The endpoint returned no models: add model IDs manually if it does not list them')
      return { url: base, models: list }
    }
    await res.body?.cancel().catch(() => {})
    lastStatus = res.status
    if (res.status === 401 || res.status === 403) throw new HttpError(400, 'The endpoint refused that API key')
    if (res.status === 404 || res.status === 405) {
      if (i + 1 < candidates.length) continue
      if (endpoint.manualModels.length) {
        return { url: endpoint.url, models: endpoint.manualModels.map((id) => toProviderModel(endpoint, id)) }
      }
      throw new HttpError(400, `The endpoint answered ${res.status} for /models: add model IDs manually or check the URL`)
    }
    throw new HttpError(502, `The endpoint answered ${res.status} for /models`)
  }
  throw new HttpError(502, `The endpoint answered ${lastStatus || 'an error'} for /models`)
}

/** Discovers models from every configured custom endpoint in parallel. Offline endpoints never throw. */
export async function customOpenAIModels(user: User): Promise<ProviderModel[]> {
  const endpoints = readStored(user)
  if (!endpoints.length) return []
  const version = versionOf(user.id)
  const lists = await Promise.all(
    endpoints.map((ep) => {
      const key = `${user.id}:${ep.id}`
      const hit = modelCache.get(key)
      if (hit && Date.now() - hit.at < hit.ttl && (!hit.pending || hit.authority === privateRequestAuthority())) return hit.value
      const fallback = ep.manualModels.map((id) => toProviderModel(ep, id))
      const entry: CacheEntry = {
        at: Date.now(),
        ttl: MODELS_OK_TTL,
        pending: true,
        authority: privateRequestAuthority(),
        value: Promise.resolve(fallback),
      }
      entry.value = (async () => {
        try {
          const res = await fetchModelsOnce(user, ep.url, ep.apiKey, 5_000)
          if (!res.ok) {
            await res.body?.cancel().catch(() => {})
            entry.ttl = MODELS_ERR_TTL
            return fallback
          }
          const body = await readModelsJson(res)
          if (versionOf(user.id) !== version) return []
          return parseModelsBody(ep, body, ep.manualModels)
        } catch {
          entry.ttl = MODELS_ERR_TTL
          return fallback
        } finally {
          entry.pending = false
        }
      })()
      modelCache.set(key, entry)
      return entry.value
    }),
  )
  return lists.flat()
}

// --- Chat Completions API -------------------------------------------------------------------------

function dataUrl(b64: string): string {
  const mime = b64.startsWith('iVBOR') ? 'image/png' : b64.startsWith('/9j/') ? 'image/jpeg' : b64.startsWith('R0lG') ? 'image/gif' : b64.startsWith('UklGR') ? 'image/webp' : 'image/png'
  return `data:${mime};base64,${b64}`
}

/**
 * Translates MvL OS's Ollama-style messages into OpenAI Chat Completions format:
 * - Assistant tool_calls get stable IDs (`call_<i>_<j>`) paired with subsequent tool results
 *   (matching by `tool_name` first, then FIFO).
 * - Orphan tool results become user notes.
 * - Unclosed tool calls receive a synthetic cut-short error result before the next non-tool message
 *   or at the end of the conversation.
 */
export function chatCompletionsMessages(messages: ChatMessage[]): unknown[] {
  const out: unknown[] = []
  let open: { id: string; name: string }[] = []
  const flushOpen = () => {
    for (const c of open) out.push({ role: 'tool', tool_call_id: c.id, content: '{"error":"No result: the turn was cut short"}' })
    open = []
  }
  messages.forEach((m, i) => {
    if (m.role === 'tool') {
      const named = open.findIndex((c) => c.name === m.tool_name)
      const at = named >= 0 ? named : 0
      const call = open[at]
      if (!call) {
        out.push({ role: 'user', content: `(A tool result for ${m.tool_name || 'a tool'}, from earlier.)\n${m.content}` })
        return
      }
      open = open.filter((_, j) => j !== at)
      out.push({ role: 'tool', tool_call_id: call.id, content: m.content })
      return
    }
    flushOpen()
    if (m.role === 'system') {
      out.push({ role: 'system', content: m.content })
      return
    }
    if (m.role === 'assistant') {
      if (m.tool_calls?.length) {
        const tool_calls = m.tool_calls.map((c, j) => {
          const id = `call_${i}_${j}`
          open.push({ id, name: c.function.name })
          return { id, type: 'function', function: { name: c.function.name, arguments: JSON.stringify(c.function.arguments ?? {}) } }
        })
        out.push({ role: 'assistant', content: m.content || null, tool_calls })
      } else {
        out.push({ role: 'assistant', content: m.content })
      }
      return
    }
    if (m.images?.length) {
      const parts: unknown[] = [{ type: 'text', text: m.content || ' ' }]
      for (const img of m.images) parts.push({ type: 'image_url', image_url: { url: dataUrl(img) } })
      out.push({ role: 'user', content: parts })
    } else {
      out.push({ role: 'user', content: m.content || ' ' })
    }
  })
  flushOpen()
  return out
}

const CONTEXT_ERR = /context_length|context window|too long|maximum context|exceeds the available context|n_ctx/i

function parseErrorText(text: string): { message: string; code: string } {
  let message = ''
  let code = ''
  try {
    const body = JSON.parse(text) as { error?: { message?: string; code?: string; type?: string } | string; detail?: string | { message?: string } }
    message = typeof body.error === 'string' ? body.error : body.error?.message || (typeof body.detail === 'string' ? body.detail : body.detail?.message) || ''
    code = typeof body.error === 'object' ? body.error?.code || body.error?.type || '' : ''
  } catch {
    message = text.slice(0, 200)
  }
  return { message: message.replace(/\s+/g, ' ').trim().slice(0, 300), code }
}

function mapFailure(status: number, text: string, who: string): HttpError {
  const { message, code } = parseErrorText(text)
  if (CONTEXT_ERR.test(`${code} ${message}`)) return new HttpError(502, `${who}: the conversation is too long for the model's context window${message ? ` (${message})` : ''}`)
  if (status === 429) return new HttpError(429, message ? `${who}: ${message}` : `${who} says the usage limit is reached for now`)
  if (status === 401 || status === 403) return new HttpError(409, `${who} refused the request${message ? `: ${message}` : ''}`)
  return new HttpError(502, message ? `${who}: ${message}` : `${who} answered ${status}`)
}

type ChatUsage = {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}

type StreamChunk = {
  error?: { message?: string; code?: string } | string
  usage?: ChatUsage
  choices?: {
    delta?: {
      content?: string | null
      reasoning_content?: string | null
      reasoning?: string | null
      tool_calls?: { index?: number; function?: { name?: string; arguments?: string } }[]
    }
    message?: {
      content?: string | null
      reasoning_content?: string | null
      reasoning?: string | null
      tool_calls?: { function?: { name?: string; arguments?: string | Record<string, unknown> } }[]
    }
  }[]
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw !== 'string' || !raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

async function readJsonReply(res: Response, who: string, onDelta: (d: { content?: string; thinking?: string }) => void, timer: ReturnType<typeof meter>, model: string): Promise<Reply> {
  const buf = await readCapped(res, MAX_JSON_CHAT_BYTES)
  let body: StreamChunk
  try {
    body = JSON.parse(buf.toString('utf8')) as StreamChunk
  } catch {
    throw new HttpError(502, `${who} sent an unreadable response`)
  }
  if (body.error) {
    const { message, code } = parseErrorText(JSON.stringify({ error: body.error }))
    if (CONTEXT_ERR.test(`${code} ${message}`)) throw new HttpError(502, `${who}: the conversation is too long for the model's context window${message ? ` (${message})` : ''}`)
    throw new HttpError(502, `${who}: ${message || 'the reply failed'}`)
  }
  const msg = body.choices?.[0]?.message
  const thinking = typeof msg?.reasoning_content === 'string' ? msg.reasoning_content : typeof msg?.reasoning === 'string' ? msg.reasoning : ''
  const content = typeof msg?.content === 'string' ? msg.content : ''
  if (thinking) {
    timer.first()
    onDelta({ thinking })
  }
  if (content) {
    timer.first()
    onDelta({ content })
  }
  const calls: ToolCall[] = []
  for (const tc of msg?.tool_calls ?? []) {
    const name = tc?.function?.name
    if (typeof name === 'string' && name) {
      timer.first()
      calls.push({ name, arguments: parseArgs(tc.function?.arguments) })
    }
  }
  const u = body.usage ?? null
  const used = u ? (u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0)) : null
  return { content, thinking, calls, used, stats: chatCompletionsStats('custom', model, u, timer.end()) }
}

async function readStreamReply(res: Response, who: string, onDelta: (d: { content?: string; thinking?: string }) => void, timer: ReturnType<typeof meter>, model: string): Promise<Reply> {
  let content = ''
  let thinking = ''
  let usage: ChatUsage | null = null
  const toolAcc = new Map<number, { name: string; args: string }>()

  const handleChunk = (chunk: StreamChunk) => {
    if (chunk.error) {
      const { message, code } = parseErrorText(JSON.stringify({ error: chunk.error }))
      if (CONTEXT_ERR.test(`${code} ${message}`)) throw new HttpError(502, `${who}: the conversation is too long for the model's context window${message ? ` (${message})` : ''}`)
      throw new HttpError(502, `${who}: ${message || 'the reply failed'}`)
    }
    if (chunk.usage) usage = chunk.usage
    const delta = chunk.choices?.[0]?.delta
    if (!delta) return
    const reasoning = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : typeof delta.reasoning === 'string' ? delta.reasoning : ''
    if (reasoning) {
      timer.first()
      thinking += reasoning
      onDelta({ thinking: reasoning })
    }
    if (typeof delta.content === 'string' && delta.content) {
      timer.first()
      content += delta.content
      onDelta({ content: delta.content })
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        timer.first()
        const idx = typeof tc.index === 'number' && Number.isInteger(tc.index) && tc.index >= 0 ? tc.index : toolAcc.size
        const entry = toolAcc.get(idx) ?? { name: '', args: '' }
        if (typeof tc.function?.name === 'string' && tc.function.name) entry.name += tc.function.name
        if (typeof tc.function?.arguments === 'string' && tc.function.arguments) entry.args += tc.function.arguments
        toolAcc.set(idx, entry)
      }
    }
  }

  const takeData = (data: string) => {
    const trimmed = data.trim()
    if (!trimmed || trimmed === '[DONE]') return
    try {
      handleChunk(JSON.parse(trimmed) as StreamChunk)
    } catch (e) {
      if (e instanceof HttpError) throw e
    }
  }

  const takeBlock = (raw: string) => {
    const lines = raw
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart())
    if (!lines.length) return
    const joined = lines.join('\n').trim()
    if (!joined || joined === '[DONE]') return
    try {
      handleChunk(JSON.parse(joined) as StreamChunk)
    } catch (e) {
      if (e instanceof HttpError) throw e
      if (lines.length > 1) for (const line of lines) takeData(line)
    }
  }

  if (!res.body) throw new HttpError(502, `${who} sent nothing`)
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const piece of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(piece, { stream: true }).replace(/\r\n/g, '\n')
    let end: number
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      takeBlock(buffer.slice(0, end))
      buffer = buffer.slice(end + 2)
    }
  }
  buffer += decoder.decode().replace(/\r\n/g, '\n')
  if (buffer.trim()) takeBlock(buffer)

  const calls: ToolCall[] = [...toolAcc.entries()]
    .sort(([a], [b]) => a - b)
    .filter(([, e]) => !!e.name)
    .map(([, e]) => ({ name: e.name, arguments: parseArgs(e.args) }))
  const u = usage as ChatUsage | null
  const used = u ? (u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0)) : null
  return { content, thinking, calls, used, stats: chatCompletionsStats('custom', model, u, timer.end()) }
}

/** One streamed Chat Completions turn against a user's configured custom OpenAI-compatible API. */
export async function customOpenAIChat(
  user: User,
  req: { model: string; messages: ChatMessage[]; tools?: ToolDef[]; effort?: Effort | null; session?: string },
  signal: AbortSignal,
  onDelta: (d: { content?: string; thinking?: string }) => void,
): Promise<Reply> {
  const parsed = parseCustomModel(req.model)
  if (!parsed) throw new HttpError(400, 'Bad custom model ID')
  const version = versionOf(user.id)
  return withProviderLifetime(
    () => assertConfigVersion(user, version),
    (end) =>
      onConfigChanged((id) => {
        if (id === user.id) end()
      }),
    async () => {
      assertConfigVersion(user, version)
      const endpoint = readStored(user).find((e) => e.id === parsed.endpointId)
      if (!endpoint) throw new HttpError(409, 'This OpenAI-compatible API is no longer configured: check Settings → Integrations')
      const who = endpoint.name
      const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'text/event-stream, application/json' }
      if (endpoint.apiKey) headers.Authorization = `Bearer ${endpoint.apiKey}`
      const tools = req.tools?.length
        ? {
            tools: req.tools.map((t) => ({ type: 'function', function: { name: t.function.name, description: t.function.description, parameters: t.function.parameters } })),
            tool_choice: 'auto',
          }
        : {}
      const baseBody = {
        model: parsed.modelId,
        messages: chatCompletionsMessages(req.messages),
        stream: true,
        ...tools,
      }
      const send = async (withStreamOptions: boolean) => {
        try {
          return await guardedFetch(user, `${endpoint.url}/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify(withStreamOptions ? { ...baseBody, stream_options: { include_usage: true } } : baseBody),
            signal,
          })
        } catch (e) {
          rethrowEgress(e)
          if (signal.aborted) throw e
          throw new HttpError(502, `${who} did not answer`)
        }
      }

      const timer = meter()
      let res = await send(true)
      if (res.status === 400) {
        const firstText = (await readCapped(res, 64 * 1024).catch(() => Buffer.alloc(0))).toString('utf8')
        const { message, code } = parseErrorText(firstText)
        if (CONTEXT_ERR.test(`${code} ${message}`)) throw mapFailure(400, firstText, who)
        // Some OpenAI-compatible servers reject stream_options with 400: retry once without it.
        res = await send(false)
        if (!res.ok) {
          const retryText = (await readCapped(res, 64 * 1024).catch(() => Buffer.alloc(0))).toString('utf8')
          throw mapFailure(res.status, retryText || firstText, who)
        }
      } else if (!res.ok) {
        const errText = (await readCapped(res, 64 * 1024).catch(() => Buffer.alloc(0))).toString('utf8')
        throw mapFailure(res.status, errText, who)
      }

      const contentType = (res.headers.get('content-type') ?? '').toLowerCase()
      const reply = contentType.includes('application/json')
        ? await readJsonReply(res, who, onDelta, timer, req.model)
        : await readStreamReply(res, who, onDelta, timer, req.model)
      assertConfigVersion(user, version)
      return reply
    },
  )
}

// --- CRUD & HTTP API ------------------------------------------------------------------------------

type EndpointBody = { name?: unknown; url?: unknown; apiKey?: unknown; clearKey?: unknown; manualModels?: unknown }

async function addEndpoint(user: User, body: EndpointBody) {
  const existing = readStored(user)
  if (existing.length >= MAX_ENDPOINTS) throw new HttpError(400, `At most ${MAX_ENDPOINTS} OpenAI-compatible endpoints per account`)
  const name = cleanName(body.name)
  if (existing.some((e) => e.name.toLowerCase() === name.toLowerCase())) throw new HttpError(400, `An endpoint named "${name}" already exists`)
  const url = cleanUrl(body.url)
  const apiKey = cleanApiKey(body.apiKey)
  const manualModels = cleanManualModels(body.manualModels)
  const id = `e${randomBytes(4).toString('hex')}`
  const probed = await probeEndpoint(user, { id, name, url, apiKey, manualModels })
  const created: StoredEndpoint = { id, name, url: probed.url, apiKey, manualModels }
  // Re-read after await in case another request raced.
  const latest = readStored(user)
  if (latest.length >= MAX_ENDPOINTS) throw new HttpError(400, `At most ${MAX_ENDPOINTS} OpenAI-compatible endpoints per account`)
  if (latest.some((e) => e.name.toLowerCase() === name.toLowerCase())) throw new HttpError(400, `An endpoint named "${name}" already exists`)
  const next = [...latest, created]
  writeStored(user, next)
  return { endpoints: next.map(toView), endpoint: toView(created), discovered: probed.models.map((m) => m.name) }
}

async function updateEndpoint(user: User, id: string, body: EndpointBody) {
  const existing = readStored(user)
  const current = existing.find((e) => e.id === id)
  if (!current) throw new HttpError(404, 'No such endpoint')
  const name = body.name !== undefined ? cleanName(body.name) : current.name
  if (existing.some((e) => e.id !== id && e.name.toLowerCase() === name.toLowerCase())) throw new HttpError(400, `An endpoint named "${name}" already exists`)
  const url = body.url !== undefined ? cleanUrl(body.url) : current.url
  const clearKey = body.clearKey === true
  const rawKey = body.apiKey !== undefined ? cleanApiKey(body.apiKey) : ''
  const apiKey = clearKey ? '' : rawKey || current.apiKey
  const manualModels = body.manualModels !== undefined ? cleanManualModels(body.manualModels) : current.manualModels
  const probed = await probeEndpoint(user, { id, name, url, apiKey, manualModels })
  const updated: StoredEndpoint = { id, name, url: probed.url, apiKey, manualModels }
  const latest = readStored(user)
  if (!latest.some((e) => e.id === id)) throw new HttpError(404, 'No such endpoint')
  if (latest.some((e) => e.id !== id && e.name.toLowerCase() === name.toLowerCase())) throw new HttpError(400, `An endpoint named "${name}" already exists`)
  const next = latest.map((e) => (e.id === id ? updated : e))
  writeStored(user, next)
  return { endpoints: next.map(toView), endpoint: toView(updated), discovered: probed.models.map((m) => m.name) }
}

function deleteEndpoint(user: User, id: string) {
  const existing = readStored(user)
  if (!existing.some((e) => e.id === id)) throw new HttpError(404, 'No such endpoint')
  const next = existing.filter((e) => e.id !== id)
  writeStored(user, next)
  return { endpoints: next.map(toView) }
}

async function testEndpoint(user: User, id: string): Promise<{ ok: boolean; models: string[]; error?: string }> {
  const ep = readStored(user).find((e) => e.id === id)
  if (!ep) throw new HttpError(404, 'No such endpoint')
  clearUserCache(user.id)
  try {
    const probed = await probeEndpoint(user, ep)
    return { ok: true, models: probed.models.map((m) => m.name) }
  } catch (e) {
    if (e instanceof EgressError) return { ok: false, models: [], error: e.message }
    return { ok: false, models: [], error: (e as Error).message || 'Could not reach the endpoint' }
  }
}

export async function handleCustomOpenAIApi(req: IncomingMessage, res: ServerResponse, path: string, method: string, user: User): Promise<boolean> {
  const read = method === 'GET' || method === 'HEAD'
  if (path === '/api/agents/custom-openai' && read) return json(res, 200, { endpoints: listCustomOpenAI(user) }), true
  if (path === '/api/agents/custom-openai' && method === 'POST') return json(res, 200, await addEndpoint(user, await readJson<EndpointBody>(req, 16 * 1024))), true
  const one = /^\/api\/agents\/custom-openai\/([^/]+)(\/test)?$/.exec(path)
  if (!one) return false
  const id = decodeURIComponent(one[1])
  if (!ENDPOINT_ID.test(id)) throw new HttpError(404, 'No such endpoint')
  if (!one[2] && method === 'PUT') return json(res, 200, await updateEndpoint(user, id, await readJson<EndpointBody>(req, 16 * 1024))), true
  if (!one[2] && method === 'DELETE') return json(res, 200, deleteEndpoint(user, id)), true
  if (one[2] && method === 'POST') return json(res, 200, await testEndpoint(user, id)), true
  return false
}
