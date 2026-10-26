import './Compact.css'
import type { Thread } from '../../data/agents'
import { Icon, Scramble, shortWhen, titlePending } from './bits'
import type { SideCtx } from './ctx'
import { STATUS_LABEL, statusOf, useSidebarModel } from './model'
import { HideButton, List, ProjectsSection, SearchBox, SideFoot, StudioLink, ThreadRow, ThreadsSection } from './shared'

// Compact: one dense line per thread, thin sticky group headers (one per day, no "Threads" header
// above them), and a New thread button beside the search. Its CSS is Compact.css.

export function CompactSidebar({ ctx }: { ctx: SideCtx }) {
  const model = useSidebarModel(ctx)
  const row = (t: Thread) => {
    const status = statusOf(ctx, t)
    return (
      <ThreadRow key={t.id} ctx={ctx} t={t} itemClass={status ? `is-${status}` : ''}>
        <span className={`agt-dot-mode is-${t.mode} ${t.running ? 'is-running' : ''}`} role="img" aria-label={status ? STATUS_LABEL[status] : t.mode === 'deep' ? 'Deep research' : 'Quick'} />
        <span className="agt-item-title">
          <Scramble text={t.title} pending={titlePending(t)} />
        </span>
        {t.pinned && (
          <span className="agt-pin" title="Pinned" aria-label="Pinned">
            <Icon name="pin" size={10} />
          </span>
        )}
        <span className="agt-item-when">{t.running ? '…' : status === 'attention' ? '!' : shortWhen(t.updatedAt)}</span>
      </ThreadRow>
    )
  }
  return (
    <>
      <div className="agt-side-head agt-cx-head">
        <SearchBox ctx={ctx} />
        {!ctx.archived && (
          <button className="agt-cx-new" onClick={ctx.newThread} title="New thread" aria-label="New thread">
            <Icon name="plus" size={14} />
            <span>
              New<span className="agt-cx-long"> thread</span>
            </span>
          </button>
        )}
        <HideButton ctx={ctx} />
      </div>
      <List>
        <StudioLink ctx={ctx} />
        <ProjectsSection ctx={ctx} model={model} row={row} showCount />
        <ThreadsSection
          ctx={ctx}
          model={model}
          row={row}
          header={null}
          day={(label, items) => (
            <h5 className="agt-group agt-cx-day">
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
