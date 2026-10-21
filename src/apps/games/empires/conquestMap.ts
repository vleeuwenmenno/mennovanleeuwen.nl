import * as M from './detmath.ts'
import { BUILD_RADIUS } from './data.ts'
import { DEFAULT_RULES, generateMap, type MapDef, type Patch, type Pt } from './maps.ts'
import { mapDist } from './scale.ts'
import type { Galaxy, PlanetKind, StructId } from './galaxy.ts'

// Galactic conquest's battle maps: every planet has one map of its own, the same every time it is
// fought over and in the orbit view's preview of it, so where the player stands its Command Station,
// yards and defense stations on the preview is where they stand when the planet is attacked.
//
// The map comes from the generator (maps.ts generateMap) with a seed from the galaxy's seed and the
// planet's id, its terrain by the planet's kind (asteroid fields round barren and volcanic worlds,
// nebulas round gas giants). The holder's station starts at the first spawn, on the left; each
// hyperlane into the planet's system has an entry zone of its own along the far side of the map (in
// the order the lanes leave the system, round from the west), where an attacker coming down that
// lane drops out of hyperspace, and a planet with neighbours in its system has one more for fleets
// coming from them. Every entry zone is a spawn of the map after the home one (MapDef.spawns), so the
// rocks a battle scatters keep clear of all of them, whichever one the attacker uses.
//
// No DOM, so the headless checks load this too.

/** Where a structure sits round its planet in the orbit view's pictures: a bearing `a` (radians,
 * screen-wise: 0 to the right, clockwise) and a distance `d` in planet radii from its middle. Saves
 * from before the battle maps kept the layout this way (see polarToMap). */
export type Spot = { a: number; d: number }
/** Each structure's own spot round its planet before the battle maps: what an old save's layout left
 * out stood at (see fromPolar), and where a picture goes with no place on the map. */
export const AUTO_SPOT: Record<StructId, Spot> = {
  station: { a: -0.75, d: 2.05 },
  yard: { a: Math.PI, d: 2.25 },
  cyard: { a: 0.9, d: 2.3 },
  def0: { a: -2.25, d: 1.9 },
  def1: { a: 2.2, d: 1.9 },
}
/** Where the orbit view pictures the Command Station round its planet (the rest round it, see mapToPolar). */
export const RING_STATION: Spot = { a: -2.3, d: 2.05 }
/** How near and how far from the planet's middle the pictures of its structures sit, in planet radii. */
export const SPOT_D = { min: 1.6, max: 2.9 }
/** Battle world units for each planet radius of a Spot, and how near and far from the station a
 * structure turned onto the map by polarToMap stands. */
export const LAYOUT_SCALE = { unit: mapDist(560), min: mapDist(760), max: BUILD_RADIUS * 0.9 }

/** A place on a planet's battle map (world units). */
export type Place = { x: number; y: number }
/** Where a structure of a layout stands, and its heading `a` (radians, as a unit's in a battle) if
 * its holder turned it; left out, it faces the way it does by default (sim.ts layoutFace: the
 * station towards the middle of the map, a yard away from the station, a defense station as the
 * station does). Saves from before structures could be turned have none. */
export type LayoutPlace = Place & { a?: number }
/** Where a planet's structures stand on its battle map, as its holder placed them (each missing one
 * stands at its default, see autoLayout). */
export type PlanetLayout = Partial<Record<StructId, LayoutPlace>>

/** A heading brought into (-PI, PI], to four decimals (what a layout keeps). */
export function cleanTurn(a: number): number {
  const t = a - Math.PI * 2 * Math.floor((a + Math.PI) / (Math.PI * 2))
  return Math.round(t * 1e4) / 1e4
}

/** An entry zone: where an attacker coming from `system` (a neighbouring system down a hyperlane,
 * or the planet's own system for a fleet from another planet there) drops out of hyperspace. */
export type Entry = Place & { system: number; name: string }
/** A planet's battle map: the map itself (spawns: home, then one per entry zone), where the
 * holder's station starts, and the entry zones in the map's spawn order. */
export type PlanetMap = { key: string; map: MapDef; home: Place; entries: Entry[] }

/** How far from the map's edges the entry zones keep, and how much room round each the terrain
 * leaves (a fleet drops out of hyperspace there in a loose block). */
const ENTRY_EDGE = mapDist(600)
const ENTRY_CLEAR = mapDist(950)
/** How big an entry zone is drawn on the preview. */
export const ENTRY_R = mapDist(380)

const cache = new Map<string, PlanetMap>()

/** Planet `pid`'s battle map: always the same for the same galaxy (seed, planets and lanes). */
export function planetMap(g: Pick<Galaxy, 'seed' | 'systems' | 'planets' | 'lanes'>, pid: number): PlanetMap {
  const p = g.planets[pid]
  const sys = g.systems[p.system]
  const near = g.lanes.filter((l) => l.includes(p.system)).map((l) => (l[0] === p.system ? l[1] : l[0])).sort((a, b) => a - b)
  const others = sys.planets.length > 1
  const key = `${g.seed}:${pid}:${p.kind}:${near.join(',')}:${others ? 1 : 0}`
  const hit = cache.get(key)
  if (hit) return hit
  const seed = (((Math.imul(g.seed + 1, 7919) + Math.imul(pid + 1, 104729)) >>> 0) % 999999) || 1
  const base = generateMap({ ...DEFAULT_RULES, seed, players: 2, size: 'small', beacons: 0, ...terrainOf(p.kind), wrecks: 'none' })
  const home = base.spawns[0]
  // The entry zones: one per lane, round the far side in the order the lanes leave the system
  // (from the west, through north, east and south), and one for the system's own planets.
  const dirs = near.map((s) => ({ system: s, name: g.systems[s].name, b: M.atan2(g.systems[s].y - sys.y, g.systems[s].x - sys.x) }))
  if (others) dirs.push({ system: p.system, name: `In ${sys.name}`, b: wrap(p.angle + Math.PI) })
  if (!dirs.length) dirs.push({ system: -1, name: 'Deep space', b: 0 })
  dirs.sort((a, b) => wrap(a.b + Math.PI) - wrap(b.b + Math.PI) || a.system - b.system)
  const { w, h } = base
  // (Along the top, down the far edge and back along the bottom, its corners cut so neighbouring
  // zones never crowd round one.)
  const m = ENTRY_EDGE
  const cut = mapDist(900)
  const path: Pt[] = [{ x: w * 0.56, y: m }, { x: w - m - cut, y: m }, { x: w - m, y: m + cut }, { x: w - m, y: h - m - cut }, { x: w - m - cut, y: h - m }, { x: w * 0.56, y: h - m }]
  const entries: Entry[] = dirs.map((d, i) => ({ ...along(path, (i + 0.5) / dirs.length), system: d.system, name: d.name }))
  // The terrain leaves the entry zones open.
  const open = (q: Patch) => entries.every((e) => M.hypot(q.x - e.x, q.y - e.y) > q.r + ENTRY_CLEAR)
  const map: MapDef = {
    ...base,
    id: 'conquest',
    name: p.name,
    spawns: [home, ...entries.map((e) => ({ x: e.x, y: e.y }))],
    // Its rocks are its own, not copied round the middle; they keep clear of the home's build
    // radius and, less widely, of every entry zone.
    sym: 'none',
    keep: [BUILD_RADIUS, ...entries.map(() => ENTRY_CLEAR)],
    ore: [],
    beacons: [],
    wrecks: [],
    fields: base.fields.filter(open),
    nebulas: base.nebulas.filter(open),
    planet: { kind: p.kind, x: w / 2 + (home.x - w / 2) * 0.5, y: h / 2 + mapDist(1500), r: 560 },
  }
  const out: PlanetMap = { key, map, home: { x: home.x, y: home.y }, entries }
  if (cache.size > 200) cache.clear()
  cache.set(key, out)
  return out
}

/** The terrain round a planet of each kind. */
function terrainOf(kind: PlanetKind) {
  return {
    asteroidFields: kind === 'barren' || kind === 'lava' || kind === 'crystal' ? ('many' as const) : kind === 'city' ? ('none' as const) : ('few' as const),
    nebulas: kind === 'gas' || kind === 'icegiant' || kind === 'stormgiant' ? ('many' as const) : kind === 'ice' || kind === 'ocean' || kind === 'swamp' || kind === 'toxic' ? ('few' as const) : ('none' as const),
  }
}

/** An angle brought into [0, 2 PI). */
const wrap = (a: number) => a - Math.PI * 2 * Math.floor(a / (Math.PI * 2))
/** The point a share `t` of the way along a path of straight legs. */
function along(path: Pt[], t: number): Pt {
  const legs = path.slice(1).map((q, i) => M.hypot(q.x - path[i].x, q.y - path[i].y))
  let left = t * legs.reduce((s, l) => s + l, 0)
  for (let i = 0; i < legs.length; i++) {
    if (left <= legs[i] || i === legs.length - 1) {
      const f = legs[i] ? Math.min(1, left / legs[i]) : 0
      return { x: path[i].x + (path[i + 1].x - path[i].x) * f, y: path[i].y + (path[i + 1].y - path[i].y) * f }
    }
    left -= legs[i]
  }
  return path[0]
}

/**
 * The spawn an attacker uses on planet map `pm`: the entry zone of the system it came from (`via`,
 * see Fleet.via; the planet's own system for a fleet from one of its neighbours there). Unknown (a
 * fleet built here, a save from before the entry zones): the zone in the middle of the far side.
 */
export function entrySpawn(pm: PlanetMap, via: number | undefined): number {
  const i = via === undefined ? -1 : pm.entries.findIndex((e) => e.system === via)
  return 1 + (i >= 0 ? i : Math.floor((pm.entries.length - 1) / 2))
}

/** Which way the planet lies from the station on the map (below it on a map without one). */
const planetTurn = (map: MapDef, st: Place) => (map.planet ? M.atan2(map.planet.y - st.y, map.planet.x - st.x) : Math.PI / 2)

/**
 * Where a structure at `X` round the planet stands on its battle map, with the Command Station at
 * `S` round the planet and at `st` on the map: where it sits from the station round the planet,
 * turned so the planet lies the way the map's planet lies from the station, LAYOUT_SCALE world units
 * per planet radius, kept within reach of the station. How battles placed structures before the
 * battle maps; it turns old saves' layouts onto the map (fromPolar).
 */
export function polarToMap(map: MapDef, st: Place, S: Spot, X: Spot): Place {
  const sx = M.cos(S.a) * S.d
  const sy = M.sin(S.a) * S.d
  const rx = M.cos(X.a) * X.d - sx
  const ry = M.sin(X.a) * X.d - sy
  const turn = planetTurn(map, st) - M.atan2(-sy, -sx)
  const c = M.cos(turn)
  const s = M.sin(turn)
  const len = M.hypot(rx, ry) || 1
  const d = Math.max(LAYOUT_SCALE.min, Math.min(LAYOUT_SCALE.max, len * LAYOUT_SCALE.unit))
  return { x: st.x + ((rx * c - ry * s) / len) * d, y: st.y + ((rx * s + ry * c) / len) * d }
}

/** The structures round a planet (galaxy.ts StructId), in the order a battle stands them. */
export const STRUCT_ORDER: StructId[] = ['station', 'yard', 'cyard', 'def0', 'def1']

/**
 * The default layout on a map, with the station at `home` and attackers coming in at `attackers`
 * (the other spawns): the yards on either flank, a little behind the station, away from where the
 * attackers come in, and the defense stations either side in front of it, facing them. Where a
 * structure actually stands is then worked out on the map (sim.ts standBase: the nearest clear spot
 * to this, room kept for every structure at its biggest).
 */
export function autoLayout(home: Place, attackers: readonly Pt[]): Record<StructId, Place> {
  const n = attackers.length
  const from = n ? { x: attackers.reduce((s, q) => s + q.x, 0) / n, y: attackers.reduce((s, q) => s + q.y, 0) / n } : { x: home.x + 1, y: home.y }
  const away = M.atan2(home.y - from.y, home.x - from.x)
  const at = (b: number, d: number): Place => ({ x: home.x + M.cos(away + b) * d, y: home.y + M.sin(away + b) * d })
  return { station: { ...home }, yard: at(1.25, mapDist(1100)), cyard: at(-1.25, mapDist(1350)), def0: at(Math.PI - 0.6, mapDist(950)), def1: at(Math.PI + 0.6, mapDist(950)) }
}
/** The default layout on planet map `pm` (see autoLayout). */
export const autoLayoutOf = (pm: Pick<PlanetMap, 'map' | 'home'>) => autoLayout(pm.home, pm.map.spawns.slice(1))

/** A layout saved before the battle maps (bearings and distances round the planet, see Spot) on
 * planet map `pm`: the station at home, the rest where battles stood them (polarToMap). */
export function fromPolar(pm: Pick<PlanetMap, 'map' | 'home'>, spots: Partial<Record<StructId, Spot>>): PlanetLayout {
  const S = spots.station ?? AUTO_SPOT.station
  const out: PlanetLayout = { station: { ...pm.home } }
  // (A station moved round the planet turned the others with it: they all come over then.)
  for (const id of STRUCT_ORDER) if (id !== 'station' && (spots[id] || spots.station)) out[id] = polarToMap(pm.map, pm.home, S, spots[id] ?? AUTO_SPOT[id])
  return out
}

/**
 * The pictures round the planet in the orbit view: each structure's place on the battle map (`at`,
 * the station at `at.station`) turned back round the planet (the inverse of polarToMap, the station
 * on its own spot), kept between SPOT_D's distances.
 */
export function mapToPolar(map: MapDef, at: Partial<Record<StructId, Place>>): Partial<Record<StructId, Spot>> {
  // (Up and to the left of the planet: the battle map's panel sits to its right.)
  const S = RING_STATION
  const st = at.station
  if (!st) return {}
  const sx = Math.cos(S.a) * S.d
  const sy = Math.sin(S.a) * S.d
  const turn = planetTurn(map, st) - Math.atan2(-sy, -sx)
  const c = Math.cos(-turn)
  const s = Math.sin(-turn)
  const out: Partial<Record<StructId, Spot>> = { station: S }
  for (const id of STRUCT_ORDER) {
    const q = at[id]
    if (!q || id === 'station') continue
    const dx = (q.x - st.x) / LAYOUT_SCALE.unit
    const dy = (q.y - st.y) / LAYOUT_SCALE.unit
    const x = sx + dx * c - dy * s
    const y = sy + dx * s + dy * c
    out[id] = { a: Math.atan2(y, x), d: Math.max(SPOT_D.min, Math.min(SPOT_D.max, Math.hypot(x, y))) }
  }
  return out
}

/** A saved layout made sound: only structures that exist, at finite places on the map. Old saves'
 * layouts round the planet (bearings and distances) are turned onto planet map `pm` (fromPolar). */
export function cleanLayout(l: unknown, pm: () => Pick<PlanetMap, 'map' | 'home'>): PlanetLayout | undefined {
  if (!l || typeof l !== 'object') return undefined
  const v = l as Record<string, unknown>
  const polar: Partial<Record<StructId, Spot>> = {}
  const out: PlanetLayout = {}
  for (const id of STRUCT_ORDER) {
    const s = v[id] as Partial<Spot & LayoutPlace> | undefined
    if (!s || typeof s !== 'object') continue
    if (Number.isFinite(s.x) && Number.isFinite(s.y)) out[id] = { x: s.x!, y: s.y!, ...(Number.isFinite(s.a) ? { a: cleanTurn(s.a!) } : {}) }
    else if (Number.isFinite(s.a) && Number.isFinite(s.d)) polar[id] = { a: s.a!, d: Math.max(SPOT_D.min, Math.min(SPOT_D.max, s.d!)) }
  }
  if (Object.keys(polar).length) {
    const xy = { ...out }
    Object.assign(out, fromPolar(pm(), polar), xy)
  }
  if (!Object.keys(out).length) return undefined
  const m = pm().map
  for (const id of STRUCT_ORDER) {
    const q = out[id]
    if (q && (q.x < 0 || q.y < 0 || q.x > m.w || q.y > m.h)) delete out[id]
  }
  return Object.keys(out).length ? out : undefined
}
