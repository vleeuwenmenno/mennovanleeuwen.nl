import { useEffect, useState, type ComponentType } from 'react'
import type { WinState } from '../../os/wm'
import { Breakout } from './Breakout'
import { Game2048 } from './Game2048'
import { Minesweeper } from './Minesweeper'
import { Snake } from './Snake'

export const GAMES: { id: string; name: string; blurb: string; glyph: string; color: string; component: ComponentType<{ win: WinState }> }[] = [
  { id: 'snake', name: 'Snake', blurb: 'Eat, grow, do not bite yourself', glyph: '🐍', color: '#9ece6a', component: Snake },
  { id: 'minesweeper', name: 'Minesweeper', blurb: 'The reason office PCs had a mouse', glyph: '💣', color: '#7aa2f7', component: Minesweeper },
  { id: '2048', name: '2048', blurb: 'Slide, merge, reach 2048', glyph: '🔢', color: '#f6c453', component: Game2048 },
  { id: 'breakout', name: 'Breakout', blurb: 'Bounce the ball, break the wall', glyph: '🧱', color: '#f7768e', component: Breakout },
]

function readBest(id: string) {
  try {
    const all = JSON.parse(localStorage.getItem('mvlos.highscores.v1') ?? '{}')
    if (id === 'minesweeper') return all['minesweeper-easy'] !== undefined ? `${all['minesweeper-easy']}s` : null
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
        <p className="muted">Four small games, written for this site. High scores stay in your browser.</p>
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
