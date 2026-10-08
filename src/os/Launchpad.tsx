import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { openSticky } from '../apps/Sticky'
import { GAME_CATALOG } from '../apps/games/catalog'
import { faviconOf, launch as launchLink, useLaunchers } from '../data/launchers'
import { createNote } from '../data/notes'
import { contributions, profile, projects } from '../data/profile'
import { APP_META } from './apps'
import { appearanceMenu } from './appearanceMenu'
import { openContextMenu, type MenuItem } from './ContextMenu'
import { isDockableApp, launcherDockId, pinToDock, unpinFromDock, useCanCustomizeDock, useDock, type DockId } from './dockItems'
import { resetLayout } from './desktopStore'
import { DOCK_MODES, getDockMode, setDockMode } from './dockPrefs'
import { AppIcon } from './icons'
import { setOverlay } from './overlays'
import { reboot, shutdown } from './powerState'
import { SINGLE_INSTANCE, useWM, type AppId } from './wm'

// The "All apps" launcher, modelled on Omarchy's menu (Super + Alt + Space): a small "Go…" list
// of categories that open into submenus. Typing searches every entry at once. Ctrl+K's
// Spotlight is the separate, bigger search for files, maths and status.

type Entry = {
  label: string
  icon?: ReactNode
  /** Leaf: what choosing it does. */
  run?: () => void
  /** Ctrl+Enter / right half: open another window. */
  runNew?: () => void
  /** Branch: its entries, built when opened so they reflect the current state. */
  children?: () => Entry[]
  checked?: boolean
  swatch?: string
  /** Right-click pins it to the dock or takes it off (signed in). */
  dockId?: DockId
}

const APP_ORDER: AppId[] = ['terminal', 'files', 'zed', 'projects', 'recents', 'cv', 'games', 'notebook', 'contact', 'notes', 'keys', 'settings', 'trash']

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' } as const
const Icon = ({ children }: { children: ReactNode }) => (
  <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden {...stroke}>
    {children}
  </svg>
)
const ICONS = {
  apps: (
    <Icon>
      <path d="M5 5h2v2H5zM11 5h2v2h-2zM17 5h2v2h-2zM5 11h2v2H5zM11 11h2v2h-2zM17 11h2v2h-2zM5 17h2v2H5zM11 17h2v2h-2zM17 17h2v2h-2z" />
    </Icon>
  ),
  launchers: (
    <Icon>
      <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </Icon>
  ),
  games: (
    <Icon>
      <path d="M7 8h10a4 4 0 0 1 4 4v1a4 4 0 0 1-7 2.6L13 14h-2l-1 1.6A4 4 0 0 1 3 13v-1a4 4 0 0 1 4-4zM8 10.5v3M6.5 12h3" />
    </Icon>
  ),
  projects: (
    <Icon>
      <path d="M12 3l9 5-9 5-9-5zM3 13l9 5 9-5" />
    </Icon>
  ),
  learn: (
    <Icon>
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5zM4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5" />
    </Icon>
  ),
  style: (
    <Icon>
      <path d="M4 20l10-10M14 4v2M14 12v2M10 8h-2M20 8h-2M17 5l-1.5 1.5M17 11l-1.5-1.5" />
    </Icon>
  ),
  setup: (
    <Icon>
      <path d="M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </Icon>
  ),
  about: (
    <Icon>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </Icon>
  ),
  system: (
    <Icon>
      <path d="M12 3v8M6.3 6.8a8 8 0 1 0 11.4 0" />
    </Icon>
  ),
}

/** Context-menu items (the Appearance menu) as launcher entries. */
const fromMenu = (items: MenuItem[]): Entry[] =>
  items.flatMap((m) =>
    'separator' in m ? [] : [{ label: m.label, checked: m.checked, swatch: m.swatch, run: m.onSelect, children: m.submenu ? () => fromMenu(m.submenu!) : undefined }],
  )

const link = (url: string) => () => window.open(url, '_blank', 'noopener')

export function Launchpad() {
  const wm = useWM()
  const [path, setPath] = useState<Entry[]>([])
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const close = () => setOverlay(null)
  const launchers = useLaunchers()
  const dock = useDock()
  const canPin = useCanCustomizeDock()

  useEffect(() => input.current?.focus(), [])

  const root = useMemo<Entry[]>(
    () => [
      {
        label: 'Apps',
        icon: ICONS.apps,
        children: () =>
          APP_ORDER.filter((a) => APP_META[a]).map((app) => ({
            label: APP_META[app].dock,
            icon: <AppIcon app={app} size={16} tone />,
            run: () => wm.open(app),
            runNew: SINGLE_INSTANCE.has(app) ? undefined : () => wm.openNew(app),
            dockId: isDockableApp(app) ? app : undefined,
          })),
      },
      // Your own links (Settings → Launchers), when there are any.
      ...(launchers.length
        ? [
            {
              label: 'Launchers',
              icon: ICONS.launchers,
              children: () =>
                launchers.map((l) => ({
                  label: l.label,
                  icon: l.glyph ? <span className="om-glyph">{l.glyph}</span> : <img className="al-fav" src={faviconOf(l.url)} alt="" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} />,
                  run: () => launchLink(l),
                  dockId: launcherDockId(l.id),
                })),
            },
          ]
        : []),
      {
        label: 'Games',
        icon: ICONS.games,
        children: () => GAME_CATALOG.map((g) => ({ label: g.name, icon: <span className="om-glyph">{g.glyph}</span>, run: () => wm.openNew('games', { game: g.id }) })),
      },
      {
        label: 'Projects',
        icon: ICONS.projects,
        children: () => [
          ...projects.map((p) => ({ label: p.name, run: () => wm.open('projects', { slug: p.slug }) })),
          ...contributions.map((c) => ({ label: `${c.owner}/${c.slug}`, run: () => wm.open('projects', { slug: c.slug }) })),
        ],
      },
      {
        label: 'Learn',
        icon: ICONS.learn,
        children: () => [
          { label: 'CV', run: () => wm.open('cv') },
          { label: 'Keyboard shortcuts', run: () => wm.open('keys') },
          { label: 'Terminal commands', run: () => wm.openNew('terminal', { run: 'help' }) },
          { label: 'Recent activity', run: () => wm.open('recents') },
          { label: 'Source code', run: link('https://github.com/vleeuwenmenno/mennovanleeuwen.nl') },
          { label: 'GitHub', run: link(`https://github.com/${profile.github}`) },
        ],
      },
      { label: 'Style', icon: ICONS.style, children: () => fromMenu(appearanceMenu()) },
      {
        label: 'Setup',
        icon: ICONS.setup,
        children: () => [
          { label: 'Dock', children: () => DOCK_MODES.map(([m, label]) => ({ label, checked: getDockMode() === m, run: () => setDockMode(m) })) },
          { label: 'Settings', run: () => wm.open('settings') },
          { label: 'New sticky note', run: () => openSticky(wm, createNote().id) },
          { label: 'Clean up desktop icons', run: resetLayout },
          { label: 'Show desktop', run: () => wm.windows.forEach((w) => wm.minimize(w.pid)) },
          { label: 'New terminal', run: () => wm.openNew('terminal') },
        ],
      },
      { label: 'About', icon: ICONS.about, run: () => wm.open('terminal', { run: 'fastfetch', t: String(Date.now()) }) },
      {
        label: 'System',
        icon: ICONS.system,
        children: () => [
          { label: 'Reboot', run: reboot },
          { label: 'Shut down', run: shutdown },
        ],
      },
    ],
    [wm, launchers],
  )

  const level = path.length ? path[path.length - 1].children!() : root
  // Typing searches every entry below where you are, showing where each one lives.
  const rows = useMemo(() => {
    const query = q.trim().toLowerCase()
    if (!query) return level.map((e) => ({ e, where: '' }))
    const out: { e: Entry; where: string }[] = []
    const walk = (entries: Entry[], where: string) => {
      for (const e of entries) {
        if (e.label.toLowerCase().includes(query) && (e.run || e.children)) out.push({ e, where })
        if (e.children) walk(e.children(), where ? `${where} › ${e.label}` : e.label)
      }
    }
    walk(level, path.map((p) => p.label).join(' › '))
    return out.sort((a, b) => Number(!a.e.label.toLowerCase().startsWith(query)) - Number(!b.e.label.toLowerCase().startsWith(query)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, path, root])

  useEffect(() => setActive(0), [q, path])
  useEffect(() => {
    list.current?.querySelector('.om-row.is-active')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const choose = (e: Entry, fresh = false) => {
    if (e.children && !(fresh && e.run)) {
      setPath((p) => [...p, e])
      setQ('')
      return
    }
    close()
    ;(fresh && e.runNew ? e.runNew : e.run)?.()
  }
  const back = () => {
    setPath((p) => p.slice(0, -1))
    setQ('')
  }

  const title = path.length ? `${path[path.length - 1].label}…` : 'Go…'
  return (
    <div className="om-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div
        className="om-panel"
        role="dialog"
        aria-label="All apps"
        onKeyDown={(ev) => {
          if (ev.key === 'Escape') close()
          else if (ev.key === 'ArrowDown') setActive((a) => Math.min(rows.length - 1, a + 1))
          else if (ev.key === 'ArrowUp') setActive((a) => Math.max(0, a - 1))
          else if ((ev.key === 'Enter' || (ev.key === 'ArrowRight' && rows[active]?.e.children)) && rows[active]) choose(rows[active].e, ev.ctrlKey || ev.metaKey)
          else if ((ev.key === 'ArrowLeft' || ev.key === 'Backspace') && !q && path.length) back()
          else return
          ev.preventDefault()
        }}
      >
        <div className="om-head">
          {path.length > 0 && (
            <button className="om-back" onClick={back} aria-label="Back">
              ‹
            </button>
          )}
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder={title} aria-label={title} spellCheck={false} autoComplete="off" />
        </div>
        <div className="om-list" ref={list} role="listbox">
          {rows.map(({ e, where }, i) => (
            <button
              key={`${where}/${e.label}`}
              role="option"
              aria-selected={i === active}
              className={`om-row ${i === active ? 'is-active' : ''}`}
              onPointerMove={() => setActive(i)}
              onClick={(ev) => choose(e, ev.ctrlKey || ev.metaKey)}
              onContextMenu={(ev) => {
                const id = e.dockId
                if (!canPin || !id) return
                const pinned = dock.includes(id)
                openContextMenu(ev, [
                  { label: 'Open', onSelect: () => choose(e) },
                  ...(e.runNew ? [{ label: 'Open in new window', onSelect: () => choose(e, true) }] : []),
                  { separator: true },
                  { label: pinned ? 'Remove from dock' : 'Pin to dock', onSelect: () => (pinned ? unpinFromDock : pinToDock)(id) },
                ])
              }}
            >
              <span className="om-icon">{e.swatch ? <span className="om-swatch" style={{ background: e.swatch }} /> : e.icon}</span>
              <span className="om-label">
                {e.label}
                {where && <span className="om-where">{where}</span>}
              </span>
              {e.checked && <span className="om-check">✓</span>}
              {e.children && <span className="om-more">›</span>}
            </button>
          ))}
          {!rows.length && <p className="om-empty">Nothing called “{q}”. Ctrl+K searches files and more.</p>}
        </div>
      </div>
    </div>
  )
}
