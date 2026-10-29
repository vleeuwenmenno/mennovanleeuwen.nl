import { askArgLines, callVerdictKind, policySummary, RUN_STATUS_LABEL, TASK_TOOLS, type Task, type TaskRunInfo } from '../../data/agentTaskPolicy'
import { describeSchedule } from '../../data/agentTaskSchedule'
import { approveRun, cancelRun, getRun, listRuns, listTasks, runTask, updateTask } from '../../data/agentTasks'
import { getThread, type AgentMessage, type MessageMeta } from '../../data/agents'
import { clipLine, seg, wrap, type Line } from './text'

// /tasks in the agents command: background tasks (server/agentTasks.ts) as lines. The same API
// as the Agents app's Tasks tab; ids may be given as a unique prefix.

export const TASKS_HELP = '/tasks [show|runs|run|dry|pause|resume <task>] [log|approve|deny|cancel <run> [call]]'

const when = (ms: number | null | undefined, zone?: string) => (ms ? new Date(ms).toLocaleString('en-GB', { ...(zone ? { timeZone: zone } : {}), weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—')
const tone = (r: TaskRunInfo) => (r.status === 'succeeded' ? 'green' : r.status === 'failed' ? 'red' : r.status === 'waiting' || r.status === 'denied' ? 'yellow' : 'muted')
const runWord = (r: TaskRunInfo) => `${RUN_STATUS_LABEL[r.status]}${r.status === 'succeeded' ? (r.reported ? ', reported' : ', quiet') : ''}${r.dry ? ', dry run' : ''}`

export function taskListLines(tasks: Task[], enabled: boolean, cols: number): Line[] {
  const out: Line[] = [[seg('Tasks', 'bold')]]
  if (!enabled) out.push([seg('  Switched off on this server (AGENT_TASKS): nothing runs.', 'yellow')])
  if (!tasks.length) return [...out, [seg('  None yet. Make one in the Agents app (Tasks), or ask an agent to.', 'muted')], []]
  for (const t of tasks) {
    out.push(clipLine([seg(`  ${t.id.slice(0, 8)} `, 'muted'), seg(t.title, 'bold'), seg(`  ${t.status}`, t.status === 'active' ? 'green' : 'muted')], cols))
    out.push(clipLine([seg(`           ${describeSchedule(t.schedule, t.timezone)}${t.status === 'active' && t.nextRunAt ? ` · next ${when(t.nextRunAt, t.timezone)}` : ''}${t.status === 'active' && t.mailPending ? ` · ${t.mailPending} mail waiting` : ''}`, 'muted')], cols))
    if (t.lastRun) out.push(clipLine([seg('           last: ', 'muted'), seg(runWord(t.lastRun), tone(t.lastRun)), seg(` ${when(t.lastRun.startedAt ?? t.lastRun.queuedAt, t.timezone)} · run ${t.lastRun.id.slice(0, 8)}`, 'muted')], cols))
  }
  return [...out, [seg(`  ${TASKS_HELP}`, 'muted')], []]
}

export function taskLines(t: Task, runs: TaskRunInfo[], cols: number): Line[] {
  const row = (k: string, v: string): Line[] => wrap([seg(v)], cols, [seg(`  ${k.padEnd(12)}`, 'muted')])
  const s = policySummary(t.policy)
  return [
    [seg(t.title, 'bold'), seg(`  ${t.id}`, 'muted')],
    ...row('status', t.status),
    ...row(t.schedule.kind === 'mail' ? 'starts' : 'runs', t.schedule.kind === 'mail' ? describeSchedule(t.schedule, t.timezone) : `${describeSchedule(t.schedule, t.timezone)} (${t.timezone})`),
    ...(t.status === 'active' && t.schedule.kind !== 'mail' ? row('next', when(t.nextRunAt, t.timezone)) : []),
    ...(t.status === 'active' && t.schedule.kind === 'mail' ? row('waiting', t.mailPending ? `${t.mailPending} new mail for the next run` : 'no new mail yet') : []),
    ...row('tells you', t.condition ? `when ${t.condition}` : t.report.when),
    ...(t.doneWhen ? row('done when', t.doneWhen) : []),
    ...row('does', t.instruction),
    ...s.lines.flatMap((l) => row('may', l)),
    ...s.warnings.flatMap((w) => wrap([seg(w, 'yellow')], cols, [seg('  watch out   ', 'yellow')])),
    ...(t.stateNote ? row('state note', t.stateNote) : []),
    [seg('  runs', 'muted')],
    ...runLines(runs, t.timezone, cols),
    [],
  ]
}

export function runLines(runs: TaskRunInfo[], zone: string, cols: number): Line[] {
  if (!runs.length) return [[seg('    none yet', 'muted')]]
  return runs.map((r) => clipLine([seg(`    ${r.id.slice(0, 8)} `, 'muted'), seg(runWord(r), tone(r)), seg(` ${when(r.startedAt ?? r.queuedAt, zone)}${r.reportReason ? ` · ${r.reportReason}` : r.error ? ` · ${r.error}` : ''}`, 'muted')], cols))
}

/** What a waiting run asks, in full: the call, why it asks, what the card says, the arguments (where it goes first, long text last), then how to answer. */
export function askLines(r: TaskRunInfo, cols: number): Line[] {
  const out: Line[] = []
  for (const a of r.asks) {
    out.push(...wrap([seg(`${a.summary?.title ?? TASK_TOOLS[a.name]?.label ?? a.name} (${a.name})`, 'yellow')], cols, [seg(`  waits [${a.index}] `, 'yellow')]))
    if (a.reason) out.push(...wrap([seg(a.reason)], cols, [seg('      why: ', 'muted')]))
    for (const [k, v] of a.summary?.rows ?? []) out.push(...wrap([seg(v)], cols, [seg(`      ${k}: `, 'muted')]))
    if (a.summary?.body !== undefined) out.push([seg('      text:', 'muted')], ...(a.summary.body || '(no text)').split('\n').slice(0, 40).flatMap((l) => wrap([seg(l)], cols, [seg('        ')])))
    for (const [k, v] of askArgLines(a.arguments, 1500)) out.push(...v.split('\n').slice(0, 30).flatMap((l, i) => wrap([seg(l)], cols, [seg(i ? '        ' : `      ${k}: `, 'muted')], [seg('        ')])))
    out.push([seg(`      /tasks approve ${r.id.slice(0, 8)} ${a.index}  or  /tasks deny ${r.id.slice(0, 8)} ${a.index}`, 'muted')])
  }
  return out
}

const VERDICT_WORD = { allowed: 'allowed by policy', approved: 'approved by you', denied: 'denied', expired: 'denied (no answer)', blocked: 'blocked by policy' } as const

/** A run: its facts, what it waits for, the report, and each tool call with how it was decided. */
export function runDetailLines(r: TaskRunInfo, title: string, messages: AgentMessage[], cols: number): Line[] {
  const out: Line[] = [[seg(`${title} · run ${r.id.slice(0, 8)}`, 'bold')], [seg('  ', ''), seg(runWord(r), tone(r)), seg(` · ${when(r.startedAt ?? r.queuedAt)}${r.endedAt && r.startedAt ? ` · ${Math.round((r.endedAt - r.startedAt) / 1000)} s` : ''} · ${r.tokensIn + r.tokensOut} tokens · ${r.toolCalls} tool calls`, 'muted')]]
  if (r.mail) {
    out.push([seg(`  started by ${r.mail.mails.length} new ${r.mail.mails.length === 1 ? 'mail' : 'mails'}`, 'muted')])
    for (const m of r.mail.mails.slice(0, 20)) out.push(clipLine([seg('    '), seg(m.subject || '(no subject)'), seg(` · ${m.from || '(nobody)'} · ${when(m.receivedAt)}`, 'muted')], cols))
    if (r.mail.dropped) out.push([seg(`    ${r.mail.dropped} older dropped while waiting`, 'muted')])
  }
  if (r.reportReason) out.push(...wrap([seg(r.reportReason)], cols, [seg(`  ${r.reported ? 'reported: ' : 'quiet: '}`, 'muted')]))
  out.push(...askLines(r, cols))
  if (r.summary) out.push([seg('  report', 'muted')], ...r.summary.split('\n').flatMap((l) => wrap([seg(l)], cols, [seg('    ')])))
  out.push([seg('  transcript', 'muted')])
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m.role === 'assistant') {
      if (m.content.trim()) out.push(...m.content.trim().split('\n').slice(0, 12).flatMap((l) => wrap([seg(l)], cols, [seg('    ')])))
      ;(m.toolCalls ?? []).forEach((c, k) => {
        const res = messages[i + 1 + k]?.role === 'tool' ? messages[i + 1 + k] : undefined
        const kind = callVerdictKind(res?.checked)
        out.push(clipLine([seg(`    ${res ? (/^\{"error"/.test(res.content) ? '✕' : '✓') : '◌'} ${c.name}`), seg(kind ? ` · ${VERDICT_WORD[kind]}` : res ? '' : ' · waiting', kind === 'blocked' ? 'red' : kind === 'approved' ? 'cyan' : 'muted')], cols))
      })
    }
  }
  return [...out, []]
}

/**
 * A background task's report in a thread: marked as such, never as the agent's own answer. A run of
 * a task that continues the thread has its header; its quiet runs are one muted line.
 */
export function reportLines(content: string, cols: number, meta?: MessageMeta): Line[] {
  if (meta?.kind === 'taskQuiet') return [[seg(`· ${content}`, 'muted')]]
  const head: Line = meta?.kind === 'taskRun' ? [seg(`▍ Task: ${meta.title}`, 'cyan'), seg(` · run #${meta.number ?? '?'} · /tasks log ${meta.run.slice(0, 8)}`, 'muted')] : [seg('▍ Task report', 'cyan'), seg(' · from a background task', 'muted')]
  const body = meta?.kind === 'taskRun' ? content.replace(/^Task “[^”]*”, run #[^\n]*\n\n/, '') : content
  return [head, ...body.split('\n').flatMap((l) => wrap([seg(l)], cols, [seg('▍ ', 'cyan')]))]
}

/** Finds one item by id or a unique id prefix (at least 4 characters). */
function byPrefix<T extends { id: string }>(items: T[], ref: string, what: string): T {
  const hits = items.filter((x) => x.id === ref || (ref.length >= 4 && x.id.startsWith(ref)))
  if (hits.length !== 1) throw new Error(hits.length ? `More than one ${what} starts with ${ref}: give more of its id` : `No ${what} ${ref}`)
  return hits[0]
}

/** Runs /tasks with its arguments; answers the lines to show. */
export async function tasksCommand(arg: string, cols: number): Promise<Line[]> {
  const [sub = '', ref = '', extra = ''] = arg.trim().split(/\s+/)
  const { tasks, enabled } = await listTasks()
  if (!sub || sub === 'list') return taskListLines(tasks, enabled, cols)
  const say = (text: string, c = 'muted'): Line[] => [[seg(`  ${text}`, c)], []]
  const allRuns = async () => (await Promise.all(tasks.map((t) => listRuns(t.id).then((r) => r.runs.map((x) => ({ ...x, title: t.title }))))) ).flat()
  if (['show', 'runs', 'run', 'dry', 'pause', 'resume'].includes(sub)) {
    if (!ref) return say(`Which task? ${TASKS_HELP}`, 'yellow')
    const t = byPrefix(tasks, ref, 'task')
    if (sub === 'show') return taskLines(t, (await listRuns(t.id)).runs.slice(0, 8), cols)
    if (sub === 'runs') return [[seg(`${t.title}: runs`, 'bold')], ...runLines((await listRuns(t.id)).runs, t.timezone, cols), []]
    if (sub === 'run' || sub === 'dry') {
      const r = await runTask(t.id, sub === 'dry')
      return say(`${sub === 'dry' ? 'Dry run' : 'Run'} ${r.id.slice(0, 8)} of “${t.title}” is queued. /tasks log ${r.id.slice(0, 8)} shows it.`, 'green')
    }
    await updateTask(t.id, { status: sub === 'pause' ? 'paused' : 'active' })
    return say(`“${t.title}” is ${sub === 'pause' ? 'paused' : 'active again'}.`, 'green')
  }
  if (['log', 'approve', 'deny', 'cancel'].includes(sub)) {
    if (!ref) return say(`Which run? ${TASKS_HELP}`, 'yellow')
    const run = byPrefix(await allRuns(), ref, 'run')
    if (sub === 'cancel') return (await cancelRun(run.id), say(`Run ${run.id.slice(0, 8)} is cancelled.`, 'green'))
    if (sub === 'approve' || sub === 'deny') {
      const { run: now, task } = await getRun(run.id)
      if (!now.asks.length) return say('It is not waiting for anything.', 'yellow')
      // Never picked for you: without the call's number, it shows what waits, in full, and how to answer.
      const index = /^\d+$/.test(extra) ? Number(extra) : NaN
      if (!now.asks.some((a) => a.index === index)) return [[seg(`${task.title} · run ${now.id.slice(0, 8)} waits for:`, 'bold')], ...askLines(now, cols), [seg('  Name the call to answer it; nothing was approved or denied.', 'yellow')], []]
      await approveRun(run.id, index, sub === 'approve')
      return say(sub === 'approve' ? 'Allowed: the run goes on once nothing else waits.' : 'Denied: the run goes on without it.', 'green')
    }
    const { run: detail, task } = await getRun(run.id)
    const messages = detail.threadId ? (await getThread(detail.threadId)).messages : []
    return runDetailLines(detail, task.title, messages, cols)
  }
  return say(TASKS_HELP, 'yellow')
}
