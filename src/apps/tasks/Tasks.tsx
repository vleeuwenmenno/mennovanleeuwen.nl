import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import {
  completeTask,
  createTask,
  dayKeyOf,
  deleteList,
  deleteTask,
  dueDay,
  dueLabel,
  isOverdue,
  keepTimeZone,
  reloadTasks,
  reorderTasks,
  repeatLabel,
  setTaskPrefs,
  updateTask,
  useTaskPrefs,
  useTasks,
  type Task,
  type TaskList,
} from '../../data/tasks'
import { priorityLevel } from '../../data/taskPrefs'
import { openLink } from '../../data/links'
import { signIn, useAccount } from '../../os/account'
import { openContextMenu, type MenuItem } from '../../os/ContextMenu'
import { ask } from '../../os/Dialogs'
import { notify } from '../../os/notify'
import { useWM, type WinState } from '../../os/wm'
import { parseQuick } from './quickAdd'
import { TaskEditor } from './TaskEditor'
import { ListSheet, SettingsSheet } from './TaskSheets'
import './tasks.css'

// The Tasks app, laid out like Apple's Reminders: smart lists (Today, Scheduled, All, Priority,
// Completed) and your lists in the sidebar, grouped by where they live (each CalDAV account, and
// "On this site"); the tasks of the one picked on the right. Type a task at the top with its date
// at the end ("Call mum tomorrow 9am", "Report fri !!"); tick the circle to complete it (a repeating
// one moves on to its next date); click it for its details. In a list, drag the handle to put tasks
// in your own order (kept as Apple's X-APPLE-SORT-ORDER, so Reminders on a phone shows the same).
// Right-click (or long-press) a task or list for the rest. On a phone the sidebar is the first
// screen and a list opens over it.
//
// props.task ("<list id>|<UID>", from openTask, a reminder or the Calendar) opens that task.

type Smart = 'today' | 'scheduled' | 'all' | 'priority' | 'completed'
type View = { smart: Smart } | { list: string }
type Editing = { task: Task | null; defaults?: { list?: string; hasDate?: boolean; date?: string } }

const SMART: { id: Smart; label: string; glyph: string; color: string }[] = [
  { id: 'today', label: 'Today', glyph: '◉', color: 'var(--blue)' },
  { id: 'scheduled', label: 'Scheduled', glyph: '▦', color: 'var(--red)' },
  { id: 'all', label: 'All', glyph: '≡', color: 'var(--text)' },
  { id: 'priority', label: 'Priority', glyph: '!', color: 'var(--orange)' },
  { id: 'completed', label: 'Completed', glyph: '✓', color: 'var(--muted)' },
]

const isSmart = (v: View): v is { smart: Smart } => 'smart' in v
/** Manual order first (lowest first), then the oldest. */
const byOrder = (a: Task, b: Task) => (a.order ?? Infinity) - (b.order ?? Infinity) || (a.created ?? '').localeCompare(b.created ?? '') || a.title.localeCompare(b.title)
/** Due first (soonest first), then priority. */
const byDue = (a: Task, b: Task) => (dueDay(a) ?? '9999').localeCompare(dueDay(b) ?? '9999') || (a.allDay ? 0 : 1) - (b.allDay ? 0 : 1) || (a.due ?? '').localeCompare(b.due ?? '') || prioRank(a) - prioRank(b)
const prioRank = (t: Task) => (t.priority ? (t.priority < 5 ? 0 : t.priority === 5 ? 1 : 2) : 3)
const bangs = (t: Task) => ({ high: '!!!', medium: '!!', low: '!', none: '' })[priorityLevel(t.priority)]

/** A row in the list: a task, how deep it sits (subtasks), or a heading (Scheduled's days, All's lists). */
type Row = { task: Task; depth: number } | { heading: string; key: string; color?: string }

export function TasksApp({ win }: { win: WinState }) {
  const account = useAccount()
  const wm = useWM()
  const { lists, tasks, errors, loading } = useTasks()
  const prefs = useTaskPrefs()
  const rootRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<View>({ smart: 'today' })
  const [search, setSearch] = useState('')
  const [narrow, setNarrow] = useState(false)
  const [pane, setPane] = useState<'side' | 'main'>('main')
  const [editing, setEditing] = useState<Editing | null>(null)
  const [sheet, setSheet] = useState<{ kind: 'list'; list: TaskList | null } | { kind: 'settings' } | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Just ticked: they stay a moment (ticked) before they leave the list.
  const [leaving, setLeaving] = useState<Set<string>>(new Set())
  const [now, setNow] = useState(() => new Date())

  useEffect(() => keepTimeZone(), [])
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(t)
  }, [])
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setNarrow(el.clientWidth < 620))
    ro.observe(el)
    return () => ro.disconnect()
  }, [account.status])

  // Opened on a task (a reminder, the Calendar, another app): its list, with its details. Only when
  // just asked: a window put back from the saved layout keeps its props, and shouldn't open it again.
  const fresh = () => !!win.props.task && Number(win.props.t ?? 0) > Date.now() - 30_000
  const wanted = useRef<string | null>(fresh() ? win.props.task! : null)
  useEffect(() => {
    if (fresh()) wanted.current = win.props.task!
  }, [win.props.t]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const id = wanted.current
    if (!id || !lists) return
    const t = tasks.find((x) => x.id === id)
    if (!t) return
    wanted.current = null
    setView({ list: t.list })
    setSearch('')
    setSelected(t.id)
    setPane('main')
    setEditing({ task: t })
  }, [lists, tasks, win.props.t])

  // Brought to the front: take the keyboard (unless something else is being typed in).
  useEffect(() => {
    if (wm.focusedPid !== win.pid) return
    const active = document.activeElement
    if (active && active !== document.body && !active.closest('.window')) return
    if (!rootRef.current?.contains(active)) rootRef.current?.focus({ preventScroll: true })
  }, [wm.focusedPid, win.pid])

  const listById = useMemo(() => new Map((lists ?? []).map((l) => [l.id, l])), [lists])
  const writableLists = (lists ?? []).filter((l) => l.writable)
  const today = dayKeyOf(now)
  const visible = (t: Task) => !t.completed || leaving.has(t.id)
  const currentList = !isSmart(view) ? listById.get(view.list) : undefined
  // The view's list may be gone (deleted elsewhere): back to Today.
  useEffect(() => {
    if (lists && !isSmart(view) && !listById.has(view.list)) setView({ smart: 'today' })
  }, [lists, view, listById])

  const counts = useMemo(() => {
    const open = tasks.filter((t) => !t.completed)
    return {
      today: open.filter((t) => t.due && dueDay(t)! <= today).length,
      scheduled: open.filter((t) => t.due).length,
      all: open.length,
      priority: open.filter((t) => t.priority).length,
      completed: tasks.length - open.length,
      byList: new Map((lists ?? []).map((l) => [l.id, open.filter((t) => t.list === l.id).length])),
    }
  }, [tasks, lists, today])

  /** The rows of the view: a list's tasks with their subtasks under them, or a smart list's. */
  const rows = useMemo<Row[]>(() => {
    const q = search.trim().toLowerCase()
    if (q) {
      const found = tasks.filter((t) => `${t.title}\n${t.notes ?? ''}`.toLowerCase().includes(q)).sort((a, b) => Number(a.completed) - Number(b.completed) || byDue(a, b))
      return found.map((task) => ({ task, depth: 0 }))
    }
    if (!isSmart(view)) {
      const mine = tasks.filter((t) => t.list === view.list && (prefs.showCompleted || visible(t)))
      const uids = new Set(mine.map((t) => t.uid))
      const out: Row[] = []
      const walk = (parent: string | undefined, depth: number) => {
        for (const t of mine.filter((x) => (parent ? x.parent === parent : !x.parent || !uids.has(x.parent))).sort((a, b) => Number(a.completed && !leaving.has(a.id)) - Number(b.completed && !leaving.has(b.id)) || byOrder(a, b))) {
          out.push({ task: t, depth })
          if (depth < 4) walk(t.uid, depth + 1)
        }
      }
      walk(undefined, 0)
      return out
    }
    const open = tasks.filter(visible)
    switch (view.smart) {
      case 'today':
        return open.filter((t) => t.due && dueDay(t)! <= today).sort(byDue).map((task) => ({ task, depth: 0 }))
      case 'priority':
        return open.filter((t) => t.priority).sort((a, b) => prioRank(a) - prioRank(b) || byDue(a, b)).map((task) => ({ task, depth: 0 }))
      case 'completed':
        return tasks.filter((t) => t.completed).sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? '')).map((task) => ({ task, depth: 0 }))
      case 'scheduled': {
        const out: Row[] = []
        let last = ''
        for (const t of open.filter((x) => x.due).sort(byDue)) {
          const day = dueDay(t)!
          const heading = day < today ? 'Overdue' : day === today ? 'Today' : dueLabel({ due: day, allDay: true }, now)
          if (heading !== last) out.push({ heading, key: `h-${heading}` })
          last = heading
          out.push({ task: t, depth: 0 })
        }
        return out
      }
      case 'all': {
        const out: Row[] = []
        for (const l of lists ?? []) {
          const mine = open.filter((t) => t.list === l.id).sort(byOrder)
          if (!mine.length) continue
          out.push({ heading: l.name, key: `h-${l.id}`, color: l.color })
          out.push(...mine.map((task) => ({ task, depth: task.parent && mine.some((p) => p.uid === task.parent) ? 1 : 0 })))
        }
        return out
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, lists, view, search, prefs.showCompleted, leaving, today])

  const taskRows = rows.filter((r): r is { task: Task; depth: number } => 'task' in r)

  const go = (v: View) => {
    setView(v)
    setSearch('')
    setSelected(null)
    setPane('main')
  }

  /** The list a task typed here goes in: this one, or the default. */
  const targetList = (): TaskList | undefined => (currentList?.writable ? currentList : (writableLists.find((l) => l.id === prefs.defaultList) ?? writableLists.find((l) => !l.local) ?? writableLists[0]))

  const toggle = async (t: Task) => {
    if (!listById.get(t.list)?.writable) return
    setError(null)
    const done = !t.completed
    if (done && !t.repeat) {
      setLeaving((s) => new Set(s).add(t.id))
      setTimeout(
        () =>
          setLeaving((s) => {
            const n = new Set(s)
            n.delete(t.id)
            return n
          }),
        1500,
      )
    }
    try {
      const r = await completeTask(t, done)
      if (r.advanced && r.task.due) notify({ title: `${t.title}: next on ${dueLabel(r.task, new Date())}`, body: repeatLabel(r.task.repeat ?? ''), transient: true })
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const change = async (t: Task, patch: Parameters<typeof updateTask>[1], list?: string) => {
    setError(null)
    try {
      await updateTask(t, patch, list)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const remove = async (t: Task) => {
    if (!(await ask({ title: `Delete "${t.title}"?`, body: tasks.some((x) => x.parent === t.uid && x.list === t.list) ? 'Its subtasks are deleted with it.' : undefined, confirm: 'Delete', danger: true }))) return
    try {
      await deleteTask(t)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const removeList = async (l: TaskList) => {
    const n = tasks.filter((t) => t.list === l.id).length
    if (!(await ask({ title: `Delete the list "${l.name}"?`, body: `${n ? `Its ${n} task${n === 1 ? '' : 's'} go with it` : 'It is empty'}${l.local ? '' : `, on ${l.source} too`}. This cannot be undone.`, confirm: 'Delete list', danger: true }))) return
    try {
      await deleteList(l)
      if (!isSmart(view) && view.list === l.id) go({ smart: 'today' })
    } catch (e) {
      setError((e as Error).message)
    }
  }

  /** Makes it a subtask of the task above it in the list (or, `out`, takes it out again). */
  const indent = (t: Task, out: boolean) => {
    if (out) return change(t, { parent: null })
    const i = taskRows.findIndex((r) => r.task.id === t.id)
    const depth = taskRows[i]?.depth ?? 0
    const above = taskRows
      .slice(0, i)
      .reverse()
      .find((r) => r.depth === depth && r.task.list === t.list)
    if (above) void change(t, { parent: above.task.uid })
  }

  const due = (days: number | null): string | null => (days === null ? null : dayKeyOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() + days)))
  const taskMenu = (ev: MouseEvent, t: Task) => {
    setSelected(t.id)
    const writable = !!listById.get(t.list)?.writable
    const depth = taskRows.find((r) => r.task.id === t.id)?.depth ?? 0
    const items: MenuItem[] = [
      { label: writable ? 'Open' : 'Show details', onSelect: () => setEditing({ task: t }) },
      ...(writable
        ? [
            { label: t.completed ? 'Mark as not completed' : 'Mark as completed', shortcut: 'Space', onSelect: () => void toggle(t) },
            {
              label: 'Due',
              submenu: [
                { label: 'Today', onSelect: () => change(t, { due: due(0) }) },
                { label: 'Tomorrow', onSelect: () => change(t, { due: due(1) }) },
                { label: 'This weekend', onSelect: () => change(t, { due: due((6 - now.getDay() + 7) % 7 || 7) }) },
                { label: 'Next week', onSelect: () => change(t, { due: due(7 - ((now.getDay() + 6) % 7)) }) },
                { separator: true as const },
                { label: 'No date', disabled: !t.due, onSelect: () => change(t, { due: null }) },
              ],
            },
            { label: 'Priority', submenu: ([['None', 0], ['Low', 9], ['Medium', 5], ['High', 1]] as const).map(([label, p]) => ({ label, checked: priorityLevel(t.priority) === priorityLevel(p), onSelect: () => change(t, { priority: p }) })) },
            ...(writableLists.length > 1 ? [{ label: 'Move to', submenu: writableLists.map((l) => ({ label: `${l.name} · ${l.source}`, swatch: l.color, checked: l.id === t.list, disabled: l.id === t.list, onSelect: () => change(t, {}, l.id) })) }] : []),
            ...(!isSmart(view) ? [depth > 0 || t.parent ? { label: 'Not a subtask', onSelect: () => indent(t, true) } : { label: 'Subtask of the one above', onSelect: () => indent(t, false) }] : []),
          ]
        : []),
      ...(t.url ? [{ label: 'Open link', onSelect: () => openLink(t.url!) }] : []),
      ...(writable ? [{ separator: true as const }, { label: 'Delete', danger: true, shortcut: 'Del', onSelect: () => void remove(t) }] : []),
    ]
    openContextMenu(ev, items)
  }

  const listMenu = (ev: MouseEvent, l: TaskList) => {
    const hidden = prefs.hiddenInCalendar.includes(l.id)
    openContextMenu(ev, [
      { label: 'Show in Calendar', checked: !hidden, onSelect: () => setTaskPrefs({ hiddenInCalendar: hidden ? prefs.hiddenInCalendar.filter((x) => x !== l.id) : [...prefs.hiddenInCalendar, l.id] }) },
      { label: 'New tasks from other apps go here', checked: prefs.defaultList === l.id, disabled: !l.writable, onSelect: () => setTaskPrefs({ defaultList: l.id }) },
      ...(l.writable ? [{ separator: true as const }, { label: 'Rename and colour…', onSelect: () => setSheet({ kind: 'list', list: l }) }] : []),
      ...(l.writable && !l.calendar ? [{ label: 'Delete list…', danger: true, onSelect: () => void removeList(l) }] : []),
    ])
  }

  // --- Keyboard: arrows choose, Space ticks, Enter opens, Delete deletes, N types a new one.
  const onKey = (e: KeyboardEvent) => {
    if (editing || sheet || e.metaKey || e.ctrlKey || e.altKey) return
    if ((e.target as HTMLElement).closest('input, textarea, select')) return
    const i = taskRows.findIndex((r) => r.task.id === selected)
    const sel = taskRows[i]?.task
    if (e.key === 'ArrowDown' || e.key === 'j') setSelected(taskRows[Math.min(taskRows.length - 1, i + 1)]?.task.id ?? null)
    else if (e.key === 'ArrowUp' || e.key === 'k') setSelected(taskRows[Math.max(0, i - 1)]?.task.id ?? null)
    else if (e.key === ' ' && sel) void toggle(sel)
    else if (e.key === 'Enter' && sel) setEditing({ task: sel })
    else if ((e.key === 'Delete' || e.key === 'Backspace') && sel && listById.get(sel.list)?.writable) void remove(sel)
    else if (e.key === 'n') rootRef.current?.querySelector<HTMLInputElement>('.tk-add input')?.focus()
    else if (e.key === 'r') void reloadTasks(true)
    else return
    e.preventDefault()
  }

  if (account.status !== 'user')
    return (
      <div ref={rootRef} className="tk tk-empty">
        <div className="ca-empty-box">
          <span className="ca-empty-glyph">☑</span>
          <h3>Tasks</h3>
          <p className="muted">Your reminders and to-dos show here once you sign in: the task lists of your CalDAV accounts (Fastmail, Nextcloud, iCloud), or lists kept on this site.</p>
          {account.status === 'anon' && (
            <button className="btn btn-primary" onClick={signIn}>
              Sign in with GitHub
            </button>
          )}
        </div>
      </div>
    )

  const title = search.trim() ? `Results for “${search.trim()}”` : isSmart(view) ? SMART.find((s) => s.id === view.smart)!.label : (currentList?.name ?? '')
  const titleColor = search.trim() ? 'var(--fg-bright)' : isSmart(view) ? SMART.find((s) => s.id === view.smart)!.color : currentList?.color
  const sources = [...new Set((lists ?? []).map((l) => l.source))]
  const problems = [error, ...errors].filter(Boolean)
  const showSide = !narrow || pane === 'side'
  const showMain = !narrow || pane === 'main'
  const canAdd = !search.trim() && (isSmart(view) ? view.smart !== 'completed' : !!currentList?.writable) && !!targetList()
  const shownCount = taskRows.filter((r) => !r.task.completed).length

  return (
    <div ref={rootRef} className={`tk ${narrow ? 'is-narrow' : ''}`} tabIndex={-1} onKeyDown={onKey}>
      {showSide && (
        <aside className="tk-side">
          <input
            className="tk-search"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && search.trim() && setPane('main')}
            placeholder="Search"
            aria-label="Search tasks"
            enterKeyHint="search"
          />
          <div className="tk-smart">
            {SMART.map((s) => (
              <button key={s.id} className={`tk-tile ${isSmart(view) && view.smart === s.id && !search ? 'is-on' : ''}`} onClick={() => go({ smart: s.id })} style={{ ['--c' as string]: s.color }}>
                <span className="tk-tile-glyph" aria-hidden>
                  {s.glyph}
                </span>
                <strong>{counts[s.id]}</strong>
                <span>{s.label}</span>
              </button>
            ))}
          </div>
          {lists === null && <p className="ca-hint">Opening your lists…</p>}
          {sources.map((source) => (
            <section key={source} className="tk-lists">
              <h4>{source}</h4>
              {(lists ?? [])
                .filter((l) => l.source === source)
                .map((l) => (
                  <button key={l.id} className={`tk-list ${!isSmart(view) && view.list === l.id && !search ? 'is-on' : ''}`} onClick={() => go({ list: l.id })} onContextMenu={(e) => listMenu(e, l)} title={l.writable ? l.name : `${l.name} (read-only)`}>
                    <span className="tk-dot" style={{ background: l.color }} />
                    <span className="tk-list-name">{l.name}</span>
                    {prefs.hiddenInCalendar.includes(l.id) ? null : <span className="tk-cal-mark" title="Shows in the Calendar" aria-label="Shows in the Calendar">▦</span>}
                    <span className="tk-count">{counts.byList.get(l.id) || ''}</span>
                  </button>
                ))}
            </section>
          ))}
          <div className="tk-side-foot">
            <button className="link-btn" onClick={() => setSheet({ kind: 'list', list: null })}>
              + Add list
            </button>
            <span className="nb-spacer" />
            <button className="ca-icon" onClick={() => void reloadTasks(true)} aria-label="Refresh" title="Refresh (R)">
              ↻
            </button>
            <button className="ca-icon" onClick={() => setSheet({ kind: 'settings' })} aria-label="Settings" title="Settings">
              ⚙
            </button>
          </div>
        </aside>
      )}
      {showMain && (
        <main className="tk-main">
          <header className="tk-head">
            {narrow && (
              <button className="tk-back" onClick={() => (setPane('side'), setSearch(''))} aria-label="Lists">
                ‹ Lists
              </button>
            )}
            <h2 style={{ color: titleColor }}>{title}</h2>
            {loading && <span className="ca-spin" aria-label="Loading" />}
            <span className="nb-spacer" />
            {!(isSmart(view) && view.smart === 'completed') && !isSmart(view) && (
              <button className={`btn btn-small ${prefs.showCompleted ? 'is-on' : ''}`} onClick={() => setTaskPrefs({ showCompleted: !prefs.showCompleted })} title="Show or hide completed tasks">
                {prefs.showCompleted ? 'Hide completed' : 'Show completed'}
              </button>
            )}
            <span className="tk-total">{shownCount}</span>
          </header>
          {problems.length > 0 && (
            <p className="ca-problem">
              {problems.join(' · ')}
              {error && (
                <button className="ca-x" onClick={() => setError(null)} aria-label="Dismiss">
                  ×
                </button>
              )}
            </p>
          )}
          {canAdd && <QuickAdd list={targetList()!} view={view} today={today} short={narrow} onError={setError} onMore={(defaults) => setEditing({ task: null, defaults })} />}
          <TaskRows
            rows={rows}
            lists={listById}
            now={now}
            selected={selected}
            leaving={leaving}
            showList={isSmart(view) || !!search.trim()}
            reorder={!isSmart(view) && !search.trim() && !!currentList?.writable ? currentList : null}
            onSelect={setSelected}
            onOpen={(t) => setEditing({ task: t })}
            onToggle={toggle}
            onMenu={taskMenu}
            onError={setError}
          />
          {lists !== null && taskRows.length === 0 && <p className="tk-none">{search.trim() ? 'Nothing found.' : isSmart(view) && view.smart === 'today' ? 'Nothing due today.' : isSmart(view) && view.smart === 'completed' ? 'Nothing completed yet.' : 'No tasks.'}</p>}
        </main>
      )}
      {editing && (
        <TaskEditor
          key={editing.task?.id ?? 'new'}
          task={editing.task}
          defaults={editing.task ? undefined : { list: editing.defaults?.list ?? targetList()?.id, hasDate: editing.defaults?.hasDate, date: editing.defaults?.date }}
          lists={lists ?? []}
          onClose={() => {
            setEditing(null)
            rootRef.current?.focus({ preventScroll: true })
          }}
        />
      )}
      {sheet?.kind === 'list' && <ListSheet list={sheet.list} onClose={() => setSheet(null)} onMade={(l) => go({ list: l.id })} />}
      {sheet?.kind === 'settings' && <SettingsSheet lists={lists ?? []} onClose={() => setSheet(null)} />}
    </div>
  )
}

/** The new-task line: what is typed, with the date and priority read from its end shown before adding. */
function QuickAdd({ list, view, today, short, onError, onMore }: { list: TaskList; view: View; today: string; short: boolean; onError: (e: string | null) => void; onMore: (defaults: { list: string; hasDate?: boolean; date?: string }) => void }) {
  const [text, setText] = useState('')
  const [plain, setPlain] = useState(false)
  const [busy, setBusy] = useState(false)
  const parsed = useMemo(() => (plain ? { title: text.trim(), priority: 0 } : parseQuick(text)), [text, plain])
  // Today's list makes tasks for today; Priority's, high-priority ones.
  const fallbackDue = isSmart(view) && (view.smart === 'today' || view.smart === 'scheduled') ? today : undefined
  const add = async () => {
    if (!parsed.title || busy) return
    setBusy(true)
    onError(null)
    try {
      await createTask({ title: parsed.title, due: parsed.due ?? fallbackDue, priority: parsed.priority || (isSmart(view) && view.smart === 'priority' ? 1 : 0), listId: list.id })
      setText('')
      setPlain(false)
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const chips = [parsed.due ? `📅 ${dueLabel({ due: parsed.due, allDay: parsed.allDay })}` : fallbackDue && text.trim() ? '📅 Today' : '', parsed.priority ? `${{ 1: '!!!', 5: '!!', 9: '!' }[parsed.priority as 1 | 5 | 9]} priority` : ''].filter(Boolean)
  return (
    <div className="tk-add">
      <span className="tk-check is-ghost" style={{ ['--c' as string]: list.color }} aria-hidden />
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            void add()
          } else if (e.key === 'Escape') {
            setText('')
            ;(e.target as HTMLInputElement).blur()
          }
        }}
        placeholder={short ? `New task in ${list.name}` : `New task in ${list.name} (try "tomorrow 9am" or "fri !!")`}
        aria-label="New task"
        disabled={busy}
      />
      {text.trim() && (parsed.due || parsed.priority) && !plain && (
        <span className="tk-chips">
          {chips.map((c) => (
            <span key={c} className="tk-chip">
              {c}
            </span>
          ))}
          <button className="tk-chip-x" onClick={() => setPlain(true)} title="Keep the words as they are" aria-label="Keep the words as they are">
            ×
          </button>
        </span>
      )}
      <button className="ca-icon" onClick={() => onMore({ list: list.id, ...(fallbackDue ? { hasDate: true, date: fallbackDue } : {}) })} title="New task with details" aria-label="New task with details">
        ⓘ
      </button>
    </div>
  )
}

type RowsProps = {
  rows: Row[]
  lists: Map<string, TaskList>
  now: Date
  selected: string | null
  leaving: Set<string>
  showList: boolean
  /** The list whose tasks can be dragged into another order (none in smart lists) */
  reorder: TaskList | null
  onSelect: (id: string) => void
  onOpen: (t: Task) => void
  onToggle: (t: Task) => void
  onMenu: (ev: MouseEvent, t: Task) => void
  onError: (e: string) => void
}

/** The tasks, and in a list a handle on each top-level one to drag it into another place. */
function TaskRows({ rows, lists, now, selected, leaving, showList, reorder, onSelect, onOpen, onToggle, onMenu, onError }: RowsProps) {
  const boxRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<{ id: string; y0: number; dy: number; to: number } | null>(null)
  const top = rows.filter((r): r is { task: Task; depth: number } => 'task' in r && r.depth === 0 && !r.task.completed)

  // Where a dragged task would land: before the top-level task whose middle is below the pointer.
  const indexAt = (y: number) => {
    const els = top.map((r) => boxRef.current?.querySelector<HTMLElement>(`[data-task="${CSS.escape(r.task.id)}"]`))
    const i = els.findIndex((el) => el && y < el.getBoundingClientRect().top + el.offsetHeight / 2)
    return i < 0 ? top.length : i
  }
  const down = (ev: ReactPointerEvent<HTMLElement>, t: Task) => {
    if (ev.button !== 0) return
    ev.preventDefault()
    ev.stopPropagation()
    ev.currentTarget.setPointerCapture(ev.pointerId)
    setDrag({ id: t.id, y0: ev.clientY, dy: 0, to: top.findIndex((r) => r.task.id === t.id) })
  }
  const move = (ev: ReactPointerEvent<HTMLElement>) => drag && setDrag({ ...drag, dy: ev.clientY - drag.y0, to: indexAt(ev.clientY) })
  const up = () => {
    const d = drag
    setDrag(null)
    if (!d || !reorder) return
    const from = top.findIndex((r) => r.task.id === d.id)
    if (from < 0 || d.to === from || d.to === from + 1) return
    const order = top.map((r) => r.task)
    const [moved] = order.splice(from, 1)
    order.splice(d.to > from ? d.to - 1 : d.to, 0, moved)
    reorderTasks(reorder.id, order, moved).catch((e: Error) => onError(e.message))
  }

  return (
    <div ref={boxRef} className="tk-rows" role="list">
      {rows.map((r) => {
        if ('heading' in r)
          return (
            <h4 key={r.key} className="tk-heading" style={r.color ? { color: r.color } : undefined}>
              {r.heading}
            </h4>
          )
        const t = r.task
        const list = lists.get(t.list)
        const done = t.completed || leaving.has(t.id)
        const overdue = isOverdue(t, now)
        const topIndex = top.findIndex((x) => x.task.id === t.id)
        const dragging = drag?.id === t.id
        return (
          <div
            key={t.id}
            data-task={t.id}
            role="listitem"
            className={`tk-row ${selected === t.id ? 'is-selected' : ''} ${done ? 'is-done' : ''} ${dragging ? 'is-dragging' : ''} ${drag && !dragging && topIndex === drag.to ? 'is-drop-before' : ''} ${drag && !dragging && topIndex === top.length - 1 && drag.to === top.length ? 'is-drop-after' : ''}`}
            style={{ paddingLeft: 10 + r.depth * 26, ...(dragging ? { transform: `translateY(${drag!.dy}px)` } : {}) }}
            onClick={() => onSelect(t.id)}
            onContextMenu={(e) => onMenu(e, t)}
          >
            {reorder && r.depth === 0 && !t.completed ? (
              <span className="tk-grip" onPointerDown={(e) => down(e, t)} onPointerMove={move} onPointerUp={up} onPointerCancel={() => setDrag(null)} aria-label="Drag to reorder" title="Drag to reorder" data-no-touch-menu>
                ⠿
              </span>
            ) : reorder ? (
              <span className="tk-grip is-blank" />
            ) : null}
            <button
              className={`tk-check ${done ? 'is-on' : ''}`}
              style={{ ['--c' as string]: list?.color ?? 'var(--accent)' }}
              onClick={(e) => (e.stopPropagation(), onToggle(t))}
              disabled={!list?.writable}
              role="checkbox"
              aria-checked={done}
              aria-label={done ? `Mark "${t.title}" as not completed` : `Complete "${t.title}"`}
            />
            <div className="tk-body" onClick={() => onOpen(t)}>
              <div className="tk-title">
                {bangs(t) && <span className="tk-bangs">{bangs(t)} </span>}
                {t.title}
              </div>
              {t.notes && <div className="tk-notes">{t.notes.split('\n')[0]}</div>}
              {(t.due || t.repeat || t.url || showList) && (
                <div className="tk-meta">
                  {t.due && <span className={overdue ? 'is-overdue' : ''}>{dueLabel(t, now)}</span>}
                  {t.repeat && <span title={repeatLabel(t.repeat)}>↻ {repeatLabel(t.repeat).replace(/^Every /, '')}</span>}
                  {t.url && (
                    <a
                      href={t.url}
                      onClick={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        openLink(t.url!)
                      }}
                      title={t.url}
                    >
                      🔗 {linkLabel(t.url)}
                    </a>
                  )}
                  {showList && list && (
                    <span className="tk-in">
                      <span className="tk-dot" style={{ background: list.color }} />
                      {list.name}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

const linkLabel = (url: string) => {
  try {
    const u = new URL(url)
    return u.protocol.startsWith('http') ? u.host.replace(/^www\./, '') : u.protocol === 'mailto:' ? u.pathname : 'Mail'
  } catch {
    return url.slice(0, 30)
  }
}

