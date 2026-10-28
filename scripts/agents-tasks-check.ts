// Checks background agent tasks (server/agentTasks.ts, src/data/agentTaskPolicy.ts,
// src/data/agentTaskSchedule.ts) in three parts:
//
// 1. Pure rules: cron and the next run across daylight saving time (a gap runs at the first valid
//    minute, a repeated hour once), the 15-minute floor, the policy table (every tool the agents
//    know is classified, an unknown one is blocked), hard caps, scopes, dry runs, widening.
// 2. The scheduler in this process, with a fake clock and a stand-in for Ollama (OLLAMA_URL):
//    quiet and reported runs, a run without a verdict, the failure guard, a persisted Ask that
//    expires after 12 hours (fake) and one that is approved, user-wide grants ignored, blocked
//    calls, task expiry, the compare-and-set claim, the run pool, per-user isolation.
// 3. The real server (server/index.ts) over HTTP: create_task asks even in Bypass and takes the
//    card's edit, a run's thread is read-only to chat routes, a waiting run outlives a restart and
//    goes on when approved, and a run cut off by a restart is marked interrupted, tried again and
//    not counted as a failure.
//
//   node scripts/agents-tasks-check.ts
//
// Exits 1 on any failure.

import { createServer, type ServerResponse } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { Server, check, finish, sleep } from './empires-harness.ts'
import { cleanSchedule, fromWall, nextCron, parseCron, shortestGap, upcoming, MIN_INTERVAL_MS } from '../src/data/agentTaskSchedule.ts'
import { askArgLines, CALL_VERDICTS, defaultPolicy, normalizePolicy, policySummary, scopeResult, TASK_TOOLS, taskDecide, toolVerdict, widens, type TaskPolicy } from '../src/data/agentTaskPolicy.ts'

type J = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const MODEL = 'tasks-test'
// One key for this process's database and the server's, so a token sealed here opens there.
process.env.SESSION_SECRET ||= randomBytes(32).toString('hex')
// A scratch database for this process, set before anything opens one (server/db.ts reads DATA_DIR once).
const data = mkdtempSync(join(tmpdir(), 'agent-tasks-check-'))
Object.assign(process.env, { DATA_DIR: data, OLLAMA_API_KEY: 'fake-key', ADMIN_GITHUB_IDS: '1,2', AGENT_TASKS: 'on', AGENT_TASKS_TICK_MS: '3600000', NOTIFY_WATCH: 'off', AGENT_TASKS_UNSEEN_MS: '1000' })
const iso = (t: number | null) => (t === null ? 'null' : new Date(t).toISOString())

// --- 1. Pure rules ----------------------------------------------------------------------------------

{
  const z = 'Europe/Amsterdam'
  // 29 March 2026: 02:00 → 03:00 (01:00 UTC). 25 October 2026: 03:00 → 02:00 (01:00 UTC).
  check('a time in the spring-forward gap runs at the first valid minute', iso(fromWall({ y: 2026, mo: 3, d: 29, h: 2, mi: 30 }, z)) === '2026-03-29T01:00:00.000Z')
  check('a repeated time runs at its first occurrence', iso(fromWall({ y: 2026, mo: 10, d: 25, h: 2, mi: 30 }, z)) === '2026-10-25T00:30:00.000Z')
  const daily = parseCron('30 2 * * *')
  check('daily 02:30 on the gap day runs at 03:00', iso(nextCron(daily, z, Date.UTC(2026, 2, 28, 12))) === '2026-03-29T01:00:00.000Z')
  check('daily 02:30 the day after the gap is 02:30 again', iso(nextCron(daily, z, Date.UTC(2026, 2, 29, 1, 0))) === '2026-03-30T00:30:00.000Z')
  check('daily 02:30 on the fall-back day: the first 02:30', iso(nextCron(daily, z, Date.UTC(2026, 9, 24, 12))) === '2026-10-25T00:30:00.000Z')
  check('daily 02:30 never runs at the second 02:30', iso(nextCron(daily, z, Date.UTC(2026, 9, 25, 0, 30))) === '2026-10-26T01:30:00.000Z')
  const gapRuns = upcoming({ kind: 'cron', expr: '*/15 2 * * *' }, z, Date.UTC(2026, 2, 28, 12), 2).map(iso)
  check('every 15 minutes inside the gap runs once, at 03:00', gapRuns[0] === '2026-03-29T01:00:00.000Z' && gapRuns[1] === '2026-03-30T00:00:00.000Z')
  check('weekdays at 08:00 in another zone', iso(nextCron(parseCron('0 8 * * 1-5'), 'America/New_York', Date.UTC(2026, 9, 31, 12))) === '2026-11-02T13:00:00.000Z')
  check('day 7 is Sunday', parseCron('0 9 * * 7').weekdays.has(0) && parseCron('0 9 * * 5-7').weekdays.has(0))
  check('both day fields narrowed: either matches', (() => { const c = parseCron('0 9 13 * 5'); return !c.anyDay && !c.anyWeekday })())
  check('cron every 5 minutes is under the 15-minute floor', shortestGap({ kind: 'cron', expr: '*/5 * * * *' }, z, Date.now()) < MIN_INTERVAL_MS)
  check('every 15 minutes is allowed', shortestGap({ kind: 'cron', expr: '*/15 * * * *' }, z, Date.now()) >= MIN_INTERVAL_MS)
  let bad = 0
  for (const s of [{ kind: 'cron', expr: '61 * * * *' }, { kind: 'cron', expr: '* * *' }, { kind: 'daily', time: '25:00' }, { kind: 'weekly', time: '08:00', days: [] }, { kind: 'nope' }]) try { cleanSchedule(s) } catch { bad++ }
  check('bad schedules are refused', bad === 5)
}

{
  const policy = defaultPolicy()
  const ctx = { holdsPrivate: false, given: () => false, dryRun: false }
  check('an unknown tool is blocked', taskDecide(policy, { name: 'shiny_new_tool' }, ctx).verdict === 'block')
  check('a tool the policy has not seen yet is blocked', toolVerdict({ ...policy, seen: policy.seen.filter((n) => n !== 'web_search') }, 'web_search') === 'block')
  check('defaults: web search runs, mail reads, past threads and Seafile reads ask, writes are blocked', toolVerdict(policy, 'web_search') === 'allow' && toolVerdict(policy, 'mail_read') === 'ask' && toolVerdict(policy, 'read_thread') === 'ask' && toolVerdict(policy, 'seafile_read') === 'ask' && toolVerdict(policy, 'seafile_write') === 'block' && toolVerdict(policy, 'remember') === 'block')
  const open: TaskPolicy = { ...defaultPolicy(), groups: { mail: 'allow', calendar: 'allow', seafile_write: 'allow', seafile: 'allow' }, tools: { create_task: 'allow', terminal: 'allow', ask_user: 'allow' } }
  check('mail sends never go beyond Ask', toolVerdict(open, 'mail_send') === 'ask')
  check('calendar changes never go beyond Ask', ['calendar_create_event', 'calendar_update_event', 'calendar_delete_event', 'link_note_to_event'].every((n) => toolVerdict(open, n) === 'ask'))
  check('task tools, the terminal and ask_user are never in a run', ['create_task', 'update_task', 'cancel_task', 'terminal', 'ask_user', 'exit_plan_mode'].every((n) => toolVerdict(open, n) === 'block'))
  check('a steering file write never goes beyond Ask', taskDecide(open, { name: 'seafile_write', arguments: { library: 'Docs', path: '/proj/AGENTS.md', content: 'x' } }, ctx).verdict === 'ask' && taskDecide(open, { name: 'seafile_write', arguments: { library: 'Docs', path: '/proj/.claude/settings.json', content: 'x' } }, ctx).verdict === 'ask')
  check('other writes run when allowed', taskDecide(open, { name: 'seafile_write', arguments: { library: 'Docs', path: '/proj/notes.md', content: 'x' } }, ctx).verdict === 'allow')
  const scoped: TaskPolicy = { ...open, seafile: [{ library: 'Docs', path: '/reports', write: true }, { library: 'Docs', path: '/read', write: false }] }
  check('Seafile scope: outside the folders is blocked', taskDecide(scoped, { name: 'seafile_read', arguments: { library: 'Docs', path: '/private/x.md' } }, ctx).verdict === 'block')
  check('Seafile scope: a read-only folder cannot be written', taskDecide(scoped, { name: 'seafile_write', arguments: { library: 'Docs', path: '/read/x.md' } }, ctx).verdict === 'block')
  check('Seafile scope: inside a writable folder runs', taskDecide(scoped, { name: 'seafile_write', arguments: { library: 'docs', path: '/reports/x.md' } }, ctx).verdict === 'allow')
  check('Seafile scope: a move out of the folders is blocked', taskDecide(scoped, { name: 'seafile_move', arguments: { library: 'Docs', path: '/reports/x.md', to_folder: '/elsewhere' } }, ctx).verdict === 'block')
  const web: TaskPolicy = { ...defaultPolicy(), sites: ['example.org'] }
  check('a listed site is read without asking', taskDecide(web, { name: 'web_fetch', arguments: { url: 'https://www.example.org/a' } }, ctx).verdict === 'allow')
  check('another site asks', taskDecide(web, { name: 'web_fetch', arguments: { url: 'https://other.example.net/a' } }, ctx).verdict === 'ask')
  check('another site is blocked when the task says never', taskDecide({ ...web, otherSites: 'block' }, { name: 'web_fetch', arguments: { url: 'https://other.example.net/a' } }, ctx).verdict === 'block')
  check('a built address on a listed site asks while private data is in the run', taskDecide(web, { name: 'web_fetch', arguments: { url: 'https://example.org/?q=secret' } }, { ...ctx, holdsPrivate: true }).verdict === 'ask')
  check('a given address on a listed site runs while private data is in the run', taskDecide(web, { name: 'web_fetch', arguments: { url: 'https://example.org/a' } }, { ...ctx, holdsPrivate: true, given: (u) => u === 'https://example.org/a' }).verdict === 'allow')
  check('find_image pages follow the site list', taskDecide({ ...web, tools: { find_image: 'allow' } }, { name: 'find_image', arguments: { query: 'x', page: 'https://other.example.net/p' } }, ctx).verdict === 'ask')
  const mail: TaskPolicy = { ...defaultPolicy(), groups: { mail: 'allow' }, mail: { accounts: ['Work'], send: 'self', recipients: [] } }
  const own = { mailAccounts: [{ id: '3', label: 'Work' }], own: ['me@example.org'] }
  check('mail send to yourself asks (capped), to anyone else is blocked', taskDecide(mail, { name: 'mail_send' }, { ...ctx, scope: { ...own, recipients: ['me@example.org'] } }).verdict === 'ask' && taskDecide(mail, { name: 'mail_send' }, { ...ctx, scope: { ...own, recipients: ['me@example.org', 'x@evil.example'] } }).verdict === 'block')
  check('mail send to a listed recipient asks when the task allows listed ones', taskDecide({ ...mail, mail: { ...mail.mail, send: 'listed', recipients: ['friend@example.org'] } }, { name: 'mail_send' }, { ...ctx, scope: { ...own, recipients: ['friend@example.org'] } }).verdict === 'ask')
  check('another mail account is blocked', taskDecide(mail, { name: 'mail_search' }, { ...ctx, scope: { mailAccounts: [{ id: '4', label: 'Home' }] } }).verdict === 'block')
  check('calendar changes outside the listed calendars are blocked', taskDecide({ ...open, calendars: ['Family'] }, { name: 'calendar_create_event' }, { ...ctx, scope: { calendars: [{ id: 'g:1', name: 'Work' }] } }).verdict === 'block')
  check('a dry run asks before every change', taskDecide(open, { name: 'seafile_write', arguments: { library: 'Docs', path: '/a.md' } }, { ...ctx, dryRun: true }).verdict === 'ask' && taskDecide(open, { name: 'seafile_read', arguments: { library: 'Docs', path: '/a.md' } }, { ...ctx, dryRun: true }).verdict === 'allow')
  check('widening is noticed', widens(defaultPolicy(), { ...defaultPolicy(), sites: ['a.example'] }) && widens(defaultPolicy(), { ...defaultPolicy(), tools: { remember: 'ask' } }) && !widens(open, defaultPolicy()))
  check('an edited policy is cleaned: unknown tools dropped, caps still hold', (() => { const p = normalizePolicy({ tools: { mail_send: 'allow', nonsense: 'allow' }, groups: { web: 'allow' } }); return !('nonsense' in p.tools) && toolVerdict(p, 'mail_send') === 'ask' })())
  const s = policySummary({ ...defaultPolicy(), groups: { web: 'allow', seafile_write: 'allow' } })
  check('the summary warns about untrusted input with writes', s.warnings.some((w) => w.includes('talk it into')))

  // Review fixes: Seafile calls without a library, results narrowed to the task's folders.
  const folders: TaskPolicy = { ...defaultPolicy(), groups: { seafile: 'allow', seafile_write: 'allow' }, seafile: [{ library: 'Docs', path: '/reports', write: true }] }
  const v = (name: string, args: J) => taskDecide(folders, { name, arguments: args }, ctx).verdict
  check('Seafile scope: a search across every library asks', v('seafile_search', { query: 'tax' }) === 'ask')
  check('Seafile scope: a search in a library holding a listed folder runs, in another is blocked', v('seafile_search', { query: 'tax', library: 'docs' }) === 'allow' && v('seafile_search', { query: 'tax', library: 'Private' }) === 'block')
  check('Seafile scope: the list of libraries runs; a folder on the way to a listed one can be listed; others not', v('seafile_list', {}) === 'allow' && v('seafile_list', { library: 'Docs' }) === 'allow' && v('seafile_list', { library: 'Docs', path: '/private' }) === 'block' && v('seafile_list', { library: 'Private' }) === 'block')
  check('Seafile scope: a change without a library is blocked', v('seafile_write', { path: '/reports/a.md', content: 'x' }) === 'block')
  const libs = JSON.parse(scopeResult(folders, { name: 'seafile_list', arguments: {} }, JSON.stringify([{ name: 'Docs', id: 'r1' }, { name: 'Private', id: 'r2' }])))
  check("the list of libraries shows only the task's", libs.length === 1 && libs[0].name === 'Docs')
  const root = JSON.parse(scopeResult(folders, { name: 'seafile_list', arguments: { library: 'Docs', path: '/' } }, JSON.stringify([{ name: 'reports', folder: true }, { name: 'private', folder: true }, { name: 'secret.md' }])))
  check('a folder listing shows only the way to the listed folders', root.length === 1 && root[0].name === 'reports')
  const hits = JSON.parse(scopeResult(folders, { name: 'seafile_search', arguments: { query: 'tax', library: 'Docs' } }, JSON.stringify({ results: [{ library: 'Docs', path: '/reports/tax.md' }, { library: 'Docs', path: '/private/tax.md' }, { library: 'Private', path: '/reports/tax.md' }], more: 4 })))
  check('search results are narrowed to the listed folders', hits.results.length === 1 && hits.results[0].path === '/reports/tax.md' && !('more' in hits))
  check('an answer that cannot be narrowed is hidden', /Hidden/.test(scopeResult(folders, { name: 'seafile_search', arguments: { library: 'Docs' } }, 'not json')))
  // The user's own ~/AGENTS.md and skills folder (Settings → Agents), wherever they are.
  const steering = { steering: [{ libraries: ['r9', 'Home'], path: '/me/skills' }, { libraries: ['r9', 'Home'], path: '/me/AGENTS.md' }] }
  const open2: TaskPolicy = { ...defaultPolicy(), groups: { seafile_write: 'allow' } }
  const w = (name: string, args: J) => taskDecide(open2, { name, arguments: args }, { ...ctx, scope: steering }).verdict
  check('a write into the skills folder asks (by library name or id)', w('seafile_write', { library: 'home', path: '/me/skills/x/SKILL.md' }) === 'ask' && w('seafile_write', { library: 'r9', path: '/me/skills/new.md' }) === 'ask')
  check('a write to the configured prompt file asks, and so does moving or deleting a folder holding it', w('seafile_write', { library: 'Home', path: '/me/AGENTS.md', overwrite: true }) === 'ask' && w('seafile_delete', { library: 'Home', path: '/me' }) === 'ask' && w('seafile_move', { library: 'Other', path: '/x.md', to_library: 'Home', to_folder: '/me/skills' }) === 'ask')
  check('other writes in that library still run', w('seafile_write', { library: 'Home', path: '/notes/a.md' }) === 'allow')
  // Approving shows where a call goes first, long text last.
  const lines = askArgLines({ content: 'x'.repeat(5000), overwrite: true, path: '/a.md', library: 'Docs', url: 'https://e.example/' })
  check('a call to approve lists path, address and library first, long content last and clipped', lines[0][0] === 'path' && lines[1][0] === 'url' && lines.at(-1)![0] === 'content' && lines.at(-1)![1].length < 4100)

}

// --- the stand-in for Ollama --------------------------------------------------------------------------

type Step = { calls?: { name: string; arguments: J }[]; content?: string; fail?: boolean; delay?: number }
const report = (args: J): Step => ({ calls: [{ name: 'task_report', arguments: args }] })
const SCENARIOS: Record<string, Step[]> = {
  'report-true': [report({ report: true, reason: 'Found news', summary: 'There is news.', state: 'seen news 1' })],
  'report-false': [report({ report: false, reason: 'Nothing new', summary: '', state: 'still nothing' })],
  'no-verdict': [{ content: 'I looked around.' }, { content: 'Still just words.' }],
  fail: [{ fail: true }],
  done: [report({ report: true, reason: 'Done', summary: 'It happened.', done: true })],
  'ask-site': [{ calls: [{ name: 'web_fetch', arguments: { url: 'https://granted.example.org/page' } }] }, report({ report: true, reason: 'Read it', summary: 'Read the page.' })],
  blocked: [{ calls: [{ name: 'web_search', arguments: { query: 'anything' } }] }, report({ report: false, reason: 'Could not search', summary: '' })],
  slow: [{ delay: 2500, ...report({ report: false, reason: 'Slow', summary: '' }) }],
  many: [{ calls: [1, 2, 3].map((n) => ({ name: 'web_search', arguments: { query: `q${n}` } })) }, report({ report: false, reason: 'Searched', summary: '' })],
}
const chats: J[] = []
let webFetches = 0
const json = (res: ServerResponse, body: unknown) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
const ollama = createServer(async (req, res) => {
  let raw = ''
  for await (const chunk of req) raw += chunk
  if (req.url === '/api/tags') return void json(res, { models: [{ name: MODEL }] })
  if (req.url === '/api/show') return void json(res, { capabilities: ['completion', 'tools'], model_info: { 'x.context_length': 131072 } })
  if (req.url === '/api/web_fetch') return void (webFetches++, json(res, { title: 'A page', content: 'Page text', links: [] }))
  if (req.url !== '/api/chat') return void res.writeHead(404).end()
  const body = JSON.parse(raw) as J
  if (body.stream === false) return void json(res, { message: { role: 'assistant', content: '{"title":"Tasks check"}' }, done: true })
  chats.push(body)
  const msgs = body.messages as J[]
  const first = msgs.find((m) => m.role === 'user')?.content ?? ''
  let step: Step
  if (first.startsWith('SCENARIO ')) {
    const steps = SCENARIOS[first.slice(9).trim()] ?? [{ content: 'Unknown scenario' }]
    const round = msgs.filter((m) => m.role === 'assistant').length
    step = steps[Math.min(round, steps.length - 1)]
  } else {
    // A chat turn: "CHAT <call json>" runs that call, then answers.
    const at = msgs.findLastIndex((m) => m.role === 'user' && String(m.content).startsWith('CHAT '))
    const after = msgs.slice(at + 1)
    step = after.some((m) => m.role === 'tool') ? { content: 'Done.' } : { calls: [JSON.parse(msgs[at].content.slice(5))] }
  }
  if (step.delay) await sleep(step.delay)
  if (step.fail) return void res.writeHead(400, { 'Content-Type': 'application/json' }).end('{"error":"scripted failure"}')
  const message = step.calls ? { role: 'assistant', content: '', tool_calls: step.calls.map((c) => ({ function: c })) } : { role: 'assistant', content: step.content ?? '' }
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
  res.end(JSON.stringify({ message, done: false }) + '\n' + JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 100, eval_count: 10 }) + '\n')
})
await new Promise<void>((resolve) => ollama.listen(0, '127.0.0.1', resolve))
const OLLAMA_URL = `http://127.0.0.1:${(ollama.address() as { port: number }).port}`

// --- 2. The scheduler in this process, with a fake clock -----------------------------------------------

Object.assign(process.env, { OLLAMA_URL })

{
  // Every tool the agents know is in the table (and nothing stale is).
  const { mentionTools } = await import('../server/agents.ts')
  const { calendarTools } = await import('../server/agentCalendar.ts')
  const { mailTools } = await import('../server/agentMail.ts')
  const { noteLinkTools } = await import('../server/agentNoteLinks.ts')
  const { workdirTools, terminalTool, exitPlanTool } = await import('../server/workdir.ts')
  const { taskChatTools } = await import('../server/agentTasks.ts')
  const names = new Set([...mentionTools().map((t) => t.name), ...[...calendarTools(), ...mailTools(), ...noteLinkTools(), ...workdirTools(), terminalTool(), exitPlanTool(), ...taskChatTools()].map((t) => t.function.name), 'task_report'])
  const missing = [...names].filter((n) => !TASK_TOOLS[n])
  const stale = Object.keys(TASK_TOOLS).filter((n) => !names.has(n))
  check(`every tool is classified for tasks${missing.length ? `: missing ${missing.join(', ')}` : ''}`, !missing.length)
  check(`no stale tools in the table${stale.length ? `: ${stale.join(', ')}` : ''}`, !stale.length)
}
const { database, encrypt } = await import('../server/db.ts')
const tasks = await import('../server/agentTasks.ts')
const { accounts } = await import('../server/auth.ts')
const db = database()
const t0 = Date.now()
for (const [id, name] of [[1, 'tasks-one'], [2, 'tasks-two']] as const) db.prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, name, encrypt('none'), t0, t0)
const [alice, bob] = [accounts().find((u) => u.id === 1)!, accounts().find((u) => u.id === 2)!]
let fake = t0
tasks.setTaskClock(() => fake)
tasks.startAgentTasks()

const spec = (scenario: string, extra: J = {}) => ({ title: `Check ${scenario}`, instruction: `SCENARIO ${scenario}`, schedule: { kind: 'once', at: null }, timezone: 'Europe/Amsterdam', model: MODEL, ...extra })
const runOf = (id: string) => db.prepare('SELECT * FROM agent_task_runs WHERE id = ?').get(id) as J
const runsOf = (task: string) => db.prepare('SELECT * FROM agent_task_runs WHERE task_id = ? ORDER BY queued_at').all(task) as J[]
const taskRow = (id: string) => db.prepare('SELECT * FROM agent_tasks WHERE id = ?').get(id) as J
async function until(what: string, test: () => boolean, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (test()) return true
    await sleep(25)
  }
  check(`${what} (timed out)`, false)
  return false
}
const OVER = ['succeeded', 'failed', 'cancelled', 'denied', 'interrupted']
async function oneRun(user: typeof alice, s: J): Promise<{ task: J; run: J }> {
  const t = tasks.createTask(user, s)
  // Due now, whatever its schedule says.
  db.prepare('UPDATE agent_tasks SET next_run_at = ? WHERE id = ?').run(fake, t.id)
  await tasks.tick()
  await until(`a run of ${s.title} ends`, () => runsOf(t.id).some((r) => OVER.includes(r.status) || r.status === 'waiting'))
  const run = runsOf(t.id).at(-1)!
  return { task: taskRow(t.id), run }
}
const notices = (user: number, source: string) => db.prepare('SELECT * FROM notifications WHERE user_id = ? AND source = ?').all(user, source) as J[]
const toolMessages = (thread: string) => db.prepare("SELECT * FROM agent_messages WHERE thread_id = ? AND role = 'tool' ORDER BY id").all(thread) as J[]

try {
  {
    const { task, run } = await oneRun(alice, spec('report-true'))
    check('a reported run succeeds, reports, and keeps the state note', run.status === 'succeeded' && run.reported === 1 && run.quiet === 0 && task.state_note === 'seen news 1')
    check('a reported run notifies through "Agent tasks"', notices(1, 'agenttasks.report').some((n) => n.title === 'Check report-true'))
    check('a one-off task completes after its run', task.status === 'completed' && task.next_run_at === null)
    check('the run thread is hidden (quick = 3)', (db.prepare('SELECT quick FROM agent_threads WHERE id = ?').get(run.thread_id) as J).quick === 3)
    const offered = (chats.at(-1)?.tools ?? []).map((t: J) => t.function.name)
    check('a run is offered task_report and never chat-only or task tools', offered.includes('task_report') && !['ask_user', 'exit_plan_mode', 'create_task', 'terminal', 'remember'].some((n) => offered.includes(n)))
  }
  {
    const before = notices(1, 'agenttasks.report').length
    const { run } = await oneRun(alice, spec('report-false'))
    check('a quiet run sends nothing and is marked quiet', run.status === 'succeeded' && run.quiet === 1 && run.reported === 0 && notices(1, 'agenttasks.report').length === before)
  }
  {
    const { run } = await oneRun(alice, spec('no-verdict'))
    check('a run that ends without a verdict reports, flagged', run.status === 'succeeded' && run.reported === 1 && /without a verdict/.test(run.report_reason))
  }
  {
    const { run, task } = await oneRun(alice, spec('done', { schedule: { kind: 'daily', time: '09:00' } }))
    check('done in the verdict completes a repeating task', run.status === 'succeeded' && task.status === 'completed')
  }
  {
    // The failure guard: a repeating task that fails reports on the third failure in a row.
    const t = tasks.createTask(alice, spec('fail', { schedule: { kind: 'daily', time: '09:00' } }))
    const results: J[] = []
    for (let i = 0; i < 3; i++) {
      db.prepare('UPDATE agent_tasks SET next_run_at = ? WHERE id = ?').run(fake, t.id)
      await tasks.tick()
      await until('a failing run ends', () => runsOf(t.id).length === i + 1 && OVER.includes(runsOf(t.id)[i].status))
      results.push(runsOf(t.id)[i])
    }
    check('failures 1 and 2 stay quiet (report on the condition)', results[0].status === 'failed' && results[0].quiet === 1 && results[1].quiet === 1)
    check('the third failure in a row reports regardless', results[2].reported === 1 && taskRow(t.id).failures === 3)
  }
  {
    // A user-wide site grant and mail reads always: a task run ignores both and asks.
    db.prepare('INSERT INTO agent_domains (user_id, host, created_at) VALUES (1, ?, ?)').run('granted.example.org', fake)
    db.prepare('INSERT INTO agent_mail_reads (user_id, always, updated_at) VALUES (1, 1, ?)').run(fake)
    const asks = notices(1, 'agenttasks.ask').length
    const fetches = webFetches
    const { run, task } = await oneRun(alice, spec('ask-site'))
    check('a site the user allowed for good still asks in a task run', run.status === 'waiting' && webFetches === fetches)
    check('the asked call is kept with the run, with a 12-hour deadline', JSON.parse(run.pending).calls[0].state === 'asking' && run.deadline === fake + 12 * 3600_000)
    check('a waiting run notifies "needs you"', notices(1, 'agenttasks.ask').length === asks + 1)
    // Twelve hours later (fake): denied, and the run ends needing the user.
    fake += 12 * 3600_000 + 1000
    await tasks.tick()
    const after = runOf(run.id)
    check('an unanswered Ask expires after 12 hours: denied, needs-you report', after.status === 'denied' && after.reported === 1 && /Needs you/.test(after.report_reason))
    check('the expired call says so in the transcript', toolMessages(after.thread_id).some((m) => m.checked === CALL_VERDICTS.expired))
    check('the one-off is done', taskRow(task.id).status === 'completed')
  }
  {
    // Approved: the run goes on from where it stopped.
    const { run } = await oneRun(alice, spec('ask-site'))
    const r = tasks.approveRun(alice, run.id, { index: 0, allow: true })
    check('approving the last call queues the run to go on', r.status === 'queued')
    await tasks.tick()
    await until('the approved run finishes', () => OVER.includes(runOf(run.id).status))
    const after = runOf(run.id)
    check('an approved call runs and the run reports', after.status === 'succeeded' && after.reported === 1 && toolMessages(after.thread_id).some((m) => m.tool_name === 'web_fetch' && m.checked === CALL_VERDICTS.approved))
  }
  {
    const { run } = await oneRun(alice, spec('blocked', { policy: { ...defaultPolicy(), tools: { web_search: 'block' } } }))
    check('a blocked tool is not offered, and a call to it is recorded as blocked', run.status === 'succeeded' && toolMessages(run.thread_id).some((m) => m.tool_name === 'web_search' && String(m.checked).startsWith(CALL_VERDICTS.blocked)))
  }
  {
    // Compare-and-set: one slot, one claimer.
    const t = tasks.createTask(alice, spec('report-false', { schedule: { kind: 'daily', time: '09:00' } }))
    db.prepare("UPDATE agent_tasks SET status = 'paused' WHERE id = ?").run(t.id)
    db.prepare("UPDATE agent_tasks SET status = 'active', next_run_at = ? WHERE id = ?").run(fake - 1000, t.id)
    const a = tasks.claimTask(t.id, fake - 1000, fake + 3600_000)
    const b = tasks.claimTask(t.id, fake - 1000, fake + 3600_000)
    check('a due slot is claimed once only', a && !b)
    db.prepare("UPDATE agent_tasks SET status = 'paused' WHERE id = ?").run(t.id)
  }
  {
    const t = tasks.createTask(alice, spec('report-false', { schedule: { kind: 'daily', time: '09:00' }, expiresAt: fake + 1000 }))
    fake += 2000
    await tasks.tick()
    check('a task past its end date expires', taskRow(t.id).status === 'expired' && taskRow(t.id).next_run_at === null)
  }
  {
    // The pool: one run per account at a time; another account's runs are not held up.
    const a1 = tasks.createTask(alice, spec('slow', { title: 'slow one' }))
    const a2 = tasks.createTask(alice, spec('slow', { title: 'slow two' }))
    const b1 = tasks.createTask(bob, spec('slow', { title: 'slow bob' }))
    await tasks.tick()
    await until('runs start', () => runsOf(a1.id).length > 0 && runsOf(a2.id).length > 0 && runsOf(b1.id).length > 0 && runsOf(b1.id)[0].status === 'running')
    const states = [runsOf(a1.id)[0].status, runsOf(a2.id)[0].status].sort()
    check('one run per account at a time, the other waits queued', states[0] === 'queued' && states[1] === 'running' && runsOf(b1.id)[0].status === 'running')
    await until('the slow runs finish', () => [a1, a2, b1].every((t) => OVER.includes(runsOf(t.id)[0]?.status)), 15000)
  }
  {
    // Per-user isolation: Bob can't list, read, run, change, approve, cancel or continue Alice's.
    const { task, run } = await oneRun(alice, spec('ask-site', { title: 'private alice' }))
    const refused = (f: () => unknown) => {
      try {
        f()
        return false
      } catch (e) {
        return (e as { status?: number }).status === 404
      }
    }
    check("another account's tasks are not listed", !tasks.listTasks(bob).tasks.some((t) => t.id === task.id))
    check("another account's task and runs can't be read", refused(() => tasks.getTask(bob, task.id)) && refused(() => tasks.getRun(bob, run.id)) && refused(() => tasks.listRuns(bob, task.id, new URLSearchParams())))
    check("another account's task can't be run, changed or deleted", refused(() => tasks.runNow(bob, task.id)) && refused(() => tasks.updateTask(bob, task.id, { title: 'mine now' })) && refused(() => tasks.deleteTask(bob, task.id)))
    check("another account's run can't be approved, cancelled or continued", refused(() => tasks.approveRun(bob, run.id, { index: 0, allow: true })) && refused(() => tasks.cancelRun(bob, run.id)) && refused(() => tasks.continueRun(bob, run.id)))
    const { getThread } = await import('../server/agents.ts')
    check("another account's run thread can't be read", refused(() => getThread(bob, run.thread_id)))
    check('the owner can read their run thread', !refused(() => getThread(alice, run.thread_id)))
    tasks.cancelRun(alice, run.id)
    check('cancelling a waiting run ends it', runOf(run.id).status === 'cancelled')
  }
  {
    // Review fix: a state note makes the run hold private data from its first round.
    const plain = await oneRun(alice, spec('ask-site', { title: 'listed, no note', policy: { ...defaultPolicy(), sites: ['granted.example.org'] } }))
    check('a built address on a listed site runs while the run holds nothing private', plain.run.status === 'succeeded')
    const t = tasks.createTask(alice, spec('ask-site', { title: 'listed, with note', policy: { ...defaultPolicy(), sites: ['granted.example.org'] } }))
    tasks.updateTask(alice, t.id, { stateNote: 'last run read: alice@example.org wrote about the merger' })
    db.prepare('UPDATE agent_tasks SET next_run_at = ? WHERE id = ?').run(fake, t.id)
    await tasks.tick()
    await until('the noted run stops', () => runsOf(t.id).some((r) => r.status === 'waiting' || OVER.includes(r.status)))
    const noted = runsOf(t.id)[0]
    check('with a state note, the same built address asks from the first round', noted.status === 'waiting')
    tasks.cancelRun(alice, noted.id)
  }
  {
    // Review fix: never more tool calls than the budget has left.
    const { run } = await oneRun(alice, spec('many', { title: 'budget', caps: { minutes: 10, toolCalls: 1, tokens: 400_000 } }))
    check('a reply with three calls and one call left runs one', run.status === 'succeeded' && toolMessages(run.thread_id).filter((m) => m.tool_name === 'web_search').length === 1)
  }
  {
    // Review fixes: a cancelled one-off is over, running or queued.
    const a = tasks.createTask(alice, spec('slow', { title: 'one-off, cancelled while running' }))
    const b = tasks.createTask(alice, spec('slow', { title: 'one-off, cancelled while queued' }))
    await tasks.tick()
    await until('one runs, one waits', () => runsOf(a.id)[0]?.status === 'running' && runsOf(b.id)[0]?.status === 'queued')
    tasks.cancelRun(alice, runsOf(b.id)[0].id)
    tasks.cancelRun(alice, runsOf(a.id)[0].id)
    await until('the running one stops', () => OVER.includes(runsOf(a.id)[0].status))
    check('a cancelled one-off completes (running or queued)', taskRow(a.id).status === 'completed' && taskRow(b.id).status === 'completed' && runsOf(b.id)[0].status === 'cancelled')
  }
  {
    // Review fix: a run whose start throws is failed, never left running (it would hold the task back).
    const t = tasks.createTask(alice, spec('report-true', { title: 'throws' }))
    db.prepare("UPDATE agent_tasks SET timezone = 'Not/AZone', next_run_at = ? WHERE id = ?").run(fake, t.id)
    await tasks.tick()
    await until('the throwing run ends', () => runsOf(t.id).some((r) => OVER.includes(r.status)))
    check('a run that throws is marked failed', runsOf(t.id)[0].status === 'failed')
  }
  {
    // Review fix: a report job that fails is kept and tried again, then given up on and said so.
    const { run } = await oneRun(alice, spec('report-false', { title: 'email job' }))
    const entry = randomBytes(8).toString('hex')
    db.prepare('INSERT INTO notifications (id, user_id, source, title, at, read) VALUES (?, 1, ?, ?, ?, 0)').run(entry, 'agenttasks.report', 'email job', fake)
    db.prepare("INSERT INTO agent_task_jobs (user_id, run_id, kind, due_at, data) VALUES (1, ?, 'email_if_unseen', ?, ?)").run(run.id, fake, JSON.stringify({ entry, account: null, title: 't', body: 'b', task: run.task_id }))
    await tasks.runJobs(fake)
    const kept = db.prepare('SELECT * FROM agent_task_jobs WHERE run_id = ?').get(run.id) as J | undefined
    check('a failed email is kept, to try again later', !!kept && JSON.parse(kept.data).tries === 1 && kept.due_at > fake)
    for (let i = 0; i < 8; i++) await tasks.runJobs(fake + (i + 1) * 3 * 3600_000)
    check('and given up on after a few tries, saying so on the run', !db.prepare('SELECT 1 FROM agent_task_jobs WHERE run_id = ?').get(run.id) && /email failed/.test(String(runOf(run.id).delivered)))
  }
  {
    // Review fix: reports go into a thread as a task report, not the agent's own words.
    const thread = randomUUID()
    db.prepare("INSERT INTO agent_threads (id, user_id, title, mode, model, archived, quick, created_at, updated_at) VALUES (?, 1, 'Report here', 'quick', ?, 0, 0, ?, ?)").run(thread, MODEL, fake, fake)
    await oneRun(alice, spec('report-true', { title: 'into a thread', report: { thread: 'fixed', threadId: thread, notify: false, email: 'off', when: 'always' } }))
    await until('the report is posted', () => !!db.prepare('SELECT 1 FROM agent_messages WHERE thread_id = ?').get(thread))
    const roles = (db.prepare('SELECT role FROM agent_messages WHERE thread_id = ?').all(thread) as J[]).map((m) => m.role)
    check('a report goes into a thread as a task report, never as an assistant message', roles.length === 1 && roles[0] === 'report')
  }
  {
    let refusedFast = false
    try { tasks.createTask(alice, spec('report-false', { schedule: { kind: 'cron', expr: '*/5 * * * *' } })) } catch { refusedFast = true }
    check('a schedule under 15 minutes is refused', refusedFast)
    for (const t of tasks.listTasks(alice).tasks) if (t.status === 'active') tasks.updateTask(alice, t.id, { status: 'paused' })
    for (let i = 0; i < 20; i++) tasks.createTask(alice, spec('report-false', { title: `cap ${i}`, schedule: { kind: 'daily', time: '09:00' } }))
    let capped = false
    try { tasks.createTask(alice, spec('report-false', { title: 'one too many', schedule: { kind: 'daily', time: '09:00' } })) } catch { capped = true }
    check('at most 20 active tasks per account', capped)
  }
} catch (e) {
  check(`in-process checks threw: ${(e as Error).stack}`, false)
}

// --- 3. The real server over HTTP ------------------------------------------------------------------------

const server = new Server({ GITHUB_CLIENT_ID: 'x', GITHUB_CLIENT_SECRET: 'x', ADMIN_GITHUB_IDS: '1,2', NOTIFY_WATCH: 'off', OLLAMA_URL, OLLAMA_API_KEY: 'fake-key', AGENT_TASKS: 'on', AGENT_TASKS_TICK_MS: '200' })
try {
  // The sessions live in the server's own database: written there once it has made it.
  const { DatabaseSync } = await import('node:sqlite')
  await server.start()
  const sdb = new DatabaseSync(join(server.data, 'mvlos.db'))
  const { createHash } = await import('node:crypto')
  const sha = (s: string) => createHash('sha256').update(s).digest('hex')
  const sid = randomBytes(24).toString('hex')
  const otherSid = randomBytes(24).toString('hex')
  const now = Date.now()
  for (const [id, name, token] of [[1, 'http-one', sid], [2, 'http-two', otherSid]] as const) {
    sdb.prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, name, encrypt('none'), now, now)
    sdb.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha(token), id, now, now + 86400_000)
  }
  // What a page signed in as that account says about itself (scripts/as-page.ts reads it from this process's database, which is not the server's here).
  const headers = async (who: string) => ({ Cookie: `mvlos_sid=${who}`, 'X-MvL-Account': who === sid ? '1' : '2', Origin: server.origin, 'Content-Type': 'application/json' })
  const api = async (method: string, path: string, body?: unknown, who = sid): Promise<{ status: number; body: J }> => {
    const res = await fetch(server.origin + path, { method, headers: await headers(who), body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await res.text()
    let parsed: J = {}
    try { parsed = JSON.parse(text) } catch { parsed = { text } }
    return { status: res.status, body: parsed }
  }

  // create_task in a Bypass thread: the card still comes, with the task to edit; the edit is what is saved.
  const thread = (await api('POST', '/api/agents/threads', { permission: 'bypass', model: MODEL })).body
  const call = { name: 'create_task', arguments: { title: 'From chat', instruction: 'SCENARIO report-false', schedule: { kind: 'daily', time: '07:30' }, report_to: 'this_thread' } }
  const turn = await fetch(`${server.origin}/api/agents/threads/${thread.id}/messages`, { method: 'POST', headers: await headers(sid), body: JSON.stringify({ text: `CHAT ${JSON.stringify(call)}`, client: { timeZone: 'Europe/Amsterdam' } }) })
  const reader = turn.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let card: J | null = null
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let end: number
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      if (!line.trim()) continue
      const e = JSON.parse(line)
      if (e.type === 'approval' && !card) {
        card = e
        const edited = { ...e.summary.spec, title: 'Edited on the card' }
        await api('POST', `/api/agents/threads/${thread.id}/approve`, { callId: e.callId, allow: true, edit: edited })
      }
    }
  }
  check('create_task asks even in Bypass, with the checked task on the card', card?.call?.name === 'create_task' && card?.summary?.spec?.title === 'From chat' && card.summary.rows.some((r: string[]) => r[0] === 'Runs'))
  const listed = (await api('GET', '/api/agents/tasks')).body.tasks as J[]
  const made = listed.find((t) => t.title === 'Edited on the card')
  check("the card's edit is what was saved, reporting to the thread", !!made && made.report.thread === 'fixed' && made.report.threadId === thread.id && made.createdFromThread === thread.id)
  check("another account can't read the task over HTTP", (await api('GET', `/api/agents/tasks/${made?.id}`, undefined, otherSid)).status === 404)

  // Review fix: no task tools while planning, nor in a thread with every tool off.
  const chatTurn = async (id: string, c: J): Promise<J[]> => {
    const res = await fetch(`${server.origin}/api/agents/threads/${id}/messages`, { method: 'POST', headers: await headers(sid), body: JSON.stringify({ text: `CHAT ${JSON.stringify(c)}`, client: { timeZone: 'Europe/Amsterdam' } }) })
    const events: J[] = []
    for (const line of (await res.text()).split('\n')) if (line.trim()) events.push(JSON.parse(line))
    return events
  }
  const planned = (await api('POST', '/api/agents/threads', { permission: 'plan', model: MODEL })).body
  const planEvents = await chatTurn(planned.id, call)
  const planOffered = (chats.at(-2)?.tools ?? []).map((t: J) => t.function.name)
  const planResult = ((await api('GET', `/api/agents/threads/${planned.id}`)).body.messages as J[]).find((m) => m.role === 'tool' && m.toolName === 'create_task')
  check('Plan mode: create_task is not offered, a call to it asks nothing and is refused', !planOffered.includes('create_task') && !planEvents.some((e) => e.type === 'approval') && /error/.test(planResult?.content ?? ''))
  const bare = (await api('POST', '/api/agents/threads', { permission: 'auto', model: MODEL, tools: [] })).body
  await chatTurn(bare.id, { name: 'update_todos', arguments: { items: [] } })
  check('a thread with every tool off is not offered the task tools', !(chats.at(-2)?.tools ?? []).some((t: J) => ['create_task', 'update_task', 'cancel_task'].includes(t.function.name)))

  // Review fix: a report in a thread reaches the model as quoted data, never as its own words.
  const reporting = (await api('POST', '/api/agents/tasks', { spec: spec('report-true', { title: 'Report into chat', report: { thread: 'fixed', threadId: thread.id, notify: false, email: 'off', when: 'always' } }) })).body
  const endR = Date.now() + 10_000
  while (Date.now() < endR && !((await api('GET', `/api/agents/threads/${thread.id}`)).body.messages as J[]).some((m) => m.role === 'report')) await sleep(100)
  await chatTurn(thread.id, { name: 'update_todos', arguments: { items: [] } })
  const sent = (chats.at(-2)?.messages ?? []) as J[]
  check('the model reads a task report as quoted data, not as its own answer', sent.some((m) => m.role === 'user' && /<task_report>[\s\S]*There is news\./.test(m.content)) && !sent.some((m) => m.role === 'assistant' && /There is news\./.test(m.content)))
  void reporting

  // A waiting run survives a restart, and goes on when approved.
  const waiting = (await api('POST', '/api/agents/tasks', { spec: spec('ask-site', { title: 'Across a restart' }) })).body
  let run: J = {}
  const end = Date.now() + 10_000
  while (Date.now() < end) {
    const runs = (await api('GET', `/api/agents/tasks/${waiting.id}/runs`)).body.runs as J[]
    if (runs[0]?.status === 'waiting') { run = runs[0]; break }
    await sleep(100)
  }
  check('a run waits for an answer', run.status === 'waiting' && run.asks?.[0]?.name === 'web_fetch')
  const runThread = run.threadId
  check("a run's thread is readable, but no chat route writes to it", (await api('GET', `/api/agents/threads/${runThread}`)).status === 200 && (await api('POST', `/api/agents/threads/${runThread}/queue`, { text: 'hi' })).status === 404)
  await server.stop()
  await server.start()
  const again = (await api('GET', `/api/agents/task-runs/${run.id}`)).body.run
  check('the waiting run is still waiting after a restart', again?.status === 'waiting' && again.asks.length === 1)
  check("another account can't answer it", (await api('POST', `/api/agents/task-runs/${run.id}/approve`, { index: 0, allow: true }, otherSid)).status === 404)
  await api('POST', `/api/agents/task-runs/${run.id}/approve`, { index: 0, allow: true })
  let resumed: J = {}
  const end2 = Date.now() + 10_000
  while (Date.now() < end2) {
    resumed = (await api('GET', `/api/agents/task-runs/${run.id}`)).body.run
    if (OVER.includes(resumed.status)) break
    await sleep(100)
  }
  check('approved after the restart, it goes on and reports', resumed.status === 'succeeded' && resumed.reported)
  const cont = await api('POST', `/api/agents/task-runs/${run.id}/continue`)
  check('Continue in thread makes a normal thread from the transcript', cont.status === 200 && cont.body.thread?.quick === false && cont.body.messages?.length > 0)

  // A run cut off by a restart: interrupted, tried once more, not a failure. The other account's
  // task, paused while its run goes, is not tried again (review fix).
  const slow = (await api('POST', '/api/agents/tasks', { spec: spec('slow', { title: 'Cut off' }) })).body
  const paused = (await api('POST', '/api/agents/tasks', { spec: spec('slow', { title: 'Cut off, paused' }) }, otherSid)).body
  const end3 = Date.now() + 10_000
  while (Date.now() < end3) {
    const runs = (await api('GET', `/api/agents/tasks/${slow.id}/runs`)).body.runs as J[]
    const other = (await api('GET', `/api/agents/tasks/${paused.id}/runs`, undefined, otherSid)).body.runs as J[]
    if (runs[0]?.status === 'running' && runs[0]?.threadId && other[0]?.status === 'running' && other[0]?.threadId) break
    await sleep(50)
  }
  await api('PATCH', `/api/agents/tasks/${paused.id}`, { status: 'paused' }, otherSid)
  await sleep(300)
  await server.stop()
  await server.start()
  let runs: J[] = []
  const end4 = Date.now() + 15_000
  while (Date.now() < end4) {
    runs = (await api('GET', `/api/agents/tasks/${slow.id}/runs`)).body.runs as J[]
    if (runs.length === 2 && OVER.includes(runs[0].status)) break
    await sleep(100)
  }
  const [retry, cut] = runs
  check('a run cut off by a restart is marked interrupted', cut?.status === 'interrupted')
  check('and tried once more', retry?.trigger === 'retry' && retry.status === 'succeeded')
  check('an interrupted run is not a failure', (await api('GET', `/api/agents/tasks/${slow.id}`)).body.failures === 0)
  await sleep(1500)
  const pausedRuns = (await api('GET', `/api/agents/tasks/${paused.id}/runs`, undefined, otherSid)).body.runs as J[]
  check('a task paused meanwhile is not tried again after the restart', pausedRuns.length === 1 && pausedRuns[0].status === 'interrupted')
  sdb.close()
} catch (e) {
  check(`HTTP checks threw: ${(e as Error).stack}\n${server.log.slice(-3000)}`, false)
} finally {
  await server.dispose().catch(() => {})
  ollama.close()
  rmSync(data, { recursive: true, force: true })
}
finish()
