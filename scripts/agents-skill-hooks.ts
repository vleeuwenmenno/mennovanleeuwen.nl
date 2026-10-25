// Checks always-on skills and skill rules in the Agents app (src/data/agentSkillRules.ts,
// server/agentSkills.ts and the system prompt in server/agents.ts): a skill that is always on goes
// into the system prompt whole (and into the context breakdown), the size cap, where it applies
// (threads, Spotlight quick answers, the terminal), per-project overrides, switching one off in a
// thread (kept with the thread), rules matching on mode, permission and project, and the server
// refusing bad settings. It starts the real server (server/index.ts) on a free port with a scratch
// DATA_DIR, a signed-in user and a stand-in for Ollama (OLLAMA_URL) that keeps every system prompt.
//
//   node scripts/agents-skill-hooks.ts
//
// Exits 1 on any failure.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { Server, check, finish } from './empires-harness.ts'
import { asPage } from './as-page.ts'
import { activeItems, ALWAYS_CAP, alwaysOnPrompt, emptyConfig, parseSkillConfig } from '../src/data/agentSkillRules.ts'

type Message = { role: string; content: string }
type ChatBody = { model: string; messages: Message[]; stream?: boolean }

const MODEL = 'skills-model'
const systems: string[] = []
const json = (res: ServerResponse, body: unknown, status = 200) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
const ollama = createServer((req: IncomingMessage, res: ServerResponse) => {
  let raw = ''
  req.on('data', (d) => (raw += d))
  req.on('end', () => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    if (path === '/api/tags') return json(res, { models: [{ name: MODEL }] })
    if (path === '/api/show') return json(res, { capabilities: ['completion', 'tools'], model_info: { 'test.context_length': 200_000 } })
    if (path === '/api/chat') {
      const body = JSON.parse(raw) as ChatBody
      if (body.stream === false) return json(res, { model: body.model, message: { role: 'assistant', content: '{"title":"Skills check"}' }, done: true })
      if (body.messages[0]?.role === 'system') systems.push(body.messages[0].content)
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
      res.write(`${JSON.stringify({ model: body.model, message: { role: 'assistant', content: 'ok' }, done: false })}\n`)
      return res.end(`${JSON.stringify({ model: body.model, message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 100, eval_count: 1 })}\n`)
    }
    res.writeHead(404).end()
  })
})
await new Promise<void>((r) => ollama.listen(0, '127.0.0.1', r))
const ollamaUrl = `http://127.0.0.1:${(ollama.address() as { port: number }).port}`

const LOGIN = 'skills-check'
const server = new Server({ OLLAMA_URL: ollamaUrl, OLLAMA_API_KEY: 'fake-key', GITHUB_CLIENT_ID: 'x', GITHUB_CLIENT_SECRET: 'x', ADMIN_USERS: LOGIN })
process.env.DATA_DIR = server.data
const { database, encrypt, sha256 } = await import('../server/db.ts')
const sid = randomBytes(24).toString('hex')
const now = Date.now()
database().prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (1, 1, ?, ?, ?, ?)').run(LOGIN, encrypt('none'), now, now)
database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, 1, ?, ?)').run(sha256(sid), now, now + 86400_000)
await server.start()

const call = async (method: string, path: string, body?: unknown) =>
  fetch(`${server.origin}${path}`, { method, headers: { Cookie: `mvlos_sid=${sid}`, ...(await asPage(sid)), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
const api = async <T = unknown>(method: string, path: string, body?: unknown): Promise<T> => {
  const res = await call(method, path, body)
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`)
  return (await res.json()) as T
}
type ThreadInfo = { id: string; skillsOff: string[] }
const newThread = (extra: Record<string, unknown> = {}) => api<ThreadInfo>('POST', '/api/agents/threads', { model: MODEL, mode: 'quick', tools: [], ...extra })
/** Sends a message and answers the system prompt the model got for it. */
const promptOf = async (id: string, client: Record<string, unknown> = {}) => {
  const from = systems.length
  const res = await call('POST', `/api/agents/threads/${id}/messages`, { text: 'hello', client })
  await res.text()
  return systems.slice(from).at(-1) ?? ''
}
const config = (c: unknown) => call('PUT', '/api/agents/skill-config', c)
const save = async (c: unknown) => {
  const res = await config(c)
  if (!res.ok) throw new Error(`saving the config: ${res.status} ${await res.text()}`)
  return res.json()
}
const CAVEMAN = '<active_skill name="caveman-adhd">'
const has = (s: string, name: string) => s.includes(`<active_skill name="${name}">`)

try {
  // --- Nothing always on: nothing in the prompt.
  check('config: empty to begin with', JSON.stringify(await api('GET', '/api/agents/skill-config')) === JSON.stringify(emptyConfig()))
  const plain = await newThread()
  check('none on: no always-on section', !(await promptOf(plain.id)).includes('Always-on skills'))

  // --- Always on: the whole SKILL.md, delimited, in every thread, the skills tool group off too.
  await save({ always: ['caveman-adhd'] })
  const a = await newThread()
  const pa = await promptOf(a.id)
  check('always on: the skill is in the system prompt, delimited', pa.includes(CAVEMAN) && pa.includes('</active_skill>'))
  check('always on: its whole body, not just its description', pa.includes('## Shaping rules') && pa.includes('## Pre-send check'))
  check('always on: told to follow it for the whole conversation', /follow each of them in every reply, for the whole conversation/.test(pa))
  check('always on: an older thread gets it too', has(await promptOf(plain.id), 'caveman-adhd'))
  const ctx = await api<{ parts: { label: string; tokens: number }[] }>('GET', `/api/agents/threads/${a.id}/context`)
  const row = ctx.parts.find((p) => p.label === 'Always-on skills (1)')
  check(`context: a row of its own (${row?.tokens} tokens)`, !!row && row.tokens > 1000)

  // --- Per thread: off in this thread only, kept with it.
  const offed = await api<ThreadInfo>('PATCH', `/api/agents/threads/${a.id}`, { skillsOff: ['caveman-adhd'] })
  check('thread off: saved on the thread', offed.skillsOff.join() === 'caveman-adhd')
  check('thread off: survives a reload', (await api<{ thread: ThreadInfo }>('GET', `/api/agents/threads/${a.id}`)).thread.skillsOff.join() === 'caveman-adhd')
  check('thread off: gone from its prompt', !(await promptOf(a.id)).includes(CAVEMAN))
  check('thread off: gone from its context breakdown', !(await api<{ parts: { label: string }[] }>('GET', `/api/agents/threads/${a.id}/context`)).parts.some((p) => p.label.startsWith('Always-on')))
  check('thread off: other threads keep it', has(await promptOf(plain.id), 'caveman-adhd'))
  await api('PATCH', `/api/agents/threads/${a.id}`, { skillsOff: [] })
  check('thread off: back on', has(await promptOf(a.id), 'caveman-adhd'))
  const born = await newThread({ skillsOff: ['caveman-adhd'] })
  check('thread off: chosen before the thread existed', born.skillsOff.join() === 'caveman-adhd' && !(await promptOf(born.id)).includes(CAVEMAN))
  check('thread off: bad keys refused (400)', (await call('PATCH', `/api/agents/threads/${a.id}`, { skillsOff: ['../etc', 'x y'] })).status === 400)
  check('thread off: not a list refused (400)', (await call('PATCH', `/api/agents/threads/${a.id}`, { skillsOff: 'caveman-adhd' })).status === 400)

  // --- Where it applies: threads by default; quick answers and the terminal when ticked.
  const q = await newThread({ quick: true })
  check('scope: not in Spotlight quick answers by default', !(await promptOf(q.id)).includes(CAVEMAN))
  check('scope: not from the terminal by default', !(await promptOf(plain.id, { terminal: true })).includes(CAVEMAN))
  await save({ always: ['caveman-adhd'], scope: { threads: false, quick: true, terminal: true } })
  check('scope: in quick answers when ticked', has(await promptOf(q.id), 'caveman-adhd'))
  check('scope: from the terminal when ticked', has(await promptOf(plain.id, { terminal: true }), 'caveman-adhd'))
  check('scope: not in app threads when unticked', !(await promptOf(plain.id)).includes(CAVEMAN))

  // --- Per project: off in one project, another skill on in it.
  const project = await api<{ id: number }>('POST', '/api/agents/projects', { name: 'Work' })
  const inProject = await newThread({ projectId: project.id })
  await save({ always: ['caveman-adhd'], projects: { [project.id]: { on: ['msh'], off: ['caveman-adhd'] } } })
  const pp = await promptOf(inProject.id)
  check('project: its off wins over always on', !pp.includes(CAVEMAN))
  check('project: its on adds a skill', has(pp, 'msh'))
  const po = await promptOf(plain.id)
  check('project: threads outside it are unchanged', has(po, 'caveman-adhd') && !has(po, 'msh'))
  const ctx2 = await api<{ parts: { label: string }[] }>('GET', `/api/agents/threads/${inProject.id}/context`)
  check('project: context counts what is on there', ctx2.parts.some((p) => p.label === 'Always-on skills (1)'))

  // --- Rules: on mode, permission and project; a text rule; switched off rules and in a thread.
  await save({
    always: [],
    rules: [
      { id: 'deep', when: { mode: 'deep' }, then: { text: 'RULE-DEEP: cite sources inline.' } },
      { id: 'plan', when: { permission: 'plan' }, then: { skill: 'skill-creator' } },
      { id: 'work', when: { project: project.id, mode: 'quick' }, then: { text: 'RULE-WORK: answer in Dutch.' } },
      { id: 'idle', on: false, when: {}, then: { text: 'RULE-IDLE' } },
    ],
  })
  const quickT = await newThread()
  const pq = await promptOf(quickT.id)
  check('rules: nothing matches a plain quick thread', !pq.includes('RULE-') && !pq.includes('<active_skill'))
  const deepT = await newThread({ mode: 'deep' })
  const pd = await promptOf(deepT.id)
  check('rules: mode deep adds its instruction, delimited', pd.includes('<user_instruction>\nRULE-DEEP: cite sources inline.\n</user_instruction>'))
  check('rules: a rule that is off does nothing', !pd.includes('RULE-IDLE'))
  const planT = await newThread({ permission: 'plan' })
  check('rules: permission plan turns a skill on', has(await promptOf(planT.id), 'skill-creator'))
  await api('PATCH', `/api/agents/threads/${quickT.id}`, { permission: 'plan' })
  check('rules: checked again on each message (switched to plan)', has(await promptOf(quickT.id), 'skill-creator'))
  const pw = await promptOf(inProject.id)
  check('rules: project and mode both match', pw.includes('RULE-WORK'))
  await api('PATCH', `/api/agents/threads/${inProject.id}`, { mode: 'deep' })
  const pw2 = await promptOf(inProject.id)
  check('rules: all conditions must match (deep in the project)', !pw2.includes('RULE-WORK') && pw2.includes('RULE-DEEP'))
  await api('PATCH', `/api/agents/threads/${deepT.id}`, { skillsOff: ['rule:deep'] })
  check('rules: an instruction switched off in one thread', !(await promptOf(deepT.id)).includes('RULE-DEEP'))

  // --- A skill switched off in Settings is never always on.
  await save({ always: ['caveman-adhd'] })
  await call('PUT', '/api/state/agents', { value: { skillsOff: ['caveman-adhd'] } })
  check('disabled skill: not injected even when always on', !(await promptOf(plain.id)).includes(CAVEMAN))
  await call('PUT', '/api/state/agents', { value: { skillsOff: [] } })

  // --- Validation: bad settings are refused, whole.
  const bad: [string, unknown][] = [
    ['not an object', 'caveman'],
    ['a bad skill name', { always: ['../../etc'] }],
    ['always not a list', { always: 'caveman-adhd' }],
    ['too many always-on skills', { always: Array.from({ length: 21 }, (_, i) => `s${i}`) }],
    ['scope not boolean', { scope: { threads: 'yes' } }],
    ['a bad project id', { projects: { abc: { on: ['msh'] } } }],
    ['rules not a list', { rules: {} }],
    ['too many rules', { rules: Array.from({ length: 21 }, (_, i) => ({ id: `r${i}`, then: { text: 'x' } })) }],
    ['a rule without an id', { rules: [{ then: { text: 'x' } }] }],
    ['a bad rule id', { rules: [{ id: 'Bad Id!', then: { text: 'x' } }] }],
    ['two rules with one id', { rules: [{ id: 'a', then: { text: 'x' } }, { id: 'a', then: { text: 'y' } }] }],
    ['an unknown condition', { rules: [{ id: 'a', when: { time: '9:00' }, then: { text: 'x' } }] }],
    ['a bad mode', { rules: [{ id: 'a', when: { mode: 'turbo' }, then: { text: 'x' } }] }],
    ['a bad permission', { rules: [{ id: 'a', when: { permission: 'root' }, then: { text: 'x' } }] }],
    ['a bad project', { rules: [{ id: 'a', when: { project: -1 }, then: { text: 'x' } }] }],
    ['code as an action', { rules: [{ id: 'a', then: { run: 'rm -rf /' } }] }],
    ['a skill and a text at once', { rules: [{ id: 'a', then: { skill: 'msh', text: 'x' } }] }],
    ['an empty instruction', { rules: [{ id: 'a', then: { text: '   ' } }] }],
    ['an instruction over 2000 characters', { rules: [{ id: 'a', then: { text: 'x'.repeat(2001) } }] }],
  ]
  for (const [what, body] of bad) {
    const res = await config(body)
    check(`refused: ${what} (${res.status})`, res.status === 400)
  }
  check('refused saves change nothing', JSON.stringify(((await api('GET', '/api/agents/skill-config')) as { always: string[] }).always) === '["caveman-adhd"]')
  // Stored some other way (the plain state API), it is read leniently: what is wrong is dropped.
  await call('PUT', '/api/state/agentskills', { value: { always: ['msh', '../x'], rules: [{ id: 'ok', then: { text: 'fine' } }, { id: 'bad', then: { run: 'x' } }] } })
  const lenient = await api<{ always: string[]; rules: { id: string }[] }>('GET', '/api/agents/skill-config')
  check('read leniently: bad entries dropped, good ones kept', lenient.always.join() === 'msh' && lenient.rules.map((r) => r.id).join() === 'ok')

  // --- The size cap (pure): what does not fit is left out and named.
  const big = 'word '.repeat(4000) // 20 KB
  const capped = alwaysOnPrompt([
    { kind: 'skill', name: 'one', text: big },
    { kind: 'skill', name: 'two', text: big },
    { kind: 'text', name: 'small', text: 'a short instruction' },
  ])
  check(`size cap: within ${ALWAYS_CAP} bytes (${capped.bytes})`, capped.bytes <= ALWAYS_CAP + 300)
  check('size cap: the one that does not fit is left out, the rest kept', capped.used.join() === 'one,small' && capped.left.join() === 'two' && capped.text.includes('Left out for size: two'))
  // Pure resolution: order and no duplicates when a rule names an always-on skill.
  const c = parseSkillConfig({ always: ['msh'], rules: [{ id: 'x', then: { skill: 'msh' } }, { id: 'y', then: { skill: 'skill-creator' } }] }, true)
  check('resolve: valid config has no error', c.error === null)
  const items = activeItems(c.config, { surface: 'threads', projectId: null, mode: 'quick', permission: 'auto', off: [], disabled: [] })
  check('resolve: always-on first, a skill only once', items.map((i) => `${i.name}:${i.from}`).join() === 'msh:always,skill-creator:rule')
} catch (e) {
  check(`no exception (${(e as Error).message})`, false)
} finally {
  await server.stop()
  ollama.close()
}
finish()
