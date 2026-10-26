import './Detailed.css'
import type { Thread } from '../../data/agents'
import { modelName } from '../../data/agentModelNames'
import { Icon, Scramble, titlePending } from './bits'
import type { SideCtx } from './ctx'
import { GroupHeader, HideButton, List, ProjectsSection, SearchBox, SideFoot, StudioLink, ThreadRow, ThreadsSection } from './shared'
import { longWhen, statusOf, useSidebarModel, type Status } from './model'

// Detailed: two lines per thread. The title comes first and wraps to a second line when there is
// room; under it, small and muted, the project (or the model) and when. A bar on the left and a
// badge say what is running, new or stopped. Its CSS is Detailed.css.

const modelLabel = (raw: string) => {
  const n = modelName(raw)
  return `${n.name}${n.variant ? ` ${n.variant}` : ''}`
}

function badge(t: Thread, status: Status) {
  if (status === 'running') return 'Running'
  if (status === 'unread') return 'New'
  if (status === 'attention') return t.interrupted?.reason === 'failed' ? 'Failed' : 'Interrupted'
  return null
}

export function DetailedSidebar({ ctx }: { ctx: SideCtx }) {
  const model = useSidebarModel(ctx)
  /** `withProject`: name the project in the second line (the rows outside the project blocks). */
  const rowOf = (withProject: boolean) => (t: Thread) => {
    const status = statusOf(ctx, t)
    const project = withProject ? ctx.projects.find((p) => p.id === t.projectId) : undefined
    const label = badge(t, status)
    return (
      <ThreadRow key={t.id} ctx={ctx} t={t} itemClass={`agt-dx-item ${status ? `is-${status}` : ''}`}>
        <span className="agt-dx-body">
          <span className="agt-dx-title">
            <Scramble text={t.title} pending={titlePending(t)} />
            {t.pinned && (
              <span className="agt-pin" title="Pinned" aria-label="Pinned">
                <Icon name="pin" size={11} />
              </span>
            )}
          </span>
          <span className="agt-dx-meta">
            <span className="agt-dx-sub">
              {project && <span className="agt-dx-project">{project.name}</span>}
              <span>
                {t.mode === 'deep' ? 'Deep · ' : ''}
                {modelLabel(t.model)}
              </span>
            </span>
            {label && <span className={`agt-dx-badge is-${status}`}>{label}</span>}
            <span className="agt-item-when">{t.running ? '' : longWhen(t.updatedAt)}</span>
          </span>
        </span>
      </ThreadRow>
    )
  }
  return (
    <>
      {!ctx.archived && (
        <div className="agt-dx-top">
          <button className="agt-dx-new" onClick={ctx.newThread}>
            <Icon name="plus" size={15} />
            <span>New thread</span>
          </button>
          <HideButton ctx={ctx} />
        </div>
      )}
      <div className="agt-side-head agt-dx-search">
        <SearchBox ctx={ctx} />
        {ctx.archived && <HideButton ctx={ctx} />}
      </div>
      <List>
        <StudioLink ctx={ctx} />
        <ProjectsSection ctx={ctx} model={model} row={rowOf(false)} showCount />
        <ThreadsSection
          ctx={ctx}
          model={model}
          row={rowOf(true)}
          header={<GroupHeader title={ctx.archived ? 'Archived' : 'Threads'} count={model.loose.length} />}
          day={(label, items) => (
            <h5 className="agt-day agt-dx-day">
              <span>{label}</span>
              <span className="agt-group-count">{items.length}</span>
            </h5>
          )}
        />
      </List>
      <SideFoot ctx={ctx} />
    </>
  )
}
