// Checks the Tasks app's server side (server/tasks.ts) against a stand-in CalDAV server
// (scripts/tasks-mock.ts): it starts the real server (server/index.ts) on a free port with a scratch
// DATA_DIR and a signed-in admin (admins may reach internal addresses, so the mock on 127.0.0.1 can
// be linked), links the mock as a CalDAV account and goes through:
//
//   - discovery: task lists are the collections that take VTODOs; events-only ones are left out,
//   - reading tasks (due, priority, notes, order, alarms) and making new ones,
//   - changes written into the task's own text, keeping other apps' properties and alarms,
//   - completing, and completing a repeating task (it moves on to its next occurrence),
//   - a conflict: the task changed elsewhere between reading and writing (412), retried once
//     from the new text, and a 409 when it keeps changing,
//   - subtasks, manual order, moving between lists, lists on this site, making and deleting lists,
//   - reminders: due tasks notify once through the notification hub, however often the watcher runs,
//   - the quick-add parser's dates.
//
//   node scripts/tasks-check.ts
//
// Exits 1 on any failure.

import { randomBytes } from 'node:crypto'
import { Server, check, finish } from './empires-harness.ts'
import { PASSWORD, startMock, USER } from './tasks-mock.ts'
import { asPage } from './as-page.ts'

const mock = await startMock()
const LOGIN = 'tasks-check'
process.env.ADMIN_GITHUB_IDS = '1'
const server = new Server({ GITHUB_CLIENT_ID: 'x', GITHUB_CLIENT_SECRET: 'x', ADMIN_GITHUB_IDS: '1', NOTIFY_WATCH: 'off' })
// The account and its session go straight into the scratch database, before the server opens it.
process.env.DATA_DIR = server.data
const { database, encrypt, sha256 } = await import('../server/db.ts')
const sid = randomBytes(24).toString('hex')
const now = Date.now()
database().prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (1, 1, ?, ?, ?, ?)').run(LOGIN, encrypt('none'), now, now)
database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, 1, ?, ?)').run(sha256(sid), now, now + 86400_000)
await server.start()

type Task = { id: string; list: string; uid: string; ref: string; title: string; notes?: string; due?: string; allDay?: boolean; priority: number; completed: boolean; url?: string; parent?: string; order?: number; repeat?: string; alarms?: string[] }
type List = { id: string; name: string; source: string; writable: boolean; local: boolean; calendar?: boolean }

const api = async <T = any>(method: string, path: string, body?: unknown, expect = 200): Promise<T> => {
  const res = await fetch(`${server.origin}${path}`, { method, headers: { Cookie: `mvlos_sid=${sid}`, ...(await asPage(sid)), 'Content-Type': 'application/json', Origin: server.origin }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  if (res.status !== expect) throw new Error(`${method} ${path}: ${res.status} ${text}`)
  return JSON.parse(text) as T
}
const all = () => api<{ lists: List[]; tasks: Task[]; errors: string[] }>('GET', '/api/tasks?fresh=1')
const object = (path: string) => mock.collections.get(path.slice(0, path.lastIndexOf('/') + 1))?.objects.get(path)?.text ?? ''
const find = (tasks: Task[], uid: string) => tasks.find((t) => t.uid === uid)!

try {
  // --- Discovery ----------------------------------------------------------------------------------
  await api('POST', '/api/caldav', { url: `${mock.origin}/`, username: USER, password: PASSWORD, label: 'Mock' })
  let r = await all()
  check(`no errors (${r.errors.join('; ') || 'none'})`, r.errors.length === 0)
  const names = r.lists.map((l) => l.name).sort()
  check(`task lists are the VTODO collections (${names.join(', ')})`, names.join(',') === 'Personal,Reminders')
  check('with a CalDAV account, no list on this site is made', !r.lists.some((l) => l.local))
  const reminders = r.lists.find((l) => l.name === 'Reminders')!
  const personal = r.lists.find((l) => l.name === 'Personal')!
  check('a collection that takes events too is marked as a calendar', !!personal.calendar && !reminders.calendar)

  // --- Reading --------------------------------------------------------------------------------------
  const seed1 = find(r.tasks, 'seed-1')
  check('a task reads its title, notes, priority and order', seed1.title === 'Water the plants' && seed1.notes === 'The ones on the balcony' && seed1.priority === 5 && seed1.order === 100)
  check('an all-day due date is a day', seed1.allDay === true && /^\d{4}-\d{2}-\d{2}$/.test(seed1.due ?? ''))
  check('its own alarm is read', seed1.alarms?.[0] === '2030-01-01T09:00:00.000Z')
  const seed2 = find(r.tasks, 'seed-2')
  check('a repeating task carries its rule', seed2.repeat === 'FREQ=WEEKLY;COUNT=3' && seed2.due === '2026-10-13T07:00:00.000Z')

  // --- Creating -------------------------------------------------------------------------------------
  const created = (await api<{ task: Task }>('POST', '/api/tasks', { list: reminders.id, task: { title: 'Buy milk', notes: 'Oat, 2 cartons', due: '2026-10-14T16:30:00.000Z', url: 'https://example.com/shop', priority: 1, timeZone: 'Europe/Amsterdam' } })).task
  const createdPath = `/cal/mock/tasks/${created.uid}.ics`
  check('a new task is written as its own object', object(createdPath).includes('SUMMARY:Buy milk'))
  check('with its due time in the browser zone', object(createdPath).includes('DUE;TZID=Europe/Amsterdam:20261014T183000'))
  check('and its link, priority and notes', object(createdPath).includes('URL:https://example.com/shop') && object(createdPath).includes('PRIORITY:1') && object(createdPath).includes('DESCRIPTION:Oat\\, 2 cartons'))
  check('it reads back the same', created.due === '2026-10-14T16:30:00.000Z' && created.priority === 1 && created.url === 'https://example.com/shop')
  await api('POST', '/api/tasks', { list: reminders.id, task: { title: 'Bad', url: 'javascript:alert(1)' } }, 400)
  check('a link that is not https, mailto or message is refused', true)

  // --- Changes keep what they don't touch -------------------------------------------------------------
  await api('PATCH', '/api/tasks', { ref: seed1.ref, task: { title: 'Water all the plants', priority: 9 } })
  let text = object('/cal/mock/tasks/seed-1.ics')
  check('a change is made', text.includes('SUMMARY:Water all the plants') && text.includes('PRIORITY:9'))
  check("another app's property stays", text.includes("X-FOO-UNKNOWN;X-PARAM=keep:Some other app's value"))
  check('the alarm stays', text.includes('BEGIN:VALARM') && text.includes('X-WR-ALARMUID:alarm-1'))
  check('the notes and order stay', text.includes('DESCRIPTION:The ones on the balcony') && text.includes('X-APPLE-SORT-ORDER:100'))
  check('the write was conditional (If-Match)', mock.log.filter((l) => l === 'PUT /cal/mock/tasks/seed-1.ics').length === 1)

  // --- Completing -------------------------------------------------------------------------------------
  await api('PATCH', '/api/tasks', { ref: seed1.ref, task: { completed: true } })
  text = object('/cal/mock/tasks/seed-1.ics')
  check('completing sets STATUS and COMPLETED', text.includes('STATUS:COMPLETED') && /COMPLETED:\d{8}T\d{6}Z/.test(text) && text.includes('PERCENT-COMPLETE:100'))
  r = await all()
  check('a completed task reads as completed', find(r.tasks, 'seed-1').completed)
  await api('PATCH', '/api/tasks', { ref: seed1.ref, task: { completed: false } })
  text = object('/cal/mock/tasks/seed-1.ics')
  check('and back again', text.includes('STATUS:NEEDS-ACTION') && !/^COMPLETED:/m.test(text))

  // --- Repeating ------------------------------------------------------------------------------------
  const weekly = await api<{ task: Task; advanced: boolean }>('PATCH', '/api/tasks', { ref: seed2.ref, task: { completed: true } })
  text = object('/cal/mock/tasks/seed-2.ics')
  check('a weekly task moves on a week, at the same wall-clock time', weekly.advanced && text.includes('DUE;TZID=Europe/Amsterdam:20261020T090000') && text.includes('DTSTART;TZID=Europe/Amsterdam:20261020T090000'))
  check('it stays open, with one occurrence fewer to go', !text.includes('STATUS:COMPLETED') && text.includes('RRULE:FREQ=WEEKLY;COUNT=2'))
  check('it answers the next due date', weekly.task.due === '2026-10-20T07:00:00.000Z' && !weekly.task.completed)
  const daily = await api<{ task: Task; advanced: boolean }>('PATCH', '/api/tasks', { ref: find(r.tasks, 'seed-3').ref, task: { completed: true } })
  check('a daily all-day task moves on a day', daily.advanced && object('/cal/mock/tasks/seed-3.ics').includes('DUE;VALUE=DATE:20261014'))
  const monthly = await api<{ task: Task; advanced: boolean }>('PATCH', '/api/tasks', { ref: find(r.tasks, 'seed-4').ref, task: { completed: true } })
  check('a monthly task on the 31st skips the months without one', monthly.advanced && object('/cal/mock/tasks/seed-4.ics').includes('DUE;VALUE=DATE:20261231'))
  const last = await api<{ task: Task; advanced: boolean }>('PATCH', '/api/tasks', { ref: find(r.tasks, 'seed-5').ref, task: { completed: true } })
  check('the last occurrence completes it for good', !last.advanced && last.task.completed && object('/cal/mock/tasks/seed-5.ics').includes('STATUS:COMPLETED'))

  // --- Conflicts --------------------------------------------------------------------------------------
  mock.bump.set('/cal/mock/tasks/seed-1.ics', 1)
  await api('PATCH', '/api/tasks', { ref: seed1.ref, task: { title: 'After a conflict' } })
  text = object('/cal/mock/tasks/seed-1.ics')
  check('a 412 is tried once more from the new text: both changes are in', text.includes('SUMMARY:After a conflict') && text.includes('X-OTHER-APP:changed'))
  check('the first write was refused with 412 and the second went through', mock.log.filter((l) => l === 'PUT /cal/mock/tasks/seed-1.ics').length === 5)
  mock.bump.set('/cal/mock/tasks/seed-1.ics', 5)
  const conflict = await api<{ error: string }>('PATCH', '/api/tasks', { ref: seed1.ref, task: { title: 'Never' } }, 409)
  check(`a task that keeps changing answers 409 ("${conflict.error}")`, /changed somewhere else/.test(conflict.error) && !object('/cal/mock/tasks/seed-1.ics').includes('SUMMARY:Never'))
  mock.bump.clear()

  // --- Subtasks, order, moving --------------------------------------------------------------------------
  const child = (await api<{ task: Task }>('POST', '/api/tasks', { list: reminders.id, task: { title: 'Oat milk', parent: created.uid } })).task
  check('a subtask names its parent (RELATED-TO)', child.parent === created.uid && object(`/cal/mock/tasks/${child.uid}.ics`).includes(`RELATED-TO;RELTYPE=PARENT:${created.uid}`))
  r = await all()
  const inList = r.tasks.filter((t) => t.list === reminders.id && !t.completed && !t.parent)
  const sorted = [...inList].sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity))
  // Drag the last one (with order 300) to the top.
  const moved = sorted.find((t) => t.uid === 'seed-3')!
  const order = [moved, ...sorted.filter((t) => t !== moved)].map((t) => t.ref)
  await api('PUT', '/api/tasks/order', { list: reminders.id, refs: order, moved: moved.ref })
  r = await all()
  const top = r.tasks.filter((t) => t.list === reminders.id && !t.parent && !t.completed).sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity))[0]
  check(`a dragged task gets an order before the others (${find(r.tasks, 'seed-3').order})`, top.uid === 'seed-3')

  // --- Lists on this site --------------------------------------------------------------------------------
  const local = (await api<{ list: List }>('POST', '/api/tasks/lists', { name: 'Groceries', account: 'local', color: '#f7768e' })).list
  check('a list on this site is made', local.local && local.source === 'On this site')
  const l1 = (await api<{ task: Task }>('POST', '/api/tasks', { list: local.id, task: { title: 'Bread', due: '2026-10-15' } })).task
  check('a task on this site is made', l1.list === local.id && l1.due === '2026-10-15' && l1.allDay === true)
  const l1done = await api<{ task: Task }>('PATCH', '/api/tasks', { ref: l1.ref, task: { completed: true } })
  check('and completed', l1done.task.completed)
  const movedOut = await api<{ task: Task }>('PATCH', '/api/tasks', { ref: l1.ref, task: {}, list: reminders.id })
  check('a task moves from this site to a CalDAV list', movedOut.task.list === reminders.id && object(`/cal/mock/tasks/${l1.uid}.ics`).includes('SUMMARY:Bread'))
  r = await all()
  check('and is gone from the list it left', !r.tasks.some((t) => t.list === local.id))

  // --- Lists on the CalDAV server --------------------------------------------------------------------------
  const account = (await api<{ caldav: { id: number }[] }>('GET', '/api/me')).caldav[0].id
  const made = (await api<{ list: List }>('POST', '/api/tasks/lists', { name: 'Work <stuff>', account, color: '#bb9af7' })).list
  const dav = [...mock.collections.entries()].find(([, c]) => c.name === 'Work &lt;stuff&gt;' || c.name === 'Work <stuff>')
  check('MKCALENDAR makes a collection for VTODOs', !!dav && dav[1].comps.join() === 'VTODO')
  await api('PATCH', '/api/tasks/lists', { id: made.id, name: 'Work' })
  check('a list is renamed (PROPPATCH)', dav?.[1].name === 'Work')
  await api('DELETE', '/api/tasks/lists', { id: personal.id }, 400)
  check('a collection that is also a calendar is not deleted', mock.collections.has('/cal/mock/both/'))
  await api('DELETE', '/api/tasks/lists', { id: made.id })
  check('a task list is deleted', !!dav && !mock.collections.has(dav[0]))

  // --- Deleting -----------------------------------------------------------------------------------------
  await api('DELETE', '/api/tasks', { ref: created.ref })
  check('deleting a task deletes its subtasks too', !object(createdPath) && !object(`/cal/mock/tasks/${child.uid}.ics`))

  // --- Reminders ----------------------------------------------------------------------------------------
  // The watcher's own function, run here on the same database, as often as we like.
  const { taskReminders } = await import('../server/tasks.ts')
  const at = Date.now()
  await api('POST', '/api/tasks', { list: local.id, task: { title: 'Call the plumber', due: new Date(at - 60_000).toISOString() } })
  await api('POST', '/api/tasks', { list: local.id, task: { title: 'Due tomorrow', due: new Date(at + 864e5).toISOString() } })
  await api('POST', '/api/tasks', { list: local.id, task: { title: 'Long overdue', due: new Date(at - 5 * 3600_000).toISOString() } })
  await taskReminders(at)
  await taskReminders(at + 30_000)
  await taskReminders(at + 60_000)
  const sent = database().prepare("SELECT title, body FROM notifications WHERE user_id = 1 AND source = 'tasks.due'").all() as { title: string; body: string }[]
  check(`a due task notifies once, however often the watcher runs (${sent.map((s) => s.title).join(', ')})`, sent.filter((s) => s.title === 'Call the plumber').length === 1)
  check('not before it is due, nor hours after', !sent.some((s) => s.title === 'Due tomorrow' || s.title === 'Long overdue'))
  check(`it says when and which list ("${sent[0]?.body}")`, /Due .* · Groceries/.test(sent[0]?.body ?? ''))
  database().prepare("INSERT INTO state (user_id, key, value, updated_at) VALUES (1, 'notify', ?, ?)").run(JSON.stringify({ off: ['tasks'] }), Date.now())
  await api('POST', '/api/tasks', { list: local.id, task: { title: 'Switched off', due: new Date(at - 30_000).toISOString() } })
  await taskReminders(at + 90_000)
  const after = database().prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = 1 AND title = 'Switched off'").get() as { n: number }
  check('switched off in Settings → Notifications: no reminder', after.n === 0)

  // When reminders come: a task's own alarms win; otherwise the settings' default.
  const { reminderTimes } = await import('../server/tasks.ts')
  const prefs = { remind: true, lead: 15 as const, morning: '08:30', timeZone: 'Europe/Amsterdam', hiddenInCalendar: [], showCompleted: false, defaultList: null }
  check('a task with its own alarm reminds then', JSON.stringify(reminderTimes({ due: '2026-10-14', allDay: true, alarms: ['2026-10-13T18:00:00.000Z'], completed: false }, prefs)) === JSON.stringify([Date.parse('2026-10-13T18:00:00.000Z')]))
  check('a timed task reminds the set minutes before', reminderTimes({ due: '2026-10-14T10:00:00.000Z', allDay: false, completed: false }, prefs)[0] === Date.parse('2026-10-14T09:45:00.000Z'))
  check('an all-day task reminds in the morning, in the user zone', reminderTimes({ due: '2026-10-14', allDay: true, completed: false }, prefs)[0] === Date.parse('2026-10-14T06:30:00.000Z'))
  check('a completed task, or reminders off, never', !reminderTimes({ due: '2026-10-14', allDay: true, completed: true }, prefs).length && !reminderTimes({ due: '2026-10-14', allDay: true, completed: false }, { ...prefs, remind: false }).length)
  check('its own alarm is still read after all those changes', find((await all()).tasks, 'seed-1').alarms?.length === 1)
  await api('DELETE', '/api/tasks/lists', { id: local.id })
  check('a list on this site is deleted with its tasks', !(await all()).lists.some((l) => l.id === local.id) && (database().prepare('SELECT COUNT(*) AS n FROM task_items').get() as { n: number }).n === 0)

  // --- Importing events: the UID is kept, and a calendar says which UIDs it has --------------------------
  const calendars = (await api<{ calendars: { id: string; name: string }[] }>('GET', '/api/calendar/calendars')).calendars
  const events = calendars.find((c) => c.name === 'Events')!
  await api('POST', '/api/calendar/events', { calendar: events.id, event: { title: 'Imported viewing', start: '2026-10-15T08:00:00.000Z', end: '2026-10-15T08:30:00.000Z', allDay: false, uid: 'imported-1@example.com', timeZone: 'Europe/Amsterdam' } })
  const imported = [...(mock.collections.get('/cal/mock/events/')?.objects.entries() ?? [])].find(([, o]) => o.text.includes('SUMMARY:Imported viewing'))
  check('an imported event keeps its own UID', !!imported && imported[1].text.includes('UID:imported-1@example.com\r\n') && imported[0] === '/cal/mock/events/imported-1@example.com.ics')
  const known = await api<{ known: string[] }>('POST', '/api/calendar/known', { calendar: events.id, uids: ['imported-1@example.com', 'never-seen@example.com'] })
  check('the calendar says which UIDs it has', known.known.length === 1 && known.known[0] === 'imported-1@example.com')
  await api('POST', '/api/calendar/events', { calendar: events.id, event: { title: 'Odd UID', start: '2026-10-16T08:00:00.000Z', end: '2026-10-16T08:30:00.000Z', allDay: false, uid: 'has;semicolon' } })
  check('a UID that is no safe token is not kept', [...(mock.collections.get('/cal/mock/events/')?.objects.values() ?? [])].some((o) => o.text.includes('SUMMARY:Odd UID') && !o.text.includes('has;semicolon')))

  // --- Quick add ------------------------------------------------------------------------------------------
  const { parseQuick } = await import('../src/apps/tasks/quickAdd.ts')
  const base = new Date(2026, 9, 12, 14, 0) // Monday 12 October 2026, 14:00
  const q = (s: string) => parseQuick(s, base)
  check('"tomorrow 9am"', JSON.stringify(q('Call mum tomorrow 9am')) === JSON.stringify({ title: 'Call mum', due: new Date(2026, 9, 13, 9, 0).toISOString(), allDay: false, priority: 0 }))
  check('"fri"', q('Report fri').due === '2026-10-16' && q('Report fri').title === 'Report')
  check('"today 17:30"', q('Ship it today 17:30').due === new Date(2026, 9, 12, 17, 30).toISOString())
  check('"next week"', q('Plan next week').due === '2026-10-19')
  check('"in 3 days"', q('Follow up in 3 days').due === '2026-10-15')
  check('"on 24 dec"', q('Buy presents on 24 dec').due === '2026-12-24')
  check('"!!" sets priority', q('Taxes !!').priority === 5 && q('Taxes !!').title === 'Taxes')
  check('words in the title stay', q('Read Friday Night Lights').due === undefined)
} catch (e) {
  check(`no exception (${(e as Error).message})`, false)
} finally {
  await server.dispose()
  await mock.close()
}
finish()
