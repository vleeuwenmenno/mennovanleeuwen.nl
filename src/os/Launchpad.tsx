import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { GAMES } from '../apps/games/Games'
import { APP_META } from './apps'
import { openContextMenu } from './ContextMenu'
import { resetLayout } from './desktopStore'
import { AppIcon } from './icons'
import { setOverlay } from './overlays'
import { toggleMode, themeSettings } from './theme'
import { SINGLE_INSTANCE, useWM, type AppId } from './wm'

// The "All apps" launcher, laid out like Omarchy Spotlight: one search field, Applications and
// Commands sections, a type label per row and the highlighted row's name in the accent colour.

type Row = { key: string; section: 'Applications' | 'Games' | 'Commands'; name: string; detail?: string; kind: string; icon: ReactNode; run: () => void; runNew?: () => void }

const APP_ORDER: AppId[] = ['terminal', 'files', 'projects', 'recents', 'cv', 'games', 'contact', 'notes', 'trash']

export function Launchpad() {
  const wm = useWM()
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const close = () => setOverlay(null)

  useEffect(() => input.current?.focus(), [])

  const rows = useMemo<Row[]>(() => {
    const apps: Row[] = APP_ORDER.filter((a) => APP_META[a]).map((app) => ({
      key: app,
      section: 'Applications',
      name: APP_META[app].dock,
      detail: APP_META[app].blurb,
      kind: 'App',
      icon: <AppIcon app={app} size={20} />,
      run: () => wm.open(app),
      runNew: SINGLE_INSTANCE.has(app) ? undefined : () => wm.openNew(app),
    }))
    const games: Row[] = GAMES.map((g) => ({
      key: `game-${g.id}`,
      section: 'Games',
      name: g.name,
      detail: g.blurb,
      kind: 'Game',
      icon: <span className="al-glyph">{g.glyph}</span>,
      run: () => wm.openNew('games', { game: g.id }),
    }))
    const dark = themeSettings().name && document.documentElement.dataset.mode === 'dark'
    const commands: Row[] = [
      { key: 'cmd-terminal', section: 'Commands', name: 'New terminal', detail: 'Open another shell', kind: 'Command', icon: <span className="al-glyph">›_</span>, run: () => wm.openNew('terminal') },
      { key: 'cmd-theme', section: 'Commands', name: dark ? 'Day mode' : 'Night mode', detail: 'Switch between the light and dark theme', kind: 'Command', icon: <span className="al-glyph">{dark ? '☀' : '☾'}</span>, run: toggleMode },
      { key: 'cmd-search', section: 'Commands', name: 'Search everything', detail: 'Files, status, projects (Ctrl+K)', kind: 'Command', icon: <span className="al-glyph">⌕</span>, run: () => setTimeout(() => setOverlay('spotlight'), 0) },
      { key: 'cmd-minimize', section: 'Commands', name: 'Show desktop', detail: 'Minimize every window', kind: 'Command', icon: <span className="al-glyph">▁</span>, run: () => wm.windows.forEach((w) => wm.minimize(w.pid)) },
      { key: 'cmd-cleanup', section: 'Commands', name: 'Clean up icons', detail: 'Put desktop icons back in order', kind: 'Command', icon: <span className="al-glyph">▤</span>, run: resetLayout },
    ]
    const query = q.trim().toLowerCase()
    const match = (r: Row) => !query || `${r.name} ${r.detail ?? ''} ${r.kind}`.toLowerCase().includes(query)
    // Name matches first, then description matches.
    const rank = (r: Row) => (!query ? 0 : r.name.toLowerCase().startsWith(query) ? 0 : r.name.toLowerCase().includes(query) ? 1 : 2)
    return [...apps, ...games, ...commands].filter(match).sort((a, b) => (query ? rank(a) - rank(b) : 0))
  }, [q, wm])

  const sections = query(rows)
  const flat = sections.flatMap((s) => s.rows)
  useEffect(() => setActive(0), [q])
  useEffect(() => {
    list.current?.querySelector('.al-row.is-active')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const launch = (r: Row, fresh = false) => {
    close()
    ;(fresh && r.runNew ? r.runNew : r.run)()
  }

  return (
    <div className="al-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div
        className="al-panel"
        role="dialog"
        aria-label="All apps"
        onKeyDown={(e) => {
          if (e.key === 'Escape') close()
          else if (e.key === 'ArrowDown') setActive((a) => Math.min(flat.length - 1, a + 1))
          else if (e.key === 'ArrowUp') setActive((a) => Math.max(0, a - 1))
          else if (e.key === 'Enter' && flat[active]) launch(flat[active], e.ctrlKey || e.metaKey)
          else return
          e.preventDefault()
        }}
      >
        <div className="al-search">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search for apps and commands…" aria-label="Search for apps and commands" spellCheck={false} autoComplete="off" />
        </div>
        <div className="al-list" ref={list}>
          {sections.map((s) => (
            <section key={s.title}>
              <p className="al-section">{s.title}</p>
              {s.rows.map((r) => {
                const i = flat.indexOf(r)
                return (
                  <button
                    key={r.key}
                    className={`al-row ${i === active ? 'is-active' : ''}`}
                    onPointerMove={() => setActive(i)}
                    onClick={(e) => launch(r, e.ctrlKey || e.metaKey)}
                    onContextMenu={(e) =>
                      openContextMenu(e, [
                        { label: 'Open', onSelect: () => launch(r) },
                        ...(r.runNew ? [{ label: 'Open in new window', onSelect: () => launch(r, true) }] : []),
                      ])
                    }
                  >
                    <span className="al-icon">{r.icon}</span>
                    <span className="al-name">{r.name}</span>
                    {r.detail && <span className="al-detail">{r.detail}</span>}
                    <span className="al-kind">{r.kind}</span>
                  </button>
                )
              })}
            </section>
          ))}
          {!flat.length && <p className="al-empty">Nothing called “{q}”. Ctrl+K searches files and more.</p>}
        </div>
        <footer className="al-foot">
          <span className="al-brand">
            <svg viewBox="0 0 64 64" width="11" height="11" aria-hidden>
              <path d="M14 46V18l18 16 18-16v28" fill="none" stroke="currentColor" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            MvL OS
          </span>
          <span>
            {flat[active]?.runNew && <span className="al-hint">ctrl ↵ new window</span>}↵ Open
          </span>
        </footer>
      </div>
    </div>
  )
}

function query(rows: Row[]) {
  const order: Row['section'][] = ['Applications', 'Games', 'Commands']
  return order.map((title) => ({ title, rows: rows.filter((r) => r.section === title) })).filter((s) => s.rows.length)
}
