import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { createTask, dayKeyOf, deleteTask, repeatLabel, updateTask, type Task, type TaskList, type TaskPatch } from '../../data/tasks'
import { PRIORITIES, priorityLevel } from '../../data/taskPrefs'
import { openLink } from '../../data/links'
import { ask } from '../../os/Dialogs'
import { Select } from '../../os/Select'

// A task to look at and change, or a new one: title, notes, when it is due (a day, with or without
// a time), how it repeats, priority, a link and its list. A repeating rule from another app that
// isn't one of the simple ones stays as it is, shown in words.

const REPEATS = [
  { value: '', label: 'Never' },
  { value: 'FREQ=DAILY', label: 'Every day' },
  { value: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', label: 'Every weekday' },
  { value: 'FREQ=WEEKLY', label: 'Every week' },
  { value: 'FREQ=WEEKLY;INTERVAL=2', label: 'Every 2 weeks' },
  { value: 'FREQ=MONTHLY', label: 'Every month' },
  { value: 'FREQ=YEARLY', label: 'Every year' },
]

type Draft = { title: string; notes: string; hasDate: boolean; date: string; hasTime: boolean; time: string; repeat: string; priority: number; url: string; list: string }

const hhmm = (d: Date) => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

function draftOf(t: Task | null, defaults: Partial<Draft>): Draft {
  const now = new Date()
  const base: Draft = { title: '', notes: '', hasDate: false, date: dayKeyOf(now), hasTime: false, time: '09:00', repeat: '', priority: 0, url: '', list: '', ...defaults }
  if (!t) return base
  const due = t.due ? (t.allDay ? null : new Date(t.due)) : null
  return {
    title: t.title,
    notes: t.notes ?? '',
    hasDate: !!t.due,
    date: t.due ? (t.allDay ? t.due.slice(0, 10) : dayKeyOf(due!)) : base.date,
    hasTime: !!due,
    time: due ? hhmm(due) : base.time,
    repeat: t.repeat ?? '',
    priority: t.priority,
    url: t.url ?? '',
    list: t.list,
  }
}

/** The due value the server takes: a day, or a local date and time as an ISO time. */
const dueOf = (d: Draft) => (!d.hasDate ? null : !d.hasTime ? d.date : new Date(`${d.date}T${d.time}`).toISOString())

type Props = {
  task: Task | null
  defaults?: Partial<Draft>
  lists: TaskList[]
  onClose: () => void
}

export function TaskEditor({ task, defaults = {}, lists, onClose }: Props) {
  const [d, setDraft] = useState(() => draftOf(task, defaults))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const set = (patch: Partial<Draft>) => setDraft((x) => ({ ...x, ...patch }))
  const list = lists.find((l) => l.id === d.list)
  const readOnly = !!task && !lists.find((l) => l.id === task.list)?.writable
  const writable = lists.filter((l) => l.writable)

  // A new task starts in its title; an open one takes the keyboard, so Escape closes it.
  useEffect(() => {
    if (!task) titleRef.current?.focus()
    else formRef.current?.focus({ preventScroll: true })
  }, [task])

  const save = async (e?: FormEvent) => {
    e?.preventDefault()
    if (readOnly) return onClose()
    if (!d.title.trim()) return setError('A task needs a title')
    setBusy(true)
    setError(null)
    const patch: TaskPatch = { title: d.title.trim(), notes: d.notes, due: dueOf(d), priority: d.priority, url: d.url.trim() || null, repeat: d.hasDate ? d.repeat || null : null }
    try {
      if (task) {
        // Only what changed, so another app's values for the rest stay exactly as they are.
        const was = draftOf(task, {})
        const changed: TaskPatch = {}
        if (patch.title !== task.title) changed.title = patch.title
        if (d.notes !== was.notes) changed.notes = patch.notes
        if (dueOf(d) !== dueOf(was)) changed.due = patch.due
        if (d.priority !== task.priority) changed.priority = patch.priority
        if ((patch.url ?? '') !== (task.url ?? '')) changed.url = patch.url
        if ((patch.repeat ?? '') !== (task.repeat ?? '')) changed.repeat = patch.repeat
        if (Object.keys(changed).length || d.list !== task.list) await updateTask(task, changed, d.list !== task.list ? d.list : undefined)
      } else await createTask({ ...patch, title: patch.title!, ...(patch.due ? {} : { due: undefined }), listId: d.list || undefined })
      onClose()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!task) return
    if (!(await ask({ title: `Delete "${task.title}"?`, body: 'Its subtasks are deleted with it. This cannot be undone.', confirm: 'Delete', danger: true }))) return
    setBusy(true)
    try {
      await deleteTask(task)
      onClose()
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose()
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save()
  }

  const repeatOptions = d.repeat && !REPEATS.some((r) => r.value === d.repeat) ? [...REPEATS, { value: d.repeat, label: repeatLabel(d.repeat) }] : REPEATS

  return (
    <div className="ca-sheet-back" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <form ref={formRef} tabIndex={-1} className="ca-sheet tk-sheet" onSubmit={save} onKeyDown={onKey} role="dialog" aria-label={task ? 'Task' : 'New task'}>
        <div className="ca-sheet-head">
          <span className="ca-swatch" style={{ background: list?.color ?? 'var(--accent)' }} />
          <input ref={titleRef} className="ca-title-input" value={d.title} onChange={(e) => set({ title: e.target.value })} placeholder="New task" disabled={readOnly} aria-label="Title" />
          <button type="button" className="ca-x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <fieldset disabled={readOnly || busy} className="ca-fields">
          <label className="ca-field ca-notes">
            <span>Notes</span>
            <textarea value={d.notes} onChange={(e) => set({ notes: e.target.value })} rows={3} />
          </label>
          <label className="ca-field ca-check">
            <span>Date</span>
            <input type="checkbox" checked={d.hasDate} onChange={(e) => set({ hasDate: e.target.checked })} />
          </label>
          {d.hasDate && (
            <>
              <div className="ca-field">
                <span>Due</span>
                <span className="ca-when">
                  <input type="date" value={d.date} onChange={(e) => e.target.value && set({ date: e.target.value })} required aria-label="Due date" />
                  {d.hasTime && <input type="time" step={300} value={d.time} onChange={(e) => e.target.value && set({ time: e.target.value })} required aria-label="Due time" />}
                </span>
              </div>
              <label className="ca-field ca-check">
                <span>Time</span>
                <input type="checkbox" checked={d.hasTime} onChange={(e) => set({ hasTime: e.target.checked })} />
              </label>
              <label className="ca-field">
                <span>Repeat</span>
                <Select value={d.repeat} options={repeatOptions} onChange={(repeat) => set({ repeat })} aria-label="Repeat" />
              </label>
            </>
          )}
          <div className="ca-field">
            <span>Priority</span>
            <span className="tk-seg" role="radiogroup" aria-label="Priority">
              {PRIORITIES.map((p) => (
                <button key={p.value} type="button" role="radio" aria-checked={priorityLevel(d.priority) === priorityLevel(p.value)} className={priorityLevel(d.priority) === priorityLevel(p.value) ? 'is-on' : ''} onClick={() => set({ priority: p.value })}>
                  {p.label}
                </button>
              ))}
            </span>
          </div>
          <div className="ca-field">
            <span>Link</span>
            <span className="ca-when">
              <input value={d.url} onChange={(e) => set({ url: e.target.value })} placeholder="https://…" inputMode="url" spellCheck={false} aria-label="Link" />
              {/^message:/i.test(d.url.trim()) ? (
                <button type="button" className="btn btn-small" onClick={() => openLink(d.url.trim())} title="Open the email in Mail">
                  ✉
                </button>
              ) : (
                /^https?:\/\//.test(d.url.trim()) && (
                  <button type="button" className="btn btn-small" onClick={() => openLink(d.url.trim())} title="Open the link">
                    ↗
                  </button>
                )
              )}
            </span>
          </div>
          <label className="ca-field">
            <span>List</span>
            {writable.length ? (
              <Select value={d.list} onChange={(l) => set({ list: l })} options={writable.map((l) => ({ value: l.id, label: `${l.name} · ${l.source}` }))} aria-label="List" />
            ) : (
              <em className="muted">{list?.name ?? 'None'}</em>
            )}
          </label>
        </fieldset>
        {task?.alarms?.length ? <p className="ca-hint">Reminds at {task.alarms.map((a) => new Date(a).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })).join(', ')} (its own reminder).</p> : null}
        {d.hasDate && d.repeat && <p className="ca-hint">Completing it moves it on to the next date.</p>}
        {readOnly && <p className="ca-hint">This list is read-only here.</p>}
        {error && <p className="ca-hint t-red copyable">{error}</p>}
        <div className="ca-sheet-foot">
          {task && !readOnly && (
            <button type="button" className="btn btn-small btn-danger" onClick={remove} disabled={busy}>
              Delete
            </button>
          )}
          <span className="nb-spacer" />
          <button type="button" className="btn btn-small" onClick={onClose}>
            {readOnly ? 'Close' : 'Cancel'}
          </button>
          {!readOnly && (
            <button type="submit" className="btn btn-small btn-primary" disabled={busy || !d.title.trim()}>
              {busy ? 'Saving…' : task ? 'Save' : 'Add'}
            </button>
          )}
        </div>
      </form>
    </div>
  )
}
