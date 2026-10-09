import { lazy, Suspense, useCallback, useEffect, useState, type ComponentType } from 'react'
import type { WinState } from '../../os/wm'
import { Breakout } from './Breakout'
import { GAME_CATALOG } from './catalog'
import { bestGladiatorLevel } from './gladiator/saves'
import { highScores } from './shared'
import { Minecraft } from './Minecraft'
import { Minesweeper } from './Minesweeper'
import { PacMan } from './PacMan'
import { Pool } from './Pool'
import { Snake } from './Snake'
import { Tetris } from './Tetris'

// Gladiator is big (art, rules, sound), so it loads only when picked.
const Gladiator = lazy(() => import('./Gladiator').then((m) => ({ default: m.Gladiator })))

const COMPONENTS: Record<string, ComponentType<{ win: WinState }>> = {
  'tetris': Tetris,
  'pacman': PacMan,
  'minecraft': Minecraft,
  'snake': Snake,
  'minesweeper': Minesweeper,
  'breakout': Breakout,
  'pool': Pool,
  'gladiator': Gladiator,
}

export const GAMES = GAME_CATALOG.map((g) => ({ ...g, component: COMPONENTS[g.id] }))

function readBest(id: string) {
  try {
    const all = highScores.get()
    if (id === 'minesweeper') return all['minesweeper-easy'] !== undefined ? `${all['minesweeper-easy']}s` : null
    if (id === 'minecraft') return 'touch grass'
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
  return { on, toggle: () => setOn((v) => !v), exit }
}

const FullscreenIcon = ({ on }: { on: boolean }) => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {on ? <path d="M6 1v5H1M10 1v5h5M6 15v-5H1M10 15v-5h5" /> : <path d="M1 6V1h5M15 6V1h-5M1 10v5h5M15 10v5h-5" />}
  </svg>
)

export function Games({ win }: { win: WinState }) {
  const [game, setGame] = useState<string | undefined>(win.props.game)
  useEffect(() => setGame(win.props.game), [win.props])
  const current = GAMES.find((g) => g.id === game)
  const full = useGameFullscreen()
  const { exit } = full
  // Leaving a game (or closing the window) also leaves fullscreen.
  useEffect(() => exit, [game, exit])

  if (current) {
    const Game = current.component
    return (
      <div className={`games-play ${full.on ? 'is-page-full' : ''}`}>
        <div className="games-top">
          <button className="back" onClick={() => setGame(undefined)}>
            ← All games
          </button>
          <span className="games-title">
            {current.glyph} {current.name}
          </span>
          <button className="games-full" onClick={full.toggle} title={full.on ? 'Back to the window (Esc)' : 'Fill the screen with the game'} aria-pressed={full.on}>
            <FullscreenIcon on={full.on} />
            <span>{full.on ? 'Exit fullscreen' : 'Fullscreen'}</span>
          </button>
        </div>
        <Suspense fallback={<div className="game"><p className="muted">Loading…</p></div>}>
          <Game key={current.id} win={win} />
        </Suspense>
      </div>
    )
  }

  return (
    <div className="games">
      <header className="games-head">
        <h2>Arcade</h2>
        <p className="muted">Small games, written for this site. High scores stay in your browser.</p>
      </header>
      <div className="games-grid">
        {GAMES.map((g) => (
          <button key={g.id} className="game-card" style={{ ['--p' as string]: g.color }} onClick={() => setGame(g.id)}>
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
