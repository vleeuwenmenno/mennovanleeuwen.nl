import { sharedProviderJob, withProviderLifetime } from './privateRequest.ts'
import { privateFetch as fetch } from './privateRequest.ts'
import { createHash, randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { requireStillSignedIn, serverKey, type User } from './auth.ts'
import { database, decrypt, encrypt, onUserGone } from './db.ts'
import { HttpError, json, readJson, SECURITY, UNTRUSTED } from './http.ts'
import { checkRoom } from './quota.ts'
import { fitPng, isPng, pngSize } from './pngResize.ts'

// Pictures and icons from OpenAI's gpt-image models, for the Agents app's gpt_image tool. Ollama
// Cloud (what the agents run on) makes no pictures, so this goes to OpenAI in one of two ways,
// picked in Settings → Agents → Images:
//
// - An OpenAI API key (the user's, stored encrypted like the Ollama key; admins may fall back to
//   OPENAI_API_KEY on the server). Pictures come from the Images API, billed to that key.
// - Sign in with ChatGPT: the Codex CLI's OAuth sign-in (public client, PKCE), done the way
//   CLIProxyAPI (github.com/router-for-me/CLIProxyAPI) does it, and pictures from the ChatGPT
//   Codex backend, spending the plan's image allowance. This is unofficial: OpenAI does not allow
//   it for hosted apps and may restrict the account, so the window warns before it starts (and the
//   server refuses to start without that being accepted). The sign-in comes back to a localhost
//   address only the Codex CLI listens on, so the user pastes that address back here.
//
// Tokens and keys never go to the browser or the model. Icons are kept per account in a library
// by slug (agent_icons), downscaled to 256 px; GET /api/agents/icons/<slug> serves them.
//
// OPENAI_URL, OPENAI_AUTH_URL and CHATGPT_CODEX_URL point at stand-ins for testing.

const OPENAI = () => (process.env.OPENAI_URL || 'https://api.openai.com').replace(/\/+$/, '')
const AUTH = () => (process.env.OPENAI_AUTH_URL || 'https://auth.openai.com').replace(/\/+$/, '')
const CODEX = () => (process.env.CHATGPT_CODEX_URL || 'https://chatgpt.com/backend-api/codex').replace(/\/+$/, '')

/** The Codex CLI's public OAuth client, and the only redirect it has registered (CLIProxyAPI's internal/auth/codex). */
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const CODEX_REDIRECT = 'http://localhost:1455/auth/callback'
const CODEX_SCOPE = 'openid email profile offline_access'
/** What CLIProxyAPI sends as the Codex client to the ChatGPT backend. */
const CODEX_ORIGINATOR = 'codex-tui'
const CODEX_USER_AGENT = 'codex-tui/0.154.0 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.154.0)'
/** The chat model the Codex backend's Responses API runs the image_generation tool with, when the direct images route is not there. */
const CODEX_MAIN_MODEL = 'gpt-5.4-mini'

const KEY = 'openai'
const TOKENS = 'openai-chatgpt'
const SETTINGS = 'openai-images'

export const IMAGE_MODELS = ['gpt-image-2', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-1.5', 'gpt-image-1', 'gpt-image-1-mini'] as const
export type Provider = 'off' | 'apikey' | 'chatgpt'
type Settings = { provider: Provider; model: string }
type Tokens = { access: string; refresh: string; accountId: string; email: string; plan: string; expires: number }

const ICON_SIZE = 256
export const SLUG = /^[a-z0-9_-]{1,64}$/
const perDay = () => Math.max(1, Number(process.env.OPENAI_IMAGES_PER_DAY) || 40)

// --- stored secrets and settings ----------------------------------------------------------------

function read<T>(user: User, name: string): T | null {
  const row = database().prepare('SELECT secret FROM integrations WHERE user_id = ? AND name = ?').get(user.id, name) as { secret: string } | undefined
  if (!row) return null
  try {
    return JSON.parse(decrypt(row.secret)) as T
  } catch {
    return null
  }
}
function write(user: User, name: string, value: unknown) {
  database()
    .prepare('INSERT INTO integrations (user_id, name, secret, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, name) DO UPDATE SET secret = excluded.secret')
    .run(user.id, name, encrypt(JSON.stringify(value)), Date.now())
}
const forget = (user: User, name: string) => database().prepare('DELETE FROM integrations WHERE user_id = ? AND name = ?').run(user.id, name)

function settings(user: User): Settings {
  const s = read<Partial<Settings>>(user, SETTINGS)
  return { provider: s?.provider === 'apikey' || s?.provider === 'chatgpt' ? s.provider : 'off', model: typeof s?.model === 'string' && s.model ? s.model : IMAGE_MODELS[0] }
}
const apiKey = (user: User): string | null => read<{ key: string }>(user, KEY)?.key ?? serverKey(user, 'OPENAI_API_KEY')
const keySource = (user: User): 'settings' | 'server' | null => (read<{ key: string }>(user, KEY) ? 'settings' : serverKey(user, 'OPENAI_API_KEY') ? 'server' : null)
const tokens = (user: User) => read<Tokens>(user, TOKENS)

/** Whether gpt_image can run for this account now: a provider picked, and its key or sign-in there. */
export function openaiImagesReady(user: User): boolean {
  const s = settings(user)
  return s.provider === 'apikey' ? !!apiKey(user) : s.provider === 'chatgpt' ? !!tokens(user) : false
}

function usedToday(user: User): number {
  return (database().prepare('SELECT COUNT(*) AS n FROM agent_image_usage WHERE user_id = ? AND at > ?').get(user.id, Date.now() - 86400_000) as { n: number }).n
}

/** What Settings shows: never a key or token, only where they come from and who is signed in. */
export function openaiImagesView(user: User) {
  const s = settings(user)
  const t = tokens(user)
  return {
    provider: s.provider,
    model: s.model,
    models: [...IMAGE_MODELS],
    apiKey: keySource(user),
    chatgpt: t ? { email: t.email, plan: t.plan } : null,
    signingIn: flows.has(user.id),
    usage: { today: usedToday(user), limit: perDay() },
    ready: openaiImagesReady(user),
  }
}

function saveSettings(user: User, body: { provider?: unknown; model?: unknown }) {
  const s = settings(user)
  if (body.provider !== undefined) {
    if (body.provider !== 'off' && body.provider !== 'apikey' && body.provider !== 'chatgpt') throw new HttpError(400, 'Provider is off, apikey or chatgpt')
    s.provider = body.provider
  }
  if (body.model !== undefined) {
    if (typeof body.model !== 'string' || !(IMAGE_MODELS as readonly string[]).includes(body.model)) throw new HttpError(400, `Model is one of ${IMAGE_MODELS.join(', ')}`)
    s.model = body.model
  }
  write(user, SETTINGS, s)
}

/** Checks the key with OpenAI (listing models costs nothing), then stores it encrypted. */
async function setKey(user: User, body: { key?: unknown }) {
  const key = typeof body.key === 'string' ? body.key.trim() : ''
  if (!key || key.length > 400 || /\s/.test(key)) throw new HttpError(400, 'Paste an OpenAI API key')
  const res = await fetch(`${OPENAI()}/v1/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) }).catch(() => null)
  if (!res) throw new HttpError(502, 'OpenAI did not answer')
  await res.body?.cancel()
  if (res.status === 401 || res.status === 403) throw new HttpError(400, 'OpenAI refused that key')
  if (!res.ok) throw new HttpError(502, `OpenAI answered ${res.status}`)
  write(user, KEY, { key })
  const s = settings(user)
  if (s.provider === 'off') write(user, SETTINGS, { ...s, provider: 'apikey' })
}

// --- Sign in with ChatGPT (Codex OAuth, PKCE) ----------------------------------------------------

/** Sign-ins started and not finished, by account: the PKCE verifier and state, for 15 minutes. */
const flows = new Map<number, { verifier: string; state: string; at: number }>()
const FLOW_TTL = 15 * 60_000
onUserGone((id) => {
  flows.delete(id)
  refreshing.delete(id)
  invalidate(id)
})

/**
 * The version of an account's stored ChatGPT credential. It moves on sign-out, a new sign-in and
 * account removal, so work that started under an older version (a refresh in flight, a sign-in
 * waiting on OpenAI) can neither store nor hand out its tokens.
 */
const credentialChanged = new Set<(id: number) => void>()
export function onChatGPTChanged(fn: (id: number) => void) { credentialChanged.add(fn); return () => { credentialChanged.delete(fn) } }
const credentialVersion = new Map<number, number>()
const versionOf = (id: number) => credentialVersion.get(id) ?? 0
function invalidate(id: number) {
  credentialVersion.set(id, versionOf(id) + 1)
  refreshing.delete(id)
  for (const changed of credentialChanged) changed(id)
}
export const chatGPTVersion = (user: User) => versionOf(user.id)
export function assertChatGPTVersion(user: User, version: number) {
  if (versionOf(user.id) !== version || !database().prepare('SELECT 1 FROM users WHERE id=? AND banned_at IS NULL').get(user.id)) throw STALE()
}
const STALE = () => new HttpError(409, 'The ChatGPT sign-in changed while this was running: try again')

const b64url = (b: Buffer) => b.toString('base64url')

/** Starts a sign-in: the address to open at auth.openai.com. Only after the risk was accepted in the window. */
function startSignIn(user: User, body: { acceptedRisk?: unknown }) {
  if (body.acceptedRisk !== true) throw new HttpError(400, 'Accept the risk warning first: this sign-in is unofficial and OpenAI may restrict the ChatGPT account')
  const verifier = b64url(randomBytes(64))
  const state = b64url(randomBytes(24))
  flows.set(user.id, { verifier, state, at: Date.now() })
  const params = new URLSearchParams({
    client_id: CODEX_CLIENT_ID,
    response_type: 'code',
    redirect_uri: CODEX_REDIRECT,
    scope: CODEX_SCOPE,
    state,
    code_challenge: b64url(createHash('sha256').update(verifier).digest()),
    code_challenge_method: 'S256',
    prompt: 'login',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
  })
  return { url: `${AUTH()}/oauth/authorize?${params}`, redirect: CODEX_REDIRECT }
}

/** The claims in a JWT's middle part (not verified: it came straight from OpenAI over TLS). */
function claims(jwt: unknown): Record<string, unknown> {
  if (typeof jwt !== 'string') return {}
  try {
    return JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

type TokenAnswer = { access_token?: string; refresh_token?: string; id_token?: string; expires_in?: number }
async function tokenRequest(form: Record<string, string>): Promise<TokenAnswer> {
  const res = await fetch(`${AUTH()}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(30_000),
  }).catch(() => null)
  if (!res) throw new HttpError(502, 'auth.openai.com did not answer')
  const body = (await res.json().catch(() => null)) as (TokenAnswer & { error?: string; error_description?: string }) | null
  if (!res.ok || !body?.access_token) throw new HttpError(res.status === 400 || res.status === 401 ? 400 : 502, `OpenAI refused the sign-in${body?.error_description || body?.error ? `: ${body.error_description || body.error}` : ` (${res.status})`}`)
  return body
}

function storeTokens(user: User, answer: TokenAnswer, previous?: Tokens | null) {
  const id = claims(answer.id_token)
  const auth = (id['https://api.openai.com/auth'] ?? claims(answer.access_token)['https://api.openai.com/auth'] ?? {}) as { chatgpt_account_id?: string; chatgpt_plan_type?: string }
  const t: Tokens = {
    access: answer.access_token!,
    refresh: answer.refresh_token || previous?.refresh || '',
    accountId: auth.chatgpt_account_id || previous?.accountId || '',
    email: (typeof id.email === 'string' && id.email) || previous?.email || '',
    plan: auth.chatgpt_plan_type || previous?.plan || '',
    expires: Date.now() + (Number(answer.expires_in) > 0 ? Number(answer.expires_in) : 3600) * 1000,
  }
  if (!t.refresh) throw new HttpError(502, 'OpenAI sent no refresh token')
  write(user, TOKENS, t)
  return t
}

/**
 * Finishes a sign-in with the address the browser ended on (http://localhost:1455/auth/callback?code=…&state=…),
 * pasted back, or just its query. The state must be this account's sign-in's.
 */
async function finishSignIn(user: User, body: { callback?: unknown }, req: IncomingMessage) {
  requireStillSignedIn(req)
  const flow = flows.get(user.id)
  if (!flow || Date.now() - flow.at > FLOW_TTL) {
    flows.delete(user.id)
    throw new HttpError(409, 'Start the sign-in again: it was not started here, or it is more than 15 minutes old')
  }
  const text = typeof body.callback === 'string' ? body.callback.trim() : ''
  if (!text || text.length > 8192) throw new HttpError(400, 'Paste the address your browser ended on after signing in')
  let query: URLSearchParams
  try {
    query = /^[a-z]+:\/\//i.test(text) ? new URL(text).searchParams : new URLSearchParams(text.replace(/^[^?]*\?/, ''))
  } catch {
    throw new HttpError(400, 'That is not the address your browser ended on')
  }
  if (query.get('error')) throw new HttpError(400, `OpenAI said: ${query.get('error_description') || query.get('error')}`)
  const code = query.get('code')
  if (!code) throw new HttpError(400, 'That address has no code in it: paste the whole address from the address bar, starting with http://localhost:1455')
  if (query.get('state') !== flow.state) throw new HttpError(400, 'That address belongs to another sign-in: start again')
  flows.delete(user.id)
  const version = versionOf(user.id)
  const answer = await tokenRequest({ grant_type: 'authorization_code', client_id: CODEX_CLIENT_ID, code, redirect_uri: CODEX_REDIRECT, code_verifier: flow.verifier })
  if (versionOf(user.id) !== version) throw STALE() // signed out or removed while OpenAI answered
  // storeTokens validates the answer and writes it without awaiting anything; only then is the old
  // credential's pending work cancelled, so a malformed answer leaves the previous sign-in intact.
  requireStillSignedIn(req)
  const t = storeTokens(user, answer)
  invalidate(user.id) // a refresh of the previous account's tokens must not land on this one
  const s = settings(user)
  if (s.provider === 'off') write(user, SETTINGS, { ...s, provider: 'chatgpt' })
  return { email: t.email, plan: t.plan }
}

function signOut(user: User) {
  invalidate(user.id)
  forget(user, TOKENS)
  flows.delete(user.id)
  const s = settings(user)
  if (s.provider === 'chatgpt') write(user, SETTINGS, { ...s, provider: apiKey(user) ? 'apikey' : 'off' })
}

/** One refresh at a time per account: two pictures at once must not both spend the refresh token. */
const refreshing = new Map<number, { version: number; job: ReturnType<typeof sharedProviderJob<Tokens>> }>()
async function freshTokens(user: User, force = false, expected = versionOf(user.id), signal?: AbortSignal): Promise<Tokens> {
  assertChatGPTVersion(user, expected)
  const t = tokens(user)
  if (!t) throw new HttpError(409, 'Sign in with ChatGPT first, in Settings → Agents → Images')
  if (!force && t.expires - Date.now() > 5 * 60_000) return t
  const version = versionOf(user.id)
  const running = refreshing.get(user.id)
  if (running && running.version === version && !running.job.signal.aborted) return running.job.join(signal)
  const job = sharedProviderJob(() => assertChatGPTVersion(user, version), (end) => onChatGPTChanged((id) => { if (id === user.id) end() }), async () => {
    try {
      const answer = await tokenRequest({ client_id: CODEX_CLIENT_ID, grant_type: 'refresh_token', refresh_token: t.refresh, scope: 'openid profile email' })
      assertChatGPTVersion(user, version)
      return storeTokens(user, answer, t)
    } catch (error) {
      assertChatGPTVersion(user, version)
      if (error instanceof HttpError && error.status === 400) throw new HttpError(409, 'The ChatGPT sign-in has expired: sign in again in Settings → Agents → Images')
      throw error
    }
  })
  void job.value.finally(() => { if (refreshing.get(user.id)?.job === job) refreshing.delete(user.id) }).catch(() => {})
  refreshing.set(user.id, { version, job })
  return job.join(signal)
}

// --- making a picture ----------------------------------------------------------------------------

/** A picture the model passes along to draw from (a screenshot, an earlier picture), already checked to be the user's. */
export type Reference = { name: string; mime: string; bytes: Buffer }
export type ImageRequest = { prompt: string; size: '1024x1024' | '1536x1024' | '1024x1536'; quality: 'low' | 'medium' | 'high' | 'auto'; background: 'transparent' | 'opaque' | 'auto'; format: 'png' | 'webp'; references?: Reference[] }
type Made = { bytes: Buffer; mime: string }
/** Called with each rough preview while a picture is drawn (when the route streams them). */
export type OnPartial = (preview: Made) => void

/** How many rough previews to ask for while drawing (the API allows 0 to 3; each costs a little). */
const PARTIALS = 2
/** References: at most this many, each at most this big (OpenAI takes more; these keep requests and memory sane). */
export const MAX_REFERENCES = 4
export const MAX_REFERENCE_BYTES = 8 * 1024 * 1024

const MIME: Record<string, string> = { png: 'image/png', webp: 'image/webp', jpeg: 'image/jpeg' }
export function sniff(bytes: Buffer): string | null {
  if (isPng(bytes)) return 'image/png'
  if (bytes.length > 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  return null
}
function picture(b64: unknown): Made {
  if (typeof b64 !== 'string' || !b64) throw new HttpError(502, 'OpenAI sent no picture')
  const bytes = Buffer.from(b64, 'base64')
  const mime = sniff(bytes)
  if (!mime) throw new HttpError(502, 'OpenAI sent something that is not a picture')
  if (bytes.length > 12 * 1024 * 1024) throw new HttpError(502, 'OpenAI sent a picture over 12 MB')
  return { bytes, mime }
}
/** A preview that does not decode is skipped, never fatal: the final picture is what counts. */
function preview(b64: unknown, onPartial?: OnPartial) {
  if (!onPartial) return
  try {
    onPartial(picture(b64))
  } catch {}
}

/**
 * Typical drawing time in ms, for the estimate the window shows while it waits: by quality, a bit
 * longer for the large sizes and with references. Only an estimate; the window never shows 100%.
 */
export function expectedMs(r: Pick<ImageRequest, 'quality' | 'size'> & { references?: number }): number {
  const base = r.quality === 'low' ? 20_000 : r.quality === 'high' ? 90_000 : 45_000
  return Math.round(base * (r.size === '1024x1024' ? 1 : 1.3) + (r.references ? 10_000 : 0))
}

async function failure(res: Response, who: string): Promise<HttpError> {
  const text = await res.text().catch(() => '')
  let message = ''
  try {
    const body = JSON.parse(text) as { error?: { message?: string; code?: string } | string; detail?: string }
    message = typeof body.error === 'string' ? body.error : body.error?.message || body.detail || ''
  } catch {}
  message = message.replace(/\s+/g, ' ').slice(0, 300)
  if (res.status === 429) return new HttpError(429, message ? `${who}: ${message}` : `${who} says the image limit is reached for now`)
  if (res.status === 400 && message) return new HttpError(400, `${who} refused the picture: ${message}`)
  return new HttpError(502, message ? `${who}: ${message}` : `${who} answered ${res.status}`)
}

type StreamEvent = { type?: string; b64_json?: string; partial_image_b64?: string; item?: { type?: string; result?: string }; response?: { output?: { type?: string; result?: string }[]; error?: { message?: string } }; error?: { message?: string } | string; message?: string }

/** A server-sent event stream, event by event, as it arrives (so previews show while the picture is drawn). */
async function* events(res: Response): AsyncGenerator<StreamEvent> {
  if (!res.body) return
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const parse = (block: string): StreamEvent | null => {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n')
    if (!data || data === '[DONE]') return null
    try {
      return JSON.parse(data) as StreamEvent
    } catch {
      return null
    }
  }
  for (;;) {
    const { done, value } = await reader.read()
    buffer += decoder.decode(value, { stream: !done })
    // A picture comes as one big data line, so the buffer is cut at blank lines only.
    let cut: RegExpExecArray | null
    while ((cut = /\r?\n\r?\n/.exec(buffer))) {
      const event = parse(buffer.slice(0, cut.index))
      buffer = buffer.slice(cut.index + cut[0].length)
      if (event) yield event
    }
    if (done) break
  }
  const last = parse(buffer)
  if (last) yield last
}
const eventError = (e: StreamEvent) => (typeof e.error === 'string' ? e.error : e.error?.message) || e.response?.error?.message || e.message || 'the picture failed'
const isStream = (res: Response) => (res.headers.get('content-type') ?? '').includes('text/event-stream')

/** The Images API's answer: a stream (previews, then image_generation.completed / image_edit.completed) or plain JSON. */
async function imagesAnswer(res: Response, who: string, onPartial?: OnPartial): Promise<Made> {
  if (!isStream(res)) {
    const body = (await res.json().catch(() => null)) as { data?: { b64_json?: string }[] } | null
    return picture(body?.data?.[0]?.b64_json)
  }
  let found: string | undefined
  for await (const e of events(res)) {
    if (e.type?.endsWith('.partial_image')) preview(e.b64_json, onPartial)
    else if (e.type?.endsWith('.completed')) found ??= e.b64_json
    else if (e.type === 'error' || e.type?.endsWith('.failed')) throw new HttpError(502, `${who}: ${eventError(e)}`)
  }
  if (!found) throw new HttpError(502, `${who} finished without a picture`)
  return picture(found)
}

const imagesBody = (model: string, r: ImageRequest, stream: boolean) => ({ model, prompt: r.prompt, n: 1, size: r.size, quality: r.quality, background: r.background, output_format: r.format, ...(stream ? { stream: true, partial_images: PARTIALS } : {}) })

/** The edits route's form: the same fields, and each reference as image[] (OpenAI's multipart shape for several input pictures). */
function editsForm(model: string, r: ImageRequest, stream: boolean): FormData {
  const form = new FormData()
  for (const [k, v] of Object.entries(imagesBody(model, r, stream))) form.append(k, String(v))
  for (const ref of r.references ?? []) form.append('image[]', new Blob([new Uint8Array(ref.bytes)], { type: ref.mime }), ref.name.replace(/[^\w.-]+/g, '_').slice(0, 80) || 'reference.png')
  return form
}

async function withApiKey(user: User, model: string, r: ImageRequest, signal: AbortSignal, onPartial?: OnPartial): Promise<Made> {
  const key = apiKey(user)
  if (!key) throw new HttpError(409, 'Add an OpenAI API key in Settings → Agents → Images first')
  // References go to the edits route (several input pictures); a plain picture to generations.
  const edit = !!r.references?.length
  const res = await fetch(`${OPENAI()}/v1/images/${edit ? 'edits' : 'generations'}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, ...(edit ? {} : { 'Content-Type': 'application/json' }) },
    body: edit ? editsForm(model, r, !!onPartial) : JSON.stringify(imagesBody(model, r, !!onPartial)),
    signal,
  }).catch((e: Error) => {
    if (signal.aborted) throw e
    throw new HttpError(502, 'OpenAI did not answer')
  })
  if (res.status === 401 || res.status === 403) throw new HttpError(409, 'OpenAI refused the API key: set it again in Settings → Agents → Images')
  if (!res.ok) throw await failure(res, 'OpenAI')
  return imagesAnswer(res, 'OpenAI', onPartial)
}

function codexHeaders(t: Tokens, accept: string): Record<string, string> {
  return { Authorization: `Bearer ${t.access}`, 'Content-Type': 'application/json', Accept: accept, Originator: CODEX_ORIGINATOR, 'User-Agent': CODEX_USER_AGENT, ...(t.accountId ? { 'Chatgpt-Account-Id': t.accountId } : {}) }
}

const dataUrl = (ref: Reference) => `data:${ref.mime};base64,${ref.bytes.toString('base64')}`

/**
 * The Codex backend's Responses API with the image_generation tool (CLIProxyAPI's
 * codexBuildImagesResponsesRequest), read from its event stream. References go along as
 * input_image items in the message, and the tool is told to edit from them.
 */
async function codexResponses(t: Tokens, model: string, r: ImageRequest, signal: AbortSignal, stream: boolean): Promise<Response> {
  const refs = r.references ?? []
  const body = {
    instructions: '',
    stream: true,
    reasoning: { effort: 'medium', summary: 'auto' },
    parallel_tool_calls: true,
    include: ['reasoning.encrypted_content'],
    model: CODEX_MAIN_MODEL,
    store: false,
    tool_choice: { type: 'image_generation' },
    tools: [{ type: 'image_generation', action: refs.length ? 'edit' : 'generate', model, size: r.size, quality: r.quality, background: r.background, output_format: r.format, ...(stream ? { partial_images: PARTIALS } : {}) }],
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: r.prompt }, ...refs.map((ref) => ({ type: 'input_image', image_url: dataUrl(ref) }))] }],
  }
  return fetch(`${CODEX()}/responses`, { method: 'POST', headers: codexHeaders(t, 'text/event-stream'), body: JSON.stringify(body), signal })
}

/** The Responses stream: previews (response.image_generation_call.partial_image), then the finished call's picture. */
async function imageFromEvents(res: Response, onPartial?: OnPartial): Promise<Made> {
  let found: string | undefined
  for await (const event of events(res)) {
    if (event.type === 'response.image_generation_call.partial_image') preview(event.partial_image_b64, onPartial)
    if (event.type === 'response.output_item.done' && event.item?.type === 'image_generation_call' && event.item.result) found ??= event.item.result
    if (event.type === 'response.completed') found ??= event.response?.output?.find((o) => o.type === 'image_generation_call' && o.result)?.result
    if (event.type === 'response.failed' || event.type === 'error') throw new HttpError(502, `ChatGPT: ${eventError(event)}`)
  }
  if (!found) throw new HttpError(502, 'ChatGPT finished without a picture')
  return picture(found)
}

/**
 * Whether the Codex backend's direct images route takes stream/partial_images. Unknown until it
 * answers once; a 400 to a streamed ask turns it off (for this process) and the ask goes again
 * without, so a backend that does not stream still draws (with the estimate only).
 */
let codexDirectStreams: boolean | null = null

async function withChatGPT(user: User, model: string, r: ImageRequest, signal: AbortSignal, onPartial?: OnPartial): Promise<Made> {
  const version = chatGPTVersion(user)
  return withProviderLifetime(() => assertChatGPTVersion(user, version), (end) => onChatGPTChanged((id) => { if (id === user.id) end() }), async () => {
  const attempt = async (t: Tokens): Promise<{ res: Response; kind: 'images' | 'responses' }> => {
    // References: the Responses API, which takes input pictures. Otherwise the direct images route
    // first (what CLIProxyAPI uses for gpt-image models), the Responses API where it is missing.
    // A 400 to previews there too gets one more ask without them.
    const viaResponses = async () => {
      let res = await codexResponses(t, model, r, signal, !!onPartial)
      if (onPartial && res.status === 400) {
        await res.body?.cancel()
        res = await codexResponses(t, model, r, signal, false)
      }
      return { res, kind: 'responses' as const }
    }
    if (r.references?.length) return viaResponses()
    const ask = (stream: boolean) => fetch(`${CODEX()}/images/generations`, { method: 'POST', headers: codexHeaders(t, stream ? 'text/event-stream' : 'application/json'), body: JSON.stringify(imagesBody(model, r, stream)), signal })
    const streamed = !!onPartial && codexDirectStreams !== false
    let direct = await ask(streamed)
    if (streamed && direct.status === 400) {
      await direct.body?.cancel()
      direct = await ask(false)
      if (direct.ok) codexDirectStreams = false
    } else if (streamed && direct.ok) codexDirectStreams = true
    if (direct.status !== 404 && direct.status !== 405) return { res: direct, kind: 'images' }
    await direct.body?.cancel()
    return viaResponses()
  }
  const call = (t: Tokens) =>
    attempt(t).catch((e: Error) => {
      if (signal.aborted) throw e
      throw new HttpError(502, 'ChatGPT did not answer')
    })
  let { res, kind } = await call(await freshTokens(user, false, version, signal))
  if (res.status === 401) {
    await res.body?.cancel()
    ;({ res, kind } = await call(await freshTokens(user, true, version, signal)))
    if (res.status === 401) {
      await res.body?.cancel()
      throw new HttpError(409, 'ChatGPT refused the sign-in: sign in again in Settings → Agents → Images')
    }
  }
  if (!res.ok) throw await failure(res, 'ChatGPT')
  const made = await (kind === 'responses' ? imageFromEvents(res, onPartial) : imagesAnswer(res, 'ChatGPT', onPartial))
  assertChatGPTVersion(user, version)
  return made
  })
}

/** One picture from the provider picked in Settings, counted against the daily cap once it is made. */
async function makePicture(user: User, r: ImageRequest, signal: AbortSignal, onPartial?: OnPartial): Promise<Made> {
  const s = settings(user)
  if (s.provider === 'off') throw new HttpError(409, 'Pick an image provider in Settings → Agents → Images first')
  if (usedToday(user) >= perDay()) throw new HttpError(429, `The daily limit of ${perDay()} pictures is reached for this account; it frees up 24 hours after each one`)
  if ((r.references?.length ?? 0) > MAX_REFERENCES) throw new HttpError(400, `At most ${MAX_REFERENCES} reference pictures`)
  const limit = AbortSignal.any([signal, AbortSignal.timeout(4 * 60_000)])
  const made = await (s.provider === 'apikey' ? withApiKey(user, s.model, r, limit, onPartial) : withChatGPT(user, s.model, r, limit, onPartial)).catch((e: Error) => {
    if (limit.aborted && !signal.aborted) throw new HttpError(504, 'The picture took more than 4 minutes')
    throw e
  })
  database().prepare('INSERT INTO agent_image_usage (user_id, at) VALUES (?, ?)').run(user.id, Date.now())
  return made
}

// --- the icon library ------------------------------------------------------------------------------

/** The house style every icon is drawn in, so icons made at different times still match. */
const iconPrompt = (subject: string) =>
  `A single small app-style icon of: ${subject}. Flat vector illustration, simple bold shapes, clean dark outline, a few solid colours with soft flat shading, front view, centred, filling most of the square with a little margin. No text, no letters, no frame, no background, no ground shadow. Transparent background.`

type IconRow = { slug: string; prompt: string; body: Uint8Array; created_at: number; updated_at: number }
const iconRow = (user: User, slug: string) => database().prepare('SELECT slug, prompt, body, created_at, updated_at FROM agent_icons WHERE user_id = ? AND slug = ?').get(user.id, slug) as IconRow | undefined

export function listIcons(user: User) {
  const rows = database().prepare('SELECT slug, prompt, LENGTH(body) AS size, created_at, updated_at FROM agent_icons WHERE user_id = ? ORDER BY slug').all(user.id) as { slug: string; prompt: string; size: number; created_at: number; updated_at: number }[]
  return rows.map((r) => ({ slug: r.slug, prompt: r.prompt, size: r.size, url: `/api/agents/icons/${r.slug}`, createdAt: r.created_at, updatedAt: r.updated_at }))
}

/** An icon from the library, or a new one drawn and saved under `slug` (again, with `regenerate`). */
export async function icon(user: User, slug: string, subject: string, regenerate: boolean, signal: AbortSignal) {
  if (!SLUG.test(slug)) throw new HttpError(400, 'An icon slug is 1 to 64 of a-z, 0-9, _ and -, like diamond_pickaxe')
  const have = iconRow(user, slug)
  if (have && !regenerate) return { slug, reused: true, prompt: have.prompt, size: have.body.byteLength }
  const what = subject.trim() || have?.prompt || ''
  if (!what) throw new HttpError(400, 'Say what the icon shows')
  const made = await makePicture(user, { prompt: iconPrompt(what), size: '1024x1024', quality: 'low', background: 'transparent', format: 'png' }, signal)
  if (made.mime !== 'image/png') throw new HttpError(502, 'OpenAI did not send a PNG for the icon')
  let small: Buffer
  try {
    small = fitPng(made.bytes, ICON_SIZE)
  } catch (e) {
    throw new HttpError(502, `The icon could not be read (${(e as Error).message})`)
  }
  checkRoom(user, small.length + what.length)
  const now = Date.now()
  database()
    .prepare('INSERT INTO agent_icons (user_id, slug, prompt, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (user_id, slug) DO UPDATE SET prompt = excluded.prompt, body = excluded.body, updated_at = excluded.updated_at')
    .run(user.id, slug, what.slice(0, 1000), small, now, now)
  return { slug, reused: false, prompt: what, size: small.length }
}

/** A picture for a message: its bytes and type, to keep with the tool's result like a sent picture. */
export async function image(user: User, r: Omit<ImageRequest, 'format'>, signal: AbortSignal, onPartial?: OnPartial) {
  const made = await makePicture(user, { ...r, format: r.background === 'transparent' ? 'png' : 'webp' }, signal, onPartial)
  checkRoom(user, Math.ceil((made.bytes.length * 4) / 3))
  const ext = Object.entries(MIME).find(([, m]) => m === made.mime)?.[0] ?? 'png'
  const dims = made.mime === 'image/png' ? pngSize(made.bytes) : null
  return { ...made, ext, ...(dims ?? {}) }
}

// --- the HTTP API ----------------------------------------------------------------------------------

export async function handleOpenAIApi(req: IncomingMessage, res: ServerResponse, path: string, method: string, user: User): Promise<boolean> {
  const read = method === 'GET' || method === 'HEAD'
  if (path === '/api/agents/openai' && read) return json(res, 200, openaiImagesView(user)), true
  if (path === '/api/agents/openai' && method === 'PUT') return saveSettings(user, await readJson(req, 1024)), json(res, 200, openaiImagesView(user)), true
  if (path === '/api/agents/openai/key' && method === 'PUT') return await setKey(user, await readJson(req, 2048)), json(res, 200, openaiImagesView(user)), true
  if (path === '/api/agents/openai/key' && method === 'DELETE') {
    forget(user, KEY)
    const s = settings(user)
    if (s.provider === 'apikey' && !apiKey(user)) write(user, SETTINGS, { ...s, provider: tokens(user) ? 'chatgpt' : 'off' })
    return json(res, 200, openaiImagesView(user)), true
  }
  if (path === '/api/agents/openai/chatgpt/start' && method === 'POST') return json(res, 200, startSignIn(user, await readJson(req, 1024))), true
  if (path === '/api/agents/openai/chatgpt/finish' && method === 'POST') return await finishSignIn(user, await readJson(req, 16 * 1024), req), json(res, 200, openaiImagesView(user)), true
  if (path === '/api/agents/openai/chatgpt/cancel' && method === 'POST') return flows.delete(user.id), json(res, 200, openaiImagesView(user)), true
  if (path === '/api/agents/openai/chatgpt' && method === 'DELETE') return signOut(user), json(res, 200, openaiImagesView(user)), true
  if (path === '/api/agents/icons' && read) return json(res, 200, { icons: listIcons(user) }), true
  const one = /^\/api\/agents\/icons\/([^/]+)(\/regenerate)?$/.exec(path)
  if (!one) return false
  const slug = decodeURIComponent(one[1])
  if (!SLUG.test(slug)) throw new HttpError(404, 'No such icon')
  if (!one[2] && read) {
    const row = iconRow(user, slug)
    if (!row) throw new HttpError(404, 'No such icon')
    const tag = `"${row.updated_at}"`
    if (req.headers['if-none-match'] === tag) return res.writeHead(304, { ETag: tag, 'Cache-Control': 'private, no-cache', ...SECURITY }).end(), true
    const body = Buffer.from(row.body)
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(body.length), ETag: tag, 'Cache-Control': 'private, no-cache', ...SECURITY, ...UNTRUSTED }).end(method === 'HEAD' ? undefined : body)
    return true
  }
  if (!one[2] && method === 'DELETE') {
    database().prepare('DELETE FROM agent_icons WHERE user_id = ? AND slug = ?').run(user.id, slug)
    return json(res, 200, { icons: listIcons(user) }), true
  }
  if (one[2] && method === 'POST') {
    if (!iconRow(user, slug)) throw new HttpError(404, 'No such icon')
    const gone = new AbortController()
    res.on('close', () => !res.writableEnded && gone.abort())
    await icon(user, slug, '', true, gone.signal)
    return json(res, 200, { icons: listIcons(user) }), true
  }
  return false
}

// --- for chat on OpenAI's models (server/agentChatGPT.ts) ------------------------------------------

/** What the chat provider needs from the sign-in and the key, without handing out the stored secrets anywhere else. */
export const openaiChatAccess = { openaiUrl: OPENAI, codexUrl: CODEX, apiKey, signedIn: (user: User) => !!tokens(user), freshTokens, codexHeaders, version: chatGPTVersion, assertVersion: assertChatGPTVersion, onChanged: onChatGPTChanged }

/** The sign-in steps, for the refresh-race check (scripts/agents-chatgpt-refresh.ts) only. */
export const chatgptSignInForTest = { startSignIn, finishSignIn, signOut }
