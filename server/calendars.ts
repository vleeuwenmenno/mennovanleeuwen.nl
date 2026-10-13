import type { User } from './auth.ts'
import { caldavCalendars, caldavEvents, caldavKnownUids, createCaldavEvent, deleteCaldavEvent, getCaldavEvent, listCaldav, moveCaldavEvent, updateCaldavEvent, type CaldavRef } from './caldav.ts'
import {
  createGoogleEvent,
  deleteGoogleEvent,
  getGoogleEvent,
  googleAccount,
  googleKnownUids,
  listCalendars,
  listEvents,
  moveGoogleEvent,
  updateGoogleEvent,
  type CalendarEvent,
  type CalendarInfo,
  type GoogleRef,
} from './google.ts'
import { HttpError } from './http.ts'
import { tellPages } from './notifier.ts'

// Every calendar the user connected, Google and CalDAV together, for the Agenda widget, the
// clock and the Calendar app: one list of calendars (CalDAV ids start with "caldav:") and one list
// of events. One source failing (an expired Google link, a refused app password) doesn't hide the
// others: its problem comes back in `errors`, named after the account.
//
// The Calendar app also changes events through here. Each event carries a `ref`, opaque to the
// browser, that says where it lives; it comes back with the change and is checked against the
// connected calendars before anything is sent anywhere.

export type AnyCalendar = CalendarInfo & { source: string }

/**
 * An event as the Calendar app sends it: ISO times, or "YYYY-MM-DD" dates when all day (end
 * exclusive). `recurrence` is an RRULE's value (FREQ=WEEKLY;BYDAY=MO), only for a new event: the
 * Agents app makes repeating events, the Calendar app doesn't yet.
 */
export type EventInput = { title: string; start: string; end: string; allDay: boolean; location?: string; description?: string; attendees?: string[]; timeZone?: string; recurrence?: string; uid?: string }

export type Ref = GoogleRef | CaldavRef
export const encodeRef = (r: Ref) => Buffer.from(JSON.stringify(r)).toString('base64url')
export function decodeRef(raw: unknown): Ref {
  try {
    const r = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8')) as Ref
    if ((r.k === 'g' && typeof r.c === 'string' && typeof r.e === 'string') || (r.k === 'c' && typeof r.c === 'string' && typeof r.h === 'string' && typeof r.u === 'string')) return r
  } catch {
    /* below */
  }
  throw new HttpError(400, 'Unknown event')
}

const message = (source: string, e: unknown) => `${source}: ${e instanceof Error ? e.message : String(e)}`

export async function allCalendars(user: User): Promise<{ calendars: AnyCalendar[]; errors: string[] }> {
  const labels = new Map(listCaldav(user).map((a) => [a.id, a.label]))
  const errors: string[] = []
  const [google, caldav] = await Promise.all([
    googleAccount(user) ? listCalendars(user).catch((e) => (errors.push(message('Google', e)), [] as CalendarInfo[])) : Promise.resolve([] as CalendarInfo[]),
    caldavCalendars(user),
  ])
  return {
    calendars: [
      ...google.map((c) => ({ ...c, source: 'Google' })),
      ...caldav.calendars.map((c) => ({
        id: c.id,
        name: c.name,
        color: c.color,
        primary: false,
        selected: true,
        writable: c.writable,
        source: labels.get(c.account) ?? 'CalDAV',
        // Only said for shared ones: a CalDAV server doesn't mark the calendars that are simply yours.
        ...(c.shared === 'with-you' ? { access: c.writable ? ('writer' as const) : ('reader' as const) } : c.shared === 'by-you' ? { access: 'owner' as const } : {}),
      })),
    ],
    errors: [...errors, ...caldav.errors],
  }
}

/** Events in range from the given calendars (default: Google's shown ones and every CalDAV one). */
export async function allEvents(user: User, ids: string[] | null, range: { from: Date; to: Date }): Promise<{ events: CalendarEvent[]; errors: string[] }> {
  const caldavIds = ids?.filter((id) => id.startsWith('caldav:')) ?? null
  const googleIds = ids?.filter((id) => !id.startsWith('caldav:')) ?? null
  const { calendars: cals, errors } = await caldavCalendars(user)
  const pick = caldavIds ? cals.filter((c) => caldavIds.includes(c.id)) : cals
  const googleWanted = googleAccount(user) && (!googleIds || googleIds.length > 0)
  const usernames = new Map(listCaldav(user).map((a) => [a.id, a.username.toLowerCase()]))
  const [google, caldav] = await Promise.all([
    googleWanted ? listEvents(user, googleIds, range, encodeRef).catch((e) => (errors.push(message('Google', e)), [] as CalendarEvent[])) : Promise.resolve([] as CalendarEvent[]),
    Promise.all(
      pick.map((cal) =>
        caldavEvents(user, cal, range.from, range.to)
          .then((events) =>
            events.map<CalendarEvent>((e) => ({
              id: `${cal.id}|${e.uid}`,
              calendarId: cal.id,
              calendar: cal.name,
              color: cal.color,
              title: e.title,
              start: e.start,
              end: e.end,
              allDay: e.allDay,
              location: e.location,
              description: e.description,
              meet: e.meet,
              attendees: e.attendees?.map((a) => ({ ...a, self: a.email === usernames.get(cal.account) || undefined })),
              recurring: !!e.recurrence || undefined,
              editable: cal.writable,
              ref: encodeRef({ k: 'c', c: cal.id, h: e.href, u: e.icalUid, r: e.recurrence }),
              uid: e.icalUid || undefined,
              ...(e.recurrence ? { occurrence: e.recurrence } : {}),
              ...(e.notes?.length ? { notes: e.notes } : {}),
            })),
          )
          .catch((e) => (errors.push(message(cal.name, e)), [] as CalendarEvent[])),
      ),
    ).then((l) => l.flat()),
  ])
  return {
    events: [...google, ...caldav].sort((a, b) => a.start.localeCompare(b.start) || Number(b.allDay) - Number(a.allDay)),
    errors: [...new Set(errors)],
  }
}

// ---------------------------------------------------------------------------------------------
// Changes

const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

/** Checks and tidies what the browser sent; `partial` allows leaving fields out. The Agents app checks with it before asking the user. */
export function cleanInput(raw: unknown, partial: boolean): Partial<EventInput> {
  if (!raw || typeof raw !== 'object') throw new HttpError(400, 'No event given')
  const r = raw as Record<string, unknown>
  const out: Partial<EventInput> = {}
  const text = (k: 'title' | 'location' | 'description', max: number) => {
    if (r[k] === undefined) return
    if (typeof r[k] !== 'string') throw new HttpError(400, `Bad ${k}`)
    out[k] = (r[k] as string).trim().slice(0, max)
  }
  text('title', 300)
  text('location', 500)
  text('description', 8000)
  if (r.start !== undefined || r.end !== undefined || r.allDay !== undefined) {
    const { start, end, allDay } = r as { start?: unknown; end?: unknown; allDay?: unknown }
    if (typeof start !== 'string' || typeof end !== 'string' || typeof allDay !== 'boolean') throw new HttpError(400, 'Give start, end and all day together')
    const ok = allDay ? DATE.test(start) && DATE.test(end) : !isNaN(Date.parse(start)) && !isNaN(Date.parse(end))
    if (!ok) throw new HttpError(400, 'Bad start or end')
    if (Date.parse(end) <= Date.parse(start)) throw new HttpError(400, 'It has to end after it starts')
    Object.assign(out, allDay ? { start, end, allDay } : { start: new Date(start).toISOString(), end: new Date(end).toISOString(), allDay })
  }
  if (r.attendees !== undefined) {
    if (!Array.isArray(r.attendees) || r.attendees.length > 50) throw new HttpError(400, 'Bad guest list')
    const emails = [...new Set(r.attendees.map((a) => String(a).trim().toLowerCase()))]
    const bad = emails.find((e) => !EMAIL.test(e))
    if (bad) throw new HttpError(400, `${bad} is not an email address`)
    out.attendees = emails
  }
  if (typeof r.timeZone === 'string' && /^[\w+-]+(?:\/[\w+-]+)*$/.test(r.timeZone)) out.timeZone = r.timeZone
  if (r.recurrence !== undefined && r.recurrence !== null && r.recurrence !== '') {
    if (partial) throw new HttpError(400, 'How an event repeats can only be set when it is made')
    out.recurrence = cleanRule(r.recurrence)
  }
  // An imported event's own iCalendar UID, only for a new one (so importing the same file again can skip what is there).
  if (typeof r.uid === 'string' && !partial && /^[\x21-\x7e]{1,200}$/.test(r.uid) && !/[;,\\]/.test(r.uid)) out.uid = r.uid
  if (!partial && (out.start === undefined || out.title === undefined)) throw new HttpError(400, 'A new event needs a title, start and end')
  return out
}

/** The repeat rules both Google and CalDAV take as they are, and that the agenda can show. */
const RULE_PARTS = new Set(['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'BYSETPOS', 'WKST'])

/** An RRULE value ("RRULE:" in front allowed), checked part by part. */
function cleanRule(raw: unknown): string {
  const rule = String(raw).trim().replace(/^RRULE:/i, '').toUpperCase()
  const parts = rule.split(';').filter(Boolean).map((p) => p.split('='))
  const bad = () => new HttpError(400, `"${String(raw).slice(0, 100)}" is not a repeat rule like FREQ=WEEKLY;BYDAY=MO,WE;COUNT=10`)
  if (!parts.length || parts.some((p) => p.length !== 2 || !RULE_PARTS.has(p[0]) || !/^[A-Z0-9,+-]+$/.test(p[1]))) throw bad()
  const get = (k: string) => parts.find((p) => p[0] === k)?.[1]
  if (!/^(DAILY|WEEKLY|MONTHLY|YEARLY)$/.test(get('FREQ') ?? '')) throw bad()
  if (get('COUNT') && get('UNTIL')) throw new HttpError(400, 'A repeat rule has COUNT or UNTIL, not both')
  if (get('UNTIL') && !/^\d{8}(T\d{6}Z)?$/.test(get('UNTIL')!)) throw new HttpError(400, 'UNTIL is a date like 20261231, or a UTC time like 20261231T230000Z')
  return parts.map((p) => p.join('=')).join(';')
}

const isCaldav = (calendarId: string) => calendarId.startsWith('caldav:')

/** Makes an event; answers its ref (the Agents app hands it to the model, to change it later). */
export async function createEvent(user: User, body: { calendar?: unknown; event?: unknown }): Promise<string> {
  const calendar = String(body.calendar ?? '')
  const input = cleanInput(body.event, false) as EventInput
  if (!calendar) throw new HttpError(400, 'Pick a calendar')
  try {
    return encodeRef(isCaldav(calendar) ? await createCaldavEvent(user, calendar, input) : await createGoogleEvent(user, calendar, input))
  } finally {
    // The Calendar app, the Agenda widget and the clock, in every open page (an agent added it, or
    // another device did): fetch again. Also after a failure, which may have half happened.
    tellPages(user.id, 'calendar')
  }
}

/** Which of these iCalendar UIDs the calendar already has: an import skips those. */
export async function knownUids(user: User, body: { calendar?: unknown; uids?: unknown }): Promise<string[]> {
  const calendar = String(body.calendar ?? '')
  const uids = Array.isArray(body.uids) ? [...new Set(body.uids.filter((u): u is string => typeof u === 'string' && u.length > 0 && u.length <= 200))].slice(0, 2000) : []
  if (!calendar) throw new HttpError(400, 'Pick a calendar')
  return uids.length ? (isCaldav(calendar) ? caldavKnownUids(user, calendar, uids) : googleKnownUids(user, calendar, uids)) : []
}

/**
 * Changes an event; `all` for every occurrence of a repeating one. A new `calendar` moves it
 * there (not for one occurrence of a series): within Google or between CalDAV calendars it moves
 * as it is; between the two it is made again there (with the fields sent) and deleted here.
 */
export async function updateEvent(user: User, body: { ref?: unknown; event?: unknown; calendar?: unknown; all?: unknown }) {
  try {
    const ref = decodeRef(body.ref)
    const input = cleanInput(body.event, true)
    const all = body.all === true
    const target = typeof body.calendar === 'string' && body.calendar !== ref.c ? body.calendar : null
    const recurring = ref.k === 'g' ? !!ref.m : !!ref.r
    if (target && recurring) throw new HttpError(400, 'A repeating event stays in its calendar')
    if (target && isCaldav(target) !== (ref.k === 'c')) {
      const full = input as EventInput
      if (full.title === undefined || full.start === undefined) throw new HttpError(400, 'Send the whole event to move it there')
      await createEvent(user, { calendar: target, event: full })
      await deleteEvent(user, { ref: body.ref })
      return
    }
    if (ref.k === 'g') {
      if (Object.keys(input).some((k) => k !== 'timeZone')) await updateGoogleEvent(user, ref, input, all)
      if (target) await moveGoogleEvent(user, ref, target)
    } else {
      if (Object.keys(input).some((k) => k !== 'timeZone')) await updateCaldavEvent(user, ref, input, all)
      if (target) await moveCaldavEvent(user, ref, target)
    }
  } finally {
    tellPages(user.id, 'calendar')
  }
}

/** One event (or one occurrence of a series) as it is now: what the Agents app changes from. */
export type EventNow = { title: string; start: string; end: string; allDay: boolean; location?: string; description?: string; recurring: boolean; guests: number; calendarId: string }
export async function getEvent(user: User, rawRef: unknown): Promise<EventNow> {
  const ref = decodeRef(rawRef)
  if (ref.k === 'g') return { ...(await getGoogleEvent(user, ref)), calendarId: ref.c }
  const e = await getCaldavEvent(user, ref)
  const self = listCaldav(user).find((a) => ref.c.startsWith(`caldav:${a.id}:`))?.username.toLowerCase()
  return {
    title: e.title,
    start: e.start,
    end: e.end,
    allDay: e.allDay,
    location: e.location,
    description: e.description,
    recurring: !!ref.r || e.series,
    guests: (e.attendees ?? []).filter((a) => !a.organizer && a.email !== self).length,
    calendarId: ref.c,
  }
}

export async function deleteEvent(user: User, body: { ref?: unknown; all?: unknown }) {
  const ref = decodeRef(body.ref)
  try {
    if (ref.k === 'g') await deleteGoogleEvent(user, ref, body.all === true)
    else await deleteCaldavEvent(user, ref, body.all === true)
  } finally {
    tellPages(user.id, 'calendar')
  }
}
