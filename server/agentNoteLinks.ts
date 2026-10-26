import { randomUUID } from 'node:crypto'
import type { User } from './auth.ts'
import { protectPreparedCalendar, calendarsOf, eventDay, eventId, refOf, whenText, type CallSummary, type Prepared } from './agentCalendar.ts'
import { changeLinks, eventInfo, findLinked, liveNote, linkTo, markEvent, readNotes, writeNotes, type EventInfo, type NoteRow } from './noteLinks.ts'
import { assertCaldavLink, caldavLinkVersion } from './caldav.ts'
import { assertGoogleLink, googleLinkGeneration } from './google.ts'
import { cleanNoteEvents, linkMatches, MAX_NOTE_EVENTS, meetingNoteText, sameOccurrence, textTitle } from '../src/data/noteEvents.ts'

// The Agents app's tools for notes linked to calendar events (server/noteLinks.ts): which notes an
// event has and which events a note is linked to (these only look), linking and unlinking a note
// and an event, and a meeting note made for an event, already linked. Events are named by the ids
// calendar_list_events gives (server/agentCalendar.ts), notes by the ids search_notes gives.
//
// Linking changes the note and writes a backlink into the event, so these ask in every mode, like
// the calendar's changes (server/agents.ts decide). Like those, each call is checked and worked out
// first, so a mistake goes back to the model before the user is asked, and the card says exactly
// which note and which event.

export const NOTE_LINK_WRITES = new Set(['link_note_to_event', 'unlink_note_from_event', 'make_meeting_note'])
export const NOTE_LINK_TOOLS = new Set(['notes_for_event', 'events_for_note', ...NOTE_LINK_WRITES])

type ToolDef = { type: 'function'; function: { name: string; description: string; parameters: { type: 'object'; properties: Record<string, unknown>; required?: string[] } } }
const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []): ToolDef => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } })
const str = (description: string) => ({ type: 'string', description })
const bool = (description: string) => ({ type: 'boolean', description })

export function noteLinkTools(): ToolDef[] {
  const event = str('The event id, exactly as calendar_list_events gave it')
  const note = str('The note id, from search_notes or create_note')
  const all = bool('For a repeating event: link every occurrence (the whole series), not just this one (default false)')
  return [
    tool('notes_for_event', "The user's notes linked to an event (meeting notes, say), in full, each with its id.", { event_id: event }, ['event_id']),
    tool('events_for_note', 'The calendar events a note is linked to: each one as it is now (with its id, when it can be found), or as it was when it has been deleted.', { note_id: note }, ['note_id']),
    tool(
      'link_note_to_event',
      'Link one of the user\'s notes to a calendar event, so the Calendar shows the note on the event and the note shows the event. Use it when the user asks to link or attach a note to a meeting. Nobody is mailed.',
      { note_id: note, event_id: event, all_occurrences: all },
      ['note_id', 'event_id'],
    ),
    tool('unlink_note_from_event', 'Take the link between a note and an event away (the note and the event both stay).', { note_id: note, event_id: event }, ['note_id', 'event_id']),
    tool(
      'make_meeting_note',
      'Make a meeting note for an event, linked to it: its title and date as the heading, when and where, who is coming, and places for the agenda, notes and action items. Use it when the user asks for notes for a meeting ("make notes for my 2pm meeting"): find the event with calendar_list_events first. Answers the new note\'s id, for update_note.',
      { event_id: event, agenda: str('Agenda items to fill in, in Markdown (optional; only what the user gave)'), all_occurrences: all },
      ['event_id'],
    ),
  ]
}

/** What the system prompt says about them, with the calendar's lines. */
export const NOTE_LINK_LINES =
  'Notes and events: a note can be linked to a calendar event (link_note_to_event); the Calendar then shows it on the event and the note shows the event. When the user wants notes for a meeting ("make notes for my 2pm meeting"), find the event with calendar_list_events and use make_meeting_note, which makes the note already linked. calendar_list_events says how many notes each event has (linked_notes); notes_for_event reads them.'

const fail = (message: string): never => {
  throw new Error(message)
}
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)

/** The event the model named, as it is now, and the note links that apply to it. */
async function eventOf(user: User, id: unknown) {
  const { calendars } = await calendarsOf(user)
  const { ref, calendar } = refOf(id, calendars)
  return { info: await eventInfo(user, ref), calendar }
}

const linkedHere = (n: NoteRow, e: EventInfo) => (cleanNoteEvents(n.events) ?? []).some((l) => linkMatches(l, e)) || e.notes.includes(n.id)
const scopeRow = (e: EventInfo, all: boolean): [string, string][] => (e.recurring ? [['Applies to', all ? 'Every occurrence (the whole series)' : 'Only this occurrence']] : [])

/** Links a note to an event: on the note (unless it has that link already), then the event's backlink. */
async function link(user: User, noteId: string, e: EventInfo, all: boolean) {
  const wanted = linkTo(e, all)
  let added = false
  changeLinks(user, noteId, (links) => {
    if (links.some((l) => l.uid === wanted.uid && (l.occurrence ? sameOccurrence(l.occurrence, wanted.occurrence) : !wanted.occurrence))) return links
    if (links.length >= MAX_NOTE_EVENTS) fail(`A note can be linked to at most ${MAX_NOTE_EVENTS} events`)
    added = true
    return [...links, wanted]
  })
  // The backlink is a convenience: the link works without it.
  const mirror = await markEvent(user, e.ref, noteId, { all: !wanted.occurrence, unlink: false }).catch((err: Error) => ({ mirrored: false, why: err.message }))
  return { added, mirror }
}

/** Checks a call and gets it ready (see server/agentCalendar.ts prepareCalendarCall). Throws what the model should be told. */
export async function prepareNoteLinkCall(user: User, name: string, args: Record<string, unknown>, zone: string): Promise<Prepared> {
  const google = googleLinkGeneration(user)
  const caldav = caldavLinkVersion(user)
  const prepared = await prepareNoteLinkCallInner(user, name, args, zone)
  assertGoogleLink(user, google)
  assertCaldavLink(user, caldav)
  return protectPreparedCalendar(user, google, caldav, prepared)
}

async function prepareNoteLinkCallInner(user: User, name: string, args: Record<string, unknown>, zone: string): Promise<Prepared> {
  if (name === 'events_for_note') {
    const note = liveNote(user, args.note_id)
    return {
      run: async () => {
        // One Google snapshot for all the lookups, taken before the first await: Google takes part
        // only if it was connected now, and nothing of it is returned if the link changes before the
        // answer is written (a lookup that fails for that reason falls back like any other failure,
        // so the whole answer is checked at the end).
        const google = googleLinkGeneration(user)
        const caldav = caldavLinkVersion(user)
        const links = cleanNoteEvents(note.events) ?? []
        const events = await Promise.all(
          links.map(async (l) => {
            const now = await findLinked(user, l, false, google, caldav).catch(() => ({ event: null, gone: false }))
            const e = now.event ?? l
            return {
              ...(now.event?.ref ? { id: eventId(now.event.ref) } : {}),
              title: e.title,
              when: whenText(e, zone),
              applies_to: l.occurrence ? 'this occurrence' : 'the event (every occurrence if it repeats)',
              ...(now.gone ? { deleted: true } : now.event ? {} : { note: 'Not found near when it was; this is how it was when linked' }),
            }
          }),
        )
        assertGoogleLink(user, google)
        assertCaldavLink(user, caldav)
        return JSON.stringify({ note: { id: note.id, title: textTitle(note.text) }, events })
      },
    }
  }

  const { info: e, calendar } = await eventOf(user, args.event_id)
  const all = args.all_occurrences === true

  if (name === 'notes_for_event')
    return {
      run: async () => {
        const notes = readNotes(user).filter((n) => !n.purged && !n.deleted && linkedHere(n, e))
        return JSON.stringify({ event: { title: e.title, when: whenText(e, zone) }, notes: notes.map((n) => ({ id: n.id, title: textTitle(n.text), text: clip(n.text, 4000) })) })
      },
    }

  const eventRow: [string, string] = ['Event', `${e.title}, ${whenText(e, zone)}`]
  const calendarRow: [string, string] = ['Calendar', `${calendar.name} (${calendar.source})`]

  if (name === 'link_note_to_event') {
    const note = liveNote(user, args.note_id)
    const summary: CallSummary = { title: `Link “${clip(textTitle(note.text), 60)}” to “${clip(e.title, 60)}”`, rows: [['Note', textTitle(note.text)], eventRow, calendarRow, ...scopeRow(e, all)] }
    return {
      summary,
      run: async () => {
        const { added, mirror } = await link(user, note.id, e, all)
        return JSON.stringify({ linked: { note: textTitle(note.text), event: e.title, when: whenText(e, zone), ...(e.recurring ? { applies_to: all ? 'the whole series' : 'this occurrence' } : {}) }, ...(added ? {} : { note: 'They were linked already' }), ...(mirror.mirrored ? {} : { event_backlink: `not written: ${mirror.why}` }) })
      },
    }
  }

  if (name === 'unlink_note_from_event') {
    const note = liveNote(user, args.note_id)
    const links = (cleanNoteEvents(note.events) ?? []).filter((l) => linkMatches(l, e))
    if (!links.length && !e.notes.includes(note.id)) throw new Error('That note is not linked to that event')
    return {
      summary: { title: `Unlink “${clip(textTitle(note.text), 60)}” from “${clip(e.title, 60)}”`, rows: [['Note', textTitle(note.text)], eventRow, calendarRow] },
      run: async () => {
        changeLinks(user, note.id, (all) => all.filter((l) => !linkMatches(l, e)))
        // The backlink of each link taken away (a series' too), or the stray one the event had.
        const scopes = links.length ? links.map((l) => !l.occurrence) : [true]
        for (const series of scopes) await markEvent(user, e.ref, note.id, { all: series, unlink: true }).catch(() => null)
        return JSON.stringify({ unlinked: { note: textTitle(note.text), event: e.title, when: whenText(e, zone) } })
      },
    }
  }

  if (name === 'make_meeting_note') {
    const agenda = typeof args.agenda === 'string' ? args.agenda.trim().slice(0, 20_000) : ''
    const people = e.attendees.filter((a) => !a.self).map((a) => a.name || a.email)
    const text = meetingNoteText({ title: e.title, day: eventDay(e, zone), when: whenText(e, zone), location: e.location, attendees: people, agenda })
    return {
      summary: { title: `Make a meeting note for “${clip(e.title, 80)}”`, rows: [eventRow, calendarRow, ...(people.length ? [['Attendees', clip(people.join(', '), 300)] as [string, string]] : []), ...scopeRow(e, all), ...(agenda ? [['Agenda', clip(agenda, 400)] as [string, string]] : [])] },
      run: async () => {
        const now = Date.now()
        const id = randomUUID()
        const tilt = Math.round((Math.random() < 0.5 ? -1 : 1) * (0.8 + Math.random() * 2.7) * 10) / 10
        writeNotes(user, (notes) => [...notes, { id, text, color: 'blue', tilt, created: now, updated: now, edited: now, events: [], eventsAt: now }])
        const { mirror } = await link(user, id, e, all)
        return JSON.stringify({ note: { id, title: textTitle(text) }, linked_to: { title: e.title, when: whenText(e, zone), ...(e.recurring ? { applies_to: all ? 'the whole series' : 'this occurrence' } : {}) }, ...(mirror.mirrored ? {} : { event_backlink: `not written: ${mirror.why}` }) })
      },
    }
  }

  throw new Error(`There is no tool called ${name}`)
}

