// Empires At War: the factions, their ships and the numbers behind them. No DOM here, so the
// headless balance sims can load it too.
//
// Each faction's own ships, structures, station, research and yards are in its file under data/
// (republic.ts, droid.ts, swarm.ts), written in the types of data/kit.ts; this file merges them into
// the tables the rest of the game reads (UNITS, UNIT, TECHS, STATIONS, FACTIONS and the rest), and
// holds what every faction shares: the damage tables, toughness, expansions, the economy.
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

import { DROID } from './data/droid.ts'
import { ORBITAL_FRAME, reach, type AbilityId, type Ability, type BaseModule, type Berth, type FactionData, type FactionId, type FactionInfo, type Hardpoint, type Layout, type ModuleId, type OrbitalModId, type OrbitalModule, type OrbitalPlan, type StationPlan, type Tech, type Tier, type UnitType, type Weapon, type WeaponKind, type Works } from './data/kit.ts'
import { REPUBLIC } from './data/republic.ts'
import { SWARM } from './data/swarm.ts'
import { sized } from './models/sizes.ts'
import { SPEED_SCALE, mapDist } from './scale.ts'

export type {
  Ability, AbilityId, BaseModule, FactionId, FactionInfo, Hardpoint, HardpointKind, ModuleArt, ModuleId, OrbitalModId, OrbitalModule, OrbitalPlan, OrbitalStage, StationModule, StationPlan, Tech, TechEffect, Tier, UnitType, Weapon, WeaponKind, Works,
} from './data/kit.ts'
export { ORBITAL_FRAME, ORBITAL_MODS } from './data/kit.ts'

/** Every faction's data, in the order the menus list them (and their units go into UNITS). */
const KITS: FactionData[] = [REPUBLIC, DROID, SWARM]
/** Every faction, in the order the menus list them. */
export const FACTION_IDS: FactionId[] = KITS.map((k) => k.id)
const byFaction = <T>(f: (k: FactionData) => T) => Object.fromEntries(KITS.map((k) => [k.id, f(k)])) as Record<FactionId, T>
const merged = <T>(f: (k: FactionData) => Record<string, T>) => Object.assign({}, ...KITS.map(f)) as Record<string, T>

export const ABILITIES: Record<AbilityId, Ability> = {
  flakBarrage: { name: 'Flak barrage', blurb: 'Point defence fires twice as fast for 8 s.', cooldown: 40, duration: 8 },
  repairSwarm: { name: 'Damage control', blurb: 'Its repair crews restore 30% of its hull over 10 s.', cooldown: 60, duration: 10 },
  shieldBoost: { name: 'Shield boost', blurb: 'Instantly restores half the shields.', cooldown: 45, duration: 0 },
  tractor: { name: 'Tractor lock', blurb: 'Enemy ships nearby crawl at a third of their speed for 7 s.', cooldown: 45, duration: 7, range: reach(650) },
  broadside: { name: 'Full broadside', blurb: 'Turbolasers deal 60% more damage for 10 s.', cooldown: 50, duration: 10 },
  launchSwarm: { name: 'Scramble', blurb: 'Empties the hangars: two extra squadrons of its strike craft at once.', cooldown: 60, duration: 0 },
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
 * `away` of their damage; at home, under the station's cover, they take `guard` of the damage shot
 * at them (without it a pair of gunships' flak wiped a whole wing in five seconds). The station
 * rebuilds lost craft one at a time, every `every` seconds, starting `wait` seconds after the last
 * one was lost, while its hangar stands.
 */
export const DEFENSE_WING = { radius: reach(1400), away: 0.3, guard: 0.25, every: 25, wait: 15 }

/** A faction's defense wing fighter. */
export const wingOf = (faction: FactionId) => UNIT[`${FACTIONS[faction].prefix}-picket`]

/** What field repairs work on: stations, and ships of gunship class and up. Strike craft and the
 * platforms on the ore are left to their own (platforms have repair crews of their own). */
export const MENDABLE: Tier[] = ['gunship', 'frigate', 'cruiser', 'capital', 'station', 'yard']

/** How each faction looks and sounds outside its models (see FactionInfo): its name, colours,
 * emblem, voices, the letter its ids start with and its usual rival. */
export const FACTIONS: Record<FactionId, FactionInfo> = byFaction((k) => k.info)
/** An ability as faction `f` names it (FactionInfo `names`): the same ability under its own words. */
export function abilityOf(id: AbilityId, f: FactionId): Ability {
  const own = FACTIONS[f].names?.ability?.[id]
  return own ? { ...ABILITIES[id], name: own.name, blurb: own.blurb ?? ABILITIES[id].blurb } : ABILITIES[id]
}
/** The letter a faction's unit and research ids start with: r-fighter, d-st-guns, s-capital. */
export const prefixOf = (faction: FactionId) => FACTIONS[faction].prefix

// Damage against each kind of target. Fighter guns barely scratch big hulls, flak shreds small
// craft, turbolasers are too slow to track fighters, missiles go through shields (see sim).
// Yards take hits as stations do.
const VS: Record<WeaponKind, Record<Tier, number>> = {
  laser: { fighter: 1, gunship: 0.9, frigate: 0.35, cruiser: 0.25, capital: 0.2, station: 0.2, mine: 0.4, defense: 0.25, yard: 0.2, vehicle: 0.9, building: 0.2 },
  flak: { fighter: 2.2, gunship: 1.4, frigate: 0.3, cruiser: 0.2, capital: 0.15, station: 0.15, mine: 0.3, defense: 0.2, yard: 0.15, vehicle: 1.4, building: 0.15 },
  turbo: { fighter: 0.5, gunship: 0.7, frigate: 1, cruiser: 1, capital: 1, station: 1, mine: 1, defense: 1, yard: 1, vehicle: 0.7, building: 1 },
  missile: { fighter: 0.25, gunship: 0.6, frigate: 1.1, cruiser: 1, capital: 0.9, station: 0.8, mine: 1, defense: 1, yard: 0.8, vehicle: 0.6, building: 0.8 },
  // Against shields; ion barely touches a hull (see the sim's damage).
  ion: { fighter: 0.3, gunship: 0.8, frigate: 1.2, cruiser: 1.3, capital: 1.3, station: 1.2, mine: 0.5, defense: 1.2, yard: 1.2, vehicle: 0.8, building: 1.2 },
}
/** Chance a shot connects: big guns can't follow fighters. */
const ACCURACY: Record<WeaponKind, Record<Tier, number>> = {
  laser: { fighter: 0.55, gunship: 0.7, frigate: 0.95, cruiser: 1, capital: 1, station: 1, mine: 1, defense: 1, yard: 1, vehicle: 0.7, building: 1 },
  flak: { fighter: 0.75, gunship: 0.8, frigate: 0.95, cruiser: 1, capital: 1, station: 1, mine: 1, defense: 1, yard: 1, vehicle: 0.8, building: 1 },
  turbo: { fighter: 0.15, gunship: 0.35, frigate: 0.85, cruiser: 0.95, capital: 1, station: 1, mine: 1, defense: 0.95, yard: 1, vehicle: 0.35, building: 1 },
  missile: { fighter: 0.3, gunship: 0.7, frigate: 0.95, cruiser: 1, capital: 1, station: 1, mine: 1, defense: 1, yard: 1, vehicle: 0.7, building: 1 },
  ion: { fighter: 0.15, gunship: 0.45, frigate: 0.9, cruiser: 1, capital: 1, station: 1, mine: 1, defense: 1, yard: 1, vehicle: 0.45, building: 1 },
}
export const effect = (w: WeaponKind, t: Tier) => VS[w][t]
export const accuracy = (w: WeaponKind, t: Tier) => ACCURACY[w][t]

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
  ...(t.drain ? { drain: { ...t.drain, radius: reach(t.drain.radius) } } : {}),
  ...(t.fireControl ? { fireControl: { ...t.fireControl, radius: reach(t.fireControl.radius) } } : {}),
  ...(t.shieldAura ? { shieldAura: { ...t.shieldAura, radius: reach(t.shieldAura.radius) } } : {}),
})
/** Toughened and scaled: every unit goes through this once. */
const finish = (t: UnitType) => scaled(toughen(t))

// --- Platforms on the ore ---------------------------------------------------------------------------

/**
 * A mining platform's point defence, by faction: one small flak turret, enough that one squadron of
 * the other side's fighters attacking it has about an even chance; nothing a warship would notice
 * (each faction's file tunes its own).
 */
export const MINE_FLAK: Record<FactionId, Weapon> = byFaction((k) => k.mineFlak)

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
export const YARD_SOCKETS: Record<FactionId, [number, number][]> = byFaction((k) => k.yardSockets)
export const CYARD_SOCKETS: Record<FactionId, [number, number][]> = byFaction((k) => k.cyardSockets)
/** Each yard's berth, in its model's units (the box 100 long, nose up): half its width and where it
 * runs from the mouth (y0) to the stern (y1). The battle draws the ship being built in it, and a new
 * ship flies out of it through the mouth (sim.ts launchFrom). */
export const YARD_BERTHS: Record<string, Berth> = merged((k) => k.berths)
/** Where the gantry cranes (Republic) or ring frames (Confederacy) span each yard's berth, in the same
 * units: the welding beams come down from them onto the ship being built. */
export const YARD_GANTRIES: Record<string, number[]> = merged((k) => k.gantries)

/** Where the Command Station's expansions sit, on the 0-10 grid of whatever stage it has grown to
 * (so they move out with it): three of its corners, out past the core on struts. */
export const STATION_SOCKETS: [number, number][] = [[1.2, 8.8], [8.9, 1.1], [1.1, 1.1]]

// --- Expansion modules -----------------------------------------------------------------------------

// What an expansion is: BaseModule in data/kit.ts.

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

/** The research that allows a rush launch, by faction. */
export const RUSH_TECH: Record<FactionId, string> = byFaction((k) => k.rushTech)

/** The expansions a building takes. */
/** The expansions faction `f` can fit on building `on`: a Shield core only for a side whose station
 * has shields to feed (not the Swarm's). */
export const modulesFor = (on: Works, f: FactionId) => MODULES.filter((m) => m.on === on && (m.id !== 'shieldCore' || STATIONS[f].stages.some((s) => s.shield > 0)))
/** Whether faction `f` can fit expansion `id` at all (see modulesFor). */
export const moduleFits = (id: ModuleId, f: FactionId) => !!MODULE[id] && modulesFor(MODULE[id].on, f).some((m) => m.id === id)
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

// --- Stations ---------------------------------------------------------------------------------------

/** Each faction's Command Station, at every level (see StationPlan in data/kit.ts). */
export const STATIONS: Record<FactionId, StationPlan> = byFaction((k) => k.station)

/** What faction `f`'s station goes by at `level` (StationPlan stages): Hive Seed, Dominion Warbase. */
export const stageName = (f: FactionId, level: number) => {
  const st = STATIONS[f].stages
  return st[Math.max(1, Math.min(st.length, level)) - 1].name
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
    // A station that launches its own strike craft, or whose hull grows back, from a level on.
    ...(plan.carrier && lv >= plan.carrier.level ? { carrier: { unit: plan.carrier.unit, every: plan.carrier.every, max: plan.carrier.max } } : {}),
    ...(plan.regrow && lv >= plan.regrow.level ? { regrow: { rate: plan.regrow.rate, delay: plan.regrow.delay } } : {}),
  }
  const tough = finish(t)
  // (Already toughened, so they go on after.)
  if (xs.length) tough.hardpoints = [...tough.hardpoints, ...xs.map((m) => moduleHardpoint(m, STATION_SOCKETS[m.socket], m.s))]
  stationCache.set(id, tough)
  return tough
}

// --- Orbital defense stations (Galactic conquest) ---------------------------------------------------

/** Each faction's orbital defense station (see OrbitalPlan in data/kit.ts). */
export const ORBITALS: Record<FactionId, OrbitalPlan> = byFaction((k) => k.orbital)
/** Defense stations a planet can have, at most: two sites round its Command Station. */
export const ORBITAL_MAX = 2
/** The highest level a defense station grows to. */
export const ORBITAL_TOP = 3
/** Module slots a defense station has at `level` (1, 2 or 4). */
export const orbitalSlots = (level: number) => ORBITAL_FRAME.counts[Math.max(1, Math.min(ORBITAL_TOP, level)) - 1]
/** Faction `f`'s module `id` for a defense station slot. */
export const orbitalMod = (f: FactionId, id: OrbitalModId): OrbitalModule => ORBITALS[f].modules.find((m) => m.id === id)!
/** What faction `f`'s defense station is called at `level`: Bastion Watchpost, Guardian Bloom. */
export const orbitalName = (f: FactionId, level: number) => ORBITALS[f].stages[Math.max(1, Math.min(ORBITAL_TOP, level)) - 1].name
/** A defense station's look's name, for the queues and cards that know it only by that. */
export const orbitalSprite = (f: FactionId, level: number) => `${f}-orbital-${Math.max(1, Math.min(ORBITAL_TOP, level))}`
/** The hardpoint key of a module in a slot: a swapped module is a new part, with its own hull. */
export const orbitalKey = (slot: number, id: OrbitalModId) => `s${slot}:${id}`

const orbitalCache = new Map<string, UnitType>()
/**
 * A defense station as it stands: faction `f`'s at `level`, with module `slots[i]` in each of its
 * slots (null: empty). Like a grown station, every level and loadout is a type of its own under the
 * one id (`<prefix>-orbital`, not in UNITS: only Galactic conquest has them), drawn on its level's
 * box of the shared frame (ORBITAL_FRAME), so a module keeps its place as the station grows. Each
 * module is a hardpoint of its own that can be shot off: its gun stops, its shields go, its hangar
 * stops launching. `i`: which of the planet's two defense sites it stands on (for the battle's result).
 */
export function orbitalType(f: FactionId, level: number, slots: readonly (OrbitalModId | null)[], i?: number): UnitType {
  const lv = Math.max(1, Math.min(ORBITAL_TOP, level))
  const n = orbitalSlots(lv)
  const have = Array.from({ length: n }, (_, s) => slots[s] ?? null)
  const key = `${f}:${lv}:${have.map((m) => m ?? '-').join(',')}:${i ?? ''}`
  const hit = orbitalCache.get(key)
  if (hit) return hit
  const plan = ORBITALS[f]
  const st = plan.stages[lv - 1]
  const [x0, y0, x1, y1] = ORBITAL_FRAME.boxes[lv - 1]
  const w = x1 - x0
  const h = y1 - y0
  const long = Math.max(w, h)
  const mods = have.map((id) => (id ? orbitalMod(f, id) : null))
  const fitted = mods.filter((m): m is OrbitalModule => !!m)
  const hangars = fitted.filter((m) => m.carrier).length
  const pools = fitted.filter((m) => m.regrow)
  const t: UnitType = {
    id: `${prefixOf(f)}-orbital`, faction: f, tier: 'defense', name: st.name, blurb: plan.blurb, sprite: orbitalSprite(f, lv), aspect: w / h, size: long * ORBITAL_FRAME.perUnit,
    hull: Math.round(st.hull * (1 + fitted.reduce((s, m) => s + (m.hull ?? 0), 0))),
    shield: st.shield + fitted.reduce((s, m) => s + (m.shield ?? 0), 0),
    regen: plan.regen + fitted.reduce((s, m) => s + (m.regen ?? 0), 0),
    speed: 0, turn: 0, pop: 0, cost: 0, build: 0, level: 0, squad: 1, sensor: 1300, weapons: [],
    hardpoints: mods.flatMap((m, s) => {
      if (!m) return []
      const [fx, fy] = ORBITAL_FRAME.slots[s]
      return [{ kind: m.kind, art: m.art, ...(m.look ? { look: m.look } : {}), key: orbitalKey(s, m.id), hp: m.hp, ...(m.weapon ? { weapon: m.weapon } : {}), x: ((fx - x0) / w) * 10, y: ((fy - y0) / h) * 10, s: (m.r * 2) / long }]
    }),
    engines: [],
    orbital: { level: lv, slots: have, ...(i !== undefined ? { i } : {}) },
    role: {
      role: 'Orbital defense',
      strong: [...(fitted.some((m) => m.id === 'battery' || m.id === 'launcher') ? ['frigates', 'cruisers', 'flagships'] : []), ...(fitted.some((m) => m.id === 'flak' || m.carrier) ? ['fighters', 'bombers'] : [])],
      weak: [...(fitted.some((m) => m.id === 'flak' || m.carrier) ? [] : ['bombers']), ...(fitted.some((m) => m.id === 'battery' || m.id === 'launcher') ? [] : ['warships']), 'a big fleet on its own'],
    },
    ...(hangars ? { carrier: { unit: fitted.find((m) => m.carrier)!.carrier!, every: 30, max: hangars } } : {}),
    ...(plan.regrow ? { regrow: { rate: plan.regrow.rate * (1 + pools.reduce((s, m) => s + (m.regrow ?? 0), 0)), delay: plan.regrow.delay } } : {}),
  }
  const out = finish(t)
  orbitalCache.set(key, out)
  return out
}
/** Whether a unit type is an orbital defense station. */
export const isOrbital = (t: UnitType) => !!t.orbital
/** The level a defense station slot comes with (slot 0 at level 1, slot 1 at 2, slots 2 and 3 at 3). */
export const orbitalSlotLevel = (slot: number) => ORBITAL_FRAME.counts.findIndex((n) => n > slot) + 1

/**
 * The module the AI fits next into a defense station with `mods` in its slots (Galactic conquest's
 * galaxy AI and the skirmish admirals both): flak against a fleet of strike craft and gunships
 * (`small` against `big`, what the enemy flies), batteries against warships, a launcher against
 * shielded hulls once it has a battery, then a shield generator (the Swarm's regeneration pool) and,
 * on the fourth slot, a hangar.
 */
export function orbitalPick(mods: readonly (OrbitalModId | null)[], small: number, big: number, shielded: boolean): OrbitalModId {
  const n = (id: OrbitalModId) => mods.filter((m) => m === id).length
  const fitted = mods.filter(Boolean).length
  if (fitted === 0) return small > big * 1.3 ? 'flak' : 'battery'
  if (fitted === 3) return 'hangar'
  if (small > big * 1.3 && n('flak') < 2) return 'flak'
  if (!n('flak')) return 'flak'
  if (big >= small && n('battery') + n('launcher') < 2) return shielded && n('battery') ? 'launcher' : 'battery'
  return n('shield') ? 'battery' : 'shield'
}

// --- Defense stations in a skirmish ----------------------------------------------------------------

/**
 * A Galactic conquest build takes this many times its skirmish time on the galaxy clock (ships, yards,
 * expansions), so a defense station's galaxy times (OrbitalPlan) divided by it are its skirmish times.
 */
export const SHIP_TIME = 1.5
/**
 * Defense stations in a skirmish (and a multiplayer battle): the same stations, levels, modules,
 * prices and art as Galactic conquest's, put up by engineers within the build radius like a yard.
 * How many a player may have at a time is the lobby's (DEFENSE_STEPS, 0 for off; DEFENSE_DEFAULT
 * when a lobby or match has none).
 */
export const DEFENSE_STEPS = [0, 1, 2, 3, 4, 6]
export const DEFENSE_DEFAULT = 2
/** Upgrades and modules waiting or under way at one defense station, at most. */
export const DEFENSE_QUEUE = 3
/** The lobby's defense station limit as received (old setups have none, a tampered client anything):
 * one of DEFENSE_STEPS, DEFENSE_DEFAULT when missing or not one of them. */
export const cleanDefense = (v: unknown): number => (typeof v === 'number' && DEFENSE_STEPS.includes(v) ? v : DEFENSE_DEFAULT)
/** The id faction `f`'s defense station goes by (`r-orbital`): not in UNIT, see defenseType. */
export const defenseId = (f: FactionId) => `${prefixOf(f)}-orbital`
/** The faction whose defense station id this is, or null for any other id. */
export const defenseFaction = (id: string): FactionId | null => FACTION_IDS.find((f) => defenseId(f) === id) ?? null
/** Seconds (on the skirmish clock) the work on faction `f`'s defense station takes: building it
 * (`level` 1, one engineer squadron's work), an upgrade to `level` 2 or 3, or fitting a module. */
export const defenseTime = (f: FactionId, level: number) => Math.round(ORBITALS[f].stages[Math.max(1, Math.min(ORBITAL_TOP, level)) - 1].time / SHIP_TIME)
export const defenseModTime = (f: FactionId, id: OrbitalModId) => Math.round(orbitalMod(f, id).time / SHIP_TIME)
/** What a defense station as it stands cost: its levels and the modules in its slots. */
export const defenseValue = (f: FactionId, level: number, slots: readonly (OrbitalModId | null)[]) =>
  ORBITALS[f].stages.slice(0, Math.max(1, Math.min(ORBITAL_TOP, level))).reduce((s, x) => s + x.cost, 0) + slots.reduce((s, m) => s + (m ? orbitalMod(f, m).cost : 0), 0)

const defenseCache = new Map<string, UnitType>()
/**
 * A defense station in a skirmish: orbitalType's, with a price (what it stands for: its levels and
 * modules, for its repairs and the experience for destroying it) and a build time (the first
 * level's, on the skirmish clock: what engineers weld it up in). Galactic conquest keeps its own.
 */
export function defenseType(f: FactionId, level: number, slots: readonly (OrbitalModId | null)[]): UnitType {
  const t = orbitalType(f, level, slots)
  const hit = defenseCache.get(`${t.orbital!.level}:${t.orbital!.slots.join(',')}:${f}`)
  if (hit) return hit
  const out: UnitType = { ...t, cost: defenseValue(f, t.orbital!.level, t.orbital!.slots), build: defenseTime(f, 1), level: ORBITALS[f].stages[0].station }
  defenseCache.set(`${t.orbital!.level}:${t.orbital!.slots.join(',')}:${f}`, out)
  return out
}
/** What engineers can put up round the Command Station, by id: a yard, or a defense station (as it
 * goes up: level 1, its slot empty). */
export function placeType(id: string): UnitType | undefined {
  if (Object.hasOwn(UNIT, id)) return UNIT[id]
  const f = defenseFaction(id)
  return f ? defenseType(f, 1, []) : undefined
}

/** Every unit as written, before TOUGHNESS: each faction's ships, its station, then its structures. */
const WRITTEN: UnitType[] = KITS.flatMap((k) => [...k.ships, stationType(k.id, 1, []), ...k.structures])
/** Where each warship carries its hardpoints at its size, by unit id (see Layout in data/kit.ts). */
export const BIG_LAYOUT: Record<string, Layout> = merged((k) => k.layout)
/** Every unit, toughened and scaled (stations come out of stationType that way already), at its
 * size (models/sizes.ts). */
export const UNITS: UnitType[] = [
  ...WRITTEN.map((u) => (u.tier === 'station' ? u : sized(finish(u), BIG_LAYOUT[u.id]))),
  // Ground battles' units and buildings, after every space unit, as written (no space toughness or sizes).
  ...KITS.flatMap((k) => k.ground),
]

const SHIELDED_MINE: Record<FactionId, UnitType> = byFaction((k) => finish(k.shieldedMine))
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
export const unitOf = (faction: FactionId, tier: Tier) => UNIT[`${prefixOf(faction)}-${tier}`]
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
export const yardOf = (faction: FactionId, kind: 'yard' | 'cyard' = 'yard') => UNIT[`${prefixOf(faction)}-${kind}`]
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
/** A unit that moves and takes orders: every ship, and in ground battles every vehicle (isGround
 * tells those apart). Stations, platforms, yards and ground buildings are not. */
export const isShip = (t: UnitType) => t.tier !== 'station' && t.tier !== 'mine' && t.tier !== 'defense' && t.tier !== 'yard' && t.tier !== 'building'
/** A ground battle's unit or building (UnitType `ground`): code for ships in space skips these. */
export const isGround = (t: UnitType) => t.ground !== undefined
/** A ground battle's building (a Command Center). */
export const isGroundBuilding = (t: UnitType) => t.tier === 'building'
/** What can go on a surveyed ore asteroid, one structure each: the mining platform, then the
 * defense platforms (balanced first), unless `guns` is false (the lobby turned them off: see the
 * World's `oreDefense`). */
export const siteOptions = (faction: FactionId, guns = true) => UNITS.filter((u) => u.faction === faction && (u.tier === 'mine' || (guns && u.tier === 'defense')))

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
/** A mining platform upgrade as faction `f` has it (FactionInfo names `site`): its own name and words. */
export function siteUpgradeOf(id: SiteUpgradeId, f: FactionId): SiteUpgrade {
  const up = SITE_UPGRADES.find((x) => x.id === id)!
  const own = FACTIONS[f].names?.site?.[id]
  return own ? { ...up, ...own } : up
}
/** Output per Deeper drills level, and hull and module health from Armour plating. */
export const YIELD_PER_LEVEL = 0.3
export const ARMOR_BONUS = 0.5
export const BEACON_INCOME = 1.5
export const BASE_POP = 30
export const POP_PER_LEVEL = 4
export const BEACON_POP = 6
/** How far a captured beacon sees for the team holding it (a frigate's sensors, about): it lights
 * up its part of the map in the fog, on the minimap and for the AI. A neutral or contested beacon
 * sees nothing; a lost one stops seeing for the old holder at once. */
export const BEACON_SENSOR = reach(900)
export const MAX_QUEUE = 6

// --- Research ---------------------------------------------------------------------------------------

/** Every faction's research, one faction after the other (see each faction's file). */
export const TECHS: Tech[] = KITS.flatMap((k) => k.techs)

export const TECH: Record<string, Tech> = Object.fromEntries(TECHS.map((t) => [t.id, t]))
export const techsFor = (unitId: string) => TECHS.filter((t) => t.for === unitId)
export const MAX_RESEARCH = 4
/** The station-level upgrade shares the research queue under this id. */
export const LEVEL_UP = 'level'

/** Station upgrades: cost and seconds to reach each level (index = the new level). */
export const UPGRADES: ({ cost: number; time: number } | null)[] = [null, null, { cost: 1100, time: 40 }, { cost: 1900, time: 55 }, { cost: 3200, time: 75 }]
export const MAX_LEVEL = 4
export const MAX_CAPITALS = 1
