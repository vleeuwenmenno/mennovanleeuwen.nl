import { useMemo } from 'react'
import type { Project, Thread } from '../../data/agents'
import { byDay } from './bits'
import type { SideCtx } from './ctx'

/** Pinned first, then the newest. */
export const pinnedFirst = (list: Thread[]) => [...list].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)

/** A thread that stopped on an error (or was cut short) and waits for you to look at it. */
export const needsAttention = (t: Thread) => !t.running && !!t.interrupted && t.interrupted.reason !== 'stopped'

/**
 * What every style shows, worked out once: the loose threads (pinned, then by day), each project's
 * threads, what is running or unread. `filter` narrows the threads further (the Focus chips);
 * `flat` puts the project threads in the loose list too, for a filtered view without project blocks.
 */
export function useSidebarModel(ctx: SideCtx, options: { filter?: (t: Thread) => boolean; flat?: boolean } = {}) {
  const { filter, flat } = options
  const { shown, archived, inProject, isUnread } = ctx
  const kept = useMemo(() => (filter ? shown.filter(filter) : shown), [shown, filter])
  return useMemo(() => {
    const loose = pinnedFirst(kept.filter((t) => flat || archived || !inProject(t)))
    return {
      /** The threads the search and filter let through. */
      kept,
      loose,
      loosePinned: loose.filter((t) => t.pinned),
      looseByDay: byDay(loose.filter((t) => !t.pinned)),
      projectThreads: (p: Project) => pinnedFirst(kept.filter((t) => t.projectId === p.id)),
      running: kept.filter((t) => t.running),
      unread: kept.filter(isUnread),
    }
  }, [kept, flat, archived, inProject, isUnread])
}
export type SidebarModel = ReturnType<typeof useSidebarModel>

export type Status = 'running' | 'attention' | 'unread' | null
/** What a thread wants you to know, most pressing first (the styles that show it). */
export const statusOf = (ctx: SideCtx, t: Thread): Status => (t.running ? 'running' : needsAttention(t) ? 'attention' : ctx.isUnread(t) ? 'unread' : null)
/** The words for a status, as a tooltip or a label. */
export const STATUS_LABEL = { running: 'Running', attention: 'Needs a look', unread: 'New answer' } as const

/** "just now", "5 min ago", "3 h ago", "Yesterday", "Tuesday", "12 Oct": for rows with room to say it. */
export function longWhen(ms: number, now = Date.now()) {
  const s = (now - ms) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  const d = new Date(ms)
  if (new Date(now).toDateString() === d.toDateString()) return `${Math.floor(s / 3600)} h ago`
  const y = new Date(now)
  y.setDate(y.getDate() - 1)
  if (y.toDateString() === d.toDateString()) return 'Yesterday'
  if (s < 6 * 86400) return d.toLocaleDateString('en-GB', { weekday: 'long' })
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}
