// Pool physics in SI units: metres, seconds. x runs along the table and y across it, both as drawn
// on screen (y down), so z points into the cloth and the frame stays right-handed.
//
// A struck ball slides until the cloth's friction turns its spin into a natural roll, then rolls
// with a little resistance; side spin (about z) dies away on its own. Ball-ball and ball-cushion
// contacts carry friction too, which is what gives cut-induced and spin-induced throw, spin passed
// on to the object ball, and english that changes the angle off a rail.

export const R = 0.028575 // 2¼" balls
export const L = 2.54 // 9 ft table: 100" x 50" between the cushion noses
export const W = 1.27
export const HEAD_X = L / 4
export const FOOT_X = (3 * L) / 4

const G = 9.81
const MU_SLIDE = 0.2 // ball on cloth while sliding
const MU_ROLL = 0.012 // rolling resistance
const SPIN_DECEL = 22 // rad/s², side spin boring into the cloth
const E_BALL = 0.95
const MU_BALL = 0.06 // ball on ball
const MU_RAIL = 0.18 // ball on cushion rubber
const STEP = 1 / 1000

export type Ball = {
  id: number
  x: number
  y: number
  vx: number
  vy: number
  wx: number
  wy: number
  wz: number
  on: boolean
  /** Orientation for drawing: the ball's local x, y and z axes in world coordinates. */
  m: number[]
}

export type Events = {
  ball?: (a: Ball, b: Ball, speed: number) => void
  rail?: (b: Ball, speed: number) => void
  pocket?: (b: Ball, pocket: number) => void
}

// --- Table ---------------------------------------------------------------------------------------

type P = [number, number]
const CORNER = 0.081 // the corner cushion noses stop this far from the corner: a 4½" mouth
const SIDE = 0.0635 // half the 5" side pocket mouth
const DEG = Math.PI / 180
const CJ = 0.06 // jaw lengths
const SJ = 0.05

// Each cushion between two pockets is a polyline: jaw, nose, nose, jaw. Corner jaws leave the nose
// at 142°, so the corner pockets narrow towards the throat; side jaws at 104°.
const top: P[] = [
  [CORNER - CJ * Math.cos(38 * DEG), -CJ * Math.sin(38 * DEG)],
  [CORNER, 0],
  [L / 2 - SIDE, 0],
  [L / 2 - SIDE + SJ * Math.cos(76 * DEG), -SJ * Math.sin(76 * DEG)],
]
const end: P[] = [
  [-CJ * Math.sin(38 * DEG), CORNER - CJ * Math.cos(38 * DEG)],
  [0, CORNER],
  [0, W - CORNER],
  [-CJ * Math.sin(38 * DEG), W - CORNER + CJ * Math.cos(38 * DEG)],
]
const flipX = (p: P[]) => p.map(([x, y]) => [L - x, y] as P)
const flipY = (p: P[]) => p.map(([x, y]) => [x, W - y] as P)

export const CUSHIONS: P[][] = [top, flipX(top), flipY(top), flipY(flipX(top)), end, flipX(end)]
const SEGMENTS = CUSHIONS.flatMap((c) => c.slice(1).map((p, i) => [c[i][0], c[i][1], p[0], p[1]]))

/** Pocket centres, for drawing and for telling which pocket a ball dropped in. */
export const POCKETS: P[] = [
  [-0.032, -0.032],
  [L / 2, -0.048],
  [L + 0.032, -0.032],
  [-0.032, W + 0.032],
  [L / 2, W + 0.048],
  [L + 0.032, W + 0.032],
]
// The cushions keep every ball centre on the bed except in a pocket's throat, so a centre this far
// past a cushion line has gone over the edge.
const DROP = 0.021

// --- Balls ---------------------------------------------------------------------------------------

function randomOrientation(rnd: () => number) {
  const m = [1, 0, 0, 0, 1, 0, 0, 0, 1]
  for (let i = 0; i < 3; i++) rotate(m, rnd() - 0.5, rnd() - 0.5, rnd() - 0.5, 4)
  return m
}

export function makeBall(id: number, x: number, y: number, rnd = Math.random): Ball {
  return { id, x, y, vx: 0, vy: 0, wx: 0, wy: 0, wz: 0, on: true, m: randomOrientation(rnd) }
}

/** A fresh 8-ball rack: apex on the foot spot, the 8 in the middle, a solid and a stripe in the back
 * corners, everything else shuffled. The cue ball waits on the head spot. */
export function rack(rnd = Math.random): Ball[] {
  const shuffle = (a: number[]) => {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1))
      ;[a[i], a[j]] = [a[j], a[i]]
    }
    return a
  }
  const solids = shuffle([1, 2, 3, 4, 5, 6, 7])
  const stripes = shuffle([9, 10, 11, 12, 13, 14, 15])
  const order: number[] = new Array(15)
  order[4] = 8
  const flip = rnd() < 0.5
  order[10] = flip ? solids.pop()! : stripes.pop()!
  order[14] = flip ? stripes.pop()! : solids.pop()!
  const rest = shuffle([...solids, ...stripes])
  for (let i = 0; i < 15; i++) if (order[i] === undefined) order[i] = rest.pop()!

  const balls = [makeBall(0, HEAD_X, W / 2, rnd)]
  const gap = 0.0002 // racks are never perfectly tight
  let k = 0
  for (let row = 0; row < 5; row++) {
    for (let j = 0; j <= row; j++) {
      const jitter = () => (rnd() - 0.5) * 0.0001
      const x = FOOT_X + row * (2 * R + gap) * Math.cos(30 * DEG) + jitter()
      const y = W / 2 + (j - row / 2) * (2 * R + gap) + jitter()
      balls.push(makeBall(order[k++], x, y, rnd))
    }
  }
  return balls
}

export const isMoving = (b: Ball) => b.on && (b.vx * b.vx + b.vy * b.vy > 1e-10 || b.wx * b.wx + b.wy * b.wy + b.wz * b.wz > 1e-6)
export const allStopped = (balls: Ball[]) => !balls.some(isMoving)

/** Strikes the cue ball with a level cue. `side` and `vert` are where the tip meets the ball, as a
 * fraction of its radius (right and up are positive); much past half a radius is a miscue. */
export function strike(cue: Ball, angle: number, speed: number, side: number, vert: number) {
  // Squirt: english pushes the cue ball a little off the line, away from the side that was hit.
  const a = angle - side * 0.03
  const dx = Math.cos(a)
  const dy = Math.sin(a)
  cue.vx = speed * dx
  cue.vy = speed * dy
  // Angular impulse of an off-centre hit: ω = 5 v d / 2R². Hitting 0.4 R above centre gives a
  // natural roll straight away.
  const k = (5 * speed) / (2 * R)
  cue.wx = k * vert * dy
  cue.wy = -k * vert * dx
  cue.wz = -k * side
}

// --- Simulation ----------------------------------------------------------------------------------

/** Rotates an orientation by angular velocity w over time h (Rodrigues). */
export function rotate(m: number[], wx: number, wy: number, wz: number, h: number) {
  const w = Math.hypot(wx, wy, wz)
  if (w < 1e-9) return
  const th = w * h
  const kx = wx / w
  const ky = wy / w
  const kz = wz / w
  const c = Math.cos(th)
  const s = Math.sin(th)
  for (let i = 0; i < 9; i += 3) {
    const vx = m[i]
    const vy = m[i + 1]
    const vz = m[i + 2]
    const d = (kx * vx + ky * vy + kz * vz) * (1 - c)
    m[i] = vx * c + (ky * vz - kz * vy) * s + kx * d
    m[i + 1] = vy * c + (kz * vx - kx * vz) * s + ky * d
    m[i + 2] = vz * c + (kx * vy - ky * vx) * s + kz * d
  }
}

/** Keeps an orientation orthonormal against rounding drift. */
export function tidy(m: number[]) {
  let n = Math.hypot(m[0], m[1], m[2])
  m[0] /= n
  m[1] /= n
  m[2] /= n
  const d = m[0] * m[3] + m[1] * m[4] + m[2] * m[5]
  m[3] -= d * m[0]
  m[4] -= d * m[1]
  m[5] -= d * m[2]
  n = Math.hypot(m[3], m[4], m[5])
  m[3] /= n
  m[4] /= n
  m[5] /= n
  m[6] = m[1] * m[5] - m[2] * m[4]
  m[7] = m[2] * m[3] - m[0] * m[5]
  m[8] = m[0] * m[4] - m[1] * m[3]
}

function roll(b: Ball, h: number) {
  const v = Math.hypot(b.vx, b.vy)
  const nv = Math.max(0, v - MU_ROLL * G * h)
  const f = v > 0 ? nv / v : 0
  b.vx *= f
  b.vy *= f
  b.wx = b.vy / R
  b.wy = -b.vx / R
}

function move(b: Ball, h: number, spin: boolean) {
  // Velocity of the bottom of the ball over the cloth.
  const ux = b.vx + R * b.wy
  const uy = b.vy - R * b.wx
  const us = Math.hypot(ux, uy)
  if (us > 1e-4) {
    // Sliding friction shrinks the slip at 3.5 μg (2.5 of it through spin) until the ball rolls.
    const rate = 3.5 * MU_SLIDE * G
    const t = Math.min(h, us / rate)
    const ax = (-MU_SLIDE * G * ux) / us
    const ay = (-MU_SLIDE * G * uy) / us
    b.vx += ax * t
    b.vy += ay * t
    b.wx += ((-2.5 * ay) / R) * t
    b.wy += ((2.5 * ax) / R) * t
    if (t < h) roll(b, h - t)
  } else roll(b, h)
  const dz = SPIN_DECEL * h
  b.wz = Math.abs(b.wz) <= dz ? 0 : b.wz - Math.sign(b.wz) * dz
  if (b.vx * b.vx + b.vy * b.vy < 1e-8 && Math.abs(b.wz) < 0.05 && us < 1e-3) {
    b.vx = b.vy = b.wx = b.wy = b.wz = 0
  }
  if (spin) rotate(b.m, b.wx, b.wy, b.wz, h)
  b.x += b.vx * h
  b.y += b.vy * h
}

function collideBalls(a: Ball, b: Ball, ev?: Events) {
  let nx = b.x - a.x
  let ny = b.y - a.y
  const d = Math.hypot(nx, ny) || 1e-9
  nx /= d
  ny /= d
  const push = (2 * R - d) / 2
  a.x -= nx * push
  a.y -= ny * push
  b.x += nx * push
  b.y += ny * push
  const vn = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny
  if (vn <= 0) return
  // Normal impulse per unit mass; equal masses share it.
  const jn = ((1 + E_BALL) * vn) / 2
  a.vx -= jn * nx
  a.vy -= jn * ny
  b.vx += jn * nx
  b.vy += jn * ny
  // Friction where the surfaces touch: their slip, sideways and vertical (from top or back spin,
  // which is why a rolling cue ball throws less than a stunned one).
  let sx = a.vx - a.wz * ny * R - (b.vx + b.wz * ny * R)
  let sy = a.vy + a.wz * nx * R - (b.vy - b.wz * nx * R)
  const sz = (a.wx * ny - a.wy * nx) * R + (b.wx * ny - b.wy * nx) * R
  const sn = sx * nx + sy * ny
  sx -= sn * nx
  sy -= sn * ny
  const s = Math.hypot(sx, sy, sz)
  if (s > 1e-6) {
    const jt = Math.min(MU_BALL * jn, s / 7)
    const tx = sx / s
    const ty = sy / s
    const tz = sz / s
    a.vx -= jt * tx
    a.vy -= jt * ty
    b.vx += jt * tx
    b.vy += jt * ty
    // Torque from the sideways part changes side spin, the same way on both balls.
    const dwz = (-(nx * ty - ny * tx) * jt * 2.5) / R
    a.wz += dwz
    b.wz += dwz
    // The vertical part acts at the equator and nudges the rolling spin.
    const k = (jt * tz * 2.5) / R
    a.wx -= ny * k
    a.wy += nx * k
    b.wx -= ny * k
    b.wy += nx * k
  }
  ev?.ball?.(a, b, vn)
}

function collideRails(b: Ball, ev?: Events) {
  for (const [ax, ay, bx, by] of SEGMENTS) {
    const ex = bx - ax
    const ey = by - ay
    const t = Math.max(0, Math.min(1, ((b.x - ax) * ex + (b.y - ay) * ey) / (ex * ex + ey * ey)))
    const px = ax + ex * t
    const py = ay + ey * t
    const dx = px - b.x
    const dy = py - b.y
    const d2 = dx * dx + dy * dy
    if (d2 >= R * R) continue
    const d = Math.sqrt(d2) || 1e-9
    // n points from the ball into the cushion.
    const nx = dx / d
    const ny = dy / d
    b.x -= nx * (R - d)
    b.y -= ny * (R - d)
    const vn = b.vx * nx + b.vy * ny
    if (vn <= 0) continue
    // Rubber gives back less of a hard hit than a soft one.
    const e = Math.max(0.55, 0.92 - 0.045 * vn)
    const jn = (1 + e) * vn
    b.vx -= jn * nx
    b.vy -= jn * ny
    // Friction against the rubber: english grips and changes the rebound angle.
    let sx = b.vx - b.wz * ny * R
    let sy = b.vy + b.wz * nx * R
    const sn = sx * nx + sy * ny
    sx -= sn * nx
    sy -= sn * ny
    const s = Math.hypot(sx, sy)
    if (s > 1e-6) {
      const jt = Math.min(MU_RAIL * jn, s / 3.5)
      const tx = sx / s
      const ty = sy / s
      b.vx -= jt * tx
      b.vy -= jt * ty
      b.wz += (-(nx * ty - ny * tx) * jt * 2.5) / R
    }
    // The nose sits above the ball's equator, so it also eats into the roll the ball came in with.
    const tx = -ny
    const ty = nx
    const wt = b.wx * tx + b.wy * ty
    b.wx -= 0.7 * wt * tx
    b.wy -= 0.7 * wt * ty
    ev?.rail?.(b, vn)
  }
}

function substep(balls: Ball[], h: number, ev: Events | undefined, spin: boolean) {
  const moving = balls.map(isMoving)
  for (let i = 0; i < balls.length; i++) if (moving[i]) move(balls[i], h, spin)
  for (let i = 0; i < balls.length; i++) {
    const a = balls[i]
    if (!a.on) continue
    for (let j = i + 1; j < balls.length; j++) {
      const b = balls[j]
      if (!b.on || (!moving[i] && !moving[j])) continue
      const dx = b.x - a.x
      const dy = b.y - a.y
      if (dx * dx + dy * dy < 4 * R * R) collideBalls(a, b, ev)
    }
  }
  for (let i = 0; i < balls.length; i++) {
    const b = balls[i]
    if (!b.on || !moving[i]) continue
    // Only near the edge can a ball touch a cushion.
    if (b.x < R + 0.07 || b.x > L - R - 0.07 || b.y < R + 0.07 || b.y > W - R - 0.07) collideRails(b, ev)
    if (b.x < -DROP || b.x > L + DROP || b.y < -DROP || b.y > W + DROP) {
      b.on = false
      let best = 0
      POCKETS.forEach(([px, py], k) => {
        if (Math.hypot(px - b.x, py - b.y) < Math.hypot(POCKETS[best][0] - b.x, POCKETS[best][1] - b.y)) best = k
      })
      b.vx = b.vy = b.wx = b.wy = b.wz = 0
      ev?.pocket?.(b, best)
    }
  }
}

/** Advances the table by dt seconds in fixed small steps. With `spin`, ball orientations are
 * tracked too, for drawing. */
export function simulate(balls: Ball[], dt: number, ev?: Events, spin = true) {
  const n = Math.max(1, Math.ceil(dt / STEP - 1e-6))
  for (let i = 0; i < n; i++) substep(balls, dt / n, ev, spin)
  if (spin) for (const b of balls) tidy(b.m)
}

export const cloneBalls = (balls: Ball[]): Ball[] => balls.map((b) => ({ ...b }))

/** Where a cue ball sent along `angle` first touches something: the ghost-ball position, and the
 * ball it hits, if any. */
export function castAim(balls: Ball[], cue: Ball, angle: number): { x: number; y: number; hit: Ball | null } {
  const dx = Math.cos(angle)
  const dy = Math.sin(angle)
  let t = Infinity
  let hit = null as Ball | null
  for (const o of balls) {
    if (!o.on || o === cue) continue
    const cx = cue.x - o.x
    const cy = cue.y - o.y
    const b = dx * cx + dy * cy
    const c = cx * cx + cy * cy - 4 * R * R
    const disc = b * b - c
    if (disc < 0) continue
    const tt = -b - Math.sqrt(disc)
    if (tt > 0 && tt < t) {
      t = tt
      hit = o
    }
  }
  // Otherwise the cushion: the rectangle a ball centre can reach.
  if (!hit) {
    const tx = dx > 0 ? (L - R - cue.x) / dx : dx < 0 ? (R - cue.x) / dx : Infinity
    const ty = dy > 0 ? (W - R - cue.y) / dy : dy < 0 ? (R - cue.y) / dy : Infinity
    t = Math.max(0, Math.min(tx, ty))
  }
  return { x: cue.x + dx * t, y: cue.y + dy * t, hit }
}

/** True if a ball centred at (x, y) would sit on the bed without touching another ball. */
export function fits(balls: Ball[], x: number, y: number, skip?: Ball) {
  if (x < R || x > L - R || y < R || y > W - R) return false
  return balls.every((b) => !b.on || b === skip || Math.hypot(b.x - x, b.y - y) >= 2 * R + 0.0005)
}

/** The free spot nearest (x, y), searching outwards, optionally only left of `maxX`. */
export function freeSpot(balls: Ball[], x: number, y: number, skip?: Ball, maxX = L) {
  for (let r = 0; r < 1.2; r += R / 2) {
    const n = r === 0 ? 1 : Math.ceil((2 * Math.PI * r) / (R / 2))
    for (let i = 0; i < n; i++) {
      const px = x + r * Math.cos((i / n) * 2 * Math.PI)
      const py = y + r * Math.sin((i / n) * 2 * Math.PI)
      if (px <= maxX && fits(balls, px, py, skip)) return { x: px, y: py }
    }
  }
  return { x, y }
}
