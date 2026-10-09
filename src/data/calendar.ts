import { useEffect, useState } from 'react'
import { api, hasCalendar, useAccount, type Account } from '../os/account'
import { synced } from '../os/synced'

// Google Calendar events for the browser (server/google.ts does the talking to Google): the
// Agenda widget and the clock's calendar both read them through here. Days are this browser's
// local days, so "today" is today where you are, not on the server.

export type CalendarEvent = { id: string; calendar: string; color: string; title: string; start: string; end: string; allDay: boolean; location?: string; url?: string; meet?: string }

const CACHE_MS = 2 * 60_000
/** Events, and per-source problems (an expired Google link, a refused app password) to show beside them. */
export type CalendarEvents = { events: CalendarEvent[]; errors: string[] }

const cache = new Map<string, { at: number; value: Promise<CalendarEvents> }>()

/** Local midnight of `d`, `plus` days later. */
export const startOfDay = (d: Date, plus = 0) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + plus)

/** "2026-10-09" for a local date. */
export const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

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

export type CalendarInfo = { id: string; name: string; color: string; primary: boolean; selected: boolean; source?: string }

const choice = synced<Record<string, boolean>>('calendar-choice', {}, { normalize: (v) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, boolean>) : {}) })

export const useCalendarChoice = choice.use
export const setCalendarShown = (id: string, shown: boolean) => choice.set((c) => ({ ...c, [id]: shown }))
export const isShown = (c: CalendarInfo, picks: Record<string, boolean>) => picks[c.id] ?? (c.source && c.source !== 'Google' ? true : c.selected)

// The connected calendars, asked again when the connected accounts change.
let listCache: { signature: string; value: Promise<{ calendars: CalendarInfo[]; errors: string[] }> } | null = null
const signatureOf = (a: Account) => `${a.google?.email ?? ''}|${a.caldav.map((c) => c.id).join(',')}`

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
