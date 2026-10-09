import type { User } from './auth.ts'
import { caldavCalendars, caldavEvents, listCaldav } from './caldav.ts'
import { googleAccount, listCalendars, listEvents, type CalendarEvent, type CalendarInfo } from './google.ts'

// Every calendar the owner connected, Google and CalDAV together, for the Agenda widget and the
// clock: one list of calendars (CalDAV ids start with "caldav:") and one list of events. One
// source failing (an expired Google link, a refused app password) doesn't hide the others: its
// problem comes back in `errors`, named after the account.

export type AnyCalendar = CalendarInfo & { source: string }

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
      ...caldav.calendars.map((c) => ({ id: c.id, name: c.name, color: c.color, primary: false, selected: true, source: labels.get(c.account) ?? 'CalDAV' })),
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
  const [google, caldav] = await Promise.all([
    googleWanted ? listEvents(user, googleIds, range).catch((e) => (errors.push(message('Google', e)), [] as CalendarEvent[])) : Promise.resolve([] as CalendarEvent[]),
    Promise.all(
      pick.map((cal) =>
        caldavEvents(user, cal, range.from, range.to)
          .then((events) => events.map<CalendarEvent>((e) => ({ id: `${cal.id}|${e.uid}`, calendar: cal.name, color: cal.color, title: e.title, start: e.start, end: e.end, allDay: e.allDay, location: e.location, meet: e.meet })))
          .catch((e) => (errors.push(message(cal.name, e)), [] as CalendarEvent[])),
      ),
    ).then((l) => l.flat()),
  ])
  return {
    events: [...google, ...caldav].sort((a, b) => a.start.localeCompare(b.start) || Number(b.allDay) - Number(a.allDay)),
    errors: [...new Set(errors)],
  }
}
