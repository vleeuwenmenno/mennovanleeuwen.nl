import { dayKey, type CalendarEvent } from '../../data/calendar'
import { datesIn, displayName, type Contact, type PersonDate } from '../../data/contacts'
import { addDays, parseDay } from './time'

// The Birthdays calendar: your contacts' birthdays and anniversaries (src/data/contacts.ts) as
// all-day events, with the age they turn. It is read-only and kept in the browser (nothing is
// written to a calendar), on in the sidebar unless switched off there (the same synced switches
// as the other calendars, under the id "birthdays"). Opening one opens the contact.

export const BIRTHDAYS = 'birthdays'
export const BIRTHDAY_COLOR = '#e0af68'

export type BirthdayEvent = CalendarEvent & { person: PersonDate }

export const isBirthdayEvent = (e: CalendarEvent): e is BirthdayEvent => 'person' in e && !!(e as BirthdayEvent).person

/** "Ann turns 40", "Ann's birthday", "Ann and Bob: Wedding (10 years)". */
export function birthdayTitle(d: PersonDate): string {
  const name = displayName(d.contact)
  if (d.kind === 'birthday') return d.years !== undefined ? `${name} turns ${d.years}` : `${name}’s birthday`
  return `${name}: ${d.label}${d.years !== undefined ? ` (${d.years} ${d.years === 1 ? 'year' : 'years'})` : ''}`
}

/** The birthdays and anniversaries between `from` and `to`, as all-day events. */
export function birthdayEvents(contacts: Contact[], from: Date, to: Date): BirthdayEvent[] {
  return datesIn(contacts, from, to).map((d) => ({
    id: `birthday:${d.contact.id}:${d.kind}:${d.label}:${d.date}`,
    calendarId: BIRTHDAYS,
    calendar: 'Birthdays',
    color: BIRTHDAY_COLOR,
    title: `${d.kind === 'birthday' ? '🎂' : '💍'} ${birthdayTitle(d)}`,
    start: d.date,
    end: dayKey(addDays(parseDay(d.date), 1)),
    allDay: true,
    editable: false,
    person: d,
  }))
}
