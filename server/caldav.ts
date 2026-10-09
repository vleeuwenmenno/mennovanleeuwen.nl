import { randomUUID } from 'node:crypto'
import type { User } from './auth.ts'
import type { EventInput } from './calendars.ts'
import { database, decrypt, encrypt } from './db.ts'
import { HttpError } from './http.ts'

// CalDAV calendars (Fastmail, Nextcloud, iCloud, Radicale...) for the Agenda widget, the clock and
// the Calendar app, next to Google Calendar. An account is a server URL, a username and an app
// password (stored encrypted; read-only is enough to look, the Calendar app needs read-write to
// change things). Calendars are found from the URL the standard way (principal → calendar home →
// calendars), and events are asked for by date range with the server expanding repeating events
// into their occurrences. Changes are made in the event's own iCalendar text and written back
// with its ETag, so whatever else is in there (alarms, other apps' properties) stays. No XML or
// iCalendar library: the few elements and properties needed are read and written directly.

export type CaldavInfo = { id: number; label: string; url: string; username: string }
type Account = CaldavInfo & { password: string }
type Calendar = { href: string; name: string; color: string; writable: boolean }
export type CaldavAttendee = { email: string; name?: string; status?: 'accepted' | 'declined' | 'tentative' | 'needs-action'; organizer?: boolean }
export type CaldavEvent = {
  /** Unique per occurrence: the UID and which occurrence. */
  uid: string
  /** The iCalendar UID itself. */
  icalUid: string
  /** For one occurrence of a repeating event: when it was meant to start (its RECURRENCE-ID). */
  recurrence?: string
  title: string
  start: string
  end: string
  allDay: boolean
  location?: string
  description?: string
  meet?: string
  attendees?: CaldavAttendee[]
}

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
  // The same account again (a new app password, read-write this time): keep it, and its calendars' ids.
  const existing = database().prepare('SELECT id FROM caldav WHERE user_id = ? AND base_url = ? AND username = ?').get(user.id, url, username) as { id: number } | undefined
  if (existing) {
    database().prepare('UPDATE caldav SET label = ?, password = ? WHERE id = ?').run(label, encrypt(password), existing.id)
    clearCaldavCache(user)
    return { id: existing.id, label, url, username }
  }
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

async function request(account: Account, method: string, url: string, init: { headers?: Record<string, string>; body?: string } = {}): Promise<Response> {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Basic ${Buffer.from(`${account.username}:${account.password}`).toString('base64')}`, 'User-Agent': 'mvlos', ...init.headers },
    body: init.body,
    redirect: 'follow',
    signal: AbortSignal.timeout(12_000),
  }).catch(() => null)
  if (!res) throw new HttpError(502, `${new URL(url).host} did not answer`)
  return res
}

async function dav(account: Account, method: 'PROPFIND' | 'REPORT', url: string, depth: '0' | '1', body: string): Promise<string> {
  const res = await request(account, method, url, { headers: { Depth: depth, 'Content-Type': 'application/xml; charset=utf-8' }, body })
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
    `<d:propfind ${D} xmlns:a="http://apple.com/ns/ical/"><d:prop><d:resourcetype/><d:displayname/><a:calendar-color/><c:supported-calendar-component-set/><d:current-user-privilege-set/></d:prop></d:propfind>`,
  )
  return responses(list)
    .filter((r) => /<(?:[\w-]+:)?calendar\b/.test(prop(r.body, 'resourcetype') ?? ''))
    .filter((r) => {
      const comps = prop(r.body, 'supported-calendar-component-set')
      return !comps || /name="VEVENT"/i.test(comps)
    })
    .map((r) => {
      const color = (prop(r.body, 'calendar-color') ?? '').trim()
      // Servers that don't say are assumed writable; a refusal still shows when saving.
      const privileges = prop(r.body, 'current-user-privilege-set')
      return {
        writable: !privileges || /<(?:[\w-]+:)?(?:write|write-content|all)\b/.test(privileges),
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
/** One VEVENT's properties (the first of each name), plus every EXDATE value and attendee. */
type RawEvent = { props: Record<string, Prop>; exdates: string[]; attendees: Prop[] }

/** The VEVENTs in an iCalendar text, unparsed (alarms inside them skipped). */
function rawEvents(ics: string): RawEvent[] {
  const lines = ics.replace(/\r?\n[ \t]/g, '').split(/\r?\n/)
  const out: RawEvent[] = []
  let ev: RawEvent | null = null
  let depth = 0
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      ev = { props: {}, exdates: [], attendees: [] }
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
    else if (p.name === 'ATTENDEE') ev.attendees.push({ value: p.value, params: p.params })
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
  const rid = ev['RECURRENCE-ID']
  const organizer = ev.ORGANIZER && mailto(ev.ORGANIZER.value)
  return {
    uid: `${ev.UID?.value ?? ''}|${rid?.value ?? startValue ?? start.iso}`,
    icalUid: ev.UID?.value ?? '',
    recurrence: rid ? icalTime(rid.value, rid.params)?.iso : startValue ? start.iso : undefined,
    title: icalText(ev.SUMMARY?.value ?? '') || '(No title)',
    start: start.iso,
    end,
    allDay: start.allDay,
    location,
    description: description || undefined,
    meet: (ev.URL && MEETING.exec(ev.URL.value)?.[0]) || MEETING.exec(location ?? '')?.[0] || MEETING.exec(description)?.[0],
    attendees: raw.attendees.length
      ? raw.attendees.map((a) => ({ email: mailto(a.value), name: a.params.CN, status: PARTSTAT[a.params.PARTSTAT ?? ''], organizer: mailto(a.value) === organizer || undefined }))
      : undefined,
  }
}

const mailto = (v: string) => v.replace(/^mailto:/i, '').trim().toLowerCase()
const PARTSTAT: Record<string, CaldavAttendee['status']> = { ACCEPTED: 'accepted', DECLINED: 'declined', TENTATIVE: 'tentative', 'NEEDS-ACTION': 'needs-action' }

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

export type CaldavCalendar = { id: string; account: number; href: string; name: string; color: string; writable: boolean }

/** Every calendar of every CalDAV account (ids are "caldav:<account>:<href>"), and what went wrong
 * per account (a refused app password, a server that is down), named after the account. */
export async function caldavCalendars(user: User): Promise<{ calendars: CaldavCalendar[]; errors: string[] }> {
  const errors: string[] = []
  const lists = await Promise.all(
    accounts(user).map((a) =>
      cached(`${user.id}|cals|${a.id}`, 10 * 60_000, () => discover(a))
        .then((cals) => cals.map((c) => ({ id: `caldav:${a.id}:${c.href}`, account: a.id, href: c.href, name: c.name, color: c.color, writable: c.writable })))
        .catch((e: Error) => (errors.push(`${a.label}: ${e.message}`), [] as CaldavCalendar[])),
    ),
  )
  return { calendars: lists.flat(), errors }
}

/** The events in range, each with the address of the iCalendar object it lives in. */
export async function caldavEvents(user: User, calendar: CaldavCalendar, from: Date, to: Date): Promise<(CaldavEvent & { href: string })[]> {
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
    const events = responses(xml).flatMap((r) => parseEvents(unescapeXml(prop(r.body, 'calendar-data') ?? ''), from, to).map((e) => ({ ...e, href: resolve(calendar.href, r.href) })))
    // Keep what falls in range (expanded series come with a margin).
    const lo = from.toISOString()
    const hi = to.toISOString()
    return events.filter((e) => (e.allDay ? `${e.end}T00:00:00.000Z` > lo && `${e.start}T00:00:00.000Z` < hi : e.end > lo && e.start < hi))
  })
}

// ---------------------------------------------------------------------------------------------
// Changes: new events, and edits made in the event's own iCalendar text. Times are written the
// way the event already has them (in its TZID, or UTC); new events get UTC times, which every
// client shows in its own zone. With people invited and the username an email address, that is
// the organizer, and servers that do scheduling (Fastmail) mail the invitations.

/** Where a CalDAV event lives: its calendar, the iCalendar object, its UID and (one occurrence of a series) when that one was meant to start. */
export type CaldavRef = { k: 'c'; c: string; h: string; u: string; r?: string }

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/([,;])/g, '\\$1')

/** Lines over 75 octets folded, as RFC 5545 asks (never inside a character). */
function fold(line: string): string {
  if (Buffer.byteLength(line) <= 75) return line
  const parts: string[] = []
  let current = ''
  let size = 0
  for (const ch of line) {
    const n = Buffer.byteLength(ch)
    if (size + n > (parts.length ? 74 : 75)) {
      parts.push(current)
      current = ''
      size = 0
    }
    current += ch
    size += n
  }
  parts.push(current)
  return parts.join('\r\n ')
}

/** An iCalendar text as lines, each VEVENT gathered into its own array of lines. */
type Ics = (string | string[])[]

function parseIcs(ics: string): Ics {
  const out: Ics = []
  let ev: string[] | null = null
  let depth = 0
  for (const line of ics.replace(/\r?\n[ \t]/g, '').split(/\r?\n/)) {
    if (!line) continue
    if (!ev) {
      if (line === 'BEGIN:VEVENT') {
        ev = [line]
        depth = 0
      } else out.push(line)
      continue
    }
    ev.push(line)
    if (line.startsWith('BEGIN:')) depth++
    else if (line.startsWith('END:')) {
      if (depth === 0) {
        out.push(ev)
        ev = null
      } else depth--
    }
  }
  return out
}

const printIcs = (ics: Ics) => `${ics.flat().map(fold).join('\r\n')}\r\n`
const eventsIn = (ics: Ics) => ics.filter((x): x is string[] => Array.isArray(x))

/** Indexes of the event's own `name` lines (not its alarms'). */
function own(ev: string[], name: string): number[] {
  const out: number[] = []
  let depth = 0
  for (let i = 1; i < ev.length - 1; i++) {
    if (ev[i].startsWith('BEGIN:')) depth++
    else if (ev[i].startsWith('END:')) depth--
    else if (depth === 0 && parseLine(ev[i])?.name === name) out.push(i)
  }
  return out
}

function getProp(ev: string[], name: string): Prop | null {
  const i = own(ev, name)[0]
  const p = i === undefined ? null : parseLine(ev[i])
  return p && { value: p.value, params: p.params }
}

/** Where a new property goes: before the event's alarms, or its end. */
const insertPoint = (ev: string[]) => {
  const nested = ev.findIndex((l, i) => i > 0 && l.startsWith('BEGIN:'))
  return nested > 0 ? nested : ev.length - 1
}

/** Replaces the event's `name` lines with `lines` (none: removes them). */
function setProp(ev: string[], name: string, lines: string[]) {
  const at = own(ev, name)
  for (const i of [...at].reverse()) ev.splice(i, 1)
  ev.splice(at[0] ?? insertPoint(ev), 0, ...lines)
}

const isDate = (p: Prop) => p.params.VALUE === 'DATE' || /^\d{8}$/.test(p.value.trim())
const param = (v: string) => (/[:;,]/.test(v) ? `"${v}"` : v)

/** A DTSTART-like line for `iso`, written like `like` (the event's DTSTART): in its TZID if it has one, otherwise UTC. */
function timeLine(name: string, iso: string, allDay: boolean, like?: Prop | null): string {
  if (allDay) return `${name};VALUE=DATE:${iso.slice(0, 10).replace(/-/g, '')}`
  const tzid = like && !isDate(like) && !/Z$/.test(like.value) ? like.params.TZID : undefined
  if (tzid) {
    try {
      const ms = Date.parse(iso)
      return `${name};TZID=${param(tzid)}:${davTime(new Date(ms + zoneOffset(ms, tzid.replace(/^\/[^/]*\//, '')))).slice(0, 15)}`
    } catch {
      /* an unknown zone: UTC below */
    }
  }
  return `${name}:${davTime(new Date(iso))}`
}

/** How long the event lasts, from DTEND or DURATION. */
function lengthOf(ev: string[]): number {
  const start = getProp(ev, 'DTSTART')!
  const s = icalTime(start.value, start.params)!
  const endProp = getProp(ev, 'DTEND')
  const e = endProp && icalTime(endProp.value, endProp.params)
  if (e) return Date.parse(e.iso) - Date.parse(s.iso)
  return duration(getProp(ev, 'DURATION')?.value ?? (s.allDay ? 'P1D' : 'PT0S'))
}

const sameStart = (a: string | undefined, b: string) => !!a && (a.length === 10 || b.length === 10 ? a.slice(0, 10) === b.slice(0, 10) : Date.parse(a) === Date.parse(b))
const asDate = (ms: number) => new Date(ms).toISOString().slice(0, 10)

function applyInput(ev: string[], input: Partial<EventInput>, self: string) {
  const text = (name: string, v: string | undefined) => v !== undefined && setProp(ev, name, v ? [`${name}:${esc(v)}`] : [])
  text('SUMMARY', input.title)
  text('LOCATION', input.location)
  text('DESCRIPTION', input.description)
  if (input.start !== undefined && input.end !== undefined && input.allDay !== undefined) {
    const like = getProp(ev, 'DTSTART')
    setProp(ev, 'DTSTART', [timeLine('DTSTART', input.start, input.allDay, like)])
    setProp(ev, 'DTEND', [timeLine('DTEND', input.end, input.allDay, like)])
    setProp(ev, 'DURATION', [])
  }
  if (input.attendees !== undefined) {
    const lines = own(ev, 'ATTENDEE').map((i) => ev[i])
    const byEmail = new Map(lines.map((l) => [mailto(parseLine(l)!.value), l]))
    const organizer = getProp(ev, 'ORGANIZER')
    const organizerEmail = organizer ? mailto(organizer.value) : self.includes('@') ? self : null
    // You (the organizer) stay on it, with your own answer.
    const keep = lines.filter((l) => [organizerEmail, self].includes(mailto(parseLine(l)!.value)))
    const wanted = input.attendees.filter((email) => ![organizerEmail, self].includes(email.toLowerCase()))
    setProp(ev, 'ATTENDEE', [...keep, ...wanted.map((email) => byEmail.get(email.toLowerCase()) ?? `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${email}`)])
    if (!organizer && wanted.length && organizerEmail) setProp(ev, 'ORGANIZER', [`ORGANIZER:mailto:${organizerEmail}`])
  }
  const sequence = Number(getProp(ev, 'SEQUENCE')?.value ?? 0)
  setProp(ev, 'SEQUENCE', [`SEQUENCE:${Number.isFinite(sequence) ? sequence + 1 : 1}`])
  const now = davTime(new Date())
  setProp(ev, 'DTSTAMP', [`DTSTAMP:${now}`])
  setProp(ev, 'LAST-MODIFIED', [`LAST-MODIFIED:${now}`])
}

/** The account and calendar for a calendar id, if it is one of this user's. */
async function calendarFor(user: User, calendarId: string): Promise<{ account: Account; calendar: CaldavCalendar }> {
  const calendar = (await caldavCalendars(user)).calendars.find((c) => c.id === calendarId)
  const account = calendar && accounts(user).find((a) => a.id === calendar.account)
  if (!calendar || !account) throw new HttpError(404, 'That calendar is not connected')
  return { account, calendar }
}

/** An object's address, only if it is inside that calendar (refs come back from the browser). */
function objectUrl(calendar: CaldavCalendar, href: string): string {
  const base = new URL(calendar.href)
  const url = new URL(href, base)
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`)) throw new HttpError(400, 'That event is not in that calendar')
  return url.href
}

function refused(res: Response, url: string): never {
  const host = new URL(url).host
  if (res.status === 401 || res.status === 403) throw new HttpError(403, `${host} refused the change; an app password that can write is needed (Settings → Calendar, add the account again)`)
  if (res.status === 404 || res.status === 410) throw new HttpError(404, 'That event is gone from the calendar')
  if (res.status === 412) throw new HttpError(409, 'It changed somewhere else meanwhile; try again')
  throw new HttpError(502, `${host} answered ${res.status}`)
}

async function getObject(account: Account, url: string): Promise<{ ics: Ics; etag: string | null }> {
  const res = await request(account, 'GET', url, { headers: { Accept: 'text/calendar' } })
  if (!res.ok) refused(res, url)
  return { ics: parseIcs(await res.text()), etag: res.headers.get('etag') }
}

/** Writes an object: `etag` it must still have, or 'new' for one that must not exist yet. */
async function putObject(account: Account, url: string, ics: Ics, etag: string | null | 'new') {
  const headers: Record<string, string> = { 'Content-Type': 'text/calendar; charset=utf-8' }
  if (etag === 'new') headers['If-None-Match'] = '*'
  else if (etag) headers['If-Match'] = etag
  const res = await request(account, 'PUT', url, { headers, body: printIcs(ics) })
  if (!res.ok) refused(res, url)
}

async function deleteObject(account: Account, url: string) {
  const res = await request(account, 'DELETE', url)
  if (!res.ok && res.status !== 404) refused(res, url)
}

export async function createCaldavEvent(user: User, calendarId: string, input: EventInput) {
  const { account, calendar } = await calendarFor(user, calendarId)
  const uid = randomUUID()
  const ev = ['BEGIN:VEVENT', `UID:${uid}`, `CREATED:${davTime(new Date())}`, 'END:VEVENT']
  applyInput(ev, input, account.username.toLowerCase())
  setProp(ev, 'SEQUENCE', ['SEQUENCE:0'])
  const href = `${calendar.href.endsWith('/') ? calendar.href : `${calendar.href}/`}${uid}.ics`
  await putObject(account, href, ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//mvlos//Calendar//EN', 'CALSCALE:GREGORIAN', ev, 'END:VCALENDAR'], 'new')
  clearCaldavCache(user)
}

/** The series (no RECURRENCE-ID) and the occurrence changed on its own that started out at `r`. */
function find(ics: Ics, uid: string, r?: string) {
  const mine = eventsIn(ics).filter((ev) => getProp(ev, 'UID')?.value === uid)
  const master = mine.find((ev) => !getProp(ev, 'RECURRENCE-ID')) ?? null
  const override = r
    ? (mine.find((ev) => {
        const rid = getProp(ev, 'RECURRENCE-ID')
        return rid && sameStart(icalTime(rid.value, rid.params)?.iso, r)
      }) ?? null)
    : null
  return { master, override }
}

/**
 * Changes an event. For one occurrence of a repeating event, `all` changes the whole series (a
 * new time moves every occurrence by as much as this one moved); otherwise only that occurrence
 * changes, as an exception to the series.
 */
export async function updateCaldavEvent(user: User, ref: CaldavRef, input: Partial<EventInput>, all: boolean) {
  const { account, calendar } = await calendarFor(user, ref.c)
  const url = objectUrl(calendar, ref.h)
  const { ics, etag } = await getObject(account, url)
  const { master, override } = find(ics, ref.u, ref.r)
  const self = account.username.toLowerCase()
  if (!ref.r) {
    if (!master) throw new HttpError(404, 'That event is gone from the calendar')
    applyInput(master, input, self)
  } else if (all) {
    if (!master) throw new HttpError(409, 'The series itself is not in this calendar')
    const patch = { ...input }
    if (input.start !== undefined && input.end !== undefined) {
      const start = getProp(master, 'DTSTART')!
      const was = icalTime(start.value, start.params)!
      if (was.allDay !== input.allDay) throw new HttpError(400, 'Switch all day for one occurrence at a time')
      const moved = Date.parse(input.start) - Date.parse(ref.r)
      const length = Date.parse(input.end) - Date.parse(input.start)
      const at = Date.parse(was.iso) + moved
      patch.start = was.allDay ? asDate(at) : new Date(at).toISOString()
      patch.end = was.allDay ? asDate(at + length) : new Date(at + length).toISOString()
      if (moved) shiftExceptions(ics, master, moved)
    }
    applyInput(master, patch, self)
  } else {
    let ev = override
    if (!ev) {
      if (!master) throw new HttpError(409, 'The series itself is not in this calendar')
      // A copy of the series for this one occurrence, at its own time to begin with.
      const start = getProp(master, 'DTSTART')!
      const allDay = isDate(start)
      ev = [...master]
      for (const name of ['RRULE', 'RDATE', 'EXDATE', 'EXRULE', 'DURATION']) setProp(ev, name, [])
      const end = Date.parse(ref.r) + lengthOf(master)
      setProp(ev, 'RECURRENCE-ID', [timeLine('RECURRENCE-ID', ref.r, allDay, start)])
      setProp(ev, 'DTSTART', [timeLine('DTSTART', ref.r, allDay, start)])
      setProp(ev, 'DTEND', [timeLine('DTEND', allDay ? asDate(end) : new Date(end).toISOString(), allDay, start)])
      ics.splice(ics.indexOf(master) + 1, 0, ev)
    }
    applyInput(ev, input, self)
  }
  await putObject(account, url, ics, etag)
  clearCaldavCache(user)
}

/** A series moved by `ms`: its left-out (EXDATE) and changed (RECURRENCE-ID) occurrences move along, so they still match theirs. */
function shiftExceptions(ics: Ics, master: string[], ms: number) {
  const moved = (value: string, params: Record<string, string>, name: string) => {
    const t = icalTime(value, params)
    if (!t) return null
    const at = Date.parse(t.iso) + ms
    return timeLine(name, t.allDay ? asDate(at) : new Date(at).toISOString(), t.allDay, { value, params })
  }
  for (const i of own(master, 'EXDATE').reverse()) {
    const p = parseLine(master[i])!
    master.splice(i, 1, ...p.value.split(',').flatMap((v) => moved(v.trim(), p.params, 'EXDATE') ?? []))
  }
  const uid = getProp(master, 'UID')?.value
  for (const ev of eventsIn(ics)) {
    const rid = ev !== master && getProp(ev, 'UID')?.value === uid ? getProp(ev, 'RECURRENCE-ID') : null
    const line = rid && moved(rid.value, rid.params, 'RECURRENCE-ID')
    if (line) setProp(ev, 'RECURRENCE-ID', [line])
  }
}

/** Deletes an event, one occurrence of a series (left out of it with EXDATE), or (`all`) the whole series. */
export async function deleteCaldavEvent(user: User, ref: CaldavRef, all: boolean) {
  const { account, calendar } = await calendarFor(user, ref.c)
  const url = objectUrl(calendar, ref.h)
  if (!ref.r || all) {
    await deleteObject(account, url)
  } else {
    const { ics, etag } = await getObject(account, url)
    const { master, override } = find(ics, ref.u, ref.r)
    if (override) ics.splice(ics.indexOf(override), 1)
    if (master) {
      const start = getProp(master, 'DTSTART')!
      master.splice(insertPoint(master), 0, timeLine('EXDATE', ref.r, isDate(start), start))
      applyInput(master, {}, account.username.toLowerCase())
    } else if (!override) throw new HttpError(404, 'That event is gone from the calendar')
    if (eventsIn(ics).length) await putObject(account, url, ics, etag)
    else await deleteObject(account, url)
  }
  clearCaldavCache(user)
}

/** Moves an event's whole iCalendar object to another CalDAV calendar (on any connected account). */
export async function moveCaldavEvent(user: User, ref: CaldavRef, calendarId: string) {
  const from = await calendarFor(user, ref.c)
  const to = await calendarFor(user, calendarId)
  const url = objectUrl(from.calendar, ref.h)
  const { ics } = await getObject(from.account, url)
  const name = new URL(url).pathname.split('/').filter(Boolean).pop() ?? `${randomUUID()}.ics`
  await putObject(to.account, `${to.calendar.href.endsWith('/') ? to.calendar.href : `${to.calendar.href}/`}${name}`, ics, 'new')
  await deleteObject(from.account, url)
  clearCaldavCache(user)
}
