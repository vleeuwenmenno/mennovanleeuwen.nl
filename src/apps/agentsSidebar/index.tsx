import type { SidebarStyle } from '../../data/agents'
import { ClassicSidebar } from './Classic'
import { CompactSidebar } from './Compact'
import type { SideCtx } from './ctx'
import { DetailedSidebar } from './Detailed'
import { FocusSidebar } from './Focus'
import { ArchivedTitle } from './shared'

// The Agents sidebar in the style Settings → Agents picks (`sidebarStyle`). Each style is a
// component and a CSS file of its own, built from the same parts and model (shared.tsx, model.ts);
// to drop a style, delete its two files, its line here and its entry in SIDEBAR_STYLES
// (src/data/agents.ts). Classic's CSS is in src/home.css, and the others build on it.

export { sideKeys } from './shared'
export type { SideCtx } from './ctx'

export function AgentsSidebar({ style, ctx }: { style: SidebarStyle; ctx: SideCtx }) {
  return (
    <>
      <ArchivedTitle ctx={ctx} />
      {style === 'compact' ? <CompactSidebar ctx={ctx} /> : style === 'detailed' ? <DetailedSidebar ctx={ctx} /> : style === 'focus' ? <FocusSidebar ctx={ctx} /> : <ClassicSidebar ctx={ctx} />}
    </>
  )
}
