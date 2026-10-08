import { useState } from 'react'
import type { WinState } from '../../os/wm'
import { keyToDir, swipeHandlers, useGameKeys, useHighScore, type Dir } from './shared'

// Tiles keep an id across moves so React can slide them with a CSS transition.
type Tile = { id: number; v: number; r: number; c: number; merged?: boolean; fresh?: boolean }

let nextId = 1

function addRandom(tiles: Tile[]): Tile[] {
  const free: [number, number][] = []
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) if (!tiles.some((t) => t.r === r && t.c === c)) free.push([r, c])
  if (!free.length) return tiles
  const [r, c] = free[Math.floor(Math.random() * free.length)]
  return [...tiles, { id: nextId++, v: Math.random() < 0.9 ? 2 : 4, r, c, fresh: true }]
}

const start = () => addRandom(addRandom([]))

/** Slides every row/column towards `dir`, merging equal neighbours once per move. */
function move(tiles: Tile[], dir: Dir): { tiles: Tile[]; gained: number; moved: boolean } {
  const vertical = dir === 'up' || dir === 'down'
  const forward = dir === 'right' || dir === 'down'
  let gained = 0
  let moved = false
  const out: Tile[] = []
  for (let line = 0; line < 4; line++) {
    const row = tiles
      .filter((t) => (vertical ? t.c : t.r) === line)
      .sort((a, b) => (vertical ? a.r - b.r : a.c - b.c) * (forward ? -1 : 1))
    let pos = 0
    let last: Tile | null = null
    for (const t of row) {
      if (last && last.v === t.v && !last.merged) {
        last.v *= 2
        last.merged = true
        gained += last.v
        moved = true
        continue
      }
      const target = forward ? 3 - pos : pos
      const nt: Tile = { id: t.id, v: t.v, r: vertical ? target : line, c: vertical ? line : target }
      if (nt.r !== t.r || nt.c !== t.c) moved = true
      out.push(nt)
      last = nt
      pos++
    }
  }
  return { tiles: out, gained, moved }
}

const canMove = (tiles: Tile[]) => tiles.length < 16 || (['up', 'down', 'left', 'right'] as Dir[]).some((d) => move(tiles.map((t) => ({ ...t })), d).moved)

export function Game2048({ win }: { win: WinState }) {
  const [tiles, setTiles] = useState<Tile[]>(start)
  const [score, setScore] = useState(0)
  const [over, setOver] = useState(false)
  const [won, setWon] = useState(false)
  const [keepGoing, setKeepGoing] = useState(false)
  const { best, submit } = useHighScore('2048')

  const restart = () => {
    setTiles(start())
    setScore(0)
    setOver(false)
    setWon(false)
    setKeepGoing(false)
  }

  const play = (d: Dir) => {
    if (over || (won && !keepGoing)) return
    const res = move(tiles.map((t) => ({ ...t })), d)
    if (!res.moved) return
    const next = addRandom(res.tiles)
    const total = score + res.gained
    setTiles(next)
    setScore(total)
    if (!won && next.some((t) => t.v === 2048)) {
      setWon(true)
      submit(total)
    }
    if (!canMove(next)) {
      setOver(true)
      submit(total)
    }
  }

  useGameKeys(win, (e) => {
    const d = keyToDir(e.key)
    if (d) play(d)
    else if (e.key === 'r') restart()
  })

  return (
    <div className="game game-2048">
      <div className="game-bar">
        <span>
          Score <strong>{score}</strong>
        </span>
        <span className="muted">Best {Math.max(best ?? 0, score) || '—'}</span>
        <button className="btn btn-small" onClick={restart}>
          New game
        </button>
      </div>
      <div className="g2048" {...swipeHandlers(play, false)}>
        {Array.from({ length: 16 }, (_, i) => (
          <span key={i} className="g2048-slot" />
        ))}
        {tiles.map((t) => (
          <span key={t.id} className={`g2048-tile v${Math.min(t.v, 4096)} ${t.merged ? 'is-merged' : ''} ${t.fresh ? 'is-fresh' : ''}`} style={{ ['--r' as string]: t.r, ['--c' as string]: t.c }}>
            {t.v}
          </span>
        ))}
        {(over || (won && !keepGoing)) && (
          <div className="game-overlay g2048-overlay">
            <strong>{won && !over ? 'You made 2048!' : 'No moves left'}</strong>
            <span>Score {score}</span>
            <div className="actions">
              {won && !over && (
                <button className="btn" onClick={() => setKeepGoing(true)}>
                  Keep going
                </button>
              )}
              <button className="btn btn-primary" onClick={restart}>
                New game
              </button>
            </div>
          </div>
        )}
      </div>
      <p className="game-hint muted">Arrows / WASD or swipe. Equal tiles merge.</p>
    </div>
  )
}
