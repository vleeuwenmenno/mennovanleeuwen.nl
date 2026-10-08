import { allStopped, castAim, cloneBalls, fits, freeSpot, HEAD_X, L, R, simulate, strike, W, type Ball } from './physics'
import { judge, legalTargets, newLog, type Match } from './rules'

// The computer player. It lists the pots that look possible from the geometry, plays each one out
// with the real physics at a few speeds and spins, and keeps the shot whose outcome scores best,
// counting how many easy shots it leaves for itself. Then it misses a little, like people do.

export type Shot = { angle: number; speed: number; side: number; vert: number; place?: { x: number; y: number } }
export type Hand = 'kitchen' | 'table' | null
export type Level = 'easy' | 'medium' | 'hard'

// How good the computer is: how many pots it considers, which spins it tries for position, and
// how far its stroke strays from the plan (aim in radians, speed as a fraction).
// `safe` is how many of the best shots it replays slightly mis-hit, keeping the one that still
// works when the stroke is off.
// `nudge` are aim corrections it also tries around the ghost-ball line, which is what finds the
// allowance for throw on a cut.
const LEVELS: Record<Level, { pots: number; verts: number[]; nudge: number[]; aim: number; speed: number; safe: number }> = {
  easy: { pots: 3, verts: [0.1], nudge: [0], aim: 0.009, speed: 0.08, safe: 0 },
  medium: { pots: 7, verts: [0.3, -0.25], nudge: [0], aim: 0.0022, speed: 0.03, safe: 0 },
  hard: { pots: 8, verts: [0.35, -0.3], nudge: [-0.006, 0, 0.006], aim: 0.0007, speed: 0.015, safe: 4 },
}

// Where to send a ball for each pocket: just inside the mouth.
const AIM = [
  [0.012, 0.012],
  [L / 2, -0.012],
  [L - 0.012, 0.012],
  [0.012, W - 0.012],
  [L / 2, W + 0.012],
  [L - 0.012, W - 0.012],
]

const clear = (balls: Ball[], ax: number, ay: number, bx: number, by: number, skip: Ball[]) => {
  const ex = bx - ax
  const ey = by - ay
  const len2 = ex * ex + ey * ey
  return balls.every((o) => {
    if (!o.on || skip.includes(o)) return true
    const t = Math.max(0, Math.min(1, ((o.x - ax) * ex + (o.y - ay) * ey) / len2))
    return Math.hypot(ax + ex * t - o.x, ay + ey * t - o.y) >= 2 * R
  })
}

type Pot = { target: Ball; gx: number; gy: number; score: number }

/** Pots that look makeable from (cx, cy), best first. */
function pots(balls: Ball[], targets: Ball[], cx: number, cy: number): Pot[] {
  const cue = balls[0]
  const out: Pot[] = []
  for (const t of targets) {
    for (const [px, py] of AIM) {
      const dx = px - t.x
      const dy = py - t.y
      const d2 = Math.hypot(dx, dy)
      // The side pockets refuse balls coming in along the rail.
      if ((py < 0 || py > W) && Math.abs(dy) / d2 < 0.45) continue
      const gx = t.x - (dx / d2) * 2 * R
      const gy = t.y - (dy / d2) * 2 * R
      const d1 = Math.hypot(gx - cx, gy - cy)
      if (d1 < 1e-6) continue
      const cut = ((gx - cx) * dx + (gy - cy) * dy) / (d1 * d2)
      if (cut < 0.25) continue // thinner than about 75°
      if (!clear(balls, cx, cy, gx, gy, [cue, t]) || !clear(balls, t.x, t.y, px, py, [cue, t])) continue
      out.push({ target: t, gx, gy, score: cut * cut / (0.4 + d1 * 0.5 + d2) })
    }
  }
  return out.sort((a, b) => b.score - a.score)
}

/** Where to put the cue ball with ball in hand: straight behind the easiest pot. */
function placeCue(balls: Ball[], m: Match, hand: Hand) {
  const cue = balls[0]
  const maxX = hand === 'kitchen' ? HEAD_X : L
  // Pots judged from the ghost ball only: any approach works when you can place the cue ball.
  const ranked = legalTargets(balls, m)
    .flatMap((t) =>
      AIM.map(([px, py]) => {
        const dx = px - t.x
        const dy = py - t.y
        const d = Math.hypot(dx, dy)
        return { t, ux: dx / d, uy: dy / d, d }
      }),
    )
    .sort((a, b) => a.d - b.d)
  for (const r of ranked) {
    for (const back of [0.25, 0.4, 0.15, 0.6]) {
      for (const tilt of [0, 0.25, -0.25, 0.5, -0.5]) {
        const c = Math.cos(tilt)
        const s = Math.sin(tilt)
        const ux = r.ux * c - r.uy * s
        const uy = r.ux * s + r.uy * c
        const x = r.t.x - r.ux * 2 * R - ux * back
        const y = r.t.y - r.uy * 2 * R - uy * back
        if (x > maxX || !fits(balls, x, y, cue)) continue
        const p = pots(balls, [r.t], x, y)
        if (p.length) return { x, y }
      }
    }
  }
  return freeSpot(balls, hand === 'kitchen' ? HEAD_X - 0.2 : L / 2, W / 2, cue, maxX)
}

/** Shots left from the cue ball's resting place: a rough measure of position. */
function openPots(balls: Ball[], m: Match) {
  const cue = balls[0]
  if (!cue.on) return 0
  return Math.min(4, pots(balls, legalTargets(balls, m), cue.x, cue.y).length)
}

function playOut(balls: Ball[], m: Match, shot: Shot) {
  const sim = cloneBalls(balls)
  const log = newLog()
  const before = sim.filter((b) => b.on).map((b) => b.id)
  strike(sim[0], shot.angle, shot.speed, shot.side, shot.vert)
  const ev = {
    ball: (a: Ball, b: Ball) => {
      if (log.first === null && (a.id === 0 || b.id === 0)) log.first = a.id === 0 ? b.id : a.id
    },
    rail: () => {
      if (log.first !== null) log.rail = true
    },
    pocket: (b: Ball) => {
      log.pocketed.push(b.id)
    },
  }
  for (let t = 0; t < 14 && !allStopped(sim); t += 0.05) simulate(sim, 0.05, ev, false)
  const out = judge(m, log, before)
  const me = m.turn
  let score = 0
  if (out.winner === me) score = 10000
  else if (out.winner !== null) score = -10000
  else if (out.foul) score = -400
  else if (out.next === me) score = 300 + 25 * openPots(sim, { ...m, groups: out.groups, isBreak: false })
  else score = -20 * openPots(sim, { ...m, turn: (1 - me) as 0 | 1, groups: out.groups, isBreak: false })
  return score - shot.speed // between equals, the softer shot
}

const gauss = () => {
  let u = 0
  while (u === 0) u = Math.random()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random())
}

/** Plans the computer's shot. A generator, so the caller can spread the thinking over frames. */
export function* plan(balls: Ball[], m: Match, hand: Hand, level: Level = 'medium'): Generator<void, Shot> {
  const skill = LEVELS[level]
  const cue = balls[0]
  if (m.isBreak) {
    const place = freeSpot(balls, HEAD_X, W / 2 + (Math.random() - 0.5) * 0.3, cue, HEAD_X)
    const apex = balls.reduce((a, b) => (b.id !== 0 && b.on && b.x < a.x ? b : a), balls[1])
    return { place, angle: Math.atan2(apex.y - place.y, apex.x - place.x) + gauss() * 0.004, speed: 8 + Math.random() * 0.8, side: 0, vert: 0.05 }
  }

  const work = cloneBalls(balls)
  let place: { x: number; y: number } | undefined
  if (hand) {
    place = placeCue(work, m, hand)
    work[0].x = place.x
    work[0].y = place.y
  }
  const wc = work[0]
  const targets = legalTargets(work, m)
  const cands: Shot[] = []
  for (const p of pots(work, targets, wc.x, wc.y).slice(0, skill.pots)) {
    const angle = Math.atan2(p.gy - wc.y, p.gx - wc.x)
    const dist = Math.hypot(p.gx - wc.x, p.gy - wc.y) + Math.hypot(p.target.x - p.gx, p.target.y - p.gy)
    const base = 1 + dist * 0.9
    for (const speed of [base * 0.75, base * 1.15, base * 1.7]) for (const vert of skill.verts) for (const n of skill.nudge) cands.push({ angle: angle + n, speed: Math.min(7, speed), side: 0, vert })
  }
  if (!cands.length) {
    // Nothing to pot: hit something legal and hope for the best.
    for (const t of targets) {
      const angle = Math.atan2(t.y - wc.y, t.x - wc.x)
      if (castAim(work, wc, angle).hit !== t) continue
      for (const speed of [1.2, 2, 3.2]) cands.push({ angle, speed, side: 0, vert: 0 })
    }
    for (let i = 0; cands.length < 6 && i < 36; i++) cands.push({ angle: (i / 36) * Math.PI * 2, speed: 2.5, side: 0, vert: 0 })
  }
  const scored: { c: Shot; s: number }[] = []
  for (const c of cands) {
    scored.push({ c, s: playOut(work, m, c) })
    yield
  }
  scored.sort((a, b) => b.s - a.s)
  for (const r of scored.slice(0, skill.safe)) {
    for (const off of [-0.003, 0.003]) {
      r.s = Math.min(r.s, playOut(work, m, { ...r.c, angle: r.c.angle + off, speed: r.c.speed * (1 + off * 10) }))
      yield
    }
  }
  if (skill.safe) scored.sort((a, b) => b.s - a.s)
  const best = scored[0].c
  return { ...best, place, angle: best.angle + gauss() * skill.aim, speed: best.speed * (1 + gauss() * skill.speed) }
}
