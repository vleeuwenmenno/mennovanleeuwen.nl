import type { EventInput } from '../../data/calendar'

// Reading .ics files (dropped on the Calendar app) far enough to import their events: the
// title, when (a day, a UTC time, or a time in its TZID), where, the notes and how it repeats.
// Guests are left out on purpose: adding them would send everyone an invitation from you.

export type IcsEvent = EventInput & { recurrence?: string }

/** Content lines, unfolded: NAME;PARAM=a;PARAM="b:c":value. */
function lines(text: string): { name: string; params: Record<string, string>; value: string }[] {
  const out: { name: string; params: Record<string, string>; value: string }[] = []
  for (const raw of text.replace(/\r\n|\r/g, '\n').replace(/\n[ \t]/g, '').split('\n')) {
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

/** A DTSTART-like value as an ISO time, or "YYYY-MM-DD" for a day. Floating times are this browser's. */
function when(value: string, params: Record<string, string>): { iso: string; allDay: boolean } | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim())
  if (!m) return null
  const [, y, mo, d, h, mi, s, z] = m
  if (!h || params.VALUE === 'DATE') return { iso: `${y}-${mo}-${d}`, allDay: true }
  const wall = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)
  if (z) return { iso: new Date(wall).toISOString(), allDay: false }
  const zone = params.TZID?.replace(/^\/[^/]*\//, '')
  if (zone)
    try {
      let utc = wall - zoneOffset(wall, zone)
      utc = wall - zoneOffset(utc, zone)
      return { iso: new Date(utc).toISOString(), allDay: false }
    } catch {
      /* a zone this browser doesn't know (Outlook's names): as local time below */
    }
  return { iso: new Date(+y, +mo - 1, +d, +h, +mi, +s).toISOString(), allDay: false }
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
export function parseIcs(ics: string): IcsEvent[] {
  const out: IcsEvent[] = []
  let ev: Record<string, { value: string; params: Record<string, string> }> | null = null
  let depth = 0
  for (const l of lines(ics.slice(0, 5 * 1024 * 1024))) {
    if (l.name === 'BEGIN' && l.value.trim().toUpperCase() === 'VEVENT') {
      ev = {}
      depth = 0
      continue
    }
    if (!ev) continue
    if (l.name === 'BEGIN') depth++
    else if (l.name === 'END' && depth > 0) depth--
    else if (l.name === 'END') {
      const start = ev.DTSTART && when(ev.DTSTART.value, ev.DTSTART.params)
      if (start && ev.STATUS?.value.toUpperCase() !== 'CANCELLED' && !ev['RECURRENCE-ID']) {
        const endProp = ev.DTEND && when(ev.DTEND.value, ev.DTEND.params)
        let end = endProp?.iso
        if (!end || end <= start.iso) {
          const length = ev.DURATION ? duration(ev.DURATION.value) : 0
          end = start.allDay ? nextDay(start.iso, Math.max(1, Math.round(length / 864e5))) : new Date(Date.parse(start.iso) + (length || 3600_000)).toISOString()
        }
        const rule = ev.RRULE?.value.replace(/^RRULE:/i, '')
        out.push({
          title: text(ev.SUMMARY?.value ?? '') || '(No title)',
          start: start.iso,
          end: start.allDay ? end.slice(0, 10) : end,
          allDay: start.allDay,
          location: ev.LOCATION ? text(ev.LOCATION.value) : '',
          description: ev.DESCRIPTION ? text(ev.DESCRIPTION.value) : '',
          ...(rule && /^FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)/.test(rule) ? { recurrence: rule } : {}),
        })
      }
      ev = null
    } else if (depth === 0 && !(l.name in ev)) ev[l.name] = { value: l.value, params: l.params }
  }
  return out
}
