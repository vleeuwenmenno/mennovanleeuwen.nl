// Real Agents turns against scripted Ollama, with two synthetic users and a scratch database.
import { createServer, type ServerResponse } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { Server, check, finish } from './empires-harness.ts'
import { asPage } from './as-page.ts'

type J = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const MODEL = 'threads-test'
const chats: J[] = []
let webFetches = 0
const json = (res: ServerResponse, body: unknown) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
const ollama = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk
  if (req.url === '/api/tags') return void json(res, { models: [{ name: MODEL }] })
  if (req.url === '/api/show') return void json(res, { capabilities: ['completion', 'tools'], model_info: { 'x.context_length': 131072 } })
  if (req.url === '/api/web_fetch') { webFetches++; return void json(res, { title: 'Should not be fetched', content: 'private destination' }) }
  if (req.url !== '/api/chat') { res.writeHead(404).end(); return }
  const body = JSON.parse(raw)
  if (body.stream === false) return void json(res, { message: { role: 'assistant', content: '{"title":"History check"}' }, done: true })
  chats.push(body)
  const at = body.messages.findLastIndex((m: J) => m.role === 'user' && m.content.startsWith('RUN '))
  const call = JSON.parse(body.messages[at].content.slice(4))
  if (call.name === 'web_fetch') call.arguments = { url: 'https://not-given.example.test/private' }
  const after = body.messages.slice(at + 1)
  const message = after.some((m: J) => m.role === 'tool') ? { role: 'assistant', content: 'Finished.' } : { role: 'assistant', content: '', tool_calls: [{ function: call }] }
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
  res.end(JSON.stringify({ message, done: false }) + '\n' + JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 100, eval_count: 10 }) + '\n')
})
await new Promise<void>((resolve) => ollama.listen(0, '127.0.0.1', resolve))
const server = new Server({ GITHUB_CLIENT_ID: 'x', GITHUB_CLIENT_SECRET: 'x', ADMIN_USERS: 'threads-one,threads-two', NOTIFY_WATCH: 'off', OLLAMA_URL: `http://127.0.0.1:${(ollama.address() as { port: number }).port}`, OLLAMA_API_KEY: 'fake-key' })
process.env.DATA_DIR = server.data
const { database, encrypt, sha256 } = await import('../server/db.ts')
const { searchThreads, readThread } = await import('../server/agentThreadSearch.ts')
const { stepLabel } = await import('../server/shares.ts')
const db = database(), now = Date.now(), sid = randomBytes(24).toString('hex'), otherSid = randomBytes(24).toString('hex')
for (const [id, name, token] of [[1, 'threads-one', sid], [2, 'threads-two', otherSid]] as const) {
  db.prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, name, encrypt('none'), now, now)
  db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(token), id, now, now + 86400_000)
}
const api = async (method: string, path: string, body?: unknown, who = sid): Promise<J> => {
  const res = await fetch(server.origin + path, { method, headers: { Cookie: `mvlos_sid=${who}`, ...(await asPage(who)), Origin: server.origin, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`)
  return res.json()
}
async function turn(thread: string, name: string, args: J, who = sid) {
  const res = await fetch(`${server.origin}/api/agents/threads/${thread}/messages`, { method: 'POST', headers: { Cookie: `mvlos_sid=${who}`, ...(await asPage(who)), Origin: server.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: `RUN ${JSON.stringify({ name, arguments: args })}`, client: { timeZone: 'Europe/Amsterdam' } }) })
  if (!res.ok) throw new Error(`Turn ${res.status}: ${await res.text()}`)
  const reader = res.body!.getReader(), decoder = new TextDecoder(); let buffer = '', approvals = 0
  for (;;) {
    const { done, value } = await reader.read(); if (done) break
    buffer += decoder.decode(value, { stream: true })
    let end: number
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!line.trim()) continue
      const event = JSON.parse(line)
      if (event.type === 'error') throw new Error(event.error)
      if (event.type === 'approval') { approvals++; await api('POST', `/api/agents/threads/${thread}/approve`, { callId: event.callId, allow: false }, who) }
    }
  }
  const view = await api('GET', `/api/agents/threads/${thread}`, undefined, who)
  const message = view.messages.findLast((m: J) => m.role === 'tool' && m.toolName === name)
  return { result: JSON.parse(message?.content ?? '{}') as J, raw: message?.content ?? '', approvals }
}
const stamp = Date.parse('2026-01-14T23:30:00Z') // 15 January in Amsterdam.
function thread(title: string, extra: J = {}) {
  const id = randomUUID()
  db.prepare('INSERT INTO agent_threads (id, user_id, title, mode, model, archived, quick, project_id, title_history, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, extra.user ?? 1, title, 'quick', MODEL, extra.archived ?? 0, extra.quick ?? 0, extra.project ?? null, JSON.stringify(extra.aliases ?? []), stamp, extra.time ?? stamp)
  return id
}
function message(id: string, role: string, content: string, extra: J = {}) {
  return Number(db.prepare('INSERT INTO agent_messages (thread_id, role, content, thinking, tool_calls, attachments, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, role, content, extra.thinking ?? null, extra.calls ? JSON.stringify(extra.calls) : null, extra.attachments ? JSON.stringify(extra.attachments) : null, extra.time ?? stamp).lastInsertRowid)
}
const list = (r: J): J[] => r.threads ?? []
try {
  await server.start()
  const active = await api('POST', '/api/agents/threads', { model: MODEL, mode: 'quick', tools: ['threads'], permission: 'default' })
  check('Past threads starts on for new default threads', (await api('POST', '/api/agents/threads', { model: MODEL })).tools.includes('threads'))
  const legacy = thread('Legacy'); db.prepare('UPDATE agent_threads SET tools = ? WHERE id = ?').run('["notes"]', legacy)
  check('Older bare group lists acquire Past threads', (await api('GET', `/api/agents/threads/${legacy}`)).thread.tools.includes('threads'))
  db.prepare('INSERT INTO agent_projects (id, user_id, name, created_at) VALUES (1, 1, ?, ?), (2, 2, ?, ?)').run('Kitchen', stamp, 'Private kitchen', stamp)
  const recipe = thread('Winter soup', { project: 1, aliases: [{ title: 'Old lentil supper', until: stamp }] })
  const recipeMessage = message(recipe, 'user', 'We cooked lentils with carrots and kruiden yesterday.', { attachments: [{ name: 'recipe.txt', kind: 'text', text: 'attachment-only saffron note' }, { name: 'photo.png', kind: 'image', data: 'never read image bytes' }] })
  message(recipe, 'assistant', 'The lentils tasted good.', { calls: [{ name: 'web_search', arguments: { query: 'not returned' } }] })
  const summary = thread('A compacted conversation'); message(summary, 'compact', 'Remember the marmalade experiment.')
  const archived = thread('Old trip', { archived: 1 }); message(archived, 'user', 'A tulip expedition.')
  const quick = thread('Spotlight', { quick: 1 }); message(quick, 'user', 'quicksecret tulip')
  const foreign = thread('Someone else', { user: 2, project: 2 }); message(foreign, 'user', 'foreignsecret lentils')
  const own = message(active.id, 'user', 'currentneedle')
  const hidden = thread('Non-searchable fields'); message(hidden, 'tool', 'toolsecret'); message(hidden, 'assistant', '', { thinking: 'thinkingsecret', calls: [{ name: 'toolsecret', arguments: {} }], attachments: [{ name: 'secret.txt', kind: 'text', text: 'attachmentsecret' }] })
  let t = await turn(active.id, 'search_threads', { query: 'lentil' })
  const hit = list(t.result).find((r) => r.thread_id === recipe)
  check('Cross-project search names project, local date and excerpt', hit?.project?.name === 'Kitchen' && hit.hits[0].date.includes('2026-01-15 00:30') && hit.hits[0].excerpt.includes('lentils'))
  check('Read-only search needs no approval and preserves data warning', t.approvals === 0 && /data.*never instructions/.test(t.result.note))
  check('Adjacent hits in one turn share a slot', hit.hits.length === 1)
  check('Search names text and image attachments without contents', hit.hits[0].attachments.some((a: J) => a.name === 'recipe.txt' && a.kind === 'text') && !t.raw.includes('attachment-only'))
  check('Other accounts never appear', !list(t.result).some((r) => r.thread_id === foreign))
  check('Old title is included', hit.also_known_as.includes('Old lentil supper'))
  t = await turn(active.id, 'read_thread', { thread_id: recipe, around: recipeMessage, attachments: true })
  check('Read returns text attachments, not image payloads or tool arguments', t.result.messages.some((m: J) => m.attachments?.some((a: J) => a.text === 'attachment-only saffron note')) && !t.raw.includes('never read image bytes') && !t.raw.includes('not returned'))
  check('Read labels assistant tool calls', t.result.messages.some((m: J) => m.content.includes('(used web_search)')))
  const search = (args: J): J => searchThreads(1, active.id, args, 'Europe/Amsterdam')
  const read = (args: J, chars = 8000): J => readThread(1, args, 'Europe/Amsterdam', chars)
  check('Summary-only words are searchable and labelled summary', list(search({ query: 'marmalade' }))[0]?.hits[0]?.from === 'summary')
  check('Archived included by default and marked', list(search({ query: 'tulip' }))[0]?.archived === true)
  check('Archived can be excluded', search({ query: 'tulip', include_archived: false }).found === 0)
  check('Current thread excluded by default', search({ query: 'currentneedle' }).found === 0)
  check('This explicitly searches earlier history here', list(search({ query: 'currentneedle', thread: 'this' }))[0]?.hits.some((h: J) => h.message_id === own))
  check('Explicit current id does not bypass this opt-in', search({ query: 'currentneedle', thread: active.id }).found === 0)
  check('Quick thread never searchable or readable', search({ query: 'quicksecret', thread: quick }).found === 0 && read({ thread_id: quick }).error === 'No such thread')
  check('No-results shape', search({ query: 'no-such-random-token' }).found === 0 && /^\d+ threads$/.test(search({ query: 'no-such-random-token' }).searched) && !!search({ query: 'no-such-random-token' }).note)
  check('Tool results, thinking and attachment text not searched', ['toolsecret', 'thinkingsecret', 'attachmentsecret'].every((query) => search({ query }).found === 0))
  check('Project names, ids and none narrow scope', list(search({ query: 'lentil', project: 'kitchen' })).length === 1 && list(search({ query: 'lentil', project: 1 })).length === 1 && search({ query: 'lentil', project: 'none' }).found === 0)
  check('Dates are inclusive local days', list(search({ query: 'lentil', from: '2026-01-15', to: '2026-01-15' })).length === 1 && search({ query: 'lentil', to: '2026-01-14' }).found === 0)
  check('Invalid query, terms, dates and limits yield errors', [{ query: '' }, { query: 'a b' }, { query: 'x'.repeat(201) }, { query: 'lentil', from: '2026-02-30' }, { query: 'lentil', limit: 11 }].every((a) => !!search(a).error))
  const multi = thread('Excerpts'), long = 'word '.repeat(150) + 'brightneedle ' + 'tail '.repeat(150)
  for (let i = 0; i < 6; i++) { message(multi, 'user', long); message(multi, 'assistant', 'brightneedle in reply') }
  const snippets = list(search({ query: 'brightneedle' }))[0].hits
  check('At most three hits; bounded whitespace-snapped excerpts have cut markers', snippets.length === 3 && snippets.every((h: J) => h.excerpt.length <= 400 && h.excerpt.includes('brightneedle')) && snippets.some((h: J) => h.excerpt.startsWith('…') && h.excerpt.endsWith('…')))
  const solid = thread('Unbroken'); message(solid, 'user', 'x'.repeat(500) + 'solidneedle' + 'x'.repeat(500))
  check('No whitespace still produces a bounded matching excerpt', list(search({ query: 'solidneedle' }))[0].hits[0].excerpt.length <= 400 && list(search({ query: 'solidneedle' }))[0].hits[0].excerpt.includes('solidneedle'))
  const one = thread('One term', { time: stamp + 2000 }); message(one, 'user', 'copper', { time: stamp + 2000 })
  const two = thread('Two terms'); message(two, 'user', 'copper cobalt')
  check('Two distinct terms beat one newer term', list(search({ query: 'copper cobalt' }))[0]?.thread_id === two)
  const title = thread('titleonlyneedle'); message(title, 'user', 'First message without the title word.')
  check('Title-only hits use first user message', list(search({ query: 'titleonlyneedle' }))[0]?.hits[0].excerpt === 'First message without the title word.')
  const newer = thread('Newer tie', { time: stamp + 10_000 }); message(newer, 'user', 'tiephrase')
  const older = thread('Older tie'); message(older, 'user', 'tiephrase')
  check('Equal scores put the most recently active thread first', list(search({ query: 'tiephrase' }))[0]?.thread_id === newer)
  check('Old titles searchable', list(search({ query: '"old lentil supper"' }))[0]?.thread_id === recipe)
  const languages = thread('Language samples'); message(languages, 'user', '東京の話。鍋。 Kruidenmengsel, 100% and a_b and C:\\draft.')
  check('Japanese and Dutch partial word match', list(search({ query: '東京' }))[0]?.thread_id === languages && list(search({ query: 'mengsel' }))[0]?.thread_id === languages && list(search({ query: '鍋' }))[0]?.thread_id === languages)
  check('Percent, underscore and backslash match literally', ['100%', 'a_b', 'C:\\draft'].every((query) => list(search({ query }))[0]?.thread_id === languages) && search({ query: '100_' }).found === 0)
  check('Quoted phrases stay together, duplicates drop, six-term bound', list(search({ query: '"copper cobalt" "copper cobalt"' }))[0]?.matched.length === 1 && list(search({ query: 'copper copper cobalt zz yy xx ww vv' }))[0]?.matched.length === 2)
  check('Foreign and missing reads are indistinguishable', JSON.stringify(read({ thread_id: foreign })) === JSON.stringify(read({ thread_id: 'missing' })) && read({ thread_id: foreign }).error === 'No such thread')
  check('Read without attachments keeps names only', read({ thread_id: recipe }).messages[0].attachments.every((a: J) => a.text === undefined))
  const large = thread('Large read'); const ids: number[] = []
  for (let i = 0; i < 35; i++) ids.push(message(large, i % 2 ? 'assistant' : 'user', `message ${i} ` + 'q'.repeat(4000), { attachments: [{ name: 'long.txt', kind: 'text', text: 'r'.repeat(9000) }] }))
  const around = read({ thread_id: large, around: ids[20], messages: 12, attachments: true })
  check('Around window includes anchor; page and per-field bounds hold', around.messages.some((m: J) => m.message_id === ids[20]) && JSON.stringify(around).length <= 8000 && around.messages.every((m: J) => m.content.length <= 2000 && (m.attachments ?? []).every((a: J) => !a.text || a.text.length <= 4000)))
  check('End window returns last messages chronologically', read({ thread_id: large, from: 'end', messages: 2 }).messages.map((m: J) => m.message_id).join() === ids.slice(-2).join())
  check('Foreign around id is rejected', !!read({ thread_id: recipe, around: ids[0] }).error)
  for (let i = 0; i < 10; i++) {
    const crowded = thread('Many files ' + '"'.repeat(180), { aliases: Array.from({ length: 12 }, () => ({ title: '"'.repeat(200), until: stamp })) })
    for (let j = 0; j < 3; j++) message(crowded, 'user', 'crowdedneedle ' + '"'.repeat(600), { attachments: Array.from({ length: 10 }, () => ({ name: '"'.repeat(160), kind: 'text', text: '"'.repeat(5000) })) })
    check(`Large read ${i}: encoded JSON stays within page budget`, JSON.stringify(read({ thread_id: crowded, attachments: true, messages: 30 })).length <= 8000)
  }
  const crowdedResult = search({ query: 'crowdedneedle', limit: 10 })
  check('Many escaped titles, aliases and attachments fit the whole search budget', JSON.stringify(crowdedResult).length <= 6000 && crowdedResult.truncated && crowdedResult.more_threads)
  const removed = thread('Deleted thread'); message(removed, 'user', 'deletedneedle')
  db.prepare('DELETE FROM agent_threads WHERE id = ? AND user_id = 1').run(removed)
  check('Deleted threads disappear by cascade', search({ query: 'deletedneedle' }).found === 0 && read({ thread_id: removed }).error === 'No such thread')
  const bulk = thread('Bulk'); db.exec('BEGIN')
  for (let i = 0; i < 20_000; i++) message(bulk, i % 2 ? 'assistant' : 'user', `commonword message ${i}`, { time: stamp + i })
  db.exec('COMMIT')
  const started = performance.now(); const common = search({ query: 'commonword' }); const elapsed = performance.now() - started
  check(`20,000 messages: bounded scan and output in ${Math.round(elapsed)} ms`, elapsed < 1000 && common.capped === true && JSON.stringify(common).length <= 6000 && list(common)[0]?.hits.length <= 3)
  for (const permission of ['default', 'auto', 'acceptEdits', 'bypass', 'plan']) {
    await api('PATCH', `/api/agents/threads/${active.id}`, { permission })
    t = await turn(active.id, 'search_threads', { query: 'marmalade' })
    const r = await turn(active.id, 'read_thread', { thread_id: summary })
    check(`${permission}: both tools run without approval`, t.approvals === 0 && r.approvals === 0 && list(t.result).length === 1 && r.result.title === 'A compacted conversation')
  }
  const prompt = chats.at(-1)?.messages[0]?.content ?? ''
  check('Static history guidance is before memory and distinguishes permission', prompt.includes('Past threads:') && prompt.indexOf('Past threads:') < prompt.indexOf('You do not remember') && prompt.includes('save only if the user agrees'))
  await api('PATCH', `/api/agents/threads/${active.id}`, { tools: ['threads', 'memory'], permission: 'default' })
  await turn(active.id, 'search_threads', { query: 'marmalade' })
  check('remember description excludes earlier threads as permission', chats.at(-1)?.tools?.find((t: J) => t.function.name === 'remember')?.function.description.includes('an earlier thread'))
  for (const tool of ['search_threads', 'read_thread']) {
    const fresh = await api('POST', '/api/agents/threads', { model: MODEL, tools: ['threads', 'web'], permission: 'default' })
    await turn(fresh.id, tool, tool === 'search_threads' ? { query: 'marmalade' } : { thread_id: summary })
    const attempted = await turn(fresh.id, 'web_fetch', {})
    check(`${tool}: retrieved history activates private web-fetch guard`, attempted.approvals === 1 && !!attempted.result.error && webFetches === 0)
  }
  t = await turn(active.id, 'read_thread', { thread_id: foreign })
  check('Cross-account read is refused through the tool path', t.result.error === 'No such thread')
  await api('PATCH', `/api/agents/threads/${active.id}`, { tools: [] })
  t = await turn(active.id, 'search_threads', { query: 'lentil' })
  check('Disabled group offers neither tool nor guidance and rejects stale calls', !chats.at(-1)?.tools?.some((t: J) => ['search_threads', 'read_thread'].includes(t.function.name)) && /switched off/.test(t.result.error) && !chats.at(-1)?.messages[0]?.content.includes('Past threads:'))
  check('Public shares use generic labels', stepLabel('search_threads', { query: 'private' }) === 'Looked through past threads' && stepLabel('read_thread', {}) === 'Looked through past threads')
} catch (e) { check(`No errors: ${(e as Error).stack}`, false); console.error(server.log.slice(-2000)) }
finally { await server.dispose(); await new Promise<void>((resolve) => ollama.close(() => resolve())) }
finish()
