import * as M from './detmath.ts'
import { sq } from './detmath.ts'
import { MAP_SCALE } from './scale.ts'

// The battlefields. Each map lists its spawn points, ore, beacons and terrain, and how it is
// symmetric, so everything can be placed once and copied to every player's side: nobody gets the
// better lanes. Besides the fixed maps there's a generator that builds a fair map from a few rules
// and a seed. No DOM, so the headless sims load this too.

export type Pt = { x: number; y: number }
/** How a map's sides copy each other: 'point' (two, turned half way round the middle), 'quad'
 * (four, mirrored left-right and top-bottom), 'tri', 'penta' and 'hex' (three, five and six, turned
 * round the middle) and 'tripair' (six: three pairs of mirror twins, turned a third of the way round). */
export type Symmetry = 'point' | 'quad' | 'tri' | 'penta' | 'hex' | 'tripair'
/** A round patch of terrain. Fields and nebulas are built from a few overlapping ones, so they read
 * as blobs rather than perfect circles. */
export type Patch = { x: number; y: number; r: number }
/** A gas cloud: `hue` is its colour on the HSL wheel. */
export type Nebula = Patch & { hue: number }

export type MapDef = {
  id: string
  name: string
  blurb: string
  w: number
  h: number
  /** Station positions; stations face the middle of the map. */
  spawns: Pt[]
  ore: Pt[]
  beacons: Pt[]
  sym: Symmetry
  rocks: number
  /** Seeds the scattered rocks, so a map always looks the same. */
  seed: number
  /** Asteroid fields: small drifting rocks that wear down big ships flying through. */
  fields: Patch[]
  /** Gas clouds that knock out shields and halve sensor range for ships inside. */
  nebulas: Nebula[]
  /** Derelict hulks: park ships next to one to strip it for credits. */
  wrecks: Wreckage[]
  /** A fleet battle's planet, drawn far behind the battle (kind names its art in planets/). */
  planet?: { kind: string; x: number; y: number; r: number }
}
export type Wreckage = Pt & { value: number }

/** Whether a point is inside any of the patches (grown by `pad`). */
export const inside = (ps: Patch[], x: number, y: number, pad = 0) => ps.some((p) => sq(x - p.x) + sq(y - p.y) < sq(p.r + pad))

/** A start area: where a player may put their station, chosen before the battle starts. */
export type Rect = { x: number; y: number; w: number; h: number }
export const inRect = (r: Rect, x: number, y: number) => x >= r.x && y >= r.y && x <= r.x + r.w && y <= r.y + r.h
/** A spawn's own start area when nobody has drawn one: a square round it, inside the map. */
export function defaultArea(map: MapDef, i: number): Rect {
  const sp = map.spawns[i]
  const size = Math.min(2600 * MAP_SCALE, map.w * 0.38, map.h * 0.5)
  const x = Math.max(0, Math.min(map.w - size, sp.x - size / 2))
  const y = Math.max(0, Math.min(map.h - size, sp.y - size / 2))
  return { x, y, w: size, h: size }
}

/** A small seeded random generator (mulberry32): the same seed always gives the same numbers. */
export function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const rot = (p: Pt, c: Pt, a: number): Pt => {
  const s = M.sin(a)
  const co = M.cos(a)
  return { x: c.x + (p.x - c.x) * co - (p.y - c.y) * s, y: c.y + (p.x - c.x) * s + (p.y - c.y) * co }
}
const dist = (a: Pt, b: Pt) => M.hypot(a.x - b.x, a.y - b.y)

type Shape = { w: number; h: number; sym: Symmetry }

/** Every copy of a point under a map's symmetry, the point itself first. */
export function mirrored(m: Shape, p: Pt): Pt[] {
  const { w, h } = m
  if (m.sym === 'point') return [p, { x: w - p.x, y: h - p.y }]
  if (m.sym === 'quad') return [p, { x: w - p.x, y: p.y }, { x: p.x, y: h - p.y }, { x: w - p.x, y: h - p.y }]
  const c = { x: w / 2, y: h / 2 }
  if (m.sym === 'tri') return [p, rot(p, c, (Math.PI * 2) / 3), rot(p, c, (Math.PI * 4) / 3)]
  // Copies in turn round the middle (clockwise on screen), so neighbouring spawns get neighbouring
  // numbers.
  const turn = (q: Pt, n: number) => Array.from({ length: n }, (_, k) => (k ? rot(q, c, (Math.PI * 2 * k) / n) : q))
  if (m.sym === 'penta') return turn(p, 5)
  if (m.sym === 'hex') return turn(p, 6)
  // tripair: the point and its twin across the upright line through the middle, both turned a
  // third and two thirds round. A point left of the line gives the twins in order round the middle.
  const twin = { x: w - p.x, y: p.y }
  const a = turn(p, 3)
  const b = turn(twin, 3)
  return [a[0], b[0], a[1], b[1], a[2], b[2]]
}

/** The distinct copies of a point: a point on a mirror line or in the middle is its own copy. */
const copies = (m: Shape, p: Pt) => mirrored(m, p).filter((q, i, all) => all.findIndex((o) => dist(o, q) < 1) === i)

const all = (m: Shape, pts: Pt[]) => pts.flatMap((p) => copies(m, p))
/** Terrain patches given as [x, y, r], copied to every side. */
/** Wrecks at each of these points, copied to every side; [x, y, credits]. */
const hulks = (m: Shape, ps: [number, number, number][]): Wreckage[] => ps.flatMap(([x, y, value]) => copies(m, { x, y }).map((p) => ({ ...p, value })))
const patches = (m: Shape, ps: [number, number, number][]): Patch[] => ps.flatMap(([x, y, r]) => copies(m, { x, y }).map((p) => ({ ...p, r })))
const clouds = (m: Shape, hue: number, ps: [number, number, number][]): Nebula[] => patches(m, ps).map((p) => ({ ...p, hue }))

// --- The maps ---------------------------------------------------------------------------------------

const kessar = { w: 5600, h: 3400, sym: 'point' as const }
const trinity = { w: 5800, h: 5800, sym: 'tri' as const }
const vanth = { w: 6600, h: 4400, sym: 'quad' as const }
const cinder = { w: 4400, h: 2800, sym: 'point' as const }
const reefs = { w: 6200, h: 4200, sym: 'quad' as const }
const shroud = { w: 6000, h: 6000, sym: 'tri' as const }
const tc = { x: trinity.w / 2, y: trinity.h / 2 }
const sc = { x: shroud.w / 2, y: shroud.h / 2 }
const hadrel = { w: 4600, h: 2700, sym: 'point' as const }
const tessaly = { w: 4050, h: 4050, sym: 'tri' as const }
const orvane = { w: 5800, h: 3200, sym: 'point' as const }
const ithra = { w: 6000, h: 4000, sym: 'quad' as const }
const quintara = { w: 6800, h: 6800, sym: 'penta' as const }
const serrat = { w: 6800, h: 6800, sym: 'hex' as const }
const velkar = { w: 8400, h: 8400, sym: 'hex' as const }
const draxis = { w: 8000, h: 8000, sym: 'hex' as const }
const tarsis = { w: 8600, h: 8600, sym: 'tripair' as const }
const mid = (m: Shape): Pt => ({ x: m.w / 2, y: m.h / 2 })
/** The point `r` from the middle of `m`, `deg` degrees clockwise from straight up. */
const at = (m: Shape, r: number, deg: number): Pt => rot({ x: m.w / 2, y: m.h / 2 - r }, mid(m), (deg * Math.PI) / 180)
/** The same as an [x, y, size] entry for patches, clouds and hulks. */
const atR = (m: Shape, r: number, deg: number, size: number): [number, number, number] => {
  const p = at(m, r, deg)
  return [p.x, p.y, size]
}
/** Where the spiral arms of Draxis Spiral lie at `r` from the middle: they wind clockwise outwards. */
const arm = (r: number) => 8 + ((r - 1000) / 1600) * 37
/** How far each of Tarsis Triad's twin stations sits off the line between them. */
const TWIN = 19.2

/** How far every map is spread out from how it was drawn: positions and terrain grow, while ore,
 * beacons, wrecks and stations keep their size, so there's more open space between them and
 * fleets take longer to get anywhere. The battlefield's own dial, MAP_SCALE (scale.ts), goes on
 * top of this. */
export const SPREAD = 1.35

/** A map spread out by `k` (see SPREAD and MAP_SCALE). Scattered rocks grow in number to keep their
 * density. */
export function spread(m: MapDef, k = SPREAD * MAP_SCALE): MapDef {
  const p = <T extends Pt>(q: T): T => ({ ...q, x: q.x * k, y: q.y * k })
  const patch = <T extends Patch>(q: T): T => ({ ...p(q), r: q.r * k })
  return {
    ...m,
    w: Math.round(m.w * k),
    h: Math.round(m.h * k),
    spawns: m.spawns.map(p),
    ore: m.ore.map(p),
    beacons: m.beacons.map(p),
    wrecks: m.wrecks.map(p),
    fields: m.fields.map(patch),
    nebulas: m.nebulas.map(patch),
    rocks: Math.round(m.rocks * k * k),
  }
}

export const MAPS: MapDef[] = ([
  {
    id: 'kessar',
    name: 'Kessar Belt',
    blurb: 'A long belt between two stations, three beacons down the middle, an asteroid field on each flank. The classic duel.',
    ...kessar,
    spawns: [
      { x: 650, y: 1700 },
      { x: 4950, y: 1700 },
    ],
    ore: [
      ...all(kessar, [
        { x: 1150, y: 640 },
        { x: 1150, y: 2760 },
        { x: 2050, y: 1180 },
      ]),
      { x: 2640, y: 750 },
      { x: 2960, y: 2650 },
    ],
    beacons: [
      { x: 2800, y: 430 },
      { x: 2800, y: 1700 },
      { x: 2800, y: 2970 },
    ],
    rocks: 44,
    seed: 1107,
    wrecks: hulks(kessar, [[2200, 2550, 900]]),
    fields: patches(kessar, [
      [1900, 2350, 260],
      [2110, 2480, 180],
    ]),
    nebulas: [],
  },
  {
    id: 'trinity',
    name: 'Trinity Rift',
    blurb: 'Three stations around a contested core shrouded in a nebula. Two against one, or a duel with an empty corner.',
    ...trinity,
    spawns: all(trinity, [{ x: tc.x, y: 650 }]),
    ore: [
      ...all(trinity, [
        { x: tc.x - 620, y: 1150 },
        { x: tc.x + 620, y: 1150 },
        { x: tc.x, y: tc.y - 1100 },
      ]),
      // Out on the rim between each pair of stations, and around the core.
      ...all(trinity, [rot({ x: tc.x, y: tc.y - 2050 }, tc, Math.PI / 3)]),
      ...all(trinity, [rot({ x: tc.x, y: tc.y - 800 }, tc, Math.PI)]),
    ],
    beacons: [tc, ...all(trinity, [rot({ x: tc.x, y: tc.y - 1350 }, tc, Math.PI / 3)])],
    rocks: 66,
    seed: 2311,
    wrecks: hulks(trinity, [[tc.x + 760, 1950, 800]]),
    fields: [],
    nebulas: clouds(trinity, 285, [[tc.x, tc.y, 380]]),
  },
  {
    id: 'vanth',
    name: 'Vanth Crossing',
    blurb: 'Four corners, five beacons, asteroid fields along the top and bottom. Two against two, three against one, or anything in between.',
    ...vanth,
    spawns: all(vanth, [{ x: 700, y: 650 }]),
    ore: [
      ...all(vanth, [
        { x: 1500, y: 450 },
        { x: 650, y: 1500 },
        { x: 1700, y: 1350 },
        { x: 2650, y: 1650 },
      ]),
    ],
    beacons: [
      { x: vanth.w / 2, y: vanth.h / 2 },
      { x: vanth.w / 2, y: 520 },
      { x: vanth.w / 2, y: vanth.h - 520 },
      { x: 520, y: vanth.h / 2 },
      { x: vanth.w - 520, y: vanth.h / 2 },
    ],
    rocks: 72,
    seed: 3719,
    wrecks: hulks(vanth, [[1950, 2000, 700]]),
    fields: patches(vanth, [
      [2580, 700, 230],
      [2420, 820, 150],
    ]),
    nebulas: [],
  },
  {
    id: 'cinder',
    name: 'Cinder Gate',
    blurb: 'A tight duel over just four ore. The middle beacon hides in a nebula; two more sit on the edges. Every mine counts.',
    ...cinder,
    spawns: [
      { x: 600, y: 1400 },
      { x: 3800, y: 1400 },
    ],
    ore: all(cinder, [
      { x: 1250, y: 600 },
      { x: 1500, y: 2250 },
    ]),
    beacons: all(cinder, [
      { x: cinder.w / 2, y: cinder.h / 2 },
      { x: cinder.w / 2, y: 300 },
    ]),
    rocks: 26,
    seed: 4421,
    wrecks: hulks(cinder, [[1650, 2250, 1000]]),
    fields: [],
    nebulas: clouds(cinder, 18, [
      [cinder.w / 2, cinder.h / 2, 420],
      [1960, 1190, 240],
    ]),
  },
  {
    id: 'reefs',
    name: 'Twin Reefs',
    blurb: 'Four corners with two ore each, asteroid reefs in every quarter and a nebula over the middle beacon. Lean, and made for two against two.',
    ...reefs,
    spawns: all(reefs, [{ x: 700, y: 650 }]),
    ore: all(reefs, [
      { x: 1550, y: 520 },
      { x: 850, y: 1450 },
    ]),
    beacons: [
      { x: reefs.w / 2, y: reefs.h / 2 },
      { x: reefs.w / 2, y: 500 },
      { x: reefs.w / 2, y: reefs.h - 500 },
      { x: 450, y: reefs.h / 2 },
      { x: reefs.w - 450, y: reefs.h / 2 },
    ],
    rocks: 56,
    seed: 5153,
    wrecks: hulks(reefs, [[2350, 1450, 700]]),
    fields: patches(reefs, [
      [1900, 1400, 280],
      [2110, 1240, 200],
    ]),
    nebulas: clouds(reefs, 190, [
      [reefs.w / 2, reefs.h / 2, 500],
      [2750, 1860, 270],
    ]),
  },
  {
    id: 'shroud',
    name: 'Shroud Expanse',
    blurb: 'Three stations, a nebula over the core and clouds on the rim where the richest ore lies. Fights in the murk are fought without shields.',
    ...shroud,
    spawns: all(shroud, [{ x: sc.x, y: 650 }]),
    ore: [
      ...all(shroud, [
        { x: sc.x - 650, y: 1200 },
        { x: sc.x + 650, y: 1200 },
        { x: sc.x, y: sc.y - 950 },
      ]),
      ...all(shroud, [rot({ x: sc.x, y: sc.y - 2100 }, sc, Math.PI / 3)]),
    ],
    beacons: [sc, ...all(shroud, [rot({ x: sc.x, y: sc.y - 1300 }, sc, Math.PI / 3)])],
    rocks: 60,
    seed: 6007,
    wrecks: hulks(shroud, [[3000 + 650, 1750, 800]]),
    fields: patches(shroud, [
      [4377, 1034, 250],
      [4560, 1180, 160],
    ]),
    nebulas: [
      ...clouds(shroud, 265, [[sc.x, sc.y, 440]]),
      ...clouds(shroud, 175, [
        [4732, 2000, 460],
        [4980, 1720, 260],
      ]),
    ],
  },
  // --- Small ---
  {
    id: 'hadrel',
    name: 'Hadrel Narrows',
    blurb: 'A duel across an asteroid wall with two narrow gaps, a beacon in each. A derelict lies in the heart of the wall for anyone who braves the rocks.',
    ...hadrel,
    spawns: [
      { x: 550, y: 1350 },
      { x: 4050, y: 1350 },
    ],
    ore: all(hadrel, [
      { x: 1100, y: 650 },
      { x: 1100, y: 2050 },
      { x: 1750, y: 1350 },
    ]),
    beacons: all(hadrel, [{ x: 2300, y: 760 }]),
    rocks: 22,
    seed: 7103,
    wrecks: hulks(hadrel, [
      [2300, 1350, 1000],
      [1500, 250, 600],
    ]),
    fields: patches(hadrel, [
      [2300, 1350, 300],
      [2290, 1090, 170],
      [2300, 190, 230],
      [2350, 350, 140],
    ]),
    nebulas: clouds(hadrel, 30, [[1650, 2380, 230]]),
  },
  {
    id: 'tessaly',
    name: 'Tessaly Knot',
    blurb: 'Three stations close together, asteroid walls between each pair. Every road runs through the knot in the middle: the only beacon and the richest ore, under a nebula.',
    ...tessaly,
    spawns: all(tessaly, [{ x: tessaly.w / 2, y: 520 }]),
    ore: [
      ...all(tessaly, [
        { x: 1430, y: 1000 },
        { x: 2620, y: 1000 },
      ]),
      ...all(tessaly, [at(tessaly, 560, 60)]),
    ],
    beacons: [mid(tessaly)],
    rocks: 24,
    seed: 7211,
    wrecks: hulks(tessaly, [atR(tessaly, 1750, 88, 700)]),
    fields: patches(tessaly, [atR(tessaly, 950, 60, 180), atR(tessaly, 1220, 60, 270), atR(tessaly, 1500, 60, 210)]),
    nebulas: clouds(tessaly, 300, [[tessaly.w / 2, tessaly.h / 2, 330]]),
  },
  // --- Medium ---
  {
    id: 'orvane',
    name: 'Orvane Lanes',
    blurb: 'Three lanes split by two long asteroid walls, open to each other only at the crossroads in the middle. The beacons sit in the outer lanes under nebulas; the middle lane has the ore and a big derelict.',
    ...orvane,
    spawns: [
      { x: 600, y: 1600 },
      { x: 5200, y: 1600 },
    ],
    ore: all(orvane, [
      { x: 1150, y: 900 },
      { x: 1150, y: 2300 },
      { x: 2250, y: 500 },
      { x: 2100, y: 1600 },
    ]),
    beacons: all(orvane, [{ x: 2900, y: 430 }]),
    rocks: 40,
    seed: 8317,
    wrecks: hulks(orvane, [[2900, 1600, 1200]]),
    fields: patches(orvane, [
      [1750, 1060, 170],
      [2080, 1040, 190],
      [2420, 1070, 170],
      [3380, 1050, 170],
      [3720, 1080, 190],
      [4050, 1060, 170],
    ]),
    nebulas: clouds(orvane, 200, [[2900, 430, 260]]),
  },
  {
    id: 'ithra',
    name: 'Ithra Archipelago',
    blurb: 'Four corners and four ore islands, each ringed by asteroids and open towards its own corner. Beacons on the top and bottom edges and in a nebula at the heart.',
    ...ithra,
    spawns: all(ithra, [{ x: 650, y: 600 }]),
    ore: all(ithra, [
      { x: 1350, y: 480 },
      { x: 560, y: 1320 },
      { x: 1800, y: 1380 },
      { x: 2120, y: 1600 },
    ]),
    beacons: [mid(ithra), ...all(ithra, [{ x: ithra.w / 2, y: 480 }])],
    rocks: 50,
    seed: 8429,
    wrecks: hulks(ithra, [[1150, ithra.h / 2, 800]]),
    fields: patches(ithra, [
      [2350, 1180, 160],
      [2440, 1640, 170],
      [1900, 1990, 170],
      [ithra.w / 2 - 560, ithra.h / 2 - 420, 190],
    ]),
    nebulas: clouds(ithra, 160, [[ithra.w / 2, ithra.h / 2, 380]]),
  },
  // --- Large ---
  {
    id: 'quintara',
    name: 'Quintara Crown',
    blurb: 'Five stations round a crown of asteroids, a beacon in each gap and the richest ore inside, round a nebula with the sixth beacon. Three against two, or every admiral for a side.',
    ...quintara,
    spawns: all(quintara, [{ x: quintara.w / 2, y: 650 }]),
    ore: [
      ...all(quintara, [
        { x: 2800, y: 1150 },
        { x: 4000, y: 1150 },
      ]),
      ...all(quintara, [at(quintara, 2450, 36), at(quintara, 720, 36)]),
    ],
    beacons: [mid(quintara), ...all(quintara, [at(quintara, 1500, 36)])],
    rocks: 70,
    seed: 9001,
    wrecks: hulks(quintara, [atR(quintara, 2000, 20, 700)]),
    fields: patches(quintara, [atR(quintara, 1500, 0, 300), atR(quintara, 1450, 11, 200), atR(quintara, 1450, -11, 200)]),
    nebulas: clouds(quintara, 45, [[quintara.w / 2, quintara.h / 2, 450]]),
  },
  {
    id: 'serrat',
    name: 'Serrat Halo',
    blurb: 'Six stations on a ring round a dead heart of asteroids. Each pair of neighbours shares a beacon, so the fighting runs all the way round; a rich derelict waits in the heart.',
    ...serrat,
    spawns: all(serrat, [{ x: serrat.w / 2, y: 700 }]),
    ore: [
      ...all(serrat, [
        { x: 2880, y: 1300 },
        { x: 3920, y: 1300 },
      ]),
      ...all(serrat, [at(serrat, 1650, 0)]),
    ],
    beacons: all(serrat, [at(serrat, 2450, 30)]),
    rocks: 70,
    seed: 9127,
    wrecks: hulks(serrat, [[serrat.w / 2, serrat.h / 2, 1500]]),
    fields: patches(serrat, [
      [serrat.w / 2, serrat.h / 2, 620],
      atR(serrat, 820, 30, 320),
    ]),
    nebulas: clouds(serrat, 0, [[serrat.w / 2, serrat.h / 2, 420]]),
  },
  // --- Huge: six spawns each, laid out to play from a duel on opposite sides up to three against three ---
  {
    id: 'velkar',
    name: 'Velkar Core',
    blurb: 'Six stations round a wide open field and a rich core: six beacons ring the middle, a seventh sits in its nebula. Empty spawns leave their ore for whoever gets there first.',
    ...velkar,
    spawns: all(velkar, [{ x: velkar.w / 2, y: 700 }]),
    ore: [
      ...all(velkar, [
        { x: 3620, y: 1250 },
        { x: 4780, y: 1250 },
      ]),
      ...all(velkar, [at(velkar, 3000, 30), at(velkar, 800, 0)]),
    ],
    beacons: [mid(velkar), ...all(velkar, [at(velkar, 1900, 30)])],
    rocks: 110,
    seed: 9311,
    wrecks: hulks(velkar, [atR(velkar, 2300, 0, 600)]),
    fields: patches(velkar, [atR(velkar, 2500, 13, 230), atR(velkar, 2620, 18, 150)]),
    nebulas: clouds(velkar, 200, [[velkar.w / 2, velkar.h / 2, 520]]),
  },
  {
    id: 'draxis',
    name: 'Draxis Spiral',
    blurb: 'Six asteroid arms wind out from the middle like a pinwheel, so every road to the core curves past a neighbour. Beacons wait at the inner end of each lane and in the core.',
    ...draxis,
    spawns: all(draxis, [{ x: draxis.w / 2, y: 700 }]),
    ore: [
      ...all(draxis, [
        { x: 3420, y: 1250 },
        { x: 4580, y: 1250 },
      ]),
      ...all(draxis, [at(draxis, 2300, arm(2300) - 30), at(draxis, 3000, 30)]),
    ],
    beacons: [mid(draxis), ...all(draxis, [at(draxis, 1150, arm(1150) - 30)])],
    rocks: 100,
    seed: 9437,
    wrecks: hulks(draxis, [atR(draxis, 1600, arm(1600) + 30, 700)]),
    fields: patches(draxis, [1000, 1330, 1660, 1990, 2320, 2600].map((r, i) => atR(draxis, r, arm(r), i % 2 ? 210 : 240))),
    nebulas: clouds(draxis, 320, [[draxis.w / 2, draxis.h / 2, 500]]),
  },
  {
    id: 'tarsis',
    name: 'Tarsis Triad',
    blurb: 'Three pairs of twin stations, each pair sharing a beacon. Between the pairs lie three fronts, each a beacon in a nebula, and an open core with a seventh. Twins can fight for their beacon or stand together.',
    ...tarsis,
    spawns: all(tarsis, [at(tarsis, 3500, -TWIN)]),
    ore: [
      ...all(tarsis, [at(tarsis, 3650, -TWIN - 12.8), at(tarsis, 2700, -TWIN - 5.8), at(tarsis, 3000, -45)]),
      ...all(tarsis, [at(tarsis, 900, 60)]),
    ],
    beacons: [mid(tarsis), ...all(tarsis, [at(tarsis, 3150, 0), at(tarsis, 2500, 60)])],
    rocks: 120,
    seed: 9551,
    wrecks: hulks(tarsis, [atR(tarsis, 2000, -30, 800)]),
    fields: patches(tarsis, [atR(tarsis, 3700, 60, 320), atR(tarsis, 3600, 50, 200)]),
    nebulas: clouds(tarsis, 15, [atR(tarsis, 2500, 60, 620)]),
  },
] as MapDef[]).map((m) => spread(m))

export const MAP: Record<string, MapDef> = Object.fromEntries(MAPS.map((m) => [m.id, m]))

// --- Generated maps ------------------------------------------------------------------------------------

export type MapSize = 'small' | 'medium' | 'large'
/** How many players a generated map is for. */
export type Players = 2 | 3 | 4 | 5 | 6
export const PLAYER_COUNTS: readonly Players[] = [2, 3, 4, 5, 6]
export type Resources = 'scarce' | 'normal' | 'rich'
export type Amount = 'none' | 'few' | 'many'
export type MapRules = {
  seed: number
  players: Players
  size: MapSize
  resources: Resources
  /** How many beacons, or 'auto' for one more than there are players. Snapped to what the
   * symmetry allows (three players can't share two beacons fairly). */
  beacons: number | 'auto'
  asteroidFields: Amount
  nebulas: Amount
  /** Derelicts to salvage. */
  wrecks: Amount
}

/** The lobby's map id for the generator; the rules travel alongside it. */
export const GENERATED = 'generated'
export const MAX_SEED = 999999
export const MAX_BEACONS = 9
export const DEFAULT_RULES: MapRules = { seed: 1, players: 2, size: 'medium', resources: 'normal', beacons: 'auto', asteroidFields: 'few', nebulas: 'few', wrecks: 'few' }

const pick = <T,>(v: unknown, ok: readonly T[], fallback: T): T => (ok.includes(v as T) ? (v as T) : fallback)
/** Rules read back from storage, with anything missing or broken replaced by the default. */
export function cleanRules(v: unknown): MapRules {
  const r = (v && typeof v === 'object' ? v : {}) as Partial<Record<keyof MapRules, unknown>>
  const d = DEFAULT_RULES
  const seed = typeof r.seed === 'number' && Number.isFinite(r.seed) ? Math.min(MAX_SEED, Math.max(0, Math.floor(r.seed))) : d.seed
  const beacons = r.beacons === 'auto' ? 'auto' : typeof r.beacons === 'number' && Number.isFinite(r.beacons) ? Math.min(MAX_BEACONS, Math.max(0, Math.floor(r.beacons))) : d.beacons
  return {
    seed,
    players: pick(r.players, PLAYER_COUNTS, d.players),
    size: pick(r.size, ['small', 'medium', 'large'] as const, d.size),
    resources: pick(r.resources, ['scarce', 'normal', 'rich'] as const, d.resources),
    beacons,
    asteroidFields: pick(r.asteroidFields, ['none', 'few', 'many'] as const, d.asteroidFields),
    nebulas: pick(r.nebulas, ['none', 'few', 'many'] as const, d.nebulas),
    wrecks: pick(r.wrecks, ['none', 'few', 'many'] as const, d.wrecks),
  }
}

const DIMS: Record<Players, Record<MapSize, [number, number]>> = {
  2: { small: [4600, 2900], medium: [5600, 3400], large: [6800, 4100] },
  3: { small: [5000, 5000], medium: [5800, 5800], large: [6800, 6800] },
  4: { small: [5600, 3800], medium: [6600, 4400], large: [7800, 5200] },
  // Turned round the middle like three, with a ring big enough for the stations not to crowd.
  5: { small: [5800, 5800], medium: [6600, 6600], large: [7600, 7600] },
  6: { small: [6200, 6200], medium: [7000, 7000], large: [8000, 8000] },
}
const ORE_PER_PLAYER: Record<Resources, number> = { scarce: 2, normal: 4, rich: 6 }
const NAME_A = ['Kel', 'Orun', 'Vesh', 'Tarn', 'Ilos', 'Myrr', 'Dath', 'Sorre', 'Quell', 'Ashen', 'Brin', 'Corva', 'Ytha', 'Mordu', 'Saren', 'Zeel']
const NAME_B = ['Expanse', 'Reach', 'Drift', 'Verge', 'Shoals', 'Hollow', 'Span', 'Deep', 'Marches', 'Rift', 'Narrows', 'Cradle']
const NEBULA_HUES = [285, 190, 330, 25, 160, 240]

/**
 * A map built from rules and a seed: the same rules and seed always give the same map. Everything
 * is placed for the first player and copied to the others by the symmetry (point for two players,
 * four-way mirror for four, and for three, five and six a turn round the middle), so every spawn
 * gets the same ore, beacons and terrain around it.
 *
 * Each step draws from its own random stream, so turning nebulas up or down leaves the ore where
 * it was. Placement retries with looser spacing if a crowded map runs out of room, and gives up on
 * a piece after a while rather than looping forever.
 */
export function generateMap(rules: MapRules): MapDef {
  const R = cleanRules(rules)
  const n = R.players
  const [w, h] = DIMS[n][R.size]
  const sym: Symmetry = n === 2 ? 'point' : n === 3 ? 'tri' : n === 4 ? 'quad' : n === 5 ? 'penta' : 'hex'
  /** Turned round the middle: three, five or six. */
  const turned = n === 3 || n >= 5
  const m: Shape = { w, h, sym }
  const c = { x: w / 2, y: h / 2 }
  const stream = (k: number) => rng(R.seed * 7919 + n * 104729 + k * 15485863)
  const scale = Math.sqrt((w * h) / (5600 * 3400))

  // Spawns: near the edge (or the corners), nudged a little so seeds differ.
  const rs = stream(1)
  const s0 =
    n === 2 ? { x: 600 + rs() * 250, y: h / 2 + (rs() - 0.5) * h * 0.4 } : turned ? rot({ x: c.x, y: 650 }, c, (rs() - 0.5) * 0.5) : { x: 650 + rs() * 250, y: 600 + rs() * 200 }
  const spawns = mirrored(m, s0)
  const inBounds = (p: Pt, margin: number) => p.x > margin && p.y > margin && p.x < w - margin && p.y < h - margin
  const toCentre = M.atan2(c.y - s0.y, c.x - s0.x)
  const reach = dist(s0, c)

  /** Tries random spots from `gen` until `ok` accepts all copies, relaxing `ok` as tries run out. */
  const place = (gen: () => Pt, ok: (ps: Pt[], slack: number) => boolean, tries = 500): Pt[] | null => {
    for (let i = 0; i < tries; i++) {
      const ps = copies(m, gen())
      if (ok(ps, 1 - (0.4 * i) / tries)) return ps
    }
    return null
  }

  // Ore: one close to home, the rest further out towards the middle.
  const ro = stream(2)
  const ore: Pt[] = []
  const homeOre: Pt[] = []
  for (let k = 0; k < ORE_PER_PLAYER[R.resources]; k++) {
    const got = place(
      () => {
        const d = k === 0 ? 800 + ro() * 300 : 1050 + ro() * (reach * 1.05 - 1050)
        const a = toCentre + (ro() - 0.5) * (k === 0 ? 2.2 : 3)
        return { x: s0.x + M.cos(a) * d, y: s0.y + M.sin(a) * d }
      },
      (ps, k2) =>
        ps.length === n &&
        // Off the middle, where a beacon or a big nebula may go.
        ps.every((p) => inBounds(p, 350) && dist(p, c) > 760 && spawns.every((s) => dist(p, s) > 720) && ore.every((o) => dist(p, o) > 700 * k2)) &&
        ps.every((p, i) => ps.every((q, j) => i === j || dist(p, q) > 700 * k2)),
    )
    if (!got) continue
    ore.push(...got)
    if (k === 0) homeOre.push(...got)
  }

  // Beacons: the middle when the count calls for it, then groups of one per player, and on four
  // player maps pairs on the mirror lines (each pair is shared by two neighbours).
  const rb = stream(3)
  const auto = n + 1
  let want = Math.min(MAX_BEACONS, R.beacons === 'auto' ? auto : R.beacons)
  // Turned maps take beacons in groups of one each, and maybe the middle: two can't be split fairly
  // between three, so round down.
  if (turned && want % n > 1) want -= (want % n) - 1
  const centre = turned ? want % n === 1 : want % 2 === 1
  const beacons: Pt[] = centre ? [{ ...c }] : []
  const beaconOk = (ps: Pt[], k: number) =>
    ps.every((p) => inBounds(p, 420) && spawns.every((s) => dist(p, s) > 1300 * k) && beacons.every((b) => dist(p, b) > 1000 * k) && ore.every((o) => dist(p, o) > 720 * k)) &&
    ps.every((p, i) => ps.every((q, j) => i === j || dist(p, q) > 1000 * k))
  let left = want - beacons.length
  while (left >= n) {
    const got = place(() => ({ x: 400 + rb() * (w - 800), y: 400 + rb() * (h - 800) }), (ps, k) => ps.length === n && beaconOk(ps, k))
    left -= n
    if (got) beacons.push(...got)
  }
  if (n === 4)
    while (left >= 2) {
      // On a mirror line: (middle, y) or (x, middle), which the symmetry turns into a pair.
      const vertical = rb() < 0.5
      const got = place(
        () => (vertical ? { x: c.x, y: 420 + rb() * (c.y - 1000) } : { x: 420 + rb() * (c.x - 1000), y: c.y }),
        (ps, k) => ps.length === 2 && beaconOk(ps, k),
      )
      left -= 2
      if (got) beacons.push(...got)
    }

  // Terrain: blobs of a few overlapping patches, every copy checked against everything placed.
  const blob = (r: () => number, at: Pt, size: number): Patch[] => {
    const out: Patch[] = [{ ...at, r: size }]
    const lobes = 1 + Math.floor(r() * 3)
    for (let i = 0; i < lobes; i++) {
      const a = r() * Math.PI * 2
      const d = size * (0.55 + r() * 0.35)
      out.push({ x: at.x + M.cos(a) * d, y: at.y + M.sin(a) * d, r: size * (0.45 + r() * 0.3) })
    }
    return out
  }
  /** Places `groups` blobs; `clear` says whether one patch keeps far enough from everything, with
   * `k` easing from 1 towards 0.6 (and the blobs shrinking) as tries run out on a crowded map. A
   * blob's copies may run into each other (near the middle or a mirror line): that just makes one
   * bigger blob, still the same from every side. */
  const scatter = (r: () => number, groups: number, size: () => number, clear: (p: Patch, placed: Patch[], k: number) => boolean): Patch[][] => {
    const placed: Patch[][] = []
    const tries = 500
    for (let g = 0; g < groups; g++) {
      for (let i = 0; i < tries; i++) {
        const k = 1 - (0.4 * i) / tries
        const shape = blob(r, { x: 300 + r() * (w - 600), y: 300 + r() * (h - 600) }, size() * (0.5 + 0.5 * k))
        const flat = shape.flatMap((p) => copies(m, p).map((q) => ({ ...q, r: p.r })))
        const others = placed.flat()
        if (!flat.every((p) => inBounds(p, p.r * 0.4) && clear(p, others, k))) continue
        placed.push(flat)
        break
      }
    }
    return placed
  }
  const groupsFor = (a: Amount, r: () => number) => (a === 'none' ? 0 : a === 'few' ? 1 : n === 2 ? 3 : 2 + Math.floor(r() * 2))

  // Nebulas first: they're the big ones and need the room.
  const rn = stream(5)
  const nebulaGroups = groupsFor(R.nebulas, rn)
  const hueAt = Math.floor(rn() * NEBULA_HUES.length)
  const nebulas: Nebula[] = []
  // A big cloud over the middle now and then, when there's plenty of nebula about.
  if (R.nebulas === 'many' && rn() < 0.5) {
    const r = (380 + rn() * 160) * scale
    if (spawns.every((s) => dist(c, s) > 1300 + r)) nebulas.push({ ...c, r, hue: NEBULA_HUES[hueAt] })
  }
  scatter(rn, nebulaGroups, () => (320 + rn() * 200) * scale, (p, placed, k) =>
    spawns.every((s) => dist(p, s) > 1300 + p.r) &&
    homeOre.every((o) => dist(p, o) > (420 + p.r) * k) &&
    nebulas.every((q) => dist(p, q) > p.r + q.r + 100) &&
    placed.every((q) => dist(p, q) > p.r + q.r + 100),
  ).forEach((g, i) => nebulas.push(...g.map((p) => ({ ...p, hue: NEBULA_HUES[(hueAt + i + 1) % NEBULA_HUES.length] }))))

  // Fields keep out of the nebulas while there's room: one hazard at a time reads better.
  const rf = stream(4)
  const fields = scatter(rf, groupsFor(R.asteroidFields, rf), () => (200 + rf() * 140) * scale, (p, placed, k) =>
    spawns.every((s) => dist(p, s) > 950 + p.r) &&
    ore.every((o) => dist(p, o) > 420 * k + p.r) &&
    beacons.every((b) => dist(p, b) > 380 * k + p.r) &&
    (k < 0.75 || nebulas.every((q) => dist(p, q) > p.r + q.r + 100)) &&
    placed.every((q) => dist(p, q) > p.r + q.r + 150 * k),
  ).flat()

  // Wrecks: one or two per player out in the open, worth a detour for a scout.
  const rw = stream(6)
  const wrecks: Wreckage[] = []
  const hulkCount = R.wrecks === 'none' ? 0 : R.wrecks === 'few' ? 1 : 2
  for (let g = 0; g < hulkCount; g++) {
    for (let i = 0; i < 400; i++) {
      const p = { x: 300 + rw() * (w - 600), y: 300 + rw() * (h - 600) }
      const set = copies(m, p)
      const ok = set.every(
        (q) =>
          inBounds(q, 200) &&
          spawns.every((s) => dist(q, s) > 1000) &&
          ore.every((o) => dist(q, o) > 320) &&
          beacons.every((b) => dist(q, b) > 380) &&
          fields.every((f) => dist(q, f) > f.r + 120) &&
          wrecks.every((x) => dist(q, x) > 700),
      ) && set.every((q, k) => set.every((o, j) => j === k || dist(q, o) > 600))
      if (!ok) continue
      const value = Math.round((500 + rw() * 700) / 50) * 50
      wrecks.push(...set.map((q) => ({ ...q, value })))
      break
    }
  }

  const nm = rng(Math.imul(R.seed + 17, 0x9e3779b1))
  const name = `${NAME_A[Math.floor(nm() * NAME_A.length)]} ${NAME_B[Math.floor(nm() * NAME_B.length)]}`
  const sizeName = { small: 'Small', medium: 'Medium', large: 'Large' }[R.size]
  const oreName = { scarce: 'scarce', normal: 'steady', rich: 'rich' }[R.resources]
  return spread({
    id: `gen-${n}-${R.size}-${R.resources}-${R.beacons}-${R.asteroidFields}-${R.nebulas}-${R.wrecks}-${R.seed}`,
    name,
    blurb: `${sizeName} generated map for ${n} players with ${oreName} ore. Seed ${R.seed}.`,
    w, h, sym, spawns, ore, beacons,
    rocks: Math.round(((w * h) / 1e6) * 2.3),
    seed: R.seed,
    fields,
    nebulas,
    wrecks,
  })
}
