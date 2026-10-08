import { useEffect, useState, type ComponentType } from 'react'
import type { WinState } from '../../os/wm'
import { Breakout } from './Breakout'
import { GAME_CATALOG } from './catalog'
import { Minecraft } from './Minecraft'
import { Minesweeper } from './Minesweeper'
import { PacMan } from './PacMan'
import { Pool } from './Pool'
import { Snake } from './Snake'
import { Tetris } from './Tetris'

const COMPONENTS: Record<string, ComponentType<{ win: WinState }>> = {
  'tetris': Tetris,
  'pacman': PacMan,
  'minecraft': Minecraft,
  'snake': Snake,
  'minesweeper': Minesweeper,
  'breakout': Breakout,
  'pool': Pool,
}

export const GAMES = GAME_CATALOG.map((g) => ({ ...g, component: COMPONENTS[g.id] }))

function readBest(id: string) {
  try {
    const all = JSON.parse(localStorage.getItem('mvlos.highscores.v1') ?? '{}')
    if (id === 'minesweeper') return all['minesweeper-easy'] !== undefined ? `${all['minesweeper-easy']}s` : null
    if (id === 'minecraft') return 'touch grass'
    if (id === 'pool') return all.pool !== undefined ? `${all.pool} ${all.pool === 1 ? 'win' : 'wins'}` : null
    return all[id] ?? null
  } catch {
    return null
  }
}

export function Games({ win }: { win: WinState }) {
  const [game, setGame] = useState<string | undefined>(win.props.game)
  useEffect(() => setGame(win.props.game), [win.props])
  const current = GAMES.find((g) => g.id === game)

  if (current) {
    const Game = current.component
    return (
      <div className="games-play">
        <div className="games-top">
          <button className="back" onClick={() => setGame(undefined)}>
            ← All games
          </button>
          <span className="games-title">
            {current.glyph} {current.name}
          </span>
        </div>
        <Game key={current.id} win={win} />
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
