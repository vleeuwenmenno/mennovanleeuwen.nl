// The Tasks app's settings (synced state "tasks"), shared by the browser (the Tasks and Calendar
// apps, src/data/tasks.ts) and the server's task reminders (server/tasks.ts), which reads them the
// way the notification hub reads "notify". No DOM or Node APIs here: both runtimes import it.

/** Minutes before a timed task is due that its reminder comes (0: when it is due). */
export const TASK_LEADS = [0, 5, 10, 15, 30, 60] as const
export type TaskLead = (typeof TASK_LEADS)[number]

export type TaskPrefs = {
  /** Remind about due tasks that have no reminder of their own (a VALARM) */
  remind: boolean
  /** Minutes before a timed task is due that its reminder comes */
  lead: TaskLead
  /** When an all-day task's reminder comes on the day it is due, "HH:MM" */
  morning: string
  /** The browser's time zone, for that morning time and the reminders' wording (the Tasks app sets it) */
  timeZone: string | null
  /** Lists whose tasks the Calendar app leaves out */
  hiddenInCalendar: string[]
  /** Completed tasks show in the Tasks app's lists */
  showCompleted: boolean
  /** The list new tasks go in when none is picked (another app's "Make a task") */
  defaultList: string | null
}

export const DEFAULT_TASK_PREFS: TaskPrefs = { remind: true, lead: 0, morning: '09:00', timeZone: null, hiddenInCalendar: [], showCompleted: false, defaultList: null }

/** Stored settings made whole and valid. */
export function normalizeTaskPrefs(v: unknown): TaskPrefs {
  const s = { ...DEFAULT_TASK_PREFS, ...(v && typeof v === 'object' ? (v as Partial<TaskPrefs>) : {}) }
  return {
    remind: s.remind !== false,
    lead: (TASK_LEADS as readonly number[]).includes(s.lead) ? s.lead : DEFAULT_TASK_PREFS.lead,
    morning: typeof s.morning === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s.morning) ? s.morning : DEFAULT_TASK_PREFS.morning,
    timeZone: typeof s.timeZone === 'string' && /^[\w+-]+(?:\/[\w+-]+)*$/.test(s.timeZone) ? s.timeZone : null,
    hiddenInCalendar: Array.isArray(s.hiddenInCalendar) ? s.hiddenInCalendar.filter((x): x is string => typeof x === 'string').slice(0, 200) : [],
    showCompleted: s.showCompleted === true,
    defaultList: typeof s.defaultList === 'string' ? s.defaultList : null,
  }
}

/** iCalendar priorities (1 highest, 9 lowest, 0 none) as the Tasks app names them; Apple writes 1, 5 and 9. */
export const PRIORITIES = [
  { value: 0, label: 'None' },
  { value: 9, label: 'Low' },
  { value: 5, label: 'Medium' },
  { value: 1, label: 'High' },
] as const
export type PriorityLevel = 'none' | 'low' | 'medium' | 'high'
export const priorityLevel = (p: number): PriorityLevel => (!p ? 'none' : p < 5 ? 'high' : p === 5 ? 'medium' : 'low')
