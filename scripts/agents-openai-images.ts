// Checks the Agents app's OpenAI pictures and icon library (server/agentOpenAI.ts) end to end,
// against stand-ins: the real server (server/index.ts) on a free port with a scratch DATA_DIR and
// a signed-in account, a stand-in for Ollama that plays scripted gpt_image calls, and one fake
// for OpenAI's API, auth.openai.com and the ChatGPT Codex backend (OPENAI_URL, OPENAI_AUTH_URL,
// CHATGPT_CODEX_URL). No real key or account is ever used.
//
//   - An API key: checked before it is saved, never sent back; a picture made with it is kept
//     with the tool's result and served as a message attachment.
//   - Icons: drawn small (256 px, transparent, low quality), kept by slug, reused without drawing,
//     redrawn, deleted; GET /api/agents/icons/<slug> is the PNG or a 404; the daily cap holds.
//   - Sign in with ChatGPT: refused before the risk is accepted; the authorize address has the
//     Codex client, PKCE and the localhost redirect; the pasted callback address is checked
//     against the sign-in's state; the code is exchanged with the verifier; tokens never reach
//     the browser; an expiring token is refreshed, a refused one refreshed and retried; the
//     Responses API stands in when the direct images route is missing; Sign out forgets it.
//   - Drawing: the Images API is asked to stream previews; each one reaches the thread as it comes
//     (and is served while the picture is drawn), a window that joins halfway sees the drawing and
//     its estimate, Stop aborts the request and counts nothing; a Codex route that refuses to
//     stream still draws; the Responses API is asked for previews too.
//   - Infographics: high quality and landscape by default, portrait when asked.
//   - References: pictures from the user's messages and earlier pictures (by gpt:<id>) reach the
//     edits route as image[] (API key) or input_image (ChatGPT); unknown, foreign or too many are refused.
//
//   node scripts/agents-openai-images.ts
//
// Exits 1 on any failure.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { Server, check, finish } from './empires-harness.ts'
import { asPage } from './as-page.ts'
import { decodePng, encodePng } from '../server/pngResize.ts'

const MODEL = 'check-model'
const GOOD_KEY = 'sk-test-good-key-0001'

// --- A picture the fakes send: 1024 × 1024, a red disc on transparent -----------------------------

function disc(): string {
  const size = 1024
  const data = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      if ((x - 512) ** 2 + (y - 512) ** 2 < 400 ** 2) data.set([220, 40, 40, 255], i)
    }
  return encodePng({ width: size, height: size, data }).toString('base64')
}
const PICTURE = disc()

// --- The fake OpenAI: API, auth and Codex backend in one ------------------------------------------

type Seen = { path: string; headers: IncomingMessage['headers']; body: string }
const seen: Seen[] = []
const jwt = (claims: Record<string, unknown>) => `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`
const ID_CLAIMS = { email: 'checker@example.test', 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-check-1', chatgpt_plan_type: 'plus' } }
/** The code the fake authorize step "issued", with the challenge it was issued for. */
let issued: { code: string; challenge: string } | null = null
let accessN = 0
let refreshToken = 'refresh-1'
/** The access token the Codex fake accepts now. */
let validAccess = ''
let directImages = true
let refuseNextCodex = false
/** The Codex direct images route answers 400 to stream/partial_images (as a backend that does not stream might). */
let codexRefusesStream = false
/** A slow draw: the fake sends one preview and then waits this long before the picture (for Stop and joining halfway). */
let slowMs = 0
/** Requests whose client went away before the fake answered (Stop aborts the request). */
let abortedRequests = 0
const PREVIEW = (() => {
  const size = 64
  const data = Buffer.alloc(size * size * 4)
  for (let i = 0; i < data.length; i += 4) data.set([40, 40, 220, 255], i)
  return encodePng({ width: size, height: size, data }).toString('base64')
})()
const sse = (events: Record<string, unknown>[]) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
/** A streamed answer: the previews now, the rest after `wait` ms (unless the client has gone). */
function stream(req: IncomingMessage, res: ServerResponse, first: Record<string, unknown>[], rest: Record<string, unknown>[], wait: number) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  res.write(sse(first))
  let gone = false
  res.on('close', () => {
    if (!res.writableEnded) (gone = true), abortedRequests++
  })
  setTimeout(() => !gone && res.end(sse(rest)), wait)
}
/** The image[] parts of a multipart body (their count and types), and its text fields. */
function multipart(req: IncomingMessage, raw: Buffer) {
  const boundary = /boundary=(.+)$/.exec(req.headers['content-type'] ?? '')?.[1]?.replace(/^"|"$/g, '') ?? ''
  const fields: Record<string, string> = {}
  const images: { type: string; size: number }[] = []
  for (const part of raw.toString('latin1').split(`--${boundary}`)) {
    const head = part.slice(0, part.indexOf('\r\n\r\n'))
    const name = /name="([^"]+)"/.exec(head)?.[1]
    if (!name) continue
    const body = part.slice(head.length + 4, part.length - 2)
    if (name === 'image[]') images.push({ type: /Content-Type: (\S+)/i.exec(head)?.[1] ?? '', size: body.length })
    else fields[name] = body
  }
  return { fields, images }
}

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type }).end(typeof body === 'string' ? body : JSON.stringify(body))
}

const fake = createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', (d: Buffer) => chunks.push(d))
  req.on('end', () => {
    const bytes = Buffer.concat(chunks)
    const raw = bytes.toString('utf8')
    const path = new URL(req.url ?? '/', 'http://x').pathname
    seen.push({ path, headers: req.headers, body: raw })
    const auth = req.headers.authorization ?? ''
    // OpenAI's API
    if (path === '/v1/models') return send(res, auth === `Bearer ${GOOD_KEY}` ? 200 : 401, { data: [] })
    if (path === '/v1/images/generations') {
      if (auth !== `Bearer ${GOOD_KEY}`) return send(res, 401, { error: { message: 'bad key' } })
      const asked = JSON.parse(raw) as { stream?: boolean; partial_images?: number }
      if (!asked.stream) return send(res, 200, { data: [{ b64_json: PICTURE }] })
      const partials = Array.from({ length: asked.partial_images ?? 0 }, (_, i) => ({ type: 'image_generation.partial_image', partial_image_index: i, b64_json: PREVIEW }))
      return stream(req, res, partials.slice(0, 1), [...partials.slice(1), { type: 'image_generation.completed', b64_json: PICTURE, usage: {} }], slowMs || 400)
    }
    if (path === '/v1/images/edits') {
      if (auth !== `Bearer ${GOOD_KEY}`) return send(res, 401, { error: { message: 'bad key' } })
      const form = multipart(req, bytes)
      seen[seen.length - 1].body = JSON.stringify({ ...form.fields, images: form.images })
      if (!form.images.length) return send(res, 400, { error: { message: 'image is required' } })
      return stream(req, res, [{ type: 'image_edit.partial_image', partial_image_index: 0, b64_json: PREVIEW }], [{ type: 'image_edit.completed', b64_json: PICTURE }], 50)
    }
    // auth.openai.com
    if (path === '/oauth/token') {
      const form = new URLSearchParams(raw)
      if (form.get('client_id') !== 'app_EMoamEEZ73f0CkXaXp7hrann') return send(res, 400, { error: 'invalid_client' })
      if (form.get('grant_type') === 'authorization_code') {
        const verifier = form.get('code_verifier') ?? ''
        const ok = issued && form.get('code') === issued.code && createHash('sha256').update(verifier).digest('base64url') === issued.challenge && form.get('redirect_uri') === 'http://localhost:1455/auth/callback'
        if (!ok) return send(res, 400, { error: 'invalid_grant', error_description: 'code or verifier mismatch' })
        issued = null
      } else if (form.get('grant_type') === 'refresh_token') {
        if (form.get('refresh_token') !== refreshToken) return send(res, 400, { error: 'invalid_grant' })
        refreshToken = `refresh-${accessN + 2}`
      } else return send(res, 400, { error: 'unsupported_grant_type' })
      validAccess = `access-${++accessN}`
      return send(res, 200, { access_token: validAccess, refresh_token: refreshToken, id_token: jwt(ID_CLAIMS), expires_in: 3600, token_type: 'Bearer' })
    }
    // The ChatGPT Codex backend
    if (path === '/images/generations' || path === '/responses') {
      if (path === '/images/generations' && !directImages) return send(res, 404, { detail: 'Not Found' })
      if (refuseNextCodex || auth !== `Bearer ${validAccess}`) {
        refuseNextCodex = false
        return send(res, 401, { detail: 'token expired' })
      }
      if (req.headers['chatgpt-account-id'] !== 'acct-check-1') return send(res, 403, { detail: 'no account' })
      if (path === '/images/generations') {
        const asked = JSON.parse(raw) as { stream?: boolean }
        if (asked.stream && codexRefusesStream) return send(res, 400, { detail: 'Unsupported parameter: stream' })
        return send(res, 200, { data: [{ b64_json: PICTURE }] })
      }
      const asked = JSON.parse(raw) as { tools?: { partial_images?: number }[] }
      const partial = asked.tools?.[0]?.partial_images ? [{ type: 'response.image_generation_call.partial_image', output_index: 0, item_id: 'ig1', partial_image_index: 0, partial_image_b64: PREVIEW }] : []
      return stream(req, res, [{ type: 'response.created', response: { id: 'r1' } }, ...partial], [
        { type: 'response.output_item.done', output_index: 0, item: { type: 'image_generation_call', result: PICTURE } },
        { type: 'response.completed', response: { output: [] } },
      ], 50)
    }
    send(res, 404, { error: 'not here' })
  })
})
await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r))
const fakeUrl = `http://127.0.0.1:${(fake.address() as { port: number }).port}`

// --- The stand-in for Ollama: the scenario's gpt_image call, then an answer ------------------------

type Message = { role: string; content: string }
const CALLS: Record<string, Record<string, unknown>> = {
  image: { prompt: 'A red apple on a table', size: 'square' },
  icon: { mode: 'icon', slug: 'diamond_pickaxe', prompt: 'a diamond pickaxe' },
  icon2: { mode: 'icon', slug: 'iron_ingot', prompt: 'an iron ingot' },
  badslug: { mode: 'icon', slug: 'Diamond Pickaxe!', prompt: 'a diamond pickaxe' },
  infographic: { mode: 'infographic', prompt: 'Title banner "How a furnace works"; labelled parts; steps 1. 2. 3.' },
  portrait: { mode: 'infographic', size: 'portrait', quality: 'medium', prompt: 'A tall guide' },
  slow: { prompt: 'A slow picture', size: 'landscape' },
  badref: { prompt: 'From a web picture', references: ['https://example.test/x.png'] },
  missingref: { prompt: 'From a picture that is not here', references: ['attachment:999999:0'] },
  toomany: { prompt: 'Five pictures', references: ['gpt:000000000001', 'gpt:000000000002', 'gpt:000000000003', 'gpt:000000000004', 'gpt:000000000005'] },
}
/** refs: the ids the model can see in the thread (the picture's attachment tag, an earlier result's gpt:<id>). */
let givenRefs: string[] = []
const seenIds = (messages: Message[]) => [...new Set(messages.flatMap((m) => [...(m.content.match(/attachment:\d+:\d|gpt:[0-9a-f]{12}/g) ?? [])]))]
let lastTools: string[] = []
const ollama = createServer((req, res) => {
  let raw = ''
  req.on('data', (d) => (raw += d))
  req.on('end', () => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    if (path === '/api/tags') return send(res, 200, { models: [{ name: MODEL }] })
    if (path === '/api/show') return send(res, 200, { capabilities: ['completion', 'tools'], model_info: { 'x.context_length': 32768 } })
    if (path !== '/api/chat') return send(res, 404, {})
    const body = JSON.parse(raw) as { messages: Message[]; stream?: boolean; tools?: { function: { name: string } }[] }
    if (body.stream === false) return send(res, 200, { model: MODEL, message: { role: 'assistant', content: '{"title":"Images check"}' }, done: true })
    lastTools = (body.tools ?? []).map((t) => t.function.name)
    const at = body.messages.map((m) => m.role === 'user' && m.content.startsWith('SCENARIO ')).lastIndexOf(true)
    const scenario = body.messages[at]?.content.slice('SCENARIO '.length).split(/\s/)[0] ?? ''
    const round = body.messages.slice(at + 1).filter((m) => m.role === 'assistant').length
    const args = scenario === 'given' ? { prompt: 'From pictures elsewhere', references: givenRefs } : scenario === 'refs' ? { prompt: 'Redraw it with an orange sky', references: seenIds(body.messages.slice(0, at + 1)) } : CALLS[scenario]
    const message = round === 0 && args ? { role: 'assistant', content: '', tool_calls: [{ function: { name: 'gpt_image', arguments: args } }] } : { role: 'assistant', content: `DONE ${scenario}` }
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
    res.write(`${JSON.stringify({ model: MODEL, message, done: false })}\n`)
    res.end(`${JSON.stringify({ model: MODEL, message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 10, eval_count: 5 })}\n`)
  })
})
await new Promise<void>((r) => ollama.listen(0, '127.0.0.1', r))
const ollamaUrl = `http://127.0.0.1:${(ollama.address() as { port: number }).port}`

// --- The site, with a signed-in account -------------------------------------------------------------

const LOGIN = 'images-check'
const server = new Server({ OLLAMA_URL: ollamaUrl, OLLAMA_API_KEY: 'fake-ollama', OPENAI_URL: fakeUrl, OPENAI_AUTH_URL: fakeUrl, CHATGPT_CODEX_URL: fakeUrl, OPENAI_API_KEY: '', OPENAI_IMAGES_PER_DAY: '20', GITHUB_CLIENT_ID: 'x', GITHUB_CLIENT_SECRET: 'x', ADMIN_GITHUB_IDS: '1' })
process.env.DATA_DIR = server.data
const { database, decrypt, encrypt, sha256 } = await import('../server/db.ts')
const sid = randomBytes(24).toString('hex')
const now = Date.now()
database().prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (1, 1, ?, ?, ?, ?)').run(LOGIN, encrypt('none'), now, now)
database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, 1, ?, ?)').run(sha256(sid), now, now + 86400_000)
await server.start()

const call = async (method: string, path: string, body?: unknown) =>
  fetch(`${server.origin}${path}`, { method, headers: { Cookie: `mvlos_sid=${sid}`, ...(await asPage(sid)), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
const api = async <T = Record<string, any>>(method: string, path: string, body?: unknown): Promise<T> => {
  const res = await call(method, path, body)
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`)
  return (await res.json()) as T
}
type Saved = { id: number; role: string; content: string; toolName?: string; attachments?: { name: string; mime: string; kind: string }[] }
const newThread = async () => (await api<{ id: string }>('POST', '/api/agents/threads', { model: MODEL, mode: 'quick', tools: ['gpt_images'] })).id
/** One turn of a scenario: the gpt_image result saved in the thread, and the answer after it. */
type Event = { type: string; error?: string; callId?: string; previews?: number; width?: number; height?: number; gpt?: { expected: number; previews: number } }
async function scenario(name: string, opts: { thread?: string; attachments?: unknown[]; onEvent?: (e: Event, thread: string) => void | Promise<void> } = {}) {
  const id = opts.thread ?? (await newThread())
  const res = await call('POST', `/api/agents/threads/${id}/messages`, { text: `SCENARIO ${name}`, ...(opts.attachments ? { attachments: opts.attachments } : {}) })
  // Read as it streams, so a check can act halfway (fetch a preview, join, stop).
  const events: Event[] = []
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    buffer += decoder.decode(value, { stream: !done })
    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line) continue
      const e = JSON.parse(line) as Event
      events.push(e)
      await opts.onEvent?.(e, id)
    }
    if (done) break
  }
  const error = events.find((e) => e.type === 'error')
  const t = await api<{ messages: Saved[] }>('GET', `/api/agents/threads/${id}`)
  const tool = [...t.messages].reverse().find((m) => m.role === 'tool' && m.toolName === 'gpt_image')
  return { id, error, events, tool, result: tool ? (JSON.parse(tool.content) as Record<string, any>) : null, answered: t.messages.at(-1)?.content === `DONE ${name}` }
}
const generations = () => seen.filter((s) => s.path === '/v1/images/generations' || s.path === '/v1/images/edits' || s.path === '/images/generations' || s.path === '/responses').length
const lastGeneration = () => JSON.parse([...seen].reverse().find((s) => s.path.endsWith('/generations'))?.body ?? '{}') as Record<string, unknown>
const lastOf = (path: string) => JSON.parse([...seen].reverse().find((s) => s.path === path)?.body ?? '{}') as Record<string, any>
const usage = async () => ((await api('GET', '/api/agents/openai')).usage as { today: number }).today

try {
  // 1. Nothing set up: off, and the tool is not offered.
  let view = await api('GET', '/api/agents/openai')
  check('starts off and not ready', view.provider === 'off' && view.ready === false && view.apiKey === null && view.chatgpt === null)
  await scenario('none')
  check('gpt_image is not offered before a provider is set up', !lastTools.includes('gpt_image'))

  // 2. The API key: a refused key is not saved, a good one is, and never comes back.
  const bad = await call('PUT', '/api/agents/openai/key', { key: 'sk-test-wrong' })
  check(`a key OpenAI refuses is not saved (${bad.status})`, bad.status === 400)
  view = await api('PUT', '/api/agents/openai/key', { key: GOOD_KEY })
  check('a good key is saved and picks the API key provider', view.apiKey === 'settings' && view.provider === 'apikey' && view.ready === true)
  check('the key is never sent back', !JSON.stringify(view).includes(GOOD_KEY))
  const stored = (database().prepare("SELECT secret FROM integrations WHERE user_id = 1 AND name = 'openai'").get() as { secret: string }).secret
  check('the key is stored encrypted', !stored.includes(GOOD_KEY) && decrypt(stored).includes(GOOD_KEY))

  // 3. A picture with the key, kept with the result like a sent picture.
  let before = generations()
  const pic = await scenario('image')
  check(`image turn ran without an error${pic.error ? ` (${pic.error.error})` : ''}`, !pic.error && pic.answered)
  check('gpt_image was offered', lastTools.includes('gpt_image') && lastTools.includes('list_icons'))
  check('one picture was asked of the Images API', generations() === before + 1)
  const asked = lastGeneration()
  check('the Images API got the model, size and webp output', asked.model === 'gpt-image-2' && asked.size === '1024x1024' && asked.output_format === 'webp' && asked.n === 1)
  check('the result says the picture is shown and has no bytes', !!pic.result?.image && /shown to the user/.test(String(pic.result?.message)) && !pic.tool!.content.includes(PICTURE.slice(0, 40)))
  check('the picture is kept with the tool result', pic.tool?.attachments?.length === 1 && pic.tool.attachments[0].kind === 'image')
  const att = await call('GET', `/api/agents/threads/${pic.id}/messages/${pic.tool!.id}/attachments/0`)
  const attBytes = Buffer.from(await att.arrayBuffer())
  check('the picture is served as an attachment', att.ok && att.headers.get('content-type') === 'image/png' && attBytes.toString('base64') === PICTURE)

  // 3b. Drawing: previews streamed into the thread, served while drawing, gone after.
  check('the Images API was asked to stream two previews', asked.stream === true && asked.partial_images === 2)
  const drawStart = pic.events.find((e) => e.type === 'imageGeneration')
  check('the thread heard the drawing start, with its shape and an estimate', drawStart?.width === 1024 && drawStart.height === 1024 && (drawStart.gpt?.expected ?? 0) > 0 && drawStart.gpt?.previews === 0)
  const previews = pic.events.filter((e) => e.type === 'gptPreview' && e.callId === drawStart?.callId)
  check(`each preview reached the thread (${previews.length})`, previews.length === 2 && previews[1].previews === 2)
  const order = pic.events.map((e) => e.type)
  check('the drawing ends after the picture is saved', order.indexOf('imageGenerationDone') > pic.events.findIndex((e) => e.type === 'message' && (e as { message?: { role: string } }).message?.role === 'tool'))
  check('the result gives the picture an id to draw from again', /^gpt:[0-9a-f]{12}$/.test(String(pic.result?.image?.id)) && (pic.tool?.attachments?.[0] as { ref?: string } | undefined)?.ref === pic.result?.image?.id && String(pic.result?.message).includes(String(pic.result?.image?.id)))
  let servedPreview = ''
  let joined: Record<string, any> | null = null
  const watched = await scenario('image', {
    onEvent: async (e, thread) => {
      if (e.type !== 'gptPreview' || servedPreview) return
      const r = await call('GET', `/api/agents/threads/${thread}/gpt-preview/${e.callId}`)
      servedPreview = r.ok ? `${r.headers.get('content-type')} ${Buffer.from(await r.arrayBuffer()).toString('base64') === PREVIEW}` : String(r.status)
      joined = (await api('GET', `/api/agents/threads/${thread}`)).pending?.[0] ?? null
    },
  })
  check(`a preview is served while the picture is drawn (${servedPreview})`, servedPreview === 'image/png true')
  check('a window joining halfway sees the drawing, its estimate and how long it has run', joined?.kind === 'image' && joined.gpt?.previews >= 1 && joined.gpt.elapsed >= 0 && joined.gpt.expected > 0 && joined.width === 1024)
  const wCall = watched.events.find((e) => e.type === 'imageGeneration')?.callId
  const after = await call('GET', `/api/agents/threads/${watched.id}/gpt-preview/${wCall}`)
  check(`the preview is gone once the picture is done (${after.status})`, after.status === 404 && (await api('GET', `/api/agents/threads/${watched.id}`)).pending.length === 0)
  const foreign = await call('GET', `/api/agents/threads/00000000-0000-4000-8000-000000000000/gpt-preview/${wCall}`)
  check(`a preview of another thread is not served (${foreign.status})`, foreign.status === 404)

  // 3c. Infographics: high quality, landscape; portrait when asked.
  const info = await scenario('infographic')
  const infoAsk = lastGeneration()
  check(`an infographic defaults to high quality, landscape${info.error ? ` (${info.error.error})` : ''}`, !info.error && infoAsk.quality === 'high' && infoAsk.size === '1536x1024' && /infographic/i.test(String(infoAsk.prompt)) && /How a furnace works/.test(String(infoAsk.prompt)))
  check('the infographic shows in its landscape shape while drawn', info.events.some((e) => e.type === 'imageGeneration' && e.width === 1536 && e.height === 1024))
  await scenario('portrait')
  check('an infographic can be portrait and medium', lastGeneration().size === '1024x1536' && lastGeneration().quality === 'medium')

  // 3d. References: a sent picture and an earlier picture reach the edits route.
  const refThread = await newThread()
  const firstPic = await scenario('image', { thread: refThread })
  const firstRef = String(firstPic.result?.image?.id)
  before = generations()
  const usedBefore = await usage()
  const refs = await scenario('refs', { thread: refThread, attachments: [{ name: 'screenshot.png', source: 'computer', kind: 'image', mime: 'image/png', data: PICTURE }] })
  const edits = lastOf('/v1/images/edits')
  check(`references go to the edits route${refs.error ? ` (${refs.error.error})` : ''}`, !refs.error && generations() === before + 1 && seen.at(-1)?.path !== '/v1/images/generations' && edits.model === 'gpt-image-2')
  check(`both references arrive as image[] parts (${edits.images?.length})`, edits.images?.length === 2 && edits.images.every((i: { type: string; size: number }) => i.type === 'image/png' && i.size > 1000))
  check('the edit streams previews too', edits.stream === 'true' && refs.events.some((e) => e.type === 'gptPreview'))
  check('the result says how many references were used, and it counts as one picture', refs.result?.image?.references === 2 && (await usage()) === usedBefore + 1)
  check('the earlier picture was found by its gpt: id', firstRef.startsWith('gpt:'))
  before = generations()
  const badRef = await scenario('badref')
  check('a URL as reference is refused without drawing', /not a picture id/.test(String(badRef.result?.error)) && generations() === before)
  const missingRef = await scenario('missingref', { thread: refThread })
  check('a picture id that is not in this thread is refused', /no picture/i.test(String(missingRef.result?.error)) && generations() === before)
  givenRefs = [firstRef]
  const stolen = await scenario('given')
  check('another thread cannot draw from those pictures', /no picture/i.test(String(stolen.result?.error)) && generations() === before)
  const tooMany = await scenario('toomany')
  check('more than 4 references are refused', /At most 4/.test(String(tooMany.result?.error)) && generations() === before)

  // 3e. Stop while drawing: the request is aborted, nothing is counted or kept.
  slowMs = 20_000
  const abortedBefore = abortedRequests
  const usedNow = await usage()
  let stopped = false
  const slow = await scenario('slow', {
    onEvent: async (e, thread) => {
      if (e.type === 'gptPreview' && !stopped) {
        stopped = true
        await api('POST', `/api/agents/threads/${thread}/stop`, {})
      }
    },
  })
  slowMs = 0
  await new Promise((r) => setTimeout(r, 200))
  const slowThread = await api('GET', `/api/agents/threads/${slow.id}`)
  check('Stop while drawing ends the turn and the drawing', stopped && slow.events.some((e) => e.type === 'done') && slow.events.some((e) => e.type === 'imageGenerationDone') && !slow.events.some((e) => e.type === 'error'))
  check(`Stop aborts the request to OpenAI (${abortedRequests - abortedBefore})`, abortedRequests === abortedBefore + 1)
  check('a stopped picture is not counted and leaves nothing waiting', (await usage()) === usedNow && slowThread.pending.length === 0 && !(slowThread.messages as Saved[]).some((m) => m.attachments?.length))
  // The cap checks below count from here: the first picture only.
  database().prepare('DELETE FROM agent_image_usage WHERE user_id = 1').run()
  database().prepare('INSERT INTO agent_image_usage (user_id, at) VALUES (1, ?)').run(Date.now())

  // 4. Icons: drawn small, kept by slug, reused, served, listed.
  const missing = await call('GET', '/api/agents/icons/diamond_pickaxe')
  check(`a missing icon is a 404 (${missing.status})`, missing.status === 404)
  before = generations()
  const ic = await scenario('icon')
  check(`icon turn ran without an error${ic.error ? ` (${ic.error.error})` : ''}`, !ic.error && ic.answered)
  const iconAsk = lastGeneration()
  check('the icon was asked transparent, low quality, PNG, square', generations() === before + 1 && iconAsk.background === 'transparent' && iconAsk.quality === 'low' && iconAsk.output_format === 'png' && iconAsk.size === '1024x1024')
  check('the icon prompt carries the house style', /diamond pickaxe/.test(String(iconAsk.prompt)) && /Transparent background/.test(String(iconAsk.prompt)))
  check('the result names icon:diamond_pickaxe and was not reused', ic.result?.icon?.reference === 'icon:diamond_pickaxe' && ic.result?.icon?.reused === false && /icon:diamond_pickaxe/.test(String(ic.result?.message)))
  const got = await call('GET', '/api/agents/icons/diamond_pickaxe')
  const png = Buffer.from(await got.arrayBuffer())
  const decoded = got.ok ? decodePng(png) : null
  check('GET /api/agents/icons/diamond_pickaxe is a 256 px PNG', got.headers.get('content-type') === 'image/png' && decoded?.width === 256 && decoded.height === 256)
  check('the icon keeps its transparent corners and its red middle', !!decoded && decoded.data[3] === 0 && decoded.data[(128 * 256 + 128) * 4] > 200 && decoded.data[(128 * 256 + 128) * 4 + 3] === 255)
  const etag = got.headers.get('etag')
  const cached = await fetch(`${server.origin}/api/agents/icons/diamond_pickaxe`, { headers: { Cookie: `mvlos_sid=${sid}`, 'If-None-Match': etag ?? '' } })
  check('an unchanged icon answers 304 to its ETag', cached.status === 304)
  const stranger = await fetch(`${server.origin}/api/agents/icons/diamond_pickaxe`)
  check(`an icon is not served without signing in (${stranger.status})`, stranger.status === 401 || stranger.status === 403)
  before = generations()
  const again = await scenario('icon')
  check('asking for an existing slug reuses it without drawing', generations() === before && again.result?.icon?.reused === true)
  const badSlug = await scenario('badslug')
  check('a slug outside [a-z0-9_-] is refused', /slug/.test(String(badSlug.result?.error)))
  let icons = (await api<{ icons: { slug: string; updatedAt: number }[] }>('GET', '/api/agents/icons')).icons
  check('the list has the icon', icons.length === 1 && icons[0].slug === 'diamond_pickaxe')
  before = generations()
  const firstAt = icons[0].updatedAt
  await new Promise((r) => setTimeout(r, 5))
  icons = (await api<{ icons: { slug: string; updatedAt: number }[] }>('POST', '/api/agents/icons/diamond_pickaxe/regenerate', {})).icons
  check('Redraw draws it again from its saved description', generations() === before + 1 && icons[0].updatedAt > firstAt && /diamond pickaxe/.test(String(lastGeneration().prompt)))

  // 5. The daily cap.
  const used = (await api('GET', '/api/agents/openai')).usage as { today: number; limit: number }
  check(`usage counts each picture (${used.today} of ${used.limit})`, used.today === 3 && used.limit === 20)
  const fill = database().prepare('INSERT INTO agent_image_usage (user_id, at) VALUES (1, ?)')
  for (let i = used.today; i < used.limit; i++) fill.run(Date.now())
  before = generations()
  const capped = await call('POST', '/api/agents/icons/diamond_pickaxe/regenerate', {})
  check(`over the daily cap nothing is drawn (${capped.status})`, capped.status === 429 && generations() === before)
  database().prepare('DELETE FROM agent_image_usage WHERE user_id = 1').run()

  // 6. Sign in with ChatGPT: the risk first, then PKCE and the pasted callback address.
  const noRisk = await call('POST', '/api/agents/openai/chatgpt/start', {})
  check(`the sign-in does not start before the risk is accepted (${noRisk.status})`, noRisk.status === 400 && /risk/i.test(await noRisk.text()))
  const started = await api<{ url: string }>('POST', '/api/agents/openai/chatgpt/start', { acceptedRisk: true })
  const authorize = new URL(started.url)
  const q = authorize.searchParams
  check('the authorize address is auth.openai.com’s, with the Codex client and PKCE', authorize.pathname === '/oauth/authorize' && q.get('client_id') === 'app_EMoamEEZ73f0CkXaXp7hrann' && q.get('response_type') === 'code' && q.get('redirect_uri') === 'http://localhost:1455/auth/callback' && q.get('scope') === 'openid email profile offline_access' && q.get('code_challenge_method') === 'S256' && (q.get('code_challenge') ?? '').length >= 43 && !!q.get('state'))
  issued = { code: 'code-from-openai', challenge: q.get('code_challenge')! }
  const wrongState = await call('POST', '/api/agents/openai/chatgpt/finish', { callback: `http://localhost:1455/auth/callback?code=${issued.code}&state=someone-else` })
  check(`a callback with another state is refused (${wrongState.status})`, wrongState.status === 400)
  const noCode = await call('POST', '/api/agents/openai/chatgpt/finish', { callback: 'http://localhost:1455/auth/callback?state=x' })
  check('a callback without a code is refused', noCode.status === 400)
  view = await api('POST', '/api/agents/openai/chatgpt/finish', { callback: `http://localhost:1455/auth/callback?code=${issued.code}&scope=openid&state=${q.get('state')}` })
  check('the pasted callback signs in, with the email and plan from the ID token', view.chatgpt?.email === 'checker@example.test' && view.chatgpt?.plan === 'plus')
  check('no token reaches the browser', !/access-|refresh-|code-from/.test(JSON.stringify(view)))
  const replay = await call('POST', '/api/agents/openai/chatgpt/finish', { callback: `http://localhost:1455/auth/callback?code=code-from-openai&state=${q.get('state')}` })
  check('the same callback cannot be used twice', replay.status === 409)
  const tokenRow = () => database().prepare("SELECT secret FROM integrations WHERE user_id = 1 AND name = 'openai-chatgpt'").get() as { secret: string }
  check('the tokens are stored encrypted', !tokenRow().secret.includes('access-') && decrypt(tokenRow().secret).includes(validAccess))

  // 7. Pictures through the Codex backend: direct, refreshed, retried, and through Responses.
  view = await api('PUT', '/api/agents/openai', { provider: 'chatgpt' })
  check('ChatGPT can be picked', view.provider === 'chatgpt' && view.ready)
  const viaChat = await scenario('image')
  const direct = [...seen].reverse().find((s) => s.path === '/images/generations')
  check(`a picture through ChatGPT${viaChat.error ? ` (${viaChat.error.error})` : ''}`, !viaChat.error && viaChat.tool?.attachments?.length === 1)
  check('the direct Codex route was asked to stream previews', JSON.parse(direct?.body ?? '{}').stream === true)
  check('the Codex backend got the access token, the account and the Codex originator', direct?.headers.authorization === 'Bearer access-1' && direct.headers['chatgpt-account-id'] === 'acct-check-1' && direct.headers.originator === 'codex-tui')
  // Expiring in a minute: refreshed first.
  const t = JSON.parse(decrypt(tokenRow().secret)) as { expires: number }
  database().prepare("UPDATE integrations SET secret = ? WHERE user_id = 1 AND name = 'openai-chatgpt'").run(encrypt(JSON.stringify({ ...t, expires: Date.now() + 60_000 })))
  const refreshes = () => seen.filter((s) => s.path === '/oauth/token' && new URLSearchParams(s.body).get('grant_type') === 'refresh_token').length
  let r0 = refreshes()
  const refreshed = await scenario('image')
  check('an expiring token is refreshed before the picture', !refreshed.error && refreshes() === r0 + 1 && [...seen].reverse().find((s) => s.path === '/images/generations')?.headers.authorization === 'Bearer access-2')
  // Refused by the backend: refreshed once and retried.
  refuseNextCodex = true
  r0 = refreshes()
  const retried = await scenario('image')
  check('a refused token is refreshed and the picture retried', !retried.error && retried.tool?.attachments?.length === 1 && refreshes() === r0 + 1)
  // No direct images route: the Responses API with the image_generation tool.
  directImages = false
  const viaResponses = await scenario('icon2')
  const responses = [...seen].reverse().find((s) => s.path === '/responses')
  const rb = JSON.parse(responses?.body ?? '{}') as { tools?: { type: string; model?: string; background?: string }[]; tool_choice?: { type: string }; stream?: boolean }
  check('without the direct route, the Responses API makes it', !viaResponses.error && responses !== undefined && rb.stream === true && rb.tool_choice?.type === 'image_generation' && rb.tools?.[0]?.type === 'image_generation' && rb.tools[0].background === 'transparent')
  check('icons are drawn without previews', (rb.tools?.[0] as { partial_images?: number })?.partial_images === undefined)
  const viaResponsesPic = await scenario('image')
  const rpb = lastOf('/responses')
  check(`a picture through the Responses API streams previews${viaResponsesPic.error ? ` (${viaResponsesPic.error.error})` : ''}`, !viaResponsesPic.error && rpb.tools?.[0]?.partial_images === 2 && viaResponsesPic.events.some((e) => e.type === 'gptPreview'))
  directImages = true
  // References through ChatGPT: the Responses API, with input_image items.
  const chatRefThread = await newThread()
  await scenario('image', { thread: chatRefThread })
  const chatRefs = await scenario('refs', { thread: chatRefThread, attachments: [{ name: 'shot.png', source: 'computer', kind: 'image', mime: 'image/png', data: PICTURE }] })
  const crb = lastOf('/responses')
  const content = (crb.input?.[0]?.content ?? []) as { type: string; image_url?: string }[]
  check(`references through ChatGPT go to the Responses API as input_image${chatRefs.error ? ` (${chatRefs.error.error})` : ''}`, !chatRefs.error && content.filter((c) => c.type === 'input_image' && c.image_url?.startsWith('data:image/png;base64,')).length === 2 && crb.tools?.[0]?.action === 'edit')
  // A direct route that refuses to stream: asked again without, and still draws.
  codexRefusesStream = true
  const directBefore = seen.filter((x) => x.path === '/images/generations').length
  const noStream = await scenario('image')
  const directAsks = seen.filter((x) => x.path === '/images/generations').slice(directBefore)
  check(`a Codex route that refuses to stream still draws${noStream.error ? ` (${noStream.error.error})` : ''}`, !noStream.error && noStream.tool?.attachments?.length === 1 && directAsks.length === 2 && JSON.parse(directAsks[1].body).stream === undefined)
  check('it shows the drawing (estimate only) without previews', noStream.events.some((e) => e.type === 'imageGeneration') && !noStream.events.some((e) => e.type === 'gptPreview'))
  const later = await scenario('image')
  check('later pictures skip streaming on that route', !later.error && JSON.parse([...seen].reverse().find((x) => x.path === '/images/generations')!.body).stream === undefined)
  codexRefusesStream = false

  // 8. Sign out: the tokens go, the API key takes over.
  view = await api('DELETE', '/api/agents/openai/chatgpt')
  check('Sign out forgets the tokens and falls back to the API key', view.chatgpt === null && view.provider === 'apikey' && !database().prepare("SELECT 1 FROM integrations WHERE user_id = 1 AND name = 'openai-chatgpt'").get())

  // 9. Delete an icon; removing the key turns it all off.
  icons = (await api<{ icons: { slug: string }[] }>('DELETE', '/api/agents/icons/diamond_pickaxe')).icons
  check('a deleted icon is gone', icons.length === 1 && icons[0].slug === 'iron_ingot' && (await call('GET', '/api/agents/icons/diamond_pickaxe')).status === 404)
  view = await api('DELETE', '/api/agents/openai/key')
  check('removing the key turns pictures off', view.provider === 'off' && view.ready === false && view.apiKey === null)
} catch (e) {
  check(`ran to the end (${(e as Error).message})`, false)
  console.error(server.log)
} finally {
  await server.dispose()
  fake.close()
  ollama.close()
}
finish()
