import { useEffect, useState, type CSSProperties } from 'react'
import { dayKey, eventsOn, eventTime, fetchEvents, isShown, startOfDay, useCalendarChoice, useCalendarList, useShownCalendarIds, type CalendarEvent } from '../data/calendar'
import { connectGoogle, hasCalendar, signIn, useAccount } from '../os/account'
import type { MenuItem } from '../os/ContextMenu'
import { useWindowMenu } from '../os/windowMenu'
import { useWM, type WinState } from '../os/wm'
import { createWithTilt, setWidgetConfig, tiltMenu, useWidgetConfig } from './config'
import type { WidgetDef } from './types'

// The Agenda widget: today and the coming days from Google Calendar and CalDAV accounts
// (server/calendars.ts): the calendars switched on in Settings, or its own pick. Owner only: it
// needs the GitHub sign-in with a calendar connected (Settings → Calendar).

type Config = { calendars: string[] | null; days: number; tilt: number }
const DEFAULTS: Config = { calendars: null, days: 3, tilt: 0 }

function useEvents(config: Config, enabled: boolean) {
  const [events, setEvents] = useState<CalendarEvent[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  // Its own pick, or what Settings has switched on (known once the calendar list is in).
  const shown = useShownCalendarIds()
  const ids = config.calendars ?? shown
  const key = `${ids?.join(',') ?? '…'}|${config.days}`
  useEffect(() => {
    if (!enabled || !ids) return
    let live = true
    const today = startOfDay(new Date())
    fetchEvents(today, startOfDay(today, config.days), ids, tick > 0).then(
      // Events from what works, and what didn't (named after the account) beside them.
      (r) => live && (setEvents(r.events), setError(r.errors.join(' · ') || null)),
      (e: Error) => live && setError(e.message),
    )
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, tick])
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
  return { events, error }
}


function dayLabel(key: string) {
  const today = new Date()
  const tomorrow = new Date(today.getTime() + 864e5)
  if (key === dayKey(today)) return 'Today'
  if (key === dayKey(tomorrow)) return 'Tomorrow'
  return new Date(`${key}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' })
}

/** Events by day; an all-day event spanning days shows on each of them in range. */
function byDay(events: CalendarEvent[], days: number): [string, CalendarEvent[]][] {
  const today = startOfDay(new Date())
  return Array.from({ length: days }, (_, i) => {
    const key = dayKey(startOfDay(today, i))
    return [key, eventsOn(events, key)]
  })
}

export function Agenda({ id }: { win: WinState; id: string }) {
  const account = useAccount()
  const config = useWidgetConfig<Config>(id, DEFAULTS)
  const connected = hasCalendar(account)
  const { events, error } = useEvents(config, connected)
  const windowMenu = useWindowMenu()
  const wm = useWM()
  const [, setNow] = useState(0)
  // Keep "now" fresh so past events dim on time.
  useEffect(() => {
    const t = setInterval(() => setNow((n) => n + 1), 60_000)
    return () => clearInterval(t)
  }, [])

  const head = (
    <div className="ag-head">
      <strong>Agenda</strong>
      <button className="sticky-btn" onClick={windowMenu} title="More" aria-label="Agenda menu">
        ⋯
      </button>
    </div>
  )

  if (account.status !== 'user')
    return (
      <div className="ag">
        {head}
        <p className="ag-note">
          Your calendar shows here once you sign in.{' '}
          {account.status === 'anon' && (
            <button className="link-btn" onClick={signIn}>
              Sign in with GitHub
            </button>
          )}
        </p>
      </div>
    )
  if (!connected)
    return (
      <div className="ag">
        {head}
        <p className="ag-note">Connect a calendar (Google, or Fastmail and other CalDAV) to see what is coming up.</p>
        <div className="ag-connect">
          {account.googleEnabled && (
            <button className="btn btn-small" onClick={connectGoogle}>
              📅 Google Calendar
            </button>
          )}
          <button className="btn btn-small" onClick={() => wm.open('settings', { section: 'calendar', t: String(Date.now()) })}>
            🗓 Fastmail / CalDAV
          </button>
        </div>
      </div>
    )

  const now = Date.now()
  return (
    <div className="ag">
      {head}
      {error && <p className="ag-note t-red">{error}</p>}
      {!events && !error && <p className="ag-note">Opening your calendar…</p>}
      {events &&
        byDay(events, config.days).map(([key, list]) => (
          <section key={key} className="ag-day">
            <h4>{dayLabel(key)}</h4>
            {list.length === 0 && <p className="ag-empty">Nothing planned</p>}
            {list.map((e) => {
              const past = !e.allDay && new Date(e.end).getTime() < now
              const live = !e.allDay && new Date(e.start).getTime() <= now && !past
              return (
                <div key={e.id + key} className={`ag-event ${past ? 'is-past' : ''} ${live ? 'is-now' : ''}`} title={`${e.calendar}${e.location ? ` · ${e.location}` : ''}`}>
                  <span className="ag-dot" style={{ background: e.color }} />
                  <span className="ag-time">{eventTime(e)}</span>
                  <a className="ag-title" href={e.url} target="_blank" rel="noopener noreferrer">
                    {e.title}
                  </a>
                  {e.meet && (
                    <a className="ag-meet" href={e.meet} target="_blank" rel="noopener noreferrer" title="Join the video call">
                      🎥
                    </a>
                  )}
                </div>
              )
            })}
          </section>
        ))}
    </div>
  )
}

function useAgendaFrame(id: string): CSSProperties {
  const { tilt } = useWidgetConfig<Config>(id, DEFAULTS)
  return { ['--widget-bg' as string]: 'linear-gradient(175deg, #ffffff 0%, #f1efe8 100%)', ['--widget-fg' as string]: '#262626', ['--widget-tilt' as string]: `${tilt}deg` }
}

function useAgendaMenu(id: string): MenuItem[] {
  const config = useWidgetConfig<Config>(id, DEFAULTS)
  const list = useCalendarList().calendars ?? []
  const picks = useCalendarChoice()
  const chosen = config.calendars ?? list.filter((c) => isShown(c, picks)).map((c) => c.id)
  const multiSource = new Set(list.map((c) => c.source)).size > 1
  const toggle = (cid: string) => setWidgetConfig(id, { calendars: chosen.includes(cid) ? chosen.filter((x) => x !== cid) : [...chosen, cid] })
  return [
    { label: 'Show', submenu: ([[1, 'Today'], [3, 'Three days'], [7, 'A week']] as const).map(([days, label]) => ({ label, checked: config.days === days, onSelect: () => setWidgetConfig(id, { days }) })) },
    ...(list.length
      ? [
          {
            label: 'Calendars',
            submenu: [
              ...list.map((c) => ({ label: multiSource ? `${c.name} · ${c.source}` : c.name, swatch: c.color, checked: chosen.includes(c.id), onSelect: () => toggle(c.id) })),
              { separator: true as const },
              { label: 'As in Settings', checked: config.calendars === null, onSelect: () => setWidgetConfig(id, { calendars: null }) },
            ],
          },
        ]
      : []),
    { label: 'Open Google Calendar ↗', onSelect: () => window.open('https://calendar.google.com', '_blank', 'noopener') },
    tiltMenu(id, config.tilt),
  ]
}

export const agendaWidget: WidgetDef = {
  kind: 'agenda',
  name: 'Agenda',
  blurb: 'Today and the coming days from Google Calendar, Fastmail and other CalDAV',
  glyph: '📅',
  size: [300, 320],
  resizable: true,
  Component: Agenda,
  useFrame: useAgendaFrame,
  useMenu: useAgendaMenu,
  create: createWithTilt,
}
