// Checks notes linked to calendar events (server/noteLinks.ts, server/agentNoteLinks.ts) through
// the real site server (server/index.ts, on a free port with a scratch DATA_DIR and two signed-in
// admins, who may reach the stand-ins on 127.0.0.1), against stand-ins for CalDAV
// (scripts/tasks-mock.ts), Google Calendar (scripts/google-mock.ts) and Ollama (a scripted model,
// as in scripts/agents-permissions.ts). It goes through:
//
//   - CalDAV: the note's backlink (X-MVLOS-NOTE) written into the event with everything else in it
//     kept (alarms, other apps' properties, SEQUENCE and DTSTAMP), an ETag conflict (read again
//     and redone; given up on after three tries), one occurrence of a series against the whole
//     series (no exception made for it), unlinking, and an event with guests left alone;
//   - Google: the backlink in the private extended properties, other apps' properties and the
//     guests kept, with sendUpdates=none;
//   - a link followed to its event, and to a deleted one;
//   - the Agents tools: a meeting note for an event (asked first in Ask first), linking in Auto
//     (no asking), and reading the notes of an event and the events of a note;
//   - another user, who reaches none of it.
//
//   node scripts/note-links-check.ts
//
// No real accounts. Exits 1 on any failure.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { Server, check, finish } from './empires-harness.ts'
import { startMockGoogle } from './google-mock.ts'
import { PASSWORD, startMock, USER } from './tasks-mock.ts'

type J = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

// --- The stand-in for Ollama: scripted turns ------------------------------------------------------
//
// The user's message starts with "SCENARIO <name> <arg>"; each round plays the next step, which
// may read the tool results so far (an event id from calendar_list_events).

const MODEL = 'main-model'
type Message = { role: string; content: string }
type ChatBody = { model: string; messages: Message[]; stream?: boolean; format?: unknown; tools?: { function: { name: string } }[] }
type Step = (results: J[], arg: string) => { name: string; arguments: J }[] | null
const firstEvent = (results: J[]) => (results.find((r) => Array.isArray(r.events))?.events?.[0]?.id as string) ?? 'none'
const SCENARIOS: Record<string, Step[]> = {
  // "make notes for my meeting tomorrow at 10": find it, then a meeting note.
  meeting: [(_, q) => [{ name: 'calendar_list_events', arguments: { query: q } }], (r) => [{ name: 'make_meeting_note', arguments: { event_id: firstEvent(r), agenda: '- Budget\n- Hiring' } }]],
  link: [(_, q) => [{ name: 'calendar_list_events', arguments: { query: q.split('|')[0] } }], (r, q) => [{ name: 'link_note_to_event', arguments: { note_id: q.split('|')[1], event_id: firstEvent(r) } }]],
  lookup: [(_, q) => [{ name: 'calendar_list_events', arguments: { query: q.split('|')[0] } }], (r, q) => [{ name: 'notes_for_event', arguments: { event_id: firstEvent(r) } }, { name: 'events_for_note', arguments: { note_id: q.split('|')[1] } }]],
  unlink: [(_, q) => [{ name: 'calendar_list_events', arguments: { query: q.split('|')[0] } }], (r, q) => [{ name: 'unlink_note_from_event', arguments: { note_id: q.split('|')[1], event_id: firstEvent(r) } }]],
}
const offered: string[][] = []

const json = (res: ServerResponse, body: unknown) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
const reply = (res: ServerResponse, msg: { content?: string; tool_calls?: unknown[] }) => {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
  res.write(`${JSON.stringify({ model: MODEL, message: { role: 'assistant', content: '', ...msg }, done: false })}\n`)
  res.end(`${JSON.stringify({ model: MODEL, message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 100, eval_count: 10 })}\n`)
}
function chat(body: ChatBody, res: ServerResponse) {
  if (body.format) return json(res, { model: body.model, message: { role: 'assistant', content: JSON.stringify({ verdict: 'safe', reason: 'ok' }) }, done: true })
  if (body.stream === false) return json(res, { model: body.model, message: { role: 'assistant', content: '{"title":"Note links check"}' }, done: true })
  offered.push((body.tools ?? []).map((t) => t.function.name))
  const at = body.messages.map((m) => m.role === 'user' && m.content.startsWith('SCENARIO ')).lastIndexOf(true)
  const [, name, ...rest] = (body.messages[at]?.content ?? '').split(' ')
  const after = body.messages.slice(at + 1)
  const round = after.filter((m) => m.role === 'assistant').length
  const results = after.filter((m) => m.role === 'tool').map((m) => {
    try {
      return JSON.parse(m.content) as J
    } catch {
      return {}
    }
  })
  const step = SCENARIOS[name]?.[round]
  const calls = step?.(results, rest.join(' '))
  if (calls) return reply(res, { tool_calls: calls.map((c) => ({ function: c })) })
  return reply(res, { content: `FINAL ${name}` })
}
const ollama = createServer((req: IncomingMessage, res: ServerResponse) => {
  let raw = ''
  req.on('data', (d) => (raw += d))
  req.on('end', () => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    if (path === '/api/tags') return void json(res, { models: [{ name: MODEL }] })
    if (path === '/api/show') return void json(res, { capabilities: ['completion', 'tools'], model_info: { 'x.context_length': 131072 } })
    if (path === '/api/chat') return chat(JSON.parse(raw) as ChatBody, res)
    res.writeHead(404).end()
  })
})
await new Promise<void>((r) => ollama.listen(0, '127.0.0.1', r))

// --- Stand-ins and the site -------------------------------------------------------------------------

const caldav = await startMock()
const google = await startMockGoogle()
const ME = 'me@example.test'
const LOGIN = 'notes-check'
const OTHER = 'notes-other'
const server = new Server({
  GITHUB_CLIENT_ID: 'x',
  GITHUB_CLIENT_SECRET: 'x',
  ADMIN_USERS: `${LOGIN},${OTHER}`,
  NOTIFY_WATCH: 'off',
  GOOGLE_CLIENT_ID: 'x',
  GOOGLE_CLIENT_SECRET: 'x',
  GOOGLE_API_URL: google.api,
  GOOGLE_TOKEN_URL: `${google.origin}/token`,
  OLLAMA_URL: `http://127.0.0.1:${(ollama.address() as { port: number }).port}`,
  OLLAMA_API_KEY: 'fake-key',
})
process.env.DATA_DIR = server.data
const { database, encrypt, sha256 } = await import('../server/db.ts')
const now = Date.now()
const sid = randomBytes(24).toString('hex')
const otherSid = randomBytes(24).toString('hex')
database().prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (1, 1, ?, ?, ?, ?)').run(LOGIN, encrypt('none'), now, now)
database().prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (2, 2, ?, ?, ?, ?)').run(OTHER, encrypt('none'), now, now)
database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, 1, ?, ?)').run(sha256(sid), now, now + 86400_000)
database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, 2, ?, ?)').run(sha256(otherSid), now, now + 86400_000)
database()
  .prepare('INSERT INTO google (user_id, email, refresh_token, access_token, expires_at, scopes, created_at) VALUES (1, ?, ?, ?, ?, ?, ?)')
  .run(ME, encrypt('mock-refresh'), encrypt(google.token), now + 3600_000 * 24, 'openid email https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events', now)
await server.start()

const call = async <T = J>(who: string, method: string, path: string, body?: unknown, expect = 200): Promise<T> => {
  const res = await fetch(`${server.origin}${path}`, { method, headers: { Cookie: `mvlos_sid=${who}`, 'Content-Type': 'application/json', Origin: server.origin }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  if (res.status !== expect) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 400)}`)
  return (text ? JSON.parse(text) : {}) as T
}
const api = <T = J>(method: string, path: string, body?: unknown, expect = 200) => call<T>(sid, method, path, body, expect)
const status = async (who: string, method: string, path: string, body?: unknown) => (await fetch(`${server.origin}${path}`, { method, headers: { Cookie: `mvlos_sid=${who}`, 'Content-Type': 'application/json', Origin: server.origin }, body: body === undefined ? undefined : JSON.stringify(body) })).status

/** One Agents turn, read as it streams; approvals answered by `allow`. Answers the approvals asked and the turn's tool results. */
async function turn(id: string, text: string, allow: boolean) {
  const asked: J[] = []
  const res = await fetch(`${server.origin}/api/agents/threads/${id}/messages`, { method: 'POST', headers: { Cookie: `mvlos_sid=${sid}`, 'Content-Type': 'application/json', Origin: server.origin }, body: JSON.stringify({ text, zone: 'Europe/Amsterdam' }) })
  if (!res.ok) throw new Error(`turn: ${res.status} ${await res.text()}`)
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let nl
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line) continue
      const e = JSON.parse(line) as J
      if (e.type === 'approval') {
        asked.push(e)
        void api('POST', `/api/agents/threads/${id}/approve`, { callId: e.callId, allow }).catch((err: Error) => check(`answering an approval worked (${err.message})`, false))
      }
    }
  }
  const t = await api('GET', `/api/agents/threads/${id}`)
  const last = (t.messages as J[]).map((m) => m.role).lastIndexOf('user')
  const tools = (t.messages as J[]).slice(last + 1).filter((m) => m.role === 'tool')
  return { asked, tools, result: (name: string) => JSON.parse(tools.find((m) => m.toolName === name)?.content ?? '{}') as J }
}

// --- The calendars' contents ----------------------------------------------------------------------------

const EVENTS = '/cal/mock/events/'
const objects = caldav.collections.get(EVENTS)!.objects
const object = (name: string) => objects.get(`${EVENTS}${name}`)
const put = (name: string, body: string) => objects.set(`${EVENTS}${name}`, { etag: `"seed-${name}"`, text: `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Check//EN\r\n${body}END:VCALENDAR\r\n` })
const stamp = (plusDays: number, hour: number) => {
  const d = new Date(Date.now() + plusDays * 864e5)
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}T${String(hour).padStart(2, '0')}0000Z`
}
put(
  'single.ics',
  `BEGIN:VEVENT\r\nUID:single@check\r\nDTSTAMP:20261001T080000Z\r\nSEQUENCE:3\r\nSUMMARY:Design review\r\nDESCRIPTION:Bring the mockups\r\nDTSTART:${stamp(1, 10)}\r\nDTEND:${stamp(1, 11)}\r\nX-OTHER-APP;X-PARAM=keep:Some other app's value\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Reminder\r\nTRIGGER:-PT10M\r\nEND:VALARM\r\nEND:VEVENT\r\n`,
)
put('series.ics', `BEGIN:VEVENT\r\nUID:series@check\r\nDTSTAMP:20261001T080000Z\r\nSUMMARY:Weekly standup\r\nDTSTART:${stamp(1, 9)}\r\nDTEND:${stamp(1, 9).replace(/0000Z$/, '3000Z')}\r\nRRULE:FREQ=WEEKLY;COUNT=4\r\nEND:VEVENT\r\n`)
put('guests.ics', `BEGIN:VEVENT\r\nUID:guests@check\r\nDTSTAMP:20261001T080000Z\r\nSUMMARY:Board meeting\r\nDTSTART:${stamp(2, 14)}\r\nDTEND:${stamp(2, 15)}\r\nORGANIZER:mailto:mock@example.test\r\nATTENDEE;PARTSTAT=ACCEPTED:mailto:mock@example.test\r\nATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:carol@example.test\r\nEND:VEVENT\r\n`)
const tomorrow10 = new Date(Date.now() + 864e5)
tomorrow10.setUTCHours(10, 0, 0, 0)
google.calendars.get(ME)!.events.set('gplan', {
  id: 'gplan',
  iCalUID: 'planning@google.test',
  status: 'confirmed',
  summary: 'Planning sync',
  location: 'Room 4',
  start: { dateTime: tomorrow10.toISOString() },
  end: { dateTime: new Date(tomorrow10.getTime() + 3600_000).toISOString() },
  attendees: [
    { email: ME, self: true, organizer: true, responseStatus: 'accepted' },
    { email: 'dana@example.test', displayName: 'Dana Scully', responseStatus: 'accepted' },
  ],
  extendedProperties: { private: { otherApp: 'keep me' }, shared: { team: 'x' } },
})

const N1 = randomUUID()
const N2 = randomUUID()
const note = (id: string, text: string) => ({ id, text, color: 'yellow', tilt: 1, created: now, updated: now })

try {
  await api('POST', '/api/caldav', { url: `${caldav.origin}/`, username: USER, password: PASSWORD, label: 'Mock' })
  await api('PUT', '/api/state/notes', { value: [note(N1, '# Design notes\n\nIdeas'), note(N2, '# Standup notes')] })
  const range = (days: number) => `from=${encodeURIComponent(new Date(Date.now() - 864e5).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + days * 864e5).toISOString())}`
  const events = async () => (await api('GET', `/api/calendar/events?${range(40)}&fresh=1`)).events as J[]
  let list = await events()
  const single = list.find((e) => e.uid === 'single@check')!
  const occurrences = list.filter((e) => e.uid === 'series@check')
  const guests = list.find((e) => e.uid === 'guests@check')!
  const plan = list.find((e) => e.uid === 'planning@google.test')!
  check(`the events are there (${list.map((e) => e.title).join(', ')})`, !!single && occurrences.length === 4 && !!guests && !!plan)
  check('occurrences of a series say which one they are', occurrences.every((e) => e.recurring && typeof e.occurrence === 'string'))

  // --- CalDAV: the backlink, and everything else kept ----------------------------------------------
  const before = object('single.ics')!.text
  let r = await api('POST', '/api/calendar/note-link', { ref: single.ref, note: N1 })
  let text = object('single.ics')!.text
  check('linking writes X-MVLOS-NOTE into the CalDAV event', r.mirrored === true && text.includes(`X-MVLOS-NOTE:${N1}\r\n`))
  check("other apps' properties and the alarm stay", text.includes("X-OTHER-APP;X-PARAM=keep:Some other app's value") && text.includes('BEGIN:VALARM') && text.includes('TRIGGER:-PT10M'))
  check('it is not a change to the meeting: SEQUENCE, DTSTAMP and the rest as they were', text.includes('SEQUENCE:3\r\n') && text.includes('DTSTAMP:20261001T080000Z') && text.includes('DESCRIPTION:Bring the mockups') && text.includes('SUMMARY:Design review'))
  check('only the backlink and LAST-MODIFIED were added', text.replace(/X-MVLOS-NOTE:[^\r]*\r\n/, '').replace(/LAST-MODIFIED:[^\r]*\r\n/, '') === before)
  r = await api('POST', '/api/calendar/note-link', { ref: single.ref, note: N1 })
  check('linking again changes nothing', r.mirrored === true && object('single.ics')!.text.split(`X-MVLOS-NOTE:${N1}`).length === 2)
  list = await events()
  check('the event lists the linked note', list.find((e) => e.uid === 'single@check')?.notes?.includes(N1))

  // An ETag conflict: changed elsewhere right after it is read, once; then every time.
  const path = `${EVENTS}single.ics`
  caldav.bump.set(path, 1)
  const puts = () => caldav.log.filter((l) => l === `PUT ${path}`).length
  let p0 = puts()
  r = await api('POST', '/api/calendar/note-link', { ref: single.ref, note: N2 })
  text = object('single.ics')!.text
  check('a conflict is read again and redone (two PUTs, the second with the new ETag)', r.mirrored === true && puts() - p0 === 2 && text.includes(`X-MVLOS-NOTE:${N1}`) && text.includes(`X-MVLOS-NOTE:${N2}`))
  caldav.bump.set(path, 5)
  p0 = puts()
  const st = await status(sid, 'POST', '/api/calendar/note-link', { ref: single.ref, note: N2, unlink: true })
  check(`a conflict every time is given up on after three tries (409, got ${st})`, st === 409 && puts() - p0 === 3)
  caldav.bump.delete(path)
  r = await api('POST', '/api/calendar/note-link', { ref: single.ref, note: N2, unlink: true })
  text = object('single.ics')!.text
  check('unlinking takes only that note out', r.mirrored === true && !text.includes(N2) && text.includes(`X-MVLOS-NOTE:${N1}`))

  // --- CalDAV: one occurrence against the whole series -------------------------------------------------
  const second = occurrences[1]
  r = await api('POST', '/api/calendar/note-link', { ref: second.ref, note: N1 })
  // Unfolded: the line is longer than 75 octets, so it is written folded, as RFC 5545 asks.
  text = object('series.ics')!.text.replace(/\r\n[ \t]/g, '')
  check('one occurrence: on the series, saying which occurrence', r.mirrored === true && new RegExp(`X-MVLOS-NOTE;X-MVLOS-OCCURRENCE=\\d{8}T\\d{6}Z:${N1}`).test(text))
  check('and no exception made for it (still one VEVENT)', text.split('BEGIN:VEVENT').length === 2 && !text.includes('RECURRENCE-ID'))
  list = await events()
  const occ = list.filter((e) => e.uid === 'series@check')
  check('only that occurrence lists the note', occ.filter((e) => e.notes?.includes(N1)).map((e) => e.occurrence).join() === second.occurrence)
  r = await api('POST', '/api/calendar/note-link', { ref: occurrences[0].ref, note: N2, all: true })
  list = await events()
  check('the whole series: every occurrence lists the note', /X-MVLOS-NOTE:[\w-]+\r\n/.test(object('series.ics')!.text) && list.filter((e) => e.uid === 'series@check').every((e) => e.notes?.includes(N2)))
  await api('POST', '/api/calendar/note-link', { ref: second.ref, note: N1, unlink: true })
  await api('POST', '/api/calendar/note-link', { ref: second.ref, note: N2, all: true, unlink: true })
  check('unlinking the occurrence and the series takes both out', !object('series.ics')!.text.includes('X-MVLOS-NOTE'))

  // --- CalDAV: guests ------------------------------------------------------------------------------------
  const guestTag = object('guests.ics')!.etag
  r = await api('POST', '/api/calendar/note-link', { ref: guests.ref, note: N1 })
  check('an event with guests is left as it is (the link stays on the note)', r.mirrored === false && /guests/.test(r.why) && object('guests.ics')!.etag === guestTag)

  // --- Google ----------------------------------------------------------------------------------------------
  const gLog = google.log.length
  r = await api('POST', '/api/calendar/note-link', { ref: plan.ref, note: N1 })
  const gev = google.calendars.get(ME)!.events.get('gplan')!
  const patches = google.log.slice(gLog).filter((l) => l.startsWith('PATCH '))
  check('Google: the note goes in the private extended properties', r.mirrored === true && gev.extendedProperties.private.mvlosNotes === N1)
  check("Google: other apps' private and shared properties stay", gev.extendedProperties.private.otherApp === 'keep me' && gev.extendedProperties.shared.team === 'x')
  check(`Google: with sendUpdates=none, and nothing sent with all (${patches.join('; ')})`, patches.length === 1 && patches[0].endsWith('sendUpdates=none') && !google.log.slice(gLog).some((l) => l.includes('sendUpdates=all')))
  check('Google: the guests stay as they were', gev.attendees.length === 2 && gev.attendees[1].email === 'dana@example.test' && gev.attendees[1].responseStatus === 'accepted')
  list = await events()
  check('Google: the event lists the linked note', list.find((e) => e.uid === 'planning@google.test')?.notes?.includes(N1))
  await api('POST', '/api/calendar/note-link', { ref: plan.ref, note: N1, unlink: true })
  check('Google: unlinking takes it out again', google.calendars.get(ME)!.events.get('gplan')!.extendedProperties.private.mvlosNotes === '' && gev.extendedProperties.private.otherApp === 'keep me')

  // --- Following a link; a deleted event -------------------------------------------------------------------
  const link = { source: 'caldav', calendarId: single.calendarId, uid: 'single@check', ref: single.ref, title: 'Design review', start: single.start, end: single.end, allDay: false, linked: now }
  let found = await api('POST', '/api/calendar/find', { uid: link.uid, calendarId: link.calendarId, start: link.start })
  check('a link finds its event', found.event?.uid === 'single@check' && found.event.title === 'Design review' && !found.gone)
  found = await api('POST', '/api/calendar/find', { uid: 'series@check', calendarId: second.calendarId, occurrence: second.occurrence, start: second.start })
  check('a link to one occurrence finds that occurrence', found.event?.occurrence === second.occurrence)
  objects.delete(`${EVENTS}single.ics`)
  found = await api('POST', '/api/calendar/find', { uid: link.uid, calendarId: link.calendarId, start: link.start, fresh: true })
  check('a deleted event is reported gone', found.event === null && found.gone === true)
  r = await api('POST', '/api/calendar/note-link', { link, note: N1, all: true, unlink: true })
  check('unlinking from a deleted event still answers (nothing to take out)', r.mirrored === false && /gone/.test(r.why))
  check('linking to a deleted event is refused (404)', (await status(sid, 'POST', '/api/calendar/note-link', { ref: single.ref, note: N2 })) === 404)

  // --- The Agents tools -------------------------------------------------------------------------------------
  // Ask first: the meeting note waits for the user.
  const ask = await api('POST', '/api/agents/threads', { model: MODEL, mode: 'quick', permission: 'default' })
  let t = await turn(ask.id, 'SCENARIO meeting Planning sync', true)
  const made = t.result('make_meeting_note')
  check(`the note tools are offered with a calendar connected (${offered.at(-1)?.filter((n) => /note|event/.test(n)).join(', ')})`, ['notes_for_event', 'events_for_note', 'link_note_to_event', 'unlink_note_from_event', 'make_meeting_note'].every((n) => offered.at(-1)?.includes(n)))
  check(`Ask first: making a meeting note asks first (${t.asked.map((a) => a.call?.name).join(', ')})`, t.asked.length === 1 && t.asked[0].call?.name === 'make_meeting_note' && /Planning sync/.test(JSON.stringify(t.asked[0])))
  let notes = (await api('GET', '/api/state')).notes.value as J[]
  const meeting = notes.find((n) => n.id === made.note?.id)
  check('the meeting note is made: title and day, when and where, attendees, agenda, action items', !!meeting && /^# Planning sync — \w{3} \d{1,2} \w{3} \d{4}/.test(meeting.text) && meeting.text.includes('**Where:** Room 4') && meeting.text.includes('**Attendees:** Dana Scully') && meeting.text.includes('- Budget') && meeting.text.includes('## Action items'))
  check('and linked to the event, on the note and on the event', meeting?.events?.[0]?.uid === 'planning@google.test' && google.calendars.get(ME)!.events.get('gplan')!.extendedProperties.private.mvlosNotes === made.note?.id)
  t = await turn(ask.id, 'SCENARIO meeting Planning sync', false)
  check('declined, no second note is made', !!t.result('make_meeting_note').error && ((await api('GET', '/api/state')).notes.value as J[]).length === notes.length)

  // Auto: linking goes ahead.
  const auto = await api('POST', '/api/agents/threads', { model: MODEL, mode: 'quick', permission: 'auto' })
  t = await turn(auto.id, `SCENARIO link standup|${N2}`, true)
  notes = (await api('GET', '/api/state')).notes.value as J[]
  check(`Auto: linking runs without asking (${t.asked.length} asked)`, t.asked.length === 0 && t.result('link_note_to_event').linked?.event === 'Weekly standup')
  check('the note has the link, to that occurrence', notes.find((n) => n.id === N2)?.events?.some((l: J) => l.uid === 'series@check' && l.occurrence))
  t = await turn(auto.id, `SCENARIO lookup standup|${N2}`, true)
  check('notes_for_event finds the note on the event', t.result('notes_for_event').notes?.some((n: J) => n.id === N2 && n.title === 'Standup notes'))
  check('events_for_note finds the event, with its id', t.result('events_for_note').events?.some((e: J) => e.title === 'Weekly standup' && typeof e.id === 'string'))
  t = await turn(auto.id, `SCENARIO unlink standup|${N2}`, true)
  notes = (await api('GET', '/api/state')).notes.value as J[]
  check('unlink_note_from_event takes the link off the note and the event', !!t.result('unlink_note_from_event').unlinked && !notes.find((n) => n.id === N2)?.events?.length && !object('series.ics')!.text.includes('X-MVLOS-NOTE'))
  const plan2 = await api('POST', '/api/agents/threads', { model: MODEL, mode: 'quick', permission: 'plan' })
  await turn(plan2.id, 'SCENARIO none', true)
  check('Plan: the changing ones are not offered, the looking ones are', !offered.at(-1)!.includes('make_meeting_note') && !offered.at(-1)!.includes('link_note_to_event') && offered.at(-1)!.includes('notes_for_event'))

  // --- Another user ------------------------------------------------------------------------------------------
  check("another user can't link to someone else's event", [400, 404, 409].includes(await status(otherSid, 'POST', '/api/calendar/note-link', { ref: plan.ref, note: N1 })))
  check('nor take a backlink out', [400, 404, 409].includes(await status(otherSid, 'POST', '/api/calendar/note-link', { ref: occurrences[0].ref, note: N1, unlink: true })))
  const theirs = await call(otherSid, 'POST', '/api/calendar/find', { uid: 'planning@google.test', calendarId: plan.calendarId, start: plan.start })
  check('nor find the event by its UID', theirs.event === null)
  check('and sees none of the notes', !((await call(otherSid, 'GET', '/api/state')).notes?.value ?? []).length)
  check('signed out, nothing at all', (await (await fetch(`${server.origin}/api/calendar/find`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: server.origin }, body: '{"uid":"x"}' })).status) === 401)
} catch (e) {
  check(`no errors (${(e as Error).message})`, false)
  console.error(server.log?.slice?.(-3000))
} finally {
  await server.dispose()
  await caldav.close()
  await google.close()
  ollama.close()
}
finish()
