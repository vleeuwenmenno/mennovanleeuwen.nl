import { api } from '../os/account'

// Google Calendar events for the browser (server/google.ts does the talking to Google): the
// Agenda widget and the clock's calendar both read them through here. Days are this browser's
// local days, so "today" is today where you are, not on the server.

export type CalendarEvent = { id: string; calendar: string; color: string; title: string; start: string; end: string; allDay: boolean; location?: string; url?: string; meet?: string }

const CACHE_MS = 2 * 60_000
const cache = new Map<string, { at: number; value: Promise<CalendarEvent[]> }>()

/** Local midnight of `d`, `plus` days later. */
export const startOfDay = (d: Date, plus = 0) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + plus)

/** "2026-10-09" for a local date. */
export const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** Events from `from` up to `to`, from the given calendars (default: those shown in Google Calendar). */
export function fetchEvents(from: Date, to: Date, calendars: string[] | null = null, fresh = false): Promise<CalendarEvent[]> {
  const params = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() })
  if (calendars) params.set('calendars', calendars.join(','))
  const key = params.toString()
  const hit = cache.get(key)
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.value
  const value = api<CalendarEvent[]>(`/api/calendar/events?${key}`)
  cache.set(key, { at: Date.now(), value })
  value.catch(() => cache.delete(key))
  return value
}

/** The events on one local day: timed ones that start that day, all-day ones that cover it. */
export function eventsOn(events: CalendarEvent[], key: string): CalendarEvent[] {
  return events.filter((e) => (e.allDay ? key >= e.start.slice(0, 10) && key < e.end.slice(0, 10) : dayKey(new Date(e.start)) === key))
}

export const eventTime = (e: CalendarEvent) => (e.allDay ? 'all day' : new Date(e.start).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }))
