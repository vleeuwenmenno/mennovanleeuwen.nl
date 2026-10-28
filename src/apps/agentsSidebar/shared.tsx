import { useEffect, type ReactNode } from 'react'
import { alsoKnownAs, type Project, type Thread } from '../../data/agents'
import { openContextMenu, openMenuAt } from '../../os/ContextMenu'
import { Icon, InlineName, RenameBox } from './bits'
import type { SideCtx } from './ctx'
import type { SidebarModel } from './model'
import { BulkBar, SelectCheck, useBandSelect, useRowSelect } from './select'

// The parts every sidebar style is made of. They draw what the classic sidebar always drew; a
// style changes them with its own class names, CSS, and the few render props below, and builds
// whatever differs (rows, the top, the foot) itself. All behaviour is here, once: search, renaming,
// menus, dragging, folding, selection and the keyboard.

/** The search field. */
export function SearchBox({ ctx }: { ctx: SideCtx }) {
  const { q, setQ, archived } = ctx
  return (
    <label className="agt-search">
      <Icon name="search" />
      <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && q && (e.stopPropagation(), setQ(''))} placeholder={archived ? 'Search archived' : 'Search threads'} aria-label="Search threads" spellCheck={false} />
      {q && (
        <button type="button" className="agt-search-clear" onClick={() => setQ('')} title="Clear the search" aria-label="Clear the search">
          <Icon name="close" size={12} />
        </button>
      )}
    </label>
  )
}

/** Fold the sidebar to its rail (nothing in a narrow window, where list and conversation take turns). */
export function HideButton({ ctx }: { ctx: SideCtx }) {
  if (ctx.narrow) return null
  return (
    <button className="agt-icon" onClick={ctx.hide} title="Hide the sidebar" aria-label="Hide the sidebar">
      <Icon name="sidebar" />
    </button>
  )
}

/** The way back from the archived view. */
export function ArchivedTitle({ ctx }: { ctx: SideCtx }) {
  if (!ctx.archived) return null
  return (
    <div className="agt-side-title">
      <button className="agt-icon" onClick={ctx.leaveArchived} aria-label="Back to threads" title="Back to threads">
        <Icon name="back" />
      </button>
      <strong>Archived</strong>
    </div>
  )
}

/** The Image Studio, as an entry at the top of the list. */
export function StudioLink({ ctx }: { ctx: SideCtx }) {
  if (ctx.archived) return null
  return (
    <button className={`agt-item agt-studio-link ${ctx.mainKind === 'studio' ? 'is-active' : ''}`} onClick={ctx.openStudio} title="Generate pictures with your ComfyUI by hand, without an agent">
      <Icon name="studio" />
      <span className="agt-item-title">Image Studio</span>
    </button>
  )
}

/**
 * The scrolling list, with the rubber band over it and the bulk bar under it. Arrow keys walk
 * through its rows (see `sideKeys`). The selection only ever holds what the list shows: a search, a
 * folded project or a deleted thread takes its rows out of it.
 */
export function List({ ctx, children }: { ctx: SideCtx; children: ReactNode }) {
  const sel = ctx.selection
  const { onMouseDown, band } = useBandSelect(ctx)
  useEffect(() => {
    const list = sel.listRef.current
    if (!sel.size || !list || !list.getClientRects().length) return
    sel.keepOnly(new Set(sel.order()))
  })
  return (
    <>
      <div ref={sel.listRef} className={`agt-list ${sel.active ? 'is-selecting' : ''}`} onMouseDown={onMouseDown}>
        {children}
        <div ref={band} className="agt-band" aria-hidden />
      </div>
      <BulkBar ctx={ctx} />
    </>
  )
}

/**
 * Up and Down move between the search, the project headers and the thread rows, in the order they
 * are on screen; Up from the first row goes back to the search. In the list, Shift+Up and Down
 * extend the selection from the row it started on, Ctrl+A selects every row and Esc ends the
 * selection. Put on the sidebar itself.
 */
export function sideKeys(e: React.KeyboardEvent<HTMLElement>, ctx: SideCtx) {
  const target = e.target as HTMLElement
  const sel = ctx.selection
  const search = e.currentTarget.querySelector<HTMLInputElement>('input[aria-label="Search threads"]')
  // Other text fields (renaming) keep their keys.
  const typing = (target instanceof HTMLInputElement && target !== search) || target instanceof HTMLTextAreaElement
  if (e.key === 'Escape' && sel.active && !typing) {
    e.preventDefault()
    e.stopPropagation()
    return sel.clear()
  }
  if (typing || e.altKey) return
  if (e.key.toLowerCase() === 'a' && (e.ctrlKey || e.metaKey) && !e.shiftKey && target !== search && target.closest('.agt-list')) {
    e.preventDefault()
    return sel.selectAll()
  }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
  if (e.shiftKey && !e.ctrlKey && !e.metaKey) {
    const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('.agt-list .agt-row > .agt-item')].filter((el) => el.offsetParent !== null)
    const here = rows.indexOf(target)
    if (here < 0) return
    e.preventDefault()
    const next = rows[here + (e.key === 'ArrowDown' ? 1 : -1)]
    if (!next) return
    const idOf = (el: HTMLElement) => el.closest<HTMLElement>('.agt-row')!.dataset.thread!
    sel.range(idOf(next), false, sel.anchor ?? idOf(target))
    next.focus()
    return next.scrollIntoView({ block: 'nearest' })
  }
  if (e.ctrlKey || e.metaKey || e.shiftKey) return
  const stops = [...e.currentTarget.querySelectorAll<HTMLElement>('.agt-list .agt-item, .agt-list .agt-project-toggle')].filter((el) => el.offsetParent !== null)
  const here = stops.indexOf(target)
  if (target !== search && here < 0) return
  const next = target === search ? (e.key === 'ArrowDown' ? stops[0] : undefined) : e.key === 'ArrowDown' ? stops[here + 1] : here === 0 ? search : stops[here - 1]
  if (!next) return
  e.preventDefault()
  next.focus()
  next.scrollIntoView({ block: 'nearest' })
}

/**
 * One thread: the row's frame (renaming in place, the menu, dragging, the selection) around what
 * the style puts inside the button.
 */
export function ThreadRow({ ctx, t, itemClass = '', rowClass = '', children }: { ctx: SideCtx; t: Thread; itemClass?: string; rowClass?: string; children: ReactNode }) {
  const active = t.id === ctx.selected && ctx.mainKind === 'thread'
  const rs = useRowSelect(ctx, t)
  const selecting = ctx.selection.active
  const drag = ctx.archived ? {} : (ctx.dragging({ kind: 'thread', id: t.id }) as { onDragStart?: (e: React.DragEvent) => void })
  const classes = ['agt-row', rowClass, selecting && 'is-selecting', ctx.selection.has(t.id) && 'is-selected']
  return (
    <li className={classes.filter(Boolean).join(' ')} data-thread={t.id}>
      {selecting && ctx.renaming !== t.id && <SelectCheck ctx={ctx} t={t} />}
      {ctx.renaming === t.id ? (
        <div className={`agt-item is-active ${itemClass}`}>
          <RenameBox thread={t} onSave={(title) => ctx.rename(t, title)} onCancel={() => ctx.setRenaming(null)} />
        </div>
      ) : (
        <button
          className={`agt-item ${active ? 'is-active' : ''} ${itemClass}`}
          title={[t.title, alsoKnownAs(t), `${t.mode === 'deep' ? 'Deep research' : 'Quick'} · ${t.model}`].filter(Boolean).join('\n')}
          {...drag}
          onDragStart={drag.onDragStart && ((e) => rs.onDragStart(e, drag.onDragStart!))}
          onPointerDown={rs.onPointerDown}
          onPointerMove={rs.onPointerMove}
          onPointerUp={rs.onPointerUp}
          onPointerCancel={rs.onPointerCancel}
          onPointerLeave={rs.onPointerLeave}
          onClick={rs.onClick}
          onKeyDown={rs.onKeyDown}
          onKeyUp={rs.onKeyUp}
          onContextMenu={(e) => {
            if (rs.onContextMenu(e)) return
            openContextMenu(e, ctx.selection.size > 1 && ctx.selection.has(t.id) ? ctx.bulk.menu() : ctx.menu(t))
          }}
        >
          {children}
        </button>
      )}
      {ctx.renaming !== t.id && (
        <button className="agt-icon agt-mini agt-item-more" onClick={(e) => openMenuAt(e.currentTarget, ctx.menu(t))} title="More" aria-label={`${t.title}: more`}>
          <Icon name="more" size={13} />
        </button>
      )}
    </li>
  )
}

/** A thread dropped on a project (or out of them): all the selected ones go with it when it is one of them. */
function dropThread(ctx: SideCtx, id: string, projectId: number | null) {
  if (ctx.selection.has(id) && ctx.selection.size > 1) return ctx.bulk.move(projectId)
  const t = ctx.threads.find((x) => x.id === id)
  if (t) ctx.move(t, projectId)
}

/** The small header of a group of the list: its name, how many it holds (styles that show it), and a + for a new one. */
export function GroupHeader({ title, count, onAdd, addLabel, className = '' }: { title: string; count?: number; onAdd?: () => void; addLabel?: string; className?: string }) {
  return (
    <h4 className={`agt-group agt-group-row ${className}`}>
      <span>{title}</span>
      {count !== undefined && <span className="agt-group-count">{count}</span>}
      {onAdd && (
        <button className="agt-icon agt-mini" onClick={onAdd} title={addLabel} aria-label={addLabel}>
          <Icon name="plus" size={13} />
        </button>
      )}
    </h4>
  )
}

/**
 * The Projects block: each project folds, renames, reorders by dragging and takes dropped threads.
 * `row` draws a thread; `showCount` puts the project count on the header; `badge` adds to a
 * project's own header (what is running in it, say).
 */
export function ProjectsSection({ ctx, model, row, showCount, badge }: { ctx: SideCtx; model: SidebarModel; row: (t: Thread) => ReactNode; showCount?: boolean; badge?: (p: Project, list: Thread[]) => ReactNode }) {
  if (ctx.archived) return null
  const { projects, query, folded } = ctx
  return (
    <section>
      <GroupHeader title="Projects" count={showCount ? projects.length : undefined} onAdd={ctx.newProject} addLabel="New project" />
      {ctx.addingProject && (
        <InlineName
          placeholder="Project name"
          onDone={(name) => {
            ctx.setAddingProject(false)
            if (name) ctx.addProject(name)
          }}
        />
      )}
      {projects.map((p) => {
        const list = model.projectThreads(p)
        if (query && !list.length) return null
        // Filtering (a style's chips) shows only projects with something left.
        if (list.length === 0 && model.kept !== ctx.shown) return null
        const isFolded = folded.includes(p.id) && !query
        return (
          <div key={p.id} className={`agt-project ${ctx.dropAt === `p${p.id}` ? 'is-drop' : ''} ${ctx.drag?.kind === 'project' && ctx.drag.id === p.id ? 'is-dragged' : ''}`}>
            <div
              className="agt-project-head"
              onContextMenu={(e) => openContextMenu(e, ctx.projectMenu(p))}
              {...ctx.dragging({ kind: 'project', id: p.id })}
              {...ctx.dropZone(
                `p${p.id}`,
                (d) => (d.kind === 'project' ? d.id !== p.id : ctx.threads.find((t) => t.id === d.id)?.projectId !== p.id),
                (d) => (d.kind === 'project' ? ctx.reorder(d.id, p.id) : dropThread(ctx, d.id, p.id)),
              )}
            >
              {ctx.renamingProject === p.id ? (
                <InlineName
                  value={p.name}
                  onDone={(name) => {
                    ctx.setRenamingProject(null)
                    if (name && name !== p.name) ctx.renameProject(p, name)
                  }}
                />
              ) : (
                <button className="agt-project-toggle" onClick={() => ctx.toggleFold(p.id)} onDoubleClick={() => ctx.setRenamingProject(p.id)} aria-expanded={!isFolded}>
                  <span className={`agt-chev ${isFolded ? 'is-folded' : ''}`}>
                    <Icon name="chevron" size={12} />
                  </span>
                  <span className="agt-project-name">{p.name}</span>
                  {badge?.(p, list)}
                  <span className="agt-project-count">{list.length || ''}</span>
                </button>
              )}
              <button className="agt-icon agt-mini" onClick={() => ctx.open(null, p.id)} title={`New thread in ${p.name}`} aria-label={`New thread in ${p.name}`}>
                <Icon name="plus" size={13} />
              </button>
              <button className="agt-icon agt-mini" onClick={(e) => openMenuAt(e.currentTarget, ctx.projectMenu(p))} title="More" aria-label={`${p.name}: more`}>
                <Icon name="more" size={13} />
              </button>
            </div>
            {!isFolded && (
              <ul className="agt-project-threads">
                {list.map(row)}
                {!list.length && <li className="agt-hint muted">No threads yet: + starts one, or drag one here.</li>}
              </ul>
            )}
          </div>
        )
      })}
      {!projects.length && !ctx.addingProject && <p className="agt-hint muted">Projects group threads that belong together, each with a memory of its own.</p>}
    </section>
  )
}

/**
 * The threads outside any project (all of them in the archived view): pinned first, then by day.
 * A thread dropped here leaves its project. `header` is the group header (null: none), `day` draws
 * a day's heading, `empty` what shows when there is nothing.
 */
export function ThreadsSection({ ctx, model, row, header, day, empty }: { ctx: SideCtx; model: SidebarModel; row: (t: Thread) => ReactNode; header?: ReactNode; day?: (label: string, items: Thread[]) => ReactNode; empty?: ReactNode }) {
  const { archived, query, threads } = ctx
  return (
    <section
      className={ctx.dropAt === 'loose' ? 'agt-drop-loose is-drop' : 'agt-drop-loose'}
      {...ctx.dropZone(
        'loose',
        (d) => d.kind === 'thread' && ctx.inProject(threads.find((t) => t.id === d.id)!),
        (d) => d.kind === 'thread' && dropThread(ctx, d.id, null),
      )}
    >
      {header === undefined ? <GroupHeader title={archived ? 'Archived' : 'Threads'} onAdd={archived ? undefined : ctx.newThread} addLabel="New thread" /> : header}
      {model.loosePinned.length > 0 && <ul>{model.loosePinned.map(row)}</ul>}
      {model.looseByDay.map((g) => (
        <div key={g.label}>
          {day ? day(g.label, g.items) : <h5 className="agt-day">{g.label}</h5>}
          <ul>{g.items.map(row)}</ul>
        </div>
      ))}
      {!model.loose.length && (empty ?? <p className="agt-list-empty muted">{ctx.listError ?? (query ? 'Nothing matches.' : archived ? 'Nothing archived.' : 'No threads yet. Ask something to start one.')}</p>)}
    </section>
  )
}

/** Runs going (a number) and runs waiting for you (an !), on the Tasks button. */
export function TaskBadge({ badge }: { badge: { active: number; waiting: number } }) {
  if (!badge.active && !badge.waiting) return null
  return (
    <span className={`agt-task-badge ${badge.waiting ? 'is-ask' : ''}`} aria-label={badge.waiting ? `${badge.waiting} waiting for you` : `${badge.active} running`}>
      {badge.waiting ? '!' : badge.active}
    </span>
  )
}

/** The classic foot: Archived, Memory, Tasks and Settings, with their names. */
export function SideFoot({ ctx }: { ctx: SideCtx }) {
  return (
    <div className="agt-side-foot">
      <button className={ctx.archived ? 'is-on' : ''} onClick={ctx.toggleArchived} title="Archived threads">
        <Icon name="archive" /> <span>Archived</span>
      </button>
      <button className={ctx.mainKind === 'memory' ? 'is-on' : ''} onClick={() => ctx.openMemory(null)} title="What the agent remembers">
        <Icon name="memory" /> <span>Memory</span>
      </button>
      <button className={ctx.mainKind === 'tasks' ? 'is-on' : ''} onClick={ctx.openTasks} title="Background tasks: agents that run on their own and report back">
        <Icon name="tasks" /> <span>Tasks</span>
        <TaskBadge badge={ctx.taskBadge} />
      </button>
      <button className={ctx.mainKind === 'settings' ? 'is-on' : ''} onClick={ctx.openSettings} title="Agents settings">
        <Icon name="gear" /> <span>Settings</span>
      </button>
    </div>
  )
}
