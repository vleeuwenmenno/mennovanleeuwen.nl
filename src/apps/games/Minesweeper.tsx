import { useEffect, useRef, useState } from 'react'
import type { WinState } from '../../os/wm'
import { useGameKeys, useHighScore } from './shared'

const LEVELS = {
  easy: { w: 9, h: 9, mines: 10, label: 'Easy' },
  medium: { w: 16, h: 16, mines: 40, label: 'Medium' },
}
type Level = keyof typeof LEVELS
type Cell = { mine: boolean; open: boolean; flag: boolean; n: number }

function emptyBoard(w: number, h: number): Cell[] {
  return Array.from({ length: w * h }, () => ({ mine: false, open: false, flag: false, n: 0 }))
}

const neighbours = (i: number, w: number, h: number) => {
  const x = i % w
  const y = Math.floor(i / w)
  const out: number[] = []
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue
      const nx = x + dx
      const ny = y + dy
      if (nx >= 0 && ny >= 0 && nx < w && ny < h) out.push(ny * w + nx)
    }
  return out
}

/** Places mines after the first click so it, and its neighbours, are always safe. */
function seed(board: Cell[], w: number, h: number, mines: number, safe: number) {
  const banned = new Set([safe, ...neighbours(safe, w, h)])
  let placed = 0
  while (placed < mines) {
    const i = Math.floor(Math.random() * board.length)
    if (board[i].mine || banned.has(i)) continue
    board[i].mine = true
    placed++
  }
  board.forEach((c, i) => (c.n = neighbours(i, w, h).filter((j) => board[j].mine).length))
}

export function Minesweeper({ win }: { win: WinState }) {
  const [level, setLevel] = useState<Level>('easy')
  const { w, h, mines } = LEVELS[level]
  const [board, setBoard] = useState(() => emptyBoard(w, h))
  const [status, setStatus] = useState<'ready' | 'playing' | 'won' | 'lost'>('ready')
  const [time, setTime] = useState(0)
  const [boom, setBoom] = useState<number | null>(null)
  const { best, submit } = useHighScore(`minesweeper-${level}`, true)
  const [newBest, setNewBest] = useState(false)
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const longPressed = useRef(false)

  const reset = (lv: Level = level) => {
    setLevel(lv)
    setBoard(emptyBoard(LEVELS[lv].w, LEVELS[lv].h))
    setStatus('ready')
    setTime(0)
    setBoom(null)
    setNewBest(false)
  }

  useGameKeys(win, (e) => {
    if (e.key === 'r' || e.key === 'F2') reset()
  })

  useEffect(() => {
    if (status !== 'playing') return
    const t = setInterval(() => setTime((s) => Math.min(999, s + 1)), 1000)
    return () => clearInterval(t)
  }, [status])

  /** Opens cells on one copy of the board, so chording several cells at once does not lose any. */
  function reveal(cells: number[]) {
    if (status === 'won' || status === 'lost') return
    const todo = cells.filter((i) => !board[i].flag && !board[i].open)
    if (!todo.length) return
    const next = board.map((c) => ({ ...c }))
    if (status === 'ready') {
      seed(next, w, h, mines, todo[0])
      setStatus('playing')
    }
    const hit = todo.find((i) => next[i].mine)
    if (hit !== undefined) {
      next.forEach((c) => c.mine && (c.open = true))
      setBoom(hit)
      setBoard(next)
      setStatus('lost')
      return
    }
    // Flood-fill open the empty region.
    const stack = [...todo]
    while (stack.length) {
      const j = stack.pop()!
      if (next[j].open || next[j].flag) continue
      next[j].open = true
      if (next[j].n === 0) stack.push(...neighbours(j, w, h).filter((k) => !next[k].open))
    }
    setBoard(next)
    if (next.every((c) => c.mine || c.open)) {
      setStatus('won')
      setNewBest(submit(time))
    }
  }

  /** Clicking an opened number with the right number of flags opens the rest (chording). */
  function chord(i: number) {
    const c = board[i]
    if (!c.open || !c.n) return
    const around = neighbours(i, w, h)
    if (around.filter((j) => board[j].flag).length !== c.n) return
    reveal(around)
  }

  function toggleFlag(i: number) {
    if (status === 'won' || status === 'lost' || board[i].open) return
    setBoard(board.map((c, j) => (j === i ? { ...c, flag: !c.flag } : c)))
  }

  const flags = board.filter((c) => c.flag).length
  const face = status === 'lost' ? '😵' : status === 'won' ? '😎' : '🙂'

  return (
    <div className="game game-mines">
      <div className="game-bar">
        <div className="seg seg-small">
          {(Object.keys(LEVELS) as Level[]).map((lv) => (
            <button key={lv} className={lv === level ? 'is-active' : ''} onClick={() => reset(lv)}>
              {LEVELS[lv].label}
            </button>
          ))}
        </div>
        <span className="muted">Best {best !== null ? `${best}s` : '—'}</span>
      </div>
      <div className="mines-panel">
        <span className="mines-lcd">{String(Math.max(0, mines - flags)).padStart(3, '0')}</span>
        <button className="mines-face" onClick={() => reset()} aria-label="New game">
          {face}
        </button>
        <span className="mines-lcd">{String(time).padStart(3, '0')}</span>
      </div>
      <div className="mines-scroll">
        <div className="mines-grid" style={{ gridTemplateColumns: `repeat(${w}, var(--cell))` }} onContextMenu={(e) => e.preventDefault()}>
          {board.map((c, i) => (
            <button
              key={i}
              className={`mine ${c.open ? 'is-open' : ''} ${c.flag ? 'is-flag' : ''} ${boom === i ? 'is-boom' : ''} n${c.n}`}
              onClick={() => {
                if (longPressed.current) return
                if (c.open) chord(i)
                else reveal([i])
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                toggleFlag(i)
              }}
              // Touch: hold to flag.
              onPointerDown={(e) => {
                longPressed.current = false
                if (e.pointerType !== 'touch') return
                pressTimer.current = setTimeout(() => {
                  longPressed.current = true
                  toggleFlag(i)
                  navigator.vibrate?.(15)
                }, 380)
              }}
              onPointerUp={() => pressTimer.current && clearTimeout(pressTimer.current)}
              onPointerLeave={() => pressTimer.current && clearTimeout(pressTimer.current)}
              aria-label={c.open ? (c.mine ? 'mine' : `${c.n}`) : c.flag ? 'flagged' : 'hidden'}
            >
              {c.open ? (c.mine ? '💣' : c.n || '') : c.flag ? '🚩' : ''}
            </button>
          ))}
        </div>
      </div>
      <p className="game-hint muted">
        {status === 'won'
          ? newBest
            ? `Cleared in ${time}s. New best!`
            : `Cleared in ${time}s.`
          : status === 'lost'
            ? 'Boom. Click the face (or press R) to try again.'
            : 'Click to dig, right-click (or hold on touch) to flag, click a number to clear around it.'}
      </p>
    </div>
  )
}
