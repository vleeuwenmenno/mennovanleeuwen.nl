import { useEffect, useRef, useState, type ReactNode } from 'react'
import './AgentsSubagents.css'
import { MarkdownPreview } from './Zed'
import { Transcript } from './AgentsTasks'
import { ask } from '../os/Dialogs'
import { useIsMobile } from '../os/useIsMobile'
import { branchThread, followThread, getThread, messageSubagent, stopSubagent, type AgentMessage, type MessageMeta, type PendingApproval, type Thread, type ThreadTaskRun, type TurnEvent } from '../data/agents'
import { approveRun, cancelRun, getRun } from '../data/agentTasks'
import { askArgLines, TASK_TOOLS, type TaskRunInfo } from '../data/agentTaskPolicy'
import { overviewLine, shortCount, shortDuration, SUBAGENT_STATUS_LABEL, type SubagentInfo } from '../data/agentSubagents'

// The thread side of subagents and of tasks that continue a thread (server/agents.ts):
//
// - SubagentStrip: the helpers this thread's agent started, above the message box: each with its
//   state and usage; opened, its work live, a box to message it, Stop and Open as thread. Their
//   cards (a change to allow) show here, labelled with their name, and are answered here.
// - TaskRunStrip: runs of tasks that continue this thread, while they go: the live run, its
//   questions to answer, Cancel.
// - TaskRunBlock / TaskQuietLine / SubagentResult / ParentMessage: how those land in the thread.

const STATUS_TONE: Record<SubagentInfo['status'], string> = { running: 'is-busy', idle: 'is-ok', stopped: 'is-off', failed: 'is-bad', interrupted: 'is-off' }

/** A finished subagent's overview in its parent's thread (role 'subagent'): data from another agent, its answer folded. */
export function SubagentResult({ m, actions }: { m: AgentMessage; actions: ReactNode }) {
  const meta = m.meta?.kind === 'subagent' ? m.meta : null
  const answer = m.content.replace(/^Subagent "[^"]*" \(id [0-9a-f]+\): [^\n]*\n\n/, '')
  return (
    <div className="agt-act-host agt-sub-result" data-msg={m.id} role="note" aria-label="A subagent's result">
      <details>
        <summary>
          <span className={`agt-tk-chip ${meta ? STATUS_TONE[meta.status] : ''}`}>{meta ? SUBAGENT_STATUS_LABEL[meta.status] : 'Done'}</span>
          <strong>{meta?.name ?? 'Subagent'}</strong>
          <span className="muted agt-sub-line">{meta ? overviewLine(meta).split(' · ').slice(1).join(' · ') : ''}</span>
        </summary>
        <article className="zed-preview agt-answer">
          <MarkdownPreview text={answer} />
        </article>
      </details>
      {actions}
    </div>
  )
}

/** In a subagent's own thread (or a branch of it): what its parent agent wrote to it. */
export function ParentMessage({ m }: { m: AgentMessage }) {
  return (
    <div className="agt-user-wrap agt-sub-parent" data-msg={m.id}>
      <div className="agt-user">
        <p className="muted agt-sub-from">From the parent agent</p>
        <div className="zed-preview agt-user-text">
          <MarkdownPreview text={m.content} breaks />
        </div>
      </div>
    </div>
  )
}

const TRIGGER: Record<string, string> = { schedule: 'on schedule', manual: 'run by hand', dry: 'dry run', retry: 'tried again', catchup: 'catching up', mail: 'new mail' }

/** A run of a task that continues this thread, landed here: a header, the report, its transcript on demand. */
export function TaskRunBlock({ m, actions, onOpenRun }: { m: AgentMessage; actions: ReactNode; onOpenRun: (task: string, run: string) => void }) {
  const meta = m.meta as Extract<MessageMeta, { kind: 'taskRun' }>
  const [open, setOpen] = useState(false)
  const [transcript, setTranscript] = useState<AgentMessage[] | null>(null)
  useEffect(() => {
    if (!open || transcript || !meta.runThread) return
    getThread(meta.runThread).then((r) => setTranscript(r.messages), () => setTranscript([]))
  }, [open, transcript, meta.runThread])
  const body = m.content.replace(/^Task “[^”]*”, run #[^\n]*\n\n/, '')
  return (
    <div className="agt-act-host agt-task-report-msg agt-task-run-block" data-msg={m.id} role="note" aria-label="Task run">
      <p className="agt-task-report-head">
        <span>
          Task: <strong>{meta.title}</strong> · run #{meta.number ?? '?'} · {TRIGGER[meta.trigger] ?? meta.trigger}
          {meta.status === 'failed' ? ' · failed' : meta.status === 'denied' ? ' · needs you' : ''}
        </span>
        <button type="button" className="btn btn-small agt-tk-link" onClick={() => onOpenRun(meta.task, meta.run)}>
          Open run
        </button>
      </p>
      <article className="zed-preview agt-answer">
        <MarkdownPreview text={body} />
      </article>
      <details className="agt-task-run-transcript" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
        <summary className="muted">What it did</summary>
        {transcript ? <Transcript messages={transcript} live={null} /> : <p className="muted">Loading…</p>}
      </details>
      {actions}
    </div>
  )
}

/** The one muted line quiet runs of a task keep up to date in this thread. */
export function TaskQuietLine({ m, onOpenRun }: { m: AgentMessage; onOpenRun: (task: string, run: string) => void }) {
  const meta = m.meta as Extract<MessageMeta, { kind: 'taskQuiet' }>
  const since = new Date(meta.since).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  return (
    <details className="agt-task-quiet" data-msg={m.id}>
      <summary className="muted">
        {meta.title}: checked{meta.count > 1 ? ` ${meta.count}×` : ''} — nothing new{meta.count > 1 ? ` · since ${since}` : ''}
      </summary>
      <p className="muted">
        Quiet runs of this task land here as this one line; a run that reports lands as a block.{' '}
        <button type="button" className="btn btn-small agt-tk-link" onClick={() => onOpenRun(meta.task, meta.run)}>
          Open the last run
        </button>
      </p>
    </details>
  )
}

/** A subagent's card (a change to allow, a page it was not given) in its parent's thread: Allow or Decline, nothing "always". */
function ChildCard({ p, onDecide }: { p: PendingApproval; onDecide: (callId: string, allow: boolean) => void }) {
  const call = p.call
  const label = p.summary?.title ?? (call ? (TASK_TOOLS[call.name]?.label.replace(/ \(.*\)$/, '') ?? call.name) : 'A call')
  return (
    <div className="agt-tool is-asking agt-sub-card" role="group" aria-label={`${p.child?.name ?? 'A subagent'} asks`}>
      <p className="agt-ask-title">
        <span className="agt-tool-icon" aria-hidden>
          ?
        </span>
        <span className="agt-tool-label">
          <strong>{p.child?.name}</strong> wants to: {label}
        </span>
      </p>
      {p.summary && (
        <dl className="agt-answers agt-ask-summary">
          {p.summary.rows.map(([k, v], i) => (
            <div key={i}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {call && (
        <dl className="agt-answers agt-ask-summary agt-tk-args">
          {askArgLines(call.arguments ?? {}, 1500).map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v.length > 200 || v.includes('\n') ? <pre className="agt-tool-body">{v}</pre> : v}</dd>
            </div>
          ))}
        </dl>
      )}
      {p.check && <p className="muted agt-ask-why">{p.check}</p>}
      <div className="agt-ask-actions">
        <button type="button" className="btn btn-small btn-primary" onClick={() => onDecide(p.callId, true)}>
          Allow
        </button>
        <button type="button" className="btn btn-small" onClick={() => onDecide(p.callId, false)}>
          Decline
        </button>
      </div>
    </div>
  )
}

/** One subagent, opened: its work (live while it works), a box to write to it, Stop and Open as thread. */
function SubagentPanel({ thread, s, onOpenThread, onError }: { thread: Thread; s: SubagentInfo; onOpenThread: (id: string) => void; onError: (e: string) => void }) {
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [live, setLive] = useState<{ content: string; thinking: string } | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const going = s.status === 'running'
  useEffect(() => {
    const ctl = new AbortController()
    if (going)
      void followThread(
        s.id,
        (e: TurnEvent) => {
          if (e.type === 'snapshot') (setMessages(e.messages), setLive(e.live))
          else if (e.type === 'message') (setMessages((m) => [...m.filter((x) => x.id !== e.message.id), e.message]), e.message.role === 'assistant' && setLive({ content: '', thinking: '' }))
          else if (e.type === 'delta') setLive((l) => ({ content: (l?.content ?? '') + (e.content ?? ''), thinking: (l?.thinking ?? '') + (e.thinking ?? '') }))
        },
        ctl.signal,
      )
        .catch(() => {})
        .finally(() => !ctl.signal.aborted && (setLive(null), void getThread(s.id).then((r) => setMessages(r.messages), () => {})))
    else getThread(s.id).then((r) => setMessages(r.messages), () => {})
    return () => ctl.abort()
  }, [s.id, going])
  const send = () => {
    const t = text.trim()
    if (!t || busy) return
    setBusy(true)
    messageSubagent(thread.id, s.id, t).then(
      () => setText(''),
      (e: Error) => onError(e.message),
    ).finally(() => setBusy(false))
  }
  const openAsThread = () => {
    const last = messages.at(-1)
    if (!last) return
    branchThread(s.id, last.id).then((r) => onOpenThread(r.thread.id), (e: Error) => onError(e.message))
  }
  return (
    <div className="agt-sub-panel">
      <p className="muted agt-sub-meta">
        {s.model} · {s.tools.length ? s.tools.join(', ') : 'no tool groups'}
        {s.writeFiles ? ' · may change files' : ''} · {shortCount(s.tokensIn + s.tokensOut)} tokens · {s.toolCalls} tool calls · {shortDuration(s.activeMs)}
      </p>
      <div className="agt-sub-transcript">
        <Transcript messages={messages} live={live} userLabel="From you" />
      </div>
      {s.error && <p className="t-red copyable">{s.error}</p>}
      <form
        className="agt-sub-say"
        onSubmit={(e) => {
          e.preventDefault()
          send()
        }}
      >
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={going ? 'Tell it something (it reads it at its next step)' : 'Ask it something more'} aria-label={`Message ${s.name}`} maxLength={20_000} />
        <button type="submit" className="btn btn-small btn-primary" disabled={busy || !text.trim()}>
          Send
        </button>
        {going && (
          <button type="button" className="btn btn-small" onClick={() => void stopSubagent(thread.id, s.id).catch((e: Error) => onError(e.message))}>
            Stop
          </button>
        )}
        {!going && messages.length > 0 && (
          <button type="button" className="btn btn-small" onClick={openAsThread} title="Open its work as a normal thread to follow up in">
            Open as thread
          </button>
        )}
      </form>
    </div>
  )
}

/**
 * The helpers this thread's agent started: a strip above the message box while any exist (folded
 * to one line once none works and none asks), with their cards to answer.
 */
export function SubagentStrip({ thread, approvals, onDecide, onOpenThread, onError }: { thread: Thread; approvals: PendingApproval[]; onDecide: (callId: string, allow: boolean) => void; onOpenThread: (id: string) => void; onError: (e: string) => void }) {
  const list = thread.subagents ?? []
  const cards = approvals.filter((a) => a.child && a.kind === 'approval')
  const working = list.filter((s) => s.status === 'running').length
  const [expanded, setExpanded] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const phone = useIsMobile()
  const seen = useRef(working)
  // Something new works or asks: the strip opens by itself.
  useEffect(() => {
    if (working > seen.current || cards.length) setExpanded(true)
    seen.current = working
  }, [working, cards.length])
  if (!list.length) return null
  const shown = expanded ? list.slice(-8).reverse() : []
  return (
    <section className={`agt-sub-strip ${phone ? 'is-phone' : ''}`} aria-label="Subagents">
      <button type="button" className="agt-sub-head" aria-expanded={expanded} onClick={() => setExpanded((x) => !x)}>
        <span className="agt-chev" aria-hidden>
          {expanded ? '▾' : '▸'}
        </span>
        Subagents
        <span className="muted">
          {working ? ` · ${working} working` : ''}
          {cards.length ? ` · ${cards.length} ${cards.length === 1 ? 'asks' : 'ask'} you` : ''}
          {!working && !cards.length ? ` · ${list.length} done` : ''}
        </span>
      </button>
      {cards.map((p) => (
        <ChildCard key={p.callId} p={p} onDecide={onDecide} />
      ))}
      {expanded && (
        <ul className="agt-sub-list">
          {shown.map((s) => (
            <li key={s.id}>
              <button type="button" className="agt-sub-row" aria-expanded={open === s.id} onClick={() => setOpen(open === s.id ? null : s.id)}>
                <span className={`agt-tk-chip ${STATUS_TONE[s.status]}`}>{SUBAGENT_STATUS_LABEL[s.status]}</span>
                <strong>{s.name}</strong>
                <span className="muted agt-sub-line">{s.lastOutput ? s.lastOutput.replace(/\s+/g, ' ').slice(0, 120) : s.instruction.replace(/\s+/g, ' ').slice(0, 120)}</span>
              </button>
              {open === s.id && <SubagentPanel thread={thread} s={s} onOpenThread={onOpenThread} onError={onError} />}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

const RUN_STATE: Record<ThreadTaskRun['status'], string> = { queued: 'Queued', running: 'Running', waiting: 'Needs you' }

/** One run of a task that continues this thread, opened: its questions, its work live. */
function TaskRunPanel({ id, onError }: { id: string; onError: (e: string) => void }) {
  const [run, setRun] = useState<TaskRunInfo | null>(null)
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [live, setLive] = useState<{ content: string; thinking: string } | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => void getRun(id).then((r) => setRun(r.run), (e: Error) => onError(e.message)), [id, tick, onError])
  const thread = run?.threadId ?? null
  const going = run?.status === 'running'
  useEffect(() => {
    if (!thread) return
    const ctl = new AbortController()
    if (going)
      void followThread(
        thread,
        (e: TurnEvent) => {
          if (e.type === 'snapshot') (setMessages(e.messages), setLive(e.live))
          else if (e.type === 'message') setMessages((m) => [...m.filter((x) => x.id !== e.message.id), e.message])
          else if (e.type === 'delta') setLive((l) => ({ content: (l?.content ?? '') + (e.content ?? ''), thinking: (l?.thinking ?? '') + (e.thinking ?? '') }))
        },
        ctl.signal,
      )
        .catch(() => {})
        .finally(() => !ctl.signal.aborted && (setLive(null), setTick((n) => n + 1)))
    else getThread(thread).then((r) => setMessages(r.messages), () => {})
    return () => ctl.abort()
  }, [thread, going])
  if (!run) return <p className="muted">Loading…</p>
  return (
    <div className="agt-sub-panel">
      {run.asks.map((a) => (
        <div key={a.index} className="agt-tool is-asking agt-sub-card">
          <p className="agt-ask-title">
            <span className="agt-tool-icon" aria-hidden>
              ?
            </span>
            <span className="agt-tool-label">{a.summary?.title ?? TASK_TOOLS[a.name]?.label ?? a.name}</span>
          </p>
          <dl className="agt-answers agt-ask-summary agt-tk-args">
            {[...(a.summary?.rows ?? []), ...askArgLines(a.arguments, 1500)].map(([k, v], i) => (
              <div key={i}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
          <p className="muted agt-ask-why">{a.reason}</p>
          <div className="agt-ask-actions">
            <button type="button" className="btn btn-small btn-primary" onClick={() => approveRun(run.id, a.index, true).then((r) => setRun(r), (e: Error) => onError(e.message))}>
              Allow
            </button>
            <button type="button" className="btn btn-small" onClick={() => approveRun(run.id, a.index, false).then((r) => setRun(r), (e: Error) => onError(e.message))}>
              Deny
            </button>
          </div>
        </div>
      ))}
      <div className="agt-sub-transcript">
        <Transcript messages={messages.filter((m) => !(m.role === 'compact' && m.compact?.seed))} live={live} />
      </div>
    </div>
  )
}

/** Runs of tasks that continue this thread, while they go: what they do, what they ask, Cancel. They land here when done. */
export function TaskRunStrip({ thread, onOpenRun, onError }: { thread: Thread; onOpenRun: (task: string, run: string) => void; onError: (e: string) => void }) {
  const runs = thread.taskRuns ?? []
  const [open, setOpen] = useState<string | null>(null)
  if (!runs.length) return null
  return (
    <section className="agt-sub-strip agt-task-strip" aria-label="Tasks running for this thread">
      <ul className="agt-sub-list">
        {runs.map((r) => (
          <li key={r.run}>
            <div className="agt-sub-row-wrap">
              <button type="button" className="agt-sub-row" aria-expanded={open === r.run} onClick={() => setOpen(open === r.run ? null : r.run)}>
                <span className={`agt-tk-chip ${r.status === 'waiting' ? 'is-ask' : 'is-busy'}`}>{RUN_STATE[r.status]}</span>
                <strong>Task: {r.title}</strong>
                <span className="muted agt-sub-line">
                  run #{r.number ?? '?'}
                  {r.asks ? ` · ${r.asks} ${r.asks === 1 ? 'question' : 'questions'} for you` : ''}
                </span>
              </button>
              <button type="button" className="btn btn-small" onClick={() => onOpenRun(r.task, r.run)}>
                Open
              </button>
              <button
                type="button"
                className="btn btn-small"
                onClick={async () => {
                  if (await ask({ title: `Cancel this run of “${r.title}”?`, body: 'What it finished stays in its transcript; nothing lands in the thread.', confirm: 'Cancel run' })) cancelRun(r.run).catch((e: Error) => onError(e.message))
                }}
              >
                Cancel
              </button>
            </div>
            {open === r.run && <TaskRunPanel id={r.run} onError={onError} />}
          </li>
        ))}
      </ul>
    </section>
  )
}
