import { createHash, randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { accounts, type User } from './auth.ts'
import { database, onUserGone } from './db.ts'
import { HttpError, json, readJson } from './http.ts'
import { listMail, mailAccount, mailMeta, send as sendMail } from './jmap.ts'
import { notify, tellPages } from './notifier.ts'
import { withoutPrivateRequest } from './privateRequest.ts'
import { isShuttingDown, onShutdown } from './shutdown.ts'
import { readState } from './state.ts'
import type { CallSummary } from './agentCalendar.ts'
import { branchThread, closeRunCalls, createRunThread, deleteRunThread, followThread, ownChatThread, postTaskReport, requireTaskKey, runActive, runTaskTurn, settleRunPending, stopRun, taskModel, taskSystemPrompt, type TaskPending, type TaskUsage } from './agents.ts'
import {
  DEFAULT_CAPS,
  DEFAULT_EXPIRY_MS,
  DEFAULT_OPTIONS,
  DEFAULT_REPORT,
  defaultPolicy,
  normalizePolicy,
  policySummary,
  RETENTION,
  TASK_GROUPS,
  TASK_TOOLS,
  taskDecide,
  TOOL_NAMES,
  toolVerdict,
  usedGroups,
  widens,
  type ReportTargets,
  type RunAsk,
  type RunStatus,
  type RunVerdict,
  type Task,
  type TaskCaps,
  type TaskOptions,
  type TaskPolicy,
  type TaskRunInfo,
  type TaskSpec,
  type TaskStatus,
} from '../src/data/agentTaskPolicy.ts'
import { cleanSchedule, describeSchedule, MIN_INTERVAL_MS, nextRun, shortestGap, validZone, type Schedule } from '../src/data/agentTaskSchedule.ts'

// Background agent tasks: an agent that runs on its own, once (now or at a time) or on a schedule,
// and reports back. Each account's tasks use only that account's own integrations and keys (an
// admin's server keys stay the admin's, as everywhere: server/auth.ts serverKey).
//
// - A task is a row in agent_tasks: the instruction, when to tell the user ("Tell me when…"), when
//   it is done, the schedule in the user's time zone, a small state note the agent reads at the
//   start of a run and rewrites at its end, the permission policy (versioned), where reports go,
//   the caps per run and the options.
// - The scheduler (every 30 s) claims tasks that are due with a compare-and-set on next_run_at, so
//   a task never runs twice for one slot, and queues a run. Runs have a pool of their own: one at
//   a time per account and four on the server, never a chat turn's place; a run that finds the pool
//   full waits its turn. Runs due during a short restart (within GRACE_MS) run as usual; runs missed
//   for longer catch up once, or are skipped, as the task says.
// - A run happens in a hidden thread (server/agents.ts runTaskTurn) whose every call the policy
//   decides (taskDecide in src/data/agentTaskPolicy.ts, the only authority there). A call the policy
//   asks about pauses the run: what it waits for is kept in the run row with a deadline 12 hours
//   on, the user is told ("Agent tasks" notifications), and answering in the Tasks tab (or the
//   agents TUI) goes on from there, also after a restart. Nobody answering in time denies the call
//   and the run ends with a "needs you" report.
// - The run ends with the agent's verdict (task_report): report or stay quiet, why, a summary,
//   done or not, and the new state note. Reports go to a thread (a new one, or one fixed thread,
//   written only while it is at rest), a notification, and email from the user's own mail account
//   to themselves (always, or only when the notification was not read in time).
// - Three failed runs in a row report whatever the task says; a run cut off by a restart is
//   marked interrupted, tried once more, and does not count as a failure.
//
// AGENT_TASKS=off stops the scheduler (and Run now); it is off unless AGENT_TASKS=on in the dev
// server (vite.config.ts), on unless off in production.

type TaskRow = {
  id: string
  user_id: number
  title: string
  instruction: string
  condition: string
  done_when: string
  schedule: string
  timezone: string
  state_note: string
  policy: string
  policy_version: number
  report: string
  caps: string
  options: string
  model: string | null
  status: string
  expires_at: number | null
  next_run_at: number | null
  last_run_at: number | null
  last_report_at: number | null
  failures: number
  created_from_thread: string | null
  created_at: number
  updated_at: number
}
type RunRow = {
  id: string
  task_id: string
  user_id: number
  status: string
  trigger: string
  dry: number
  attempt: number
  quiet: number
  reported: number
  report_reason: string | null
  summary: string | null
  verdict: string | null
  policy_version: number
  policy: string
  queued_at: number
  started_at: number | null
  ended_at: number | null
  active_ms: number
  tokens_in: number
  tokens_out: number
  tool_calls: number
  thread_id: string | null
  error: string | null
  pending: string | null
  deadline: number | null
  delivered: string | null
}

const RUNS_PER_USER = 1
const RUNS_TOTAL = 4
const MAX_ACTIVE = 20
const TICK_MS = Math.max(200, Number(process.env.AGENT_TASKS_TICK_MS) || 30_000)
/** Due while the server restarted (a deploy): not missed, it runs as usual. */
const GRACE_MS = 10 * 60_000
const ASK_WAIT_MS = () => Math.max(1000, Number(process.env.AGENT_TASKS_ASK_MS) || 12 * 3600_000)
const UNSEEN_MS = () => Math.max(1000, Number(process.env.AGENT_TASKS_UNSEEN_MS) || 15 * 60_000)
const FAILURE_GUARD = 3
/** Scheduled runs start up to this much after their time, the same for each task, so tasks set to the same minute do not all start at once. */
const JITTER_MS = 3 * 60_000
const HEARTBEAT_MS = { weekly: 7 * 86400_000, monthly: 30 * 86400_000 } as const

/** The clock the scheduler reads (scripts/agents-tasks-check.ts moves it). */
let clock = () => Date.now()
export const setTaskClock = (fn: () => number) => void (clock = fn)

let enabled = false
/** Whether the scheduler runs on this server (AGENT_TASKS). */
export const tasksEnabled = () => enabled

// --- tasks ---------------------------------------------------------------------------------------

const parse = <T>(raw: string | null, fallback: T): T => {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}
const jitter = (id: string) => (createHash('sha256').update(id).digest().readUInt32BE(0) % JITTER_MS)

function specOf(r: TaskRow): TaskSpec {
  return {
    title: r.title,
    instruction: r.instruction,
    condition: r.condition,
    doneWhen: r.done_when,
    schedule: parse<Schedule>(r.schedule, { kind: 'once', at: null }),
    timezone: r.timezone,
    policy: normalizePolicy(parse(r.policy, {})),
    report: reportOf(parse(r.report, {})),
    caps: capsOf(parse(r.caps, {})),
    model: r.model,
    options: optionsOf(parse(r.options, {})),
    expiresAt: r.expires_at,
  }
}

function runInfo(r: RunRow): TaskRunInfo {
  const pending = parse<TaskPending | null>(r.pending, null)
  const asks: RunAsk[] = r.status === 'waiting' && pending ? pending.calls.filter((c) => c.state === 'asking').map((c) => ({ index: c.index, name: c.call.name, arguments: c.call.arguments ?? {}, summary: c.summary ? { title: c.summary.title, rows: c.summary.rows, ...(c.summary.body !== undefined ? { body: c.summary.body } : {}) } : null, reason: c.reason ?? '' })) : []
  return {
    id: r.id,
    taskId: r.task_id,
    status: r.status as RunStatus,
    trigger: r.trigger as TaskRunInfo['trigger'],
    dry: !!r.dry,
    quiet: !!r.quiet,
    reported: !!r.reported,
    reportReason: r.report_reason,
    summary: r.summary,
    verdict: parse<RunVerdict | null>(r.verdict, null),
    policyVersion: r.policy_version,
    queuedAt: r.queued_at,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    tokensIn: r.tokens_in,
    tokensOut: r.tokens_out,
    toolCalls: r.tool_calls,
    threadId: r.thread_id,
    error: r.error,
    asks,
    deadline: r.status === 'waiting' ? r.deadline : null,
    delivered: parse<string[]>(r.delivered, []),
  }
}

const ACTIVE_RUNS = "('queued', 'running', 'waiting')"
function toTask(r: TaskRow): Task {
  const db = database()
  const last = db.prepare('SELECT * FROM agent_task_runs WHERE task_id = ? ORDER BY queued_at DESC LIMIT 1').get(r.id) as RunRow | undefined
  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM agent_task_runs WHERE task_id = ? AND status IN ${ACTIVE_RUNS}`).get(r.id) as { n: number }
  return { ...specOf(r), id: r.id, status: r.status as TaskStatus, stateNote: r.state_note, policyVersion: r.policy_version, nextRunAt: r.next_run_at, lastRunAt: r.last_run_at, failures: r.failures, createdFromThread: r.created_from_thread, createdAt: r.created_at, updatedAt: r.updated_at, lastRun: last ? runInfo(last) : null, active: n }
}

/** One of the user's own tasks, by id; another account's is "no such task". */
function ownTask(user: Pick<User, 'id'>, id: string): TaskRow {
  const row = database().prepare('SELECT * FROM agent_tasks WHERE id = ? AND user_id = ?').get(String(id), user.id) as TaskRow | undefined
  if (!row) throw new HttpError(404, 'No such task')
  return row
}
function ownRun(user: Pick<User, 'id'>, id: string): RunRow {
  const row = database().prepare('SELECT * FROM agent_task_runs WHERE id = ? AND user_id = ?').get(String(id), user.id) as RunRow | undefined
  if (!row) throw new HttpError(404, 'No such run')
  return row
}

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const clampInt = (v: unknown, lo: number, hi: number, fallback: number) => {
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback
}
function reportOf(v: unknown): ReportTargets {
  const r = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  return {
    thread: r.thread === 'new' || r.thread === 'fixed' ? r.thread : 'none',
    threadId: typeof r.threadId === 'string' && /^[0-9a-f-]{36}$/.test(r.threadId) ? r.threadId : null,
    notify: r.notify !== false,
    email: r.email === 'always' || r.email === 'unseen' ? r.email : 'off',
    emailAccount: Number.isInteger(r.emailAccount) ? Number(r.emailAccount) : null,
    when: r.when === 'always' || r.when === 'failure' ? r.when : 'condition',
  }
}
const capsOf = (v: unknown): TaskCaps => {
  const c = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  return { minutes: clampInt(c.minutes, 1, 60, DEFAULT_CAPS.minutes), toolCalls: clampInt(c.toolCalls, 1, 200, DEFAULT_CAPS.toolCalls), tokens: clampInt(c.tokens, 10_000, 2_000_000, DEFAULT_CAPS.tokens) }
}
const optionsOf = (v: unknown): TaskOptions => {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  return {
    overlap: o.overlap === 'queue' ? 'queue' : 'skip',
    missed: o.missed === 'skip' ? 'skip' : 'once',
    keepWatching: o.keepWatching === true,
    heartbeat: o.heartbeat === 'weekly' || o.heartbeat === 'monthly' ? o.heartbeat : 'off',
    keep: RETENTION.includes(Number(o.keep)) ? Number(o.keep) : null,
  }
}

/** Settings → Apps → Agents: the task model, where reports go by default, and how many runs each task keeps. */
type TaskSettings = { report: Partial<ReportTargets>; keep: number }
function taskSettings(user: User): TaskSettings {
  const v = (readState(user).agents?.value ?? {}) as { taskReport?: unknown; taskKeep?: unknown }
  const r = (v.taskReport && typeof v.taskReport === 'object' ? v.taskReport : {}) as Partial<ReportTargets>
  return { report: r, keep: RETENTION.includes(Number(v.taskKeep)) ? Number(v.taskKeep) : 100 }
}

/**
 * A task as sent (from the editor, an approval card, or the agent's create_task), checked: a 400
 * says what is wrong. `base`: the task as it is, for a change that names only some fields.
 */
export function cleanSpec(user: User, raw: unknown, base?: TaskSpec, from: string | null = null): TaskSpec {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const has = (k: string) => v[k] !== undefined
  const title = has('title') ? text(v.title, 120) : (base?.title ?? '')
  const instruction = has('instruction') ? text(v.instruction, 8000) : (base?.instruction ?? '')
  if (!title) throw new HttpError(400, 'Give the task a title')
  if (!instruction) throw new HttpError(400, 'Say what the task should do')
  let schedule: Schedule
  try {
    schedule = has('schedule') ? cleanSchedule(v.schedule) : (base?.schedule ?? { kind: 'once', at: null })
  } catch (e) {
    throw new HttpError(400, (e as Error).message)
  }
  const timezone = has('timezone') ? text(v.timezone, 80) : (base?.timezone ?? 'UTC')
  if (!validZone(timezone)) throw new HttpError(400, `Unknown time zone ${timezone}`)
  if (shortestGap(schedule, timezone, clock()) < MIN_INTERVAL_MS) throw new HttpError(400, 'A task runs at most every 15 minutes')
  const defaults = taskSettings(user).report
  const report = reportOf(has('report') ? v.report : (base?.report ?? { ...DEFAULT_REPORT, ...defaults, ...(from ? { thread: defaults.thread === 'new' ? 'new' : 'fixed', threadId: from } : {}) }))
  if (report.thread === 'fixed' && (!report.threadId || !ownChatThread(user, report.threadId))) throw new HttpError(400, 'Pick the thread reports go to')
  const mail = listMail(user)
  if (report.email !== 'off') {
    if (!mail.length) throw new HttpError(400, 'Email reports need a linked mail account (Settings → Integrations → Mail)')
    if (report.emailAccount === null || !mail.some((a) => a.id === report.emailAccount)) report.emailAccount = mail[0].id
  }
  const model = has('model') ? (v.model === null || v.model === '' ? null : text(v.model, 80)) : (base?.model ?? null)
  if (model !== null && !/^[\w.:/-]{1,80}$/.test(model)) throw new HttpError(400, 'Bad model name')
  const expiresAt = has('expiresAt') ? (v.expiresAt === null ? null : Number(v.expiresAt)) : base ? base.expiresAt : clock() + DEFAULT_EXPIRY_MS
  if (expiresAt !== null && !Number.isFinite(expiresAt)) throw new HttpError(400, 'Bad expiry')
  return {
    title,
    instruction,
    condition: has('condition') ? text(v.condition, 2000) : (base?.condition ?? ''),
    doneWhen: has('doneWhen') ? text(v.doneWhen, 2000) : (base?.doneWhen ?? ''),
    schedule,
    timezone,
    policy: has('policy') ? normalizePolicy(v.policy) : (base?.policy ?? defaultPolicy()),
    report,
    caps: has('caps') ? capsOf(v.caps) : (base?.caps ?? { ...DEFAULT_CAPS }),
    model,
    options: has('options') ? optionsOf(v.options) : (base?.options ?? { ...DEFAULT_OPTIONS }),
    expiresAt,
  }
}

/** When a task runs next, from `after` (null: a one-off that ran, or a schedule with no more runs). */
function planNext(id: string, spec: TaskSpec, after: number): number | null {
  if (spec.schedule.kind === 'once') return spec.schedule.at === null ? after : Math.max(spec.schedule.at, after)
  const next = nextRun(spec.schedule, spec.timezone, after)
  return next === null ? null : next + jitter(id)
}

function changed(userId: number, data: Record<string, unknown> = {}) {
  tellPages(userId, 'tasks', data)
}

export function listTasks(user: User): { tasks: Task[]; enabled: boolean } {
  const rows = database().prepare('SELECT * FROM agent_tasks WHERE user_id = ? ORDER BY created_at DESC LIMIT 200').all(user.id) as TaskRow[]
  return { tasks: rows.map(toTask), enabled }
}

export function getTask(user: User, id: string): Task {
  return toTask(ownTask(user, id))
}

const activeCount = (userId: number) => (database().prepare("SELECT COUNT(*) AS n FROM agent_tasks WHERE user_id = ? AND status = 'active'").get(userId) as { n: number }).n

export function createTask(user: User, raw: unknown, from: string | null = null): Task {
  const spec = cleanSpec(user, raw, undefined, from)
  if (activeCount(user.id) >= MAX_ACTIVE) throw new HttpError(409, `At most ${MAX_ACTIVE} active tasks: pause or delete one first`)
  const id = randomUUID()
  const now = clock()
  const next = planNext(id, spec, now)
  const thread = from && ownChatThread(user, from) ? from : null
  database()
    .prepare('INSERT INTO agent_tasks (id, user_id, title, instruction, condition, done_when, schedule, timezone, state_note, policy, policy_version, report, caps, options, model, status, expires_at, next_run_at, created_from_thread, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, \'\', ?, 1, ?, ?, ?, ?, \'active\', ?, ?, ?, ?, ?)')
    .run(id, user.id, spec.title, spec.instruction, spec.condition, spec.doneWhen, JSON.stringify(spec.schedule), spec.timezone, JSON.stringify(spec.policy), JSON.stringify(spec.report), JSON.stringify(spec.caps), JSON.stringify(spec.options), spec.model, spec.expiresAt, next, thread, now, now)
  changed(user.id, { task: id })
  kick()
  return getTask(user, id)
}

/** Changes a task (any of its fields), its state note, or pauses and resumes it (`status`). */
export function updateTask(user: User, id: string, raw: unknown): Task {
  const row = ownTask(user, id)
  const v = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const db = database()
  const now = clock()
  const before = specOf(row)
  const fields = ['title', 'instruction', 'condition', 'doneWhen', 'schedule', 'timezone', 'policy', 'report', 'caps', 'model', 'options', 'expiresAt']
  let spec = before
  if (fields.some((k) => v[k] !== undefined)) {
    spec = cleanSpec(user, v, before)
    const policyChanged = JSON.stringify(spec.policy) !== JSON.stringify(before.policy)
    const scheduleChanged = JSON.stringify(spec.schedule) !== JSON.stringify(before.schedule) || spec.timezone !== before.timezone
    db.prepare('UPDATE agent_tasks SET title = ?, instruction = ?, condition = ?, done_when = ?, schedule = ?, timezone = ?, policy = ?, policy_version = policy_version + ?, report = ?, caps = ?, options = ?, model = ?, expires_at = ?, updated_at = ? WHERE id = ?').run(
      spec.title, spec.instruction, spec.condition, spec.doneWhen, JSON.stringify(spec.schedule), spec.timezone, JSON.stringify(spec.policy), policyChanged ? 1 : 0, JSON.stringify(spec.report), JSON.stringify(spec.caps), JSON.stringify(spec.options), spec.model, spec.expiresAt, now, row.id,
    )
    if (scheduleChanged && row.status === 'active') db.prepare('UPDATE agent_tasks SET next_run_at = ? WHERE id = ?').run(planNext(row.id, spec, now), row.id)
  }
  if (v.stateNote !== undefined) db.prepare('UPDATE agent_tasks SET state_note = ?, updated_at = ? WHERE id = ?').run(typeof v.stateNote === 'string' ? v.stateNote.slice(0, 2000) : '', now, row.id)
  if (v.status === 'paused' && row.status === 'active') db.prepare("UPDATE agent_tasks SET status = 'paused', next_run_at = NULL, updated_at = ? WHERE id = ?").run(now, row.id)
  if (v.status === 'active' && row.status !== 'active') {
    if (activeCount(user.id) >= MAX_ACTIVE) throw new HttpError(409, `At most ${MAX_ACTIVE} active tasks: pause or delete one first`)
    // Resumed (or renewed when expired or completed): from now on, and for six more months when it had expired.
    const expires = row.status === 'expired' || (spec.expiresAt !== null && spec.expiresAt <= now) ? now + DEFAULT_EXPIRY_MS : spec.expiresAt
    const fresh = spec.schedule.kind === 'once' && row.status === 'completed' ? { ...spec, schedule: { kind: 'once' as const, at: null } } : spec
    db.prepare("UPDATE agent_tasks SET status = 'active', failures = 0, expires_at = ?, next_run_at = ?, schedule = ?, updated_at = ? WHERE id = ?").run(expires, planNext(row.id, fresh, now), JSON.stringify(fresh.schedule), now, row.id)
  }
  changed(user.id, { task: row.id })
  kick()
  return getTask(user, row.id)
}

export function deleteTask(user: User, id: string) {
  const row = ownTask(user, id)
  const runs = database().prepare('SELECT * FROM agent_task_runs WHERE task_id = ?').all(row.id) as RunRow[]
  for (const r of runs) {
    inFlight.get(r.id)?.ctl.abort()
    if (r.thread_id) deleteRunThread(user, r.thread_id)
  }
  database().prepare('DELETE FROM agent_tasks WHERE id = ?').run(row.id)
  changed(user.id, { task: row.id, deleted: true })
}

export function listRuns(user: User, id: string, q: URLSearchParams): { runs: TaskRunInfo[]; more: boolean } {
  const row = ownTask(user, id)
  const limit = clampInt(q.get('limit'), 1, 100, 30)
  const before = Number(q.get('before')) || Number.MAX_SAFE_INTEGER
  const rows = database().prepare('SELECT * FROM agent_task_runs WHERE task_id = ? AND queued_at < ? ORDER BY queued_at DESC LIMIT ?').all(row.id, before, limit + 1) as RunRow[]
  return { runs: rows.slice(0, limit).map(runInfo), more: rows.length > limit }
}

export function getRun(user: User, id: string): { run: TaskRunInfo; task: Task } {
  const r = ownRun(user, id)
  return { run: runInfo(r), task: getTask(user, r.task_id) }
}

// --- runs ----------------------------------------------------------------------------------------

/** Runs going on this server, by run: whose, and how to stop it. */
const inFlight = new Map<string, { userId: number; ctl: AbortController }>()

function queueRun(task: TaskRow, trigger: TaskRunInfo['trigger'], opts: { dry?: boolean; attempt?: number } = {}): string {
  const id = randomUUID()
  database()
    .prepare("INSERT INTO agent_task_runs (id, task_id, user_id, status, trigger, dry, attempt, policy_version, policy, queued_at) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)")
    .run(id, task.id, task.user_id, trigger, opts.dry ? 1 : 0, opts.attempt ?? 0, task.policy_version, task.policy, clock())
  changed(task.user_id, { task: task.id, run: id })
  return id
}

const activeRunOf = (taskId: string) => database().prepare(`SELECT id, status FROM agent_task_runs WHERE task_id = ? AND status IN ${ACTIVE_RUNS} ORDER BY queued_at`).all(taskId) as { id: string; status: string }[]

/** Run now (or a dry run: every change asks). */
export function runNow(user: User, id: string, body: { dry?: unknown } = {}): TaskRunInfo {
  const row = ownTask(user, id)
  if (!enabled) throw new HttpError(409, 'Tasks are switched off on this server (AGENT_TASKS)')
  if (activeRunOf(row.id).length) throw new HttpError(409, 'A run of this task is going: wait for it, or cancel it')
  const runId = queueRun(row, body.dry === true ? 'dry' : 'manual', { dry: body.dry === true })
  kick()
  return runInfo(ownRun(user, runId))
}

const accountOf = (userId: number): User | null => accounts().find((u) => u.id === userId) ?? null

/**
 * Claims a due task for its slot: next_run_at moves on only if it still is what was read (a
 * compare-and-set), so two ticks (or two servers) never run one slot twice. Answers whether this
 * caller got it. Exported for scripts/agents-tasks-check.ts.
 */
export function claimTask(id: string, due: number, next: number | null): boolean {
  return database().prepare("UPDATE agent_tasks SET next_run_at = ? WHERE id = ? AND next_run_at = ? AND status = 'active'").run(next, id, due).changes === 1
}

function claimDue(now: number) {
  const due = database().prepare("SELECT * FROM agent_tasks WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at LIMIT 50").all(now) as TaskRow[]
  for (const row of due) {
    const spec = specOf(row)
    const at = row.next_run_at!
    const missed = now - at > GRACE_MS
    // A one-off runs once; a repeating task's next slot is after now, so missed slots are not piled up.
    const next = spec.schedule.kind === 'once' ? null : planNext(row.id, spec, Math.max(now, at))
    if (!claimTask(row.id, at, next)) continue
    if (!accountOf(row.user_id)) continue // banned or gone: the slot passes
    if (missed && spec.schedule.kind !== 'once' && spec.options.missed === 'skip') continue
    const going = activeRunOf(row.id)
    if (going.length && (spec.options.overlap === 'skip' || going.some((r) => r.status === 'queued'))) continue
    queueRun(row, missed ? 'catchup' : 'schedule')
  }
}

/** Starts queued runs while the pool has room: one per account, RUNS_TOTAL in all, oldest first. */
function dispatch() {
  if (!enabled || isShuttingDown()) return
  const queued = database().prepare("SELECT * FROM agent_task_runs WHERE status = 'queued' ORDER BY queued_at LIMIT 200").all() as RunRow[]
  for (const run of queued) {
    if (inFlight.size >= RUNS_TOTAL) break
    if ([...inFlight.values()].filter((f) => f.userId === run.user_id).length >= RUNS_PER_USER) continue
    // Claimed like a slot: queued → running, only once.
    if (database().prepare("UPDATE agent_task_runs SET status = 'running', started_at = COALESCE(started_at, ?) WHERE id = ? AND status = 'queued'").run(clock(), run.id).changes !== 1) continue
    const ctl = new AbortController()
    inFlight.set(run.id, { userId: run.user_id, ctl })
    changed(run.user_id, { task: run.task_id, run: run.id })
    void withoutPrivateRequest(() => execute(run.id, ctl))
      .catch((e) => console.error('[tasks] run failed:', (e as Error).message))
      .finally(() => {
        inFlight.delete(run.id)
        dispatch()
      })
  }
}

let kickTimer: ReturnType<typeof setTimeout> | null = null
/** Looks for work soon (a task was made, a run asked for, an answer given). */
function kick() {
  if (!enabled || kickTimer) return
  kickTimer = setTimeout(() => {
    kickTimer = null
    void tick()
  }, 10)
}

async function execute(runId: string, ctl: AbortController) {
  const db = database()
  const run = db.prepare('SELECT * FROM agent_task_runs WHERE id = ?').get(runId) as RunRow
  const task = db.prepare('SELECT * FROM agent_tasks WHERE id = ?').get(run.task_id) as TaskRow | undefined
  const user = accountOf(run.user_id)
  if (!task || !user) return void finish(run.id, { status: 'cancelled', error: 'The task or account is gone' })
  const spec = specOf(task)
  const policy = normalizePolicy(parse(run.policy, {}))
  const pending = parse<TaskPending | null>(run.pending, null)
  let model: string
  try {
    model = await taskModel(user, spec.model)
    requireTaskKey(user, model)
  } catch (e) {
    return void finish(run.id, { status: 'failed', error: (e as Error).message })
  }
  let thread = run.thread_id
  if (!thread) {
    const day = new Date(clock()).toLocaleString('en-GB', { timeZone: spec.timezone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    thread = createRunThread(user, { title: `${spec.title} · ${day}`, model, groups: usedGroups(policy) })
    db.prepare('UPDATE agent_task_runs SET thread_id = ? WHERE id = ?').run(thread, run.id)
    changed(user.id, { task: task.id, run: run.id })
  }
  const tools = new Set(TOOL_NAMES.filter((n) => toolVerdict(policy, n) !== 'block'))
  const system = await taskSystemPrompt(user, { zone: spec.timezone, memories: policy.memories, tools, title: spec.title, condition: spec.condition, doneWhen: spec.doneWhen, when: spec.report.when, stateNote: task.state_note, dry: !!run.dry })
  const used: TaskUsage = { toolCalls: run.tool_calls, tokensIn: run.tokens_in, tokensOut: run.tokens_out, activeMs: run.active_ms }
  if (pending) db.prepare('UPDATE agent_task_runs SET pending = NULL, deadline = NULL WHERE id = ?').run(run.id)
  const result = await runTaskTurn({
    user,
    thread,
    model,
    system,
    zone: spec.timezone,
    tools,
    decide: (call, ctx) => taskDecide(policy, call, { ...ctx, dryRun: !!run.dry }),
    memories: policy.memories,
    caps: { toolCalls: spec.caps.toolCalls, tokens: spec.caps.tokens, ms: spec.caps.minutes * 60_000 },
    used,
    signal: ctl.signal,
    ...(pending ? { resume: pending } : { first: spec.instruction }),
  })
  db.prepare('UPDATE agent_task_runs SET tool_calls = ?, tokens_in = ?, tokens_out = ?, active_ms = ? WHERE id = ?').run(used.toolCalls, used.tokensIn, used.tokensOut, used.activeMs, run.id)
  if (result.outcome === 'waiting') {
    if (!db.prepare("UPDATE agent_task_runs SET status = 'waiting', pending = ?, deadline = ? WHERE id = ? AND status = 'running'").run(JSON.stringify(result.pending), clock() + ASK_WAIT_MS(), run.id).changes) return
    const asks = result.pending.calls.filter((c) => c.state === 'asking')
    notify(user, { source: 'agenttasks.ask', title: `A task needs you: ${spec.title}`, body: asks.map((a) => a.summary?.title ?? TASK_TOOLS[a.call.name]?.label ?? a.call.name).join('; ').slice(0, 300), action: openRun(task.id, run.id), tag: `task-ask-${task.id}` })
    changed(user.id, { task: task.id, run: run.id })
    return
  }
  if (result.outcome === 'stopped') {
    // On the way down it stays running: the next start marks it interrupted and tries again.
    if (isShuttingDown()) return
    return void finish(run.id, { status: 'cancelled' })
  }
  if (result.outcome === 'failed') return void finish(run.id, { status: 'failed', error: result.error })
  finish(run.id, { status: 'succeeded', verdict: result.verdict, text: result.text })
}

const openRun = (task: string, run: string) => ({ app: 'agents', props: { tab: 'tasks', task, run } })

/**
 * A run's end: what it found decides whether it reports (the task's "when", its condition, the
 * failure guard; a run that needs the user always does), the state note and done-ness go to the
 * task, and the report goes where the task says.
 */
function finish(runId: string, end: { status: 'succeeded' | 'failed' | 'cancelled' | 'denied'; verdict?: RunVerdict | null; text?: string; error?: string }) {
  const db = database()
  const run = db.prepare('SELECT * FROM agent_task_runs WHERE id = ?').get(runId) as RunRow | undefined
  if (!run) return
  const task = db.prepare('SELECT * FROM agent_tasks WHERE id = ?').get(run.task_id) as TaskRow | undefined
  const now = clock()
  if (!task) {
    db.prepare('UPDATE agent_task_runs SET status = ?, ended_at = ?, error = ? WHERE id = ?').run(end.status, now, end.error ?? null, run.id)
    return
  }
  const spec = specOf(task)
  const verdict = end.verdict ?? null
  const failures = end.status === 'failed' ? task.failures + 1 : end.status === 'succeeded' ? 0 : task.failures
  const when = spec.report.when
  let deliver = false
  let reason = ''
  if (end.status === 'denied') (deliver = true), (reason = 'Needs you: a call waited 12 hours for an answer')
  else if (end.status === 'failed') {
    deliver = when !== 'condition' || failures >= FAILURE_GUARD
    reason = failures >= FAILURE_GUARD && when === 'condition' ? `Failed ${failures} times in a row` : `Failed: ${end.error ?? 'something went wrong'}`
  } else if (end.status === 'succeeded') {
    if (!verdict) (deliver = when !== 'failure'), (reason = 'The agent ended without a verdict, so this is reported')
    else if (when === 'always') (deliver = true), (reason = verdict.reason || 'Reports every run')
    else if (when === 'failure') (deliver = false), (reason = verdict.reason || 'Reports only when something fails')
    else (deliver = verdict.report), (reason = verdict.reason || (verdict.report ? 'The condition is met' : 'Nothing new'))
  } else reason = 'Cancelled'
  if (run.dry) deliver = false
  const summary = end.status === 'succeeded' ? (verdict?.summary || end.text || '').trim() : end.status === 'denied' ? 'A call needed your approval and nobody answered within 12 hours, so it was denied and the run stopped.' : end.error ?? null
  db.prepare('UPDATE agent_task_runs SET status = ?, ended_at = ?, error = ?, verdict = ?, summary = ?, report_reason = ?, quiet = ?, reported = ? WHERE id = ?').run(end.status, now, end.error ?? null, verdict ? JSON.stringify(verdict) : null, summary, reason, deliver ? 0 : 1, deliver ? 1 : 0, run.id)

  // The task: its state note, failures, done-ness, a one-off's end.
  const updates: string[] = ['failures = ?', 'last_run_at = ?', 'updated_at = ?']
  const values: (string | number | null)[] = [failures, now, now]
  if (verdict?.state !== undefined && !run.dry) updates.push('state_note = ?'), values.push(verdict.state.slice(0, 2000))
  const done = !run.dry && end.status === 'succeeded' && verdict?.done && !spec.options.keepWatching
  if (done || (spec.schedule.kind === 'once' && !run.dry && end.status !== 'cancelled' && task.status === 'active' && task.next_run_at === null)) updates.push("status = 'completed'", 'next_run_at = NULL')
  db.prepare(`UPDATE agent_tasks SET ${updates.join(', ')} WHERE id = ?`).run(...values, task.id)

  const user = accountOf(run.user_id)
  if (user && deliver) {
    const kind = end.status === 'denied' ? 'needs' : end.status === 'failed' ? 'failed' : 'report'
    void report(user, task, run.id, kind, summary || reason).catch((e) => console.warn('[tasks] report failed:', (e as Error).message))
  } else if (user && end.status === 'succeeded' && !run.dry && spec.options.heartbeat !== 'off' && now - (task.last_report_at ?? task.created_at) > HEARTBEAT_MS[spec.options.heartbeat]) {
    void report(user, task, run.id, 'heartbeat', `Still watching. Nothing to report since ${new Date(task.last_report_at ?? task.created_at).toLocaleDateString('en-GB', { timeZone: spec.timezone, day: 'numeric', month: 'short' })}.${verdict?.reason ? ` Last run: ${verdict.reason}` : ''}`).catch(() => {})
  }
  prune(task, user)
  changed(run.user_id, { task: task.id, run: run.id })
}

/** Keeps the newest runs of a task (Settings → Apps → Agents, or the task's own number); older ones go, with their threads. */
function prune(task: TaskRow, user: User | null) {
  if (!user) return
  const keep = optionsOf(parse(task.options, {})).keep ?? taskSettings(user).keep
  const old = database().prepare(`SELECT id, thread_id FROM agent_task_runs WHERE task_id = ? AND status NOT IN ${ACTIVE_RUNS} ORDER BY queued_at DESC LIMIT -1 OFFSET ?`).all(task.id, keep) as { id: string; thread_id: string | null }[]
  for (const r of old) {
    if (r.thread_id) deleteRunThread(user, r.thread_id)
    database().prepare('DELETE FROM agent_task_runs WHERE id = ?').run(r.id)
  }
}

// --- reports -------------------------------------------------------------------------------------

/** Sends a run's report where the task says: a thread, a notification, email. */
async function report(user: User, task: TaskRow, runId: string, kind: 'report' | 'failed' | 'needs' | 'heartbeat', body: string) {
  const spec = specOf(task)
  const db = database()
  const title = kind === 'needs' ? `${spec.title} needs you` : kind === 'failed' ? `${spec.title} failed` : kind === 'heartbeat' ? `${spec.title}: still watching` : spec.title
  const delivered: string[] = []
  const model = await taskModel(user, spec.model).catch(() => '')
  if (spec.report.thread !== 'none') {
    const message = `**${title}**\n\n${body}\n\n_From the task “${spec.title}”: its runs are in Agents → Tasks._`
    try {
      const posted = postTaskReport(user, spec.report.thread === 'fixed' ? spec.report.threadId : null, { title, model, text: message })
      if (posted) delivered.push('thread')
      else (addJob(user.id, runId, 'thread', clock() + 60_000, { target: spec.report.threadId, title, model, text: message, tries: 0 }), delivered.push('thread (when it is at rest)'))
    } catch (e) {
      delivered.push(`thread failed: ${(e as Error).message}`)
    }
  }
  let entry: ReturnType<typeof notify> = null
  if (spec.report.notify) {
    entry = notify(user, { source: kind === 'needs' ? 'agenttasks.ask' : 'agenttasks.report', title, body: body.replace(/[#*_`>]/g, '').split('\n').find((l) => l.trim())?.slice(0, 300) ?? '', action: openRun(task.id, runId), tag: `task-${task.id}` })
    if (entry) delivered.push('notification')
  }
  if (spec.report.email === 'always' || (spec.report.email === 'unseen' && !entry)) {
    try {
      await reportEmail(user, spec.report.emailAccount, title, body, task.id, runId)
      delivered.push('email')
    } catch (e) {
      delivered.push(`email failed: ${(e as Error).message}`)
    }
  } else if (spec.report.email === 'unseen' && entry) {
    addJob(user.id, runId, 'email_if_unseen', clock() + UNSEEN_MS(), { entry: entry.id, account: spec.report.emailAccount, title, body, task: task.id })
    delivered.push('email if not seen in time')
  }
  db.prepare('UPDATE agent_task_runs SET delivered = ? WHERE id = ?').run(JSON.stringify(delivered), runId)
  db.prepare('UPDATE agent_tasks SET last_report_at = ? WHERE id = ?').run(clock(), task.id)
  changed(user.id, { task: task.id, run: runId })
}

/**
 * The email fallback: plain text from the user's own mail account to its own address. Not the
 * agent's mail_send tool, and nobody else ever gets it. The agent's words are marked as such.
 */
async function reportEmail(user: User, accountId: number | null, title: string, body: string, task: string, run: string) {
  const all = listMail(user)
  const info = all.find((a) => a.id === accountId) ?? all[0]
  if (!info) throw new Error('No mail account is linked')
  const acc = mailAccount(user, info.id)
  const meta = await mailMeta(acc)
  const identity = meta.identities[0]
  if (!identity) throw new Error(`${info.label} has no address to send from`)
  const origin = (process.env.PUBLIC_ORIGIN ?? '').replace(/\/+$/, '')
  const link = `${origin}/?open=agents&tab=tasks&task=${task}&run=${run}`
  const text = [`A report from your agent task.`, '', '--- What the agent wrote ---', body.slice(0, 20_000), '--- End of what the agent wrote ---', '', `Open the run: ${link}`, '', 'You get this because the task is set to email its reports to you. Change it in Agents → Tasks.'].join('\n')
  await sendMail(acc, { identityId: identity.id, to: [{ name: identity.name || null, email: identity.email }], subject: `[Agent task] ${title}`.slice(0, 300), text })
}

function addJob(userId: number, runId: string, kind: 'thread' | 'email_if_unseen', due: number, data: Record<string, unknown>) {
  database().prepare('INSERT INTO agent_task_jobs (user_id, run_id, kind, due_at, data) VALUES (?, ?, ?, ?, ?)').run(userId, runId, kind, due, JSON.stringify(data))
}

/** What is due later: an email when the notification is still unread, a report for a thread that was busy. */
async function runJobs(now: number) {
  const db = database()
  const jobs = db.prepare('SELECT * FROM agent_task_jobs WHERE due_at <= ? ORDER BY due_at LIMIT 50').all(now) as { id: number; user_id: number; run_id: string; kind: string; data: string }[]
  for (const job of jobs) {
    // Taken once: whoever deletes it does it.
    if (db.prepare('DELETE FROM agent_task_jobs WHERE id = ?').run(job.id).changes !== 1) continue
    const user = accountOf(job.user_id)
    if (!user) continue
    const data = parse<Record<string, unknown>>(job.data, {})
    const delivered = (line: string) => {
      const row = db.prepare('SELECT delivered FROM agent_task_runs WHERE id = ?').get(job.run_id) as { delivered: string | null } | undefined
      if (row) db.prepare('UPDATE agent_task_runs SET delivered = ? WHERE id = ?').run(JSON.stringify([...parse<string[]>(row.delivered, []), line]), job.run_id)
    }
    try {
      if (job.kind === 'email_if_unseen') {
        const read = db.prepare('SELECT read FROM notifications WHERE id = ? AND user_id = ?').get(String(data.entry), user.id) as { read: number } | undefined
        if (read?.read) continue
        await reportEmail(user, typeof data.account === 'number' ? data.account : null, String(data.title), String(data.body), String(data.task), job.run_id)
        delivered('email (the notification was not seen)')
      } else if (job.kind === 'thread') {
        const posted = postTaskReport(user, typeof data.target === 'string' ? data.target : null, { title: String(data.title), model: String(data.model), text: String(data.text) })
        const tries = Number(data.tries) || 0
        if (posted) delivered('thread')
        else if (tries < 60) addJob(user.id, job.run_id, 'thread', now + 60_000, { ...data, tries: tries + 1 })
      }
    } catch (e) {
      delivered(`${job.kind === 'thread' ? 'thread' : 'email'} failed: ${(e as Error).message}`)
    }
  }
}

// --- answers, cancelling, continuing --------------------------------------------------------------

/** The user's answer to a call a waiting run asks about. Once nothing waits, the run goes on. */
export function approveRun(user: User, id: string, body: { index?: unknown; allow?: unknown }): TaskRunInfo {
  const run = ownRun(user, id)
  if (run.status !== 'waiting') throw new HttpError(409, 'This run is not waiting for an answer')
  const pending = parse<TaskPending | null>(run.pending, null)
  const call = pending?.calls.find((c) => c.index === Number(body.index) && c.state === 'asking')
  if (!pending || !call) throw new HttpError(404, 'Nothing is waiting for that')
  call.state = body.allow === true ? 'approved' : 'denied'
  const open = pending.calls.some((c) => c.state === 'asking')
  // Compare-and-set on what was read, so two answers at once cannot both start it.
  const ok = database().prepare(`UPDATE agent_task_runs SET pending = ?, status = ? WHERE id = ? AND status = 'waiting' AND pending = ?`).run(JSON.stringify(pending), open ? 'waiting' : 'queued', run.id, run.pending).changes
  if (!ok) throw new HttpError(409, 'The run changed meanwhile: look again')
  changed(user.id, { task: run.task_id, run: run.id })
  if (!open) kick()
  return runInfo(ownRun(user, run.id))
}

export function cancelRun(user: User, id: string): TaskRunInfo {
  const run = ownRun(user, id)
  if (run.status === 'queued') {
    if (database().prepare("UPDATE agent_task_runs SET status = 'cancelled', ended_at = ?, report_reason = 'Cancelled' WHERE id = ? AND status = 'queued'").run(clock(), run.id).changes) {
      const pending = parse<TaskPending | null>(run.pending, null)
      if (pending && run.thread_id) settleRunPending(run.thread_id, pending, 'cancelled')
    }
  } else if (run.status === 'running') {
    inFlight.get(run.id)?.ctl.abort()
    if (run.thread_id) stopRun(run.thread_id)
  } else if (run.status === 'waiting') {
    const pending = parse<TaskPending | null>(run.pending, null)
    if (database().prepare("UPDATE agent_task_runs SET status = 'running', pending = NULL WHERE id = ? AND status = 'waiting'").run(run.id).changes) {
      if (pending && run.thread_id) settleRunPending(run.thread_id, pending, 'cancelled')
      finish(run.id, { status: 'cancelled' })
    }
  } else throw new HttpError(409, 'This run is over already')
  changed(user.id, { task: run.task_id, run: run.id })
  return runInfo(ownRun(user, run.id))
}

/** Continue in thread: the run's transcript as a normal thread to follow up in (the run itself stays as it was). */
export function continueRun(user: User, id: string) {
  const run = ownRun(user, id)
  if (!run.thread_id) throw new HttpError(409, 'This run has no transcript yet')
  if (runActive(run.thread_id)) throw new HttpError(409, 'Wait for the run to finish first')
  const last = database().prepare('SELECT MAX(id) AS id FROM agent_messages WHERE thread_id = ?').get(run.thread_id) as { id: number | null }
  if (!last.id) throw new HttpError(409, 'This run has no transcript yet')
  return branchThread(user, run.thread_id, { messageId: last.id })
}

/** The live view: the run's thread as it goes (server/agents.ts followThread). */
export function followRun(res: ServerResponse, user: User, id: string) {
  const run = ownRun(user, id)
  if (!run.thread_id) throw new HttpError(409, 'This run has not started yet')
  followThread(res, user, run.thread_id)
}

/** Runs that waited too long: the asked calls are denied, and the run ends needing the user. */
function expireAsks(now: number) {
  const db = database()
  const rows = db.prepare("SELECT * FROM agent_task_runs WHERE status = 'waiting' AND deadline IS NOT NULL AND deadline <= ?").all(now) as RunRow[]
  for (const run of rows) {
    if (!db.prepare("UPDATE agent_task_runs SET status = 'running', pending = NULL, deadline = NULL WHERE id = ? AND status = 'waiting'").run(run.id).changes) continue
    const pending = parse<TaskPending | null>(run.pending, null)
    if (pending && run.thread_id) {
      for (const c of pending.calls) if (c.state === 'asking') c.state = 'expired'
      settleRunPending(run.thread_id, pending, 'expired')
    }
    finish(run.id, { status: 'denied' })
  }
}

/** Tasks past their end date stop, and say so once. */
function expireTasks(now: number) {
  const db = database()
  const rows = db.prepare("SELECT * FROM agent_tasks WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?").all(now) as TaskRow[]
  for (const t of rows) {
    if (!db.prepare("UPDATE agent_tasks SET status = 'expired', next_run_at = NULL, updated_at = ? WHERE id = ? AND status = 'active'").run(now, t.id).changes) continue
    const user = accountOf(t.user_id)
    if (user) notify(user, { source: 'agenttasks.report', title: `${t.title} has expired`, body: 'It reached its end date and stopped. Renew it in Agents → Tasks to keep it going.', action: { app: 'agents', props: { tab: 'tasks', task: t.id } }, tag: `task-${t.id}` })
    changed(t.user_id, { task: t.id })
  }
}

let busy = false
/** One look: expire what is past, claim what is due, send what waits, start what fits. Exported for the check script. */
export async function tick() {
  if (busy) return
  busy = true
  try {
    const now = clock()
    expireTasks(now)
    expireAsks(now)
    claimDue(now)
    await runJobs(now)
    dispatch()
  } catch (e) {
    console.error('[tasks]', (e as Error).message)
  } finally {
    busy = false
  }
}

/** Stops an account's runs (banned or deleted: server/agents.ts stopTurnsOf). */
export function stopTasksOf(userId: number) {
  for (const [, f] of inFlight) if (f.userId === userId) f.ctl.abort()
}
onUserGone(stopTasksOf)

let started = false
/**
 * Once the server starts: runs cut off by the last stop are marked interrupted (and tried once
 * more), then the scheduler starts, unless AGENT_TASKS=off (or, in the dev server, unless
 * AGENT_TASKS=on).
 */
export function startAgentTasks(opts: { dev?: boolean } = {}) {
  if (started) return
  started = true
  const db = database()
  const cut = db.prepare("SELECT * FROM agent_task_runs WHERE status = 'running'").all() as RunRow[]
  for (const run of cut) {
    db.prepare("UPDATE agent_task_runs SET status = 'interrupted', ended_at = ?, report_reason = 'The server restarted while it ran' WHERE id = ?").run(clock(), run.id)
    if (run.thread_id) closeRunCalls(run.thread_id)
    const task = db.prepare('SELECT * FROM agent_tasks WHERE id = ?').get(run.task_id) as TaskRow | undefined
    // Tried once more (the policy it was started under), and not a failure.
    if (task && run.attempt === 0) queueRun({ ...task, policy: run.policy, policy_version: run.policy_version }, 'retry', { dry: !!run.dry, attempt: 1 })
  }
  if (cut.length) console.log(`[tasks] ${cut.length} ${cut.length === 1 ? 'run was' : 'runs were'} cut off by a restart: marked interrupted`)
  const flag = process.env.AGENT_TASKS
  enabled = flag === 'on' || (!opts.dev && flag !== 'off')
  onShutdown('agent tasks', () => {
    enabled = false
  })
  if (!enabled) return
  setInterval(() => void tick(), TICK_MS).unref()
  kick()
}

// --- the agent's own task tools, in chat threads ------------------------------------------------------

export const TASK_CHAT_TOOLS = new Set(['create_task', 'update_task', 'cancel_task'])

type ToolDef = { type: 'function'; function: { name: string; description: string; parameters: { type: 'object'; properties: Record<string, unknown>; required?: string[] } } }
const def = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []): ToolDef => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } })
const str = (description: string) => ({ type: 'string', description })

const specProps = {
  title: str('A short title'),
  instruction: str('What the agent does on each run, in full: it starts with nothing else'),
  condition: str('"Tell me when…": when a run should report (empty: report as `report_when` says)'),
  done_when: str('When the task is done and stops (empty: never; a one-off ends after its run)'),
  schedule: {
    type: 'object',
    description: 'When it runs: once (at a local time "YYYY-MM-DDTHH:MM", or now when at is empty), daily, weekdays or weekly at "HH:MM" (weekly: days, 0 Sunday to 6 Saturday), or a 5-field cron line. At most every 15 minutes.',
    properties: { kind: { type: 'string', enum: ['once', 'daily', 'weekdays', 'weekly', 'cron'] }, at: str('once: local "YYYY-MM-DDTHH:MM", or empty for now'), time: str('"HH:MM"'), days: { type: 'array', items: { type: 'integer' } }, expr: str('cron line') },
    required: ['kind'],
  },
  allow: { type: 'array', items: { type: 'string' }, description: `Tools or groups that run without asking (${TASK_GROUPS.filter((g) => !['chat', 'tasks', 'run', 'files', 'terminal', 'images'].includes(g.id)).map((g) => g.id).join(', ')}, or tool names). Mail sends and calendar changes always ask.` },
  ask: { type: 'array', items: { type: 'string' }, description: 'Tools or groups that ask the user each time' },
  sites: { type: 'array', items: { type: 'string' }, description: 'Web sites it may read without asking, like github.com' },
  report_to: { type: 'string', enum: ['this_thread', 'new_thread', 'notification_only'], description: 'Where reports go besides a notification (default: this thread)' },
  report_when: { type: 'string', enum: ['condition', 'always', 'failure'], description: 'condition (default): when the condition is met; always: every run; failure: only when something fails' },
}

/** create_task, update_task and cancel_task, for chat threads (never in task runs). */
export function taskChatTools(): ToolDef[] {
  return [
    def('create_task', 'Make a background task: an agent that runs on its own, once or on a schedule, and reports back (a notification, this thread). The user is always asked first and can change it on the card. Use it when the user asks for something to happen later, regularly, or to be watched ("tell me when…").', specProps, ['title', 'instruction', 'schedule']),
    def('update_task', 'Change one of the user\'s background tasks (by id or exact title); give only what changes. Always asked first.', { task: str('The task id or exact title'), ...specProps }, ['task']),
    def('cancel_task', "Stop one of the user's background tasks for good (by id or exact title). Always asked first.", { task: str('The task id or exact title') }, ['task']),
  ]
}

function findTask(user: User, ref: unknown): TaskRow {
  const s = String(ref ?? '').trim()
  const rows = database().prepare('SELECT * FROM agent_tasks WHERE user_id = ?').all(user.id) as TaskRow[]
  const t = rows.find((r) => r.id === s) ?? rows.find((r) => r.title.toLowerCase() === s.toLowerCase())
  if (!t) throw new Error(`No task "${s.slice(0, 80)}". Tasks: ${rows.map((r) => `${r.id} ${r.title}`).join('; ') || 'none'}`)
  return t
}

/** A local "YYYY-MM-DDTHH:MM" in a zone, as a moment. */
function localMoment(raw: string, zone: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(raw.trim())
  if (!m) throw new Error('once: give at as "YYYY-MM-DDTHH:MM" (local time), or leave it empty for now')
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(new Date(guess))
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0)
  const offset = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute')) - guess
  return guess - offset
}

/** What the agent's arguments say, as a task spec (over `base` for a change). */
function specFromArgs(user: User, args: Record<string, unknown>, zone: string, thread: string, base?: TaskSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (typeof args.title === 'string') out.title = args.title
  if (typeof args.instruction === 'string') out.instruction = args.instruction
  if (typeof args.condition === 'string') out.condition = args.condition
  if (typeof args.done_when === 'string') out.doneWhen = args.done_when
  if (!base) out.timezone = zone
  if (args.schedule && typeof args.schedule === 'object') {
    const s = { ...(args.schedule as Record<string, unknown>) }
    if (s.kind === 'once') s.at = typeof s.at === 'string' && s.at.trim() ? localMoment(s.at, base?.timezone ?? zone) : null
    out.schedule = s
  }
  if (Array.isArray(args.allow) || Array.isArray(args.ask) || Array.isArray(args.sites)) {
    const policy: TaskPolicy = structuredClone(base?.policy ?? defaultPolicy())
    const put = (names: unknown, v: 'allow' | 'ask') => {
      for (const n of Array.isArray(names) ? names : []) {
        const name = String(n)
        if (TASK_GROUPS.some((g) => g.id === name)) policy.groups[name as keyof TaskPolicy['groups']] = v
        else if (TASK_TOOLS[name]) policy.tools[name] = v
        else throw new Error(`Unknown tool or group "${name.slice(0, 40)}"`)
      }
    }
    put(args.ask, 'ask')
    put(args.allow, 'allow')
    if (Array.isArray(args.sites)) policy.sites = [...new Set([...policy.sites, ...args.sites.map(String)])]
    out.policy = policy
  }
  if (typeof args.report_to === 'string' || typeof args.report_when === 'string') {
    const r = { ...(base?.report ?? { ...DEFAULT_REPORT, ...taskSettings(user).report }) }
    if (args.report_to === 'this_thread') (r.thread = 'fixed'), (r.threadId = thread)
    else if (args.report_to === 'new_thread') (r.thread = 'new'), (r.threadId = null)
    else if (args.report_to === 'notification_only') (r.thread = 'none'), (r.notify = true)
    if (args.report_when === 'always' || args.report_when === 'failure' || args.report_when === 'condition') r.when = args.report_when
    out.report = r
  }
  return out
}

const REPORT_WHEN = { always: 'Every run', failure: 'Only when something fails or needs you', condition: 'When the condition is met' } as const
function specRows(spec: TaskSpec, available?: (g: string) => boolean): [string, string][] {
  const s = policySummary(spec.policy, available as never)
  const to = [spec.report.thread === 'new' ? 'a new thread each run' : spec.report.thread === 'fixed' ? (spec.report.threadId ? 'this thread' : 'a thread') : '', spec.report.notify ? 'a notification' : '', spec.report.email === 'always' ? 'email to you' : spec.report.email === 'unseen' ? 'email when the notification is not seen' : ''].filter(Boolean)
  return [
    ['Runs', `${describeSchedule(spec.schedule, spec.timezone)} (${spec.timezone})`],
    ['Tell you', spec.condition ? `When: ${spec.condition}` : REPORT_WHEN[spec.report.when]],
    ...(spec.doneWhen ? [['Done when', spec.doneWhen] as [string, string]] : []),
    ['Reports to', to.join(', ') || 'only the run history'],
    ['May', s.lines.join(' ')],
    ...s.warnings.map((w) => ['Watch out', w] as [string, string]),
    ['Model', spec.model ?? 'The task model from Settings'],
    ['Ends', spec.expiresAt ? new Date(spec.expiresAt).toLocaleDateString('en-GB', { timeZone: spec.timezone, day: 'numeric', month: 'short', year: 'numeric' }) : 'Never'],
  ]
}

/**
 * A create_task, update_task or cancel_task call, checked and ready for the approval card (which
 * always shows: server/agents.ts asks in every mode). `run` takes the task as the user edited it on
 * the card, checked again the same way.
 */
export async function prepareTaskCall(user: User, thread: string, name: string, args: Record<string, unknown>, zone: string): Promise<{ summary: CallSummary; run: (edit?: Record<string, unknown>) => Promise<string> }> {
  const from = ownChatThread(user, thread) ? thread : null
  if (name === 'create_task') {
    const spec = cleanSpec(user, specFromArgs(user, args, zone, from ?? thread), undefined, from)
    return {
      summary: { title: `Make the task “${spec.title}”`, rows: specRows(spec), body: spec.instruction, spec },
      run: async (edit) => {
        const t = createTask(user, edit ? cleanSpec(user, edit, undefined, from) : spec, from)
        return JSON.stringify({ created: { id: t.id, title: t.title, next_run: t.nextRunAt ? new Date(t.nextRunAt).toISOString() : null, note: 'It shows in Agents → Tasks, with every run.' } })
      },
    }
  }
  const row = findTask(user, args.task)
  const before = specOf(row)
  if (name === 'update_task') {
    const spec = cleanSpec(user, specFromArgs(user, args, zone, from ?? thread, before), before)
    const wider = widens(before.policy, spec.policy)
    return {
      summary: { title: `Change the task “${before.title}”`, rows: [...(wider ? [['Widens', 'It may do more than before'] as [string, string]] : []), ...specRows(spec)], body: spec.instruction, spec },
      run: async (edit) => {
        const t = updateTask(user, row.id, edit ? cleanSpec(user, edit, before) : spec)
        return JSON.stringify({ updated: { id: t.id, title: t.title, next_run: t.nextRunAt ? new Date(t.nextRunAt).toISOString() : null } })
      },
    }
  }
  if (name === 'cancel_task')
    return {
      summary: { title: `Cancel the task “${before.title}”`, rows: [['Runs', describeSchedule(before.schedule, before.timezone)], ['After', 'It stops for good; its runs stay in the history']] },
      run: async () => {
        database().prepare("UPDATE agent_tasks SET status = 'completed', next_run_at = NULL, updated_at = ? WHERE id = ? AND user_id = ?").run(clock(), row.id, user.id)
        changed(user.id, { task: row.id })
        return JSON.stringify({ cancelled: { id: row.id, title: row.title } })
      },
    }
  throw new Error(`There is no tool called ${name}`)
}

// --- the API -------------------------------------------------------------------------------------

/** What the editor can offer: linked mail accounts, and whether calendars and Seafile are there. */
function taskOptions(user: User) {
  return { enabled, mail: listMail(user).map((a) => ({ id: a.id, label: a.label })), defaults: { report: { ...DEFAULT_REPORT, ...taskSettings(user).report }, keep: taskSettings(user).keep, caps: DEFAULT_CAPS, options: DEFAULT_OPTIONS } }
}

/** /api/agents/tasks… and /api/agents/task-runs…; answers whether it handled the request. */
export async function handleAgentTasksApi(req: IncomingMessage, res: ServerResponse, url: URL, method: string, user: User): Promise<boolean> {
  const path = url.pathname
  const read = method === 'GET' || method === 'HEAD'
  if (path === '/api/agents/tasks' && read) return json(res, 200, listTasks(user)), true
  if (path === '/api/agents/tasks' && method === 'POST') {
    const body = await readJson<{ spec?: unknown; from?: unknown }>(req, 64 * 1024)
    return json(res, 200, createTask(user, body.spec, typeof body.from === 'string' ? body.from : null)), true
  }
  if (path === '/api/agents/tasks/options' && read) return json(res, 200, taskOptions(user)), true
  const task = /^\/api\/agents\/tasks\/([0-9a-f-]{36})(\/runs|\/run)?$/.exec(path)
  if (task) {
    const [, id, sub] = task
    if (!sub && read) return json(res, 200, getTask(user, id)), true
    if (!sub && method === 'PATCH') return json(res, 200, updateTask(user, id, await readJson(req, 64 * 1024))), true
    if (!sub && method === 'DELETE') return deleteTask(user, id), json(res, 200, { ok: true }), true
    if (sub === '/runs' && read) return json(res, 200, listRuns(user, id, url.searchParams)), true
    if (sub === '/run' && method === 'POST') return json(res, 200, runNow(user, id, await readJson(req, 1024))), true
  }
  const run = /^\/api\/agents\/task-runs\/([0-9a-f-]{36})(\/approve|\/cancel|\/continue|\/follow)?$/.exec(path)
  if (run) {
    const [, id, sub] = run
    if (!sub && read) return json(res, 200, getRun(user, id)), true
    if (sub === '/approve' && method === 'POST') return json(res, 200, approveRun(user, id, await readJson(req, 1024))), true
    if (sub === '/cancel' && method === 'POST') return json(res, 200, cancelRun(user, id)), true
    if (sub === '/continue' && method === 'POST') return json(res, 200, continueRun(user, id)), true
    if (sub === '/follow' && read) return followRun(res, user, id), true
  }
  return false
}

