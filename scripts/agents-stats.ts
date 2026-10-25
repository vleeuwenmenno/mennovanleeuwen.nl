// Checks the Agents app's thread stats for nerds (server/agentStats.ts, GET /api/agents/threads/<id>/stats,
// src/data/agentStats.ts) and that a thread's request prefix stays the same between rounds and turns,
// so the providers' prompt caches can hold. Against stand-ins only: the real server (server/index.ts)
// on a free port with a scratch DATA_DIR and a signed-in account, a fake Ollama (OLLAMA_URL) that
// streams with a delay and reports its durations, and a fake ChatGPT Codex backend
// (CHATGPT_CODEX_URL) that reports cached and reasoning tokens. No real key or account is used.
//
//   - Ollama: per call the counts, Ollama's own eval/prompt/load durations, our time to the first
//     token and the wall time; no cache figure ("not reported by Ollama"); tool calls timed.
//   - ChatGPT: input, cached, output and reasoning tokens; the cache hit is cached over input.
//   - The stats survive a restart; a message saved before stats were kept shows as unmeasured.
//   - Prefix stability: the second round of a turn and the next turn send the system prompt, the
//     tools and the history so far byte for byte as before (Ollama, with the calendar on, where the
//     prompt used to carry a clock; and ChatGPT, whose prompt_cache_key stays the thread's own).
//
//   node scripts/agents-stats.ts
//
// Exits 1 on any failure.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { Server, check, finish, sleep } from './empires-harness.ts'
import { asPage } from './as-page.ts'
import { summarize, threadSummary, summaryLines, cacheNote, type ThreadStats } from '../src/data/agentStats.ts'

const MODEL = 'stats-model'
const FIRST_DELAY = 60

// --- The stand-in for Ollama --------------------------------------------------------------------------

type ChatBody = { model: string; messages: { role: string; content: string; tool_calls?: unknown[] }[]; stream?: boolean; tools?: unknown[]; think?: unknown }
const mains: { body: ChatBody; raw: string }[] = []
const send = (res: ServerResponse, status: number, body: unknown, type = 'application/json') => res.writeHead(status, { 'Content-Type': type }).end(typeof body === 'string' ? body : JSON.stringify(body))

const ollama = createServer((req: IncomingMessage, res: ServerResponse) => {
  let raw = ''
  req.on('data', (d) => (raw += d))
  req.on('end', async () => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    if (path === '/api/tags') return send(res, 200, { models: [{ name: MODEL }] })
    if (path === '/api/show') return send(res, 200, { capabilities: ['completion', 'tools'], model_info: { 'x.context_length': 200000 } })
    if (path !== '/api/chat') return send(res, 404, {})
    const body = JSON.parse(raw) as ChatBody
    if (body.stream === false) return send(res, 200, { message: { role: 'assistant', content: '{"title":"Stats check"}' }, done: true })
    mains.push({ body, raw })
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
    await sleep(FIRST_DELAY)
    const last = body.messages.at(-1)!
    const done = { done: true, prompt_eval_count: 1200, eval_count: 300, total_duration: 2_500_000_000, load_duration: 50_000_000, prompt_eval_duration: 400_000_000, eval_duration: 1_500_000_000 }
    // A user message asks for a search first; after the search's result, the answer.
    if (last.role === 'user' && /SEARCH/.test(last.content)) {
      res.write(`${JSON.stringify({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'search_threads', arguments: { query: 'apples' } } }] }, done: false })}\n`)
      return res.end(`${JSON.stringify({ message: { role: 'assistant', content: '' }, ...done })}\n`)
    }
    res.write(`${JSON.stringify({ message: { role: 'assistant', content: 'The answer ' }, done: false })}\n`)
    await sleep(20)
    res.write(`${JSON.stringify({ message: { role: 'assistant', content: 'is here.' }, done: false })}\n`)
    res.end(`${JSON.stringify({ message: { role: 'assistant', content: '' }, ...done })}\n`)
  })
})
await new Promise<void>((r) => ollama.listen(0, '127.0.0.1', r))
const ollamaUrl = `http://127.0.0.1:${(ollama.address() as { port: number }).port}`

// --- The stand-in for ChatGPT's Codex backend ---------------------------------------------------------

type Item = { type: string; role?: string; content?: { type: string; text?: string }[]; call_id?: string; name?: string; output?: string }
const codex: { body: Record<string, any>; headers: IncomingMessage['headers'] }[] = []
const sse = (events: Record<string, unknown>[]) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
const fake = createServer((req, res) => {
  let raw = ''
  req.on('data', (d) => (raw += d))
  req.on('end', async () => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    if (path === '/models') return send(res, 200, { models: [{ slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', context_window: 272000, default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }], input_modalities: ['text'] }] })
    if (path !== '/responses') return send(res, 404, {})
    const body = JSON.parse(raw) as { input: Item[] }
    codex.push({ body, headers: req.headers })
    const lastUser = [...body.input].reverse().find((i) => i.type === 'message' && i.role === 'user')
    const answered = body.input.at(-1)?.type === 'function_call_output'
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    await sleep(FIRST_DELAY)
    const usage = { input_tokens: 10_000, input_tokens_details: { cached_tokens: 9_000 }, output_tokens: 400, output_tokens_details: { reasoning_tokens: 150 }, total_tokens: 10_400 }
    if (/SEARCH/.test(lastUser?.content?.[0]?.text ?? '') && !answered)
      return res.end(sse([{ type: 'response.created', response: { id: 'r' } }, { type: 'response.reasoning_summary_text.delta', summary_index: 0, delta: 'Searching.' }, { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'srv', name: 'search_threads', arguments: '{"query":"pears"}' } }, { type: 'response.completed', response: { usage } }]))
    res.end(sse([{ type: 'response.created', response: { id: 'r' } }, { type: 'response.output_text.delta', delta: 'Done ' }, { type: 'response.output_text.delta', delta: 'here.' }, { type: 'response.completed', response: { usage } }]))
  })
})
await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r))
const fakeUrl = `http://127.0.0.1:${(fake.address() as { port: number }).port}`

// --- The site, with a signed-in account, a ChatGPT sign-in and a CalDAV calendar ------------------------

const LOGIN = 'stats-check'
const server = new Server({ OLLAMA_URL: ollamaUrl, OLLAMA_API_KEY: 'fake-ollama', OPENAI_URL: fakeUrl, OPENAI_AUTH_URL: fakeUrl, CHATGPT_CODEX_URL: fakeUrl, OPENAI_API_KEY: '', GITHUB_CLIENT_ID: 'x', GITHUB_CLIENT_SECRET: 'x', ADMIN_USERS: LOGIN })
process.env.DATA_DIR = server.data
const { database, encrypt, sha256 } = await import('../server/db.ts')
const sid = randomBytes(24).toString('hex')
const now = Date.now()
database().prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (1, 1, ?, ?, ?, ?)').run(LOGIN, encrypt('none'), now, now)
database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, 1, ?, ?)').run(sha256(sid), now, now + 86400_000)
database().prepare("INSERT INTO integrations (user_id, name, secret, created_at) VALUES (1, 'openai-chatgpt', ?, ?)").run(encrypt(JSON.stringify({ access: 'access-1', refresh: 'refresh-1', accountId: 'acct-1', email: 'checker@example.test', plan: 'plus', expires: now + 3600_000 })), now)
// A calendar that is never asked anything: it only has to be connected for the calendar's prompt.
database().prepare("INSERT INTO caldav (user_id, label, base_url, username, password, created_at) VALUES (1, 'Stand-in', 'http://127.0.0.1:9/', 'nobody', ?, ?)").run(encrypt('x'), now)
await server.start()

const call = async (method: string, path: string, body?: unknown) =>
  fetch(`${server.origin}${path}`, { method, headers: { Cookie: `mvlos_sid=${sid}`, ...(await asPage(sid)), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
const api = async <T = Record<string, any>>(method: string, path: string, body?: unknown): Promise<T> => {
  const res = await call(method, path, body)
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`)
  return (await res.json()) as T
}
const newThread = async (model: string, tools: string[]) => (await api<{ id: string }>('POST', '/api/agents/threads', { model, mode: 'quick', tools })).id
const say = async (id: string, text: string) => {
  const res = await call('POST', `/api/agents/threads/${id}/messages`, { text, client: { timeZone: 'Europe/Amsterdam' } })
  const events = (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l) as { type: string; error?: string })
  return events.find((e) => e.type === 'error')?.error ?? null
}
const stats = (id: string) => api<ThreadStats>('GET', `/api/agents/threads/${id}/stats`)
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

try {
  // 1. Ollama, with a tool call and the calendar on: two rounds, then a second turn.
  const a = await newThread(MODEL, ['threads', 'calendar'])
  const from = mains.length
  const err1 = await say(a, 'SEARCH for apples, please')
  check(`an Ollama turn with a tool call answers${err1 ? ` (${err1})` : ''}`, !err1 && mains.length - from === 2)
  const [r0, r1] = [mains[from], mains[from + 1]]
  const err2 = await say(a, 'and now something else')
  check(`a second Ollama turn answers${err2 ? ` (${err2})` : ''}`, !err2 && mains.length - from === 3)
  const r2 = mains[from + 2]

  const sys = r0.body.messages[0].content
  check('the system prompt carries no clock (it would change every minute)', !/\b\d\d:\d\d now\b/.test(sys) && /Each of the user's messages ends with the time it was sent/.test(sys))
  check('each user message ends with when it was sent, in the user’s zone', /\[Sent \w{3} \d{1,2} \w{3} \d{4} \d\d:\d\d\]$/.test(r0.body.messages[1].content))
  check('round 2 of a turn sends round 1’s messages byte for byte, then the new ones', same(r1.body.messages.slice(0, r0.body.messages.length), r0.body.messages) && same(r1.body.tools, r0.body.tools))
  check('the next turn sends the last round’s messages byte for byte, then the new ones', same(r2.body.messages.slice(0, r1.body.messages.length), r1.body.messages))
  check('the next turn offers the same tools, in the same order', same(r2.body.tools, r1.body.tools) && same(r2.body.think, r1.body.think))
  // The serialized request itself, up to the end of what was sent before: the same bytes.
  const head = r1.raw.slice(0, r1.raw.indexOf('"messages"'))
  const sent = `"messages":${JSON.stringify(r1.body.messages).slice(0, -1)},`
  check('the serialized request, up to the end of the last turn’s history, is byte-identical', r2.raw.startsWith(head) && r1.raw.includes(sent.slice(0, -1)) && r2.raw.startsWith(`${head}${sent}`))

  let s = await stats(a)
  check('stats: two turns', s.turns.length === 2 && s.turns[0].text.startsWith('SEARCH for apples') && s.model === MODEL)
  const c0 = s.turns[0].calls[0].stats
  check('stats: an Ollama call has its counts', c0?.provider === 'ollama' && c0.model === MODEL && c0.input === 1200 && c0.output === 300)
  check('stats: Ollama’s own durations (eval as the writing time, prompt eval, load)', c0?.gen === 1500 && c0.promptEval === 400 && c0.load === 50)
  check(`stats: our time to the first token covers the stand-in’s delay (${c0?.ttft} ms)`, typeof c0?.ttft === 'number' && c0.ttft >= FIRST_DELAY - 5 && c0.ms >= c0.ttft)
  check('stats: no cache figure from Ollama', c0?.cached === undefined)
  check('stats: the tool call is timed', s.turns[0].tools.length === 1 && s.turns[0].tools[0].name === 'search_threads' && typeof s.turns[0].tools[0].ms === 'number')
  let sum = threadSummary(s)
  check('summary: 3 model calls, 1 tool call', sum.calls === 3 && sum.toolCalls === 1 && sum.unmeasured === 0)
  check(`summary: 200 tok/s (300 tokens in 1.5 s each; got ${sum.tokPerSec})`, Math.round(sum.tokPerSec ?? 0) === 200)
  check('summary: the cache is "not reported by Ollama"', sum.cacheHit === null && cacheNote(sum) === 'not reported by Ollama' && summaryLines(sum).some(([k, v]) => k === 'Cache hit' && v === 'not reported by Ollama'))
  check('summary: input and output add up', sum.input === 3600 && sum.output === 900 && sum.reasoning === null)

  // 2. A message saved before stats were kept: counted, but unmeasured.
  database().prepare("INSERT INTO agent_messages (thread_id, role, content, created_at) VALUES (?, 'user', 'an old question', ?)").run(a, Date.now())
  database().prepare("INSERT INTO agent_messages (thread_id, role, content, created_at) VALUES (?, 'assistant', 'an old answer', ?)").run(a, Date.now())
  database().prepare("INSERT INTO agent_messages (thread_id, role, content, tool_name, created_at) VALUES (?, 'tool', '{}', 'web_search', ?)").run(a, Date.now())
  s = await stats(a)
  const old = s.turns.at(-1)!
  check('old messages: their call has no stats, their tool no time', old.calls[0].stats === null && old.tools[0].ms === null)
  sum = threadSummary(s)
  check('old messages: counted as calls from before stats', sum.calls === 4 && sum.unmeasured === 1 && summarize(old.calls, old.tools).llmMs === 0)

  // 3. ChatGPT: cached and reasoning tokens; the prefix and prompt_cache_key between rounds and turns.
  const b = await newThread('chatgpt/gpt-5.5', ['threads'])
  const at = codex.length
  const e1 = await say(b, 'SEARCH for pears')
  const e2 = await say(b, 'thanks')
  check(`a ChatGPT thread answers twice${e1 || e2 ? ` (${e1 || e2})` : ''}`, !e1 && !e2 && codex.length - at === 3)
  const [q0, q1, q2] = codex.slice(at)
  check('ChatGPT: round 2 sends round 1’s input byte for byte', same(q1.body.input.slice(0, q0.body.input.length), q0.body.input) && same(q1.body.tools, q0.body.tools) && q1.body.instructions === q0.body.instructions)
  check('ChatGPT: the next turn sends the last round’s input byte for byte', same(q2.body.input.slice(0, q1.body.input.length), q1.body.input) && same(q2.body.tools, q1.body.tools))
  check('ChatGPT: the prompt_cache_key is the thread’s, the same every call', !!q0.body.prompt_cache_key && q0.body.prompt_cache_key === q1.body.prompt_cache_key && q1.body.prompt_cache_key === q2.body.prompt_cache_key && q0.headers.session_id === q0.body.prompt_cache_key)
  const c = await newThread('chatgpt/gpt-5.5', ['threads'])
  await say(c, 'hello')
  check('ChatGPT: another thread has its own prompt_cache_key', codex.at(-1)!.body.prompt_cache_key !== q0.body.prompt_cache_key)
  s = await stats(b)
  const g0 = s.turns[0].calls[0].stats
  check('stats: a ChatGPT call has input, cached, output and reasoning tokens', g0?.provider === 'chatgpt' && g0.input === 10_000 && g0.cached === 9_000 && g0.output === 400 && g0.reasoning === 150)
  check(`stats: ChatGPT’s time to the first token (${g0?.ttft} ms)`, typeof g0?.ttft === 'number' && g0.ttft >= FIRST_DELAY - 5)
  sum = threadSummary(s)
  check(`summary: cache hit 90% (${sum.cacheHit})`, sum.cacheHit !== null && Math.round(sum.cacheHit * 100) === 90 && summaryLines(sum).some(([k, v]) => k === 'Cache hit' && v.startsWith('90%')))
  check('summary: reasoning adds up', sum.reasoning === 450)

  // 4. After a restart the stats are still there.
  const before = await stats(a)
  await server.stop()
  await server.start()
  await sleep(100)
  check('restart: the stats survive', same(await stats(a), before))

  // 5. Somebody else's thread is not readable.
  database().prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (2, 2, ?, ?, ?, ?)').run('other', encrypt('none'), now, now)
  const sid2 = randomBytes(24).toString('hex')
  database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, 2, ?, ?)').run(sha256(sid2), now, now + 86400_000)
  const theirs = await fetch(`${server.origin}/api/agents/threads/${a}/stats`, { headers: { Cookie: `mvlos_sid=${sid2}`, ...(await asPage(sid2)) } })
  check(`another account cannot read the stats (${theirs.status})`, theirs.status === 404 || theirs.status === 403)
} catch (e) {
  check(`ran to the end (${(e as Error).message})`, false)
  console.error(server.log)
} finally {
  await server.dispose()
  ollama.close()
  fake.close()
}
finish()
