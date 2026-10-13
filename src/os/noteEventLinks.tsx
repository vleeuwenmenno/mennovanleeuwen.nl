import { useEffect, useMemo, useState } from 'react'
import {
  calendarChangedElsewhere,
  dayKey,
  fetchEvents,
  onEventsFetched,
  openEventByUid,
  registerEventAction,
  registerEventMark,
  registerEventSlot,
  startOfDay,
  useShownCalendarIds,
  type CalendarEvent,
} from '../data/calendar'
import { displayName, peekContactByEmail } from '../data/contacts'
import { linkMatches, MAX_NOTE_EVENTS, meetingNoteText, sameOccurrence, type NoteEvent } from '../data/noteEvents'
import { allNotes, createNote, noteTitle, onNotePurged, registerNoteAction, registerNoteSlot, setAllNoteEvents, setNoteEvents, subscribeNotes, useAllNotes, type Note } from '../data/notes'
import { api, getAccount, hasCalendar } from './account'
import { choose } from './Dialogs'
import { notify } from './notify'
import './noteEventLinks.css'

// Notes linked to calendar events, for meeting notes: the Calendar and the Notebook plug into each
// other here (src/data/calendar.ts and notes.ts have the hooks), once for the page, the way
// src/os/pimLinks.tsx joins Mail, Contacts and Calendar.
//
//   - An event (its menu, and the editor) gets "New meeting note" (a note titled with the event
//     and its day, a small template with the guests, linked and opened), "Link a note…" (a
//     picker), and its linked notes, each to open or unlink. Events with notes have a 📝 beside
//     their title in the Calendar's views and the Agenda.
//   - A note (the Notebook's menus and the sticky's) gets "Link to an event…" (a picker of events
//     around today, by title and date), and chips with each event it is linked to, which open the
//     Calendar at that event; the Notebook's list marks linked notes with 📅.
//
// The link is kept on the note (src/data/noteEvents.ts says how); the server also writes a
// private backlink into the event (server/noteLinks.ts), which is best effort.

let started = false

export function startNoteEventLinks() {
  if (started) return
  started = true

  const real = (e: CalendarEvent) => !!e.ref && !!e.uid
  registerEventAction({ id: 'meeting-note', label: 'New meeting note', when: real, run: (e) => void newMeetingNote(e) })
  registerEventAction({ id: 'link-note', label: 'Link a note…', when: real, run: (e) => void linkANote(e) })
  registerEventAction({
    id: 'linked-notes',
    label: 'Linked notes',
    when: (e) => real(e) && notesOf(allNotes(), e).length > 0,
    submenu: (e) => notesOf(allNotes(), e).map((n) => ({ label: noteTitle(n), run: () => openNote(n.id) })),
  })
  registerEventSlot('notes', (e) => (real(e) ? <EventNotes event={e} /> : null))
  const marks = registerEventMark((e) => {
    if (!real(e)) return null
    const notes = notesOf(allNotes(), e)
    if (!notes.length) return null
    return { glyph: '📝', title: notes.length === 1 ? `Note: ${noteTitle(notes[0])}` : `${notes.length} notes: ${notes.map(noteTitle).join(', ')}`, open: () => openNote(notes[0].id) }
  })
  subscribeNotes(marks.changed)

  registerNoteAction({ id: 'link-event', label: 'Link to an event…', when: (n) => !n.deleted && hasCalendar(getAccount()), run: (n) => void linkAnEvent(n) })
  registerNoteSlot('chips', (n, where) => (n.events?.length ? <NoteEventChips note={n} compact={where === 'sticky'} /> : null))
  registerNoteSlot('mark', (n) =>
    n.events?.length ? (
      <span className="nel-mark" title={`Linked to ${n.events.map((l) => l.title).join(', ')}`} role="img" aria-label="Linked to an event">
        📅{' '}
      </span>
    ) : null,
  )

  // Whenever events come in, the notes' copies of their titles and times follow.
  onEventsFetched(refreshFrom)
  // A note deleted for good: its events' backlinks go too.
  onNotePurged((n) => {
    if (!hasCalendar(getAccount())) return
    for (const l of n.events ?? []) void mirror({ link: l, note: n.id, all: !l.occurrence, unlink: true }).catch(() => {})
  })
}

// ---------------------------------------------------------------------------------------------
// Links

/** The notes linked to an event: by their own links, or by the event's backlinks. Notes in the trash don't count. */
export const notesOf = (notes: Note[], e: CalendarEvent) => notes.filter((n) => !n.deleted && !n.purged && ((n.events ?? []).some((l) => linkMatches(l, e)) || !!e.notes?.includes(n.id)))

const isOccurrence = (e: CalendarEvent) => !!e.recurring && !!e.occurrence

/** The link a note keeps to this event: this occurrence, or (`all`, or not repeating) the event or series. */
function linkOf(e: CalendarEvent, all: boolean): NoteEvent {
  return {
    source: e.calendarId.startsWith('caldav:') ? 'caldav' : 'google',
    calendarId: e.calendarId,
    uid: e.uid!,
    ...(isOccurrence(e) && !all ? { occurrence: e.occurrence } : {}),
    ...(e.recurring ? { repeats: true } : {}),
    ref: e.ref,
    title: e.title,
    start: e.start,
    end: e.end,
    allDay: e.allDay,
    linked: Date.now(),
  }
}

const sameLink = (a: { uid: string; occurrence?: string }, b: { uid: string; occurrence?: string }) => a.uid === b.uid && (a.occurrence ? sameOccurrence(a.occurrence, b.occurrence) : !b.occurrence)

/** The event's backlink (server/noteLinks.ts). */
const mirror = (body: { ref?: string; link?: NoteEvent; note: string; all: boolean; unlink?: boolean }) => api<{ mirrored: boolean; why?: string }>('/api/calendar/note-link', { method: 'POST', json: body })

/** Links a note to an event: on the note straight away, then the event's backlink. */
function link(note: Note, e: CalendarEvent, all: boolean) {
  const l = linkOf(e, all)
  if ((note.events ?? []).some((x) => sameLink(x, l))) return notify({ title: 'Linked already', body: `${noteTitle(note)} · ${e.title}`, transient: true })
  if ((note.events?.length ?? 0) >= MAX_NOTE_EVENTS) return notify({ title: 'Not linked', body: `A note can be linked to at most ${MAX_NOTE_EVENTS} events`, transient: true })
  setNoteEvents(note.id, (ls) => [...ls, l])
  notify({ title: 'Linked', body: `${noteTitle(note)} · ${e.title}`, transient: true })
  mirror({ ref: e.ref, link: l, note: note.id, all: !l.occurrence })
    .then(() => calendarChangedElsewhere())
    .catch((err: Error) => notify({ title: 'Linked on the note only', body: `The event itself could not be marked: ${err.message}`, transient: true }))
}

/** Takes one link off a note (and its event's backlink). */
function unlink(noteId: string, l: NoteEvent) {
  setNoteEvents(noteId, (ls) => ls.filter((x) => !sameLink(x, l)))
  if (hasCalendar(getAccount())) void mirror({ link: l, note: noteId, all: !l.occurrence, unlink: true }).then(() => calendarChangedElsewhere(), () => {})
}

/** Takes a note off an event: every link of the note that applies to it, or the event's stray backlink. */
function unlinkFromEvent(note: Note, e: CalendarEvent) {
  const links = (note.events ?? []).filter((l) => linkMatches(l, e))
  if (links.length) return links.forEach((l) => unlink(note.id, l))
  void mirror({ ref: e.ref, note: note.id, all: !isOccurrence(e), unlink: true }).then(() => calendarChangedElsewhere(), () => {})
}

/** The events that came in, against every note's links: newer titles and times are kept. */
function refreshFrom(events: CalendarEvent[]) {
  if (!events.length) return
  setAllNoteEvents((n) => {
    let changed = false
    const next = (n.events ?? []).map((l) => {
      const e = events.find((x) => x.ref && linkMatches(l, x))
      if (!e) return l
      // A link to a series keeps the time of the occurrence it was made from; its title follows.
      const now: Partial<NoteEvent> = l.occurrence || !e.recurring ? { title: e.title, start: e.start, end: e.end, allDay: e.allDay, ref: e.ref, calendarId: e.calendarId } : { title: e.title, calendarId: e.calendarId }
      if (!l.gone && Object.entries(now).every(([k, v]) => l[k as keyof NoteEvent] === v)) return l
      changed = true
      const { gone: _, ...rest } = l
      return { ...rest, ...now }
    })
    return changed ? next : null
  })
}

// ---------------------------------------------------------------------------------------------
// Opening

function openNote(id: string) {
  window.dispatchEvent(new CustomEvent('mvlos:open', { detail: { app: 'notebook', props: { id, t: String(Date.now()) } } }))
}

const dateOf = (iso: string, allDay: boolean) => new Date(allDay || iso.length === 10 ? `${iso.slice(0, 10)}T00:00:00` : iso)

/** Opens the Calendar at the event a link points at, found again first (it may have moved); a deleted one says so. */
async function openLinked(noteId: string, l: NoteEvent) {
  let found: { event: CalendarEvent | null; gone: boolean }
  try {
    found = await api('/api/calendar/find', { method: 'POST', json: { uid: l.uid, calendarId: l.calendarId, occurrence: l.occurrence, start: l.start, fresh: true } })
  } catch {
    // Can't ask now: open where it was.
    return openEventByUid(l.uid, dateOf(l.occurrence ?? l.start, l.allDay), l.occurrence)
  }
  if (found.event) {
    const e = found.event
    refreshFrom([e])
    return openEventByUid(l.uid, dateOf(e.start, e.allDay), l.occurrence ?? e.occurrence)
  }
  if (found.gone) {
    setNoteEvents(noteId, (ls) => ls.map((x) => (sameLink(x, l) ? { ...x, gone: true } : x)))
    const a = await choose({
      title: 'This event was deleted',
      body: `“${l.title}”, ${whenOf(l)}, is not in your calendars any more. The note keeps its link until you take it away.`,
      buttons: [
        { id: 'cancel', label: 'Keep the link' },
        { id: 'unlink', label: 'Unlink', primary: true },
      ],
    })
    if (a === 'unlink') unlink(noteId, l)
    return
  }
  openEventByUid(l.uid, dateOf(l.occurrence ?? l.start, l.allDay), l.occurrence)
}

/** "Tue 14 Oct, 10:00–11:00", "Fri 17 Oct, all day", with the year when it isn't this year's. */
function whenOf(e: { start: string; end: string; allDay: boolean }) {
  const a = dateOf(e.start, e.allDay)
  if (isNaN(a.getTime())) return ''
  const day = a.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', ...(a.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) }).replace(',', '')
  if (e.allDay) return `${day}, all day`
  const t = (d: Date) => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  const b = new Date(e.end)
  return `${day}, ${t(a)}${isNaN(b.getTime()) ? '' : `–${t(b)}`}`
}

// ---------------------------------------------------------------------------------------------
// Making and picking

/** A meeting note for an event (this occurrence, for a repeating one), linked to it and opened in the Notebook. */
function newMeetingNote(e: CalendarEvent) {
  const day = dateOf(e.start, e.allDay).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).replace(',', '')
  const people = (e.attendees ?? []).filter((a) => !a.self).map((a) => {
    const c = peekContactByEmail(a.email)
    return a.name || (c ? displayName(c) : a.email)
  })
  const note = createNote({ text: meetingNoteText({ title: e.title, day, when: whenOf(e), location: e.location, attendees: people }), color: 'blue' })
  link(note, e, false)
  openNote(note.id)
}

/** For a repeating event: link this occurrence, or every one? null: cancelled. */
async function scopeFor(e: CalendarEvent): Promise<boolean | null> {
  if (!isOccurrence(e)) return false
  const a = await choose({
    title: 'This event repeats',
    body: 'Link the note to this occurrence only, or to every occurrence?',
    buttons: [
      { id: 'cancel', label: 'Cancel' },
      { id: 'all', label: 'Every occurrence' },
      { id: 'one', label: 'Only this one', primary: true },
    ],
  })
  return a === 'one' ? false : a === 'all' ? true : null
}

/** "Link a note…" on an event: a note picked, then linked. */
async function linkANote(e: CalendarEvent) {
  let picked: string | null = null
  const id = await choose({
    title: `Link a note to “${e.title}”`,
    body: <NotePicker exclude={notesOf(allNotes(), e).map((n) => n.id)} onPick={(n) => (picked = n)} />,
    buttons: [
      { id: 'cancel', label: 'Cancel' },
      { id: 'new', label: 'New meeting note' },
      { id: 'link', label: 'Link', primary: true },
    ],
  })
  if (id === 'new') return newMeetingNote(e)
  const note = id === 'link' && picked ? allNotes().find((n) => n.id === picked) : null
  if (!note) return
  const all = await scopeFor(e)
  if (all !== null) link(note, e, all)
}

/** "Link to an event…" on a note: an event picked, then linked. */
async function linkAnEvent(note: Note) {
  let picked: CalendarEvent | null = null
  const id = await choose({
    title: `Link “${noteTitle(note)}” to an event`,
    body: <EventPicker onPick={(e) => (picked = e)} />,
    buttons: [
      { id: 'cancel', label: 'Cancel' },
      { id: 'link', label: 'Link', primary: true },
    ],
  })
  const e = id === 'link' ? (picked as CalendarEvent | null) : null
  if (!e) return
  const all = await scopeFor(e)
  if (all !== null) link(note, e, all)
}

/** Picking happens in a dialog: a click on a row picks it and presses the dialog's main button. */
const confirmFrom = (el: Element | null) => el?.closest('.dlg')?.querySelector<HTMLButtonElement>('.btn-primary')?.click()

/** Moves through a picker's rows with the arrow keys; Enter picks. */
function useRows(count: number, pick: (i: number, el: Element) => void) {
  const [at, setAt] = useState(0)
  useEffect(() => setAt((i) => Math.min(i, Math.max(0, count - 1))), [count])
  const onKeyDown = (ev: React.KeyboardEvent<HTMLInputElement>) => {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault()
      setAt((i) => Math.max(0, Math.min(count - 1, i + (ev.key === 'ArrowDown' ? 1 : -1))))
    } else if (ev.key === 'Enter' && count) {
      ev.preventDefault()
      pick(at, ev.currentTarget)
    }
  }
  return { at, onKeyDown }
}

function NotePicker({ exclude, onPick }: { exclude: string[]; onPick: (id: string) => void }) {
  const notes = useAllNotes()
  const [q, setQ] = useState('')
  const list = useMemo(() => {
    const query = q.trim().toLowerCase()
    return notes
      .filter((n) => !n.deleted && !n.purged && !exclude.includes(n.id) && (!query || n.text.toLowerCase().includes(query)))
      .sort((a, b) => b.updated - a.updated)
      .slice(0, 50)
  }, [notes, q, exclude])
  const pick = (i: number, el: Element) => {
    onPick(list[i].id)
    confirmFrom(el)
  }
  const rows = useRows(list.length, pick)
  useEffect(() => {
    if (list[rows.at]) onPick(list[rows.at].id)
  }, [list, rows.at, onPick])
  return (
    <div className="nel-picker">
      <input className="dlg-input" data-autofocus="" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={rows.onKeyDown} placeholder="Search notes" aria-label="Search notes" autoComplete="off" spellCheck={false} />
      <ul className="nel-list" role="listbox" aria-label="Notes">
        {list.map((n, i) => (
          <li key={n.id}>
            <button type="button" role="option" aria-selected={i === rows.at} className={`nel-row ${i === rows.at ? 'is-on' : ''}`} onClick={(e) => pick(i, e.currentTarget)}>
              <span className="nel-row-title">{noteTitle(n)}</span>
              <span className="nel-row-sub muted">{n.text.split('\n').filter((l) => l.trim()).slice(1).join(' ').slice(0, 80) || 'Empty'}</span>
            </button>
          </li>
        ))}
        {!list.length && <li className="nel-empty muted">{q ? 'No note matches.' : 'No notes yet.'}</li>}
      </ul>
    </div>
  )
}

const DAY_MS = 864e5

function EventPicker({ onPick }: { onPick: (e: CalendarEvent) => void }) {
  const shown = useShownCalendarIds()
  const today = startOfDay(new Date())
  const [q, setQ] = useState('')
  const [from, setFrom] = useState(dayKey(startOfDay(today, -14)))
  const [to, setTo] = useState(dayKey(startOfDay(today, 30)))
  const [state, setState] = useState<{ events: CalendarEvent[]; loading: boolean; error: string | null }>({ events: [], loading: true, error: null })
  useEffect(() => {
    if (!shown) return
    const a = new Date(`${from}T00:00:00`)
    const b = new Date(new Date(`${to}T00:00:00`).getTime() + DAY_MS)
    if (isNaN(a.getTime()) || isNaN(b.getTime()) || b <= a) return setState({ events: [], loading: false, error: 'The range ends before it starts' })
    if (b.getTime() - a.getTime() > 400 * DAY_MS) return setState({ events: [], loading: false, error: 'At most 400 days at a time' })
    let live = true
    setState((s) => ({ ...s, loading: true }))
    fetchEvents(a, b, shown).then(
      (r) => live && setState({ events: r.events.filter((e) => e.ref && e.uid), loading: false, error: r.errors[0] ?? null }),
      (err: Error) => live && setState({ events: [], loading: false, error: err.message }),
    )
    return () => {
      live = false
    }
  }, [shown?.join(','), from, to]) // eslint-disable-line react-hooks/exhaustive-deps
  const list = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const hits = state.events.filter((e) => words.every((w) => `${e.title} ${e.location ?? ''}`.toLowerCase().includes(w)))
    // Nearest to now first: what is coming up, then what just was.
    const now = Date.now()
    const coming = hits.filter((e) => dateOf(e.end, e.allDay).getTime() >= now)
    const past = hits.filter((e) => dateOf(e.end, e.allDay).getTime() < now).reverse()
    return [...coming, ...past].slice(0, 80)
  }, [state.events, q])
  const pick = (i: number, el: Element) => {
    onPick(list[i])
    confirmFrom(el)
  }
  const rows = useRows(list.length, pick)
  useEffect(() => {
    if (list[rows.at]) onPick(list[rows.at])
  }, [list, rows.at, onPick])
  return (
    <div className="nel-picker">
      <input className="dlg-input" data-autofocus="" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={rows.onKeyDown} placeholder="Search events by title" aria-label="Search events" autoComplete="off" spellCheck={false} />
      <div className="nel-range">
        <label>
          From <input type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} aria-label="From" />
        </label>
        <label>
          to <input type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} aria-label="To" />
        </label>
      </div>
      <ul className="nel-list" role="listbox" aria-label="Events">
        {list.map((e, i) => (
          <li key={e.id}>
            <button type="button" role="option" aria-selected={i === rows.at} className={`nel-row ${i === rows.at ? 'is-on' : ''}`} onClick={(ev) => pick(i, ev.currentTarget)}>
              <span className="nel-row-title">
                <span className="nel-dot" style={{ background: e.color }} aria-hidden />
                {e.title}
                {e.recurring && <span className="muted"> ↻</span>}
              </span>
              <span className="nel-row-sub muted">
                {whenOf(e)} · {e.calendar}
              </span>
            </button>
          </li>
        ))}
        {!list.length && <li className="nel-empty muted">{state.loading || !shown ? 'Looking…' : (state.error ?? (q ? 'No event matches in these dates.' : 'No events in these dates.'))}</li>}
      </ul>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// On the event, and on the note

/** The event editor's section: its notes, to open or unlink, and making or linking one. */
function EventNotes({ event }: { event: CalendarEvent }) {
  const notes = notesOf(useAllNotes(), event)
  const scope = (n: Note) => {
    const l = (n.events ?? []).find((x) => linkMatches(x, event))
    return !event.recurring ? '' : !l ? '' : l.occurrence ? 'this occurrence' : 'every occurrence'
  }
  return (
    <div className="nel-event">
      <div className="nel-event-head">
        <span>Notebook</span>
        <button type="button" className="link-btn" onClick={() => newMeetingNote(event)}>
          New meeting note
        </button>
        <button type="button" className="link-btn" onClick={() => void linkANote(event)}>
          Link a note…
        </button>
      </div>
      {notes.length > 0 && (
        <ul className="nel-event-list">
          {notes.map((n) => (
            <li key={n.id}>
              <button type="button" className="nel-note" onClick={() => openNote(n.id)} title="Open in Notebook">
                📝 <span className="nel-note-title">{noteTitle(n)}</span>
                {scope(n) && <span className="muted nel-note-scope"> · {scope(n)}</span>}
              </button>
              <button type="button" className="link-btn nel-unlink" onClick={() => unlinkFromEvent(n, event)} aria-label={`Unlink ${noteTitle(n)}`}>
                Unlink
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Links looked up again this session (their event found, moved or gone), by note and UID. */
const checked = new Map<string, number>()
const RECHECK_MS = 10 * 60_000

/** The note's chips: each event it is linked to, opening the Calendar there, with Unlink. */
function NoteEventChips({ note, compact }: { note: Note; compact?: boolean }) {
  const links = note.events ?? []
  const can = hasCalendar(getAccount())
  // Once in a while, each link is looked up again: a moved event shows its new time, a deleted one says so.
  useEffect(() => {
    if (!can) return
    for (const l of links) {
      const key = `${note.id}|${l.uid}|${l.occurrence ?? ''}`
      if (Date.now() - (checked.get(key) ?? 0) < RECHECK_MS) continue
      checked.set(key, Date.now())
      api<{ event: CalendarEvent | null; gone: boolean }>('/api/calendar/find', { method: 'POST', json: { uid: l.uid, calendarId: l.calendarId, occurrence: l.occurrence, start: l.start } }).then(
        (r) => {
          if (r.event) refreshFrom([r.event])
          else if (r.gone && !l.gone) setNoteEvents(note.id, (ls) => ls.map((x) => (sameLink(x, l) ? { ...x, gone: true } : x)))
        },
        () => {},
      )
    }
  }, [note.id, links.map((l) => `${l.uid}|${l.occurrence ?? ''}`).join(','), can]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className={`nel-chips ${compact ? 'is-compact' : ''}`} onContextMenu={(e) => e.stopPropagation()}>
      {links.map((l) => (
        <span key={`${l.uid}|${l.occurrence ?? ''}`} className={`nel-chip ${l.gone ? 'is-gone' : ''}`}>
          <button type="button" className="nel-chip-open" onClick={() => (can ? void openLinked(note.id, l) : undefined)} disabled={!can} title={l.gone ? 'This event was deleted' : can ? 'Open in Calendar' : 'Sign in with a calendar connected to open it'}>
            <span aria-hidden>📅</span>
            <span className="nel-chip-title">{l.title}</span>
            <span className="nel-chip-when">{l.gone ? 'deleted' : whenOf(l)}</span>
            {!l.gone && !l.occurrence && l.repeats && <span className="nel-chip-when">↻ every time</span>}
          </button>
          <button type="button" className="nel-chip-x" onClick={() => unlink(note.id, l)} aria-label={`Unlink ${l.title}`} title="Unlink">
            ×
          </button>
        </span>
      ))}
    </div>
  )
}
