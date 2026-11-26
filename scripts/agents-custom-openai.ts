// Checks two Agents app features end to end against stand-in servers:
// 1. Removing an Ollama Cloud key hides Ollama Cloud models from /api/agents/models and /api/agents/defaults.
// 2. Custom OpenAI-compatible API endpoints (server/agentCustomOpenAI.ts):
//    - CRUD (add, /v1 auto-detection, edit preserving/clearing key, test, delete)
//    - Optional API key, keys never leaked to the browser
//    - Egress protection: non-admin blocked from loopback/private IPs while admin succeeds
//    - Model discovery metadata (context length, vision, thinking, providerLabel, manualModels)
//    - Offline endpoint resilience (does not break other endpoints or providers)
//    - Chat Completions streaming: text deltas, reasoning_content thinking deltas, parallel tool
//      calls + paired tool_call_ids, vision image_url data URLs, usage & stats (provider: 'custom'),
//      Stop abort, stream_options 400 fallback, and non-streaming application/json fallback.
//
//   node scripts/agents-custom-openai.ts
//
// Exits 1 on any failure.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { Server, check, finish, sleep, waitFor } from './empires-harness.ts'
import { asPage } from './as-page.ts'

const OLLAMA_MODEL = 'glm-5.3'
const SECRET_KEY = 'sk-strata-secret-9999'
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type }).end(typeof body === 'string' ? body : JSON.stringify(body))
}

// --- Stand-in Ollama -----------------------------------------------------------------------------

const ollama = createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://x').pathname
  if (path === '/api/me') return send(res, 200, { ok: true })
  if (path === '/api/tags') return send(res, 200, { models: [{ name: OLLAMA_MODEL }] })
  if (path === '/api/show') return send(res, 200, { capabilities: ['completion', 'tools', 'thinking'], model_info: { 'x.context_length': 200000 } })
  send(res, 404, {})
})
await new Promise<void>((r) => ollama.listen(0, '127.0.0.1', r))
const ollamaUrl = `http://127.0.0.1:${(ollama.address() as { port: number }).port}`

// --- Stand-in Custom OpenAI-compatible server (Strata-style) -------------------------------------

type ChatMsg = { role: string; content: unknown; tool_calls?: { id: string; function: { name: string } }[]; tool_call_id?: string }
type ReqLog = { method: string; path: string; headers: IncomingMessage['headers']; body: string }
const seen: ReqLog[] = []
let requireKey: string | null = null
let slowStarted = false
let slowClosed = false
let toolPairing: { callIds: string[]; toolIds: string[] } | null = null
let rejectStreamOptions = false
let forceJsonResponse = false

function sseChunk(obj: Record<string, unknown>) {
  return `data: ${JSON.stringify(obj)}\n\n`
}

function scenarioOf(messages: ChatMsg[]) {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')
  const rawText = typeof lastUser?.content === 'string' ? lastUser.content : Array.isArray(lastUser?.content) ? (lastUser.content as { type?: string; text?: string }[]).find((p) => p.type === 'text')?.text ?? '' : ''
  const name = rawText.startsWith('SCENARIO ') ? rawText.slice('SCENARIO '.length).split(/\s/)[0] : ''
  const lastUserIdx = messages.lastIndexOf(lastUser!)
  const after = lastUserIdx >= 0 ? messages.slice(lastUserIdx + 1) : []
  const hasTools = after.some((m) => m.role === 'tool')
  return { name, round: hasTools ? 1 : 0, after }
}

const strata = createServer((req, res) => {
  let raw = ''
  req.on('data', (d) => (raw += d))
  req.on('end', () => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    seen.push({ method: req.method ?? 'GET', path, headers: req.headers, body: raw })
    if (requireKey && req.headers.authorization !== `Bearer ${requireKey}`) return send(res, 401, { error: { message: 'bad api key' } })
    if (path === '/v1/models') {
      return send(res, 200, {
        data: [
          { id: 'Qwen/Qwen3-VL-32B', context_length: 131072, capabilities: { vision: true, thinking: true } },
          { id: 'strata-fast', display_name: 'Strata Fast', max_model_len: 65536 },
        ],
      })
    }
    if (path === '/v1/chat/completions') {
      const body = JSON.parse(raw) as { model: string; messages: ChatMsg[]; stream?: boolean; stream_options?: unknown }
      if (rejectStreamOptions && body.stream_options !== undefined) {
        return send(res, 400, { error: { message: 'Unknown parameter: stream_options' } })
      }
      const { name, round, after } = scenarioOf(body.messages)
      if (name === 'toolong') return send(res, 400, { error: { message: 'This model maximum context length is 65536 tokens', code: 'context_length_exceeded' } })
      if (name === 'slow') {
        slowStarted = true
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write(sseChunk({ choices: [{ delta: { content: 'Working ' } }] }))
        res.on('close', () => (slowClosed = !res.writableEnded))
        return
      }
      if (forceJsonResponse) {
        return send(res, 200, {
          choices: [{ message: { role: 'assistant', reasoning_content: 'JSON thought.', content: `JSON ${name}` } }],
          usage: { prompt_tokens: 100, completion_tokens: 25, total_tokens: 125 },
        })
      }
      if (name === 'tools' && round === 0) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write(sseChunk({ choices: [{ delta: { reasoning_content: 'Running two searches.' } }] }))
        res.write(sseChunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c0', type: 'function', function: { name: 'search_threads', arguments: '{"que' } }] } }] }))
        res.write(sseChunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ry":"alpha"}' } }, { index: 1, id: 'c1', type: 'function', function: { name: 'search_threads', arguments: '{"query":"beta"}' } }] } }] }))
        res.write(sseChunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 400, completion_tokens: 40, total_tokens: 440 } }))
        res.end('data: [DONE]\n\n')
        return
      }
      if (name === 'tools' && round === 1) {
        const callIds = after.flatMap((m) => (m.role === 'assistant' ? (m.tool_calls ?? []).map((c) => c.id) : []))
        const toolIds = after.filter((m) => m.role === 'tool').map((m) => m.tool_call_id!)
        toolPairing = { callIds, toolIds }
      }
      const lastUser = [...body.messages].reverse().find((m) => m.role === 'user')
      const sees =
        Array.isArray(lastUser?.content) &&
        (lastUser.content as { type?: string; image_url?: { url?: string } }[]).some((p) => p.type === 'image_url' && p.image_url?.url?.startsWith('data:image/png;base64,'))
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(sseChunk({ choices: [{ delta: { reasoning_content: 'Step 1. ' } }] }))
      res.write(sseChunk({ choices: [{ delta: { reasoning_content: 'Step 2.' } }] }))
      res.write(sseChunk({ choices: [{ delta: { content: 'DONE ' } }] }))
      res.write(sseChunk({ choices: [{ delta: { content: `${name}${sees ? ' saw picture' : ''}` } }] }))
      res.write(
        sseChunk({
          choices: [],
          usage: {
            prompt_tokens: 1000,
            completion_tokens: 150,
            total_tokens: 1150,
            prompt_tokens_details: { cached_tokens: 800 },
            completion_tokens_details: { reasoning_tokens: 50 },
          },
        }),
      )
      res.end('data: [DONE]\n\n')
      return
    }
    send(res, 404, { error: 'not found' })
  })
})
await new Promise<void>((r) => strata.listen(0, '127.0.0.1', r))
const strataPort = (strata.address() as { port: number }).port
const strataBareUrl = `http://127.0.0.1:${strataPort}`

// Second server without /v1/models (tests manual models + direct 404 handling) and a dead port for offline resilience
const manualOnly = createServer((_req, res) => send(res, 404, { error: 'no models endpoint' }))
await new Promise<void>((r) => manualOnly.listen(0, '127.0.0.1', r))
const manualUrl = `http://127.0.0.1:${(manualOnly.address() as { port: number }).port}/v1`

// Grab an unused port for offline endpoint resilience test
const deadServer = createServer()
await new Promise<void>((r) => deadServer.listen(0, '127.0.0.1', r))
const deadPort = (deadServer.address() as { port: number }).port
await new Promise<void>((r) => deadServer.close(() => r()))

// --- Boot MvL OS server with admin (user 1) and non-admin (user 2) -------------------------------

const server = new Server({ OLLAMA_URL: ollamaUrl, OLLAMA_API_KEY: '', OPENAI_API_KEY: '', GITHUB_CLIENT_ID: 'x', GITHUB_CLIENT_SECRET: 'x', ADMIN_GITHUB_IDS: '1' })
process.env.DATA_DIR = server.data
const { database, encrypt, sha256 } = await import('../server/db.ts')
const now = Date.now()
const sidAdmin = randomBytes(24).toString('hex')
const sidUser = randomBytes(24).toString('hex')
database().prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (1, 1, ?, ?, ?, ?)').run('admin-check', encrypt('none'), now, now)
database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, 1, ?, ?)').run(sha256(sidAdmin), now, now + 86400_000)
database().prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (2, 2, ?, ?, ?, ?)').run('regular-user', encrypt('none'), now, now)
database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, 2, ?, ?)').run(sha256(sidUser), now, now + 86400_000)
await server.start()

const callAs = async (sid: string, method: string, path: string, body?: unknown) =>
  fetch(`${server.origin}${path}`, { method, headers: { Cookie: `mvlos_sid=${sid}`, ...(await asPage(sid)), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
const api = async <T = Record<string, any>>(method: string, path: string, body?: unknown): Promise<T> => {
  const res = await callAs(sidAdmin, method, path, body)
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`)
  return (await res.json()) as T
}

type Model = { name: string; label?: string; provider?: string; providerLabel?: string; contextLength: number | null; vision: boolean; thinking: boolean }
type Ev = { type: string; error?: string; content?: string; thinking?: string }
type Saved = { id: number; role: string; content: string; thinking?: string; toolName?: string; toolCalls?: { name: string; arguments: Record<string, unknown> }[] }

async function turn(threadId: string, scenario: string, attachments: unknown[] = []) {
  const res = await callAs(sidAdmin, 'POST', `/api/agents/threads/${threadId}/messages`, { text: `SCENARIO ${scenario}`, attachments })
  const events = (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l) as Ev)
  const t = await api<{ thread: { contextTokens: number | null; running: boolean }; messages: Saved[] }>('GET', `/api/agents/threads/${threadId}`)
  return { events, error: events.find((e) => e.type === 'error')?.error, messages: t.messages, thread: t.thread, last: t.messages.at(-1) }
}

try {
  // 1. Part 1: Ollama Cloud models appear only when Ollama key is set, and vanish when removed.
  let list = await api<Model[]>('GET', '/api/agents/models')
  let defaults = await api<{ quick: string; deep: string; title: string; check: string }>('GET', '/api/agents/defaults')
  check('with no Ollama key and no other provider, /api/agents/models is empty', list.length === 0)
  check('with no Ollama key, /api/agents/defaults returns empty strings', !defaults.quick && !defaults.deep && !defaults.title && !defaults.check)

  await api('PUT', '/api/integrations/ollama', { key: 'fake-ollama-key' })
  list = await api<Model[]>('GET', '/api/agents/models')
  defaults = await api('GET', '/api/agents/defaults')
  check('after adding an Ollama key, Ollama models appear', list.some((m) => m.name === OLLAMA_MODEL && m.provider === 'ollama'))
  check('after adding an Ollama key, defaults include Ollama', defaults.quick === OLLAMA_MODEL && defaults.title === OLLAMA_MODEL)

  await api('DELETE', '/api/integrations/ollama')
  list = await api<Model[]>('GET', '/api/agents/models')
  defaults = await api('GET', '/api/agents/defaults')
  check('after removing the Ollama key, Ollama models disappear immediately', list.length === 0)
  check('after removing the Ollama key, defaults no longer return Ollama models', defaults.quick === '' && defaults.deep === '' && defaults.title === '' && defaults.check === '')

  // 2. Egress check: non-admin is blocked from loopback/private IPs; admin succeeds.
  const blocked = await callAs(sidUser, 'POST', '/api/agents/custom-openai', { name: 'Local Strata', url: strataBareUrl })
  check(`non-admin is blocked from private/loopback URL (${blocked.status})`, blocked.status === 400 && /not a public address/i.test(await blocked.text()))

  // 3. Add endpoint with bare URL (auto-detects /v1) and no API key.
  const added = await api<{ endpoints: { id: string; name: string; url: string; hasKey: boolean; manualModels: string[] }[]; endpoint: { id: string; name: string; url: string; hasKey: boolean }; discovered: string[] }>('POST', '/api/agents/custom-openai', {
    name: 'Strata API',
    url: strataBareUrl,
  })
  const epId = added.endpoint.id
  check('bare URL auto-detected /v1 and stored normalized URL', added.endpoint.url === `${strataBareUrl}/v1` && /^e[0-9a-f]{8}$/.test(epId))
  check('optional API key works (hasKey is false)', added.endpoint.hasKey === false)
  check('discovered models include endpoint prefix', added.discovered.length === 2 && added.discovered.every((m) => m.startsWith(`custom/${epId}/`)))

  const me = await api<{ integrations: { ollama: string | null; customOpenAI: number } }>('GET', '/api/me')
  check('/api/me reports customOpenAI count', me.integrations.ollama === null && me.integrations.customOpenAI === 1)

  // 4. Model discovery metadata and defaults without Ollama key.
  list = await api<Model[]>('GET', '/api/agents/models')
  const qwen = list.find((m) => m.name === `custom/${epId}/Qwen/Qwen3-VL-32B`)
  const fast = list.find((m) => m.name === `custom/${epId}/strata-fast`)
  check('custom model carries contextLength, vision, thinking and providerLabel', !!qwen && qwen.provider === 'custom' && qwen.providerLabel === 'Strata API' && qwen.contextLength === 131072 && qwen.vision && qwen.thinking)
  check('custom model reads display_name and max_model_len', !!fast && fast.label === 'Strata Fast' && fast.contextLength === 65536 && !fast.vision)
  check('no Ollama models leak when only custom endpoint is configured', !list.some((m) => m.provider === 'ollama'))

  defaults = await api('GET', '/api/agents/defaults')
  check('defaults fall back to custom model when Ollama is absent, with blank title/check', defaults.quick.startsWith(`custom/${epId}/`) && defaults.title === '' && defaults.check === '')

  // 5. Manual models fallback when /models returns 404, plus offline endpoint resilience.
  const manualAdded = await api<{ endpoint: { id: string } }>('POST', '/api/agents/custom-openai', {
    name: 'Manual Server',
    url: manualUrl,
    manualModels: ['custom-manual-7b'],
  })
  check('server without /models saves when manualModels are given', !!manualAdded.endpoint.id)
  // Inject an offline endpoint directly into the encrypted config to verify offline resilience.
  const row = database().prepare("SELECT secret FROM integrations WHERE user_id = 1 AND name = 'agents-custom-openai'").get() as { secret: string }
  const { decrypt } = await import('../server/db.ts')
  const stored = JSON.parse(decrypt(row.secret)) as { endpoints: { id: string; name: string; url: string; apiKey: string; manualModels: string[] }[] }
  stored.endpoints.push({ id: 'e99999999', name: 'Offline PC', url: `http://127.0.0.1:${deadPort}/v1`, apiKey: '', manualModels: [] })
  database().prepare("UPDATE integrations SET secret = ? WHERE user_id = 1 AND name = 'agents-custom-openai'").run(encrypt(JSON.stringify(stored)))
  list = await api<Model[]>('GET', '/api/agents/models')
  check('offline endpoint does not break /api/agents/models for healthy endpoints', list.some((m) => m.name === `custom/${epId}/strata-fast`) && list.some((m) => m.name === `custom/${manualAdded.endpoint.id}/custom-manual-7b`))
  await api('DELETE', '/api/agents/custom-openai/e99999999')
  await api('DELETE', `/api/agents/custom-openai/${manualAdded.endpoint.id}`)

  // 6. Edit endpoint to add API key, preserve key on blank edit, test, and verify key never leaks.
  requireKey = SECRET_KEY
  const edited = await api<{ endpoint: { hasKey: boolean }; endpoints: unknown[] }>('PUT', `/api/agents/custom-openai/${epId}`, {
    name: 'Strata NetBird',
    url: `${strataBareUrl}/v1/chat/completions/`,
    apiKey: SECRET_KEY,
  })
  check('edit normalizes /chat/completions suffix and stores API key', edited.endpoint.hasKey === true && !JSON.stringify(edited).includes(SECRET_KEY))
  // Edit without passing apiKey keeps saved key.
  const kept = await api<{ endpoint: { hasKey: boolean; name: string } }>('PUT', `/api/agents/custom-openai/${epId}`, {
    name: 'Strata API',
    url: `${strataBareUrl}/v1`,
  })
  check('blank apiKey on edit keeps saved key', kept.endpoint.hasKey === true && kept.endpoint.name === 'Strata API')
  const tested = await api<{ ok: boolean; models: string[] }>('POST', `/api/agents/custom-openai/${epId}/test`)
  check('POST .../test probes and returns discovered models', tested.ok === true && tested.models.length === 2 && !JSON.stringify(tested).includes(SECRET_KEY))

  // 7. Full Chat Completions streaming turn: text deltas, reasoning_content, usage & stats.
  const modelName = `custom/${epId}/Qwen/Qwen3-VL-32B`
  const thread = (await api<{ id: string }>('POST', '/api/agents/threads', { model: modelName, mode: 'quick', tools: ['threads'] })).id
  const r1 = await turn(thread, 'text')
  check(`streaming turn answers cleanly${r1.error ? ` (${r1.error})` : ''}`, !r1.error && r1.last?.role === 'assistant' && r1.last.content === 'DONE text')
  check('text streamed in multiple deltas', r1.events.filter((e) => e.type === 'delta' && e.content).length >= 2)
  check('reasoning_content preserved as thinking', r1.last?.thinking === 'Step 1. Step 2.')
  check('usage fills contextTokens', r1.thread.contextTokens === 1150)
  const stats = await api<{ turns: { calls: { stats: { provider: string; input?: number; cached?: number; output?: number; reasoning?: number } | null }[] }[] }>('GET', `/api/agents/threads/${thread}/stats`)
  const s0 = stats.turns[0]?.calls[0]?.stats
  check('thread stats record provider=custom with usage counts', s0?.provider === 'custom' && s0.input === 1000 && s0.cached === 800 && s0.output === 150 && s0.reasoning === 50)
  const lastChat = [...seen].reverse().find((s) => s.path === '/v1/chat/completions')
  check('chat request sends stripped model ID and Bearer key', !!lastChat && lastChat.headers.authorization === `Bearer ${SECRET_KEY}` && JSON.parse(lastChat.body).model === 'Qwen/Qwen3-VL-32B')

  // 8. Parallel tool calls + paired tool_call_id follow-up.
  const r2 = await turn(thread, 'tools')
  const toolAssistant = r2.messages.filter((m) => m.role === 'assistant' && m.toolCalls?.length).at(-1)
  const toolResults = r2.messages.filter((m) => m.role === 'tool' && m.toolName === 'search_threads')
  check(`parallel tool calls ran${r2.error ? ` (${r2.error})` : ''}`, !r2.error && toolAssistant?.toolCalls?.length === 2 && toolResults.length === 2 && toolAssistant.toolCalls[0].arguments.query === 'alpha' && toolAssistant.toolCalls[1].arguments.query === 'beta')
  check('tool results went back paired with matching tool_call_ids', !!toolPairing && toolPairing.callIds.length === 2 && toolPairing.toolIds.length === 2 && toolPairing.callIds.every((id, i) => toolPairing!.toolIds[i] === id))
  check('turn completed after tool calls', r2.last?.content === 'DONE tools')

  // 9. Vision image_url data URL.
  const r3 = await turn(thread, 'vision', [{ name: 'dot.png', source: 'This computer', kind: 'image', mime: 'image/png', size: 68, data: PNG }])
  check(`vision picture sent as image_url data URL${r3.error ? ` (${r3.error})` : ''}`, !r3.error && r3.last?.content === 'DONE vision saw picture')

  // 10. stream_options 400 fallback.
  rejectStreamOptions = true
  const r4 = await turn(thread, 'nostreamopts')
  rejectStreamOptions = false
  check(`400 on stream_options automatically retries without it${r4.error ? ` (${r4.error})` : ''}`, !r4.error && r4.last?.content === 'DONE nostreamopts')

  // 11. Non-streaming application/json fallback.
  forceJsonResponse = true
  const r5 = await turn(thread, 'jsonfallback')
  forceJsonResponse = false
  check(`non-streaming JSON response works${r5.error ? ` (${r5.error})` : ''}`, !r5.error && r5.last?.content === 'JSON jsonfallback' && r5.last?.thinking === 'JSON thought.')

  // 12. Context window error mapping.
  const tLong = (await api<{ id: string }>('POST', '/api/agents/threads', { model: modelName, mode: 'quick', tools: [] })).id
  const rLong = await turn(tLong, 'toolong')
  check(`context length error maps cleanly (${rLong.error})`, /context window/i.test(rLong.error ?? '') && /Strata API/.test(rLong.error ?? ''))

  // 13. Stop abort closes upstream request.
  const tSlow = (await api<{ id: string }>('POST', '/api/agents/threads', { model: modelName, mode: 'quick', tools: [] })).id
  const slowReq = callAs(sidAdmin, 'POST', `/api/agents/threads/${tSlow}/messages`, { text: 'SCENARIO slow' }).then((r) => r.text())
  await waitFor('slow stream started', () => slowStarted, 8000)
  await sleep(150)
  await api('POST', `/api/agents/threads/${tSlow}/stop`)
  await slowReq
  await waitFor('upstream request closed', () => slowClosed, 5000).catch(() => {})
  const tSlowAfter = await api<{ thread: { running: boolean } }>('GET', `/api/agents/threads/${tSlow}`)
  check('Stop aborts upstream custom endpoint request and rests thread', slowClosed && !tSlowAfter.thread.running)

  // 14. Clear key with clearKey: true and delete endpoint.
  requireKey = null
  const cleared = await api<{ endpoint: { hasKey: boolean } }>('PUT', `/api/agents/custom-openai/${epId}`, {
    name: 'Strata API',
    url: `${strataBareUrl}/v1`,
    clearKey: true,
  })
  check('clearKey: true removes stored API key', cleared.endpoint.hasKey === false)
  const deleted = await api<{ endpoints: unknown[] }>('DELETE', `/api/agents/custom-openai/${epId}`)
  check('DELETE removes endpoint', deleted.endpoints.length === 0)
  const afterDel = await callAs(sidAdmin, 'POST', `/api/agents/threads/${thread}/messages`, { text: 'after delete' })
  check(`removed endpoint returns 409 on chat (${afterDel.status})`, afterDel.status === 409)
} catch (e) {
  check(`ran to the end (${(e as Error).message})`, false)
  console.error(server.log)
} finally {
  await server.dispose()
  strata.close()
  manualOnly.close()
  ollama.close()
}
finish()
