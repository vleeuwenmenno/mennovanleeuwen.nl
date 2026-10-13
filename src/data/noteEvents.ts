// Notes linked to calendar events, as the browser (src/data/notes.ts, src/os/noteEventLinks.tsx)
// and the server (server/noteLinks.ts, the Agents app's tools in server/agentNoteLinks.ts) both
// see them. No imports, so the server can use it as it is.
//
// The link lives on the note: the event's iCalendar UID (the same in every calendar and app that
// has the event, and kept when it is renamed or moved), which occurrence of a repeating event (its
// RECURRENCE-ID, the time it was first meant to start, which also stays when that one occurrence
// moves) or none for the whole series, and the calendar it was in. A copy of the title and time
// is kept beside it, to show when the event can't be read (another device without the calendar,
// a deleted event), and is brought up to date whenever the event is seen. Notes sync, so the link
// follows the user to every device. The event gets a private backlink too (server/noteLinks.ts),
// but nothing depends on it.

/** A note's link to an event (or to every occurrence of a repeating one). */
export type NoteEvent = {
  source: 'google' | 'caldav'
  /** The calendar it was in when last seen (a hint: the UID finds it anywhere). */
  calendarId: string
  /** Its iCalendar UID. */
  uid: string
  /** One occurrence of a repeating event: when it was meant to start (ISO time, or "YYYY-MM-DD"). None: the event, or every occurrence. */
  occurrence?: string
  /** The event repeats (without an occurrence: the link is to every one). */
  repeats?: boolean
  /** Where it lived when last seen, for the server (opaque; may be out of date). */
  ref?: string
  /** What it was called and when it was, when last seen. */
  title: string
  start: string
  end: string
  allDay: boolean
  /** When it was linked. */
  linked: number
  /** The event (or that occurrence) was deleted, last time anyone looked. */
  gone?: boolean
}

/** At most this many events per note. */
export const MAX_NOTE_EVENTS = 20

/** A note id as the Notebook makes them (a UUID), checked before it goes into an event. */
export const NOTE_ID = /^[\w-]{1,64}$/

/** Whether two occurrence starts are the same occurrence: dates by day, times to the second. */
export function sameOccurrence(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  if (a.length === 10 || b.length === 10) return a.slice(0, 10) === b.slice(0, 10)
  return Date.parse(a) === Date.parse(b)
}

/** Whether a link is to this event: the same UID and, for a link to one occurrence, that occurrence. A link to the series matches every occurrence. */
export const linkMatches = (link: { uid: string; occurrence?: string }, e: { uid?: string; occurrence?: string }) => !!e.uid && link.uid === e.uid && (!link.occurrence || sameOccurrence(link.occurrence, e.occurrence))

/** The links on a note as stored, checked and tidied (anything malformed is left out). */
export function cleanNoteEvents(v: unknown): NoteEvent[] | undefined {
  if (!Array.isArray(v)) return undefined
  const text = (x: unknown, max: number) => (typeof x === 'string' ? x.slice(0, max) : '')
  const out: NoteEvent[] = []
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    if ((r.source !== 'google' && r.source !== 'caldav') || typeof r.uid !== 'string' || !r.uid || typeof r.calendarId !== 'string') continue
    out.push({
      source: r.source,
      calendarId: text(r.calendarId, 1000),
      uid: text(r.uid, 1000),
      ...(typeof r.occurrence === 'string' && r.occurrence ? { occurrence: text(r.occurrence, 40) } : {}),
      ...(r.repeats === true ? { repeats: true } : {}),
      ...(typeof r.ref === 'string' && r.ref ? { ref: text(r.ref, 3000) } : {}),
      title: text(r.title, 300) || '(No title)',
      start: text(r.start, 40),
      end: text(r.end, 40),
      allDay: r.allDay === true,
      linked: typeof r.linked === 'number' ? r.linked : 0,
      ...(r.gone === true ? { gone: true } : {}),
    })
    if (out.length >= MAX_NOTE_EVENTS) break
  }
  return out
}

/** A note's title: its first line, without Markdown heading or list marks. */
export function textTitle(text: string): string {
  const line = text.split('\n').find((l) => l.trim()) ?? ''
  return line.replace(/^\s*(#{1,6}\s+|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/, '').trim().slice(0, 80) || 'New note'
}

/**
 * A meeting note for an event: its title and day as the heading, when and where, who is coming,
 * then places for the agenda, notes and action items. The times come already written in the
 * reader's time zone (the browser's, or the one the Agents window sent).
 */
export function meetingNoteText(m: { title: string; day: string; when: string; location?: string; attendees: string[]; agenda?: string }): string {
  const agenda = m.agenda?.trim()
  return [
    `# ${m.title} — ${m.day}`,
    '',
    `**When:** ${m.when}`,
    ...(m.location ? [`**Where:** ${m.location}`] : []),
    ...(m.attendees.length ? [`**Attendees:** ${m.attendees.join(', ')}`] : []),
    '',
    '## Agenda',
    agenda || '- ',
    '',
    '## Notes',
    '',
    '',
    '## Action items',
    '- [ ] ',
    '',
  ].join('\n')
}
