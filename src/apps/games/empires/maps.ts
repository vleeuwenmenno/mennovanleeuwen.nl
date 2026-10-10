// The battlefields. Each map lists its spawn points, ore, beacons and terrain, and how it is
// symmetric, so everything can be placed once and copied to every player's side: nobody gets the
// better lanes. Besides the fixed maps there's a generator that builds a fair map from a few rules
// and a seed. No DOM, so the headless sims load this too.

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
const cinder = { w: 4400, h: 2800, sym: 'point' as const }
const reefs = { w: 6200, h: 4200, sym: 'quad' as const }
const shroud = { w: 6000, h: 6000, sym: 'tri' as const }
const tc = { x: trinity.w / 2, y: trinity.h / 2 }
const sc = { x: shroud.w / 2, y: shroud.h / 2 }

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
]

export const MAP: Record<string, MapDef> = Object.fromEntries(MAPS.map((m) => [m.id, m]))

// --- Generated maps ------------------------------------------------------------------------------------

export type MapSize = 'small' | 'medium' | 'large'
export type Resources = 'scarce' | 'normal' | 'rich'
export type Amount = 'none' | 'few' | 'many'
export type MapRules = {
  seed: number
  players: 2 | 3 | 4
  size: MapSize
  resources: Resources
  /** How many beacons, or 'auto' for one more than there are players. Snapped to what the
   * symmetry allows (three players can't share two beacons fairly). */
  beacons: number | 'auto'
  asteroidFields: Amount
  nebulas: Amount
}

/** The lobby's map id for the generator; the rules travel alongside it. */
export const GENERATED = 'generated'
export const MAX_SEED = 999999
export const MAX_BEACONS = 9
export const DEFAULT_RULES: MapRules = { seed: 1, players: 2, size: 'medium', resources: 'normal', beacons: 'auto', asteroidFields: 'few', nebulas: 'few' }

const pick = <T,>(v: unknown, ok: readonly T[], fallback: T): T => (ok.includes(v as T) ? (v as T) : fallback)
/** Rules read back from storage, with anything missing or broken replaced by the default. */
export function cleanRules(v: unknown): MapRules {
  const r = (v && typeof v === 'object' ? v : {}) as Partial<Record<keyof MapRules, unknown>>
  const d = DEFAULT_RULES
  const seed = typeof r.seed === 'number' && Number.isFinite(r.seed) ? Math.min(MAX_SEED, Math.max(0, Math.floor(r.seed))) : d.seed
  const beacons = r.beacons === 'auto' ? 'auto' : typeof r.beacons === 'number' && Number.isFinite(r.beacons) ? Math.min(MAX_BEACONS, Math.max(0, Math.floor(r.beacons))) : d.beacons
  return {
    seed,
    players: pick(r.players, [2, 3, 4] as const, d.players),
    size: pick(r.size, ['small', 'medium', 'large'] as const, d.size),
    resources: pick(r.resources, ['scarce', 'normal', 'rich'] as const, d.resources),
    beacons,
    asteroidFields: pick(r.asteroidFields, ['none', 'few', 'many'] as const, d.asteroidFields),
    nebulas: pick(r.nebulas, ['none', 'few', 'many'] as const, d.nebulas),
  }
}

const DIMS: Record<2 | 3 | 4, Record<MapSize, [number, number]>> = {
  2: { small: [4600, 2900], medium: [5600, 3400], large: [6800, 4100] },
  3: { small: [5000, 5000], medium: [5800, 5800], large: [6800, 6800] },
  4: { small: [5600, 3800], medium: [6600, 4400], large: [7800, 5200] },
}
const ORE_PER_PLAYER: Record<Resources, number> = { scarce: 2, normal: 4, rich: 6 }
const NAME_A = ['Kel', 'Orun', 'Vesh', 'Tarn', 'Ilos', 'Myrr', 'Dath', 'Sorre', 'Quell', 'Ashen', 'Brin', 'Corva', 'Ytha', 'Mordu', 'Saren', 'Zeel']
const NAME_B = ['Expanse', 'Reach', 'Drift', 'Verge', 'Shoals', 'Hollow', 'Span', 'Deep', 'Marches', 'Rift', 'Narrows', 'Cradle']
const NEBULA_HUES = [285, 190, 330, 25, 160, 240]

/**
 * A map built from rules and a seed: the same rules and seed always give the same map. Everything
 * is placed for the first player and copied to the others by the symmetry (point for two players,
 * three-way rotation for three, four-way mirror for four), so every spawn gets the same ore,
 * beacons and terrain around it.
 *
 * Each step draws from its own random stream, so turning nebulas up or down leaves the ore where
 * it was. Placement retries with looser spacing if a crowded map runs out of room, and gives up on
 * a piece after a while rather than looping forever.
 */
export function generateMap(rules: MapRules): MapDef {
  const R = cleanRules(rules)
  const n = R.players
  const [w, h] = DIMS[n][R.size]
  const sym: Symmetry = n === 2 ? 'point' : n === 3 ? 'tri' : 'quad'
  const m: Shape = { w, h, sym }
  const c = { x: w / 2, y: h / 2 }
  const stream = (k: number) => rng(R.seed * 7919 + n * 104729 + k * 15485863)
  const scale = Math.sqrt((w * h) / (5600 * 3400))

  // Spawns: near the edge (or the corners), nudged a little so seeds differ.
  const rs = stream(1)
  const s0 =
    n === 2 ? { x: 600 + rs() * 250, y: h / 2 + (rs() - 0.5) * h * 0.4 } : n === 3 ? rot({ x: c.x, y: 650 }, c, (rs() - 0.5) * 0.5) : { x: 650 + rs() * 250, y: 600 + rs() * 200 }
  const spawns = mirrored(m, s0)
  const inBounds = (p: Pt, margin: number) => p.x > margin && p.y > margin && p.x < w - margin && p.y < h - margin
  const toCentre = Math.atan2(c.y - s0.y, c.x - s0.x)
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
        return { x: s0.x + Math.cos(a) * d, y: s0.y + Math.sin(a) * d }
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
  if (n === 3 && want % 3 === 2) want-- // Two can't be split fairly between three; round down.
  const centre = n === 3 ? want % 3 === 1 : want % 2 === 1
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
      out.push({ x: at.x + Math.cos(a) * d, y: at.y + Math.sin(a) * d, r: size * (0.45 + r() * 0.3) })
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

  const nm = rng(Math.imul(R.seed + 17, 0x9e3779b1))
  const name = `${NAME_A[Math.floor(nm() * NAME_A.length)]} ${NAME_B[Math.floor(nm() * NAME_B.length)]}`
  const sizeName = { small: 'Small', medium: 'Medium', large: 'Large' }[R.size]
  const oreName = { scarce: 'scarce', normal: 'steady', rich: 'rich' }[R.resources]
  return {
    id: `gen-${n}-${R.size}-${R.resources}-${R.beacons}-${R.asteroidFields}-${R.nebulas}-${R.seed}`,
    name,
    blurb: `${sizeName} generated map for ${n} players with ${oreName} ore. Seed ${R.seed}.`,
    w, h, sym, spawns, ore, beacons,
    rocks: Math.round(((w * h) / 1e6) * 2.3),
    seed: R.seed,
    fields,
    nebulas,
  }
}
