import { dayKey, startOfDay, type CalendarEvent } from '../../data/calendar'

// Dates for the Calendar app: which days a view shows, its title, and where events go on the
// grid. Everything is in this browser's local time; weeks start on Monday.

export type View = 'day' | '3day' | 'week' | 'month' | 'year'

export const VIEWS: { id: View; label: string; key: string }[] = [
  { id: 'day', label: 'Day', key: 'd' },
  { id: '3day', label: '3 days', key: '3' },
  { id: 'week', label: 'Week', key: 'w' },
  { id: 'month', label: 'Month', key: 'm' },
  { id: 'year', label: 'Year', key: 'y' },
]

export const isView = (v: unknown): v is View => VIEWS.some((x) => x.id === v)

export const MINUTE = 60_000
/** Drags and new events snap to this many minutes. */
export const SNAP = 15

/** Local midnight `n` days after `d`'s day. */
export const addDays = (d: Date, n: number) => startOfDay(d, n)
export const startOfWeek = (d: Date) => startOfDay(d, -((d.getDay() + 6) % 7))
/** "2026-10-09" as local midnight. */
export const parseDay = (key: string) => {
  const [y, m, d] = key.slice(0, 10).split('-').map(Number)
  return new Date(y, m - 1, d)
}
export const sameDay = (a: Date, b: Date) => dayKey(a) === dayKey(b)
/** Minutes since local midnight, by the clock (a daylight saving day still runs 0–1440). */
export const minutesOf = (d: Date) => d.getHours() * 60 + d.getMinutes()
/** `day` at `minutes` past midnight, by the clock. */
export const atMinutes = (day: Date, minutes: number) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, minutes)
export const hhmm = (d: Date) => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

export function isoWeek(d: Date) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7))
  return Math.ceil(((t.getTime() - Date.UTC(t.getUTCFullYear(), 0, 1)) / 864e5 + 1) / 7)
}

/** The days a view shows (none for the year), and the range of events it needs. */
export function viewRange(view: View, anchor: Date): { days: Date[]; from: Date; to: Date } {
  const days = (start: Date, n: number) => Array.from({ length: n }, (_, i) => addDays(start, i))
  if (view === 'year') return { days: [], from: new Date(anchor.getFullYear(), 0, 1), to: new Date(anchor.getFullYear() + 1, 0, 1) }
  const list =
    view === 'day'
      ? days(anchor, 1)
      : view === '3day'
        ? days(anchor, 3)
        : view === 'week'
          ? days(startOfWeek(anchor), 7)
          : days(startOfWeek(new Date(anchor.getFullYear(), anchor.getMonth(), 1)), 42)
  return { days: list, from: list[0], to: addDays(list[list.length - 1], 1) }
}

/** The anchor one page back (-1) or forward (1). */
export function step(view: View, anchor: Date, dir: -1 | 1): Date {
  if (view === 'month') return new Date(anchor.getFullYear(), anchor.getMonth() + dir, 1)
  if (view === 'year') return new Date(anchor.getFullYear() + dir, anchor.getMonth(), 1)
  return addDays(anchor, dir * (view === 'day' ? 1 : view === '3day' ? 3 : 7))
}

export function viewTitle(view: View, anchor: Date, days: Date[]): string {
  if (view === 'year') return String(anchor.getFullYear())
  if (view === 'month') return anchor.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
  if (view === 'day') return anchor.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  const first = days[0]
  const last = days[days.length - 1]
  const range =
    first.getMonth() === last.getMonth()
      ? `${first.getDate()} – ${last.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`
      : `${first.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} – ${last.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`
  return view === 'week' ? `Week ${isoWeek(first)} · ${range}` : range
}

/** Start and end in local milliseconds (all-day dates are local midnights, the end exclusive). */
export function span(e: CalendarEvent): { start: number; end: number } {
  if (e.allDay) return { start: parseDay(e.start).getTime(), end: parseDay(e.end).getTime() }
  return { start: Date.parse(e.start), end: Date.parse(e.end) }
}

/** A timed event's part of one day, in minutes from midnight, beside the ones it overlaps. */
export type Placed = { e: CalendarEvent; top: number; bottom: number; col: number; cols: number; startsBefore: boolean; endsAfter: boolean }

export function layoutDay(events: CalendarEvent[], day: Date): Placed[] {
  const dayStart = day.getTime()
  const dayEnd = addDays(day, 1).getTime()
  const items = events
    .filter((e) => !e.allDay)
    .map((e) => ({ e, ...span(e) }))
    .filter((x) => x.start < dayEnd && (x.end > dayStart || (x.end === x.start && x.start >= dayStart)))
    .map((x) => {
      const s = Math.max(x.start, dayStart)
      const t = Math.min(x.end, dayEnd)
      const top = x.start < dayStart ? 0 : minutesOf(new Date(s))
      const bottom = x.end > dayEnd || t === dayEnd ? 1440 : minutesOf(new Date(t))
      return { e: x.e, top, bottom: Math.max(bottom, top + SNAP), startsBefore: x.start < dayStart, endsAfter: x.end > dayEnd }
    })
    .sort((a, b) => a.top - b.top || b.bottom - a.bottom)
  // Groups of events that overlap one another; in a group, each takes the first free column.
  const out: Placed[] = []
  let group: Placed[] = []
  let columnsEnd: number[] = []
  let groupEnd = -1
  const flush = () => {
    for (const p of group) p.cols = columnsEnd.length
    out.push(...group)
    group = []
    columnsEnd = []
  }
  for (const it of items) {
    if (it.top >= groupEnd) flush()
    let col = columnsEnd.findIndex((end) => end <= it.top)
    if (col < 0) col = columnsEnd.push(it.bottom) - 1
    else columnsEnd[col] = it.bottom
    groupEnd = Math.max(groupEnd, it.bottom)
    group.push({ ...it, col, cols: 0 })
  }
  flush()
  return out
}

/** An all-day event as a bar over days[startCol] up to (not including) days[endCol], in a row. */
export type Bar = { e: CalendarEvent; startCol: number; endCol: number; row: number; startsBefore: boolean; endsAfter: boolean }

/** All-day events over consecutive `days`, stacked into as few rows as fit. */
export function layoutBars(events: CalendarEvent[], days: Date[]): { bars: Bar[]; rows: number } {
  const keys = days.map(dayKey)
  const after = dayKey(addDays(days[days.length - 1], 1))
  const index = (key: string) => {
    const i = keys.findIndex((k) => k >= key)
    return i < 0 ? keys.length : i
  }
  const bars = events
    .filter((e) => e.allDay && e.start.slice(0, 10) < after && e.end.slice(0, 10) > keys[0])
    .map((e) => ({ e, startCol: index(e.start.slice(0, 10)), endCol: index(e.end.slice(0, 10)), row: 0, startsBefore: e.start.slice(0, 10) < keys[0], endsAfter: e.end.slice(0, 10) > after }))
    .filter((b) => b.endCol > b.startCol)
    .sort((a, b) => a.startCol - b.startCol || b.endCol - b.startCol - (a.endCol - a.startCol))
  const rowsEnd: number[] = []
  for (const b of bars) {
    let row = rowsEnd.findIndex((end) => end <= b.startCol)
    if (row < 0) row = rowsEnd.push(b.endCol) - 1
    else rowsEnd[row] = b.endCol
    b.row = row
  }
  return { bars, rows: rowsEnd.length }
}

/** Moves an event by whole days and minutes (by the clock), keeping its length. */
export function moved(e: CalendarEvent, days: number, minutes: number): { start: string; end: string; allDay: boolean } {
  if (e.allDay) return { start: dayKey(addDays(parseDay(e.start), days)), end: dayKey(addDays(parseDay(e.end), days)), allDay: true }
  const { start, end } = span(e)
  const s = new Date(start)
  s.setDate(s.getDate() + days)
  s.setMinutes(s.getMinutes() + minutes)
  return { start: s.toISOString(), end: new Date(s.getTime() + (end - start)).toISOString(), allDay: false }
}
