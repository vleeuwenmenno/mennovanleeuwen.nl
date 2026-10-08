import { useEffect, useMemo, useRef, useState } from 'react'
import { GAMES } from '../apps/games/Games'
import { APP_META } from './apps'
import { openContextMenu } from './ContextMenu'
import { AppIcon } from './icons'
import { setOverlay } from './overlays'
import { SINGLE_INSTANCE, useWM, type AppId } from './wm'

type Tile = { key: string; name: string; blurb: string; icon: React.ReactNode; open: () => void; openNew?: () => void }

const APP_ORDER: AppId[] = ['terminal', 'projects', 'recents', 'cv', 'games', 'contact', 'notes', 'trash']

/** Full-screen app launcher, like macOS Launchpad: every app and game, filterable by typing. */
export function Launchpad() {
  const wm = useWM()
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const close = () => setOverlay(null)

  useEffect(() => input.current?.focus(), [])

  const sections = useMemo(() => {
    const apps: Tile[] = APP_ORDER.map((app) => ({
      key: app,
      name: APP_META[app].dock,
      blurb: APP_META[app].blurb,
      icon: <AppIcon app={app} size={64} />,
      open: () => wm.open(app),
      openNew: SINGLE_INSTANCE.has(app) ? undefined : () => wm.openNew(app),
    }))
    const games: Tile[] = GAMES.map((g) => ({
      key: `game-${g.id}`,
      name: g.name,
      blurb: g.blurb,
      icon: (
        <span className="lp-game" style={{ ['--p' as string]: g.color }}>
          {g.glyph}
        </span>
      ),
      open: () => wm.openNew('games', { game: g.id }),
    }))
    const match = (t: Tile) => !q || `${t.name} ${t.blurb}`.toLowerCase().includes(q.toLowerCase())
    return [
      { title: 'Apps', tiles: apps.filter(match) },
      { title: 'Games', tiles: games.filter(match) },
    ].filter((s) => s.tiles.length)
  }, [q, wm])

  const flat = sections.flatMap((s) => s.tiles)
  const launch = (t: Tile, fresh = false) => {
    close()
    ;(fresh && t.openNew ? t.openNew : t.open)()
  }

  return (
    <div
      className="launchpad"
      onPointerDown={(e) => e.target === e.currentTarget && close()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') close()
        else if (e.key === 'Enter' && flat[active]) launch(flat[active], e.ctrlKey || e.metaKey)
        else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') setActive((a) => Math.min(flat.length - 1, a + (e.key === 'ArrowDown' ? 4 : 1)))
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') setActive((a) => Math.max(0, a - (e.key === 'ArrowUp' ? 4 : 1)))
        else return
        e.preventDefault()
      }}
    >
      <div className="lp-search">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
          <circle cx="11" cy="11" r="7" />
          <path d="M20 20l-3.5-3.5" />
        </svg>
        <input
          ref={input}
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setActive(0)
          }}
          placeholder="Search apps and games"
          aria-label="Search apps and games"
        />
      </div>
      <div className="lp-body" onPointerDown={(e) => e.target === e.currentTarget && close()}>
        {sections.map((s) => (
          <section key={s.title}>
            <h3 className="lp-section">{s.title}</h3>
            <div className="lp-grid">
              {s.tiles.map((t) => {
                const i = flat.indexOf(t)
                return (
                  <button
                    key={t.key}
                    className={`lp-tile ${i === active ? 'is-active' : ''}`}
                    onClick={() => launch(t)}
                    onPointerEnter={() => setActive(i)}
                    onContextMenu={(e) =>
                      openContextMenu(e, [
                        { label: 'Open', onSelect: () => launch(t) },
                        ...(t.openNew ? [{ label: 'Open in new window', onSelect: () => launch(t, true) }] : []),
                      ])
                    }
                    title={t.blurb}
                  >
                    {t.icon}
                    <span className="lp-name">{t.name}</span>
                  </button>
                )
              })}
            </div>
          </section>
        ))}
        {!flat.length && <p className="lp-empty">Nothing called “{q}”. Try Ctrl+K to search everything.</p>}
      </div>
      <p className="lp-hint">Enter opens · Ctrl+Enter new window · Esc closes · Ctrl+K searches everything</p>
    </div>
  )
}
