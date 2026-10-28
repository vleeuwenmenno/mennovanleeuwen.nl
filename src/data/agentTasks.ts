import { api } from '../os/account'
import { useCallback, useEffect, useState } from 'react'
import type { Task, TaskRunInfo, TaskSpec } from './agentTaskPolicy'
import type { AgentMessage, Thread } from './agents'

// The Agents app's side of background tasks (server/agentTasks.ts): the tasks, their runs, answers
// to what a waiting run asks, and the live line that says when any of it changed (the notification
// stream's `tasks` event, src/os/notifyStream.ts, said again on window as TASKS_EVENT).

/** Said on window when a task or run changed on the server (a run started, ended, waits for you). */
export const TASKS_EVENT = 'mvlos:agent-tasks'
export type TasksChange = { task?: string; run?: string; deleted?: boolean }

export type TaskOptionsInfo = { enabled: boolean; mail: { id: number; label: string }[]; defaults: { report: TaskSpec['report']; keep: number; caps: TaskSpec['caps']; options: TaskSpec['options'] } }

export const listTasks = () => api<{ tasks: Task[]; enabled: boolean }>('/api/agents/tasks')
export const taskOptions = () => api<TaskOptionsInfo>('/api/agents/tasks/options')
export const getTask = (id: string) => api<Task>(`/api/agents/tasks/${id}`)
export const createTask = (spec: Partial<TaskSpec>, from: string | null = null) => api<Task>('/api/agents/tasks', { method: 'POST', json: { spec, from } })
/** Any fields of the task, its state note, or `status` ('paused' or 'active') to pause and resume it. */
export const updateTask = (id: string, patch: Partial<TaskSpec> & { stateNote?: string; status?: 'paused' | 'active' }) => api<Task>(`/api/agents/tasks/${id}`, { method: 'PATCH', json: patch })
export const deleteTask = (id: string) => api(`/api/agents/tasks/${id}`, { method: 'DELETE' })
export const runTask = (id: string, dry = false) => api<TaskRunInfo>(`/api/agents/tasks/${id}/run`, { method: 'POST', json: { dry } })
export const listRuns = (id: string, before?: number) => api<{ runs: TaskRunInfo[]; more: boolean }>(`/api/agents/tasks/${id}/runs${before ? `?before=${before}` : ''}`)
export const getRun = (id: string) => api<{ run: TaskRunInfo; task: Task }>(`/api/agents/task-runs/${id}`)
export const approveRun = (id: string, index: number, allow: boolean) => api<TaskRunInfo>(`/api/agents/task-runs/${id}/approve`, { method: 'POST', json: { index, allow } })
export const cancelRun = (id: string) => api<TaskRunInfo>(`/api/agents/task-runs/${id}/cancel`, { method: 'POST', json: {} })
/** Continue in thread: the run's transcript as a normal thread to follow up in. */
export const continueRun = (id: string) => api<{ thread: Thread; messages: AgentMessage[] }>(`/api/agents/task-runs/${id}/continue`, { method: 'POST', json: {} })

/** Calls `fn` whenever the server says tasks changed (and once a minute, in case the line was down). */
export function useTasksChanged(fn: (c: TasksChange) => void) {
  useEffect(() => {
    const on = (e: Event) => fn(((e as CustomEvent<TasksChange>).detail ?? {}) as TasksChange)
    window.addEventListener(TASKS_EVENT, on)
    const timer = window.setInterval(() => fn({}), 60_000)
    return () => (window.removeEventListener(TASKS_EVENT, on), window.clearInterval(timer))
  }, [fn])
}

/** How many runs are going (running, queued) and how many wait for you, for the Tasks tab's badge. */
export function useTaskBadge(): { active: number; waiting: number } {
  const [badge, setBadge] = useState({ active: 0, waiting: 0 })
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let live = true
    listTasks().then(
      ({ tasks }) => live && setBadge({ active: tasks.reduce((n, t) => n + (t.active && t.lastRun?.status !== 'waiting' ? 1 : 0), 0), waiting: tasks.filter((t) => t.lastRun?.status === 'waiting').length }),
      () => {},
    )
    return () => void (live = false)
  }, [tick])
  useTasksChanged(useCallback(() => setTick((n) => n + 1), []))
  return badge
}
