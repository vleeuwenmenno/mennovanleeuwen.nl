import type { User } from './auth.ts'
import { caldavByUid, clearCaldavCache, getCaldavEvent, listCaldav, markCaldavNote } from './caldav.ts'
import { allCalendars, allEvents, decodeRef, encodeRef, hiddenCalendars } from './calendars.ts'
import { clearGoogleCache, googleByUid, googleEventInfo, markGoogleNote, type CalendarEvent } from './google.ts'
import { HttpError } from './http.ts'
import { tellPages } from './notifier.ts'
import { readState, writeState } from './state.ts'
import { cleanNoteEvents, linkMatches, MAX_NOTE_EVENTS, NOTE_ID, type NoteEvent } from '../src/data/noteEvents.ts'

// Notes linked to calendar events (src/data/noteEvents.ts says how a link is kept): the server's
// part. The link itself lives on the note, in the synced notes (server/state.ts); here the event
// gets a private backlink as well, so the event itself says it has notes wherever MvL OS reads it:
//
//   - CalDAV: an X-MVLOS-NOTE line with the note's id, written into the event's own iCalendar text
//     with its ETag (server/caldav.ts markCaldavNote), everything else kept, nothing that counts as
//     a change to the meeting (no SEQUENCE), and events with guests left alone;
//   - Google: the note ids in the event's private extended properties, with sendUpdates=none
//     (server/google.ts markGoogleNote).
//
// Both work for one occurrence or a whole series. The backlink is a convenience: when it can't be
// written (a read-only calendar, guests) the link still works, from the note. Everything is the
// user's own: events only through refs within their connected calendars, notes only their own.

/** An event as a link and a meeting note need it. */
export type EventInfo = {
  ref: string
  source: 'google' | 'caldav'
  calendarId: string
  uid: string
  occurrence?: string
  recurring: boolean
  title: string
  start: string
  end: string
  allDay: boolean
  location?: string
  attendees: { email: string; name?: string; organizer?: boolean; self?: boolean }[]
  /** Its backlinks: ids of notes linked to it. */
  notes: string[]
}

/** One event (or one occurrence) by its ref, as it is now. Throws 404 when it is gone. */
export async function eventInfo(user: User, rawRef: unknown): Promise<EventInfo> {
  const ref = decodeRef(rawRef)
  if (ref.k === 'g') {
    const g = await googleEventInfo(user, ref)
    if (!g.uid) throw new HttpError(400, 'That event has no UID')
    return { ref: encodeRef(ref), source: 'google', calendarId: ref.c, ...g }
  }
  const e = await getCaldavEvent(user, ref)
  const self = listCaldav(user).find((a) => ref.c.startsWith(`caldav:${a.id}:`))?.username.toLowerCase()
  return {
    ref: encodeRef(ref),
    source: 'caldav',
    calendarId: ref.c,
    uid: e.icalUid,
    occurrence: ref.r ?? e.recurrence,
    recurring: !!ref.r || e.series,
    title: e.title,
    start: e.start,
    end: e.end,
    allDay: e.allDay,
    location: e.location,
    attendees: (e.attendees ?? []).map((a) => ({ email: a.email, name: a.name, organizer: a.organizer, self: a.email === self || undefined })),
    notes: e.notes ?? [],
  }
}

/** The link a note keeps to an event: to that occurrence, or (`all`, or not repeating) to the event or series. */
export function linkTo(e: EventInfo, all: boolean): NoteEvent {
  return {
    source: e.source,
    calendarId: e.calendarId,
    uid: e.uid,
    ...(e.recurring && !all && e.occurrence ? { occurrence: e.occurrence } : {}),
    ...(e.recurring ? { repeats: true } : {}),
    ref: e.ref,
    title: e.title,
    start: e.start,
    end: e.end,
    allDay: e.allDay,
    linked: Date.now(),
  }
}

/** Writes (or takes out) the event's backlink to a note. */
export async function markEvent(user: User, rawRef: unknown, noteId: string, opts: { all: boolean; unlink: boolean }): Promise<{ mirrored: boolean; why?: string }> {
  if (!NOTE_ID.test(noteId)) throw new HttpError(400, 'Bad note id')
  const ref = decodeRef(rawRef)
  try {
    return ref.k === 'g' ? await markGoogleNote(user, ref, noteId, opts) : await markCaldavNote(user, ref, noteId, opts)
  } finally {
    // The Calendar app and the Agenda show which events have notes: fetch again.
    tellPages(user.id, 'calendar')
  }
}

/**
 * The browser's call (POST /api/calendar/note-link): { ref, note, all?, unlink? }, or instead of
 * `ref` the `link` as the note keeps it (its ref may be out of date: then the event is looked up
 * by UID). Answers whether the event got its backlink, and why not.
 */
export async function noteLinkApi(user: User, body: { ref?: unknown; link?: unknown; note?: unknown; all?: unknown; unlink?: unknown }): Promise<{ mirrored: boolean; why?: string; ref?: string }> {
  const note = String(body.note ?? '')
  if (!NOTE_ID.test(note)) throw new HttpError(400, 'Bad note id')
  const link = cleanNoteEvents([body.link])?.[0]
  const opts = { all: body.all === true, unlink: body.unlink === true }
  let ref = typeof body.ref === 'string' ? body.ref : link?.ref
  if (!ref && link) ref = (await findLinked(user, link)).event?.ref
  if (!ref) {
    if (opts.unlink) return { mirrored: false, why: 'The event is gone' }
    throw new HttpError(400, 'Which event?')
  }
  try {
    return { ...(await markEvent(user, ref, note, opts)), ref }
  } catch (e) {
    // Moved since the note last saw it: find it again by its UID.
    if (e instanceof HttpError && e.status === 404 && link) {
      const found = (await findLinked(user, link)).event?.ref
      if (found && found !== ref) return { ...(await markEvent(user, found, note, opts)), ref: found }
      if (opts.unlink) return { mirrored: false, why: 'The event is gone' }
    }
    throw e
  }
}

/**
 * The event a link points at, as it is now: looked for around when it was (a link to a series:
 * its next occurrence), in the calendar it was in first and then in the others. `gone` only when
 * every calendar answered and the event (or that occurrence) is not there any more.
 */
export async function findLinked(user: User, link: { uid: string; calendarId?: string; occurrence?: string; start?: string }, fresh = false): Promise<{ event: CalendarEvent | null; gone: boolean }> {
  // Asked for by a click: past the two-minute caches, to see a change made elsewhere just now.
  if (fresh) {
    clearCaldavCache(user)
    clearGoogleCache(user)
  }
  const DAY = 864e5
  const at = Date.parse(link.occurrence ?? link.start ?? '')
  const base = Math.floor((isNaN(at) ? Date.now() : at) / DAY) * DAY
  const range = { from: new Date(base - 62 * DAY), to: new Date(base + 63 * DAY) }
  // A hidden calendar still answers for the calendar a link names (it may be a calendar the user hid since), but is not searched otherwise.
  const { calendars, errors } = await allCalendars(user, true)
  const hidden = hiddenCalendars(user)
  let failed = errors.length > 0
  const pick = (events: CalendarEvent[]) => {
    const hits = events.filter((e) => linkMatches(link, e))
    if (!hits.length) return null
    if (link.occurrence) return hits[0]
    const now = Date.now()
    return hits.find((e) => Date.parse(e.allDay ? `${e.end}T00:00:00Z` : e.end) > now) ?? hits[hits.length - 1]
  }
  const first = calendars.filter((c) => c.id === link.calendarId).map((c) => c.id)
  const rest = calendars.filter((c) => c.id !== link.calendarId && !hidden.has(c.id)).map((c) => c.id)
  for (const ids of [first, rest]) {
    if (!ids.length) continue
    const found = await allEvents(user, ids, range)
    if (found.errors.length) failed = true
    const e = pick(found.events)
    if (e) return { event: e, gone: false }
  }
  if (failed) return { event: null, gone: false }
  // Not near when it was: is the event there at all? (A series still there without that occurrence: it was deleted.)
  const there = (await caldavByUid(user, link.uid).catch(() => [1])).length > 0 || !!(await googleByUid(user, link.uid).catch(() => true))
  return { event: null, gone: !there || !!link.occurrence }
}

// ---------------------------------------------------------------------------------------------
// The notes, as synced desktop state (src/data/notes.ts keeps the same shape)

export type NoteRow = { id: string; text: string; color?: string; tilt?: number; created?: number; updated?: number; deleted?: number; purged?: boolean; events?: NoteEvent[]; eventsAt?: number }

export const readNotes = (user: User): NoteRow[] => {
  const v = readState(user).notes?.value
  return Array.isArray(v) ? (v as NoteRow[]).filter((n) => n && typeof n.id === 'string') : []
}

/** Changes the notes on the server; open pages fetch them again, and merge them in by id. */
export function writeNotes(user: User, change: (all: NoteRow[]) => NoteRow[]) {
  writeState(user, 'notes', { value: change(readNotes(user)) })
  tellPages(user.id, 'state', { key: 'notes' })
}

/** A note that is there (not in the trash, not deleted), or a message for the model. */
export function liveNote(user: User, id: unknown): NoteRow {
  const n = readNotes(user).find((x) => x.id === String(id ?? '').trim() && !x.purged)
  if (!n) throw new Error(`No note with id ${String(id ?? '')}: find it with search_notes first`)
  if (n.deleted) throw new Error("That note is in the Notebook's trash")
  return n
}

/** Changes one note's links (and when, so a merge with another device keeps the newest links). */
export function changeLinks(user: User, noteId: string, change: (links: NoteEvent[]) => NoteEvent[]) {
  writeNotes(user, (all) =>
    all.map((n) => {
      if (n.id !== noteId) return n
      const events = change(cleanNoteEvents(n.events) ?? []).slice(0, MAX_NOTE_EVENTS)
      // Not an edit of the text: `updated` stays (the Notebook sorts by it).
      return { ...n, events, eventsAt: Date.now() }
    }),
  )
}
