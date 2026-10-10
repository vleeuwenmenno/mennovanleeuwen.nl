// The battlefields. Each map lists its spawn points, ore and beacons, and how it is symmetric, so
// asteroid fields can be scattered once and copied to every player's side: nobody gets the better
// lanes. No DOM, so the headless sims load this too.

export type Pt = { x: number; y: number }
export type Symmetry = 'point' | 'quad' | 'tri'

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
  /** Seeds the asteroid fields, so a map always looks the same. */
  seed: number
}

const rot = (p: Pt, c: Pt, a: number): Pt => {
  const s = Math.sin(a)
  const co = Math.cos(a)
  return { x: c.x + (p.x - c.x) * co - (p.y - c.y) * s, y: c.y + (p.x - c.x) * s + (p.y - c.y) * co }
}

/** Every copy of a point under a map's symmetry, the point itself first. */
export function mirrored(m: { w: number; h: number; sym: Symmetry }, p: Pt): Pt[] {
  const { w, h } = m
  if (m.sym === 'point') return [p, { x: w - p.x, y: h - p.y }]
  if (m.sym === 'quad') return [p, { x: w - p.x, y: p.y }, { x: p.x, y: h - p.y }, { x: w - p.x, y: h - p.y }]
  const c = { x: w / 2, y: h / 2 }
  return [p, rot(p, c, (Math.PI * 2) / 3), rot(p, c, (Math.PI * 4) / 3)]
}

const all = (m: { w: number; h: number; sym: Symmetry }, pts: Pt[]) => pts.flatMap((p) => mirrored(m, p))

// --- The maps ---------------------------------------------------------------------------------------

const kessar = { w: 5600, h: 3400, sym: 'point' as const }
const trinity = { w: 5800, h: 5800, sym: 'tri' as const }
const vanth = { w: 6600, h: 4400, sym: 'quad' as const }
const tc = { x: trinity.w / 2, y: trinity.h / 2 }

export const MAPS: MapDef[] = [
  {
    id: 'kessar',
    name: 'Kessar Belt',
    blurb: 'A long belt between two stations, three beacons down the middle. The classic duel.',
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
  },
  {
    id: 'trinity',
    name: 'Trinity Rift',
    blurb: 'Three stations around a contested core. Two against one, or a duel with an empty corner.',
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
  },
  {
    id: 'vanth',
    name: 'Vanth Crossing',
    blurb: 'Four corners, five beacons. Two against two, three against one, or anything in between.',
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
  },
]

export const MAP: Record<string, MapDef> = Object.fromEntries(MAPS.map((m) => [m.id, m]))
