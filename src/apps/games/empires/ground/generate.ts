import { rng, type Symmetry } from '../maps.ts'
import { blockedTiles, buildGroundMap, spawnArea } from './terrain.ts'
import { TF, TILE, canStep, type GroundFeatures, type GroundMap, type GroundMapDef, type TilePt } from './types.ts'

// Random ground maps from a recipe, a player count, a size and a seed: the same inputs build the
// same map on every machine (sim data: exactly rounded maths and the seeded stream only), so a
// generated map travels as its id, `gen:<recipe>:<players>:<size>:<seed>` (GROUND_MAP in maps.ts
// builds it on demand).
//
// Every recipe draws one player's sector and copies it to the others by the map's symmetry: two
// players are mirrored across the diagonal (rivers) or turned half way round (the rest), three are
// turned a third of the way, four mirrored both ways. A sector is laid out in its own frame: `a`
// runs from the map's middle out to the player's spawn, `b` across. Its two edges are the lines it
// shares with its neighbours, so anything drawn on an edge (a river, its bridge and ford, a crystal
// field, a pass) is shared, and fair. The tile copying in terrain.ts then makes every side exactly
// alike. A finished map is checked (every spawn reaches every other and every crystal field, build
// areas open, fair distances) and laid out again from a varied stream if it fails.
//
// The recipes, all in the approved style (big calm areas, features in clumps, chokepoints at
// bridges, fords, ramps and passes, a crystal field by each base and contested ones between):
// - Rivers: rivers along the sector edges, each with a bridge and a ford (a lake where they meet);
//   a mesa a side with a ramp and crystals on top; woods round the edges.
// - Highlands: each base on a plateau with a ramp; bare rocky ridges along the sector edges with
//   passes through them; a central mesa with crystals, ramps from every side.
// - Forest: big solid woods with lanes and clearings between them; crystals in the clearings.
// - Open plains: wide open grass and dirt, a few small woods, a pond, low ridges, ruins and roads.

export const RECIPES = ['rivers', 'highlands', 'forest', 'plains'] as const
export type Recipe = (typeof RECIPES)[number]
export const RECIPE_NAMES: Record<Recipe, string> = { rivers: 'Rivers', highlands: 'Highlands', forest: 'Forest', plains: 'Open plains' }
export const RECIPE_BLURBS: Record<Recipe, string> = {
  rivers: 'Rivers between the bases, crossed by bridges and fords.',
  highlands: 'Bases on plateaus, rocky ridges with passes, a mesa in the middle.',
  forest: 'Big solid woods with lanes and clearings between them.',
  plains: 'Wide open ground with a few woods, a pond and ruins.',
}
export const GEN_PLAYERS = [2, 3, 4, 6] as const
export type GenPlayers = (typeof GEN_PLAYERS)[number]
export const GEN_SIZES = ['s', 'm', 'l'] as const
export type GenSize = (typeof GEN_SIZES)[number]
export const GEN_SIZE_NAMES: Record<GenSize, string> = { s: 'Small', m: 'Medium', l: 'Large' }
export const GEN_MAX_SEED = 99999

export type GenRules = { recipe: Recipe; players: GenPlayers; size: GenSize; seed: number }
export const DEFAULT_GEN: GenRules = { recipe: 'rivers', players: 2, size: 'm', seed: 1 }

/** A generated map's id. */
export const genId = (r: GenRules) => `gen:${r.recipe}:${r.players}:${r.size}:${r.seed}`
/** The rules in a generated map's id, or null when it isn't one. */
export function parseGenId(id: string): GenRules | null {
  const m = /^gen:(\w+):(\d+):(\w):(\d+)$/.exec(id)
  if (!m) return null
  const recipe = m[1] as Recipe, players = Number(m[2]) as GenPlayers, size = m[3] as GenSize, seed = Number(m[4])
  if (!RECIPES.includes(recipe) || !GEN_PLAYERS.includes(players) || !GEN_SIZES.includes(size) || seed > GEN_MAX_SEED) return null
  return { recipe, players, size, seed }
}
/** Rules made safe (anything unknown back to the default). */
export const cleanGen = (r: Partial<GenRules> | undefined): GenRules => ({
  recipe: RECIPES.includes(r?.recipe as Recipe) ? (r!.recipe as Recipe) : DEFAULT_GEN.recipe,
  players: GEN_PLAYERS.includes(r?.players as GenPlayers) ? (r!.players as GenPlayers) : DEFAULT_GEN.players,
  size: GEN_SIZES.includes(r?.size as GenSize) ? (r!.size as GenSize) : DEFAULT_GEN.size,
  seed: Number.isInteger(r?.seed) && r!.seed! >= 0 && r!.seed! <= GEN_MAX_SEED ? r!.seed! : DEFAULT_GEN.seed,
})

/** Map side in tiles by size, for two players; more players get more room. */
const SIDE: Record<GenSize, number> = { s: 76, m: 96, l: 120 }
const sideFor = (r: GenRules) => Math.round((SIDE[r.size] * (r.players >= 6 ? 1.3 : r.players > 2 ? 1.15 : 1)) / 4) * 4

type Frame = {
  n: number
  /** The map's middle, the unit vector out to the spawn and the one across (b grows to its left). */
  cx: number
  cy: number
  ux: number
  uy: number
  vx: number
  vy: number
  /** Half the sector's angle: features stay within it. */
  half: number
  /** The spawn's distance from the middle. */
  rs: number
}

/** A point in a sector's frame, in tiles. */
const at = (f: Frame, a: number, b: number): TilePt => [f.cx + f.ux * a + f.vx * b, f.cy + f.uy * a + f.vy * b]

/** The symmetry for a player count and recipe. */
function symmetryOf(r: GenRules): { sym: Symmetry; mirror?: 'diagonal' } {
  if (r.players === 2) return r.recipe === 'rivers' ? { sym: 'none', mirror: 'diagonal' } : { sym: 'point' }
  if (r.players === 3) return { sym: 'tri' }
  if (r.players === 4) return { sym: 'quad' }
  return { sym: 'hex' }
}

/** An irregular round polygon (a wood, a mesa) round a middle, radius `r` give or take `jag`. */
function blob(rand: () => number, c: TilePt, rx: number, ry: number, jag: number, turn = 0): TilePt[] {
  const k = 9 + Math.floor(rand() * 4)
  const pts: TilePt[] = []
  const start = rand() * Math.PI * 2
  for (let i = 0; i < k; i++) {
    const t = start + (i / k) * Math.PI * 2
    const m = 1 - jag / 2 + rand() * jag
    const x = Math.cos(t) * rx * m, y = Math.sin(t) * ry * m
    pts.push([c[0] + x * Math.cos(turn) - y * Math.sin(turn), c[1] + x * Math.sin(turn) + y * Math.cos(turn)])
  }
  return pts
}

const dist = (a: TilePt, b: TilePt) => Math.hypot(a[0] - b[0], a[1] - b[1])
/** Distance from a point to a polyline. */
function toLine(p: TilePt, line: TilePt[]) {
  let best = Infinity
  for (let i = 0; i + 1 < line.length; i++) {
    const [ax, ay] = line[i], [bx, by] = line[i + 1]
    const dx = bx - ax, dy = by - ay
    const t = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / (dx * dx + dy * dy || 1)))
    best = Math.min(best, Math.hypot(ax + dx * t - p[0], ay + dy * t - p[1]))
  }
  return best
}

/** One sector's shapes, before they are copied. */
type Sector = Required<GroundFeatures>
const emptySector = (): Sector => ({ plateaus: [], ramps: [], rivers: [], bridges: [], fords: [], roads: [], forests: [], deposits: [], ruins: [], spawns: [] })

/**
 * Lays out one sector for a recipe. `keep` collects the lines and points nothing solid may cover
 * (roads, ramps, crossings, crystal fields, the build area), so woods and ridges go round them.
 */
function sector(r: GenRules, f: Frame, rand: () => number): Sector {
  const s = emptySector()
  const { n, rs, half } = f
  const spawn = at(f, rs, 0)
  s.spawns.push(spawn)
  const keepLines: { line: TilePt[]; pad: number }[] = []
  const keepPts: { p: TilePt; r: number }[] = [{ p: spawn, r: 11 }]
  const side = rand() < 0.5 ? 1 : -1
  const mirror = symmetryOf(r).mirror === 'diagonal' || symmetryOf(r).sym === 'quad'
  /** The edge of the sector at distance `a` from the middle (b at the edge), on side `sgn`. */
  const edgeB = (a: number, sgn: number) => sgn * (half >= Math.PI / 2 - 1e-6 ? n : a * Math.tan(half))
  /** A point on the sector's edge line (the spawn's direction turned by ±half) `d` from the middle. */
  const onEdge = (d: number, sgn: number): TilePt => {
    const ang = sgn * half
    const ex = f.ux * Math.cos(ang) + f.vx * Math.sin(ang)
    const ey = f.uy * Math.cos(ang) + f.vy * Math.sin(ang)
    return [f.cx + ex * d, f.cy + ey * d]
  }
  // The direction along an edge, from the middle outwards.
  const edgeDir = (sgn: number): TilePt => {
    const p = onEdge(1, sgn)
    return [p[0] - f.cx, p[1] - f.cy]
  }
  /** Whether a point lies inside the sector, `m` tiles in from its edges and the map's border. */
  const inSector = (p: TilePt, m: number) => {
    const mb = Math.max(m, 2)
    if (p[0] < mb || p[1] < mb || p[0] > n - mb || p[1] > n - mb) return false
    const dx = p[0] - f.cx, dy = p[1] - f.cy
    const a = dx * f.ux + dy * f.uy, b = dx * f.vx + dy * f.vy
    if (half >= Math.PI / 2 - 1e-6) return a > m
    return a > 0 && Math.abs(b) < a * Math.tan(half) - m / Math.cos(half)
  }
  /** Places a solid blob (a wood, a ridge) near `c` if it stays clear of everything kept. */
  const solid = (into: TilePt[][] | { level: number; pts: TilePt[] }[], c: TilePt, rx: number, ry: number, level?: number, turn = rand() * Math.PI) => {
    const rmax = Math.max(rx, ry) * 1.15
    // A wood may reach half its size over the sector's edge: its copy on the other side joins it.
    if (!inSector(c, level === undefined ? -rmax * 0.5 : 3)) return false
    if (keepPts.some((k) => dist(k.p, c) < k.r + rmax + 1)) return false
    if (keepLines.some((k) => toLine(c, k.line) < k.pad + rmax + 1)) return false
    const pts = blob(rand, c, rx, ry, 0.35, turn)
    if (level === undefined) (into as TilePt[][]).push(pts)
    else (into as { level: number; pts: TilePt[] }[]).push({ level, pts })
    keepPts.push({ p: c, r: rmax })
    return true
  }
  /** A random spot anywhere on the map (solid() keeps only those in this sector). */
  const anywhere = (): TilePt => [4 + rand() * (n - 8), 4 + rand() * (n - 8)]
  const field = (p: TilePt) => {
    s.deposits.push(p)
    keepPts.push({ p, r: 3.5 })
  }
  // A road from the spawn towards the middle (and on to a crossing, if there is one).
  const road = (pts: TilePt[]) => {
    s.roads.push({ pts, width: 2.6 })
    keepLines.push({ line: pts, pad: 2.5 })
  }
  // A crystal field by the base, off to one side (clear of the build area's square, which doesn't
  // turn with the sector).
  field(at(f, rs - 4, side * 13.5))

  if (r.recipe === 'rivers') {
    const lake = r.players > 2 ? 5 + n * 0.03 : 0
    if (lake) s.rivers.push({ pts: [[f.cx, f.cy], [f.cx, f.cy]], width: lake * 2 })
    // A river along each of the sector's edges, from the middle out past the map's border.
    for (const sgn of [1, -1]) {
      const out = onEdge(n, sgn)
      s.rivers.push({ pts: [[f.cx, f.cy], out], width: 8 })
      // Woods may come down to the banks.
      keepLines.push({ line: [[f.cx, f.cy], out], pad: 3 })
    }
    // Crossings: on a mirror line each edge gets one (a bridge on one, a ford on the other); turned
    // copies share an edge with the neighbour, so each sector puts both on its +b edge.
    const crossings: { sgn: number; d: number; kind: 'bridge' | 'ford' }[] = mirror
      ? [{ sgn: 1, d: Math.max(lake + 9, rs * 0.55), kind: 'bridge' }, { sgn: -1, d: Math.max(lake + 9, rs * 0.75), kind: 'ford' }]
      : [{ sgn: 1, d: Math.max(lake + 9, rs * 0.5), kind: 'bridge' }, { sgn: 1, d: Math.max(lake + 18, rs * 0.95), kind: 'ford' }]
    for (const c of crossings) {
      const p = onEdge(c.d, c.sgn)
      const [dx, dy] = edgeDir(c.sgn)
      const l = Math.hypot(dx, dy)
      const nx = -dy / l, ny = dx / l
      if (c.kind === 'bridge') {
        s.bridges.push({ from: [p[0] - nx * 8, p[1] - ny * 8], to: [p[0] + nx * 8, p[1] + ny * 8], width: 5 })
        // The road from the base to this bridge's near end, and on over it.
        const ends: TilePt[] = [[p[0] - nx * 8, p[1] - ny * 8], [p[0] + nx * 8, p[1] + ny * 8]]
        const near = dist(ends[0], spawn) < dist(ends[1], spawn) ? ends[0] : ends[1]
        road([spawn, at(f, rs * 0.7, side * 2), near, p])
        keepPts.push({ p, r: 7 })
      } else {
        s.fords.push({ at: p, radius: 6 })
        field(p)
        keepPts.push({ p, r: 7 })
      }
    }
    // A mesa with crystals on top, well clear of the base, its ramp facing the middle of the map.
    const ma = Math.min(rs * 0.55, rs - 24)
    const mc = at(f, ma, -side * Math.min(rs * 0.35, Math.abs(edgeB(ma, 1)) * 0.5))
    if (ma > 6 && inSector(mc, 10) && dist(mc, spawn) > 24) {
      s.plateaus.push({ level: 1, pts: blob(rand, mc, 9, 7, 0.25, rand() * Math.PI) })
      field(mc)
      const lane = at(f, ma * 0.4, 0)
      const dx = lane[0] - mc[0], dy = lane[1] - mc[1]
      const dl = Math.hypot(dx, dy) || 1
      const foot: TilePt = [mc[0] + (dx / dl) * 13, mc[1] + (dy / dl) * 13]
      s.ramps.push({ from: foot, to: [mc[0] + (dx / dl) * 4, mc[1] + (dy / dl) * 4], width: 5 })
      keepPts.push({ p: mc, r: 11 })
      keepLines.push({ line: [mc, [mc[0] + (dx / dl) * 15, mc[1] + (dy / dl) * 15]], pad: 3 })
    }
    for (let i = 0; i < 200 && s.forests.length < 4; i++) solid(s.forests, anywhere(), 4 + rand() * 4, 3.5 + rand() * 3)
    s.ruins.push(at(f, Math.min(rs * 0.75, rs - 16), side * 6))
  } else if (r.recipe === 'highlands') {
    // The base on its own plateau, a ramp down towards the middle.
    s.plateaus.push({ level: 1, pts: blob(rand, spawn, 18.5, 18.5, 0.1) })
    const rampFoot = at(f, rs - 24, 0), rampTop = at(f, rs - 14.5, 0)
    s.ramps.push({ from: rampFoot, to: rampTop, width: 6 })
    keepLines.push({ line: [spawn, at(f, rs - 26, 0)], pad: 4 })
    keepPts.push({ p: spawn, r: 20 })
    // The middle: a mesa with crystals, a ramp from this side.
    const mid: TilePt = [f.cx, f.cy]
    {
      s.plateaus.push({ level: 1, pts: blob(rand, mid, 8 + n * 0.02, 8 + n * 0.02, 0.15) })
      s.deposits.push(mid)
      const rr = 8 + n * 0.02
      s.ramps.push({ from: at(f, rr + 6, 0), to: at(f, rr - 3, 0), width: 5 })
      keepPts.push({ p: mid, r: rr + 4 })
      keepLines.push({ line: [mid, at(f, rr + 9, 0)], pad: 3 })
    }
    road([spawn, rampTop, rampFoot, at(f, 8 + n * 0.02 + 7, 0)])
    // Ridges along the edges with a pass halfway: bare rock, no way up.
    const passD = rs * 0.62
    for (const sgn of mirror ? [1, -1] : [1]) {
      const inner = onEdge(Math.max(8 + n * 0.02 + 6, passD * 0.45), sgn), passIn = onEdge(passD - 4, sgn), passOut = onEdge(passD + 4, sgn), outer = onEdge(n * 0.75, sgn)
      for (const [a, b] of [[inner, passIn], [passOut, outer]] as [TilePt, TilePt][]) {
        const len = dist(a, b)
        if (len < 6) continue
        const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2
        s.plateaus.push({ level: 1, pts: blob(rand, [mx, my], len / 2, 2.6, 0.2, Math.atan2(b[1] - a[1], b[0] - a[0])) })
      }
      const pass = onEdge(passD, sgn)
      s.deposits.push(pass)
    }
    for (let i = 0; i < 140 && s.forests.length < 3; i++) solid(s.forests, anywhere(), 4 + rand() * 3, 3 + rand() * 3)
    s.ruins.push(at(f, Math.min(rs * 0.45, rs - 16), side * 7))
  } else if (r.recipe === 'forest') {
    road([spawn, at(f, rs * 0.5, side * 3), [f.cx, f.cy]])
    // A lane out to each edge's middle, kept open.
    for (const sgn of [1, -1]) keepLines.push({ line: [at(f, rs * 0.75, 0), onEdge(rs * 0.6, sgn)], pad: 4 })
    // Clearings with crystals.
    const clear = at(f, rs * 0.55, -side * rs * 0.3)
    if (inSector(clear, 6)) field(clear)
    keepPts.push({ p: clear, r: 6 })
    for (const sgn of mirror ? [1, -1] : [1]) field(onEdge(rs * 0.6, sgn))
    if (r.players > 2) field([f.cx, f.cy])
    // Big woods everywhere else.
    for (let i = 0; i < 300 && s.forests.length < 8; i++) solid(s.forests, anywhere(), 6 + rand() * 6, 5 + rand() * 5)
    s.rivers.push({ pts: [at(f, rs * 0.4, side * rs * 0.35), at(f, rs * 0.4, side * rs * 0.35)], width: 6 })
  } else {
    // Open plains: roads to the middle, a pond in the middle, a few small woods, a low ridge, ruins.
    road([spawn, at(f, rs * 0.5, -side * 4), [f.cx, f.cy]])
    s.rivers.push({ pts: [[f.cx, f.cy], [f.cx, f.cy]], width: 7 + n * 0.03 })
    keepPts.push({ p: [f.cx, f.cy], r: 6 + n * 0.02 })
    field(at(f, rs * 0.5, side * rs * 0.28))
    for (const sgn of mirror ? [1, -1] : [1]) field(onEdge(rs * 0.55, sgn))
    for (let i = 0; i < 140 && s.forests.length < 3; i++) solid(s.forests, anywhere(), 3 + rand() * 3, 3 + rand() * 2)
    for (let i = 0; i < 60 && s.plateaus.length < 1; i++) solid(s.plateaus, anywhere(), 6 + rand() * 3, 2.2, 1)
    s.ruins.push(at(f, Math.min(rs * 0.65, rs - 16), side * 5), at(f, rs * 0.3, -side * 8))
  }
  return s
}

/** A generated map's definition. Laid out again (from a varied stream) until it passes the reach
 * and fairness checks, so a seed always gives a playable map. */
export function generateGroundDef(rules: GenRules): GroundMapDef {
  const r = cleanGen(rules)
  const n = sideFor(r)
  const sy = symmetryOf(r)
  let best: GroundMapDef | null = null
  for (let attempt = 0; attempt < 12; attempt++) {
    const rand = rng(r.seed * 7919 + RECIPES.indexOf(r.recipe) * 104729 + r.players * 31 + n * 7 + attempt * 1000003)
    // The first sector points at the top left corner (two and four players) or straight up.
    const ang = r.players === 2 || r.players === 4 ? Math.atan2(-1, -1) : -Math.PI / 2
    const ux = Math.cos(ang), uy = Math.sin(ang)
    const half = sy.mirror === 'diagonal' || sy.sym === 'point' ? Math.PI / 2 : Math.PI / r.players
    // The spawn as far out as the map allows, 15 tiles in from the border.
    let rs = Infinity
    for (const k of Array.from({ length: r.players }, (_, i) => i)) {
      const a = ang + (k * Math.PI * 2) / r.players
      const cx = Math.abs(Math.cos(a)), cy = Math.abs(Math.sin(a))
      rs = Math.min(rs, cx > 1e-6 ? (n / 2 - 15) / cx : Infinity, cy > 1e-6 ? (n / 2 - 15) / cy : Infinity)
    }
    const frame: Frame = { n, cx: n / 2, cy: n / 2, ux, uy, vx: -uy, vy: ux, half, rs }
    const s = sector(r, frame, rand)
    // One sector's shapes: buildGroundMap copies them to every side (expandFeatures in terrain.ts).
    const def: GroundMapDef = {
      id: genId(r),
      name: `${RECIPE_NAMES[r.recipe]} (generated)`,
      blurb: `${RECIPE_BLURBS[r.recipe]} ${r.players} players, ${GEN_SIZE_NAMES[r.size].toLowerCase()}, seed ${r.seed}.`,
      cols: n,
      rows: n,
      cell: 1,
      sym: sy.sym,
      ...(sy.mirror ? { mirror: sy.mirror } : {}),
      seed: (r.seed * 131 + attempt) % 100000,
      biome: 'temperate',
      sketch: [],
      features: dedupe(s),
    }
    best ??= def
    if (!problem(buildGroundMap(def))) return def
  }
  return best!
}

/** Drops shapes that landed on themselves (a mirror line maps onto itself). */
function dedupe(s: Sector): GroundFeatures {
  const key = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === 'number' ? Math.round(x * 4) / 4 : x))
  const uniq = <T>(list: T[], k: (t: T) => string = key) => list.filter((t, i) => list.findIndex((o) => k(o) === k(t)) === i)
  const seg = (a: TilePt, b: TilePt) => [key(a), key(b)].sort().join('|')
  return {
    plateaus: uniq(s.plateaus, (p) => key(p.pts.map((q) => q).sort((a, b) => a[0] - b[0] || a[1] - b[1]))),
    ramps: uniq(s.ramps),
    rivers: uniq(s.rivers, (p) => seg(p.pts[0], p.pts[p.pts.length - 1]) + p.width),
    bridges: uniq(s.bridges, (b) => seg(b.from, b.to)),
    fords: uniq(s.fords),
    roads: uniq(s.roads),
    forests: uniq(s.forests, (p) => key([...p].sort((a, b) => a[0] - b[0] || a[1] - b[1]))),
    deposits: s.deposits,
    ruins: s.ruins,
    spawns: s.spawns,
  }
}

// --- Checks ---------------------------------------------------------------------------------------

/** How far (in tiles, a diagonal step √2) the way by canStep runs from tile `start` to every tile,
 * -1 where it can't get. Dijkstra over whole tenths (10 straight, 14 diagonal) with a bucket queue. */
export function stepsFrom(map: GroundMap, start: number): Float64Array {
  const g = map.grid
  const n = g.cols * g.rows
  const d = new Int32Array(n).fill(-1)
  const buckets: number[][] = Array.from({ length: 15 }, () => [])
  d[start] = 0
  buckets[0].push(start)
  let pending = 1
  for (let cost = 0; pending > 0; cost++) {
    const b = buckets[cost % 15]
    while (b.length) {
      const t = b.pop()!
      pending--
      if (d[t] !== cost) continue
      const c = t % g.cols, r = (t - c) / g.cols
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue
          const nc = c + dx, nr = r + dy
          if (nc < 0 || nr < 0 || nc >= g.cols || nr >= g.rows) continue
          const u = nr * g.cols + nc
          const nd = cost + (dx && dy ? 14 : 10)
          if ((d[u] < 0 || nd < d[u]) && canStep(g, t, u)) {
            d[u] = nd
            buckets[nd % 15].push(u)
            pending++
          }
        }
    }
  }
  const out = new Float64Array(n)
  for (let i = 0; i < n; i++) out[i] = d[i] < 0 ? -1 : d[i] / 10
  return out
}

const tileOf = (map: GroundMap, p: { x: number; y: number }) => Math.floor(p.y / TILE) * map.grid.cols + Math.floor(p.x / TILE)

/**
 * What's wrong with a map, or null: a spawn that can't reach another spawn or a crystal field, a
 * blocking prop on a ramp or in a build area, a build area that isn't open level ground, a base with
 * no crystal field within 20 tiles' walk, or bases whose way to their nearest field or to each other
 * differs too much (fairness).
 */
export function problem(map: GroundMap, opts: { nearField?: boolean } = {}): string | null {
  const g = map.grid
  if (map.spawns.length < 2) return 'fewer than two spawns'
  const near: number[] = []
  const toOthers: number[][] = []
  for (let i = 0; i < map.spawns.length; i++) {
    const d = stepsFrom(map, tileOf(map, map.spawns[i]))
    const others = map.spawns.map((s, j) => (j === i ? 0 : d[tileOf(map, s)])).filter((_, j) => j !== i)
    if (others.some((v) => v < 0)) return `spawn ${i + 1} can't reach every other spawn`
    const deps = map.deposits.map((p) => d[tileOf(map, p)])
    if (deps.some((v) => v < 0)) return `spawn ${i + 1} can't reach every crystal field`
    near.push(Math.min(...deps))
    toOthers.push(others.sort((a, b) => a - b))
    const ar = spawnArea(map, i)
    for (let r = ar.r0; r <= ar.r1; r++)
      for (let c = ar.c0; c <= ar.c1; c++) {
        if (c < 0 || r < 0 || c >= g.cols || r >= g.rows) return `spawn ${i + 1}'s build area runs off the map`
        const t = r * g.cols + c
        if (g.flags[t] & (TF.blocked | TF.noBuild) || g.height[t] !== g.height[tileOf(map, map.spawns[i])]) return `spawn ${i + 1}'s build area isn't open level ground`
      }
  }
  for (const p of map.props) {
    if (!p.blocks) continue
    if (blockedTiles(g, p).some((t) => g.flags[t] & TF.ramp)) return 'a blocking prop on a ramp'
  }
  if (opts.nearField !== false && Math.max(...near) > 20) return 'a base with no crystal field near it'
  const fair = (a: number[]) => Math.max(...a) - Math.min(...a) <= Math.max(4, Math.min(...a) * 0.15)
  const show = (a: number[]) => a.map((v) => v.toFixed(0)).join(', ')
  if (!fair(near)) return `bases' nearest crystal fields are unfairly far apart (${show(near)} tiles)`
  for (let k = 0; k < toOthers[0].length; k++) if (!fair(toOthers.map((o) => o[k]))) return `bases are unfairly far from each other (${show(toOthers.map((o) => o[k]))} tiles)`
  return null
}
