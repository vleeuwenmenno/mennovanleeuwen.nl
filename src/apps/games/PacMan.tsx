import { useCallback, useEffect, useRef, useState } from 'react'
import type { WinState } from '../../os/wm'
import { keyToDir, swipeHandlers, useGameKeys, usePress, useHighScore, type Dir } from './shared'

// An original maze in the spirit of the arcade game. # wall, . pellet, o power pellet,
// - ghost-house door, G ghost house, P start. Row 9 wraps around as a tunnel.
const MAZE = [
  '###################',
  '#........#........#',
  '#o##.###.#.###.##o#',
  '#.................#',
  '#.##.#.#####.#.##.#',
  '#....#...#...#....#',
  '####.### # ###.####',
  '   #.#       #.#   ',
  '####.# ##-## #.####',
  '    .  #GGG#  .    ',
  '####.# ##### #.####',
  '   #.#       #.#   ',
  '####.# ##### #.####',
  '#........#........#',
  '#.##.###.#.###.##.#',
  '#o.#.....P.....#.o#',
  '##.#.#.#####.#.#.##',
  '#....#...#...#....#',
  '#.######.#.######.#',
  '#.................#',
  '###################',
]
const W = MAZE[0].length
const H = MAZE.length
const T = 20
const TUNNEL_ROW = 9
const DOOR = { x: 9, y: 8 }
const HOUSE_EXIT = { x: 9, y: 7 }
const HOUSE_CENTER = { x: 9, y: 9 }

const D: Record<Dir, { x: number; y: number }> = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } }
const REVERSE: Record<Dir, Dir> = { up: 'down', down: 'up', left: 'right', right: 'left' }
const ORDER: Dir[] = ['up', 'left', 'down', 'right'] // arcade tie-break order

type GhostMode = 'house' | 'leaving' | 'active' | 'eyes'
/** `scared` is cleared once a ghost has been eaten, so it comes back dangerous during the same power pellet. */
type Ghost = { name: string; color: string; x: number; y: number; dir: Dir; p: number; mode: GhostMode; releaseAt: number; corner: { x: number; y: number }; scared: boolean }
type Pac = { x: number; y: number; dir: Dir; next: Dir; p: number }

const wall = (x: number, y: number, ghostCanPassDoor = false) => {
  if (y === TUNNEL_ROW && (x < 0 || x >= W)) return false
  const c = MAZE[y]?.[x]
  if (c === undefined || c === '#') return true
  if (c === '-' || c === 'G') return !ghostCanPassDoor
  return false
}

const wrap = (x: number) => (x + W) % W

function pellets() {
  const set = new Map<string, 'dot' | 'power'>()
  MAZE.forEach((row, y) => [...row].forEach((c, x) => (c === '.' ? set.set(`${x},${y}`, 'dot') : c === 'o' && set.set(`${x},${y}`, 'power'))))
  return set
}

function newGhosts(now: number, level: number): Ghost[] {
  const delay = Math.max(800, 3000 - level * 300)
  return [
    { name: 'blinky', color: '#f7768e', x: HOUSE_EXIT.x, y: HOUSE_EXIT.y, dir: 'left', p: 0, mode: 'active', releaseAt: 0, corner: { x: W - 2, y: -2 }, scared: false },
    { name: 'pinky', color: '#ff9fd6', x: 9, y: 9, dir: 'up', p: 0, mode: 'house', releaseAt: now + 600, corner: { x: 1, y: -2 }, scared: false },
    { name: 'inky', color: '#7dcfff', x: 8, y: 9, dir: 'up', p: 0, mode: 'house', releaseAt: now + 600 + delay, corner: { x: W - 1, y: H }, scared: false },
    { name: 'clyde', color: '#ff9e64', x: 10, y: 9, dir: 'up', p: 0, mode: 'house', releaseAt: now + 600 + delay * 2, corner: { x: 0, y: H }, scared: false },
  ]
}

// Scatter / chase phases in seconds, as in the arcade; the last chase lasts forever.
const PHASES = [7, 20, 7, 20, 5, 20, 5]

export function PacMan({ win }: { win: WinState }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const { best, submit } = useHighScore('pacman')
  const [hud, setHud] = useState({ score: 0, lives: 3, level: 1 })
  const [state, setState] = useState<'ready' | 'playing' | 'paused' | 'dying' | 'over' | 'cleared'>('ready')
  const [newBest, setNewBest] = useState(false)
  const g = useRef({
    pac: { x: 9, y: 15, dir: 'left', next: 'left', p: 0 } as Pac,
    ghosts: [] as Ghost[],
    pellets: pellets(),
    score: 0,
    lives: 3,
    level: 1,
    frightUntil: 0,
    eatCombo: 0,
    phase: 0,
    phaseUntil: 0,
    time: 0,
    mouth: 0,
  })

  const resetPositions = (now: number) => {
    const s = g.current
    s.pac = { x: 9, y: 15, dir: 'left', next: 'left', p: 0 }
    s.ghosts = newGhosts(now, s.level)
    s.frightUntil = 0
    s.phase = 0
    s.phaseUntil = now + PHASES[0] * 1000
  }

  const start = () => {
    const s = g.current
    if (state === 'over' || state === 'ready') {
      s.score = 0
      s.lives = 3
      s.level = 1
      s.pellets = pellets()
      setNewBest(false)
    }
    if (state === 'cleared') s.pellets = pellets()
    resetPositions(s.time)
    setHud({ score: s.score, lives: s.lives, level: s.level })
    setState('playing')
  }

  const press = usePress()
  const steer = (d: Dir) => {
    g.current.pac.next = d
    if (state === 'ready' || state === 'over' || state === 'cleared') start()
    if (state === 'paused') setState('playing')
  }

  const focused = useGameKeys(win, (e) => {
    const d = keyToDir(e.key)
    if (d) steer(d)
    else if (e.key === ' ' || e.key === 'p') setState((st) => (st === 'playing' ? 'paused' : st === 'paused' ? 'playing' : st))
    else if (e.key === 'Enter' && state !== 'playing') start()
  })

  useEffect(() => {
    if (!focused) setState((st) => (st === 'playing' ? 'paused' : st))
  }, [focused])

  const draw = useCallback(() => {
    const c = canvas.current
    if (!c) return
    const ctx = c.getContext('2d')!
    const s = g.current
    ctx.fillStyle = '#07090f'
    ctx.fillRect(0, 0, c.width, c.height)

    // Walls: filled tiles with an outline wherever they face a corridor.
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        if (MAZE[y][x] !== '#') continue
        ctx.fillStyle = '#121a3d'
        ctx.fillRect(x * T, y * T, T, T)
        ctx.strokeStyle = '#5b7cfa'
        ctx.lineWidth = 2
        ctx.beginPath()
        const open = (nx: number, ny: number) => MAZE[ny]?.[nx] !== undefined && MAZE[ny][nx] !== '#'
        if (open(x, y - 1)) (ctx.moveTo(x * T, y * T + 1), ctx.lineTo(x * T + T, y * T + 1))
        if (open(x, y + 1)) (ctx.moveTo(x * T, y * T + T - 1), ctx.lineTo(x * T + T, y * T + T - 1))
        if (open(x - 1, y)) (ctx.moveTo(x * T + 1, y * T), ctx.lineTo(x * T + 1, y * T + T))
        if (open(x + 1, y)) (ctx.moveTo(x * T + T - 1, y * T), ctx.lineTo(x * T + T - 1, y * T + T))
        ctx.stroke()
      }
    ctx.fillStyle = '#ff9fd6'
    ctx.fillRect(DOOR.x * T + 2, DOOR.y * T + T / 2 - 2, T - 4, 4)

    // Pellets; power pellets pulse.
    for (const [k, kind] of s.pellets) {
      const [x, y] = k.split(',').map(Number)
      ctx.fillStyle = '#f2d8b8'
      ctx.beginPath()
      const r = kind === 'power' ? 5 + Math.sin(s.time / 150) * 1.2 : 2
      ctx.arc(x * T + T / 2, y * T + T / 2, r, 0, Math.PI * 2)
      ctx.fill()
    }

    const pos = (e: { x: number; y: number; dir: Dir; p: number }) => ({ x: (e.x + D[e.dir].x * e.p) * T + T / 2, y: (e.y + D[e.dir].y * e.p) * T + T / 2 })

    // Pac.
    const pp = pos(s.pac)
    const angle = { right: 0, down: Math.PI / 2, left: Math.PI, up: -Math.PI / 2 }[s.pac.dir]
    const mouth = state === 'playing' ? Math.abs(Math.sin(s.mouth)) * 0.42 : 0.25
    ctx.fillStyle = '#f6c453'
    ctx.beginPath()
    ctx.moveTo(pp.x, pp.y)
    ctx.arc(pp.x, pp.y, T * 0.45, angle + mouth * Math.PI, angle - mouth * Math.PI + Math.PI * 2)
    ctx.closePath()
    ctx.fill()

    // Ghosts.
    const frightened = s.frightUntil > s.time
    const flashing = frightened && s.frightUntil - s.time < 1800 && Math.floor(s.time / 200) % 2 === 0
    for (const gh of s.ghosts) {
      const { x, y } = pos(gh)
      const r = T * 0.45
      const scared = frightened && gh.mode === 'active' && gh.scared
      if (gh.mode !== 'eyes') {
        ctx.fillStyle = scared ? (flashing ? '#e4e7ef' : '#3d4fd1') : gh.color
        ctx.beginPath()
        ctx.arc(x, y - 1, r, Math.PI, 0)
        const bottom = y + r - 1
        ctx.lineTo(x + r, bottom)
        for (let i = 0; i < 3; i++) {
          const wx = x + r - ((i + 0.5) * (2 * r)) / 3
          ctx.lineTo(wx, bottom - 3 - (Math.floor(s.time / 120) % 2) * 1.5)
          ctx.lineTo(x + r - ((i + 1) * (2 * r)) / 3, bottom)
        }
        ctx.closePath()
        ctx.fill()
      }
      if (scared && gh.mode !== 'eyes') {
        ctx.fillStyle = flashing ? '#f7768e' : '#f2d8b8'
        ctx.fillRect(x - 4, y - 3, 2, 2)
        ctx.fillRect(x + 2, y - 3, 2, 2)
        continue
      }
      const look = D[gh.dir]
      for (const ex of [-3.5, 3.5]) {
        ctx.fillStyle = '#fff'
        ctx.beginPath()
        ctx.arc(x + ex, y - 3, 3, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = '#1d2bb8'
        ctx.beginPath()
        ctx.arc(x + ex + look.x * 1.4, y - 3 + look.y * 1.4, 1.5, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }, [state])

  useEffect(() => {
    let raf = 0
    let last = performance.now()

    const step = (dt: number) => {
      const s = g.current
      s.time += dt * 1000
      const now = s.time
      const speedUp = 1 + (s.level - 1) * 0.06

      // Scatter/chase schedule; ghosts reverse when it flips.
      if (s.phase < PHASES.length - 1 && now >= s.phaseUntil && s.frightUntil <= now) {
        s.phase++
        s.phaseUntil = now + PHASES[s.phase] * 1000
        for (const gh of s.ghosts) if (gh.mode === 'active' && gh.p === 0) gh.dir = REVERSE[gh.dir]
      }
      const chasing = s.phase % 2 === 1 || s.phase >= PHASES.length - 1
      const frightened = s.frightUntil > now

      // --- Pac ---
      const pac = s.pac
      let dist = 7.6 * speedUp * dt
      if (pac.next === REVERSE[pac.dir] && pac.p > 0) {
        pac.x = wrap(pac.x + D[pac.dir].x)
        pac.y += D[pac.dir].y
        pac.p = 1 - pac.p
        pac.dir = pac.next
      }
      while (dist > 0) {
        if (pac.p === 0) {
          if (!wall(pac.x + D[pac.next].x, pac.y + D[pac.next].y)) pac.dir = pac.next
          if (wall(pac.x + D[pac.dir].x, pac.y + D[pac.dir].y)) break
        }
        const take = Math.min(dist, 1 - pac.p)
        pac.p += take
        dist -= take
        if (pac.p >= 1 - 1e-9) {
          pac.x = wrap(pac.x + D[pac.dir].x)
          pac.y += D[pac.dir].y
          pac.p = 0
          const key = `${pac.x},${pac.y}`
          const kind = s.pellets.get(key)
          if (kind) {
            s.pellets.delete(key)
            s.score += kind === 'power' ? 50 : 10
            if (kind === 'power') {
              s.frightUntil = now + Math.max(2000, 7000 - s.level * 700)
              s.eatCombo = 0
              for (const gh of s.ghosts) {
                gh.scared = gh.mode !== 'eyes'
                if (gh.mode === 'active' && gh.p === 0) gh.dir = REVERSE[gh.dir]
              }
            }
            setHud({ score: s.score, lives: s.lives, level: s.level })
            if (!s.pellets.size) {
              s.level++
              setHud({ score: s.score, lives: s.lives, level: s.level })
              setState('cleared')
              return
            }
          }
        }
      }
      s.mouth += dt * 14

      // --- Ghosts ---
      for (const gh of s.ghosts) {
        const scared = frightened && gh.scared
        if (gh.mode === 'house') {
          if (now >= gh.releaseAt) gh.mode = 'leaving'
          else continue
        }
        const target = (() => {
          if (gh.mode === 'leaving') return gh.x === HOUSE_CENTER.x || gh.y < DOOR.y ? HOUSE_EXIT : HOUSE_CENTER
          if (gh.mode === 'eyes') return HOUSE_CENTER
          if (!chasing) return gh.corner
          const ahead = (n: number) => ({ x: pac.x + D[pac.dir].x * n, y: pac.y + D[pac.dir].y * n })
          if (gh.name === 'blinky') return { x: pac.x, y: pac.y }
          if (gh.name === 'pinky') return ahead(4)
          if (gh.name === 'inky') {
            const blinky = s.ghosts[0]
            const a = ahead(2)
            return { x: a.x * 2 - blinky.x, y: a.y * 2 - blinky.y }
          }
          return Math.hypot(gh.x - pac.x, gh.y - pac.y) > 8 ? { x: pac.x, y: pac.y } : gh.corner
        })()
        const throughDoor = gh.mode === 'leaving' || gh.mode === 'eyes'
        let speed = gh.mode === 'eyes' ? 14 : scared && gh.mode === 'active' ? 4.2 : gh.y === TUNNEL_ROW && (gh.x < 4 || gh.x > W - 5) ? 4 : 7.1 * speedUp
        if (gh.mode === 'leaving') speed = 5
        let d = speed * dt
        while (d > 0) {
          if (gh.p === 0) {
            const options = ORDER.filter((dir) => dir !== REVERSE[gh.dir] && !wall(gh.x + D[dir].x, gh.y + D[dir].y, throughDoor))
            if (!options.length) options.push(REVERSE[gh.dir])
            if (scared && gh.mode === 'active') gh.dir = options[Math.floor(Math.random() * options.length)]
            else
              gh.dir = options.reduce((bestDir, dir) =>
                Math.hypot(gh.x + D[dir].x - target.x, gh.y + D[dir].y - target.y) < Math.hypot(gh.x + D[bestDir].x - target.x, gh.y + D[bestDir].y - target.y) ? dir : bestDir,
              )
          }
          const take = Math.min(d, 1 - gh.p)
          gh.p += take
          d -= take
          if (gh.p >= 1 - 1e-9) {
            gh.x = wrap(gh.x + D[gh.dir].x)
            gh.y += D[gh.dir].y
            gh.p = 0
            if (gh.mode === 'leaving' && gh.x === HOUSE_EXIT.x && gh.y === HOUSE_EXIT.y) {
              gh.mode = 'active'
              gh.dir = 'left'
            }
            if (gh.mode === 'eyes' && gh.x === HOUSE_CENTER.x && gh.y === HOUSE_CENTER.y) {
              gh.mode = 'leaving'
              gh.scared = false
            }
          }
        }

        // Collision with Pac.
        const gx = gh.x + D[gh.dir].x * gh.p
        const gy = gh.y + D[gh.dir].y * gh.p
        const px = pac.x + D[pac.dir].x * pac.p
        const py = pac.y + D[pac.dir].y * pac.p
        if (gh.mode === 'active' && Math.hypot(gx - px, gy - py) < 0.6) {
          if (scared) {
            gh.mode = 'eyes'
            gh.scared = false
            s.eatCombo++
            s.score += 100 * 2 ** s.eatCombo
            setHud({ score: s.score, lives: s.lives, level: s.level })
          } else {
            s.lives--
            setHud({ score: s.score, lives: s.lives, level: s.level })
            if (s.lives <= 0) {
              setState('over')
              setNewBest(submit(s.score))
            } else setState('dying')
            return
          }
        }
      }
    }

    const loop = (t: number) => {
      const dt = Math.min(0.05, (t - last) / 1000)
      last = t
      if (state === 'playing') step(dt)
      else g.current.time += dt * 1000
      draw()
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [state, draw, submit])

  // After losing a life, pause briefly, then reset positions and carry on.
  useEffect(() => {
    if (state !== 'dying') return
    const t = setTimeout(() => {
      resetPositions(g.current.time)
      setState('playing')
    }, 1200)
    return () => clearTimeout(t)
  }, [state])

  return (
    <div className="game game-pacman">
      <div className="game-bar">
        <span>
          Score <strong>{hud.score}</strong>
        </span>
        <span className="pac-lives">{Array.from({ length: Math.max(0, hud.lives) }, (_, i) => <span key={i} />)}</span>
        <span className="muted">
          Level {hud.level} · Best {best ?? '—'}
        </span>
      </div>
      <div className="game-stage pac-stage" {...swipeHandlers(steer)}>
        <canvas ref={canvas} width={W * T} height={H * T} className="game-canvas" />
        {state !== 'playing' && state !== 'dying' && (
          <button className="game-overlay" onClick={() => (state === 'paused' ? setState('playing') : start())}>
            <strong>{state === 'over' ? (newBest ? 'New high score!' : 'Game over') : state === 'cleared' ? `Level ${hud.level}` : state === 'paused' ? 'Paused' : 'Pac-Man'}</strong>
            <span>
              {state === 'over'
                ? `You scored ${hud.score}. Click or press Enter to play again.`
                : state === 'cleared'
                  ? 'Maze cleared. The ghosts get quicker.'
                  : state === 'paused'
                    ? 'Click or press Space to continue'
                    : 'Arrows / WASD or swipe. Eat a power pellet, then the ghosts.'}
            </span>
          </button>
        )}
      </div>
      <div className="dpad" aria-label="Direction pad">
        {(['up', 'left', 'down', 'right'] as Dir[]).map((d) => (
          <button key={d} className={`dpad-${d}`} {...press(() => steer(d))} aria-label={d}>
            {{ up: '▲', down: '▼', left: '◀', right: '▶' }[d]}
          </button>
        ))}
      </div>
    </div>
  )
}
