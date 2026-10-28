import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import './AgentsTasks.css'
import { Icon } from './agentsSidebar/bits'
import { MarkdownPreview } from './Zed'
import { Select } from '../os/Select'
import { ask, tell } from '../os/Dialogs'
import { hasCalendar, useAccount } from '../os/account'
import { agentModels, followThread, getThread, listThreads, type AgentMessage, type Thread, type TurnEvent } from '../data/agents'
import { approveRun, cancelRun, continueRun, createTask, deleteTask, getRun, getTask, listRuns, listTasks, runTask, taskOptions, updateTask, useTasksChanged, type TaskOptionsInfo, type TasksChange } from '../data/agentTasks'
import {
  askArgLines,
  callVerdictKind,
  CALL_VERDICTS,
  DEFAULT_CAPS,
  DEFAULT_EXPIRY_MS,
  DEFAULT_OPTIONS,
  DEFAULT_REPORT,
  defaultPolicy,
  policySummary,
  RETENTION,
  RUN_STATUS_LABEL,
  TASK_GROUPS,
  TASK_TOOLS,
  toolVerdict,
  type CallVerdictKind,
  type RunStatus,
  type Task,
  type TaskGroup,
  type TaskPolicy,
  type TaskRunInfo,
  type TaskSpec,
  type Verdict,
} from '../data/agentTaskPolicy'
import { describeSchedule, upcoming, type Schedule } from '../data/agentTaskSchedule'
import { blankMailTrigger, describeMailTrigger, MAX_PER_HOUR, MAX_WINDOW_MS, NEVER_ROLES, type MailTrigger, type RunMail } from '../data/agentTaskMail'
import { bootstrap, openMail, type Mailbox } from '../data/mail'

// The Agents app's Tasks tab: background tasks (server/agentTasks.ts) that run an agent once or on a
// schedule and report back. The list (needing you, running, scheduled, one-off, paused, done), a
// task (what it does, its policy in plain words, its state note, its runs), a run (what happened:
// every tool call with how it was decided, the report, live while it runs, with its questions to
// answer), and the editor, which the approval card of the agent's create_task uses too.

export type TasksFocus = { task?: string; run?: string }

const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone
const when = (ms: number | null | undefined, zone = ZONE) => (ms ? new Date(ms).toLocaleString('en-GB', { timeZone: zone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—')
const took = (ms: number) => (ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`)
const tokens = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : String(n))
const STATUS_TONE: Record<RunStatus, string> = { queued: 'is-busy', running: 'is-busy', waiting: 'is-ask', succeeded: 'is-ok', failed: 'is-bad', cancelled: 'is-off', denied: 'is-ask', interrupted: 'is-off' }

function RunChip({ run }: { run: TaskRunInfo }) {
  return (
    <span className={`agt-tk-chip ${STATUS_TONE[run.status]}`} title={run.reportReason ?? undefined}>
      {RUN_STATUS_LABEL[run.status]}
      {run.status === 'succeeded' ? (run.reported ? ' · reported' : ' · quiet') : ''}
      {run.dry ? ' · dry run' : ''}
    </span>
  )
}

/** The Tasks tab: the list, a task, a run, or the editor, one at a time (a stack, like on a phone). */
export function TasksView({ focus, onBack, onOpenThread }: { focus: TasksFocus | null; onBack: () => void; onOpenThread: (id: string) => void }) {
  const [tasks, setTasks] = useState<Task[] | null>(null)
  const [enabled, setEnabled] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [task, setTask] = useState<string | null>(focus?.task ?? null)
  const [run, setRun] = useState<string | null>(focus?.run ?? null)
  const [editing, setEditing] = useState<Task | 'new' | null>(null)
  const [version, setVersion] = useState(0)
  useEffect(() => {
    if (!focus) return
    setTask(focus.task ?? null)
    setRun(focus.run ?? null)
    setEditing(null)
  }, [focus])
  const load = useCallback(() => {
    listTasks().then(
      (r) => (setTasks(r.tasks), setEnabled(r.enabled), setError(null)),
      (e: Error) => setError(e.message),
    )
  }, [])
  useEffect(load, [load])
  useTasksChanged(useCallback((_c: TasksChange) => (load(), setVersion((v) => v + 1)), [load]))
  const options = useTaskOptions()

  if (editing)
    return (
      <TaskEditorPane
        initial={editing === 'new' ? null : editing}
        options={options}
        onCancel={() => setEditing(null)}
        onSaved={(t) => (setEditing(null), setTask(t.id), load())}
      />
    )
  if (run) return <RunView id={run} version={version} onBack={() => setRun(null)} onOpenThread={onOpenThread} onTask={(id) => (setRun(null), setTask(id))} />
  if (task) return <TaskView id={task} version={version} onBack={() => setTask(null)} onRun={setRun} onEdit={(t) => setEditing(t)} onDeleted={() => (setTask(null), load())} />

  const list = tasks ?? []
  const waiting = list.filter((t) => t.lastRun?.status === 'waiting')
  const busy = list.filter((t) => t.active > 0 && t.lastRun?.status !== 'waiting')
  const rest = list.filter((t) => !waiting.includes(t) && !busy.includes(t))
  const groups: { title: string; items: Task[] }[] = [
    { title: 'Needs you', items: waiting },
    { title: 'Running', items: busy },
    { title: 'On new mail', items: rest.filter((t) => t.status === 'active' && t.schedule.kind === 'mail') },
    { title: 'Scheduled', items: rest.filter((t) => t.status === 'active' && t.schedule.kind !== 'once' && t.schedule.kind !== 'mail') },
    { title: 'One-off', items: rest.filter((t) => t.status === 'active' && t.schedule.kind === 'once') },
    { title: 'Paused', items: rest.filter((t) => t.status === 'paused') },
    { title: 'Completed', items: rest.filter((t) => t.status === 'completed' || t.status === 'expired') },
  ]
  return (
    <>
      <div className="nb-toolbar agt-toolbar">
        <button className="btn btn-small agt-back" onClick={onBack} aria-label="Back to threads">
          ‹
        </button>
        <span className="agt-title">Tasks</span>
        <span className="nb-spacer" />
        <button className="btn btn-small btn-primary" onClick={() => setEditing('new')}>
          <Icon name="plus" size={13} /> New task
        </button>
      </div>
      <div className="agt-scroll agt-tk">
        {!enabled && <p className="agt-tk-banner">Tasks are switched off on this server (AGENT_TASKS): they are kept, but nothing runs until they are switched on.</p>}
        {tasks && !list.length && (
          <div className="agt-tk-empty">
            <p>Tasks run an agent in the background, once, on a schedule or when new mail arrives, and tell you what it found: “every weekday at 8, check my calendar and mail and give me a summary”, “tell me when a new release of X is out”, “when a receipt arrives, file it”.</p>
            <p className="muted">Make one here, or ask an agent in a thread to make one for you: it always asks you first.</p>
          </div>
        )}
        {groups
          .filter((g) => g.items.length)
          .map((g) => (
            <section key={g.title} className="agt-tk-group">
              <h4>
                {g.title} <span className="muted">{g.items.length}</span>
              </h4>
              <ul className="agt-tk-list">
                {g.items.map((t) => (
                  <TaskRow key={t.id} task={t} onOpen={() => (t.lastRun?.status === 'waiting' ? setRun(t.lastRun.id) : setTask(t.id))} onChanged={load} enabled={enabled} />
                ))}
              </ul>
            </section>
          ))}
        {error && <p className="t-red copyable">{error}</p>}
      </div>
    </>
  )
}

function useTaskOptions(): TaskOptionsInfo | null {
  const [o, setO] = useState<TaskOptionsInfo | null>(null)
  useEffect(() => void taskOptions().then(setO, () => {}), [])
  return o
}

function TaskRow({ task: t, onOpen, onChanged, enabled }: { task: Task; onOpen: () => void; onChanged: () => void; enabled: boolean }) {
  const act = (p: Promise<unknown>) => void p.then(onChanged, (e: Error) => void tell({ title: 'That did not work', body: e.message }))
  return (
    <li className="agt-tk-row">
      <button className="agt-tk-main" onClick={onOpen}>
        <strong>{t.title}</strong>
        <span className="muted">
          {describeSchedule(t.schedule, t.timezone)}
          {t.status === 'active' && t.nextRunAt ? ` · next ${when(t.nextRunAt, t.timezone)}` : t.status === 'expired' ? ' · expired' : ''}
          {t.status === 'active' && t.mailPending > 0 ? ` · ${t.mailPending} new ${t.mailPending === 1 ? 'mail' : 'mails'} waiting` : ''}
        </span>
        {t.lastRun && (
          <span className="agt-tk-last">
            <RunChip run={t.lastRun} /> <span className="muted">{when(t.lastRun.endedAt ?? t.lastRun.startedAt ?? t.lastRun.queuedAt, t.timezone)}</span>
          </span>
        )}
      </button>
      <span className="agt-tk-actions">
        {t.status === 'active' || t.status === 'paused' ? (
          <button className="btn btn-small" disabled={!enabled || t.active > 0} onClick={() => act(runTask(t.id))} title="Run it now">
            Run now
          </button>
        ) : null}
        {t.status === 'active' && (
          <button className="btn btn-small" onClick={() => act(updateTask(t.id, { status: 'paused' }))}>
            Pause
          </button>
        )}
        {t.status !== 'active' && (
          <button className="btn btn-small" onClick={() => act(updateTask(t.id, { status: 'active' }))} title={t.status === 'paused' ? 'Go on with the schedule' : 'Start it again (an expired task gets six more months)'}>
            {t.status === 'paused' ? 'Resume' : 'Renew'}
          </button>
        )}
      </span>
    </li>
  )
}

// --- a task ---------------------------------------------------------------------------------------

const REPORT_WHEN = { always: 'Every run', failure: 'Only when something fails or needs you', condition: 'When the condition is met' } as const

function TaskView({ id, version, onBack, onRun, onEdit, onDeleted }: { id: string; version: number; onBack: () => void; onRun: (id: string) => void; onEdit: (t: Task) => void; onDeleted: () => void }) {
  const [task, setTask] = useState<Task | null>(null)
  const [runs, setRuns] = useState<TaskRunInfo[]>([])
  const [more, setMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  useEffect(() => {
    getTask(id).then(setTask, (e: Error) => setError(e.message))
    listRuns(id).then((r) => (setRuns(r.runs), setMore(r.more)), () => {})
  }, [id, version])
  const act = (p: Promise<unknown>) =>
    void p.then(
      () => (getTask(id).then(setTask, () => {}), listRuns(id).then((r) => (setRuns(r.runs), setMore(r.more)), () => {})),
      (e: Error) => setError(e.message),
    )
  if (!task)
    return (
      <>
        <div className="nb-toolbar agt-toolbar">
          <button className="btn btn-small" onClick={onBack} aria-label="Back to the tasks">
            ‹ Tasks
          </button>
        </div>
        <div className="agt-scroll agt-tk">{error ? <p className="t-red">{error}</p> : <p className="muted">Loading…</p>}</div>
      </>
    )
  const remove = async () => {
    if (!(await ask({ title: `Delete “${task.title}”?`, body: 'The task and all its runs are gone for good. Pause it instead to keep its history.', confirm: 'Delete', danger: true }))) return
    deleteTask(task.id).then(onDeleted, (e: Error) => setError(e.message))
  }
  const to = [task.report.thread === 'new' ? 'a new thread each run' : task.report.thread === 'fixed' ? 'a thread' : '', task.report.notify ? 'a notification' : '', task.report.email === 'always' ? 'email to you' : task.report.email === 'unseen' ? 'email when the notification is not read in time' : ''].filter(Boolean)
  return (
    <>
      <div className="nb-toolbar agt-toolbar">
        <button className="btn btn-small" onClick={onBack} aria-label="Back to the tasks">
          ‹ Tasks
        </button>
        <span className="agt-title">{task.title}</span>
        <span className="nb-spacer" />
        <span className="agt-tk-actions">
          {(task.status === 'active' || task.status === 'paused') && (
            <>
              <button className="btn btn-small btn-primary" disabled={task.active > 0} onClick={() => act(runTask(task.id))}>
                Run now
              </button>
              <button className="btn btn-small" disabled={task.active > 0} onClick={() => act(runTask(task.id, true))} title="One run where every change asks you first">
                Dry run
              </button>
            </>
          )}
          {task.status === 'active' ? (
            <button className="btn btn-small" onClick={() => act(updateTask(task.id, { status: 'paused' }))}>
              Pause
            </button>
          ) : (
            <button className="btn btn-small" onClick={() => act(updateTask(task.id, { status: 'active' }))}>
              {task.status === 'paused' ? 'Resume' : 'Renew'}
            </button>
          )}
          <button className="btn btn-small" onClick={() => onEdit(task)}>
            Edit
          </button>
          <button className="btn btn-small" onClick={() => void remove()} aria-label="Delete the task" title="Delete">
            <Icon name="trash" size={13} />
          </button>
        </span>
      </div>
      <div className="agt-scroll agt-tk">
        <dl className="agt-tk-facts">
          <Fact label="Status">{task.status === 'active' ? 'Active' : task.status === 'paused' ? 'Paused' : task.status === 'expired' ? 'Expired' : 'Completed'}</Fact>
          <Fact label="Runs">
            {describeSchedule(task.schedule, task.timezone)} {task.schedule.kind !== 'mail' && <span className="muted">({task.timezone})</span>}
          </Fact>
          {task.status === 'active' && task.schedule.kind !== 'mail' && <Fact label="Next run">{when(task.nextRunAt, task.timezone)}</Fact>}
          {task.status === 'active' && task.schedule.kind === 'mail' && <Fact label="Waiting">{task.mailPending ? `${task.mailPending} new ${task.mailPending === 1 ? 'mail' : 'mails'} for the next run` : 'No new mail yet'}</Fact>}
          <Fact label="Tells you">{task.condition ? `When: ${task.condition}` : REPORT_WHEN[task.report.when]}</Fact>
          {task.doneWhen && <Fact label="Done when">{task.doneWhen}</Fact>}
          <Fact label="Reports to">{to.join(', ') || 'only the run history'}</Fact>
          <Fact label="Model">{task.model ?? 'The task model from Settings'}</Fact>
          <Fact label="Ends">{task.expiresAt ? when(task.expiresAt, task.timezone) : 'Never'}</Fact>
          {task.failures > 0 && <Fact label="Failures">{task.failures} in a row</Fact>}
        </dl>
        <h4 className="agt-tk-sub">What it does</h4>
        <pre className="agt-tk-instruction">{task.instruction}</pre>
        <h4 className="agt-tk-sub">What it may do</h4>
        <PolicySummary policy={task.policy} />
        <h4 className="agt-tk-sub">State note</h4>
        <p className="muted agt-tk-help">What the agent noted for its next run (it reads it at the start, and writes a new one at the end). Data, not instructions; you can change or clear it.</p>
        <textarea className="agt-tk-note" value={note ?? task.stateNote} onChange={(e) => setNote(e.target.value)} maxLength={2000} rows={4} placeholder="Nothing noted yet" aria-label="State note" />
        {note !== null && note !== task.stateNote && (
          <div className="agt-tk-row-actions">
            <button className="btn btn-small btn-primary" onClick={() => act(updateTask(task.id, { stateNote: note }).then(() => setNote(null)))}>
              Save note
            </button>
            <button className="btn btn-small" onClick={() => setNote(null)}>
              Undo
            </button>
          </div>
        )}
        <h4 className="agt-tk-sub">Runs</h4>
        {!runs.length && <p className="muted">No runs yet.</p>}
        <ul className="agt-tk-runs">
          {runs.map((r) => (
            <li key={r.id}>
              <button className="agt-tk-run" onClick={() => onRun(r.id)}>
                <RunChip run={r} />
                <span>{when(r.startedAt ?? r.queuedAt, task.timezone)}</span>
                <span className="muted">{r.endedAt && r.startedAt ? took(r.endedAt - r.startedAt) : r.status === 'running' ? 'running…' : ''}</span>
                <span className="muted agt-tk-reason">{r.mail ? `${mailCount(r.mail)} · ` : ''}{r.reportReason ?? r.error ?? ''}</span>
              </button>
            </li>
          ))}
        </ul>
        {more && (
          <button className="btn btn-small" onClick={() => listRuns(task.id, runs[runs.length - 1]?.queuedAt).then((r) => (setRuns((x) => [...x, ...r.runs]), setMore(r.more)), () => {})}>
            Older runs
          </button>
        )}
        {error && <p className="t-red copyable">{error}</p>}
      </div>
    </>
  )
}

const mailCount = (m: RunMail | null) => (m ? `${m.mails.length} ${m.mails.length === 1 ? 'mail' : 'mails'}` : 'mail')

/** The mail that started a run: sender and subject, each opening the message in Mail. */
function RunMailList({ mail, zone }: { mail: RunMail; zone: string }) {
  return (
    <section aria-label="The mail that started this run">
      <h4 className="agt-tk-sub">Mail that started it</h4>
      <ul className="agt-tk-mails">
        {mail.mails.map((m) => (
          <li key={`${m.account}.${m.id}`}>
            <button type="button" className="agt-tk-mail" onClick={() => openMail(m.id, { account: m.account })} title="Open in Mail">
              <strong>{m.subject || '(no subject)'}</strong>
              <span className="muted">
                {m.from || '(nobody)'} · {when(m.receivedAt, zone)} · {m.mailbox}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {mail.dropped > 0 && <p className="muted agt-tk-help">{mail.dropped} older {mail.dropped === 1 ? 'mail was' : 'mails were'} dropped while waiting (more than 200, or older than a week).</p>}
    </section>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

function PolicySummary({ policy }: { policy: TaskPolicy }) {
  const s = policySummary(policy)
  return (
    <div className="agt-tk-summary">
      {s.lines.map((l, i) => (
        <p key={i}>{l}</p>
      ))}
      {s.warnings.map((w, i) => (
        <p key={`w${i}`} className="agt-tk-warn" role="note">
          {w}
        </p>
      ))}
    </div>
  )
}

// --- a run ----------------------------------------------------------------------------------------

const VERDICT_LABEL: Record<CallVerdictKind, string> = { allowed: 'Allowed by policy', approved: 'Approved by you', denied: 'Denied', expired: 'Denied (no answer)', blocked: 'Blocked by policy' }

function RunView({ id, version, onBack, onOpenThread, onTask }: { id: string; version: number; onBack: () => void; onOpenThread: (id: string) => void; onTask: (id: string) => void }) {
  const [data, setData] = useState<{ run: TaskRunInfo; task: Task } | null>(null)
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [live, setLive] = useState<{ content: string; thinking: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(() => getRun(id).then(setData, (e: Error) => setError(e.message)), [id])
  useEffect(() => void load(), [load, version])
  const run = data?.run
  const thread = run?.threadId ?? null
  const going = run?.status === 'running'
  // Read again whenever the run moves on (an answer, the end), not only while it is followed.
  const stage = `${run?.status}:${run?.toolCalls}:${run?.endedAt}`
  // The transcript: read once, and followed live while the run goes.
  useEffect(() => {
    if (!thread) return
    const ctl = new AbortController()
    if (going)
      void followThread(
        thread,
        (e: TurnEvent) => {
          if (e.type === 'snapshot') (setMessages(e.messages), setLive(e.live))
          else if (e.type === 'message') (setMessages((m) => [...m.filter((x) => x.id !== e.message.id), e.message]), e.message.role === 'assistant' && setLive({ content: '', thinking: '' }))
          else if (e.type === 'delta') setLive((l) => ({ content: (l?.content ?? '') + (e.content ?? ''), thinking: (l?.thinking ?? '') + (e.thinking ?? '') }))
        },
        ctl.signal,
      )
        .catch(() => {})
        .finally(() => !ctl.signal.aborted && (setLive(null), void load()))
    else getThread(thread).then((r) => setMessages(r.messages), () => {})
    return () => ctl.abort()
  }, [thread, going, load, stage])
  if (!data || !run)
    return (
      <>
        <div className="nb-toolbar agt-toolbar">
          <button className="btn btn-small" onClick={onBack}>
            ‹ Back
          </button>
        </div>
        <div className="agt-scroll agt-tk">{error ? <p className="t-red">{error}</p> : <p className="muted">Loading…</p>}</div>
      </>
    )
  const { task } = data
  const active = run.status === 'running' || run.status === 'queued' || run.status === 'waiting'
  const act = (p: Promise<unknown>) => {
    setBusy(true)
    void p.then(load, (e: Error) => setError(e.message)).finally(() => setBusy(false))
  }
  const cont = () => {
    setBusy(true)
    continueRun(run.id).then(
      (r) => onOpenThread(r.thread.id),
      (e: Error) => (setError(e.message), setBusy(false)),
    )
  }
  return (
    <>
      <div className="nb-toolbar agt-toolbar">
        <button className="btn btn-small" onClick={onBack} aria-label="Back">
          ‹ Back
        </button>
        <span className="agt-title">
          {task.title} <span className="muted">· {when(run.startedAt ?? run.queuedAt, task.timezone)}</span>
        </span>
        <span className="nb-spacer" />
        <span className="agt-tk-actions">
          {active && (
            <button className="btn btn-small" disabled={busy} onClick={() => act(cancelRun(run.id))}>
              Cancel run
            </button>
          )}
          {!active && thread && (
            <button className="btn btn-small btn-primary" disabled={busy} onClick={cont} title="Open this run as a normal thread to follow up (the run stays as it was)">
              Continue in thread
            </button>
          )}
          <button className="btn btn-small" onClick={() => onTask(task.id)}>
            Task
          </button>
        </span>
      </div>
      <div className="agt-scroll agt-tk">
        <dl className="agt-tk-facts">
          <Fact label="Status">
            <RunChip run={run} />
          </Fact>
          <Fact label="Started">{when(run.startedAt ?? run.queuedAt, task.timezone)}</Fact>
          {run.endedAt && <Fact label="Ended">{when(run.endedAt, task.timezone)}</Fact>}
          {run.endedAt && run.startedAt && <Fact label="Took">{took(run.endedAt - run.startedAt)}</Fact>}
          <Fact label="Tokens">
            {tokens(run.tokensIn)} in · {tokens(run.tokensOut)} out
          </Fact>
          <Fact label="Tool calls">{run.toolCalls}</Fact>
          <Fact label="Started by">{run.trigger === 'schedule' ? 'The schedule' : run.trigger === 'mail' ? `New mail (${mailCount(run.mail)})` : run.trigger === 'catchup' ? 'Catching up after downtime' : run.trigger === 'retry' ? 'A retry after a restart' : run.dry ? 'You (dry run)' : 'You (Run now)'}</Fact>
          <Fact label="Policy">version {run.policyVersion}{run.policyVersion !== task.policyVersion ? ` (now ${task.policyVersion})` : ''}</Fact>
          {run.reportReason && <Fact label={run.reported ? 'Reported' : 'Quiet'}>{run.reportReason}</Fact>}
          {run.delivered.length > 0 && <Fact label="Sent to">{run.delivered.join(', ')}</Fact>}
          {run.error && <Fact label="Error">{run.error}</Fact>}
        </dl>
        {run.mail && <RunMailList mail={run.mail} zone={task.timezone} />}
        {run.asks.length > 0 && (
          <section className="agt-tk-asks" aria-label="Waiting for you">
            <h4 className="agt-tk-sub">Waiting for you{run.deadline ? <span className="muted"> · until {when(run.deadline, task.timezone)}, then denied</span> : null}</h4>
            {run.asks.map((a) => (
              <div key={a.index} className="agt-tool is-asking agt-tk-ask">
                <p className="agt-ask-title">
                  <span className="agt-tool-icon" aria-hidden>
                    ?
                  </span>
                  <span className="agt-tool-label">{a.summary?.title ?? TASK_TOOLS[a.name]?.label ?? a.name}</span>
                </p>
                {a.summary && (
                  <dl className="agt-answers agt-ask-summary">
                    {a.summary.rows.map(([k, v], i) => (
                      <div key={i}>
                        <dt>{k}</dt>
                        <dd>{v}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                {a.summary?.body !== undefined && <pre className="agt-tool-body agt-ask-mail">{a.summary.body || '(no text)'}</pre>}
                {/* The call itself: where it goes (path, address, recipients) first, long text last. */}
                <dl className="agt-answers agt-ask-summary agt-tk-args">
                  {askArgLines(a.arguments).map(([k, v]) => (
                    <div key={k}>
                      <dt>{k}</dt>
                      <dd>{v.length > 300 || v.includes('\n') ? <pre className="agt-tool-body">{v}</pre> : v}</dd>
                    </div>
                  ))}
                </dl>
                <p className="muted agt-ask-why">{a.reason}</p>
                <div className="agt-ask-actions">
                  <button className="btn btn-small btn-primary" disabled={busy} onClick={() => act(approveRun(run.id, a.index, true))}>
                    Allow
                  </button>
                  <button className="btn btn-small" disabled={busy} onClick={() => act(approveRun(run.id, a.index, false))}>
                    Deny
                  </button>
                </div>
              </div>
            ))}
          </section>
        )}
        {(run.summary || run.verdict) && (
          <>
            <h4 className="agt-tk-sub">Report</h4>
            <article className="zed-preview agt-answer agt-tk-report">
              <MarkdownPreview text={run.summary || run.verdict?.summary || ''} />
            </article>
          </>
        )}
        <h4 className="agt-tk-sub">Transcript</h4>
        <Transcript messages={messages} live={live} />
        {error && <p className="t-red copyable">{error}</p>}
      </div>
    </>
  )
}

/** The run's messages: the instruction, the agent's words, and each tool call with how it was decided and what came back. */
function Transcript({ messages, live }: { messages: AgentMessage[]; live: { content: string; thinking: string } | null }) {
  const out: ReactNode[] = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m.role === 'user')
      out.push(
        <div key={m.id} className="agt-tk-msg is-user">
          <span className="muted">Instruction</span>
          <pre>{m.content}</pre>
        </div>,
      )
    else if (m.role === 'assistant') {
      const results: AgentMessage[] = []
      let j = i + 1
      while (j < messages.length && messages[j].role === 'tool') results.push(messages[j++])
      out.push(
        <div key={m.id} className="agt-tk-msg">
          {m.thinking && (
            <details className="agt-tk-thinking">
              <summary className="muted">Thinking</summary>
              <pre>{m.thinking}</pre>
            </details>
          )}
          {m.content.trim() && (
            <article className="zed-preview agt-answer">
              <MarkdownPreview text={m.content} />
            </article>
          )}
          {(m.toolCalls ?? []).map((c, k) => {
            const r = results[k]
            const kind = callVerdictKind(r?.checked)
            let failed = false
            try {
              failed = !!r && 'error' in (JSON.parse(r.content) as object)
            } catch {
              /* text */
            }
            return (
              <details key={k} className={`agt-tool ${failed ? 'is-failed' : ''}`}>
                <summary>
                  <span className="agt-tool-icon" aria-hidden>
                    {!r ? '◌' : failed ? '✕' : '✓'}
                  </span>
                  <span className="agt-tool-label">{c.name === 'task_report' ? 'Report' : (TASK_TOOLS[c.name]?.label.replace(/ \(.*\)$/, '') ?? c.name)}</span>
                  {kind && <span className={`agt-tk-verdict is-${kind}`}>{VERDICT_LABEL[kind]}</span>}
                  {!r && <span className="muted"> · waiting</span>}
                </summary>
                <pre className="agt-tool-body">{[`${c.name}(${JSON.stringify(c.arguments, null, 2)})`, r ? r.content.slice(0, 6000) : 'No result yet', r?.checked && !kind ? r.checked : r?.checked && r.checked !== CALL_VERDICTS[kind!] ? r.checked : ''].filter(Boolean).join('\n\n')}</pre>
              </details>
            )
          })}
        </div>,
      )
      i = j - 1
    }
  }
  if (live && (live.content || live.thinking))
    out.push(
      <div key="live" className="agt-tk-msg is-live">
        {live.thinking && <pre className="muted agt-tk-live-thinking">{live.thinking.slice(-600)}</pre>}
        {live.content && (
          <article className="zed-preview agt-answer">
            <MarkdownPreview text={live.content} />
          </article>
        )}
      </div>,
    )
  if (!out.length) return <p className="muted">Nothing yet.</p>
  return <div className="agt-tk-transcript">{out}</div>
}

// --- the editor -----------------------------------------------------------------------------------

/** A task to start from: a new one, with Settings' defaults. */
export function blankSpec(options: TaskOptionsInfo | null): TaskSpec {
  return {
    title: '',
    instruction: '',
    condition: '',
    doneWhen: '',
    schedule: { kind: 'daily', time: '08:00' },
    timezone: ZONE,
    policy: defaultPolicy(),
    report: { ...DEFAULT_REPORT, ...(options?.defaults.report ?? {}), threadId: null },
    caps: { ...DEFAULT_CAPS },
    model: null,
    options: { ...DEFAULT_OPTIONS },
    expiresAt: Date.now() + DEFAULT_EXPIRY_MS,
  }
}

function TaskEditorPane({ initial, options, onCancel, onSaved }: { initial: Task | null; options: TaskOptionsInfo | null; onCancel: () => void; onSaved: (t: Task) => void }) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const save = (spec: TaskSpec) => {
    setBusy(true)
    setError(null)
    ;(initial ? updateTask(initial.id, spec) : createTask(spec)).then(onSaved, (e: Error) => (setError(e.message), setBusy(false)))
  }
  return (
    <>
      <div className="nb-toolbar agt-toolbar">
        <button className="btn btn-small" onClick={onCancel}>
          ‹ Cancel
        </button>
        <span className="agt-title">{initial ? `Edit “${initial.title}”` : 'New task'}</span>
      </div>
      <div className="agt-scroll agt-tk">
        <TaskEditor initial={initial ?? blankSpec(options)} options={options} busy={busy} error={error} saveLabel={initial ? 'Save' : 'Make the task'} onSave={save} onCancel={onCancel} />
      </div>
    </>
  )
}

const KIND_LABEL: Record<Exclude<Schedule['kind'], 'mail'> | 'at', string> = { once: 'Once, right away', at: 'Once, at a time', daily: 'Every day', weekdays: 'Every weekday', weekly: 'On some days of the week', cron: 'Cron line' }
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const VERDICT_TEXT: Record<Verdict, string> = { allow: 'Allow', ask: 'Ask', block: 'Block' }
const localInput = (ms: number) => {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

/** The task editor: what it does, when, what it may do, where reports go, its limits. */
export function TaskEditor({ initial, options, busy, error, saveLabel, onSave, onCancel }: { initial: TaskSpec; options: TaskOptionsInfo | null; busy?: boolean; error?: string | null; saveLabel: string; onSave: (spec: TaskSpec) => void; onCancel: () => void }) {
  const [spec, setSpec] = useState<TaskSpec>(() => structuredClone(initial))
  const set = <K extends keyof TaskSpec>(k: K, v: TaskSpec[K]) => setSpec((s) => ({ ...s, [k]: v }))
  const setPolicy = (p: Partial<TaskPolicy>) => setSpec((s) => ({ ...s, policy: { ...s.policy, ...p } }))
  const [threads, setThreads] = useState<Thread[]>([])
  const [models, setModels] = useState<string[]>([])
  useEffect(() => {
    listThreads(false).then(setThreads, () => {})
    agentModels().then((m) => setModels(m.map((x) => x.name)), () => {})
  }, [])
  const kind = spec.schedule.kind === 'once' && spec.schedule.at !== null ? 'at' : spec.schedule.kind
  const pickKind = (k: string) => {
    const time = 'time' in spec.schedule ? spec.schedule.time : '08:00'
    const s: Schedule = k === 'once' ? { kind: 'once', at: null } : k === 'at' ? { kind: 'once', at: Date.now() + 3600_000 } : k === 'weekly' ? { kind: 'weekly', time, days: [1] } : k === 'cron' ? { kind: 'cron', expr: '0 8 * * 1-5' } : { kind: k as 'daily' | 'weekdays', time }
    set('schedule', s)
  }
  // Schedule or new mail: switching back and forth keeps what was picked on each side.
  const other = useRef<Schedule | null>(null)
  const pickWhen = (w: string) => {
    if ((w === 'mail') === (spec.schedule.kind === 'mail')) return
    const back = other.current
    other.current = spec.schedule
    set('schedule', back ?? (w === 'mail' ? blankMailTrigger(mail[0]) : { kind: 'daily', time: '08:00' }))
  }
  const next = useMemo(() => {
    try {
      return { runs: upcoming(spec.schedule, spec.timezone, Date.now(), 3), error: null }
    } catch (e) {
      return { runs: [], error: (e as Error).message }
    }
  }, [spec.schedule, spec.timezone])
  const mail = options?.mail ?? []
  return (
    <form
      className="agt-tk-form"
      onSubmit={(e) => {
        e.preventDefault()
        onSave(spec)
      }}
    >
      <label className="agt-tk-field">
        <span>Title</span>
        <input value={spec.title} onChange={(e) => set('title', e.target.value)} maxLength={120} required placeholder="Morning briefing" />
      </label>
      <label className="agt-tk-field">
        <span>What it does each run</span>
        <textarea value={spec.instruction} onChange={(e) => set('instruction', e.target.value)} rows={5} maxLength={8000} required placeholder="Look at today's calendar and my unread mail, and give me a short summary of what needs me." />
      </label>
      <label className="agt-tk-field">
        <span>Tell me when… <span className="muted">(optional)</span></span>
        <input value={spec.condition} onChange={(e) => set('condition', e.target.value)} maxLength={2000} placeholder="a new release is out" />
      </label>
      <label className="agt-tk-field">
        <span>Done when… <span className="muted">(optional)</span></span>
        <input value={spec.doneWhen} onChange={(e) => set('doneWhen', e.target.value)} maxLength={2000} placeholder="the tickets are on sale" />
      </label>

      <fieldset className="agt-tk-set">
        <legend>When it runs</legend>
        <div className="agt-tk-when" role="radiogroup" aria-label="What starts it">
          {[
            ['schedule', 'On a schedule'],
            ['mail', 'When new mail arrives'],
          ].map(([v, label]) => {
            const on = (v === 'mail') === (spec.schedule.kind === 'mail')
            return (
              <button type="button" key={v} role="radio" aria-checked={on} className={`agt-tk-day ${on ? 'is-on' : ''}`} disabled={v === 'mail' && !mail.length} title={v === 'mail' && !mail.length ? 'Link a mail account first (Settings → Integrations → Mail)' : undefined} onClick={() => pickWhen(v)}>
                {label}
              </button>
            )
          })}
        </div>
        {spec.schedule.kind === 'mail' ? (
          <MailTriggerFields trigger={spec.schedule} accounts={mail} policy={spec.policy} onChange={(t) => set('schedule', t)} />
        ) : (
        <>
        <div className="agt-tk-inline">
          <Select value={kind} onChange={pickKind} aria-label="When it runs" options={(Object.keys(KIND_LABEL) as (keyof typeof KIND_LABEL)[]).map((k) => ({ value: k, label: KIND_LABEL[k] }))} />
          {spec.schedule.kind === 'once' && spec.schedule.at !== null && <input type="datetime-local" value={localInput(spec.schedule.at)} onChange={(e) => e.target.value && set('schedule', { kind: 'once', at: new Date(e.target.value).getTime() })} aria-label="When" />}
          {'time' in spec.schedule && <input type="time" value={spec.schedule.time} onChange={(e) => (spec.schedule.kind === 'daily' || spec.schedule.kind === 'weekdays' || spec.schedule.kind === 'weekly') && set('schedule', { ...spec.schedule, time: e.target.value })} aria-label="At" />}
          {spec.schedule.kind === 'cron' && <input className="agt-tk-cron" value={spec.schedule.expr} onChange={(e) => set('schedule', { kind: 'cron', expr: e.target.value })} aria-label="Cron line" placeholder="minute hour day month weekday" spellCheck={false} />}
        </div>
        {spec.schedule.kind === 'weekly' && (
          <div className="agt-tk-days" role="group" aria-label="Days">
            {DAYS.map((d, i) => {
              const s = spec.schedule as Extract<Schedule, { kind: 'weekly' }>
              const on = s.days.includes(i)
              return (
                <button type="button" key={d} className={`agt-tk-day ${on ? 'is-on' : ''}`} aria-pressed={on} onClick={() => set('schedule', { ...s, days: on ? s.days.filter((x) => x !== i) : [...s.days, i].sort() })}>
                  {d}
                </button>
              )
            })}
          </div>
        )}
        <label className="agt-tk-field">
          <span>Time zone</span>
          <input value={spec.timezone} onChange={(e) => set('timezone', e.target.value)} spellCheck={false} />
        </label>
        <p className="muted agt-tk-help">{next.error ? <span className="t-red">{next.error}</span> : next.runs.length ? `Next: ${next.runs.map((t) => when(t, spec.timezone)).join(' · ')}` : spec.schedule.kind === 'once' && spec.schedule.at === null ? 'Runs as soon as it is saved.' : 'No runs ahead.'}</p>
        </>
        )}
        <div className="agt-tk-grid">
          {spec.schedule.kind !== 'mail' && (
            <>
              <label className="agt-tk-field">
                <span>A run still going when the next is due</span>
                <Select value={spec.options.overlap} onChange={(overlap) => set('options', { ...spec.options, overlap })} options={[{ value: 'skip', label: 'Skip the next one' }, { value: 'queue', label: 'Run it after' }]} />
              </label>
              <label className="agt-tk-field">
                <span>Missed while the server was down</span>
                <Select value={spec.options.missed} onChange={(missed) => set('options', { ...spec.options, missed })} options={[{ value: 'once', label: 'Catch up once' }, { value: 'skip', label: 'Skip' }]} />
              </label>
            </>
          )}
          <label className="agt-tk-field">
            <span>Ends</span>
            <span className="agt-tk-inline">
              <input type="date" value={spec.expiresAt ? new Date(spec.expiresAt).toISOString().slice(0, 10) : ''} disabled={spec.expiresAt === null} onChange={(e) => e.target.value && set('expiresAt', new Date(`${e.target.value}T23:59:00`).getTime())} aria-label="End date" />
              <label className="agt-tk-check">
                <input type="checkbox" checked={spec.expiresAt === null} onChange={(e) => set('expiresAt', e.target.checked ? null : Date.now() + DEFAULT_EXPIRY_MS)} /> Never
              </label>
            </span>
          </label>
        </div>
      </fieldset>

      <fieldset className="agt-tk-set">
        <legend>Reports</legend>
        <div className="agt-tk-grid">
          <label className="agt-tk-field">
            <span>Tell me</span>
            <Select value={spec.report.when} onChange={(w) => set('report', { ...spec.report, when: w })} options={[{ value: 'condition', label: REPORT_WHEN.condition }, { value: 'always', label: REPORT_WHEN.always }, { value: 'failure', label: REPORT_WHEN.failure }]} />
          </label>
          <label className="agt-tk-field">
            <span>In a thread</span>
            <Select
              value={spec.report.thread === 'fixed' ? `t:${spec.report.threadId ?? ''}` : spec.report.thread}
              onChange={(v) => set('report', v.startsWith('t:') ? { ...spec.report, thread: 'fixed', threadId: v.slice(2) || null } : { ...spec.report, thread: v as 'none' | 'new', threadId: null })}
              options={[{ value: 'none', label: 'No thread' }, { value: 'new', label: 'A new thread each run' }, ...threads.slice(0, 50).map((t) => ({ value: `t:${t.id}`, label: `Thread: ${t.title}` })), ...(spec.report.thread === 'fixed' && spec.report.threadId && !threads.some((t) => t.id === spec.report.threadId) ? [{ value: `t:${spec.report.threadId}`, label: 'The thread it was made in' }] : [])]}
            />
          </label>
          <label className="agt-tk-check">
            <input type="checkbox" checked={spec.report.notify} onChange={(e) => set('report', { ...spec.report, notify: e.target.checked })} /> Notification
          </label>
          {mail.length > 0 && (
            <label className="agt-tk-field">
              <span>Email to yourself</span>
              <Select value={spec.report.email} onChange={(email) => set('report', { ...spec.report, email, emailAccount: spec.report.emailAccount ?? mail[0].id })} options={[{ value: 'off', label: 'No email' }, { value: 'always', label: 'Always' }, { value: 'unseen', label: 'Only if the notification is not read in 15 min' }]} />
            </label>
          )}
          {mail.length > 1 && spec.report.email !== 'off' && (
            <label className="agt-tk-field">
              <span>From</span>
              <Select value={spec.report.emailAccount ?? mail[0].id} onChange={(emailAccount) => set('report', { ...spec.report, emailAccount })} options={mail.map((a) => ({ value: a.id, label: a.label }))} />
            </label>
          )}
          <label className="agt-tk-field">
            <span>Still watching note</span>
            <Select value={spec.options.heartbeat} onChange={(heartbeat) => set('options', { ...spec.options, heartbeat })} options={[{ value: 'off', label: 'Never' }, { value: 'weekly', label: 'After a quiet week' }, { value: 'monthly', label: 'After a quiet month' }]} />
          </label>
          {spec.doneWhen && (
            <label className="agt-tk-check">
              <input type="checkbox" checked={spec.options.keepWatching} onChange={(e) => set('options', { ...spec.options, keepWatching: e.target.checked })} /> Keep watching once done
            </label>
          )}
        </div>
      </fieldset>

      <fieldset className="agt-tk-set">
        <legend>What it may do</legend>
        <PolicyEditor policy={spec.policy} onChange={setPolicy} mail={mail} />
        <PolicySummary policy={spec.policy} />
      </fieldset>

      <fieldset className="agt-tk-set">
        <legend>Limits per run</legend>
        <div className="agt-tk-grid">
          <label className="agt-tk-field">
            <span>Minutes</span>
            <input type="number" min={1} max={60} value={spec.caps.minutes} onChange={(e) => set('caps', { ...spec.caps, minutes: Number(e.target.value) })} />
          </label>
          <label className="agt-tk-field">
            <span>Tool calls</span>
            <input type="number" min={1} max={200} value={spec.caps.toolCalls} onChange={(e) => set('caps', { ...spec.caps, toolCalls: Number(e.target.value) })} />
          </label>
          <label className="agt-tk-field">
            <span>Tokens</span>
            <input type="number" min={10000} max={2000000} step={10000} value={spec.caps.tokens} onChange={(e) => set('caps', { ...spec.caps, tokens: Number(e.target.value) })} />
          </label>
          <label className="agt-tk-field">
            <span>Model</span>
            <input list="agt-tk-models" value={spec.model ?? ''} onChange={(e) => set('model', e.target.value.trim() || null)} placeholder="The task model from Settings" spellCheck={false} />
            <datalist id="agt-tk-models">
              {models.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </label>
          <label className="agt-tk-field">
            <span>Runs kept</span>
            <Select value={spec.options.keep ?? 0} onChange={(k) => set('options', { ...spec.options, keep: k || null })} options={[{ value: 0, label: `As in Settings (${options?.defaults.keep ?? 100})` }, ...RETENTION.map((n) => ({ value: n, label: `${n} runs` }))]} />
          </label>
        </div>
      </fieldset>
      {error && <p className="t-red copyable">{error}</p>}
      <div className="agt-tk-row-actions agt-tk-save">
        <button className="btn btn-primary" type="submit" disabled={busy || !spec.title.trim() || !spec.instruction.trim()}>
          {saveLabel}
        </button>
        <button className="btn" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}

const listText = (xs: string[]) => xs.join(', ')
const textList = (s: string) => s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean)

/** A mailbox with its parents, "Projects/Receipts". */
function boxPath(boxes: Mailbox[], b: Mailbox): string {
  const parts = [b.name]
  for (let up = boxes.find((x) => x.id === b.parentId), i = 0; up && i < 10; up = boxes.find((x) => x.id === up!.parentId), i++) parts.unshift(up.name)
  return parts.join('/')
}

/** The new-mail trigger: account, mailbox, filters, batching, in plain words, and what never starts it. */
function MailTriggerFields({ trigger: t, accounts, policy, onChange }: { trigger: MailTrigger; accounts: { id: number; label: string }[]; policy: TaskPolicy; onChange: (t: MailTrigger) => void }) {
  const [boxes, setBoxes] = useState<Mailbox[] | null>(null)
  useEffect(() => {
    let live = true
    setBoxes(null)
    bootstrap(t.account).then((b) => live && setBoxes(b.mailboxes), () => live && setBoxes([]))
    return () => void (live = false)
  }, [t.account])
  const pickable = (boxes ?? []).filter((b) => !b.role || !NEVER_ROLES.includes(b.role)).filter((b) => b.role !== 'inbox')
  const set = (p: Partial<MailTrigger>) => onChange({ ...t, ...p })
  const reads = toolVerdict(policy, 'mail_read')
  return (
    <div className="agt-tk-mailtrigger">
      <div className="agt-tk-grid">
        <label className="agt-tk-field">
          <span>Account</span>
          <Select value={t.account} onChange={(account) => set({ account, accountLabel: accounts.find((a) => a.id === account)?.label ?? '', mailbox: null, mailboxName: 'Inbox' })} options={[...accounts.map((a) => ({ value: a.id, label: a.label })), ...(accounts.some((a) => a.id === t.account) ? [] : [{ value: t.account, label: t.accountLabel || 'An account that is gone' }])]} />
        </label>
        <label className="agt-tk-field">
          <span>Mailbox</span>
          <Select
            value={t.mailbox ?? ''}
            onChange={(id) => set({ mailbox: id || null, mailboxName: id ? boxPath(boxes ?? [], (boxes ?? []).find((b) => b.id === id)!) : 'Inbox' })}
            options={[{ value: '', label: 'Inbox' }, ...pickable.map((b) => ({ value: b.id, label: boxPath(boxes ?? [], b) })), ...(t.mailbox && boxes && !pickable.some((b) => b.id === t.mailbox) ? [{ value: t.mailbox, label: t.mailboxName }] : [])]}
          />
        </label>
        <label className="agt-tk-field">
          <span>From <span className="muted">(addresses or @domains, comma-separated; empty: anyone)</span></span>
          <input key={`f${t.account}`} defaultValue={listText(t.from)} onChange={(e) => set({ from: textList(e.target.value).map((x) => x.toLowerCase()) })} placeholder="@steampowered.com, boss@example.org" spellCheck={false} />
        </label>
        <label className="agt-tk-field">
          <span>To or Cc contains <span className="muted">(any of these)</span></span>
          <input defaultValue={listText(t.to)} onChange={(e) => set({ to: textList(e.target.value) })} placeholder="billing@" spellCheck={false} />
        </label>
        <label className="agt-tk-field">
          <span>Subject contains <span className="muted">(any of these, any case)</span></span>
          <input defaultValue={listText(t.subject)} onChange={(e) => set({ subject: textList(e.target.value) })} placeholder="invoice, receipt" />
        </label>
        <label className="agt-tk-field">
          <span>Attachment</span>
          <Select value={t.attachment} onChange={(attachment) => set({ attachment })} options={[{ value: 'any', label: "Doesn't matter" }, { value: 'yes', label: 'Has one' }, { value: 'no', label: 'Has none' }]} />
        </label>
        <label className="agt-tk-field">
          <span>Handle mail together within <span className="muted">(minutes)</span></span>
          <input type="number" min={0} max={MAX_WINDOW_MS / 60_000} step={1} value={Math.round(t.windowMs / 60_000)} onChange={(e) => set({ windowMs: Math.max(0, Math.min(MAX_WINDOW_MS, Number(e.target.value) * 60_000 || 0)) })} />
        </label>
        <label className="agt-tk-field">
          <span>At most, runs an hour</span>
          <input type="number" min={1} max={MAX_PER_HOUR} value={t.maxPerHour} onChange={(e) => set({ maxPerHour: Math.max(1, Math.min(MAX_PER_HOUR, Math.round(Number(e.target.value)) || 1)) })} />
        </label>
      </div>
      <p className="agt-tk-help">{describeMailTrigger(t)}. More mail than that waits for the next run.</p>
      <p className="agt-tk-warn" role="note">
        Mail from outside starts this task and the agent reads it: a mail can try to talk it into something (send, change, delete). Keep changes and sends on Ask unless you trust everyone who can mail you.
      </p>
      <p className="muted agt-tk-help">
        Never a trigger: drafts, mail in Sent, Drafts, Trash or Junk, and mail this task sends itself (its email reports, mail a run sends). {reads === 'block' ? 'Mail reads are blocked below, so a run only sees who wrote and the subject.' : 'A run reads the mail that started it without asking; any other mail it reads follows Mail below.'}
      </p>
    </div>
  )
}

/** Allow, Ask or Block, as three buttons; a cap or an unavailable tool greys what it can't be. */
function Verdicts({ value, onChange, cap, disabled, label, mixed }: { value: Verdict | null; onChange: (v: Verdict) => void; cap?: Verdict; disabled?: string; label: string; mixed?: boolean }) {
  return (
    <span className="agt-tk-verdicts" role="group" aria-label={label} title={disabled}>
      {(['allow', 'ask', 'block'] as Verdict[]).map((v) => {
        const over = cap === 'ask' && v === 'allow'
        return (
          <button type="button" key={v} className={`is-${v} ${value === v ? 'is-on' : ''} ${mixed && value === null ? 'is-mixed' : ''}`} aria-pressed={value === v} disabled={!!disabled || over} title={over ? 'Never runs without asking' : undefined} onClick={() => onChange(v)}>
            {VERDICT_TEXT[v]}
          </button>
        )
      })}
    </span>
  )
}

const HIDDEN_GROUPS = new Set<TaskGroup>(['run'])

function PolicyEditor({ policy, onChange, mail }: { policy: TaskPolicy; onChange: (p: Partial<TaskPolicy>) => void; mail: { id: number; label: string }[] }) {
  const [open, setOpen] = useState<TaskGroup | null>(null)
  const account = useAccount()
  const linked = (g: TaskGroup) => (g === 'mail' ? mail.length > 0 : g === 'calendar' ? hasCalendar(account) : g === 'seafile' || g === 'seafile_write' ? !!account.seafile : true)
  const sites = useRef(policy.sites.join('\n'))
  return (
    <>
      <ul className="agt-tk-policy">
        {TASK_GROUPS.filter((g) => !HIDDEN_GROUPS.has(g.id)).map((g) => {
          const tools = Object.entries(TASK_TOOLS).filter(([, t]) => t.group === g.id)
          const usable = tools.filter(([, t]) => !t.unavailable)
          const verdicts = new Set(usable.map(([n]) => toolVerdict(policy, n)))
          const value = verdicts.size === 1 ? [...verdicts][0] : null
          const setGroup = (v: Verdict) => {
            const t = { ...policy.tools }
            for (const [n] of tools) delete t[n]
            onChange({ groups: { ...policy.groups, [g.id]: v }, tools: t })
          }
          return (
            <li key={g.id} className={!usable.length ? 'is-off' : ''}>
              <div className="agt-tk-prow">
                <button type="button" className="agt-tk-pname" onClick={() => setOpen(open === g.id ? null : g.id)} aria-expanded={open === g.id} disabled={!usable.length}>
                  <span className="agt-chev" aria-hidden>
                    {usable.length ? (open === g.id ? '▾' : '▸') : ''}
                  </span>
                  {g.name}
                  {!usable.length ? <span className="muted"> · not in tasks</span> : !linked(g.id) ? <span className="muted"> · not linked</span> : value === null ? <span className="muted"> · mixed</span> : null}
                </button>
                {usable.length > 0 && <Verdicts value={value} mixed onChange={setGroup} label={`${g.name}: allow, ask or block`} />}
              </div>
              {open === g.id && (
                <ul className="agt-tk-tools">
                  {tools.map(([n, t]) => (
                    <li key={n} className={t.unavailable ? 'is-off' : ''}>
                      <span>
                        {t.label}
                        {t.unavailable && <span className="muted"> · {t.unavailable}</span>}
                        {t.cap === 'ask' && !t.unavailable && <span className="muted"> · always asks at most</span>}
                      </span>
                      <Verdicts value={toolVerdict(policy, n)} cap={t.cap} disabled={t.unavailable} onChange={(v) => onChange({ tools: { ...policy.tools, [n]: v }, seen: [...new Set([...policy.seen, n])] })} label={t.label} />
                    </li>
                  ))}
                </ul>
              )}
            </li>
          )
        })}
      </ul>
      <div className="agt-tk-grid">
        <label className="agt-tk-field agt-tk-wide">
          <span>Web sites it reads without asking <span className="muted">(one per line; * for any)</span></span>
          <textarea
            rows={3}
            defaultValue={sites.current}
            onChange={(e) => onChange({ sites: e.target.value.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean) })}
            placeholder={'github.com\nnews.ycombinator.com'}
            spellCheck={false}
          />
        </label>
        <label className="agt-tk-field">
          <span>Pages on other sites</span>
          <Select value={policy.otherSites} onChange={(otherSites) => onChange({ otherSites })} options={[{ value: 'ask', label: 'Ask me' }, { value: 'block', label: 'Never' }]} />
        </label>
        <label className="agt-tk-check">
          <input type="checkbox" checked={policy.memories} onChange={(e) => onChange({ memories: e.target.checked })} /> It knows what the agent remembers about me
        </label>
      </div>
      <details className="agt-tk-scopes">
        <summary>Folders, calendars and mail</summary>
        <div className="agt-tk-folders">
          <span className="muted">Seafile: only these folders (none: anywhere it may go)</span>
          {policy.seafile.map((f, i) => (
            <div key={i} className="agt-tk-inline">
              <input value={f.library} onChange={(e) => onChange({ seafile: policy.seafile.map((x, j) => (j === i ? { ...x, library: e.target.value } : x)) })} placeholder="Library" aria-label="Library" />
              <input value={f.path} onChange={(e) => onChange({ seafile: policy.seafile.map((x, j) => (j === i ? { ...x, path: e.target.value } : x)) })} placeholder="/folder" aria-label="Folder" />
              <label className="agt-tk-check">
                <input type="checkbox" checked={f.write} onChange={(e) => onChange({ seafile: policy.seafile.map((x, j) => (j === i ? { ...x, write: e.target.checked } : x)) })} /> may change
              </label>
              <button type="button" className="btn btn-small" onClick={() => onChange({ seafile: policy.seafile.filter((_, j) => j !== i) })} aria-label="Remove the folder">
                ×
              </button>
            </div>
          ))}
          <button type="button" className="btn btn-small" onClick={() => onChange({ seafile: [...policy.seafile, { library: '', path: '/', write: false }] })}>
            Add a folder
          </button>
        </div>
        <label className="agt-tk-field">
          <span>Calendar changes only in <span className="muted">(names, comma-separated; empty: any)</span></span>
          <input defaultValue={policy.calendars.join(', ')} onChange={(e) => onChange({ calendars: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} placeholder="Family, Work" />
        </label>
        {mail.length > 0 && (
          <div className="agt-tk-field">
            <span>Mail accounts it may use <span className="muted">(none ticked: any)</span></span>
            <span className="agt-tk-inline">
              {mail.map((a) => (
                <label key={a.id} className="agt-tk-check">
                  <input type="checkbox" checked={policy.mail.accounts.includes(String(a.id))} onChange={(e) => onChange({ mail: { ...policy.mail, accounts: e.target.checked ? [...policy.mail.accounts, String(a.id)] : policy.mail.accounts.filter((x) => x !== String(a.id)) } })} /> {a.label}
                </label>
              ))}
            </span>
          </div>
        )}
        <label className="agt-tk-field">
          <span>Mail it sends goes to</span>
          <Select value={policy.mail.send} onChange={(send) => onChange({ mail: { ...policy.mail, send } })} options={[{ value: 'self', label: 'Only me' }, { value: 'listed', label: 'Me and the people below' }]} />
        </label>
        {policy.mail.send === 'listed' && (
          <label className="agt-tk-field">
            <span>People it may mail</span>
            <input defaultValue={policy.mail.recipients.join(', ')} onChange={(e) => onChange({ mail: { ...policy.mail, recipients: e.target.value.split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean) } })} placeholder="someone@example.org" />
          </label>
        )}
      </details>
    </>
  )
}

/** The editor in a dialog, for the agent's create_task and update_task cards: Allow saves what is shown. */
export function TaskEditDialog({ spec, onDone, onCancel }: { spec: TaskSpec; onDone: (spec: TaskSpec) => void; onCancel: () => void }) {
  const options = useTaskOptions()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])
  return (
    <div className="agt-tk-dialog-back" onClick={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="agt-tk-dialog" role="dialog" aria-modal="true" aria-label="Change the task before allowing it">
        <h3>Change the task, then allow it</h3>
        <TaskEditor initial={spec} options={options} saveLabel="Allow with these changes" onSave={onDone} onCancel={onCancel} />
      </div>
    </div>
  )
}
