// Checks compaction in the Agents app (server/agents.ts) end to end: /compact with and without
// instructions (and compacting a compaction), what the next model call gets after it, compacting by
// itself before a message that would take the context past the threshold (and not when that is
// switched off), compacting and trying again after the model refused a request for being too long,
// /compact while a turn runs (refused as a message, queued otherwise), Retry, Rewind across a
// boundary, a failed /compact and its Retry, the context breakdown, shared links, a Spotlight quick
// answer, and a restart. It starts the real server (server/index.ts) on a free port with a scratch
// DATA_DIR, a signed-in admin and a stand-in for Ollama (OLLAMA_URL) that writes a fake summary
// when asked to compact, refuses scripted requests as too long, and answers the rest.
//
//   node scripts/agents-compact.ts
//
// Exits 1 on any failure.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { Server, check, finish, sleep, waitFor } from './empires-harness.ts'
import { asPage } from './as-page.ts'

type Message = { role: string; content: string; tool_calls?: unknown[] }
type ChatBody = { model: string; messages: Message[]; stream?: boolean; tools?: unknown[] }

/** A model with a big window, and one small enough for the threshold to be reached. */
const BIG = 'compact-big'
const SMALL = 'compact-small'
const SMALL_WINDOW = 24_000
const TOO_LONG = 'prompt too long; exceeded max context length by 2048 tokens'
const NOTE = '(A note from the app, not from the user.)'

// --- The stand-in for Ollama ----------------------------------------------------------------------

/** Requests to compact (the summariser), and the rest of the chat requests, in order. */
const summaries: ChatBody[] = []
const mains: ChatBody[] = []
/** The summariser fails while this is above zero. */
let failSummaries = 0
/** A turn of the "slow" scenario waits for this to be called. */
let release: (() => void) | null = null

const json = (res: ServerResponse, body: unknown, status = 200) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
const reply = (res: ServerResponse, model: string, content: string) => {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
  res.write(`${JSON.stringify({ model, message: { role: 'assistant', content }, done: false })}\n`)
  res.end(`${JSON.stringify({ model, message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 1000, eval_count: 10 })}\n`)
}
const text = (b: ChatBody) => b.messages.map((m) => m.content).join('\n')

function chat(body: ChatBody, res: ServerResponse) {
  // The title model (not streamed).
  if (body.stream === false) return json(res, { model: body.model, message: { role: 'assistant', content: '{"title":"Compact check"}' }, done: true })
  if (body.messages[0]?.content.startsWith('You compact a conversation')) {
    summaries.push(body)
    if (failSummaries > 0) return failSummaries--, json(res, { error: 'the summariser is down' }, 500)
    const n = summaries.length
    const focus = /<instructions>\n([\s\S]*?)\n<\/instructions>/.exec(body.messages[1].content)?.[1]
    return reply(res, body.model, `## User goals and requests\nFAKE SUMMARY ${n}${focus ? ` (focus: ${focus})` : ''}\n\n## Next step\nCarry on.`)
  }
  mains.push(body)
  const last = [...body.messages].reverse().find((m) => m.role === 'user' && !m.content.startsWith(NOTE))
  const scenario = /SCENARIO (\w+)/.exec([...text(body).matchAll(/SCENARIO \w+/g)].at(-1)?.[0] ?? '')?.[1] ?? 'plain'
  // Too long, until the conversation has been compacted.
  if (scenario === 'overflow' && !text(body).includes('<summary>')) return json(res, { error: TOO_LONG }, 400)
  if (scenario === 'slow' && release === null) {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
    res.write(`${JSON.stringify({ model: body.model, message: { role: 'assistant', content: 'Working on ' }, done: false })}\n`)
    release = () => {
      res.write(`${JSON.stringify({ model: body.model, message: { role: 'assistant', content: 'it: done' }, done: false })}\n`)
      res.end(`${JSON.stringify({ model: body.model, message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 1000, eval_count: 10 })}\n`)
    }
    return
  }
  return reply(res, body.model, `ANSWER to ${(last?.content ?? '').slice(0, 40)}`)
}

const ollama = createServer((req: IncomingMessage, res: ServerResponse) => {
  let raw = ''
  req.on('data', (d) => (raw += d))
  req.on('end', () => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    if (path === '/api/tags') return json(res, { models: [{ name: BIG }, { name: SMALL }] })
    if (path === '/api/show') {
      const name = (JSON.parse(raw) as { model: string }).model
      return json(res, { capabilities: ['completion', 'tools'], model_info: { 'test.context_length': name === SMALL ? SMALL_WINDOW : 1_000_000 } })
    }
    if (path === '/api/chat') return chat(JSON.parse(raw) as ChatBody, res)
    res.writeHead(404).end()
  })
})
await new Promise<void>((r) => ollama.listen(0, '127.0.0.1', r))
const ollamaUrl = `http://127.0.0.1:${(ollama.address() as { port: number }).port}`

// --- The site, with a signed-in admin -------------------------------------------------------------

const LOGIN = 'compact-check'
const server = new Server({ OLLAMA_URL: ollamaUrl, OLLAMA_API_KEY: 'fake-key', GITHUB_CLIENT_ID: 'x', GITHUB_CLIENT_SECRET: 'x', ADMIN_GITHUB_IDS: '1' })
process.env.DATA_DIR = server.data
const { database, encrypt, sha256 } = await import('../server/db.ts')
const sid = randomBytes(24).toString('hex')
const now = Date.now()
database().prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (1, 1, ?, ?, ?, ?)').run(LOGIN, encrypt('none'), now, now)
database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, 1, ?, ?)').run(sha256(sid), now, now + 86400_000)
await server.start()

const call = async (method: string, path: string, body?: unknown) =>
  fetch(`${server.origin}${path}`, { method, headers: { Cookie: `mvlos_sid=${sid}`, ...(await asPage(sid)), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
const api = async (method: string, path: string, body?: unknown) => {
  const res = await call(method, path, body)
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`)
  return res
}
type Event = { type: string; error?: string; state?: string; auto?: boolean; message?: Saved }
type Compaction = { auto: boolean; reason?: string; instructions?: string; messages: number; request?: string; files?: string[] }
type Saved = { id: number; role: string; content: string; compact?: Compaction }
type ThreadInfo = { interrupted: { reason: string; compact?: unknown } | null; queue: unknown[]; running: boolean }
const events = async (res: Response) => (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l) as Event)
const thread = async (id: string) => (await (await api('GET', `/api/agents/threads/${id}`)).json()) as { thread: ThreadInfo; messages: Saved[] }
const newThread = async (model = BIG, extra: Record<string, unknown> = {}) => ((await (await api('POST', '/api/agents/threads', { model, mode: 'quick', tools: [], ...extra })).json()) as { id: string }).id
const say = async (id: string, text: string, attachments?: unknown[]) => events(await api('POST', `/api/agents/threads/${id}/messages`, { text, ...(attachments ? { attachments } : {}) }))
const settings = (value: Record<string, unknown>) => api('PUT', '/api/state/agents', { value })
const lastMain = () => mains.at(-1)!

try {
  await settings({ autoCompact: true, compactAt: 85 })

  // 1. /compact without instructions: the summariser gets the conversation, the summary is saved
  // as a boundary, the whole history stays, and the next call gets only the summary and what follows.
  const a = await newThread()
  await say(a, 'first question about apples')
  await say(a, 'second question about pears')
  const from = summaries.length
  const ev = await say(a, '/compact')
  check('/compact: no error', !ev.some((e) => e.type === 'error'))
  check('/compact: says it starts compacting', ev.some((e) => e.type === 'compact' && e.state === 'start' && e.auto === false))
  const sum1 = summaries[from]
  check('/compact: the summariser was asked once', summaries.length === from + 1)
  check('/compact: the summariser gets the structured prompt', /## Files and paths/.test(sum1?.messages[0].content ?? '') && /## Next step/.test(sum1?.messages[0].content ?? ''))
  check('/compact: the summariser gets the whole conversation', /first question about apples/.test(sum1?.messages[1].content ?? '') && /ANSWER to second question/.test(sum1?.messages[1].content ?? ''))
  check('/compact: no instructions without any', !/<instructions>/.test(sum1?.messages[1].content ?? ''))
  check('/compact: the summariser is offered no tools', !sum1?.tools?.length)
  let t = await thread(a)
  const boundary = t.messages.at(-1)
  check('/compact: the thread ends with the compaction', boundary?.role === 'compact' && boundary.content.includes('FAKE SUMMARY') && boundary.compact?.auto === false)
  check('/compact: it summarised the 4 messages before it', boundary?.compact?.messages === 4)
  check('/compact: the whole history is still there', t.messages.filter((m) => m.role === 'user').length === 2 && t.messages.length === 5)
  check('/compact: no /compact message is saved as yours', !t.messages.some((m) => m.content.startsWith('/compact')))
  check('/compact: the thread is not marked as interrupted', !t.thread.interrupted)
  await say(a, 'third question about plums')
  const after = lastMain()
  check('after /compact: the system prompt comes first', after.messages[0].role === 'system')
  check('after /compact: then the summary, as a note from the app', after.messages[1].role === 'user' && after.messages[1].content.startsWith(NOTE) && after.messages[1].content.includes('<summary>\n## User goals and requests\nFAKE SUMMARY'))
  check('after /compact: then the new message', after.messages[2]?.role === 'user' && after.messages[2].content === 'third question about plums' && after.messages.length === 3)
  check('after /compact: the messages before it are not sent', !/apples|pears/.test(text(after)))

  // 2. /compact with instructions, compacting the compaction.
  const from2 = summaries.length
  await say(a, '/compact keep the plum details')
  const sum2 = summaries[from2]
  check('/compact with instructions: they reach the summariser', /<instructions>\nkeep the plum details\n<\/instructions>/.test(sum2?.messages[1].content ?? ''))
  check('/compact again: the earlier summary is summarised too', /\[Summary of the conversation before this[^\]]*\]\n## User goals and requests\nFAKE SUMMARY/.test(sum2?.messages[1].content ?? ''))
  check('/compact again: the messages before the first boundary are not', !/apples|pears/.test(sum2?.messages[1].content ?? ''))
  t = await thread(a)
  check('/compact with instructions: saved with the compaction', t.messages.at(-1)?.compact?.instructions === 'keep the plum details' && /focus: keep the plum details/.test(t.messages.at(-1)?.content ?? ''))
  await say(a, 'fourth question')
  check('after the second /compact: only the latest summary is sent', (text(lastMain()).match(/<summary>/g) ?? []).length === 1 && text(lastMain()).includes(`FAKE SUMMARY ${from2 + 1}`) && !/plums/.test(text(lastMain()).replace(/FAKE SUMMARY[^\n]*/g, '')))
  const nothing = await call('POST', `/api/agents/threads/${a}/messages`, { text: '/compact' })
  check('/compact: allowed again once something was said', nothing.status === 200)
  await nothing.text()
  const twice = await call('POST', `/api/agents/threads/${a}/messages`, { text: '/compact' })
  check('/compact with nothing new: refused before it streams (409)', twice.status === 409 && /Nothing new to compact/.test(await twice.text()))

  // 3. The context breakdown shows the summary as its own part.
  const ctx = (await (await api('GET', `/api/agents/threads/${a}/context`)).json()) as { parts: { label: string; tokens: number }[]; compaction: { times: number; hidden: number } | null; autoCompact: number | null }
  check('context: the summary is a part of its own', ctx.parts.some((p) => p.label === 'Summary of earlier messages' && p.tokens > 0))
  check('context: only the messages since are counted', ctx.parts.find((p) => p.label.startsWith('Your messages'))?.label === 'Your messages (0)')
  check(`context: compacted 3 times, standing in for the messages before (${JSON.stringify(ctx.compaction)})`, ctx.compaction?.times === 3 && ctx.compaction.hidden === 8)
  check('context: says the threshold', ctx.autoCompact === 85)

  // 4. By itself, before a message that would take the context past the threshold.
  await settings({ autoCompact: true, compactAt: 60 })
  const limit = Math.floor((SMALL_WINDOW * 60) / 100)
  const b = await newThread(SMALL)
  const base = ((await (await api('GET', `/api/agents/threads/${b}/context`)).json()) as { estimate: number }).estimate
  check(`threshold: the thread starts well under it (${base} of ${limit} tokens)`, base < limit - 2000)
  const pad = { name: 'pad.txt', source: 'test', kind: 'text', mime: 'text/plain', text: 'padding '.repeat(Math.ceil(((limit - base) * 4 + 4000) / 8)) }
  const from4 = summaries.length
  await say(b, 'SCENARIO plain here is a big file', [pad])
  check('threshold: one big message alone is not compacted', summaries.length === from4)
  const ev4 = await say(b, 'SCENARIO plain and now a small one')
  check('threshold: the turn says it compacts by itself', ev4.some((e) => e.type === 'compact' && e.state === 'start' && e.auto === true) && !ev4.some((e) => e.type === 'error'))
  t = await thread(b)
  const auto = t.messages.find((m) => m.role === 'compact')
  const autoAt = t.messages.findIndex((m) => m.role === 'compact')
  check('threshold: compacted by itself', summaries.length === from4 + 1 && auto?.compact?.auto === true && auto.compact.reason === 'threshold')
  check('threshold: before the new message, which stays whole after it', t.messages[autoAt + 1]?.role === 'user' && t.messages[autoAt + 1].content === 'SCENARIO plain and now a small one' && !auto?.compact?.request)
  check('threshold: the file is named for the model', auto?.compact?.files?.includes('pad.txt (test)') === true)
  check('threshold: the next call gets the summary, the files named and the message', text(lastMain()).includes('<summary>') && text(lastMain()).includes('pad.txt (test)') && !text(lastMain()).includes('padding padding') && lastMain().messages.at(-1)?.content === 'SCENARIO plain and now a small one')

  // ...and not when it is switched off.
  await settings({ autoCompact: false, compactAt: 60 })
  const c = await newThread(SMALL)
  await say(c, 'SCENARIO plain here is a big file', [pad])
  const from5 = summaries.length
  await say(c, 'SCENARIO plain and now a small one')
  check('switched off: nothing is compacted', summaries.length === from5 && !(await thread(c)).messages.some((m) => m.role === 'compact'))
  await settings({ autoCompact: true, compactAt: 85 })

  // 5. The model says it is too long: compacted, and asked once more.
  const d = await newThread()
  await say(d, 'SCENARIO plain before the overflow')
  const from6 = mains.length
  const ev6 = await say(d, 'SCENARIO overflow please answer')
  check('too long: no error', !ev6.some((e) => e.type === 'error'))
  check('too long: shown as an automatic compaction', ev6.some((e) => e.type === 'compact' && e.state === 'start' && e.auto === true))
  t = await thread(d)
  const over = t.messages.find((m) => m.role === 'compact')
  check('too long: compacted because of it', over?.compact?.auto === true && over.compact.reason === 'overflow')
  check('too long: the message it worked on is kept word for word', over?.compact?.request === 'SCENARIO overflow please answer')
  check('too long: refused once, then answered', mains.length === from6 + 2 && t.messages.at(-1)?.role === 'assistant' && t.messages.at(-1)?.content.startsWith('ANSWER'))
  check('too long: the retry carries the message in the note', text(lastMain()).includes('<message>\nSCENARIO overflow please answer\n</message>'))
  check('too long: not marked as interrupted', !t.thread.interrupted)
  // Switched off, the refusal is what the user sees.
  await settings({ autoCompact: false })
  const e2 = await newThread()
  await say(e2, 'SCENARIO plain before')
  const ev7 = await say(e2, 'SCENARIO overflow again')
  check('too long, switched off: the refusal is the error', ev7.some((e) => e.type === 'error' && e.error?.includes('exceeded max context length')))
  await settings({ autoCompact: true, compactAt: 85 })

  // 6. /compact while a turn runs: refused as a message, queued otherwise, run after the turn.
  const f = await newThread()
  await say(f, 'SCENARIO plain to have something')
  const slow = api('POST', `/api/agents/threads/${f}/messages`, { text: 'SCENARIO slow take your time' }).then(events)
  await waitFor('the slow turn to start', () => release !== null)
  const refused = await call('POST', `/api/agents/threads/${f}/messages`, { text: '/compact' })
  check('while running: /compact as a message is refused (409)', refused.status === 409)
  await refused.text()
  const q = (await (await api('POST', `/api/agents/threads/${f}/queue`, { text: '/compact keep it short' })).json()) as { thread: ThreadInfo }
  check('while running: /compact is queued', q.thread.queue.length === 1)
  const o = (await (await api('POST', `/api/agents/threads/${f}/override`, { text: '/compact' })).json()) as { queued: boolean; thread: ThreadInfo }
  check('while running: Send instead with /compact queues it too', o.queued && o.thread.queue.length === 2)
  const from8 = summaries.length
  release!()
  const ev8 = await slow
  t = await thread(f)
  check('while running: the turn answered first', t.messages.some((m) => m.role === 'assistant' && m.content === 'Working on it: done'))
  check('while running: then the queued /compact ran, once (the second had nothing new)', summaries.length === from8 + 1 && t.messages.filter((m) => m.role === 'compact').length === 1)
  check('while running: with its instructions', t.messages.at(-1)?.compact?.instructions === 'keep it short')
  check('while running: on the same stream, without errors', ev8.some((e) => e.type === 'message' && e.message?.role === 'compact') && !ev8.some((e) => e.type === 'error'))
  check('while running: the queue is empty and nothing is interrupted', !t.thread.queue.length && !t.thread.interrupted && !t.thread.running)

  // 7. Retry right after a /compact: the last turn is answered again, and the compaction after it goes.
  await api('POST', `/api/agents/threads/${a}/retry`, {}).then(events)
  t = await thread(a)
  check('retry after /compact: the compaction after the last message went', t.messages.at(-1)?.role === 'assistant' && t.messages.filter((m) => m.role === 'compact').length === 2)

  // 8. Rewind across a boundary: one after it keeps it, one before it removes it.
  const g = await newThread()
  await say(g, 'SCENARIO plain one about cherries')
  await say(g, 'SCENARIO plain two')
  await say(g, '/compact')
  await say(g, 'SCENARIO plain three')
  t = await thread(g)
  const three = t.messages.find((m) => m.content === 'SCENARIO plain three')!
  const two = t.messages.find((m) => m.content === 'SCENARIO plain two')!
  await api('POST', `/api/agents/threads/${g}/rewind`, { messageId: three.id })
  check('rewind after the boundary: the compaction stays', (await thread(g)).messages.at(-1)?.role === 'compact')
  const rw = (await (await api('POST', `/api/agents/threads/${g}/rewind`, { messageId: two.id })).json()) as { removed: number }
  t = await thread(g)
  check('rewind before the boundary: the compaction goes with what it summarised', rw.removed === 3 && !t.messages.some((m) => m.role === 'compact') && t.messages.length === 2)
  await say(g, 'SCENARIO plain two again')
  check('rewind before the boundary: the next call gets the messages again, no summary', text(lastMain()).includes('one about cherries') && !text(lastMain()).includes('<summary>'))

  // 9. A /compact that fails: says so, Retry compacts again and keeps the messages.
  failSummaries = 1
  const ev9 = await say(g, '/compact the second try')
  t = await thread(g)
  check('failed /compact: an error on the stream', ev9.some((e) => e.type === 'error' && /Could not compact/.test(e.error ?? '')) && ev9.some((e) => e.type === 'compact' && e.state === 'failed'))
  check('failed /compact: the thread says it was a compaction', t.thread.interrupted?.reason === 'failed' && !!t.thread.interrupted.compact)
  const kept = t.messages.length
  await api('POST', `/api/agents/threads/${g}/retry`, {}).then(events)
  t = await thread(g)
  check('failed /compact, Retry: compacted, nothing removed', t.messages.length === kept + 1 && t.messages.at(-1)?.compact?.instructions === 'the second try' && !t.thread.interrupted)

  // 10. A shared link never carries the summary, and shows the conversation itself.
  const share = (await (await api('POST', `/api/agents/threads/${g}/share`, { kind: 'thread' })).json()) as { token: string }
  const page = await (await fetch(`${server.origin}/s/${share.token}`)).text()
  check('shared link: the messages are there, the summary is not', page.includes('one about cherries') && !page.includes('FAKE SUMMARY'))

  // 11. A Spotlight quick answer compacts like any thread; its answer is the agent's, not the summary.
  const h = await newThread(BIG, { quick: true })
  await say(h, 'SCENARIO plain quick one')
  await say(h, '/compact')
  const quick = ((await (await api('GET', '/api/agents/quick')).json()) as { thread: { id: string }; answer: string }[]).find((x) => x.thread.id === h)
  check('quick answer: still the answer, not the summary', !!quick && quick.answer.startsWith('ANSWER') && !quick.answer.includes('FAKE SUMMARY'))

  // 12. After a restart the boundary is still there, and the model still gets the summary.
  await server.stop()
  await server.start()
  await sleep(100)
  await say(g, 'SCENARIO plain after the restart')
  check('restart: the next call still starts from the summary', text(lastMain()).includes('<summary>') && !text(lastMain()).includes('one about cherries'))
} catch (e) {
  check(`ran to the end (${(e as Error).message})`, false)
  console.error(server.log)
} finally {
  await server.dispose()
  ollama.close()
}
finish()
