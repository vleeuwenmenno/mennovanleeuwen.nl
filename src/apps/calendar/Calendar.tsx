import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import {
  dayKey,
  deleteEvent,
  fetchEvents,
  isShown,
  setCalendarShown,
  startOfDay,
  updateEvent,
  useCalendarChoice,
  useCalendarList,
  useCalendarVersion,
  useLastCalendar,
  type CalendarEvent,
  type CalendarInfo,
} from '../../data/calendar'
import { connectGoogle, hasCalendar, signIn, useAccount } from '../../os/account'
import { openContextMenu, type MenuItem } from '../../os/ContextMenu'
import { synced } from '../../os/synced'
import { openLink } from '../../data/links'
import { useWM, type WinState } from '../../os/wm'
import { draftFromEvent, draftFromRange, EventEditor, type Choose, type Draft } from './EventEditor'
import { MonthView } from './MonthView'
import { TimeGrid, type Change } from './TimeGrid'
import { addDays, atMinutes, isView, parseDay, step, VIEWS, viewRange, viewTitle, type View } from './time'
import { dayLoad, MiniMonth, YearView } from './YearView'

// The Calendar app: every connected Google and CalDAV calendar in one place, by day, three days,
// week, month or year. Events can be made (click or drag on an empty spot), moved and stretched
// (drag them), changed, moved to another calendar and deleted, with people invited by email;
// Google and the CalDAV server keep them, so they show on your phone too. The calendars ticked in
// the sidebar are the same switches as in Settings → Calendar.
//
// props.date ("2026-10-09") and props.view open it on a day (from the clock's month).

const viewPref = synced<View>('calendar-view', 'week', { normalize: (v) => (isView(v) ? v : 'week') })

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
  const savedView = viewPref.use()
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
    viewPref.set(v)
  }
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

  const events = useMemo(
    () => (data?.events ?? []).filter((e) => optimistic[e.id] !== 'deleted').map((e) => (optimistic[e.id] ? { ...e, ...(optimistic[e.id] as Change) } : e)),
    [data, optimistic],
  )
  const writable = (calendars ?? []).filter((c) => c.writable)

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
  const open = (e: CalendarEvent) => setEditing({ event: e, draft: draftFromEvent(e) })
  const create = (start: Date, end: Date, allDay: boolean) => setEditing({ event: null, draft: draftFromRange(start, end, allDay, defaultCalendar()) })
  const newEvent = () => {
    // The next whole hour today, or 09:00 on the day in view.
    const today = dayKey(anchor) === dayKey(now)
    const start = today ? atMinutes(anchor, (now.getHours() + 1) * 60) : atMinutes(anchor, 9 * 60)
    create(start, new Date(start.getTime() + 3600_000), false)
  }

  /** A drag ended: move or stretch the event there (asking first for a repeating one). */
  const change = async (e: CalendarEvent, c: Change) => {
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

  /** Right-click: on an event, what can be done with it; on an empty spot, a new event there. */
  const menu = (ev: MouseEvent, e: CalendarEvent | null, at: Date, allDay: boolean) => {
    const items: MenuItem[] = e
      ? [
          { label: e.editable ? 'Open' : 'Show details', onSelect: () => open(e) },
          ...(e.meet ? [{ label: 'Join the call', onSelect: () => openLink(e.meet!) }] : []),
          ...(e.url ? [{ label: 'Open in Google Calendar', onSelect: () => openLink(e.url!) }] : []),
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

  const onKey = (e: KeyboardEvent) => {
    if (editing || asking || e.metaKey || e.ctrlKey || e.altKey) return
    if ((e.target as HTMLElement).closest('input, textarea, select')) return
    const v = VIEWS.find((x) => x.key === e.key.toLowerCase())
    if (v) setView(v.id)
    else if (e.key === 't') setAnchor(startOfDay(new Date()))
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
              <p className="muted">Connect Google Calendar, Fastmail or another CalDAV calendar to see and plan your days here.</p>
              <div className="ca-connect">
                {account.googleEnabled && (
                  <button className="btn" onClick={connectGoogle}>
                    Google Calendar
                  </button>
                )}
                <button className="btn" onClick={() => wm.open('settings', { section: 'calendar', t: String(Date.now()) })}>
                  Fastmail / CalDAV…
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
            <MonthView days={days} month={anchor.getMonth()} events={events} now={now} onOpen={open} onCreate={create} onChange={change} onDay={showDay} onMenu={menu} />
          ) : (
            <TimeGrid days={days} events={events} now={now} onOpen={open} onCreate={create} onChange={change} onDay={showDay} onMenu={menu} />
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
