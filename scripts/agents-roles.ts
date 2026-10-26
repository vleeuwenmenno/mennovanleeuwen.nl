// Checks that no request the Agents app sends to Ollama ends on the assistant's own reply. Some
// models' servers (Mistral's) refuse that: "Expected last role User or Tool (or Assistant with
// prefix True) for serving but got assistant". It starts the real server (server/index.ts) on a
// free port with a scratch DATA_DIR, a signed-in admin and a stand-in for Ollama (OLLAMA_URL) that
// refuses such a request the way Mistral does, and plays scripted replies through:
//
//   - a reply that only thinks: the app asks once more for the answer (the nudge),
//   - an answer while the todo list has open items: the app asks for it to be updated (wrap-up),
//   - a turn cut off by a restart halfway through a reply, then Retry and a new message.
//
// Each must end with the answer and no error, and the app's notes to the model must not be saved
// in the thread.
//
//   node scripts/agents-roles.ts
//
// Exits 1 on any failure.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { Server, check, finish, sleep } from './empires-harness.ts'
import { asPage } from './as-page.ts'

type Message = { role: string; content: string; thinking?: string; tool_calls?: unknown[]; tool_name?: string }
type ChatBody = { model: string; messages: Message[]; stream?: boolean; tools?: { function: { name: string } }[] }

const MODEL = 'mistral-large-4'
const MISTRAL = 'Expected last role User or Tool (or Assistant with prefix True) for serving but got assistant'
const EMPTY = 'Assistant message must have either content or tool_calls, but not none.'

// --- The stand-in for Ollama ----------------------------------------------------------------------

/** Every chat request the app sent, and the ones refused for ending on the assistant. */
const seen: ChatBody[] = []
const refused: ChatBody[] = []
/** Turns of the restart scenario so far: the first hangs halfway through its reply. */
let restartTurns = 0
/** The restart scenario's reply has started streaming. */
let halfway = false

const reply = (res: ServerResponse, msg: { content?: string; thinking?: string; tool_calls?: unknown[] }) => {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
  res.write(`${JSON.stringify({ model: MODEL, message: { role: 'assistant', content: '', ...msg }, done: false })}\n`)
  res.end(`${JSON.stringify({ model: MODEL, message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 100, eval_count: 10 })}\n`)
}
const call = (name: string, args: Record<string, unknown>) => [{ function: { name, arguments: args } }]

function chat(body: ChatBody, res: ServerResponse) {
  seen.push(body)
  const last = body.messages.at(-1)
  if (last?.role === 'assistant') {
    refused.push(body)
    res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: MISTRAL }))
    return
  }
  // Mistral also refuses an assistant message with neither text nor tool calls.
  if (body.messages.some((m) => m.role === 'assistant' && !m.content.trim() && !m.tool_calls?.length)) {
    refused.push(body)
    res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: EMPTY }))
    return
  }
  // The title model (not streamed).
  if (body.stream === false) {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ model: MODEL, message: { role: 'assistant', content: '{"title":"Roles check"}' }, done: true }))
    return
  }
  // The scenario is in the user's last own message; the round is the replies since.
  const at = body.messages.map((m) => m.role === 'user' && m.content.startsWith('SCENARIO ')).lastIndexOf(true)
  const scenario = body.messages[at]?.content.slice('SCENARIO '.length) ?? ''
  // The app's own notes count as a round too: the thinking-only reply before a nudge is not sent.
  const round = body.messages.slice(at + 1).filter((m) => m.role === 'assistant' || m.content.startsWith('(A note from the app')).length
  if (scenario === 'nudge') {
    if (round === 0) return reply(res, { thinking: 'Let me look in the notes.', tool_calls: call('search_notes', { query: 'roles' }) })
    if (round === 1) return reply(res, { thinking: 'Nothing found. I should answer.' })
    return reply(res, { content: 'FINAL nudge answer' })
  }
  if (scenario === 'wrapup') {
    if (round === 0) return reply(res, { tool_calls: call('update_todos', { items: [{ text: 'Look', status: 'active' }, { text: 'Answer', status: 'pending' }] }) })
    if (round === 1) return reply(res, { content: 'FINAL wrapup answer' })
    return reply(res, { tool_calls: call('update_todos', { items: [] }) })
  }
  if (scenario === 'restart' && restartTurns++ === 0) {
    // Half a reply, then nothing until the app goes away.
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
    res.write(`${JSON.stringify({ model: MODEL, message: { role: 'assistant', content: 'Half an ans' }, done: false })}\n`)
    halfway = true
    return
  }
  return reply(res, { content: `FINAL ${scenario} answer` })
}

const ollama = createServer((req: IncomingMessage, res: ServerResponse) => {
  let raw = ''
  req.on('data', (d) => (raw += d))
  req.on('end', () => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    if (path === '/api/tags') return void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ models: [{ name: MODEL }] }))
    if (path === '/api/show') return void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ capabilities: ['completion', 'tools', 'thinking'], model_info: { 'mistral.context_length': 131072 } }))
    if (path === '/api/chat') return chat(JSON.parse(raw) as ChatBody, res)
    res.writeHead(404).end()
  })
})
await new Promise<void>((r) => ollama.listen(0, '127.0.0.1', r))
const ollamaUrl = `http://127.0.0.1:${(ollama.address() as { port: number }).port}`

// --- The site, with a signed-in admin -------------------------------------------------------------

const LOGIN = 'roles-check'
const server = new Server({ OLLAMA_URL: ollamaUrl, OLLAMA_API_KEY: 'fake-key', GITHUB_CLIENT_ID: 'x', GITHUB_CLIENT_SECRET: 'x', ADMIN_GITHUB_IDS: '1' })
// The account and its session go straight into the scratch database, before the server opens it.
process.env.DATA_DIR = server.data
const { database, encrypt, sha256 } = await import('../server/db.ts')
const sid = randomBytes(24).toString('hex')
const now = Date.now()
database().prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (1, 1, ?, ?, ?, ?)').run(LOGIN, encrypt('none'), now, now)
database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, 1, ?, ?)').run(sha256(sid), now, now + 86400_000)
await server.start()

const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${server.origin}${path}`, { method, headers: { Cookie: `mvlos_sid=${sid}`, ...(await asPage(sid)), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`)
  return res
}
/** A turn, streamed to the end: its events. */
const events = async (res: Response) =>
  (await res.text())
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { type: string; error?: string })
type Saved = { role: string; content: string }
const thread = async (id: string) => (await (await api('GET', `/api/agents/threads/${id}`)).json()) as { thread: { interrupted: unknown; todos: unknown[] }; messages: Saved[] }
const newThread = async () => ((await (await api('POST', '/api/agents/threads', { model: MODEL, mode: 'quick' })).json()) as { id: string }).id

/** One turn: no error, the answer last, and none of the app's notes saved. */
async function turn(label: string, id: string, run: () => Promise<Response>, answer: string) {
  const from = seen.length
  const evs = await events(await run())
  const error = evs.find((e) => e.type === 'error')
  check(`${label}: no error${error ? ` (got "${error.error}")` : ''}`, !error)
  const t = await thread(id)
  const said = t.messages.filter((m) => m.role === 'assistant' && m.content.trim()).at(-1)?.content
  check(`${label}: ends with the answer (got ${JSON.stringify(said)})`, said === answer)
  check(`${label}: the thread is not marked as interrupted`, !t.thread.interrupted)
  check(`${label}: only the user's own messages are saved as theirs`, t.messages.filter((m) => m.role === 'user').every((m) => m.content.startsWith('SCENARIO ')))
  const sent = seen.slice(from).filter((b) => b.stream !== false)
  check(`${label}: no request ended on the assistant`, sent.every((b) => b.messages.at(-1)?.role !== 'assistant'))
  return { t, sent }
}

try {
  // 1. A reply that only thinks: asked once more, in a user message that is not saved.
  const a = await newThread()
  const one = await turn('nudge', a, () => api('POST', `/api/agents/threads/${a}/messages`, { text: 'SCENARIO nudge' }), 'FINAL nudge answer')
  const nudge = one.sent.at(-1)
  const note = nudge?.messages.at(-1)
  check('nudge: the last request ends with a note asking for the answer', note?.role === 'user' && /only thought and wrote nothing/.test(note.content))
  check('nudge: the note is not in the system prompt', !/only thought and wrote nothing/.test(nudge?.messages[0]?.content ?? ''))
  check('nudge: no tools are offered with the note', !nudge?.tools?.length)
  check('nudge: the note is not saved', !one.t.messages.some((m) => /only thought and wrote nothing/.test(m.content)))

  // 2. Retry of the same turn runs the same way.
  await turn('retry after nudge', a, () => api('POST', `/api/agents/threads/${a}/retry`, {}), 'FINAL nudge answer')

  // 3. An answer while todos are open: asked to update them, in a user message that is not saved.
  const b = await newThread()
  const two = await turn('wrap-up', b, () => api('POST', `/api/agents/threads/${b}/messages`, { text: 'SCENARIO wrapup' }), 'FINAL wrapup answer')
  const wrap = two.sent.at(-1)
  const ask = wrap?.messages.at(-1)
  check('wrap-up: the last request ends with a note about the open todos', ask?.role === 'user' && /todo list still has 2 open items/.test(ask.content))
  check('wrap-up: the note is not in the system prompt', !/You have answered, but your todo list/.test(wrap?.messages[0]?.content ?? ''))
  check('wrap-up: only update_todos is offered with the note', wrap?.tools?.map((t) => t.function.name).join() === 'update_todos')
  check('wrap-up: the todo list is cleared', two.t.thread.todos.length === 0)
  check('wrap-up: the note is not saved', !two.t.messages.some((m) => /todo list still has/.test(m.content)))

  // 4. A restart halfway through a reply keeps the half reply; Retry and a new message both work.
  const c = await newThread()
  const cut = api('POST', `/api/agents/threads/${c}/messages`, { text: 'SCENARIO restart' }).then((r) => r.text()).catch(() => '')
  for (let i = 0; i < 100 && !halfway; i++) await sleep(50)
  await sleep(200)
  await server.stop()
  await cut
  await server.start()
  const kept = await thread(c)
  check('restart: the half reply is kept, last in the thread', kept.messages.at(-1)?.role === 'assistant' && kept.messages.at(-1)?.content === 'Half an ans')
  check('restart: the thread is marked as interrupted', !!kept.thread.interrupted)
  await turn('restart, then Retry', c, () => api('POST', `/api/agents/threads/${c}/retry`, {}), 'FINAL restart answer')
  await turn('restart, then a new message', c, () => api('POST', `/api/agents/threads/${c}/messages`, { text: 'SCENARIO again' }), 'FINAL again answer')

  check(`Ollama refused no request (refused ${refused.length})`, refused.length === 0)
} catch (e) {
  check(`ran to the end (${(e as Error).message})`, false)
  console.error(server.log)
} finally {
  await server.dispose()
  ollama.close()
}
finish()
