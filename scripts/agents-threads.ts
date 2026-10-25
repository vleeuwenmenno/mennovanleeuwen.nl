import { threadsCommand, threadSearchLines } from '../src/terminal/agents/threads.ts'
// Real Agents turns against scripted Ollama, with two synthetic users and a scratch database.
import { createServer, type ServerResponse } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { Server, check, finish } from './empires-harness.ts'
import { asPage } from './as-page.ts'

type J = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const MODEL = 'threads-test'
const chats: J[] = []
let webFetches = 0
// The title model's answers (requests with stream: false): a plain title unless a test sets its own.
const PLAIN_TITLE = (): string => '{"title":"History check"}'
let titleAnswer: (body: J) => string | Promise<string> = PLAIN_TITLE
const titleCalls: J[] = []
const json = (res: ServerResponse, body: unknown) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
const ollama = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk
  if (req.url === '/api/tags') return void json(res, { models: [{ name: MODEL }] })
  if (req.url === '/api/show') return void json(res, { capabilities: ['completion', 'tools'], model_info: { 'x.context_length': 131072 } })
  if (req.url === '/api/web_fetch') { webFetches++; return void json(res, { title: 'Should not be fetched', content: 'private destination' }) }
  if (req.url !== '/api/chat') { res.writeHead(404).end(); return }
  const body = JSON.parse(raw)
  if (body.stream === false) { titleCalls.push(body); return void json(res, { message: { role: 'assistant', content: await titleAnswer(body) }, done: true }) }
  chats.push(body)
  const at = body.messages.findLastIndex((m: J) => m.role === 'user' && m.content.startsWith('RUN '))
  const call = JSON.parse(body.messages[at].content.slice(4))
  // A turn whose model fails: the answer never comes.
  if (call.name === 'fail_turn') return void res.writeHead(400, { 'Content-Type': 'application/json' }).end('{"error":"scripted failure"}')
  if (call.name === 'web_fetch') call.arguments = { url: 'https://not-given.example.test/private' }
  const after = body.messages.slice(at + 1)
  const message = after.some((m: J) => m.role === 'tool') ? { role: 'assistant', content: 'Finished.' } : { role: 'assistant', content: '', tool_calls: [{ function: call }] }
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
  res.end(JSON.stringify({ message, done: false }) + '\n' + JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 100, eval_count: 10 }) + '\n')
})
await new Promise<void>((resolve) => ollama.listen(0, '127.0.0.1', resolve))
const server = new Server({ GITHUB_CLIENT_ID: 'x', GITHUB_CLIENT_SECRET: 'x', ADMIN_GITHUB_IDS: '1,2', NOTIFY_WATCH: 'off', OLLAMA_URL: `http://127.0.0.1:${(ollama.address() as { port: number }).port}`, OLLAMA_API_KEY: 'fake-key' })
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
  // Thread titles: parsing what the title model says, the stand-in title, and when titles change.
  const { pickTitle, pickRetitle, fallbackTitle, cleanTitle } = await import('../server/agents.ts')
  check('Title: a fenced JSON answer gives its title', pickTitle('```json\n{"title": "Lentil soup"}\n```') === 'Lentil soup')
  check('Title: JSON inside chatter gives its title', pickTitle('Sure! Here it is: {"title": "Postgres vs SQLite"} Hope that helps.') === 'Postgres vs SQLite')
  check('Title: a bare code fence, or only symbols, is no title', pickTitle('```') === null && pickTitle('```\n```') === null && pickTitle('...') === null && pickTitle('{"title": "---"}') === null && cleanTitle('```') === null)
  check('Title: backticks are trimmed off', cleanTitle('`Lentil soup`') === 'Lentil soup')
  check('Fallback title: skips code to the first prose line', fallbackTitle('```ts\nconst x = 1\n```\n\nwhy does this throw?') === 'Why does this throw')
  check('Fallback title: code only is never a code fence', fallbackTitle('```\n{ "a": 1 }\n```') === 'Code snippet' && fallbackTitle('```\n```', ['server.log']) === 'server.log' && fallbackTitle('', []) === 'Untitled thread')
  check('Retitle: a fenced {"title"} is taken', pickRetitle('```json\n{"title": "Bread baking"}\n```', 'Lentil soup') === 'Bread baking')
  check('Retitle: {"keep": true} keeps, fenced or not, and so do unclear answers', pickRetitle('{"keep": true}', 'Lentil soup') === null && pickRetitle('```json\n{"keep": true}\n```', 'Lentil soup') === null && pickRetitle('I think it fits.', 'Lentil soup') === null && pickRetitle('{"title": "```"}', 'Lentil soup') === null)
  const view = async (id: string) => (await api('GET', `/api/agents/threads/${id}`)).thread as J
  const titleWait = async (id: string, done: (t: J) => boolean) => {
    for (let i = 0; i < 100; i++) {
      const t = await view(id)
      if (done(t) && !t.titling && !t.checkingTitle) return t
      await new Promise((r) => setTimeout(r, 50))
    }
    return view(id)
  }
  const RETITLE = (b: J) => String(b.messages[0]?.content ?? '').startsWith('You keep the title')
  // The first title from the question is a code fence, so the stand-in is used; with the answer the model knows better.
  titleAnswer = (b) => (RETITLE(b) ? '{"keep": true}' : String(b.messages.at(-1)?.content ?? '').includes('Agent:') ? '```json\n{"title":"Zebrafish care guide"}\n```' : '```')
  const named = await api('POST', '/api/agents/threads', { model: MODEL, tools: ['threads'], permission: 'default' })
  await turn(named.id, 'search_threads', { query: 'zqone' })
  let tt = await titleWait(named.id, (x) => x.title === 'Zebrafish care guide')
  check('First title: named again from question and answer after the first answer', tt.title === 'Zebrafish care guide' && tt.titleSource === 'auto')
  check('First title: the stand-in it replaced was not a code fence', tt.aliases.length === 1 && tt.aliases[0].title !== '```' && /[a-z]/i.test(tt.aliases[0].title))
  // Later turns: the check keeps the title until the conversation moved on, then renames it.
  let calls = titleCalls.length
  titleAnswer = (b) => (RETITLE(b) ? '```json\n{"title":"Kayak repair"}\n```' : '{"title":"Not asked"}')
  for (let i = 0; i < 2; i++) await turn(named.id, 'search_threads', { query: 'zqtwo' })
  tt = await titleWait(named.id, () => true)
  check('Title check: not asked before 3 messages', tt.title === 'Zebrafish care guide' && !titleCalls.slice(calls).some(RETITLE))
  await turn(named.id, 'search_threads', { query: 'zqtwo' })
  tt = await titleWait(named.id, (x) => x.title === 'Kayak repair')
  const asked = titleCalls.slice(calls).find(RETITLE)
  check('Title check: after 3 messages a fenced answer renames the thread', tt.title === 'Kayak repair' && tt.aliases[0]?.title === 'Zebrafish care guide')
  check('Title check: is given how the thread started and the latest messages', !!asked && /How it started:[\s\S]*Latest messages:/.test(asked.messages.at(-1).content))
  // A title set by hand is never changed: not after the first answer, not by the check.
  titleAnswer = (b) => (RETITLE(b) ? '{"title":"Model rename"}' : '{"title":"Model first title"}')
  const mine = await api('POST', '/api/agents/threads', { model: MODEL, tools: ['threads'], permission: 'default' })
  await turn(mine.id, 'search_threads', { query: 'zqthree' })
  await titleWait(mine.id, () => true)
  await api('PATCH', `/api/agents/threads/${mine.id}`, { title: 'My own name' })
  calls = titleCalls.length
  for (let i = 0; i < 4; i++) await turn(mine.id, 'search_threads', { query: 'zqthree' })
  await new Promise((r) => setTimeout(r, 300))
  tt = await titleWait(mine.id, () => true)
  check('User title: never changed automatically', tt.title === 'My own name' && tt.titleSource === 'user' && !titleCalls.slice(calls).length)
  // Races: the refinement after the first answer is slow, and something else writes the title meanwhile.
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const last = (b: J) => String(b.messages.at(-1)?.content ?? '')
  const kind = (b: J) => (RETITLE(b) ? 'check' : last(b).includes('at its end') ? 'regenerate' : last(b).includes('Agent:') ? 'refine' : 'first')
  let regenerated = 'Initial title'
  titleAnswer = async (b) => {
    const k = kind(b)
    if (k === 'refine') return (await sleep(700), '{"title":"Stale refinement"}')
    return JSON.stringify({ title: k === 'regenerate' ? regenerated : k === 'check' ? 'Not asked' : 'Initial title' })
  }
  const pendingRefine = async (id: string) => {
    for (let i = 0; i < 60 && !(await view(id)).checkingTitle; i++) await sleep(25)
    return (await view(id)).checkingTitle as boolean
  }
  for (const same of [true, false]) {
    regenerated = same ? 'Initial title' : 'Regenerated title'
    const raced = await api('POST', '/api/agents/threads', { model: MODEL, tools: ['threads'], permission: 'default' })
    await turn(raced.id, 'search_threads', { query: 'zqfour' })
    const waiting = await pendingRefine(raced.id)
    const regen = await api('POST', `/api/agents/threads/${raced.id}/retitle`, {})
    tt = await titleWait(raced.id, () => true)
    await sleep(800)
    tt = await titleWait(raced.id, () => true)
    check(`Race: Regenerate (${same ? 'same title' : 'new title'}) during a pending refinement wins`, waiting && regen.thread.title === regenerated && tt.title === regenerated && tt.titleSource === 'auto')
  }
  const renamed = await api('POST', '/api/agents/threads', { model: MODEL, tools: ['threads'], permission: 'default' })
  await turn(renamed.id, 'search_threads', { query: 'zqfive' })
  const waitingRename = await pendingRefine(renamed.id)
  await api('PATCH', `/api/agents/threads/${renamed.id}`, { title: 'Hand named' })
  await sleep(800)
  tt = await titleWait(renamed.id, () => true)
  check('Race: a rename during a pending refinement wins', waitingRename && tt.title === 'Hand named' && tt.titleSource === 'user')
  const sameName = await api('POST', '/api/agents/threads', { model: MODEL, tools: ['threads'], permission: 'default' })
  await turn(sameName.id, 'search_threads', { query: 'zqfive' })
  const waitingSame = await pendingRefine(sameName.id)
  await api('PATCH', `/api/agents/threads/${sameName.id}`, { title: 'Initial title' })
  await sleep(800)
  tt = await titleWait(sameName.id, () => true)
  check('Race: renaming to the same title during a pending refinement claims it', waitingSame && tt.title === 'Initial title' && tt.titleSource === 'user')
  const pinned = await api('POST', '/api/agents/threads', { model: MODEL, tools: ['threads'], permission: 'default' })
  await turn(pinned.id, 'search_threads', { query: 'zqfive' })
  const waitingPin = await pendingRefine(pinned.id)
  await api('PATCH', `/api/agents/threads/${pinned.id}`, { pinned: true })
  tt = await titleWait(pinned.id, (x) => x.title === 'Stale refinement')
  check('Race: a change without a title (pinning) leaves the refinement alone', waitingPin && tt.title === 'Stale refinement' && tt.titleSource === 'auto' && tt.pinned)
  const gone = await api('POST', '/api/agents/threads', { model: MODEL, tools: ['threads'], permission: 'default' })
  await turn(gone.id, 'search_threads', { query: 'zqfive' })
  const waitingGone = await pendingRefine(gone.id)
  await api('DELETE', `/api/agents/threads/${gone.id}`)
  await sleep(800)
  check('Race: deleting a thread during a pending refinement leaves nothing behind', waitingGone && !db.prepare('SELECT 1 FROM agent_threads WHERE id = ?').get(gone.id) && (await fetch(`${server.origin}/api/agents/threads/${gone.id}`, { headers: { Cookie: `mvlos_sid=${sid}`, ...(await asPage(sid)), Origin: server.origin } })).status === 404)
  // The same for the periodic check: Regenerate giving the same title while the check thinks wins.
  titleAnswer = async (b) => {
    const k = kind(b)
    if (k === 'check') return (await sleep(700), '{"title":"Stale check"}')
    return '{"title":"Initial title"}'
  }
  const checked = await api('POST', '/api/agents/threads', { model: MODEL, tools: ['threads'], permission: 'default' })
  for (let i = 0; i < 3; i++) await turn(checked.id, 'search_threads', { query: 'zqseven' }), await titleWait(checked.id, () => true)
  await turn(checked.id, 'search_threads', { query: 'zqseven' })
  const waitingCheck = await pendingRefine(checked.id)
  const regenCheck = await api('POST', `/api/agents/threads/${checked.id}/retitle`, {})
  await sleep(800)
  tt = await titleWait(checked.id, () => true)
  check('Race: Regenerate (same title) during a pending title check wins', waitingCheck && regenCheck.thread.title === 'Initial title' && tt.title === 'Initial title')
  // A first turn that fails still leaves the refinement for the first turn that answers.
  titleAnswer = (b) => JSON.stringify({ title: kind(b) === 'refine' ? 'Refined after failure' : kind(b) === 'check' ? 'Not asked' : 'Initial title' })
  const failing = await api('POST', '/api/agents/threads', { model: MODEL, tools: ['threads'], permission: 'default' })
  const failed = await turn(failing.id, 'fail_turn', {}).then(() => false, () => true)
  tt = await titleWait(failing.id, () => true)
  const sourceAfterFail = (db.prepare('SELECT title_source FROM agent_threads WHERE id = ?').get(failing.id) as J).title_source
  check('Failed first turn: the first title is set and still waits for its refinement', failed && tt.title === 'Initial title' && sourceAfterFail === 'first')
  await turn(failing.id, 'search_threads', { query: 'zqsix' })
  tt = await titleWait(failing.id, (x) => x.title === 'Refined after failure')
  check('Failed first turn: the next answered turn refines the title, once', tt.title === 'Refined after failure' && (db.prepare('SELECT title_source FROM agent_threads WHERE id = ?').get(failing.id) as J).title_source === 'auto')
  titleAnswer = PLAIN_TITLE
  const active = await api('POST', '/api/agents/threads', { model: MODEL, mode: 'quick', tools: ['threads'], permission: 'default' })
  check('Past threads starts on for new default threads', (await api('POST', '/api/agents/threads', { model: MODEL })).tools.includes('threads'))
  const legacy = thread('Legacy'); db.prepare('UPDATE agent_threads SET tools = ? WHERE id = ?').run('["notes"]', legacy)
  check('Older bare group lists acquire Past threads', (await api('GET', `/api/agents/threads/${legacy}`)).thread.tools.includes('threads'))
  db.prepare('INSERT INTO agent_projects (id, user_id, name, created_at) VALUES (1, 1, ?, ?), (2, 2, ?, ?)').run('Kitchen', stamp, 'Private kitchen', stamp)
  // Branches preserve the exact prefix and settings, without carrying live state or PNG bytes.
  const source = thread('Branch source', { project: 1, aliases: [{ title: 'Earlier subject', until: stamp }] })
  const profileId = Number(db.prepare('INSERT INTO agent_memories (user_id, text, created_at, image_profile) VALUES (1, ?, ?, ?)').run('Image profile', stamp, JSON.stringify({ name: 'Branch look', description: 'Quiet light', origin: 'user' })).lastInsertRowid)
  db.prepare('UPDATE agent_threads SET mode = ?, permission = ?, tools = ?, workdir = ?, image_config = ?, image_profile_id = ?, queue = ?, interrupted = ?, turn_at = ? WHERE id = ?').run('deep', 'plan', JSON.stringify({ on: ['images', 'threads'], seen: ['images', 'threads'] }), JSON.stringify({ repo: 'fixture', path: '/work', label: 'Work' }), JSON.stringify({ preset: 'sdxl', loras: [{ name: 'fixture.safetensors', weight: 0.8 }] }), profileId, JSON.stringify([{ id: randomUUID(), text: 'Not copied', attachments: [], createdAt: stamp }]), JSON.stringify({ reason: 'stopped', at: stamp }), stamp, source)
  message(source, 'user', 'Keep this', { attachments: [{ name: 'notes.txt', source: 'computer', kind: 'text', mime: 'text/plain', size: 4, text: 'full text' }] })
  const compactId = message(source, 'compact', 'Summary stays')
  db.prepare('UPDATE agent_messages SET compact = ? WHERE id = ?').run(JSON.stringify({ auto: false, messages: 1, before: 20, after: 5, model: MODEL }), compactId)
  message(source, 'assistant', '', { thinking: 'Retained thinking', calls: [{ name: 'generate_image', arguments: { prompt: 'A fixture' } }] })
  const artifact = randomUUID(), picture = Buffer.from('branch image bytes')
  db.prepare('INSERT INTO agent_images (id, thread_id, name, body, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?)').run(artifact, source, 'branch.png', picture, stamp, '{"prompt":"A fixture"}')
  const boundary = message(source, 'tool', JSON.stringify({ image: { id: artifact, url: `/api/agents/images/${artifact}` } }))
  db.prepare('UPDATE agent_messages SET tool_name = ? WHERE id = ?').run('generate_image', boundary)
  message(source, 'assistant', 'After the cut')
  const beforeBranch = db.prepare('SELECT * FROM agent_messages WHERE thread_id = ? ORDER BY id').all(source) as J[]
  const branch = await api('POST', `/api/agents/threads/${source}/branch`, { messageId: boundary })
  const copied = db.prepare('SELECT * FROM agent_messages WHERE thread_id = ? ORDER BY id').all(branch.thread.id) as J[]
  const contents = (rows: J[]) => rows.map(({ id: _id, thread_id: _thread, ...row }) => row)
  check('Branch copies exactly through the boundary, including thinking, calls, attachments and compaction', JSON.stringify(contents(copied)) === JSON.stringify(contents(beforeBranch.filter((m) => m.id <= boundary))))
  check('Branch leaves original messages untouched', JSON.stringify(db.prepare('SELECT * FROM agent_messages WHERE thread_id = ? ORDER BY id').all(source)) === JSON.stringify(beforeBranch))
  const sourceRow = db.prepare('SELECT * FROM agent_threads WHERE id = ?').get(source) as J, branchRow = db.prepare('SELECT * FROM agent_threads WHERE id = ?').get(branch.thread.id) as J
  check('Branch carries every requested setting', ['mode', 'model', 'tools', 'project_id', 'workdir', 'permission', 'image_config', 'image_profile_id'].every((key) => branchRow[key] === sourceRow[key]))
  check('Branch starts idle with no queue or pending approvals', !branch.thread.running && !branchRow.queue && !branchRow.interrupted && !branchRow.turn_at && branch.pending.length === 0)
  check('Branch title is manual, with original and earlier names in history', branchRow.title === 'Branch source — from 2026-01-14' && branchRow.title_source === 'user' && JSON.parse(branchRow.title_history).some((h: J) => h.title === 'Branch source') && JSON.parse(branchRow.title_history).some((h: J) => h.title === 'Earlier subject') && branchRow.title_mark === copied.at(-1)!.id)
  check('Branch refuses another account', await api('POST', `/api/agents/threads/${source}/branch`, { messageId: boundary }, otherSid).then(() => false, (e: Error) => e.message.startsWith('404:')))
  check('Branch refuses a message outside the thread', await api('POST', `/api/agents/threads/${active.id}/branch`, { messageId: boundary }).then(() => false, (e: Error) => e.message.startsWith('404:')))
  const { generatedImageForVision } = await import('../server/agentImages.ts')
  check('Branch image reference supplies the same private bytes to vision', generatedImageForVision({ id: 1 } as any, branch.thread.id, artifact).data === picture.toString('base64'))
  check('Branch does not duplicate stored PNG bytes', (db.prepare('SELECT COUNT(*) AS n FROM agent_images WHERE id = ?').get(artifact) as J).n === 1 && (db.prepare('SELECT SUM(length(body)) AS n FROM agent_images WHERE id = ?').get(artifact) as J).n === picture.length)
  const readPicture = async () => fetch(server.origin + `/api/agents/images/${artifact}`, { headers: { Cookie: `mvlos_sid=${sid}`, ...await asPage(sid) } })
  check('Branch image URL displays the same bytes', Buffer.from(await (await readPicture()).arrayBuffer()).equals(picture))
  await api('DELETE', `/api/agents/threads/${source}`)
  check('Deleting original preserves the branch image', (await readPicture()).status === 200 && generatedImageForVision({ id: 1 } as any, branch.thread.id, artifact).data === picture.toString('base64'))
  await api('DELETE', `/api/agents/threads/${branch.thread.id}`)
  check('Deleting the final branch reclaims its image', (await readPicture()).status === 404)
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
  const routeResult = await api('POST', '/api/agents/threads/search', { query: 'lentil', current_thread: active.id, client: { timeZone: 'Europe/Amsterdam' } })
  check('Explicit CLI route returns the same owned bounded search', routeResult.threads[0].thread_id === recipe && JSON.stringify(routeResult).length <= 6000)
  check('CLI parser handles queries, current-thread reuse and opening ids', threadsCommand('lentil').kind === 'search' && JSON.stringify(threadsCommand('this', 'lentil')) === JSON.stringify({ kind: 'search', query: 'lentil', current: true }) && threadsCommand('open ' + recipe).kind === 'open' && threadsCommand('open nonsense').kind === 'error' && threadsCommand('this').kind === 'error' && threadsCommand('x'.repeat(201)).kind === 'error')
  check('CLI output is clipped plain text with identifiers and project', threadSearchLines(routeResult as any, 50).every((line) => line.reduce((n, s) => n + [...s.t].length, 0) <= 50) && threadSearchLines(routeResult as any, 80).flat().some((s) => s.t.includes(recipe)) && threadSearchLines(routeResult as any, 80).flat().some((s) => s.t.includes('Kitchen')))
  check('CLI route cannot search another account or Spotlight', (await api('POST', '/api/agents/threads/search', { query: 'foreignsecret quicksecret' })).found === 0)
  check('CLI route defaults to excluding current thread', (await api('POST', '/api/agents/threads/search', { query: 'currentneedle', current_thread: active.id })).found === 0)
  check('CLI this includes current thread', (await api('POST', '/api/agents/threads/search', { query: 'currentneedle', current_thread: active.id, thread: 'this' })).threads[0].thread_id === active.id)
  check('CLI route refuses a non-object request', await api('POST', '/api/agents/threads/search', null).then(() => false, (e: Error) => e.message.startsWith('400:')))
  check('CLI route includes marked archives', (await api('POST', '/api/agents/threads/search', { query: 'tulip' })).threads[0].archived === true)
  check('CLI route requires sign-in', (await fetch(server.origin + '/api/agents/threads/search', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MvL-Account': 'visitor', Origin: server.origin }, body: JSON.stringify({ query: 'lentil' }) })).status === 401)
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
  const pictureThread = thread('Picture history')
  message(pictureThread, 'user', 'picturetopic: please draw something')
  const beforePictureSearch = search({ query: 'picturetopic' })
  const requested = { prompt: 'imagepromptneedle ' + 'quiet light '.repeat(600), negative_prompt: 'No harsh light', preset: 'sdxl', model: 'studio.safetensors', clip: '', vae: '', loras: [{ name: 'looks/soft.safetensors', weight: 0.7 }], steps: 20, cfg: 6, sampler: 'dpmpp_2m', scheduler: 'karras', width: 1024, height: 768, seed: 123 }
  const imageCall = message(pictureThread, 'assistant', '', { calls: [{ name: 'generate_image', arguments: { ...requested, private_url: 'https://secret.invalid', arbitrary: 'do not return' } }, { name: 'web_fetch', arguments: { url: 'https://unrelated.invalid' } }] })
  const imageId = randomUUID()
  db.prepare('INSERT INTO agent_images (id, thread_id, name, body, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?)').run(imageId, pictureThread, 'picture.png', Buffer.from('do not return PNG bytes'), stamp, JSON.stringify({ ...requested, steps: 24 }))
  const imageResult = message(pictureThread, 'tool', JSON.stringify({ image: { id: imageId, url: 'https://untrusted.invalid', settings: { ...requested, steps: 999 } }, hidden: 'do not return result extras' }))
  db.prepare('UPDATE agent_messages SET tool_name = ? WHERE id = ?').run('generate_image', imageResult)
  const ignoredResult = message(pictureThread, 'tool', 'do not return other tool output')
  db.prepare('UPDATE agent_messages SET tool_name = ? WHERE id = ?').run('web_fetch', ignoredResult)
  const pictureRead = await turn(active.id, 'read_thread', { thread_id: pictureThread })
  const callContent = pictureRead.result.messages.find((m: J) => m.message_id === imageCall).content
  const callArgs = JSON.parse(callContent.split('\n')[1])
  check('Image calls expose bounded requested prompts and every allowlisted setting', callContent.startsWith('Requested image (generate_image; arguments, not confirmed output):') && callArgs.prompt.startsWith('imagepromptneedle') && callArgs.prompt.length <= 1200 && Object.entries(requested).filter(([key]) => key !== 'prompt').every(([key, value]) => JSON.stringify(callArgs[key]) === JSON.stringify(value)) && callContent.length <= 2000)
  const resultContent = pictureRead.result.messages.find((m: J) => m.message_id === imageResult).content
  check('Image results name the owned artifact, private URL and canonical recorded settings', resultContent.includes(`Image: ${imageId}\nURL: /api/agents/images/${imageId}`) && resultContent.includes('steps=24') && resultContent.includes('LoRAs: looks/soft.safetensors (0.7)') && !resultContent.includes('999'))
  check('Only image requests/results are expanded; unrelated arguments, bodies and URLs stay private', callContent.includes('(used web_fetch)') && !pictureRead.raw.includes('https://') && !pictureRead.raw.includes('do not return'))
  check('Image history leaves search results and searchable fields unchanged', JSON.stringify(search({ query: 'picturetopic' })) === JSON.stringify(beforePictureSearch) && search({ query: 'imagepromptneedle' }).found === 0)
  check('Read around an image result includes that tool message', read({ thread_id: pictureThread, around: imageResult, messages: 2 }).messages.some((m: J) => m.message_id === imageResult))
  const alienImage = randomUUID()
  db.prepare('INSERT INTO agent_images (id, thread_id, name, body, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?)').run(alienImage, foreign, 'private.png', Buffer.from('private bytes'), stamp, JSON.stringify(requested))
  db.prepare('UPDATE agent_messages SET content = ? WHERE id = ?').run(JSON.stringify({ image: { id: alienImage } }), imageResult)
  check('An image result cannot expose another account’s artifact', !JSON.stringify(read({ thread_id: pictureThread })).includes(alienImage))
  db.prepare('UPDATE agent_messages SET content = ? WHERE id = ?').run(JSON.stringify({ image: { id: imageId } }), imageResult)
  for (let i = 0; i < 16; i++) message(pictureThread, 'assistant', '', { calls: [{ name: 'generate_image', arguments: { ...requested, prompt: '\"\\\n'.repeat(2000), loras: Array.from({ length: 5 }, (_, j) => ({ name: `style${j}/` + '\"'.repeat(300), weight: 0.8 })) } }] })
  for (const budget of [8000, 16000]) {
    const crowdedImages = read({ thread_id: pictureThread, messages: 30 }, budget)
    check(`Image prompts, escaped arguments and results stay inside the ${budget}-character page`, JSON.stringify(crowdedImages).length <= budget && crowdedImages.messages.every((m: J) => m.content.length <= 2000) && crowdedImages.truncated)
  }
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
  check('History guidance explains image prompts, settings and inspection without guessing', prompt.includes('Image reads include bounded generation prompts') && prompt.includes('view_generated_image') && prompt.includes('name any missing settings or assets'))
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
