import { useEffect, useRef, useState } from 'react'
import type { WinState } from '../../os/wm'
import { plan, type Hand, type Level, type Shot } from './pool/ai'
import { allStopped, castAim, fits, FOOT_X, freeSpot, HEAD_X, isMoving, L, POCKETS, R, rack, simulate, strike, W, type Ball, type Events } from './pool/physics'
import { ballCss, MARGIN, paintBall, paintCue, paintTable, PLAIN, TOTAL_H, TOTAL_W, viewFor, type Sprite, type View } from './pool/render'
import { judge, newLog, newMatch, WIN_SIMPLE, type Group, type Rules } from './pool/rules'
import { PoolSound } from './pool/sound'
import { useGameKeys, useHighScore } from './shared'

type Mode = 'cpu' | 'duo' | 'solo'
type Phase = 'menu' | 'aim' | 'strike' | 'moving' | 'cpu' | 'over'

// Sensitivity: metres of drag back for a full-power stroke.
const DRAG = { low: 0.6, medium: 0.4, high: 0.25 }
type Sensitivity = keyof typeof DRAG
type Settings = { helpers: boolean; sensitivity: Sensitivity; level: Level }
const LEVELS: Level[] = ['easy', 'medium', 'hard']
const SETTINGS_KEY = 'mvlos.pool.settings'
function readSettings(): Settings {
  try {
    const v = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}')
    return { helpers: v.helpers !== false, sensitivity: v.sensitivity in DRAG ? v.sensitivity : 'medium', level: LEVELS.includes(v.level) ? v.level : 'medium' }
  } catch {
    return { helpers: true, sensitivity: 'medium', level: 'medium' }
  }
}
const MAX_BACK = 0.28 // how far the cue draws back at full power
const STRIKE_MS = 110
const powerToSpeed = (p: number) => 0.25 + 8.75 * Math.pow(p, 1.7)
const speedToPower = (v: number) => Math.pow(Math.max(0, Math.min(1, (v - 0.25) / 8.75)), 1 / 1.7)
const ease = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t))

const NAMES: Record<Mode, [string, string]> = { cpu: ['You', 'Computer'], duo: ['Player 1', 'Player 2'], solo: ['You', 'You'] }
const has = (name: string) => (name === 'You' ? 'have' : 'has')
const plainCss = `rgb(${PLAIN.join(',')})`

type Hud = { phase: Phase; mode: Mode; rules: Rules; turn: 0 | 1; groups: [Group | null, Group | null]; scores: [number, number]; shots: number; onTable: number[]; msg: string; over: { title: string; text: string } | null; hand: Hand; muted: boolean }

export function Pool({ win }: { win: WinState }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const root = useRef<HTMLDivElement>(null)
  const sound = useRef<PoolSound>(null as unknown as PoolSound)
  if (!sound.current) sound.current = new PoolSound()
  const wins = useHighScore('pool')
  const soloBest = { eight: useHighScore('pool-solo-eight', true), simple: useHighScore('pool-solo-simple', true) }
  const [pick, setPick] = useState<Rules>('eight')
  const [settings, setSettings] = useState(readSettings)
  const changeSettings = (next: Partial<Settings>) => {
    const v = { ...settings, ...next }
    setSettings(v)
    s.current.settings = v
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(v))
    } catch {
      /* the choice just won't persist */
    }
  }

  const s = useRef({
    balls: rack(),
    match: newMatch('eight', false),
    mode: 'cpu' as Mode,
    phase: 'menu' as Phase,
    hand: 'kitchen' as Hand,
    breaker: 0 as 0 | 1,
    aim: 0,
    power: 0,
    press: null as null | { kind: 'charge' | 'cue' | 'aim'; x: number; y: number },
    spin: { x: 0, y: 0 },
    shot: null as Shot | null,
    strikeAt: 0,
    strikePower: 0,
    log: newLog(),
    before: [] as number[],
    falling: [] as { ball: Ball; x: number; y: number; px: number; py: number; t: number }[],
    cpu: null as null | { gen: Generator<void, Shot>; shot?: Shot; start: number; t0: number; from: number },
    msg: '',
    over: null as Hud['over'],
    view: null as View | null,
    rot: false,
    settings: readSettings(),
  })

  const snapshot = (): Hud => {
    const g = s.current
    const m = g.match
    return { phase: g.phase, mode: g.mode, rules: m.rules, turn: m.turn, groups: [...m.groups], scores: [...m.scores], shots: m.shots, onTable: g.balls.filter((b) => b.on).map((b) => b.id), msg: g.msg, over: g.over, hand: g.hand, muted: sound.current.muted }
  }
  const [hud, setHud] = useState<Hud>(snapshot)
  const sync = () => setHud(snapshot())
  const [spinDot, setSpinDot] = useState({ x: 0, y: 0 })
  const [portrait, setPortrait] = useState(false)

  const names = NAMES[hud.mode]
  const isCpuTurn = (g = s.current) => g.mode === 'cpu' && g.match.turn === 1

  const beginTurn = () => {
    const g = s.current
    g.power = 0
    g.press = null
    if (isCpuTurn()) {
      g.phase = 'cpu'
      g.cpu = { gen: plan(g.balls, g.match, g.hand, g.settings.level), start: performance.now(), t0: 0, from: g.aim }
    } else {
      g.phase = 'aim'
      g.spin = { x: 0, y: 0 }
      setSpinDot({ x: 0, y: 0 })
      if (g.match.isBreak) {
        const cue = g.balls[0]
        const apex = g.balls.reduce((a, b) => (b.id !== 0 && b.x < a.x ? b : a), g.balls[1])
        g.aim = Math.atan2(apex.y - cue.y, apex.x - cue.x)
      }
    }
    sync()
  }

  const start = (mode: Mode, rules: Rules) => {
    sound.current.wake()
    const g = s.current
    g.breaker = g.phase === 'menu' || mode === 'solo' ? 0 : ((1 - g.breaker) as 0 | 1)
    g.mode = mode
    g.balls = rack()
    g.match = newMatch(rules, mode === 'solo', g.breaker)
    g.hand = 'kitchen'
    g.falling = []
    g.over = null
    g.msg = mode === 'solo' ? 'Clear the table in as few shots as you can.' : `${NAMES[mode][g.breaker]} to break`
    sprites.current.clear()
    beginTurn()
  }

  const fire = (power: number) => {
    const g = s.current
    g.shot = { angle: g.aim, speed: powerToSpeed(power), side: g.spin.x, vert: g.spin.y }
    g.strikePower = power
    g.strikeAt = performance.now()
    g.phase = 'strike'
    g.press = null
  }

  const endShot = () => {
    const g = s.current
    const m = g.match
    const me = m.turn
    const out = judge(m, g.log, g.before)
    const n = NAMES[g.mode]
    const cue = g.balls[0]
    if (out.respot8) {
      const eight = g.balls.find((b) => b.id === 8)!
      const p = freeSpot(g.balls, FOOT_X, W / 2, eight)
      Object.assign(eight, { x: p.x, y: p.y, on: true })
    }
    if (!cue.on) {
      const p = freeSpot(g.balls, HEAD_X, W / 2, cue)
      Object.assign(cue, { x: p.x, y: p.y, on: true, vx: 0, vy: 0, wx: 0, wy: 0, wz: 0 })
    }
    const potted = g.log.pocketed.filter((id) => id !== 0).length

    if (out.winner !== null) {
      g.phase = 'over'
      g.match = { ...m, scores: out.scores, shots: out.shots }
      if (m.solo) {
        const cleared = out.winner === 0
        const best = soloBest[m.rules]
        const record = cleared && best.submit(out.shots)
        g.over = { title: cleared ? (record ? 'New best!' : 'Table cleared') : 'Game over', text: cleared ? `Cleared in ${out.shots} shots.${!record && best.best ? ` Best: ${best.best}.` : ''}` : `${out.reason?.replace(/^./, (c) => c.toUpperCase())}.` }
      } else {
        const w = n[out.winner]
        g.over = { title: `${w} ${w === 'You' ? 'win' : 'wins'}`, text: `${out.reason?.replace(/^./, (c) => c.toUpperCase())}.` }
        if (g.mode === 'cpu' && out.winner === 0) wins.submit((wins.best ?? 0) + 1)
      }
      g.msg = g.over.title
      sync()
      return
    }

    if (m.solo) {
      const left = g.balls.filter((b) => b.on && b.id !== 0).length
      g.msg = out.foul ? `Foul: ${out.foul.toLowerCase()}, that costs a shot. Ball in hand.` : `${potted ? (potted > 1 ? `${potted} in. ` : 'In. ') : ''}${left} left.`
    } else if (out.foul) g.msg = `Foul: ${out.foul.toLowerCase()}. ${n[out.next]} ${has(n[out.next])} ball in hand.`
    else if (!m.groups[me] && out.groups[me]) g.msg = `${n[me]} ${has(n[me])} ${out.groups[me]}${out.next === me ? ', and shoot again' : ''}.`
    else if (out.next === me) g.msg = `${n[me]} ${n[me] === 'You' ? 'shoot' : 'shoots'} again.`
    else g.msg = m.isBreak && out.respot8 ? `8 on the break, back on the spot. ${n[out.next]} to shoot.` : `${n[out.next]} to shoot.`
    g.match = { ...m, turn: out.next, groups: out.groups, scores: out.scores, shots: out.shots, isBreak: false }
    g.hand = out.ballInHand ? 'table' : null
    beginTurn()
  }

  // --- Main loop -------------------------------------------------------------------------------
  const sprites = useRef(new Map<number, Sprite>())
  const tableCanvas = useRef<HTMLCanvasElement | null>(null)
  const resizeRef = useRef<() => void>(() => {})

  // On a tall, narrow screen the table stands upright.
  useEffect(() => {
    const el = root.current!
    const check = () => setPortrait(el.clientWidth < 560 && el.clientHeight > el.clientWidth * 1.15)
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  useEffect(() => {
    s.current.rot = portrait
    resizeRef.current()
  }, [portrait])

  useEffect(() => {
    const c = canvas.current!
    const ctx = c.getContext('2d')!
    const resize = () => {
      const rot = s.current.rot
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const w = Math.max(200, Math.round(c.clientWidth * dpr))
      const h = Math.round((w * (rot ? TOTAL_W : TOTAL_H)) / (rot ? TOTAL_H : TOTAL_W))
      if (c.width === w && c.height === h && tableCanvas.current && s.current.view?.rot === rot) return
      c.width = w
      c.height = h
      // Everything is drawn in landscape table space; portrait just turns the canvas.
      const lw = rot ? h : w
      const v = { ...viewFor(lw), rot }
      s.current.view = v
      const t = document.createElement('canvas')
      t.width = lw
      t.height = rot ? w : h
      paintTable(t.getContext('2d')!, v)
      tableCanvas.current = t
      sprites.current.clear()
    }
    resizeRef.current = resize
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(c)

    // Stereo position of a sound, from where it happens on screen.
    const pan = (x: number, y: number) => (s.current.rot ? 1 - (2 * y) / W : (2 * x) / L - 1)
    const events: Events = {
      ball: (a, b, v) => {
        const log = s.current.log
        if (log.first === null && (a.id === 0 || b.id === 0)) log.first = a.id === 0 ? b.id : a.id
        sound.current.clack(v, pan((a.x + b.x) / 2, (a.y + b.y) / 2))
      },
      rail: (_b, v) => {
        if (s.current.log.first !== null) s.current.log.rail = true
        sound.current.rail(v)
      },
      pocket: (b, i) => {
        s.current.log.pocketed.push(b.id)
        s.current.falling.push({ ball: b, x: b.x, y: b.y, px: POCKETS[i][0], py: POCKETS[i][1], t: performance.now() })
        sound.current.pocket()
      },
    }

    const update = (dt: number, now: number) => {
      const g = s.current
      const cue = g.balls[0]
      if (g.phase === 'strike' && g.shot) {
        if (now - g.strikeAt >= STRIKE_MS) {
          g.log = newLog()
          g.before = g.balls.filter((b) => b.on).map((b) => b.id)
          strike(cue, g.shot.angle, g.shot.speed, g.shot.side, g.shot.vert)
          sound.current.cue(g.shot.speed, pan(cue.x, cue.y))
          g.hand = null
          g.phase = 'moving'
        }
      } else if (g.phase === 'moving') {
        simulate(g.balls, dt, events)
        sound.current.roll(g.balls.reduce((a, b) => a + (b.on ? Math.hypot(b.vx, b.vy) : 0), 0))
        if (allStopped(g.balls)) {
          sound.current.roll(0)
          endShot()
        }
      } else if (g.phase === 'cpu' && g.cpu) {
        const p = g.cpu
        if (!p.shot) {
          const until = performance.now() + 8
          while (performance.now() < until) {
            const r = p.gen.next()
            if (r.done) {
              p.shot = r.value
              p.t0 = Math.max(now, p.start + 700)
              p.from = g.aim
              if (r.value.place) {
                cue.x = r.value.place.x
                cue.y = r.value.place.y
              }
              g.spin = { x: r.value.side, y: r.value.vert }
              setSpinDot({ x: r.value.side * 1.6, y: -r.value.vert * 1.6 })
              break
            }
          }
        } else if (now >= p.t0) {
          const t = now - p.t0
          let d = p.shot.angle - p.from
          d = Math.atan2(Math.sin(d), Math.cos(d))
          g.aim = p.from + d * ease(t / 650)
          g.power = speedToPower(p.shot.speed) * ease((t - 700) / 500)
          if (t > 1400) {
            g.aim = p.shot.angle
            g.shot = p.shot
            g.strikePower = g.power
            g.strikeAt = now
            g.phase = 'strike'
            g.cpu = null
          }
        }
      }
    }

    const draw = (now: number) => {
      const g = s.current
      const v = g.view
      if (!v || !tableCanvas.current) return
      const X = (x: number) => v.ox + x * v.k
      const Y = (y: number) => v.oy + y * v.k
      const rp = R * v.k
      const plain = g.match.rules === 'simple'
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, c.width, c.height)
      if (v.rot) ctx.setTransform(0, 1, -1, 0, c.width, 0)
      ctx.drawImage(tableCanvas.current, 0, 0)
      const cue = g.balls[0]
      const human = g.phase === 'aim'

      if (human && g.hand === 'kitchen') {
        ctx.fillStyle = 'rgba(255,255,255,0.035)'
        ctx.fillRect(X(0), Y(0), HEAD_X * v.k, W * v.k)
      }

      // Shadows first, so no ball's shadow lands on another ball.
      for (const b of g.balls) {
        if (!b.on) continue
        const sx = X(b.x) + rp * 0.22
        const sy = Y(b.y) + rp * 0.3
        const grad = ctx.createRadialGradient(sx, sy, rp * 0.2, sx, sy, rp * 1.25)
        grad.addColorStop(0, 'rgba(0,0,0,0.5)')
        grad.addColorStop(1, 'rgba(0,0,0,0)')
        ctx.fillStyle = grad
        ctx.beginPath()
        ctx.arc(sx, sy, rp * 1.25, 0, Math.PI * 2)
        ctx.fill()
      }
      for (const b of g.balls) {
        if (!b.on) continue
        let sp = sprites.current.get(b.id)
        if (!sp || isMoving(b) || g.phase === 'menu') {
          sp = paintBall(b, rp, sp, plain)
          sprites.current.set(b.id, sp)
        }
        ctx.drawImage(sp.canvas, X(b.x) - sp.size / 2, Y(b.y) - sp.size / 2)
      }
      // Balls on their way down a pocket.
      g.falling = g.falling.filter((f) => {
        const t = (now - f.t) / 260
        if (t >= 1) return false
        const sp = sprites.current.get(f.ball.id)
        if (!sp) return false
        const sc = 1 - 0.45 * t
        ctx.globalAlpha = 1 - t
        const x = X(f.x + (f.px - f.x) * t)
        const y = Y(f.y + (f.py - f.y) * t)
        ctx.drawImage(sp.canvas, x - (sp.size * sc) / 2, y - (sp.size * sc) / 2, sp.size * sc, sp.size * sc)
        ctx.globalAlpha = 1
        return true
      })

      if (human && g.hand && !g.press) {
        ctx.strokeStyle = 'rgba(255,255,255,0.55)'
        ctx.setLineDash([4, 4])
        ctx.lineWidth = 1.5
        ctx.beginPath()
        ctx.arc(X(cue.x), Y(cue.y), rp * 1.5, 0, Math.PI * 2)
        ctx.stroke()
        ctx.setLineDash([])
      }

      if (human && g.settings.helpers && g.press?.kind !== 'cue') {
        // Aim guide: the cue ball's path to the first contact, the ghost ball there, and where the
        // object ball and the cue ball go next (the 90° rule; spin bends the real paths).
        const hit = castAim(g.balls, cue, g.aim)
        ctx.strokeStyle = 'rgba(255,255,255,0.6)'
        ctx.lineWidth = Math.max(1, v.k * 0.0025)
        ctx.setLineDash([v.k * 0.012, v.k * 0.012])
        ctx.beginPath()
        ctx.moveTo(X(cue.x), Y(cue.y))
        ctx.lineTo(X(hit.x), Y(hit.y))
        ctx.stroke()
        ctx.setLineDash([])
        ctx.beginPath()
        ctx.arc(X(hit.x), Y(hit.y), rp, 0, Math.PI * 2)
        ctx.stroke()
        if (hit.hit) {
          const nx = (hit.hit.x - hit.x) / (2 * R)
          const ny = (hit.hit.y - hit.y) / (2 * R)
          const dx = Math.cos(g.aim)
          const dy = Math.sin(g.aim)
          const cut = dx * nx + dy * ny
          ctx.strokeStyle = 'rgba(255,255,255,0.75)'
          ctx.beginPath()
          ctx.moveTo(X(hit.hit.x), Y(hit.hit.y))
          ctx.lineTo(X(hit.hit.x + nx * 0.06 * (1 + 4 * cut)), Y(hit.hit.y + ny * 0.06 * (1 + 4 * cut)))
          ctx.stroke()
          const tx = dx - cut * nx
          const ty = dy - cut * ny
          if (Math.hypot(tx, ty) > 0.05) {
            ctx.strokeStyle = 'rgba(255,255,255,0.3)'
            ctx.beginPath()
            ctx.moveTo(X(hit.x), Y(hit.y))
            ctx.lineTo(X(hit.x + tx * 0.2), Y(hit.y + ty * 0.2))
            ctx.stroke()
          }
        }
      }
      if (human || g.phase === 'cpu' || g.phase === 'strike') {
        let back = g.power * MAX_BACK
        if (g.phase === 'strike') back = g.strikePower * MAX_BACK * (1 - ease((now - g.strikeAt) / STRIKE_MS))
        if (g.phase !== 'cpu' || g.cpu?.shot) paintCue(ctx, v, cue.x, cue.y, g.aim, 0.004 + back)
      }

      // Power meter, in screen space at the right edge: how hard the stroke will be, and the speed
      // the cue ball leaves at.
      const power = g.phase === 'strike' ? g.strikePower : g.phase === 'aim' || g.phase === 'cpu' ? g.power : 0
      if (g.settings.helpers && power > 0.005) {
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        const u = c.width / 100
        const bw = Math.max(10, u * 1.4)
        const bh = c.height * (v.rot ? 0.3 : 0.5)
        const bx = c.width - bw - Math.max(8, u * 1.6)
        const by = (c.height - bh) / 2
        ctx.fillStyle = 'rgba(8,10,14,0.55)'
        ctx.beginPath()
        ctx.roundRect(bx - 3, by - 3, bw + 6, bh + 6, 4)
        ctx.fill()
        const grad = ctx.createLinearGradient(0, by + bh, 0, by)
        grad.addColorStop(0, '#9ece6a')
        grad.addColorStop(0.55, '#e0af68')
        grad.addColorStop(1, '#f7768e')
        ctx.fillStyle = grad
        ctx.fillRect(bx, by + bh * (1 - power), bw, bh * power)
        ctx.strokeStyle = 'rgba(255,255,255,0.25)'
        ctx.lineWidth = 1
        for (let i = 1; i < 4; i++) {
          ctx.beginPath()
          ctx.moveTo(bx, by + (bh * i) / 4)
          ctx.lineTo(bx + bw, by + (bh * i) / 4)
          ctx.stroke()
        }
        const fs = Math.max(11, u * 1.25)
        ctx.font = `600 ${fs}px ui-monospace, monospace`
        ctx.textAlign = 'right'
        ctx.fillStyle = '#fff'
        ctx.shadowColor = 'rgba(0,0,0,0.8)'
        ctx.shadowBlur = 4
        ctx.fillText(`${Math.round(power * 100)}%`, bx + bw, by - fs * 0.7)
        ctx.font = `${fs * 0.85}px ui-monospace, monospace`
        ctx.fillText(`${powerToSpeed(power).toFixed(1)} m/s`, bx + bw, by + bh + fs * 1.5)
        ctx.shadowBlur = 0
      }
    }

    let raf = 0
    let last = performance.now()
    const loop = (now: number) => {
      const dt = Math.min(0.04, (now - last) / 1000)
      last = now
      update(dt, now)
      draw(now)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [])

  useEffect(() => () => sound.current.dispose(), [])

  // --- Input -----------------------------------------------------------------------------------
  const toWorld = (e: React.PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect()
    const u = (e.clientX - r.left) / r.width
    const v = (e.clientY - r.top) / r.height
    // Upright, the table's length runs down the screen and its far side is on the left.
    if (s.current.rot) return { x: v * TOTAL_W - MARGIN, y: (1 - u) * TOTAL_H - MARGIN }
    return { x: u * TOTAL_W - MARGIN, y: v * TOTAL_H - MARGIN }
  }
  const aimAt = (p: { x: number; y: number }) => {
    const cue = s.current.balls[0]
    if (Math.hypot(p.x - cue.x, p.y - cue.y) > R * 0.5) s.current.aim = Math.atan2(p.y - cue.y, p.x - cue.x)
  }
  const placeCue = (p: { x: number; y: number }) => {
    const g = s.current
    const cue = g.balls[0]
    const x = Math.max(R, Math.min(g.hand === 'kitchen' ? HEAD_X : Infinity, p.x))
    if (fits(g.balls, x, p.y, cue)) {
      cue.x = x
      cue.y = p.y
    }
  }

  const onDown = (e: React.PointerEvent) => {
    sound.current.wake()
    const g = s.current
    if (g.phase !== 'aim' || e.button > 0) return
    ;(e.target as Element).setPointerCapture(e.pointerId)
    const p = toWorld(e)
    const cue = g.balls[0]
    if (g.hand && Math.hypot(p.x - cue.x, p.y - cue.y) < R * 1.8) g.press = { kind: 'cue', ...p }
    else if (e.pointerType === 'touch') {
      g.press = { kind: 'aim', ...p }
      aimAt(p)
    } else g.press = { kind: 'charge', ...p }
  }
  const onMove = (e: React.PointerEvent) => {
    const g = s.current
    if (g.phase !== 'aim') return
    const p = toWorld(e)
    const press = g.press
    if (!press) {
      if (e.pointerType !== 'touch') aimAt(p)
      return
    }
    if (press.kind === 'cue') placeCue(p)
    else if (press.kind === 'aim') aimAt(p)
    else {
      const pull = (press.x - p.x) * Math.cos(g.aim) + (press.y - p.y) * Math.sin(g.aim)
      g.power = Math.max(0, Math.min(1, pull / DRAG[g.settings.sensitivity]))
    }
  }
  const onUp = () => {
    const g = s.current
    if (g.phase !== 'aim' || !g.press) return
    if (g.press.kind === 'charge' && g.power > 0.02) fire(g.power)
    else {
      g.press = null
      g.power = 0
    }
  }

  // Power bar for touch screens: drag along it, let go to shoot; back to the start cancels.
  const powerBar = useRef<HTMLDivElement>(null)
  const [barPower, setBarPower] = useState(0)
  const barAt = (e: React.PointerEvent) => {
    const r = powerBar.current!.getBoundingClientRect()
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))
  }
  const barHandlers = {
    onPointerDown: (e: React.PointerEvent) => {
      sound.current.wake()
      if (s.current.phase !== 'aim') return
      ;(e.target as Element).setPointerCapture(e.pointerId)
      s.current.power = barAt(e)
      setBarPower(s.current.power)
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (!e.buttons || s.current.phase !== 'aim') return
      s.current.power = barAt(e)
      setBarPower(s.current.power)
    },
    onPointerUp: () => {
      if (s.current.phase === 'aim' && s.current.power > 0.03) fire(s.current.power)
      else s.current.power = 0
      setBarPower(0)
    },
  }

  // Spin: where the tip meets the cue ball. The dot's edge is half a radius from centre, about as
  // far out as a tip can go without a miscue.
  const spinRef = useRef<HTMLDivElement>(null)
  const setSpin = (e: React.PointerEvent) => {
    const r = spinRef.current!.getBoundingClientRect()
    let x = ((e.clientX - r.left) / r.width) * 2 - 1
    let y = ((e.clientY - r.top) / r.height) * 2 - 1
    const d = Math.hypot(x, y)
    if (d > 0.8) {
      x *= 0.8 / d
      y *= 0.8 / d
    }
    setSpinDot({ x, y })
    s.current.spin = { x: (x / 0.8) * 0.5, y: (-y / 0.8) * 0.5 }
  }
  const spinHandlers = {
    onPointerDown: (e: React.PointerEvent) => {
      if (s.current.phase !== 'aim') return
      ;(e.target as Element).setPointerCapture(e.pointerId)
      setSpin(e)
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (e.buttons && s.current.phase === 'aim') setSpin(e)
    },
    onDoubleClick: () => {
      if (s.current.phase !== 'aim') return
      setSpinDot({ x: 0, y: 0 })
      s.current.spin = { x: 0, y: 0 }
    },
  }

  const toggleMute = () => {
    sound.current.wake()
    sound.current.setMuted(!sound.current.muted)
    sync()
  }

  useGameKeys(win, (e) => {
    const g = s.current
    if (e.key === 'm' || e.key === 'M') toggleMute()
    if (g.phase !== 'aim') return
    const step = e.shiftKey ? 0.02 : 0.002
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') g.aim -= step
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') g.aim += step
  })

  const playing = hud.phase !== 'menu' && hud.phase !== 'over'
  const panel = (p: 0 | 1) => {
    const active = hud.turn === p && playing
    let detail: React.ReactNode
    if (hud.rules === 'simple') {
      detail = (
        <>
          <i className="pool-chip" style={{ ['--c' as string]: plainCss }} />
          {hud.scores[p]} of {WIN_SIMPLE}
        </>
      )
    } else if (hud.groups[p]) {
      const ids = hud.groups[p] === 'solids' ? [1, 2, 3, 4, 5, 6, 7] : [9, 10, 11, 12, 13, 14, 15]
      detail = (
        <>
          {ids.map((id) => <i key={id} className={`pool-chip ${id > 8 ? 'is-stripe' : ''} ${hud.onTable.includes(id) ? '' : 'is-gone'}`} style={{ ['--c' as string]: ballCss(id) }} />)}
          {!ids.some((id) => hud.onTable.includes(id)) && <i className="pool-chip" style={{ ['--c' as string]: ballCss(8) }} />}
        </>
      )
    } else detail = <span className="muted">open table</span>
    return (
      <div className={`pool-player ${active ? 'is-active' : ''}`}>
        <strong>{names[p]}</strong>
        <span className="pool-chips">{detail}</span>
      </div>
    )
  }
  const solo = hud.mode === 'solo'
  const soloRecord = soloBest[hud.rules].best

  return (
    <div className="game game-pool" ref={root}>
      <div className="game-bar pool-bar">
        {solo ? (
          <>
            <div className="pool-player is-active">
              <strong>Shots {hud.shots}</strong>
              <span className="pool-chips muted">{hud.onTable.filter((id) => id !== 0).length} balls left</span>
            </div>
            <span className="pool-msg">{hud.msg}</span>
            <div className="pool-player">
              <strong>Best</strong>
              <span className="pool-chips muted">{soloRecord ? `${soloRecord} shots` : '—'}</span>
            </div>
          </>
        ) : (
          <>
            {panel(0)}
            <span className="pool-msg">{hud.phase === 'cpu' ? 'Computer is lining up…' : hud.msg}</span>
            {panel(1)}
          </>
        )}
        <button className="pool-mute" onClick={toggleMute} title={hud.muted ? 'Sound off (M)' : 'Sound on (M)'} aria-label={hud.muted ? 'Turn sound on' : 'Turn sound off'}>
          {hud.muted ? '🔇' : '🔊'}
        </button>
      </div>
      <div className={`game-stage pool-stage ${portrait ? 'is-portrait' : ''}`}>
        <canvas
          ref={canvas}
          className="game-canvas pool-canvas"
          style={{ aspectRatio: portrait ? `${TOTAL_H} / ${TOTAL_W}` : `${TOTAL_W} / ${TOTAL_H}` }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onContextMenu={(e) => e.preventDefault()}
        />
        <div className={`pool-spin ${hud.phase === 'aim' ? '' : 'is-idle'}`} ref={spinRef} {...spinHandlers} title="Spin: drag the dot. Double-click to centre.">
          <span className="pool-spin-dot" style={{ left: `${50 + spinDot.x * 50}%`, top: `${50 + spinDot.y * 50}%` }} />
        </div>
        {!playing && (
          <div className="game-overlay pool-menu">
            <strong>{hud.over?.title ?? 'Pool'}</strong>
            <span>{hud.over?.text ?? 'A 9-foot table with real spin, throw and cushions.'}</span>
            <div className="seg pool-rules" role="radiogroup" aria-label="Game">
              <button role="radio" aria-checked={pick === 'eight'} className={pick === 'eight' ? 'is-active' : ''} onClick={() => setPick('eight')}>
                8-Ball
              </button>
              <button role="radio" aria-checked={pick === 'simple'} className={pick === 'simple' ? 'is-active' : ''} onClick={() => setPick('simple')}>
                Simple
              </button>
            </div>
            <span className="pool-rules-text">
              {pick === 'eight' ? 'Solids or stripes, then the 8.' : `All balls alike. Pot one, shoot again. First to ${WIN_SIMPLE} wins.`}
            </span>
            <div className="pool-settings">
              <span>Helpers</span>
              <div className="seg" role="radiogroup" aria-label="Helpers">
                {[true, false].map((on) => (
                  <button key={String(on)} role="radio" aria-checked={settings.helpers === on} className={settings.helpers === on ? 'is-active' : ''} onClick={() => changeSettings({ helpers: on })}>
                    {on ? 'On' : 'Off'}
                  </button>
                ))}
              </div>
              <span>Sensitivity</span>
              <div className="seg" role="radiogroup" aria-label="Sensitivity">
                {(['low', 'medium', 'high'] as const).map((k) => (
                  <button key={k} role="radio" aria-checked={settings.sensitivity === k} className={settings.sensitivity === k ? 'is-active' : ''} onClick={() => changeSettings({ sensitivity: k })}>
                    {k[0].toUpperCase() + k.slice(1)}
                  </button>
                ))}
              </div>
              <span>Computer</span>
              <div className="seg" role="radiogroup" aria-label="Computer difficulty">
                {LEVELS.map((k) => (
                  <button key={k} role="radio" aria-checked={settings.level === k} className={settings.level === k ? 'is-active' : ''} onClick={() => changeSettings({ level: k })}>
                    {k[0].toUpperCase() + k.slice(1)}
                  </button>
                ))}
              </div>
            </div>
            <span className="pool-rules-text muted">
              {settings.helpers ? 'Aim line and power meter shown. ' : 'No aim line or power meter. '}
              Full power takes a {Math.round(DRAG[settings.sensitivity] * 100)} cm pull on the table.
            </span>
            <div className="actions">
              <button className="btn btn-primary" onClick={() => start('cpu', pick)}>
                Play the computer
              </button>
              <button className="btn" onClick={() => start('duo', pick)}>
                Two players
              </button>
              <button className="btn" onClick={() => start('solo', pick)}>
                Solo
              </button>
            </div>
            <span className="pool-rules-text muted">
              Wins against the computer: {wins.best ?? 0}
              {soloBest[pick].best ? ` · solo best: ${soloBest[pick].best} shots` : ''}
            </span>
          </div>
        )}
      </div>
      <div className="pool-power touch-only" ref={powerBar} {...barHandlers}>
        <span style={{ width: `${barPower * 100}%` }} />
        <em>{barPower > 0 ? 'Let go to shoot' : 'Drag to set power, let go to shoot'}</em>
      </div>
      <p className="game-hint muted">
        {hud.hand && hud.phase === 'aim' ? 'Ball in hand: drag the cue ball to place it. ' : ''}
        <span className="pool-hint-mouse">Move the mouse to aim, hold and drag back to set power, let go to shoot. Arrow keys fine-tune the aim. </span>
        <span className="touch-only">Drag on the table to aim. </span>
        The dot bottom-left sets follow, draw and english.
      </p>
    </div>
  )
}
