import './Rail.css'
import { useState } from 'react'
import type { Project, Thread } from '../../data/agents'
import { openContextMenu } from '../../os/ContextMenu'
import { Icon, NEW_TITLE } from './bits'
import type { SideCtx } from './ctx'
import { pinnedFirst, STATUS_LABEL, statusOf } from './model'
import { TaskBadge } from './shared'

// The folded sidebar, the same for every style: New thread and Search on top, then the threads as
// small chips (running ones first, then pinned, then the newest) or, with Projects on, the
// projects' threads grouped under their initials, and the footer's Archived, Memory, Image Studio
// and Settings. A chip is the thread's first letter; its tooltip has the full title and project, a
// dot says running, new answer or stopped, and the open thread is in the accent. Up and Down walk
// through every button. A narrow window never folds (see Agents.tsx), so this is desktop only.
// Its CSS is Rail.css.

/** As many chips as the rail will list: it scrolls, but a hundred is already a long way down. */
const MAX_CHIPS = 100

const initialOf = (t: Thread) => (t.title === NEW_TITLE ? null : (t.title.match(/[\p{L}\p{N}]/u)?.[0] ?? null)?.toUpperCase() ?? null)

/** Running first, then pinned, then the newest. */
const railOrder = (list: Thread[]) => [...list].sort((a, b) => Number(b.running) - Number(a.running) || Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)

/** Up and Down (and Home, End) move between the rail's buttons, in the order they are on screen. */
function railKeys(e: React.KeyboardEvent<HTMLElement>) {
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
  const stops = [...e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled)')].filter((el) => el.offsetParent !== null)
  const here = stops.indexOf(e.target as HTMLElement)
  if (here < 0) return
  const next = e.key === 'Home' ? stops[0] : e.key === 'End' ? stops[stops.length - 1] : stops[here + (e.key === 'ArrowDown' ? 1 : -1)]
  if (!next) return
  e.preventDefault()
  next.focus()
  next.scrollIntoView({ block: 'nearest' })
}

export function Rail({ ctx, onContextMenu }: { ctx: SideCtx; onContextMenu: React.MouseEventHandler<HTMLElement> }) {
  const [byProject, setByProject] = useState(false)
  const { threads, projects, mainKind } = ctx
  const projectOf = (t: Thread) => projects.find((p) => p.id === t.projectId)
  const chip = (t: Thread) => {
    const status = statusOf(ctx, t)
    const active = t.id === ctx.selected && mainKind === 'thread'
    const project = projectOf(t)
    const letter = initialOf(t)
    const tip = [t.title, project?.name, status ? STATUS_LABEL[status] : ''].filter(Boolean).join(' · ')
    return (
      <button
        key={t.id}
        className={`agt-rail-chip ${active ? 'is-active' : ''} ${t.mode === 'deep' ? 'is-deep' : ''} ${status ? `is-${status}` : ''}`}
        onClick={() => ctx.open(t.id)}
        onContextMenu={(e) => openContextMenu(e, ctx.menu(t))}
        title={tip}
        aria-label={tip}
        aria-current={active ? 'true' : undefined}
      >
        {letter ?? <Icon name="chat" size={14} />}
        {status && <span className={`agt-rail-dot is-${status}`} aria-hidden />}
      </button>
    )
  }

  let body: React.ReactNode
  if (byProject) {
    const groups = projects.map((p: Project) => ({ p, list: pinnedFirst(threads.filter((t) => t.projectId === p.id)) })).filter((g) => g.list.length)
    body = groups.length ? (
      groups.map(({ p, list }) => (
        <div key={p.id} className="agt-rail-group" role="group" aria-label={p.name}>
          <span className="agt-rail-project" title={p.name} role="img" aria-label={`Project ${p.name}`}>
            <Icon name="folder" size={11} />
            {p.name.trim().charAt(0).toUpperCase()}
          </span>
          {list.slice(0, MAX_CHIPS).map(chip)}
        </div>
      ))
    ) : (
      <span className="agt-rail-empty" title="No threads in a project yet">
        –
      </span>
    )
  } else {
    const ordered = railOrder(threads).slice(0, MAX_CHIPS)
    const top = ordered.filter((t) => t.running || t.pinned)
    const rest = ordered.filter((t) => !t.running && !t.pinned)
    body = (
      <>
        {top.map(chip)}
        {top.length > 0 && rest.length > 0 && <span className="agt-rail-sep" aria-hidden />}
        {rest.map(chip)}
        {!ordered.length && (
          <span className="agt-rail-empty" title={ctx.listError ?? 'No threads yet'}>
            –
          </span>
        )}
      </>
    )
  }

  return (
    <nav className="agt-rail" aria-label="Agents" onContextMenu={onContextMenu} onKeyDown={railKeys}>
      <button className="agt-icon" onClick={ctx.show} title="Show the sidebar" aria-label="Show the sidebar">
        <Icon name="sidebar" />
      </button>
      <button className="agt-icon is-accent" onClick={ctx.newThread} title="New thread" aria-label="New thread">
        <Icon name="plus" />
      </button>
      <button className="agt-icon" onClick={ctx.findThreads} title="Search threads" aria-label="Search threads">
        <Icon name="search" />
      </button>
      {projects.length > 0 && (
        <button className={`agt-icon ${byProject ? 'is-on' : ''}`} onClick={() => setByProject((on) => !on)} title={byProject ? 'Show recent threads' : 'Show the threads of each project'} aria-label="Projects" aria-pressed={byProject}>
          <Icon name="folder" />
        </button>
      )}
      <div className="agt-rail-list" role="group" aria-label={byProject ? 'Threads by project' : 'Recent threads'}>
        {body}
      </div>
      <button className="agt-icon" onClick={ctx.toggleArchived} title="Archived threads" aria-label="Archived threads">
        <Icon name="archive" />
      </button>
      <button className={`agt-icon ${mainKind === 'memory' ? 'is-on' : ''}`} onClick={() => ctx.openMemory(null)} title="Memory" aria-label="Memory">
        <Icon name="memory" />
      </button>
      <button className={`agt-icon agt-task-icon ${mainKind === 'tasks' ? 'is-on' : ''}`} onClick={ctx.openTasks} title="Tasks" aria-label="Tasks">
        <Icon name="tasks" />
        <TaskBadge badge={ctx.taskBadge} />
      </button>
      <button className={`agt-icon ${mainKind === 'studio' ? 'is-on' : ''}`} onClick={ctx.openStudio} title="Image Studio" aria-label="Image Studio">
        <Icon name="studio" />
      </button>
      <button className={`agt-icon ${mainKind === 'settings' ? 'is-on' : ''}`} onClick={ctx.openSettings} title="Settings" aria-label="Settings">
        <Icon name="gear" />
      </button>
    </nav>
  )
}
