// Galactic conquest: a galaxy of star systems joined by hyperlanes, each with a star and a few
// planets. Planets pay their owner every day, planets with a station build ships, and fleets fly
// between planets: inside a system, or across the lanes to another one. A fleet arriving where an
// enemy fleet or station is starts a fleet battle (played in the battle view, or auto-resolved);
// an undefended planet is taken by staying in its orbit for a while. The galaxy runs in real time,
// in seconds; a day is DAY seconds. No DOM, so headless sims can load it.

import { PROFILES, PROFILE_IDS, type Difficulty, type Profile } from './ai.ts'
import {
  FACTIONS, MODULE, MODULE_FX, REBUILD, UNIT, WORKS_NAME, buildable, builtAt, needsModule, stationType, unitOf, yardOf, yardType,
  type FactionId, type ModuleId, type Tier, type UnitType, type Works,
} from './data.ts'
import { rng } from './maps.ts'
import { dpsVs } from './sim.ts'

export type PlanetKind = 'desert' | 'ice' | 'lava' | 'ocean' | 'jungle' | 'city' | 'gas' | 'barren' | 'icegiant' | 'stormgiant' | 'toxic' | 'swamp' | 'crystal' | 'tundra'
/** Gas giants: big, and their clouds fill a battle over them with nebulas. */
export const GIANTS: PlanetKind[] = ['gas', 'icegiant', 'stormgiant']
export type StarKind = 'yellow' | 'orange' | 'red' | 'white' | 'blue'

export const PLANET_KINDS: Record<PlanetKind, { name: string; income: number; blurb: string }> = {
  city: { name: 'City world', income: 120, blurb: 'One planet-wide city: rich in taxes and trade.' },
  crystal: { name: 'Crystal world', income: 100, blurb: 'Rare crystals for lenses, lasers and shield generators.' },
  stormgiant: { name: 'Storm giant', income: 95, blurb: 'A violent gas giant: rich in exotic gases, deadly to mine.' },
  gas: { name: 'Gas giant', income: 90, blurb: 'Gas mines skim fuel from its upper clouds.' },
  icegiant: { name: 'Ice giant', income: 85, blurb: 'Cold gas giant: its haulers carry frozen fuel and coolant.' },
  jungle: { name: 'Jungle world', income: 80, blurb: 'Dense forests, farms and rare medicines.' },
  ocean: { name: 'Ocean world', income: 80, blurb: 'Floating cities over endless seas.' },
  lava: { name: 'Volcanic world', income: 70, blurb: 'Molten ore, mined at great cost.' },
  toxic: { name: 'Toxic world', income: 65, blurb: 'Acid seas and poison clouds, refined into chemicals.' },
  desert: { name: 'Desert world', income: 60, blurb: 'Dry, dusty and full of smugglers.' },
  swamp: { name: 'Swamp world', income: 55, blurb: 'Fog-bound marshes, rich soil and rare herbs.' },
  ice: { name: 'Ice world', income: 50, blurb: 'Frozen outposts and buried minerals.' },
  tundra: { name: 'Tundra world', income: 45, blurb: 'Cold plains, timber and hardy colonists.' },
  barren: { name: 'Barren rock', income: 40, blurb: 'Airless rock with a mining colony or two.' },
}
export const STAR_COLOR: Record<StarKind, string> = { yellow: '#ffe28a', orange: '#ffb066', red: '#ff7a5c', white: '#eef4ff', blue: '#8fc4ff' }

/** Seconds in a galaxy day: planets pay their owner at the end of each one. A week is WEEK days. */
export const DAY = 10
export const WEEK = 6
/** Each station level makes its planet a busier port: this much more income per level. */
export const STATION_INCOME = 0.1
/** Seconds a fleet takes per unit of lane length (a typical lane takes about 20 s), and to fly
 * between planets of one system. */
export const LANE_PACE = 1 / 8
export const ORBIT_HOP = 4
/** Seconds a fleet must hold an undefended planet's orbit to take it. */
export const CAPTURE_TIME = 8
export const MAX_YARD = 5
/** Station building and upgrades: the price and seconds to reach each level (index = level). */
export const STATION_COST = [0, 1200, 1900, 2900, 4200]
export const STATION_TIME = [0, 30, 40, 50, 60]
export const SHIP_TIME = 1.5
/** Yards and expansions take their skirmish build time (data.ts) times this on the galaxy clock, as
 * ships do: a Frigate Yard goes up in about the time of a station upgrade. */
export const WORKS_TIME = SHIP_TIME

/** The yards a planet can have round its Command Station (hybrid bases: data.ts, Yards). */
export type YardKind = 'yard' | 'cyard'
export const YARD_KINDS: YardKind[] = ['yard', 'cyard']
/**
 * What a planet has built round its station, as in a skirmish with hybrid bases but without
 * engineers: its yards, each standing ('up') or a ruin a battle left (rebuilt for REBUILD of its
 * price), and the expansions standing on the station and its yards (MODULE[id].on says which). The
 * Frigate Yard builds the planet's frigates and corvettes, the Capital Yard its cruisers, and with a
 * Capital slip its flagships; bombers need the station's Strike hangar. Everything is ordered in
 * the planet's queue, with a price and a build time, like a station upgrade.
 */
export type PlanetBase = { yards: Partial<Record<YardKind, 'up' | 'ruin'>>; mods: ModuleId[] }
/** A yard or an expansion: what a planet's Buildings tab orders (a station level is 'station'). */
export type WorkId = YardKind | ModuleId
export const emptyBase = (): PlanetBase => ({ yards: {}, mods: [] })
export const copyBase = (b: PlanetBase | undefined): PlanetBase => ({ yards: { ...(b?.yards ?? {}) }, mods: [...(b?.mods ?? [])] })
export const isYard = (id: string): id is YardKind => id === 'yard' || id === 'cyard'
export const isModule = (id: string): id is ModuleId => Object.hasOwn(MODULE, id)
/** Whether a queue entry is work on the planet's buildings (a station level, a yard, an expansion)
 * rather than a ship. */
export const isWork = (unit: string) => unit === 'station' || isYard(unit) || isModule(unit)

export type Planet = {
  id: number
  system: number
  name: string
  kind: PlanetKind
  /** Orbit ring (0 innermost) and where on it, for the system view. */
  orbit: number
  angle: number
  size: number
  owner: number
  station: number
  /** Its yards and expansions (see PlanetBase). */
  base: PlanetBase
  /** Credits a day before the station's bonus: its kind's, varied a little per planet. */
  income: number
  /** Credits it has paid its current owner since they took it. */
  earned: number
  /** Ships (or a station level: 'station', a yard or an expansion: its WorkId) being built here,
   * first one in progress (the first two ships with a Second slip). A finished ship waits on its
   * slip (`full`) while every fleet here is full and there are MAX_FLEETS of them. `paid`: what a
   * yard or an expansion cost when it was queued (a ruin's rebuild is cheaper), for a refund. */
  queue: { unit: string; left: number; total: number; full?: boolean; paid?: number }[]
  /** Who is taking it, and how far along (seconds). */
  capture: { owner: number; t: number } | null
}
export type StarSystem = { id: number; name: string; x: number; y: number; star: StarKind; planets: number[] }
export type Hop = { system: number; planet: number; total: number }
export type Fleet = {
  id: number
  owner: number
  /** Its ships as a flat list of unit ids (biggest first), kept in step with `items` by `sync`. */
  ships: string[]
  /** Its ships laid out on the fleet's grid (see the fleet inventory below). */
  items: Item[]
  /** The planet it orbits, or -1 while it's flying. */
  planet: number
  /** The system it's in or last left, and the planet it last orbited (retreats go back there). */
  system: number
  from: number
  /** The flight in progress (from `system` to hop.system), then the rest of the route. */
  leg: (Hop & { left: number }) | null
  route: Hop[]
  /** Planets queued (Shift) to go on to, in order, once it's where it's going: at each one that
   * isn't its side's yet it stays to fight and take it first. */
  waypoints?: number[]
  /** When it arrived where it is: the first fleet at a neutral planet holds it in a battle. */
  arrived: number
  /** Saves from before the grid only: ships held back, by type (now each item says so itself). */
  reserve?: Record<string, number>
  /** The fleet it was sent to join up with (Gather): the two become one once both are at the same
   * planet. */
  join?: number
}

/** The most fleets a side keeps at one planet: more that end up there join up where they fit, and
 * no new fleet is made there past it (see capFleets). */
export const MAX_FLEETS = 4
export type Side = {
  faction: FactionId
  credits: number
  ai: Difficulty | null
  alive: boolean
  /** Totals this campaign: paid in by planets, spent on ships and stations (cancellations refunded). */
  earned: number
  spent: { ships: number; stations: number }
  /** Credits and income at the end of every day, for the economy chart. */
  history: { day: number; credits: number; income: number }[]
  /** The latest money in and out, newest last. */
  ledger: { day: number; amount: number; what: string }[]
  /** An AI side's plans and memory (see galaxyAi). */
  mind?: GalaxyMind
  /** Which systems it sees right now (by system id), worked out every tick (see updateSight). */
  sight?: boolean[]
  /** What it last saw of every planet (by planet id): kept for the systems it doesn't see now. */
  intel?: Intel[]
}
const LEDGER = 30
export type GalaxyEvent =
  | { k: 'captured'; planet: number; owner: number; from: number }
  | { k: 'built'; planet: number; owner: number; unit: string }
  | { k: 'station'; planet: number; owner: number; level: number }
  | { k: 'arrived'; fleet: number; planet: number; owner: number }
  | { k: 'battle'; planet: number; owners: number[]; auto: boolean; winner?: number }
  | { k: 'out'; owner: number }
  | { k: 'payday'; owner: number; amount: number; day: number }
  | { k: 'blockaded'; fleet: number; owner: number; system: number; by: number }
  | { k: 'capturing'; planet: number; owner: number; from: number }
  | { k: 'yardFull'; planet: number; owner: number; unit: string }
  | { k: 'works'; planet: number; owner: number; what: WorkId }

export type Galaxy = {
  /** 2 since planets have buildings (yards and expansions); 1 before (see clean). */
  v: 2
  /** The save slot it lives in, and the name the player gave it. */
  save: { id: string; name: string }
  name: string
  seed: number
  size: GalaxySize
  time: number
  systems: StarSystem[]
  planets: Planet[]
  lanes: [number, number][]
  fleets: Fleet[]
  sides: Side[]
  nextId: number
  /** The winning side, or -1. */
  winner: number
  /** A battle the player is in, waiting for their choice; the galaxy holds still meanwhile. */
  pending: number
  events: GalaxyEvent[]
  aiT: number[]
  rules: { blockade: BlockadeRule; frontline: boolean }
}

export type GalaxySize = 'short' | 'standard' | 'long'

/**
 * Blockades: which systems an enemy fleet can't fly through (it can still fly into them, to attack).
 * `majority`: a system where the other side holds more planets than the fleet's side; `full`: only
 * a system where the other side holds every planet; `off`: fleets fly through anything.
 */
export type BlockadeRule = 'majority' | 'full' | 'off'
export const BLOCKADES: Record<BlockadeRule, { label: string; blurb: string }> = {
  majority: { label: 'Majority', blurb: 'A system blocks enemy fleets passing through when its holder has more planets there than they do.' },
  full: { label: 'Full systems', blurb: 'Only a system where one side holds every planet blocks the other side\'s fleets.' },
  off: { label: 'Off', blurb: 'Fleets fly through any system.' },
}
export const SIZES: Record<GalaxySize, { label: string; systems: number; blurb: string }> = {
  short: { label: 'Short', systems: 10, blurb: 'About 10 systems: an evening' },
  standard: { label: 'Standard', systems: 18, blurb: 'About 18 systems' },
  long: { label: 'Long', systems: 26, blurb: 'About 26 systems: a long campaign' },
}

// --- The handcrafted galaxy ------------------------------------------------------------------------

type SystemDef = { name: string; x: number; y: number; star: StarKind; tier: 1 | 2 | 3; planets: [string, PlanetKind][] }

/**
 * The Rim Wars: Republic core worlds in the west, the Confederacy's foundry worlds in the far east,
 * contested trade worlds between. Names lean on the war that inspired it without copying it.
 * Tier 1 systems make the short galaxy, tiers 1-2 the standard one, all of them the long one.
 */
const RIM_WARS: SystemDef[] = [
  { name: 'Corvanis', x: 190, y: 290, star: 'yellow', tier: 1, planets: [['Corvanis Prime', 'city'], ['Corvanis Minor', 'barren']] },
  { name: 'Kuvaar', x: 120, y: 180, star: 'white', tier: 1, planets: [['Kuvaar', 'city'], ['Kuvaar Drift', 'gas']] },
  { name: 'Corellis', x: 110, y: 400, star: 'yellow', tier: 1, planets: [['Corellis', 'city'], ['Drall', 'barren']] },
  { name: 'Naboa', x: 360, y: 300, star: 'yellow', tier: 1, planets: [['Naboa', 'jungle'], ['Rori', 'barren'], ['Ohmar', 'swamp']] },
  { name: 'Bespar', x: 530, y: 220, star: 'orange', tier: 1, planets: [['Bespar', 'gas'], ['Anax', 'icegiant']] },
  { name: 'Rylos', x: 600, y: 380, star: 'red', tier: 1, planets: [['Rylos', 'desert']] },
  { name: 'Tatara', x: 720, y: 500, star: 'yellow', tier: 1, planets: [['Tatara', 'desert'], ['Ghomar', 'barren']] },
  { name: 'Catonis', x: 820, y: 210, star: 'white', tier: 1, planets: [['Catonis', 'city'], ['Catonis Reach', 'ocean']] },
  { name: 'Geonar', x: 900, y: 380, star: 'red', tier: 1, planets: [['Geonar', 'desert'], ['Geonar Ring', 'barren']] },
  { name: 'Alderra', x: 290, y: 170, star: 'yellow', tier: 2, planets: [['Alderra', 'jungle'], ['Delaya', 'ice']] },
  { name: 'Kamora', x: 90, y: 530, star: 'blue', tier: 2, planets: [['Kamora', 'ocean']] },
  { name: 'Ondaro', x: 420, y: 110, star: 'red', tier: 2, planets: [['Ondaro', 'desert'], ['Ondaro Deep', 'stormgiant']] },
  { name: 'Ord Mandra', x: 450, y: 440, star: 'white', tier: 2, planets: [['Ord Mandra', 'city']] },
  { name: 'Kristoff', x: 560, y: 560, star: 'blue', tier: 2, planets: [['Kristoff', 'crystal'], ['Kristoff Shards', 'barren']] },
  { name: 'Tethra', x: 680, y: 260, star: 'yellow', tier: 2, planets: [['Tethra', 'jungle']] },
  { name: 'Utapan', x: 790, y: 340, star: 'white', tier: 2, planets: [['Utapan', 'barren'], ['Pau Major', 'icegiant']] },
  { name: 'Mustara', x: 860, y: 530, star: 'red', tier: 2, planets: [['Mustara', 'lava']] },
  { name: 'Muunar', x: 930, y: 100, star: 'blue', tier: 2, planets: [['Muunar', 'city']] },
  { name: 'Brentis', x: 260, y: 420, star: 'orange', tier: 3, planets: [['Brentis', 'ocean']] },
  { name: 'Kashyr', x: 600, y: 90, star: 'yellow', tier: 3, planets: [['Kashyr', 'jungle'], ['Trandos', 'barren']] },
  { name: 'Dantor', x: 350, y: 560, star: 'orange', tier: 3, planets: [['Dantor', 'tundra']] },
  { name: 'Hothis', x: 200, y: 590, star: 'white', tier: 3, planets: [['Hothis', 'ice']] },
  { name: 'Felun', x: 760, y: 110, star: 'yellow', tier: 3, planets: [['Felun', 'swamp']] },
  { name: 'Saluca', x: 700, y: 610, star: 'orange', tier: 3, planets: [['Saluca', 'stormgiant'], ['Saluca Minor', 'lava']] },
  { name: 'Seraxis', x: 960, y: 580, star: 'red', tier: 3, planets: [['Seraxis', 'lava']] },
  { name: 'Hyperis', x: 470, y: 620, star: 'red', tier: 3, planets: [['Hyperis', 'toxic']] },
]
/** Where each side starts in the Rim Wars: the capital system first. */
const RIM_START: Record<FactionId, string[]> = { republic: ['Corvanis', 'Kuvaar'], droid: ['Geonar', 'Catonis'] }

export type GalaxyChoice = { kind: 'rim' } | { kind: 'generated'; seed: number }
export const GALAXIES = { rim: { name: 'The Rim Wars', blurb: 'Republic core worlds in the west, Confederacy foundries in the east, trade worlds to fight over between.' } }

// --- Building a galaxy -------------------------------------------------------------------------------

export const W = 1000
export const H = 660

/** Hyperlanes: a Gabriel graph (two systems are joined when no third lies inside the circle on
 * them), with the longest lanes dropped where the systems stay connected anyway. */
function laneGraph(pts: { x: number; y: number }[]): [number, number][] {
  const n = pts.length
  const d2 = (a: number, b: number) => (pts[a].x - pts[b].x) ** 2 + (pts[a].y - pts[b].y) ** 2
  let lanes: [number, number][] = []
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++) {
      const mx = (pts[a].x + pts[b].x) / 2
      const my = (pts[a].y + pts[b].y) / 2
      const r2 = d2(a, b) / 4
      if (!pts.some((p, c) => c !== a && c !== b && (p.x - mx) ** 2 + (p.y - my) ** 2 < r2)) lanes.push([a, b])
    }
  // Too long to read well: drop it if the map stays in one piece.
  lanes.sort((x, y) => d2(y[0], y[1]) - d2(x[0], x[1]))
  for (const l of [...lanes]) {
    if (d2(l[0], l[1]) < 300 ** 2) break
    const rest = lanes.filter((x) => x !== l)
    if (connected(n, rest)) lanes = rest
  }
  return lanes
}
function connected(n: number, lanes: [number, number][]) {
  const seen = new Set([0])
  const stack = [0]
  while (stack.length) {
    const a = stack.pop()!
    for (const [x, y] of lanes) {
      const b = x === a ? y : y === a ? x : -1
      if (b >= 0 && !seen.has(b)) {
        seen.add(b)
        stack.push(b)
      }
    }
  }
  return seen.size === n
}

const SYL_A = ['Ka', 'Ve', 'Or', 'Tal', 'Sel', 'Ry', 'Dra', 'Mu', 'Ba', 'Cor', 'Zan', 'Ith', 'Ul', 'Ne', 'Pha', 'Gor', 'Ae', 'Lo', 'Quel', 'Ser', 'Tyr', 'Vos', 'Hel', 'Jae']
const SYL_B = ['ra', 'lon', 'dis', 'mar', 'tho', 'vex', 'nar', 'dor', 'sha', 'ki', 'lis', 'ron', 'vel', 'ta', 'qua', 'mir', 'sus', 'don', 'ka', 'rion']
const SYL_C = ['', '', '', ' Prime', ' Major', ' Minor', 'ia', 'is', 'os', 'ar', 'en']
const ROMAN = ['', ' II', ' III', ' IV']
const KINDS: PlanetKind[] = ['desert', 'ice', 'lava', 'ocean', 'jungle', 'city', 'gas', 'barren', 'icegiant', 'stormgiant', 'toxic', 'swamp', 'crystal', 'tundra']
const STARS: StarKind[] = ['yellow', 'yellow', 'orange', 'orange', 'red', 'white', 'blue']

function generatedDefs(seed: number, count: number): SystemDef[] {
  const r = rng(seed * 2654435761)
  const out: SystemDef[] = []
  const names = new Set<string>()
  const minD = Math.sqrt((W * H) / count) * 0.62
  let tries = 0
  while (out.length < count && tries++ < 8000) {
    // A wide, slightly squashed disc: denser towards the middle.
    const a = r() * Math.PI * 2
    const d = Math.sqrt(r()) * 0.95
    const x = W / 2 + Math.cos(a) * d * (W / 2 - 50)
    const y = H / 2 + Math.sin(a) * d * (H / 2 - 50)
    if (out.some((s) => (s.x - x) ** 2 + (s.y - y) ** 2 < (minD * (tries > 5000 ? 0.75 : 1)) ** 2)) continue
    let name = ''
    for (let i = 0; i < 20 && (!name || names.has(name)); i++) name = SYL_A[Math.floor(r() * SYL_A.length)] + SYL_B[Math.floor(r() * SYL_B.length)] + SYL_C[Math.floor(r() * SYL_C.length)]
    names.add(name)
    const np = 1 + Math.floor(r() * r() * 4)
    const planets: [string, PlanetKind][] = []
    for (let i = 0; i < np; i++) planets.push([`${name}${ROMAN[i]}`, KINDS[Math.floor(r() * KINDS.length)]])
    out.push({ name, x: Math.round(x), y: Math.round(y), star: STARS[Math.floor(r() * STARS.length)], tier: 1, planets })
  }
  return out
}

/** The two systems furthest apart by lanes: the two capitals. */
function farthestPair(n: number, lanes: [number, number][]) {
  const hops = (from: number) => {
    const d = Array(n).fill(Infinity)
    d[from] = 0
    const q = [from]
    while (q.length) {
      const a = q.shift()!
      for (const [x, y] of lanes) {
        const b = x === a ? y : y === a ? x : -1
        if (b >= 0 && d[b] === Infinity) {
          d[b] = d[a] + 1
          q.push(b)
        }
      }
    }
    return d
  }
  let best: [number, number] = [0, 1]
  let far = -1
  for (let a = 0; a < n; a++) {
    const d = hops(a)
    d.forEach((v, b) => {
      if (v !== Infinity && v > far) {
        far = v
        best = [a, b]
      }
    })
  }
  return best
}

export type NewGalaxy = { choice: GalaxyChoice; size: GalaxySize; faction: FactionId; difficulty: Difficulty; credits: number; name?: string; blockade?: BlockadeRule; frontline?: boolean }

export function newGalaxy(opts: NewGalaxy): Galaxy {
  const seed = opts.choice.kind === 'generated' ? opts.choice.seed : 7
  const r = rng(seed * 31 + 17)
  const defs = opts.choice.kind === 'rim' ? RIM_WARS.filter((s) => s.tier <= (opts.size === 'short' ? 1 : opts.size === 'standard' ? 2 : 3)) : generatedDefs(seed, SIZES[opts.size].systems)
  const g: Galaxy = {
    v: 2,
    save: { id: newSaveId(), name: opts.name?.trim() || `${opts.choice.kind === 'rim' ? GALAXIES.rim.name : `Sector ${seed}`}, ${FACTIONS[opts.faction].name}` },
    name: opts.choice.kind === 'rim' ? GALAXIES.rim.name : `Sector ${seed}`,
    seed,
    size: opts.size,
    time: 0,
    systems: [],
    planets: [],
    lanes: [],
    fleets: [],
    sides: [],
    nextId: 1,
    winner: -1,
    pending: -1,
    events: [],
    aiT: [0, 2],
    rules: { blockade: opts.blockade ?? 'majority', frontline: opts.frontline ?? true },
  }
  defs.forEach((d, id) => {
    const sys: StarSystem = { id, name: d.name, x: d.x, y: d.y, star: d.star, planets: [] }
    d.planets.forEach(([name, kind], i) => {
      const pid = g.planets.length
      const income = Math.round((PLANET_KINDS[kind].income * (0.7 + r() * 0.6)) / 5) * 5
      g.planets.push({ id: pid, system: id, name, kind, orbit: i, angle: r() * Math.PI * 2, size: GIANTS.includes(kind) ? 1.3 : kind === 'barren' ? 0.8 : 1, owner: -1, station: 0, base: emptyBase(), income, earned: 0, queue: [], capture: null })
      sys.planets.push(pid)
    })
    g.systems.push(sys)
  })
  g.lanes = laneGraph(g.systems)
  // The sides: the player first, then the AI on the other faction.
  const other: FactionId = opts.faction === 'republic' ? 'droid' : 'republic'
  const side = (faction: FactionId, ai: Difficulty | null): Side => ({ faction, credits: opts.credits, ai, alive: true, earned: 0, spent: { ships: 0, stations: 0 }, history: [], ledger: [] })
  g.sides = [side(opts.faction, null), side(other, opts.difficulty)]
  // Home systems: the capital (its first planet gets a level 3 station and a Frigate Yard) and a
  // neighbour (level 1). The Capital Yard and the expansions are each side's own to build.
  const homes: number[][] = [[], []]
  if (opts.choice.kind === 'rim') {
    g.sides.forEach((s, o) => (homes[o] = RIM_START[s.faction].map((n) => g.systems.findIndex((x) => x.name === n)).filter((i) => i >= 0)))
  } else {
    const [a, b] = farthestPair(g.systems.length, g.lanes)
    const neighbour = (s: number, not: number) => {
      const ns = g.lanes.filter((l) => l.includes(s)).map((l) => (l[0] === s ? l[1] : l[0])).filter((x) => x !== not)
      return ns.sort((x, y) => dist(g.systems[s], g.systems[x]) - dist(g.systems[s], g.systems[y]))[0]
    }
    homes[0] = [a, neighbour(a, b)].filter((x) => x !== undefined)
    homes[1] = [b, neighbour(b, a)].filter((x) => x !== undefined && !homes[0].includes(x))
  }
  homes.forEach((hs, o) =>
    hs.forEach((s, i) => {
      for (const pid of g.systems[s].planets) g.planets[pid].owner = o
      const capital = g.planets[g.systems[s].planets[0]]
      capital.station = i === 0 ? 3 : 1
      if (i === 0) capital.base.yards.yard = 'up'
      if (i === 0) capital.income = Math.round((capital.income * 1.5) / 5) * 5
    }),
  )
  // A fair start: home systems are rolled (or, in the Rim Wars, drawn) unevenly, so the poorer
  // side's capital pays the difference and both sides start on the same income.
  const homeIncome = (o: number) => g.planets.reduce((v, p) => v + (p.owner === o ? p.income * (1 + STATION_INCOME * p.station) : 0), 0)
  const poorer = homeIncome(0) < homeIncome(1) ? 0 : 1
  const capital = homes[poorer][0] !== undefined ? g.planets[g.systems[homes[poorer][0]].planets[0]] : null
  if (capital) capital.income += Math.round((homeIncome(1 - poorer) - homeIncome(poorer)) / (1 + STATION_INCOME * capital.station) / 5) * 5
  // Starting fleets at each capital.
  g.sides.forEach((s, o) => {
    const cap = g.systems[homes[o][0]].planets[0]
    const f = (t: Tier) => unitOf(s.faction, t).id
    dock(g, o, cap, [f('fighter'), f('fighter'), f('gunship'), f('gunship'), f('frigate')].map((unit) => ({ unit })), true)
  })
  // What each side knows at the start: the charts of the galaxy and who held what when the war
  // broke out, but nothing of the other side's fleets.
  for (const s of g.sides) s.intel = chartOf(g)
  updateSight(g)
  return g
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y)

// --- The fleet inventory ---------------------------------------------------------------------------
//
// Each fleet carries its ships on a grid of GRID_W by GRID_H cells, like a backpack in a role-playing
// game: every ship takes up a footprint that grows with its size (FOOTPRINT), so a fleet holds a
// few big warships or a swarm of small craft, never everything at once. Strike craft (the fighter
// tier: fighters, bombers, repair craft and pickets) of one type stack, up to STACK squadrons in a
// cell; everything bigger is one ship per footprint, so three frigates are three items. Each item
// either jumps in when a battle starts or is held back in the battle's reserve (Item.held). Ships
// move between our fleets at the same planet, to any spot where they fit (turned on their side if
// that's what fits), and into a new fleet there while there are fewer than MAX_FLEETS. A fleet that
// gives away its last ship is gone. Fleet.items is the layout; Fleet.ships lists the same ships
// flat, for everything that only needs to know what a fleet has (battles, values, the AI), and
// `sync` keeps the two in step.

/** A fleet's grid, in cells across and down: 24 cells of room. */
export const GRID_W = 6
export const GRID_H = 4
/** Squadrons of one strike craft type that share a cell. */
export const STACK = 3
/** One thing on a fleet's grid: a ship, or a stack of strike craft of one type, at (x, y) from the
 * top left, `w` cells wide and `h` tall (a ship turned on its side has the two swapped). */
export type Item = { unit: string; n: number; x: number; y: number; w: number; h: number; held?: boolean }

/**
 * The cells a ship takes up by tier, wide by tall as it sits upright: strike craft and gunships one
 * cell, frigates a column of two, cruisers a square of four and capital ships two by three, so one
 * dreadnought takes the room of six fighter stacks and a fleet carries at most three of them.
 */
export const FOOTPRINT: Partial<Record<Tier, [number, number]>> = { fighter: [1, 1], gunship: [1, 1], frigate: [1, 2], cruiser: [2, 2], capital: [2, 3] }
/** Ships whose hull doesn't match their tier's footprint: the Republic's repair corvette is a gunship
 * by tier but a long tender, as long as a frigate. */
const FOOTPRINT_OF: Record<string, [number, number]> = { 'r-corvette': [1, 2] }
export function footprint(unit: string) {
  const [w, h] = FOOTPRINT_OF[unit] ?? FOOTPRINT[UNIT[unit]?.tier] ?? [1, 1]
  return { w, h }
}
/** Whether a type stacks: only the strike craft do. */
export const stacks = (unit: string) => UNIT[unit]?.tier === 'fighter'
const areaOf = (unit: string) => footprint(unit).w * footprint(unit).h
/** Bigger footprints first, then dearer ships: the order things are packed in. */
const bigFirst = (a: string, b: string) => areaOf(b) - areaOf(a) || UNIT[b].cost - UNIT[a].cost || (a < b ? -1 : a > b ? 1 : 0)

function taken(items: Item[], skip?: Item) {
  const c = new Uint8Array(GRID_W * GRID_H)
  for (const it of items) if (it !== skip) for (let y = it.y; y < it.y + it.h; y++) for (let x = it.x; x < it.x + it.w; x++) c[y * GRID_W + x] = 1
  return c
}
/** Whether a footprint fits at (x, y) on a grid (leaving out `skip`, the item being moved). */
export function fitsAt(items: Item[], w: number, h: number, x: number, y: number, skip?: Item) {
  if (x < 0 || y < 0 || x + w > GRID_W || y + h > GRID_H) return false
  const c = taken(items, skip)
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) if (c[j * GRID_W + i]) return false
  return true
}
/** The first free spot for a footprint, row by row from the top left, upright if it fits that way
 * anywhere, else on its side. */
export function spotFor(items: Item[], w: number, h: number, skip?: Item) {
  for (const [a, b] of w === h ? [[w, h]] : [[w, h], [h, w]])
    for (let y = 0; y + b <= GRID_H; y++) for (let x = 0; x + a <= GRID_W; x++) if (fitsAt(items, a, b, x, y, skip)) return { x, y, w: a, h: b }
  return null
}
/** The item covering a cell of a fleet's grid. */
export const itemAt = (f: Fleet, x: number, y: number) => f.items.find((i) => x >= i.x && x < i.x + i.w && y >= i.y && y < i.y + i.h)
const cloneItems = (items: Item[]) => items.map((i) => ({ ...i }))

/** Puts up to `n` ships of a type into a layout: strike craft top up the stacks of their type (held
 * back with held back) first, then everything takes the first free spot. Returns how many went in. */
function place(items: Item[], unit: string, n: number, held = false): number {
  let left = n
  if (stacks(unit))
    for (const it of items) {
      if (!left) break
      if (it.unit !== unit || !!it.held !== held || it.n >= STACK) continue
      const k = Math.min(STACK - it.n, left)
      it.n += k
      left -= k
    }
  const { w, h } = footprint(unit)
  while (left > 0) {
    const at = spotFor(items, w, h)
    if (!at) break
    const k = stacks(unit) ? Math.min(STACK, left) : 1
    items.push({ unit, n: k, ...at, ...(held ? { held: true } : {}) })
    left -= k
  }
  return n - left
}
/** How many ships of a type (`n` at most) a fleet still has room for. */
export const roomFor = (f: Fleet, unit: string, n = 1, held = false) => place(cloneItems(f.items), unit, n, held)

type Loose = { unit: string; held?: boolean }
/** Ships laid out from scratch, biggest first (held back ones as their own stacks); what doesn't fit
 * is `rest`. */
export function pack(ships: Loose[]): { items: Item[]; rest: Loose[] } {
  const groups = new Map<string, { unit: string; held: boolean; n: number }>()
  for (const s of ships) {
    const key = `${s.unit}|${s.held ? 1 : 0}`
    const gr = groups.get(key)
    if (gr) gr.n++
    else groups.set(key, { unit: s.unit, held: !!s.held, n: 1 })
  }
  const items: Item[] = []
  const rest: Loose[] = []
  for (const gr of [...groups.values()].sort((a, b) => bigFirst(a.unit, b.unit) || Number(a.held) - Number(b.held))) {
    const k = place(items, gr.unit, gr.n, gr.held)
    for (let i = k; i < gr.n; i++) rest.push({ unit: gr.unit, held: gr.held })
  }
  return { items, rest }
}
/** Fleet.ships from the layout (biggest first), with emptied items gone. */
export function sync(f: Fleet) {
  f.items = f.items.filter((i) => i.n > 0)
  f.ships = f.items.slice().sort((a, b) => bigFirst(a.unit, b.unit)).flatMap((i) => Array<string>(i.n).fill(i.unit))
}
/** Cells of a fleet's grid in use. */
export const cellsUsed = (f: Fleet) => f.items.reduce((s, i) => s + i.w * i.h, 0)
/** A fleet's ships as loose ships: what each is and whether it's held back. */
const looseOf = (f: Fleet): Loose[] => f.items.flatMap((i) => Array.from({ length: i.n }, () => ({ unit: i.unit, held: !!i.held })))

/** A new, empty fleet of ours in orbit of a planet (no orders). */
function newFleet(g: Galaxy, owner: number, planet: number, arrived = g.time): Fleet {
  const p = g.planets[planet]
  const f: Fleet = { id: g.nextId++, owner, ships: [], items: [], planet, system: p.system, from: planet, leg: null, route: [], waypoints: [], arrived }
  g.fleets.push(f)
  return f
}

/** A side's fleets in orbit of a planet (not those flying through), in the order they're listed. */
export const fleetsHere = (g: Galaxy, owner: number, planet: number) => g.fleets.filter((f) => f.owner === owner && f.planet === planet && !f.leg)
/** Where new ships at a planet go first: a fleet that is staying before one only stopping on its way. */
const dockOrder = (fs: Fleet[]) => fs.slice().sort((a, b) => Number(!!a.waypoints?.length) - Number(!!b.waypoints?.length))

/**
 * Ships that turn up at a planet (built there, a starting fleet, or the survivors of a battle with
 * no fleet of theirs left there) join our fleets in its orbit: the first with room for each, and new
 * fleets while there are fewer than MAX_FLEETS; with `spill`, past the cap too (ships that have to go
 * somewhere). Returns the ships that found no room.
 */
function dock(g: Galaxy, owner: number, planet: number, ships: Loose[], spill = false): Loose[] {
  let rest = ships.slice().sort((a, b) => bigFirst(a.unit, b.unit))
  for (const f of dockOrder(fleetsHere(g, owner, planet))) {
    rest = rest.filter((s) => place(f.items, s.unit, 1, !!s.held) === 0)
    sync(f)
  }
  while (rest.length && (spill || fleetsHere(g, owner, planet).length < MAX_FLEETS)) {
    const f = newFleet(g, owner, planet)
    const r = pack(rest)
    f.items = r.items
    sync(f)
    if (r.rest.length === rest.length) break
    rest = r.rest
  }
  return rest
}
/** Whether a ship built at a planet has somewhere to go: a fleet there with room, or room for a new fleet. */
export const yardRoom = (g: Galaxy, owner: number, planet: number, unit: string) => {
  const fs = fleetsHere(g, owner, planet)
  return fs.length < MAX_FLEETS || fs.some((f) => roomFor(f, unit) > 0)
}

/** How many ships of a type a fleet holds back. */
export const heldOf = (f: Fleet, id: string) => f.items.reduce((s, i) => s + (i.unit === id && i.held ? i.n : 0), 0)
/** The ships a fleet holds back when a battle starts. */
export const heldShips = (f: Fleet) => f.items.flatMap((i) => (i.held ? Array<string>(i.n).fill(i.unit) : []))
/** `all` without one of each of `some` (ship ids, counted). */
export function withoutShips(all: string[], some: string[]) {
  const rest = [...all]
  for (const id of some) {
    const i = rest.indexOf(id)
    if (i >= 0) rest.splice(i, 1)
  }
  return rest
}

/** Moves what fits of one layout into another (items keep held back or not; strike craft top up
 * stacks); what doesn't fit stays in `from`. Returns how many ships moved. */
function pour(from: Item[], into: Item[]): number {
  let moved = 0
  for (const it of from.slice().sort((a, b) => bigFirst(a.unit, b.unit))) {
    if (!it.n) continue
    if (stacks(it.unit)) {
      const k = place(into, it.unit, it.n, !!it.held)
      it.n -= k
      moved += k
      continue
    }
    // The same spot if it's free there, else the first that fits.
    const at = fitsAt(into, it.w, it.h, it.x, it.y) ? { x: it.x, y: it.y, w: it.w, h: it.h } : spotFor(into, it.w, it.h)
    if (!at) continue
    into.push({ ...it, ...at })
    moved += it.n
    it.n = 0
  }
  return moved
}
/** Whether all of a fleet would fit into others (filling them in order). */
function fitsInto(from: Fleet, into: Fleet[]) {
  const left = cloneItems(from.items)
  for (const f of into) pour(left, cloneItems(f.items))
  return left.every((i) => i.n === 0)
}
/** One fleet joins another, as far as there's room: what doesn't fit stays in `from` (gone once
 * empty), and the merged fleet keeps the earlier arrival. Returns how many ships moved. */
function absorb(g: Galaxy, from: Fleet, into: Fleet): number {
  if (from === into) return 0
  const moved = pour(from.items, into.items)
  sync(from)
  sync(into)
  if (moved) into.arrived = Math.min(into.arrived, from.arrived)
  if (!from.items.length) g.fleets = g.fleets.filter((x) => x !== from)
  return moved
}

/**
 * Ships split off a fleet as their own (by `take`, ship ids counted): the ones that jump in go
 * first, then held back ones, which stay held back in the new fleet. Each keeps its spot on the
 * grid, so they always fit. The new fleet is listed but has no orders.
 */
function splitOff(g: Galaxy, f: Fleet, take: string[]): Fleet {
  const nf = newFleet(g, f.owner, f.planet, f.arrived)
  nf.system = f.system
  nf.from = f.from
  for (const [id, n] of grouped(take)) {
    let left = n
    for (const it of f.items.filter((i) => i.unit === id).sort((a, b) => Number(!!a.held) - Number(!!b.held))) {
      if (!left) break
      const k = Math.min(left, it.n)
      nf.items.push({ ...it, n: k })
      it.n -= k
      left -= k
    }
  }
  sync(f)
  sync(nf)
  return nf
}
const grouped = (ships: string[]) => {
  const m = new Map<string, number>()
  for (const id of ships) m.set(id, (m.get(id) ?? 0) + 1)
  return [...m.entries()]
}

/** A spot on a fleet's grid: the item covering cell (x, y) of fleet `fleet`. */
export type ItemRef = { fleet: number; x: number; y: number }
/** Where an item goes: a fleet (a new one at the same planet with 'new'), at a spot with a size (its
 * footprint upright or on its side), or anywhere it fits. */
export type ItemDrop = { fleet: number | 'new'; x?: number; y?: number; w?: number; h?: number }

/**
 * Move an item on the inventory (or `n` squadrons of a stack): to another spot in its fleet (turned,
 * with `w` and `h` swapped), to another of our fleets at the same planet, or into a new fleet there.
 * With a spot it goes there if it fits; dropped on a stack of its own kind (and part) with room it
 * joins that stack. Without one it tops up the stacks of its kind there, then takes the first free
 * spot. Returns the fleet it went to, or why it can't go.
 */
export function moveItem(g: Galaxy, owner: number, from: ItemRef, to: ItemDrop, n?: number): Fleet | string {
  const a = g.fleets.find((f) => f.id === from.fleet)
  if (!a || a.owner !== owner) return 'Not our fleet'
  const it = itemAt(a, from.x, from.y)
  if (!it) return 'Nothing there'
  const k = Math.max(1, Math.min(it.n, Math.floor(n ?? it.n)))
  const whole = k === it.n
  const foot = footprint(it.unit)
  const w = to.w ?? it.w
  const h = to.h ?? it.h
  if (!((w === foot.w && h === foot.h) || (w === foot.h && h === foot.w))) return "It doesn't fit that way"
  let b: Fleet
  if (to.fleet === a.id) b = a
  else {
    if (a.leg) return 'In flight: ships move between fleets only while they hold an orbit'
    if (to.fleet === 'new') {
      // A fleet that gives away all it has only changes its name: that's no extra fleet.
      if (fleetsHere(g, owner, a.planet).length >= MAX_FLEETS && !(whole && a.items.length === 1)) return `At most ${MAX_FLEETS} fleets at one planet`
      b = newFleet(g, owner, a.planet, a.arrived)
      b.system = a.system
    } else {
      const t = g.fleets.find((f) => f.id === to.fleet)
      if (!t || t.owner !== owner) return 'Not our fleet'
      if (t.leg || t.planet !== a.planet) return 'Ships move only between fleets at the same planet'
      b = t
    }
  }
  const fresh = to.fleet === 'new'
  if (to.x !== undefined && to.y !== undefined && !fresh) {
    const onto = itemAt(b, to.x, to.y)
    if (onto && onto !== it && onto.unit === it.unit && stacks(it.unit) && !!onto.held === !!it.held) {
      if (onto.n >= STACK) return 'That stack is full'
      const m = Math.min(k, STACK - onto.n)
      onto.n += m
      it.n -= m
    } else {
      if (!fitsAt(b.items, w, h, to.x, to.y, b === a && whole ? it : undefined)) return 'No room there'
      if (b === a && whole) Object.assign(it, { x: to.x, y: to.y, w, h })
      else {
        b.items.push({ unit: it.unit, n: k, x: to.x, y: to.y, w, h, ...(it.held ? { held: true } : {}) })
        it.n -= k
      }
    }
  } else if (b !== a) {
    // Anywhere it fits (a new fleet takes it at the top left, the way it was turned).
    const at = fresh ? { x: 0, y: 0, w, h } : null
    const went = at ? (b.items.push({ unit: it.unit, n: k, ...at, ...(it.held ? { held: true } : {}) }), k) : place(b.items, it.unit, k, !!it.held)
    if (!went) return `No room for ${UNIT[it.unit].name} in that fleet`
    it.n -= went
  }
  sync(a)
  if (b !== a) sync(b)
  if (!a.items.length) g.fleets = g.fleets.filter((x) => x !== a)
  return b
}

/** Why an item can't go somewhere (null: it can), worked out on a copy without moving anything: for
 * showing where a dragged ship would fit. */
export function dropWhy(g: Galaxy, owner: number, from: ItemRef, to: ItemDrop, n?: number): string | null {
  const copy: Galaxy = { ...g, fleets: g.fleets.map((f) => ({ ...f, items: cloneItems(f.items), ships: [...f.ships] })) }
  const r = moveItem(copy, owner, from, to, n)
  return typeof r === 'string' ? r : null
}

/** Hold an item back (it waits in the battle's reserve) or deploy it. Also while the fleet flies. */
export function holdItem(g: Galaxy, owner: number, ref: ItemRef, held: boolean): string | null {
  const f = g.fleets.find((x) => x.id === ref.fleet)
  if (!f || f.owner !== owner) return 'Not our fleet'
  const it = itemAt(f, ref.x, ref.y)
  if (!it) return 'Nothing there'
  if (held) it.held = true
  else delete it.held
  return null
}
/** Hold back (or deploy) everything in a fleet. */
export function holdFleet(g: Galaxy, owner: number, fleetId: number, held: boolean): string | null {
  const f = g.fleets.find((x) => x.id === fleetId)
  if (!f || f.owner !== owner) return 'Not our fleet'
  for (const it of f.items) {
    if (held) it.held = true
    else delete it.held
  }
  return null
}
/** Lay a fleet's grid out afresh, biggest first and stacks filled up, unless that would leave a ship
 * out (a hand-made layout can be tighter than the packer's). */
export function arrangeFleet(g: Galaxy, owner: number, fleetId: number): string | null {
  const f = g.fleets.find((x) => x.id === fleetId)
  if (!f || f.owner !== owner) return 'Not our fleet'
  const r = pack(looseOf(f))
  if (r.rest.length) return 'Already packed as tight as it goes'
  f.items = r.items
  sync(f)
  return null
}

/** One of our fleets joins another at the same planet, as far as there's room: returns how many of
 * its ships didn't fit (they stay a fleet of their own), or why it can't. */
export function mergeFleets(g: Galaxy, owner: number, fromId: number, intoId: number): { left: number } | string {
  const a = g.fleets.find((f) => f.id === fromId)
  const b = g.fleets.find((f) => f.id === intoId)
  if (!a || !b || a.owner !== owner || b.owner !== owner) return 'Not our fleet'
  if (a === b) return { left: 0 }
  if (a.leg || b.leg || a.planet !== b.planet) return 'Fleets join up only at the same planet'
  if (!absorb(g, a, b)) return `No room: ${cellsUsed(b) >= GRID_W * GRID_H ? 'that fleet is full' : 'none of these ships fit in that fleet'}`
  return { left: g.fleets.includes(a) ? a.ships.length : 0 }
}

/**
 * Fleets whose ships and layout don't agree (saves from before the grid, or ships set from outside)
 * are laid out again: biggest first, held back ones (old saves' `reserve` counts) still held back.
 * What doesn't fit forms another fleet beside it with the same orders, past the cap if need be.
 */
export function layoutFleets(g: Galaxy) {
  for (const f of [...g.fleets]) {
    const items = Array.isArray(f.items) ? f.items : []
    const flat = items.flatMap((i) => Array<string>(i.n).fill(i.unit)).sort()
    const ships = (f.ships ?? []).slice().sort()
    if (Array.isArray(f.items) && !f.reserve && flat.length === ships.length && flat.every((x, i) => x === ships[i])) continue
    // Held back: each item's own mark, or (old saves) the counts by type.
    const held: Record<string, number> = { ...(f.reserve ?? {}) }
    for (const i of items) if (i.held) held[i.unit] = (held[i.unit] ?? 0) + i.n
    const loose = (f.ships ?? []).map((unit): Loose => {
      const h = (held[unit] ?? 0) > 0
      if (h) held[unit]--
      return { unit, held: h }
    })
    delete f.reserve
    let r = pack(loose)
    f.items = r.items
    sync(f)
    while (r.rest.length) {
      const nf: Fleet = { ...f, id: g.nextId++, items: [], ships: [], leg: f.leg ? { ...f.leg } : null, route: f.route.map((x) => ({ ...x })), waypoints: [...(f.waypoints ?? [])] }
      delete nf.join
      r = pack(r.rest)
      nf.items = r.items
      sync(nf)
      g.fleets.push(nf)
    }
  }
  g.fleets = g.fleets.filter((f) => f.items.length)
}

/**
 * Fleets sent to join another (Gather) do so once both are at the same planet, as far as there's
 * room (whatever doesn't fit stays a fleet of its own there). No side keeps more than MAX_FLEETS at
 * one planet when it can help it: past that, one folds into the others there if all of it fits,
 * until they're down to the cap. The one to fold in is one without orders before one with them, the
 * latest to arrive first (a fleet flying in joins those already there), then the smallest; it fills
 * one with the same stops queued first, then the biggest. When none fits whole, the extra fleets
 * stay until the player sorts them out: the cap still stops new fleets being made there (the
 * shipyard, "New fleet"). Runs every tick, and on saves made before the cap.
 */
export function capFleets(g: Galaxy) {
  for (const f of [...g.fleets]) {
    if (f.join === undefined || !g.fleets.includes(f) || f.leg || f.route.length) continue
    const t = g.fleets.find((x) => x.id === f.join && x.owner === f.owner)
    if (!t || t === f) delete f.join
    else if (!t.leg && t.planet === f.planet && f.planet >= 0) {
      absorb(g, f, t)
      if (g.fleets.includes(f)) delete f.join
    }
    // The one it was to meet has settled somewhere else: nothing to wait for.
    else if (!t.leg && !t.route.length) delete f.join
  }
  const at = new Map<string, Fleet[]>()
  for (const f of g.fleets) {
    if (f.leg || f.route.length || f.planet < 0) continue
    const key = `${f.owner}:${f.planet}`
    at.set(key, [...(at.get(key) ?? []), f])
  }
  for (const fs of at.values()) {
    while (fs.length > MAX_FLEETS) {
      const orders = (f: Fleet) => (f.waypoints?.length || f.join !== undefined ? 1 : 0)
      const stops = (f: Fleet) => (f.waypoints ?? []).join(',')
      let folded = false
      for (const fold of fs.slice().sort((a, b) => orders(a) - orders(b) || b.arrived - a.arrived || a.ships.length - b.ships.length || b.id - a.id)) {
        const same = (f: Fleet) => (stops(f) === stops(fold) ? 1 : 0)
        const into = fs.filter((f) => f !== fold).sort((a, b) => same(b) - same(a) || b.ships.length - a.ships.length)
        if (!fitsInto(fold, into)) continue
        for (const t of into) if (g.fleets.includes(fold)) absorb(g, fold, t)
        fs.splice(fs.indexOf(fold), 1)
        folded = true
        break
      }
      if (!folded) break
    }
  }
}

// --- Looking things up -------------------------------------------------------------------------------

export const neighbours = (g: Galaxy, s: number) => g.lanes.filter((l) => l.includes(s)).map((l) => (l[0] === s ? l[1] : l[0]))
/** What a planet pays its owner a day: its own income, plus its station's bonus, times the owner's
 * difficulty multiplier (an AI's). */
export const planetIncome = (g: Galaxy, p: Planet) => {
  const mul = p.owner >= 0 && g.sides[p.owner].ai ? GALAXY_AI[g.sides[p.owner].ai!].income : 1
  return Math.round(p.income * (1 + STATION_INCOME * p.station) * mul)
}
export const incomeOf = (g: Galaxy, o: number) => g.planets.reduce((s, p) => s + (p.owner === o ? planetIncome(g, p) : 0), 0)
/** The day (from 0) and how far through it, and the week (from 0) and the day within it. */
export const calendar = (t: number) => {
  const day = Math.floor(t / DAY)
  return { day, frac: t / DAY - day, week: Math.floor(day / WEEK), weekDay: day % WEEK }
}
function book(s: Side, day: number, amount: number, what: string) {
  s.ledger.push({ day, amount, what })
  if (s.ledger.length > LEDGER) s.ledger.splice(0, s.ledger.length - LEDGER)
}
export const fleetsAt = (g: Galaxy, planet: number) => g.fleets.filter((f) => f.planet === planet && !f.leg)
/** What a fleet is worth: its ships' price. */
export const fleetValue = (ships: string[]) => ships.reduce((s, id) => s + UNIT[id].cost, 0)
/** Who holds a system: the side that owns most of its planets, or -1. With `viewer`, as that side
 * knows it (see the fog of war below). */
export function systemOwner(g: Galaxy, s: number, viewer = -1) {
  const n = [0, 0]
  for (const o of ownersIn(g, s, viewer)) if (o >= 0) n[o]++
  return n[0] > n[1] ? 0 : n[1] > n[0] ? 1 : -1
}

/** Who blockades `owner` given the owners of a system's planets (see BlockadeRule), or -1. */
function blockOf(rule: BlockadeRule, ps: number[], owner: number, sides: number) {
  if (rule === 'off' || owner < 0) return -1
  const ours = ps.filter((o) => o === owner).length
  for (let o = 0; o < sides; o++) {
    if (o === owner) continue
    const theirs = ps.filter((x) => x === o).length
    if (rule === 'full' ? theirs === ps.length && ps.length > 0 : theirs > ours) return o
  }
  return -1
}
/**
 * The side whose blockade stops `owner`'s fleets flying through system `s`, or -1 (see BlockadeRule).
 * Plans (routes, the AI) go by what `owner`'s side knows of the system; `real` is the blockade as it
 * is, which pulls a fleet out of hyperspace when it gets there.
 */
export function blockedBy(g: Galaxy, s: number, owner: number, real = false): number {
  return blockOf(g.rules?.blockade ?? 'majority', ownersIn(g, s, real ? -1 : owner), owner, g.sides.length)
}
/** A system's blockade as `viewer` knows it, for drawing: the blockading side and the side it stops. */
export function blockadeIn(g: Galaxy, s: number, viewer: number): { by: number; against: number } | null {
  const ps = ownersIn(g, s, viewer)
  for (let o = 0; o < g.sides.length; o++) {
    const by = blockOf(g.rules?.blockade ?? 'majority', ps, o, g.sides.length)
    if (by >= 0) return { by, against: o }
  }
  return null
}

/** Front lines (a campaign rule): a system `owner`'s side doesn't control while the other side holds
 * planets there (as many or more than it does) is contested for it. */
export function contested(g: Galaxy, s: number, owner: number) {
  if (owner < 0) return false
  const ps = ownersIn(g, s, owner)
  const ours = ps.filter((o) => o === owner).length
  const theirs = Math.max(0, ...g.sides.map((_, o) => (o === owner ? 0 : ps.filter((x) => x === o).length)))
  return theirs > 0 && theirs >= ours
}
/** Whether the other side holds any planet in a system (as `owner`'s side knows it). */
const enemyIn = (g: Galaxy, s: number, owner: number) => ownersIn(g, s, owner).some((o) => o >= 0 && o !== owner)

// --- The fog of war ----------------------------------------------------------------------------------
//
// A side sees a star system while it owns a planet there, has a fleet there (in orbit, or flying
// between its planets), or the system is contested for it (one of its planets being taken, or a
// battle it's in; both mean it's there anyway), and the systems next door to a planet of its with
// a Sensor array on its station. Everything else is hidden from it: it knows the geography (stars,
// planets, their kinds) and what it last saw (Side.intel: who held each planet, its station, its
// yards and expansions, the other side's ships in its orbit, and when), never live fleets, stations,
// buildings or shipyards. A fleet flying through a system glimpses it on the way, which updates what it last
// saw. Sight is worked out once a tick for every side (updateSight) and saved with the campaign; a
// new campaign starts with the pre-war charts (who held what, no fleets). The galaxy AI plays by the
// same rules: it reads the galaxy only through what its side sees and remembers.

/** What a side last saw of a planet: who held it, its station level and buildings, the other side's
 * ships in its orbit (how many and what they cost; -1 ships: never seen) and when (galaxy seconds).
 * `base` is missing from looks taken before planets had buildings: nothing seen. */
export type Intel = { owner: number; station: number; base?: PlanetBase; ships: number; value: number; t: number }
/** What a side knows of a planet now: live when it sees the system, else its last look. */
export type Known = Intel & { base: PlanetBase; live: boolean }

/** The system a fleet is in where others can see it: in orbit, or flying between planets of one
 * system (out on a lane between systems, it's in hyperspace: -1). */
export const fleetSystem = (f: Fleet) => (!f.leg ? (f.planet >= 0 ? f.system : -1) : f.leg.system === f.system ? f.system : -1)
/** Whether side `o` sees system `s` (-1, nobody's view, sees everything). */
export const sees = (g: Galaxy, o: number, s: number) => o < 0 || !g.sides[o]?.sight || !!g.sides[o].sight![s]
/** Whether side `o` sees a fleet: its own, or one in a system it sees. */
export const canSee = (g: Galaxy, o: number, f: Fleet) => f.owner === o || (fleetSystem(f) >= 0 && sees(g, o, fleetSystem(f)))
/** The owners of a system's planets as side `viewer` knows them (-1: as they are). */
export function ownersIn(g: Galaxy, s: number, viewer = -1) {
  const live = sees(g, viewer, s)
  return g.systems[s].planets.map((pid) => (live ? g.planets[pid].owner : (g.sides[viewer].intel?.[pid]?.owner ?? -1)))
}
/** Who holds a planet as side `o` knows it. */
export const ownerFor = (g: Galaxy, o: number, p: Planet) => (sees(g, o, p.system) ? p.owner : (g.sides[o].intel?.[p.id]?.owner ?? -1))
/** The other sides' ships in a planet's orbit right now, as side `o` would count them. */
function garrison(g: Galaxy, o: number, pid: number) {
  const ships = fleetsAt(g, pid).filter((f) => f.owner !== o).flatMap((f) => f.ships)
  return { ships: ships.length, value: fleetValue(ships) }
}
/** What side `o` knows of a planet: live when it sees the system, else its last look. */
export function known(g: Galaxy, o: number, p: Planet): Known {
  if (sees(g, o, p.system)) return { owner: p.owner, station: p.station, base: p.base, ...garrison(g, o, p.id), t: g.time, live: true }
  const i = g.sides[o].intel?.[p.id]
  return i ? { ...i, base: i.base ?? emptyBase(), live: false } : { owner: -1, station: 0, base: emptyBase(), ships: -1, value: 0, t: -1, live: false }
}
/** The pre-war charts: who holds each planet, its station and buildings now, but no fleets. */
const chartOf = (g: Galaxy): Intel[] => g.planets.map((p) => ({ owner: p.owner, station: p.station, base: copyBase(p.base), ships: -1, value: 0, t: g.time }))
/** Side `o` takes a look at a planet now (it sees it, flies through, or hears how a battle ended). */
function note(g: Galaxy, o: number, p: Planet) {
  const s = g.sides[o]
  if (!s) return
  s.intel ??= chartOf(g)
  s.intel[p.id] = { owner: p.owner, station: p.station, base: copyBase(p.base), ...garrison(g, o, p.id), t: g.time }
}
/** A fleet passing through a system (or arriving in it) glimpses every planet there. */
const glimpse = (g: Galaxy, o: number, s: number) => {
  for (const pid of g.systems[s].planets) note(g, o, g.planets[pid])
}
/** Which systems each side sees now, and what it notes there. Cheap: once a tick. */
export function updateSight(g: Galaxy) {
  g.sides.forEach((side, o) => {
    side.intel ??= chartOf(g)
    const sight = g.systems.map(() => false)
    for (const p of g.planets) {
      if (p.owner === o || p.capture?.owner === o) sight[p.system] = true
      // A Sensor array looks down the lanes into the systems next door.
      if (p.owner === o && p.station > 0 && p.base?.mods.includes('sensorArray')) for (const n of neighbours(g, p.system)) sight[n] = true
    }
    for (const f of g.fleets) {
      if (f.owner !== o) continue
      const s = fleetSystem(f)
      if (s >= 0) sight[s] = true
    }
    // A battle it's in (it has a fleet or the planet there, so this is only for clarity).
    if (g.pending >= 0 && (g.planets[g.pending].owner === o || fleetsAt(g, g.pending).some((f) => f.owner === o))) sight[g.planets[g.pending].system] = true
    side.sight = sight
    sight.forEach((v, s) => v && glimpse(g, o, s))
  })
}
/** With front lines on, a fleet in a contested system can't jump straight into another system the
 * enemy holds planets in: it has to win where it is first (or fall back). */
const frontlineStops = (g: Galaxy, from: number, to: number, owner: number) => !!g.rules?.frontline && owner >= 0 && contested(g, from, owner) && enemyIn(g, to, owner)

/** Systems from `a` to `b` by the quickest lanes (both ends included), or null. With `owner`, its
 * fleets don't fly through systems blockaded against it (they may still end in one). */
export function lanePath(g: Galaxy, a: number, b: number, owner = -1): number[] | null {
  const n = g.systems.length
  const d = Array(n).fill(Infinity)
  const prev = Array(n).fill(-1)
  d[a] = 0
  const open = new Set([a])
  while (open.size) {
    let cur = -1
    for (const x of open) if (cur < 0 || d[x] < d[cur]) cur = x
    open.delete(cur)
    if (cur === b) break
    for (const nb of neighbours(g, cur)) {
      if (nb !== b && owner >= 0 && blockedBy(g, nb, owner) >= 0) continue
      if (frontlineStops(g, cur, nb, owner)) continue
      const nd = d[cur] + dist(g.systems[cur], g.systems[nb])
      if (nd < d[nb]) {
        d[nb] = nd
        prev[nb] = cur
        open.add(nb)
      }
    }
  }
  if (d[b] === Infinity) return null
  const path = [b]
  while (path[0] !== a) path.unshift(prev[path[0]])
  return path
}

/** The hops from where a fleet is to a planet: across the lanes, then into its orbit. */
export function routeTo(g: Galaxy, f: Fleet, planet: number): Hop[] | null {
  const to = g.planets[planet]
  const at = f.leg ? f.leg.system : f.system
  if (to.system === at) return f.planet === planet && !f.leg ? [] : [{ system: at, planet, total: ORBIT_HOP }]
  const path = lanePath(g, at, to.system, f.owner)
  if (!path) return null
  const hops: Hop[] = []
  for (let i = 1; i < path.length; i++)
    hops.push({ system: path[i], planet: i === path.length - 1 ? planet : -1, total: dist(g.systems[path[i - 1]], g.systems[path[i]]) * LANE_PACE + (i === path.length - 1 ? ORBIT_HOP / 2 : 0) })
  return hops
}

/** Seconds until a fleet gets where it's going. */
export const eta = (f: Fleet) => (f.leg ? f.leg.left : 0) + f.route.reduce((s, h) => s + h.total, 0)

// --- Orders ----------------------------------------------------------------------------------------

/** Where a fleet is headed: the end of its route, else the planet it orbits (-1 mid-system). */
const headedTo = (f: Fleet) => (f.route.length ? f.route[f.route.length - 1].planet : f.leg ? f.leg.planet : f.planet)

/** Still busy where it's going: flying, with stops queued, or taking the planet it orbits. */
const busy = (g: Galaxy, f: Fleet) => !!f.leg || f.route.length > 0 || !!f.waypoints?.length || (f.planet >= 0 && g.planets[f.planet].owner !== f.owner)

/** Every hop a fleet has ahead of it: its route, then on through its queued stops. */
export function plannedHops(g: Galaxy, f: Fleet): Hop[] {
  const hops = [...(f.leg ? [f.leg] : []), ...f.route]
  let at = headedTo(f)
  for (const w of f.waypoints ?? []) {
    if (at < 0) break
    const next = routeTo(g, { ...f, leg: null, planet: at, system: g.planets[at].system }, w)
    if (!next) break
    hops.push(...next)
    at = w
  }
  return hops
}

/**
 * Send a fleet (or, with `take`, just those of its ships: split off as a new fleet) to a planet.
 * A fleet already flying finishes its current hop first. With `queue` (Shift), a fleet that's busy
 * goes there once it's done with what it was doing.
 */
export function moveFleet(g: Galaxy, owner: number, fleetId: number, planet: number, take?: string[], queue = false): string | null {
  let f = g.fleets.find((x) => x.id === fleetId)
  if (!f || f.owner !== owner) return 'Not our fleet'
  // (Splitting off ships that would stay where they are makes no new fleet.)
  if (take && take.length && take.length < f.ships.length && !(f.planet === planet && !f.leg)) {
    if (f.leg) return 'Split fleets only while they hold an orbit'
    const rest = [...f.ships]
    for (const id of take) {
      const i = rest.indexOf(id)
      if (i < 0) return 'Those ships are not in this fleet'
      rest.splice(i, 1)
    }
    f = splitOff(g, f, take)
  }
  // A new order replaces a join-up that was under way.
  delete f.join
  if (queue && busy(g, f)) {
    const last = f.waypoints?.length ? f.waypoints[f.waypoints.length - 1] : headedTo(f)
    if (last === planet) return null
    if (last >= 0) {
      const from = { ...f, leg: null, planet: last, system: g.planets[last].system }
      if (!routeTo(g, from, planet)) return noWay(g, from, planet)
    }
    f.waypoints = [...(f.waypoints ?? []), planet]
    return null
  }
  const hops = routeTo(g, f, planet)
  if (!hops) return noWay(g, f, planet)
  if (f.leg) {
    // Mid-flight: finish this hop, then on from there.
    const from = { ...f, system: f.leg.system, planet: f.leg.planet, leg: null }
    const rest = routeTo(g, from, planet)
    if (!rest) return noWay(g, from, planet)
    f.waypoints = []
    f.route = f.leg.planet === planet ? [] : rest
    return null
  }
  f.waypoints = []
  if (!hops.length) return null
  f.route = hops
  startLeg(f)
  return null
}

/** Why a fleet can't get to a planet: a blockade in the way (named), or no lane at all. */
function noWay(g: Galaxy, f: Fleet, planet: number) {
  const at = f.leg ? f.leg.system : f.system
  if (g.rules?.frontline && contested(g, at, f.owner) && neighbours(g, at).every((n) => !lanePath(g, n, g.planets[planet].system, f.owner) || frontlineStops(g, at, n, f.owner)))
    return `Front line: win ${g.systems[at].name} first. From a contested system a fleet can only fall back to systems the enemy holds no planets in`
  const open = lanePath(g, at, g.planets[planet].system)
  const wall = open?.slice(1, -1).find((s) => blockedBy(g, s, f.owner) >= 0)
  return wall !== undefined ? `Blockaded: the ${factionName(g, blockedBy(g, wall, f.owner))} holds ${g.systems[wall].name}, and every way round` : 'No hyperlane leads there'
}

/** Stop: no more stops, and a fleet in flight halts at the next system it reaches (at one of our
 * planets there if there is one). */
export function stopFleet(g: Galaxy, owner: number, fleetId: number): string | null {
  const f = g.fleets.find((x) => x.id === fleetId)
  if (!f || f.owner !== owner) return 'Not our fleet'
  f.waypoints = []
  f.route = []
  delete f.join
  if (f.leg && f.leg.planet < 0) {
    const ps = g.systems[f.leg.system].planets.map((p) => g.planets[p])
    f.leg.planet = (ps.find((p) => p.owner === owner) ?? ps[0]).id
  }
  return null
}

/** Drop the last stop queued for a fleet (or, with none queued, nothing). */
export function dropWaypoint(g: Galaxy, owner: number, fleetId: number): boolean {
  const f = g.fleets.find((x) => x.id === fleetId)
  if (!f || f.owner !== owner || !f.waypoints?.length) return false
  f.waypoints = f.waypoints.slice(0, -1)
  return true
}

function startLeg(f: Fleet) {
  const h = f.route.shift()
  if (!h) return
  if (f.planet >= 0) f.from = f.planet
  f.leg = { ...h, left: h.total }
  f.planet = -1
}

/** Queue a ship at a planet's station. */
export function cantBuildAt(g: Galaxy, owner: number, planet: number, unit: string): string | null {
  const p = g.planets[planet]
  const t = UNIT[unit]
  if (p.owner !== owner) return 'Not our planet'
  if (!p.station) return 'Needs a station to build ships'
  // Ships behind a queued upgrade are fine at the current level; the ones that need the next level stay locked until
  // the upgrade has actually finished, because the level only rises then (queueing them early would be a promise the
  // shipyard might not keep if the upgrade is cancelled).
  if (t.level > p.station) return p.queue.some((q) => q.unit === 'station') ? `Needs station level ${t.level}: wait for the upgrade` : `Needs station level ${t.level}`
  const lock = yardLock(p, t)
  if (lock) return lock
  if (p.queue.length >= MAX_YARD) return 'Shipyard queue full'
  if (g.sides[owner].credits < t.cost) return 'Not enough credits'
  return null
}
/**
 * What a planet's buildings say about building a ship there, or null when they allow it: frigates
 * and corvettes need its Frigate Yard, cruisers its Capital Yard, flagships the Capital slip on it
 * too, and bombers the station's Strike hangar; strike craft, gunships and repair craft come from
 * the station itself. As with a station upgrade, a building still in the queue is not there yet.
 */
export function yardLock(p: Planet, t: UnitType): string | null {
  const queued = (id: string) => p.queue.some((q) => q.unit === id)
  const where = builtAt(t)
  if (where !== 'station' && p.base.yards[where] !== 'up') return queued(where) ? `Needs a ${WORKS_NAME[where]} here: wait for it` : `Needs a ${WORKS_NAME[where]} here`
  const need = needsModule(t)
  if (need && !p.base.mods.includes(need)) return queued(need) ? `Needs the ${MODULE[need].name}: wait for it` : `Needs the ${MODULE[need].name}: an expansion of the ${WORKS_NAME[MODULE[need].on]}`
  return null
}
export function buildAt(g: Galaxy, owner: number, planet: number, unit: string): string | null {
  const why = cantBuildAt(g, owner, planet, unit)
  if (why) return why
  const t = UNIT[unit]
  const s = g.sides[owner]
  s.credits -= t.cost
  s.spent.ships += t.cost
  book(s, calendar(g.time).day, -t.cost, `${t.name} at ${g.planets[planet].name}`)
  const time = t.build * SHIP_TIME
  g.planets[planet].queue.push({ unit, left: time, total: time })
  return null
}
/** Upgrading a station can be queued behind the ships already building: it goes to the back of the queue, so it
 * starts once everything ahead of it is done, and its credits are charged when it is queued, like a ship's. Only one
 * upgrade can sit in a planet's queue at a time. */
export function cantUpgradeStation(g: Galaxy, owner: number, planet: number): string | null {
  const p = g.planets[planet]
  if (p.owner !== owner) return 'Not our planet'
  if (p.station >= 4) return 'Station at its highest level'
  if (p.queue.some((q) => q.unit === 'station')) return 'Already being built'
  if (p.queue.length >= MAX_YARD) return 'Shipyard queue full'
  if (g.sides[owner].credits < STATION_COST[p.station + 1]) return 'Not enough credits'
  return null
}
export function upgradeStation(g: Galaxy, owner: number, planet: number): string | null {
  const why = cantUpgradeStation(g, owner, planet)
  if (why) return why
  const p = g.planets[planet]
  const s = g.sides[owner]
  const cost = STATION_COST[p.station + 1]
  s.credits -= cost
  s.spent.stations += cost
  book(s, calendar(g.time).day, -cost, p.station ? `Station level ${p.station + 1} at ${p.name}` : `Station at ${p.name}`)
  const time = STATION_TIME[p.station + 1]
  p.queue.push({ unit: 'station', left: time, total: time })
  return null
}

// --- Buildings: yards and expansions ------------------------------------------------------------------
//
// A planet's base grows as a skirmish one does (data.ts: the same yards, expansions, prices and
// station levels), but there are no engineers on the galaxy map: a yard or an expansion is ordered
// in the planet's queue like a station upgrade, paid when queued, and stands once its time is up
// (its skirmish build time times WORKS_TIME). A yard's ruin is rebuilt for REBUILD of the price.

/** What a yard or an expansion is called, for the queue and the ledger. */
export const workName = (id: WorkId) => (isYard(id) ? WORKS_NAME[id] : MODULE[id].name)
/** What a yard or an expansion costs at a planet: a yard's ruin is rebuilt for REBUILD of its price. */
export function workCost(g: Galaxy, owner: number, p: Planet, id: WorkId) {
  if (!isYard(id)) return MODULE[id].cost
  const t = yardOf(g.sides[owner].faction, id)
  return p.base.yards[id] === 'ruin' ? Math.round(t.cost * REBUILD) : t.cost
}
/** Seconds a yard or an expansion takes on the galaxy clock. */
export const workTime = (g: Galaxy, owner: number, id: WorkId) => (isYard(id) ? yardOf(g.sides[owner].faction, id).build : MODULE[id].time) * WORKS_TIME
/** The station level a yard or an expansion needs. */
export const workLevel = (g: Galaxy, owner: number, id: WorkId) => (isYard(id) ? yardOf(g.sides[owner].faction, id).level : MODULE[id].level)
/** Whether the building an expansion goes on stands at a planet (the station, or one of its yards). */
export const worksUp = (p: Planet, on: Works) => (on === 'station' ? p.station > 0 : p.base.yards[on] === 'up')

/**
 * What rules a yard or an expansion out at a planet whatever the credits and the queue (the
 * Buildings tab shows it locked, with this), or null: not ours, no station, already built or
 * queued, the station level is short, or the yard an expansion goes on isn't there.
 */
export function workLock(g: Galaxy, owner: number, planet: number, id: WorkId): string | null {
  const p = g.planets[planet]
  if (p.owner !== owner) return 'Not our planet'
  if (!p.station) return 'Needs a station'
  const queued = (x: string) => p.queue.some((q) => q.unit === x)
  if (isYard(id) ? p.base.yards[id] === 'up' : p.base.mods.includes(id)) return 'Already built'
  if (queued(id)) return 'Already being built'
  if (!isYard(id)) {
    const on = MODULE[id].on
    if (!worksUp(p, on)) return queued(on) ? `Needs the ${WORKS_NAME[on]}: wait for it` : `Needs a ${WORKS_NAME[on]} here`
  }
  const level = workLevel(g, owner, id)
  if (level > p.station) return queued('station') ? `Needs station level ${level}: wait for the upgrade` : `Needs station level ${level}`
  return null
}
export function cantWork(g: Galaxy, owner: number, planet: number, id: WorkId): string | null {
  const lock = workLock(g, owner, planet, id)
  if (lock) return lock
  const p = g.planets[planet]
  if (p.queue.length >= MAX_YARD) return 'Shipyard queue full'
  if (g.sides[owner].credits < workCost(g, owner, p, id)) return 'Not enough credits'
  return null
}
/** Order a yard (or its ruin rebuilt) or an expansion at a planet: paid now, built after its time. */
export function buildWork(g: Galaxy, owner: number, planet: number, id: WorkId): string | null {
  const why = cantWork(g, owner, planet, id)
  if (why) return why
  const p = g.planets[planet]
  const s = g.sides[owner]
  const cost = workCost(g, owner, p, id)
  s.credits -= cost
  s.spent.stations += cost
  book(s, calendar(g.time).day, -cost, `${isYard(id) && p.base.yards[id] === 'ruin' ? 'Rebuilding the ' : ''}${workName(id)} at ${p.name}`)
  const time = workTime(g, owner, id)
  p.queue.push({ unit: id, left: time, total: time, paid: cost })
  return null
}
/** What a queue entry gave back if it were cancelled now: what it cost when it was queued. */
const queuedCost = (p: Planet, q: Planet['queue'][number]) => q.paid ?? (q.unit === 'station' ? STATION_COST[p.station + 1] : UNIT[q.unit]?.cost ?? 0)
/** Cancel a queued ship or station work: the credits come back. */
export function cancelBuild(g: Galaxy, owner: number, planet: number, i: number) {
  const p = g.planets[planet]
  const q = p.queue[i]
  if (!q || p.owner !== owner) return
  refund(g, owner, p, q, 'Cancelled')
  p.queue.splice(i, 1)
}
function refund(g: Galaxy, owner: number, p: Planet, q: Planet['queue'][number], why: string) {
  const s = g.sides[owner]
  const back = queuedCost(p, q)
  s.credits += back
  if (isWork(q.unit)) s.spent.stations -= back
  else s.spent.ships -= back
  book(s, calendar(g.time).day, back, `${why}: ${q.unit === 'station' ? 'station work' : isWork(q.unit) ? workName(q.unit as WorkId) : UNIT[q.unit].name}`)
}
/**
 * A base falls with its station: its yards are left as ruins (for whoever holds the planet next to
 * rebuild at REBUILD of the price) and every expansion is gone.
 */
function razeBase(p: Planet) {
  for (const k of YARD_KINDS) if (p.base.yards[k] === 'up') p.base.yards[k] = 'ruin'
  p.base.mods = []
}
/** Expansions waiting in a planet's queue for a building that is gone now are refunded. */
function dropOrphans(g: Galaxy, p: Planet) {
  for (let i = p.queue.length - 1; i >= 0; i--) {
    const u = p.queue[i].unit
    if (!isModule(u) || worksUp(p, MODULE[u].on)) continue
    if (p.owner >= 0) refund(g, p.owner, p, p.queue[i], `Lost with its yard`)
    p.queue.splice(i, 1)
  }
}

// --- Battles ---------------------------------------------------------------------------------------

/** A battle waiting at a planet: who holds it, who attacks, and with what. The `Held` lists are
 * the part of each side's ships its fleets hold back in the reserve (included in `Ships`). `base`:
 * the holder's yards and expansions round its station (only when it owns the planet and has one). */
export type Clash = { planet: number; holder: number; attacker: number; station: number; holderShips: string[]; attackerShips: string[]; holderHeld: string[]; attackerHeld: string[]; base?: PlanetBase }

export function clashAt(g: Galaxy, planet: number): Clash | null {
  const p = g.planets[planet]
  const here = fleetsAt(g, planet)
  const owners = new Set(here.map((f) => f.owner))
  const defended = p.owner >= 0 && p.station > 0
  if (defended) owners.add(p.owner)
  if (owners.size < 2) return null
  // The planet's owner holds it; at a neutral planet, the fleet that got there first.
  const holder = owners.has(p.owner) ? p.owner : here.slice().sort((a, b) => a.arrived - b.arrived)[0].owner
  const attacker = [...owners].find((o) => o !== holder)!
  const ships = (o: number) => here.filter((f) => f.owner === o).flatMap((f) => f.ships)
  const held = (o: number) => here.filter((f) => f.owner === o).flatMap(heldShips)
  const station = p.owner === holder ? p.station : 0
  return { planet, holder, attacker, station, holderShips: ships(holder), attackerShips: ships(attacker), holderHeld: held(holder), attackerHeld: held(attacker), ...(station ? { base: copyBase(p.base) } : {}) }
}

/** Seconds into an auto-resolved battle before held back ships are called in (sooner when nothing
 * else of their side is left out there). */
export const RESERVE_CALL = 4

/** Yards in an auto-resolved battle: spread round the build radius, they are never all in the
 * fight. Each stands with `hull` of its hull and shields, and is shot at that much less readily
 * than a ship or the station (`aim`); once the station and the holder's ships are gone, the yards
 * fall with them. A whole base, yards and expansions, is then worth about as much to its holder as
 * two thirds of a cruiser at station level 2, one and a half at levels 3 and 4. */
export const AUTO_YARD = { hull: 0.35, aim: 0.85 }

/** How a battle ended: the winning side, and what's left of each side. Ships that jumped out are
 * `escaped`: they go back where they came from. `base`: the holder's yards still standing and the
 * expansions not shot off (left out: its buildings came through as they were). */
export type BattleResult = { winner: number; survivors: Record<number, string[]>; escaped: Record<number, string[]>; stationLeft: boolean; base?: { yards: YardKind[]; mods: ModuleId[] } }

/**
 * A quick result without playing it out: both sides trade damage once a second, each ship firing at
 * what its guns hurt most, until one side is gone. An attacker that has lost most of its fleet while
 * the defence still stands pulls out what's left. Ships held back count in full but come in late,
 * as a player would call them in: after RESERVE_CALL seconds, or at once when nothing else of their
 * side is left fighting. A side that wins before then keeps them untouched; an attacker that pulls
 * out takes them along.
 *
 * The holder's buildings fight too: its yards add their guns and part of their hulls (AUTO_YARD;
 * shot at as stations are, if less readily, and they fall with the station), a Shield core gives
 * the station 40% more shields and an Armour works its frigates and corvettes 20% more hull, as in
 * a battle. Whatever of them is destroyed is lost (BattleResult.base): a yard's expansions go with
 * it, the station's with the station.
 */
export function autoResolve(g: Galaxy, c: Clash, seed = g.time): BattleResult {
  const r = rng(Math.floor(seed * 1000) + c.planet)
  type U = { side: number; id: string; tier: Tier; hp: number; max: number; dps: (tier: Tier) => number; station?: boolean; yard?: YardKind; late?: boolean }
  const mods = c.base?.mods ?? []
  const plate = (o: number, t: UnitType) => (o === c.holder && mods.includes('armourWorks') && (t.tier === 'frigate' || t.kind === 'support') ? 1 + MODULE_FX.armour : 1)
  const mk = (side: number, id: string, late = false): U => {
    const t = UNIT[id]
    const hp = (t.hull * plate(side, t) + t.shield) * t.squad
    return { side, id, tier: t.tier, hp, max: hp, dps: (tier) => dpsVs(t, tier) * t.squad, ...(late ? { late } : {}) }
  }
  const side = (o: number, ships: string[], held: string[] = []) => [...withoutShips(ships, held).map((id) => mk(o, id)), ...held.map((id) => mk(o, id, true))]
  const us: U[] = [...side(c.holder, c.holderShips, c.holderHeld), ...side(c.attacker, c.attackerShips, c.attackerHeld)]
  if (c.station) {
    const faction = g.sides[c.holder].faction
    const t = stationType(faction, c.station, [], mods.filter((id) => MODULE[id].on === 'station'))
    const hp = t.hull + t.shield * (mods.includes('shieldCore') ? 1 + MODULE_FX.shield : 1)
    us.push({ side: c.holder, id: 'station', tier: 'station', hp, max: hp, dps: (tier) => dpsVs(t, tier), station: true })
    for (const k of YARD_KINDS) {
      if (c.base?.yards[k] !== 'up') continue
      const y = yardType(yardOf(faction, k).id, mods)
      const yhp = (y.hull + y.shield) * AUTO_YARD.hull
      us.push({ side: c.holder, id: k, tier: 'station', hp: yhp, max: yhp, dps: (tier) => dpsVs(y, tier), yard: k })
    }
  }
  // Luck: each side fights a little better or worse than on paper this time.
  const luck = { [c.holder]: 0.8 + r() * 0.4, [c.attacker]: 0.8 + r() * 0.4 } as Record<number, number>
  const total = (side: number) => us.filter((u) => u.side === side && u.hp > 0).reduce((s, u) => s + u.hp, 0)
  const start = { [c.holder]: total(c.holder), [c.attacker]: total(c.attacker) } as Record<number, number>
  let escaped: string[] = []
  for (let t = 0; t < 900; t++) {
    // The reserve is called in.
    for (const u of us) if (u.late && (t >= RESERVE_CALL || !us.some((x) => x.side === u.side && !x.late && x.hp > 0))) u.late = false
    const alive = us.filter((u) => u.hp > 0)
    // (The yards don't hold the planet on their own: they fall with the station.)
    if (!alive.some((u) => u.side === c.holder && !u.yard) || !alive.some((u) => u.side === c.attacker)) break
    const field = alive.filter((u) => !u.late)
    const dmg = new Map<U, number>()
    for (const a of field) {
      const foes = field.filter((u) => u.side !== a.side)
      let best = foes[0]
      let bs = -1
      for (const e of foes) {
        const s = a.dps(e.tier) * (0.7 + r() * 0.6) * (1 + (1 - e.hp / e.max) * 0.5) * (e.yard ? AUTO_YARD.aim : 1)
        if (s > bs) {
          bs = s
          best = e
        }
      }
      dmg.set(best, (dmg.get(best) ?? 0) + a.dps(best.tier) * luck[a.side] * (0.85 + r() * 0.3))
    }
    for (const [u, d] of dmg) u.hp -= d
    // A beaten attacker jumps out with what's left (fighters can't make the jump).
    if (t > 20 && total(c.attacker) < start[c.attacker] * 0.3 && total(c.holder) > start[c.holder] * 0.5) {
      escaped = us.filter((u) => u.side === c.attacker && u.hp > 0 && u.tier !== 'fighter').map((u) => u.id)
      for (const u of us) if (u.side === c.attacker) u.hp = 0
      break
    }
  }
  const left = (side: number) => us.filter((u) => u.side === side && u.hp > 0 && !u.station && !u.yard).map((u) => u.id)
  const holderLeft = us.some((u) => u.side === c.holder && u.hp > 0 && !u.yard)
  if (!holderLeft) for (const u of us) if (u.yard) u.hp = 0
  const stationLeft = us.some((u) => u.station && u.hp > 0)
  const yards = us.filter((u) => u.yard && u.hp > 0).map((u) => u.yard!)
  return {
    winner: holderLeft ? c.holder : c.attacker,
    survivors: { [c.holder]: left(c.holder), [c.attacker]: left(c.attacker) },
    escaped: { [c.holder]: [], [c.attacker]: escaped },
    stationLeft,
    ...(c.base ? { base: { yards, mods: mods.filter((id) => (MODULE[id].on === 'station' ? stationLeft : yards.includes(MODULE[id].on as YardKind))) } } : {}),
  }
}

/** The nearest planet of ours a beaten fleet can fall back to (not `not`), or -1. */
function fallback(g: Galaxy, owner: number, prefer: number, not: number) {
  if (prefer >= 0 && prefer !== not && g.planets[prefer].owner === owner) return prefer
  const from = g.planets[not].system
  let best = -1
  let bd = Infinity
  for (const p of g.planets) {
    if (p.owner !== owner || p.id === not) continue
    const path = lanePath(g, from, p.system)
    if (!path) continue
    const d = path.length + (p.system === from ? 0.5 : 0)
    if (d < bd) {
      bd = d
      best = p.id
    }
  }
  return best >= 0 ? best : prefer >= 0 && prefer !== not ? prefer : -1
}

/**
 * What's left of a side's fleets after a battle: the ships that came out of it go back into the
 * fleets they fought in (each type into the fleets that had it, in order, held back ones first as
 * they waited in the reserve), on the same spots of the same grids, so the fleets keep their names,
 * layouts, stops and held back ships; fleets with nothing left are gone. Ships without a place of
 * their own (a station's side has no fleet there) dock as new fleets.
 */
function refill(g: Galaxy, owner: number, planet: number, old: Fleet[], ships: string[]): Fleet[] {
  const left = new Map(grouped(ships))
  for (const f of old) {
    for (const it of f.items.slice().sort((a, b) => Number(!!b.held) - Number(!!a.held))) {
      const k = Math.min(it.n, left.get(it.unit) ?? 0)
      left.set(it.unit, (left.get(it.unit) ?? 0) - k)
      it.n = k
    }
    sync(f)
  }
  g.fleets = g.fleets.filter((f) => !old.includes(f) || f.items.length)
  const before = new Set(g.fleets)
  const rest = [...left].flatMap(([unit, n]) => Array.from({ length: Math.max(0, n) }, () => ({ unit })))
  if (rest.length) dock(g, owner, planet, rest, true)
  return [...old.filter((f) => f.items.length), ...g.fleets.filter((f) => !before.has(f))]
}

/** Settle a battle: survivors stay (the winner keeps or takes the planet), escaped ships fly back. */
export function applyBattle(g: Galaxy, c: Clash, res: BattleResult, auto: boolean) {
  const p = g.planets[c.planet]
  const here = fleetsAt(g, c.planet)
  // Fleets of other sides, if any, have no part in it: they're gone with the battle's losers.
  g.fleets = g.fleets.filter((f) => !here.includes(f) || f.owner === c.holder || f.owner === c.attacker)
  for (const o of [c.holder, c.attacker]) {
    const old = here.filter((f) => f.owner === o)
    const back = old[0]?.from ?? -1
    const ships = res.survivors[o] ?? []
    const esc = res.escaped[o] ?? []
    if (ships.length) {
      // Survivors stay, with any of theirs that jumped out (they're back with the fleet), and carry
      // on with the stops their fleets had queued.
      for (const f of refill(g, o, c.planet, old, [...ships, ...esc])) f.arrived = o === c.holder ? g.time - 1 : g.time
      continue
    }
    const to = esc.length ? fallback(g, o, back, c.planet) : -1
    if (to < 0) {
      g.fleets = g.fleets.filter((f) => !old.includes(f))
      continue
    }
    // Out of the battle at once: flying to the fallback planet.
    for (const f of refill(g, o, c.planet, old, esc)) moveFleet(g, o, f.id, to)
  }
  // The holder's buildings: a yard destroyed in the battle is a ruin now (its expansions gone with
  // it), and an expansion shot off is lost; both are built again from the planet's queue.
  if (c.station && res.base && p.owner === c.holder) {
    for (const k of YARD_KINDS) if (p.base.yards[k] === 'up' && !res.base.yards.includes(k)) p.base.yards[k] = 'ruin'
    p.base.mods = p.base.mods.filter((id) => res.base!.mods.includes(id) && worksUp(p, MODULE[id].on))
    dropOrphans(g, p)
  }
  if (c.station && !res.stationLeft) {
    p.station = 0
    p.queue = []
    razeBase(p)
  }
  // Survivors of a beaten side that didn't jump out are lost; the winner takes an emptied planet
  // once it has held the orbit (the usual capture).
  if (res.winner !== c.holder && p.owner === c.holder && !p.station) p.capture = null
  // Both sides saw how it ended, even one whose fleet is gone from there now.
  note(g, c.holder, p)
  note(g, c.attacker, p)
  g.events.push({ k: 'battle', planet: c.planet, owners: [c.holder, c.attacker], auto, winner: res.winner })
}

// --- The clock ---------------------------------------------------------------------------------------

/**
 * Advance the galaxy by dt seconds: income, shipyards, fleets in flight, captures, battles and the
 * AI. A battle that involves the player stops here (g.pending) until they settle it; battles
 * between AIs are auto-resolved.
 */
export function tickGalaxy(g: Galaxy, dt: number) {
  if (g.winner !== -1 || g.pending >= 0) return
  // Ships set from outside (a tool, a check script) get their place on the grid.
  layoutFleets(g)
  const before = calendar(g.time).day
  g.time += dt
  // Payday: every planet pays its owner at the end of the day.
  const today = calendar(g.time).day
  if (today > before) {
    g.sides.forEach((s, o) => {
      if (!s.alive) return
      let paid = 0
      for (const p of g.planets) {
        if (p.owner !== o) continue
        const v = planetIncome(g, p)
        p.earned += v
        paid += v
      }
      s.credits += paid
      s.earned += paid
      if (paid) book(s, before, paid, `Day ${before + 1} income`)
      s.history.push({ day: today, credits: Math.round(s.credits), income: paid })
      if (s.history.length > 400) s.history.splice(0, s.history.length - 400)
      g.events.push({ k: 'payday', owner: o, amount: paid, day: today })
    })
  }
  // Shipyards, and work on the station and its buildings. With a Second slip standing, the first
  // two ships in the queue are built at once (a building or an upgrade still goes on its own).
  for (const p of g.planets) {
    if (!p.queue.length || p.owner < 0) continue
    const two = p.base.mods.includes('secondSlip') && p.queue.length > 1 && !isWork(p.queue[0].unit) && !isWork(p.queue[1].unit)
    for (const q of p.queue.slice(0, two ? 2 : 1)) {
      q.left -= dt
      if (q.left > 0) continue
      if (!isWork(q.unit) && !yardRoom(g, p.owner, p.id, q.unit)) {
        // Every fleet here is full and there are MAX_FLEETS of them: the finished ship waits on its
        // slip, holding up the queue behind it, until a fleet makes room or leaves (said once).
        q.left = 0
        if (!q.full) g.events.push({ k: 'yardFull', planet: p.id, owner: p.owner, unit: q.unit })
        q.full = true
        continue
      }
      p.queue.splice(p.queue.indexOf(q), 1)
      if (q.unit === 'station') {
        p.station++
        g.events.push({ k: 'station', planet: p.id, owner: p.owner, level: p.station })
      } else if (isYard(q.unit)) {
        p.base.yards[q.unit] = 'up'
        g.events.push({ k: 'works', planet: p.id, owner: p.owner, what: q.unit })
      } else if (isModule(q.unit)) {
        const id = q.unit
        if (!worksUp(p, MODULE[id].on)) refund(g, p.owner, p, q, 'Lost with its yard')
        else if (!p.base.mods.includes(id)) {
          p.base.mods.push(id)
          g.events.push({ k: 'works', planet: p.id, owner: p.owner, what: id })
        }
      } else {
        dock(g, p.owner, p.id, [{ unit: q.unit }])
        g.events.push({ k: 'built', planet: p.id, owner: p.owner, unit: q.unit })
      }
    }
  }
  // Fleets in flight.
  for (const f of g.fleets) {
    if (!f.leg) continue
    f.leg.left -= dt
    if (f.leg.left > 0) continue
    // Into a system (to stay, or on the way through): a look round it as it comes out of hyperspace.
    if (f.leg.system !== f.system) glimpse(g, f.owner, f.leg.system)
    f.system = f.leg.system
    if (f.leg.planet >= 0) {
      f.planet = f.leg.planet
      f.arrived = g.time
      f.leg = null
      if (!f.route.length && !f.waypoints?.length) g.events.push({ k: 'arrived', fleet: f.id, planet: f.planet, owner: f.owner })
    } else f.leg = null
    const by = f.planet < 0 ? blockedBy(g, f.system, f.owner, true) : -1
    if (by >= 0) {
      // Flown into a system that's blockaded against it (it changed hands on the way): pulled out
      // of hyperspace at the blockading side's planet there.
      const stop = g.systems[f.system].planets.map((p) => g.planets[p]).sort((a, b) => Number(b.owner === by) - Number(a.owner === by) || b.station - a.station)[0]
      f.planet = stop.id
      f.route = []
      f.waypoints = []
      f.arrived = g.time
      g.events.push({ k: 'blockaded', fleet: f.id, owner: f.owner, system: f.system, by })
    } else if (f.route.length) {
      // Passing through: on to the next hop, round any blockade that has gone up since it set off.
      const dest = f.route[f.route.length - 1].planet
      const again = routeTo(g, f, dest)
      if (again && again.length) f.route = again
      if (again && again.length) startLeg(f)
      else if (!again) {
        f.route = []
        f.waypoints = []
        f.planet = g.systems[f.system].planets[0]
        f.arrived = g.time
        g.events.push({ k: 'blockaded', fleet: f.id, owner: f.owner, system: f.system, by: -1 })
      }
    } else if (f.planet < 0) {
      // A route that ended mid-system (shouldn't happen): settle at its first planet.
      f.planet = g.systems[f.system].planets[0]
    }
  }
  // An AI side's fleets at one planet join up where they fit whole: it plans around one main fleet
  // (with whatever full fleets wait beside it) and detachments sent off from it. The player's stay
  // apart (up to MAX_FLEETS, see capFleets), so they can be split.
  for (const f of [...g.fleets]) {
    if (!g.fleets.includes(f) || f.leg || f.planet < 0 || !g.sides[f.owner]?.ai) continue
    // (Not a fleet only stopping on its way, nor one waiting there.)
    const other = g.fleets.find((x) => x !== f && x.owner === f.owner && x.planet === f.planet && !x.leg && !x.route.length && !f.route.length && !x.waypoints?.length && !f.waypoints?.length && fitsInto(f, [x]))
    if (other) absorb(g, f, other)
  }
  // Battles, then captures.
  for (const p of g.planets) {
    const c = clashAt(g, p.id)
    if (c) {
      if (!g.sides[c.holder].ai || !g.sides[c.attacker].ai) {
        g.pending = p.id
        g.events.push({ k: 'battle', planet: p.id, owners: [c.holder, c.attacker], auto: false })
        updateSight(g)
        return
      }
      applyBattle(g, c, autoResolve(g, c), true)
      continue
    }
    const here = fleetsAt(g, p.id)
    const taker = here.find((f) => f.owner !== p.owner)
    if (taker && !here.some((f) => f.owner === p.owner)) {
      if (!p.capture || p.capture.owner !== taker.owner) {
        p.capture = { owner: taker.owner, t: 0 }
        g.events.push({ k: 'capturing', planet: p.id, owner: taker.owner, from: p.owner })
      }
      p.capture.t += dt
      if (p.capture.t >= CAPTURE_TIME) {
        const from = p.owner
        p.owner = taker.owner
        p.earned = 0
        p.capture = null
        p.queue = []
        // Its base fell with its station before it could be taken: the new owner finds the ruins.
        razeBase(p)
        // The side that lost it knows, even if it sees nothing there any more.
        if (from >= 0) note(g, from, p)
        g.events.push({ k: 'captured', planet: p.id, owner: taker.owner, from })
      }
    } else p.capture = null
  }
  // Fleets with stops queued go on once the planet they're at is theirs (taken, or theirs already).
  for (const f of g.fleets) {
    if (f.leg || f.route.length || f.planet < 0 || !f.waypoints?.length || g.planets[f.planet].owner !== f.owner) continue
    while (f.waypoints.length) {
      const next = f.waypoints.shift()!
      const hops = routeTo(g, f, next)
      if (hops?.length) {
        f.route = hops
        startLeg(f)
        break
      }
      if (!hops) g.events.push({ k: 'blockaded', fleet: f.id, owner: f.owner, system: f.system, by: -1 })
    }
  }
  // Join-ups, and the cap on fleets at a planet (fleets that just went on from a stop don't count).
  capFleets(g)
  // What each side sees now, for the AI and the map.
  updateSight(g)
  // The AI.
  g.sides.forEach((s, o) => {
    if (!s.ai || !s.alive) return
    g.aiT[o] = (g.aiT[o] ?? 0) - dt
    if (g.aiT[o] > 0) return
    galaxyAi(g, o)
    g.aiT[o] = GALAXY_AI[s.ai].think * (0.8 + roll(s.mind!) * 0.4)
  })
  // Who's still in it: anything owned or flying.
  g.sides.forEach((s, o) => {
    if (s.alive && !g.planets.some((p) => p.owner === o) && !g.fleets.some((f) => f.owner === o)) {
      s.alive = false
      g.events.push({ k: 'out', owner: o })
    }
  })
  const standing = g.sides.map((s, o) => (s.alive ? o : -1)).filter((o) => o >= 0)
  if (standing.length === 1) g.winner = standing[0]
}

/** The player's fleet battle at the pending planet was fought (or auto-resolved, or abandoned). */
export function settlePending(g: Galaxy, res: BattleResult | 'auto') {
  const c = g.pending >= 0 ? clashAt(g, g.pending) : null
  g.pending = -1
  if (!c) return
  applyBattle(g, c, res === 'auto' ? autoResolve(g, c) : res, res === 'auto')
  updateSight(g)
}
/** The attacker turns back before the battle: its fleets fly back where they came from. */
export function withdraw(g: Galaxy, owner: number) {
  const planet = g.pending
  if (planet < 0) return
  for (const f of fleetsAt(g, planet).filter((x) => x.owner === owner)) {
    const to = fallback(g, owner, f.from, planet)
    if (to >= 0) moveFleet(g, owner, f.id, to)
    else g.fleets = g.fleets.filter((x) => x !== f)
  }
  g.pending = -1
  updateSight(g)
}

// --- The galaxy AI ------------------------------------------------------------------------------------

/**
 * How the galaxy AI plays at each difficulty. It plays like a person with only so much time: a few
 * orders a minute at most (fleet moves and splits, ships and station work queued; whatever is past
 * that waits for a later look), and it misjudges strength, notices threats and chances late and now
 * and then makes the worse choice, all the more the easier it is. Minutes are game minutes, so a
 * sped-up galaxy speeds it up with everything else.
 */
export type GalaxyLevel = {
  blurb: string
  /** Orders it may give a minute. */
  apm: number
  /** Seconds between looks at the galaxy. */
  think: number
  /** How far off its estimate of an enemy planet's defence can be, either way (0.3: by up to 30%). */
  misjudge: number
  /** Seconds before it reacts to a threat to one of its planets, or acts on a weak enemy one. */
  react: number
  /** The chance that a decision is a worse pick than the best one it can see. */
  blunder: number
  /** Seconds it sticks with a staging planet, or waits after a failed attack before the next one. */
  commit: number
  /** How much stronger than the defence it thinks it sees its fleet must be before it attacks. */
  margin: number
  /** The fleet value it gathers before its first attack (it gathers more after a failed one). */
  wave: number
  /** Seconds before it attacks anything of the player's (it still takes unclaimed planets). */
  calm: number
  /** Detachments out taking unclaimed planets at once. */
  claims: number
  /** What its planets pay, against the player's. */
  income: number
}
export const GALAXY_AI: Record<Difficulty, GalaxyLevel> = {
  veryEasy: {
    blurb: 'A sleepy recruit: earns little, gives few orders, misjudges your strength badly and leaves you alone for the first eight minutes.',
    apm: 3, think: 9, misjudge: 0.4, react: 40, blunder: 0.3, commit: 90, margin: 1.8, wave: 5000, calm: 480, claims: 1, income: 0.55,
  },
  easy: {
    blurb: 'Slow to react and slow to grow: a few orders a minute, often wrong about your strength. No attacks for the first five minutes.',
    apm: 4, think: 7, misjudge: 0.3, react: 25, blunder: 0.2, commit: 75, margin: 1.6, wave: 4000, calm: 300, claims: 1, income: 0.7,
  },
  medium: {
    blurb: 'A fair fight: it gathers a strike fleet, expands steadily and defends what it holds. It leaves you two minutes to settle in.',
    apm: 8, think: 5, misjudge: 0.18, react: 12, blunder: 0.1, commit: 60, margin: 1.35, wave: 3000, calm: 120, claims: 2, income: 1,
  },
  hard: {
    blurb: 'Quick to react and hard to fool, with a little more income than you. It attacks from the start.',
    apm: 14, think: 3.5, misjudge: 0.1, react: 6, blunder: 0.04, commit: 45, margin: 1.2, wave: 2500, calm: 0, claims: 2, income: 1.15,
  },
}

/**
 * How an AI empire plays its campaign: one of the battle AI's profiles (ai.ts PROFILES), picked per
 * empire from the galaxy's seed, so it's the same on every load and campaigns saved before profiles
 * get one too without anything new in the save. Its fleet battles are fought with the same profile.
 */
export function galaxyProfile(g: Pick<Galaxy, 'seed'>, o: number): Profile {
  let h = Math.imul((g.seed + 1) ^ Math.imul(o + 7, 0x9e3779b1), 0x85ebca6b) >>> 0
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0
  return PROFILE_IDS[((h ^ (h >>> 16)) >>> 0) % PROFILE_IDS.length]
}
/** What a profile changes in a campaign: how much stronger than a planet's defence it wants to be
 * before it attacks (`margin`), how big a fleet it gathers first (`wave`), and how long it leaves
 * the player alone (`calm`), as multipliers on its difficulty's. */
export const GALAXY_STYLE: Record<Profile, { margin: number; wave: number; calm: number }> = {
  defensive: { margin: 1.15, wave: 1.3, calm: 1.3 },
  balanced: { margin: 1, wave: 1, calm: 1 },
  offensive: { margin: 0.88, wave: 0.8, calm: 0.7 },
}

/** What the galaxy AI remembers between looks (saved with the campaign). */
export type GalaxyMind = {
  /** Orders it may give right now: it refills at its APM, up to a few in hand. */
  budget: number
  /** When it last looked, for the refill. */
  last: number
  /** Its own dice, so it plays the same from a save; `salt` seeds how it misjudges each planet. */
  seed: number
  salt: number
  /** The planet its fleet gathers at, and when it next thinks about moving it. */
  stage: number
  restage: number
  /** The planet its main fleet is going for and why (null: none), and when it may pick the next. */
  target: number
  goal: 'attack' | 'defend' | null
  until: number
  /** The fleet value it waits for before attacking: it grows after a failed attack. */
  wave: number
  /** When it first saw each threat to its planets, and each enemy planet looking weak. */
  alarms: Record<number, number>
  spotted: Record<number, number>
  /** Detachments out taking planets: fleet id to the planet. */
  claims: Record<number, number>
  /** Orders given this campaign. */
  orders: number
}

function newMind(g: Galaxy, o: number): GalaxyMind {
  const D = GALAXY_AI[g.sides[o].ai ?? 'medium']
  const seed = (Math.imul(g.seed + 1, 2654435761) + o * 40503) >>> 0
  return { budget: 2, last: g.time, seed, salt: seed, stage: -1, restage: 0, target: -1, goal: null, until: 0, wave: D.wave * GALAXY_STYLE[galaxyProfile(g, o)].wave, alarms: {}, spotted: {}, claims: {}, orders: 0 }
}
/** The AI's next dice roll, from 0 up to 1. */
function roll(m: GalaxyMind) {
  m.seed = (Math.imul(m.seed, 1664525) + 1013904223) >>> 0
  return m.seed / 4294967296
}
/** How the AI misjudges a planet's defence right now: a factor near 1 that drifts every `commit`
 * seconds, the same on every look in between (so it doesn't flip-flop from one look to the next). */
function misjudged(m: GalaxyMind, D: GalaxyLevel, planet: number, time: number) {
  let h = Math.imul(m.salt ^ Math.imul(planet + 1, 374761393) ^ Math.imul(Math.floor(time / D.commit) + 1, 668265263), 2246822519) >>> 0
  h = Math.imul(h ^ (h >>> 13), 3266489917) >>> 0
  h = (h ^ (h >>> 16)) >>> 0
  return 1 + D.misjudge * ((h / 4294967296) * 2 - 1)
}
/** Where a fleet is headed in the end, stops included. */
const finalStop = (f: Fleet) => (f.waypoints?.length ? f.waypoints[f.waypoints.length - 1] : headedTo(f))
const flying = (f: Fleet) => !!f.leg || f.route.length > 0

/** What the AI guesses guards a planet it has never seen the orbit of (credits of ships): enough to
 * keep it from throwing a lone ship at an unknown, not so much that it never probes. */
const FOG_GUESS = 900

/**
 * The AI's look at the galaxy, every few seconds. It keeps one main fleet together at a staging
 * planet near the front, where its best shipyard builds straight into it (full fleets wait beside
 * it and go where it goes: the main army). It defends planets under attack (once it has noticed),
 * sends the army at a reachable enemy planet it thinks it can beat once it has gathered enough, and
 * keeps at that attack until it's won or lost instead of picking again on every look. A detachment
 * or two of a couple of ships takes unclaimed planets nearby (and, scouting as they go, finds out
 * what holds the planets it can't see). Every order comes out of its budget, defence first. It
 * plays under the fog of war: it reads planets and enemy fleets only through what its side sees and
 * remembers (known, canSee), never the galaxy as it is.
 */
function galaxyAi(g: Galaxy, o: number) {
  const s = g.sides[o]
  const D = GALAXY_AI[s.ai!]
  const m = (s.mind ??= newMind(g, o))
  m.budget = Math.min(Math.max(2, D.apm / 4), m.budget + ((g.time - m.last) * D.apm) / 60)
  m.last = g.time
  /** Give an order if there's budget for it; it only counts if it went through. */
  const order = (give: () => string | null) => {
    if (m.budget < 1 || give()) return false
    m.budget--
    m.orders++
    return true
  }
  const hostile = (owner: number) => owner >= 0 && owner !== o
  /** Who holds a planet, as far as it knows. */
  const holder = (p: Planet) => ownerFor(g, o, p)
  /** Enemy fleets it can see. */
  const seen = g.fleets.filter((f) => hostile(f.owner) && canSee(g, o, f))
  const enemyAt = (pid: number) => seen.some((f) => !f.leg && f.planet === pid)
  const mine = g.planets.filter((p) => p.owner === o)
  const hops = (from: number, to: number) => {
    const path = lanePath(g, from, to, o)
    return path ? path.length - 1 : 99
  }
  /** What it believes holds a planet: in a system it sees, the enemy fleets there (half for those at
   * other planets of the system) and the station with the yards round it; elsewhere what it saw
   * there last (a guess where it never looked); all misjudged a little. */
  const defence = (p: Planet) => {
    const k = known(g, o, p)
    let v = hostile(k.owner) ? k.station * 1500 + (k.station ? baseGuard(k.base) : 0) : 0
    if (k.live) {
      for (const f of seen) if (!f.leg && f.system === p.system) v += fleetValue(f.ships) * (f.planet === p.id ? 1 : 0.5)
    } else v += k.ships < 0 ? (hostile(k.owner) ? FOG_GUESS : 0) : k.value
    return v * misjudged(m, D, p.id, g.time)
  }
  const style = GALAXY_STYLE[galaxyProfile(g, o)]
  const calmFor = (owner: number) => g.time < D.calm * style.calm && !g.sides[owner]?.ai

  // Threats: enemy fleets it can see at our planets, or flying in to one inside a system it sees
  // (what's coming down the lanes it can't see until it arrives). It acts on each only once it has
  // been there a while: it notices late.
  const threat = new Map<number, number>()
  for (const f of seen) {
    const to = f.leg ? f.leg.planet : f.planet
    if (to < 0 || g.planets[to].owner !== o) continue
    threat.set(to, (threat.get(to) ?? 0) + fleetValue(f.ships))
  }
  for (const k of Object.keys(m.alarms)) if (!threat.has(Number(k))) delete m.alarms[Number(k)]
  for (const pid of threat.keys()) m.alarms[pid] ??= g.time

  // Detachments: done once their planet is ours, called off when the fleet is gone or an enemy is
  // seen there first.
  for (const [k, pid] of Object.entries(m.claims)) {
    const f = g.fleets.find((x) => x.id === Number(k))
    if (!f || g.planets[pid].owner === o || enemyAt(pid)) delete m.claims[Number(k)]
  }
  const claimed = new Set(Object.keys(m.claims).map(Number))
  const fleets = g.fleets.filter((f) => f.owner === o)
  const main = fleets.filter((f) => !claimed.has(f.id)).reduce<Fleet | null>((b, f) => (!b || fleetValue(f.ships) > fleetValue(b.ships) ? f : b), null)
  const mainIdle = !!main && !flying(main) && main.planet >= 0
  // The main army: the main fleet and the fleets that go where it goes (full ones that couldn't join
  // it): idle beside it, or on their way with it to the same planet.
  const withMain = (f: Fleet) => (mainIdle ? !flying(f) && f.planet === main!.planet && !f.waypoints?.length : flying(f) && finalStop(f) === finalStop(main!))
  const army = !main ? [] : [main, ...fleets.filter((f) => f !== main && !claimed.has(f.id) && withMain(f))]
  const mainValue = army.reduce((v, f) => v + fleetValue(f.ships), 0)
  const inArmy = new Set(army)
  /** The whole army goes: one order, as a player sends a selection. */
  const sendArmy = (planet: number) => {
    let why: string | null = 'No fleet'
    for (const f of army) if (!moveFleet(g, o, f.id, planet)) why = null
    return why
  }

  // The staging planet: our shipyard nearest the enemy (as far as it knows), rethought now and then.
  if (g.planets[m.stage]?.owner !== o || g.time >= m.restage) {
    const enemySystems = [...new Set(g.planets.filter((p) => hostile(holder(p))).map((p) => p.system))]
    const front = (p: Planet) => Math.min(99, ...enemySystems.map((sys) => hops(p.system, sys)))
    const yards = mine.filter((p) => p.station > 0)
    const pick = (yards.length ? yards : mine).slice().sort((a, b) => front(a) - front(b) || b.station - a.station)[0]
    if (pick) m.stage = pick.id
    m.restage = g.time + D.commit
  }

  // 1. Defence: the army goes to a planet it has noticed is under attack, if it's near and can win
  // there. An attack under way gives way to it, unless it's nearly there; a defence under way is
  // seen through (no chasing every raid around).
  const alarms = [...threat]
    .filter(([pid]) => g.time - m.alarms[pid] >= D.react)
    .map(([pid, v]) => ({ p: g.planets[pid], v: v * misjudged(m, D, pid, g.time) }))
    .sort((a, b) => b.p.station - a.p.station || b.p.income - a.p.income)
  if (main && m.goal !== 'defend' && !(m.goal === 'attack' && eta(main) < 20) && alarms.length && roll(m) > D.blunder) {
    const save = alarms.find((a) => mainValue >= a.v * 0.8 && hops(main.leg ? main.leg.system : main.system, a.p.system) <= 3)
    if (save && finalStop(main) !== save.p.id && order(() => sendArmy(save.p.id))) {
      m.goal = 'defend'
      m.target = save.p.id
    }
  }

  // 2. The goal in hand: kept until it's won or lost.
  if (main && m.goal) {
    const t = g.planets[m.target]
    const there = !flying(main) && main.planet === t.id
    const won = m.goal === 'attack' ? t.owner === o : !threat.has(t.id)
    if (won && there) m.goal = null
    else if (m.goal === 'attack' && there) {
      // Holding the orbit while the battle is fought or the planet is taken.
    } else if (!flying(main) && !there) {
      // Beaten back (the survivors jumped out), or stopped on the way: it gathers more next time.
      if (m.goal === 'attack') m.wave = Math.min(D.wave * style.wave * 3, m.wave * 1.25)
      m.goal = null
      m.until = g.time + D.commit
    }
  }

  // 3. A new attack: the army, gathered, at a reachable enemy planet it thinks it can beat well
  // enough, near ones first. A weak spot only counts once it has looked weak for a while.
  if (main && mainIdle && !m.goal && g.time >= m.until) {
    const options: { p: Planet; score: number }[] = []
    for (const p of g.planets) {
      const owner = holder(p)
      const need = hostile(owner) ? defence(p) * D.margin * style.margin + 400 : Infinity
      const h = need <= mainValue ? hops(main.system, p.system) : 99
      if (h >= 99 || calmFor(owner)) {
        delete m.spotted[p.id]
        continue
      }
      m.spotted[p.id] ??= g.time
      if (g.time - m.spotted[p.id] >= D.react / 2) options.push({ p, score: need + h * 700 - p.income * 4 - known(g, o, p).station * 300 })
    }
    options.sort((a, b) => a.score - b.score)
    const pick = roll(m) < D.blunder ? options[Math.floor(roll(m) * Math.min(3, options.length))] : options[0]
    if (pick && mainValue >= m.wave && order(() => sendArmy(pick.p.id))) {
      m.goal = 'attack'
      m.target = pick.p.id
    }
  }

  // 4. Detachments take unclaimed planets nearby (and, once it's not calm, enemy ones it believes
  // have no station): a spare fleet first, else a ship or two split off the main fleet while it
  // waits. A lone ship only goes next door.
  const expand = () => {
    const open = g.planets.filter((p) => {
      const owner = holder(p)
      return owner !== o && m.target !== p.id && !Object.values(m.claims).includes(p.id) && (owner < 0 || (!calmFor(owner) && !known(g, o, p).station)) && !enemyAt(p.id)
    })
    const spare = fleets.filter((f) => !inArmy.has(f) && !claimed.has(f.id) && !flying(f) && f.planet >= 0)
    for (let n = Object.keys(m.claims).length; n < D.claims && open.length; n++) {
      const from = spare.shift() ?? (main && mainIdle && !m.goal && main.ships.length >= 5 ? main : null)
      if (!from) break
      const near = open
        .map((p) => ({ p, h: hops(from.system, p.system) }))
        .filter((x) => x.h <= ((from === main ? main.ships.length < 7 : from.ships.length < 2) ? 1 : 2))
        .sort((a, b) => a.h - b.h || b.p.income - a.p.income)
      const goal = roll(m) < D.blunder ? near[Math.floor(roll(m) * near.length)] : near[0]
      if (!goal) continue
      const take = from === main ? from.ships.filter((id) => UNIT[id].tier !== 'fighter').sort((a, b) => UNIT[a].cost - UNIT[b].cost).slice(0, from.ships.length >= 7 ? 2 : 1) : undefined
      if (take && !take.length) continue
      const before = new Set(g.fleets.map((f) => f.id))
      if (!order(() => moveFleet(g, o, from.id, goal.p.id, take))) break
      const sent = take ? g.fleets.find((f) => !before.has(f.id)) : from
      if (sent) m.claims[sent.id] = goal.p.id
      open.splice(open.indexOf(goal.p), 1)
    }
  }

  // 5. Everything else gathers: spare fleets join the main fleet (or go to the staging planet while
  // it's away), as long as there's room for them there.
  const gatherAll = () => {
    const spare = fleets.filter((f) => g.fleets.includes(f) && !inArmy.has(f) && !claimed.has(f.id) && !(f.id in m.claims) && !flying(f) && f.planet >= 0)
    const gather = main && mainIdle && !m.goal ? main.planet : m.stage
    for (const f of spare) {
      // (Not one that's busy taking the planet it's at, nor one with nowhere to fit there.)
      if (flying(f) || gather < 0 || f.planet === gather || g.planets[f.planet].capture?.owner === o) continue
      const there = fleetsHere(g, o, gather)
      if (there.length >= MAX_FLEETS && !fitsInto(f, there)) continue
      if (!order(() => moveFleet(g, o, f.id, gather))) break
    }
    // An idle main fleet away from the staging planet goes back to it, unless it sits at a shipyard
    // of ours: then that becomes the staging planet (no flying back and forth).
    if (main && mainIdle && !m.goal && m.stage >= 0 && main.planet !== m.stage && !threat.has(main.planet)) {
      const here = g.planets[main.planet]
      if (here.owner === o && here.station > 0) m.stage = here.id
      else order(() => sendArmy(m.stage))
    }
  }

  // 6. Buildings (see planBase), stations, then ships with what orders are left. Ships come from the staging planet's yard
  // (they join the main fleet right there, no order needed to send them), and from another yard
  // only while that one is full, builds bigger ships or money piles up. With few orders to spare it buys bigger ships
  // rather than many small ones, the more so the richer it is. A yard whose fleets have no room for
  // the ship is passed over (it would only wait on its slip).
  const spend = () => {
    const yards = mine.filter((p) => p.station > 0)
    planBase(g, o, m, yards, order)
    if (yards.length < Math.ceil(mine.length / 3)) {
      const site = mine.filter((p) => !p.station && !p.queue.length).sort((a, b) => b.income - a.income)[0]
      if (site && s.credits > STATION_COST[1] + 400) order(() => upgradeStation(g, o, site.id))
    }
    const stage = g.planets[m.stage]
    const stageFull = !stage || stage.owner !== o || stage.queue.length >= 3
    for (const p of yards.sort((a, b) => Number(b.id === m.stage) - Number(a.id === m.stage) || b.station - a.station)) {
      // An upgrade needs an empty shipyard: it stops queueing ships there until it can.
      if (p.station < 4 && s.credits > STATION_COST[p.station + 1] * 1.4 + 600) {
        if (!p.queue.length) order(() => upgradeStation(g, o, p.id))
        continue
      }
      if (p.id === m.stage ? p.queue.length >= 3 : p.queue.length >= 1 || !(stageFull || s.credits > 4000 || p.station > stage!.station)) continue
      // (Only what this planet's yards build.)
      const can = buildable(s.faction).filter((t) => t.level <= p.station && t.cost <= s.credits - 300 && !yardLock(p, t))
      if (!can.length) break
      const rich = Math.min(1, s.credits / 6000)
      const pick = can[Math.min(can.length - 1, Math.floor(Math.pow(roll(m), 0.6 - rich * 0.35) * can.length))]
      if (pick.tier === 'capital' && fleets.some((f) => f.ships.some((id) => UNIT[id].tier === 'capital'))) continue
      if (!yardRoom(g, o, p.id, pick.id)) continue
      if (!order(() => buildAt(g, o, p.id, pick.id))) break
    }
  }

  // Money piling up goes on ships before anything else; otherwise expanding and gathering come first.
  if (s.credits > 2500) {
    spend()
    expand()
    gatherAll()
  } else {
    expand()
    gatherAll()
    spend()
  }
}
/** The galaxy AI's look, for the check scripts (the clock calls it by itself). */
export const thinkAi = galaxyAi

/** What the AI reckons a planet's buildings add to its defence, in credits of ships: a yard's
 * hull and guns, and the station's Shield core (as they count in an auto-resolved battle, AUTO_YARD:
 * the whole base a little over a cruiser's worth). */
const baseGuard = (b: PlanetBase) => (b.yards.yard === 'up' ? 900 : 0) + (b.yards.cyard === 'up' ? 1000 : 0) + (b.mods.includes('shieldCore') ? 250 : 0)

/**
 * The galaxy AI plans its planets' buildings by its profile, one order per look at most, and only
 * with credits to spare beyond what it keeps for ships (a planet that builds no frigates yet comes
 * first, as frigates are the line). Its staging planet (the front: the main fleet gathers there) is
 * a frontier outpost: a Frigate Yard as soon as its station allows, and the profile's station
 * expansions (a defensive admiral's Shield core first). Its forge world is its core: the yard with
 * the biggest station, the one furthest from the enemy (as far as it knows) of those: a Frigate Yard
 * too, then a Capital Yard once the station is level 3, and the Capital slip at level 4 for a
 * flagship. The yards' expansions follow
 * on whichever of the two has the yard, in its profile's order (ai.ts PROFILES `modules`: an
 * offensive admiral starts with the Second slip and Strike hangar, a defensive one with the Shield
 * core and Drydock). A ruined yard is rebuilt before anything new, as it costs half. Ships come
 * from the station meanwhile (strike craft and gunships need no yard), so it never stalls.
 */
function planBase(g: Galaxy, o: number, m: GalaxyMind, yards: Planet[], order: (give: () => string | null) => boolean) {
  const s = g.sides[o]
  if (!yards.length || m.budget < 1) return
  const hostile = (p: Planet) => ownerFor(g, o, p) >= 0 && ownerFor(g, o, p) !== o
  const enemy = [...new Set(g.planets.filter(hostile).map((p) => p.system))]
  const far = (p: Planet) => Math.min(99, ...enemy.map((sys) => lanePath(g, p.system, sys, o)?.length ?? 99))
  const stage = yards.find((p) => p.id === m.stage) ?? yards[0]
  const forge = yards.slice().sort((a, b) => b.station - a.station || far(b) - far(a) || a.id - b.id)[0]
  const sites = forge === stage ? [stage] : [forge, stage]
  const want: [Planet, WorkId][] = []
  // Ruins first, then a Frigate Yard where there is none, then the Capital Yard and its slip.
  for (const p of yards) for (const k of YARD_KINDS) if (p.base.yards[k] === 'ruin' && (k === 'yard' || p === forge)) want.push([p, k])
  for (const p of sites) want.push([p, 'yard'])
  want.push([forge, 'cyard'], [forge, 'capitalSlip'])
  for (const id of PROFILES[galaxyProfile(g, o)].modules) {
    const on = MODULE[id].on
    const at = on === 'station' ? stage : sites.find((p) => worksUp(p, on)) ?? forge
    want.push([at, id])
  }
  // The first it may build now (the rest waits for a later look), if the credits are there.
  const none = !g.planets.some((p) => p.owner === o && p.base.yards.yard === 'up')
  for (const [p, id] of want) {
    if (workLock(g, o, p.id, id) || p.queue.length >= 2) continue
    const cost = workCost(g, o, p, id)
    if (s.credits < cost + (none && id === 'yard' ? 200 : 1200)) return
    order(() => buildWork(g, o, p.id, id))
    return
  }
}

// --- Saving --------------------------------------------------------------------------------------------

/**
 * Campaigns are saved in slots, each under a name the player chose, in this browser. The campaign in
 * play saves into its own slot by itself (every few seconds, and on anything that matters), so it
 * can always be loaded again from where it was; "Save as" copies it into a new slot. The index
 * lists every slot with what the load screen shows, newest first.
 */
export type SaveInfo = { id: string; name: string; savedAt: number; galaxy: string; week: number; faction: FactionId; planets: number; enemy: number; total: number }
const INDEX = 'mvlos.empires.saves'
const SLOT = (id: string) => `mvlos.empires.save.${id}`
/** Where the single save lived before there were slots. */
const LEGACY = 'mvlos.empires.conquest'
const newSaveId = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`

function readIndex(): SaveInfo[] {
  try {
    const v = JSON.parse(localStorage.getItem(INDEX) ?? '[]') as SaveInfo[]
    return Array.isArray(v) ? v.filter((x) => x && typeof x.id === 'string') : []
  } catch {
    return []
  }
}
function writeIndex(list: SaveInfo[]) {
  try {
    localStorage.setItem(INDEX, JSON.stringify(list))
  } catch {
    // Storage blocked: nothing to list.
  }
}
const infoOf = (g: Galaxy): SaveInfo => ({
  id: g.save.id,
  name: g.save.name,
  savedAt: Date.now(),
  galaxy: g.name,
  week: Math.floor(g.time / DAY / WEEK) + 1,
  faction: g.sides[0].faction,
  planets: g.planets.filter((p) => p.owner === 0).length,
  enemy: g.planets.filter((p) => p.owner > 0).length,
  total: g.planets.length,
})

/** The old single save becomes a slot of its own, once. */
function migrateLegacy() {
  try {
    const raw = localStorage.getItem(LEGACY)
    if (!raw) return
    const g = clean(JSON.parse(raw))
    localStorage.removeItem(LEGACY)
    if (!g) return
    g.save = { id: newSaveId(), name: `${g.name}, ${FACTIONS[g.sides[0].faction].name}` }
    saveGalaxy(g)
  } catch {
    // Unreadable: left as it is.
  }
}

/** Every saved campaign, newest first. */
export function listSaves(): SaveInfo[] {
  migrateLegacy()
  return readIndex().sort((a, b) => b.savedAt - a.savedAt)
}
export const latestSave = () => listSaves()[0]

/** Save the campaign into its slot (a new slot, under `name`, with `as`). Returns whether it fit. */
export function saveGalaxy(g: Galaxy, as?: string): boolean {
  if (as !== undefined) g.save = { id: newSaveId(), name: as.trim() || g.save.name }
  try {
    localStorage.setItem(SLOT(g.save.id), JSON.stringify({ ...g, events: [] }))
    writeIndex([infoOf(g), ...readIndex().filter((x) => x.id !== g.save.id)])
    return true
  } catch {
    // Storage full or blocked: this session only.
    return false
  }
}

/** What a planet with a station of this level had before planets had buildings (version 1 saves):
 * the yards that level allowed its ships from, level 2 a Frigate Yard and level 3 a Capital Yard
 * too, and no expansions. */
const baseOfOld = (station: number): PlanetBase => ({ yards: { ...(station >= 2 ? { yard: 'up' as const } : {}), ...(station >= 3 ? { cyard: 'up' as const } : {}) }, mods: [] })
/** A planet's buildings as saved, made sound: only yards and expansions that exist. */
function cleanBase(b: PlanetBase | undefined): PlanetBase | undefined {
  if (!b || typeof b !== 'object') return undefined
  const yards: PlanetBase['yards'] = {}
  for (const k of YARD_KINDS) if (b.yards?.[k] === 'up' || b.yards?.[k] === 'ruin') yards[k] = b.yards[k]
  return { yards, mods: Array.isArray(b.mods) ? [...new Set(b.mods.filter((id) => MODULE[id]))] : [] }
}

/** A saved campaign, made fit for this version of the game, or null. */
function clean(v: Galaxy | null): Galaxy | null {
  const version = (v as { v?: number } | null)?.v
  if (!v || (version !== 1 && version !== 2) || !Array.isArray(v.systems) || !Array.isArray(v.planets) || !Array.isArray(v.fleets)) return null
  // Ships that no longer exist in the game are dropped.
  for (const f of v.fleets) {
    f.ships = (f.ships ?? []).filter((id) => UNIT[id])
    if (Array.isArray(f.items)) {
      f.items = f.items.filter((i) => UNIT[i.unit] && i.n > 0)
      sync(f)
    }
    if (f.reserve && typeof f.reserve !== 'object') delete f.reserve
    if (typeof f.join !== 'number') delete f.join
  }
  v.fleets = v.fleets.filter((f) => f.ships.length)
  // Saves from when campaigns picked their ship sizes: every campaign is fought at the one size now
  // (models/sizes.ts), a Classic one too. Its fleets carry over as they are.
  if (v.rules) delete (v.rules as { sizes?: unknown }).sizes
  // Saves from before the grid: every fleet is laid out, biggest ships first, its held back ships
  // still held back; what doesn't fit makes another fleet beside it.
  layoutFleets(v)
  // Saves from before the cap on fleets at a planet: the spare ones join up where they fit.
  capFleets(v)
  for (const p of v.planets) {
    // Saves from before planets had buildings: each owned planet keeps what its station level let
    // it build (see baseOfOld), so nothing is lost.
    p.base = cleanBase(p.base) ?? (version === 1 && p.owner >= 0 ? baseOfOld(p.station ?? 0) : emptyBase())
    p.queue = (Array.isArray(p.queue) ? p.queue : []).filter((q) => q.unit === 'station' || UNIT[q.unit] || isWork(q.unit))
    if (!PLANET_KINDS[p.kind]) p.kind = 'barren'
    // Saves from before planets had their own income.
    p.income ??= PLANET_KINDS[p.kind].income
    p.earned ??= 0
  }
  for (const s of v.sides) {
    s.earned ??= 0
    s.spent ??= { ships: 0, stations: 0 }
    s.history ??= []
    s.ledger ??= []
  }
  v.events = []
  v.rules ??= { blockade: 'majority', frontline: true }
  v.rules.frontline ??= true
  // Saves from before the fog of war: each side starts with the galaxy as it is now on its charts,
  // and its sight from what it holds and where its fleets are.
  for (const s of v.sides) if (!Array.isArray(s.intel) || s.intel.length !== v.planets.length) s.intel = chartOf(v)
  // What each side last saw of a planet before there were buildings: what that station level had.
  for (const s of v.sides) for (const i of s.intel!) if (i) i.base = cleanBase(i.base) ?? (version === 1 ? baseOfOld(i.station ?? 0) : emptyBase())
  v.v = 2
  updateSight(v)
  return v
}
export function loadSave(id: string): Galaxy | null {
  try {
    const g = clean(JSON.parse(localStorage.getItem(SLOT(id)) ?? 'null') as Galaxy | null)
    if (g) g.save = { id, name: g.save?.name ?? readIndex().find((x) => x.id === id)?.name ?? g.name }
    return g
  } catch {
    return null
  }
}
export function deleteSave(id: string) {
  try {
    localStorage.removeItem(SLOT(id))
  } catch {
    // Nothing to remove.
  }
  writeIndex(readIndex().filter((x) => x.id !== id))
}
export function renameSave(id: string, name: string) {
  const n = name.trim()
  if (!n) return
  writeIndex(readIndex().map((x) => (x.id === id ? { ...x, name: n } : x)))
  const g = loadSave(id)
  if (!g) return
  g.save.name = n
  try {
    localStorage.setItem(SLOT(id), JSON.stringify(g))
  } catch {
    // The list has the new name; the slot keeps the old one until it's saved again.
  }
}
export const factionName = (g: Galaxy, o: number) => FACTIONS[g.sides[o].faction].name
