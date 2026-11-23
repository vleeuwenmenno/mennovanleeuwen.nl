import './page.css'
import { forwardRef, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Mode, Thread } from '../../data/agents'
import { signOut, useAccount } from '../../os/account'
import { openMenuAt } from '../../os/ContextMenu'
import { toggleMode, useTheme } from '../../os/theme'
import { Icon, Scramble, titlePending } from '../agentsSidebar/bits'
import type { SideCtx } from '../agentsSidebar/ctx'
import { useSidebarModel } from '../agentsSidebar/model'
import { ArchivedTitle, GroupHeader, List, ProjectsSection, SearchBox, TaskBadge, ThreadRow, ThreadsSection } from '../agentsSidebar/shared'
import { sideKeys } from '../agentsSidebar'

// The Agents page's layout (/agents, src/apps/agentsPage/AgentsPage.tsx): the same app as the
// window (Agents.tsx owns all the state and passes the sidebar's context in), drawn like a chat
// website. A sidebar with the app's name, New chat, Search and the app's places, then the projects
// and recent threads and the account at the bottom; it hides on a desktop and is a drawer on a
// phone. The conversation is a centred column (page.css). The sidebar is built from the same parts
// as the window's sidebar styles (agentsSidebar/shared.tsx), so renaming, menus, dragging into
// projects and selecting many threads work the same.

/** What the conversation draws for the page: the button that brings the sidebar back (or opens the drawer). */
export type PageChrome = { lead: ReactNode }

/** The conversation's first buttons: the drawer's on a phone, Show sidebar and New chat on a desktop once it is hidden. */
export function PageLead({ phone, collapsed, onMenu, onShow, onNew }: { phone: boolean; collapsed: boolean; onMenu: () => void; onShow: () => void; onNew: () => void }) {
  if (phone)
    return (
      <button type="button" className="agt-icon agp-lead" onClick={onMenu} aria-label="Open the sidebar" title="Threads, projects and settings">
        <Icon name="menu" size={18} />
      </button>
    )
  if (!collapsed) return null
  return (
    <>
      <button type="button" className="agt-icon agp-lead" onClick={onShow} aria-label="Show the sidebar" title="Show the sidebar">
        <Icon name="sidebar" size={17} />
      </button>
      <button type="button" className="agt-icon agp-lead" onClick={onNew} aria-label="New chat" title="New chat">
        <Icon name="compose" size={17} />
      </button>
    </>
  )
}

/** The headline over an empty thread's message box. */
export function pageGreeting(name: string | null, mode: Mode, now = new Date()): string {
  if (mode === 'deep') return 'What should it research?'
  const first = name?.trim().split(/\s+/)[0]
  const h = now.getHours()
  const part = h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
  return first ? `${part}, ${first}` : `${part}. What's on your mind?`
}

/** A few ideas under an empty thread's message box: a tap puts the words in the box, to change or send. */
export function pageSuggestions(mode: Mode): { label: string; prompt: string }[] {
  return mode === 'deep'
    ? [
        { label: 'Compare options', prompt: 'Compare the main options for ' },
        { label: 'State of the art', prompt: 'What is the current state of the art in ' },
        { label: 'Pros and cons', prompt: 'Research the pros and cons of ' },
        { label: 'Explain a topic', prompt: 'Give me a thorough explanation of ' },
      ]
    : [
        { label: 'Explain something', prompt: 'Explain in simple terms: ' },
        { label: 'Summarise a page', prompt: 'Summarise this page: ' },
        { label: "Today's news", prompt: 'What is in the news today about ' },
        { label: 'Help me write', prompt: 'Help me write ' },
      ]
}

type LayoutProps = {
  ctx: SideCtx
  phone: boolean
  /** The sidebar is hidden (desktop) */
  collapsed: boolean
  /** The drawer is open (phone) */
  drawer: boolean
  onDrawer: (open: boolean) => void
  onContextMenu: (e: React.MouseEvent) => void
  onSideMenu: (e: React.MouseEvent) => void
  children: ReactNode
}

export const AgentsPageLayout = forwardRef<HTMLDivElement, LayoutProps>(function AgentsPageLayout({ ctx, phone, collapsed, drawer, onDrawer, onContextMenu, onSideMenu, children }, ref) {
  const side = phone ? drawer : !collapsed
  // Esc closes the drawer (a field or menu that has Esc of its own keeps it).
  useEffect(() => {
    if (!phone || !drawer) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !e.defaultPrevented && onDrawer(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phone, drawer, onDrawer])
  return (
    <div ref={ref} className={`agp ${phone ? 'is-phone' : ''} ${side ? 'has-side' : ''}`} onContextMenu={onContextMenu}>
      {phone && drawer && <div className="agp-scrim" onClick={() => onDrawer(false)} aria-hidden />}
      {side && (
        <aside className="agp-side agt-side" onContextMenu={onSideMenu} onKeyDown={(e) => sideKeys(e, ctx)} aria-label="Threads">
          <PageSidebar ctx={ctx} phone={phone} onClose={() => (phone ? onDrawer(false) : ctx.hide())} />
        </aside>
      )}
      <main className="agp-main nb-main">{children}</main>
    </div>
  )
})

function PageSidebar({ ctx, phone, onClose }: { ctx: SideCtx; phone: boolean; onClose: () => void }) {
  const model = useSidebarModel(ctx)
  const [searching, setSearching] = useState(() => !!ctx.q)
  const searchWrap = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (searching) searchWrap.current?.querySelector('input')?.focus()
  }, [searching])
  const row = (t: Thread) => (
    <ThreadRow key={t.id} ctx={ctx} t={t} itemClass="agp-item">
      <span className="agp-item-title">
        <Scramble text={t.title} pending={titlePending(t)} />
      </span>
      {t.running && <span className="agp-running" aria-label="Answering" title="Answering" />}
      {!t.running && ctx.isUnread(t) && <span className="agp-unread" aria-label="New answer" title="New answer" />}
      {t.pinned && (
        <span className="agt-pin" title="Pinned" aria-label="Pinned">
          <Icon name="pin" size={11} />
        </span>
      )}
    </ThreadRow>
  )
  const place = (on: boolean) => (on ? 'is-on' : '')
  return (
    <>
      <div className="agp-side-head">
        <a
          className="agp-brand"
          href="/agents"
          onClick={(e) => {
            if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return
            e.preventDefault()
            ctx.newThread()
          }}
        >
          Agents
        </a>
        <button type="button" className="agt-icon" onClick={onClose} aria-label={phone ? 'Close the sidebar' : 'Hide the sidebar'} title={phone ? 'Close' : 'Hide the sidebar'}>
          <Icon name={phone ? 'close' : 'sidebar'} size={phone ? 18 : 16} />
        </button>
      </div>
      <nav className="agp-nav">
        <button type="button" onClick={ctx.newThread}>
          <Icon name="compose" size={16} /> <span>New chat</span>
        </button>
        <button type="button" className={place(searching)} onClick={() => (searching && ctx.q ? ctx.setQ('') : undefined, setSearching((s) => !s))} aria-expanded={searching}>
          <Icon name="search" size={16} /> <span>Search chats</span>
        </button>
        {searching && (
          <div ref={searchWrap} className="agp-search">
            <SearchBox ctx={ctx} />
          </div>
        )}
        <button type="button" className={place(ctx.mainKind === 'tasks')} onClick={ctx.openTasks} title="Background tasks: agents that run on their own and report back">
          <Icon name="tasks" size={16} /> <span>Tasks</span>
          <TaskBadge badge={ctx.taskBadge} />
        </button>
        <button type="button" onClick={ctx.openStudio} title="The Image Studio, in MvL OS (a new tab)">
          <Icon name="studio" size={16} /> <span>Images</span>
        </button>
        <button type="button" className={place(ctx.mainKind === 'memory')} onClick={() => ctx.openMemory(null)} title="What the agent remembers">
          <Icon name="memory" size={16} /> <span>Memory</span>
        </button>
        <button type="button" className={place(ctx.archived)} onClick={ctx.toggleArchived} title="Archived threads">
          <Icon name="archive" size={16} /> <span>Archived</span>
        </button>
        <button type="button" className={place(ctx.mainKind === 'settings')} onClick={ctx.openSettings} title="Agents settings">
          <Icon name="gear" size={16} /> <span>Settings</span>
        </button>
      </nav>
      <ArchivedTitle ctx={ctx} />
      <List ctx={ctx}>
        <ProjectsSection ctx={ctx} model={model} row={row} />
        <ThreadsSection ctx={ctx} model={model} row={row} header={<GroupHeader title={ctx.archived ? 'Archived' : 'Recents'} />} day={() => null} />
      </List>
      <AccountChip />
    </>
  )
}

/** The account at the bottom of the sidebar: light or dark, MvL OS itself, and signing out. */
function AccountChip() {
  const account = useAccount()
  const theme = useTheme()
  const user = account.user
  if (!user) return null
  const name = user.name || user.login
  return (
    <div className="agp-account">
      <button
        type="button"
        className="agp-account-chip"
        onClick={(e) =>
          openMenuAt(
            e.currentTarget,
            [
              { label: theme.palette.mode === 'light' ? 'Dark theme' : 'Light theme', hint: theme.label, onSelect: toggleMode },
              { label: 'Open MvL OS', hint: 'The desktop this comes from, in a new tab', onSelect: () => void window.open('/', '_blank', 'noopener') },
              { separator: true },
              { label: 'Sign out', onSelect: () => void signOut() },
            ],
            'above',
          )
        }
        aria-label={`${name}: account`}
      >
        {user.avatar ? <img className="agp-avatar" src={user.avatar} alt="" /> : <span className="agp-avatar is-letter">{name.slice(0, 1).toUpperCase()}</span>}
        <span className="agp-account-name">{name}</span>
        <Icon name="more" size={14} />
      </button>
    </div>
  )
}
