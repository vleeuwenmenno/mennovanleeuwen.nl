import type { User } from './auth.ts'
import { caldavCalendars, caldavEvents, createCaldavEvent, deleteCaldavEvent, listCaldav, moveCaldavEvent, updateCaldavEvent, type CaldavRef } from './caldav.ts'
import {
  createGoogleEvent,
  deleteGoogleEvent,
  googleAccount,
  listCalendars,
  listEvents,
  moveGoogleEvent,
  updateGoogleEvent,
  type CalendarEvent,
  type CalendarInfo,
  type GoogleRef,
} from './google.ts'
import { HttpError } from './http.ts'

// Every calendar the owner connected, Google and CalDAV together, for the Agenda widget, the
// clock and the Calendar app: one list of calendars (CalDAV ids start with "caldav:") and one list
// of events. One source failing (an expired Google link, a refused app password) doesn't hide the
// others: its problem comes back in `errors`, named after the account.
//
// The Calendar app also changes events through here. Each event carries a `ref`, opaque to the
// browser, that says where it lives; it comes back with the change and is checked against the
// connected calendars before anything is sent anywhere.

export type AnyCalendar = CalendarInfo & { source: string }

/** An event as the Calendar app sends it: ISO times, or "YYYY-MM-DD" dates when all day (end exclusive). */
export type EventInput = { title: string; start: string; end: string; allDay: boolean; location?: string; description?: string; attendees?: string[]; timeZone?: string }

type Ref = GoogleRef | CaldavRef
const encodeRef = (r: Ref) => Buffer.from(JSON.stringify(r)).toString('base64url')
function decodeRef(raw: unknown): Ref {
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
      ...caldav.calendars.map((c) => ({ id: c.id, name: c.name, color: c.color, primary: false, selected: true, writable: c.writable, source: labels.get(c.account) ?? 'CalDAV' })),
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

/** Checks and tidies what the browser sent; `partial` allows leaving fields out. */
function cleanInput(raw: unknown, partial: boolean): Partial<EventInput> {
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
  if (!partial && (out.start === undefined || out.title === undefined)) throw new HttpError(400, 'A new event needs a title, start and end')
  return out
}

const isCaldav = (calendarId: string) => calendarId.startsWith('caldav:')

export async function createEvent(user: User, body: { calendar?: unknown; event?: unknown }) {
  const calendar = String(body.calendar ?? '')
  const input = cleanInput(body.event, false) as EventInput
  if (!calendar) throw new HttpError(400, 'Pick a calendar')
  if (isCaldav(calendar)) await createCaldavEvent(user, calendar, input)
  else await createGoogleEvent(user, calendar, input)
}

/**
 * Changes an event; `all` for every occurrence of a repeating one. A new `calendar` moves it
 * there (not for one occurrence of a series): within Google or between CalDAV calendars it moves
 * as it is; between the two it is made again there (with the fields sent) and deleted here.
 */
export async function updateEvent(user: User, body: { ref?: unknown; event?: unknown; calendar?: unknown; all?: unknown }) {
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
}

export async function deleteEvent(user: User, body: { ref?: unknown; all?: unknown }) {
  const ref = decodeRef(body.ref)
  if (ref.k === 'g') await deleteGoogleEvent(user, ref, body.all === true)
  else await deleteCaldavEvent(user, ref, body.all === true)
}
