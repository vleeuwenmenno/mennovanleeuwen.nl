// Checks how Mail, Contacts, Calendar and Tasks work together on the server (server/pim.ts),
// through the real site server (server/index.ts, on a free port with a scratch DATA_DIR and a
// signed-in admin, who may reach the stand-ins on 127.0.0.1) against stand-ins for everything:
// JMAP (scripts/mail-mock.ts), CalDAV (scripts/tasks-mock.ts) and Google Calendar
// (scripts/google-mock.ts). It goes through:
//
//   - answering an invitation in each place the event can be: a CalDAV calendar (your PARTSTAT in
//     the event's own text, nothing mailed by the site), Google Calendar (your answer through the
//     API, Google mailing the organiser), and nowhere yet (a copy in the calendar picked, and an
//     iMIP REPLY by email with METHOD:REPLY and you as the ATTENDEE with your answer),
//   - a cancellation taking the event out of the calendar, and a guest's reply written onto your
//     own event (only by the guest who sent it),
//   - a contact's recent mail and upcoming events,
//   - a task made from a message, with the link back to it, found again by its Message-ID,
//   - the address a tapped push opens (a task reminder: that task),
//   - another user, who reaches none of it.
//
//   node scripts/pim-check.ts
//
// No real accounts. Exits 1 on any failure.

import { randomBytes } from 'node:crypto'
import { Server, check, finish } from './empires-harness.ts'
import { startMockGoogle } from './google-mock.ts'
import { ME, startMockJmap } from './mail-mock.ts'
import { PASSWORD, startMock, USER } from './tasks-mock.ts'
import { asPage } from './as-page.ts'

type J = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const jmapMock = await startMockJmap({ fill: 5 })
const caldav = await startMock()
const google = await startMockGoogle()
const LOGIN = 'pim-check'
const OTHER = 'pim-other'
const server = new Server({ GITHUB_CLIENT_ID: 'x', GITHUB_CLIENT_SECRET: 'x', ADMIN_USERS: `${LOGIN},${OTHER}`, NOTIFY_WATCH: 'off', GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'x', GOOGLE_API_URL: google.api, GOOGLE_TOKEN_URL: `${google.origin}/token`, MAIL_WATCH_MS: '3600000' })
process.env.DATA_DIR = server.data
const { database, encrypt, sha256 } = await import('../server/db.ts')
const now = Date.now()
const sid = randomBytes(24).toString('hex')
const otherSid = randomBytes(24).toString('hex')
database().prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (1, 1, ?, ?, ?, ?)').run(LOGIN, encrypt('none'), now, now)
database().prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (2, 2, ?, ?, ?, ?)').run(OTHER, encrypt('none'), now, now)
database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, 1, ?, ?)').run(sha256(sid), now, now + 86400_000)
database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, 2, ?, ?)').run(sha256(otherSid), now, now + 86400_000)
// Google, connected with editing allowed and a token that is still good (so no refresh is asked).
database()
  .prepare('INSERT INTO google (user_id, email, refresh_token, access_token, expires_at, scopes, created_at) VALUES (1, ?, ?, ?, ?, ?, ?)')
  .run(ME.email, encrypt('mock-refresh'), encrypt(google.token), now + 3600_000 * 24, 'openid email https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events', now)
await server.start()

const call = async <T = J>(who: string, method: string, path: string, body?: unknown, expect = 200): Promise<T> => {
  const res = await fetch(`${server.origin}${path}`, { method, headers: { Cookie: `mvlos_sid=${who}`, ...(await asPage(who)), 'Content-Type': 'application/json', Origin: server.origin }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  if (res.status !== expect) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 400)}`)
  return (text ? JSON.parse(text) : {}) as T
}
const api = <T = J>(method: string, path: string, body?: unknown, expect = 200) => call<T>(sid, method, path, body, expect)
const status = async (who: string, method: string, path: string, body?: unknown) => (await fetch(`${server.origin}${path}`, { method, headers: { Cookie: `mvlos_sid=${who}`, ...(await asPage(who)), 'Content-Type': 'application/json', Origin: server.origin }, body: body === undefined ? undefined : JSON.stringify(body) })).status

const EVENTS = '/cal/mock/events/'
const object = (path: string) => caldav.collections.get(path.slice(0, path.lastIndexOf('/') + 1))?.objects.get(path)?.text ?? ''
const put = (name: string, text: string) => caldav.collections.get(EVENTS)!.objects.set(`${EVENTS}${name}`, { etag: `"seed-${name}"`, text })
const ical = (method: string | null, body: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Check//EN\r\n${method ? `METHOD:${method}\r\n` : ''}BEGIN:VEVENT\r\n${body}END:VEVENT\r\nEND:VCALENDAR\r\n`
const day = (plus: number) => {
  const d = new Date(Date.now() + plus * 864e5)
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`
}
const bob = { name: 'Bob Builder', email: 'bob@example.test' }
const lines = (uid: string, extra = '') => `UID:${uid}\r\nDTSTAMP:20261001T080000Z\r\nSEQUENCE:2\r\nSUMMARY:Review ${uid.split('@')[0]}\r\nDTSTART:${day(3)}T090000Z\r\nDTEND:${day(3)}T100000Z\r\nORGANIZER;CN=Bob Builder:mailto:bob@example.test\r\nATTENDEE;CN=Test User;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${ME.email}\r\nATTENDEE;CN=Carol;PARTSTAT=ACCEPTED:mailto:carol@example.test\r\n${extra}`
/** A message with an invitation, delivered to the mock's Inbox; answers its id. */
const deliver = (subject: string, calendar: string, from = bob) => jmapMock.deliver({ from: [from], subject, text: 'See the invitation.', calendar }).id

try {
  // --- Linking (an admin may use the stand-ins on 127.0.0.1) ---------------------------------------
  const acc = (await api<{ id: number }>('POST', '/api/mail/accounts', { url: jmapMock.sessionUrl, token: jmapMock.token })).id
  await api('POST', '/api/caldav', { url: `${caldav.origin}/`, username: USER, password: PASSWORD, label: 'Mock' })
  const cals = (await api<{ calendars: J[] }>('GET', '/api/calendar/calendars')).calendars
  const eventsCal = cals.find((c) => c.name === 'Events')!
  const googleCal = cals.find((c) => c.source === 'Google' && c.primary)!
  check(`the CalDAV and Google calendars are there (${cals.map((c) => c.name).join(', ')})`, !!eventsCal && !!googleCal)

  // --- An invitation in a CalDAV calendar: PARTSTAT changed there ----------------------------------
  put('caldav-invite.ics', ical(null, lines('caldav-invite@example.test')))
  const m1 = deliver('Invitation: Review caldav-invite', ical('REQUEST', lines('caldav-invite@example.test')))
  let state = await api('GET', `/api/pim/invite?account=${acc}&email=${m1}`)
  check('the card finds the event in the CalDAV calendar', state.where?.source === 'caldav' && state.where.calendar === 'Events' && state.status === 'needs-action' && state.canAnswer && state.me === ME.email)
  const sentBefore = jmapMock.submissions.length
  let r = await api('POST', '/api/pim/invite', { account: acc, email: m1, action: 'answer', answer: 'accepted' })
  let text = object(`${EVENTS}caldav-invite.ics`)
  check('accepting sets your PARTSTAT in the event itself', /ATTENDEE;CN=Test User;PARTSTAT=ACCEPTED:mailto:me@example\.test/.test(text) && r.via === 'caldav')
  check('RSVP is taken off your line, and the other guest is untouched', !/PARTSTAT=ACCEPTED;RSVP/.test(text) && text.includes('ATTENDEE;CN=Carol;PARTSTAT=ACCEPTED:mailto:carol@example.test'))
  check('the CalDAV server sends the reply: nothing is mailed from here', jmapMock.submissions.length === sentBefore)
  check('the card then shows your answer', r.state.status === 'accepted')
  r = await api('POST', '/api/pim/invite', { account: acc, email: m1, action: 'answer', answer: 'declined' })
  check('an answer can be changed', /PARTSTAT=DECLINED:mailto:me@example\.test/.test(object(`${EVENTS}caldav-invite.ics`)) && r.state.status === 'declined')

  // --- An invitation in Google Calendar: answered through Google's API -----------------------------
  google.calendars.get(ME.email)!.events.set('gev1', {
    id: 'gev1',
    iCalUID: 'google-invite@example.test',
    status: 'confirmed',
    summary: 'Review google-invite',
    start: { dateTime: new Date(Date.now() + 2 * 864e5).toISOString() },
    end: { dateTime: new Date(Date.now() + 2 * 864e5 + 3600_000).toISOString() },
    attendees: [
      { email: bob.email, organizer: true, responseStatus: 'accepted' },
      { email: ME.email, self: true, responseStatus: 'needsAction' },
      { email: 'carol@example.test', responseStatus: 'needsAction' },
    ],
  })
  const m2 = deliver('Invitation: Review google-invite', ical('REQUEST', lines('google-invite@example.test')))
  state = await api('GET', `/api/pim/invite?account=${acc}&email=${m2}`)
  check('the card finds the event in Google Calendar', state.where?.source === 'google' && state.status === 'needs-action')
  r = await api('POST', '/api/pim/invite', { account: acc, email: m2, action: 'answer', answer: 'tentative' })
  const gev = google.calendars.get(ME.email)!.events.get('gev1')!
  check('maybe sets your responseStatus in Google', gev.attendees.find((a: J) => a.self).responseStatus === 'tentative' && r.via === 'google')
  check('with Google mailing the organiser (sendUpdates=all)', google.log.some((l) => l.startsWith('PATCH /calendars/') && l.endsWith('sendUpdates=all')))
  check('and the other guests left as they were', gev.attendees.find((a: J) => a.email === 'carol@example.test').responseStatus === 'needsAction')
  check('nothing is mailed from here for it', jmapMock.submissions.length === sentBefore)

  // --- An invitation from elsewhere: a copy in the calendar picked, and an iMIP REPLY ----------------
  const m3 = deliver('Invitation: Review elsewhere', ical('REQUEST', lines('elsewhere@example.test', 'LOCATION:Room 7\r\nBEGIN:VALARM\r\nTRIGGER:-PT10M\r\nACTION:DISPLAY\r\nDESCRIPTION:x\r\nEND:VALARM\r\n')))
  state = await api('GET', `/api/pim/invite?account=${acc}&email=${m3}`)
  check('an invitation that is in no calendar can still be answered', state.where === null && state.canAnswer)
  r = await api('POST', '/api/pim/invite', { account: acc, email: m3, action: 'answer', answer: 'accepted', calendar: eventsCal.id })
  const copyPath = [...caldav.collections.get(EVENTS)!.objects.keys()].find((k) => object(k).includes('UID:elsewhere@example.test'))
  const copy = copyPath ? object(copyPath) : ''
  check('accepting puts a copy in the calendar picked', r.via === 'email' && r.added === eventsCal.id && !!copyPath)
  check('the copy has no METHOD, your answer, and leaves scheduling to you (SCHEDULE-AGENT=CLIENT)', !/^METHOD:/m.test(copy) && /PARTSTAT=ACCEPTED:mailto:me@example\.test/.test(copy) && /^ORGANIZER;CN=Bob Builder;SCHEDULE-AGENT=CLIENT:mailto:bob@example\.test/m.test(copy))
  check('and keeps the rest of the invitation (its alarm, its place)', copy.includes('BEGIN:VALARM') && copy.includes('LOCATION:Room 7'))
  const sub = jmapMock.submissions.at(-1)
  check('a reply is sent to the organiser', jmapMock.submissions.length === sentBefore + 1 && sub?.to?.[0]?.email === bob.email && sub?.subject === 'Accepted: Review elsewhere')
  const raw = (jmapMock.emails.get(sub?.emailId)?.raw ?? '') as string
  check('as text/calendar with method=REPLY', /Content-Type: text\/calendar; method=REPLY; charset=utf-8/.test(raw) && /Content-Type: multipart\/alternative/.test(raw))
  const parts = raw.split(/--mvlos-[0-9a-f]+/).map((p) => p.split(/\r\n\r\n/))
  const icsPart = parts.find((p) => /text\/calendar/.test(p[0]))
  const reply = icsPart ? Buffer.from(icsPart.slice(1).join('').replace(/\s+/g, ''), 'base64').toString('utf8').replace(/\r\n[ \t]/g, '') : ''
  check('whose iCalendar says METHOD:REPLY with the same UID and SEQUENCE', /^METHOD:REPLY\r$/m.test(reply) && reply.includes('UID:elsewhere@example.test') && reply.includes('SEQUENCE:2'))
  check('with you as the ATTENDEE, accepted, and the ORGANIZER', /^ATTENDEE;CN=Test User;PARTSTAT=ACCEPTED:mailto:me@example\.test\r$/m.test(reply) && /^ORGANIZER;CN=Bob Builder:mailto:bob@example\.test\r$/m.test(reply))
  check('and nobody else on it', !reply.includes('carol@example.test'))
  check('the reply goes to Sent, as sent', !!jmapMock.emails.get(sub?.emailId)?.mailboxIds['mb-sent'] && !jmapMock.emails.get(sub?.emailId)?.keywords.$draft)
  r = await api('GET', `/api/pim/invite?account=${acc}&email=${m3}`)
  check('the card then finds the copy, with your answer', r.where?.source === 'caldav' && r.status === 'accepted')

  // Into Google instead: imported with its own UID, and the reply by email too.
  const m4 = deliver('Invitation: Review elsewhere-two', ical('REQUEST', lines('elsewhere-two@example.test')))
  r = await api('POST', '/api/pim/invite', { account: acc, email: m4, action: 'answer', answer: 'tentative', calendar: googleCal.id })
  const imported = [...google.calendars.get(ME.email)!.events.values()].find((e) => e.iCalUID === 'elsewhere-two@example.test')
  check('into Google: imported with its UID and your answer', r.added === googleCal.id && imported?.attendees.find((a: J) => a.email === ME.email)?.responseStatus === 'tentative' && imported?.organizer?.email === bob.email)
  check('and a reply mailed (Tentatively accepted)', jmapMock.submissions.at(-1)?.subject === 'Tentatively accepted: Review elsewhere-two')
  // Declined: nothing added anywhere, only the reply.
  const m5 = deliver('Invitation: Review declined-one', ical('REQUEST', lines('declined-one@example.test')))
  const before = caldav.collections.get(EVENTS)!.objects.size
  r = await api('POST', '/api/pim/invite', { account: acc, email: m5, action: 'answer', answer: 'declined', calendar: eventsCal.id })
  check('declining adds nothing, and sends the reply', r.added === null && caldav.collections.get(EVENTS)!.objects.size === before && jmapMock.submissions.at(-1)?.subject === 'Declined: Review declined-one')
  // Not a guest: refused.
  const m6 = deliver('Invitation: not for me', ical('REQUEST', lines('not-mine@example.test').replace(`mailto:${ME.email}`, 'mailto:someone@else.test')))
  check('an invitation that does not list you is refused', (await status(sid, 'POST', '/api/pim/invite', { account: acc, email: m6, action: 'answer', answer: 'accepted' })) === 400)

  // --- A cancellation ------------------------------------------------------------------------------
  const m7 = deliver('Cancelled: Review caldav-invite', ical('CANCEL', `${lines('caldav-invite@example.test')}STATUS:CANCELLED\r\n`))
  state = await api('GET', `/api/pim/invite?account=${acc}&email=${m7}`)
  check('a cancellation finds the event still in the calendar', state.method === 'CANCEL' && state.where?.source === 'caldav' && !state.canAnswer)
  r = await api('POST', '/api/pim/invite', { account: acc, email: m7, action: 'remove' })
  check('and takes it out', !object(`${EVENTS}caldav-invite.ics`) && r.state.where === null)

  // --- A guest's reply onto your own event ---------------------------------------------------------
  const mine = `UID:my-party@example.test\r\nDTSTAMP:20261001T080000Z\r\nSUMMARY:My party\r\nDTSTART:${day(5)}T180000Z\r\nDTEND:${day(5)}T220000Z\r\nORGANIZER:mailto:${ME.email}\r\nATTENDEE;PARTSTAT=ACCEPTED:mailto:${ME.email}\r\nATTENDEE;CN=Dave;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:dave@example.test\r\nATTENDEE;CN=Carol;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:carol@example.test\r\n`
  put('my-party.ics', ical(null, mine))
  const dave = { name: 'Dave', email: 'dave@example.test' }
  const replyBody = `UID:my-party@example.test\r\nDTSTAMP:20261002T080000Z\r\nORGANIZER:mailto:${ME.email}\r\nATTENDEE;CN=Dave;PARTSTAT=ACCEPTED:mailto:dave@example.test\r\n`
  const m8 = deliver('Accepted: My party', ical('REPLY', replyBody), dave)
  state = await api('GET', `/api/pim/invite?account=${acc}&email=${m8}`)
  check('a reply, which often has no title or time, gets them from your event', state.where?.title === 'My party' && !!state.where?.start)
  check('a reply shows the answer and what your event says now', state.organiser && state.replies[0]?.email === 'dave@example.test' && state.replies[0].status === 'accepted' && state.replies[0].current === 'needs-action' && state.replies[0].fromSender)
  r = await api('POST', '/api/pim/invite', { account: acc, email: m8, action: 'apply' })
  text = object(`${EVENTS}my-party.ics`)
  check("the guest's answer is written onto your event", /ATTENDEE;CN=Dave;PARTSTAT=ACCEPTED:mailto:dave@example\.test/.test(text) && r.state.replies[0].current === 'accepted')
  check('and only theirs', text.includes('ATTENDEE;CN=Carol;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:carol@example.test'))
  const forged = deliver('Accepted: My party', ical('REPLY', replyBody.replace('PARTSTAT=ACCEPTED:mailto:dave', 'PARTSTAT=DECLINED:mailto:dave')), { name: 'Erin', email: 'erin@example.test' })
  check('a reply sent by someone else for that guest is refused', (await status(sid, 'POST', '/api/pim/invite', { account: acc, email: forged, action: 'apply' })) === 400 && /PARTSTAT=ACCEPTED:mailto:dave/.test(object(`${EVENTS}my-party.ics`)))

  // --- A contact's recent mail and upcoming events -------------------------------------------------
  const carol = await api('POST', '/api/contacts/card', { book: 'local', fields: { fn: 'Carol Writer', n: { family: 'Writer', given: 'Carol', middle: '', prefix: '', suffix: '' }, nickname: '', org: '', department: '', title: '', emails: [{ value: 'carol@example.test' }, { value: 'carol.w@work.example' }], phones: [], urls: [], addresses: [], birthday: '', anniversaries: [], note: '', categories: [] } })
  const emails = carol.emails.map((e: J) => e.value).join(',')
  jmapMock.deliver({ from: [{ name: 'Carol at work', email: 'carol.w@work.example' }], subject: 'From her work address', text: 'Hello from work.' })
  const recent = await api('GET', `/api/pim/mail-with?emails=${encodeURIComponent(emails)}&limit=5`)
  const subjects = recent.messages.map((m: J) => m.subject)
  check(`a contact's recent mail, from any of their addresses (${subjects.join(' | ')})`, subjects[0] === 'From her work address' && subjects.includes('Re: Draft chapter') && recent.messages.every((m: J) => m.account === acc))
  check('one row per conversation, newest first', subjects.filter((s: string) => /Draft chapter/.test(s)).length === 1 && recent.messages.every((m: J, i: number, a: J[]) => i === 0 || a[i - 1].receivedAt >= m.receivedAt))
  check('nothing from Trash or Junk', (await api('GET', '/api/pim/mail-with?emails=old%40news.example')).messages.length === 0)
  check('nor Drafts', !(await api('GET', '/api/pim/mail-with?emails=alice%40example.test')).messages.some((m: J) => m.subject === 'Half-written note'))
  put('with-carol.ics', ical(null, `UID:with-carol@example.test\r\nDTSTAMP:20261001T080000Z\r\nSUMMARY:Coffee with Carol\r\nDTSTART:${day(10)}T090000Z\r\nDTEND:${day(10)}T100000Z\r\nORGANIZER:mailto:${ME.email}\r\nATTENDEE;PARTSTAT=ACCEPTED:mailto:${ME.email}\r\nATTENDEE;PARTSTAT=ACCEPTED:mailto:carol@example.test\r\n`))
  put('far-off.ics', ical(null, `UID:far-off@example.test\r\nDTSTAMP:20261001T080000Z\r\nSUMMARY:Far off\r\nDTSTART:${day(80)}T090000Z\r\nDTEND:${day(80)}T100000Z\r\nATTENDEE:mailto:carol@example.test\r\n`))
  put('without-carol.ics', ical(null, `UID:without@example.test\r\nDTSTAMP:20261001T080000Z\r\nSUMMARY:Alone\r\nDTSTART:${day(4)}T090000Z\r\nDTEND:${day(4)}T100000Z\r\n`))
  const upcoming = (await api('GET', `/api/pim/events-with?emails=${encodeURIComponent(emails)}&days=60&fresh=1`)).events.map((e: J) => e.title)
  check(`upcoming events with them, in the next 60 days (${upcoming.join(' | ')})`, upcoming.includes('Coffee with Carol') && upcoming.includes('My party') && upcoming.includes('Review google-invite') && !upcoming.includes('Far off') && !upcoming.includes('Alone'))

  // --- A task from a message, with the link back ---------------------------------------------------
  const lunch = [...jmapMock.emails.values()].find((e) => e.subject === 'Lunch on Friday?')!
  const task = (await api('POST', '/api/pim/task-from-mail', { account: acc, email: lunch.id, due: '2026-10-20' })).task
  check('the task is the subject, due that day', task.title === 'Lunch on Friday?' && task.due === '2026-10-20' && task.allDay)
  check('with the sender and a snippet as notes', task.notes.startsWith('From Alice Example <alice@example.test>') && task.notes.includes('Shall we have lunch on Friday?'))
  check(`and the link back by Message-ID (${task.url})`, task.url === `message:%3C${lunch.messageId[0]}%3E`)
  const mid = decodeURIComponent(task.url.slice('message:'.length)).replace(/^<|>$/g, '')
  const found = await api('GET', `/api/pim/find-mail?messageId=${encodeURIComponent(mid)}`)
  check('the link finds the message again', found.account === acc && found.id === lunch.id && found.threadId === lunch.threadId)
  check('an unknown Message-ID is not found', (await status(sid, 'GET', '/api/pim/find-mail?messageId=nobody%40nowhere.test', undefined)) === 404)
  const list = (await api('GET', '/api/tasks')).tasks as J[]
  check('the task is in Tasks', list.some((t) => t.id === task.id && t.url === task.url))

  // --- A tapped push opens what it is about ---------------------------------------------------------
  const { actionUrl } = await import('../src/data/notifySources.ts')
  check('a task reminder opens that task (/?open=tasks&task=…)', actionUrl({ app: 'tasks', props: { task: task.id } }) === `/?open=tasks&task=${encodeURIComponent(task.id)}`)
  check('an Agents answer still opens its thread', actionUrl({ app: 'agents', props: { thread: 'abc' } }) === '/?open=agents&thread=abc')

  // --- Another user ----------------------------------------------------------------------------------
  check("another user can't read the invitation", (await status(otherSid, 'GET', `/api/pim/invite?account=${acc}&email=${m3}`)) === 404)
  check("nor answer it", (await status(otherSid, 'POST', '/api/pim/invite', { account: acc, email: m3, action: 'answer', answer: 'declined' })) === 404 && /PARTSTAT=ACCEPTED:mailto:me/.test(copy))
  check("nor make a task from someone else's mail", (await status(otherSid, 'POST', '/api/pim/task-from-mail', { account: acc, email: lunch.id })) === 404)
  const otherMail = await call(otherSid, 'GET', `/api/pim/mail-with?emails=${encodeURIComponent(emails)}`)
  const otherEvents = await call(otherSid, 'GET', `/api/pim/events-with?emails=${encodeURIComponent(emails)}`)
  check('and sees no mail and no events with that contact', otherMail.messages.length === 0 && otherEvents.events.length === 0)
  check('nor finds the message by its Message-ID', (await status(otherSid, 'GET', `/api/pim/find-mail?messageId=${encodeURIComponent(mid)}`)) === 404)
  check('signed out, nothing at all', (await (await fetch(`${server.origin}/api/pim/mail-with?emails=carol%40example.test`)).status) === 401)
} catch (e) {
  check(`no errors (${(e as Error).message})`, false)
  console.error(server.log?.slice?.(-2000))
} finally {
  await server.dispose()
  await jmapMock.close()
  await caldav.close()
  await google.close()
}
finish()
