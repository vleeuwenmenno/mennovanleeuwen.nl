// The battlefields. Each map lists its spawn points, ore, beacons and terrain, and how it is
// symmetric, so everything can be placed once and copied to every player's side: nobody gets the
// better lanes. No DOM, so the headless sims load this too.

export type Pt = { x: number; y: number }
export type Symmetry = 'point' | 'quad' | 'tri'
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
}

/** Whether a point is inside any of the patches (grown by `pad`). */
export const inside = (ps: Patch[], x: number, y: number, pad = 0) => ps.some((p) => (x - p.x) ** 2 + (y - p.y) ** 2 < (p.r + pad) ** 2)

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
  const s = Math.sin(a)
  const co = Math.cos(a)
  return { x: c.x + (p.x - c.x) * co - (p.y - c.y) * s, y: c.y + (p.x - c.x) * s + (p.y - c.y) * co }
}
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)

type Shape = { w: number; h: number; sym: Symmetry }

/** Every copy of a point under a map's symmetry, the point itself first. */
export function mirrored(m: Shape, p: Pt): Pt[] {
  const { w, h } = m
  if (m.sym === 'point') return [p, { x: w - p.x, y: h - p.y }]
  if (m.sym === 'quad') return [p, { x: w - p.x, y: p.y }, { x: p.x, y: h - p.y }, { x: w - p.x, y: h - p.y }]
  const c = { x: w / 2, y: h / 2 }
  return [p, rot(p, c, (Math.PI * 2) / 3), rot(p, c, (Math.PI * 4) / 3)]
}

/** The distinct copies of a point: a point on a mirror line or in the middle is its own copy. */
const copies = (m: Shape, p: Pt) => mirrored(m, p).filter((q, i, all) => all.findIndex((o) => dist(o, q) < 1) === i)

const all = (m: Shape, pts: Pt[]) => pts.flatMap((p) => copies(m, p))
/** Terrain patches given as [x, y, r], copied to every side. */
const patches = (m: Shape, ps: [number, number, number][]): Patch[] => ps.flatMap(([x, y, r]) => copies(m, { x, y }).map((p) => ({ ...p, r })))
const clouds = (m: Shape, hue: number, ps: [number, number, number][]): Nebula[] => patches(m, ps).map((p) => ({ ...p, hue }))

// --- The maps ---------------------------------------------------------------------------------------

const kessar = { w: 5600, h: 3400, sym: 'point' as const }
const trinity = { w: 5800, h: 5800, sym: 'tri' as const }
const vanth = { w: 6600, h: 4400, sym: 'quad' as const }
const tc = { x: trinity.w / 2, y: trinity.h / 2 }

export const MAPS: MapDef[] = [
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
    fields: patches(vanth, [
      [2580, 700, 230],
      [2420, 820, 150],
    ]),
    nebulas: [],
  },
]

export const MAP: Record<string, MapDef> = Object.fromEntries(MAPS.map((m) => [m.id, m]))
