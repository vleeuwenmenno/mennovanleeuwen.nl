import { useEffect, useSyncExternalStore } from 'react'
import { api, getAccount, subscribeAccount } from '../os/account'
import { synced } from '../os/synced'
import { useCalendarVersion } from './calendar'
import { DEFAULT_TASK_PREFS, normalizeTaskPrefs, type TaskPrefs } from './taskPrefs'

// Tasks for the browser (server/tasks.ts keeps them in the CalDAV accounts' task lists and in lists
// on this site): the Tasks app, the Calendar app and the Agenda widget read them through here and
// change them. One copy for the whole page, fetched again after every change, when the server's live
// stream says something changed (another device, src/os/notifyStream.ts's "calendar"), and every
// few minutes while something shows tasks.
//
// For other apps (Mail's "Make a task from this email", say):
//
//   import { createTask, openTask } from '../data/tasks'
//   const task = await createTask({ title: 'Reply to Anna', notes: 'About the invoice', due: '2026-10-14', url: 'https://…' })
//   openTask(task.id)
//
// `due` is a day ("2026-10-14", all day) or an ISO time; `listId` picks the list, otherwise the one
// chosen in the Tasks app's settings (or the first CalDAV list). createTask throws with the server's
// message when it can't (signed out, no list that can be written). openTask opens the Tasks app with
// that task's details.

export type TaskList = {
  id: string
  name: string
  color: string
  /** The account it lives in ("Fastmail"), or "On this site" */
  source: string
  writable: boolean
  local: boolean
  /** A CalDAV collection that holds events too: a calendar, so it is not deleted from here */
  calendar?: boolean
}

export type Task = {
  /** "<list id>|<UID>" */
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
  /** The UID of the task it is a subtask of. */
  parent?: string
  /** Manual order in its list (Apple's X-APPLE-SORT-ORDER), lowest first. */
  order?: number
  /** How it repeats: an RRULE's value (FREQ=WEEKLY;BYDAY=MO). */
  repeat?: string
  /** When its own reminders go off. */
  alarms?: string[]
  created?: string
}

/** What a new task or a change says: only the fields given change; null removes one. */
export type TaskPatch = {
  title?: string
  notes?: string
  due?: string | null
  priority?: number
  url?: string | null
  parent?: string | null
  repeat?: string | null
  completed?: boolean
}

export type TasksState = { lists: TaskList[] | null; tasks: Task[]; errors: string[]; loading: boolean }

// ---------------------------------------------------------------------------------------------
// Settings (synced state "tasks"; the server reads them for reminders)

export const taskPrefs = synced<TaskPrefs>('tasks', DEFAULT_TASK_PREFS, { normalize: normalizeTaskPrefs })
export const useTaskPrefs = taskPrefs.use
export const setTaskPrefs = (patch: Partial<TaskPrefs>) => taskPrefs.set((p) => ({ ...p, ...patch }))

/** Tells the server this browser's zone, for reminders in the morning of an all-day task. */
export function keepTimeZone() {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  if (zone && taskPrefs.get().timeZone !== zone) setTaskPrefs({ timeZone: zone })
}

// ---------------------------------------------------------------------------------------------
// The page's copy

let state: TasksState = { lists: null, tasks: [], errors: [], loading: false }
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())
const set = (next: Partial<TasksState>) => {
  state = { ...state, ...next }
  emit()
}

let loadedAt = 0
let inFlight: Promise<void> | null = null
let again = false
const STALE_MS = 2 * 60_000

/** Fetches the lists and tasks (`fresh`: past the server's cache of the CalDAV servers too). */
export function reloadTasks(fresh = false): Promise<void> {
  if (getAccount().status !== 'user') {
    set({ lists: null, tasks: [], errors: [], loading: false })
    return Promise.resolve()
  }
  // One at a time; a change made while one is out asks once more after it.
  if (inFlight) {
    again = true
    return inFlight
  }
  set({ loading: true })
  inFlight = api<{ lists: TaskList[]; tasks: Task[]; errors: string[] }>(`/api/tasks${fresh ? '?fresh=1' : ''}`)
    .then(
      (r) => set({ lists: r.lists, tasks: r.tasks, errors: r.errors }),
      (e: Error) => set({ lists: state.lists ?? [], errors: [e.message] }),
    )
    .finally(() => {
      loadedAt = Date.now()
      inFlight = null
      set({ loading: false })
      if (again) {
        again = false
        void reloadTasks()
      }
    })
  return inFlight
}

subscribeAccount(() => {
  // Signed out (or in as someone else): nothing of the last account's stays.
  if (getAccount().status !== 'user') set({ lists: null, tasks: [], errors: [] })
  else if (state.lists === null && listeners.size) void reloadTasks()
})

/** Every list and task (lists null while the first load is out). Loads on first use and keeps up. */
export function useTasks(): TasksState {
  const snapshot = useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => state,
  )
  // Something changed elsewhere (the server's live stream): fetch again, unless we just did.
  const version = useCalendarVersion()
  useEffect(() => {
    if (Date.now() - loadedAt > 1500 || state.lists === null) void reloadTasks()
  }, [version])
  // Every five minutes, and when the tab comes back after a while.
  useEffect(() => {
    const tick = () => document.visibilityState === 'visible' && Date.now() - loadedAt > STALE_MS && void reloadTasks()
    const t = setInterval(tick, 5 * 60_000)
    document.addEventListener('visibilitychange', tick)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [])
  return snapshot
}

// ---------------------------------------------------------------------------------------------
// Changes. Each shows at once (optimistic), then the server's answer replaces it.

const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone

function patchLocal(id: string, patch: Partial<Task> | null) {
  set({ tasks: patch ? state.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)) : state.tasks.filter((t) => t.id !== id) })
}

async function settle<T>(work: Promise<T>): Promise<T> {
  try {
    return await work
  } finally {
    // Also after a failure: what is there may have changed.
    void reloadTasks()
  }
}

/** Makes a task; answers it as the server wrote it. */
export async function createTask(input: TaskPatch & { title: string; listId?: string }): Promise<Task> {
  const { listId, ...task } = input
  const r = await settle(api<{ task: Task }>('/api/tasks', { method: 'POST', json: { list: listId, task: { ...task, timeZone: timeZone() } } }))
  set({ tasks: [...state.tasks.filter((t) => t.id !== r.task.id), r.task] })
  return r.task
}

/** Changes a task; `list` moves it (with its subtasks) to another list. `advanced`: completing a repeating one moved it to its next date. */
export async function updateTask(task: Task, patch: TaskPatch, list?: string): Promise<{ task: Task; advanced: boolean }> {
  const { completed: _, ...shown } = patch
  patchLocal(task.id, { ...(shown as Partial<Task>), ...(patch.completed !== undefined && !task.repeat ? { completed: patch.completed } : {}) })
  const r = await settle(api<{ task: Task; advanced: boolean }>('/api/tasks', { method: 'PATCH', json: { ref: task.ref, task: { ...patch, timeZone: timeZone() }, list } }))
  set({ tasks: state.tasks.filter((t) => t.id !== task.id && t.id !== r.task.id).concat(r.task) })
  return r
}

export const completeTask = (task: Task, done = true) => updateTask(task, { completed: done })

export async function deleteTask(task: Task) {
  patchLocal(task.id, null)
  await settle(api('/api/tasks', { method: 'DELETE', json: { ref: task.ref } }))
}

/** A task dragged to a new place: `ordered` is its list's (top-level) tasks in their new order. */
export async function reorderTasks(listId: string, ordered: Task[], moved: Task) {
  // Shown in the new order at once: orders counting up from the first one's.
  const at = new Map(ordered.map((t, i) => [t.id, i]))
  set({ tasks: state.tasks.map((t) => (at.has(t.id) ? { ...t, order: -1e9 + at.get(t.id)! } : t)) })
  await settle(api('/api/tasks/order', { method: 'PUT', json: { list: listId, refs: ordered.map((t) => t.ref), moved: moved.ref } }))
}

/** A new list: on this site ("local"), or in a CalDAV account (its id). */
export async function createList(input: { name: string; color: string; account: number | 'local' }): Promise<TaskList> {
  const r = await settle(api<{ list: TaskList }>('/api/tasks/lists', { method: 'POST', json: input }))
  return r.list
}

export const updateList = (list: TaskList, patch: { name?: string; color?: string }) => settle(api('/api/tasks/lists', { method: 'PATCH', json: { id: list.id, ...patch } }))

export async function deleteList(list: TaskList) {
  set({ lists: state.lists?.filter((l) => l.id !== list.id) ?? null, tasks: state.tasks.filter((t) => t.list !== list.id) })
  await settle(api('/api/tasks/lists', { method: 'DELETE', json: { id: list.id } }))
}

/** Opens the Tasks app on this task ("<list id>|<UID>"), with its details. */
export function openTask(id: string) {
  window.dispatchEvent(new CustomEvent('mvlos:open', { detail: { app: 'tasks', props: { task: id, t: String(Date.now()) } } }))
}

// ---------------------------------------------------------------------------------------------
// Dates

/** "2026-10-12" for a local date. */
export const dayKeyOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** The local day a task is due ("YYYY-MM-DD"), or null. */
export const dueDay = (t: Pick<Task, 'due' | 'allDay'>) => (!t.due ? null : t.allDay ? t.due.slice(0, 10) : dayKeyOf(new Date(t.due)))

/** Past its due time (a whole day for an all-day task) and not done. */
export function isOverdue(t: Task, now = new Date()): boolean {
  if (t.completed || !t.due) return false
  return t.allDay ? t.due.slice(0, 10) < dayKeyOf(now) : Date.parse(t.due) < now.getTime()
}

/** "Today", "Tomorrow 09:30", "Fri 16 Oct", "12 Jan 2027". */
export function dueLabel(t: Pick<Task, 'due' | 'allDay'>, now = new Date()): string {
  const day = dueDay(t)
  if (!day || !t.due) return ''
  const today = dayKeyOf(now)
  const d = new Date(`${day}T12:00:00`)
  const tomorrow = dayKeyOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1))
  const yesterday = dayKeyOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))
  const name =
    day === today
      ? 'Today'
      : day === tomorrow
        ? 'Tomorrow'
        : day === yesterday
          ? 'Yesterday'
          : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) })
  return t.allDay ? name : `${name} ${new Date(t.due).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}`
}

/** "Every week", "Every 2 days", "Every month"… for an RRULE, plainly. */
export function repeatLabel(rule: string): string {
  const get = (k: string) => new RegExp(`(?:^|;)${k}=([^;]+)`).exec(rule)?.[1]
  const freq = get('FREQ')
  const n = Number(get('INTERVAL') ?? 1)
  const unit = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' }[freq ?? ''] ?? 'time'
  if (freq === 'WEEKLY' && get('BYDAY') === 'MO,TU,WE,TH,FR' && n === 1) return 'Every weekday'
  const days = freq === 'WEEKLY' && get('BYDAY') ? ` on ${get('BYDAY')!.split(',').map((d) => ({ MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat', SU: 'Sun' })[d.slice(-2)] ?? d).join(', ')}` : ''
  return `${n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`}${days}`
}
