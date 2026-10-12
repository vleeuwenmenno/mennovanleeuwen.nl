import { breakOutcome, breakPieces, wreckState, type Piece } from './index.ts'
import { PALETTES, hash, rng } from './kit.ts'
import { drawHull, drawMount, drawPart, drawPiece } from './paint.ts'
import type { BreakKind, HullState, Model } from './types.ts'
import type { Tier } from '../data.ts'

// What happens to procedural models when they come apart, all of it on screen only (the battle
// never knows): parts shot off fly away tumbling and smoking, then fade; small craft burst into a
// few fragments; and a dead warship's hull lies where the battle left its wreck, in one scorched
// piece, broken in two or in several pieces drifting slowly apart, until the wreck is salvaged or
// drifts off. How it broke follows from the wreck's id and the world's seed, so every player in a
// multiplayer battle sees the same break; the drift itself runs on each screen's own clock.

const TAU = Math.PI * 2

/** Something flying free: a part, a turret or a fragment. */
type Flier = {
  draw: (ctx: CanvasRenderingContext2D, x: number, y: number, a: number, zdpr: number, alpha: number) => void
  x: number
  y: number
  a: number
  vx: number
  vy: number
  va: number
  life: number
  max: number
  /** World radius, for culling and smoke size. */
  r: number
  smokeT: number
  palette: Model['faction']
}
type Drift = { dx: number; dy: number; drift: number; slow: number; spin: number; spinSlow: number }
/** A broken hull anchored to a battle wreck. */
type Hulk = {
  id: number
  m: Model
  kind: BreakKind
  variant: number
  pieces: Piece[]
  drifts: Drift[]
  state: HullState
  x: number
  y: number
  rot: number
  size: number
  born: number
  /** When the battle's wreck went (salvaged or drifted off), 0 while it's there. */
  gone: number
  alpha: number
  emberT: number
}
/** Smoke, embers and flashes: drawn flat, cartoon style. */
type Puff = { kind: 'smoke' | 'ember' | 'flash' | 'fire'; x: number; y: number; vx: number; vy: number; life: number; max: number; size: number; grow: number; color: string }

/** Where a point of a hulk's piece is in the world, at `age` seconds. */
function pieceAt(h: Hulk, i: number, age: number) {
  const p = h.pieces[i]
  const d = h.drifts[i]
  const k = h.size / h.m.long
  const c = Math.cos(h.rot)
  const s = Math.sin(h.rot)
  const ox = (p.cx * c - p.cy * s) * k
  const oy = (p.cx * s + p.cy * c) * k
  const e = 1 - Math.exp(-age / 2.4)
  const sep = Math.min(h.size * 0.5, d.drift * e + d.slow * age)
  return { x: h.x + ox + d.dx * sep, y: h.y + oy + d.dy * sep, a: h.rot + d.spin * e + d.spinSlow * age }
}

export class ModelFx {
  clock = 0
  private fliers: Flier[] = []
  private hulks = new Map<number, Hulk>()
  private puffs: Puff[] = []
  /** Smoke and fire from the fx itself; the battle has its own explosions, the Codex uses these. */
  private puff(p: Omit<Puff, 'max'>) {
    if (this.puffs.length < 900) this.puffs.push({ ...p, max: p.life })
  }

  /** Throws a flier off with a random kick, spin and life. */
  private fling(f: Omit<Flier, 'vx' | 'vy' | 'va' | 'life' | 'max' | 'smokeT'>, vx: number, vy: number, speed: number, life: number, r: () => number, away?: number) {
    const a = away ?? r() * TAU
    const v = speed * (0.6 + r() * 0.7)
    const t = life * (0.75 + r() * 0.5)
    this.fliers.push({ ...f, vx: vx + Math.cos(a) * v, vy: vy + Math.sin(a) * v, va: (r() - 0.5) * 5, life: t, max: t, smokeT: 0 })
  }

  /**
   * A part of a unit blown off (index into model.parts): it flies away from the hull, tumbling and
   * trailing smoke, then fades. (x, y, rot): the unit; (vx, vy): its velocity.
   */
  flyPart(m: Model, index: number, x: number, y: number, rot: number, size: number, vx: number, vy: number, seed: number) {
    const p = m.parts[index]
    if (p.pts.length < 3) return
    let cx = 0
    let cy = 0
    for (const q of p.pts) {
      cx += q[0]
      cy += q[1]
    }
    cx /= p.pts.length
    cy /= p.pts.length
    const k = size / m.long
    const c = Math.cos(rot)
    const s = Math.sin(rot)
    const wx = x + (cx * c - cy * s) * k
    const wy = y + (cx * s + cy * c) * k
    const r = rng(seed)
    const away = Math.atan2(wy - y, wx - x) + (r() - 0.5) * 1.2
    this.fling({ draw: (ctx, fx, fy, a, zdpr, alpha) => drawPart(ctx, m, index, fx, fy, a, size, zdpr, alpha), x: wx, y: wy, a: rot, r: size * 0.12, palette: m.faction }, vx, vy, 30 + size * 0.5, 3.5, r, away)
    this.sparks(wx, wy, size * 0.08, r)
  }

  /** A turret or module blown off its socket: the wrecked mount flies away. */
  flyMount(m: Model, index: number, x: number, y: number, rot: number, aim: number, size: number, vx: number, vy: number, seed: number) {
    const mt = m.mounts[index]
    const k = size / m.long
    const c = Math.cos(rot)
    const s = Math.sin(rot)
    const wx = x + (mt.x * c - mt.y * s) * k
    const wy = y + (mt.x * s + mt.y * c) * k
    const r = rng(seed)
    const away = Math.atan2(wy - y, wx - x) + (r() - 0.5) * 1.6
    const rad = mt.r * k
    this.fling({ draw: (ctx, fx, fy, a, zdpr, alpha) => drawMount(ctx, m.faction, mt.design, true, fx, fy, a, rad, zdpr, alpha), x: wx, y: wy, a: aim, r: rad, palette: m.faction }, vx, vy, 40 + size * 0.4, 3.2, r, away)
    this.sparks(wx, wy, rad, r)
  }

  private sparks(x: number, y: number, size: number, r: () => number) {
    this.puff({ kind: 'flash', x, y, vx: 0, vy: 0, life: 0.18, size: size * 1.2, grow: size, color: '#fff2c8' })
    for (let i = 0; i < 4; i++) {
      const a = r() * TAU
      const v = 20 + r() * 50
      this.puff({ kind: 'fire', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.4 + r() * 0.4, size: size * 0.4, grow: size * 0.5, color: r() < 0.5 ? '#ffb347' : '#ff6a2a' })
    }
  }

  /**
   * A unit gone without leaving a wreck (strike craft, gunships, structures): its hull bursts into
   * fragments that fly apart and fade. Small craft come apart fast; a station's slabs tumble slowly
   * and linger. `key` picks how it breaks (the same unit always breaks the same way).
   */
  shatter(m: Model, tier: Tier, x: number, y: number, rot: number, size: number, vx: number, vy: number, key: number, state: HullState) {
    const r = rng(hash(key, 0x5a7))
    const variant = key % 8
    const pieces = breakPieces(m, 'pieces', variant)
    const big = tier === 'station' || tier === 'mine' || tier === 'defense'
    const k = size / m.long
    const st: HullState = { ...state, scorch: 3 }
    pieces.forEach((p, i) => {
      const c = Math.cos(rot)
      const s = Math.sin(rot)
      const px = x + (p.cx * c - p.cy * s) * k
      const py = y + (p.cx * s + p.cy * c) * k
      const away = Math.atan2(py - y, px - x) + (r() - 0.5) * 0.8
      this.fling(
        { draw: (ctx, fx, fy, a, zdpr, alpha) => drawPiece(ctx, m, p, `f${variant}.${i}`, st, fx, fy, a, size, zdpr, alpha, !big), x: px, y: py, a: rot, r: size * Math.sqrt(p.share) * 0.5, palette: m.faction },
        vx * 0.5,
        vy * 0.5,
        big ? 14 : 45 + size,
        big ? 9 : 1.6,
        r,
        away,
      )
      if (big) this.fliers[this.fliers.length - 1].va *= 0.05
    })
    // Whatever was still attached and could come off goes too.
    for (const i of m.detachable) if (r() < 0.5) this.flyPart(m, i, x, y, rot, size, vx * 0.5, vy * 0.5, hash(key, i))
  }

  /**
   * A battle wreck appeared where a modelled warship died: its hull, anchored to the wreck. `seed`
   * is the world's (the map's) seed; `detached` what had already come off when it died, if known.
   */
  anchor(id: number, m: Model, tier: Tier, x: number, y: number, rot: number, size: number, seed: number, detached?: number, force?: BreakKind) {
    if (this.hulks.has(id)) return
    const out = breakOutcome(id, seed, tier)
    const kind = force ?? out.kind
    const pieces = breakPieces(m, kind, out.variant)
    const r = rng(hash(id, seed, 0xd71f))
    const k = size / m.long
    const drifts = pieces.map((p) => {
      const c = Math.cos(rot)
      const s = Math.sin(rot)
      let dx = (p.cx * c - p.cy * s) * k
      let dy = (p.cx * s + p.cy * c) * k
      const l = Math.hypot(dx, dy)
      if (l < size * 0.05) {
        const a = r() * TAU
        dx = Math.cos(a)
        dy = Math.sin(a)
      } else {
        dx /= l
        dy /= l
      }
      const j = (r() - 0.5) * 0.5
      const ndx = dx * Math.cos(j) - dy * Math.sin(j)
      const ndy = dx * Math.sin(j) + dy * Math.cos(j)
      return kind === 'intact'
        ? { dx: ndx, dy: ndy, drift: 0, slow: 0, spin: 0, spinSlow: (id % 2 ? 1 : -1) * 0.012 }
        : { dx: ndx, dy: ndy, drift: size * (0.08 + r() * 0.08), slow: 0.4 + r() * 0.8, spin: (r() - 0.5) * 0.7, spinSlow: (r() - 0.5) * 0.024 }
    })
    this.hulks.set(id, { id, m, kind, variant: out.variant, pieces, drifts, state: wreckState(m, id, detached), x, y, rot, size, born: this.clock, gone: 0, alpha: 1, emberT: 0 })
  }
  /** How a wreck broke, for the Codex. */
  hulkKind = (id: number) => this.hulks.get(id)?.kind
  /** Whether a battle wreck has its hull here. */
  has = (id: number) => this.hulks.has(id)
  /** The battle's wreck is gone: its pieces fade out. */
  release(id: number) {
    const h = this.hulks.get(id)
    if (h && !h.gone) h.gone = this.clock
  }
  /** The battle wreck's own fade (it drifts off as its decay runs out). */
  setAlpha(id: number, a: number) {
    const h = this.hulks.get(id)
    if (h) h.alpha = a
  }
  /** Ids of every hulk still tied to a battle wreck. */
  anchored() {
    return [...this.hulks.values()].filter((h) => !h.gone).map((h) => h.id)
  }
  clear() {
    this.fliers = []
    this.hulks.clear()
    this.puffs = []
  }

  /** A blast with smoke, for the Codex (the battle draws its own explosions). */
  boom(x: number, y: number, size: number, seed: number) {
    const r = rng(seed)
    this.puff({ kind: 'flash', x, y, vx: 0, vy: 0, life: 0.22, size: size * 0.45, grow: size * 0.3, color: '#fff3d0' })
    for (let i = 0; i < 16; i++) {
      const a = r() * TAU
      const v = (0.3 + r()) * (30 + size * 0.9)
      const d = r() * size * 0.35
      this.puff({ kind: 'fire', x: x + Math.cos(a) * d, y: y + Math.sin(a) * d, vx: Math.cos(a) * v * 0.4, vy: Math.sin(a) * v * 0.4, life: 0.4 + r() * 0.5, size: size * (0.05 + r() * 0.07), grow: size * 0.16, color: r() < 0.5 ? '#ffb347' : '#ff6a2a' })
      if (i % 2) this.puff({ kind: 'smoke', x, y, vx: Math.cos(a) * v * 0.25, vy: Math.sin(a) * v * 0.25, life: 1.4 + r() * 1.2, size: size * 0.14, grow: size * 0.4, color: PALETTES.republic.smoke })
    }
  }

  step(dt: number) {
    this.clock += dt
    for (const f of this.fliers) {
      f.life -= dt
      f.x += f.vx * dt
      f.y += f.vy * dt
      f.vx *= 0.985
      f.vy *= 0.985
      f.a += f.va * dt
      // Burning as it goes: smoke puffs while it's fresh.
      f.smokeT -= dt
      if (f.smokeT <= 0 && f.life > f.max * 0.3) {
        f.smokeT = 0.09
        this.puff({ kind: 'smoke', x: f.x, y: f.y, vx: 0, vy: 0, life: 0.9, size: f.r * 0.5, grow: f.r * 1.3, color: PALETTES[f.palette].smoke })
        if (Math.random() < 0.35) this.puff({ kind: 'fire', x: f.x, y: f.y, vx: 0, vy: 0, life: 0.25, size: f.r * 0.4, grow: f.r * 0.3, color: '#ff8a3a' })
      }
    }
    this.fliers = this.fliers.filter((f) => f.life > 0)
    // Fresh breaks smoulder: embers off the torn edges for the first half minute.
    for (const h of this.hulks.values()) {
      const age = this.clock - h.born
      if (h.gone || h.kind === 'intact' || age > 30) continue
      h.emberT -= dt
      if (h.emberT > 0) continue
      h.emberT = 0.12 + age * 0.02
      const i = Math.floor(Math.random() * h.pieces.length)
      const p = h.pieces[i]
      const cut = p.cuts[Math.floor(Math.random() * p.cuts.length)]
      if (!cut) continue
      const q = cut[Math.floor(Math.random() * cut.length)]
      const at = pieceAt(h, i, age)
      const k = h.size / h.m.long
      const lx = (q[0] - p.cx) * k
      const ly = (q[1] - p.cy) * k
      const c = Math.cos(at.a)
      const s = Math.sin(at.a)
      const x = at.x + lx * c - ly * s
      const y = at.y + lx * s + ly * c
      this.puff({ kind: 'ember', x, y, vx: (Math.random() - 0.5) * 30, vy: (Math.random() - 0.5) * 30, life: 0.5 + Math.random() * 0.5, size: 1.4, grow: 0, color: '#ffb35a' })
      if (Math.random() < 0.4) this.puff({ kind: 'smoke', x, y, vx: 0, vy: 0, life: 1.6, size: h.size * 0.03, grow: h.size * 0.12, color: PALETTES[h.m.faction].smoke })
    }
    for (const [id, h] of this.hulks) if (h.gone && this.clock - h.gone > 1.6) this.hulks.delete(id)
    for (const p of this.puffs) {
      p.life -= dt
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.vx *= 0.95
      p.vy *= 0.95
    }
    this.puffs = this.puffs.filter((p) => p.life > 0)
  }

  /** Draws one wreck's hull pieces (call it where the wreck would be drawn, under the ships). */
  drawHulk(ctx: CanvasRenderingContext2D, id: number, zdpr: number) {
    const h = this.hulks.get(id)
    if (!h) return false
    const age = this.clock - h.born
    const alpha = h.alpha * (h.gone ? Math.max(0, 1 - (this.clock - h.gone) / 1.5) : 1)
    if (alpha <= 0) return true
    if (h.kind === 'intact') {
      const d = h.drifts[0]
      drawHull(ctx, h.m, h.x, h.y, h.rot + d.spinSlow * age, h.size, zdpr, h.state, { alpha, wreck: true })
      return true
    }
    h.pieces.forEach((p, i) => {
      const at = pieceAt(h, i, age)
      drawPiece(ctx, h.m, p, `${h.id}.${h.kind}.${h.variant}.${i}`, h.state, at.x, at.y, at.a, h.size, zdpr, alpha)
    })
    return true
  }
  /** Hulks whose battle wreck is gone, fading out (the battle no longer lists them). */
  drawFading(ctx: CanvasRenderingContext2D, zdpr: number) {
    for (const h of this.hulks.values()) if (h.gone) this.drawHulk(ctx, h.id, zdpr)
  }

  /** Fliers and smoke, over the ships. `onScreen` culls in world units. */
  draw(ctx: CanvasRenderingContext2D, zdpr: number, onScreen: (x: number, y: number, r: number) => boolean = () => true) {
    for (const p of this.puffs) {
      if (p.kind !== 'smoke' || !onScreen(p.x, p.y, p.size + p.grow)) continue
      const t = 1 - p.life / p.max
      ctx.globalAlpha = 0.3 * (p.life / p.max)
      ctx.fillStyle = p.color
      ctx.beginPath()
      ctx.arc(p.x, p.y, p.size + p.grow * t, 0, TAU)
      ctx.fill()
    }
    ctx.globalAlpha = 1
    for (const f of this.fliers) {
      if (!onScreen(f.x, f.y, f.r * 2)) continue
      f.draw(ctx, f.x, f.y, f.a, zdpr, Math.min(1, (f.life / f.max) * 2.5))
    }
    ctx.globalCompositeOperation = 'lighter'
    for (const p of this.puffs) {
      if (p.kind === 'smoke' || !onScreen(p.x, p.y, p.size + p.grow)) continue
      const t = 1 - p.life / p.max
      ctx.globalAlpha = Math.max(0, p.life / p.max) * (p.kind === 'fire' ? 0.75 : 1)
      ctx.fillStyle = p.color
      ctx.beginPath()
      ctx.arc(p.x, p.y, Math.max(p.size + p.grow * t, p.kind === 'ember' ? 1 / zdpr : 0), 0, TAU)
      ctx.fill()
    }
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1
  }
}
