import type { User } from './auth.ts'
import { caldavCalendars, caldavEvents, listCaldav } from './caldav.ts'
import { googleAccount, listCalendars, listEvents, type CalendarEvent, type CalendarInfo } from './google.ts'

// Every calendar the owner connected, Google and CalDAV together, for the Agenda widget and the
// clock: one list of calendars (CalDAV ids start with "caldav:") and one list of events.

export type AnyCalendar = CalendarInfo & { source: string }

export async function allCalendars(user: User): Promise<AnyCalendar[]> {
  const labels = new Map(listCaldav(user).map((a) => [a.id, a.label]))
  const [google, caldav] = await Promise.all([googleAccount(user) ? listCalendars(user) : Promise.resolve([]), caldavCalendars(user)])
  return [
    ...google.map((c) => ({ ...c, source: 'Google' })),
    ...caldav.map((c) => ({ id: c.id, name: c.name, color: c.color, primary: false, selected: true, source: labels.get(c.account) ?? 'CalDAV' })),
  ]
}

/** Events in range from the given calendars (default: Google's shown ones and every CalDAV one). */
export async function allEvents(user: User, ids: string[] | null, range: { from: Date; to: Date }): Promise<CalendarEvent[]> {
  const caldavIds = ids?.filter((id) => id.startsWith('caldav:')) ?? null
  const googleIds = ids?.filter((id) => !id.startsWith('caldav:')) ?? null
  const cals = await caldavCalendars(user)
  const pick = caldavIds ? cals.filter((c) => caldavIds.includes(c.id)) : cals
  const googleWanted = googleAccount(user) && (!googleIds || googleIds.length > 0)
  const [google, caldav] = await Promise.all([
    // With CalDAV calendars to show, a broken Google link doesn't blank the whole agenda.
    googleWanted ? listEvents(user, googleIds, range).catch((e) => (cals.length ? [] : Promise.reject(e))) : Promise.resolve([] as CalendarEvent[]),
    Promise.all(
      pick.map((cal) =>
        caldavEvents(user, cal, range.from, range.to)
          .then((events) => events.map<CalendarEvent>((e) => ({ id: `${cal.id}|${e.uid}`, calendar: cal.name, color: cal.color, title: e.title, start: e.start, end: e.end, allDay: e.allDay, location: e.location, meet: e.meet })))
          .catch(() => [] as CalendarEvent[]),
      ),
    ).then((l) => l.flat()),
  ])
  return [...google, ...caldav].sort((a, b) => a.start.localeCompare(b.start) || Number(b.allDay) - Number(a.allDay))
}
