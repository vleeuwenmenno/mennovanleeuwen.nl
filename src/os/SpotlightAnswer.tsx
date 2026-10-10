import { useCallback, useEffect, useRef, useState } from 'react'
import { MarkdownPreview } from '../apps/Zed'
import { agentSettings, createThread, deleteThread, getThread, listQuick, sendMessage, toolLabel, updateThread, type AgentMessage, type QuickAnswerInfo, type Thread } from '../data/agents'
import { AppIcon } from './icons'
import { useWM } from './wm'

// Spotlight's quick answers: a question asked from Spotlight runs in an Agents thread with the
// app's defaults (mode, model, tools) and streams in here. The thread is a quick one, kept out of
// the Agents app: it lists under Recent answers in Spotlight until it expires (Settings →
// Spotlight) or is forgotten. Continue in Agents (Ctrl+K) moves it into the app and opens it there,
// for follow-up questions.

export type QuickAnswer = {
  question: string
  thread: Thread | null
  messages: AgentMessage[]
  live: { content: string; thinking: string }
  /** The agent asked for an approval or filled in a form: only the Agents window can answer it */
  waiting: boolean
  error: string | null
  done: boolean
  /** Streamed from this Spotlight, or read from the server again and again (a recent one still answering) */
  source: 'stream' | 'poll'
}

/** The answer so far, as Markdown: every reply's text, then what is still streaming. */
export const answerText = (a: QuickAnswer) =>
  [...a.messages.filter((m) => m.role === 'assistant').map((m) => m.content.trim()), a.live.content.trim()].filter(Boolean).join('\n\n')

const EMPTY = { live: { content: '', thinking: '' }, waiting: false, error: null }

/** Asking, the answer on show, and the recent answers; `enabled` when the owner has Agents. */
export function useQuickAnswer(enabled: boolean) {
  const wm = useWM()
  const [answer, setAnswer] = useState<QuickAnswer | null>(null)
  const [recent, setRecent] = useState<QuickAnswerInfo[]>([])
  // The question streaming into this Spotlight: its thread (once made) and its stream.
  const run = useRef<{ thread: Promise<Thread | null>; ctl: AbortController; sent: boolean } | null>(null)
  const shown = useRef(answer)
  shown.current = answer

  const refresh = useCallback(() => {
    if (enabled) listQuick().then(setRecent, () => {})
  }, [enabled])
  useEffect(refresh, [refresh])

  /**
   * Stops following the stream. The answer goes on on the server and lands in Recent answers; a
   * thread whose question never went out is deleted.
   */
  const drop = useCallback(() => {
    const r = run.current
    run.current = null
    if (!r) return
    r.ctl.abort()
    if (!r.sent) void r.thread.then((t) => t && deleteThread(t.id).catch(() => {}))
  }, [])
  useEffect(() => drop, [drop])

  const ask = useCallback(
    (question: string) => {
      drop()
      const ctl = new AbortController()
      const patch = (p: Partial<QuickAnswer>) => !ctl.signal.aborted && setAnswer((a) => (a ? { ...a, ...p } : a))
      setAnswer({ question, thread: null, messages: [], ...EMPTY, done: false, source: 'stream' })
      const s = agentSettings()
      const thread = createThread({ mode: s.mode, tools: s.tools, quick: true }).catch((e: Error) => (patch({ error: e.message, done: true }), null))
      const r = { thread, ctl, sent: false }
      run.current = r
      void thread.then(async (t) => {
        if (!t || ctl.signal.aborted) return
        patch({ thread: t })
        r.sent = true
        try {
          await sendMessage(
            t.id,
            question,
            [],
            (e) => {
              if (ctl.signal.aborted) return
              if (e.type === 'delta') setAnswer((a) => a && { ...a, live: { content: a.live.content + (e.content ?? ''), thinking: a.live.thinking + (e.thinking ?? '') } })
              else if (e.type === 'message') setAnswer((a) => a && { ...a, messages: [...a.messages, e.message], live: e.message.role === 'assistant' ? { content: '', thinking: '' } : a.live })
              else if (e.type === 'approval' || e.type === 'question') patch({ waiting: true })
              else if (e.type === 'approved' || e.type === 'answered') patch({ waiting: false })
              else if (e.type === 'thread') patch({ thread: e.thread })
              else if (e.type === 'error') patch({ error: e.error })
            },
            ctl.signal,
          )
        } catch (e) {
          if ((e as Error).name !== 'AbortError') patch({ error: (e as Error).message })
        } finally {
          if (run.current === r) run.current = null
          patch({ done: true })
          refresh()
        }
      })
    },
    [drop, refresh],
  )

  /** Shows a recent answer again; one still answering is read again every moment until it is done. */
  const show = useCallback(
    (info: QuickAnswerInfo) => {
      drop()
      setAnswer({ question: info.question, thread: info.thread, messages: [], ...EMPTY, done: !info.thread.running, source: 'poll' })
    },
    [drop],
  )
  const shownId = answer?.source === 'poll' ? answer.thread?.id : undefined
  const polling = !!shownId && !answer?.done
  useEffect(() => {
    if (!shownId) return
    let stop = false
    const load = () =>
      getThread(shownId).then(
        (r) => {
          if (stop) return
          setAnswer((a) => (a?.thread?.id === shownId ? { ...a, thread: r.thread, messages: r.messages, waiting: r.pending.length > 0, done: !r.thread.running } : a))
          if (!r.thread.running) refresh()
        },
        (e: Error) => !stop && setAnswer((a) => (a?.thread?.id === shownId ? { ...a, error: e.message, done: true } : a)),
      )
    void load()
    const timer = polling ? setInterval(load, 1500) : undefined
    return () => {
      stop = true
      clearInterval(timer)
    }
  }, [shownId, polling, refresh])

  /**
   * Moves a quick answer (the one on show, without `id`) into the Agents app and opens it there; a
   * turn still going goes on in that window.
   */
  const adopt = useCallback(async (id?: string) => {
    const t = id ? { id } : (shown.current?.thread ?? (await run.current?.thread) ?? null)
    if (!t) return
    await updateThread(t.id, { quick: false }).catch(() => {})
    setRecent((list) => list.filter((x) => x.thread.id !== t.id))
    wm.open('agents', { thread: t.id, t: String(Date.now()) })
  }, [wm])

  /** Deletes a recent answer (stopping it, if it is still answering). */
  const forget = useCallback(
    (id: string) => {
      setRecent((list) => list.filter((x) => x.thread.id !== id))
      setAnswer((a) => (a?.thread?.id === id ? null : a))
      void deleteThread(id).catch(() => {}).then(refresh)
    },
    [refresh],
  )

  const clear = useCallback(() => {
    drop()
    setAnswer(null)
  }, [drop])

  return { answer, recent, ask, show, adopt, forget, clear }
}

export function QuickAnswerView({ answer, onAdopt }: { answer: QuickAnswer; onAdopt: () => void }) {
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  useEffect(() => {
    const el = scroller.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [answer.messages, answer.live])

  const { messages, live, waiting, error, done } = answer
  const replies = messages.filter((m) => m.role === 'assistant')
  const steps = replies.flatMap((m) => m.toolCalls ?? [])
  const shown = answerText(answer)
  const thinking = !done && !live.content && !!live.thinking

  return (
    <div className="sp-answer" ref={scroller} onScroll={(e) => (pinned.current = e.currentTarget.scrollHeight - e.currentTarget.scrollTop - e.currentTarget.clientHeight < 40)}>
      <div className="sp-answer-head">
        <AppIcon app="agents" size={22} />
        <span className="sp-answer-q">{answer.question}</span>
        <button className="btn btn-small" onClick={onAdopt} disabled={!answer.thread && !!error}>
          Continue in Agents
        </button>
      </div>
      {steps.length > 0 && (
        <ul className="sp-answer-steps muted">
          {steps.map((c, i) => (
            <li key={i}>{toolLabel(c)}</li>
          ))}
        </ul>
      )}
      {shown ? (
        <article className="zed-preview agt-answer">
          <MarkdownPreview text={shown} />
        </article>
      ) : (
        !error && !done && <p className="agt-wait muted">{!answer.thread ? 'Starting…' : thinking ? 'Thinking…' : steps.length ? 'Reading…' : 'Working…'}</p>
      )}
      {waiting && <p className="sp-answer-note">The agent is waiting for you: continue in Agents to answer it.</p>}
      {error && <p className="sp-answer-note t-red">{error}</p>}
      {done && !shown && !error && <p className="muted">No answer came back.</p>}
    </div>
  )
}
