import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { createEvent, dayKey, deleteEvent, setLastCalendar, updateEvent, type CalendarEvent, type CalendarInfo, type EventInput } from '../../data/calendar'
import { connectGoogle } from '../../os/account'
import { Select } from '../../os/Select'
import { composeMail, openMailByMessageId } from '../../data/mail'
import { messageIdOf } from '../../data/pim'
import { PeoplePicker, PersonChip, type Person } from '../contacts/people'
import { addDays, hhmm, parseDay, span } from './time'

// A new event, or one to look at and change: title, calendar, when, where, who and notes. Guests
// are picked from your contacts (Contacts' people picker) and get an invitation by email from
// Google or the CalDAV server; Email guests writes to them all. For one occurrence of a repeating
// event, saving and deleting ask whether it is about that one or the whole series. Notes that link
// back to a mail (an event made from one) get a button that opens it in Mail.

export type Draft = {
  title: string
  calendarId: string
  allDay: boolean
  startDate: string
  startTime: string
  endDate: string
  endTime: string
  location: string
  description: string
  guests: string[]
}

/** "Only this one, or all of them?" — answered by the Calendar app's own dialog. */
export type Choose = (question: string, verb: string) => Promise<'one' | 'all' | null>

export function draftFromEvent(e: CalendarEvent): Draft {
  const { start, end } = span(e)
  const others = (e.attendees ?? []).filter((a) => !a.self).map((a) => a.email)
  if (e.allDay)
    return { title: e.title, calendarId: e.calendarId, allDay: true, startDate: e.start.slice(0, 10), startTime: '09:00', endDate: dayKey(addDays(parseDay(e.end), -1)), endTime: '10:00', location: e.location ?? '', description: e.description ?? '', guests: others }
  return {
    title: e.title,
    calendarId: e.calendarId,
    allDay: false,
    startDate: dayKey(new Date(start)),
    startTime: hhmm(new Date(start)),
    endDate: dayKey(new Date(end)),
    endTime: hhmm(new Date(end)),
    location: e.location ?? '',
    description: e.description ?? '',
    guests: others,
  }
}

export function draftFromRange(start: Date, end: Date, allDay: boolean, calendarId: string): Draft {
  return {
    title: '',
    calendarId,
    allDay,
    startDate: dayKey(start),
    startTime: allDay ? '09:00' : hhmm(start),
    endDate: allDay ? dayKey(addDays(end, -1)) : dayKey(end),
    endTime: allDay ? '10:00' : hhmm(end),
    location: '',
    description: '',
    guests: [],
  }
}

/** What to send, or why it can't be. */
function inputOf(d: Draft): EventInput | string {
  const base = { title: d.title.trim() || 'New event', location: d.location.trim(), description: d.description.trim(), attendees: d.guests }
  if (d.allDay) {
    if (d.endDate < d.startDate) return 'It has to end after it starts'
    return { ...base, allDay: true, start: d.startDate, end: dayKey(addDays(parseDay(d.endDate), 1)) }
  }
  const start = new Date(`${d.startDate}T${d.startTime}`)
  const end = new Date(`${d.endDate}T${d.endTime}`)
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return 'Give a start and an end'
  if (end <= start) return 'It has to end after it starts'
  return { ...base, allDay: false, start: start.toISOString(), end: end.toISOString() }
}

/** Only what changed, so changing a title doesn't also move a series that was moved before. */
function changes(before: EventInput, after: EventInput): Partial<EventInput> {
  const out: Partial<EventInput> = {}
  if (before.title !== after.title) out.title = after.title
  if ((before.location ?? '') !== after.location) out.location = after.location
  if ((before.description ?? '') !== after.description) out.description = after.description
  if (before.start !== after.start || before.end !== after.end || before.allDay !== after.allDay) Object.assign(out, { start: after.start, end: after.end, allDay: after.allDay })
  if ([...(before.attendees ?? [])].sort().join() !== [...(after.attendees ?? [])].sort().join()) out.attendees = after.attendees
  return out
}

/** The first link back to a message in the notes (an event made from an email), as its Message-ID. */
const MAIL_LINK = /(https?:\/\/\S+[?&]open=mail\S*|message:\S+)/
const mailIn = (notes: string) => {
  const m = MAIL_LINK.exec(notes)
  return m ? messageIdOf(m[1].replace(/[).,;]+$/, '')) : null
}
const STATUS: Record<string, [string, string]> = { accepted: ['✓', 'going'], declined: ['✕', 'not going'], tentative: ['?', 'maybe'], 'needs-action': ['…', 'not answered yet'] }

type Props = {
  event: CalendarEvent | null
  initial: Draft
  calendars: CalendarInfo[]
  googleCanWrite: boolean
  choose: Choose
  onClose: () => void
}

export function EventEditor({ event, initial, calendars, googleCanWrite, choose, onClose }: Props) {
  const [d, setDraft] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const titleRef = useRef<HTMLInputElement>(null)
  const set = (patch: Partial<Draft>) => setDraft((x) => ({ ...x, ...patch }))
  const writable = calendars.filter((c) => c.writable)
  const readOnly = !!event && !event.editable
  const calendar = calendars.find((c) => c.id === d.calendarId)
  const statusOf = new Map((event?.attendees ?? []).map((a) => [a.email.toLowerCase(), a]))
  // Names for the guests: the event's, then what was picked.
  const [names, setNames] = useState<Record<string, string>>(() => Object.fromEntries((event?.attendees ?? []).filter((a) => a.name).map((a) => [a.email.toLowerCase(), a.name!])))
  const people: Person[] = d.guests.map((g) => (names[g] ? { email: g, name: names[g] } : { email: g }))
  const badge = (p: Person) => {
    const a = statusOf.get(p.email.toLowerCase())
    const [icon, label] = STATUS[a?.status ?? ''] ?? ['', '']
    return icon ? (
      <b className={`ca-guest-status is-${a?.status}`} title={`${label}${a?.organizer ? ' · organiser' : ''}`}>
        {icon}
      </b>
    ) : null
  }
  const mailMessage = mailIn(d.description)

  useEffect(() => {
    if (!readOnly) titleRef.current?.focus()
  }, [readOnly])

  // Moving the start keeps the length, as calendar apps do.
  const setStart = (patch: { startDate?: string; startTime?: string }) =>
    setDraft((x) => {
      const next = { ...x, ...patch }
      if (x.allDay) {
        const days = Math.round((parseDay(x.endDate).getTime() - parseDay(x.startDate).getTime()) / 864e5)
        return { ...next, endDate: dayKey(addDays(parseDay(next.startDate), Math.max(0, days))) }
      }
      const was = new Date(`${x.startDate}T${x.startTime}`).getTime()
      const length = new Date(`${x.endDate}T${x.endTime}`).getTime() - was
      const now = new Date(`${next.startDate}T${next.startTime}`).getTime()
      if (isNaN(now) || isNaN(length) || length <= 0) return next
      const end = new Date(now + length)
      return { ...next, endDate: dayKey(end), endTime: hhmm(end) }
    })

  const save = async (ev?: FormEvent) => {
    ev?.preventDefault()
    if (readOnly || busy) return
    const input = inputOf(d)
    if (typeof input === 'string') return setError(input)
    setBusy(true)
    setError(null)
    try {
      if (!event) {
        if (!calendar?.writable) throw new Error('Pick a calendar to put it in')
        await createEvent(d.calendarId, input)
        setLastCalendar(d.calendarId)
      } else {
        const moving = d.calendarId !== event.calendarId
        const patch = moving ? input : changes(inputOf(draftFromEvent(event)) as EventInput, input)
        if (!moving && !Object.keys(patch).length) return onClose()
        let all = false
        if (event.recurring) {
          const answer = await choose('This event repeats. Change only this one, or all of them?', 'Change')
          if (!answer) return
          all = answer === 'all'
        }
        await updateEvent(event, patch, { all, calendar: moving ? d.calendarId : undefined })
      }
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!event || busy) return
    let all = false
    if (event.recurring) {
      const answer = await choose('This event repeats. Delete only this one, or all of them?', 'Delete')
      if (!answer) return
      all = answer === 'all'
    } else if (!confirmDelete) return setConfirmDelete(true)
    setBusy(true)
    try {
      await deleteEvent(event, all)
      onClose()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose()
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save()
  }

  const roReason = !readOnly ? null : calendar?.source === 'Google' && !googleCanWrite ? 'google' : 'calendar'
  const selectable = event && !writable.some((c) => c.id === event.calendarId) ? [...writable, ...(calendar ? [calendar] : [])] : writable

  return (
    <div className="ca-sheet-back" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="ca-sheet" onSubmit={save} onKeyDown={onKey} role="dialog" aria-label={event ? 'Event' : 'New event'}>
        <div className="ca-sheet-head">
          <span className="ca-swatch" style={{ background: calendar?.color ?? event?.color ?? 'var(--accent)' }} />
          <input ref={titleRef} className="ca-title-input" value={d.title} onChange={(e) => set({ title: e.target.value })} placeholder={event ? '(No title)' : 'New event'} disabled={readOnly} aria-label="Title" />
          <button type="button" className="ca-x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <fieldset disabled={readOnly || busy} className="ca-fields">
          <label className="ca-field">
            <span>Calendar</span>
            {selectable.length ? (
              <Select
                value={d.calendarId}
                onChange={(calendarId) => set({ calendarId })}
                disabled={!!event?.recurring}
                options={[
                  ...(!calendar?.writable && !event ? [{ value: '', label: 'Pick a calendar…' }] : []),
                  ...selectable.map((c) => ({ value: c.id, label: `${c.name} · ${c.source ?? 'Google'}` })),
                ]}
              />
            ) : (
              <em className="muted">{event ? `${event.calendar}` : 'None you can add to yet (see below)'}</em>
            )}
          </label>
          <label className="ca-field ca-check">
            <span>All day</span>
            <input type="checkbox" checked={d.allDay} onChange={(e) => set({ allDay: e.target.checked })} />
          </label>
          <div className="ca-field">
            <span>Starts</span>
            <span className="ca-when">
              <input type="date" value={d.startDate} onChange={(e) => setStart({ startDate: e.target.value })} required aria-label="Start date" />
              {!d.allDay && <input type="time" step={900} value={d.startTime} onChange={(e) => setStart({ startTime: e.target.value })} required aria-label="Start time" />}
            </span>
          </div>
          <div className="ca-field">
            <span>Ends</span>
            <span className="ca-when">
              <input type="date" value={d.endDate} min={d.startDate} onChange={(e) => set({ endDate: e.target.value })} required aria-label="End date" />
              {!d.allDay && <input type="time" step={900} value={d.endTime} onChange={(e) => set({ endTime: e.target.value })} required aria-label="End time" />}
            </span>
          </div>
          <label className="ca-field">
            <span>Where</span>
            <input value={d.location} onChange={(e) => set({ location: e.target.value })} placeholder="Place or link" />
          </label>
          <div className="ca-field">
            <span>Guests</span>
            {readOnly ? (
              <div className="ca-guests is-ro">
                {people.length ? people.map((p) => <PersonChip key={p.email} email={p.email} name={p.name} compact badge={badge(p)} />) : <em className="muted">None</em>}
              </div>
            ) : (
              <PeoplePicker
                value={people}
                onChange={(next) => {
                  setNames((n) => ({ ...n, ...Object.fromEntries(next.filter((p) => p.name).map((p) => [p.email.toLowerCase(), p.name!])) }))
                  set({ guests: [...new Set(next.map((p) => p.email.toLowerCase()))] })
                }}
                badge={badge}
                placeholder="Invite people by name or email"
                label="Guests"
              />
            )}
          </div>
          <label className="ca-field ca-notes">
            <span>Notes</span>
            <textarea value={d.description} onChange={(e) => set({ description: e.target.value })} rows={3} />
          </label>
        </fieldset>
        {roReason === 'google' && (
          <p className="ca-hint">
            Google only lets this site read your calendars so far.{' '}
            <button type="button" className="link-btn" onClick={connectGoogle}>
              Connect Google again
            </button>{' '}
            to allow editing.
          </p>
        )}
        {roReason === 'calendar' && <p className="ca-hint">This calendar is read-only here.</p>}
        {!event && !writable.length && (
          <p className="ca-hint">
            No calendar can be written to yet. For Google, connect again to allow editing; for Fastmail, add the account again with an app password that can read and write
            (Settings → Integrations → Calendars).
          </p>
        )}
        {d.guests.length > 0 && !readOnly && <p className="ca-hint">Guests get an invitation by email once you save.</p>}
        {error && <p className="ca-hint t-red">{error}</p>}
        <div className="ca-sheet-foot">
          {event?.url && (
            <a className="btn btn-small btn-ghost" href={event.url} target="_blank" rel="noopener noreferrer">
              Open in Google ↗
            </a>
          )}
          {event?.meet && (
            <a className="btn btn-small btn-ghost" href={event.meet} target="_blank" rel="noopener noreferrer">
              🎥 Join call
            </a>
          )}
          {d.guests.length > 0 && (
            <button type="button" className="btn btn-small btn-ghost" onClick={() => composeMail({ to: people.map((p) => p.email), subject: d.title.trim() || event?.title || '' })} title="Write to everyone on it">
              ✉ Email guests
            </button>
          )}
          {mailMessage && (
            <button type="button" className="btn btn-small btn-ghost" onClick={() => openMailByMessageId(mailMessage)} title="The email this event was made from">
              Open the email
            </button>
          )}
          <span className="nb-spacer" />
          {event && !readOnly && (
            <button type="button" className="btn btn-small is-danger" onClick={remove} disabled={busy}>
              {confirmDelete ? 'Really delete?' : 'Delete'}
            </button>
          )}
          <button type="button" className="btn btn-small" onClick={onClose}>
            {readOnly ? 'Close' : 'Cancel'}
          </button>
          {!readOnly && (
            <button className="btn btn-small btn-primary" disabled={busy || (!event && !calendar?.writable)}>
              {busy ? 'Saving…' : event ? 'Save' : 'Add'}
            </button>
          )}
        </div>
      </form>
    </div>
  )
}
