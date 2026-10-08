import { useCallback, useEffect, useRef, useState } from 'react'
import type { WinState } from '../../os/wm'
import { useGameKeys, useHighScore } from './shared'

const COLS = 10
const ROWS = 20
const CELL = 24

type Kind = 'I' | 'O' | 'T' | 'S' | 'Z' | 'J' | 'L'
type Piece = { kind: Kind; rot: number; x: number; y: number }

// Each piece lists its four rotation states as [x, y] cells inside a 4x4 box.
const SHAPES: Record<Kind, [number, number][][]> = {
  I: [[[0, 1], [1, 1], [2, 1], [3, 1]], [[2, 0], [2, 1], [2, 2], [2, 3]], [[0, 2], [1, 2], [2, 2], [3, 2]], [[1, 0], [1, 1], [1, 2], [1, 3]]],
  O: [[[1, 0], [2, 0], [1, 1], [2, 1]], [[1, 0], [2, 0], [1, 1], [2, 1]], [[1, 0], [2, 0], [1, 1], [2, 1]], [[1, 0], [2, 0], [1, 1], [2, 1]]],
  T: [[[1, 0], [0, 1], [1, 1], [2, 1]], [[1, 0], [1, 1], [2, 1], [1, 2]], [[0, 1], [1, 1], [2, 1], [1, 2]], [[1, 0], [0, 1], [1, 1], [1, 2]]],
  S: [[[1, 0], [2, 0], [0, 1], [1, 1]], [[1, 0], [1, 1], [2, 1], [2, 2]], [[1, 1], [2, 1], [0, 2], [1, 2]], [[0, 0], [0, 1], [1, 1], [1, 2]]],
  Z: [[[0, 0], [1, 0], [1, 1], [2, 1]], [[2, 0], [1, 1], [2, 1], [1, 2]], [[0, 1], [1, 1], [1, 2], [2, 2]], [[1, 0], [0, 1], [1, 1], [0, 2]]],
  J: [[[0, 0], [0, 1], [1, 1], [2, 1]], [[1, 0], [2, 0], [1, 1], [1, 2]], [[0, 1], [1, 1], [2, 1], [2, 2]], [[1, 0], [1, 1], [0, 2], [1, 2]]],
  L: [[[2, 0], [0, 1], [1, 1], [2, 1]], [[1, 0], [1, 1], [1, 2], [2, 2]], [[0, 1], [1, 1], [2, 1], [0, 2]], [[0, 0], [1, 0], [1, 1], [1, 2]]],
}

const COLORS: Record<Kind, string> = { I: '#7dcfff', O: '#f6c453', T: '#bb9af7', S: '#9ece6a', Z: '#f7768e', J: '#7aa2f7', L: '#ff9e64' }
const LINE_SCORES = [0, 100, 300, 500, 800]

const cells = (p: Piece) => SHAPES[p.kind][p.rot].map(([x, y]) => [p.x + x, p.y + y] as const)

/** A shuffled bag of all seven pieces, so droughts of one piece cannot happen. */
function bag(): Kind[] {
  const b: Kind[] = ['I', 'O', 'T', 'S', 'Z', 'J', 'L']
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[b[i], b[j]] = [b[j], b[i]]
  }
  return b
}

type Board = (Kind | null)[][]
const emptyBoard = (): Board => Array.from({ length: ROWS }, () => Array<Kind | null>(COLS).fill(null))

function fits(board: Board, p: Piece) {
  return cells(p).every(([x, y]) => x >= 0 && x < COLS && y < ROWS && (y < 0 || !board[y][x]))
}

export function Tetris({ win }: { win: WinState }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const side = useRef<HTMLCanvasElement>(null)
  const { best, submit } = useHighScore('tetris')
  const [hud, setHud] = useState({ score: 0, lines: 0, level: 1 })
  const [state, setState] = useState<'ready' | 'playing' | 'paused' | 'over'>('ready')
  const [newBest, setNewBest] = useState(false)
  const g = useRef({ board: emptyBoard(), piece: null as Piece | null, queue: [] as Kind[], hold: null as Kind | null, canHold: true, score: 0, lines: 0, level: 1, dropAt: 0, lockAt: 0 })

  const nextKind = () => {
    const s = g.current
    if (s.queue.length < 7) s.queue.push(...bag())
    return s.queue.shift()!
  }

  const spawn = useCallback((kind?: Kind) => {
    const s = g.current
    const p: Piece = { kind: kind ?? nextKind(), rot: 0, x: 3, y: -1 }
    if (!fits(s.board, p)) {
      s.piece = null
      setState('over')
      setNewBest(submit(s.score))
      return
    }
    s.piece = p
    s.canHold = true
    s.lockAt = 0
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submit])

  const start = () => {
    g.current = { board: emptyBoard(), piece: null, queue: [], hold: null, canHold: true, score: 0, lines: 0, level: 1, dropAt: 0, lockAt: 0 }
    setHud({ score: 0, lines: 0, level: 1 })
    setNewBest(false)
    spawn()
    setState('playing')
  }

  const lock = () => {
    const s = g.current
    if (!s.piece) return
    for (const [x, y] of cells(s.piece)) if (y >= 0) s.board[y][x] = s.piece.kind
    const kept = s.board.filter((row) => row.some((c) => !c))
    const cleared = ROWS - kept.length
    s.board = [...Array.from({ length: cleared }, () => Array<Kind | null>(COLS).fill(null)), ...kept]
    s.lines += cleared
    s.score += LINE_SCORES[cleared] * s.level
    s.level = 1 + Math.floor(s.lines / 10)
    setHud({ score: s.score, lines: s.lines, level: s.level })
    spawn()
  }

  const move = (dx: number, dy: number) => {
    const s = g.current
    if (!s.piece) return false
    const p = { ...s.piece, x: s.piece.x + dx, y: s.piece.y + dy }
    if (!fits(s.board, p)) return false
    s.piece = p
    if (dx) s.lockAt = 0 // moving resets the lock delay, like modern Tetris
    return true
  }

  const rotate = (dir: 1 | -1) => {
    const s = g.current
    if (!s.piece) return
    const rot = (s.piece.rot + dir + 4) % 4
    // Simple wall kicks: try in place, then nudged sideways and up.
    for (const [kx, ky] of [[0, 0], [-1, 0], [1, 0], [-2, 0], [2, 0], [0, -1]]) {
      const p = { ...s.piece, rot, x: s.piece.x + kx, y: s.piece.y + ky }
      if (fits(s.board, p)) {
        s.piece = p
        s.lockAt = 0
        return
      }
    }
  }

  const hardDrop = () => {
    const s = g.current
    let n = 0
    while (move(0, 1)) n++
    s.score += n * 2
    lock()
  }

  const hold = () => {
    const s = g.current
    if (!s.piece || !s.canHold) return
    const current = s.piece.kind
    const swap = s.hold
    s.hold = current
    spawn(swap ?? undefined)
    s.canHold = false
  }

  const act = (a: 'left' | 'right' | 'down' | 'rotate' | 'rotateBack' | 'drop' | 'hold') => {
    if (state !== 'playing') return
    if (a === 'left') move(-1, 0)
    else if (a === 'right') move(1, 0)
    else if (a === 'down') {
      if (move(0, 1)) g.current.score += 1
    } else if (a === 'rotate') rotate(1)
    else if (a === 'rotateBack') rotate(-1)
    else if (a === 'drop') hardDrop()
    else hold()
    draw()
  }

  const focused = useGameKeys(win, (e) => {
    if (state !== 'playing' && (e.key === 'Enter' || e.key === ' ')) {
      if (state === 'paused') setState('playing')
      else start()
      return
    }
    const map: Record<string, Parameters<typeof act>[0]> = { ArrowLeft: 'left', a: 'left', ArrowRight: 'right', d: 'right', ArrowDown: 'down', s: 'down', ArrowUp: 'rotate', w: 'rotate', x: 'rotate', z: 'rotateBack', ' ': 'drop', c: 'hold', Shift: 'hold' }
    if (map[e.key]) act(map[e.key])
    else if (e.key === 'p' || e.key === 'Escape') setState((s) => (s === 'playing' ? 'paused' : s))
  })

  useEffect(() => {
    if (!focused) setState((s) => (s === 'playing' ? 'paused' : s))
  }, [focused])

  const draw = useCallback(() => {
    const c = canvas.current
    if (!c) return
    const ctx = c.getContext('2d')!
    const s = g.current
    ctx.fillStyle = '#0d1016'
    ctx.fillRect(0, 0, c.width, c.height)
    ctx.strokeStyle = 'rgba(255,255,255,0.035)'
    for (let x = 1; x < COLS; x++) {
      ctx.beginPath()
      ctx.moveTo(x * CELL, 0)
      ctx.lineTo(x * CELL, ROWS * CELL)
      ctx.stroke()
    }
    const block = (x: number, y: number, color: string, alpha = 1) => {
      if (y < 0) return
      ctx.globalAlpha = alpha
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.roundRect(x * CELL + 1, y * CELL + 1, CELL - 2, CELL - 2, 4)
      ctx.fill()
      ctx.fillStyle = 'rgba(255,255,255,0.18)'
      ctx.fillRect(x * CELL + 3, y * CELL + 3, CELL - 6, 3)
      ctx.globalAlpha = 1
    }
    s.board.forEach((row, y) => row.forEach((k, x) => k && block(x, y, COLORS[k])))
    if (s.piece) {
      // Ghost piece shows where a hard drop would land.
      let ghost = s.piece
      while (fits(s.board, { ...ghost, y: ghost.y + 1 })) ghost = { ...ghost, y: ghost.y + 1 }
      for (const [x, y] of cells(ghost)) block(x, y, COLORS[s.piece.kind], 0.18)
      for (const [x, y] of cells(s.piece)) block(x, y, COLORS[s.piece.kind])
    }

    const sc = side.current
    if (!sc) return
    const sctx = sc.getContext('2d')!
    sctx.clearRect(0, 0, sc.width, sc.height)
    const mini = (kind: Kind | null, oy: number, label: string) => {
      sctx.fillStyle = '#8a91a5'
      sctx.font = '11px "Space Grotesk", sans-serif'
      sctx.fillText(label, 6, oy - 6)
      if (!kind) return
      const size = 16
      for (const [x, y] of SHAPES[kind][0]) {
        sctx.fillStyle = COLORS[kind]
        sctx.beginPath()
        sctx.roundRect(8 + x * size, oy + y * size, size - 2, size - 2, 3)
        sctx.fill()
      }
    }
    mini(s.hold, 22, 'HOLD')
    s.queue.slice(0, 3).forEach((k, i) => mini(k, 104 + i * 62, i === 0 ? 'NEXT' : ''))
  }, [])

  useEffect(() => {
    draw()
    if (state !== 'playing') return
    let raf = 0
    const loop = (t: number) => {
      const s = g.current
      const interval = Math.max(60, 800 * Math.pow(0.85, s.level - 1))
      if (!s.dropAt) s.dropAt = t + interval
      if (t >= s.dropAt) {
        s.dropAt = t + interval
        if (!move(0, 1)) {
          // Half a second to slide or spin before the piece locks.
          if (!s.lockAt) s.lockAt = t + 500
        } else s.lockAt = 0
      }
      if (s.lockAt && t >= s.lockAt && s.piece && !fits(s.board, { ...s.piece, y: s.piece.y + 1 })) lock()
      draw()
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, draw])

  return (
    <div className="game game-tetris">
      <div className="game-bar">
        <span>
          Score <strong>{hud.score}</strong>
        </span>
        <span>
          Lines {hud.lines} · Level {hud.level}
        </span>
        <span className="muted">Best {best ?? '—'}</span>
      </div>
      <div className="tetris-wrap">
        <div className="game-stage tetris-stage">
          <canvas ref={canvas} width={COLS * CELL} height={ROWS * CELL} className="game-canvas" />
          {state !== 'playing' && (
            <button className="game-overlay" onClick={() => (state === 'paused' ? setState('playing') : start())}>
              <strong>{state === 'over' ? (newBest ? 'New high score!' : 'Game over') : state === 'paused' ? 'Paused' : 'Tetris'}</strong>
              <span>
                {state === 'over'
                  ? `${hud.score} points, ${hud.lines} lines. Click to play again.`
                  : state === 'paused'
                    ? 'Click or press Enter to continue'
                    : '← → move · ↑ rotate · ↓ soft drop · Space hard drop · C hold'}
              </span>
            </button>
          )}
        </div>
        <canvas ref={side} width={80} height={300} className="tetris-side" />
      </div>
      <div className="touch-pad tetris-pad">
        <button onClick={() => act('hold')}>Hold</button>
        <button onClick={() => act('left')}>◀</button>
        <button onClick={() => act('rotate')}>⟳</button>
        <button onClick={() => act('right')}>▶</button>
        <button onClick={() => act('down')}>▼</button>
        <button onClick={() => act('drop')}>Drop</button>
      </div>
    </div>
  )
}
