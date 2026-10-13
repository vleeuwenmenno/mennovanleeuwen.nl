import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import {
  createEvent,
  dayKey,
  deleteEvent,
  eventActions,
  fetchEvents,
  isShown,
  knownUids,
  reloadCalendars,
  setCalendarShown,
  setLastCalendar,
  startOfDay,
  takeEventRequest,
  updateEvent,
  useCalendarChoice,
  useCalendarList,
  useCalendarVersion,
  useLastCalendar,
  type CalendarEvent,
  type CalendarInfo,
} from '../../data/calendar'
import { openContact, useContacts } from '../../data/contacts'
import { blobText } from '../../data/decodeText'
import { importFileOf } from '../../data/fileOps'
import { sameOccurrence } from '../../data/noteEvents'
import { takeImport, isIcsName, type ImportFile } from '../../data/pimFiles'
import { openLink } from '../../data/links'
import { composeMail } from '../../data/mail'
import { completeTask, deleteTask, openTask, setTaskPrefs, updateTask, useTaskPrefs, useTasks } from '../../data/tasks'
import { connectGoogle, hasCalendar, signIn, useAccount } from '../../os/account'
import { openContextMenu, type MenuItem } from '../../os/ContextMenu'
import { choose as askWith } from '../../os/Dialogs'
import { useDropTarget } from '../../os/dnd'
import { notify } from '../../os/notify'
import { useWM, type WinState } from '../../os/wm'
import { BIRTHDAY_COLOR, BIRTHDAYS, birthdayEvents, isBirthdayEvent } from './birthdays'
import { explainIcs, readIcs, type IcsEvent } from './ics'
import { isTaskEvent, taskEvents } from './tasks'
import '../tasks/tasks.css'
import { draftFromEvent, draftFromRange, EventEditor, type Choose, type Draft } from './EventEditor'
import { MonthView } from './MonthView'
import { TimeGrid, type Change } from './TimeGrid'
import { addDays, atMinutes, calendarView, isView, parseDay, step, VIEWS, viewRange, viewTitle, type View } from './time'
import { dayLoad, MiniMonth, YearView } from './YearView'

// The Calendar app: every connected Google and CalDAV calendar in one place, by day, three days,
// week, month or year. Events can be made (click or drag on an empty spot), moved and stretched
// (drag them), changed, moved to another calendar and deleted, with people invited by email;
// Google and the CalDAV server keep them, so they show on your phone too. The calendars ticked in
// the sidebar are the same switches as in Settings → Apps → Calendar. Tasks with a due date show too
// (src/apps/calendar/tasks.ts), per list as switched on under Tasks in the sidebar: tick them
// there, drag them to another day or time, open them in the Tasks app. So do your contacts'
// birthdays (src/apps/calendar/birthdays.ts), and .ics files dropped on it or opened in it are
// imported (props.import takes them: src/data/pimFiles.ts), skipping events it has already.
//
// props.date ("2026-10-09") and props.view open it on a day (from the clock's month), props.event
// with an iCalendar UID opens that event there (an invitation in Mail; props.occurrence picks one
// occurrence of a repeating event, for a note linked to it), and props.compose takes a
// new event to fill in from composeEvent() (Mail's "Create event from this email").

/** The time now, once a minute. */
function useNow() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(t)
  }, [])
  return now
}

type Editing = { event: CalendarEvent | null; draft: Draft }
type Asking = { question: string; verb: string; resolve: (a: 'one' | 'all' | null) => void }

export function CalendarApp({ win }: { win: WinState }) {
  const account = useAccount()
  const wm = useWM()
  const connected = hasCalendar(account)
  const now = useNow()
  const rootRef = useRef<HTMLDivElement>(null)
  const savedView = calendarView.use()
  const [view, setViewState] = useState<View>(() => (isView(win.props.view) ? win.props.view : savedView))
  const [anchor, setAnchor] = useState(() => (win.props.date ? parseDay(win.props.date) : startOfDay(new Date())))
  const [narrow, setNarrow] = useState(false)
  const [sidebar, setSidebar] = useState(true)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [asking, setAsking] = useState<Asking | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [optimistic, setOptimistic] = useState<Record<string, Change | 'deleted'>>({})
  const lastCalendar = useLastCalendar()

  // Opened again on a day (from the clock): go there.
  useEffect(() => {
    if (win.props.date) setAnchor(parseDay(win.props.date))
    if (isView(win.props.view)) setViewState(win.props.view)
  }, [win.props.t]) // eslint-disable-line react-hooks/exhaustive-deps

  // Brought to the front: take the keyboard (unless something else is being typed in).
  useEffect(() => {
    if (wm.focusedPid !== win.pid) return
    const active = document.activeElement
    if (active && active !== document.body && !active.closest('.window')) return
    if (!rootRef.current?.contains(active)) rootRef.current?.focus({ preventScroll: true })
  }, [wm.focusedPid, win.pid])

  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setNarrow(el.clientWidth < 680))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const setView = (v: View) => {
    setViewState(v)
    calendarView.set(v)
  }
  // Picked in Settings → Apps → Calendar (or on another device) while this window is open: follow it.
  const seenView = useRef(savedView)
  useEffect(() => {
    if (savedView === seenView.current) return
    seenView.current = savedView
    setViewState(savedView)
  }, [savedView])
  // A narrow window has no room for seven columns: three days instead.
  const shownView: View = narrow && view === 'week' ? '3day' : view
  const { days, from, to } = useMemo(() => viewRange(shownView, anchor), [shownView, anchor])

  // Events of the ticked calendars, for the range in view.
  const { calendars, errors: listErrors } = useCalendarList()
  const picks = useCalendarChoice()
  const shown = calendars?.filter((c) => isShown(c, picks)).map((c) => c.id) ?? null
  const version = useCalendarVersion()
  const [tick, setTick] = useState(0)
  const [data, setData] = useState<{ events: CalendarEvent[]; errors: string[] } | null>(null)
  const [loading, setLoading] = useState(false)
  const key = `${from.toISOString()}|${to.toISOString()}|${shown?.join(',') ?? '…'}`
  // Past the browser's two-minute cache only when the five-minute refresh asks.
  const askedTick = useRef(0)
  useEffect(() => {
    if (!connected || !shown) return
    let live = true
    setLoading(true)
    const fresh = tick !== askedTick.current
    askedTick.current = tick
    fetchEvents(from, to, shown, fresh)
      .then(
        (r) => live && (setData(r), setOptimistic({})),
        (e: Error) => live && setData({ events: [], errors: [e.message] }),
      )
      .finally(() => live && setLoading(false))
    return () => {
      live = false
    }
  }, [key, connected, version, tick]) // eslint-disable-line react-hooks/exhaustive-deps
  // Every five minutes, and when the tab comes back.
  useEffect(() => {
    const again = () => document.visibilityState === 'visible' && setTick((n) => n + 1)
    const t = setInterval(again, 5 * 60_000)
    document.addEventListener('visibilitychange', again)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', again)
    }
  }, [])

  // Tasks due in the range, from the lists switched on for the calendar.
  const { lists: taskLists, tasks } = useTasks()
  const taskPrefs = useTaskPrefs()
  const dueTasks = useMemo(() => taskEvents(tasks, taskLists ?? [], taskPrefs.hiddenInCalendar, from, to), [tasks, taskLists, taskPrefs.hiddenInCalendar, from, to])

  // Your contacts' birthdays and anniversaries, unless switched off.
  const { contacts } = useContacts()
  const birthdaysOn = picks[BIRTHDAYS] !== false
  const birthdays = useMemo(() => (birthdaysOn ? birthdayEvents(contacts, from, to) : []), [contacts, birthdaysOn, from, to])

  const events = useMemo(
    () => [...(data?.events ?? []), ...birthdays, ...dueTasks].filter((e) => optimistic[e.id] !== 'deleted').map((e) => (optimistic[e.id] ? { ...e, ...(optimistic[e.id] as Change) } : e)),
    [data, birthdays, dueTasks, optimistic],
  )
  const writable = (calendars ?? []).filter((c) => c.writable)

  // Asked from another app: a new event filled in (composeEvent), or an event by its UID.
  const wantedUid = useRef<string | null>(null)
  const wantedOccurrence = useRef<string | null>(null)
  useEffect(() => {
    const req = takeEventRequest(win.props.compose)
    if (req) {
      const allDay = !!req.allDay
      const start = req.start ? new Date(allDay ? `${req.start.slice(0, 10)}T00:00:00` : req.start) : atMinutes(startOfDay(new Date()), (new Date().getHours() + 1) * 60)
      const end = req.end ? new Date(allDay ? `${req.end.slice(0, 10)}T00:00:00` : req.end) : allDay ? addDays(start, 1) : new Date(start.getTime() + 3600_000)
      const draft = draftFromRange(start, end, allDay, defaultCalendar())
      setEditing({ event: null, draft: { ...draft, title: req.title ?? '', guests: req.guests ?? [], description: req.description ?? '', location: req.location ?? '' } })
    }
    wantedUid.current = win.props.event ?? null
    wantedOccurrence.current = win.props.occurrence ?? null
    openWanted()
  }, [win.props.t]) // eslint-disable-line react-hooks/exhaustive-deps
  // The event asked for, once it is in what was fetched (now, or after the day it is on loads).
  const openWanted = () => {
    const occurrence = wantedOccurrence.current
    const e = wantedUid.current ? data?.events.find((x) => x.uid === wantedUid.current && (!occurrence || sameOccurrence(x.occurrence, occurrence))) : null
    if (!e) return
    wantedUid.current = null
    setEditing({ event: e, draft: draftFromEvent(e) })
  }
  useEffect(openWanted, [data]) // eslint-disable-line react-hooks/exhaustive-deps

  const choose: Choose = useCallback((question, verb) => new Promise((resolve) => setAsking({ question, verb, resolve })), [])
  const answer = (a: 'one' | 'all' | null) => {
    asking?.resolve(a)
    setAsking(null)
    rootRef.current?.focus({ preventScroll: true })
  }

  /** The calendar new events go in: the one used last, or your main one. */
  const defaultCalendar = (): string => {
    if (writable.some((c) => c.id === lastCalendar)) return lastCalendar!
    return (writable.find((c) => c.primary) ?? writable[0])?.id ?? ''
  }
  const open = (e: CalendarEvent) => (isTaskEvent(e) ? openTask(e.task.id) : isBirthdayEvent(e) ? openContact(e.person.contact.id) : setEditing({ event: e, draft: draftFromEvent(e) }))
  const create = (start: Date, end: Date, allDay: boolean) => setEditing({ event: null, draft: draftFromRange(start, end, allDay, defaultCalendar()) })
  const newEvent = () => {
    // The next whole hour today, or 09:00 on the day in view.
    const today = dayKey(anchor) === dayKey(now)
    const start = today ? atMinutes(anchor, (now.getHours() + 1) * 60) : atMinutes(anchor, 9 * 60)
    create(start, new Date(start.getTime() + 3600_000), false)
  }

  /** A drag ended: move or stretch the event there (asking first for a repeating one). */
  const change = async (e: CalendarEvent, c: Change) => {
    // A task dragged to another day or time: that is its new due date.
    if (isTaskEvent(e)) {
      setError(null)
      return updateTask(e.task, { due: c.start }).catch((err: Error) => setError(err.message))
    }
    let all = false
    if (e.recurring) {
      const a = await choose('This event repeats. Move only this one, or all of them?', 'Move')
      if (!a) return
      all = a === 'all'
    }
    setOptimistic((o) => ({ ...o, [e.id]: c }))
    setError(null)
    try {
      await updateEvent(e, c, { all })
    } catch (err) {
      setOptimistic(({ [e.id]: _, ...rest }) => rest)
      setError((err as Error).message)
    }
  }

  const remove = async (e: CalendarEvent) => {
    if (isTaskEvent(e)) return deleteTask(e.task).catch((err: Error) => setError(err.message))
    let all = false
    if (e.recurring) {
      const a = await choose('This event repeats. Delete only this one, or all of them?', 'Delete')
      if (!a) return
      all = a === 'all'
    }
    setOptimistic((o) => ({ ...o, [e.id]: 'deleted' }))
    try {
      await deleteEvent(e, all)
    } catch (err) {
      setOptimistic(({ [e.id]: _, ...rest }) => rest)
      setError((err as Error).message)
    }
  }

  const moveTo = async (e: CalendarEvent, calendar: CalendarInfo) => {
    setError(null)
    try {
      await updateEvent(e, { title: e.title, start: e.start, end: e.end, allDay: e.allDay, location: e.location ?? '', description: e.description ?? '', attendees: (e.attendees ?? []).filter((a) => !a.self).map((a) => a.email) }, { calendar: calendar.id })
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const showDay = (d: Date) => {
    setAnchor(startOfDay(d))
    setView('day')
  }

  /** A task's ring ticked in a view. */
  const toggleTask = (e: CalendarEvent) => {
    if (!isTaskEvent(e)) return
    setError(null)
    completeTask(e.task, !e.task.completed).catch((err: Error) => setError(err.message))
  }

  /** Right-click: on an event, what can be done with it; on an empty spot, a new event there. */
  const menu = (ev: MouseEvent, e: CalendarEvent | null, at: Date, allDay: boolean) => {
    const writableTask = e && isTaskEvent(e) && !!taskLists?.find((l) => l.id === e.task.list)?.writable
    const guests = e ? (e.attendees ?? []).filter((a) => !a.self).map((a) => a.email) : []
    if (e && isBirthdayEvent(e)) {
      const email = e.person.contact.emails[0]?.value
      return openContextMenu(ev, [{ label: 'Open contact', onSelect: () => open(e) }, ...(email ? [{ label: `Email ${email}`, onSelect: () => composeMail({ to: [email] }) }] : [])])
    }
    const items: MenuItem[] = e && isTaskEvent(e)
      ? [
          { label: 'Open in Tasks', onSelect: () => openTask(e.task.id) },
          ...(writableTask
            ? [
                { label: e.task.completed ? 'Mark as not completed' : 'Mark as completed', onSelect: () => toggleTask(e) },
                { separator: true as const },
                { label: 'Delete task', danger: true, onSelect: () => void remove(e) },
              ]
            : []),
        ]
      : e
      ? [
          { label: e.editable ? 'Open' : 'Show details', onSelect: () => open(e) },
          ...(e.meet ? [{ label: 'Join the call', onSelect: () => openLink(e.meet!) }] : []),
          ...(e.url ? [{ label: 'Open in Google Calendar', onSelect: () => openLink(e.url!) }] : []),
          ...(guests.length ? [{ label: 'Email guests', onSelect: () => composeMail({ to: guests, subject: e.title }) }] : []),
          // What other apps add (notes linked to it: src/os/noteEventLinks.tsx).
          ...eventActions(e).map((a): MenuItem => (a.submenu ? { label: a.label, submenu: a.submenu(e).map((x) => ({ label: x.label, onSelect: x.run })) } : { label: a.label, onSelect: () => a.run?.(e) })),
          ...(e.editable && !e.recurring && writable.length > 1
            ? [{ label: 'Move to', submenu: writable.map((c) => ({ label: c.name, swatch: c.color, checked: c.id === e.calendarId, disabled: c.id === e.calendarId, onSelect: () => moveTo(e, c) })) }]
            : []),
          ...(e.editable ? [{ separator: true as const }, { label: e.recurring ? 'Delete…' : 'Delete', danger: true, onSelect: () => remove(e) }] : []),
        ]
      : [
          { label: allDay ? 'New all-day event' : `New event at ${at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}`, onSelect: () => (allDay ? create(at, addDays(at, 1), true) : create(at, new Date(at.getTime() + 3600_000), false)) },
          ...(shownView !== 'day' ? [{ label: 'Show this day', onSelect: () => showDay(at) }] : []),
        ]
    openContextMenu(ev, items)
  }

  // .ics files dropped on the calendar (from the computer, Files or the desktop) or opened in it:
  // their events, shown first, imported into the calendar picked. What the picked calendar has
  // already (the same UID) is skipped, so the same file can be imported twice.
  const importIcs = async (files: { name: string; text: string }[]) => {
    const found: IcsEvent[] = []
    const reports = files.map((f) => readIcs(f.text))
    for (const r of reports) found.push(...r.events)
    if (!found.length) return notify({ title: 'Nothing to import', body: explainIcs(files.map((f) => f.name), reports), transient: true })
    if (!writable.length) return notify({ title: 'No calendar to import into', body: 'Connect a calendar that can be written to first', action: { app: 'settings', props: { section: 'integrations', sub: 'calendars' } }, transient: true })
    let target = defaultCalendar()
    const when = (x: IcsEvent) => (x.allDay ? new Date(`${x.start}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : new Date(x.start).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }))
    const answer = await askWith({
      title: found.length === 1 ? 'Import this event?' : `Import ${found.length} events?`,
      body: (
        <div className="ca-import">
          <ul className="ca-import-list">
            {found.slice(0, 12).map((x, i) => (
              <li key={i}>
                <strong>{x.title}</strong>
                <span className="muted">
                  {when(x)}
                  {x.recurrence ? ' · repeats' : ''}
                  {x.location ? ` · ${x.location}` : ''}
                </span>
              </li>
            ))}
            {found.length > 12 && <li className="muted">and {found.length - 12} more</li>}
          </ul>
          <label className="ca-import-into">
            Into
            <select defaultValue={target} onChange={(e) => (target = e.target.value)}>
              {writable.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} · {c.source ?? 'Google'}
                </option>
              ))}
            </select>
          </label>
          <p className="muted">Guests are left out, so nobody is sent an invitation. Events the calendar has already are skipped.</p>
        </div>
      ),
      buttons: [
        { id: 'cancel', label: 'Cancel' },
        { id: 'import', label: 'Import', primary: true },
      ],
    })
    if (answer !== 'import') return
    // Skip what the calendar has (by UID); when that can't be told, import everything.
    let known = new Set<string>()
    let unchecked = false
    const uids = found.flatMap((x) => (x.uid ? [x.uid] : []))
    if (uids.length)
      try {
        known = new Set(await knownUids(target, uids))
      } catch {
        unchecked = true
      }
    const seen = new Set<string>()
    const fresh = found.filter((x) => {
      if (!x.uid) return true
      if (known.has(x.uid) || seen.has(x.uid)) return false
      seen.add(x.uid)
      return true
    })
    const skipped = found.length - fresh.length
    const calendarName = writable.find((c) => c.id === target)?.name
    if (!fresh.length) return notify({ title: 'Nothing new to import', body: `${skipped === 1 ? 'That event is' : `All ${skipped} events are`} in ${calendarName ?? 'the calendar'} already`, transient: true })
    let done = 0
    const failed: string[] = []
    for (const x of fresh) {
      try {
        await createEvent(target, x)
        done++
      } catch (e) {
        failed.push(`${x.title}: ${(e as Error).message}`)
      }
    }
    setLastCalendar(target)
    setAnchor(startOfDay(new Date(fresh[0].allDay ? `${fresh[0].start}T00:00:00` : fresh[0].start)))
    const notes = [skipped ? `${skipped} skipped, already in ${calendarName ?? 'the calendar'}` : '', unchecked ? 'Could not check for events already there' : '', failed.length ? `Not imported: ${failed.slice(0, 3).join('; ')}` : '']
    notify({ title: done === 1 ? 'Imported 1 event' : `Imported ${done} events`, body: [calendarName, ...notes].filter(Boolean).join(' · '), transient: !failed.length && !skipped && !unchecked })
  }
  const textsOf = (files: ImportFile[]) => Promise.all(files.map(async (f) => ({ name: f.name, text: await blobText(await f.read()) })))

  // Opened on files (Files, the desktop, the terminal, Spotlight, Mail): once the calendars are in,
  // the same import as for a drop. With no calendar linked it waits, and the empty view says so.
  const [queued, setQueued] = useState<ImportFile[] | null>(null)
  useEffect(() => {
    const files = takeImport(win.props.import)
    if (files) setQueued(files)
  }, [win.props.t]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!queued || !calendars) return
    setQueued(null)
    void textsOf(queued).then(importIcs).catch((e: Error) => notify({ title: 'Could not read the file', body: e.message, transient: true }))
  }, [queued, calendars]) // eslint-disable-line react-hooks/exhaustive-deps

  useDropTarget(
    rootRef,
    {
      accept: (d) => (d.os || d.items.some((i) => i.kind === 'file' && !i.dir && isIcsName(i.name)) ? 'copy' : null),
      drop: async (d) => {
        const files: ImportFile[] = []
        if (d.os) for (const p of await d.files()) if (isIcsName(p.file.name) || p.file.type === 'text/calendar') files.push({ name: p.file.name, read: async () => p.file })
        for (const i of d.items) if (i.kind === 'file' && !i.dir && isIcsName(i.name)) files.push(importFileOf(i.path))
        if (!files.length) return notify({ title: 'Only .ics files can be imported', transient: true })
        await textsOf(files).then(importIcs).catch((e: Error) => setError(e.message))
      },
    },
    connected,
  )

  const onKey = (e: KeyboardEvent) => {
    if (editing || asking || e.metaKey || e.ctrlKey || e.altKey) return
    if ((e.target as HTMLElement).closest('input, textarea, select')) return
    const v = VIEWS.find((x) => x.key === e.key.toLowerCase())
    if (v) setView(v.id)
    else if (e.key === 't') setAnchor(startOfDay(new Date()))
    else if (e.key === 'r') reloadCalendars()
    else if (e.key === 'n' || e.key === 'c') newEvent()
    else if (e.key === 'ArrowLeft' || e.key === 'j' || e.key === 'p') setAnchor(step(shownView, anchor, -1))
    else if (e.key === 'ArrowRight' || e.key === 'k') setAnchor(step(shownView, anchor, 1))
    else return
    e.preventDefault()
  }

  if (account.status !== 'user' || !connected)
    return (
      <div className="ca ca-empty">
        <div className="ca-empty-box">
          <span className="ca-empty-glyph">📅</span>
          <h3>Calendar</h3>
          {account.status !== 'user' ? (
            <>
              <p className="muted">Your calendars show here once you sign in.</p>
              {account.status === 'anon' && (
                <button className="btn btn-primary" onClick={signIn}>
                  Sign in with GitHub
                </button>
              )}
            </>
          ) : (
            <>
              {queued && (
                <p className="ca-empty-note">
                  <strong>{queued.length === 1 ? queued[0].name : `${queued.length} files`}</strong> can be imported once a calendar is linked: connect one below (Integrations), and the import starts.
                </p>
              )}
              <p className="muted">Connect Google Calendar, Fastmail or another CalDAV calendar to see and plan your days here.</p>
              <div className="ca-connect">
                {account.googleEnabled && (
                  <button className="btn" onClick={connectGoogle}>
                    Google Calendar
                  </button>
                )}
                <button className="btn" onClick={() => wm.open('settings', { section: 'integrations', sub: 'calendars', t: String(Date.now()) })}>
                  {queued ? 'Integrations…' : 'Fastmail / CalDAV…'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    )

  const problems = [error, ...listErrors, ...(data?.errors ?? [])].filter(Boolean)
  const sources = [...new Set((calendars ?? []).map((c) => c.source ?? 'Google'))]

  return (
    <div ref={rootRef} className={`ca ${narrow ? 'is-narrow' : ''}`} tabIndex={-1} onKeyDown={onKey}>
      <header className="ca-toolbar">
        <button className={`ca-icon ${sidebar && !narrow ? 'is-on' : ''}`} onClick={() => setSidebar((s) => !s)} aria-label="Show the sidebar" title="Sidebar">
          ☰
        </button>
        <button className="btn btn-small" onClick={() => setAnchor(startOfDay(new Date()))} title="Today (T)">
          Today
        </button>
        <button className="ca-icon" onClick={reloadCalendars} aria-label="Refresh" title="Refresh (R)">
          ↻
        </button>
        <button className="ca-icon" onClick={() => setAnchor(step(shownView, anchor, -1))} aria-label="Previous" title="Previous (←)">
          ‹
        </button>
        <button className="ca-icon" onClick={() => setAnchor(step(shownView, anchor, 1))} aria-label="Next" title="Next (→)">
          ›
        </button>
        <h2 className="ca-heading">{viewTitle(shownView, anchor, days)}</h2>
        {loading && <span className="ca-spin" aria-label="Loading" />}
        <span className="nb-spacer" />
        <div className="ca-views" role="tablist" aria-label="View">
          {VIEWS.filter((v) => !(narrow && v.id === 'week')).map((v) => (
            <button key={v.id} role="tab" aria-selected={shownView === v.id} className={shownView === v.id ? 'is-on' : ''} onClick={() => setView(v.id)} title={`${v.label} (${v.key.toUpperCase()})`}>
              {v.label}
            </button>
          ))}
        </div>
        <button className="btn btn-small btn-primary" onClick={newEvent} title="New event (N)">
          + New
        </button>
      </header>
      {problems.length > 0 && (
        <p className="ca-problem">
          {problems.join(' · ')}
          {problems.some((p) => /connect (Google Calendar )?again/i.test(p!)) && (
            <button className="link-btn" onClick={connectGoogle}>
              Connect Google again
            </button>
          )}
          {error && (
            <button className="ca-x" onClick={() => setError(null)} aria-label="Dismiss">
              ×
            </button>
          )}
        </p>
      )}
      <div className="ca-main">
        {sidebar && !narrow && (
          <aside className="ca-side">
            <SideMonth anchor={anchor} now={now} range={shownView === 'month' || shownView === 'year' ? null : [from, to]} events={events} onDay={(d) => (shownView === 'month' || shownView === 'year' ? showDay(d) : setAnchor(d))} />
            {sources.map((source) => (
              <section key={source} className="ca-cals">
                <h4>{source}</h4>
                {(calendars ?? [])
                  .filter((c) => (c.source ?? 'Google') === source)
                  .map((c) => (
                    <label key={c.id} className="ca-cal" title={c.writable ? c.name : `${c.name} (read-only)`}>
                      <input type="checkbox" checked={isShown(c, picks)} onChange={(e) => setCalendarShown(c.id, e.target.checked)} style={{ accentColor: c.color }} />
                      <span className="ca-cal-name">{c.name}</span>
                      {!c.writable && <span className="ca-ro">read-only</span>}
                    </label>
                  ))}
              </section>
            ))}
            <section className="ca-cals">
              <h4>Contacts</h4>
              <label className="ca-cal" title="Your contacts' birthdays and anniversaries (read-only)">
                <input type="checkbox" checked={birthdaysOn} onChange={(e) => setCalendarShown(BIRTHDAYS, e.target.checked)} style={{ accentColor: BIRTHDAY_COLOR }} />
                <span className="ca-cal-name">Birthdays</span>
                <span className="ca-ro">read-only</span>
              </label>
            </section>
            {!!taskLists?.length && (
              <section className="ca-cals">
                <h4>Tasks</h4>
                {taskLists.map((l) => (
                  <label key={l.id} className="ca-cal" title={`${l.name} · ${l.source}`}>
                    <input
                      type="checkbox"
                      checked={!taskPrefs.hiddenInCalendar.includes(l.id)}
                      onChange={(e) => setTaskPrefs({ hiddenInCalendar: e.target.checked ? taskPrefs.hiddenInCalendar.filter((x) => x !== l.id) : [...taskPrefs.hiddenInCalendar, l.id] })}
                      style={{ accentColor: l.color }}
                    />
                    <span className="ca-cal-name">{l.name}</span>
                  </label>
                ))}
              </section>
            )}
            {account.google && !account.google.canWrite && (
              <p className="ca-hint">
                Google is connected read-only.{' '}
                <button className="link-btn" onClick={connectGoogle}>
                  Connect again
                </button>{' '}
                to add and change events there.
              </p>
            )}
            <button className="link-btn ca-settings" onClick={() => wm.open('settings', { section: 'calendar', t: String(Date.now()) })}>
              Calendar settings
            </button>
          </aside>
        )}
        <div className="ca-view">
          {shownView === 'year' ? (
            <YearView
              year={anchor.getFullYear()}
              events={events}
              now={now}
              onDay={showDay}
              onMonth={(d) => {
                setAnchor(d)
                setView('month')
              }}
            />
          ) : shownView === 'month' ? (
            <MonthView days={days} month={anchor.getMonth()} events={events} now={now} onOpen={open} onCreate={create} onChange={change} onDay={showDay} onMenu={menu} onToggle={toggleTask} />
          ) : (
            <TimeGrid days={days} events={events} now={now} onOpen={open} onCreate={create} onChange={change} onDay={showDay} onMenu={menu} onToggle={toggleTask} />
          )}
        </div>
      </div>
      {editing && (
        <EventEditor
          key={editing.event?.id ?? `new-${editing.draft.startDate}-${editing.draft.startTime}`}
          event={editing.event}
          initial={editing.draft}
          calendars={calendars ?? []}
          googleCanWrite={!!account.google?.canWrite}
          choose={choose}
          onClose={() => {
            setEditing(null)
            rootRef.current?.focus({ preventScroll: true })
          }}
        />
      )}
      {asking && (
        <div className="ca-sheet-back ca-ask-back" onPointerDown={(e) => e.target === e.currentTarget && answer(null)}>
          <div className="ca-ask" role="alertdialog" aria-label={asking.question} onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), answer(null))}>
            <p>{asking.question}</p>
            <div className="ca-ask-buttons">
              <button className="btn btn-small" onClick={() => answer(null)}>
                Cancel
              </button>
              <button className="btn btn-small" onClick={() => answer('all')}>
                {asking.verb} all
              </button>
              <button className="btn btn-small btn-primary" onClick={() => answer('one')} autoFocus>
                Only this one
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** The sidebar's month, following the day in view, with its own arrows. */
function SideMonth({ anchor, now, range, events, onDay }: { anchor: Date; now: Date; range: [Date, Date] | null; events: CalendarEvent[]; onDay: (d: Date) => void }) {
  const [month, setMonth] = useState(() => new Date(anchor.getFullYear(), anchor.getMonth(), 1))
  useEffect(() => setMonth(new Date(anchor.getFullYear(), anchor.getMonth(), 1)), [anchor])
  const load = useMemo(() => dayLoad(events), [events])
  return (
    <div className="ca-side-month">
      <div className="ca-side-month-head">
        <strong>{month.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}</strong>
        <button className="ca-icon" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} aria-label="Previous month">
          ‹
        </button>
        <button className="ca-icon" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} aria-label="Next month">
          ›
        </button>
      </div>
      <MiniMonth month={month} now={now} load={load} selected={range ?? undefined} onDay={onDay} />
    </div>
  )
}
