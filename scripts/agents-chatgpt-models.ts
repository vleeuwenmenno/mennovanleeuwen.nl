// Checks OpenAI's models as a chat provider for the Agents app (server/agentChatGPT.ts) end to end,
// against stand-ins: the real server (server/index.ts) on a free port with a scratch DATA_DIR and a
// signed-in account, a stand-in for Ollama (titles and its own model list), and one fake for the
// ChatGPT Codex backend, auth.openai.com and OpenAI's public API (CHATGPT_CODEX_URL,
// OPENAI_AUTH_URL, OPENAI_URL). No real key or account is ever used.
//
//   - The model list: ChatGPT's own (/models?client_version=…, hidden ones left out) next to Ollama's,
//     with display names, context windows and thinking levels; the API key adds the API's chat models.
//   - A thread on chatgpt/<slug>: the Codex request shape (instructions empty, the system prompt as
//     a developer message, store false, stream true, encrypted reasoning, parallel tool calls,
//     function tools, the Codex headers), streamed text and reasoning summary, usage for the ring.
//   - Tools: two calls in one reply run and go back as function_call_output with matching call ids.
//   - Thinking effort: quick low, deep high, a picked level per thread.
//   - Pictures in a user message go as input_image data URLs.
//   - Stop aborts the request; a refused token is refreshed mid-thread and the call retried; an
//     expiring one refreshed first; the backend's errors are shown as they are.
//   - The API key route: /v1/responses with the key.
//
//   node scripts/agents-chatgpt-models.ts
//
// Exits 1 on any failure.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { Server, check, finish, sleep, waitFor } from './empires-harness.ts'
import { asPage } from './as-page.ts'

const OLLAMA_MODEL = 'glm-5.3'
const API_KEY = 'sk-test-chat-key-0001'
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

// --- The fake OpenAI: Codex backend, auth and the public API -------------------------------------

type Seen = { path: string; headers: IncomingMessage['headers']; body: string }
const seen: Seen[] = []
let accessN = 1
let validAccess = 'access-1'
let refreshToken = 'refresh-1'
let refuseNext = false
/** Whether the slow scenario's request was closed by us before it ended. */
let slowClosed = false
let slowStarted = false
/** What the tools round trip found in the second request. */
let pairing: { calls: string[]; outputs: string[] } | null = null

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type }).end(typeof body === 'string' ? body : JSON.stringify(body))
}
const sse = (events: Record<string, unknown>[]) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
const completed = (total: number) => ({ type: 'response.completed', response: { id: 'r', usage: { input_tokens: total - 20, output_tokens: 20, total_tokens: total } } })
const text = (t: string) => [
  { type: 'response.created', response: { id: 'r' } },
  { type: 'response.output_text.delta', delta: t.slice(0, 4) },
  { type: 'response.output_text.delta', delta: t.slice(4) },
]

type Item = { type: string; role?: string; content?: { type: string; text?: string; image_url?: string }[]; call_id?: string; name?: string; output?: string }

/** The scenario a Responses request plays, from the last user message starting with SCENARIO, and its round. */
function scenarioOf(input: Item[]) {
  const at = input.map((i) => i.type === 'message' && i.role === 'user' && !!i.content?.[0]?.text?.startsWith('SCENARIO ')).lastIndexOf(true)
  const name = input[at]?.content?.[0]?.text?.slice('SCENARIO '.length).split(/\s/)[0] ?? ''
  const round = input.slice(at + 1).filter((i) => i.type === 'function_call_output').length ? 1 : 0
  return { name, round, after: input.slice(at + 1) }
}

function responses(req: IncomingMessage, res: ServerResponse, raw: string) {
  const body = JSON.parse(raw) as { input: Item[] }
  const { name, round, after } = scenarioOf(body.input)
  if (name === 'fail') return send(res, 429, { detail: 'You have hit your ChatGPT usage limit (try again in 2h).' })
  if (name === 'toolong') return send(res, 400, { error: { message: 'Your input exceeds the context window of this model.', code: 'context_length_exceeded' } })
  if (name === 'slow') {
    slowStarted = true
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(sse(text('Thinking about it slowly')))
    res.on('close', () => (slowClosed = !res.writableEnded))
    return
  }
  if (name === 'tools' && round === 0)
    return send(
      res,
      200,
      sse([
        { type: 'response.created', response: { id: 'r' } },
        { type: 'response.reasoning_summary_text.delta', summary_index: 0, delta: 'Two searches at once.' },
        { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_srv_A', name: 'search_threads', arguments: '{"query":"apples"}' } },
        { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_srv_B', name: 'search_threads', arguments: '{"query":"pears"}' } },
        completed(900),
      ]),
      'text/event-stream',
    )
  if (name === 'tools') pairing = { calls: after.filter((i) => i.type === 'function_call').map((i) => i.call_id!), outputs: after.filter((i) => i.type === 'function_call_output').map((i) => i.call_id!) }
  const sees = body.input.some((i) => i.content?.some((c) => c.type === 'input_image' && c.image_url?.startsWith('data:image/png;base64,')))
  return send(
    res,
    200,
    sse([
      ...(name === 'text' ? [{ type: 'response.reasoning_summary_text.delta', summary_index: 0, delta: 'First part.' }, { type: 'response.reasoning_summary_text.delta', summary_index: 1, delta: 'Second part.' }] : []),
      ...text(`DONE ${name}${sees ? ' saw a picture' : ''}`),
      completed(1234),
    ]),
    'text/event-stream',
  )
}

const fake = createServer((req, res) => {
  let raw = ''
  req.on('data', (d) => (raw += d))
  req.on('end', () => {
    const url = new URL(req.url ?? '/', 'http://x')
    const path = url.pathname
    seen.push({ path: path + url.search, headers: req.headers, body: raw })
    const auth = req.headers.authorization ?? ''
    if (path === '/oauth/token') {
      const form = new URLSearchParams(raw)
      if (form.get('grant_type') !== 'refresh_token' || form.get('refresh_token') !== refreshToken) return send(res, 400, { error: 'invalid_grant' })
      refreshToken = `refresh-${++accessN}`
      validAccess = `access-${accessN}`
      return send(res, 200, { access_token: validAccess, refresh_token: refreshToken, expires_in: 3600 })
    }
    // The public API
    if (path === '/v1/models') {
      if (auth !== `Bearer ${API_KEY}`) return send(res, 401, { error: { message: 'bad key' } })
      return send(res, 200, { data: [{ id: 'gpt-5-mini' }, { id: 'gpt-4o' }, { id: 'text-embedding-3-small' }, { id: 'gpt-image-2' }, { id: 'tts-1' }, { id: 'gpt-4o-2024-08-06' }] })
    }
    if (path === '/v1/responses') {
      if (auth !== `Bearer ${API_KEY}`) return send(res, 401, { error: { message: 'bad key' } })
      return responses(req, res, raw)
    }
    // The Codex backend
    if (path === '/models' || path === '/responses') {
      if (refuseNext || auth !== `Bearer ${validAccess}`) {
        refuseNext = false
        return send(res, 401, { detail: 'token expired' })
      }
      if (req.headers['chatgpt-account-id'] !== 'acct-chat-1') return send(res, 403, { detail: 'no account' })
      if (path === '/models')
        return send(res, 200, {
          models: [
            { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', context_window: 272000, default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }], input_modalities: ['text', 'image'], priority: 2 },
            { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', visibility: 'list', context_window: 272000, default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }, { effort: 'max' }], input_modalities: ['text', 'image'], priority: 1 },
            { slug: 'codex-auto-review', display_name: 'Codex Auto Review', visibility: 'hide', context_window: 272000, supported_reasoning_levels: [{ effort: 'low' }] },
          ],
        })
      return responses(req, res, raw)
    }
    send(res, 404, { error: 'not here' })
  })
})
await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r))
const fakeUrl = `http://127.0.0.1:${(fake.address() as { port: number }).port}`

// --- The stand-in for Ollama: its model list and titles -----------------------------------------------

const ollama = createServer((req, res) => {
  let raw = ''
  req.on('data', (d) => (raw += d))
  req.on('end', () => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    if (path === '/api/tags') return send(res, 200, { models: [{ name: OLLAMA_MODEL }] })
    if (path === '/api/show') return send(res, 200, { capabilities: ['completion', 'tools', 'thinking'], model_info: { 'x.context_length': 200000 } })
    if (path !== '/api/chat') return send(res, 404, {})
    const body = JSON.parse(raw) as { stream?: boolean }
    if (body.stream === false) return send(res, 200, { message: { role: 'assistant', content: '{"title":"Chat check"}' }, done: true })
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
    res.end(`${JSON.stringify({ message: { role: 'assistant', content: 'OLLAMA' }, done: true, prompt_eval_count: 5, eval_count: 1 })}\n`)
  })
})
await new Promise<void>((r) => ollama.listen(0, '127.0.0.1', r))
const ollamaUrl = `http://127.0.0.1:${(ollama.address() as { port: number }).port}`

// --- The site, with a signed-in account and a ChatGPT sign-in --------------------------------------

const LOGIN = 'chat-check'
const server = new Server({ OLLAMA_URL: ollamaUrl, OLLAMA_API_KEY: 'fake-ollama', OPENAI_URL: fakeUrl, OPENAI_AUTH_URL: fakeUrl, CHATGPT_CODEX_URL: fakeUrl, OPENAI_API_KEY: '', GITHUB_CLIENT_ID: 'x', GITHUB_CLIENT_SECRET: 'x', ADMIN_GITHUB_IDS: '1' })
process.env.DATA_DIR = server.data
const { database, encrypt } = await import('../server/db.ts')
const { sha256 } = await import('../server/db.ts')
const sid = randomBytes(24).toString('hex')
const now = Date.now()
database().prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (1, 1, ?, ?, ?, ?)').run(LOGIN, encrypt('none'), now, now)
database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, 1, ?, ?)').run(sha256(sid), now, now + 86400_000)
const setTokens = (expires: number) =>
  database()
    .prepare("INSERT INTO integrations (user_id, name, secret, created_at) VALUES (1, 'openai-chatgpt', ?, ?) ON CONFLICT (user_id, name) DO UPDATE SET secret = excluded.secret")
    .run(encrypt(JSON.stringify({ access: validAccess, refresh: refreshToken, accountId: 'acct-chat-1', email: 'checker@example.test', plan: 'plus', expires })), Date.now())
setTokens(Date.now() + 3600_000)
await server.start()

const call = async (method: string, path: string, body?: unknown, signal?: AbortSignal) =>
  fetch(`${server.origin}${path}`, { method, headers: { Cookie: `mvlos_sid=${sid}`, ...(await asPage(sid)), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal })
const api = async <T = Record<string, any>>(method: string, path: string, body?: unknown): Promise<T> => {
  const res = await call(method, path, body)
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`)
  return (await res.json()) as T
}
type Model = { name: string; label?: string; provider?: string; efforts?: string[]; contextLength: number | null; vision: boolean }
type Saved = { id: number; role: string; content: string; thinking?: string; toolName?: string; toolCalls?: { name: string; arguments: Record<string, unknown> }[] }
type Ev = { type: string; error?: string; content?: string; thinking?: string }
const thread = async (model: string, mode = 'quick', tools: string[] = ['threads']) => (await api<{ id: string }>('POST', '/api/agents/threads', { model, mode, tools })).id
async function turn(id: string, scenario: string, attachments: unknown[] = []) {
  const res = await call('POST', `/api/agents/threads/${id}/messages`, { text: `SCENARIO ${scenario}`, attachments })
  const events = (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l) as Ev)
  const t = await api<{ thread: { contextTokens: number | null; running: boolean; effort: string | null }; messages: Saved[] }>('GET', `/api/agents/threads/${id}`)
  return { events, error: events.find((e) => e.type === 'error')?.error, messages: t.messages, thread: t.thread, last: t.messages.at(-1) }
}
const lastResponses = (path = '/responses') => {
  const s = [...seen].reverse().find((x) => x.path === path)
  return { headers: s?.headers ?? {}, body: JSON.parse(s?.body ?? '{}') as Record<string, any> }
}
const count = (path: string) => seen.filter((s) => s.path.startsWith(path)).length

try {
  // 1. The model list: Ollama's and ChatGPT's, hidden ones left out.
  let list = await api<Model[]>('GET', '/api/agents/models')
  const g55 = list.find((m) => m.name === 'chatgpt/gpt-5.5')
  check('Ollama’s models are still there, marked as Ollama’s, with on/off thinking', list.some((m) => m.name === OLLAMA_MODEL && m.provider === 'ollama' && m.efforts?.join() === 'off,on'))
  check('ChatGPT’s models are listed with their names, context and levels', !!g55 && g55.label === 'GPT-5.5' && g55.provider === 'chatgpt' && g55.contextLength === 272000 && g55.vision && g55.efforts?.join() === 'low,medium,high,xhigh')
  check('hidden Codex models are left out', !list.some((m) => m.name.includes('codex-auto-review')))
  const modelsAsk = seen.find((s) => s.path.startsWith('/models'))
  check('the model list is asked with a client version and the Codex headers', !!modelsAsk && /client_version=/.test(modelsAsk.path) && modelsAsk.headers.originator === 'codex-tui' && modelsAsk.headers['chatgpt-account-id'] === 'acct-chat-1')
  check('no token reaches the browser', !JSON.stringify(list).includes('access-') && !JSON.stringify(list).includes('refresh-'))

  // 2. Streamed text and reasoning summary, the request shape, usage.
  const a = await thread('chatgpt/gpt-5.5')
  const r1 = await turn(a, 'text')
  check(`a ChatGPT thread answers${r1.error ? ` (${r1.error})` : ''}`, !r1.error && r1.last?.role === 'assistant' && r1.last.content === 'DONE text')
  check('the answer streamed in pieces', r1.events.filter((e) => e.type === 'delta' && e.content).length >= 2)
  check('the reasoning summary is kept as thinking, parts on their own lines', r1.last?.thinking === 'First part.\n\nSecond part.')
  const q1 = lastResponses()
  const b1 = q1.body
  check('the request names the slug, not the prefixed id', b1.model === 'gpt-5.5')
  check('instructions empty, the prompt as a developer message', b1.instructions === '' && b1.input?.[0]?.type === 'message' && b1.input[0].role === 'developer' && b1.input[0].content?.[0]?.type === 'input_text' && b1.input[0].content[0].text.length > 100)
  check('store false, stream true, parallel tool calls, encrypted reasoning', b1.store === false && b1.stream === true && b1.parallel_tool_calls === true && b1.include?.[0] === 'reasoning.encrypted_content')
  check('quick asks for low effort with a summary', b1.reasoning?.effort === 'low' && b1.reasoning?.summary === 'auto')
  check('tools go as function tools, strict off', Array.isArray(b1.tools) && b1.tools.every((t: { type: string; strict: boolean; name: string; parameters: unknown }) => t.type === 'function' && t.strict === false && !!t.name && !!t.parameters) && b1.tools.some((t: { name: string }) => t.name === 'search_threads'))
  check('the Codex headers go along', q1.headers.authorization === `Bearer ${validAccess}` && q1.headers.originator === 'codex-tui' && q1.headers['chatgpt-account-id'] === 'acct-chat-1' && q1.headers.accept === 'text/event-stream' && !!q1.headers['session_id'])
  check('the usage fills the context ring', r1.thread.contextTokens === 1234)
  const ctx = await api<{ contextLength: number | null }>('GET', `/api/agents/threads/${a}/context`)
  check('the context breakdown knows the model’s window', ctx.contextLength === 272000)

  // 3. Two tool calls in one reply, results back with matching call ids.
  const r2 = await turn(a, 'tools')
  const calls = r2.messages.filter((m) => m.role === 'assistant' && m.toolCalls?.length).at(-1)
  const results = r2.messages.filter((m) => m.role === 'tool' && m.toolName === 'search_threads')
  check(`both calls ran${r2.error ? ` (${r2.error})` : ''}`, !r2.error && calls?.toolCalls?.length === 2 && results.length === 2 && calls.toolCalls[1].arguments.query === 'pears')
  check('the results went back paired with their calls', !!pairing && pairing.calls.length === 2 && pairing.outputs.length === 2 && pairing.calls.every((c, i) => pairing!.outputs[i] === c))
  check('the turn answered after the tools', r2.last?.content === 'DONE tools')
  check('earlier turns go back as assistant output text', lastResponses().body.input.some((i: Item) => i.type === 'message' && i.role === 'assistant' && i.content?.[0]?.type === 'output_text' && i.content[0].text === 'DONE text'))

  // 4. Thinking effort: picked per thread, deep is high.
  let t = await api<{ effort: string | null }>('PATCH', `/api/agents/threads/${a}`, { effort: 'xhigh' })
  check('a thread keeps a picked effort', t.effort === 'xhigh')
  await turn(a, 'again')
  check('the picked effort is asked for', lastResponses().body.reasoning?.effort === 'xhigh')
  const bad = await call('PATCH', `/api/agents/threads/${a}`, { effort: 'loud' })
  check(`a made-up effort is refused (${bad.status})`, bad.status === 400)
  t = await api('PATCH', `/api/agents/threads/${a}`, { effort: null })
  check('null goes back to the mode', t.effort === null)
  const d = await thread('chatgpt/gpt-6-astra', 'deep')
  await turn(d, 'deep')
  check('deep asks for high effort', lastResponses().body.reasoning?.effort === 'high' && lastResponses().body.model === 'gpt-6-astra')
  const off = await thread('chatgpt/gpt-5.5')
  await api('PATCH', `/api/agents/threads/${off}`, { effort: 'off' })
  await turn(off, 'off')
  check('off on a model without it asks for its lowest', lastResponses().body.reasoning?.effort === 'low')

  // 5. A picture in the message.
  const pic = await turn(a, 'picture', [{ name: 'dot.png', source: 'This computer', kind: 'image', mime: 'image/png', size: 68, data: PNG }])
  check(`a picture goes as an input_image data URL${pic.error ? ` (${pic.error})` : ''}`, pic.last?.content === 'DONE picture saw a picture')

  // 6. Stop aborts the request.
  const s = await thread('chatgpt/gpt-5.5')
  const stopping = call('POST', `/api/agents/threads/${s}/messages`, { text: 'SCENARIO slow' }).then((r) => r.text())
  await waitFor('the slow reply starts', () => slowStarted, 8000)
  await sleep(200)
  await api('POST', `/api/agents/threads/${s}/stop`)
  await stopping
  await waitFor('the request is closed', () => slowClosed, 5000).catch(() => {})
  const stopped = await api<{ thread: { running: boolean } }>('GET', `/api/agents/threads/${s}`)
  check('Stop closes the request to ChatGPT and the thread rests', slowClosed && !stopped.thread.running)

  // 7. Tokens: refused mid-thread, refreshed and retried; expiring, refreshed first.
  const refreshes = () => seen.filter((x) => x.path === '/oauth/token').length
  let before = refreshes()
  refuseNext = true
  const r7 = await turn(a, 'refused')
  check(`a refused token is refreshed and the call retried${r7.error ? ` (${r7.error})` : ''}`, !r7.error && r7.last?.content.startsWith('DONE refused') && refreshes() === before + 1 && lastResponses().headers.authorization === `Bearer ${validAccess}`)
  setTokens(Date.now() + 60_000)
  before = refreshes()
  const r8 = await turn(a, 'expiring')
  check('an expiring token is refreshed before the call', !r8.error && refreshes() === before + 1)

  // 8. Errors as the backend words them; too long counts as too long.
  const r9 = await turn(a, 'fail')
  check(`a usage limit shows plainly (${r9.error})`, /usage limit/.test(r9.error ?? '') && /ChatGPT/.test(r9.error ?? ''))
  const r10 = await turn(await thread('chatgpt/gpt-5.5'), 'toolong')
  check(`too long is said as too long (${r10.error})`, /context window/.test(r10.error ?? ''))

  // 9. The API key: its chat models, and a thread on /v1/responses.
  await api('PUT', '/api/agents/openai/key', { key: API_KEY })
  list = await api<Model[]>('GET', '/api/agents/models')
  const apiModels = list.filter((m) => m.provider === 'openai').map((m) => m.name)
  check(`the API's chat models are listed, nothing else (${apiModels.join(', ')})`, apiModels.join() === 'openai/gpt-4o,openai/gpt-5-mini')
  check('gpt-5-mini takes minimal to high', list.find((m) => m.name === 'openai/gpt-5-mini')?.efforts?.join() === 'minimal,low,medium,high')
  const k = await thread('openai/gpt-5-mini')
  const before9 = count('/v1/responses')
  const r11 = await turn(k, 'apikey')
  const q11 = lastResponses('/v1/responses')
  check(`an API key thread answers through /v1/responses${r11.error ? ` (${r11.error})` : ''}`, !r11.error && r11.last?.content === 'DONE apikey' && count('/v1/responses') === before9 + 1)
  check('with the key and the same request shape', q11.headers.authorization === `Bearer ${API_KEY}` && q11.body.model === 'gpt-5-mini' && q11.body.store === false && q11.body.reasoning?.effort === 'low')
  const nr = await thread('openai/gpt-4o')
  await turn(nr, 'plain')
  check('a model that cannot reason gets no reasoning field', lastResponses('/v1/responses').body.reasoning === undefined)

  // 10. Ollama threads are untouched.
  const o = await thread(OLLAMA_MODEL)
  const r12 = await turn(o, 'ollama')
  check('an Ollama thread still runs on Ollama', !r12.error && r12.last?.content === 'OLLAMA')

  // 11. Always-on skills reach ChatGPT threads too, in the developer message.
  const saved = await call('PUT', '/api/agents/skill-config', { always: ['caveman-adhd'] })
  check(`always-on skills can be switched on (${saved.status})`, saved.ok)
  await turn(a, 'skills')
  const dev = lastResponses().body.input?.[0]
  check('an always-on skill is in a ChatGPT thread’s developer message', dev?.role === 'developer' && String(dev.content?.[0]?.text).includes('<active_skill name="caveman-adhd">'))
  await call('PUT', '/api/agents/skill-config', { always: [] })

  // 12. No Ollama key, but ChatGPT: the app is open to them, and a new thread runs on ChatGPT.
  const sid2 = randomBytes(24).toString('hex')
  database().prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (2, 2, ?, ?, ?, ?)').run('chat-only', encrypt('none'), now, now)
  database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, 2, ?, ?)').run(sha256(sid2), now, now + 86400_000)
  database().prepare("INSERT INTO integrations (user_id, name, secret, created_at) VALUES (2, 'openai-chatgpt', ?, ?)").run(encrypt(JSON.stringify({ access: validAccess, refresh: refreshToken, accountId: 'acct-chat-1', email: 'other@example.test', plan: 'plus', expires: Date.now() + 3600_000 })), now)
  const as2 = async (method: string, path: string, body?: unknown) => fetch(`${server.origin}${path}`, { method, headers: { Cookie: `mvlos_sid=${sid2}`, ...(await asPage(sid2)), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const me = (await (await as2('GET', '/api/me')).json()) as { integrations: { ollama: string | null; openai: boolean } }
  check('without an Ollama key, /api/me says OpenAI is there', me.integrations.ollama === null && me.integrations.openai === true)
  const t2 = (await (await as2('POST', '/api/agents/threads', { mode: 'quick', tools: [] })).json()) as { id: string; model: string }
  check(`a new thread without a model picks a ChatGPT one (${t2.model})`, t2.model.startsWith('chatgpt/'))
  const said = (await (await as2('POST', `/api/agents/threads/${t2.id}/messages`, { text: 'SCENARIO chatonly' })).text()).split('\n').filter(Boolean).map((l) => JSON.parse(l) as Ev)
  check(`it answers without an Ollama key${said.find((e) => e.type === 'error')?.error ?? ''}`, !said.some((e) => e.type === 'error') && said.some((e) => e.type === 'delta' && e.content?.includes('chatonly')))
  const o2 = (await (await as2('POST', '/api/agents/threads', { mode: 'quick', model: OLLAMA_MODEL })).json()) as { id: string }
  const ollamaAsk = await as2('POST', `/api/agents/threads/${o2.id}/messages`, { text: 'hi' })
  check(`an Ollama thread still asks for the key (${ollamaAsk.status})`, ollamaAsk.status === 409 && /Ollama API key/.test(await ollamaAsk.text()))

  // 13. Signed out: a ChatGPT thread says what to do.
  database().prepare("DELETE FROM integrations WHERE user_id = 1 AND name = 'openai-chatgpt'").run()
  const r13 = await turn(a, 'signedout')
  check(`signed out, the thread says to sign in (${r13.error})`, /Sign in with ChatGPT/.test(r13.error ?? ''))
} catch (e) {
  check(`ran to the end (${(e as Error).message})`, false)
  console.error(server.log)
} finally {
  await server.dispose()
  fake.close()
  ollama.close()
}
finish()
