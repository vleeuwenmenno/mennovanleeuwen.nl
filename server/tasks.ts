import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { allows, normalizePrefs } from '../src/data/notifySources.ts'
import { normalizeTaskPrefs, type TaskPrefs } from '../src/data/taskPrefs.ts'
import { accounts as allAccounts, type User } from './auth.ts'
import {
  caldavAccounts,
  calendarHome,
  dav,
  davRequest,
  davTime,
  duration,
  esc,
  fold,
  getProp,
  icalText,
  icalTime,
  listCaldav,
  occurrences,
  own,
  parseLine,
  prop,
  resolveHref,
  responses,
  setProp,
  timeLine,
  unescapeXml,
  type CaldavAccount,
  type IcalProp,
} from './caldav.ts'
import { database, onUserGone } from './db.ts'
import { readCapped } from './egress.ts'
import { HttpError, json, readJson } from './http.ts'
import { notify, tellPages, type Notice } from './notifier.ts'
import { checkRoom } from './quota.ts'
import { readState } from './state.ts'

// Tasks (reminders, to-dos) for the Tasks app, the Calendar app and the Agenda widget: the VTODOs
// in the task lists of the user's CalDAV accounts (Fastmail, Nextcloud, iCloud where its reminders
// are exposed), and lists kept on the site itself in SQLite for accounts without CalDAV. Both keep
// each task as its own iCalendar text, so one set of code reads and changes them: a change is made
// in the task's text and written back with its ETag, so every property it doesn't touch (alarms,
// Apple's and Thunderbird's own) stays. A list is a CalDAV calendar collection whose
// supported-calendar-component-set includes VTODO (or that doesn't say), found from the calendar
// home like the calendars in server/caldav.ts, with the same WebDAV and iCalendar helpers.
//
// Repeating tasks show once, at their next due date. Completing one moves it on to the next
// occurrence (DUE, and DTSTART with it, the way Apple Reminders and Thunderbird do), until the rule
// runs out; then it is completed for good.
//
// Reminders: a watcher (every minute) tells about due tasks through the notification hub
// (server/notifier.ts): at a task's own alarms (VALARM) when it has any, otherwise at the default
// from the Tasks app's settings (synced state "tasks", src/data/taskPrefs.ts): when a timed task is
// due or some minutes before, and in the morning of an all-day one. Each one once.

export type TaskList = {
  id: string
  name: string
  color: string
  /** The account it lives in ("Fastmail"), or "On this site" */
  source: string
  writable: boolean
  local: boolean
  /** A CalDAV collection that is also a calendar (events too): it can't be deleted from here */
  calendar?: boolean
}

export type Task = {
  /** "<list id>|<UID>": stable while the task stays in its list. */
  id: string
  list: string
  uid: string
  /** Where it lives, for the server: sent back with a change. */
  ref: string
  title: string
  notes?: string
  /** "YYYY-MM-DD" for a day, or an ISO time. */
  due?: string
  allDay?: boolean
  /** iCalendar's: 1 highest to 9 lowest, 0 none. */
  priority: number
  completed: boolean
  completedAt?: string
  url?: string
  /** The UID of the task it is a subtask of (RELATED-TO). */
  parent?: string
  /** Apple's manual order (X-APPLE-SORT-ORDER), lowest first. */
  order?: number
  /** How it repeats: an RRULE's value. */
  repeat?: string
  /** When its own reminders (VALARMs) go off, ISO times. */
  alarms?: string[]
  created?: string
}

/** A change from the browser: only the fields given change; null removes one. */
type TaskInput = {
  title?: string
  notes?: string
  due?: string | null
  allDay?: boolean
  priority?: number
  url?: string | null
  parent?: string | null
  order?: number | null
  repeat?: string | null
  completed?: boolean
  /** The browser's zone: a new timed due date is written in it, so a repeating one keeps its wall-clock time. */
  timeZone?: string
}

const LOCAL_SOURCE = 'On this site'
const MAX_LOCAL_TASKS = 5000
const MAX_LOCAL_LISTS = 50
const MAX_TASK_BYTES = 64 * 1024
/** Completed tasks sent per list: the newest ones; years of done reminders stay on the server. */
const MAX_COMPLETED = 200

// ---------------------------------------------------------------------------------------------
// iCalendar

/** An iCalendar text as lines, each VTODO (with its alarms) gathered into its own array of lines. */
type Ics = (string | string[])[]

function parseIcs(text: string): Ics {
  const out: Ics = []
  let comp: string[] | null = null
  let depth = 0
  for (const line of text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/)) {
    if (!line) continue
    if (!comp) {
      if (line === 'BEGIN:VTODO') {
        comp = [line]
        depth = 0
      } else out.push(line)
      continue
    }
    comp.push(line)
    if (line.startsWith('BEGIN:')) depth++
    else if (line.startsWith('END:')) {
      if (depth === 0) {
        out.push(comp)
        comp = null
      } else depth--
    }
  }
  return out
}

const printIcs = (ics: Ics) => `${ics.flat().map(fold).join('\r\n')}\r\n`
/** The task itself: the VTODO that is not one changed occurrence (RECURRENCE-ID) of it. */
const masterOf = (ics: Ics) => ics.find((x): x is string[] => Array.isArray(x) && !getProp(x, 'RECURRENCE-ID')) ?? null

/** A line with another value, its name and parameters as they were. */
function withValue(line: string, value: string): string {
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted
    else if (line[i] === ':' && !quoted) return `${line.slice(0, i + 1)}${value}`
  }
  return line
}

/** The VALARMs' lines in a task, as [start, end] index pairs (BEGIN and END lines). */
function alarmBlocks(comp: string[]): [number, number][] {
  const out: [number, number][] = []
  let at = -1
  for (let i = 1; i < comp.length - 1; i++) {
    if (comp[i] === 'BEGIN:VALARM') at = i
    else if (comp[i] === 'END:VALARM' && at >= 0) {
      out.push([at, i])
      at = -1
    }
  }
  return out
}

/** When the task's own reminders go off, from each VALARM's TRIGGER (absolute, or relative to DTSTART or DUE). */
function alarmTimes(comp: string[]): string[] {
  const start = getProp(comp, 'DTSTART')
  const due = getProp(comp, 'DUE')
  const at = (p: IcalProp | null) => (p ? icalTime(p.value, p.params) : null)
  const ms = (t: { iso: string; allDay: boolean } | null) => (t ? Date.parse(t.allDay ? `${t.iso}T00:00:00` : t.iso) : NaN)
  const out: string[] = []
  for (const [a, b] of alarmBlocks(comp)) {
    for (let i = a + 1; i < b; i++) {
      const p = parseLine(comp[i])
      if (p?.name !== 'TRIGGER') continue
      let when = NaN
      if (p.params.VALUE === 'DATE-TIME') when = ms(icalTime(p.value, {}))
      else {
        // Relative to the start by default; a task without one is measured from when it is due.
        const base = p.params.RELATED === 'END' ? at(due) : (at(start) ?? at(due))
        when = ms(base) + duration(p.value)
      }
      if (!Number.isNaN(when)) out.push(new Date(when).toISOString())
    }
  }
  return out
}

const isCompleted = (comp: string[]) => getProp(comp, 'STATUS')?.value.toUpperCase() === 'COMPLETED' || !!getProp(comp, 'COMPLETED')

/** A task as the browser sees it, from its VTODO. */
function readTask(comp: string[], list: TaskList, href: string): Task | null {
  const uid = getProp(comp, 'UID')?.value
  if (!uid || getProp(comp, 'STATUS')?.value.toUpperCase() === 'CANCELLED') return null
  const dueProp = getProp(comp, 'DUE')
  const due = dueProp ? icalTime(dueProp.value, dueProp.params) : null
  const completedProp = getProp(comp, 'COMPLETED')
  const parent = own(comp, 'RELATED-TO')
    .map((i) => parseLine(comp[i])!)
    .find((p) => !p.params.RELTYPE || p.params.RELTYPE.toUpperCase() === 'PARENT')
  const order = Number(getProp(comp, 'X-APPLE-SORT-ORDER')?.value)
  const created = getProp(comp, 'CREATED')
  const alarms = alarmTimes(comp)
  return {
    id: `${list.id}|${uid}`,
    list: list.id,
    uid,
    ref: encodeRef({ l: list.id, h: href }),
    title: icalText(getProp(comp, 'SUMMARY')?.value ?? '') || '(No title)',
    ...(getProp(comp, 'DESCRIPTION')?.value ? { notes: icalText(getProp(comp, 'DESCRIPTION')!.value) } : {}),
    ...(due ? { due: due.iso, allDay: due.allDay } : {}),
    priority: Math.min(9, Math.max(0, Number(getProp(comp, 'PRIORITY')?.value) || 0)),
    completed: isCompleted(comp),
    ...(completedProp ? { completedAt: icalTime(completedProp.value, completedProp.params)?.iso } : {}),
    ...(getProp(comp, 'URL')?.value ? { url: getProp(comp, 'URL')!.value } : {}),
    ...(parent ? { parent: parent.value } : {}),
    ...(Number.isFinite(order) && getProp(comp, 'X-APPLE-SORT-ORDER') ? { order } : {}),
    ...(getProp(comp, 'RRULE') ? { repeat: getProp(comp, 'RRULE')!.value } : {}),
    ...(alarms.length ? { alarms } : {}),
    ...(created ? { created: icalTime(created.value, created.params)?.iso } : {}),
  }
}

/** Moves a repeating task on to its next occurrence after the one due now; false when the rule has run out. */
function advance(comp: string[]): boolean {
  const rule = getProp(comp, 'RRULE')
  const anchorName = getProp(comp, 'DUE') ? 'DUE' : 'DTSTART'
  const anchor = getProp(comp, anchorName)
  if (!rule || !anchor) return false
  const now = icalTime(anchor.value, anchor.params)
  if (!now) return false
  const nowMs = Date.parse(now.allDay ? `${now.iso}T00:00:00Z` : now.iso)
  const raw = { props: { DTSTART: anchor, RRULE: rule }, exdates: own(comp, 'EXDATE').flatMap((i) => parseLine(comp[i])!.value.split(',')), attendees: [] }
  // Worked out in the task's own wall-clock time, as the calendar does for events (server/caldav.ts).
  const next = occurrences(raw, new Date(nowMs), new Date(nowMs + 3 * 366 * 864e5))
    .map((value) => ({ value, t: icalTime(value, anchor.params) }))
    .find(({ t }) => t && Date.parse(t.allDay ? `${t.iso}T00:00:00Z` : t.iso) > nowMs)
  if (!next?.t) return false
  const nextMs = Date.parse(next.t.allDay ? `${next.t.iso}T00:00:00Z` : next.t.iso)
  const moved = nextMs - nowMs
  const i = own(comp, anchorName)[0]
  comp[i] = withValue(comp[i], next.value)
  // DTSTART moves along by as much, and so do alarms at a fixed time; alarms come again.
  if (anchorName === 'DUE') {
    const start = getProp(comp, 'DTSTART')
    const s = start && icalTime(start.value, start.params)
    if (start && s) {
      const at = Date.parse(s.allDay ? `${s.iso}T00:00:00Z` : s.iso) + moved
      setProp(comp, 'DTSTART', [timeLine('DTSTART', s.allDay ? new Date(at).toISOString().slice(0, 10) : new Date(at).toISOString(), s.allDay, start)])
    }
  }
  for (const [a, b] of alarmBlocks(comp).reverse()) {
    for (let j = b - 1; j > a; j--) {
      const p = parseLine(comp[j])
      if (p?.name === 'ACKNOWLEDGED') comp.splice(j, 1)
      else if (p?.name === 'TRIGGER' && p.params.VALUE === 'DATE-TIME') {
        const t = icalTime(p.value, {})
        if (t) comp[j] = withValue(comp[j], davTime(new Date(Date.parse(t.iso) + moved)))
      }
    }
  }
  // A counted rule has one occurrence fewer left.
  const count = /(?:^|;)COUNT=(\d+)/.exec(rule.value)
  if (count) {
    const r = own(comp, 'RRULE')[0]
    comp[r] = withValue(comp[r], rule.value.replace(/(^|;)COUNT=\d+/, `$1COUNT=${Math.max(1, Number(count[1]) - 1)}`))
  }
  return true
}

const URL_OK = /^(https?:|mailto:|message:)/i
const RULE_PARTS = new Set(['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'BYSETPOS', 'WKST'])

/** Checks and tidies what the browser sent. */
function cleanInput(raw: unknown): TaskInput {
  if (!raw || typeof raw !== 'object') throw new HttpError(400, 'No task given')
  const r = raw as Record<string, unknown>
  const out: TaskInput = {}
  const text = (k: 'title' | 'notes', max: number) => {
    if (r[k] === undefined) return
    if (typeof r[k] !== 'string') throw new HttpError(400, `Bad ${k}`)
    out[k] = (r[k] as string).trim().slice(0, max)
  }
  text('title', 500)
  text('notes', 8000)
  if (r.due !== undefined) {
    if (r.due === null || r.due === '') out.due = null
    else if (typeof r.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.due)) Object.assign(out, { due: r.due, allDay: true })
    else if (typeof r.due === 'string' && !Number.isNaN(Date.parse(r.due))) Object.assign(out, { due: new Date(r.due).toISOString(), allDay: false })
    else throw new HttpError(400, 'Bad due date')
  }
  if (r.priority !== undefined) {
    const p = Number(r.priority)
    if (!Number.isInteger(p) || p < 0 || p > 9) throw new HttpError(400, 'Bad priority')
    out.priority = p
  }
  if (r.url !== undefined) {
    const u = typeof r.url === 'string' ? r.url.trim() : ''
    if (u && (!URL_OK.test(u) || u.length > 2000 || /[\s"<>]/.test(u))) throw new HttpError(400, 'A link starts with https://, mailto: or message:')
    out.url = u || null
  }
  if (r.parent !== undefined) {
    if (r.parent !== null && (typeof r.parent !== 'string' || !/^[^\x00-\x1f]{1,300}$/.test(r.parent))) throw new HttpError(400, 'Bad parent task')
    out.parent = (r.parent as string | null) || null
  }
  if (r.order !== undefined) {
    if (r.order !== null && (typeof r.order !== 'number' || !Number.isSafeInteger(r.order))) throw new HttpError(400, 'Bad order')
    out.order = r.order as number | null
  }
  if (r.repeat !== undefined) {
    if (r.repeat === null || r.repeat === '') out.repeat = null
    else {
      const rule = String(r.repeat).trim().replace(/^RRULE:/i, '').toUpperCase()
      const parts = rule.split(';').filter(Boolean).map((p) => p.split('='))
      if (!parts.length || parts.some((p) => p.length !== 2 || !RULE_PARTS.has(p[0]) || !/^[A-Z0-9,+-]+$/.test(p[1])) || !/(^|;)FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(;|$)/.test(rule))
        throw new HttpError(400, 'Not a repeat rule like FREQ=WEEKLY;BYDAY=MO')
      out.repeat = rule
    }
  }
  if (r.completed !== undefined) out.completed = r.completed === true
  if (typeof r.timeZone === 'string' && /^[\w+-]+(?:\/[\w+-]+)*$/.test(r.timeZone)) out.timeZone = r.timeZone
  return out
}

/** Makes the changes in the task's own text. Answers whether completing it moved it to its next occurrence. */
function applyInput(comp: string[], input: TaskInput): { advanced: boolean } {
  const text = (name: string, v: string | undefined) => v !== undefined && setProp(comp, name, v ? [`${name}:${esc(v)}`] : [])
  text('SUMMARY', input.title)
  text('DESCRIPTION', input.notes)
  if (input.due === null) {
    setProp(comp, 'DUE', [])
    setProp(comp, 'DTSTART', [])
  } else if (input.due !== undefined) {
    // Written like the due date it had, or a new timed one in the browser's zone.
    const old = getProp(comp, 'DUE')
    const like = old && old.params.VALUE !== 'DATE' && !/^\d{8}$/.test(old.value) ? old : input.timeZone ? { value: '', params: { TZID: input.timeZone } } : null
    setProp(comp, 'DUE', [timeLine('DUE', input.due, !!input.allDay, like)])
    // A start after the due date is not allowed; Apple keeps them the same.
    if (getProp(comp, 'DTSTART')) setProp(comp, 'DTSTART', [timeLine('DTSTART', input.due, !!input.allDay, like)])
  }
  if (input.priority !== undefined) setProp(comp, 'PRIORITY', input.priority ? [`PRIORITY:${input.priority}`] : [])
  if (input.url !== undefined) setProp(comp, 'URL', input.url ? [`URL:${input.url}`] : [])
  if (input.parent !== undefined) {
    // Only the parent link; links to siblings and children stay.
    const keep = own(comp, 'RELATED-TO')
      .map((i) => comp[i])
      .filter((l) => {
        const t = parseLine(l)!.params.RELTYPE
        return t && t.toUpperCase() !== 'PARENT'
      })
    setProp(comp, 'RELATED-TO', [...keep, ...(input.parent ? [`RELATED-TO;RELTYPE=PARENT:${input.parent}`] : [])])
  }
  if (input.order !== undefined) setProp(comp, 'X-APPLE-SORT-ORDER', input.order === null ? [] : [`X-APPLE-SORT-ORDER:${input.order}`])
  if (input.repeat !== undefined) setProp(comp, 'RRULE', input.repeat ? [`RRULE:${input.repeat}`] : [])
  let advanced = false
  if (input.completed === true && !isCompleted(comp)) {
    advanced = advance(comp)
    if (!advanced) {
      setProp(comp, 'STATUS', ['STATUS:COMPLETED'])
      setProp(comp, 'COMPLETED', [`COMPLETED:${davTime(new Date())}`])
      setProp(comp, 'PERCENT-COMPLETE', ['PERCENT-COMPLETE:100'])
    }
  } else if (input.completed === false && isCompleted(comp)) {
    setProp(comp, 'STATUS', ['STATUS:NEEDS-ACTION'])
    setProp(comp, 'COMPLETED', [])
    setProp(comp, 'PERCENT-COMPLETE', [])
  }
  const sequence = Number(getProp(comp, 'SEQUENCE')?.value ?? 0)
  setProp(comp, 'SEQUENCE', [`SEQUENCE:${Number.isFinite(sequence) ? sequence + 1 : 1}`])
  const now = davTime(new Date())
  setProp(comp, 'DTSTAMP', [`DTSTAMP:${now}`])
  setProp(comp, 'LAST-MODIFIED', [`LAST-MODIFIED:${now}`])
  return { advanced }
}

function newTaskText(uid: string, input: TaskInput): Ics {
  const comp = ['BEGIN:VTODO', `UID:${uid}`, `CREATED:${davTime(new Date())}`, 'STATUS:NEEDS-ACTION', 'END:VTODO']
  applyInput(comp, { ...input, completed: undefined })
  setProp(comp, 'SEQUENCE', ['SEQUENCE:0'])
  if (input.completed) applyInput(comp, { completed: true })
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//mvlos//Tasks//EN', 'CALSCALE:GREGORIAN', comp, 'END:VCALENDAR']
}

// ---------------------------------------------------------------------------------------------
// Where tasks live: a CalDAV collection, or a list on this site. Each object is one task's text.

type Obj = { href: string; etag: string | null; text: string }
type Store = {
  list: TaskList
  objects: () => Promise<Obj[]>
  get: (href: string) => Promise<Obj>
  /** Writes an object: `etag` it must still have, or 'new' for one that must not exist yet. Answers the new ETag, when known. */
  put: (href: string, text: string, etag: string | null | 'new') => Promise<string | null>
  remove: (href: string) => Promise<void>
  /** Where a new task goes. */
  hrefFor: (uid: string) => string
}

/** The browser's handle on a task: its list and object. */
type Ref = { l: string; h: string }
const encodeRef = (r: Ref) => Buffer.from(JSON.stringify(r)).toString('base64url')
function decodeRef(raw: unknown): Ref {
  try {
    const r = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8')) as Ref
    if (typeof r.l === 'string' && typeof r.h === 'string') return r
  } catch {
    /* below */
  }
  throw new HttpError(400, 'Unknown task')
}

class Conflict extends HttpError {
  constructor() {
    super(409, 'It changed somewhere else meanwhile; try again')
  }
}

// --- On this site

const localId = (id: number) => `local:${id}`

function localLists(user: User): TaskList[] {
  const rows = database().prepare('SELECT id, name, color FROM task_lists WHERE user_id = ? ORDER BY id').all(user.id) as { id: number; name: string; color: string }[]
  return rows.map((r) => ({ id: localId(r.id), name: r.name, color: r.color, source: LOCAL_SOURCE, writable: true, local: true }))
}

function localStore(user: User, list: TaskList): Store {
  const listId = Number(list.id.slice('local:'.length))
  const db = database()
  return {
    list,
    objects: async () => (db.prepare('SELECT uid, ics, etag FROM task_items WHERE list_id = ?').all(listId) as { uid: string; ics: string; etag: number }[]).map((r) => ({ href: r.uid, etag: String(r.etag), text: r.ics })),
    async get(href) {
      const r = db.prepare('SELECT ics, etag FROM task_items WHERE list_id = ? AND uid = ?').get(listId, href) as { ics: string; etag: number } | undefined
      if (!r) throw new HttpError(404, 'That task is gone')
      return { href, etag: String(r.etag), text: r.ics }
    },
    async put(href, text, etag) {
      if (Buffer.byteLength(text) > MAX_TASK_BYTES) throw new HttpError(413, 'That task is too big')
      const r = db.prepare('SELECT etag, LENGTH(ics) AS n FROM task_items WHERE list_id = ? AND uid = ?').get(listId, href) as { etag: number; n: number } | undefined
      if (etag === 'new') {
        if (r) throw new Conflict()
        const { n } = db.prepare('SELECT COUNT(*) AS n FROM task_items i JOIN task_lists l ON l.id = i.list_id WHERE l.user_id = ?').get(user.id) as { n: number }
        if (n >= MAX_LOCAL_TASKS) throw new HttpError(400, `Lists on this site hold up to ${MAX_LOCAL_TASKS} tasks: delete some completed ones first`)
        checkRoom(user, text.length)
        db.prepare('INSERT INTO task_items (list_id, uid, ics, etag, updated_at) VALUES (?, ?, ?, 1, ?)').run(listId, href, text, Date.now())
        return '1'
      }
      if (!r) throw new HttpError(404, 'That task is gone')
      if (etag && String(r.etag) !== etag) throw new Conflict()
      checkRoom(user, text.length - r.n)
      db.prepare('UPDATE task_items SET ics = ?, etag = etag + 1, updated_at = ? WHERE list_id = ? AND uid = ?').run(text, Date.now(), listId, href)
      return String(r.etag + 1)
    },
    async remove(href) {
      db.prepare('DELETE FROM task_items WHERE list_id = ? AND uid = ?').run(listId, href)
    },
    hrefFor: (uid) => uid,
  }
}

// --- CalDAV

/** A CalDAV task list: the collection, with what it allows. */
type DavList = TaskList & { account: number; href: string }

const D = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/"'

async function discoverLists(account: CaldavAccount): Promise<DavList[]> {
  const home = await calendarHome(account)
  const xml = await dav(account, 'PROPFIND', home, '1', `<d:propfind ${D}><d:prop><d:resourcetype/><d:displayname/><a:calendar-color/><c:supported-calendar-component-set/><d:current-user-privilege-set/></d:prop></d:propfind>`)
  return responses(xml)
    .filter((r) => /<(?:[\w-]+:)?calendar\b/.test(prop(r.body, 'resourcetype') ?? ''))
    .flatMap((r) => {
      const comps = prop(r.body, 'supported-calendar-component-set')
      if (comps && !/name="VTODO"/i.test(comps)) return []
      const color = (prop(r.body, 'calendar-color') ?? '').trim()
      const privileges = prop(r.body, 'current-user-privilege-set')
      const href = resolveHref(home, r.href)
      return [
        {
          id: `caldav:${account.id}:${href}`,
          account: account.id,
          href,
          name: unescapeXml(prop(r.body, 'displayname')?.trim() || decodeURIComponent(r.href.split('/').filter(Boolean).pop() ?? 'Tasks')),
          color: /^#[0-9a-f]{6}/i.test(color) ? color.slice(0, 7) : '#e0af68',
          source: account.label,
          writable: !privileges || /<(?:[\w-]+:)?(?:write|write-content|all)\b/.test(privileges),
          local: false,
          ...(!comps || /name="VEVENT"/i.test(comps) ? { calendar: true } : {}),
        },
      ]
    })
}

function refused(res: Response, url: string): never {
  const host = new URL(url).host
  if (res.status === 401 || res.status === 403) throw new HttpError(403, `${host} refused the change; an app password that can write is needed (Settings → Calendar, add the account again)`)
  if (res.status === 404 || res.status === 410) throw new HttpError(404, 'That task is gone from the list')
  if (res.status === 412) throw new Conflict()
  throw new HttpError(502, `${host} answered ${res.status}`)
}

function davStore(account: CaldavAccount, list: DavList): Store {
  const base = new URL(list.href)
  const dir = list.href.endsWith('/') ? list.href : `${list.href}/`
  /** An object's address, only if it is inside this list (refs come back from the browser). */
  const inside = (href: string) => {
    const url = new URL(href, base)
    if (url.origin !== base.origin || !url.pathname.startsWith(new URL(dir).pathname)) throw new HttpError(400, 'That task is not in that list')
    return url.href
  }
  return {
    list,
    async objects() {
      const xml = await dav(
        account,
        'REPORT',
        list.href,
        '1',
        `<c:calendar-query ${D}><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VTODO"/></c:comp-filter></c:filter></c:calendar-query>`,
      )
      return responses(xml)
        .map((r) => ({ href: resolveHref(list.href, r.href), etag: unescapeXml(prop(r.body, 'getetag')?.trim() ?? '') || null, text: unescapeXml(prop(r.body, 'calendar-data') ?? '') }))
        .filter((o) => o.text.includes('BEGIN:VTODO'))
    },
    async get(href) {
      const url = inside(href)
      const res = await davRequest(account, 'GET', url, { headers: { Accept: 'text/calendar' } })
      if (!res.ok) refused(res, url)
      return { href: url, etag: res.headers.get('etag'), text: (await readCapped(res, 4 * 1024 * 1024)).toString('utf8') }
    },
    async put(href, text, etag) {
      const url = inside(href)
      const headers: Record<string, string> = { 'Content-Type': 'text/calendar; charset=utf-8' }
      if (etag === 'new') headers['If-None-Match'] = '*'
      else if (etag) headers['If-Match'] = etag
      const res = await davRequest(account, 'PUT', url, { headers, body: text })
      if (!res.ok) refused(res, url)
      return res.headers.get('etag')
    },
    async remove(href) {
      const url = inside(href)
      const res = await davRequest(account, 'DELETE', url)
      if (!res.ok && res.status !== 404) refused(res, url)
    },
    hrefFor: (uid) => `${dir}${encodeURIComponent(uid)}.ics`,
  }
}

// ---------------------------------------------------------------------------------------------
// Lists and tasks, cached like the calendars: lists for ten minutes, tasks for two.

const cache = new Map<string, { at: number; value: Promise<unknown> }>()
function cached<T>(key: string, ms: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < ms) return hit.value as Promise<T>
  const value = load()
  cache.set(key, { at: Date.now(), value })
  value.catch(() => cache.delete(key))
  return value
}
const forget = (userId: number, what = '') => {
  for (const k of cache.keys()) if (k.startsWith(`${userId}|${what}`)) cache.delete(k)
  upcoming.delete(userId)
}
onUserGone((id) => forget(id))

/** Every store of the account: its lists on this site and in each CalDAV account, and what went wrong per account. */
async function stores(user: User): Promise<{ stores: Store[]; errors: string[] }> {
  const errors: string[] = []
  // Someone with no lists anywhere yet gets one here, to start with.
  if (!localLists(user).length && !listCaldav(user).length) createLocalList(user, 'Reminders', '#7aa2f7')
  const local = localLists(user).map((l) => localStore(user, l))
  const dav = await Promise.all(
    caldavAccounts(user).map((a) =>
      cached(`${user.id}|lists|${a.id}`, 10 * 60_000, () => discoverLists(a))
        .then((lists) => lists.map((l) => davStore(a, l)))
        .catch((e: Error) => (errors.push(`${a.label}: ${e.message}`), [] as Store[])),
    ),
  )
  return { stores: [...local, ...dav.flat()], errors }
}

async function storeFor(user: User, listId: string): Promise<Store> {
  const store = (await stores(user)).stores.find((s) => s.list.id === listId)
  if (!store) throw new HttpError(404, 'That list is not connected')
  return store
}

/** The tasks in a list (completed ones only the newest few hundred). */
async function tasksOf(user: User, store: Store): Promise<Task[]> {
  const load = async () => {
    const tasks = (await store.objects()).flatMap((o) => {
      const comp = masterOf(parseIcs(o.text))
      const t = comp && readTask(comp, store.list, o.href)
      return t ? [t] : []
    })
    const done = tasks.filter((t) => t.completed).sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))
    return [...tasks.filter((t) => !t.completed), ...done.slice(0, MAX_COMPLETED)]
  }
  return store.list.local ? load() : cached(`${user.id}|tasks|${store.list.id}`, 2 * 60_000, load)
}

/** Every list and task of the account, and per-source problems. */
export async function allTasks(user: User): Promise<{ lists: TaskList[]; tasks: Task[]; errors: string[] }> {
  const { stores: all, errors } = await stores(user)
  const lists = await Promise.all(all.map((s) => tasksOf(user, s).catch((e: Error) => (errors.push(`${s.list.name}: ${e.message}`), [] as Task[]))))
  const pub = ({ id, name, color, source, writable, local, calendar }: TaskList): TaskList => ({ id, name, color, source, writable, local, ...(calendar ? { calendar } : {}) })
  return { lists: all.map((s) => pub(s.list)), tasks: lists.flat(), errors: [...new Set(errors)] }
}

// ---------------------------------------------------------------------------------------------
// Changes

/** Reads a task's object, changes it and writes it back with its ETag; once more on a conflict, from the new text. */
async function change(store: Store, href: string, uid: string | null, edit: (comp: string[], ics: Ics) => void): Promise<{ comp: string[]; href: string }> {
  for (let attempt = 0; ; attempt++) {
    const obj = await store.get(href)
    const ics = parseIcs(obj.text)
    const comp = uid ? ics.find((x): x is string[] => Array.isArray(x) && getProp(x, 'UID')?.value === uid && !getProp(x, 'RECURRENCE-ID')) : masterOf(ics)
    if (!comp) throw new HttpError(404, 'That task is gone')
    edit(comp, ics)
    try {
      await store.put(obj.href, printIcs(ics), obj.etag)
      return { comp, href: obj.href }
    } catch (e) {
      if (!(e instanceof Conflict) || attempt > 0) throw e
    }
  }
}

function changed(user: User, store?: Store) {
  forget(user.id, store ? `tasks|${store.list.id}` : 'tasks|')
  // The Tasks and Calendar apps and the Agenda widget, in every open page.
  tellPages(user.id, 'calendar')
}

async function defaultStore(user: User, listId: unknown): Promise<Store> {
  if (typeof listId === 'string' && listId) return storeFor(user, listId)
  const prefs = taskPrefsOf(user)
  const all = (await stores(user)).stores.filter((s) => s.list.writable)
  const store = all.find((s) => s.list.id === prefs.defaultList) ?? all.find((s) => !s.list.local) ?? all[0]
  if (!store) throw new HttpError(400, 'Make a list first')
  return store
}

export async function createTask(user: User, body: { list?: unknown; task?: unknown }): Promise<Task> {
  const input = cleanInput(body.task)
  if (!input.title) throw new HttpError(400, 'A task needs a title')
  const store = await defaultStore(user, body.list)
  const uid = randomUUID().toUpperCase()
  const ics = newTaskText(uid, input)
  const href = store.hrefFor(uid)
  try {
    await store.put(href, printIcs(ics), 'new')
  } finally {
    changed(user, store)
  }
  return readTask(masterOf(ics)!, store.list, store.list.local ? href : new URL(href).href)!
}

/** The subtasks of a task in the same list, by its UID (they move and go with it). */
async function childrenOf(user: User, store: Store, uid: string): Promise<Task[]> {
  const all = await tasksOf(user, store)
  const out: Task[] = []
  const walk = (p: string) => all.filter((t) => t.parent === p && !out.includes(t)).forEach((t) => (out.push(t), walk(t.uid)))
  walk(uid)
  return out
}

export async function updateTask(user: User, body: { ref?: unknown; task?: unknown; list?: unknown }): Promise<{ task: Task; advanced: boolean }> {
  const ref = decodeRef(body.ref)
  const input = cleanInput(body.task ?? {})
  const store = await storeFor(user, ref.l)
  try {
    let advanced = false
    const { comp, href } = await change(store, ref.h, null, (c) => (advanced = applyInput(c, input).advanced))
    let task = readTask(comp, store.list, href)!
    if (typeof body.list === 'string' && body.list !== ref.l) task = await moveTask(user, store, task, await storeFor(user, body.list))
    return { task, advanced }
  } finally {
    changed(user)
  }
}

/** Moves a task's object, with its subtasks, to another list (on any account, or this site). */
async function moveTask(user: User, from: Store, task: Task, to: Store): Promise<Task> {
  if (!to.list.writable) throw new HttpError(403, 'That list is read-only')
  const children = await childrenOf(user, from, task.uid)
  let moved = task
  for (const t of [task, ...children]) {
    const href = decodeRef(t.ref).h
    const obj = await from.get(href)
    const target = to.hrefFor(t.uid)
    await to.put(target, obj.text, 'new')
    await from.remove(href)
    if (t === task) moved = readTask(masterOf(parseIcs(obj.text))!, to.list, to.list.local ? target : new URL(target).href)!
  }
  return moved
}

export async function deleteTask(user: User, body: { ref?: unknown }) {
  const ref = decodeRef(body.ref)
  const store = await storeFor(user, ref.l)
  try {
    const obj = await store.get(ref.h)
    const uid = getProp(masterOf(parseIcs(obj.text)) ?? [], 'UID')?.value
    // Its subtasks go with it, as in Apple's Reminders.
    for (const t of uid ? await childrenOf(user, store, uid) : []) await store.remove(decodeRef(t.ref).h)
    await store.remove(obj.href)
  } finally {
    changed(user)
  }
}

/**
 * A task dragged to another place in its list: `order` is the list's tasks in their new order. The
 * moved one gets an X-APPLE-SORT-ORDER between its neighbours'; when there is no room (or the
 * neighbours have none yet), the list is numbered again, writing only the tasks whose number changes.
 */
export async function orderTasks(user: User, body: { list?: unknown; refs?: unknown; moved?: unknown }) {
  if (typeof body.list !== 'string' || !Array.isArray(body.refs) || body.refs.length > 1000) throw new HttpError(400, 'Bad order')
  const store = await storeFor(user, body.list)
  const tasks = await tasksOf(user, store)
  const byRef = new Map(tasks.map((t) => [t.ref, t]))
  const seq = body.refs.map((r) => byRef.get(String(r))).filter((t): t is Task => !!t)
  const at = seq.findIndex((t) => t.ref === body.moved)
  if (at < 0) throw new HttpError(400, 'Bad order')
  const before = seq[at - 1]?.order
  const after = seq[at + 1]?.order
  const wanted = new Map<Task, number>()
  const okBefore = at === 0 || before !== undefined
  const okAfter = at === seq.length - 1 || after !== undefined
  const lo = before ?? (after !== undefined ? after - 2048 : 0)
  const hi = after ?? lo + 2048
  if (okBefore && okAfter && hi - lo >= 2) wanted.set(seq[at], Math.floor((lo + hi) / 2))
  else seq.forEach((t, i) => t.order !== (i + 1) * 1024 && wanted.set(t, (i + 1) * 1024))
  try {
    for (const [t, order] of wanted) await change(store, decodeRef(t.ref).h, null, (c) => applyInput(c, { order }))
  } finally {
    changed(user, store)
  }
  return { changed: wanted.size }
}

// --- Lists

const COLOR = /^#[0-9a-f]{6}$/i

function createLocalList(user: User, name: string, color: string): TaskList {
  const { n } = database().prepare('SELECT COUNT(*) AS n FROM task_lists WHERE user_id = ?').get(user.id) as { n: number }
  if (n >= MAX_LOCAL_LISTS) throw new HttpError(400, `Up to ${MAX_LOCAL_LISTS} lists on this site`)
  const r = database().prepare('INSERT INTO task_lists (user_id, name, color, created_at) VALUES (?, ?, ?, ?)').run(user.id, name, color, Date.now())
  return { id: localId(Number(r.lastInsertRowid)), name, color, source: LOCAL_SOURCE, writable: true, local: true }
}

const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** A new list: on this site (`account` "local"), or a new collection for tasks in a CalDAV account (MKCALENDAR). */
export async function createList(user: User, body: { name?: unknown; color?: unknown; account?: unknown }): Promise<TaskList> {
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : ''
  if (!name) throw new HttpError(400, 'A list needs a name')
  const color = typeof body.color === 'string' && COLOR.test(body.color) ? body.color : '#7aa2f7'
  try {
    if (body.account === 'local' || body.account === undefined) return createLocalList(user, name, color)
    const account = caldavAccounts(user).find((a) => a.id === Number(body.account))
    if (!account) throw new HttpError(404, 'That account is not connected')
    const home = await calendarHome(account)
    const href = `${home.endsWith('/') ? home : `${home}/`}${randomUUID()}/`
    const res = await davRequest(account, 'MKCALENDAR', href, {
      headers: { 'Content-Type': 'application/xml; charset=utf-8' },
      body: `<?xml version="1.0" encoding="utf-8"?><c:mkcalendar ${D}><d:set><d:prop><d:displayname>${xmlEsc(name)}</d:displayname><a:calendar-color>${color}</a:calendar-color><c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set></d:prop></d:set></c:mkcalendar>`,
    })
    if (res.status === 403 || res.status === 405 || res.status === 501 || res.status === 415) throw new HttpError(400, `${account.label} doesn't let lists be made from here; make it in its own app`)
    if (!res.ok) refused(res, href)
    return { id: `caldav:${account.id}:${href}`, name, color, source: account.label, writable: true, local: false }
  } finally {
    forget(user.id)
    tellPages(user.id, 'calendar')
  }
}

export async function updateList(user: User, body: { id?: unknown; name?: unknown; color?: unknown }) {
  const store = await storeFor(user, String(body.id ?? ''))
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : undefined
  const color = typeof body.color === 'string' && COLOR.test(body.color) ? body.color : undefined
  if (name === '') throw new HttpError(400, 'A list needs a name')
  try {
    if (store.list.local) {
      const id = Number(store.list.id.slice('local:'.length))
      database().prepare('UPDATE task_lists SET name = COALESCE(?, name), color = COALESCE(?, color) WHERE id = ? AND user_id = ?').run(name ?? null, color ?? null, id, user.id)
      return
    }
    const list = store.list as DavList
    const account = caldavAccounts(user).find((a) => a.id === list.account)!
    const res = await davRequest(account, 'PROPPATCH', list.href, {
      headers: { 'Content-Type': 'application/xml; charset=utf-8' },
      body: `<?xml version="1.0" encoding="utf-8"?><d:propertyupdate ${D}><d:set><d:prop>${name ? `<d:displayname>${xmlEsc(name)}</d:displayname>` : ''}${color ? `<a:calendar-color>${color}</a:calendar-color>` : ''}</d:prop></d:set></d:propertyupdate>`,
    })
    if (!res.ok && res.status !== 207) refused(res, list.href)
  } finally {
    forget(user.id)
    tellPages(user.id, 'calendar')
  }
}

export async function deleteList(user: User, body: { id?: unknown }) {
  const store = await storeFor(user, String(body.id ?? ''))
  try {
    if (store.list.local) {
      database().prepare('DELETE FROM task_lists WHERE id = ? AND user_id = ?').run(Number(store.list.id.slice('local:'.length)), user.id)
      return
    }
    // A collection that holds events too is a calendar: never deleted from the Tasks app.
    if (store.list.calendar) throw new HttpError(400, `"${store.list.name}" is also a calendar; delete it in ${store.list.source} itself`)
    const list = store.list as DavList
    const account = caldavAccounts(user).find((a) => a.id === list.account)!
    const res = await davRequest(account, 'DELETE', list.href)
    if (!res.ok && res.status !== 404) refused(res, list.href)
  } finally {
    forget(user.id)
    tellPages(user.id, 'calendar')
  }
}

// ---------------------------------------------------------------------------------------------
// Reminders

export const taskPrefsOf = (user: User): TaskPrefs => normalizeTaskPrefs(readState(user).tasks?.value)

/** How late a reminder still comes (the server was restarting when it was due). */
const GRACE_MS = 60 * 60_000

/** When a task's reminders go off: its own alarms, or the default from the settings. */
export function reminderTimes(task: Pick<Task, 'due' | 'allDay' | 'alarms' | 'completed'>, prefs: TaskPrefs): number[] {
  if (task.completed) return []
  if (task.alarms?.length) return task.alarms.map((a) => Date.parse(a))
  if (!task.due || !prefs.remind) return []
  if (!task.allDay) return [Date.parse(task.due) - prefs.lead * 60_000]
  // The morning of the day it is due, in the user's zone.
  const at = icalTime(`${task.due.replace(/-/g, '')}T${prefs.morning.replace(':', '')}00`, prefs.timeZone ? { TZID: prefs.timeZone } : {})
  return at ? [Date.parse(at.iso)] : []
}

/** The reminders due now for these tasks, each sent once (its `once` key names the task, due date and time). */
export function dueNotices(tasks: Task[], lists: TaskList[], now: number, prefs: TaskPrefs): Notice[] {
  const names = new Map(lists.map((l) => [l.id, l.name]))
  const zone = prefs.timeZone ?? undefined
  const out: Notice[] = []
  for (const t of tasks) {
    for (const at of reminderTimes(t, prefs)) {
      if (Number.isNaN(at) || now < at || now - at > GRACE_MS) continue
      let when = ''
      if (t.due && t.allDay) when = t.due === new Date(now).toLocaleDateString('en-CA', { timeZone: zone }) ? 'Due today' : `Due ${new Date(`${t.due}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' })}`
      else if (t.due) {
        const mins = Math.round((Date.parse(t.due) - now) / 60_000)
        when = mins > 0 ? `Due in ${mins} minute${mins === 1 ? '' : 's'}` : `Due ${new Date(t.due).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: zone })}`
      }
      out.push({
        source: 'tasks.due',
        title: t.title,
        body: [when, names.get(t.list)].filter(Boolean).join(' · '),
        action: { app: 'tasks', props: { task: t.id } },
        once: `tasks:${t.id}:${t.due ?? ''}:${new Date(at).toISOString()}`,
        tag: `task-${t.id}`,
      })
    }
  }
  return out
}

/** Each account's tasks, read again every five minutes (or after a change made here). */
const upcoming = new Map<number, { at: number; tasks: Task[]; lists: TaskList[] }>()
const REFRESH_MS = 5 * 60_000

/** The watcher (every minute): due tasks of every account that has any, through the notification hub. */
export async function taskReminders(now = Date.now()) {
  for (const u of allAccounts()) {
    if (!allows(normalizePrefs(readState(u).notify?.value), 'tasks.due')) continue
    const hasLocal = (database().prepare('SELECT 1 FROM task_lists WHERE user_id = ? LIMIT 1').get(u.id) as unknown) !== undefined
    if (!hasLocal && !listCaldav(u).length) continue
    let c = upcoming.get(u.id)
    if (!c || now - c.at > REFRESH_MS) {
      const all = await allTasks(u).catch(() => null)
      c = { at: now, tasks: all?.tasks ?? c?.tasks ?? [], lists: all?.lists ?? c?.lists ?? [] }
      upcoming.set(u.id, c)
    }
    for (const n of dueNotices(c.tasks, c.lists, now, taskPrefsOf(u))) notify(u, n)
  }
}

// ---------------------------------------------------------------------------------------------
// Routes: /api/tasks (server/api.ts hands them here)

export async function handleTasksApi(req: IncomingMessage, res: ServerResponse, url: URL, method: string, user: User): Promise<boolean> {
  const path = url.pathname
  if (path === '/api/tasks') {
    if (method === 'GET') {
      if (url.searchParams.has('fresh')) forget(user.id)
      return json(res, 200, await allTasks(user)), true
    }
    // { list?, task } to add, { ref, task, list? } to change (list: move it there), { ref } to delete.
    if (method === 'POST') return json(res, 200, { task: await createTask(user, await readJson(req, 64 * 1024)) }), true
    if (method === 'PATCH') return json(res, 200, await updateTask(user, await readJson(req, 64 * 1024))), true
    if (method === 'DELETE') return await deleteTask(user, await readJson(req, 8 * 1024)), json(res, 200, { ok: true }), true
  }
  if (path === '/api/tasks/order' && method === 'PUT') return json(res, 200, await orderTasks(user, await readJson(req, 256 * 1024))), true
  if (path === '/api/tasks/lists') {
    if (method === 'POST') return json(res, 200, { list: await createList(user, await readJson(req, 8 * 1024)) }), true
    if (method === 'PATCH') return await updateList(user, await readJson(req, 8 * 1024)), json(res, 200, { ok: true }), true
    if (method === 'DELETE') return await deleteList(user, await readJson(req, 8 * 1024)), json(res, 200, { ok: true }), true
  }
  return false
}
