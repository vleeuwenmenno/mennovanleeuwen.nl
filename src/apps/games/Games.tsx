import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ComponentType } from 'react'
import { openContextMenu, type MenuItem } from '../../os/ContextMenu'
import { notify } from '../../os/notify'
import { playUrl } from '../../os/playMode'
import { useWM, type WinState } from '../../os/wm'
import { Breakout } from './Breakout'
import { GAME_CATALOG } from './catalog'
import { bestGladiatorLevel } from './gladiator/saves'
import { highScores } from './shared'
import { holdSession, newSession } from './session'
import { Minecraft } from './Minecraft'
import { Minesweeper } from './Minesweeper'
import { PacMan } from './PacMan'
import { Pool } from './Pool'
import { Snake } from './Snake'
import { Tetris } from './Tetris'

// Gladiator and Empires At War are big (art, rules, sound), so they load only when picked.
const Gladiator = lazy(() => import('./Gladiator').then((m) => ({ default: m.Gladiator })))
const EmpiresAtWar = lazy(() => import('./EmpiresAtWar').then((m) => ({ default: m.EmpiresAtWar })))

const COMPONENTS: Record<string, ComponentType<{ win: WinState }>> = {
  'tetris': Tetris,
  'pacman': PacMan,
  'minecraft': Minecraft,
  'snake': Snake,
  'minesweeper': Minesweeper,
  'breakout': Breakout,
  'pool': Pool,
  'gladiator': Gladiator,
  'empires': EmpiresAtWar,
}

export const GAMES = GAME_CATALOG.map((g) => ({ ...g, component: COMPONENTS[g.id] }))

export function readBest(id: string) {
  try {
    const all = highScores.get()
    if (id === 'minesweeper') return all['minesweeper-easy'] !== undefined ? `${all['minesweeper-easy']}s` : null
    if (id === 'minecraft') return 'touch grass'
    if (id === 'empires') return all.empires !== undefined ? `${all.empires} ${all.empires === 1 ? 'victory' : 'victories'}` : null
    if (id === 'pool') return all.pool !== undefined ? `${all.pool} ${all.pool === 1 ? 'win' : 'wins'}` : null
    if (id === 'gladiator') {
      const top = bestGladiatorLevel()
      return top ? `level ${top}` : null
    }
    return all[id] ?? null
  } catch {
    return null
  }
}

/**
 * "Fullscreen" for a game inside the OS: the game panel covers the whole page, hiding the top
 * bar, dock and window frame. Not the browser's own fullscreen, which would take over the
 * monitor. Esc or the button brings the window back.
 */
function useGameFullscreen() {
  const [on, setOn] = useState(false)
  useEffect(() => {
    if (!on) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOn(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [on])
  const exit = useCallback(() => setOn(false), [])
  const enter = useCallback(() => setOn(true), [])
  return { on, toggle: () => setOn((v) => !v), enter, exit }
}

/**
 * The game bar (name and fullscreen) shows for a moment when the game opens, then gets out of the
 * way. Shown again by hovering the top edge or tapping the handle, it hides by itself after a few
 * seconds, or once the mouse leaves it.
 */
export function useGameBar() {
  const [shown, setShown] = useState(true)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const later = useCallback((ms: number) => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setShown(false), ms)
  }, [])
  useEffect(() => {
    later(2500)
    return () => void (timer.current && clearTimeout(timer.current))
  }, [later])
  const show = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    setShown(true)
  }, [])
  const hideSoon = useCallback(() => later(700), [later])
  const toggle = useCallback(() => {
    if (shown) {
      if (timer.current) clearTimeout(timer.current)
      setShown(false)
    } else {
      setShown(true)
      later(5000)
    }
  }, [shown, later])
  return { shown, show, hideSoon, toggle }
}

/** Games that start in fullscreen on a phone, where a window leaves them too little room. */
const FULL_ON_PHONES = new Set(['empires'])
const isPhone = () => window.innerWidth < 720 || (window.matchMedia('(pointer: coarse)').matches && Math.min(window.innerWidth, window.innerHeight) < 500)

export const FullscreenIcon = ({ on }: { on: boolean }) => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {on ? <path d="M6 1v5H1M10 1v5h5M6 15v-5H1M10 15v-5h5" /> : <path d="M1 6V1h5M15 6V1h-5M1 10v5h5M15 10v5h-5" />}
  </svg>
)

/**
 * A game's direct link (/play/<game>, Play.tsx): the game on a page of its own, without MvL OS.
 * In the game window's menu and on its card in the arcade.
 */
export function gameLinkItems(id: string): MenuItem[] {
  const url = playUrl(id)
  return [
    {
      label: 'Copy direct link',
      onSelect: () =>
        void navigator.clipboard?.writeText(url).then(
          () => notify({ title: 'Link copied', body: url, transient: true }),
          () => notify({ title: 'Could not copy the link', body: url, transient: true }),
        ),
    },
    { label: 'Open without MvL OS', onSelect: () => window.open(url, '_blank', 'noopener') },
  ]
}

/**
 * The Games app: the arcade (a window without props.game), or one game in a window of its own
 * (props.game, titled with the game's name). Picking a game in the arcade opens its window, or
 * brings it forward when it's already open: one window per game, since two copies of a game would
 * share its storage.
 */
export function Games({ win }: { win: WinState }) {
  const current = GAMES.find((g) => g.id === win.props.game)
  return current ? <GameWindow win={win} game={current} /> : <Arcade />
}

function GameWindow({ win, game }: { win: WinState; game: (typeof GAMES)[number] }) {
  const wm = useWM()
  const session = win.props.session
  // A game window without a session (opened just now, or saved before windows had them) gets one
  // before the game starts, so what the game keeps is tied to this window from the first frame.
  useEffect(() => {
    if (!session) wm.setProps(win.pid, { session: newSession() })
  }, [session, wm, win.pid])
  // Closing the window ends the game: what it kept to carry on after a reload goes with it.
  useEffect(() => (session ? holdSession(session) : undefined), [session])
  const full = useGameFullscreen()
  const { exit, enter } = full
  // Closing the window also leaves fullscreen.
  useEffect(() => exit, [exit])
  // On a phone, some games open straight into fullscreen; the button still brings the window back.
  useEffect(() => {
    if (FULL_ON_PHONES.has(game.id) && isPhone()) enter()
  }, [game.id, enter])

  const bar = useGameBar()

  if (!session) return null
  const Game = game.component
  return (
    <div className={`games-play ${full.on ? 'is-page-full' : ''} ${bar.shown ? 'is-bar' : ''}`}>
      {/* The bar hides itself to leave the game the whole window: a mouse brings it back at the
          top edge, a finger with the handle hanging under it. */}
      <div className="games-hot" onPointerEnter={(e) => e.pointerType === 'mouse' && bar.show()} aria-hidden />
      <div className="games-top" onPointerEnter={(e) => e.pointerType === 'mouse' && bar.show()} onPointerLeave={(e) => e.pointerType === 'mouse' && bar.hideSoon()}>
        <span className="games-title">
          {game.glyph} {game.name}
        </span>
        <button className="games-full" onClick={full.toggle} title={full.on ? 'Back to the window (Esc)' : 'Fill the screen with the game'} aria-pressed={full.on}>
          <FullscreenIcon on={full.on} />
          <span>{full.on ? 'Exit fullscreen' : 'Fullscreen'}</span>
        </button>
        <button className="games-handle" onClick={bar.toggle} aria-label={bar.shown ? 'Hide the game bar' : 'Show the game bar'} aria-expanded={bar.shown} />
      </div>
      <Suspense fallback={<div className="game"><p className="muted">Loading…</p></div>}>
        <Game key={session} win={win} />
      </Suspense>
    </div>
  )
}

function Arcade() {
  const wm = useWM()
  return (
    <div className="games">
      <header className="games-head">
        <h2>Arcade</h2>
        <p className="muted">Small games, written for this site. Each opens in its own window; closing it ends the game. High scores stay in your browser.</p>
      </header>
      <div className="games-grid">
        {GAMES.map((g) => (
          <button
            key={g.id}
            className="game-card"
            style={{ ['--p' as string]: g.color }}
            onClick={() => wm.open('games', { game: g.id })}
            onContextMenu={(e) => openContextMenu(e, [{ label: 'Play', onSelect: () => wm.open('games', { game: g.id }) }, { separator: true }, ...gameLinkItems(g.id)])}
          >
            <span className="game-card-art">{g.glyph}</span>
            <strong>{g.name}</strong>
            <span className="muted">{g.blurb}</span>
            <span className="game-card-best">Best: {readBest(g.id) ?? '—'}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
