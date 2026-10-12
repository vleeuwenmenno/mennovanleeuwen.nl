// Calendar invitations in mail (iMIP, RFC 6047): a text/calendar part or an .ics attachment with a
// METHOD (REQUEST, REPLY, CANCEL...), read just far enough for the Mail app's invite card: what,
// when, where and from whom. No iCalendar library: the few properties needed are read directly.

export type Invite = {
  method: string
  uid: string | null
  title: string
  /** ISO time, or "YYYY-MM-DD" when all day. */
  start: string | null
  end: string | null
  allDay: boolean
  location: string | null
  organizer: { name: string | null; email: string } | null
  /** For a REPLY: who answered, and how (ACCEPTED, DECLINED, TENTATIVE). */
  replies: { email: string; name: string | null; status: string }[]
  attendees: number
}

type Line = { name: string; params: Record<string, string>; value: string }

/** The content lines, unfolded, with their parameters. */
function lines(text: string): Line[] {
  const out: Line[] = []
  for (const raw of text.replace(/\r\n|\r/g, '\n').replace(/\n[ \t]/g, '').split('\n')) {
    // NAME;PARAM=a;PARAM="b:c":value — the first colon outside quotes ends the parameters.
    let quote = false
    let colon = -1
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] === '"') quote = !quote
      else if (raw[i] === ':' && !quote) {
        colon = i
        break
      }
    }
    if (colon < 0) continue
    const [name, ...params] = raw.slice(0, colon).split(';')
    out.push({
      name: name.toUpperCase(),
      params: Object.fromEntries(params.map((p) => [p.split('=')[0].toUpperCase(), p.slice(p.indexOf('=') + 1).replace(/^"|"$/g, '')])),
      value: raw.slice(colon + 1),
    })
  }
  return out
}

const unescape = (v: string) => v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1')
const mailto = (v: string) => v.replace(/^mailto:/i, '').trim().toLowerCase()

/** The UTC offset of a time zone at an instant, in minutes. */
function offsetMinutes(tz: string, at: number): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(at))
      .map((p) => [p.type, p.value]),
  )
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second))
  return Math.round((asUtc - at) / 60_000)
}

/** A DTSTART/DTEND as an ISO time (or a date when all day); a TZID is honoured when the runtime knows it. */
function when(l: Line | undefined): { value: string; allDay: boolean } | null {
  if (!l) return null
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(l.value.trim())
  if (!m) return null
  const [, y, mo, d, h, mi, s, z] = m
  if (h === undefined || l.params.VALUE === 'DATE') return { value: `${y}-${mo}-${d}`, allDay: true }
  const local = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s))
  if (z) return { value: new Date(local).toISOString(), allDay: false }
  const tz = l.params.TZID
  if (tz) {
    try {
      // Twice, so a time near a daylight saving change lands on the right side of it.
      const guess = local - offsetMinutes(tz, local) * 60_000
      return { value: new Date(local - offsetMinutes(tz, guess) * 60_000).toISOString(), allDay: false }
    } catch {
      /* a zone the runtime does not know (Outlook's "W. Europe Standard Time"): as floating time */
    }
  }
  return { value: new Date(local).toISOString().replace('Z', ''), allDay: false }
}

/** The invitation in an iCalendar text, or null when it isn't one (no METHOD, or no event). */
export function parseInvite(text: string): Invite | null {
  const all = lines(text.slice(0, 256 * 1024))
  const method = all.find((l) => l.name === 'METHOD')?.value.trim().toUpperCase()
  const begin = all.findIndex((l) => l.name === 'BEGIN' && l.value.trim().toUpperCase() === 'VEVENT')
  if (!method || begin < 0) return null
  const endAt = all.findIndex((l, i) => i > begin && l.name === 'END' && l.value.trim().toUpperCase() === 'VEVENT')
  // The event's own lines, not its alarms'.
  const ev: Line[] = []
  let depth = 0
  for (const l of all.slice(begin + 1, endAt < 0 ? undefined : endAt)) {
    if (l.name === 'BEGIN') depth++
    else if (l.name === 'END') depth--
    else if (depth === 0) ev.push(l)
  }
  const get = (name: string) => ev.find((l) => l.name === name)
  const start = when(get('DTSTART'))
  const end = when(get('DTEND'))
  const org = get('ORGANIZER')
  const attendees = ev.filter((l) => l.name === 'ATTENDEE')
  return {
    method,
    uid: get('UID')?.value.trim() ?? null,
    title: unescape(get('SUMMARY')?.value ?? '').trim() || '(No title)',
    start: start?.value ?? null,
    end: end?.value ?? null,
    allDay: start?.allDay ?? false,
    location: get('LOCATION') ? unescape(get('LOCATION')!.value).trim() || null : null,
    organizer: org ? { name: org.params.CN ? unescape(org.params.CN) : null, email: mailto(org.value) } : null,
    replies: method === 'REPLY' ? attendees.map((a) => ({ email: mailto(a.value), name: a.params.CN ?? null, status: (a.params.PARTSTAT ?? 'NEEDS-ACTION').toUpperCase() })) : [],
    attendees: attendees.length,
  }
}
