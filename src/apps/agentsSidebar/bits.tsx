import { useEffect, useRef, useState, type ReactNode } from 'react'
import { suggestTitle, type Thread } from '../../data/agents'

// Small pieces the Agents sidebar and the app share: the icons, the Matrix-style title that is
// being thought of, the rename fields, and how threads are dated and grouped.

/** A one-line name field: Enter or leaving it keeps the name, Escape drops it. */
export function InlineName({ value = '', placeholder, onDone }: { value?: string; placeholder?: string; onDone: (name: string | null) => void }) {
  const done = useRef(false)
  const finish = (name: string | null) => {
    if (done.current) return
    done.current = true
    onDone(name?.trim() || null)
  }
  return (
    <input
      className="agt-inline-name"
      defaultValue={value}
      placeholder={placeholder}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onBlur={(e) => finish(e.currentTarget.value)}
      onKeyDown={(e) => (e.key === 'Enter' ? finish(e.currentTarget.value) : e.key === 'Escape' && finish(null))}
      onClick={(e) => e.stopPropagation()}
      aria-label={placeholder ?? 'Name'}
    />
  )
}
/** "now", "5m", "3h", "Tue", "12 Oct": as short as the one line allows. */
export function shortWhen(ms: number, now = Date.now()) {
  const s = (now - ms) / 1000
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  const d = new Date(ms)
  if (new Date(now).toDateString() === d.toDateString()) return `${Math.floor(s / 3600)}h`
  if (s < 6 * 86400) return d.toLocaleDateString('en-GB', { weekday: 'short' })
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

/** Threads under Today, Yesterday, This week, This month and Older (newest first). */
export function byDay(threads: Thread[]): { label: string; items: Thread[] }[] {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const t0 = today.getTime()
  const label = (ms: number) => (ms >= t0 ? 'Today' : ms >= t0 - 864e5 ? 'Yesterday' : ms >= t0 - 6 * 864e5 ? 'This week' : ms >= t0 - 30 * 864e5 ? 'This month' : 'Older')
  const out: { label: string; items: Thread[] }[] = []
  for (const t of threads) {
    const l = label(t.updatedAt)
    if (out[out.length - 1]?.label === l) out[out.length - 1].items.push(t)
    else out.push({ label: l, items: [t] })
  }
  return out
}

export const ICONS: Record<string, ReactNode> = {
  folder: <path d="M3 6h6l2 2h10v11H3z" />,
  sidebar: (
    <>
      <rect x="3" y="4" width="18" height="16" />
      <path d="M9 4v16" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  tasks: (
    <>
      <circle cx="12" cy="13" r="8" />
      <path d="M12 9v4l3 2M9 2h6" />
    </>
  ),
  archive: (
    <>
      <path d="M3 5h18v4H3zM5 9v10h14V9M10 13h4" />
    </>
  ),
  memory: <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM18.5 16l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" />,
  gear: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1L7 17M17 7l2.1-2.1" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="M20 20l-4.5-4.5" />
    </>
  ),
  back: <path d="M15 5l-7 7 7 7" />,
  studio: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="2" />
      <path d="M21 16l-5-5-9 9" />
    </>
  ),
  clip: <path d="M20 11.5l-8 8a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4L15 7" />,
  bolt: <path d="M13 2L5 14h6l-1 8 8-12h-6z" />,
  deep: (
    <>
      <circle cx="10" cy="10" r="6" />
      <path d="M20 20l-5.5-5.5M10 7v6M7 10h6" />
    </>
  ),
  tools: <path d="M14.7 6.3a4 4 0 0 0 5 5L22 14l-8 8-2.3-2.3a4 4 0 0 0-5-5L4 12l2.7-2.7a4 4 0 0 0 5-5L14 2z" />,
  chevron: <path d="M7 10l5 5 5-5" />,
  send: <path d="M12 19V5M6 11l6-6 6 6" />,
  stop: <rect x="7" y="7" width="10" height="10" fill="currentColor" />,
  pin: <path d="M9 4h6l-1 6 3 3H7l3-3zM12 13v7" />,
  edit: <path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  trash: <path d="M4 7h16M10 7V4h4v3M6 7l1 13h10l1-13M10 11v6M14 11v6" />,
  chat: <path d="M4 5h16v11H9l-5 4z" />,
  more: (
    <>
      <circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none" />
    </>
  ),
}

export function Icon({ name, size = 15 }: { name: keyof typeof ICONS; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="agt-svg">
      {ICONS[name]}
    </svg>
  )
}

// --- titles ----------------------------------------------------------------------------------

export const NEW_TITLE = 'New thread'
/** Regenerate title's second line: only when it changes more than the title (one you named goes back to automatic). */
export const regenerateHint = (t: Thread) => (t.titleSource === 'user' ? 'You named it: titles keep up to date again after this' : undefined)
/** Still waiting for the title model. */
export const titlePending = (t: Thread) => t.titling || (t.title === NEW_TITLE && t.running)

const GLYPHS = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789'
const noise = (n: number) => Array.from({ length: n }, () => GLYPHS[Math.floor(Math.random() * GLYPHS.length)]).join('')
const calm = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * A title that is still being thought of rains Matrix glyphs in its one line, then decodes into
 * the real title from the left once it arrives.
 */
export function Scramble({ text, pending, length = 16 }: { text: string; pending: boolean; length?: number }) {
  const [shown, setShown] = useState(() => (pending ? noise(length) : text))
  const wasPending = useRef(pending)
  useEffect(() => {
    const before = wasPending.current
    wasPending.current = pending
    if (calm()) return setShown(pending ? 'Naming…' : text)
    if (pending) {
      const timer = setInterval(() => setShown(noise(length)), 70)
      return () => clearInterval(timer)
    }
    if (!before) return setShown(text)
    // A timer, not animation frames: those stop in a hidden tab, and the title must still land.
    const start = Date.now()
    const timer = setInterval(() => {
      const p = Math.min(1, (Date.now() - start) / 650)
      const n = Math.floor(p * text.length)
      setShown(p < 1 ? text.slice(0, n) + noise(Math.min(length, text.length - n)) : text)
      if (p >= 1) clearInterval(timer)
    }, 40)
    return () => clearInterval(timer)
  }, [pending, text, length])
  return (
    <span className={`agt-matrix ${pending ? 'is-pending' : ''}`} aria-label={pending ? 'Thinking of a title' : text}>
      {shown}
    </span>
  )
}

/** Renaming in place, with a fresh suggestion from the title model one click away. */
export function RenameBox({ thread, onSave, onCancel }: { thread: Thread; onSave: (title: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(thread.title === NEW_TITLE ? '' : thread.title)
  const [suggestion, setSuggestion] = useState<string | null>(null)
  const [asking, setAsking] = useState(true)
  const input = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  const finish = (save: boolean) => {
    if (done.current) return
    done.current = true
    if (save) onSave(input.current?.value ?? value)
    else onCancel()
  }
  useEffect(() => {
    input.current?.select()
    let live = true
    suggestTitle(thread.id).then(
      (r) => live && (setSuggestion(r.title), setAsking(false)),
      () => live && setAsking(false),
    )
    return () => {
      live = false
    }
  }, [thread.id])
  return (
    <div className="agt-rename">
      <input
        ref={input}
        autoFocus
        value={value}
        placeholder={thread.title}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => finish(true)}
        onKeyDown={(e) => (e.key === 'Enter' ? finish(true) : e.key === 'Escape' && finish(false))}
        aria-label="Thread title"
      />
      {(asking || suggestion) && (
        <button
          className="agt-suggest"
          disabled={!suggestion}
          // Keep the input focused, so choosing the suggestion doesn't end the rename.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => suggestion && (setValue(suggestion), input.current?.focus())}
          title="Use this title"
        >
          <span aria-hidden>✦ </span>
          <Scramble text={suggestion ?? ''} pending={asking} length={14} />
        </button>
      )}
    </div>
  )
}

