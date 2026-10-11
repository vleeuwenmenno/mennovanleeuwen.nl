// Galactic conquest: a galaxy of star systems joined by hyperlanes, each with a star and a few
// planets. Planets pay their owner every day, planets with a station build ships, and fleets fly
// between planets: inside a system, or across the lanes to another one. A fleet arriving where an
// enemy fleet or station is starts a fleet battle (played in the battle view, or auto-resolved);
// an undefended planet is taken by staying in its orbit for a while. The galaxy runs in real time,
// in seconds; a day is DAY seconds. No DOM, so headless sims can load it.

import type { Difficulty } from './ai.ts'
import { FACTIONS, UNIT, buildable, stationType, unitOf, type FactionId, type Tier } from './data.ts'
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
  /** Credits a day before the station's bonus: its kind's, varied a little per planet. */
  income: number
  /** Credits it has paid its current owner since they took it. */
  earned: number
  /** Ships (or a station level: 'station') being built here, first one in progress. */
  queue: { unit: string; left: number; total: number }[]
  /** Who is taking it, and how far along (seconds). */
  capture: { owner: number; t: number } | null
}
export type StarSystem = { id: number; name: string; x: number; y: number; star: StarKind; planets: number[] }
export type Hop = { system: number; planet: number; total: number }
export type Fleet = {
  id: number
  owner: number
  ships: string[]
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
}
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

export type Galaxy = {
  v: 1
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
    v: 1,
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
      g.planets.push({ id: pid, system: id, name, kind, orbit: i, angle: r() * Math.PI * 2, size: GIANTS.includes(kind) ? 1.3 : kind === 'barren' ? 0.8 : 1, owner: -1, station: 0, income, earned: 0, queue: [], capture: null })
      sys.planets.push(pid)
    })
    g.systems.push(sys)
  })
  g.lanes = laneGraph(g.systems)
  // The sides: the player first, then the AI on the other faction.
  const other: FactionId = opts.faction === 'republic' ? 'droid' : 'republic'
  const side = (faction: FactionId, ai: Difficulty | null): Side => ({ faction, credits: opts.credits, ai, alive: true, earned: 0, spent: { ships: 0, stations: 0 }, history: [], ledger: [] })
  g.sides = [side(opts.faction, null), side(other, opts.difficulty)]
  // Home systems: the capital (its first planet gets a level 3 station) and a neighbour (level 1).
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
    addFleet(g, o, cap, [f('fighter'), f('fighter'), f('gunship'), f('gunship'), f('frigate')])
  })
  return g
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y)

function addFleet(g: Galaxy, owner: number, planet: number, ships: string[]): Fleet {
  // Joins a fleet of ours already sitting there.
  const here = g.fleets.find((f) => f.owner === owner && f.planet === planet && !f.leg)
  if (here) {
    here.ships.push(...ships)
    return here
  }
  const p = g.planets[planet]
  const f: Fleet = { id: g.nextId++, owner, ships: [...ships], planet, system: p.system, from: planet, leg: null, route: [], arrived: g.time }
  g.fleets.push(f)
  return f
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
/** Who holds a system: the side that owns most of its planets, or -1. */
export function systemOwner(g: Galaxy, s: number) {
  const n = [0, 0]
  for (const pid of g.systems[s].planets) if (g.planets[pid].owner >= 0) n[g.planets[pid].owner]++
  return n[0] > n[1] ? 0 : n[1] > n[0] ? 1 : -1
}

/** The side whose blockade stops `owner`'s fleets flying through system `s`, or -1 (see BlockadeRule). */
export function blockedBy(g: Galaxy, s: number, owner: number): number {
  const rule = g.rules?.blockade ?? 'majority'
  if (rule === 'off' || owner < 0) return -1
  const ps = g.systems[s].planets.map((p) => g.planets[p].owner)
  const ours = ps.filter((o) => o === owner).length
  for (let o = 0; o < g.sides.length; o++) {
    if (o === owner) continue
    const theirs = ps.filter((x) => x === o).length
    if (rule === 'full' ? theirs === ps.length && ps.length > 0 : theirs > ours) return o
  }
  return -1
}

/** Front lines (a campaign rule): a system `owner`'s side doesn't control while the other side holds
 * planets there (as many or more than it does) is contested for it. */
export function contested(g: Galaxy, s: number, owner: number) {
  if (owner < 0) return false
  const ps = g.systems[s].planets.map((p) => g.planets[p].owner)
  const ours = ps.filter((o) => o === owner).length
  const theirs = Math.max(0, ...g.sides.map((_, o) => (o === owner ? 0 : ps.filter((x) => x === o).length)))
  return theirs > 0 && theirs >= ours
}
/** Whether the other side holds any planet in a system (for `owner`). */
const enemyIn = (g: Galaxy, s: number, owner: number) => g.systems[s].planets.some((p) => g.planets[p].owner >= 0 && g.planets[p].owner !== owner)
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
  if (take && take.length && take.length < f.ships.length) {
    if (f.leg) return 'Split fleets only while they hold an orbit'
    const rest = [...f.ships]
    for (const id of take) {
      const i = rest.indexOf(id)
      if (i < 0) return 'Those ships are not in this fleet'
      rest.splice(i, 1)
    }
    f.ships = rest
    const nf: Fleet = { ...f, id: g.nextId++, ships: [...take], route: [], leg: null, waypoints: [] }
    g.fleets.push(nf)
    f = nf
  }
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
  if (p.queue.some((q) => q.unit === 'station')) return 'The station is being upgraded'
  if (t.level > p.station) return `Needs station level ${t.level}`
  if (p.queue.length >= MAX_YARD) return 'Shipyard queue full'
  if (g.sides[owner].credits < t.cost) return 'Not enough credits'
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
export function cantUpgradeStation(g: Galaxy, owner: number, planet: number): string | null {
  const p = g.planets[planet]
  if (p.owner !== owner) return 'Not our planet'
  if (p.station >= 4) return 'Station at its highest level'
  if (p.queue.length) return p.queue.some((q) => q.unit === 'station') ? 'Already being built' : 'Wait for the shipyard queue to finish'
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
/** Cancel a queued ship or station work: the credits come back. */
export function cancelBuild(g: Galaxy, owner: number, planet: number, i: number) {
  const p = g.planets[planet]
  const q = p.queue[i]
  if (!q || p.owner !== owner) return
  const s = g.sides[owner]
  const back = q.unit === 'station' ? STATION_COST[p.station + 1] : UNIT[q.unit].cost
  s.credits += back
  if (q.unit === 'station') s.spent.stations -= back
  else s.spent.ships -= back
  book(s, calendar(g.time).day, back, `Cancelled: ${q.unit === 'station' ? 'station work' : UNIT[q.unit].name}`)
  p.queue.splice(i, 1)
}

// --- Battles ---------------------------------------------------------------------------------------

/** A battle waiting at a planet: who holds it, who attacks, and with what. */
export type Clash = { planet: number; holder: number; attacker: number; station: number; holderShips: string[]; attackerShips: string[] }

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
  return { planet, holder, attacker, station: p.owner === holder ? p.station : 0, holderShips: ships(holder), attackerShips: ships(attacker) }
}

/** How a battle ended: the winning side, and what's left of each side. Ships that jumped out are
 * `escaped`: they go back where they came from. */
export type BattleResult = { winner: number; survivors: Record<number, string[]>; escaped: Record<number, string[]>; stationLeft: boolean }

/**
 * A quick result without playing it out: both sides trade damage once a second, each ship firing at
 * what its guns hurt most, until one side is gone. An attacker that has lost most of its fleet while
 * the defence still stands pulls out what's left.
 */
export function autoResolve(g: Galaxy, c: Clash, seed = g.time): BattleResult {
  const r = rng(Math.floor(seed * 1000) + c.planet)
  type U = { side: number; id: string; tier: Tier; hp: number; max: number; dps: (tier: Tier) => number; station?: boolean }
  const mk = (side: number, id: string): U => {
    const t = UNIT[id]
    const hp = (t.hull + t.shield) * t.squad
    return { side, id, tier: t.tier, hp, max: hp, dps: (tier) => dpsVs(t, tier) * t.squad }
  }
  const us: U[] = [...c.holderShips.map((id) => mk(c.holder, id)), ...c.attackerShips.map((id) => mk(c.attacker, id))]
  if (c.station) {
    const t = stationType(g.sides[c.holder].faction, c.station, [])
    const hp = t.hull + t.shield
    us.push({ side: c.holder, id: 'station', tier: 'station', hp, max: hp, dps: (tier) => dpsVs(t, tier), station: true })
  }
  // Luck: each side fights a little better or worse than on paper this time.
  const luck = { [c.holder]: 0.8 + r() * 0.4, [c.attacker]: 0.8 + r() * 0.4 } as Record<number, number>
  const total = (side: number) => us.filter((u) => u.side === side && u.hp > 0).reduce((s, u) => s + u.hp, 0)
  const start = { [c.holder]: total(c.holder), [c.attacker]: total(c.attacker) } as Record<number, number>
  let escaped: string[] = []
  for (let t = 0; t < 900; t++) {
    const alive = us.filter((u) => u.hp > 0)
    if (!alive.some((u) => u.side === c.holder) || !alive.some((u) => u.side === c.attacker)) break
    const dmg = new Map<U, number>()
    for (const a of alive) {
      const foes = alive.filter((u) => u.side !== a.side)
      let best = foes[0]
      let bs = -1
      for (const e of foes) {
        const s = a.dps(e.tier) * (0.7 + r() * 0.6) * (1 + (1 - e.hp / e.max) * 0.5)
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
  const left = (side: number) => us.filter((u) => u.side === side && u.hp > 0 && !u.station).map((u) => u.id)
  const holderLeft = us.some((u) => u.side === c.holder && u.hp > 0)
  return {
    winner: holderLeft ? c.holder : c.attacker,
    survivors: { [c.holder]: left(c.holder), [c.attacker]: left(c.attacker) },
    escaped: { [c.holder]: [], [c.attacker]: escaped },
    stationLeft: us.some((u) => u.station && u.hp > 0),
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

/** Settle a battle: survivors stay (the winner keeps or takes the planet), escaped ships fly back. */
export function applyBattle(g: Galaxy, c: Clash, res: BattleResult, auto: boolean) {
  const p = g.planets[c.planet]
  const here = fleetsAt(g, c.planet)
  const back = new Map<number, number>()
  for (const f of here) if (!back.has(f.owner)) back.set(f.owner, f.from)
  // The stops a side had queued: its survivors carry on with them.
  const plans = new Map<number, number[]>()
  for (const f of here) if (f.waypoints?.length && !plans.has(f.owner)) plans.set(f.owner, f.waypoints)
  g.fleets = g.fleets.filter((f) => !here.includes(f))
  for (const o of [c.holder, c.attacker]) {
    const ships = res.survivors[o] ?? []
    if (ships.length) {
      const f = addFleet(g, o, c.planet, ships)
      f.arrived = o === c.holder ? g.time - 1 : g.time
      f.waypoints = [...(plans.get(o) ?? [])]
    }
    const esc = res.escaped[o] ?? []
    if (esc.length) {
      const to = fallback(g, o, back.get(o) ?? -1, c.planet)
      if (to >= 0) {
        const f = addFleet(g, o, c.planet, esc)
        // Out of the battle at once: flying to the fallback planet.
        if (f.ships.length === esc.length) {
          moveFleet(g, o, f.id, to)
        }
      }
    }
  }
  if (c.station && !res.stationLeft) {
    p.station = 0
    p.queue = []
  }
  // Survivors of a beaten side that didn't jump out are lost; the winner takes an emptied planet
  // once it has held the orbit (the usual capture).
  if (res.winner !== c.holder && p.owner === c.holder && !p.station) p.capture = null
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
  // Shipyards and station work.
  for (const p of g.planets) {
    const q = p.queue[0]
    if (!q || p.owner < 0) continue
    q.left -= dt
    if (q.left > 0) continue
    p.queue.shift()
    if (q.unit === 'station') {
      p.station++
      g.events.push({ k: 'station', planet: p.id, owner: p.owner, level: p.station })
    } else {
      addFleet(g, p.owner, p.id, [q.unit])
      g.events.push({ k: 'built', planet: p.id, owner: p.owner, unit: q.unit })
    }
  }
  // Fleets in flight.
  for (const f of g.fleets) {
    if (!f.leg) continue
    f.leg.left -= dt
    if (f.leg.left > 0) continue
    f.system = f.leg.system
    if (f.leg.planet >= 0) {
      f.planet = f.leg.planet
      f.arrived = g.time
      f.leg = null
      if (!f.route.length && !f.waypoints?.length) g.events.push({ k: 'arrived', fleet: f.id, planet: f.planet, owner: f.owner })
    } else f.leg = null
    const by = f.planet < 0 ? blockedBy(g, f.system, f.owner) : -1
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
  // Fleets of one side at one planet join up.
  for (const f of [...g.fleets]) {
    if (f.leg || f.planet < 0) continue
    // (Not a fleet only stopping on its way, nor one waiting there.)
    const other = g.fleets.find((x) => x !== f && x.owner === f.owner && x.planet === f.planet && !x.leg && !x.route.length && !f.route.length && !x.waypoints?.length && !f.waypoints?.length)
    if (other && g.fleets.includes(f)) {
      other.ships.push(...f.ships)
      other.arrived = Math.min(other.arrived, f.arrived)
      g.fleets = g.fleets.filter((x) => x !== f)
    }
  }
  // Battles, then captures.
  for (const p of g.planets) {
    const c = clashAt(g, p.id)
    if (c) {
      if (!g.sides[c.holder].ai || !g.sides[c.attacker].ai) {
        g.pending = p.id
        g.events.push({ k: 'battle', planet: p.id, owners: [c.holder, c.attacker], auto: false })
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
  return { budget: 2, last: g.time, seed, salt: seed, stage: -1, restage: 0, target: -1, goal: null, until: 0, wave: D.wave, alarms: {}, spotted: {}, claims: {}, orders: 0 }
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

/**
 * The AI's look at the galaxy, every few seconds. It keeps one main fleet together at a staging
 * planet near the front, where its best shipyard builds straight into it. It defends planets under
 * attack (once it has noticed), sends the main fleet at a reachable enemy planet it thinks it can
 * beat once it has gathered enough, and keeps at that attack until it's won or lost instead of
 * picking again on every look. A detachment or two of a couple of ships takes unclaimed planets
 * nearby. Every order comes out of its budget, defence first.
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
  const mine = g.planets.filter((p) => p.owner === o)
  const hops = (from: number, to: number) => {
    const path = lanePath(g, from, to, o)
    return path ? path.length - 1 : 99
  }
  /** What it believes holds a planet: fleets there, half of those elsewhere in the system, and the
   * station, all misjudged a little. */
  const defence = (p: Planet) => {
    let v = hostile(p.owner) ? p.station * 1500 : 0
    for (const f of g.fleets) if (hostile(f.owner) && !f.leg && f.system === p.system) v += fleetValue(f.ships) * (f.planet === p.id ? 1 : 0.5)
    return v * misjudged(m, D, p.id, g.time)
  }
  const calmFor = (owner: number) => g.time < D.calm && !g.sides[owner]?.ai

  // Threats: enemy fleets at our planets, or about to arrive. It acts on each only once it has
  // been there a while: it notices late.
  const threat = new Map<number, number>()
  for (const f of g.fleets) {
    if (!hostile(f.owner)) continue
    const to = finalStop(f)
    if (to < 0 || g.planets[to].owner !== o || (flying(f) && eta(f) > 30)) continue
    threat.set(to, (threat.get(to) ?? 0) + fleetValue(f.ships))
  }
  for (const k of Object.keys(m.alarms)) if (!threat.has(Number(k))) delete m.alarms[Number(k)]
  for (const pid of threat.keys()) m.alarms[pid] ??= g.time

  // Detachments: done once their planet is ours, called off when the fleet is gone or an enemy got
  // there first.
  for (const [k, pid] of Object.entries(m.claims)) {
    const f = g.fleets.find((x) => x.id === Number(k))
    if (!f || g.planets[pid].owner === o || fleetsAt(g, pid).some((x) => hostile(x.owner))) delete m.claims[Number(k)]
  }
  const claimed = new Set(Object.keys(m.claims).map(Number))
  const fleets = g.fleets.filter((f) => f.owner === o)
  const main = fleets.filter((f) => !claimed.has(f.id)).reduce<Fleet | null>((b, f) => (!b || fleetValue(f.ships) > fleetValue(b.ships) ? f : b), null)
  const mainValue = main ? fleetValue(main.ships) : 0
  const mainIdle = !!main && !flying(main) && main.planet >= 0

  // The staging planet: our shipyard nearest the enemy, rethought now and then.
  if (g.planets[m.stage]?.owner !== o || g.time >= m.restage) {
    const enemySystems = [...new Set(g.planets.filter((p) => hostile(p.owner)).map((p) => p.system))]
    const front = (p: Planet) => Math.min(99, ...enemySystems.map((sys) => hops(p.system, sys)))
    const yards = mine.filter((p) => p.station > 0)
    const pick = (yards.length ? yards : mine).slice().sort((a, b) => front(a) - front(b) || b.station - a.station)[0]
    if (pick) m.stage = pick.id
    m.restage = g.time + D.commit
  }

  // 1. Defence: the main fleet goes to a planet it has noticed is under attack, if it's near and
  // can win there. An attack under way gives way to it, unless it's nearly there; a defence under
  // way is seen through (no chasing every raid around).
  const alarms = [...threat]
    .filter(([pid]) => g.time - m.alarms[pid] >= D.react)
    .map(([pid, v]) => ({ p: g.planets[pid], v: v * misjudged(m, D, pid, g.time) }))
    .sort((a, b) => b.p.station - a.p.station || b.p.income - a.p.income)
  if (main && m.goal !== 'defend' && !(m.goal === 'attack' && eta(main) < 20) && alarms.length && roll(m) > D.blunder) {
    const save = alarms.find((a) => mainValue >= a.v * 0.8 && hops(main.leg ? main.leg.system : main.system, a.p.system) <= 3)
    if (save && finalStop(main) !== save.p.id && order(() => moveFleet(g, o, main.id, save.p.id))) {
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
      if (m.goal === 'attack') m.wave = Math.min(D.wave * 3, m.wave * 1.25)
      m.goal = null
      m.until = g.time + D.commit
    }
  }

  // 3. A new attack: the main fleet, gathered, at a reachable enemy planet it thinks it can beat
  // well enough, near ones first. A weak spot only counts once it has looked weak for a while.
  if (main && mainIdle && !m.goal && g.time >= m.until) {
    const options: { p: Planet; score: number }[] = []
    for (const p of g.planets) {
      const need = hostile(p.owner) ? defence(p) * D.margin + 400 : Infinity
      const h = need <= mainValue ? hops(main.system, p.system) : 99
      if (h >= 99 || calmFor(p.owner)) {
        delete m.spotted[p.id]
        continue
      }
      m.spotted[p.id] ??= g.time
      if (g.time - m.spotted[p.id] >= D.react / 2) options.push({ p, score: need + h * 700 - p.income * 4 - p.station * 300 })
    }
    options.sort((a, b) => a.score - b.score)
    const pick = roll(m) < D.blunder ? options[Math.floor(roll(m) * Math.min(3, options.length))] : options[0]
    if (pick && mainValue >= m.wave && order(() => moveFleet(g, o, main.id, pick.p.id))) {
      m.goal = 'attack'
      m.target = pick.p.id
    }
  }

  // 4. Detachments take unclaimed planets nearby (and, once it's not calm, undefended enemy ones):
  // a spare fleet first, else a ship or two split off the main fleet while it waits. A lone ship
  // only goes next door.
  const expand = () => {
    const open = g.planets.filter(
      (p) => p.owner !== o && m.target !== p.id && !Object.values(m.claims).includes(p.id) && (p.owner < 0 || (!calmFor(p.owner) && !p.station)) && !fleetsAt(g, p.id).some((f) => hostile(f.owner)),
    )
    const spare = fleets.filter((f) => f !== main && !claimed.has(f.id) && !flying(f) && f.planet >= 0)
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
  // it's away).
  const gatherAll = () => {
    const spare = fleets.filter((f) => g.fleets.includes(f) && f !== main && !claimed.has(f.id) && !(f.id in m.claims) && !flying(f) && f.planet >= 0)
    const gather = main && mainIdle && !m.goal ? main.planet : m.stage
    for (const f of spare) {
      // (Not one that's busy taking the planet it's at.)
      if (flying(f) || gather < 0 || f.planet === gather || g.planets[f.planet].capture?.owner === o) continue
      if (!order(() => moveFleet(g, o, f.id, gather))) break
    }
    // An idle main fleet away from the staging planet goes back to it, unless it sits at a shipyard
    // of ours: then that becomes the staging planet (no flying back and forth).
    if (main && mainIdle && !m.goal && m.stage >= 0 && main.planet !== m.stage && !threat.has(main.planet)) {
      const here = g.planets[main.planet]
      if (here.owner === o && here.station > 0) m.stage = here.id
      else order(() => moveFleet(g, o, main.id, m.stage))
    }
  }

  // 6. Stations, then ships with what orders are left. Ships come from the staging planet's yard
  // (they join the main fleet right there, no order needed to send them), and from another yard
  // only while that one is full, builds bigger ships or money piles up. With few orders to spare it buys bigger ships
  // rather than many small ones, the more so the richer it is.
  const spend = () => {
    const yards = mine.filter((p) => p.station > 0)
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
      const can = buildable(s.faction).filter((t) => t.level <= p.station && t.cost <= s.credits - 300)
      if (!can.length) break
      const rich = Math.min(1, s.credits / 6000)
      const pick = can[Math.min(can.length - 1, Math.floor(Math.pow(roll(m), 0.6 - rich * 0.35) * can.length))]
      if (pick.tier === 'capital' && fleets.some((f) => f.ships.some((id) => UNIT[id].tier === 'capital'))) continue
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

/** A saved campaign, made fit for this version of the game, or null. */
function clean(v: Galaxy | null): Galaxy | null {
  if (!v || v.v !== 1 || !Array.isArray(v.systems) || !Array.isArray(v.planets) || !Array.isArray(v.fleets)) return null
  // Ships that no longer exist in the game are dropped.
  for (const f of v.fleets) f.ships = f.ships.filter((id) => UNIT[id])
  for (const p of v.planets) {
    p.queue = p.queue.filter((q) => q.unit === 'station' || UNIT[q.unit])
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
