import type { FactionId } from '../data.ts'
import { drawHull, drawPart } from '../models/paint.ts'
import type { HullState, Model } from '../models/types.ts'
import type { Unit } from '../sim.ts'
import { EmpiresSound } from '../sound.ts'

// How a squad's members die on the battle screen. The sim only decides when a member falls (its
// squad's crew shrinking, ground/squad.ts) and notes the ground weapon that hit the squad last, where
// from and whose (Unit `gHit`, `gHitX`, `gHitY`, `gHitF`, never in the hash); everything here is
// drawing, cartoon rather than gore:
// - a trooper is knocked back in a burst of blaster sparks and lies where it lands, burnt;
// - a droid comes apart with an electrical pop and sparks, its head, arms and blaster flying off and
//   lying round it as scrap, a splash of oil under it;
// - a bug bursts in a spray of chitin and ichor and lies curled up, legs drawn in, on a green stain.
// Explosives (rockets, shells, artillery, swarm rockets) throw a body further, spinning, and leave a
// scorch mark; a spray melts it instead (a flame chars it to ash, gas and acid dissolve it into a
// puddle). Each member falls its own way, from a seed of its own (its squad and number): direction,
// how far, which parts fly, so a squad never dies in step. Bodies lie a while, then fade; the
// oldest go first once there are many. A death makes a small sound of its faction, a few at a time
// at most (EmpiresSound.death).
//
// Cheap with big armies: bodies are the members' own cached bitmaps (one look per pose and burn),
// flying parts the cached part bitmaps that wrecks use, stains a few small sprites painted once;
// nothing is allocated per frame.

type Style = 'zap' | 'blast' | 'melt'
/** A part flung off a droid: which part, where it lands (from the body's rest), how far it turns. */
type Fling = { part: number; ex: number; ey: number; spin: number }
type Body = {
  m: Model
  f: FactionId
  style: Style
  /** A melt: whose spray (a flame chars, gas and acid dissolve). */
  melt: FactionId | null
  /** Where it stood, and where it comes to rest. */
  x: number
  y: number
  ex: number
  ey: number
  rot0: number
  rot1: number
  /** How high it is thrown (world units) and how long until it lands. */
  hop: number
  dur: number
  size: number
  at: number
  seed: number
  state: HullState
  fling: Fling[] | null
}
type StainKind = 'scorch' | 'oil' | 'ichor' | 'acid' | 'gas'
type Stain = { kind: StainKind; v: number; x: number; y: number; r: number; rot: number; at: number }

/** Seconds a body lies before it fades, and how long the fading takes (a melted one is gone sooner). */
const LIE = 24
const FADE = 6
const MELT = 1.8
/** Seconds a stain stays, and fades. */
const STAIN = 30
const STAIN_FADE = 6
/** The most bodies and stains kept: past that the oldest go. */
const MAX_BODIES = 160
const MAX_STAINS = 120
/** Seconds the sparks, shards and pops of a death last. */
const BURST = 0.7
/** Which of a droid's loose parts (bits of Model `detachable`: head, arms, blaster) fly off: one of
 * these, three each. */
const BREAKS = [0b1011, 0b0111, 0b1110, 0b1101]

const bodies: Body[] = []
const stains: Stain[] = []
/** The view when last drawn (for a death's sound: how far off and to which side). */
const view = { x0: 0, y0: 0, x1: 1, y1: 1, zoom: 1 }
type Box = { x0: number; y0: number; x1: number; y1: number }
const inView = (box: Box, x: number, y: number, r: number) => x > box.x0 - r && x < box.x1 + r && y > box.y0 - r && y < box.y1 + r

/** A number in [0, 1) from a member's seed and a draw number: the same every time. */
function rnd(seed: number, i: number) {
  let h = Math.imul(seed ^ Math.imul(i + 1, 0x9e3779b1), 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

const styleOf = (u: Unit): Style => {
  const g = u.gHit
  if (g === 'spray') return 'melt'
  if (g === 'artillery' || g === 'swarm' || g === 'shell' || g === 'rocket') return 'blast'
  return 'zap'
}

function addStain(kind: StainKind, x: number, y: number, r: number, seed: number, at: number) {
  if (stains.length >= MAX_STAINS) stains.splice(0, 1)
  stains.push({ kind, v: Math.floor(rnd(seed, 40) * 3), x, y, r, rot: rnd(seed, 41) * Math.PI * 2, at })
}

/**
 * Member `key` of squad `u` falls, standing at (x, y) facing `a`, drawn `size` world units long as
 * model `m`: how it falls follows the last weapon that hit the squad.
 */
export function memberFell(u: Unit, m: Model, x: number, y: number, a: number, size: number, key: number, clock: number) {
  const seed = (Math.imul(u.id, 73856093) ^ Math.imul(key + 1, 19349663)) | 0
  const f = m.faction
  const style = styleOf(u)
  // Thrown away from where the hit came from (else backwards), a little off line.
  let dx = u.gHitX === undefined ? -Math.cos(a) : x - u.gHitX
  let dy = u.gHitY === undefined ? -Math.sin(a) : y - u.gHitY
  const len = Math.hypot(dx, dy) || 1
  const off = (rnd(seed, 1) - 0.5) * (style === 'blast' ? 1.4 : 0.9)
  const ca = Math.cos(off)
  const sa = Math.sin(off)
  ;[dx, dy] = [(dx / len) * ca - (dy / len) * sa, (dx / len) * sa + (dy / len) * ca]
  const far = style === 'blast' ? size * (1.4 + rnd(seed, 2) * 1.4) : style === 'zap' ? size * (0.25 + rnd(seed, 2) * 0.45) : size * 0.08
  const rot0 = a + Math.PI / 2
  const turn = (rnd(seed, 3) - 0.5) * (style === 'blast' ? 7 : 1.8) + (rnd(seed, 4) < 0.5 ? -0.4 : 0.4)
  // Lying sprawled: mid-stride legs (a bug draws its legs in, see drawCurled).
  const pose = !m.walk ? 0 : f === 'swarm' ? 7 : rnd(seed, 5) < 0.5 ? 1 : 2
  const scorch = style === 'blast' ? 2 : style === 'melt' && u.gHitF === 'republic' ? 3 : f === 'swarm' ? 0 : 1
  // A droid comes apart: three of its four loose parts fly off, in one of four ways (few looks
  // of the body left behind, so few bitmaps).
  let mask = 0
  let fling: Fling[] | null = null
  if (f === 'droid' && m.detachable.length) {
    fling = []
    const n = m.detachable.length
    const pick = BREAKS[Math.floor(rnd(seed, 10) * BREAKS.length)]
    for (let i = 0; i < n && i < 8; i++) {
      if (!(pick & (1 << i))) continue
      mask |= 1 << i
      const ang = Math.atan2(dy, dx) + (rnd(seed, 20 + i) - 0.5) * 2.6
      const d = size * (0.5 + rnd(seed, 30 + i) * 0.9) * (style === 'blast' ? 1.8 : 1)
      fling.push({ part: m.detachable[i], ex: Math.cos(ang) * d, ey: Math.sin(ang) * d, spin: (rnd(seed, 35 + i) - 0.5) * 14 })
    }
  }
  if (bodies.length >= MAX_BODIES) bodies.splice(0, 1)
  const ex = x + dx * far
  const ey = y + dy * far
  bodies.push({
    m, f, style, melt: style === 'melt' ? (u.gHitF ?? 'swarm') : null, x, y, ex, ey, rot0, rot1: rot0 + turn,
    hop: style === 'blast' ? size * (0.6 + rnd(seed, 6) * 0.6) : 0, dur: style === 'blast' ? 0.55 : 0.3,
    size, at: clock, seed, state: { detached: mask, scorch, variant: 0, pose }, fling,
  })
  // What it leaves on the ground.
  if (style === 'melt') addStain(u.gHitF === 'republic' ? 'scorch' : u.gHitF === 'droid' ? 'gas' : 'acid', ex, ey, size * 0.75, seed, clock)
  else {
    if (style === 'blast') addStain('scorch', x, y, size * (0.55 + rnd(seed, 7) * 0.3), seed, clock)
    if (f === 'droid') addStain('oil', ex, ey, size * 0.5, seed + 1, clock)
    else if (f === 'swarm') addStain('ichor', ex, ey, size * (style === 'blast' ? 1.1 : 0.75), seed + 1, clock)
    else if (style === 'zap') addStain('scorch', ex, ey, size * 0.32, seed + 1, clock)
  }
  // Its sound, panned and as loud as where it is in the view.
  const snd = EmpiresSound.active
  if (snd) {
    const hw = (view.x1 - view.x0) / 2 || 1
    const hh = (view.y1 - view.y0) / 2 || 1
    const nx = (x - (view.x0 + hw)) / hw
    const ny = (y - (view.y0 + hh)) / hh
    const d = Math.hypot(nx, ny) * 0.5
    snd.death(f, { pan: Math.max(-1, Math.min(1, nx)) * 0.7, gain: Math.max(0, Math.min(1, 1.15 - d * 1.3)) * (0.35 + 0.65 * Math.min(1, view.zoom * 1.6)) })
  }
}

// --- Stains -------------------------------------------------------------------------------------------

const STAIN_COLOURS: Record<StainKind, [string, string]> = {
  scorch: ['rgba(18,13,9,0.62)', 'rgba(40,30,22,0.3)'],
  oil: ['rgba(16,18,24,0.7)', 'rgba(40,44,56,0.35)'],
  ichor: ['rgba(120,196,64,0.62)', 'rgba(150,220,90,0.32)'],
  acid: ['rgba(150,232,96,0.6)', 'rgba(190,255,120,0.3)'],
  gas: ['rgba(196,214,92,0.55)', 'rgba(220,236,120,0.28)'],
}
const KINDS: StainKind[] = ['scorch', 'oil', 'ichor', 'acid', 'gas']
/** The stains' sprites, in one canvas painted once: three of each kind in a row, 64 pixels each, a
 * lumpy splat with droplets round it. */
let atlas: HTMLCanvasElement | null = null
function stainAtlas() {
  if (atlas) return atlas
  atlas = document.createElement('canvas')
  atlas.width = 64 * 3
  atlas.height = 64 * KINDS.length
  const g = atlas.getContext('2d')!
  KINDS.forEach((kind, row) => {
    for (let v = 0; v < 3; v++) {
      g.save()
      g.translate(v * 64, row * 64)
      paintStain(g, kind, v)
      g.restore()
    }
  })
  return atlas
}
function paintStain(g: CanvasRenderingContext2D, kind: StainKind, v: number) {
  const seed = v * 977 + kind.length * 131
  const [core, edge] = STAIN_COLOURS[kind]
  const blob = (x: number, y: number, r: number, s: number, fill: string) => {
    g.fillStyle = fill
    g.beginPath()
    for (let i = 0; i <= 10; i++) {
      const a = (i / 10) * Math.PI * 2
      const k = 0.7 + rnd(s, i % 10) * 0.45
      const px = x + Math.cos(a) * r * k
      const py = y + Math.sin(a) * r * k
      if (i) g.lineTo(px, py)
      else g.moveTo(px, py)
    }
    g.fill()
  }
  blob(32, 32, 24, seed, edge)
  blob(32, 32, 16, seed + 3, core)
  for (let i = 0; i < 6; i++) {
    const a = rnd(seed, 20 + i) * Math.PI * 2
    const d = 20 + rnd(seed, 30 + i) * 9
    blob(32 + Math.cos(a) * d, 32 + Math.sin(a) * d, 2 + rnd(seed, 40 + i) * 3, seed + 50 + i, core)
  }
}

// --- Drawing ------------------------------------------------------------------------------------------

/** A bug lying curled up: its legs drawn in as little hooks round its body. */
function drawCurled(ctx: CanvasRenderingContext2D, x: number, y: number, rot: number, size: number, alpha: number) {
  const c = Math.cos(rot)
  const s = Math.sin(rot)
  ctx.globalAlpha = alpha
  ctx.strokeStyle = '#2c2238'
  ctx.lineWidth = size * 0.07
  ctx.beginPath()
  for (let i = 0; i < 6; i++) {
    const side = i < 3 ? -1 : 1
    const fy = ((i % 3) - 1) * size * 0.16
    const fx = side * size * 0.17
    const px = x + c * fx - s * fy
    const py = y + s * fx + c * fy
    const a0 = rot + (side < 0 ? Math.PI : 0) - 0.9
    ctx.moveTo(px + Math.cos(a0) * size * 0.08, py + Math.sin(a0) * size * 0.08)
    ctx.arc(px, py, size * 0.08, a0, a0 + 2.2)
  }
  ctx.stroke()
  ctx.globalAlpha = 1
}

const LIT = { lightRot: 0 }
const SPARK = ['#fff3c4', '#ffb14a']
const ZAP = ['#e8fbff', '#62e0ff']
const SHARD = '#ddd2dc'
const ICHOR = '#a5e55f'
const MELT_TINT: Record<FactionId, string> = { republic: '#ff963c', droid: '#cee260', swarm: '#a0f064' }

/** The burst of a death: sparks, shards, a pop, bubbles, `p` (0..1) of the way through it. */
function drawBurst(ctx: CanvasRenderingContext2D, b: Body, age: number) {
  const p = age / BURST
  const sz = b.size
  const base = Math.atan2(b.ey - b.y, b.ex - b.x)
  const lw = Math.max(0.6, sz * 0.05)
  if (b.style === 'melt') {
    // Bubbles rising as it dissolves.
    ctx.fillStyle = MELT_TINT[b.melt ?? 'swarm']
    ctx.globalAlpha = 0.7 * (1 - age / MELT)
    ctx.beginPath()
    for (let i = 0; i < 6; i++) {
      const t = (age * 1.6 + rnd(b.seed, 60 + i)) % 1
      const bx = b.ex + (rnd(b.seed, 70 + i) - 0.5) * sz * 0.8
      const by = b.ey + (rnd(b.seed, 80 + i) - 0.5) * sz * 0.5 - t * sz * 0.4
      const r = sz * (0.04 + 0.05 * t)
      ctx.moveTo(bx + r, by)
      ctx.arc(bx, by, r, 0, Math.PI * 2)
    }
    ctx.fill()
    ctx.globalAlpha = 1
    return
  }
  if (p >= 1) return
  ctx.globalCompositeOperation = b.f === 'swarm' ? 'source-over' : 'lighter'
  const n = b.f === 'swarm' ? 10 : b.style === 'blast' ? 11 : 8
  const reach = sz * (b.style === 'blast' ? 1.5 : 0.9)
  // Streaks flying out, mostly along the throw.
  for (let pass = 0; pass < 2; pass++) {
    ctx.strokeStyle = b.f === 'swarm' ? (pass ? ICHOR : SHARD) : b.f === 'droid' ? ZAP[pass] : SPARK[pass]
    ctx.globalAlpha = 1 - p
    ctx.lineWidth = b.f === 'swarm' ? lw * 1.6 : lw
    ctx.beginPath()
    for (let i = pass; i < n; i += 2) {
      const a = base + (rnd(b.seed, 90 + i) - 0.5) * (b.f === 'swarm' ? 5 : 3.4)
      const d0 = reach * (0.15 + p * (0.6 + rnd(b.seed, 100 + i) * 0.6))
      const d1 = d0 + sz * (b.f === 'swarm' ? 0.08 : 0.22) * (1 - p)
      ctx.moveTo(b.x + Math.cos(a) * d0, b.y + Math.sin(a) * d0)
      ctx.lineTo(b.x + Math.cos(a) * d1, b.y + Math.sin(a) * d1)
    }
    ctx.stroke()
  }
  // A flash where it was hit: a blaster scorch, a droid's electrical pop (a ring and a jag), a blast.
  if (age < 0.25) {
    const q = age / 0.25
    ctx.globalAlpha = 0.8 * (1 - q)
    if (b.f === 'droid') {
      ctx.strokeStyle = ZAP[1]
      ctx.lineWidth = lw * 1.4
      ctx.beginPath()
      ctx.arc(b.x, b.y, sz * (0.2 + q * 0.6), 0, Math.PI * 2)
      const j = rnd(b.seed, 110) * Math.PI * 2
      ctx.moveTo(b.x, b.y)
      ctx.lineTo(b.x + Math.cos(j) * sz * 0.3, b.y + Math.sin(j) * sz * 0.3)
      ctx.lineTo(b.x + Math.cos(j + 0.7) * sz * 0.45, b.y + Math.sin(j + 0.7) * sz * 0.45)
      ctx.stroke()
    } else if (b.f !== 'swarm' || b.style === 'blast') {
      ctx.fillStyle = b.style === 'blast' ? SPARK[1] : '#bfefff'
      ctx.beginPath()
      ctx.arc(b.x, b.y, sz * (b.style === 'blast' ? 0.5 + q * 0.6 : 0.3 * (1 - q * 0.5)), 0, Math.PI * 2)
      ctx.fill()
    } else {
      // A bug's splat: drops of ichor.
      ctx.fillStyle = ICHOR
      ctx.beginPath()
      for (let i = 0; i < 5; i++) {
        const a = base + (rnd(b.seed, 120 + i) - 0.5) * 4
        const d = sz * (0.2 + q * 0.5 + rnd(b.seed, 125 + i) * 0.2)
        const r = sz * 0.06
        ctx.moveTo(b.x + Math.cos(a) * d + r, b.y + Math.sin(a) * d)
        ctx.arc(b.x + Math.cos(a) * d, b.y + Math.sin(a) * d, r, 0, Math.PI * 2)
      }
      ctx.fill()
    }
  }
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
}

/** The dead, under the units: stains, then bodies (and a droid's scattered parts), then the bursts
 * of the newest deaths. `zdpr` device pixels per world unit; `box` the view in world units. */
export function drawDeaths(ctx: CanvasRenderingContext2D, zdpr: number, clock: number, box: Box) {
  view.x0 = box.x0
  view.y0 = box.y0
  view.x1 = box.x1
  view.y1 = box.y1
  view.zoom = zdpr / (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1)
  // Stains: turned and faded, without a save and restore each.
  let keep = 0
  const sheet = stains.length ? stainAtlas() : null
  for (let i = 0; i < stains.length; i++) {
    const s = stains[i]
    const age = clock - s.at
    if (age > STAIN + STAIN_FADE || age < 0) continue
    stains[keep++] = s
    if (!inView(box, s.x, s.y, s.r)) continue
    // A splat spreads out as it lands.
    const r = s.r * Math.min(1, 0.4 + age * 4)
    ctx.globalAlpha = age < STAIN ? 1 : 1 - (age - STAIN) / STAIN_FADE
    ctx.translate(s.x, s.y)
    ctx.rotate(s.rot)
    ctx.drawImage(sheet!, s.v * 64, KINDS.indexOf(s.kind) * 64, 64, 64, -r, -r, r * 2, r * 2)
    ctx.rotate(-s.rot)
    ctx.translate(-s.x, -s.y)
  }
  stains.length = keep
  ctx.globalAlpha = 1
  keep = 0
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i]
    const age = clock - b.at
    const life = b.style === 'melt' ? Math.max(MELT, BURST) : LIE + FADE
    if (age > life || age < 0) continue
    bodies[keep++] = b
    if (!inView(box, b.ex, b.ey, b.size * 3)) continue
    const p = Math.min(1, age / b.dur)
    const e = 1 - (1 - p) * (1 - p)
    const x = b.x + (b.ex - b.x) * e
    const lift = b.hop * 4 * p * (1 - p)
    const y = b.y + (b.ey - b.y) * e - lift
    const rot = b.rot0 + (b.rot1 - b.rot0) * e
    let alpha = age < LIE ? 1 : 1 - (age - LIE) / FADE
    let size = b.size * (1 + lift / (b.size * 4))
    if (b.style === 'melt') {
      const q = Math.min(1, age / MELT)
      alpha = 1 - q
      size *= 1 - 0.45 * q
    } else if (b.f === 'swarm') size *= 1 - 0.15 * Math.min(1, age / 0.4)
    if (alpha > 0.01) {
      // Lit as if lying one way, whichever way it lies: every body of a look shares one bitmap
      // (nobody reads the light on a body on the ground).
      drawHull(ctx, b.m, x, y, rot, size, zdpr, b.state, alpha < 1 ? { alpha, lightRot: 0 } : LIT)
      if (b.f === 'swarm' && b.style !== 'melt') drawCurled(ctx, x, y, rot, size, alpha)
      if (b.fling)
        for (let j = 0; j < b.fling.length; j++) {
          const fl = b.fling[j]
          const lx = b.x + (b.ex + fl.ex - b.x) * e
          const ly = b.y + (b.ey + fl.ey - b.y) * e - (b.hop + b.size * 0.5) * 4 * p * (1 - p)
          drawPart(ctx, b.m, fl.part, lx, ly, b.rot0 + fl.spin * e, b.size, zdpr, alpha)
        }
    }
    if (age < (b.style === 'melt' ? MELT : BURST)) drawBurst(ctx, b, age)
  }
  bodies.length = keep
}

/** How many bodies and stains are kept now (for tests and the perf scene). */
export const deathCounts = () => ({ bodies: bodies.length, stains: stains.length })
