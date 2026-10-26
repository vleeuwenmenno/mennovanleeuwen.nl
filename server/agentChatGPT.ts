import { withProviderLifetime } from './privateRequest.ts'
import { privateRequestAuthority, withProviderGuard } from './privateRequest.ts'
import { privateFetch as fetch } from './privateRequest.ts'
import { createHash } from 'node:crypto'
import type { User } from './auth.ts'
import { onUserGone } from './db.ts'
import { HttpError } from './http.ts'
import { openaiChatAccess as access } from './agentOpenAI.ts'
import { meter, responsesStats, type CallStats } from './agentStats.ts'

// OpenAI's models as a chat provider for the Agents app, next to Ollama Cloud (server/agents.ts).
// A thread runs here when its model id carries a provider prefix:
//
// - `chatgpt/<slug>`: the ChatGPT Codex backend (chatgpt.com/backend-api/codex/responses), with the
//   tokens from Sign in with ChatGPT (server/agentOpenAI.ts). The request is the one CLIProxyAPI
//   (github.com/router-for-me/CLIProxyAPI, its OpenAI chat to Codex translator) sends: instructions
//   empty and the system prompt as a developer message, store false, stream true, reasoning effort,
//   the encrypted reasoning included, parallel tool calls, function tools with strict false. The
//   model list is the backend's own /models?client_version=… (visibility "list"). Unofficial, like
//   the pictures: Settings warns before the sign-in.
// - `openai/<id>`: the public Responses API (api.openai.com/v1/responses) with the account's OpenAI
//   API key, billed to that key; the list is /v1/models, filtered to chat models.
//
// Both stream server-sent events; text, reasoning summaries and function calls are read from them
// and handed back in the shape Ollama's chat gives, so the turn loop does not care which it was.
// Tokens and keys stay on the server. CHATGPT_CODEX_URL and OPENAI_URL point at stand-ins for tests.

export type ChatProvider = 'ollama' | 'chatgpt' | 'openai'
export const providerOf = (model: string): ChatProvider => (model.startsWith('chatgpt/') ? 'chatgpt' : model.startsWith('openai/') ? 'openai' : 'ollama')
const slugOf = (model: string) => model.slice(model.indexOf('/') + 1)

/** Thinking effort levels any provider may list, lowest first. Ollama's boolean thinking uses off and on. */
export const EFFORTS = ['off', 'on', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const
export type Effort = (typeof EFFORTS)[number]
export const isEffort = (v: unknown): v is Effort => typeof v === 'string' && (EFFORTS as readonly string[]).includes(v)

export type ProviderModel = { name: string; thinking: boolean; vision: boolean; contextLength: number | null; provider: ChatProvider; label?: string; efforts?: Effort[]; defaultEffort?: Effort }

/** The Codex client version the model list is asked for (the same one the User-Agent names). */
const CLIENT_VERSION = '0.154.0'

/** What the Codex backend's model list gives per model (CLIProxyAPI's codex_client_models.json). */
type CodexModel = { slug?: string; display_name?: string; visibility?: string; context_window?: number; supported_reasoning_levels?: { effort?: string }[]; default_reasoning_level?: string; input_modalities?: string[]; priority?: number }

/** When the backend has no model list (or it fails): what Codex itself offered when this was written. */
const CODEX_FALLBACK: ProviderModel[] = [{ name: 'chatgpt/gpt-5.5', label: 'GPT-5.5', thinking: true, vision: true, contextLength: 272_000, provider: 'chatgpt', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' }]

const levelsOf = (list: unknown): Effort[] => {
  const raw = Array.isArray(list) ? list.map((l) => (typeof l === 'string' ? l : (l as { effort?: unknown })?.effort)) : []
  return EFFORTS.filter((e) => e !== 'off' && e !== 'on' && raw.includes(e))
}

function codexModel(m: CodexModel): ProviderModel | null {
  if (typeof m.slug !== 'string' || !/^[\w.:-]{1,70}$/.test(m.slug)) return null
  if (m.visibility && m.visibility !== 'list') return null
  const efforts = levelsOf(m.supported_reasoning_levels)
  return {
    name: `chatgpt/${m.slug}`,
    label: typeof m.display_name === 'string' ? m.display_name.slice(0, 60) : undefined,
    thinking: efforts.length > 0,
    vision: Array.isArray(m.input_modalities) ? m.input_modalities.includes('image') : true,
    contextLength: typeof m.context_window === 'number' && m.context_window > 0 ? m.context_window : null,
    provider: 'chatgpt',
    ...(efforts.length ? { efforts, defaultEffort: isEffort(m.default_reasoning_level) && efforts.includes(m.default_reasoning_level) ? m.default_reasoning_level : efforts[0] } : {}),
  }
}

/** The public API's chat models, from /v1/models: what can hold a conversation with tools. */
const API_CHAT = /^(gpt-[4-9][\w.-]*|o[1-9][\w.-]*|chatgpt-[\w.-]+)$/
const API_SKIP = /audio|realtime|tts|transcribe|image|search|embedding|instruct|moderation|codex-mini|deep-research|-\d{4}-\d{2}-\d{2}$|computer-use/
function apiModel(id: string): ProviderModel | null {
  if (!API_CHAT.test(id) || API_SKIP.test(id) || id.length > 70) return null
  // Reasoning levels by family, as OpenAI documents them (not reported by /v1/models).
  const efforts: Effort[] = /^o\d/.test(id) ? ['low', 'medium', 'high'] : /^gpt-5(-mini|-nano)?$/.test(id) ? ['minimal', 'low', 'medium', 'high'] : /^gpt-(5\.|6)/.test(id) ? ['none', 'low', 'medium', 'high', 'xhigh'] : []
  const contextLength = /^gpt-4\.1/.test(id) ? 1_047_576 : /^gpt-(5|6)/.test(id) ? 400_000 : /^o\d/.test(id) ? 200_000 : /^gpt-4o|^chatgpt-/.test(id) ? 128_000 : null
  return { name: `openai/${id}`, thinking: efforts.length > 0, vision: !/^o1-mini|^o3-mini|^gpt-3/.test(id), contextLength, provider: 'openai', ...(efforts.length ? { efforts, defaultEffort: efforts.includes('medium') ? 'medium' : efforts[0] } : {}) }
}

const cache = new Map<string, { at: number; pending: boolean; authority: object | undefined; value: Promise<ProviderModel[]> }>()
onUserGone((id) => {
  for (const k of cache.keys()) if (k.endsWith(`:${id}`)) cache.delete(k)
})
const TTL = 30 * 60_000

function cached(key: string, load: () => Promise<ProviderModel[]>): Promise<ProviderModel[]> {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL && (!hit.pending || hit.authority === privateRequestAuthority())) return hit.value
  const value = load()
  const entry = { at: Date.now(), pending: true, authority: privateRequestAuthority(), value }
  value.then(() => { entry.pending = false }, () => {})
  cache.set(key, entry)
  value.catch(() => { if (cache.get(key) === entry) cache.delete(key) })
  return value
}

/** Whether a thread on this provider can run for the account now. */
export const chatProviderReady = (user: User, p: ChatProvider) => (p === 'chatgpt' ? access.signedIn(user) : p === 'openai' ? !!access.apiKey(user) : true)

/** The OpenAI models this account can chat with: ChatGPT's when signed in, the API's with a key. Never throws. */
export async function openaiModels(user: User): Promise<ProviderModel[]> {
  const [chatgpt, api] = await Promise.all([
    access.signedIn(user)
      ? cached(`chatgpt:${user.id}`, async () => {
          const res = await codexFetch(user, `/models?client_version=${CLIENT_VERSION}`, 'GET', undefined, AbortSignal.timeout(10_000), 'application/json')
          if (!res.ok) {
            await res.body?.cancel()
            if (res.status === 404 || res.status === 405) return CODEX_FALLBACK
            throw new HttpError(502, `ChatGPT answered ${res.status} for the model list`)
          }
          const body = (await res.json().catch(() => null)) as { models?: CodexModel[] } | null
          const list = (body?.models ?? []).sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0)).map(codexModel).filter((m): m is ProviderModel => !!m)
          return list.length ? list : CODEX_FALLBACK
        }).catch(() => CODEX_FALLBACK)
      : Promise.resolve([]),
    access.apiKey(user)
      ? cached(`openai:${user.id}`, async () => {
          const res = await fetch(`${access.openaiUrl()}/v1/models`, { headers: { Authorization: `Bearer ${access.apiKey(user)}` }, signal: AbortSignal.timeout(10_000) })
          if (!res.ok) throw new HttpError(502, `OpenAI answered ${res.status}`)
          const body = (await res.json().catch(() => null)) as { data?: { id?: string }[] } | null
          return (body?.data ?? []).flatMap((m) => (typeof m.id === 'string' ? [apiModel(m.id)] : [])).filter((m): m is ProviderModel => !!m).sort((a, b) => a.name.localeCompare(b.name))
        }).catch(() => [] as ProviderModel[])
      : Promise.resolve([]),
  ])
  return [...chatgpt, ...api]
}

// --- the request ---------------------------------------------------------------------------------

type ToolCall = { name: string; arguments: Record<string, unknown> }
type ChatMessage = { role: string; content: string; thinking?: string; tool_calls?: { function: ToolCall }[]; tool_name?: string; images?: string[] }
type ToolDef = { type: 'function'; function: { name: string; description: string; parameters: unknown } }
type Reply = { content: string; thinking: string; calls: ToolCall[]; used: number | null; stats?: CallStats }

/** A picture's type from its first bytes (base64), for the data URL the Responses API wants. */
function dataUrl(b64: string): string {
  const mime = b64.startsWith('iVBOR') ? 'image/png' : b64.startsWith('/9j/') ? 'image/jpeg' : b64.startsWith('R0lG') ? 'image/gif' : b64.startsWith('UklGR') ? 'image/webp' : 'image/png'
  return `data:${mime};base64,${b64}`
}

/**
 * Ollama-style messages as Responses input items. Our tool results carry no call id (Ollama pairs
 * them by order), so each assistant call gets one here, and the results that follow take them in
 * order (by name first). A result whose call is not there any more goes as a note in a user message.
 */
export function responsesInput(messages: ChatMessage[]): { input: unknown[] } {
  const input: unknown[] = []
  let open: { id: string; name: string }[] = []
  messages.forEach((m, i) => {
    if (m.role === 'system') return void input.push({ type: 'message', role: 'developer', content: [{ type: 'input_text', text: m.content }] })
    if (m.role === 'tool') {
      const at = Math.max(0, open.findIndex((c) => c.name === m.tool_name))
      const call = open[at]
      if (!call) return void input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: `(A tool result for ${m.tool_name || 'a tool'}, from earlier.)\n${m.content}` }] })
      open = open.filter((_, j) => j !== at)
      return void input.push({ type: 'function_call_output', call_id: call.id, output: m.content })
    }
    if (m.role === 'assistant') {
      open = []
      if (m.content) input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: m.content }] })
      ;(m.tool_calls ?? []).forEach((c, j) => {
        const id = `call_${i}_${j}`
        open.push({ id, name: c.function.name })
        input.push({ type: 'function_call', call_id: id, name: c.function.name, arguments: JSON.stringify(c.function.arguments ?? {}) })
      })
      return
    }
    const parts: unknown[] = [{ type: 'input_text', text: m.content || ' ' }]
    for (const img of m.images ?? []) parts.push({ type: 'input_image', image_url: dataUrl(img) })
    input.push({ type: 'message', role: 'user', content: parts })
  })
  // A call left without its result (a turn cut short) would be refused: it gets an empty one.
  for (const c of open) input.push({ type: 'function_call_output', call_id: c.id, output: '{"error":"No result: the turn was cut short"}' })
  return { input }
}

const functionTools = (tools: ToolDef[]) => tools.map((t) => ({ type: 'function', name: t.function.name, description: t.function.description, parameters: t.function.parameters, strict: false }))

/** The effort to ask for: the one given when the model has it, else the nearest it has. */
export function clampEffort(want: Effort | null | undefined, efforts: Effort[] | undefined): Effort | null {
  if (!efforts?.length) return null
  if (!want) return null
  if (efforts.includes(want)) return want
  const order: Effort[] = EFFORTS.filter((e) => e !== 'on')
  const w = want === 'on' ? order.indexOf('medium') : order.indexOf(want)
  return [...efforts].sort((a, b) => Math.abs(order.indexOf(a) - w) - Math.abs(order.indexOf(b) - w))[0]
}

async function codexFetch(user: User, path: string, method: string, body: unknown, signal: AbortSignal, accept: string, session?: string): Promise<Response> {
  const version = access.version(user)
  return withProviderGuard(() => access.assertVersion(user, version), async () => {
  const go = async (force: boolean) => {
    const t = await access.freshTokens(user, force, version, signal)
    access.assertVersion(user, version)
    return fetch(`${access.codexUrl()}${path}`, {
      method,
      headers: { ...access.codexHeaders(t, accept), ...(session ? { session_id: session } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
    }).catch((e: Error) => {
      if (signal.aborted) throw e
      throw new HttpError(502, 'ChatGPT did not answer')
    })
  }
  let res = await go(false)
  // Refused: refreshed once and tried again (the token can expire halfway through a long thread).
  if (res.status === 401) {
    await res.body?.cancel()
    res = await go(true)
    if (res.status === 401) {
      await res.body?.cancel()
      throw new HttpError(409, 'ChatGPT refused the sign-in: sign in again in Settings → Agents → Images')
    }
  }
  access.assertVersion(user, version)
  return res
  })
}

/** An error answer from either backend, worded for the window; a too-long one so the turn compacts. */
async function failure(res: Response, who: string): Promise<HttpError> {
  const text = await res.text().catch(() => '')
  let message = ''
  let code = ''
  try {
    const body = JSON.parse(text) as { error?: { message?: string; code?: string; type?: string } | string; detail?: string | { message?: string } }
    message = typeof body.error === 'string' ? body.error : body.error?.message || (typeof body.detail === 'string' ? body.detail : body.detail?.message) || ''
    code = typeof body.error === 'object' ? body.error?.code || body.error?.type || '' : ''
  } catch {
    message = text.slice(0, 200)
  }
  message = message.replace(/\s+/g, ' ').trim().slice(0, 300)
  if (/context_length|context window|too long|maximum context/i.test(`${code} ${message}`)) return new HttpError(502, `${who}: the conversation is too long for the model's context window${message ? ` (${message})` : ''}`)
  if (res.status === 429) return new HttpError(429, message ? `${who}: ${message}` : `${who} says the usage limit is reached for now`)
  if (res.status === 401 || res.status === 403) return new HttpError(409, `${who} refused the request${message ? `: ${message}` : ''}`)
  return new HttpError(502, message ? `${who}: ${message}` : `${who} answered ${res.status}`)
}

type Event = {
  type?: string
  delta?: string
  summary_index?: number
  item?: { type?: string; call_id?: string; name?: string; arguments?: string }
  response?: { usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number; input_tokens_details?: { cached_tokens?: number }; output_tokens_details?: { reasoning_tokens?: number } }; error?: { message?: string; code?: string } }
  error?: { message?: string; code?: string } | string
  message?: string
  code?: string
}

/**
 * Reads a Responses event stream: text and reasoning summaries go out as they come; calls and usage
 * at the end. `timer` started when the request went out: anything the model streams back (text,
 * reasoning, a tool call's arguments) counts for the time to the first token.
 */
async function readStream(res: Response, who: string, onDelta: (d: { content?: string; thinking?: string }) => void, timer: ReturnType<typeof meter>, provider: ChatProvider, model: string): Promise<Reply> {
  let content = ''
  let thinking = ''
  let used: number | null = null
  let usage: NonNullable<Event['response']>['usage'] | null = null
  const calls: ToolCall[] = []
  let lastSummary = -1
  const take = (data: string) => {
    if (!data || data === '[DONE]') return
    let e: Event
    try {
      e = JSON.parse(data) as Event
    } catch {
      return
    }
    switch (e.type) {
      case 'response.output_text.delta':
        if (e.delta) timer.first(), (content += e.delta), onDelta({ content: e.delta })
        break
      case 'response.function_call_arguments.delta':
        timer.first()
        break
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta':
        if (!e.delta) break
        timer.first()
        // A new summary part starts on a line of its own.
        if (typeof e.summary_index === 'number' && e.summary_index !== lastSummary) {
          if (lastSummary >= 0 && thinking) (thinking += '\n\n'), onDelta({ thinking: '\n\n' })
          lastSummary = e.summary_index
        }
        thinking += e.delta
        onDelta({ thinking: e.delta })
        break
      case 'response.output_item.done':
        if (e.item?.type === 'function_call' && e.item.name) {
          timer.first()
          let args: Record<string, unknown> = {}
          try {
            args = (JSON.parse(e.item.arguments || '{}') as Record<string, unknown>) ?? {}
          } catch {
            /* the tool reports the missing arguments */
          }
          calls.push({ name: e.item.name, arguments: args })
        }
        break
      case 'response.completed':
      case 'response.done': {
        const u = e.response?.usage
        if (u) (usage = u), (used = u.total_tokens ?? (u.input_tokens ?? 0) + (u.output_tokens ?? 0))
        break
      }
      case 'response.failed':
      case 'response.incomplete':
      case 'error': {
        const err = e.response?.error ?? (typeof e.error === 'object' ? e.error : { message: typeof e.error === 'string' ? e.error : e.message, code: e.code })
        const text = `${err?.code ?? ''} ${err?.message ?? ''}`
        if (/context_length|context window|too long|maximum context/i.test(text)) throw new HttpError(502, `${who}: the conversation is too long for the model's context window`)
        if (e.type === 'response.incomplete' && (content || calls.length)) break
        throw new HttpError(502, `${who}: ${err?.message || 'the reply failed'}`)
      }
    }
  }
  if (!res.body) throw new HttpError(502, `${who} sent nothing`)
  const decoder = new TextDecoder()
  let buffer = ''
  const block = (raw: string) => take(raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n'))
  for await (const piece of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(piece, { stream: true }).replace(/\r\n/g, '\n')
    let end
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      block(buffer.slice(0, end))
      buffer = buffer.slice(end + 2)
    }
  }
  block(buffer)
  return { content, thinking, calls, used, stats: responsesStats(provider, model, usage, timer.end()) }
}

/**
 * One model call on an OpenAI provider, streamed, answered like Ollama's chat: the reply's text,
 * its reasoning summary, the tool calls it made and how many tokens the context took.
 */
async function responsesChatInner(
  user: User,
  req: { model: string; messages: ChatMessage[]; tools?: ToolDef[]; effort?: Effort | null; session?: string },
  signal: AbortSignal,
  onDelta: (d: { content?: string; thinking?: string }) => void,
): Promise<Reply> {
  const provider = providerOf(req.model)
  if (provider === 'ollama') throw new HttpError(500, 'Not an OpenAI model')
  const info = (await openaiModels(user)).find((m) => m.name === req.model)
  const effort = clampEffort(req.effort ?? info?.defaultEffort, info?.efforts)
  const { input } = responsesInput(req.messages)
  const body: Record<string, unknown> = {
    model: slugOf(req.model),
    instructions: '',
    input,
    stream: true,
    store: false,
    parallel_tool_calls: true,
    ...(req.tools?.length ? { tools: functionTools(req.tools), tool_choice: 'auto' } : {}),
    ...(effort ? { reasoning: { effort, summary: 'auto' }, include: ['reasoning.encrypted_content'] } : {}),
    ...(req.session ? { prompt_cache_key: createHash('sha256').update(req.session).digest('hex').slice(0, 32) } : {}),
  }
  if (provider === 'chatgpt') {
    if (!access.signedIn(user)) throw new HttpError(409, 'Sign in with ChatGPT first, in Settings → Agents → Images')
    const timer = meter()
    const res = await codexFetch(user, '/responses', 'POST', body, signal, 'text/event-stream', typeof body.prompt_cache_key === 'string' ? body.prompt_cache_key : undefined)
    if (!res.ok) throw await failure(res, 'ChatGPT')
    return readStream(res, 'ChatGPT', onDelta, timer, provider, req.model)
  }
  const key = access.apiKey(user)
  if (!key) throw new HttpError(409, 'Add an OpenAI API key in Settings → Agents → Images first')
  const timer = meter()
  const res = await fetch(`${access.openaiUrl()}/v1/responses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
  }).catch((e: Error) => {
    if (signal.aborted) throw e
    throw new HttpError(502, 'OpenAI did not answer')
  })
  if (res.status === 401) {
    await res.body?.cancel()
    throw new HttpError(409, 'OpenAI refused the API key: set it again in Settings → Agents → Images')
  }
  if (!res.ok) throw await failure(res, 'OpenAI')
  return readStream(res, 'OpenAI', onDelta, timer, provider, req.model)
}

// Capture before model discovery too: a held model list must not move this prompt to a new link.
export const responsesChat: typeof responsesChatInner = (user, request, ...args) => {
  if (providerOf(request.model) !== 'chatgpt') return responsesChatInner(user, request, ...args)
  const version = access.version(user)
  return withProviderLifetime(() => access.assertVersion(user, version), (end) => access.onChanged((id) => { if (id === user.id) end() }), async () => {
    access.assertVersion(user, version)
    const reply = await responsesChatInner(user, request, ...args)
    access.assertVersion(user, version)
    return reply
  })
}
