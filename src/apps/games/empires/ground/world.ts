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
//   off the footprint first) and build, repairs, training out of the door, and the unit cap from
//   each building's supply.
// - Kyber, the ground battle's one resource (it is the side's credits): crystal fields that hold a
//   fixed amount in separate crystal clusters that run out and are gone (World `crystals`: each
//   blocks its tile like a tree, its stamp freed when it empties), engineers that mine a load from
//   one cluster, haul it to the nearest
//   Command Center and go back (the `gather` order).
// - Fog by tile with the height rule instead of space's sight circles, and each team's memory of
//   enemy buildings as last seen (World `known`).
//
// sim.ts reaches all of it through GroundHooks, which this file fills in when it is imported: a build
// that never imports it (the production one, while ground battles are dev-only) never carries it.
//
// The orders are the space game's own (commands.ts): move, stop, place, construct, cancel a site,
// build (train) at a building, cancel, rally, and gather (ground only). Lockstep rules as in sim.ts: no Math.random, no Date,
// detmath for trig, units in `w.units` order, the nav grid changed only at the start of a tick.
// No DOM: the server runs it too.

import * as M from '../detmath.ts'
import { UNIT, isEngineer, isGround, isGroundBuilding, type UnitType } from '../data.ts'
import type { MapDef } from '../maps.ts'
import { STEP, earn, giveBack, issue, nextOrder, setGroundHooks, spawn, spend, type Order, type Owner, type Player, type QueueItem, type Unit, type World } from '../sim.ts'
import { dropEye, newFog, placeEye, sees, seesAt, type Eye, type GroundFog } from './fog.ts'
import { GROUND_MAP } from './maps.ts'
import {
  anchorAt, findPath, flushStamps, footprintOpen, movesTo, nearestStand, newNav, onMap, spotOf, stampFootprint, stands, standsAt, tileAt, type GroundNav, type NavClass,
} from './nav.ts'
import { buildGroundMap } from './terrain.ts'
import { groundPower } from './power.ts'
import { cancelJob, jobsTick, startJob } from './jobs.ts'
import { groundThink } from './think.ts'
import { combatHash, engage, giveUp, groundCombat } from './combat.ts'
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
 * crystal fields as its ore (for the lobby's preview and counts only: engineers mine the fields
 * themselves, see World `kyber`), no beacons, rocks, fields, nebulas or wrecks, and `ground` naming the terrain. Null when
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

/** A kyber crystal field: its middle (the ground map's deposit) and its tiles, the outermost first
 * (the order its crystals vanish in as it runs dry). */
export type KyberField = { x: number; y: number; tiles: number[] }

/** The terrain layer of a ground battle (World `ground`): rebuilt from the map, never saved. */
export type GroundState = { map: GroundMap; nav: GroundNav; fog: GroundFog; fields: KyberField[] }

/** A building's footprint: its top-left tile, and whether it stands on the nav grid (a site does only
 * once work has started). */
export type Foot = { c: number; r: number; on: boolean }

/** A ground vehicle's movement state (Unit `gm`): the nav grid version its path was found on (-1:
 * find it again), seconds without getting nearer its next waypoint and the nearest it got, paths
 * found again since the last waypoint, the building it works on this tick (0: none), an engineer's
 * spot next to the building it was sent to (or on the crystal field it mines), whether a gathering
 * engineer is on its way to drop its load off, and whether it mined this tick. */
export type GroundMove = { pv: number; stuck: number; best: number; tries: number; busy: number; spot?: Pt; drop?: boolean; mine?: boolean
  /** Which order the spot and the drop-off are for (its kind and building or field): a new one
   * finds its own. */
  job?: string
  /** A gatherer sent to build: the field it goes back to once the building is done. */
  back?: number
  /** A gatherer: the crystal cluster it mines (an index into World `crystals`). */
  cl?: number
  /** A gatherer hauling a load: the drop-off it picked for this trip (a Command Center or a supply
   * building), picked afresh when that one is lost or no longer takes kyber. */
  home?: number }

/** A kyber crystal cluster (World `crystals`): an object standing on one tile of crystal field `f`
 * (c, r), blocking it like a tree, with the kyber it started with and has left, one of a few shapes,
 * and whether it stands on the nav grid (it comes off once mined out, at the next flush). */
export type Crystal = { f: number; c: number; r: number; left: number; max: number; shape: number; on: boolean }

// --- Kyber -------------------------------------------------------------------------------------------

/** Kyber in each crystal field at the start, shared out over its clusters: enough for a long game (a
 * side's own fields, with half the shared one, hold 37,500 on Ashwater Crossing: half an hour of
 * gathering with fourteen engineers, about 20 kyber a second). */
export const FIELD_KYBER = 15000
/** Clusters a field has: about one for every two of its tiles, between these. */
export const CLUSTERS_MIN = 3
export const CLUSTERS_MAX = 7
/** How many shapes a cluster comes in (models/ground.ts kyber models). */
export const CRYSTAL_SHAPES = 3
/** Kyber an engineer carries in one load, and mines a second. */
export const CARRY = 20
export const MINE_RATE = 2.5
/** How near a cluster's middle an engineer mines from (from any of the eight tiles round it). */
const MINE_REACH = TILE * 1.6

/** A small seeded random stream (mulberry32) for laying out a map's clusters: the same on every
 * machine, and apart from the world's own stream. */
function seeded(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * A map's crystal clusters at the start of a battle, from its fields and its seed: each field gets
 * one cluster for about every two of its tiles (CLUSTERS_MIN to CLUSTERS_MAX), on tiles picked at
 * random (the field's edge first, so they spread) but never side by side (apart, or at most corner
 * to corner in a small field) and always with open ground round each to mine it from, and FIELD_KYBER
 * shared out between them, each a fifth more or less than an even share. The same on every machine.
 */
export function placeCrystals(map: GroundMap, fields: KyberField[]): Crystal[] {
  const g = map.grid
  const out: Crystal[] = []
  fields.forEach((field, f) => {
    const rnd = seeded(Math.imul(map.def.seed ^ 0x6b79, 2654435761) + f * 0x9e3779b9)
    const want = clamp(Math.round(field.tiles.length * 0.55), CLUSTERS_MIN, CLUSTERS_MAX)
    const pool = field.tiles.filter((i) => !(g.flags[i] & TF.blocked))
    // The field's edge tiles first (fewest field tiles round them: clusters spread out and more of
    // them fit), in random order among equals from the field's own stream.
    const inField = new Set(field.tiles)
    const edge = (i: number) => {
      let n = 0
      for (const d of [-1, 1, -g.cols, g.cols]) if (inField.has(i + d)) n++
      return n
    }
    const key = new Map(pool.map((i) => [i, edge(i) + rnd()]))
    pool.sort((a, b) => key.get(a)! - key.get(b)! || a - b)
    const picked: number[] = []
    const near = (i: number, j: number, d: number) => Math.max(Math.abs((j % g.cols) - (i % g.cols)), Math.abs(Math.floor(j / g.cols) - Math.floor(i / g.cols))) <= d
    // Open ground round tile i (walkable, not a cluster): what an engineer mines it from.
    const open = (i: number) => {
      let n = 0
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          const c = (i % g.cols) + dc
          const r = Math.floor(i / g.cols) + dr
          if ((!dc && !dr) || c < 0 || r < 0 || c >= g.cols || r >= g.rows) continue
          const j = r * g.cols + c
          if (!(g.flags[j] & TF.blocked) && !picked.includes(j)) n++
        }
      return n
    }
    // First never side by side (not even corner to corner), then, for a small field, corner to
    // corner too; always with open ground round each one.
    for (const gap of [1, 0])
      for (const i of pool) {
        if (picked.length >= want) break
        if (picked.includes(i) || picked.some((j) => (gap ? near(i, j, 1) : near(i, j, 1) && (j % g.cols === i % g.cols || Math.floor(j / g.cols) === Math.floor(i / g.cols))))) continue
        if (open(i) < 2 + gap) continue
        picked.push(i)
        // A cluster placed must not take the last open tile round one placed before.
        if (picked.some((j) => open(j) < 2)) picked.pop()
      }
    const weights = picked.map(() => 0.8 + rnd() * 0.4)
    const sum = weights.reduce((a, b) => a + b, 0)
    let given = 0
    picked.forEach((i, k) => {
      const amount = k === picked.length - 1 ? FIELD_KYBER - given : Math.round((FIELD_KYBER * weights[k]) / sum)
      given += amount
      const c = i % g.cols
      out.push({ f, c, r: (i - c) / g.cols, left: amount, max: amount, shape: Math.floor(rnd() * CRYSTAL_SHAPES), on: false })
    })
  })
  return out
}

/** Kyber left in field `f`, all its clusters together. */
export function fieldLeft(w: World, f: number) {
  let n = 0
  for (const c of w.crystals ?? []) if (c.f === f) n += c.left
  return n
}

/** A cluster's middle, in world units. */
export const crystalAt = (c: Crystal): Pt => ({ x: (c.c + 0.5) * TILE, y: (c.r + 0.5) * TILE })

/** The crystal fields of a map: each deposit tile goes to the nearest deposit middle (the first on a
 * tie), the outermost tiles first. */
export function fieldsOf(map: GroundMap): KyberField[] {
  const g = map.grid
  const fields: KyberField[] = map.deposits.map((d) => ({ x: d.x, y: d.y, tiles: [] }))
  if (!fields.length) return fields
  const far = (f: KyberField, i: number) => {
    const c = i % g.cols
    const dx = (c + 0.5) * TILE - f.x
    const dy = ((i - c) / g.cols + 0.5) * TILE - f.y
    return dx * dx + dy * dy
  }
  for (let i = 0; i < g.cols * g.rows; i++) {
    if (!(g.flags[i] & TF.deposit)) continue
    let best = 0
    for (let k = 1; k < fields.length; k++) if (far(fields[k], i) < far(fields[best], i)) best = k
    fields[best].tiles.push(i)
  }
  for (const f of fields) f.tiles.sort((a, b) => far(f, b) - far(f, a) || a - b)
  return fields
}

/** The crystal field of the cluster with kyber left under or nearest (x, y), within two tiles of it,
 * or -1. */
export function fieldAt(w: World, x: number, y: number): number {
  const reach = TILE * 2
  let best = -1
  let bestD = reach * reach
  for (const c of w.crystals ?? []) {
    if (!(c.left > 0)) continue
    const p = crystalAt(c)
    const d = (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y)
    if (d < bestD) {
      bestD = d
      best = c.f
    }
  }
  return best
}

/** Puts each standing cluster's stamp on the nav grid (from the next flush). */
function stampCrystals(w: World) {
  for (const c of w.crystals ?? []) {
    if (!(c.left > 0)) continue
    stampFootprint(gs(w).nav, c.c, c.r, 1, 1, 1)
    c.on = true
  }
}

/** The terrain layer for world `w`, whose map names its ground map. */
export function newGround(w: World): GroundState {
  const map = groundMapOf(w.map.ground!)
  if (!map) throw new Error(`No ground map ${w.map.ground}`)
  return { map, nav: newNav(map), fog: newFog(map.grid, w.teams), fields: fieldsOf(map) }
}

/** The ground unit types of `faction`: its engineer, its Command Center, its supply building, its
 * power generator, its research station and its foot and vehicle factories ('' for one it lacks). */
export function groundIds(faction: string): { engineer: string; center: string; supply: string; generator: string; research: string; barracks: string; vfactory: string } {
  const own = Object.values(UNIT).filter((t) => t.faction === faction && t.ground)
  return {
    engineer: own.find((t) => isEngineer(t))!.id,
    center: own.find((t) => isGroundBuilding(t) && t.ground!.dropOff && !!t.ground!.trains?.length)!.id,
    supply: own.find((t) => isGroundBuilding(t) && !t.ground!.trains?.length && t.ground!.supply)!.id,
    generator: own.find((t) => isGroundBuilding(t) && !!t.ground!.burn)?.id ?? '',
    research: own.find((t) => isGroundBuilding(t) && !!t.ground!.research)?.id ?? '',
    barracks: own.find((t) => isGroundBuilding(t) && t.ground!.factory === 'foot')?.id ?? '',
    vfactory: own.find((t) => isGroundBuilding(t) && t.ground!.factory === 'vehicle')?.id ?? '',
  }
}

/** The tier building `s` stands at (GroundSpec `tier`: 1 until upgrades raise it). */
export const tierOf = (s: Unit) => s.t.ground?.tier ?? 1

/** The tier a building must stand at to train ground unit `t` (GroundSpec `tier`, 1 when left out). */
export const tierNeeded = (t: UnitType | undefined) => t?.ground?.tier ?? 1

/** What building `s` trains that the game knows, in card order: a `trains` id with no unit type yet is
 * left out. */
export const trainsOf = (s: { t: UnitType } | UnitType): UnitType[] => {
  const t = 't' in s ? s.t : s
  return (t.ground?.trains ?? []).map((id) => UNIT[id]).filter((x): x is UnitType => !!x)
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
  w.crystals = placeCrystals(g.map, g.fields)
  stampCrystals(w)
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

/** What engineer `u` works on for its order: an assisting engineer's job is the one it helps with
 * (Order `assist`), its own order otherwise. */
export const jobOrder = (u: Unit): Order => (u.order.k === 'assist' ? (u.order.job ?? u.order) : u.order)

/** How near (tiles) an assisting engineer with nothing to help with keeps to the one it assists. */
const FOLLOW = 3

type AssistJob = NonNullable<Extract<Order, { k: 'assist' }>['job']>
/**
 * What an assisting engineer (Order `assist`) should help with now: the site or building the
 * engineer it assists works on, or the field it gathers; through a chain of assists to the first
 * engineer with a job. Null: nothing to help with (it follows); 'gone': the engineer it assisted is
 * lost or no longer ours (the order is done).
 */
function assistJob(w: World, u: Unit, o: Extract<Order, { k: 'assist' }>): AssistJob | null | 'gone' {
  let lead = w.byId.get(o.id)
  if (!lead || lead.dead || lead.owner !== u.owner) return 'gone'
  for (let hops = 0; hops < 4 && lead.order.k === 'assist'; hops++) {
    if (lead.order.job) return lead.order.job
    const next = w.byId.get(lead.order.id)
    if (!next || next.dead || next === u) return null
    lead = next
  }
  const lo = lead.order
  if (lo.k === 'construct') {
    const s = w.byId.get(lo.id)
    return s && needsWork(s) && s.owner === u.owner ? { k: 'construct', id: lo.id } : null
  }
  if (lo.k === 'gather') return { k: 'gather', f: lo.f }
  return null
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
  for (const o of w.units) {
    const j = o === u || o.dead || !o.gm?.spot ? null : jobOrder(o)
    if (j && ((j.k === 'construct' && j.id === s.id) || (j.k === 'gather' && o.gm!.drop))) taken.add(anchorAt(nav, size(o), o.gm!.spot!.x, o.gm!.spot!.y))
  }
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
  g.drop = false
  g.home = undefined
  const built = u.order.k === 'construct'
  nextOrder(u, u.x, u.y, u.order.k === 'move' ? (u.order.face ?? null) : null)
  // A gatherer taken off its field to build goes back to gathering once it has nothing else to do,
  // as a villager does.
  if (built && g.back !== undefined && u.order.k === 'idle' && !u.queue.length) u.order = { k: 'gather', f: g.back }
}

/** Where the current order sends `u`: a point, a building to work on (`job`), a Command Center to
 * drop kyber off at (`drop`), a spot on a crystal field to mine (`mine`, the field), or the engineer
 * it assists (`follow`). Null: it has nowhere to go. */
type Goal = { x: number; y: number; job?: Unit; drop?: Unit; mine?: number; /** After a target, or back to its spot (combat.ts engage). */ fight?: boolean; follow?: boolean }
function goal(w: World, u: Unit): Goal | null {
  let o = u.order
  // Assisting: the job of the engineer it assists becomes its own (kept on the order, so a field it
  // moves on to sticks), or with none it follows that engineer.
  let follow: Unit | undefined
  if (o.k === 'assist' && isEngineer(u.t)) {
    const a = o
    const j = assistJob(w, u, a)
    if (j === 'gone') return null
    const same = !!a.job && !!j && a.job.k === j.k && (j.k === 'construct' ? a.job.k === 'construct' && a.job.id === j.id : a.job.k === 'gather' && a.job.f === j.f)
    // (Gathering, it keeps to its own field once the other's has run dry and each moves on.)
    const keep = a.job?.k === 'gather' && j?.k === 'gather' && !(fieldLeft(w, j.f) > 0)
    if (!j) delete a.job
    else if (!same && !keep) a.job = { ...j }
    if (a.job) o = a.job
    else follow = w.byId.get(a.id)
  }
  // A new order (another building, another field) starts afresh: no spot or load run left over.
  const job = o.k === 'gather' ? `g${o.f}` : o.k === 'construct' ? `c${o.id}` : follow ? `a${follow.id}` : o.k
  const g = moveOf(u)
  if (g.job !== job) {
    // Off gathering to build: remember the field (kept through more building, dropped otherwise).
    if (job.startsWith('c')) g.back = g.job?.startsWith('g') ? Number(g.job.slice(1)) : g.back
    else if (!job.startsWith('g') && job !== 'idle') g.back = undefined
    g.job = job
    g.spot = undefined
    g.drop = false
    g.home = undefined
    g.tries = 0
  }
  if (follow) return { x: follow.x, y: follow.y, follow: true }
  if (o.k === 'move' || o.k === 'patrol') return { x: o.x, y: o.y }
  if (o.k === 'gather' && isEngineer(u.t)) return gatherGoal(w, u, o)
  if (o.k === 'construct' && isEngineer(u.t)) {
    const s = w.byId.get(o.id)
    if (!s || !needsWork(s) || s.owner !== u.owner) return null
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
  // The fight comes first (combat.ts): an attack order whose target is gone is done; in reach, the
  // unit stands and fires (turning to bring fixed guns to bear); else it drives after the target.
  const fight = engage(w, u)
  if (fight === 'done') return done(u)
  if ((fight && fight.hold) || (!fight && (u.order.k === 'idle' || u.order.k === 'guard'))) {
    u.v = Math.max(0, u.v - spec(t).accel * STEP)
    if (u.v > 0) drive(w, u, u.x + M.cos(u.a) * u.v * STEP, u.y + M.sin(u.a) * u.v * STEP)
    if (fight?.face !== undefined) u.a = wrap(u.a + clamp(wrap(fight.face - u.a), -t.turn * STEP, t.turn * STEP))
    return
  }
  const to: Goal | null = fight ? { x: fight.x, y: fight.y, fight: true } : goal(w, u)
  if (!to) return done(u)
  // Assisting with nothing to help with: near the engineer it assists, it waits.
  if (to.follow && M.hypot(to.x - u.x, to.y - u.y) <= FOLLOW * TILE) {
    u.route = null
    u.v = Math.max(0, u.v - spec(t).accel * STEP)
    if (u.v > 0) drive(w, u, u.x + M.cos(u.a) * u.v * STEP, u.y + M.sin(u.a) * u.v * STEP)
    return
  }
  if (to.job && footDist(to.job, u.x, u.y) <= REACH) return work(u, to.job)
  if (to.drop && footDist(to.drop, u.x, u.y) <= REACH) return dropOff(w, u)
  if (to.mine !== undefined && M.hypot(to.x - u.x, to.y - u.y) <= MINE_REACH) return mine(w, u, to.mine)
  // (After a moving target, the way is found again only once it has moved a tile off it.)
  const stale = !u.route || (to.fight || to.follow ? (u.route.x - to.x) * (u.route.x - to.x) + (u.route.y - to.y) * (u.route.y - to.y) > TILE * TILE : u.route.x !== to.x || u.route.y !== to.y)
  if (g.pv !== nav.ver || stale) {
    const p = findPath(nav, size(u), u.x, u.y, to.x, to.y)
    u.route = { x: to.x, y: to.y, pts: p.pts, short: p.short }
    g.pv = nav.ver
    g.stuck = 0
    g.best = Infinity
    if (!p.pts.length) return to.fight ? giveUp(u) : done(u)
  }
  const pts = u.route!.pts
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
    return arrive(w, u, to)
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
      return arrive(w, u, to)
    }
    if (++g.tries > TRIES) {
      u.v = 0
      return to.fight ? giveUp(u) : done(u)
    }
    g.pv = -1
    g.stuck = 0
    g.best = Infinity
  }
  // Research at its factory (sim.ts techBonus) speeds it up.
  let aim = t.speed * u.mods.speed * Math.max(0, 1 - left * 1.25)
  if (last) aim = Math.min(aim, Math.sqrt(2 * accel * Math.max(0, d - ARRIVE * 0.5)) + 4)
  if (u.order.k === 'move' && u.order.speed < aim) aim = u.order.speed
  u.v = u.v < aim ? Math.min(aim, u.v + accel * STEP) : Math.max(aim, u.v - accel * STEP)
  let move = u.v * STEP
  if (last && move > d) move = d
  if (move > 0) drive(w, u, u.x + M.cos(u.a) * move, u.y + M.sin(u.a) * move)
}

/** At the end of its path: a move is done (a patrol turns round); an engineer next to its building
 * gets to work, or gives up when it couldn't get there; a gathering engineer drops its load off or
 * mines, or (crowded out of its spot) picks another spot, giving up after a few tries. */
function arrive(w: World, u: Unit, to: Goal) {
  const o = u.order
  const { job } = to
  // A chase or a way back ends where it is: the fight decides again next tick (and so does following
  // the engineer it assists).
  if (to.fight || to.follow) {
    u.route = null
    return
  }
  if (job) {
    if (footDist(job, u.x, u.y) <= REACH) return work(u, job)
    return done(u)
  }
  if (to.drop || to.mine !== undefined) {
    if (to.drop && footDist(to.drop, u.x, u.y) <= REACH) return dropOff(w, u)
    if (to.mine !== undefined && M.hypot(to.x - u.x, to.y - u.y) <= MINE_REACH) return mine(w, u, to.mine)
    const g = moveOf(u)
    if (++g.tries > TRIES) return done(u)
    g.spot = undefined
    g.pv = -1
    u.route = null
    return
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

// --- Gathering ---------------------------------------------------------------------------------------

/** The anchor tiles round cluster `c` (the eight next to it) that `u` can stand on and reach. */
function crystalSpots(w: World, u: Unit, c: Crystal): number[] {
  const nav = gs(w).nav
  const k = size(u)
  const start = nearestStand(nav, k, anchorAt(nav, k, u.x, u.y))
  const piece = start >= 0 ? nav.piece[k - 1][start] : -1
  const out: number[] = []
  for (let r = c.r - k; r <= c.r + 1; r++)
    for (let cc = c.c - k; cc <= c.c + 1; cc++) {
      // Anchor squares over the cluster's own tile are on it.
      if (r > c.r - k && r <= c.r && cc > c.c - k && cc <= c.c) continue
      if (cc < 0 || r < 0 || cc >= nav.cols || r >= nav.rows) continue
      const i = r * nav.cols + cc
      if (stands(nav, k, i) && (piece < 0 || nav.piece[k - 1][i] === piece)) out.push(i)
    }
  return out
}

/** The cluster with kyber left in field `f` that `u` should mine: the nearest it can reach, one with
 * fewer engineers on it counting as nearer (so a crew spreads over the field). -1 when none. */
function pickCrystal(w: World, u: Unit, f: number): number {
  const all = w.crystals ?? []
  const miners = new Map<number, number>()
  for (const o of w.units) if (o !== u && !o.dead && jobOrder(o).k === 'gather' && o.gm?.cl !== undefined && !o.gm.drop) miners.set(o.gm.cl, (miners.get(o.gm.cl) ?? 0) + 1)
  let best = -1
  let bestD = Infinity
  all.forEach((c, i) => {
    if (c.f !== f || !(c.left > 0)) return
    const p = crystalAt(c)
    const d = (p.x - u.x) * (p.x - u.x) + (p.y - u.y) * (p.y - u.y) + (miners.get(i) ?? 0) * TAKEN
    if (d < bestD && crystalSpots(w, u, c).length) {
      bestD = d
      best = i
    }
  })
  return best
}

/** The nearest crystal field to `u` with a cluster it can mine (the first on a tie), or -1. Every
 * side knows where the fields are (the land is known from orbit). */
function nearestField(w: World, u: Unit): number {
  let best = -1
  let bestD = Infinity
  gs(w).fields.forEach((f, i) => {
    const d = (f.x - u.x) * (f.x - u.x) + (f.y - u.y) * (f.y - u.y)
    if (d < bestD && pickCrystal(w, u, i) >= 0) {
      bestD = d
      best = i
    }
  })
  return best
}

/** Whether building `s` takes in kyber for `owner` now: one of theirs that is finished and a drop-off
 * (GroundSpec `dropOff`: a Command Center, a supply building). */
const takesKyber = (s: Unit, owner: Owner) => !s.dead && s.owner === owner && !!s.foot && !s.site && !!spec(s.t).dropOff

/**
 * Where engineer `u` takes its load: the finished drop-off of its owner nearest it by the way it
 * has to drive (a Command Center or a supply building, as Age of Empires' storehouses), and the spot
 * next to it it drives to. Ties go to the lower id, so every copy picks the same. The drop-offs
 * are tried nearest in a straight line first, stopping once the next is further off in a straight
 * line than the best way found (no way is shorter than that). One it can't drive up to counts only
 * when none can be reached (then the nearest in a straight line). Null when there is none.
 */
function dropFor(w: World, u: Unit): { s: Unit; spot: Pt } | null {
  const nav = gs(w).nav
  const homes = w.units.filter((s) => takesKyber(s, u.owner)).map((s) => ({ s, d: footDist(s, u.x, u.y) }))
  homes.sort((a, b) => a.d - b.d || a.s.id - b.s.id)
  let best: { s: Unit; spot: Pt; len: number } | null = null
  for (const { s, d } of homes) {
    if (best && d > best.len) break
    const spot = workSpot(w, u, s)
    const p = findPath(nav, size(u), u.x, u.y, spot.x, spot.y)
    if (p.short || !p.pts.length) continue
    let len = 0
    let at: Pt = u
    for (const q of p.pts) {
      len += M.hypot(q.x - at.x, q.y - at.y)
      at = q
    }
    if (!best || len < best.len || (len === best.len && s.id < best.s.id)) best = { s, spot, len }
  }
  if (best) return { s: best.s, spot: best.spot }
  return homes.length ? { s: homes[0].s, spot: workSpot(w, u, homes[0].s) } : null
}

/** Where engineer `u` mines cluster `cl`: the open tile next to it nearest `u`, one no other engineer
 * mining has taken if there is one. Null when there is none. */
function mineSpot(w: World, u: Unit, cl: number): Pt | null {
  const nav = gs(w).nav
  const k = size(u)
  const taken = new Set<number>()
  for (const o of w.units) if (o !== u && !o.dead && o.gm?.spot && !o.gm.drop && jobOrder(o).k === 'gather') taken.add(anchorAt(nav, size(o), o.gm.spot.x, o.gm.spot.y))
  let best = -1
  let bestD = Infinity
  for (const i of crystalSpots(w, u, w.crystals![cl])) {
    const p = spotOf(nav, k, i)
    const d = (p.x - u.x) * (p.x - u.x) + (p.y - u.y) * (p.y - u.y) + (taken.has(i) ? TAKEN : 0)
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  return best < 0 ? null : spotOf(nav, k, best)
}

/** Where a gathering engineer goes: with a full load (or nothing left to mine and something in hand),
 * to the nearest drop-off of ours (dropFor); otherwise to its spot by its cluster, or, the cluster mined
 * out, the next one in the same field, or, the field run dry, the nearest other field. Null when
 * there is nothing left to do. */
function gatherGoal(w: World, u: Unit, o: Extract<Order, { k: 'gather' }>): Goal | null {
  const g = moveOf(u)
  const carry = u.carry ?? 0
  if (!g.drop) {
    const mine = g.cl !== undefined ? w.crystals?.[g.cl] : undefined
    if (carry >= CARRY - 1e-9) {
      g.drop = true
      g.spot = undefined
    } else if (!mine || mine.f !== o.f || !(mine.left > 0)) {
      g.spot = undefined
      let next = pickCrystal(w, u, o.f)
      if (next < 0) {
        const f = nearestField(w, u)
        if (f >= 0) {
          o.f = f
          g.job = `g${f}`
          next = pickCrystal(w, u, f)
        }
      }
      if (next >= 0) g.cl = next
      else {
        g.cl = undefined
        if (carry > 0) g.drop = true
        else return null
      }
    }
  }
  if (g.drop) {
    // The drop-off picked for this trip, or (none yet, or it was lost or no longer takes kyber) the
    // nearest by the way there; the route is found again for a new one.
    let home = g.home !== undefined ? w.byId.get(g.home) : undefined
    if (!home || !takesKyber(home, u.owner)) {
      const pick = dropFor(w, u)
      if (!pick) return null
      home = pick.s
      g.home = home.id
      g.spot = pick.spot
      u.route = null
    }
    g.spot ??= workSpot(w, u, home)
    return { x: g.spot.x, y: g.spot.y, drop: home }
  }
  g.spot ??= mineSpot(w, u, g.cl!) ?? undefined
  if (!g.spot) return null
  return { x: g.spot.x, y: g.spot.y, mine: g.cl! }
}

/** An engineer by its cluster: it stops, faces it and mines, kyber going from the cluster into its
 * load; once full it heads for a Command Center. A cluster mined out is gone: its stamp comes off the
 * nav grid at the next flush (as a building's), and the last one in a field runs it dry (an event
 * the screen tells the player about). */
function mine(w: World, u: Unit, cl: number) {
  const g = moveOf(u)
  g.mine = true
  u.route = null
  g.pv = -1
  g.tries = 0
  u.v = 0
  const c = w.crystals![cl]
  const at = crystalAt(c)
  const off = wrap(M.atan2(at.y - u.y, at.x - u.x) - u.a)
  const turn = u.t.turn * STEP
  u.a = wrap(u.a + clamp(off, -turn, turn))
  const take = Math.min(MINE_RATE * STEP, CARRY - (u.carry ?? 0), c.left)
  if (take > 0) {
    u.carry = (u.carry ?? 0) + take
    c.left -= take
    if (c.left <= 1e-9) {
      c.left = 0
      if (c.on) stampFootprint(gs(w).nav, c.c, c.r, 1, 1, -1)
      c.on = false
      if (!(fieldLeft(w, c.f) > 0)) {
        const field = gs(w).fields[c.f]
        w.events.push({ k: 'dry', field: c.f, x: field.x, y: field.y })
      }
    }
  }
  if ((u.carry ?? 0) >= CARRY - 1e-9) {
    g.drop = true
    g.spot = undefined
  } else if (!(c.left > 0)) g.spot = undefined
}

/** A gathering engineer next to a drop-off of ours (a Command Center or a supply building): its load
 * goes into the side's kyber, then back to the field. */
function dropOff(w: World, u: Unit) {
  const g = moveOf(u)
  const load = u.carry ?? 0
  // (The AI's difficulty sets how much it gets for a load: Seat incomeMul.)
  if (load > 0) earn(w, w.players[u.owner], load * w.players[u.owner].incomeMul, 'mines', 'Kyber gathered')
  u.carry = 0
  g.drop = false
  g.home = undefined
  g.spot = undefined
  g.pv = -1
  g.tries = 0
  u.route = null
}

/** Engineers `crew` gather kyber at the crystal field at (x, y): each mines a load, hauls it to the
 * nearest drop-off of ours (a Command Center or a supply building) and goes back. Why not, or null. */
export function groundGather(w: World, owner: Owner, crew: Unit[], x: number, y: number, queued: boolean): string | null {
  const f = fieldAt(w, x, y)
  if (f < 0) return 'No kyber there: pick a crystal field'
  if (!w.units.some((s) => takesKyber(s, owner))) return 'Nowhere to take the kyber: build a Command Center or a supply building'
  for (const u of crew) issue(u, { k: 'gather', f }, queued)
  return null
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
 * a whole hull): half as fast, so a building under fire can be outgunned. Repairs are free. */
const REPAIR_RATE = 0.5
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
  // Power (ground/power.ts): short of it, sites, training and research run slower, by owner.
  const power = groundPower(w, dt, crews)
  // The factories' upgrades and research (ground/jobs.ts), at the same share of their speed.
  jobsTick(w, dt, power)
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
      const step = Math.min(s.building, dt * rate * power[s.owner])
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
      q.left = Math.max(0, q.left - dt * power[s.owner])
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
    const g = moveOf(u)
    g.busy = 0
    g.mine = false
    if (!unstick(w, u)) steer(w, u)
  }
  separate(w)
  groundCombat(w, dt)
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

// --- Economy -----------------------------------------------------------------------------------------

/** The most units a side can have, however many supply buildings it puts up. */
export const POP_MAX = 200

/**
 * A player's economy in a ground battle, four times a second (sim.ts refreshPlayers): no income
 * trickles in (kyber comes only from drop-offs), the unit cap is the supply of its finished
 * buildings, and the kyber it gathered a second lately is kept for the top bar and the economy.
 */
export function groundIncome(w: World, p: Player, o: Owner) {
  let supply = 0
  for (const u of w.units) if (!u.dead && u.owner === o && u.foot && !u.site) supply += spec(u.t).supply ?? 0
  p.incomeParts = { station: 0, mines: 0, beacons: 0 }
  p.income = 0
  p.popCap = Math.min(POP_MAX, supply)
  // A running average over about half a minute (refreshPlayers runs every quarter second).
  const total = p.earnedBy.mines
  const got = total - (p.gatheredAt ?? total)
  p.gatheredAt = total
  p.gatherRate = (p.gatherRate ?? 0) * 0.99 + got * 4 * 0.01
}

// --- Placement ------------------------------------------------------------------------------------

/** One tile of a placement ghost: whether a building may cover it. */
export type TileCheck = { tc: number; tr: number; ok: boolean }
/** Where a building would go: its footprint's top-left tile and middle, what it costs, every tile
 * checked, the row in front of its door (which must stay free), and the first rule that fails (null
 * when it may go there). The ghost under the cursor shows this. */
export type GroundPlacement = { why: string | null; tc: number; tr: number; x: number; y: number; cost: number; tiles: TileCheck[]; door: TileCheck[] }

/** How far (in tiles, middle to middle) every building keeps from the enemy buildings we know of: no
 * building up against the enemy's base or walling in its door. Otherwise a building may go anywhere
 * our engineers can reach, however far from our Command Centers. */
export const ENEMY_GAP = 20

/** A footprint a team knows of: its tiles, whether it is an enemy's, and whether it has an exit (a
 * building that trains: the row in front of its door is kept clear). */
type Known = { c: number; r: number; fw: number; fh: number; enemy: boolean; exit: boolean }

/** Whether buildings of type `t` have an exit: the row in front of their door kept clear so the
 * units they train can leave (the Command Center, the factories). Those that train nothing have none. */
export const hasExit = (t: UnitType | undefined) => !!t?.ground?.trains?.length

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
    out.push({ c: u.foot.c, r: u.foot.r, fw, fh, enemy: !mine, exit: hasExit(u.t) })
  }
  for (const k of w.known?.[tm] ?? []) {
    if (seen.has(k.id)) continue
    const [fw, fh] = spec(UNIT[k.unit]).foot!
    out.push({ c: k.tc, r: k.tr, fw, fh, enemy: true, exit: hasExit(UNIT[k.unit]) })
  }
  return out
}

const covers = (f: Known, c: number, r: number) => c >= f.c && c < f.c + f.fw && r >= f.r && r < f.r + f.fh
const doorOf = (f: Known, c: number, r: number) => f.exit && r === f.r + f.fh && c >= f.c && c < f.c + f.fw

/** Why one tile can't be under a building, in the order the reasons are reported. */
const TILE_RULES = ['Not on buildable ground', 'A deposit is in the way', 'The ground must be level', 'Something is built there', "It would block a building's exit"] as const

/**
 * Where building `unitId` would go with its footprint centred as near (x, y) as the grid allows. The
 * rules, in order: every tile buildable, on one level and free of deposits, buildings and other
 * buildings' exits; at least ENEMY_GAP tiles from a known enemy building (but anywhere else, however
 * far from our Command Centers); no enemy unit we see on it; its exit free (a building that trains:
 * `hasExit`); enough kyber. What a team doesn't see doesn't stop it (the land itself is
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
  // Its exit, the row in front of the door, for a building that trains: open ground, joined to the
  // footprint's edge, nothing built on it. One that trains nothing has none.
  const door: TileCheck[] = []
  const dr = tr + fh
  for (let c = tc; c < tc + fw && hasExit(t); c++) {
    const i = dr * cols + c
    const ok = dr < rows && (g.flags[i] & TF.blocked) === 0 && canStep(g, i - cols, i) && !feet.some((k) => covers(k, c, dr))
    door.push({ tc: c, tr: dr, ok })
  }
  const out = (why: string | null): GroundPlacement => ({ why, tc, tr, x: cx, y: cy, cost, tiles, door })
  if (worst < TILE_RULES.length && worst !== 4) return out(TILE_RULES[worst])
  // Away from the enemy's buildings that we know of.
  const gap = ENEMY_GAP * TILE
  const near = knownFeet(w, owner).some((f) => {
    const dx = cx - (f.c + f.fw / 2) * TILE
    const dy = cy - (f.r + f.fh / 2) * TILE
    return f.enemy && dx * dx + dy * dy < gap * gap
  })
  if (near) return out(`Too close to an enemy building (keep ${ENEMY_GAP} tiles away)`)
  // Enemy units we can see on it.
  const x0 = tc * TILE
  const y0 = tr * TILE
  for (const u of w.units) {
    if (u.dead || !u.t.ground || u.t.tier !== 'vehicle' || team(w, u.owner) === tm || !u.seen[tm]) continue
    const dx = Math.max(x0 - u.x, 0, u.x - (x0 + fw * TILE))
    const dy = Math.max(y0 - u.y, 0, u.y - (y0 + fh * TILE))
    if (dx * dx + dy * dy < spec(u.t).radius * spec(u.t).radius) return out('Enemy units are in the way')
  }
  if (!door.every((d) => d.ok)) return out('No room for its exit: the row in front of its door must stay clear')
  if (worst === 4) return out(TILE_RULES[4])
  if (p.credits < cost) return out('Not enough kyber')
  return out(null)
}

/** Whether engineer `u` can drive to a tile next to a `fw` × `fh` footprint from tile (c, r). */
function canReach(w: World, u: Unit, c: number, r: number, [fw, fh]: [number, number]) {
  const nav = gs(w).nav
  const k = size(u)
  const start = nearestStand(nav, k, anchorAt(nav, k, u.x, u.y))
  if (start < 0) return false
  const piece = nav.piece[k - 1][start]
  for (let rr = r - k; rr <= r + fh; rr++)
    for (let cc = c - k; cc <= c + fw; cc++) {
      if (rr > r - k && rr < r + fh && cc > c - k && cc < c + fw) continue
      if (cc < 0 || rr < 0 || cc >= nav.cols || rr >= nav.rows) continue
      const i = rr * nav.cols + cc
      if (stands(nav, k, i) && nav.piece[k - 1][i] === piece) return true
    }
  return false
}

/** Engineers `crew` put up building `unitId` centred near (x, y): paid now, its site marked out (seen
 * by its owner only until work starts), the engineers sent to build it (`queued`: after their other
 * orders). Why not, or null. */
export function groundPlace(w: World, owner: Owner, crew: Unit[], unitId: string, x: number, y: number, queued: boolean): string | null {
  const builders = crew.filter((u) => u.t.ground?.builds?.includes(unitId))
  if (!builders.length) return crew.length ? "These engineers can't build that" : 'Select engineers to build it'
  const pl = groundPlacement(w, owner, unitId, x, y)
  if (pl.why) return pl.why
  // Anywhere, as long as one of the engineers can drive up to it.
  if (!builders.some((u) => canReach(w, u, pl.tc, pl.tr, spec(UNIT[unitId]).foot!))) return "Your engineers can't get there"
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
  const t = UNIT[id]
  const can = (u: Unit | undefined): u is Unit => !!u && !u.dead && u.owner === owner && !!u.foot && !u.site && !!u.yq && !!u.t.ground?.trains?.includes(id)
  // A trainer whose tier is too low for it (phase 5's upgrades raise it).
  const ok = (u: Unit | undefined): u is Unit => can(u) && tierOf(u) >= tierNeeded(t)
  if (at) {
    const u = w.byId.get(at)
    if (!can(u)) return "That building can't train it"
    return tierOf(u) >= tierNeeded(t) ? u : `Needs the ${u.t.name} at tier ${tierNeeded(t)}: upgrade it on its Upgrades page`
  }
  let best: Unit | undefined
  for (const u of w.units) if (ok(u) && (!best || u.yq!.length < best.yq!.length)) best = u
  if (best) return best
  const low = w.units.find((u) => can(u))
  if (low) return `Needs a ${low.t.name} at tier ${tierNeeded(t)}`
  const maker = Object.values(UNIT).find((m) => m.faction === w.players[owner].faction && m.ground?.trains?.includes(id))
  return maker ? `Build a ${maker.name} to train it` : 'No building of ours trains that'
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
  if (pop + t.pop > p.popCap) return `Needs more supply: build a ${UNIT[groundIds(p.faction).supply].name} (the unit cap is ${p.popCap})`
  if (p.credits < t.cost) return 'Not enough kyber'
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
      int(u.t.ground?.tier ?? 0)
      if (u.gj) num(u.gj.left)
    }
    if (u.gm) {
      int(u.gm.pv)
      num(u.gm.stuck)
      int(u.gm.tries)
      int(u.gm.busy)
      int(u.route?.pts.length ?? -1)
      int(u.gm.drop ? 1 : 0)
      int(u.gm.back ?? -1)
      int(u.gm.cl ?? -1)
      int(u.gm.home ?? -1)
    }
    if (u.carry !== undefined) num(u.carry)
    if (u.order.k === 'gather') int(u.order.f)
    if (u.order.k === 'assist') {
      int(u.order.id)
      int(!u.order.job ? 0 : u.order.job.k === 'construct' ? u.order.job.id : -1 - u.order.job.f)
    }
  }
  for (const c of w.crystals ?? []) {
    num(c.left)
    int(c.on ? 1 : 0)
  }
  // Research points and the kyber burnt for power (power itself is worked out afresh each tick).
  for (const p of w.players) {
    num(p.rp ?? 0)
    num(p.burnt ?? 0)
    int(p.techs.length)
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
  combatHash(w, int, num)
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
  // A battle saved before crystal clusters: its fields' clusters laid out afresh, each field's left
  // shared out as it was (a battle saved before kyber at all: every field full).
  if (!w.crystals) {
    w.crystals = placeCrystals(g.map, g.fields)
    const was = w.kyber
    if (was) for (const c of w.crystals) c.left = c.max * Math.max(0, Math.min(1, (was[c.f] ?? FIELD_KYBER) / FIELD_KYBER))
    delete w.kyber
    for (const c of w.crystals) c.on = c.left > 0
  }
  for (const u of w.units) {
    if (!u.foot?.on) continue
    const [fw, fh] = spec(u.t).foot!
    stampFootprint(g.nav, u.foot.c, u.foot.r, fw, fh, 1)
  }
  for (const c of w.crystals) if (c.on) stampFootprint(g.nav, c.c, c.r, 1, 1, 1)
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
  gather: groundGather,
  job: startJob,
  cancelJob,
})
