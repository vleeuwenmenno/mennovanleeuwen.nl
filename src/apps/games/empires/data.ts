// Empires At War: the two factions, their ships and the numbers behind them. No DOM here, so the
// headless balance sims can load it too.
//
// Ships face up (nose at the top). Points on a ship (hardpoints, engine glows) are given on a 0-10
// grid over its box (see dims), x from the left edge and y from the nose: where its model
// (models/) puts its guns and modules.
//
// Frigates and everything bigger carry every gun, shield generator, hangar and station module as a
// hardpoint, drawn as a mount of its own on the model (models/mounts.ts), so what a ship shows is
// exactly what it has. Engines stay part of the hull.
//
// Ranges, sensors and speeds are written at the old battlefield scale; scale.ts stretches them
// (see `reach` and `scaled`), so the numbers below stay the ones to balance against each other.

import { sized } from './models/sizes.ts'
import { RANGE_SCALE, SPEED_SCALE, mapDist } from './scale.ts'

/** A gun's or a sensor's reach, as written, at the battlefield's range scale (see scale.ts). */
const reach = (r: number) => Math.round(r * RANGE_SCALE)

export type FactionId = 'republic' | 'droid'
export type Tier = 'fighter' | 'gunship' | 'frigate' | 'cruiser' | 'capital' | 'station' | 'mine' | 'defense' | 'yard'
export type WeaponKind = 'laser' | 'flak' | 'turbo' | 'missile' | 'ion'
export type HardpointKind = 'turret' | 'shield' | 'engine' | 'hangar' | 'refinery' | 'dock' | 'sensor' | 'drill'
/** The mount a module is drawn with (models/mounts.ts). */
export type ModuleArt = 'turbo' | 'flak' | 'ion' | 'shield' | 'hangar' | 'refinery' | 'dock' | 'sensor' | 'drill'
export type AbilityId = 'flakBarrage' | 'repairSwarm' | 'shieldBoost' | 'tractor' | 'broadside' | 'launchSwarm' | 'fieldRepair'

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

/**
 * A part of a ship that can be shot off. `art` is the mount drawn on it and `s` its size as a share
 * of the ship's longest side; engines have no mount of their own. `key` names a station
 * module, so it keeps its damage while the station grows around it.
 */
export type Hardpoint = {
  kind: HardpointKind; x: number; y: number; hp: number; weapon?: Weapon; art?: ModuleArt; s?: number; key?: string
  /** An expansion module bolted onto a Command Station or a yard (see MODULES): what it is. Its
   * feature works only while it stands; the kind is only for its icon and mount. */
  exp?: ModuleId
}

export type UnitType = {
  id: string
  faction: FactionId
  tier: Tier
  name: string
  blurb: string
  /** The name of its look: what a wreck, a thumbnail or a station stage knows it by (stations
   * <faction>-station-<level>). */
  sprite: string
  /** Width / height of its box (dims): the hull's proportions, which its model is drawn on. */
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
  /** What sets it apart from the other ships of its tier: bombers go for big hulls, support ships
   * mend the fleet, ion ships strip shields. Steers the AI and the target picking. */
  kind?: 'bomber' | 'support' | 'ion' | 'repair' | 'wing' | 'engineer'
  /** Research that has to be done before it can be built (on top of the station level). */
  tech?: string
  /** Repairs allied ships within `range`: `repair` hull points a second each, up to `max` ships. */
  support?: { range: number; repair: number; max: number }
  /** Its job and counters, when they differ from its tier's (see ROLES). */
  role?: { role: string; strong: string[]; weak: string[] }
  /** How hard it speeds up and brakes, on top of its tier's usual (1 when left out). */
  accel?: number
}

export type Ability = { name: string; blurb: string; cooldown: number; duration: number; range?: number }

export const ABILITIES: Record<AbilityId, Ability> = {
  flakBarrage: { name: 'Flak barrage', blurb: 'Point defence fires twice as fast for 8 s.', cooldown: 40, duration: 8 },
  repairSwarm: { name: 'Repair swarm', blurb: 'Repair droids restore 30% hull over 10 s.', cooldown: 60, duration: 10 },
  shieldBoost: { name: 'Shield boost', blurb: 'Instantly restores half the shields.', cooldown: 45, duration: 0 },
  tractor: { name: 'Tractor lock', blurb: 'Enemy ships nearby crawl at a third of their speed for 7 s.', cooldown: 45, duration: 7, range: reach(650) },
  broadside: { name: 'Full broadside', blurb: 'Turbolasers deal 60% more damage for 10 s.', cooldown: 50, duration: 10 },
  launchSwarm: { name: 'Launch swarm', blurb: 'Empties the hangars: two extra droid squadrons at once.', cooldown: 60, duration: 0 },
  fieldRepair: {
    name: 'Field repair',
    blurb: 'Flies to a damaged station, or a ship of gunship class or bigger, and welds it back together for 15 s: hull and damaged modules, and it rebuilds destroyed station modules one at a time (a ship\'s shot-off modules stay lost). Aims at the ship under the cursor, else the most damaged one nearby. Idle crews do it by themselves.',
    cooldown: 35, duration: 15, range: reach(1400),
  },
}

/**
 * Field repair, per repair craft in reach: hull points a second, plus this share of the target's
 * full hull (and of each damaged module's) a second. Two craft mend a station or a flagship by
 * about a fifth over one run, a gunship from nearly nothing.
 *
 * On a station (and only there) the crews also rebuild shot-off modules, one at a time: `rebuild`
 * seconds of welding by one craft (so 10 s for a squadron of two, two thirds of a run) bring the
 * module back at `back` of its strength, and from then on it heals like any damaged one. Each
 * shot-off station module counts `lost` towards how badly the station needs mending, a little over
 * the tenth that idle crews look for, so a lost hangar alone is enough to bring them over.
 */
export const FIELD_REPAIR = { flat: 8, share: 0.005, reach: 200, rebuild: 20, back: 0.25, lost: 0.12 }
/**
 * A station's defense wing: one free squadron of small fighters that every station starts with and
 * keeps up. Away from home (more than `radius` from their station, or once it's gone) their guns do
 * `away` of their damage. The station rebuilds lost craft one at a time, every `every` seconds,
 * starting `wait` seconds after the last one was lost, while its hangar stands.
 */
export const DEFENSE_WING = { radius: reach(1400), away: 0.3, every: 25, wait: 15 }
/** A faction's defense wing fighter. */
export const wingOf = (faction: FactionId) => UNIT[faction === 'republic' ? 'r-picket' : 'd-picket']

/** What field repairs work on: stations, and ships of gunship class and up. Strike craft and the
 * platforms on the ore are left to their own (platforms have repair crews of their own). */
export const MENDABLE: Tier[] = ['gunship', 'frigate', 'cruiser', 'capital', 'station', 'yard']

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
// Yards take hits as stations do.
const VS: Record<WeaponKind, Record<Tier, number>> = {
  laser: { fighter: 1, gunship: 0.9, frigate: 0.35, cruiser: 0.25, capital: 0.2, station: 0.2, mine: 0.4, defense: 0.25, yard: 0.2 },
  flak: { fighter: 2.2, gunship: 1.4, frigate: 0.3, cruiser: 0.2, capital: 0.15, station: 0.15, mine: 0.3, defense: 0.2, yard: 0.15 },
  turbo: { fighter: 0.5, gunship: 0.7, frigate: 1, cruiser: 1, capital: 1, station: 1, mine: 1, defense: 1, yard: 1 },
  missile: { fighter: 0.25, gunship: 0.6, frigate: 1.1, cruiser: 1, capital: 0.9, station: 0.8, mine: 1, defense: 1, yard: 0.8 },
  // Against shields; ion barely touches a hull (see the sim's damage).
  ion: { fighter: 0.3, gunship: 0.8, frigate: 1.2, cruiser: 1.3, capital: 1.3, station: 1.2, mine: 0.5, defense: 1.2, yard: 1.2 },
}
/** Chance a shot connects: big guns can't follow fighters. */
const ACCURACY: Record<WeaponKind, Record<Tier, number>> = {
  laser: { fighter: 0.55, gunship: 0.7, frigate: 0.95, cruiser: 1, capital: 1, station: 1, mine: 1, defense: 1, yard: 1 },
  flak: { fighter: 0.75, gunship: 0.8, frigate: 0.95, cruiser: 1, capital: 1, station: 1, mine: 1, defense: 1, yard: 1 },
  turbo: { fighter: 0.15, gunship: 0.35, frigate: 0.85, cruiser: 0.95, capital: 1, station: 1, mine: 1, defense: 0.95, yard: 1 },
  missile: { fighter: 0.3, gunship: 0.7, frigate: 0.95, cruiser: 1, capital: 1, station: 1, mine: 1, defense: 1, yard: 1 },
  ion: { fighter: 0.15, gunship: 0.45, frigate: 0.9, cruiser: 1, capital: 1, station: 1, mine: 1, defense: 1, yard: 1 },
}
export const effect = (w: WeaponKind, t: Tier) => VS[w][t]
export const accuracy = (w: WeaponKind, t: Tier) => ACCURACY[w][t]

const laser = (damage: number, range = 240, cooldown = 0.5): Weapon => ({ kind: 'laser', damage, range: reach(range), cooldown, arc: 0.35 })
const flak = (damage: number, range = 320, cooldown = 0.35, burst = 1): Weapon => ({ kind: 'flak', damage, range: reach(range), cooldown, burst })
const turbo = (damage: number, range = 650, cooldown = 2.2, burst = 2): Weapon => ({ kind: 'turbo', damage, range: reach(range), cooldown, burst })
const missile = (damage: number, range = 420, cooldown = 4): Weapon => ({ kind: 'missile', damage, range: reach(range), cooldown, burst: 2, arc: 0.6 })
/** Fighters' proton torpedoes: slow to reload, useless against other fighters, deadly to big hulls. */
const torpedo = (damage: number, range = 280, cooldown = 7): Weapon => ({ kind: 'missile', damage, range: reach(range), cooldown, burst: 2, arc: 0.4 })

/** An ion cannon: a slow, heavy bolt that tears down shields and does next to nothing to a hull. */
const ion = (damage: number, range = 620, cooldown = 2.4): Weapon => ({ kind: 'ion', damage, range: reach(range), cooldown, burst: 1 })

const P = (kind: HardpointKind, x: number, y: number, hp: number, weapon?: Weapon): Hardpoint => ({ kind, x, y, hp, weapon })
/** A module with a mount of its own, `s` as a share of the ship's longest side. */
const M = (kind: HardpointKind, art: ModuleArt, x: number, y: number, s: number, hp: number, weapon?: Weapon): Hardpoint => ({ kind, art, x, y, s, hp, weapon })
const gun = (art: 'turbo' | 'flak' | 'ion', x: number, y: number, s: number, hp: number, weapon: Weapon) => M('turret', art, x, y, s, hp, weapon)

// --- Toughness ----------------------------------------------------------------------------------------

/** Everything is this much tougher than the numbers written below: hull, shields and every module.
 * One dial for how long fights last; damage and shield recharge are left as they are. */
export const TOUGHNESS = 1.15
const toughen = (t: UnitType): UnitType => ({
  ...t,
  hull: Math.round(t.hull * TOUGHNESS),
  shield: Math.round(t.shield * TOUGHNESS),
  hardpoints: t.hardpoints.map((h) => ({ ...h, hp: Math.round(h.hp * TOUGHNESS) })),
})
/** A unit as written, at the battlefield's scale (see scale.ts): sensors and repair range reach
 * further and engines push harder. Weapons are scaled where they're made (see `reach`). */
const scaled = (t: UnitType): UnitType => ({
  ...t,
  sensor: reach(t.sensor),
  speed: t.speed * SPEED_SCALE,
  ...(t.support ? { support: { ...t.support, range: reach(t.support.range) } } : {}),
})
/** Toughened and scaled: every unit goes through this once. */
const finish = (t: UnitType) => scaled(toughen(t))

// --- Platforms on the ore ---------------------------------------------------------------------------

/**
 * The sockets on a faction's platform hulls, on the 0-10 grid. A defense deck has a big socket in
 * the middle, four at its corners and two small ones at its sides; a mining deck two drill wells
 * and a small socket in the middle.
 */
const DECKS: Record<FactionId, { centre: [number, number]; corners: [number, number][]; sides: [number, number][]; wells: [number, number][]; core: [number, number]; pd: [number, number]; pad: [number, number] }> = {
  republic: { centre: [5, 5], corners: [[2.5, 2.6], [7.5, 2.6], [2.5, 7.4], [7.5, 7.4]], sides: [[0.9, 5], [9.1, 5]], wells: [[1.9, 5.2], [8.1, 5.2]], core: [5, 5.2], pd: [5, 8.3], pad: [5, 1.5] },
  droid: { centre: [5, 5.1], corners: [[2.6, 3], [7.4, 3], [2.6, 7.3], [7.4, 7.3]], sides: [[0.9, 5], [9.1, 5]], wells: [[1.8, 5], [8.2, 5]], core: [5, 5], pd: [5, 7.9], pad: [5, 1.6] },
}
/**
 * A mining platform's point defence: one small flak turret, enough that one squadron of the other
 * side's fighters attacking it has about an even chance; nothing a warship would notice. Tuned per
 * faction in headless duels, because the two squadrons take flak very differently: five fragile
 * droid fighters fall to it far faster than three shielded Republic ones.
 */
export const MINE_FLAK: Record<FactionId, Weapon> = { republic: flak(1.1, 320, 0.4), droid: flak(1.87, 320, 0.4) }

/** Mining platforms: two drill rigs and an ore silo, and a small point-defence turret. Each drill
 * earns 40% of the platform's income and the silo 20%; shot-off parts earn nothing until repaired.
 * They come without shields: the Shield generator upgrade fits a dome on the landing pad. */
function minePlatform(faction: FactionId, shielded = false): UnitType {
  const d = DECKS[faction]
  return {
    id: faction === 'republic' ? 'r-mine' : 'd-mine', faction, tier: 'mine', name: faction === 'republic' ? 'Mining platform' : 'Ore extractor',
    blurb: 'Drills an ore asteroid for credits: two drill rigs and an ore silo, each worth part of the income while it works, and a small flak turret that can hold off a fighter squadron.',
    sprite: `mine-${faction}`, aspect: faction === 'republic' ? 1.051 : 1.092, size: 120, hull: 1000, shield: shielded ? 600 : 0, regen: shielded ? 10 : 0, speed: 0, turn: 0, pop: 0, cost: 500, build: 24, level: 1, squad: 1, sensor: 600,
    weapons: [],
    hardpoints: [
      { ...M('drill', 'drill', d.wells[0][0], d.wells[0][1], 0.3, 400), key: 'drill1' },
      { ...M('drill', 'drill', d.wells[1][0], d.wells[1][1], 0.3, 400), key: 'drill2' },
      { ...M('refinery', 'refinery', d.core[0], d.core[1], 0.1, 300), key: 'silo' },
      { ...gun('flak', d.pd[0], d.pd[1], 0.11, 250, MINE_FLAK[faction]), key: 'pd' },
      ...(shielded ? [{ ...M('shield', 'shield', d.pad[0], d.pad[1], 0.17, 350), key: 'shield' }] : []),
    ],
    engines: [],
  }
}

/** The three defense platforms, each the same deck with different guns on it: flak against
 * fighters, heavy cannons against warships, or a little of both for a little less. */
type DefenseKind = 'balanced' | 'flak' | 'gun'
function defensePlatform(faction: FactionId, kind: DefenseKind): UnitType {
  const d = DECKS[faction]
  const r = faction === 'republic'
  const [c, tl, tr, bl, br] = [d.centre, ...d.corners]
  const base = {
    faction, tier: 'defense' as const, sprite: `defense-${faction}`, aspect: r ? 1.002 : 1.01, size: 130, speed: 0, turn: 0, pop: 0, level: 1, squad: 1, sensor: 1000, weapons: [], engines: [] as [number, number][],
  }
  const turboAt = (p: [number, number], big: boolean, w: Weapon) => gun('turbo', p[0], p[1], big ? 0.33 : 0.17, big ? 650 : 450, w)
  const flakAt = (p: [number, number], small: boolean, w: Weapon) => gun('flak', p[0], p[1], small ? 0.09 : 0.125, small ? 220 : 300, w)
  const shieldAt = (p: [number, number], big: boolean) => M('shield', 'shield', p[0], p[1], big ? 0.2 : 0.125, big ? 700 : 450)
  if (kind === 'flak')
    return {
      ...base, id: r ? 'r-defense-flak' : 'd-defense-flak', name: 'Flak platform', blurb: 'Six point-defence turrets that shred fighters and bombers. Barely scratches a warship. No income.',
      hull: r ? 1800 : 2000, shield: r ? 1100 : 800, regen: r ? 16 : 12, cost: 650, build: 30,
      hardpoints: [shieldAt(c, true), ...[tl, tr, bl, br].map((p) => flakAt(p, false, flak(7, 420, 0.3))), ...d.sides.map((p) => flakAt(p, true, flak(6, 400, 0.35)))],
      role: { role: 'Anti-fighter', strong: ['fighters', 'bombers', 'gunships'], weak: ['frigates', 'cruisers', 'flagships'] },
    }
  if (kind === 'gun')
    return {
      ...base, id: r ? 'r-defense-gun' : 'd-defense-gun', name: 'Gun platform', blurb: 'A heavy turbolaser and two lighter ones that outrange warships. Fighters slip under its guns. No income.',
      hull: r ? 2400 : 2700, shield: r ? 1300 : 1000, regen: r ? 18 : 14, cost: 700, build: 32,
      hardpoints: [turboAt(c, true, turbo(55, 850, 2.2, 2)), turboAt(bl, false, turbo(30, 760, 2, 2)), turboAt(br, false, turbo(30, 760, 2, 2)), shieldAt(tl, false), shieldAt(tr, false)],
      role: { role: 'Anti-warship', strong: ['frigates', 'cruisers', 'flagships'], weak: ['fighters', 'bombers'] },
    }
  return {
    ...base, id: r ? 'r-defense' : 'd-defense', name: 'Defense platform', blurb: 'A turbolaser for warships and flak for fighters: covers both, a little weaker than the specialists. No income.',
    hull: r ? 2000 : 2300, shield: r ? 1200 : 900, regen: r ? 18 : 14, cost: 650, build: 30,
    hardpoints: [turboAt(c, true, turbo(30, 720, 2, 2)), flakAt(tl, false, flak(7, 380, 0.35)), flakAt(tr, false, flak(7, 380, 0.35)), shieldAt(bl, false), shieldAt(br, false)],
  }
}

// --- Yards ------------------------------------------------------------------------------------------

/**
 * Hybrid bases: the starting station is a Command Station, and the yards for the bigger ships are
 * built round it by engineer squadrons, anywhere within BUILD_RADIUS of it (clear of rocks, asteroid
 * fields, ore, beacons, other structures and the map's edge). Each yard has its own build queue and
 * rally point. A destroyed yard leaves its ruin where it stood, which its owner's engineers rebuild
 * for REBUILD of the price.
 *
 * There are two yards: the Frigate Yard (station level 2: frigates and corvettes) and the Capital
 * Yard (station level 3: cruisers, and flagships once its Capital slip stands). The Command Station
 * and both yards take expansion modules (MODULES) on their sockets.
 */
export const BUILD_RADIUS = mapDist(1760)
/** A ruined yard is rebuilt for this share of its price. */
export const REBUILD = 0.5
/** Yards of one kind a player may have at a time (standing, being built, or planned). */
export const YARD_MAX = 1
/**
 * Engineer squadrons at work: how close to a structure's hull an engineer has to be to weld, how
 * many craft can work on one structure at once (more add nothing), and what each craft mends on a
 * finished structure a second: `flat` hull points plus `share` of its full hull, and the same share
 * of every damaged module. A yard's `build` time is one squadron's (three craft's) work, so two
 * squadrons build it in half the time and three in a third. While they work the craft circle the
 * structure slowly, `orbit` radians a second, each on its own place round it.
 */
export const ENGINEERS = { reach: 220, crew: 9, flat: 6, share: 0.004, orbit: 0.14 }
/** A construction site cancelled once building has started gives back this share of its price,
 * less `wear` of it times how far along it was (a site just begun: 75%, one nearly done: 25%). */
export const SITE_REFUND = { start: 0.75, wear: 0.5 }
/**
 * The module sockets on each faction's yards (0-10 grid, as hardpoints), where the expansions
 * attach: on the Frigate Yard two on the flanks and one at the stern; on the Capital Yard one on
 * each flank (the stern one stays free for now).
 */
export const YARD_SOCKETS: Record<FactionId, [number, number][]> = {
  republic: [[1.0, 6.1], [9.0, 6.1], [5, 9.45]],
  droid: [[0.95, 6.3], [9.05, 6.3], [5, 9.5]],
}
export const CYARD_SOCKETS: Record<FactionId, [number, number][]> = {
  republic: [[1.15, 5.7], [8.85, 5.7], [5, 9.45]],
  droid: [[1.15, 5.5], [8.85, 5.5], [5, 9.45]],
}
/** Where the Command Station's expansions sit, on the 0-10 grid of whatever stage it has grown to
 * (so they move out with it): three of its corners, out past the core on struts. */
export const STATION_SOCKETS: [number, number][] = [[1.2, 8.8], [8.9, 1.1], [1.1, 1.1]]

// --- Expansion modules -----------------------------------------------------------------------------

/** The buildings that take expansions: the Command Station and the two yards. */
export type Works = 'station' | 'yard' | 'cyard'
export type ModuleId = 'strikeHangar' | 'sensorArray' | 'shieldCore' | 'secondSlip' | 'drydock' | 'armourWorks' | 'capitalSlip' | 'fighterWing'
/**
 * An expansion: a module ordered from its building's panel and built by the building itself (no
 * engineers needed), one at a time, queued like research. It goes onto socket `socket` of its
 * building as a part of the structure with its own hull (`hp`, before TOUGHNESS) and can be shot
 * off: then its feature stops until it is rebuilt (engineers or repair craft weld it back for
 * REBUILD_MODULE of its price; a repair crew mends it with the rest). `level`: the station level
 * it needs. `s`: its size, as a share of its building's longest side (on the station that of the
 * stage it has grown to, so it grows with the station). `kind`/`art`: its icon and the mount on it.
 */
export type BaseModule = {
  id: ModuleId; on: Works; name: string; blurb: string; lost: string; cost: number; time: number; level: number; hp: number
  socket: number; s: number; kind: HardpointKind; art: ModuleArt
}
/** The whole table, building by building, to tune in one place. */
export const MODULES: BaseModule[] = [
  // Command Station
  { id: 'strikeHangar', on: 'station', name: 'Strike hangar', blurb: 'A second hangar deck for heavy strike craft: bombers are ordered at the Command Station only while it stands, and launch from it.', lost: 'No new bombers can be ordered (those already queued still launch).', cost: 700, time: 40, level: 2, hp: 1300, socket: 0, s: 0.17, kind: 'hangar', art: 'hangar' },
  { id: 'sensorArray', on: 'station', name: 'Sensor array', blurb: 'A long-range sensor mast: the station sees half as far again, well past the edge of the build radius.', lost: 'The station sees only its normal range.', cost: 500, time: 30, level: 1, hp: 900, socket: 1, s: 0.15, kind: 'sensor', art: 'sensor' },
  { id: 'shieldCore', on: 'station', name: 'Shield core', blurb: 'A reactor feeding the station\'s shield generators: 40% more shields, recharging 60% faster.', lost: 'The station\'s shields fall back to what its generators give.', cost: 900, time: 45, level: 2, hp: 1500, socket: 2, s: 0.16, kind: 'shield', art: 'shield' },
  // Frigate Yard
  { id: 'secondSlip', on: 'yard', name: 'Second slip', blurb: 'A second slipway alongside the first: the yard builds the first two ships in its queue at once.', lost: 'The yard builds one ship at a time again.', cost: 1000, time: 45, level: 2, hp: 1300, socket: 0, s: 0.17, kind: 'dock', art: 'dock' },
  { id: 'drydock', on: 'yard', name: 'Drydock', blurb: 'Repair cradles and work crews: our ships near the yard mend 2.5% of their hull a second. The station\'s Repair docks don\'t add to it: a ship near both gets the better of the two.', lost: 'Ships near the yard are no longer mended.', cost: 800, time: 40, level: 2, hp: 1100, socket: 1, s: 0.16, kind: 'dock', art: 'dock' },
  { id: 'armourWorks', on: 'yard', name: 'Armour works', blurb: 'Rolls heavy plate for the fleet: every frigate and corvette of ours has 20% more hull while it stands (added to hull research, not multiplied with it).', lost: 'Our frigates and corvettes lose the extra hull (each keeps the same share of its hull it had).', cost: 900, time: 45, level: 2, hp: 1200, socket: 2, s: 0.15, kind: 'refinery', art: 'refinery' },
  // Capital Yard
  { id: 'capitalSlip', on: 'cyard', name: 'Capital slip', blurb: 'A slipway long enough for a flagship: the Capital Yard builds flagships while it stands.', lost: 'No new flagships can be ordered (one already queued is still finished).', cost: 1200, time: 60, level: 4, hp: 1800, socket: 0, s: 0.19, kind: 'dock', art: 'dock' },
  { id: 'fighterWing', on: 'cyard', name: 'Fighter wing', blurb: 'A hangar with a defense wing of its own: a free squadron of interceptors guards the Capital Yard, and lost craft are rebuilt one at a time.', lost: 'Lost wing craft are no longer rebuilt; the ones still flying fight on.', cost: 800, time: 40, level: 3, hp: 1100, socket: 1, s: 0.15, kind: 'hangar', art: 'hangar' },
]
export const MODULE: Record<ModuleId, BaseModule> = Object.fromEntries(MODULES.map((m) => [m.id, m])) as Record<ModuleId, BaseModule>
/** Expansions waiting or under way at one building, at most. */
export const MODULE_QUEUE = 2
/** A shot-off module is welded back by engineers (or repair craft) for this share of its price. */
export const REBUILD_MODULE = 0.3
/**
 * What the expansions do, in numbers. Sensor array: the station's sight times `sensor`. Shield core:
 * the station's shields `shield` more, recharging `regen` faster. Drydock: our ships within `reach`
 * of the yard's hull mend `repair` of their hull a second. Armour works: `armour` more hull for every
 * frigate and corvette, added to their hull research.
 */
export const MODULE_FX = { sensor: 1.5, shield: 0.4, regen: 0.6, reach: reach(650), repair: 0.025, armour: 0.2 }

/**
 * Rush launch (research RUSH_TECH): a Capital Yard's ship in progress sent out unfinished, once it is
 * at least `min` built. It comes out with that share of its hull, no shields, and as many of its
 * turrets and modules as are still to be built not yet installed (scaffolding: they don't fire or
 * work). Finishing it takes the build time it had left, at the build pace, while a Drydock, repair
 * craft or engineers work on it (one at a time: more of them don't speed it up), free of credits;
 * ordinary repairs mend battle damage but never the unbuilt hull. A yard that rushed can't rush again
 * for `cooldown` seconds, and its next ship takes `slowdown` longer to build (0.25: a quarter).
 * One place to tune it; the dev cheats can override it on a local battle (World.rushTune).
 */
export const RUSH = { min: 0.5, cooldown: 120, slowdown: 0.25 }
/** The research that allows a rush launch, by faction. */
export const RUSH_TECH: Record<FactionId, string> = { republic: 'r-yd-rush', droid: 'd-yd-rush' }
/** The expansions a building takes. */
export const modulesFor = (on: Works) => MODULES.filter((m) => m.on === on)
/** Which building a unit type is, for its expansions (null for everything else). */
export const worksOf = (t: UnitType): Works | null => (t.tier === 'station' ? 'station' : t.tier === 'yard' ? (t.id.endsWith('cyard') ? 'cyard' : 'yard') : null)
/** The hardpoint key a module goes on. */
export const moduleKey = (id: ModuleId) => `x-${id}`
/** The hardpoint a module is, on a building with the box `long` long (stations: in frame pixels). */
const moduleHardpoint = (m: BaseModule, at: [number, number], s: number): Hardpoint => ({
  kind: m.kind, art: m.art, x: at[0], y: at[1], s, hp: Math.round(m.hp * TOUGHNESS), key: moduleKey(m.id), exp: m.id,
})

const yardCache = new Map<string, UnitType>()
/** A yard with the expansions in `mods` built onto it: its own type (like a grown station), its
 * module hardpoints after the yard's own, in MODULES order. The same id, so orders still find it. */
export function yardType(id: string, mods: readonly ModuleId[]): UnitType {
  const base = UNIT[id]
  const on = worksOf(base)
  const have = MODULES.filter((m) => m.on === on && mods.includes(m.id))
  if (!have.length) return base
  const key = `${id}:${have.map((m) => m.id).join(',')}`
  const hit = yardCache.get(key)
  if (hit) return hit
  const sockets = (on === 'cyard' ? CYARD_SOCKETS : YARD_SOCKETS)[base.faction]
  const t: UnitType = { ...base, hardpoints: [...base.hardpoints, ...have.map((m) => moduleHardpoint(m, sockets[m.socket], m.s))] }
  yardCache.set(key, t)
  return t
}

/** A Frigate Yard: a slipway with its gantry (the hardpoint that builds: shot off, work goes at
 * half speed), a shield generator at the stern and a point-defence flak turret at each bow corner. */
function frigateYard(faction: FactionId): UnitType {
  const r = faction === 'republic'
  const pd = flak(6, 380, 0.4)
  return {
    id: r ? 'r-yard' : 'd-yard', faction, tier: 'yard', name: r ? 'Bastion frigate yard' : 'Crucible frigate yard',
    blurb: r
      ? 'A slipway raised by engineers within the Command Station\'s build radius: it builds frigates and corvettes, with its own queue and rally point. Two point-defence turrets and a shield generator keep raiders off it.'
      : 'A droid foundry slipway raised by engineers within the Command Station\'s build radius: it builds the frigates, with its own queue and rally point. Two point-defence turrets and a shield generator keep raiders off it.',
    sprite: `${faction}-yard`, aspect: r ? 0.62 : 0.66, size: 320, hull: r ? 4600 : 5200, shield: r ? 1500 : 1100, regen: r ? 16 : 12, speed: 0, turn: 0, pop: 0, cost: 900, build: 32, level: 2, squad: 1, sensor: 1100,
    weapons: [],
    hardpoints: r
      ? [
          { ...M('dock', 'dock', 5, 4.6, 0.1, 900), key: 'slip' },
          { ...M('shield', 'shield', 5, 8.35, 0.085, 800), key: 'shield' },
          { ...gun('flak', 1.55, 1.7, 0.055, 300, pd), key: 'pd1' },
          { ...gun('flak', 8.45, 1.7, 0.055, 300, pd), key: 'pd2' },
        ]
      : [
          { ...M('dock', 'dock', 5, 4.8, 0.1, 1000), key: 'slip' },
          { ...M('shield', 'shield', 5, 8.6, 0.085, 750), key: 'shield' },
          { ...gun('flak', 1.7, 1.6, 0.055, 320, pd), key: 'pd1' },
          { ...gun('flak', 8.3, 1.6, 0.055, 320, pd), key: 'pd2' },
        ],
    engines: [],
    role: { role: 'Frigate yard', strong: ['building frigates and corvettes'], weak: ['bombers', 'cruisers', 'being left unguarded'] },
  }
}

/** A Capital Yard: a long enclosed dock for the line's heaviest ships, bigger and better armed than
 * the Frigate Yard. Its slipway gantry builds (shot off, work goes at half speed); a shield
 * generator at the stern, a turbolaser at each bow corner and point defence at the stern corners. */
function capitalYard(faction: FactionId): UnitType {
  const r = faction === 'republic'
  const pd = flak(6, 380, 0.4)
  const tl = turbo(30, 760, 2.4, 2)
  return {
    id: r ? 'r-cyard' : 'd-cyard', faction, tier: 'yard', name: r ? 'Citadel capital yard' : 'Leviathan capital foundry',
    blurb: r
      ? 'A great enclosed dock raised by engineers within the Command Station\'s build radius, from station level 3: it builds cruisers, and flagships once its Capital slip is fitted. Its own queue and rally point; turbolasers, point defence and a shield generator guard it.'
      : 'A cavernous droid foundry raised within the command foundry\'s build radius, from station level 3: it builds cruisers, and battleships once its Capital slip is fitted. Its own queue and rally point; cannons, point defence and a shield generator guard it.',
    sprite: `${faction}-cyard`, aspect: r ? 0.7 : 0.74, size: 430, hull: r ? 7400 : 8200, shield: r ? 2400 : 1800, regen: r ? 22 : 17, speed: 0, turn: 0, pop: 0, cost: 2000, build: 48, level: 3, squad: 1, sensor: 1200,
    weapons: [],
    hardpoints: r
      ? [
          { ...M('dock', 'dock', 5, 4.2, 0.11, 1400), key: 'slip' },
          { ...M('shield', 'shield', 5, 8.7, 0.085, 1100), key: 'shield' },
          { ...gun('turbo', 1.7, 1.3, 0.07, 700, tl), key: 'tl1' },
          { ...gun('turbo', 8.3, 1.3, 0.07, 700, tl), key: 'tl2' },
          { ...gun('flak', 1.9, 9.1, 0.05, 320, pd), key: 'pd1' },
          { ...gun('flak', 8.1, 9.1, 0.05, 320, pd), key: 'pd2' },
        ]
      : [
          { ...M('dock', 'dock', 5, 4.4, 0.11, 1500), key: 'slip' },
          { ...M('shield', 'shield', 5, 8.75, 0.085, 1000), key: 'shield' },
          { ...gun('turbo', 1.75, 1.35, 0.07, 760, tl), key: 'tl1' },
          { ...gun('turbo', 8.25, 1.35, 0.07, 760, tl), key: 'tl2' },
          { ...gun('flak', 1.9, 9.1, 0.05, 340, pd), key: 'pd1' },
          { ...gun('flak', 8.1, 9.1, 0.05, 340, pd), key: 'pd2' },
        ],
    engines: [],
    role: { role: 'Capital yard', strong: ['building cruisers and flagships'], weak: ['bombers', 'flagships', 'being left unguarded'] },
  }
}

// --- Stations ---------------------------------------------------------------------------------------

/**
 * A station grows with its level: a small core at level 1, a hub at 2, arms at 3 and the full
 * structure at 4, each stage its own look (<faction>-station-<level>). All four share one frame,
 * as the pictures they were first drawn from did: `box` is where a stage sits in it, and its model
 * and modules are placed in its pixels. A module appears at its `level`, or once its `tech` is
 * researched, and keeps its place (and damage) as the station grows around it.
 */
type StationModule = { key: string; kind: HardpointKind; art: ModuleArt; x: number; y: number; s: number; hp: number; weapon?: Weapon; level?: number; tech?: string }
type StationPlan = {
  id: string
  name: string
  blurb: string
  /** World units per frame pixel. */
  perPx: number
  regen: number
  stages: { box: [number, number, number, number]; hull: number; shield: number }[]
  modules: StationModule[]
}

const stationGun = (art: 'turbo' | 'flak') => (art === 'turbo' ? turbo(48, 800) : flak(7, 380, 0.35))
const sGun = (key: string, art: 'turbo' | 'flak', x: number, y: number, level: number): StationModule =>
  ({ key, kind: 'turret', art, x, y, s: art === 'turbo' ? 110 : 90, hp: art === 'turbo' ? 900 : 500, weapon: stationGun(art), level })
const sPart = (key: string, kind: HardpointKind, art: ModuleArt, x: number, y: number, s: number, hp: number, at: { level?: number; tech?: string }): StationModule => ({ key, kind, art, x, y, s, hp, ...at })

export const STATIONS: Record<FactionId, StationPlan> = {
  republic: {
    id: 'r-station',
    name: 'Bastion command station',
    blurb: 'Your command post. It builds strike craft, gunships and engineers; the engineers raise the yards for bigger ships round it. It starts as a small core and grows with every upgrade. Lose it and the battle is lost.',
    perPx: 460 / 1196,
    regen: 22,
    stages: [
      { box: [419, 417, 834, 833], hull: 6000, shield: 0 },
      { box: [278, 276, 975, 974], hull: 7000, shield: 2400 },
      { box: [135, 60, 1118, 1190], hull: 8000, shield: 3600 },
      { box: [44, 27, 1209, 1223], hull: 9000, shield: 4500 },
    ],
    modules: [
      sGun('t1', 'turbo', 738, 720, 1),
      sPart('h1', 'hangar', 'hangar', 512, 720, 120, 1200, { level: 1 }),
      sPart('sensor', 'sensor', 'sensor', 512, 465, 100, 700, { tech: 'r-st-guns' }),
      sPart('refinery', 'refinery', 'refinery', 738, 465, 110, 700, { tech: 'r-st-ore' }),
      sPart('s1', 'shield', 'shield', 626, 300, 100, 1100, { level: 2 }),
      sGun('t2', 'turbo', 330, 615, 2),
      sGun('f1', 'flak', 925, 615, 2),
      sPart('dock', 'dock', 'dock', 626, 915, 120, 700, { level: 2, tech: 'r-st-dock' }),
      sGun('t3', 'turbo', 552, 117, 3),
      sGun('t4', 'turbo', 700, 1083, 3),
      sPart('s2', 'shield', 'shield', 700, 117, 95, 1100, { level: 3 }),
      sGun('f2', 'flak', 552, 1083, 3),
      sGun('t5', 'turbo', 242, 352, 4),
      sGun('t6', 'turbo', 1008, 352, 4),
      sGun('t7', 'turbo', 242, 858, 4),
      sGun('t8', 'turbo', 1012, 858, 4),
      sGun('f3', 'flak', 368, 224, 4),
      sGun('f4', 'flak', 884, 224, 4),
    ],
  },
  droid: {
    id: 'd-station',
    name: 'Crucible command foundry',
    blurb: 'The droid command foundry. It builds strike craft, gunships and constructor droids; the droids raise the yards for bigger ships round it. It starts as a small core and grows with every upgrade. Lose it and the battle is lost.',
    perPx: 460 / 1148,
    regen: 20,
    stages: [
      { box: [410, 308, 846, 876], hull: 6400, shield: 0 },
      { box: [209, 111, 1047, 1073], hull: 7500, shield: 2100 },
      { box: [104, 15, 1152, 1169], hull: 8600, shield: 3200 },
      { box: [88, 18, 1168, 1166], hull: 9600, shield: 4000 },
    ],
    modules: [
      sGun('t1', 'turbo', 764, 701, 1),
      sPart('h1', 'hangar', 'hangar', 483, 701, 120, 1200, { level: 1 }),
      sPart('sensor', 'sensor', 'sensor', 628, 457, 100, 700, { tech: 'd-st-guns' }),
      sPart('refinery', 'refinery', 'refinery', 628, 781, 110, 700, { tech: 'd-st-ore' }),
      sPart('s1', 'shield', 'shield', 628, 592, 110, 1100, { level: 2 }),
      sGun('t2', 'turbo', 477, 558, 2),
      sGun('f1', 'flak', 769, 558, 2),
      sPart('dock', 'dock', 'dock', 628, 872, 120, 700, { level: 2, tech: 'd-st-dock' }),
      sGun('t3', 'turbo', 155, 370, 3),
      sGun('t4', 'turbo', 1100, 370, 3),
      sPart('s2', 'shield', 'shield', 628, 1055, 95, 1100, { level: 3 }),
      sGun('f2', 'flak', 628, 135, 3),
      sGun('t5', 'turbo', 148, 825, 4),
      sGun('t6', 'turbo', 1110, 825, 4),
      sGun('t7', 'turbo', 398, 993, 4),
      sGun('t8', 'turbo', 855, 993, 4),
      sGun('f3', 'flak', 400, 240, 4),
      sGun('f4', 'flak', 852, 240, 4),
    ],
  },
}

const stationCache = new Map<string, UnitType>()
/** A station as it stands at `level` with `techs` researched: its stage's look, size and hull, and
 * the modules built so far. The same id at every stage, so research and orders still find it. */
export function stationType(faction: FactionId, level: number, techs: readonly string[], exp: readonly ModuleId[] = []): UnitType {
  const plan = STATIONS[faction]
  const lv = Math.max(1, Math.min(plan.stages.length, level))
  const mods = plan.modules.filter((m) => (m.level ?? 1) <= lv && (!m.tech || techs.includes(m.tech)))
  // Expansions (hybrid bases) go after the station's own modules, in MODULES order.
  const xs = MODULES.filter((m) => m.on === 'station' && exp.includes(m.id))
  const id = `${faction}:${lv}:${mods.map((m) => m.key).join(',')}${xs.length ? `|${xs.map((m) => m.id).join(',')}` : ''}`
  const hit = stationCache.get(id)
  if (hit) return hit
  const st = plan.stages[lv - 1]
  const [x0, y0, x1, y1] = st.box
  const w = x1 - x0
  const h = y1 - y0
  const long = Math.max(w, h)
  const t: UnitType = {
    id: plan.id, faction, tier: 'station', name: plan.name, blurb: plan.blurb, sprite: `${faction}-station-${lv}`, aspect: w / h, size: long * plan.perPx,
    hull: st.hull, shield: st.shield, regen: plan.regen, speed: 0, turn: 0, pop: 0, cost: 0, build: 0, level: 0, squad: 1, sensor: 1600,
    weapons: [],
    hardpoints: mods.map((m) => ({ kind: m.kind, art: m.art, key: m.key, hp: m.hp, weapon: m.weapon, x: ((m.x - x0) / w) * 10, y: ((m.y - y0) / h) * 10, s: m.s / long })),
    engines: [],
  }
  const tough = finish(t)
  // (Already toughened, so they go on after.)
  if (xs.length) tough.hardpoints = [...tough.hardpoints, ...xs.map((m) => moduleHardpoint(m, STATION_SOCKETS[m.socket], m.s))]
  stationCache.set(id, tough)
  return tough
}

/** Every unit as written, before TOUGHNESS. */
const WRITTEN: UnitType[] = [
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
    id: 'r-bomber', faction: 'republic', tier: 'fighter', kind: 'bomber', name: 'Hammer bomber', blurb: 'Armoured bombers, two to a squadron. Heavy proton bombs for capital ships and stations; easy prey for fighters.',
    sprite: 'republic-bomber', aspect: 0.715, size: 42, hull: 150, shield: 40, regen: 3, speed: 165, turn: 2.6, pop: 2, cost: 450, build: 16, level: 2, squad: 2, sensor: 650,
    weapons: [laser(5, 220, 0.6), torpedo(75, 240, 6)], hardpoints: [], engines: [[3.3, 9.6], [6.8, 9.6]],
    role: { role: 'Bomber', strong: ['cruisers', 'flagships', 'stations'], weak: ['fighters', 'gunships', 'frigates'] },
  },
  {
    id: 'r-repair', faction: 'republic', tier: 'fighter', kind: 'repair', tech: 'r-re-wing', name: 'Suture repair fighter', blurb: 'Engineer craft, two to a squadron. Barely armed, but its Field repair welds stations and warships back together in the middle of a fight.',
    sprite: 'republic-repair', aspect: 0.774, size: 32, hull: 70, shield: 25, regen: 2, speed: 240, turn: 3.6, pop: 1, cost: 280, build: 12, level: 1, squad: 2, sensor: 700,
    weapons: [laser(2, 200, 0.8)], hardpoints: [], engines: [[3.3, 8.2], [6.85, 8.2]], ability: 'fieldRepair',
    role: { role: 'Field repairs', strong: ['long fights', 'keeping flagships alive'], weak: ['fighters', 'flak', 'everything else'] },
  },
  {
    id: 'r-picket', faction: 'republic', tier: 'fighter', kind: 'wing', name: 'Aegis picket', blurb: 'The station\'s own defense wing: five light interceptors that guard it for free and come back from its hangar when lost. Fierce at home, feeble far from it.',
    sprite: 'republic-picket', aspect: 0.767, size: 22, hull: 34, shield: 10, regen: 1, speed: 285, turn: 4.8, pop: 0, cost: 0, build: 0, level: 1, squad: 5, sensor: 650,
    weapons: [laser(4, 220, 0.45)], hardpoints: [], engines: [[5, 8.5]],
    role: { role: 'Home defense', strong: ['fighters', 'bombers near the station'], weak: ['warships', 'being sent away from home'] },
  },
  {
    id: 'r-engineer', faction: 'republic', tier: 'fighter', kind: 'engineer', name: 'Mason engineer', blurb: 'Clone engineers in three boxy utility craft. Unarmed and fragile: they build the yards round the Command Station and weld structures back together.',
    sprite: 'republic-engineer', aspect: 0.82, size: 30, hull: 60, shield: 15, regen: 1.5, speed: 215, turn: 3.6, pop: 1, cost: 300, build: 14, level: 1, squad: 3, sensor: 700,
    weapons: [], hardpoints: [], engines: [[3.3, 9.3], [6.7, 9.3]],
    role: { role: 'Construction', strong: ['building yards', 'repairing structures'], weak: ['anything that shoots'] },
  },
  {
    id: 'r-corvette', faction: 'republic', tier: 'gunship', kind: 'support', name: 'Mercy corvette', blurb: 'Repair tender: its work crews patch up the hulls of nearby ships. Lightly armed; keep it behind the line.',
    sprite: 'republic-corvette', aspect: 0.653, size: 86, hull: 520, shield: 260, regen: 8, speed: 135, turn: 1.8, pop: 2, cost: 550, build: 18, level: 2, squad: 1, sensor: 900,
    weapons: [flak(5, 280, 0.4)], hardpoints: [], engines: [[3.5, 9.4], [5, 9.5], [6.6, 9.4]],
    support: { range: 520, repair: 16, max: 6 },
    role: { role: 'Repair tender', strong: ['long fights'], weak: ['fighters', 'anything that catches it alone'] },
  },
  {
    id: 'r-frigate', faction: 'republic', tier: 'frigate', name: 'Warden frigate', blurb: 'Escort bristling with point defence. Fighters melt around it.',
    sprite: 'republic-frigate', aspect: 0.671, size: 130, hull: 950, shield: 650, regen: 14, speed: 76, turn: 1.0, pop: 3, cost: 820, build: 22, level: 2, squad: 1, sensor: 1000,
    weapons: [],
    hardpoints: [
      gun('flak', 3.51, 3.11, 0.075, 160, flak(6, 340, 0.3)), gun('flak', 6.49, 3.11, 0.075, 160, flak(6, 340, 0.3)), gun('flak', 2.73, 4.89, 0.075, 160, flak(6, 340, 0.3)),
      gun('flak', 7.27, 4.89, 0.075, 160, flak(6, 340, 0.3)), gun('turbo', 2.48, 7.26, 0.105, 300, turbo(28, 560, 2.2, 1)), M('shield', 'shield', 7.52, 7.26, 0.098, 320),
    ],
    engines: [[3.64, 9.44], [5, 9.5], [6.42, 9.44]],
    ability: 'flakBarrage',
  },
  {
    id: 'r-cruiser', faction: 'republic', tier: 'cruiser', name: 'Paladin cruiser', blurb: 'Line warship with heavy turbolasers. Knock out its shield bulbs first.',
    sprite: 'republic-cruiser', aspect: 0.376, size: 220, hull: 2300, shield: 1500, regen: 24, speed: 52, turn: 0.6, pop: 5, cost: 1650, build: 34, level: 3, squad: 1, sensor: 1200,
    weapons: [],
    hardpoints: [
      gun('turbo', 5, 1.8, 0.083, 300, turbo(22)), gun('turbo', 5, 2.7, 0.083, 300, turbo(22)), gun('turbo', 5, 3.4, 0.083, 300, turbo(22)), gun('turbo', 5, 4.4, 0.083, 300, turbo(22)),
      gun('flak', 5, 5.4, 0.068, 200, flak(6, 320, 0.8)), gun('flak', 5, 6.9, 0.068, 200, flak(6, 320, 0.8)),
      M('shield', 'shield', 1.7, 5.6, 0.128, 460), M('shield', 'shield', 8.3, 5.6, 0.128, 460), P('engine', 2.46, 9.4, 420), P('engine', 7.54, 9.4, 420),
    ],
    engines: [[2.46, 9.6], [7.54, 9.6]], ability: 'shieldBoost',
  },
  {
    id: 'r-capital', faction: 'republic', tier: 'capital', name: 'Sovereign dreadnought', blurb: 'Dagger-hulled flagship. Turbolaser batteries and its own fighter wing.',
    sprite: 'republic-capital', aspect: 0.629, size: 380, hull: 5400, shield: 3600, regen: 40, speed: 34, turn: 0.33, pop: 10, cost: 4200, build: 70, level: 4, squad: 1, sensor: 1500,
    weapons: [],
    hardpoints: [
      gun('turbo', 3.65, 3.95, 0.09, 720, turbo(58, 760)), gun('turbo', 6.35, 3.95, 0.09, 720, turbo(58, 760)), gun('turbo', 3.25, 5.7, 0.09, 720, turbo(58, 760)), gun('turbo', 6.75, 5.7, 0.09, 720, turbo(58, 760)),
      gun('flak', 3.9, 3.3, 0.068, 300, flak(6, 340, 0.9)), gun('flak', 6.1, 3.3, 0.068, 300, flak(6, 340, 0.9)), gun('flak', 3.4, 4.8, 0.068, 300, flak(6, 340, 0.9)), gun('flak', 6.6, 4.8, 0.068, 300, flak(6, 340, 0.9)),
      M('shield', 'shield', 2.75, 8.15, 0.15, 820), M('shield', 'shield', 7.25, 8.15, 0.15, 820), P('engine', 5, 9.2, 950), M('hangar', 'hangar', 5, 4.4, 0.135, 760),
    ],
    engines: [[2.69, 9.44], [3.75, 9.55], [4.95, 9.72], [6.22, 9.55], [7.28, 9.44]], ability: 'broadside', carrier: { unit: 'r-fighter', every: 28, max: 2 },
  },
  stationType('republic', 1, []),
  minePlatform('republic'),
  defensePlatform('republic', 'balanced'),
  defensePlatform('republic', 'flak'),
  defensePlatform('republic', 'gun'),
  frigateYard('republic'),
  capitalYard('republic'),

  // --- Droid Confederacy ------------------------------------------------------------------------
  {
    id: 'd-fighter', faction: 'droid', tier: 'fighter', name: 'Ratchet droid fighter', blurb: 'Five cheap droids per squadron. Fragile, relentless, and their torpedoes add up against big ships.',
    sprite: 'droid-fighter', aspect: 0.963, size: 28, hull: 38, shield: 0, regen: 0, speed: 255, turn: 4.4, pop: 1, cost: 230, build: 9, level: 1, squad: 5, sensor: 650,
    weapons: [laser(5, 230, 0.45), torpedo(16, 260)], hardpoints: [], engines: [[5, 8.4]],
  },
  {
    id: 'd-gunship', faction: 'droid', tier: 'gunship', name: 'Triad gunship', blurb: 'Three blaster arms that tear through fighters.',
    sprite: 'droid-gunship', aspect: 1.067, size: 64, hull: 395, shield: 80, regen: 5, speed: 165, turn: 2.6, pop: 2, cost: 400, build: 13, level: 1, squad: 1, sensor: 780,
    weapons: [flak(6, 290, 0.28), laser(12, 320, 1)], hardpoints: [], engines: [[5, 6.6]],
  },
  {
    id: 'd-bomber', faction: 'droid', tier: 'fighter', kind: 'bomber', name: 'Sledge bomber', blurb: 'Twin-hulled droid bombers, three to a squadron. Cheap, fragile, and their bomb bays wreck big hulls.',
    sprite: 'droid-bomber', aspect: 0.96, size: 36, hull: 85, shield: 0, regen: 0, speed: 185, turn: 3, pop: 2, cost: 400, build: 13, level: 2, squad: 3, sensor: 620,
    weapons: [laser(4, 220, 0.6), torpedo(48, 230, 6)], hardpoints: [], engines: [[5, 8.6]],
    role: { role: 'Bomber', strong: ['cruisers', 'flagships', 'stations'], weak: ['fighters', 'gunships', 'frigates'] },
  },
  {
    id: 'd-repair', faction: 'droid', tier: 'fighter', kind: 'repair', tech: 'd-re-wing', name: 'Tinker repair droid', blurb: 'Blocky welder droids, two to a squadron. Next to harmless, but their Field repair stitches foundries and warships back together under fire.',
    sprite: 'droid-repair', aspect: 0.779, size: 30, hull: 85, shield: 0, regen: 0, speed: 245, turn: 3.8, pop: 1, cost: 260, build: 11, level: 1, squad: 2, sensor: 650,
    weapons: [laser(2, 200, 0.8)], hardpoints: [], engines: [[5, 9.1]], ability: 'fieldRepair',
    role: { role: 'Field repairs', strong: ['long fights', 'keeping flagships alive'], weak: ['fighters', 'flak', 'everything else'] },
  },
  {
    id: 'd-picket', faction: 'droid', tier: 'fighter', kind: 'wing', name: 'Bolt guard droid', blurb: 'The foundry\'s own defense wing: six tiny droids that guard it for free and are rebuilt by its hangar when lost. Vicious at home, feeble far from it.',
    sprite: 'droid-picket', aspect: 0.989, size: 20, hull: 26, shield: 0, regen: 0, speed: 275, turn: 5, pop: 0, cost: 0, build: 0, level: 1, squad: 6, sensor: 620,
    weapons: [laser(3.5, 210, 0.42)], hardpoints: [], engines: [[5, 8]],
    role: { role: 'Home defense', strong: ['fighters', 'bombers near the station'], weak: ['warships', 'being sent away from home'] },
  },
  {
    id: 'd-engineer', faction: 'droid', tier: 'fighter', kind: 'engineer', name: 'Rivet constructor droid', blurb: 'Three spindly constructor droids with cutting arms. Unarmed and fragile: they build the yards round the command foundry and weld structures back together.',
    sprite: 'droid-engineer', aspect: 0.86, size: 30, hull: 72, shield: 0, regen: 0, speed: 210, turn: 3.6, pop: 1, cost: 300, build: 14, level: 1, squad: 3, sensor: 650,
    weapons: [], hardpoints: [], engines: [[5, 9.2]],
    role: { role: 'Construction', strong: ['building yards', 'repairing structures'], weak: ['anything that shoots'] },
  },
  {
    id: 'd-ion', faction: 'droid', tier: 'frigate', kind: 'ion', name: 'Disruptor frigate', blurb: 'One huge ion cannon that tears down shields in a few shots, leaving the hull open to everything else. Barely scratches bare armour.',
    sprite: 'droid-ion', aspect: 0.227, size: 140, hull: 900, shield: 380, regen: 9, speed: 70, turn: 0.95, pop: 3, cost: 780, build: 22, level: 2, squad: 1, sensor: 1000,
    weapons: [],
    hardpoints: [gun('ion', 5, 2.4, 0.165, 320, ion(70)), M('shield', 'shield', 5, 4.2, 0.105, 280), gun('flak', 5, 6.0, 0.09, 160, flak(5, 300, 0.4))],
    engines: [[2.35, 9.33], [7.5, 9.33]],
    role: { role: 'Shield breaker', strong: ['shielded warships', 'stations'], weak: ['fighters', 'unshielded ships'] },
  },
  {
    id: 'd-frigate', faction: 'droid', tier: 'frigate', name: 'Bulwark frigate', blurb: 'A heavy armoured bulb, twin cannons and repair droids.',
    sprite: 'droid-frigate', aspect: 0.422, size: 135, hull: 1150, shield: 450, regen: 10, speed: 72, turn: 1.0, pop: 3, cost: 760, build: 21, level: 2, squad: 1, sensor: 950,
    weapons: [],
    hardpoints: [
      gun('turbo', 3.8, 1.3, 0.09, 260, turbo(20, 520, 1.4, 1)), gun('turbo', 6.2, 1.3, 0.09, 260, turbo(20, 520, 1.4, 1)), M('shield', 'shield', 5, 2.65, 0.09, 300),
      gun('flak', 3.04, 6.73, 0.075, 160, flak(6, 320, 0.33)), gun('flak', 6.96, 6.73, 0.075, 160, flak(6, 320, 0.33)),
    ],
    engines: [[2.84, 9.39], [4.95, 9.6], [7.0, 9.39]],
    ability: 'repairSwarm',
  },
  {
    id: 'd-cruiser', faction: 'droid', tier: 'cruiser', name: 'Anvil cruiser', blurb: 'Gun galleries either side of a towering sail, and a tractor projector that pins ships in place.',
    sprite: 'droid-cruiser', aspect: 1.508, size: 260, hull: 2700, shield: 1100, regen: 18, speed: 49, turn: 0.55, pop: 5, cost: 1550, build: 33, level: 3, squad: 1, sensor: 1200,
    weapons: [],
    hardpoints: [
      gun('turbo', 0.83, 6.45, 0.09, 560, turbo(40)), gun('turbo', 9.17, 6.45, 0.09, 560, turbo(40)), gun('flak', 2.33, 3.94, 0.075, 220, turbo(12, 480, 1.2, 1)), gun('flak', 7.67, 3.94, 0.075, 220, turbo(12, 480, 1.2, 1)),
      M('shield', 'shield', 1.58, 5.03, 0.083, 440), M('shield', 'shield', 8.42, 5.03, 0.083, 440), P('engine', 4.47, 9.3, 420), P('engine', 5.52, 9.3, 420),
    ],
    engines: [[4.47, 9.55], [5.52, 9.55]], ability: 'tractor',
  },
  {
    id: 'd-capital', faction: 'droid', tier: 'capital', name: 'Gyre battleship', blurb: 'A ring-hulled flying factory round a command sphere. Its hangar bays never stop launching.',
    sprite: 'droid-capital', aspect: 0.742, size: 380, hull: 6200, shield: 2800, regen: 32, speed: 31, turn: 0.32, pop: 10, cost: 4000, build: 68, level: 4, squad: 1, sensor: 1500,
    weapons: [],
    hardpoints: [
      gun('turbo', 4.12, 5.17, 0.09, 680, turbo(52, 720)), gun('turbo', 5.88, 5.17, 0.09, 680, turbo(52, 720)), gun('turbo', 4.12, 6.72, 0.09, 680, turbo(52, 720)), gun('turbo', 5.88, 6.72, 0.09, 680, turbo(52, 720)),
      gun('flak', 2.72, 1.31, 0.068, 280, flak(6, 340, 0.9)), gun('flak', 7.28, 1.31, 0.068, 280, flak(6, 340, 0.9)), gun('flak', 1.25, 3.33, 0.068, 280, flak(6, 340, 0.9)), gun('flak', 8.75, 3.33, 0.068, 280, flak(6, 340, 0.9)),
      M('shield', 'shield', 3.97, 4.33, 0.098, 760), M('shield', 'shield', 6.03, 4.33, 0.098, 760), P('engine', 5, 9.1, 950), M('hangar', 'hangar', 3.0, 2.9, 0.135, 720), M('hangar', 'hangar', 7.0, 2.9, 0.135, 720),
    ],
    engines: [[3.67, 9.44], [4.52, 9.72], [5.43, 9.72], [6.31, 9.44]], ability: 'launchSwarm', carrier: { unit: 'd-fighter', every: 20, max: 3 },
  },
  stationType('droid', 1, []),
  minePlatform('droid'),
  defensePlatform('droid', 'balanced'),
  defensePlatform('droid', 'flak'),
  defensePlatform('droid', 'gun'),
  frigateYard('droid'),
  capitalYard('droid'),
]
/** Every unit, toughened and scaled (stations come out of stationType that way already), at its
 * size (models/sizes.ts). */
export const UNITS: UnitType[] = WRITTEN.map((u) => (u.tier === 'station' ? u : sized(finish(u))))

const SHIELDED_MINE: Record<FactionId, UnitType> = { republic: finish(minePlatform('republic', true)), droid: finish(minePlatform('droid', true)) }
/** A faction's mining platform as built, or with its Shield generator fitted. */
export const mineType = (faction: FactionId, shielded: boolean) => (shielded ? SHIELDED_MINE[faction] : UNITS.find((u) => u.faction === faction && u.tier === 'mine')!)

/** What each class is for, and the counter loop players need to learn: fighters beat big ships,
 * gunships beat fighters, frigates beat gunships, cruisers beat frigates. */
export const ROLES: Partial<Record<Tier, { role: string; strong: string[]; weak: string[] }>> = {
  fighter: { role: 'Strike craft', strong: ['cruisers', 'flagships'], weak: ['gunships', 'frigates'] },
  gunship: { role: 'Fighter hunter', strong: ['fighters'], weak: ['frigates', 'cruisers'] },
  frigate: { role: 'Escort', strong: ['gunships', 'fighters'], weak: ['cruisers'] },
  cruiser: { role: 'Line warship', strong: ['frigates', 'stations'], weak: ['fighters'] },
  capital: { role: 'Flagship', strong: ['frigates', 'cruisers', 'stations'], weak: ['fighter swarms'] },
  defense: { role: 'Gun emplacement', strong: ['gunships', 'frigates'], weak: ['cruisers', 'flagships'] },
}

export const UNIT: Record<string, UnitType> = Object.fromEntries(UNITS.map((u) => [u.id, u]))
/** An expansion module's look's name, for the queues and cards that show one being built (Hud.tsx
 * unitArt draws it). */
export const moduleLook = (faction: FactionId, id: ModuleId) => `${faction}-x-${id}`
export const SHIP_TIERS: Tier[] = ['fighter', 'gunship', 'frigate', 'cruiser', 'capital']
export const unitOf = (faction: FactionId, tier: Tier) => UNIT[`${faction === 'republic' ? 'r' : 'd'}-${tier}`]
/** The ships a faction can order from its station: by the station level they need, then cost. The
 * station's defense wing comes with it and is never ordered. Engineers aren't in it: they only exist
 * where bases are built (see `baseBuilds`), so galactic conquest never offers them. */
export const buildable = (faction: FactionId) =>
  UNITS.filter((u) => u.faction === faction && SHIP_TIERS.includes(u.tier) && u.kind !== 'wing' && u.kind !== 'engineer').sort((a, b) => a.level - b.level || a.cost - b.cost)
/** Every ship a faction can order in a battle with hybrid bases, engineers included. */
export const baseBuilds = (faction: FactionId) =>
  UNITS.filter((u) => u.faction === faction && SHIP_TIERS.includes(u.tier) && u.kind !== 'wing').sort((a, b) => a.level - b.level || a.cost - b.cost)
/** Where a ship is built in a battle with hybrid bases: frigates and corvettes at a Frigate Yard,
 * cruisers and flagships at a Capital Yard (flagships only once its Capital slip stands), and
 * everything else (strike craft, gunships, engineers) at the Command Station. */
export const builtAt = (t: UnitType): Works => (t.tier === 'frigate' || t.kind === 'support' ? 'yard' : t.tier === 'cruiser' || t.tier === 'capital' ? 'cyard' : 'station')
/** A faction's Frigate Yard, or with `kind` 'cyard' its Capital Yard. */
export const yardOf = (faction: FactionId, kind: 'yard' | 'cyard' = 'yard') => UNIT[`${faction === 'republic' ? 'r' : 'd'}-${kind}`]
/** Both of a faction's yards, the Frigate Yard first. */
export const yardsFor = (faction: FactionId) => [yardOf(faction, 'yard'), yardOf(faction, 'cyard')]
/** What a ship needs before it can be ordered with hybrid bases, beyond the station level and
 * research: the bombers the Command Station's Strike hangar, the flagships the Capital slip. */
export const needsModule = (t: UnitType): ModuleId | null => (t.kind === 'bomber' ? 'strikeHangar' : t.tier === 'capital' ? 'capitalSlip' : null)
/** A building's short name, for the HUD. */
export const WORKS_NAME: Record<Works, string> = { station: 'Command Station', yard: 'Frigate Yard', cyard: 'Capital Yard' }
/** Whether a unit is an engineer craft. */
export const isEngineer = (t: UnitType) => t.kind === 'engineer'
/** A ship's job and counters: its own, or its tier's. */
export const roleOf = (t: UnitType) => t.role ?? ROLES[t.tier]
export const isShip = (t: UnitType) => t.tier !== 'station' && t.tier !== 'mine' && t.tier !== 'defense' && t.tier !== 'yard'
/** What can go on a surveyed ore asteroid, one structure each: the mining platform, then the
 * defense platforms (balanced first). */
export const siteOptions = (faction: FactionId) => UNITS.filter((u) => u.faction === faction && (u.tier === 'mine' || u.tier === 'defense'))

/** World size of a sprite: [width, height]. */
export function dims(t: UnitType): [number, number] {
  return t.aspect >= 1 ? [t.size, t.size / t.aspect] : [t.size * t.aspect, t.size]
}

// --- Economy ----------------------------------------------------------------------------------------

export const START_CREDITS = 1600
/** The starting credits a lobby can pick from. */
export const CREDIT_STEPS = [500, 1000, 1600, 2500, 4000, 6000, 10000]
/** Ore must be surveyed before anything is built on it: ships nearby, unopposed, for this long. */
export const SURVEY_TIME = 8
export const SURVEY_RADIUS = 380
/** Credits per second from the station, by level. */
export const STATION_INCOME = [0, 6, 7, 8, 9]
/** Credits a second from a mining platform before its upgrades (see SITE_UPGRADES). */
export const MINE_INCOME = 3.8

/**
 * Upgrades bought for one mining platform, kept by that platform only: lose it and a new one starts
 * from nothing. `cost` and `time` are per level.
 */
export type SiteUpgradeId = 'yield' | 'armor' | 'shield'
export type SiteUpgrade = { id: SiteUpgradeId; name: string; blurb: string; levels: number; cost: number[]; time: number }
export const SITE_UPGRADES: SiteUpgrade[] = [
  { id: 'yield', name: 'Deeper drills', blurb: 'This platform mines 30% more per level.', levels: 2, cost: [400, 550], time: 25 },
  { id: 'armor', name: 'Armour plating', blurb: 'This platform and its parts take 50% more punishment.', levels: 1, cost: [450], time: 25 },
  { id: 'shield', name: 'Shield generator', blurb: 'Fits a shield dome: this platform gets shields that recharge (until the dome is shot off).', levels: 1, cost: [500], time: 30 },
]
/** Output per Deeper drills level, and hull and module health from Armour plating. */
export const YIELD_PER_LEVEL = 0.3
export const ARMOR_BONUS = 0.5
export const BEACON_INCOME = 1.5
export const BASE_POP = 30
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
  tech('republic', 'r-station', 'r-st-guns', 'Turbolaser emplacements', 'A targeting array on the station: its turbolasers hit 25% harder while the array stands.', 700, 45, 1, { damage: 0.25 }),
  tech('republic', 'r-station', 'r-st-ore', 'Advanced refineries', 'A refinery on the station: mining platforms bring in 25% more credits while it stands.', 600, 40, 1, { mines: 0.25 }),
  tech('republic', 'r-station', 'r-st-dock', 'Repair docks', 'A repair dock on the station: our ships near it repair 2% of their hull a second while it stands.', 800, 45, 2, { repair: 0.02 }, ['r-st-guns']),
  tech('republic', 'r-fighter', 'r-fi-hull', 'Reinforced hulls', 'Lance interceptors get 25% more hull.', 400, 30, 1, { hull: 0.25 }),
  tech('republic', 'r-fighter', 'r-fi-torp', 'Proton payload', 'Lasers and torpedoes deal 25% more damage.', 500, 35, 2, { damage: 0.25 }, ['r-fi-hull']),
  tech('republic', 'r-gunship', 'r-gs-flak', 'Flak tracking', 'Halberd guns deal 20% more damage.', 450, 30, 1, { damage: 0.2 }),
  tech('republic', 'r-gunship', 'r-gs-burn', 'Afterburners', 'Halberds fly 20% faster.', 350, 25, 1, { speed: 0.2 }, ['r-gs-flak']),
  tech('republic', 'r-repair', 'r-re-wing', 'Engineer wing', 'Trains clone engineers for the hangar: unlocks the Suture repair fighter and its Field repair.', 300, 25, 1, {}),
  tech('republic', 'r-bomber', 'r-bo-payload', 'Heavy payload', 'Hammer bombs deal 25% more damage.', 550, 35, 2, { damage: 0.25 }),
  tech('republic', 'r-corvette', 'r-co-crews', 'Veteran work crews', 'Mercy corvettes repair 40% faster.', 600, 40, 2, { repair: 0.4 }),
  tech('republic', 'r-frigate', 'r-fr-shield', 'Deflector upgrade', 'Warden shields 30% stronger, recharging faster.', 600, 40, 2, { shield: 0.3, regen: 0.3 }),
  tech('republic', 'r-frigate', 'r-fr-pd', 'Point-defence computers', 'Warden guns fire 15% faster.', 650, 40, 2, { cooldown: -0.15 }, ['r-fr-shield']),
  tech('republic', 'r-cruiser', 'r-cr-cap', 'Heavy capacitors', 'Paladin turbolasers deal 20% more damage.', 900, 50, 3, { damage: 0.2 }),
  tech('republic', 'r-cruiser', 'r-cr-armour', 'Armour plating', 'Paladins get 25% more hull.', 800, 45, 3, { hull: 0.25 }, ['r-cr-cap']),
  tech('republic', 'r-capital', 'r-ca-range', 'Fleet targeting array', 'Sovereign guns reach 15% further.', 1200, 60, 4, { range: 0.15 }),
  tech('republic', 'r-capital', 'r-ca-bulbs', 'Reinforced shield bulbs', 'Sovereign shields 30% stronger, recharging faster.', 1200, 60, 4, { shield: 0.3, regen: 0.3 }, ['r-ca-range']),
  tech('republic', 'r-cyard', 'r-yd-rush', 'Rushed construction', 'Crews trained to launch a warship before it is finished: the Capital Yard can rush out the ship it is building once it is half done (Rush launch). It comes out damaged, with turrets still in scaffolding, and needs repair crews to be finished. Needs a Capital Yard.', 800, 45, 3, {}),
  // Droid Confederacy
  tech('droid', 'd-station', 'd-st-guns', 'Foundry cannons', 'A sensor eye on the station: its cannons hit 25% harder while the eye stands.', 700, 45, 1, { damage: 0.25 }),
  tech('droid', 'd-station', 'd-st-ore', 'Ore processors', 'An ore processor on the station: extractors bring in 25% more credits while it stands.', 600, 40, 1, { mines: 0.25 }),
  tech('droid', 'd-station', 'd-st-dock', 'Repair crews', 'A repair crane on the station: our ships near it repair 2% of their hull a second while it stands.', 800, 45, 2, { repair: 0.02 }, ['d-st-guns']),
  tech('droid', 'd-fighter', 'd-fi-line', 'Assembly lines', 'Ratchet squadrons build 30% faster.', 400, 30, 1, { build: -0.3 }),
  tech('droid', 'd-fighter', 'd-fi-guns', 'Overcharged blasters', 'Lasers and torpedoes deal 25% more damage.', 450, 35, 2, { damage: 0.25 }, ['d-fi-line']),
  tech('droid', 'd-gunship', 'd-gs-shell', 'Armour casing', 'Triads get 25% more hull.', 450, 30, 1, { hull: 0.25 }),
  tech('droid', 'd-gunship', 'd-gs-cycle', 'Rapid cyclers', 'Triad guns fire 15% faster.', 450, 30, 1, { cooldown: -0.15 }, ['d-gs-shell']),
  tech('droid', 'd-repair', 'd-re-wing', 'Welder protocols', 'Loads repair programming into the foundry: unlocks the Tinker repair droid and its Field repair.', 300, 25, 1, {}),
  tech('droid', 'd-bomber', 'd-bo-pods', 'Overloaded pods', 'Sledge bombs deal 25% more damage.', 500, 35, 2, { damage: 0.25 }),
  tech('droid', 'd-ion', 'd-io-coils', 'Supercooled coils', 'Disruptor ion cannons fire 20% faster.', 700, 40, 2, { cooldown: -0.2 }),
  tech('droid', 'd-frigate', 'd-fr-plate', 'Bulwark plating', 'Bulwarks get 25% more hull.', 600, 40, 2, { hull: 0.25 }),
  tech('droid', 'd-frigate', 'd-fr-prong', 'Cannon amplifiers', 'Bulwark cannons deal 20% more damage.', 650, 40, 2, { damage: 0.2 }, ['d-fr-plate']),
  tech('droid', 'd-cruiser', 'd-cr-ray', 'Deflector banks', 'Anvil shields 30% stronger, recharging faster.', 800, 45, 3, { shield: 0.3, regen: 0.3 }),
  tech('droid', 'd-cruiser', 'd-cr-thrust', 'Thruster refit', 'Anvils fly 20% faster.', 700, 40, 3, { speed: 0.2 }, ['d-cr-ray']),
  tech('droid', 'd-capital', 'd-ca-hangar', 'Expanded hangars', 'Gyre battleships launch faster and keep one more squadron out.', 1200, 60, 4, { hangar: 1 }),
  tech('droid', 'd-capital', 'd-ca-armour', 'Ring armour', 'Gyre battleships get 25% more hull.', 1200, 60, 4, { hull: 0.25 }, ['d-ca-hangar']),
  tech('droid', 'd-cyard', 'd-yd-rush', 'Hasty assembly protocols', 'The foundry\'s droids are told to ship hulls before they are done: the Capital foundry can rush out the warship it is building once it is half done (Rush launch). It comes out damaged, with guns still in scaffolding, and needs welders to be finished. Needs a Capital foundry.', 800, 45, 3, {}),
]
export const TECH: Record<string, Tech> = Object.fromEntries(TECHS.map((t) => [t.id, t]))
export const techsFor = (unitId: string) => TECHS.filter((t) => t.for === unitId)
export const MAX_RESEARCH = 4
/** The station-level upgrade shares the research queue under this id. */
export const LEVEL_UP = 'level'

/** Station upgrades: cost and seconds to reach each level (index = the new level). */
export const UPGRADES: ({ cost: number; time: number } | null)[] = [null, null, { cost: 1100, time: 40 }, { cost: 1900, time: 55 }, { cost: 3200, time: 75 }]
export const MAX_LEVEL = 4
export const MAX_CAPITALS = 1
