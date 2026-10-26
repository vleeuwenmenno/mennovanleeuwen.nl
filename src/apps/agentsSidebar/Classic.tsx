import type { Thread } from '../../data/agents'
import { Icon, Scramble, shortWhen, titlePending } from './bits'
import type { SideCtx } from './ctx'
import { useSidebarModel } from './model'
import { HideButton, List, SearchBox, SideFoot, StudioLink, ProjectsSection, ThreadRow, ThreadsSection } from './shared'

// Classic: how the sidebar always looked. Its CSS is the .agt-side, .agt-item and .agt-group rules
// in src/home.css, which the other styles build on.

export function ClassicSidebar({ ctx }: { ctx: SideCtx }) {
  const model = useSidebarModel(ctx)
  const row = (t: Thread) => (
    <ThreadRow key={t.id} ctx={ctx} t={t}>
      <span className={`agt-dot-mode is-${t.mode} ${t.running ? 'is-running' : ''}`} aria-label={t.mode === 'deep' ? 'Deep research' : 'Quick'} />
      <span className="agt-item-title">
        <Scramble text={t.title} pending={titlePending(t)} />
      </span>
      {t.pinned && (
        <span className="agt-pin" title="Pinned" aria-label="Pinned">
          <Icon name="pin" size={11} />
        </span>
      )}
      <span className="agt-item-when">{t.running ? '…' : shortWhen(t.updatedAt)}</span>
    </ThreadRow>
  )
  return (
    <>
      <div className="agt-side-head">
        <SearchBox ctx={ctx} />
        <HideButton ctx={ctx} />
      </div>
      <List ctx={ctx}>
        <StudioLink ctx={ctx} />
        <ProjectsSection ctx={ctx} model={model} row={row} />
        <ThreadsSection ctx={ctx} model={model} row={row} />
      </List>
      <SideFoot ctx={ctx} />
    </>
  )
}
