// Ground battles inside the space game's sim: a battle whose map has terrain (MapDef `ground`) is
// fought on a tile grid by ground units (UnitType `ground`). Everything here is called from a few
// hooks in sim.ts, each one only when the world has terrain (World `ground`), so a space battle runs,
// and hashes, exactly as it did before ground battles existed.
//
// What it adds to the space sim:
// - The terrain layer (World `ground`): the GroundMap, rebuilt from the map's id (never saved), the
//   nav grid with building stamps (nav.ts) and the fog (fog.ts).
// - Movement for ground vehicles: a path on the tile grid by canStep, turn then drive, gentle
//   separation, never onto ground they can't stand on (see groundTick). Ships keep flying.
// - Buildings on the grid: placement by the tile rules, sites that engineers start (our units step
//   off the footprint first) and build, repairs, training out of the door, income.
// - Fog by tile with the height rule instead of space's sight circles, and each team's memory of
//   enemy buildings as last seen (World `known`).
//
// sim.ts reaches all of it through GroundHooks, which this file fills in when it is imported: a build
// that never imports it (the production one, while ground battles are dev-only) never carries it.
//
// The orders are the space game's own (commands.ts): move, stop, place, construct, cancel a site,
// build (train) at a building, cancel, rally. Lockstep rules as in sim.ts: no Math.random, no Date,
// detmath for trig, units in `w.units` order, the nav grid changed only at the start of a tick.
// No DOM: the server runs it too.

import * as M from '../detmath.ts'
import { BASE_POP, UNIT, isEngineer, isGround, isGroundBuilding, type UnitType } from '../data.ts'
import type { MapDef } from '../maps.ts'
import { STEP, giveBack, issue, nextOrder, setGroundHooks, spawn, spend, type Owner, type Player, type QueueItem, type Unit, type World } from '../sim.ts'
import { dropEye, newFog, placeEye, sees, seesAt, type Eye, type GroundFog } from './fog.ts'
import { GROUND_MAP } from './maps.ts'
import {
  anchorAt, findPath, flushStamps, footprintOpen, movesTo, nearestStand, newNav, onMap, spotOf, stampFootprint, stands, standsAt, tileAt, type GroundNav, type NavClass,
} from './nav.ts'
import { buildGroundMap } from './terrain.ts'
import { groundThink } from './think.ts'
import { testField, testMesa } from './testmaps.ts'
import { TF, TILE, canStep, type GroundMap, type Pt } from './types.ts'

// --- Maps -------------------------------------------------------------------------------------------

/** The check scripts' own maps (testmaps.ts), by id, next to the real ones (maps.ts). */
const TEST_MAPS: Record<string, () => GroundMap> = { 'test-mesa': testMesa, 'test-field': testField }

const built = new Map<string, GroundMap>()
/** The ground map with id `id`, built from its definition the first time (the same on every
 * machine), or null when there is none. The grid is never changed afterwards: buildings go on the
 * nav grid's own stamps. */
export function groundMapOf(id: string): GroundMap | null {
  let m = built.get(id)
  if (!m) {
    const def = GROUND_MAP[id]
    const test = TEST_MAPS[id]
    if (!def && !test) return null
    m = def ? buildGroundMap(def) : test()
    built.set(id, m)
  }
  return m
}

const defs = new Map<string, MapDef>()
/** The space game's map for ground map `id`: its size and spawns from the ground map, its kyber
 * crystal fields as its ore (for the lobby's preview and counts: a ground battle mines nothing from
 * them yet), no beacons, rocks, fields, nebulas or wrecks, and `ground` naming the terrain. Null when
 * none. */
export function groundMapDef(id: string): MapDef | null {
  let d = defs.get(id)
  if (!d) {
    const g = groundMapOf(id)
    if (!g) return null
    d = {
      id, name: g.def.name, blurb: g.def.blurb, w: g.grid.cols * TILE, h: g.grid.rows * TILE, spawns: g.spawns.map((p) => ({ x: p.x, y: p.y })),
      ore: g.deposits.map((p) => ({ x: p.x, y: p.y })), beacons: [], sym: g.def.sym, rocks: 0, seed: g.def.seed, fields: [], nebulas: [], wrecks: [], ground: id,
    }
    defs.set(id, d)
  }
  return d
}

/** Every ground map a battle can be fought on (not the check scripts' own), as space maps. */
export const groundMaps = (): MapDef[] => Object.keys(GROUND_MAP).map((id) => groundMapDef(id)!)

// --- The terrain layer --------------------------------------------------------------------------------

/** A team's memory of another team's building, as it last saw it (World `known`). */
export type KnownBuilding = { id: number; unit: string; owner: Owner; tc: number; tr: number }

/** The terrain layer of a ground battle (World `ground`): rebuilt from the map, never saved. */
export type GroundState = { map: GroundMap; nav: GroundNav; fog: GroundFog }

/** A building's footprint: its top-left tile, and whether it stands on the nav grid (a site does only
 * once work has started). */
export type Foot = { c: number; r: number; on: boolean }

/** A ground vehicle's movement state (Unit `gm`): the nav grid version its path was found on (-1:
 * find it again), seconds without getting nearer its next waypoint and the nearest it got, paths
 * found again since the last waypoint, the building it works on this tick (0: none), and an
 * engineer's spot next to the building it was sent to. */
export type GroundMove = { pv: number; stuck: number; best: number; tries: number; busy: number; spot?: Pt }

/** The terrain layer for world `w`, whose map names its ground map. */
export function newGround(w: World): GroundState {
  const map = groundMapOf(w.map.ground!)
  if (!map) throw new Error(`No ground map ${w.map.ground}`)
  return { map, nav: newNav(map), fog: newFog(map.grid, w.teams) }
}

/** The ground unit types of `faction`: its engineer and its Command Center. */
export function groundIds(faction: string): { engineer: string; center: string } {
  const own = Object.values(UNIT).filter((t) => t.faction === faction && t.ground)
  return { engineer: own.find((t) => isEngineer(t))!.id, center: own.find((t) => isGroundBuilding(t) && t.ground!.trains?.length)!.id }
}

const gs = (w: World) => w.ground!
const spec = (t: UnitType) => t.ground!
const size = (u: Unit) => spec(u.t).size as NavClass
const team = (w: World, o: Owner) => w.players[o].team
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
const TAU = Math.PI * 2
const wrap = (a: number) => a - TAU * Math.floor((a + Math.PI) / TAU)

/** Which way a building faces: its model's nose up, so it is drawn unturned (ships are drawn turned
 * by their heading plus a quarter turn), its door to the south. */
const FACING = -Math.PI / 2

/** A new building of type `t` for `owner` with its footprint's top-left on tile (c, r): finished,
 * stamped on the nav grid (from the next flush), facing south. Whether it may stand there is the
 * caller's to check: the battle's start, the checks and the dev cheats use it. */
export function raiseBuilding(w: World, t: UnitType, owner: Owner, c: number, r: number): Unit {
  const [fw, fh] = spec(t).foot!
  const u = spawn(w, t.id, owner, (c + fw / 2) * TILE, (r + fh / 2) * TILE, FACING)
  u.foot = { c, r, on: false }
  u.yq = []
  stampDown(w, u)
  return u
}

function stampDown(w: World, u: Unit) {
  const [fw, fh] = spec(u.t).foot!
  stampFootprint(gs(w).nav, u.foot!.c, u.foot!.r, fw, fh, 1)
  u.foot!.on = true
}

/**
 * The start of a ground battle (newWorld calls it): each player's Command Center in the middle of its
 * spawn's plateau, its door to the south, one engineer a row beyond the door, the rally point in
 * front of the door. Every team knows where the others start (as stations are always on the space map).
 */
export function groundStart(w: World) {
  const g = gs(w)
  w.known = Array.from({ length: w.teams }, () => [])
  w.players.forEach((p, o) => {
    const ids = groundIds(p.faction)
    const ct = UNIT[ids.center]
    const [fw, fh] = spec(ct).foot!
    const c = clamp(Math.round(p.start.x / TILE) - (fw >> 1), 0, g.nav.cols - fw)
    const r = clamp(Math.round(p.start.y / TILE) - (fh >> 1), 0, g.nav.rows - fh)
    const cc = raiseBuilding(w, ct, o, c, r)
    p.station = cc.id
    const et = UNIT[ids.engineer]
    const k = spec(et).size as NavClass
    const at = nearestStand(g.nav, k, (r + fh + 1) * g.nav.cols + c + (fw >> 1))
    const sp = at >= 0 ? spotOf(g.nav, k, at) : { x: cc.x, y: (r + fh + 1.5) * TILE }
    spawn(w, et.id, o, sp.x, sp.y, Math.PI / 2)
    p.rally = onMap(g.nav, k, cc.x, (r + fh + 3) * TILE)
  })
  // Stamps go down now, so the first tick's paths go round the Command Centers.
  flushStamps(g.nav)
  for (const u of w.units)
    if (u.foot) for (let t = 0; t < w.teams; t++) if (t !== team(w, u.owner)) w.known![t].push({ id: u.id, unit: u.t.id, owner: u.owner, tc: u.foot.c, tr: u.foot.r })
  groundSight(w)
}

// --- Movement ---------------------------------------------------------------------------------------

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
/** How near a building an engineer works from: its middle within this far of the footprint's edge. */
export const REACH = TILE * 1.6

const moveOf = (u: Unit): GroundMove => (u.gm ??= { pv: -1, stuck: 0, best: Infinity, tries: 0, busy: 0 })

/** Moves `u` to (x, y) when it may drive there; else slides along one axis; else stops it. */
function drive(w: World, u: Unit, tx: number, ty: number) {
  const nav = gs(w).nav
  const k = size(u)
  const { x, y } = onMap(nav, k, tx, ty)
  if (movesTo(nav, k, u.x, u.y, x, y)) {
    u.x = x
    u.y = y
  } else if (x !== u.x && movesTo(nav, k, u.x, u.y, x, u.y)) {
    u.x = x
    u.v *= 0.7
  } else if (y !== u.y && movesTo(nav, k, u.x, u.y, u.x, y)) {
    u.y = y
    u.v *= 0.7
  } else u.v = 0
}

/** How far (x, y) lies from building `s`'s footprint, in world units (0 on it). */
export function footDist(s: Unit, x: number, y: number) {
  const [fw, fh] = spec(s.t).foot!
  const x0 = s.foot!.c * TILE
  const y0 = s.foot!.r * TILE
  const dx = Math.max(x0 - x, 0, x - (x0 + fw * TILE))
  const dy = Math.max(y0 - y, 0, y - (y0 + fh * TILE))
  return Math.sqrt(dx * dx + dy * dy)
}

/** How much further a spot already taken by another engineer counts as (squared world units). */
const TAKEN = TILE * 6 * TILE * 6

/**
 * Where engineer `u` parks to work on building `s`: the open spot next to the footprint nearest it
 * that it can reach, one no other engineer sent there has taken if there is one. The building's
 * middle when nowhere next to it can be reached (the order is then given up).
 */
function workSpot(w: World, u: Unit, s: Unit): Pt {
  const nav = gs(w).nav
  const k = size(u)
  const [fw, fh] = spec(s.t).foot!
  const { c: sc, r: sr } = s.foot!
  const taken = new Set<number>()
  for (const o of w.units) if (o !== u && !o.dead && o.gm?.spot && o.order.k === 'construct' && o.order.id === s.id) taken.add(anchorAt(nav, size(o), o.gm.spot.x, o.gm.spot.y))
  const start = nearestStand(nav, k, anchorAt(nav, k, u.x, u.y))
  const piece = start >= 0 ? nav.piece[k - 1][start] : -1
  let best = -1
  let bestD = Infinity
  for (let r = sr - k; r <= sr + fh; r++)
    for (let c = sc - k; c <= sc + fw; c++) {
      // Anchor squares that overlap the footprint are on it, not next to it.
      if (r > sr - k && r < sr + fh && c > sc - k && c < sc + fw) continue
      if (c < 0 || r < 0 || c >= nav.cols || r >= nav.rows) continue
      const i = r * nav.cols + c
      if (!stands(nav, k, i) || (piece >= 0 && nav.piece[k - 1][i] !== piece)) continue
      const p = spotOf(nav, k, i)
      const d = (p.x - u.x) * (p.x - u.x) + (p.y - u.y) * (p.y - u.y) + (taken.has(i) ? TAKEN : 0)
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
  return best < 0 ? { x: s.x, y: s.y } : spotOf(nav, k, best)
}

/** Whether a ground building wants an engineer: a site, or a damaged building. */
const needsWork = (s: Unit) => !s.dead && !!s.foot && (!!s.site || s.hull < s.hullMax - 0.5)

/** The current order is done (or can't be): on to the next. */
function done(u: Unit) {
  u.route = null
  const g = moveOf(u)
  g.pv = -1
  g.tries = 0
  g.spot = undefined
  nextOrder(u, u.x, u.y, u.order.k === 'move' ? (u.order.face ?? null) : null)
}

/** Where the current order sends `u` (null: it has nowhere to go), and the building it works on. */
function goal(w: World, u: Unit): { x: number; y: number; job?: Unit } | null {
  const o = u.order
  if (o.k === 'move' || o.k === 'patrol') return { x: o.x, y: o.y }
  if (o.k === 'construct' && isEngineer(u.t)) {
    const s = w.byId.get(o.id)
    if (!s || !needsWork(s) || s.owner !== u.owner) return null
    const g = moveOf(u)
    g.spot ??= workSpot(w, u, s)
    return { x: g.spot.x, y: g.spot.y, job: s }
  }
  return null
}

/** One tick of a ground vehicle following its orders. */
function steer(w: World, u: Unit) {
  const t = u.t
  const g = moveOf(u)
  const nav = gs(w).nav
  if (u.order.k === 'idle' || u.order.k === 'guard') {
    u.v = Math.max(0, u.v - spec(t).accel * STEP)
    if (u.v > 0) drive(w, u, u.x + M.cos(u.a) * u.v * STEP, u.y + M.sin(u.a) * u.v * STEP)
    return
  }
  const to = goal(w, u)
  if (!to) return done(u)
  if (to.job && footDist(to.job, u.x, u.y) <= REACH) return work(u, to.job)
  if (g.pv !== nav.ver || !u.route || u.route.x !== to.x || u.route.y !== to.y) {
    const p = findPath(nav, size(u), u.x, u.y, to.x, to.y)
    u.route = { x: to.x, y: to.y, pts: p.pts, short: p.short }
    g.pv = nav.ver
    g.stuck = 0
    g.best = Infinity
    if (!p.pts.length) return done(u)
  }
  const pts = u.route.pts
  let p = pts[0]
  let last = pts.length === 1
  let dx = p.x - u.x
  let dy = p.y - u.y
  let d = Math.sqrt(dx * dx + dy * dy)
  while (!last && d <= PASS) {
    pts.shift()
    g.best = Infinity
    g.stuck = 0
    g.tries = 0
    p = pts[0]
    last = pts.length === 1
    dx = p.x - u.x
    dy = p.y - u.y
    d = Math.sqrt(dx * dx + dy * dy)
  }
  const accel = spec(t).accel
  if (last && d <= ARRIVE && (u.v * u.v <= 2 * accel * ARRIVE || d < 0.5)) {
    if (movesTo(nav, size(u), u.x, u.y, p.x, p.y)) {
      u.x = p.x
      u.y = p.y
    }
    u.v = 0
    return arrive(u, to.job)
  }
  // Turn towards the waypoint; drive when facing near enough, slower the further off.
  const off = wrap(M.atan2(dy, dx) - u.a)
  const turn = t.turn * STEP
  u.a = wrap(u.a + clamp(off, -turn, turn))
  const left = Math.abs(off) - Math.min(Math.abs(off), turn)
  // Stuck: no nearer the waypoint for a while, while facing it (turning on the spot doesn't count).
  if (d < g.best - 0.5) {
    g.best = d
    g.stuck = 0
  } else if (left < 0.3 && (g.stuck += STEP) > STUCK) {
    if (last && d < CROWD) {
      u.v = 0
      return arrive(u, to.job)
    }
    if (++g.tries > TRIES) {
      u.v = 0
      return done(u)
    }
    g.pv = -1
    g.stuck = 0
    g.best = Infinity
  }
  let aim = t.speed * Math.max(0, 1 - left * 1.25)
  if (last) aim = Math.min(aim, Math.sqrt(2 * accel * Math.max(0, d - ARRIVE * 0.5)) + 4)
  if (u.order.k === 'move' && u.order.speed < aim) aim = u.order.speed
  u.v = u.v < aim ? Math.min(aim, u.v + accel * STEP) : Math.max(aim, u.v - accel * STEP)
  let move = u.v * STEP
  if (last && move > d) move = d
  if (move > 0) drive(w, u, u.x + M.cos(u.a) * move, u.y + M.sin(u.a) * move)
}

/** At the end of its path: a move is done (a patrol turns round); an engineer next to its building
 * gets to work, or gives up when it couldn't get there. */
function arrive(u: Unit, job?: Unit) {
  const o = u.order
  if (job) {
    if (footDist(job, u.x, u.y) <= REACH) return work(u, job)
    return done(u)
  }
  if (o.k === 'patrol') {
    const { x, y } = o
    o.x = o.bx
    o.y = o.by
    o.bx = x
    o.by = y
    u.route = null
    return
  }
  done(u)
}

/** An engineer next to the building it was sent to: it stops, turns to face it and works (busy). */
function work(u: Unit, s: Unit) {
  const g = moveOf(u)
  g.busy = s.id
  u.route = null
  g.pv = -1
  u.v = 0
  const off = wrap(M.atan2(s.y - u.y, s.x - u.x) - u.a)
  const turn = u.t.turn * STEP
  u.a = wrap(u.a + clamp(off, -turn, turn))
}

/** Pushes `u` towards the nearest ground it can stand on, when it's somewhere it can't. True when it
 * was pushed (and does nothing else this tick). */
function unstick(w: World, u: Unit) {
  const nav = gs(w).nav
  const k = size(u)
  const here = anchorAt(nav, k, u.x, u.y)
  if (stands(nav, k, here)) return false
  const to = nearestStand(nav, k, here)
  if (to < 0) return false
  const p = spotOf(nav, k, to)
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
  u.v = 0
  moveOf(u).pv = -1
  return true
}

/** Bucket size for finding overlapping units: three tiles, more than the two biggest bodies reach. */
const BUCKET = TILE * 3
/** How much of an overlap is pushed out in one tick, and the most a unit moves for it. */
const SEPARATE = 0.25
const SEPARATE_MAX = 3

/** Ground vehicles that overlap push each other apart, gently; a parked one gives way to a moving one. */
function separate(w: World) {
  const nav = gs(w).nav
  const movers: Unit[] = []
  for (const u of w.units) if (!u.dead && u.t.ground && u.t.tier === 'vehicle') movers.push(u)
  if (movers.length < 2) return
  const bc = Math.ceil(w.w / BUCKET)
  const br = Math.ceil(w.h / BUCKET)
  const buckets = new Map<number, number[]>()
  const keyOf = (u: Unit) => clamp(Math.floor(u.y / BUCKET), 0, br - 1) * bc + clamp(Math.floor(u.x / BUCKET), 0, bc - 1)
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
    const ra = spec(a.t).radius
    for (let r = Math.max(0, r0 - 1); r <= Math.min(br - 1, r0 + 1); r++)
      for (let c = Math.max(0, c0 - 1); c <= Math.min(bc - 1, c0 + 1); c++)
        for (const j of buckets.get(r * bc + c) ?? []) {
          if (j <= i) continue
          const b = movers[j]
          const reach = ra + spec(b.t).radius
          let dx = b.x - a.x
          let dy = b.y - a.y
          const dd = dx * dx + dy * dy
          if (dd >= reach * reach) continue
          let d = Math.sqrt(dd)
          if (d < 1e-6) {
            // Right on top of each other: apart along a direction from their ids.
            const ang = ((a.id * 7 + b.id * 13) % 16) * (TAU / 16)
            dx = M.cos(ang)
            dy = M.sin(ang)
            d = 1
          }
          const push = (reach - Math.sqrt(dd)) * SEPARATE
          // Who gives way: a parked unit more than a moving one.
          const am = a.order.k !== 'idle'
          const bm = b.order.k !== 'idle'
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
    const k = size(u)
    const { x, y } = onMap(nav, k, u.x + px[i] * s, u.y + py[i] * s)
    if (movesTo(nav, k, u.x, u.y, x, y)) {
      u.x = x
      u.y = y
    } else if (movesTo(nav, k, u.x, u.y, x, u.y)) u.x = x
    else if (movesTo(nav, k, u.x, u.y, u.x, y)) u.y = y
  })
}

/**
 * Spots for a group sent to (x, y): a square grid round it, wide enough for the biggest of them,
 * nearest the middle first; each unit takes the free spot nearest it, the one nearest the
 * destination choosing first. Every copy of a battle gets the same.
 */
export function groundFormation(w: World, us: Unit[], x: number, y: number): [Unit, Pt][] {
  const gap = us.reduce((m, u) => Math.max(m, spec(u.t).radius), 0) * 2 + 8
  const side = Math.ceil(Math.sqrt(us.length)) + 2
  const all: (Pt & { d: number; k: number })[] = []
  for (let r = -side; r <= side; r++) for (let c = -side; c <= side; c++) all.push({ x: x + c * gap, y: y + r * gap, d: c * c + r * r, k: all.length })
  all.sort((a, b) => a.d - b.d || a.k - b.k)
  const free = all.slice(0, us.length)
  const out: [Unit, Pt][] = []
  const order = us.map((u, i) => ({ u, i, d: (u.x - x) * (u.x - x) + (u.y - y) * (u.y - y) })).sort((a, b) => a.d - b.d || a.i - b.i)
  for (const { u } of order) {
    let best = 0
    let bestD = Infinity
    free.forEach((p, k) => {
      const d = (p.x - u.x) * (p.x - u.x) + (p.y - u.y) * (p.y - u.y)
      if (d < bestD) {
        bestD = d
        best = k
      }
    })
    const p = free.splice(best, 1)[0]
    out.push([u, onMap(gs(w).nav, size(u), p.x, p.y)])
  }
  return out
}

// --- Works: building, repairing, training ---------------------------------------------------------

/** How much faster one to four engineers build (or repair) together than one alone; more than four
 * add nothing. */
export const CREW_RATE = [0, 1, 1.7, 2.2, 2.5]
/** A repair goes this many times as fast as building the same thing (one engineer, from nothing to
 * a whole hull). Repairs are free. */
const REPAIR_RATE = 1.5
/** Seconds an engineer waits for our own units to drive off a site before it starts work anyway
 * (whatever is still on it is then pushed off). Enemy units on it hold the work up while they stay. */
const CLEAR_WAIT = 3

/** Where a unit standing on a footprint (world box x0, y0 to x1, y1) goes to get off it: just past
 * the nearest side it can stand at (left, right, top, bottom on a tie). */
function stepAside(w: World, u: Unit, x0: number, y0: number, x1: number, y1: number): Pt {
  const nav = gs(w).nav
  const k = size(u)
  const m = spec(u.t).radius + 8
  const sides: [number, number, number][] = [
    [x0 - m, u.y, u.x - x0],
    [x1 + m, u.y, x1 - u.x],
    [u.x, y0 - m, u.y - y0],
    [u.x, y1 + m, y1 - u.y],
  ]
  sides.sort((a, b) => a[2] - b[2])
  for (const [x, y] of sides) {
    const p = onMap(nav, k, x, y)
    if (p.x > x0 - m / 2 && p.x < x1 + m / 2 && p.y > y0 - m / 2 && p.y < y1 + m / 2) continue
    if (standsAt(nav, k, p.x, p.y)) return p
  }
  return onMap(nav, k, sides[0][0], sides[0][1])
}

/** A site whose engineer has arrived: work starts once nothing stands on its footprint (our own
 * units are sent off it first). Someone else's building there already: the site is given up and
 * refunded in full. */
function startSite(w: World, s: Unit) {
  const site = s.site!
  const [fw, fh] = spec(s.t).foot!
  const { c, r } = s.foot!
  if (!footprintOpen(gs(w).nav, c, r, fw, fh)) {
    giveBack(w, w.players[s.owner], site.paid, 'structures', `Site lost: ${s.t.name}`)
    w.events.push({ k: 'cancelled', owner: s.owner, amount: site.paid, what: `Site lost: ${s.t.name}` })
    s.dead = true
    w.byId.delete(s.id)
    return
  }
  const x0 = c * TILE
  const y0 = r * TILE
  const x1 = x0 + fw * TILE
  const y1 = y0 + fh * TILE
  const tm = team(w, s.owner)
  let foes = false
  let friends = false
  for (const u of w.units) {
    if (u.dead || !u.t.ground || u.t.tier !== 'vehicle') continue
    const rad = spec(u.t).radius
    if (footDist(s, u.x, u.y) >= rad) continue
    if (team(w, u.owner) !== tm) {
      foes = true
      continue
    }
    friends = true
    // Already driving somewhere off the footprint: let it go.
    const o = u.order
    if (o.k === 'move' && (o.x <= x0 - rad || o.x >= x1 + rad || o.y <= y0 - rad || o.y >= y1 + rad)) continue
    const p = stepAside(w, u, x0, y0, x1, y1)
    // Off it first, then back to what it was doing.
    if (u.order.k !== 'idle') u.queue.unshift(u.order)
    u.order = { k: 'move', x: p.x, y: p.y, attack: false, speed: Infinity }
    u.route = null
  }
  const waited = (site.wait ?? 0) + STEP
  site.wait = waited
  if (foes || (friends && waited < CLEAR_WAIT)) return
  site.started = true
  delete site.wait
  stampDown(w, s)
}

/** A unit of `id` trained at building `s` rolls out of its door (the middle of its south side) and
 * drives to the building's rally point. False when there's nowhere to put it (it waits, done). */
function rollOut(w: World, s: Unit, id: string) {
  const nav = gs(w).nav
  const [fw, fh] = spec(s.t).foot!
  const t = UNIT[id]
  const k = spec(t).size as NavClass
  const c = clamp(s.foot!.c + Math.floor((fw - k) / 2), 0, nav.cols - 1)
  const r = clamp(s.foot!.r + fh, 0, nav.rows - 1)
  const at = nearestStand(nav, k, r * nav.cols + c)
  if (at < 0) return false
  const p = spotOf(nav, k, at)
  const u = spawn(w, id, s.owner, p.x, p.y, Math.PI / 2)
  const go = onMap(nav, k, (s.yr ?? { x: p.x, y: p.y + TILE * 2.5 }).x, (s.yr ?? { x: p.x, y: p.y + TILE * 2.5 }).y)
  u.order = { k: 'move', x: go.x, y: go.y, attack: false, speed: Infinity }
  w.events.push({ k: 'trained', owner: s.owner, unit: id, x: p.x, y: p.y, from: s.id })
  return true
}

/** One tick of every ground building's work: sites the engineers reached start and grow, damaged
 * buildings mend, queues train. */
function works(w: World, dt: number) {
  // How many engineers work on each building this tick (steer set `busy`).
  const crews = new Map<number, number>()
  for (const u of w.units) if (!u.dead && u.gm?.busy) crews.set(u.gm.busy, (crews.get(u.gm.busy) ?? 0) + 1)
  // Units trained this tick are added to the end of the list: they have nothing to do yet.
  const n = w.units.length
  for (let i = 0; i < n; i++) {
    const s = w.units[i]
    if (s.dead || !s.foot) continue
    const t = s.t
    const crew = crews.get(s.id) ?? 0
    const rate = CREW_RATE[Math.min(crew, CREW_RATE.length - 1)]
    if (s.site) {
      if (!crew) continue
      if (!s.site.started) {
        startSite(w, s)
        continue
      }
      const step = Math.min(s.building, dt * rate)
      s.building -= step
      s.hull = Math.min(s.hullMax, s.hull + (s.hullMax * 0.9 * step) / t.build)
      if (s.building <= 1e-9) {
        s.building = 0
        delete s.site
        s.yq = []
        w.events.push({ k: 'built', owner: s.owner, unit: t.id, x: s.x, y: s.y })
      }
      continue
    }
    if (crew && s.hull < s.hullMax) s.hull = Math.min(s.hullMax, s.hull + (s.hullMax / t.build) * REPAIR_RATE * rate * dt)
    const q = s.yq?.[0]
    if (q) {
      q.left = Math.max(0, q.left - dt)
      // Done: out of the door (it waits, done, while the door is walled in).
      if (q.left <= 0 && rollOut(w, s, q.unit)) {
        s.yq!.shift()
        w.players[s.owner].stats.built++
      }
    }
  }
  // A player's station is one of its finished buildings (the queue, income and AI go by it); a
  // player with no building left, finished or going up, is out.
  w.players.forEach((p, o) => {
    if (!p.alive) return
    const st = w.byId.get(p.station)
    if (st && !st.dead && !st.site) return
    const mine = w.units.filter((u) => !u.dead && u.owner === o && !!u.foot)
    p.station = mine.find((u) => !u.site)?.id ?? 0
    if (mine.length) return
    p.alive = false
    w.events.push({ k: 'out', owner: o })
    const standing = new Set(w.players.filter((q) => q.alive).map((q) => q.team))
    if (standing.size === 1 && w.winner === -1) w.winner = [...standing][0]
  })
}

/**
 * The ground battle's part of a tick, before the space sim's unit loop (which leaves ground units
 * alone): the nav grid takes the stamps placed since the last tick (the one point in the tick where
 * it changes), each ground vehicle follows its orders (or is pushed off ground it can't stand on),
 * overlapping vehicles push apart, and the buildings work.
 */
export function groundTick(w: World, dt: number) {
  flushStamps(gs(w).nav)
  for (const u of w.units) {
    if (u.dead || !u.t.ground || u.t.tier !== 'vehicle') continue
    moveOf(u).busy = 0
    if (!unstick(w, u)) steer(w, u)
  }
  separate(w)
  works(w, dt)
}

/** At the end of a tick, before the dead leave `w.units`: their fog discs come off, and a building's
 * stamp comes off the nav grid at the next flush. */
export function groundBury(w: World) {
  const g = gs(w)
  for (const u of w.units) {
    if (!u.dead) continue
    dropEye(g.fog, u)
    if (u.foot?.on) {
      const [fw, fh] = spec(u.t).foot!
      stampFootprint(g.nav, u.foot.c, u.foot.r, fw, fh, -1)
      u.foot.on = false
    }
  }
}

// --- Fog -------------------------------------------------------------------------------------------

/** Whether `tm` sees any tile of building `u`'s footprint. */
function seesFoot(w: World, tm: number, c0: number, r0: number, fw: number, fh: number) {
  const { cols, rows } = gs(w).nav
  for (let r = Math.max(0, r0); r < Math.min(rows, r0 + fh); r++) for (let c = Math.max(0, c0); c < Math.min(cols, c0 + fw); c++) if (sees(gs(w).fog, tm, r * cols + c)) return true
  return false
}

/**
 * The ground battle's sight, four times a second in place of space's (sim.ts sight): each unit's fog
 * disc where it stands now (a site nobody has started sees nothing), which units each team sees
 * (`seen`: its own always, a site nobody has started only by its owner's team, the rest by the fog,
 * a building by any tile of its footprint), and each team's memory of enemy buildings: one it sees
 * now is remembered as it stands, one remembered whose ground it sees again with nothing there is
 * forgotten.
 */
export function groundSight(w: World) {
  const g = gs(w)
  for (const u of w.units) {
    if (u.dead || !u.t.ground || (u.site && !u.site.started)) continue
    placeEye(g.fog, u, team(w, u.owner), tileAt(g.nav, u.x, u.y), spec(u.t).sight)
  }
  for (const u of w.units) {
    if (u.dead) continue
    const own = team(w, u.owner)
    for (let t = 0; t < w.teams; t++) {
      if (t === own) u.seen[t] = true
      else if (u.site && !u.site.started) u.seen[t] = false
      else if (u.foot) u.seen[t] = seesFoot(w, t, u.foot.c, u.foot.r, spec(u.t).foot![0], spec(u.t).foot![1])
      else u.seen[t] = seesAt(g.fog, t, u.x, u.y)
    }
  }
  const known = (w.known ??= Array.from({ length: w.teams }, () => []))
  for (let t = 0; t < w.teams; t++) {
    const mem = known[t]
    for (const u of w.units) {
      if (u.dead || !u.foot?.on || team(w, u.owner) === t || !u.seen[t]) continue
      const k = mem.find((m) => m.id === u.id)
      if (!k) mem.push({ id: u.id, unit: u.t.id, owner: u.owner, tc: u.foot.c, tr: u.foot.r })
    }
    known[t] = mem.filter((k) => {
      const u = w.byId.get(k.id)
      if (u && !u.dead) return true
      const [fw, fh] = spec(UNIT[k.unit]).foot!
      return !seesFoot(w, t, k.tc, k.tr, fw, fh)
    })
  }
}

/** The enemy buildings `viewer`'s team remembers, as last seen (the screen draws the ones it doesn't
 * see now as ghosts). */
export const knownBuildings = (w: World, viewer: Owner): KnownBuilding[] => w.known?.[team(w, viewer)] ?? []

// --- Income ------------------------------------------------------------------------------------------

/** A player's income in a ground battle (sim.ts refreshPlayers): each finished building's. */
export function groundIncome(w: World, p: Player, o: Owner) {
  let income = 0
  for (const u of w.units) if (!u.dead && u.owner === o && u.foot && !u.site) income += spec(u.t).income ?? 0
  p.incomeParts = { station: income * p.incomeMul, mines: 0, beacons: 0 }
  p.income = p.incomeParts.station
  p.popCap = BASE_POP
}

// --- Placement ------------------------------------------------------------------------------------

/** One tile of a placement ghost: whether a building may cover it. */
export type TileCheck = { tc: number; tr: number; ok: boolean }
/** Where a building would go: its footprint's top-left tile and middle, what it costs, every tile
 * checked, the row in front of its door (which must stay free), and the first rule that fails (null
 * when it may go there). The ghost under the cursor shows this. */
export type GroundPlacement = { why: string | null; tc: number; tr: number; x: number; y: number; cost: number; tiles: TileCheck[]; door: TileCheck[] }

/** How far (in tiles, middle to middle) a standalone building (a Command Center) keeps from every
 * enemy building we know of. */
export const STANDALONE_GAP = 20
/** Command range of a building whose type names none, in tiles. */
const DEFAULT_RANGE = 6

/** A footprint a team knows of: its tiles, and whether it is an enemy's. */
type Known = { c: number; r: number; fw: number; fh: number; enemy: boolean }

/** The buildings `owner`'s team knows stand: all of its own team's (sites nobody has started
 * included, but another seat's are a secret even from its teammates), the enemy's it sees now, and
 * the ones it remembers. */
function knownFeet(w: World, owner: Owner): Known[] {
  const tm = team(w, owner)
  const out: Known[] = []
  const seen = new Set<number>()
  for (const u of w.units) {
    if (u.dead || !u.foot) continue
    const mine = team(w, u.owner) === tm
    if (u.site && !u.site.started && u.owner !== owner) continue
    if (!mine && !(u.foot.on && u.seen[tm])) continue
    seen.add(u.id)
    const [fw, fh] = spec(u.t).foot!
    out.push({ c: u.foot.c, r: u.foot.r, fw, fh, enemy: !mine })
  }
  for (const k of w.known?.[tm] ?? []) {
    if (seen.has(k.id)) continue
    const [fw, fh] = spec(UNIT[k.unit]).foot!
    out.push({ c: k.tc, r: k.tr, fw, fh, enemy: true })
  }
  return out
}

const covers = (f: Known, c: number, r: number) => c >= f.c && c < f.c + f.fw && r >= f.r && r < f.r + f.fh
const doorOf = (f: Known, c: number, r: number) => r === f.r + f.fh && c >= f.c && c < f.c + f.fw

/** Why one tile can't be under a building, in the order the reasons are reported. */
const TILE_RULES = ['Not on buildable ground', 'A deposit is in the way', 'The ground must be level', 'Something is built there', "It would block a building's door"] as const

/** The command range circles of `owner`'s buildings (sites nobody has started don't count), in world
 * units: where its other buildings may go. */
export function commandAreas(w: World, owner: Owner): { x: number; y: number; r: number }[] {
  const out: { x: number; y: number; r: number }[] = []
  for (const u of w.units) if (!u.dead && u.owner === owner && u.foot?.on) out.push({ x: u.x, y: u.y, r: (spec(u.t).range ?? DEFAULT_RANGE) * TILE })
  return out
}

/**
 * Where building `unitId` would go with its footprint centred as near (x, y) as the grid allows. The
 * rules, in order: every tile buildable, on one level and free of deposits, buildings and other
 * buildings' doors; inside the command range of one of our buildings, or for a standalone one
 * anywhere at least STANDALONE_GAP tiles from a known enemy building; no enemy unit we see on it;
 * its door row free; enough credits. What a team doesn't see doesn't stop it (the land itself is
 * known everywhere): a site on ground where a hidden enemy building stands is given up, refunded,
 * when its engineer gets there.
 */
export function groundPlacement(w: World, owner: Owner, unitId: string, x: number, y: number): GroundPlacement {
  const t = UNIT[unitId]
  const p = w.players[owner]
  const g = gs(w).map.grid
  if (!t?.ground?.foot || t.faction !== p.faction) return { why: "That can't be built here", tc: 0, tr: 0, x, y, cost: 0, tiles: [], door: [] }
  const { cols, rows } = g
  const [fw, fh] = t.ground.foot
  const tc = clamp(Math.round(x / TILE - fw / 2), 0, cols - fw)
  const tr = clamp(Math.round(y / TILE - fh / 2), 0, rows - fh)
  const cx = (tc + fw / 2) * TILE
  const cy = (tr + fh / 2) * TILE
  const cost = t.cost
  const tm = p.team
  const feet = knownFeet(w, owner).filter((f) => f.c < tc + fw + 1 && tc < f.c + f.fw + 1 && f.r < tr + fh + 1 && tr < f.r + f.fh + 1)
  const level = g.height[(tr + (fh >> 1)) * cols + tc + (fw >> 1)]
  let worst: number = TILE_RULES.length
  const tiles: TileCheck[] = []
  for (let r = tr; r < tr + fh; r++)
    for (let c = tc; c < tc + fw; c++) {
      const i = r * cols + c
      const f = g.flags[i]
      const rule = f & (TF.blocked | TF.water | TF.noBuild | TF.ramp)
        ? 0
        : f & TF.deposit
          ? 1
          : g.height[i] !== level
            ? 2
            : feet.some((k) => covers(k, c, r))
              ? 3
              : feet.some((k) => doorOf(k, c, r))
                ? 4
                : -1
      tiles.push({ tc: c, tr: r, ok: rule < 0 })
      if (rule >= 0) worst = Math.min(worst, rule)
    }
  // The row in front of the door: open ground, joined to the footprint's edge, nothing built on it.
  const door: TileCheck[] = []
  const dr = tr + fh
  for (let c = tc; c < tc + fw; c++) {
    const i = dr * cols + c
    const ok = dr < rows && (g.flags[i] & TF.blocked) === 0 && canStep(g, i - cols, i) && !feet.some((k) => covers(k, c, dr))
    door.push({ tc: c, tr: dr, ok })
  }
  const out = (why: string | null): GroundPlacement => ({ why, tc, tr, x: cx, y: cy, cost, tiles, door })
  if (worst < TILE_RULES.length && worst !== 4) return out(TILE_RULES[worst])
  // Command range: near one of our buildings, or (standalone) away from the enemy's.
  const inRange = commandAreas(w, owner).some((a) => (a.x - cx) * (a.x - cx) + (a.y - cy) * (a.y - cy) <= a.r * a.r)
  if (t.ground.standalone) {
    const gap = STANDALONE_GAP * TILE
    const near = knownFeet(w, owner).some((f) => {
      const dx = cx - (f.c + f.fw / 2) * TILE
      const dy = cy - (f.r + f.fh / 2) * TILE
      return f.enemy && dx * dx + dy * dy < gap * gap
    })
    if (near) return out(`Too close to an enemy building (keep ${STANDALONE_GAP} tiles away)`)
  } else if (!inRange) return out('Outside the command range of your buildings')
  // Enemy units we can see on it.
  const x0 = tc * TILE
  const y0 = tr * TILE
  for (const u of w.units) {
    if (u.dead || !u.t.ground || u.t.tier !== 'vehicle' || team(w, u.owner) === tm || !u.seen[tm]) continue
    const dx = Math.max(x0 - u.x, 0, u.x - (x0 + fw * TILE))
    const dy = Math.max(y0 - u.y, 0, u.y - (y0 + fh * TILE))
    if (dx * dx + dy * dy < spec(u.t).radius * spec(u.t).radius) return out('Enemy units are in the way')
  }
  if (!door.every((d) => d.ok)) return out('No room in front of its door')
  if (worst === 4) return out(TILE_RULES[4])
  if (p.credits < cost) return out('Not enough credits')
  return out(null)
}

/** Engineers `crew` put up building `unitId` centred near (x, y): paid now, its site marked out (seen
 * by its owner only until work starts), the engineers sent to build it (`queued`: after their other
 * orders). Why not, or null. */
export function groundPlace(w: World, owner: Owner, crew: Unit[], unitId: string, x: number, y: number, queued: boolean): string | null {
  const builders = crew.filter((u) => u.t.ground?.builds?.includes(unitId))
  if (!builders.length) return crew.length ? "These engineers can't build that" : 'Select engineers to build it'
  const pl = groundPlacement(w, owner, unitId, x, y)
  if (pl.why) return pl.why
  const t = UNIT[unitId]
  spend(w, w.players[owner], pl.cost, 'structures', t.name)
  const site = spawn(w, unitId, owner, pl.x, pl.y, FACING)
  site.building = t.build
  site.hull = site.hullMax * 0.1
  site.site = { paid: pl.cost, started: false }
  site.foot = { c: pl.tc, r: pl.tr, on: false }
  for (const u of builders) issue(u, { k: 'construct', id: site.id }, queued)
  return null
}

// --- Training ----------------------------------------------------------------------------------------

/** Most units one building's queue holds. */
export const QUEUE_MAX = 10

/** The building that trains `id` for `owner`: `at` when it is one of ours that does, else the one of
 * ours with the shortest queue (the first on a tie). Why not, when there is none. */
function trainerFor(w: World, owner: Owner, id: string, at: number): Unit | string {
  const ok = (u: Unit | undefined): u is Unit => !!u && !u.dead && u.owner === owner && !!u.foot && !u.site && !!u.yq && !!u.t.ground?.trains?.includes(id)
  if (at) {
    const u = w.byId.get(at)
    return ok(u) ? u : "That building can't train it"
  }
  let best: Unit | undefined
  for (const u of w.units) if (ok(u) && (!best || u.yq!.length < best.yq!.length)) best = u
  return best ?? 'No building of ours trains that'
}

/** The queue a ground unit is trained in (sim.ts queueFor), or why there is none. */
export function groundQueue(w: World, owner: Owner, id: string, at: number): { q: QueueItem[]; yard?: Unit } | string {
  const b = trainerFor(w, owner, id, at)
  return typeof b === 'string' ? b : { q: b.yq!, yard: b }
}

/** Why `owner` can't train `id` (at building `at`, or the best one of ours) now, or null (sim.ts cantBuild). */
export function groundCantBuild(w: World, owner: Owner, id: string, at: number): string | null {
  const t = UNIT[id]
  const p = w.players[owner]
  if (!t || !isGround(t) || t.tier !== 'vehicle') return "That doesn't fight on the ground"
  const b = trainerFor(w, owner, id, at)
  if (typeof b === 'string') return b
  if (b.yq!.length >= QUEUE_MAX) return 'Queue full'
  let pop = p.pop
  for (const u of w.units) if (!u.dead && u.owner === owner) for (const q of u.yq ?? []) pop += UNIT[q.unit].pop
  if (pop + t.pop > p.popCap) return 'At the unit limit'
  if (p.credits < t.cost) return 'Not enough credits'
  return null
}

// --- Hash and snapshots -------------------------------------------------------------------------------

/** The ground battle's own state in a world's hash (sim.ts stateHash), only for worlds with terrain. */
export function groundHash(w: World, int: (v: number) => void, num: (v: number) => void) {
  const g = gs(w)
  int(g.nav.ver)
  int(g.nav.pending.length)
  for (const u of w.units) {
    if (u.dead) continue
    if (u.foot) {
      int(u.foot.c)
      int(u.foot.r)
      int(u.foot.on ? 1 : 0)
      int(u.site?.started ? 1 : 0)
      num(u.building)
      int(u.yq?.length ?? -1)
      for (const q of u.yq ?? []) num(q.left)
    }
    if (u.gm) {
      int(u.gm.pv)
      num(u.gm.stuck)
      int(u.gm.tries)
      int(u.gm.busy)
      int(u.route?.pts.length ?? -1)
    }
  }
  for (const mem of w.known ?? []) {
    int(mem.length)
    for (const k of mem) int(k.id)
  }
  for (const eyes of g.fog.eyes) {
    let n = 0
    for (const e of eyes) n += e
    int(n)
  }
}

/** What a snapshot keeps of the terrain layer: the nav grid's version and its stamps not yet applied
 * (the rest is rebuilt from the map and the units). */
export type GroundSnap = { ver: number; pending: { c: number; r: number; w: number; h: number; d: 1 | -1 }[] }
export const snapGround = (w: World): GroundSnap => ({ ver: gs(w).nav.ver, pending: gs(w).nav.pending.map((s) => ({ ...s })) })

/**
 * The terrain layer of a restored world, exactly as it was: the grid gets every stamp that had been
 * applied (each standing building's, less those still waiting, plus the removals still waiting, whose
 * buildings are gone from the units), the waiting ones go back in line, and every unit's fog disc goes
 * back where it was.
 */
export function restoreGround(w: World, s: GroundSnap | undefined) {
  const g = newGround(w)
  w.ground = g
  for (const u of w.units) {
    if (!u.foot?.on) continue
    const [fw, fh] = spec(u.t).foot!
    stampFootprint(g.nav, u.foot.c, u.foot.r, fw, fh, 1)
  }
  for (const p of s?.pending ?? []) stampFootprint(g.nav, p.c, p.r, p.w, p.h, p.d === 1 ? -1 : 1)
  flushStamps(g.nav)
  g.nav.ver = s?.ver ?? 0
  for (const p of s?.pending ?? []) stampFootprint(g.nav, p.c, p.r, p.w, p.h, p.d)
  for (const u of w.units) {
    const e: Eye | undefined = u.eye
    if (!e || u.dead) continue
    u.eye = undefined
    placeEye(g.fog, u, e.team, e.tile, e.r)
  }
}

// --- Loading --------------------------------------------------------------------------------------

// Ground battles in the sim from here on: whatever imports this file (the dev lobby, the checks)
// loads them.
setGroundHooks({
  layer: newGround,
  start: groundStart,
  tick: groundTick,
  sight: groundSight,
  bury: groundBury,
  income: groundIncome,
  formation: groundFormation,
  place: groundPlace,
  queue: groundQueue,
  cantBuild: groundCantBuild,
  hash: groundHash,
  snap: snapGround,
  restore: restoreGround,
  mapDef: groundMapDef,
  think: (w, b) => groundThink(w, b),
})
