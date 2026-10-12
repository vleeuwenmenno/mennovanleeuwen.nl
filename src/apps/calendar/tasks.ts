import { dayKey, type CalendarEvent } from '../../data/calendar'
import { dueDay, type Task, type TaskList } from '../../data/tasks'
import { addDays, parseDay } from './time'

// Tasks in the Calendar app: each task with a due date shows on that day, as an all-day bar or at
// its time, from the lists switched on in the sidebar (the Tasks app's "Show in Calendar", synced).
// They go through the views as events marked with their task, so the views draw a ring to tick
// before the title; dragging one changes its due date, and opening one opens it in the Tasks app.

export type TaskEvent = CalendarEvent & { task: Task }

export const isTaskEvent = (e: CalendarEvent): e is TaskEvent => 'task' in e && !!(e as TaskEvent).task

/** How long a timed task looks on the grid: long enough to read and grab. */
const TIMED_MS = 30 * 60_000

/** The tasks due between `from` and `to` (local days), as events. */
export function taskEvents(tasks: Task[], lists: TaskList[], hidden: string[], from: Date, to: Date): TaskEvent[] {
  const byId = new Map(lists.map((l) => [l.id, l]))
  const lo = dayKey(from)
  const hi = dayKey(to)
  const out: TaskEvent[] = []
  for (const t of tasks) {
    const list = byId.get(t.list)
    const day = dueDay(t)
    if (!list || !day || !t.due || hidden.includes(t.list) || day < lo || day >= hi) continue
    out.push({
      id: `task:${t.id}`,
      calendarId: `task:${t.list}`,
      calendar: list.name,
      color: list.color,
      title: t.title,
      start: t.allDay ? day : t.due,
      end: t.allDay ? dayKey(addDays(parseDay(day), 1)) : new Date(Date.parse(t.due) + TIMED_MS).toISOString(),
      allDay: !!t.allDay,
      description: t.notes,
      editable: list.writable && !t.completed,
      task: t,
    })
  }
  return out
}
