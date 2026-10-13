import type { EventInput } from '../../data/calendar'

// Reading .ics files (dropped on the Calendar app) far enough to import their events: the
// title, when (a day, a UTC time, or a time in its TZID), where, the notes and how it repeats.
// Guests are left out on purpose: adding them would send everyone an invitation from you.

export type IcsEvent = EventInput & { recurrence?: string; uid?: string }

/** What reading an .ics found: the events it could import, how many events it held, and why the rest were left out. */
export type IcsReport = { events: IcsEvent[]; found: number; unreadable: string[] }

/** Content lines, unfolded: NAME;PARAM=a;PARAM="b:c":value. */
function lines(text: string): { name: string; params: Record<string, string>; value: string }[] {
  const out: { name: string; params: Record<string, string>; value: string }[] = []
  for (const raw of text.replace(/^\uFEFF/, '').replace(/\r\n|\r/g, '\n').replace(/\n[ \t]/g, '').split('\n')) {
    let quoted = false
    let i = 0
    for (; i < raw.length; i++) {
      if (raw[i] === '"') quoted = !quoted
      else if (raw[i] === ':' && !quoted) break
    }
    if (i >= raw.length) continue
    const [name, ...params] = raw.slice(0, i).match(/(?:[^;"]|"[^"]*")+/g) ?? ['']
    out.push({ name: name.toUpperCase(), params: Object.fromEntries(params.map((p) => [p.split('=')[0].toUpperCase(), p.slice(p.indexOf('=') + 1).replace(/^"|"$/g, '')])), value: raw.slice(i + 1) })
  }
  return out
}

const text = (v: string) => v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1').trim()

/** Milliseconds a time zone is ahead of UTC at `utc`. */
function zoneOffset(utc: number, zone: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(utc))
      .map((x) => [x.type, x.value]),
  )
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - utc
}

/**
 * A DTSTART-like value as an ISO time, or "YYYY-MM-DD" for a day. Basic (20261015T140000Z) and
 * extended (2026-10-15T14:00:00.000+02:00) forms both read. A time with no zone is in its TZID,
 * else in the calendar's X-WR-TIMEZONE, else this browser's.
 */
function when(value: string, params: Record<string, string>, calendarZone?: string): { iso: string; allDay: boolean } | null {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})(?:[T ](\d{2}):?(\d{2})(?::?(\d{2})(?:[.,]\d+)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?)?$/i.exec(value.trim())
  if (!m) return null
  const [, y, mo, d, h, mi, s = '00', z] = m
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31 || +(h ?? 0) > 24 || +mi > 59 || +s > 60) return null
  if (!h || params.VALUE?.toUpperCase() === 'DATE') return { iso: `${y}-${mo}-${d}`, allDay: true }
  const wall = Date.UTC(+y, +mo - 1, +d, +h, +mi, Math.min(+s, 59))
  if (z) {
    const sign = z[0] === '-' ? -1 : 1
    const off = /^[+-](\d{2}):?(\d{2})?$/.exec(z)
    return { iso: new Date(wall - (off ? sign * (+off[1] * 60 + +(off[2] ?? 0)) * 60_000 : 0)).toISOString(), allDay: false }
  }
  const zone = (params.TZID || calendarZone)?.replace(/^\/[^/]*\//, '')
  if (zone)
    try {
      let utc = wall - zoneOffset(wall, zone)
      utc = wall - zoneOffset(utc, zone)
      return { iso: new Date(utc).toISOString(), allDay: false }
    } catch {
      /* a zone this browser doesn't know (Outlook's names): as local time below */
    }
  return { iso: new Date(+y, +mo - 1, +d, +h, +mi, Math.min(+s, 59)).toISOString(), allDay: false }
}

/** An ISO 8601 duration (PT1H30M, P1D) in milliseconds. */
function duration(v: string): number {
  const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim())
  return m ? ((+(m[1] ?? 0) * 7 + +(m[2] ?? 0)) * 86400 + +(m[3] ?? 0) * 3600 + +(m[4] ?? 0) * 60 + +(m[5] ?? 0)) * 1000 : 0
}

const nextDay = (day: string, n = 1) => {
  const d = new Date(`${day}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** The events in an iCalendar text (cancelled ones and changed occurrences of a series left out). */
export const parseIcs = (ics: string): IcsEvent[] => readIcs(ics).events

/** Like parseIcs, and says how many events the text held and what was wrong with the ones it could not take. */
export function readIcs(ics: string): IcsReport {
  const out: IcsEvent[] = []
  const unreadable: string[] = []
  let found = 0
  let ev: Record<string, { value: string; params: Record<string, string> }> | null = null
  let depth = 0
  let calendarZone: string | undefined
  // Some generators leave out END:VEVENT (and END:VCALENDAR): an event still open when the next
  // one begins, the calendar ends or the file does is taken as it is, as other calendar apps do.
  const finish = () => {
    if (!ev) return
    found++
    const name = text(ev.SUMMARY?.value ?? '') || '(No title)'
    const start = ev.DTSTART && when(ev.DTSTART.value, ev.DTSTART.params, calendarZone)
    if (!ev.DTSTART) unreadable.push(`${name}: it has no DTSTART`)
    else if (!start) unreadable.push(`${name}: DTSTART: ${ev.DTSTART.value.slice(0, 40)}`)
    if (start && ev.STATUS?.value.trim().toUpperCase() !== 'CANCELLED' && !ev['RECURRENCE-ID']) {
      const endProp = ev.DTEND && when(ev.DTEND.value, ev.DTEND.params, calendarZone)
      let end = endProp?.iso
      if (!end || end <= start.iso) {
        const length = ev.DURATION ? duration(ev.DURATION.value) : 0
        end = start.allDay ? nextDay(start.iso, Math.max(1, Math.round(length / 864e5))) : new Date(Date.parse(start.iso) + (length || 3600_000)).toISOString()
      }
      const rule = ev.RRULE?.value.replace(/^RRULE:/i, '').toUpperCase()
      out.push({
        title: name,
        start: start.iso,
        end: start.allDay ? end.slice(0, 10) : end,
        allDay: start.allDay,
        location: ev.LOCATION ? text(ev.LOCATION.value) : '',
        description: ev.DESCRIPTION ? text(ev.DESCRIPTION.value) : '',
        ...(ev.UID?.value.trim() ? { uid: ev.UID.value.trim() } : {}),
        ...(rule && /^FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)/.test(rule) ? { recurrence: rule } : {}),
      })
    }
    ev = null
  }
  for (const l of lines(ics.slice(0, 5 * 1024 * 1024))) {
    const what = l.value.trim().toUpperCase()
    if (l.name === 'X-WR-TIMEZONE' && !calendarZone) calendarZone = l.value.trim().replace(/^"|"$/g, '')
    if (l.name === 'BEGIN' && what === 'VEVENT') {
      finish()
      ev = {}
      depth = 0
      continue
    }
    if (!ev) continue
    if (l.name === 'END' && what === 'VCALENDAR') finish()
    else if (l.name === 'BEGIN') depth++
    else if (l.name === 'END' && depth > 0) depth--
    else if (l.name === 'END') finish()
    else if (depth === 0 && !(l.name in ev)) ev[l.name] = { value: l.value, params: l.params }
  }
  finish()
  return { events: out, found, unreadable }
}

/** Why nothing could be imported, for the notice: no events at all, a start that could not be read, or only cancelled ones. */
export function explainIcs(names: string[], reports: IcsReport[]): string {
  const found = reports.reduce((n, r) => n + r.found, 0)
  const unreadable = reports.flatMap((r) => r.unreadable)
  const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)
  if (!found) return names.length === 1 ? `${names[0]} has no events` : 'Those files have no events'
  if (unreadable.length) return `${found} ${plural(found, 'event', 'events')} found, but ${plural(unreadable.length, 'its start time', 'their start times')} couldn't be read (${unreadable.slice(0, 2).join('; ')}${unreadable.length > 2 ? '; …' : ''})`
  return `${found} ${plural(found, 'event', 'events')} found, but ${plural(found, 'it is', 'they are')} cancelled or ${plural(found, 'a change', 'changes')} to one occurrence of a repeating event`
}
