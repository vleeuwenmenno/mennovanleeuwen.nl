import { useEffect, useState, useSyncExternalStore } from 'react'
import { api, hasCalendar, useAccount, type Account } from '../os/account'
import { synced } from '../os/synced'

// Calendar events for the browser (server/calendars.ts talks to Google and CalDAV): the Agenda
// widget, the clock and the Calendar app read them through here, and the Calendar app changes
// them. Days are this browser's local days, so "today" is today where you are, not on the server.

export type Attendee = { email: string; name?: string; status?: 'accepted' | 'declined' | 'tentative' | 'needs-action'; organizer?: boolean; self?: boolean }
export type CalendarEvent = {
  id: string
  calendarId: string
  calendar: string
  color: string
  title: string
  /** ISO times, or "YYYY-MM-DD" dates for all-day events (end exclusive). */
  start: string
  end: string
  allDay: boolean
  location?: string
  description?: string
  url?: string
  meet?: string
  attendees?: Attendee[]
  /** One occurrence of a repeating event. */
  recurring?: boolean
  editable?: boolean
  /** Where it lives, for the server: sent back with a change. */
  ref?: string
}

const CACHE_MS = 2 * 60_000
/** Events, and per-source problems (an expired Google link, a refused app password) to show beside them. */
export type CalendarEvents = { events: CalendarEvent[]; errors: string[] }

const cache = new Map<string, { at: number; value: Promise<CalendarEvents> }>()

/** Local midnight of `d`, `plus` days later. */
export const startOfDay = (d: Date, plus = 0) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + plus)

/** "2026-10-09" for a local date. */
export const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

// After a change, everyone showing events asks again.
let version = 0
const versionListeners = new Set<() => void>()
function calendarChanged() {
  cache.clear()
  version++
  for (const l of versionListeners) l()
}
/** Goes up after every change made here: put it in an effect's dependencies to fetch again. */
export const useCalendarVersion = () =>
  useSyncExternalStore(
    (l) => {
      versionListeners.add(l)
      return () => versionListeners.delete(l)
    },
    () => version,
  )

/** Events from `from` up to `to`, from the given calendars (default: those shown in Google Calendar). */
export function fetchEvents(from: Date, to: Date, calendars: string[] | null = null, fresh = false): Promise<CalendarEvents> {
  // Every calendar switched off: nothing to ask for (an empty list would mean "the defaults").
  if (calendars && calendars.length === 0) return Promise.resolve({ events: [], errors: [] })
  const params = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() })
  if (calendars) params.set('calendars', calendars.join(','))
  const key = params.toString()
  const hit = cache.get(key)
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.value
  const value = api<CalendarEvents>(`/api/calendar/events?${key}`)
  cache.set(key, { at: Date.now(), value })
  value.catch(() => cache.delete(key))
  return value
}

/** The events on one local day: timed ones that start that day, all-day ones that cover it. */
export function eventsOn(events: CalendarEvent[], key: string): CalendarEvent[] {
  return events.filter((e) => (e.allDay ? key >= e.start.slice(0, 10) && key < e.end.slice(0, 10) : dayKey(new Date(e.start)) === key))
}

export const eventTime = (e: CalendarEvent) => (e.allDay ? 'all day' : new Date(e.start).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }))

// ---------------------------------------------------------------------------------------------
// Which calendars show: one switch per calendar in Settings → Calendar, for the clock and every
// Agenda widget that doesn't pick its own. Until switched, Google calendars follow Google
// Calendar's own "shown" setting and CalDAV ones are on. Synced with the account.

export type CalendarInfo = { id: string; name: string; color: string; primary: boolean; selected: boolean; writable?: boolean; source?: string }

const choice = synced<Record<string, boolean>>('calendar-choice', {}, { normalize: (v) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, boolean>) : {}) })

export const useCalendarChoice = choice.use
export const setCalendarShown = (id: string, shown: boolean) => choice.set((c) => ({ ...c, [id]: shown }))
export const isShown = (c: CalendarInfo, picks: Record<string, boolean>) => picks[c.id] ?? (c.source && c.source !== 'Google' ? true : c.selected)

// The connected calendars, asked again when the connected accounts change.
let listCache: { signature: string; value: Promise<{ calendars: CalendarInfo[]; errors: string[] }> } | null = null
const signatureOf = (a: Account) => `${a.google?.email ?? ''}${a.google?.canWrite ? '+w' : ''}|${a.caldav.map((c) => `${c.id}:${c.username}`).join(',')}`

export function calendarList(a: Account) {
  const signature = signatureOf(a)
  if (listCache?.signature !== signature) {
    const value = api<{ calendars: CalendarInfo[]; errors: string[] }>('/api/calendar/calendars')
    listCache = { signature, value }
    value.catch(() => (listCache = null))
  }
  return listCache.value
}

/** Every connected calendar (null while loading), and per-source problems. */
export function useCalendarList(): { calendars: CalendarInfo[] | null; errors: string[] } {
  const account = useAccount()
  const connected = hasCalendar(account)
  const signature = signatureOf(account)
  const [state, setState] = useState<{ signature: string; calendars: CalendarInfo[] | null; errors: string[] }>({ signature: '', calendars: null, errors: [] })
  useEffect(() => {
    if (!connected) return
    let live = true
    calendarList(account).then(
      (r) => live && setState({ signature, calendars: r.calendars, errors: r.errors }),
      (e: Error) => live && setState({ signature, calendars: [], errors: [e.message] }),
    )
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, signature])
  return connected && state.signature === signature ? state : { calendars: null, errors: [] }
}

/** The ids of the calendars switched on in Settings (null while the list loads). */
export function useShownCalendarIds(): string[] | null {
  const { calendars } = useCalendarList()
  const picks = useCalendarChoice()
  return calendars ? calendars.filter((c) => isShown(c, picks)).map((c) => c.id) : null
}

// ---------------------------------------------------------------------------------------------
// Changes, from the Calendar app. Google and CalDAV send invitations to the guests themselves.

/** A new or changed event: ISO times, or "YYYY-MM-DD" dates when all day (end exclusive). */
export type EventInput = { title: string; start: string; end: string; allDay: boolean; location?: string; description?: string; attendees?: string[] }

const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone

async function change(method: 'POST' | 'PATCH' | 'DELETE', body: Record<string, unknown>) {
  try {
    await api('/api/calendar/events', { method, json: body })
  } finally {
    // Also after a failure: what is there may have changed.
    calendarChanged()
  }
}

export const createEvent = (calendar: string, event: EventInput) => change('POST', { calendar, event: { ...event, timeZone: timeZone() } })

/** Changes an event; `all` for every occurrence of a repeating one; `calendar` moves it there. */
export const updateEvent = (e: CalendarEvent, event: Partial<EventInput>, opts: { all?: boolean; calendar?: string } = {}) =>
  change('PATCH', { ref: e.ref, event: { ...event, timeZone: timeZone() }, all: !!opts.all, calendar: opts.calendar })

export const deleteEvent = (e: CalendarEvent, all = false) => change('DELETE', { ref: e.ref, all })

// The calendar new events go in unless picked otherwise: the one used last.
const lastCalendar = synced<string | null>('calendar-default', null, { normalize: (v) => (typeof v === 'string' ? v : null) })
export const useLastCalendar = lastCalendar.use
export const setLastCalendar = (id: string) => lastCalendar.set(id)
