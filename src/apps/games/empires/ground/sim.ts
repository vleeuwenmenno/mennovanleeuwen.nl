// The ground battle sim: a world on a tile map, ticked 30 times a second, the same on every machine
// for the same orders (lockstep, as the space sim). It shares the space sim's ground rules but none
// of its state: sim.ts and its multiplayer hash are untouched by anything here.
//
// Lockstep rules: no Math.random (the world's own random stream, `rand`), no Date, trig through
// detmath.ts, units handled in the order of `w.units`, and the nav grid changed only at the start of
// a tick (nav.ts flushStamps). No DOM: the server will run this too.
//
// What a tick does, in order:
// 1. Building stamps placed since the last tick change the nav grid.
// 2. Each unit follows its orders: a move finds a path (again, when the grid changed or it got
//    stuck), turns towards the next waypoint and drives, slowing to stop on the last one.
// 3. Ground units that overlap push each other gently apart.
// 4. A unit standing where it can't (a building went up on it) is pushed onto open ground.
// 5. Fog, four times a second.

import { atan2, cos, sin } from '../detmath.ts'
import type { FactionId } from '../data/kit.ts'
import { TILE, type GroundMap, type Pt } from './types.ts'
import { anchorAt, findPath, flushStamps, movesTo, nearestStand, newNav, onMap, spotOf, stampFootprint, stands, tileAt, type GroundNav, type NavClass } from './nav.ts'
import { dropEye, newFog, placeEye, type Eye, type GroundFog } from './fog.ts'

export const STEP = 1 / 30
/** Fog refreshes a second. */
export const FOG_HZ = 4

// --- Unit types ---------------------------------------------------------------------------------

/** What a ground unit or building is, as data. */
export type GroundUnitType = {
  id: string
  name: string
  kind: 'vehicle' | 'structure'
  /** Size class for path finding: the square of tiles it needs (nav.ts). */
  size: NavClass
  /** Body radius in world units: how close other units come. */
  radius: number
  /** Top speed, world units a second. */
  speed: number
  /** Acceleration and braking, world units a second squared. */
  accel: number
  /** Turn rate, radians a second. */
  turn: number
  hull: number
  /** Sight radius in tiles. */
  sight: number
  /** Buildings: footprint in tiles, columns × rows. */
  foot?: [number, number]
}

/** Test units for the sim's checks until the real Engineer and Command Center arrive: a vehicle of
 * each size class, and a building. */
export const GROUND_UNITS: GroundUnitType[] = [
  { id: 'test-scout', name: 'Test scout', kind: 'vehicle', size: 1, radius: 11, speed: 110, accel: 220, turn: 6, hull: 60, sight: 7 },
  { id: 'test-rover', name: 'Test rover', kind: 'vehicle', size: 2, radius: 22, speed: 80, accel: 140, turn: 3, hull: 200, sight: 6 },
  { id: 'test-crawler', name: 'Test crawler', kind: 'vehicle', size: 3, radius: 36, speed: 50, accel: 80, turn: 1.6, hull: 600, sight: 5 },
  { id: 'test-block', name: 'Test block', kind: 'structure', size: 3, radius: 48, speed: 0, accel: 0, turn: 0, hull: 1500, sight: 4, foot: [3, 3] },
]
export const GROUND_UNIT: Record<string, GroundUnitType> = Object.fromEntries(GROUND_UNITS.map((t) => [t.id, t]))
const TYPE_INDEX = new Map(GROUND_UNITS.map((t, i) => [t.id, i]))

// --- The world ----------------------------------------------------------------------------------

/** A player's seat number. */
export type Owner = number

export type GroundOrder = { k: 'move'; x: number; y: number }

export type GroundUnit = {
  id: number
  type: string
  owner: Owner
  x: number
  y: number
  /** Facing, radians (0 is +x). */
  heading: number
  /** Current speed along the heading, world units a second. */
  speed: number
  hull: number
  /** Orders, the first one under way. */
  orders: GroundOrder[]
  /** Waypoints of the current order still ahead. */
  path: Pt[]
  /** The nav grid version the path was found on; -1 to find it again. */
  pv: number
  /** The path ends short of where it was sent (walled in). */
  short: boolean
  /** Seconds without getting nearer the next waypoint, and the nearest it has been. */
  stuck: number
  best: number
  /** Paths found again for being stuck since the last waypoint passed. */
  tries: number
  /** Buildings: the footprint's top-left tile. */
  tc: number
  tr: number
  dead: boolean
  /** Its fog disc (fog.ts). */
  eye?: Eye
}

export type GroundPlayer = { team: number; faction: FactionId; credits: number }

export type GroundEvent =
  | { k: 'arrived'; id: number }
  | { k: 'gaveUp'; id: number }
  | { k: 'added'; id: number }
  | { k: 'removed'; id: number }

export type GroundWorld = {
  map: GroundMap
  /** Size in world units. */
  w: number
  h: number
  players: GroundPlayer[]
  /** Seconds since the start, and ticks. */
  time: number
  ticks: number
  /** The random stream's state (rand). */
  rs: number
  units: GroundUnit[]
  byId: Map<number, GroundUnit>
  /** What happened this tick, for the screen and sound; whoever reads them clears them. */
  events: GroundEvent[]
  nextId: number
  /** The winning team, -1 while the battle goes on (nothing wins yet: there is no combat). */
  winner: number
  nav: GroundNav
  fog: GroundFog
}

export type GroundSeat = { faction: FactionId; team: number }

export function newGroundWorld(map: GroundMap, seats: GroundSeat[], opts: { seed?: number; credits?: number } = {}): GroundWorld {
  const seed = opts.seed ?? map.def.seed
  const teams = seats.reduce((m, s) => Math.max(m, s.team + 1), 1)
  return {
    map,
    w: map.grid.cols * TILE,
    h: map.grid.rows * TILE,
    players: seats.map((s) => ({ team: s.team, faction: s.faction, credits: opts.credits ?? 0 })),
    time: 0,
    ticks: 0,
    rs: (seed ^ 0x9e3779b9) >>> 0,
    units: [],
    byId: new Map(),
    events: [],
    nextId: 1,
    winner: -1,
    nav: newNav(map),
    fog: newFog(map.grid, teams),
  }
}

/** The battle's next random number in [0, 1): mulberry32, its state in the world. */
export function rand(w: GroundWorld) {
  w.rs = (w.rs + 0x6d2b79f5) >>> 0
  let t = w.rs
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const TAU = Math.PI * 2
export const wrapAngle = (a: number) => ((((a + Math.PI) % TAU) + TAU) % TAU) - Math.PI
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

export const typeOf = (u: GroundUnit) => GROUND_UNIT[u.type]
export const isStructure = (u: GroundUnit) => typeOf(u).kind === 'structure'
export const teamOf = (w: GroundWorld, owner: Owner) => w.players[owner]?.team ?? -1

function make(w: GroundWorld, type: string, owner: Owner, x: number, y: number, heading: number): GroundUnit {
  const t = GROUND_UNIT[type]
  if (!t) throw new Error(`no ground unit type ${type}`)
  const u: GroundUnit = {
    id: w.nextId++, type, owner, x, y, heading, speed: 0, hull: t.hull, orders: [], path: [], pv: -1, short: false,
    stuck: 0, best: Infinity, tries: 0, tc: -1, tr: -1, dead: false,
  }
  w.units.push(u)
  w.byId.set(u.id, u)
  w.events.push({ k: 'added', id: u.id })
  return u
}

/** A new vehicle at (x, y). One put down where it can't stand is pushed onto open ground. */
export function spawnUnit(w: GroundWorld, type: string, owner: Owner, x: number, y: number, heading = 0) {
  if (GROUND_UNIT[type]?.kind !== 'vehicle') throw new Error(`${type} is not a vehicle`)
  return make(w, type, owner, x, y, heading)
}

/** A new building with its footprint's top-left on tile (tc, tr). Its footprint stamps the nav grid
 * at the start of the next tick. Whether it may go there is the caller's to check (footprintOpen). */
export function addStructure(w: GroundWorld, type: string, owner: Owner, tc: number, tr: number) {
  const t = GROUND_UNIT[type]
  if (t?.kind !== 'structure' || !t.foot) throw new Error(`${type} is not a building`)
  const [fw, fh] = t.foot
  const u = make(w, type, owner, (tc + fw / 2) * TILE, (tr + fh / 2) * TILE, Math.PI / 2)
  u.tc = tc
  u.tr = tr
  stampFootprint(w.nav, tc, tr, fw, fh, 1)
  return u
}

/** Takes a unit out of the battle: its fog disc at once, a building's stamp at the next tick. It
 * leaves `w.units` at the end of the tick. */
export function removeUnit(w: GroundWorld, u: GroundUnit) {
  if (u.dead) return
  u.dead = true
  dropEye(w.fog, u)
  const t = typeOf(u)
  if (t.foot) stampFootprint(w.nav, u.tc, u.tr, t.foot[0], t.foot[1], -1)
  w.byId.delete(u.id)
  w.events.push({ k: 'removed', id: u.id })
}

// --- Orders -------------------------------------------------------------------------------------

/** Most orders a unit holds at once (a long shift-queue stops growing). */
const MAX_ORDERS = 32

/** A unit `owner` may order about: its own, alive, and able to move. */
function commandable(u: GroundUnit | undefined, owner: Owner): u is GroundUnit {
  return !!u && !u.dead && u.owner === owner && typeOf(u).kind === 'vehicle'
}

/** The units of `ids` that `owner` may order, each once, in the order given. */
function own(w: GroundWorld, owner: Owner, ids: number[]) {
  const out: GroundUnit[] = []
  const seen = new Set<number>()
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    const u = w.byId.get(id)
    if (commandable(u, owner)) out.push(u)
  }
  return out
}

/**
 * Spots for `n` units round (x, y): a square grid `gap` apart, nearest the middle first (on a tie,
 * in row order), so a group spreads out rather than fighting over one point.
 */
function spots(x: number, y: number, n: number, gap: number): Pt[] {
  const side = Math.ceil(Math.sqrt(n)) + 2
  const out: (Pt & { d: number; k: number })[] = []
  for (let r = -side; r <= side; r++)
    for (let c = -side; c <= side; c++) out.push({ x: x + c * gap, y: y + r * gap, d: c * c + r * r, k: out.length })
  out.sort((a, b) => a.d - b.d || a.k - b.k)
  return out.slice(0, n)
}

/** Sends units to (x, y), spread round it; `queued` adds it after the orders they have. */
export function cmdMove(w: GroundWorld, owner: Owner, ids: number[], x: number, y: number, queued = false) {
  const us = own(w, owner, ids)
  if (!us.length) return
  const gap = us.reduce((m, u) => Math.max(m, typeOf(u).radius), 0) * 2 + 8
  const free = spots(x, y, us.length, gap)
  // Nearest the destination picks first, each taking the nearest spot left (first on a tie).
  const order = us.map((u, i) => ({ u, i, d: (u.x - x) * (u.x - x) + (u.y - y) * (u.y - y) })).sort((a, b) => a.d - b.d || a.i - b.i)
  for (const { u } of order) {
    let best = 0
    let bestD = Infinity
    for (let k = 0; k < free.length; k++) {
      const d = (free[k].x - u.x) * (free[k].x - u.x) + (free[k].y - u.y) * (free[k].y - u.y)
      if (d < bestD) {
        bestD = d
        best = k
      }
    }
    const p = free.splice(best, 1)[0]
    const at = onMap(w.nav, typeOf(u).size, p.x, p.y)
    const o: GroundOrder = { k: 'move', x: at.x, y: at.y }
    if (queued && u.orders.length) {
      if (u.orders.length < MAX_ORDERS) u.orders.push(o)
    } else {
      u.orders = [o]
      u.path = []
      u.pv = -1
    }
  }
}

/** Stops units where they are. */
export function cmdStop(w: GroundWorld, owner: Owner, ids: number[]) {
  for (const u of own(w, owner, ids)) {
    u.orders = []
    u.path = []
    u.pv = -1
  }
}

// --- Movement -----------------------------------------------------------------------------------

/** How near a waypoint on the way counts as passed, and the last one as reached. */
const PASS = TILE * 0.5
const ARRIVE = 4
/** Seconds without progress before a unit finds its path again; how often it may before giving up. */
const STUCK = 1.2
const TRIES = 3
/** How near the end a stuck unit counts as there (others parked on its spot). */
const CROWD = TILE * 2.5
/** How fast a unit is pushed off ground it can't stand on, world units a second. */
const UNSTICK = 120

/** Moves `u` to (x, y) when it may drive there; else slides along one axis; else stops it. */
function drive(w: GroundWorld, u: GroundUnit, tx: number, ty: number) {
  const k = typeOf(u).size
  const { x, y } = onMap(w.nav, k, tx, ty)
  if (movesTo(w.nav, k, u.x, u.y, x, y)) {
    u.x = x
    u.y = y
  } else if (x !== u.x && movesTo(w.nav, k, u.x, u.y, x, u.y)) {
    u.x = x
    u.speed *= 0.7
  } else if (y !== u.y && movesTo(w.nav, k, u.x, u.y, u.x, y)) {
    u.y = y
    u.speed *= 0.7
  } else u.speed = 0
}

function finish(w: GroundWorld, u: GroundUnit, gaveUp = false) {
  u.orders.shift()
  u.path = []
  u.pv = -1
  u.tries = 0
  w.events.push({ k: gaveUp ? 'gaveUp' : 'arrived', id: u.id })
}

/** One tick of a vehicle following its orders. */
function steer(w: GroundWorld, u: GroundUnit) {
  const t = typeOf(u)
  const o = u.orders[0]
  if (!o) {
    u.speed = Math.max(0, u.speed - t.accel * STEP)
    if (u.speed > 0) drive(w, u, u.x + cos(u.heading) * u.speed * STEP, u.y + sin(u.heading) * u.speed * STEP)
    return
  }
  if (u.pv !== w.nav.ver) {
    const p = findPath(w.nav, t.size, u.x, u.y, o.x, o.y)
    u.path = p.pts
    u.short = p.short
    u.pv = w.nav.ver
    u.stuck = 0
    u.best = Infinity
    if (!u.path.length) return finish(w, u, true)
  }
  let p = u.path[0]
  let last = u.path.length === 1
  let dx = p.x - u.x
  let dy = p.y - u.y
  let d = Math.sqrt(dx * dx + dy * dy)
  while (!last && d <= PASS) {
    u.path.shift()
    u.best = Infinity
    u.stuck = 0
    u.tries = 0
    p = u.path[0]
    last = u.path.length === 1
    dx = p.x - u.x
    dy = p.y - u.y
    d = Math.sqrt(dx * dx + dy * dy)
  }
  if (last && d <= ARRIVE) {
    if (u.speed * u.speed <= 2 * t.accel * ARRIVE || d < 0.5) {
      if (movesTo(w.nav, t.size, u.x, u.y, p.x, p.y)) {
        u.x = p.x
        u.y = p.y
      }
      u.speed = 0
      return finish(w, u)
    }
  }
  // Turn towards the waypoint; drive when facing near enough, slower the further off.
  const off = wrapAngle(atan2(dy, dx) - u.heading)
  const turn = t.turn * STEP
  u.heading = wrapAngle(u.heading + clamp(off, -turn, turn))
  const left = Math.abs(off) - Math.min(Math.abs(off), turn)
  // Stuck: no nearer the waypoint for a while, while facing it (turning on the spot doesn't count).
  if (d < u.best - 0.5) {
    u.best = d
    u.stuck = 0
  } else if (left < 0.3 && (u.stuck += STEP) > STUCK) {
    if (last && d < CROWD) {
      u.speed = 0
      return finish(w, u)
    }
    if (++u.tries > TRIES) {
      u.speed = 0
      return finish(w, u, true)
    }
    u.pv = -1
    u.stuck = 0
    u.best = Infinity
  }
  let aim = t.speed * Math.max(0, 1 - left * 1.25)
  if (last) aim = Math.min(aim, Math.sqrt(2 * t.accel * Math.max(0, d - ARRIVE * 0.5)) + 4)
  u.speed = u.speed < aim ? Math.min(aim, u.speed + t.accel * STEP) : Math.max(aim, u.speed - t.accel * STEP)
  let move = u.speed * STEP
  if (last && move > d) move = d
  if (move > 0) drive(w, u, u.x + cos(u.heading) * move, u.y + sin(u.heading) * move)
}

/** Pushes `u` towards the nearest ground it can stand on, when it's somewhere it can't. True when it
 * was pushed (and does nothing else this tick). */
function unstick(w: GroundWorld, u: GroundUnit) {
  const k = typeOf(u).size
  const here = anchorAt(w.nav, k, u.x, u.y)
  if (stands(w.nav, k, here)) return false
  const to = nearestStand(w.nav, k, here)
  if (to < 0) return false
  const p = spotOf(w.nav, k, to)
  const dx = p.x - u.x
  const dy = p.y - u.y
  const d = Math.sqrt(dx * dx + dy * dy)
  const s = UNSTICK * STEP
  if (d <= s) {
    u.x = p.x
    u.y = p.y
  } else {
    u.x += (dx / d) * s
    u.y += (dy / d) * s
  }
  u.speed = 0
  u.pv = -1
  return true
}

/** Bucket size for finding overlapping units: three tiles, more than the two biggest bodies reach. */
const BUCKET = TILE * 3
/** How much of an overlap is pushed out in one tick, and the most a unit moves for it. */
const SEPARATE = 0.25
const SEPARATE_MAX = 3

/** Ground units that overlap push each other apart, gently; a parked unit gives way to a moving one. */
function separate(w: GroundWorld) {
  const movers: GroundUnit[] = []
  for (const u of w.units) if (!u.dead && typeOf(u).kind === 'vehicle') movers.push(u)
  if (movers.length < 2) return
  const bc = Math.ceil(w.w / BUCKET)
  const br = Math.ceil(w.h / BUCKET)
  const buckets = new Map<number, number[]>()
  const keyOf = (u: GroundUnit) => clamp(Math.floor(u.y / BUCKET), 0, br - 1) * bc + clamp(Math.floor(u.x / BUCKET), 0, bc - 1)
  movers.forEach((u, i) => {
    const key = keyOf(u)
    const b = buckets.get(key)
    if (b) b.push(i)
    else buckets.set(key, [i])
  })
  const px = new Float64Array(movers.length)
  const py = new Float64Array(movers.length)
  movers.forEach((a, i) => {
    const key = keyOf(a)
    const c0 = key % bc
    const r0 = (key - c0) / bc
    const ra = typeOf(a).radius
    for (let r = Math.max(0, r0 - 1); r <= Math.min(br - 1, r0 + 1); r++)
      for (let c = Math.max(0, c0 - 1); c <= Math.min(bc - 1, c0 + 1); c++)
        for (const j of buckets.get(r * bc + c) ?? []) {
          if (j <= i) continue
          const b = movers[j]
          const reach = ra + typeOf(b).radius
          let dx = b.x - a.x
          let dy = b.y - a.y
          const d2 = dx * dx + dy * dy
          if (d2 >= reach * reach) continue
          let d = Math.sqrt(d2)
          if (d < 1e-6) {
            // Right on top of each other: apart along a direction from their ids.
            const ang = ((a.id * 7 + b.id * 13) % 16) * (TAU / 16)
            dx = cos(ang)
            dy = sin(ang)
            d = 1
          }
          const push = (reach - Math.sqrt(d2)) * SEPARATE
          // Who gives way: a parked unit more than a moving one.
          const am = a.orders.length > 0
          const bm = b.orders.length > 0
          const share = am === bm ? 0.5 : am ? 0.2 : 0.8
          px[i] -= (dx / d) * push * share
          py[i] -= (dy / d) * push * share
          px[j] += (dx / d) * push * (1 - share)
          py[j] += (dy / d) * push * (1 - share)
        }
  })
  movers.forEach((u, i) => {
    if (!px[i] && !py[i]) return
    const len = Math.sqrt(px[i] * px[i] + py[i] * py[i])
    const s = len > SEPARATE_MAX ? SEPARATE_MAX / len : 1
    const k = typeOf(u).size
    const { x, y } = onMap(w.nav, k, u.x + px[i] * s, u.y + py[i] * s)
    if (movesTo(w.nav, k, u.x, u.y, x, y)) {
      u.x = x
      u.y = y
    } else if (movesTo(w.nav, k, u.x, u.y, x, u.y)) u.x = x
    else if (movesTo(w.nav, k, u.x, u.y, u.x, y)) u.y = y
  })
}

/** Puts each unit's fog disc where it stands now. */
function refreshFog(w: GroundWorld) {
  for (const u of w.units) {
    if (u.dead) continue
    const team = teamOf(w, u.owner)
    if (team < 0) continue
    placeEye(w.fog, u, team, tileAt(w.nav, u.x, u.y), typeOf(u).sight)
  }
}

export function tick(w: GroundWorld) {
  // 1. The one point in the tick where the nav grid changes.
  flushStamps(w.nav)
  // 2. Orders and driving, 4. pushed off ground a unit can't stand on (before it drives).
  for (const u of w.units) {
    if (u.dead || typeOf(u).kind !== 'vehicle') continue
    if (!unstick(w, u)) steer(w, u)
  }
  // 3. Overlaps.
  separate(w)
  // 5. Fog, FOG_HZ times a second (the first tick included).
  if (w.ticks === 0 || Math.floor((w.ticks * FOG_HZ) / 30) !== Math.floor(((w.ticks - 1) * FOG_HZ) / 30)) refreshFog(w)
  if (w.units.some((u) => u.dead)) w.units = w.units.filter((u) => !u.dead)
  w.ticks++
  w.time = w.ticks * STEP
}

// --- Hash ---------------------------------------------------------------------------------------

const hashView = new DataView(new ArrayBuffer(8))

/** A hash of everything that decides what happens next: two copies of a battle that hash the same
 * are in step. */
export function stateHash(w: GroundWorld): number {
  let h = 0x811c9dc5
  const int = (v: number) => {
    h = Math.imul(h ^ (v | 0), 0x01000193)
  }
  const num = (v: number) => {
    hashView.setFloat64(0, v)
    int(hashView.getInt32(0))
    int(hashView.getInt32(4))
  }
  int(w.ticks)
  int(w.rs)
  int(w.nextId)
  int(w.winner)
  int(w.nav.ver)
  int(w.nav.pending.length)
  for (const u of w.units) {
    if (u.dead) continue
    int(u.id)
    int(TYPE_INDEX.get(u.type) ?? -1)
    int(u.owner)
    num(u.x)
    num(u.y)
    num(u.heading)
    num(u.speed)
    num(u.hull)
    int(u.orders.length)
    int(u.path.length)
    int(u.tc)
    int(u.tr)
  }
  for (const p of w.players) num(p.credits)
  // Fog: what each team has explored, and how many eyes are out.
  for (let t = 0; t < w.fog.explored.length; t++) {
    const ex = w.fog.explored[t]
    for (let i = 0; i < ex.length; i += 4) int(ex[i] | (ex[i + 1] << 8) | (ex[i + 2] << 16) | (ex[i + 3] << 24))
    let eyes = 0
    for (const e of w.fog.eyes[t]) eyes += e
    int(eyes)
  }
  return h >>> 0
}
