import { STATIONS, UNITS, dims, stationType, type FactionId, type Tier, type UnitType } from '../data.ts'
import { circle, hash, inPart, inPoly, jagged, rng, seedOf } from './kit.ts'
import * as droid from './droid.ts'
import * as proto from './proto.ts'
import * as republic from './republic.ts'
import * as swarm from './swarm.ts'
import type { ModelDef } from './spec.ts'
import type { BreakKind, HullState, Model, Mount, MountDesign, Part, Pt, Scorch } from './types.ts'

// Procedural models: which units have one, building a model for a unit type, its damage state, and
// how it breaks apart when destroyed. No DOM here (see models/paint.ts for the drawing), so the
// headless check builds every model in Node.
//
// Adding a unit's model: write a ModelDef in the faction's file (republic.ts, droid.ts) that returns
// its parts on the unit's box (100 units on the long side, nose up), then list it in DEFS below.
// Its turrets, shield generators and hangars are placed for it on the unit's hardpoints from
// data.ts, so they always sit where the battle aims at them. Run `pnpm check:empires-models`, then
// look at it in the main menu's Codex (Workshop mode shows the parts, hardpoints and break-up).

export type { HullState, Model } from './types.ts'

/** The designs, by unit id. A station's id covers all its levels: the design grows with the level. */
const DEFS: Record<string, ModelDef> = {
  'r-fighter': republic.fighter,
  'r-bomber': republic.bomber,
  'r-repair': republic.repair,
  'r-picket': republic.picket,
  'r-gunship': republic.gunship,
  'r-corvette': republic.corvette,
  'r-frigate': republic.frigate,
  'r-cruiser': republic.cruiser,
  'r-capital': republic.capital,
  'r-station': republic.station,
  'r-mine': republic.mine,
  'r-defense': republic.defense,
  'r-defense-flak': republic.defense,
  'r-defense-gun': republic.defense,
  'd-fighter': droid.fighter,
  'd-station': droid.station,
  'd-bomber': droid.bomber,
  'd-repair': droid.repair,
  'd-picket': droid.picket,
  'd-gunship': droid.gunship,
  'd-ion': droid.ion,
  'd-frigate': droid.frigate,
  'd-cruiser': droid.cruiser,
  'd-capital': droid.capital,
  'd-mine': droid.mine,
  'd-defense': droid.defense,
  'd-defense-flak': droid.defense,
  'd-defense-gun': droid.defense,
}

/**
 * The Swarm: a concept kit for a future third faction (swarm.ts), one design for each droid unit,
 * on the same box and hardpoints. Never used in battle: the Codex shows them under "Swarm
 * (concept)", built with the style SWARM.
 */
const SWARM_DEFS: Record<string, ModelDef> = Object.fromEntries(
  (['fighter', 'station', 'bomber', 'repair', 'picket', 'gunship', 'ion', 'frigate', 'cruiser', 'capital', 'mine', 'defense', 'defense-flak', 'defense-gun'] as const).map((k) => [
    `d-${k}`,
    k.startsWith('defense') ? swarm.defense : swarm[k as Exclude<typeof k, 'defense-flak' | 'defense-gun'>],
  ]),
)
/** The style that builds a droid unit as its Swarm concept design. */
export const SWARM = 'swarm'
export const hasSwarm = (t: UnitType) => t.id in SWARM_DEFS
/** A Swarm design's own name (the droid unit it mirrors has a droid-navy name). */
export const swarmName = (t: UnitType) => swarm.SWARM_NAMES[t.id] ?? t.name

/**
 * The bigger redesigns (proto.ts) that ships have under Big ship sizes (sizes.ts): a Big unit type
 * of one of these is built with them, as is any type asked for in the style PROTO (the Codex).
 */
const PROTO_DEFS: Record<string, ModelDef> = { 'r-frigate': proto.frigate, 'r-capital': proto.capital }
export const PROTO = 'proto'
export const hasProto = (t: UnitType) => t.id in PROTO_DEFS

export const hasModel = (t: UnitType) => t.id in DEFS

const built = new WeakMap<UnitType, Map<string, Model | null>>()
/** The model for a unit type, built on first use (null if it has none). Every grown station is a
 * type of its own (see stationType), so each level and set of modules gets its own model. `style`
 * picks a design variant (the station's level-4 frame); left out, the design's default. */
export function modelFor(t: UnitType, style = ''): Model | null {
  let byStyle = built.get(t)
  if (!byStyle) built.set(t, (byStyle = new Map()))
  let m = byStyle.get(style)
  if (m === undefined) byStyle.set(style, (m = (style === SWARM ? hasSwarm(t) : style === PROTO ? hasProto(t) : hasModel(t)) ? buildModel(t, style || undefined) : null))
  return m
}

/** The design variants a unit's model can be shown in (the Codex offers them): the Republic
 * station's level-4 frame, the droid flagship's ring or carrier hull. */
export const modelStyles = (t: UnitType): string[] =>
  t.id === 'r-station' && /-4$/.test(t.sprite) ? [...republic.STATION_FRAMES] : t.id === 'd-capital' ? [...droid.CAPITAL_DESIGNS] : []

const bySprite = new Map<string, UnitType | null>()
/** The model behind a wreck, which only knows the sprite of the ship it was. */
export function modelForSprite(sprite: string): Model | null {
  let t = bySprite.get(sprite)
  if (t === undefined) bySprite.set(sprite, (t = UNITS.find((u) => u.sprite === sprite && u.tier !== 'station') ?? null))
  return t ? modelFor(t) : null
}

/** The ship type behind a wreck's sprite (wrecks only keep the sprite), if it has a model. */
export function unitForSprite(sprite: string): UnitType | null {
  return modelForSprite(sprite) ? (bySprite.get(sprite) ?? null) : null
}

/** The unit type a sprite name stands for, a station by its stage (with only that level's own
 * modules): for the menus and tiles that only know a sprite. */
export function typeOfSprite(sprite: string): UnitType | null {
  const st = /^(republic|droid)-station-(\d)$/.exec(sprite)
  if (st) return stationType(st[1] as FactionId, Number(st[2]), [])
  return UNITS.find((u) => u.sprite === sprite && u.tier !== 'station') ?? null
}

/** Which mounts blow off by default: small flak turrets. Heavy guns, shield generators, hangars and
 * station modules stay on the hull, wrecked. */
const DETACH_BY_DEFAULT: MountDesign[] = ['flak']

export function buildModel(t: UnitType, style?: string): Model {
  const concept = style === SWARM
  // A Big battle's redesigned ship (sizes.ts) is its prototype design, the same as the Codex shows.
  if (!concept && t.big && t.id in PROTO_DEFS) style = PROTO
  const def = concept ? SWARM_DEFS[t.id] : style === PROTO ? PROTO_DEFS[t.id] : DEFS[t.id]
  if (!def) throw new Error(`No ${concept ? 'Swarm ' : style === PROTO ? 'prototype ' : ''}model for ${t.id}`)
  let w: number
  let h: number
  let level = 1
  if (t.tier === 'station') {
    // A station is drawn in its frame's pixels, on the box of the stage it has grown to.
    level = Number(/-(\d+)$/.exec(t.sprite)?.[1] ?? 1)
    const [x0, y0, x1, y1] = STATIONS[t.faction].stages[level - 1].box
    w = x1 - x0
    h = y1 - y0
  } else {
    const [dw, dh] = dims(t)
    const k = 100 / Math.max(dw, dh)
    w = dw * k
    h = dh * k
  }
  const long = Math.max(w, h)
  const spec = def({ t, w, h, level, style: concept || style === PROTO ? undefined : style })
  const grid = (gx: number, gy: number): Pt => [(gx / 10 - 0.5) * w, (gy / 10 - 0.5) * h]
  const mounts: Mount[] = t.hardpoints.map((hp, i) => {
    const [x, y] = grid(hp.x, hp.y)
    const design: MountDesign = hp.art ?? (hp.kind === 'engine' ? 'engine' : hp.kind === 'turret' ? 'turbo' : (hp.kind as MountDesign))
    const { scale = 1, ...over } = spec.mount?.(i) ?? {}
    return { hp: i, x, y, r: (((hp.s ?? 0.05) * long) / 2) * scale, design, turns: !!hp.weapon, detach: DETACH_BY_DEFAULT.includes(design), ...over }
  })
  // Every mount sits in a socket: a dark recess in the plating, under the superstructure.
  const sockets: Part[] = mounts
    .filter((m) => m.design !== 'engine')
    .map((m) => ({ id: `socket${m.hp}`, pts: circle(m.x, m.y, m.r * 1.1, 18), tone: 'dark' as const, z: 0.5, details: [{ k: 'line' as const, pts: circle(m.x, m.y, m.r * 0.92, 16) }] }))
  const parts = [...spec.parts.filter((p) => (p.level ?? 1) <= level), ...sockets].sort((a, b) => a.z - b.z)
  // A mining platform with its Shield generator fitted is a type of its own with one more socket,
  // so its key names its modules too, as a station's does.
  const key = `${t.tier === 'station' ? `${t.id}:${level}:${t.hardpoints.map((p) => p.key).join(',')}` : t.tier === 'mine' ? `${t.id}:${t.hardpoints.map((p) => p.key).join(',')}` : t.id}${style ? `:${style}` : ''}`
  const seed = seedOf(t.tier === 'station' ? `${t.id}:${level}` : t.id)
  return {
    key,
    faction: concept ? 'swarm' : t.faction,
    w,
    h,
    long,
    parts,
    mounts,
    engines: spec.engines ?? t.engines.map(([gx, gy]) => grid(gx, gy)),
    detachable: parts.flatMap((p, i) => (p.detach ? [i] : [])),
    breakStyle: spec.breakStyle ?? 'bands',
    cuts: spec.cuts,
    core: spec.core,
    scorch: scorchSpots(parts, w, h, seed),
    seed,
  }
}

/** The parts that make up the hull's outline: everything solid that doesn't come off. */
export const hullParts = (m: Model) => m.parts.filter((p) => p.pts.length >= 3 && !p.glow && !p.detach)
/** Whether a point (model units) is on the hull. */
export const onHull = (m: Model, x: number, y: number) => m.parts.some((p) => p.pts.length >= 3 && !p.glow && !p.id.startsWith('socket') && inPart(p, x, y))

/** Where scorch marks can go: spots on the hull, the first few showing from light damage, more as
 * it gets worse. */
function scorchSpots(parts: Part[], w: number, h: number, seed: number): Scorch[] {
  const solid = parts.filter((p) => p.pts.length >= 3 && !p.glow && !p.detach)
  const r = rng(seed ^ 0x5c0)
  const out: Scorch[] = []
  const long = Math.max(w, h)
  for (let tries = 0; out.length < 30 && tries < 600; tries++) {
    const x = (r() - 0.5) * w * 0.94
    const y = (r() - 0.5) * h * 0.94
    if (!solid.some((p) => inPart(p, x, y))) continue
    const n = out.length
    out.push({ x, y, r: long * (0.035 + r() * 0.05) * (n >= 22 ? 1.2 : 1), level: n < 7 ? 1 : n < 17 ? 2 : 3, seed: Math.floor(r() * 1e9) })
  }
  return out
}

// --- Damage state ------------------------------------------------------------------------------------

/** What the battle knows about a unit that its looks depend on. */
export type Damage = { id: number; hull: number; hullMax: number; hps: readonly { hp: number }[] }

/** Whether detachable part `i` (an index into model.detachable) is gone. */
export function partGone(m: Model, i: number, d: Damage) {
  const det = m.parts[m.detachable[i]].detach!
  if (det.hp !== undefined && (d.hps[det.hp]?.hp ?? 1) <= 0) return true
  return det.hull !== undefined && d.hull / Math.max(1, d.hullMax) < det.hull
}

/** A unit's hull state now: what has come off, how burnt it is, and which burn layout it has.
 * All of it follows from the battle's own state, so every player's screen agrees. */
export function hullState(m: Model, d: Damage, tier: Tier): HullState {
  let detached = 0
  for (let i = 0; i < m.detachable.length; i++) if (partGone(m, i, d)) detached |= 1 << i
  const f = d.hull / Math.max(1, d.hullMax)
  // Strike craft and gunships share one burn layout: there are many of them and they're small, and
  // four layouts each would mean four times the bitmaps for every heading they turn through.
  return { detached, scorch: f > 0.75 ? 0 : f > 0.5 ? 1 : f > 0.25 ? 2 : 3, variant: tier === 'fighter' || tier === 'gunship' ? 0 : d.id & 3 }
}
export const stateKey = (s: HullState) => `${s.detached}.${s.scorch}.${s.variant}`

// --- Breaking up -------------------------------------------------------------------------------------

/** How likely each outcome is when a ship of this class dies: stays in one scorched piece, breaks
 * in half, or into several pieces. Bigger ships break apart more often. */
export const BREAK_WEIGHTS: Partial<Record<Tier, Record<BreakKind, number>>> = {
  frigate: { intact: 0.35, half: 0.45, pieces: 0.2 },
  cruiser: { intact: 0.3, half: 0.4, pieces: 0.3 },
  capital: { intact: 0.25, half: 0.35, pieces: 0.4 },
}

/**
 * How a destroyed ship breaks, picked from `key` (the battle wreck's id, which every multiplayer
 * client numbers the same) and the world's seed, with integer maths only so every engine agrees.
 * Strike craft, gunships and structures always come apart in pieces (fragments that soon fade).
 */
export function breakOutcome(key: number, seed: number, tier: Tier): { kind: BreakKind; variant: number } {
  const h = hash(key, seed, 0x0b7ea4)
  const variant = hash(h, 7) % 1000
  const w = BREAK_WEIGHTS[tier]
  if (!w) return { kind: 'pieces', variant }
  const u = h / 4294967296
  const kind: BreakKind = u < w.intact ? 'intact' : u < w.intact + w.half ? 'half' : 'pieces'
  return { kind, variant }
}

/** One piece of a broken hull: the region of the model it covers, its centre of mass and extent
 * (model units), the break lines along its edges, and its share of the hull. */
export type Piece = { region: Pt[]; cx: number; cy: number; x0: number; y0: number; x1: number; y1: number; cuts: Pt[][]; share: number }

const pieceCache = new WeakMap<Model, Map<string, Piece[]>>()
/**
 * The pieces a model breaks into: one for an intact wreck, two for a break in half, three or more
 * for pieces. Long hulls are cut across with jagged lines; round stations are cut into wedges round
 * the middle. The same model, kind and variant always give the same pieces.
 */
export function breakPieces(m: Model, kind: BreakKind, variant: number): Piece[] {
  // Worked out once per model and break: a squadron dying together would otherwise sample its
  // hull dozens of times in one frame.
  let byKey = pieceCache.get(m)
  if (!byKey) pieceCache.set(m, (byKey = new Map()))
  const key = `${kind}:${variant}`
  let hit = byKey.get(key)
  if (!hit) byKey.set(key, (hit = cutPieces(m, kind, variant)))
  return hit
}

function cutPieces(m: Model, kind: BreakKind, variant: number): Piece[] {
  const r = rng(hash(m.seed, variant, kind === 'half' ? 2 : kind === 'pieces' ? 3 : 1))
  const X = m.w * 0.9
  const Y = m.h * 0.9
  const amp = m.long * 0.028
  let regions: { region: Pt[]; cuts: Pt[][] }[]
  if (kind === 'intact') regions = [{ region: [[-X, -Y], [X, -Y], [X, Y], [-X, Y]], cuts: [] }]
  else if (m.breakStyle === 'ring' && m.core) {
    // The core sphere comes away whole, its spokes torn round its edge; in half, the whole ring
    // drifts off it, in pieces the ring breaks into three or four segments too.
    const { x: cx, y: cy, r: rc } = m.core
    const R = Math.hypot(X, Y) * 1.4
    const disc: Pt[] = []
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2
      const k = 1 + (r() - 0.5) * 0.08
      disc.push([cx + Math.cos(a) * rc * k, cy + Math.sin(a) * rc * k])
    }
    const rim = [...disc, disc[0]]
    if (kind === 'half') {
      // Everything outside the disc, as one polygon: the box, a slit in to the disc, round the disc
      // the other way, and back out (the slit has no width, so it covers nothing).
      const outer: Pt[] = [[cx, cy - R], [cx + R, cy - R], [cx + R, cy + R], [cx - R, cy + R], [cx - R, cy - R]]
      const around: Pt[] = [disc[18], ...disc.slice(0, 19).reverse(), ...disc.slice(19).reverse(), disc[18]]
      regions = [
        { region: disc, cuts: [rim] },
        { region: [...outer, [cx, cy - R], ...around, [cx, cy - R]], cuts: [rim] },
      ]
    } else {
      const n = 3 + Math.floor(r() * 2)
      const a0 = r() * Math.PI * 2
      const angles = Array.from({ length: n }, (_, i) => a0 + ((i + 0.4 * (r() - 0.5)) / n) * Math.PI * 2)
      const rays = angles.map((a) => jagged([cx + Math.cos(a) * rc, cy + Math.sin(a) * rc], [cx + Math.cos(a) * R, cy + Math.sin(a) * R], 7, amp * 1.4, r))
      regions = [{ region: disc, cuts: [rim] }]
      angles.forEach((a, i) => {
        const b = i + 1 < n ? angles[i + 1] : angles[0] + Math.PI * 2
        const outerArc: Pt[] = []
        const innerArc: Pt[] = []
        for (let k = 1; k < 10; k++) {
          const t = a + ((b - a) * k) / 10
          outerArc.push([cx + Math.cos(t) * R, cy + Math.sin(t) * R])
          innerArc.push([cx + Math.cos(t) * rc, cy + Math.sin(t) * rc])
        }
        const next = rays[(i + 1) % n]
        regions.push({ region: [...rays[i], ...outerArc, ...next.slice().reverse(), ...innerArc.reverse()], cuts: [rays[i], next, [rays[i][0], ...innerArc.slice().reverse(), next[0]]] })
      })
    }
  } else if (m.breakStyle === 'pie') {
    const n = kind === 'half' ? 2 : 4 + Math.floor(r() * 2)
    const a0 = r() * Math.PI * 2
    const angles = Array.from({ length: n }, (_, i) => a0 + ((i + 0.5 * (r() - 0.5)) / n) * Math.PI * 2)
    const R = Math.hypot(X, Y)
    const rays = angles.map((a) => jagged([0, 0], [Math.cos(a) * R, Math.sin(a) * R], 7, amp * 1.4, r))
    regions = angles.map((a, i) => {
      const b = i + 1 < n ? angles[i + 1] : angles[0] + Math.PI * 2
      const arc: Pt[] = []
      for (let k = 1; k < 8; k++) {
        const t = a + ((b - a) * k) / 8
        arc.push([Math.cos(t) * R * 1.3, Math.sin(t) * R * 1.3])
      }
      const next = rays[(i + 1) % n]
      return { region: [...rays[i], ...arc, ...next.slice().reverse()], cuts: [rays[i], next] }
    })
  } else {
    // Cut across the hull: one line for a half, two (three on the biggest ships) for pieces, kept
    // far enough apart that the jagged lines never cross.
    const count = kind === 'half' ? 1 : (m.cuts ?? (m.long >= 300 ? 3 : 2))
    const ys: number[] = []
    for (let i = 0; i < count; i++) {
      const lo = -0.32 + (0.64 * i) / count
      const hi = -0.32 + (0.64 * (i + 1)) / count
      ys.push((lo + (hi - lo) * (0.25 + r() * 0.5)) * m.h)
    }
    const gap = count === 1 ? m.h : (0.64 * m.h) / count
    const cuts = ys.map((y) => {
      const tilt = (r() - 0.5) * Math.min(0.6, (gap * 0.5) / X)
      return jagged([-X, y - tilt * X], [X, y + tilt * X], 9, Math.min(amp, gap * 0.12), r)
    })
    regions = []
    for (let i = 0; i <= count; i++) {
      const top = i === 0 ? ([[-X, -Y], [X, -Y]] as Pt[]) : cuts[i - 1]
      const bottom = i === count ? ([[-X, Y], [X, Y]] as Pt[]) : cuts[i]
      regions.push({ region: [...top, ...bottom.slice().reverse()], cuts: [...(i ? [cuts[i - 1]] : []), ...(i < count ? [cuts[i]] : [])] })
    }
  }
  // Each piece's share of the hull and its middle, by sampling the hull on a grid.
  const solid = m.parts.filter((p) => p.pts.length >= 3 && !p.glow)
  const N = 40
  const out: Piece[] = regions.map((g) => ({ region: g.region, cuts: g.cuts, cx: 0, cy: 0, x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, share: 0 }))
  let total = 0
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const x = ((i + 0.5) / N - 0.5) * m.w
      const y = ((j + 0.5) / N - 0.5) * m.h
      if (!solid.some((p) => inPart(p, x, y))) continue
      total++
      const k = regions.findIndex((g) => inPoly(g.region, x, y))
      if (k < 0) continue
      const p = out[k]
      p.share++
      p.cx += x
      p.cy += y
      p.x0 = Math.min(p.x0, x)
      p.y0 = Math.min(p.y0, y)
      p.x1 = Math.max(p.x1, x)
      p.y1 = Math.max(p.y1, y)
    }
  const cell = Math.max(m.w, m.h) / N
  return out
    .filter((p) => p.share > 0)
    .map((p) => ({ ...p, cx: p.cx / p.share, cy: p.cy / p.share, x0: p.x0 - cell * 2, y0: p.y0 - cell * 2, x1: p.x1 + cell * 2, y1: p.y1 + cell * 2, share: p.share / Math.max(1, total) }))
}

/** What a wreck still carries: most of what could come off is gone, a few pieces hang on, picked
 * from the wreck's key so each one looks its own. */
export function wreckState(m: Model, key: number, detached?: number): HullState {
  let mask = detached ?? 0
  const r = rng(hash(key, m.seed, 0x3ec))
  for (let i = 0; i < m.detachable.length; i++) if (r() < 0.7) mask |= 1 << i
  return { detached: mask, scorch: 3, variant: key & 3 }
}

/** What is under a point (model units): a mount first (they sit on top; within `minR` of its middle
 * however small it is drawn, so a finger can hit it), else the topmost part still on the hull. For
 * the Codex. */
export function pickAt(m: Model, x: number, y: number, detached: number, minR = 0): { mount: number } | { part: number } | null {
  let best = -1
  let bestD = Infinity
  for (let i = m.mounts.length - 1; i >= 0; i--) {
    const mt = m.mounts[i]
    const d = Math.hypot(x - mt.x, y - mt.y)
    if (mt.design !== 'engine' && d < Math.max(mt.r * 1.15, minR) && d < bestD) (best = i), (bestD = d)
  }
  if (best >= 0) return { mount: best }
  for (let i = m.parts.length - 1; i >= 0; i--) {
    const p = m.parts[i]
    const d = m.detachable.indexOf(i)
    if (d >= 0 && detached & (1 << d)) continue
    if (p.pts.length >= 3 && !p.id.startsWith('socket') && inPart(p, x, y)) return { part: i }
  }
  return null
}
