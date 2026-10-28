import './Focus.css'
import { useMemo, useState, type ReactNode } from 'react'
import type { Thread } from '../../data/agents'
import { Icon, Scramble, shortWhen, titlePending } from './bits'
import type { SideCtx } from './ctx'
import { needsAttention, STATUS_LABEL, statusOf, useSidebarModel } from './model'
import { GroupHeader, HideButton, List, ProjectsSection, SearchBox, TaskBadge, ThreadRow, ThreadsSection } from './shared'

// Focus: made to see what needs you. Chips filter the list (All, Running, Unread, Needs a look when
// something does, and one per project when there are few), a Running now section sits on top while
// anything runs, headers stick (the Threads header's + starts a thread), and the foot is icon
// buttons with tooltips. The Running now rows are marked `data-dup`: those threads are listed
// again where they belong, and a selection range counts them once. Its CSS is Focus.css.

type Filter = 'all' | 'running' | 'unread' | 'attention' | number
/** Up to this many projects get a chip each; with more, the project blocks of All do the job. */
const PROJECT_CHIPS = 4

/** The foot: Image Studio, Archived, Memory and Settings as icons (their names are tooltips). */
function FocusFoot({ ctx }: { ctx: SideCtx }) {
  const button = (icon: 'studio' | 'archive' | 'memory' | 'gear' | 'tasks', label: string, on: boolean, onClick: () => void, extra?: ReactNode) => (
    <button key={icon} className={on ? 'is-on' : ''} onClick={onClick} title={label} aria-label={label} aria-pressed={on}>
      <Icon name={icon} size={17} />
      {extra}
    </button>
  )
  return (
    <div className="agt-side-foot agt-fx-foot">
      {button('studio', 'Image Studio', ctx.mainKind === 'studio', ctx.openStudio)}
      {button('archive', 'Archived threads', ctx.archived, ctx.toggleArchived)}
      {button('memory', 'Memory: what the agent remembers', ctx.mainKind === 'memory', () => ctx.openMemory(null))}
      {button('tasks', 'Tasks: agents that run on their own', ctx.mainKind === 'tasks', ctx.openTasks, <TaskBadge badge={ctx.taskBadge} />)}
      {button('gear', 'Agents settings', ctx.mainKind === 'settings', ctx.openSettings)}
    </div>
  )
}

export function FocusSidebar({ ctx }: { ctx: SideCtx }) {
  const [filter, setFilter] = useState<Filter>('all')
  const { archived, projects, shown } = ctx
  const chipProjects = projects.length <= PROJECT_CHIPS ? projects : []
  // A chip that went away (the last thread stopped needing a look, a project was deleted) is All again.
  const active: Filter = archived || (typeof filter === 'number' && !chipProjects.some((p) => p.id === filter)) ? 'all' : filter
  const test = useMemo<((t: Thread) => boolean) | undefined>(
    () => (active === 'all' ? undefined : active === 'running' ? (t) => t.running : active === 'unread' ? ctx.isUnread : active === 'attention' ? needsAttention : (t) => t.projectId === active),
    [active, ctx.isUnread],
  )
  const model = useSidebarModel(ctx, { filter: test, flat: active !== 'all' })
  const all = useSidebarModel(ctx)
  const attention = shown.filter(needsAttention).length

  const row = (t: Thread) => {
    const status = statusOf(ctx, t)
    return (
      <ThreadRow key={t.id} ctx={ctx} t={t} itemClass={status ? `agt-fx-item is-${status}` : 'agt-fx-item'}>
        <span className={`agt-fx-state is-${status ?? t.mode}`} role="img" aria-label={status ? STATUS_LABEL[status] : t.mode === 'deep' ? 'Deep research' : 'Quick'} />
        <span className="agt-item-title">
          <Scramble text={t.title} pending={titlePending(t)} />
        </span>
        {t.pinned && (
          <span className="agt-pin" title="Pinned" aria-label="Pinned">
            <Icon name="pin" size={11} />
          </span>
        )}
        <span className="agt-item-when">{t.running ? 'answering' : status === 'attention' ? 'stopped' : shortWhen(t.updatedAt)}</span>
      </ThreadRow>
    )
  }

  const chip = (id: Filter, label: string, count?: number, tone?: string) => (
    <button key={String(id)} className={`agt-fx-chip ${active === id ? 'is-on' : ''} ${tone ?? ''} ${count === 0 ? 'is-none' : ''}`} aria-pressed={active === id} onClick={() => setFilter(id)}>
      <span>{label}</span>
      {count !== undefined && <span className="agt-fx-chip-count">{count}</span>}
    </button>
  )
  const filtered = active !== 'all'
  const name = typeof active === 'number' ? projects.find((p) => p.id === active)?.name ?? '' : active === 'running' ? 'Running' : active === 'unread' ? 'Unread' : 'Needs a look'
  const nothing = active === 'running' ? 'Nothing is running.' : active === 'unread' ? 'Nothing unread.' : active === 'attention' ? 'Nothing needs a look.' : 'No threads in this project.'

  return (
    <>
      <div className="agt-side-head">
        <SearchBox ctx={ctx} />
        <HideButton ctx={ctx} />
      </div>
      {!archived && (
        <div className="agt-fx-chips" role="group" aria-label="Show threads">
          {chip('all', 'All')}
          {chip('running', 'Running', all.running.length, 'is-live')}
          {chip('unread', 'Unread', all.unread.length)}
          {attention > 0 && chip('attention', 'Stopped', attention, 'is-warn')}
          {chipProjects.map((p) => chip(p.id, p.name, shown.filter((t) => t.projectId === p.id).length))}
        </div>
      )}
      <List ctx={ctx}>
        {!filtered && !archived && all.running.length > 0 && (
          <section className="agt-fx-live" data-dup>
            <GroupHeader title="Running now" count={all.running.length} className="agt-fx-head is-live" />
            <ul>{all.running.map(row)}</ul>
          </section>
        )}
        {!filtered && (
          <ProjectsSection
            ctx={ctx}
            model={all}
            row={row}
            showCount
            badge={(_, list) => {
              const n = list.filter((t) => t.running).length
              return n ? <span className="agt-fx-live-count" title={`${n} running`}>{n}</span> : null
            }}
          />
        )}
        <ThreadsSection
          ctx={ctx}
          model={filtered ? model : all}
          row={row}
          header={<GroupHeader title={filtered ? name : archived ? 'Archived' : 'Threads'} count={(filtered ? model : all).loose.length} onAdd={archived ? undefined : () => (typeof active === 'number' ? ctx.open(null, active) : ctx.newThread())} addLabel="New thread" className="agt-fx-head" />}
          day={(label) => <h5 className="agt-day agt-fx-day">{label}</h5>}
          empty={filtered ? <p className="agt-list-empty muted">{ctx.q ? 'Nothing matches.' : nothing}</p> : undefined}
        />
      </List>
      <FocusFoot ctx={ctx} />
    </>
  )
}
