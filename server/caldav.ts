import type { User } from './auth.ts'
import { database, decrypt, encrypt } from './db.ts'
import { HttpError } from './http.ts'

// CalDAV calendars (Fastmail, Nextcloud, iCloud, Radicale...) for the Agenda widget and the clock,
// next to Google Calendar. An account is a server URL, a username and an app password (stored
// encrypted; a read-only app password is enough). Calendars are found from the URL the standard
// way (principal → calendar home → calendars), and events are asked for by date range with the
// server expanding repeating events into their occurrences. No XML or iCalendar library: the
// few elements and properties needed are read directly.

export type CaldavInfo = { id: number; label: string; url: string; username: string }
type Account = CaldavInfo & { password: string }
type Calendar = { href: string; name: string; color: string }
export type CaldavEvent = { uid: string; title: string; start: string; end: string; allDay: boolean; location?: string; meet?: string }

export const FASTMAIL_URL = 'https://caldav.fastmail.com/dav/'

// ---------------------------------------------------------------------------------------------
// Accounts

type Row = { id: number; label: string; base_url: string; username: string; password: string }

export function listCaldav(user: User): CaldavInfo[] {
  const rows = database().prepare('SELECT id, label, base_url, username FROM caldav WHERE user_id = ? ORDER BY id').all(user.id) as unknown as Row[]
  return rows.map((r) => ({ id: r.id, label: r.label, url: r.base_url, username: r.username }))
}

function accounts(user: User): Account[] {
  const rows = database().prepare('SELECT id, label, base_url, username, password FROM caldav WHERE user_id = ? ORDER BY id').all(user.id) as unknown as Row[]
  return rows.map((r) => ({ id: r.id, label: r.label, url: r.base_url, username: r.username, password: decrypt(r.password) }))
}

/** Finds the account's calendars (proving the URL and password work), then stores it. */
export async function addCaldav(user: User, body: { url?: string; username?: string; password?: string; label?: string }): Promise<CaldavInfo> {
  const url = normalizeUrl(body.url || FASTMAIL_URL)
  const username = body.username?.trim()
  const password = body.password?.trim()
  if (!username || !password) throw new HttpError(400, 'Username and app password are required')
  const account: Account = { id: 0, label: '', url, username, password }
  const found = await discover(account).catch((e: Error) => {
    throw new HttpError(400, e.message)
  })
  if (!found.length) throw new HttpError(400, 'Signed in, but found no calendars there')
  const label = (body.label?.trim() || (url.includes('fastmail') ? 'Fastmail' : new URL(url).host)).slice(0, 40)
  const r = database().prepare('INSERT INTO caldav (user_id, label, base_url, username, password, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(user.id, label, url, username, encrypt(password), Date.now())
  clearCaldavCache(user)
  return { id: Number(r.lastInsertRowid), label, url, username }
}

export function removeCaldav(user: User, id: number) {
  database().prepare('DELETE FROM caldav WHERE user_id = ? AND id = ?').run(user.id, id)
  clearCaldavCache(user)
}

function normalizeUrl(input: string): string {
  let raw = input.trim()
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new HttpError(400, 'That is not a URL')
  }
  if (url.username || url.password) throw new HttpError(400, 'Leave credentials out of the URL')
  return url.href.endsWith('/') ? url.href : `${url.href}/`
}

// ---------------------------------------------------------------------------------------------
// WebDAV

async function dav(account: Account, method: 'PROPFIND' | 'REPORT', url: string, depth: '0' | '1', body: string): Promise<string> {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${account.username}:${account.password}`).toString('base64')}`,
      Depth: depth,
      'Content-Type': 'application/xml; charset=utf-8',
      'User-Agent': 'mvlos',
    },
    body,
    redirect: 'follow',
    signal: AbortSignal.timeout(12_000),
  }).catch(() => null)
  if (!res) throw new Error(`${new URL(url).host} did not answer`)
  if (res.status === 401 || res.status === 403) throw new Error(`${new URL(url).host} refused the username or app password`)
  if (res.status !== 207 && !res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`)
  return res.text()
}

const unescapeXml = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')

/** The responses of a multistatus, each with its href and its body to read properties from. */
function responses(xml: string): { href: string; body: string }[] {
  const out: { href: string; body: string }[] = []
  const re = /<(?:[\w-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?response>/g
  for (let m; (m = re.exec(xml)); ) {
    const href = /<(?:[\w-]+:)?href\b[^>]*>([^<]*)</.exec(m[1])?.[1]
    if (href) out.push({ href: unescapeXml(href.trim()), body: m[1] })
  }
  return out
}

/** The text inside the first element with this local name (any namespace prefix). */
function prop(body: string, name: string): string | null {
  const m = new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*?(?:/>|>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>)`).exec(body)
  return m ? (m[1] ?? '') : null
}

/** The href inside an element such as current-user-principal or calendar-home-set. */
const hrefIn = (body: string, name: string) => {
  const inner = prop(body, name)
  return inner ? (/<(?:[\w-]+:)?href\b[^>]*>([^<]*)</.exec(inner)?.[1]?.trim() ?? null) : null
}

const resolve = (base: string, href: string) => new URL(unescapeXml(href), base).href

async function discover(account: Account): Promise<Calendar[]> {
  const D = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"'
  // The principal, from the URL given or from /.well-known/caldav.
  let principal: string | null = null
  for (const start of [account.url, new URL('/.well-known/caldav', account.url).href]) {
    const xml = await dav(account, 'PROPFIND', start, '0', `<d:propfind ${D}><d:prop><d:current-user-principal/></d:prop></d:propfind>`).catch((e: Error) => {
      if (/refused/.test(e.message)) throw e
      return null
    })
    const href = xml && hrefIn(xml, 'current-user-principal')
    if (href) {
      principal = resolve(start, href)
      break
    }
  }
  if (!principal) throw new Error('No CalDAV account found at that URL')
  const homeXml = await dav(account, 'PROPFIND', principal, '0', `<d:propfind ${D}><d:prop><c:calendar-home-set/></d:prop></d:propfind>`)
  const homeHref = hrefIn(homeXml, 'calendar-home-set')
  if (!homeHref) throw new Error('That account has no calendars')
  const home = resolve(principal, homeHref)
  const list = await dav(
    account,
    'PROPFIND',
    home,
    '1',
    `<d:propfind ${D} xmlns:a="http://apple.com/ns/ical/"><d:prop><d:resourcetype/><d:displayname/><a:calendar-color/><c:supported-calendar-component-set/></d:prop></d:propfind>`,
  )
  return responses(list)
    .filter((r) => /<(?:[\w-]+:)?calendar\b/.test(prop(r.body, 'resourcetype') ?? ''))
    .filter((r) => {
      const comps = prop(r.body, 'supported-calendar-component-set')
      return !comps || /name="VEVENT"/i.test(comps)
    })
    .map((r) => {
      const color = (prop(r.body, 'calendar-color') ?? '').trim()
      return {
        href: resolve(home, r.href),
        name: unescapeXml(prop(r.body, 'displayname')?.trim() || decodeURIComponent(r.href.split('/').filter(Boolean).pop() ?? 'Calendar')),
        // Apple's colour is #RRGGBBAA; CSS wants #RRGGBB.
        color: /^#[0-9a-f]{6}/i.test(color) ? color.slice(0, 7) : '#7aa2f7',
      }
    })
}

// ---------------------------------------------------------------------------------------------
// iCalendar

const pad = (n: number) => String(n).padStart(2, '0')
const davTime = (d: Date) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`

/** Milliseconds a time zone is ahead of UTC at `utc`. */
function zoneOffset(utc: number, zone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(utc))
      .map((p) => [p.type, p.value]),
  )
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - utc
}

/** A DATE or DATE-TIME value with its TZID, as an ISO string (dates stay "YYYY-MM-DD"). */
function icalTime(value: string, params: Record<string, string>): { iso: string; allDay: boolean } | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim())
  if (!m) return null
  const [, y, mo, d, h, mi, s, z] = m
  if (!h || params.VALUE === 'DATE') return { iso: `${y}-${mo}-${d}`, allDay: true }
  const wall = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)
  if (z) return { iso: new Date(wall).toISOString(), allDay: false }
  // A wall-clock time in TZID (or "floating": then this server's zone). Two passes for DST edges.
  const zone = params.TZID?.replace(/^\/[^/]*\//, '') || Intl.DateTimeFormat().resolvedOptions().timeZone
  try {
    let utc = wall - zoneOffset(wall, zone)
    utc = wall - zoneOffset(utc, zone)
    return { iso: new Date(utc).toISOString(), allDay: false }
  } catch {
    return { iso: new Date(wall).toISOString(), allDay: false }
  }
}

/** An ISO 8601 duration like PT1H30M or P1D, in milliseconds. */
function duration(value: string): number {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim())
  if (!m) return 0
  const [, sign, w, d, h, mi, s] = m
  const ms = ((+(w ?? 0) * 7 + +(d ?? 0)) * 86400 + +(h ?? 0) * 3600 + +(mi ?? 0) * 60 + +(s ?? 0)) * 1000
  return sign === '-' ? -ms : ms
}

const icalText = (s: string) => s.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1')
const MEETING = /https:\/\/(?:meet\.google\.com|[\w.-]*zoom\.us|teams\.microsoft\.com|teams\.live\.com|[\w.-]*whereby\.com|meet\.jit\.si)\/[^\s"<>]+/i

type Prop = { value: string; params: Record<string, string> }
/** One VEVENT's properties (the first of each name), plus every EXDATE value. */
type RawEvent = { props: Record<string, Prop>; exdates: string[] }

/** The VEVENTs in an iCalendar text, unparsed (alarms inside them skipped). */
function rawEvents(ics: string): RawEvent[] {
  const lines = ics.replace(/\r?\n[ \t]/g, '').split(/\r?\n/)
  const out: RawEvent[] = []
  let ev: RawEvent | null = null
  let depth = 0
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      ev = { props: {}, exdates: [] }
      depth = 0
      continue
    }
    if (!ev) continue
    if (line === 'END:VEVENT') {
      out.push(ev)
      ev = null
      continue
    }
    // Skip the VALARMs inside an event.
    if (line.startsWith('BEGIN:')) depth++
    else if (line.startsWith('END:')) depth--
    if (depth > 0 || line.startsWith('END:')) continue
    const p = parseLine(line)
    if (!p) continue
    if (p.name === 'EXDATE') ev.exdates.push(...p.value.split(','))
    else if (!(p.name in ev.props)) ev.props[p.name] = { value: p.value, params: p.params }
  }
  return out
}

/** NAME;PARAM=a;PARAM="b:c":value, with colons allowed inside quoted parameter values. */
function parseLine(line: string): { name: string; params: Record<string, string>; value: string } | null {
  let i = 0
  let quoted = false
  for (; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted
    else if (line[i] === ':' && !quoted) break
  }
  if (i >= line.length) return null
  const [name, ...rawParams] = line.slice(0, i).match(/(?:[^;"]|"[^"]*")+/g) ?? ['']
  const params: Record<string, string> = {}
  for (const p of rawParams) {
    const eq = p.indexOf('=')
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '')
  }
  return { name: name.toUpperCase(), params, value: line.slice(i + 1) }
}

/** One event (or one occurrence of a series, with its own start) as the agenda shows it. */
function toEvent(raw: RawEvent, startValue?: string): CaldavEvent | null {
  const ev = raw.props
  if (!ev.DTSTART || ev.STATUS?.value === 'CANCELLED') return null
  const start = icalTime(startValue ?? ev.DTSTART.value, ev.DTSTART.params)
  if (!start) return null
  // The master's length, carried over to each occurrence.
  const masterStart = icalTime(ev.DTSTART.value, ev.DTSTART.params)!
  const masterEnd = ev.DTEND && icalTime(ev.DTEND.value, ev.DTEND.params)
  let end: string
  if (start.allDay) {
    const days = masterEnd ? Math.max(1, Math.round((Date.parse(`${masterEnd.iso.slice(0, 10)}T00:00:00Z`) - Date.parse(`${masterStart.iso}T00:00:00Z`)) / 864e5)) : Math.max(1, Math.round(duration(ev.DURATION?.value ?? 'P1D') / 864e5))
    const next = new Date(`${start.iso}T00:00:00Z`)
    next.setUTCDate(next.getUTCDate() + days)
    end = next.toISOString().slice(0, 10)
  } else {
    const length = masterEnd ? Date.parse(masterEnd.iso) - Date.parse(masterStart.iso) : duration(ev.DURATION?.value ?? 'PT0S')
    end = new Date(Date.parse(start.iso) + length).toISOString()
  }
  const description = icalText(ev.DESCRIPTION?.value ?? '')
  const location = ev.LOCATION ? icalText(ev.LOCATION.value) : undefined
  return {
    uid: `${ev.UID?.value ?? ''}|${ev['RECURRENCE-ID']?.value ?? startValue ?? start.iso}`,
    title: icalText(ev.SUMMARY?.value ?? '') || '(No title)',
    start: start.iso,
    end,
    allDay: start.allDay,
    location,
    meet: (ev.URL && MEETING.exec(ev.URL.value)?.[0]) || MEETING.exec(location ?? '')?.[0] || MEETING.exec(description)?.[0],
  }
}

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

/**
 * The start values of a series' occurrences between `from` and `to`, for servers that send the
 * series instead of expanding it: FREQ=DAILY/WEEKLY/MONTHLY/YEARLY with INTERVAL, COUNT, UNTIL and
 * (weekly) BYDAY. Worked out in the event's own wall-clock time, so 09:30 stays 09:30 across a
 * daylight saving change. Other rules show only their first occurrence.
 */
function occurrences(raw: RawEvent, from: Date, to: Date): string[] {
  const dtstart = raw.props.DTSTART.value
  const rule = Object.fromEntries((raw.props.RRULE?.value ?? '').split(';').map((p) => p.split('=') as [string, string]))
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/.exec(dtstart)
  if (!m || !rule.FREQ) return [dtstart]
  const [, y, mo, d, h, mi, sec, z] = m
  const timePart = h ? `T${h}${mi}${sec}${z}` : ''
  const fmt = (t: Date) => `${t.getUTCFullYear()}${pad(t.getUTCMonth() + 1)}${pad(t.getUTCDate())}${timePart}`
  const first = new Date(Date.UTC(+y, +mo - 1, +d))
  const interval = Math.max(1, Number(rule.INTERVAL ?? 1))
  const count = rule.COUNT ? Number(rule.COUNT) : Infinity
  const until = rule.UNTIL ? icalTime(rule.UNTIL, raw.props.DTSTART.params)?.iso : null
  const excluded = new Set(raw.exdates.map((x) => x.trim().slice(0, timePart ? 15 : 8)))
  const days = (rule.BYDAY ?? '').split(',').map((x: string) => DAYS.indexOf(x.slice(-2))).filter((x: number) => x >= 0)
  // A margin either side: occurrences are compared after converting to UTC below.
  const lo = from.getTime() - 2 * 864e5
  const hi = to.getTime() + 2 * 864e5
  const out: string[] = []
  let made = 0
  const take = (t: Date) => {
    made++
    const value = fmt(t)
    const at = icalTime(value, raw.props.DTSTART.params)?.iso
    if (!at || (until && at > until)) return false
    if (t.getTime() >= lo && !excluded.has(value.slice(0, timePart ? 15 : 8))) out.push(value)
    return made < count && t.getTime() <= hi
  }
  for (let i = 0; i < 5000; i++) {
    const t = new Date(first)
    if (rule.FREQ === 'DAILY') t.setUTCDate(t.getUTCDate() + i * interval)
    else if (rule.FREQ === 'MONTHLY') t.setUTCMonth(t.getUTCMonth() + i * interval)
    else if (rule.FREQ === 'YEARLY') t.setUTCFullYear(t.getUTCFullYear() + i * interval)
    else if (rule.FREQ === 'WEEKLY') {
      // Each week of the series, every BYDAY in it (or DTSTART's weekday), in order.
      const week = new Date(first)
      week.setUTCDate(week.getUTCDate() - ((week.getUTCDay() + 6) % 7) + i * 7 * interval)
      const wanted = (days.length ? days : [first.getUTCDay()]).map((day: number) => (day + 6) % 7).sort((a: number, b: number) => a - b)
      let more = true
      for (const offset of wanted) {
        const day = new Date(week)
        day.setUTCDate(day.getUTCDate() + offset)
        if (day < first) continue
        if (!take(day)) {
          more = false
          break
        }
      }
      if (!more) break
      continue
    } else return [dtstart]
    // A month or year without that day (the 31st, 29 February) has no occurrence.
    if ((rule.FREQ === 'MONTHLY' || rule.FREQ === 'YEARLY') && t.getUTCDate() !== first.getUTCDate()) continue
    if (!take(t)) break
  }
  return out
}

/** The events in an iCalendar text between `from` and `to`, series expanded where the server
 * didn't, moved or cancelled occurrences (RECURRENCE-ID) taking the place of the series' own. */
export function parseEvents(ics: string, from: Date, to: Date): CaldavEvent[] {
  const raws = rawEvents(ics)
  const moved = new Set(raws.filter((r) => r.props['RECURRENCE-ID']).map((r) => `${r.props.UID?.value}|${r.props['RECURRENCE-ID'].value.slice(0, 15)}`))
  const out: CaldavEvent[] = []
  for (const raw of raws) {
    if (!raw.props.DTSTART) continue
    if (!raw.props.RRULE || raw.props['RECURRENCE-ID']) {
      const e = toEvent(raw)
      if (e) out.push(e)
      continue
    }
    for (const value of occurrences(raw, from, to)) {
      if (moved.has(`${raw.props.UID?.value}|${value.slice(0, 15)}`)) continue
      const e = toEvent(raw, value)
      if (e) out.push(e)
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Calendars and events, with the same cache rules as Google's

const cache = new Map<string, { at: number; value: Promise<unknown> }>()
function cached<T>(key: string, ms: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < ms) return hit.value as Promise<T>
  const value = load()
  cache.set(key, { at: Date.now(), value })
  value.catch(() => cache.delete(key))
  return value
}
export const clearCaldavCache = (user: User) => {
  for (const k of cache.keys()) if (k.startsWith(`${user.id}|`)) cache.delete(k)
}

export type CaldavCalendar = { id: string; account: number; href: string; name: string; color: string }

/** Every calendar of every CalDAV account (ids are "caldav:<account>:<href>"), and what went wrong
 * per account (a refused app password, a server that is down), named after the account. */
export async function caldavCalendars(user: User): Promise<{ calendars: CaldavCalendar[]; errors: string[] }> {
  const errors: string[] = []
  const lists = await Promise.all(
    accounts(user).map((a) =>
      cached(`${user.id}|cals|${a.id}`, 10 * 60_000, () => discover(a))
        .then((cals) => cals.map((c) => ({ id: `caldav:${a.id}:${c.href}`, account: a.id, href: c.href, name: c.name, color: c.color })))
        .catch((e: Error) => (errors.push(`${a.label}: ${e.message}`), [] as CaldavCalendar[])),
    ),
  )
  return { calendars: lists.flat(), errors }
}

export async function caldavEvents(user: User, calendar: CaldavCalendar, from: Date, to: Date): Promise<CaldavEvent[]> {
  const account = accounts(user).find((a) => a.id === calendar.account)
  if (!account) return []
  const start = davTime(from)
  const end = davTime(to)
  return cached(`${user.id}|events|${calendar.id}|${start}|${end}`, 2 * 60_000, async () => {
    const xml = await dav(
      account,
      'REPORT',
      calendar.href,
      '1',
      `<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-data><c:expand start="${start}" end="${end}"/></c:calendar-data></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${start}" end="${end}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`,
    )
    const events = responses(xml).flatMap((r) => parseEvents(unescapeXml(prop(r.body, 'calendar-data') ?? ''), from, to))
    // Keep what falls in range (expanded series come with a margin).
    const lo = from.toISOString()
    const hi = to.toISOString()
    return events.filter((e) => (e.allDay ? `${e.end}T00:00:00.000Z` > lo && `${e.start}T00:00:00.000Z` < hi : e.end > lo && e.start < hi))
  })
}
