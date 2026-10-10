// Empires At War: the two factions, their ships and the numbers behind them. No DOM here, so the
// headless balance sims can load it too.
//
// Sprites face up (nose at the top). Points on a ship (hardpoints, engine glows) are given on a
// 0-10 grid over the trimmed sprite, x from the left edge and y from the nose, which is how they
// were measured off the art.

export type FactionId = 'republic' | 'droid'
export type Tier = 'fighter' | 'gunship' | 'frigate' | 'cruiser' | 'capital' | 'station' | 'mine' | 'defense'
export type WeaponKind = 'laser' | 'flak' | 'turbo' | 'missile'
export type HardpointKind = 'turret' | 'shield' | 'engine' | 'hangar'
export type AbilityId = 'flakBarrage' | 'repairSwarm' | 'shieldBoost' | 'tractor' | 'broadside' | 'launchSwarm'

export type Weapon = {
  kind: WeaponKind
  damage: number
  range: number
  /** Seconds between shots. */
  cooldown: number
  /** Bolts per shot, fired a few frames apart. */
  burst?: number
  /** Fighters and gunships only fire inside this half-angle of their nose; turrets turn freely. */
  arc?: number
}

export type Hardpoint = { kind: HardpointKind; x: number; y: number; hp: number; weapon?: Weapon }

export type UnitType = {
  id: string
  faction: FactionId
  tier: Tier
  name: string
  blurb: string
  sprite: string
  /** Width / height of the trimmed sprite. */
  aspect: number
  /** Largest dimension in world units. */
  size: number
  hull: number
  shield: number
  /** Shield points per second. */
  regen: number
  speed: number
  /** Radians per second. */
  turn: number
  pop: number
  cost: number
  /** Seconds. */
  build: number
  /** Station level needed to build it. */
  level: number
  /** Ships per order: fighters come as squadrons. */
  squad: number
  sensor: number
  weapons: Weapon[]
  hardpoints: Hardpoint[]
  engines: [number, number][]
  ability?: AbilityId
  /** Carriers launch fighter squadrons from their hangars on their own. */
  carrier?: { unit: string; every: number; max: number }
}

export type Ability = { name: string; blurb: string; cooldown: number; duration: number; range?: number }

export const ABILITIES: Record<AbilityId, Ability> = {
  flakBarrage: { name: 'Flak barrage', blurb: 'Point defence fires twice as fast for 8 s.', cooldown: 40, duration: 8 },
  repairSwarm: { name: 'Repair swarm', blurb: 'Repair droids restore 30% hull over 10 s.', cooldown: 60, duration: 10 },
  shieldBoost: { name: 'Shield boost', blurb: 'Instantly restores half the shields.', cooldown: 45, duration: 0 },
  tractor: { name: 'Tractor lock', blurb: 'Enemy ships nearby crawl at a third of their speed for 7 s.', cooldown: 45, duration: 7, range: 650 },
  broadside: { name: 'Full broadside', blurb: 'Turbolasers deal 60% more damage for 10 s.', cooldown: 50, duration: 10 },
  launchSwarm: { name: 'Launch swarm', blurb: 'Empties the hangars: two extra droid squadrons at once.', cooldown: 60, duration: 0 },
}

export const FACTIONS: Record<FactionId, { name: string; long: string; blurb: string; color: string; bolt: string; glow: string }> = {
  republic: {
    name: 'Republic',
    long: 'The Republic Navy',
    blurb: 'Tough, shielded warships flown by clone crews. Fewer ships, each one worth more.',
    color: '#e0453c',
    bolt: '#5fc8ff',
    glow: '#6ad0ff',
  },
  droid: {
    name: 'Confederacy',
    long: 'The Droid Confederacy',
    blurb: 'Cheap droid swarms and carriers that never stop launching. Numbers win wars.',
    color: '#a070ff',
    bolt: '#ff4a3a',
    glow: '#c890ff',
  },
}

// Damage against each kind of target. Fighter guns barely scratch big hulls, flak shreds small
// craft, turbolasers are too slow to track fighters, missiles go through shields (see sim).
const VS: Record<WeaponKind, Record<Tier, number>> = {
  laser: { fighter: 1, gunship: 0.9, frigate: 0.35, cruiser: 0.25, capital: 0.2, station: 0.2, mine: 0.4, defense: 0.25 },
  flak: { fighter: 2.2, gunship: 1.4, frigate: 0.3, cruiser: 0.2, capital: 0.15, station: 0.15, mine: 0.3, defense: 0.2 },
  turbo: { fighter: 0.5, gunship: 0.7, frigate: 1, cruiser: 1, capital: 1, station: 1, mine: 1, defense: 1 },
  missile: { fighter: 0.25, gunship: 0.6, frigate: 1.1, cruiser: 1, capital: 0.9, station: 0.8, mine: 1, defense: 1 },
}
/** Chance a shot connects: big guns can't follow fighters. */
const ACCURACY: Record<WeaponKind, Record<Tier, number>> = {
  laser: { fighter: 0.55, gunship: 0.7, frigate: 0.95, cruiser: 1, capital: 1, station: 1, mine: 1, defense: 1 },
  flak: { fighter: 0.75, gunship: 0.8, frigate: 0.95, cruiser: 1, capital: 1, station: 1, mine: 1, defense: 1 },
  turbo: { fighter: 0.15, gunship: 0.35, frigate: 0.85, cruiser: 0.95, capital: 1, station: 1, mine: 1, defense: 0.95 },
  missile: { fighter: 0.3, gunship: 0.7, frigate: 0.95, cruiser: 1, capital: 1, station: 1, mine: 1, defense: 1 },
}
export const effect = (w: WeaponKind, t: Tier) => VS[w][t]
export const accuracy = (w: WeaponKind, t: Tier) => ACCURACY[w][t]

const laser = (damage: number, range = 240, cooldown = 0.5): Weapon => ({ kind: 'laser', damage, range, cooldown, arc: 0.35 })
const flak = (damage: number, range = 320, cooldown = 0.35, burst = 1): Weapon => ({ kind: 'flak', damage, range, cooldown, burst })
const turbo = (damage: number, range = 650, cooldown = 2.2, burst = 2): Weapon => ({ kind: 'turbo', damage, range, cooldown, burst })
const missile = (damage: number, range = 420, cooldown = 4): Weapon => ({ kind: 'missile', damage, range, cooldown, burst: 2, arc: 0.6 })
/** Fighters' proton torpedoes: slow to reload, useless against other fighters, deadly to big hulls. */
const torpedo = (damage: number, range = 280, cooldown = 7): Weapon => ({ kind: 'missile', damage, range, cooldown, burst: 2, arc: 0.4 })

const P = (kind: HardpointKind, x: number, y: number, hp: number, weapon?: Weapon): Hardpoint => ({ kind, x, y, hp, weapon })

export const UNITS: UnitType[] = [
  // --- Republic ---------------------------------------------------------------------------------
  {
    id: 'r-fighter', faction: 'republic', tier: 'fighter', name: 'Lance interceptor', blurb: 'Clone fighters, three to a squadron. Lasers for dogfights, proton torpedoes that slip through capital shields.',
    sprite: 'republic-fighter', aspect: 0.7, size: 30, hull: 55, shield: 20, regen: 2, speed: 270, turn: 4.2, pop: 1, cost: 260, build: 10, level: 1, squad: 3, sensor: 700,
    weapons: [laser(7), torpedo(24)], hardpoints: [], engines: [[5, 9.6]],
  },
  {
    id: 'r-gunship', faction: 'republic', tier: 'gunship', name: 'Halberd gunship', blurb: 'Ball-turret flak against fighters, missile pods that punch through shields.',
    sprite: 'republic-gunship', aspect: 0.715, size: 64, hull: 300, shield: 120, regen: 6, speed: 175, turn: 2.6, pop: 2, cost: 400, build: 14, level: 1, squad: 1, sensor: 800,
    weapons: [flak(7, 300, 0.3), missile(34)], hardpoints: [], engines: [[3.6, 9.6], [4.6, 9.7], [5.5, 9.7], [6.4, 9.6]],
  },
  {
    id: 'r-frigate', faction: 'republic', tier: 'frigate', name: 'Warden frigate', blurb: 'Escort bristling with point defence. Fighters melt around it.',
    sprite: 'republic-frigate', aspect: 0.652, size: 130, hull: 950, shield: 650, regen: 14, speed: 100, turn: 1.0, pop: 3, cost: 820, build: 22, level: 2, squad: 1, sensor: 1000,
    weapons: [flak(6, 340, 0.3, 2), flak(6, 340, 0.3, 2), turbo(28, 560, 2.2, 1)], hardpoints: [], engines: [[3.9, 9.7], [5, 9.8], [6.1, 9.7]],
    ability: 'flakBarrage',
  },
  {
    id: 'r-cruiser', faction: 'republic', tier: 'cruiser', name: 'Paladin cruiser', blurb: 'Line warship with heavy turbolasers. Knock out its shield bulbs first.',
    sprite: 'republic-cruiser', aspect: 0.375, size: 220, hull: 2300, shield: 1500, regen: 24, speed: 68, turn: 0.6, pop: 5, cost: 1650, build: 34, level: 3, squad: 1, sensor: 1200,
    weapons: [flak(6, 320, 0.4)],
    hardpoints: [P('turret', 5, 2.6, 520, turbo(44)), P('turret', 5, 4.5, 520, turbo(44)), P('shield', 1, 5.6, 460), P('shield', 9, 5.6, 460), P('engine', 2.2, 9.3, 420), P('engine', 7.6, 9.3, 420)],
    engines: [[2.2, 9.5], [7.6, 9.5]], ability: 'shieldBoost',
  },
  {
    id: 'r-capital', faction: 'republic', tier: 'capital', name: 'Sovereign dreadnought', blurb: 'Dagger-hulled flagship. Turbolaser batteries and its own fighter wing.',
    sprite: 'republic-capital', aspect: 0.627, size: 380, hull: 5400, shield: 3600, regen: 40, speed: 44, turn: 0.33, pop: 10, cost: 4200, build: 70, level: 4, squad: 1, sensor: 1500,
    weapons: [flak(6, 340, 0.45), flak(6, 340, 0.45)],
    hardpoints: [
      P('turret', 3.5, 3.6, 720, turbo(58, 760)), P('turret', 6.4, 3.6, 720, turbo(58, 760)), P('turret', 3.1, 5.4, 720, turbo(58, 760)), P('turret', 6.8, 5.4, 720, turbo(58, 760)),
      P('shield', 2.1, 8, 820), P('shield', 7.9, 8, 820), P('engine', 5, 9.2, 950), P('hangar', 5, 4.2, 760),
    ],
    engines: [[2.6, 9.45], [3.6, 9.55], [4.9, 9.65], [6.1, 9.55], [7.2, 9.45]], ability: 'broadside', carrier: { unit: 'r-fighter', every: 28, max: 2 },
  },
  {
    id: 'r-station', faction: 'republic', tier: 'station', name: 'Bastion station', blurb: 'Your shipyard and command post. Lose it and the battle is lost.',
    sprite: 'republic-station', aspect: 0.97, size: 440, hull: 9000, shield: 4500, regen: 30, speed: 0, turn: 0, pop: 0, cost: 0, build: 0, level: 0, squad: 1, sensor: 1600,
    weapons: [flak(7, 380, 0.3, 2), flak(7, 380, 0.3, 2)],
    hardpoints: [
      P('turret', 2.6, 1.5, 900, turbo(48, 800)), P('turret', 7.4, 1.5, 900, turbo(48, 800)), P('turret', 0.9, 4.2, 900, turbo(48, 800)),
      P('turret', 9.1, 4.2, 900, turbo(48, 800)), P('turret', 2.6, 8.2, 900, turbo(48, 800)), P('turret', 7.4, 8.2, 900, turbo(48, 800)),
      P('shield', 4, 3.7, 1100), P('shield', 6, 5.9, 1100), P('hangar', 8.9, 5, 1200),
    ],
    engines: [],
  },
  {
    id: 'r-mine', faction: 'republic', tier: 'mine', name: 'Mining platform', blurb: 'Drills an ore asteroid for credits.',
    sprite: 'mine-republic', aspect: 0.953, size: 120, hull: 1000, shield: 0, regen: 0, speed: 0, turn: 0, pop: 0, cost: 500, build: 24, level: 1, squad: 1, sensor: 600,
    weapons: [], hardpoints: [], engines: [],
  },
  {
    id: 'r-defense', faction: 'republic', tier: 'defense', name: 'Defense platform', blurb: 'A gun emplacement on the ore: turbolasers for warships, flak for fighters. No income.',
    sprite: 'defense-republic', aspect: 0.969, size: 130, hull: 2000, shield: 1200, regen: 18, speed: 0, turn: 0, pop: 0, cost: 650, build: 30, level: 1, squad: 1, sensor: 1000,
    weapons: [turbo(32, 720, 2, 2), flak(7, 380, 0.3, 2)], hardpoints: [], engines: [],
  },

  // --- Droid Confederacy ------------------------------------------------------------------------
  {
    id: 'd-fighter', faction: 'droid', tier: 'fighter', name: 'Mantis droid fighter', blurb: 'Five cheap droids per squadron. Fragile, relentless, and their torpedoes add up against big ships.',
    sprite: 'droid-fighter', aspect: 0.963, size: 28, hull: 38, shield: 0, regen: 0, speed: 255, turn: 4.4, pop: 1, cost: 230, build: 9, level: 1, squad: 5, sensor: 650,
    weapons: [laser(5, 230, 0.45), torpedo(16, 260)], hardpoints: [], engines: [[5, 8.4]],
  },
  {
    id: 'd-gunship', faction: 'droid', tier: 'gunship', name: 'Trident gunship', blurb: 'Three blaster arms that tear through fighters.',
    sprite: 'droid-gunship', aspect: 1.067, size: 64, hull: 395, shield: 80, regen: 5, speed: 165, turn: 2.6, pop: 2, cost: 400, build: 13, level: 1, squad: 1, sensor: 780,
    weapons: [flak(6, 290, 0.28), laser(12, 320, 1)], hardpoints: [], engines: [[5, 6.6]],
  },
  {
    id: 'd-frigate', faction: 'droid', tier: 'frigate', name: 'Scarab frigate', blurb: 'Armoured shell, prong cannons and repair droids.',
    sprite: 'droid-frigate', aspect: 0.493, size: 135, hull: 1150, shield: 450, regen: 10, speed: 95, turn: 1.0, pop: 3, cost: 760, build: 21, level: 2, squad: 1, sensor: 950,
    weapons: [flak(6, 320, 0.33, 2), turbo(20, 520, 1.4, 1), turbo(20, 520, 1.4, 1)], hardpoints: [], engines: [[3.9, 9.6], [5, 9.7], [6.1, 9.6]],
    ability: 'repairSwarm',
  },
  {
    id: 'd-cruiser', faction: 'droid', tier: 'cruiser', name: 'Manta cruiser', blurb: 'Wide-winged gunline with prong cannons and a tractor projector that pins ships in place.',
    sprite: 'droid-cruiser', aspect: 1.542, size: 260, hull: 2700, shield: 1100, regen: 18, speed: 64, turn: 0.55, pop: 5, cost: 1550, build: 33, level: 3, squad: 1, sensor: 1200,
    weapons: [turbo(12, 480, 1.2, 1), turbo(12, 480, 1.2, 1)],
    hardpoints: [P('turret', 1, 8.1, 560, turbo(40)), P('turret', 9, 8.1, 560, turbo(40)), P('shield', 2.9, 4.9, 440), P('shield', 7.1, 4.9, 440), P('engine', 4.5, 9.2, 420), P('engine', 5.5, 9.2, 420)],
    engines: [[4.5, 9.45], [5.5, 9.45]], ability: 'tractor',
  },
  {
    id: 'd-capital', faction: 'droid', tier: 'capital', name: 'Hive carrier', blurb: 'A flying droid factory. Its hangar arms never stop launching.',
    sprite: 'droid-capital', aspect: 0.764, size: 380, hull: 6200, shield: 2800, regen: 32, speed: 40, turn: 0.32, pop: 10, cost: 4000, build: 68, level: 4, squad: 1, sensor: 1500,
    weapons: [flak(6, 340, 0.45), flak(6, 340, 0.45)],
    hardpoints: [
      P('turret', 4.1, 6.3, 680, turbo(52, 720)), P('turret', 5.9, 6.3, 680, turbo(52, 720)), P('turret', 4.2, 7.6, 680, turbo(52, 720)), P('turret', 5.8, 7.6, 680, turbo(52, 720)),
      P('shield', 3.3, 4.9, 760), P('shield', 6.7, 4.9, 760), P('engine', 5, 9.1, 950), P('hangar', 1.7, 3.5, 720), P('hangar', 8.3, 3.5, 720),
    ],
    engines: [[3.6, 9.2], [4.4, 9.6], [5.6, 9.6], [6.4, 9.2]], ability: 'launchSwarm', carrier: { unit: 'd-fighter', every: 20, max: 3 },
  },
  {
    id: 'd-station', faction: 'droid', tier: 'station', name: 'Foundry station', blurb: 'The droid foundry. Lose it and the battle is lost.',
    sprite: 'droid-station', aspect: 1.03, size: 440, hull: 9600, shield: 4000, regen: 28, speed: 0, turn: 0, pop: 0, cost: 0, build: 0, level: 0, squad: 1, sensor: 1600,
    weapons: [flak(7, 380, 0.3, 2), flak(7, 380, 0.3, 2)],
    hardpoints: [
      P('turret', 0.6, 2.8, 900, turbo(48, 800)), P('turret', 9.4, 2.8, 900, turbo(48, 800)), P('turret', 0.6, 7.2, 900, turbo(48, 800)),
      P('turret', 9.4, 7.2, 900, turbo(48, 800)), P('turret', 5, 0.6, 900, turbo(48, 800)), P('turret', 5, 9.4, 900, turbo(48, 800)),
      P('shield', 3.3, 3.5, 1100), P('shield', 6.7, 6.5, 1100), P('hangar', 8, 5.2, 1200),
    ],
    engines: [],
  },
  {
    id: 'd-mine', faction: 'droid', tier: 'mine', name: 'Ore harvester', blurb: 'Drills an ore asteroid for credits.',
    sprite: 'mine-droid', aspect: 1.026, size: 120, hull: 1000, shield: 0, regen: 0, speed: 0, turn: 0, pop: 0, cost: 500, build: 24, level: 1, squad: 1, sensor: 600,
    weapons: [], hardpoints: [], engines: [],
  },
  {
    id: 'd-defense', faction: 'droid', tier: 'defense', name: 'Defense platform', blurb: 'A gun emplacement on the ore: heavy cannons and blaster arms. No income.',
    sprite: 'defense-droid', aspect: 1.115, size: 130, hull: 2300, shield: 900, regen: 14, speed: 0, turn: 0, pop: 0, cost: 650, build: 30, level: 1, squad: 1, sensor: 1000,
    weapons: [turbo(32, 720, 2, 2), flak(7, 380, 0.3, 2)], hardpoints: [], engines: [],
  },
]

export const UNIT: Record<string, UnitType> = Object.fromEntries(UNITS.map((u) => [u.id, u]))
export const SHIP_TIERS: Tier[] = ['fighter', 'gunship', 'frigate', 'cruiser', 'capital']
export const unitOf = (faction: FactionId, tier: Tier) => UNIT[`${faction === 'republic' ? 'r' : 'd'}-${tier}`]
/** The ships a faction can order from its station, cheapest first. */
export const buildable = (faction: FactionId) => SHIP_TIERS.map((t) => unitOf(faction, t))
export const isShip = (t: UnitType) => t.tier !== 'station' && t.tier !== 'mine' && t.tier !== 'defense'
/** What can go on a surveyed ore asteroid, one structure each. */
export const SITE_TIERS: Tier[] = ['mine', 'defense']

/** World size of a sprite: [width, height]. */
export function dims(t: UnitType): [number, number] {
  return t.aspect >= 1 ? [t.size, t.size / t.aspect] : [t.size * t.aspect, t.size]
}

// --- Economy ----------------------------------------------------------------------------------------

export const START_CREDITS = 1600
/** Ore must be surveyed before anything is built on it: ships nearby, unopposed, for this long. */
export const SURVEY_TIME = 8
export const SURVEY_RADIUS = 380
/** Credits per second from the station, by level. */
export const STATION_INCOME = [0, 6, 7, 8, 9]
export const MINE_INCOME = 4.5
export const BEACON_INCOME = 1.5
export const BASE_POP = 16
export const POP_PER_LEVEL = 4
export const BEACON_POP = 6
export const MAX_QUEUE = 6
// --- Research ---------------------------------------------------------------------------------------

/** What a piece of research changes, as fractions: hull 0.25 is +25% hull, cooldown -0.15 fires 15% faster. */
export type TechEffect = Partial<Record<'hull' | 'shield' | 'regen' | 'damage' | 'speed' | 'cooldown' | 'range' | 'build' | 'hangar' | 'repair' | 'mines', number>>
/**
 * `for` is the unit type it upgrades, or the station (which also covers the economy). `requires`
 * lists research that has to come first, on top of the station level: that is what makes it a
 * tree rather than a shopping list.
 */
export type Tech = { id: string; faction: FactionId; for: string; name: string; blurb: string; cost: number; time: number; level: number; effect: TechEffect; requires?: string[] }

const tech = (faction: FactionId, forId: string, id: string, name: string, blurb: string, cost: number, time: number, level: number, effect: TechEffect, requires?: string[]): Tech => ({
  id, faction, for: forId, name, blurb, cost, time, level, effect, requires,
})

// Each ship's second upgrade builds on its first. The repair docks need the station's guns: a dock
// is only worth having where the station can cover it. Prerequisites always come earlier in this
// list, so the tree can be laid out in one pass.
export const TECHS: Tech[] = [
  // Republic
  tech('republic', 'r-station', 'r-st-guns', 'Turbolaser emplacements', 'Station turbolasers hit 25% harder.', 700, 45, 1, { damage: 0.25 }),
  tech('republic', 'r-station', 'r-st-ore', 'Advanced refineries', 'Mining platforms bring in 25% more credits.', 600, 40, 1, { mines: 0.25 }),
  tech('republic', 'r-station', 'r-st-dock', 'Repair docks', 'Our ships near the station repair 2% of their hull a second.', 800, 45, 2, { repair: 0.02 }, ['r-st-guns']),
  tech('republic', 'r-fighter', 'r-fi-hull', 'Reinforced hulls', 'Lance interceptors get 25% more hull.', 400, 30, 1, { hull: 0.25 }),
  tech('republic', 'r-fighter', 'r-fi-torp', 'Proton payload', 'Lasers and torpedoes deal 25% more damage.', 500, 35, 2, { damage: 0.25 }, ['r-fi-hull']),
  tech('republic', 'r-gunship', 'r-gs-flak', 'Flak tracking', 'Halberd guns deal 20% more damage.', 450, 30, 1, { damage: 0.2 }),
  tech('republic', 'r-gunship', 'r-gs-burn', 'Afterburners', 'Halberds fly 20% faster.', 350, 25, 1, { speed: 0.2 }, ['r-gs-flak']),
  tech('republic', 'r-frigate', 'r-fr-shield', 'Deflector upgrade', 'Warden shields 30% stronger, recharging faster.', 600, 40, 2, { shield: 0.3, regen: 0.3 }),
  tech('republic', 'r-frigate', 'r-fr-pd', 'Point-defence computers', 'Warden guns fire 15% faster.', 650, 40, 2, { cooldown: -0.15 }, ['r-fr-shield']),
  tech('republic', 'r-cruiser', 'r-cr-cap', 'Heavy capacitors', 'Paladin turbolasers deal 20% more damage.', 900, 50, 3, { damage: 0.2 }),
  tech('republic', 'r-cruiser', 'r-cr-armour', 'Armour plating', 'Paladins get 25% more hull.', 800, 45, 3, { hull: 0.25 }, ['r-cr-cap']),
  tech('republic', 'r-capital', 'r-ca-range', 'Fleet targeting array', 'Sovereign guns reach 15% further.', 1200, 60, 4, { range: 0.15 }),
  tech('republic', 'r-capital', 'r-ca-bulbs', 'Reinforced shield bulbs', 'Sovereign shields 30% stronger, recharging faster.', 1200, 60, 4, { shield: 0.3, regen: 0.3 }, ['r-ca-range']),
  // Droid Confederacy
  tech('droid', 'd-station', 'd-st-guns', 'Foundry cannons', 'Station turbolasers hit 25% harder.', 700, 45, 1, { damage: 0.25 }),
  tech('droid', 'd-station', 'd-st-ore', 'Ore processors', 'Harvesters bring in 25% more credits.', 600, 40, 1, { mines: 0.25 }),
  tech('droid', 'd-station', 'd-st-dock', 'Repair crews', 'Our ships near the station repair 2% of their hull a second.', 800, 45, 2, { repair: 0.02 }, ['d-st-guns']),
  tech('droid', 'd-fighter', 'd-fi-line', 'Assembly lines', 'Mantis squadrons build 30% faster.', 400, 30, 1, { build: -0.3 }),
  tech('droid', 'd-fighter', 'd-fi-guns', 'Overcharged blasters', 'Lasers and torpedoes deal 25% more damage.', 450, 35, 2, { damage: 0.25 }, ['d-fi-line']),
  tech('droid', 'd-gunship', 'd-gs-shell', 'Armoured shell', 'Tridents get 25% more hull.', 450, 30, 1, { hull: 0.25 }),
  tech('droid', 'd-gunship', 'd-gs-cycle', 'Rapid cyclers', 'Trident guns fire 15% faster.', 450, 30, 1, { cooldown: -0.15 }, ['d-gs-shell']),
  tech('droid', 'd-frigate', 'd-fr-plate', 'Shell plating', 'Scarabs get 25% more hull.', 600, 40, 2, { hull: 0.25 }),
  tech('droid', 'd-frigate', 'd-fr-prong', 'Prong amplifiers', 'Scarab cannons deal 20% more damage.', 650, 40, 2, { damage: 0.2 }, ['d-fr-plate']),
  tech('droid', 'd-cruiser', 'd-cr-ray', 'Ray shielding', 'Manta shields 30% stronger, recharging faster.', 800, 45, 3, { shield: 0.3, regen: 0.3 }),
  tech('droid', 'd-cruiser', 'd-cr-thrust', 'Thruster refit', 'Mantas fly 20% faster.', 700, 40, 3, { speed: 0.2 }, ['d-cr-ray']),
  tech('droid', 'd-capital', 'd-ca-hangar', 'Expanded hangars', 'Hive carriers launch faster and keep one more squadron out.', 1200, 60, 4, { hangar: 1 }),
  tech('droid', 'd-capital', 'd-ca-armour', 'Hive armour', 'Hive carriers get 25% more hull.', 1200, 60, 4, { hull: 0.25 }, ['d-ca-hangar']),
]
export const TECH: Record<string, Tech> = Object.fromEntries(TECHS.map((t) => [t.id, t]))
export const techsFor = (unitId: string) => TECHS.filter((t) => t.for === unitId)
export const MAX_RESEARCH = 4
/** The station-level upgrade shares the research queue under this id. */
export const LEVEL_UP = 'level'

/** Station upgrades: cost and seconds to reach each level (index = the new level). */
export const UPGRADES: ({ cost: number; time: number } | null)[] = [null, null, { cost: 1100, time: 40 }, { cost: 1900, time: 55 }, { cost: 3200, time: 75 }]
export const MAX_LEVEL = 4
/** Hull and turret damage bonus per station level above 1. */
export const STATION_LEVEL_BONUS = 0.15
export const MAX_CAPITALS = 1
