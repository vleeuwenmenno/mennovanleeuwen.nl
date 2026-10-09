import { useEffect, useRef, useState } from 'react'
import type { WinState } from '../../os/wm'
import { cssVar, useGameKeys, useHighScore, useSharpCanvas } from './shared'

const W = 480
const H = 360
const ROWS = 5
const COLS = 10
const BRICK_H = 14
const BRICK_GAP = 4
const TOP = 40
const PADDLE_W = 76
const PADDLE_H = 10
const R = 6

type Brick = { x: number; y: number; w: number; alive: boolean; row: number }

function makeBricks(): Brick[] {
  const bw = (W - 20 - BRICK_GAP * (COLS - 1)) / COLS
  const out: Brick[] = []
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) out.push({ x: 10 + c * (bw + BRICK_GAP), y: TOP + r * (BRICK_H + BRICK_GAP), w: bw, alive: true, row: r })
  return out
}

export function Breakout({ win }: { win: WinState }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const { best, submit } = useHighScore('breakout')
  useSharpCanvas(canvas, W, H)
  const [hud, setHud] = useState({ score: 0, lives: 3, level: 1 })
  const [state, setState] = useState<'ready' | 'playing' | 'paused' | 'over' | 'cleared'>('ready')
  const [newBest, setNewBest] = useState(false)
  const g = useRef({ px: W / 2 - PADDLE_W / 2, bx: W / 2, by: H - 40, vx: 3, vy: -3.6, bricks: makeBricks(), score: 0, lives: 3, level: 1, keys: { left: false, right: false }, stuck: true })

  const launch = () => {
    if (state === 'over') {
      g.current = { ...g.current, bricks: makeBricks(), score: 0, lives: 3, level: 1, stuck: true }
      setHud({ score: 0, lives: 3, level: 1 })
      setNewBest(false)
    }
    if (state === 'cleared') {
      g.current.bricks = makeBricks()
      g.current.stuck = true
    }
    g.current.stuck = false
    setState('playing')
  }

  const focused = useGameKeys(win, (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'a') g.current.keys.left = true
    if (e.key === 'ArrowRight' || e.key === 'd') g.current.keys.right = true
    if (e.key === ' ') {
      if (state === 'playing' && g.current.stuck) g.current.stuck = false
      else if (state === 'playing') setState('paused')
      else launch()
    }
  })

  useEffect(() => {
    const up = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' || e.key === 'a') g.current.keys.left = false
      if (e.key === 'ArrowRight' || e.key === 'd') g.current.keys.right = false
    }
    window.addEventListener('keyup', up)
    return () => window.removeEventListener('keyup', up)
  }, [])

  useEffect(() => {
    if (!focused) setState((s) => (s === 'playing' ? 'paused' : s))
  }, [focused])

  useEffect(() => {
    const c = canvas.current!
    const ctx = c.getContext('2d')!
    const colors = [cssVar('--red'), cssVar('--yellow'), cssVar('--green'), cssVar('--cyan'), cssVar('--magenta')]
    const accent = cssVar('--accent')
    let raf = 0
    let lastT = performance.now()

    const draw = () => {
      const s = g.current
      ctx.fillStyle = '#0d1016'
      ctx.fillRect(0, 0, W, H)
      for (const b of s.bricks) {
        if (!b.alive) continue
        ctx.fillStyle = colors[b.row] || accent
        ctx.beginPath()
        ctx.roundRect(b.x, b.y, b.w, BRICK_H, 3)
        ctx.fill()
      }
      ctx.fillStyle = accent
      ctx.beginPath()
      ctx.roundRect(s.px, H - 24, PADDLE_W, PADDLE_H, 5)
      ctx.fill()
      ctx.fillStyle = '#fff'
      ctx.beginPath()
      ctx.arc(s.bx, s.by, R, 0, Math.PI * 2)
      ctx.fill()
    }

    const step = (dt: number) => {
      const s = g.current
      const speed = 6 * dt
      if (s.keys.left) s.px -= speed * 1.4
      if (s.keys.right) s.px += speed * 1.4
      s.px = Math.max(0, Math.min(W - PADDLE_W, s.px))
      if (s.stuck) {
        s.bx = s.px + PADDLE_W / 2
        s.by = H - 24 - R - 1
        return
      }
      s.bx += s.vx * dt
      s.by += s.vy * dt
      if (s.bx < R || s.bx > W - R) {
        s.vx *= -1
        s.bx = Math.max(R, Math.min(W - R, s.bx))
      }
      if (s.by < R) {
        s.vy = Math.abs(s.vy)
        s.by = R
      }
      // Paddle: the hit position sets the bounce angle.
      if (s.vy > 0 && s.by + R >= H - 24 && s.by + R <= H - 24 + PADDLE_H + 4 && s.bx >= s.px - R && s.bx <= s.px + PADDLE_W + R) {
        const hit = (s.bx - (s.px + PADDLE_W / 2)) / (PADDLE_W / 2)
        const v = Math.hypot(s.vx, s.vy)
        const angle = hit * (Math.PI / 3)
        s.vx = v * Math.sin(angle)
        s.vy = -v * Math.cos(angle)
      }
      for (const b of s.bricks) {
        if (!b.alive) continue
        if (s.bx + R > b.x && s.bx - R < b.x + b.w && s.by + R > b.y && s.by - R < b.y + BRICK_H) {
          b.alive = false
          const overlapX = Math.min(s.bx + R - b.x, b.x + b.w - (s.bx - R))
          const overlapY = Math.min(s.by + R - b.y, b.y + BRICK_H - (s.by - R))
          if (overlapX < overlapY) s.vx *= -1
          else s.vy *= -1
          s.score += (ROWS - b.row) * 10
          setHud({ score: s.score, lives: s.lives, level: s.level })
          if (s.bricks.every((x) => !x.alive)) {
            s.level++
            s.vx *= 1.12
            s.vy *= 1.12
            setHud({ score: s.score, lives: s.lives, level: s.level })
            setState('cleared')
          }
          break
        }
      }
      if (s.by > H + R) {
        s.lives--
        s.stuck = true
        setHud({ score: s.score, lives: s.lives, level: s.level })
        if (s.lives <= 0) {
          setState('over')
          setNewBest(submit(s.score))
        }
      }
    }

    const loop = (t: number) => {
      const dt = Math.min(2.5, (t - lastT) / 16.67)
      lastT = t
      if (state === 'playing') step(dt)
      draw()
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [state, submit])

  // Mouse or finger steers the paddle; tapping launches the ball.
  const steer = (e: React.PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect()
    g.current.px = Math.max(0, Math.min(W - PADDLE_W, ((e.clientX - r.left) / r.width) * W - PADDLE_W / 2))
  }

  return (
    <div className="game game-breakout game-fit">
      <div className="game-bar">
        <span>
          Score <strong>{hud.score}</strong>
        </span>
        <span>{'♥'.repeat(Math.max(0, hud.lives))}</span>
        <span className="muted">
          Level {hud.level} · Best {best ?? '—'}
        </span>
      </div>
      <div className="game-stage">
        <canvas
          ref={canvas}
          width={W}
          height={H}
          className="game-canvas"
          onPointerMove={steer}
          onPointerDown={(e) => {
            steer(e)
            if (state === 'playing' && g.current.stuck) g.current.stuck = false
          }}
          style={{ touchAction: 'none' }}
        />
        {state !== 'playing' && (
          <button className="game-overlay" onClick={launch}>
            <strong>{state === 'over' ? (newBest ? 'New high score!' : 'Game over') : state === 'cleared' ? `Level ${hud.level}` : state === 'paused' ? 'Paused' : 'Breakout'}</strong>
            <span>{state === 'over' ? `You scored ${hud.score}. Click to play again.` : state === 'cleared' ? 'Board cleared. The ball gets faster.' : 'Move with the mouse, finger or arrows. Click or Space launches.'}</span>
          </button>
        )}
      </div>
    </div>
  )
}
