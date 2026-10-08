import { useCallback, useEffect, useRef, useState } from 'react'
import type { WinState } from '../../os/wm'
import { cssVar, keyToDir, swipeHandlers, useGameKeys, useHighScore, type Dir } from './shared'

const N = 20
type P = { x: number; y: number }
const DELTA: Record<Dir, P> = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } }
const OPPOSITE: Record<Dir, Dir> = { up: 'down', down: 'up', left: 'right', right: 'left' }

function freeCell(snake: P[]): P {
  while (true) {
    const p = { x: Math.floor(Math.random() * N), y: Math.floor(Math.random() * N) }
    if (!snake.some((s) => s.x === p.x && s.y === p.y)) return p
  }
}

export function Snake({ win }: { win: WinState }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const { best, submit } = useHighScore('snake')
  const [state, setState] = useState<'ready' | 'playing' | 'paused' | 'over'>('ready')
  const [score, setScore] = useState(0)
  const [newBest, setNewBest] = useState(false)
  const game = useRef({ snake: [{ x: 9, y: 10 }, { x: 8, y: 10 }, { x: 7, y: 10 }] as P[], dir: 'right' as Dir, queue: [] as Dir[], food: { x: 14, y: 10 } as P, score: 0 })

  const reset = useCallback(() => {
    const snake = [{ x: 9, y: 10 }, { x: 8, y: 10 }, { x: 7, y: 10 }]
    game.current = { snake, dir: 'right', queue: [], food: freeCell(snake), score: 0 }
    setScore(0)
    setNewBest(false)
    setState('playing')
  }, [])

  const steer = (d: Dir) => {
    // Start (or restart) first, so the key that started the game also steers it.
    if (state === 'ready' || state === 'over') reset()
    if (state === 'paused') setState('playing')
    const g = game.current
    const last = g.queue[g.queue.length - 1] ?? g.dir
    if (d !== last && d !== OPPOSITE[last] && g.queue.length < 3) g.queue.push(d)
  }

  const focused = useGameKeys(win, (e) => {
    const d = keyToDir(e.key)
    if (d) steer(d)
    else if (e.key === ' ' || e.key === 'p') setState((s) => (s === 'playing' ? 'paused' : s === 'paused' ? 'playing' : s))
    else if (e.key === 'Enter' && state !== 'playing') reset()
  })

  // Pause when the window loses focus, like a real game would.
  useEffect(() => {
    if (!focused) setState((s) => (s === 'playing' ? 'paused' : s))
  }, [focused])

  const draw = useCallback(() => {
    const c = canvas.current
    if (!c) return
    const ctx = c.getContext('2d')!
    const size = c.width
    const cell = size / N
    ctx.fillStyle = '#0d1016'
    ctx.fillRect(0, 0, size, size)
    ctx.fillStyle = 'rgba(255,255,255,0.03)'
    for (let x = 0; x < N; x++) for (let y = (x % 2); y < N; y += 2) ctx.fillRect(x * cell, y * cell, cell, cell)
    const g = game.current
    ctx.fillStyle = cssVar('--red') || '#f7768e'
    ctx.beginPath()
    ctx.arc((g.food.x + 0.5) * cell, (g.food.y + 0.5) * cell, cell * 0.36, 0, Math.PI * 2)
    ctx.fill()
    const accent = cssVar('--accent') || '#f6c453'
    g.snake.forEach((s, i) => {
      ctx.globalAlpha = 1 - (i / g.snake.length) * 0.55
      ctx.fillStyle = i === 0 ? accent : cssVar('--green') || '#9ece6a'
      const pad = i === 0 ? 1 : 2
      ctx.beginPath()
      ctx.roundRect(s.x * cell + pad, s.y * cell + pad, cell - pad * 2, cell - pad * 2, cell * 0.25)
      ctx.fill()
    })
    ctx.globalAlpha = 1
  }, [])

  useEffect(() => {
    draw()
    if (state !== 'playing') return
    const speed = Math.max(55, 130 - game.current.score * 3)
    const t = setInterval(() => {
      const g = game.current
      if (g.queue.length) g.dir = g.queue.shift()!
      const head = { x: g.snake[0].x + DELTA[g.dir].x, y: g.snake[0].y + DELTA[g.dir].y }
      const hitWall = head.x < 0 || head.y < 0 || head.x >= N || head.y >= N
      const hitSelf = g.snake.slice(0, -1).some((s) => s.x === head.x && s.y === head.y)
      if (hitWall || hitSelf) {
        setState('over')
        setNewBest(submit(g.score))
        return
      }
      g.snake.unshift(head)
      if (head.x === g.food.x && head.y === g.food.y) {
        g.score++
        setScore(g.score)
        g.food = freeCell(g.snake)
      } else g.snake.pop()
      draw()
    }, speed)
    return () => clearInterval(t)
  }, [state, score, draw, submit])

  return (
    <div className="game game-snake">
      <div className="game-bar">
        <span>
          Score <strong>{score}</strong>
        </span>
        <span className="muted">Best {best ?? '—'}</span>
      </div>
      <div className="game-stage" {...swipeHandlers(steer)}>
        <canvas ref={canvas} width={400} height={400} className="game-canvas" />
        {state !== 'playing' && (
          <button className="game-overlay" onClick={() => (state === 'paused' ? setState('playing') : reset())}>
            <strong>{state === 'over' ? (newBest ? 'New high score!' : 'Game over') : state === 'paused' ? 'Paused' : 'Snake'}</strong>
            <span>{state === 'over' ? `You scored ${score}. Click or press Enter to play again.` : state === 'paused' ? 'Click or press Space to continue' : 'Arrows / WASD or swipe. Space pauses.'}</span>
          </button>
        )}
      </div>
      <div className="dpad" aria-label="Direction pad">
        {(['up', 'left', 'down', 'right'] as Dir[]).map((d) => (
          <button key={d} className={`dpad-${d}`} onClick={() => steer(d)} aria-label={d}>
            {{ up: '▲', down: '▼', left: '◀', right: '▶' }[d]}
          </button>
        ))}
      </div>
    </div>
  )
}
