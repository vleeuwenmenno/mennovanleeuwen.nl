import type { IncomingMessage, ServerResponse } from 'node:http'
import type { User } from './auth.ts'
import { addCaldavObject, caldavByUid, davTime, deleteCaldavEvent, eventsIn, getProp, icalText, icalTime, listCaldav, own, parseIcs, parseLine, printIcs, setProp, writeCaldavObject, type CaldavObject, type Ics } from './caldav.ts'
import { allEvents } from './calendars.ts'
import { deleteGoogleEvent, googleAccount, googleByUid, importGoogleEvent, setGoogleAnswer, type CalendarEvent, type GoogleFound } from './google.ts'
import { HttpError, json, publicOrigin, readJson } from './http.ts'
import { parseInvite, type Invite } from './imip.ts'
import { tellPages } from './notifier.ts'
import { findByMessageId, mailAccount, mailAccounts, mailWith, messageFacts, ownAddresses, sendItip, type MailAccount, type MessageFacts, type ThreadRow } from './jmap.ts'
import { createTask } from './tasks.ts'

// Where Mail, Contacts, Calendar and Tasks meet (the browser side is src/os/pimLinks.tsx):
//
// - Invitations in Mail are answered where the event lives. In a linked CalDAV calendar (Fastmail
//   puts invitations there by itself) your PARTSTAT is changed in the event's own text, and a server
//   that does scheduling mails the organiser; in Google Calendar your answer goes through Google's
//   API, which mails them too; anywhere else the event is copied into the calendar you pick and the
//   answer goes out by email (an iMIP REPLY, RFC 6047). A cancellation can take the event out of
//   your calendar, and a guest's reply can be written onto your own event.
// - A contact's recent mail (JMAP search across the linked accounts) and upcoming events (where they
//   are a guest or the organiser), for the contact card.
// - A message found by its Message-ID (the links tasks and events keep back to a mail), and a task
//   made from a message.
//
// Every request reads the message again from the user's own mail account; nothing about it is
// taken from the browser, and nothing reaches another user.

type Status = 'accepted' | 'tentative' | 'declined' | 'needs-action'
type Answer = Exclude<Status, 'needs-action'>
const PARTSTAT: Record<Status, string> = { accepted: 'ACCEPTED', tentative: 'TENTATIVE', declined: 'DECLINED', 'needs-action': 'NEEDS-ACTION' }
const STATUS_OF: Record<string, Status> = { ACCEPTED: 'accepted', TENTATIVE: 'tentative', DECLINED: 'declined', 'NEEDS-ACTION': 'needs-action' }
const ANSWERS = new Set<string>(['accepted', 'tentative', 'declined'])
const EMAIL = /^[^\s@<>(),;:"\\]+@[^\s@<>(),;:"\\]+\.[^\s@<>(),;:"\\]+$/

const mailto = (v: string) => v.replace(/^mailto:/i, '').trim().toLowerCase()

/** A content line with one parameter set (or taken out, with null); the value and other parameters stay. */
function withParam(line: string, name: string, value: string | null): string {
  let quoted = false
  let i = 0
  for (; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted
    else if (line[i] === ':' && !quoted) break
  }
  const parts = line.slice(0, i).match(/(?:[^;"]|"[^"]*")+/g) ?? [line.slice(0, i)]
  const kept = parts.filter((p, j) => j === 0 || p.split('=')[0].toUpperCase() !== name)
  return `${[...kept, ...(value === null ? [] : [`${name}=${value}`])].join(';')}${line.slice(i)}`
}

// ---------------------------------------------------------------------------------------------
// Reading an invitation

type Parsed = {
  invite: Invite
  uid: string
  /** The iCalendar text, as lines, and its event (the series, or the one occurrence it is about). */
  ics: Ics
  event: string[]
  /** For one occurrence of a series: when it was meant to start. */
  recurrence: string | null
}

function readInvite(facts: MessageFacts): Parsed {
  const invite = facts.ics ? parseInvite(facts.ics) : null
  if (!facts.ics || !invite?.uid) throw new HttpError(404, 'That message has no invitation')
  const ics = parseIcs(facts.ics)
  const mine = eventsIn(ics).filter((ev) => getProp(ev, 'UID')?.value.trim() === invite.uid)
  const event = mine.find((ev) => !getProp(ev, 'RECURRENCE-ID')) ?? mine[0]
  if (!event) throw new HttpError(404, 'That message has no invitation')
  const rid = getProp(event, 'RECURRENCE-ID')
  return { invite, uid: invite.uid, ics, event, recurrence: rid ? (icalTime(rid.value, rid.params)?.iso ?? null) : null }
}

const attendeesOf = (ev: string[]) =>
  own(ev, 'ATTENDEE').map((i) => {
    const p = parseLine(ev[i])!
    return { index: i, email: mailto(p.value), name: p.params.CN ?? null, status: STATUS_OF[(p.params.PARTSTAT ?? 'NEEDS-ACTION').toUpperCase()] ?? 'needs-action' }
  })

/**
 * Your addresses: the mail account's identities, CalDAV usernames that are addresses, the Google
 * account. An invitation sent to an alias still counts when it was addressed to one of its guests.
 */
async function addressesOf(user: User, acc: MailAccount, facts: MessageFacts, event: string[]): Promise<Set<string>> {
  const out = new Set(await ownAddresses(acc).catch(() => [] as string[]))
  for (const a of listCaldav(user)) if (EMAIL.test(a.username)) out.add(a.username.toLowerCase())
  const google = googleAccount(user)
  if (google) out.add(google.email.toLowerCase())
  if (!attendeesOf(event).some((a) => out.has(a.email))) {
    const to = new Set([...facts.to, ...facts.cc].map((a) => a.email.toLowerCase()))
    const guests = attendeesOf(event).filter((a) => to.has(a.email))
    if (guests.length === 1) out.add(guests[0].email)
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Where the event is

type Found = { source: 'caldav'; objects: CaldavObject[] } | { source: 'google'; event: GoogleFound }

async function locate(user: User, uid: string): Promise<Found | null> {
  const objects = await caldavByUid(user, uid).catch(() => [] as CaldavObject[])
  if (objects.length) return { source: 'caldav', objects }
  const event = await googleByUid(user, uid).catch(() => null)
  return event ? { source: 'google', event } : null
}

type Guest = { email: string; name: string | null; status: Status; organizer?: boolean }
export type Where = { source: 'caldav' | 'google'; calendarId: string; calendar: string; title: string; start: string | null; allDay: boolean; cancelled: boolean; organizer: string | null; guests: Guest[] }

function describe(found: Found, uid: string): Where {
  if (found.source === 'google') {
    const e = found.event
    return { source: 'google', calendarId: e.calendarId, calendar: e.calendar, title: e.title, start: e.start || null, allDay: e.allDay, cancelled: e.cancelled, organizer: e.attendees.find((a) => a.organizer)?.email ?? null, guests: e.attendees.map((a) => ({ email: a.email, name: a.name ?? null, status: a.status ?? 'needs-action', organizer: a.organizer })) }
  }
  const o = found.objects[0]
  const evs = eventsIn(o.ics).filter((ev) => getProp(ev, 'UID')?.value.trim() === uid)
  const ev = evs.find((x) => !getProp(x, 'RECURRENCE-ID')) ?? evs[0]
  const start = getProp(ev, 'DTSTART')
  const when = start ? icalTime(start.value, start.params) : null
  const organizer = getProp(ev, 'ORGANIZER')
  return {
    source: 'caldav',
    calendarId: o.calendar.id,
    calendar: o.calendar.name,
    title: icalText(getProp(ev, 'SUMMARY')?.value ?? '').trim() || '(No title)',
    start: when?.iso ?? null,
    allDay: !!when?.allDay,
    cancelled: getProp(ev, 'STATUS')?.value.trim().toUpperCase() === 'CANCELLED',
    organizer: organizer ? mailto(organizer.value) : null,
    guests: attendeesOf(ev).map(({ email, name, status }) => ({ email, name, status, organizer: organizer ? mailto(organizer.value) === email : undefined })),
  }
}

/** Sets the PARTSTAT of these people on every copy of the event (the series and its changed occurrences); answers how many lines changed. */
async function setPartstat(user: User, objects: CaldavObject[], uid: string, who: Set<string>, status: Status): Promise<number> {
  let changed = 0
  for (const o of objects) {
    let here = 0
    for (const ev of eventsIn(o.ics)) {
      if (getProp(ev, 'UID')?.value.trim() !== uid) continue
      for (const a of attendeesOf(ev)) {
        if (!who.has(a.email)) continue
        ev[a.index] = withParam(withParam(ev[a.index], 'PARTSTAT', PARTSTAT[status]), 'RSVP', null)
        here++
      }
      if (here) setProp(ev, 'DTSTAMP', [`DTSTAMP:${davTime(new Date())}`])
    }
    if (!here) continue
    await writeCaldavObject(user, o.calendar.id, o.href, o.ics, o.etag)
    changed += here
  }
  return changed
}

// ---------------------------------------------------------------------------------------------
// What the invitation card shows

export type InviteState = {
  method: string
  uid: string
  /** Your address on it, and your answer: from your calendar's copy when there is one. */
  me: string | null
  status: Status | null
  where: Where | null
  /** You organise the event in your calendar (a REPLY can be written onto it). */
  organiser: boolean
  /** A REPLY's answers, with what your event says now. */
  replies: (Guest & { current: Status | null; fromSender: boolean })[]
  /** A copy can be made in the calendar picked (no calendar has it yet). */
  canAnswer: boolean
}

async function stateOf(user: User, acc: MailAccount, facts: MessageFacts, parsed: Parsed): Promise<InviteState> {
  const mine = await addressesOf(user, acc, facts, parsed.event)
  const found = await locate(user, parsed.uid)
  const where = found ? describe(found, parsed.uid) : null
  const guests = attendeesOf(parsed.event)
  const meOnInvite = guests.find((a) => mine.has(a.email)) ?? null
  const meInCalendar = where?.guests.find((g) => mine.has(g.email)) ?? null
  const organiser = !!where?.organizer && mine.has(where.organizer)
  const sender = facts.from[0]?.email.toLowerCase()
  return {
    method: parsed.invite.method,
    uid: parsed.uid,
    me: meInCalendar?.email ?? meOnInvite?.email ?? null,
    status: meInCalendar?.status ?? (parsed.invite.method === 'REQUEST' ? (meOnInvite?.status ?? null) : null),
    where,
    organiser,
    replies:
      parsed.invite.method === 'REPLY'
        ? guests.map((g) => ({ email: g.email, name: g.name, status: g.status, current: where?.guests.find((x) => x.email === g.email)?.status ?? null, fromSender: g.email === sender }))
        : [],
    canAnswer: parsed.invite.method === 'REQUEST' && !!meOnInvite,
  }
}

// ---------------------------------------------------------------------------------------------
// Answering, removing, writing a reply onto your event

const VERB: Record<Answer, string> = { accepted: 'Accepted', tentative: 'Tentatively accepted', declined: 'Declined' }

/** The iMIP REPLY: just what RFC 5546 asks for (UID, SEQUENCE, organiser, you with your answer), plus the title. */
function replyIcs(parsed: Parsed, me: string, answer: Answer): string {
  const ev = parsed.event
  const line = (name: string) => own(ev, name).map((i) => ev[i])
  const mine = attendeesOf(ev).find((a) => a.email === me)
  const attendee = mine ? withParam(withParam(ev[mine.index], 'PARTSTAT', PARTSTAT[answer]), 'RSVP', null) : `ATTENDEE;PARTSTAT=${PARTSTAT[answer]}:mailto:${me}`
  const out: Ics = [
    'BEGIN:VCALENDAR',
    'PRODID:-//mvlos//Mail//EN',
    'VERSION:2.0',
    'METHOD:REPLY',
    ['BEGIN:VEVENT', `UID:${parsed.uid}`, `DTSTAMP:${davTime(new Date())}`, ...line('SEQUENCE'), ...line('RECURRENCE-ID'), ...line('SUMMARY'), ...line('ORGANIZER'), attendee, 'END:VEVENT'],
    'END:VCALENDAR',
  ]
  return printIcs(out)
}

/** The invitation as your own copy: no METHOD, your answer on it, and the organiser's server left to do the scheduling (SCHEDULE-AGENT=CLIENT). */
function ownCopy(parsed: Parsed, me: string, answer: Answer): Ics {
  const copy = parseIcs(printIcs(parsed.ics)).filter((l) => typeof l !== 'string' || !/^METHOD:/i.test(l))
  for (const ev of eventsIn(copy)) {
    if (getProp(ev, 'UID')?.value.trim() !== parsed.uid) continue
    for (const a of attendeesOf(ev)) if (a.email === me) ev[a.index] = withParam(withParam(ev[a.index], 'PARTSTAT', PARTSTAT[answer]), 'RSVP', null)
    for (const i of own(ev, 'ORGANIZER')) ev[i] = withParam(ev[i], 'SCHEDULE-AGENT', 'CLIENT')
  }
  return copy
}

async function answerInvite(user: User, acc: MailAccount, facts: MessageFacts, parsed: Parsed, answer: Answer, calendar: string | null): Promise<{ via: 'caldav' | 'google' | 'email'; added: string | null }> {
  if (parsed.invite.method !== 'REQUEST') throw new HttpError(400, 'Only an invitation can be answered')
  const mine = await addressesOf(user, acc, facts, parsed.event)
  const me = attendeesOf(parsed.event).find((a) => mine.has(a.email))?.email
  if (!me) throw new HttpError(400, 'You are not on the guest list of this invitation')
  const found = await locate(user, parsed.uid)
  if (found?.source === 'caldav') {
    if (!(await setPartstat(user, found.objects, parsed.uid, mine, answer))) throw new HttpError(409, 'The copy in your calendar does not list you as a guest')
    return { via: 'caldav', added: null }
  }
  if (found?.source === 'google') {
    if (!(await setGoogleAnswer(user, found.event.calendarId, found.event.id, { self: true, emails: [...mine] }, answer, true))) throw new HttpError(409, 'The copy in Google Calendar does not list you as a guest')
    return { via: 'google', added: null }
  }
  // Nowhere yet: into the calendar picked (unless declined), and the answer by email.
  let added: string | null = null
  if (calendar && answer !== 'declined') {
    if (calendar.startsWith('caldav:')) {
      await addCaldavObject(user, calendar, parsed.uid, ownCopy(parsed, me, answer))
      added = calendar
    } else if (googleAccount(user)) {
      const inv = parsed.invite
      if (!inv.start) throw new HttpError(400, 'The invitation has no time')
      const allDay = inv.allDay
      const end = inv.end ?? (allDay ? new Date(Date.parse(`${inv.start}T00:00:00Z`) + 864e5).toISOString().slice(0, 10) : new Date(Date.parse(inv.start) + 3600_000).toISOString())
      const description = getProp(parsed.event, 'DESCRIPTION')
      await importGoogleEvent(user, calendar, {
        uid: parsed.uid,
        title: inv.title,
        start: allDay ? inv.start : new Date(inv.start).toISOString(),
        end: allDay ? end : new Date(end).toISOString(),
        allDay,
        location: inv.location,
        description: description ? icalText(description.value) : null,
        organizer: inv.organizer,
        attendees: attendeesOf(parsed.event).map((a) => ({ email: a.email, name: a.name, status: a.email === me ? answer : a.status })),
      })
      added = calendar
    }
  }
  const organizer = parsed.invite.organizer
  if (organizer && !mine.has(organizer.email)) {
    const title = parsed.invite.title
    await sendItip(acc, {
      from: me,
      to: { name: organizer.name, email: organizer.email },
      subject: `${VERB[answer]}: ${title}`,
      text: `${VERB[answer]}: ${title}\n\n${me} ${answer === 'accepted' ? 'will be there' : answer === 'tentative' ? 'might be there' : 'will not be there'}.\n`,
      ics: replyIcs(parsed, me, answer),
      method: 'REPLY',
    })
  }
  return { via: 'email', added }
}

/** A cancellation: the event (or the one occurrence) out of your calendar. */
async function removeCancelled(user: User, parsed: Parsed) {
  if (parsed.invite.method !== 'CANCEL') throw new HttpError(400, 'Only a cancelled event is removed from here')
  const found = await locate(user, parsed.uid)
  if (!found) return
  if (found.source === 'caldav') {
    for (const o of found.objects) await deleteCaldavEvent(user, { k: 'c', c: o.calendar.id, h: o.href, u: parsed.uid, ...(parsed.recurrence ? { r: parsed.recurrence } : {}) }, !parsed.recurrence)
    return
  }
  if (parsed.recurrence) throw new HttpError(400, 'Remove that occurrence in the Calendar app')
  if (!found.event.cancelled) await deleteGoogleEvent(user, { k: 'g', c: found.event.calendarId, e: found.event.id }, true)
}

/** A guest's reply onto your own event: only the answers of the guest who sent it. */
async function applyReply(user: User, acc: MailAccount, facts: MessageFacts, parsed: Parsed): Promise<number> {
  if (parsed.invite.method !== 'REPLY') throw new HttpError(400, 'That is not a reply')
  const sender = facts.from[0]?.email.toLowerCase()
  const answers = attendeesOf(parsed.event).filter((a) => a.email === sender)
  if (!answers.length) throw new HttpError(400, 'This reply was not sent by the guest it answers for')
  const found = await locate(user, parsed.uid)
  if (!found) throw new HttpError(404, 'That event is not in your calendars')
  const mine = await addressesOf(user, acc, facts, parsed.event)
  const where = describe(found, parsed.uid)
  if (!where.organizer || !mine.has(where.organizer)) throw new HttpError(403, 'Only the organiser’s calendar takes replies')
  let changed = 0
  for (const a of answers) {
    if (found.source === 'caldav') changed += await setPartstat(user, found.objects, parsed.uid, new Set([a.email]), a.status)
    else if (await setGoogleAnswer(user, found.event.calendarId, found.event.id, { emails: [a.email] }, a.status, false)) changed++
  }
  if (!changed) throw new HttpError(409, 'That guest is not on your event')
  return changed
}

// ---------------------------------------------------------------------------------------------
// People: mail with them, events with them

const emailsParam = (raw: string | null) => [...new Set((raw ?? '').split(',').map((e) => e.trim().toLowerCase()).filter((e) => EMAIL.test(e)))].slice(0, 20)

async function recentMail(user: User, emails: string[], limit: number): Promise<{ messages: (ThreadRow & { account: number })[]; errors: string[] }> {
  const errors: string[] = []
  const lists = await Promise.all(
    mailAccounts(user).map((acc) =>
      mailWith(acc, emails, limit).then(
        (rows) => rows.map((r) => ({ ...r, account: acc.id })),
        (e: Error) => (errors.push(`${acc.label}: ${e.message}`), []),
      ),
    ),
  )
  return { messages: lists.flat().sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)).slice(0, limit), errors }
}

async function eventsWith(user: User, emails: string[], days: number): Promise<{ events: CalendarEvent[]; errors: string[] }> {
  const from = new Date()
  from.setHours(0, 0, 0, 0)
  const to = new Date(from.getTime() + days * 864e5)
  const { events, errors } = await allEvents(user, null, { from, to })
  const people = new Set(emails)
  const now = Date.now()
  return {
    events: events.filter((e) => (e.allDay ? Date.parse(`${e.end}T00:00:00`) > now : Date.parse(e.end) > now) && (e.attendees ?? []).some((a) => people.has(a.email.toLowerCase()) && !a.self)).slice(0, 20),
    errors,
  }
}

// ---------------------------------------------------------------------------------------------
// A task from a message

async function taskFromMail(req: IncomingMessage, user: User, body: { account?: unknown; email?: unknown; due?: unknown; list?: unknown }) {
  const acc = mailAccount(user, body.account)
  const facts = await messageFacts(acc, body.email)
  const sender = facts.from[0]
  const who = sender ? (sender.name ? `${sender.name} <${sender.email}>` : sender.email) : 'unknown sender'
  // The link back: the message by its Message-ID (Apple's message: links, which Reminders and Mail
  // on a Mac or an iPhone open too), else this site's address of it in this account.
  const url = facts.messageId && !/[\s"<>]/.test(facts.messageId) ? `message:%3C${encodeURIComponent(facts.messageId).replace(/%40/g, '@')}%3E` : `${publicOrigin(req)}/?open=mail&account=${acc.id}&email=${encodeURIComponent(facts.id)}`
  const notes = [`From ${who}`, facts.preview.trim()].filter(Boolean).join('\n\n')
  return createTask(user, { list: body.list, task: { title: facts.subject.trim() || '(No subject)', notes, url, due: typeof body.due === 'string' && body.due ? body.due : undefined, timeZone: typeof (body as { timeZone?: unknown }).timeZone === 'string' ? (body as { timeZone: string }).timeZone : undefined } })
}

// ---------------------------------------------------------------------------------------------
// The API

/** Every /api/pim route (server/api.ts hands them over); resolves true when it answered. */
export async function handlePimApi(req: IncomingMessage, res: ServerResponse, url: URL, method: string, user: User): Promise<boolean> {
  const path = url.pathname
  const q = (k: string) => url.searchParams.get(k)
  const read = method === 'GET' || method === 'HEAD'
  if (path === '/api/pim/mail-with' && read) return json(res, 200, await recentMail(user, emailsParam(q('emails')), Math.max(1, Math.min(Number(q('limit')) || 5, 20)))), true
  if (path === '/api/pim/events-with' && read) return json(res, 200, await eventsWith(user, emailsParam(q('emails')), Math.max(1, Math.min(Number(q('days')) || 60, 90)))), true
  if (path === '/api/pim/find-mail' && read) {
    const id = (q('messageId') ?? '').trim().replace(/^<|>$/g, '')
    for (const acc of mailAccounts(user)) {
      const hit = await findByMessageId(acc, id).catch(() => null)
      if (hit) return json(res, 200, { account: acc.id, ...hit }), true
    }
    throw new HttpError(404, 'That message is not in your mail')
  }
  if (path === '/api/pim/invite' && read) {
    const acc = mailAccount(user, q('account'))
    const facts = await messageFacts(acc, q('email'))
    return json(res, 200, await stateOf(user, acc, facts, readInvite(facts))), true
  }
  if (path === '/api/pim/invite' && method === 'POST') {
    const body = (await readJson(req, 8 * 1024)) as { account?: unknown; email?: unknown; action?: unknown; answer?: unknown; calendar?: unknown }
    const acc = mailAccount(user, body.account)
    const facts = await messageFacts(acc, body.email)
    const parsed = readInvite(facts)
    let done: Record<string, unknown> = {}
    if (body.action === 'answer') {
      if (typeof body.answer !== 'string' || !ANSWERS.has(body.answer)) throw new HttpError(400, 'Accept, maybe or decline?')
      done = await answerInvite(user, acc, facts, parsed, body.answer as Answer, typeof body.calendar === 'string' && body.calendar ? body.calendar : null)
    } else if (body.action === 'remove') await removeCancelled(user, parsed)
    else if (body.action === 'apply') done = { changed: await applyReply(user, acc, facts, parsed) }
    else throw new HttpError(400, 'Unknown action')
    // The Calendar app, the Agenda widget and the clock in every open page: fetch again.
    tellPages(user.id, 'calendar')
    return json(res, 200, { ...done, state: await stateOf(user, acc, facts, parsed) }), true
  }
  if (path === '/api/pim/task-from-mail' && method === 'POST') return json(res, 200, { task: await taskFromMail(req, user, await readJson(req, 8 * 1024)) }), true
  return false
}
