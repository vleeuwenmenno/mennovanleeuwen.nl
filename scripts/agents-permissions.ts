// Checks the Agents app's permission modes (server/agents.ts decide and webReadGate) end to end:
// Ask first, Auto (web addresses the agent built are checked by rules, then by the safety check
// model), Edits allowed, Plan and Bypass, "Allow <site>" on a web read, and the mode new threads
// start in. It starts the real server (server/index.ts) on a free port with a scratch DATA_DIR, a
// signed-in admin with a memory (so every thread holds something private, which is when web reads
// of addresses the agent made up ask), and a stand-in for Ollama (OLLAMA_URL) that plays scripted
// tool calls, serves web_fetch, and answers as the safety check model: safe, ask, garbage, or not
// at all, as the script says.
//
//   node scripts/agents-permissions.ts
//
// Exits 1 on any failure.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { Server, check, finish } from './empires-harness.ts'

type Message = { role: string; content: string; tool_calls?: unknown[] }
type ChatBody = { model: string; messages: Message[]; stream?: boolean; format?: { properties?: Record<string, unknown> }; tools?: { function: { name: string } }[] }
type Call = { name: string; arguments: Record<string, unknown> }

const MODEL = 'main-model'
const CHECKER = 'safety-model'
/** In the user's memory: it must reach the main model, and never the safety check model. */
const MARKER = `MARKER-${randomBytes(6).toString('hex')}-private`
const REPO = 'https://github.com/uowuo/abaddon'

// --- Scripted turns ---------------------------------------------------------------------------------
//
// The user's message starts with "SCENARIO <name>"; each round of the model plays the next list of
// tool calls, then it answers. Addresses the user should have "given" go in the message itself.

const fetch_ = (url: string): Call => ({ name: 'web_fetch', arguments: { url } })
const SCENARIOS: Record<string, Call[][]> = {
  // The user's own example: a repository it read, then its commits and releases.
  example: [[fetch_(REPO)], [fetch_(`${REPO}/commits/master`), fetch_(`${REPO}/releases`)]],
  // A path part nobody gave it, which could carry something: the safety check decides. One address
  // per answer of the checker (a page once read counts as given from then on).
  ...Object.fromEntries(['safe', 'ask', 'garbage', 'hang'].map((v) => [`novel-${v}`, [[fetch_(`${REPO}/blob/master/bWFya2VyLXNlY3JldC10b2tlbi1ibG9iPT0-${v}`)]]])),
  // A site never seen in the thread.
  stranger: [[fetch_('https://never-seen.example.net/notes/page')]],
  // Remembered sites.
  site: [[fetch_('https://docs.example.org/guide/start?from=agent')]],
  site2: [[fetch_('https://www.docs.example.org/other/page')]],
  subsite: [[fetch_('https://api.docs.example.org/v1/thing')]],
  // Bypass: everything at once, then a write to AGENTS.md.
  bypass: [
    [
      fetch_('https://never-seen.example.net/?q=whatever'),
      { name: 'edit_file', arguments: { path: 'a.md', old_string: 'x', new_string: 'y' } },
      { name: 'delete_path', arguments: { path: 'b.md' } },
      { name: 'terminal', arguments: { command: 'rm -rf build', description: 'Clean the build' } },
      { name: 'update_note', arguments: { id: 'n1', text: 'changed' } },
    ],
    [{ name: 'edit_file', arguments: { path: 'AGENTS.md', old_string: 'x', new_string: 'y' } }],
  ],
  // Ask first with a work folder: an edit and a delete ask.
  edits: [[{ name: 'edit_file', arguments: { path: 'a.md', old_string: 'x', new_string: 'y' } }, { name: 'delete_path', arguments: { path: 'b.md' } }]],
  plan: [[{ name: 'exit_plan_mode', arguments: { plan: '1. Do the thing' } }]],
}

// --- The stand-in for Ollama ----------------------------------------------------------------------

/** What the safety check model answers next. */
let checker: 'safe' | 'ask' | 'garbage' | 'hang' = 'safe'
/** Every request the safety check model got, and every main-model request. */
const checks: ChatBody[] = []
const mains: ChatBody[] = []
const fetched: string[] = []

const json = (res: ServerResponse, body: unknown) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
const reply = (res: ServerResponse, msg: { content?: string; tool_calls?: unknown[] }) => {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
  res.write(`${JSON.stringify({ model: MODEL, message: { role: 'assistant', content: '', ...msg }, done: false })}\n`)
  res.end(`${JSON.stringify({ model: MODEL, message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 100, eval_count: 10 })}\n`)
}

function chat(body: ChatBody, res: ServerResponse) {
  // The safety check model: structured output with a verdict.
  if (body.format?.properties?.verdict) {
    checks.push(body)
    if (checker === 'hang') return // never answers: the app gives up after 10 seconds
    if (checker === 'garbage') return json(res, { model: body.model, message: { role: 'assistant', content: 'sure thing, looks fine to me!' }, done: true })
    return json(res, { model: body.model, message: { role: 'assistant', content: JSON.stringify({ verdict: checker, reason: checker === 'safe' ? 'A page of the same public repository.' : 'The path has a long encoded string in it.' }) }, done: true })
  }
  // The title model.
  if (body.stream === false) return json(res, { model: body.model, message: { role: 'assistant', content: '{"title":"Permissions check"}' }, done: true })
  mains.push(body)
  const at = body.messages.map((m) => m.role === 'user' && m.content.startsWith('SCENARIO ')).lastIndexOf(true)
  const name = body.messages[at]?.content.slice('SCENARIO '.length).split(/\s/)[0] ?? ''
  const round = body.messages.slice(at + 1).filter((m) => m.role === 'assistant').length
  const rounds = SCENARIOS[name] ?? []
  if (round < rounds.length) return reply(res, { tool_calls: rounds[round].map((c) => ({ function: c })) })
  return reply(res, { content: `FINAL ${name}` })
}

const ollama = createServer((req: IncomingMessage, res: ServerResponse) => {
  let raw = ''
  req.on('data', (d) => (raw += d))
  req.on('end', () => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    if (path === '/api/tags') return void json(res, { models: [{ name: 'aaa-other' }, { name: MODEL }, { name: CHECKER }] })
    if (path === '/api/show') return void json(res, { capabilities: ['completion', 'tools'], model_info: { 'x.context_length': 131072 } })
    if (path === '/api/chat') return chat(JSON.parse(raw) as ChatBody, res)
    if (path === '/api/web_fetch') {
      const { url } = JSON.parse(raw) as { url: string }
      fetched.push(url)
      return void json(res, { title: 'A page', content: `The page at ${url}.`, links: [] })
    }
    res.writeHead(404).end()
  })
})
await new Promise<void>((r) => ollama.listen(0, '127.0.0.1', r))
const ollamaUrl = `http://127.0.0.1:${(ollama.address() as { port: number }).port}`

// --- The site, with a signed-in admin -------------------------------------------------------------

const LOGIN = 'permissions-check'
const server = new Server({ OLLAMA_URL: ollamaUrl, OLLAMA_API_KEY: 'fake-key', GITHUB_CLIENT_ID: 'x', GITHUB_CLIENT_SECRET: 'x', ADMIN_USERS: LOGIN })
process.env.DATA_DIR = server.data
const { database, encrypt, sha256 } = await import('../server/db.ts')
const sid = randomBytes(24).toString('hex')
const now = Date.now()
database().prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (1, 1, ?, ?, ?, ?)').run(LOGIN, encrypt('none'), now, now)
database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, 1, ?, ?)').run(sha256(sid), now, now + 86400_000)
// The decisions themselves, for what the stand-in cannot reach (a calendar).
const { decide, clearedByRules } = await import('../server/agents.ts')
await server.start()

const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${server.origin}${path}`, { method, headers: { Cookie: `mvlos_sid=${sid}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`)
  return res
}
const getJson = async <T>(method: string, path: string, body?: unknown) => (await (await api(method, path, body)).json()) as T

type Thread = { id: string; permission: string }
type Saved = { role: string; content: string; toolName?: string; checked?: string }
type Approval = { type: 'approval'; callId: string; call?: Call; check?: string }
type Answer = { allow: boolean; always?: string; mode?: string }

const newThread = (extra: Record<string, unknown> = {}) => getJson<Thread>('POST', '/api/agents/threads', { model: MODEL, mode: 'quick', ...extra })
const threadOf = (id: string) => getJson<{ thread: Thread; messages: Saved[] }>('GET', `/api/agents/threads/${id}`)

/**
 * One turn, read as it streams: each approval is answered by `answer` (declined when it says
 * nothing), a terminal call gets an output. Answers the approvals asked and the turn's tool results.
 */
async function turn(id: string, text: string, answer: (a: Approval) => Answer = () => ({ allow: false }), terminal = false) {
  const asked: Approval[] = []
  const res = await api('POST', `/api/agents/threads/${id}/messages`, { text, ...(terminal ? { client: { terminal: true } } : {}) })
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let error: string | null = null
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let nl
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line) continue
      const e = JSON.parse(line) as { type: string; callId?: string; error?: string }
      if (e.type === 'error') error = e.error ?? 'error'
      if (e.type === 'approval') {
        asked.push(e as Approval)
        void api('POST', `/api/agents/threads/${id}/approve`, { callId: e.callId, ...answer(e as Approval) }).catch((err: Error) => check(`answering an approval worked (${err.message})`, false))
      }
      if (e.type === 'client') void api('POST', `/api/agents/threads/${id}/result`, { callId: e.callId, output: 'done', status: 0 }).catch((err: Error) => check(`answering a terminal call worked (${err.message})`, false))
    }
  }
  const t = await threadOf(id)
  const last = t.messages.map((m) => m.role).lastIndexOf('user')
  return { asked, error, thread: t.thread, tools: t.messages.slice(last + 1).filter((m) => m.role === 'tool') }
}
const urlOf = (a: Approval) => String(a.call?.arguments?.url ?? '')

try {
  // The safety check model is the user's pick in Settings.
  await api('PUT', '/api/state/agents', { value: { checkModel: CHECKER } })
  await api('POST', '/api/agents/memories', { text: `The user's secret is ${MARKER}`, category: 'Private' })

  // 1. New threads start in Auto; threads from before keep what they have.
  const auto = await newThread()
  check(`a new thread starts in Auto (got ${auto.permission})`, auto.permission === 'auto')
  const spot = await newThread({ quick: true })
  check(`a Spotlight quick thread starts in Auto (got ${spot.permission})`, spot.permission === 'auto')
  const old = randomUUID()
  database().prepare("INSERT INTO agent_threads (id, user_id, title, mode, model, archived, created_at, updated_at) VALUES (?, 1, 'Old', 'quick', ?, 0, ?, ?)").run(old, MODEL, now, now)
  check('a thread from before the modes (no permission stored) is Ask first', (await threadOf(old)).thread.permission === 'default')
  const askFirst = await newThread({ permission: 'default' })
  check('a thread made in Ask first stays Ask first', (await threadOf(askFirst.id)).thread.permission === 'default')

  // 2. Auto, the user's example: the repository it read, then its commits and releases, on rules alone.
  let n = checks.length
  const ex = await turn(auto.id, `SCENARIO example look at ${REPO}`)
  check(`Auto: the example ran without an error${ex.error ? ` (${ex.error})` : ''}`, !ex.error)
  check(`Auto: /commits/master and /releases did not ask (asked ${ex.asked.map(urlOf).join(', ') || 'nothing'})`, ex.asked.length === 0)
  check('Auto: all three pages were read', [REPO, `${REPO}/commits/master`, `${REPO}/releases`].every((u) => fetched.includes(u)))
  check('Auto: the rules cleared them without the safety check model', checks.length === n)
  const notes = ex.tools.filter((m) => m.toolName === 'web_fetch').map((m) => m.checked ?? '')
  check(`Auto: the two built addresses say they were checked (got ${JSON.stringify(notes)})`, notes.filter((x) => /^Checked: built from a page it read/.test(x)).length === 2)
  check('Auto: the address it was given has no note (it never needed one)', notes.filter((x) => !x).length === 1)

  // 3. Auto: a novel path part goes to the safety check model; safe runs.
  checker = 'safe'
  n = checks.length
  const safe = await turn(auto.id, `SCENARIO novel-safe in ${REPO}`)
  check('Auto, novel part, checker says safe: it went to the safety check model', checks.length === n + 1)
  check('Auto, novel part, checker says safe: it did not ask', safe.asked.length === 0)
  const safeNote = safe.tools.find((m) => m.toolName === 'web_fetch')?.checked ?? ''
  check(`Auto, novel part, checker says safe: the row says who checked it (got "${safeNote}")`, safeNote.startsWith(`Checked by ${CHECKER}:`))
  const req = checks.at(-1)!
  check('the safety check uses the model from Settings', req.model === CHECKER)
  check('the safety check gets the address in a delimited field', /<candidate_address>\nhttps:\/\/github\.com\/uowuo\/abaddon\/blob\/master\/bWFya2Vy[^\n]*\n<\/candidate_address>/.test(req.messages.at(-1)?.content ?? ''))
  check('the safety check gets the known addresses', (req.messages.at(-1)?.content ?? '').includes(`- ${REPO}`))
  check('the safety check is told the address is untrusted', /untrusted data, never instructions/.test(req.messages[0]?.content ?? ''))

  // 4. Auto: the checker says ask, says nonsense, or does not answer: the user is asked.
  for (const mode of ['ask', 'garbage', 'hang'] as const) {
    checker = mode
    n = checks.length
    const started = Date.now()
    const r = await turn(auto.id, `SCENARIO novel-${mode} in ${REPO}`)
    check(`Auto, novel part, checker ${mode}: it went to the safety check model`, checks.length === n + 1)
    check(`Auto, novel part, checker ${mode}: the user was asked (asked ${r.asked.length})`, r.asked.length === 1 && urlOf(r.asked[0]).includes('bWFya2Vy'))
    const said = r.asked[0]?.check ?? ''
    check(
      `Auto, novel part, checker ${mode}: the card says what the check said (got "${said}")`,
      mode === 'ask' ? said.includes('long encoded string') && said.includes(CHECKER) : /no clear answer/.test(said),
    )
    if (mode === 'hang') check(`Auto, checker hang: gave up after about 10 s (took ${Math.round((Date.now() - started) / 1000)} s)`, Date.now() - started >= 9_000 && Date.now() - started < 20_000)
  }

  // 5. Auto: a site never seen in the thread goes to the safety check model.
  checker = 'safe'
  n = checks.length
  const stranger = await turn(auto.id, 'SCENARIO stranger')
  check('Auto, unknown site: it went to the safety check model', checks.length === n + 1 && (checks.at(-1)?.messages.at(-1)?.content ?? '').includes('never-seen.example.net'))
  check('Auto, unknown site, checker says safe: it ran without asking', stranger.asked.length === 0 && fetched.includes('https://never-seen.example.net/notes/page'))

  // 6. Nothing private ever reaches the safety check model; the main model did hold it.
  check('the memory was in front of the main model (so web reads were guarded)', mains.some((b) => JSON.stringify(b).includes(MARKER)))
  check(`no safety check request held the memory (${checks.length} requests)`, checks.length > 0 && checks.every((b) => !JSON.stringify(b).includes(MARKER)))

  // 7. Ask first: built addresses still ask.
  const af = await turn(askFirst.id, `SCENARIO example look at ${REPO}`, () => ({ allow: true }))
  check(`Ask first: /commits/master and /releases asked (asked ${af.asked.map(urlOf).join(', ')})`, af.asked.length === 2 && af.asked.every((a) => /\/(commits\/master|releases)$/.test(urlOf(a))))
  check('Ask first: the card carries no safety check note', af.asked.every((a) => !a.check))

  // 8. Edits allowed: web reads are checked like Auto.
  const ea = await newThread({ permission: 'acceptEdits' })
  n = checks.length
  const eaRun = await turn(ea.id, `SCENARIO example look at ${REPO}`)
  check('Edits allowed: the example runs on rules like Auto', eaRun.asked.length === 0 && checks.length === n)

  // 9. Plan: built addresses ask as before (no automatic check); the plan goes on in Auto unless the card says.
  const plan = await newThread({ permission: 'plan' })
  n = checks.length
  const pl = await turn(plan.id, `SCENARIO example look at ${REPO}`, () => ({ allow: true }))
  check(`Plan: built addresses still ask (asked ${pl.asked.length})`, pl.asked.length === 2 && checks.length === n)
  const go = await turn(plan.id, 'SCENARIO plan', () => ({ allow: true }))
  check(`Plan: approving the plan without a mode goes on in Auto (got ${go.thread.permission})`, go.asked.length === 1 && go.thread.permission === 'auto')
  const plan2 = await newThread({ permission: 'plan' })
  const go2 = await turn(plan2.id, 'SCENARIO plan', () => ({ allow: true, mode: 'default' }))
  check(`Plan: approving with Ask first goes on in Ask first (got ${go2.thread.permission})`, go2.thread.permission === 'default')

  // 10. Bypass: web read, edit, delete, terminal and note change run; AGENTS.md asks.
  const workdir = { repo: randomUUID(), path: '/proj', label: '~/Projects/proj' }
  const by = await newThread({ permission: 'bypass', workdir })
  const byRun = await turn(by.id, 'SCENARIO bypass', () => ({ allow: false }), true)
  check(`Bypass: only the AGENTS.md edit asked (asked ${byRun.asked.map((a) => `${a.call?.name} ${String(a.call?.arguments?.path ?? a.call?.arguments?.url ?? '')}`).join(', ') || 'nothing'})`, byRun.asked.length === 1 && byRun.asked[0].call?.name === 'edit_file' && byRun.asked[0].call?.arguments?.path === 'AGENTS.md')
  check('Bypass: the web read of an unknown address ran', fetched.includes('https://never-seen.example.net/?q=whatever'))
  const term = byRun.tools.find((m) => m.toolName === 'terminal')
  check(`Bypass: rm ran in the terminal without asking (got ${term?.content})`, !!term && /"exit_code":0/.test(term.content))
  check('Bypass: the web read says it was not checked', byRun.tools.some((m) => m.toolName === 'web_fetch' && m.checked === 'Not checked: Bypass is on'))
  const ed = await newThread({ permission: 'default', workdir })
  const edRun = await turn(ed.id, 'SCENARIO edits', () => ({ allow: false }))
  check(`Ask first with a work folder: the edit and the delete asked (asked ${edRun.asked.length})`, edRun.asked.length === 2)
  const t = by.id
  const cal = { name: 'calendar_create_event', arguments: { title: 'x', start: '2026-10-14T10:00' } }
  check('Bypass: a calendar write still asks', decide(t, 'bypass', cal) === 'ask')
  check('Bypass: a calendar delete still asks', decide(t, 'bypass', { name: 'calendar_delete_event', arguments: { id: 'x' } }) === 'ask')
  check('Bypass: a seafile write to AGENTS.md still asks', decide(t, 'bypass', { name: 'seafile_write', arguments: { library: 'Home', path: '/AGENTS.md', content: 'x' } }) === 'ask')
  check('Bypass: renaming a file to CLAUDE.md still asks', decide(t, 'bypass', { name: 'seafile_rename', arguments: { library: 'Home', path: '/notes.md', name: 'CLAUDE.md' } }) === 'ask')
  check('Bypass: a terminal line writing AGENTS.md still asks', decide(t, 'bypass', { name: 'terminal', arguments: { command: 'echo hi > AGENTS.md' } }) === 'ask')
  check('Bypass: curl in the terminal runs', decide(t, 'bypass', { name: 'terminal', arguments: { command: 'curl -o x https://example.com' } }) === 'run')
  check('Bypass: a seafile delete runs', decide(t, 'bypass', { name: 'seafile_delete', arguments: { library: 'Home', path: '/old.md' } }) === 'run')
  check('Auto: a calendar write asks', decide(t, 'auto', cal) === 'ask')
  check('Auto: rm in the terminal asks', decide(t, 'auto', { name: 'terminal', arguments: { command: 'rm -rf build' } }) === 'ask')
  check('Auto: a file edit asks', decide(t, 'auto', { name: 'edit_file', arguments: { path: 'a.md' } }) === 'ask')
  check('Plan: a file edit is refused', decide(t, 'plan', { name: 'edit_file', arguments: { path: 'a.md' } }) === 'refuse')

  // 11. Allow <site>: remembered for all threads, exact site (www. too, not subdomains), until removed.
  const s1 = await newThread({ permission: 'default' })
  const allowed = await turn(s1.id, 'SCENARIO site', () => ({ allow: true, always: 'domain' }))
  check('Allow site: the read asked once and ran', allowed.asked.length === 1 && fetched.includes('https://docs.example.org/guide/start?from=agent'))
  const sites = await getJson<{ host: string }[]>('GET', '/api/agents/sites')
  check(`Allow site: docs.example.org is remembered (got ${sites.map((s) => s.host).join(', ')})`, sites.some((s) => s.host === 'docs.example.org'))
  const s2 = await newThread({ permission: 'default' })
  const later = await turn(s2.id, 'SCENARIO site2')
  check('Allow site: another thread (Ask first) reads www.docs.example.org without asking', later.asked.length === 0 && fetched.includes('https://www.docs.example.org/other/page'))
  check('Allow site: its row says the site is allowed', later.tools.some((m) => m.checked === 'Allowed: docs.example.org is one of your allowed sites'))
  const plan3 = await newThread({ permission: 'plan' })
  check('Allow site: a Plan thread reads it without asking too', (await turn(plan3.id, 'SCENARIO site2')).asked.length === 0)
  const sub = await turn(s2.id, 'SCENARIO subsite')
  check('Allow site: a subdomain (api.docs.example.org) still asks', sub.asked.length === 1)
  await api('DELETE', '/api/agents/sites/docs.example.org')
  check('Allow site: removed in Settings, it is gone', !(await getJson<{ host: string }[]>('GET', '/api/agents/sites')).some((s) => s.host === 'docs.example.org'))
  const s3 = await newThread({ permission: 'default' })
  check('Allow site: after removing it, the read asks again', (await turn(s3.id, 'SCENARIO site2')).asked.length === 1)
  await api('POST', '/api/agents/sites', { host: 'https://WWW.Example.COM/some/path' })
  check('Allow site by hand: a pasted address is stored as its site', (await getJson<{ host: string }[]>('GET', '/api/agents/sites')).some((s) => s.host === 'example.com'))
  const bad = await fetch(`${server.origin}/api/agents/sites`, { method: 'POST', headers: { Cookie: `mvlos_sid=${sid}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ host: 'not a site' }) })
  check(`Allow site by hand: nonsense is refused (got ${bad.status})`, bad.status === 400)

  // 12. The rules, case by case.
  const given = [new URL(REPO), new URL('https://github.com/uowuo/abaddon/issues'), new URL('https://example.org/docs/a?lang=en')]
  const rules = (u: string) => clearedByRules(new URL(u), given)
  check('rules: /commits/master on a read repo passes', rules(`${REPO}/commits/master`))
  check('rules: /releases/latest passes', rules(`${REPO}/releases/latest`))
  check('rules: issues/123 passes', rules(`${REPO}/issues/123`))
  check('rules: www. is the same site', rules('https://www.github.com/uowuo/abaddon/releases'))
  check('rules: a parent of a given address passes', rules('https://github.com/uowuo'))
  check('rules: a known query pair passes', rules('https://example.org/docs/a?lang=en'))
  check('rules: ?page=2 passes', rules(`${REPO}/issues?page=2`))
  check('rules: a novel long segment does not pass', !rules(`${REPO}/blob/master/c2VjcmV0LXRva2Vu`))
  check('rules: an email address does not pass', !rules('https://github.com/uowuo/abaddon/issues/someone@example.com'))
  check('rules: a new query value does not pass', !rules(`${REPO}?token=abc123`))
  check('rules: a sort value that is not a plain word does not pass', !rules(`${REPO}/issues?sort=secret-value-here`))
  check('rules: three added words do not pass', !rules(`${REPO}/tree/main/docs`))
  check('rules: a number not after issues or pulls does not pass', !rules(`${REPO}/1234`))
  check('rules: a long number does not pass', !rules(`${REPO}/issues/123456`))
  check('rules: a site never given does not pass', !rules('https://evil.example/uowuo/abaddon/releases'))
  check('rules: a subdomain does not pass', !rules('https://gist.github.com/uowuo/abaddon'))
  check('rules: a user name in the address does not pass', !rules('https://me:pw@github.com/uowuo/abaddon/releases'))
  check('rules: another port does not pass', !rules('https://github.com:8443/uowuo/abaddon/releases'))
} catch (e) {
  check(`ran to the end (${(e as Error).message})`, false)
  console.error(server.log)
} finally {
  await server.dispose()
  ollama.close()
}
finish()
