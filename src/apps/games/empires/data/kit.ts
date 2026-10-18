// What every faction's data is written in: the types of a unit, its guns, hardpoints, research and
// station, the shared helpers that make them, and the shape of one faction's file (FactionData).
// Shared by data/republic.ts, data/droid.ts and data/swarm.ts, and merged by data.ts, which is what
// the rest of the game reads. No DOM here, so the headless balance sims and the server load it too.
//
// Each faction's file is its own: its ships, structures, station, research, yards and colours. This
// file and data.ts are shared by all three; change them only for something every faction needs.

import { RANGE_SCALE } from '../scale.ts'

/** A gun's or a sensor's reach, as written, at the battlefield's range scale (see scale.ts). */
export const reach = (r: number) => Math.round(r * RANGE_SCALE)

export type FactionId = 'republic' | 'droid' | 'swarm'
export type Tier = 'fighter' | 'gunship' | 'frigate' | 'cruiser' | 'capital' | 'station' | 'mine' | 'defense' | 'yard'
  /** Ground battles (see UnitType `ground`): units that drive on the tile grid, and buildings that
   * stand on it. The space game's tier checks never match them. */
  | 'vehicle' | 'building'
export type WeaponKind = 'laser' | 'flak' | 'turbo' | 'missile' | 'ion'
export type HardpointKind = 'turret' | 'shield' | 'engine' | 'hangar' | 'refinery' | 'dock' | 'sensor' | 'drill'
/** The mount a module is drawn with (models/mounts.ts). */
export type ModuleArt = 'turbo' | 'flak' | 'ion' | 'shield' | 'hangar' | 'refinery' | 'dock' | 'sensor' | 'drill'
/**
 * Extra mount designs a faction may draw (models/<faction>/mounts.ts `extras`), picked per hardpoint
 * with Hardpoint `look` (or per mount by its model's ModelSpec `mount`). A faction that draws no such
 * design gets the closest common one instead (models/mounts.ts FALLBACK), so data can name them
 * before every faction has one. Only the looks: what the hardpoint does is still its kind and weapon.
 */
export type MountExtra =
  | 'torpedo' | 'pd' | 'triple' | 'missileBox' | 'strike' | 'railgun' | 'beam' | 'quad'
  | 'spore' | 'acid' | 'lance' | 'bioturret' | 'parasite' | 'regen' | 'engineSac' | 'broodSac' | 'spine' | 'projector'
export type AbilityId = 'flakBarrage' | 'repairSwarm' | 'shieldBoost' | 'tractor' | 'broadside' | 'launchSwarm' | 'fieldRepair' | 'spreadOut'

export type Weapon = {
  kind: WeaponKind
  damage: number
  range: number
  /** Seconds between shots. */
  cooldown: number
  /** Bolts per shot, fired a few frames apart. */
  burst?: number
  /** Fighters and gunships only fire inside this half-angle of their nose (radians); turrets turn
   * freely. A gun on a hardpoint with an arc is fixed to the hull the same way (see `spinal`). */
  arc?: number
  /** A spinal weapon: a gun built along the hull's keel that only fires inside its `arc` off the
   * nose, so the whole ship turns to aim it (the AI and the sim's closing in already do: see sim.ts
   * bearing). Its mount doesn't turn on the model. Made with `spinal()`. */
  spinal?: true
  /** Ground battles' weapons (groundWeapon): which of the seven it is. Its `kind` is then the space
   * weapon it sounds and sparks like; the ground's own table (GROUND_VS) sets what it does. */
  ground?: GroundWeaponKind
  /** Ground: the radius its shells or rockets hurt everything in where they land (artillery, swarm
   * rockets), in world units. */
  splash?: number
  /** Ground: the nearest it can fire (artillery), in world units. */
  min?: number
}

/**
 * A part of a ship that can be shot off. `art` is the mount drawn on it and `s` its size as a share
 * of the ship's longest side; engines have no mount of their own. `key` names a station
 * module, so it keeps its damage while the station grows around it.
 */
export type Hardpoint = {
  kind: HardpointKind; x: number; y: number; hp: number; weapon?: Weapon; art?: ModuleArt; s?: number; key?: string
  /** The mount drawn on it when it is not its `art`'s (see MountExtra): a torpedo launcher rather
   * than a turbolaser turret, a spore launcher, an engine sac. Its icon and what it does still
   * follow `kind` and `art`. */
  look?: MountExtra
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
  /** Carriers launch fighter squadrons from their hangars on their own: a squadron of `unit` every
   * `every` seconds while fewer than `max` of its squadrons are out. A station's (see StationPlan
   * `carrier`) only from the station level it names. */
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

  // --- Faction mechanics (sim.ts): each is off unless a unit sets it. -------------------------------

  /** Living hulls: out of combat (`delay` seconds since an enemy, or an asteroid field's rocks, last
   * hit it) the hull grows back,
   * `rate` of its full hull a second, up to what it can have (a rush-launched ship's unbuilt hull
   * stays unbuilt). Module damage isn't mended by it. */
  regrow?: { rate: number; delay: number }
  /** A drain aura: the `targets` nearest enemies within `radius` (as written, stretched like gun
   * ranges) lose `dps` hull points a second each, straight off the hull past any shields, and `heal`
   * of what is drained mends our ships within `radius`, shared out evenly among the damaged ones
   * (itself included). */
  drain?: { radius: number; dps: number; heal: number; targets: number }
  /** A fire-control aura: our ships within `radius` (as written, stretched like gun ranges), itself
   * included, deal `bonus` more damage (0.15: 15%). Auras don't stack: a ship near several gets the
   * best one. */
  fireControl?: { radius: number; bonus: number }
  /** A shield-projector aura: our ships within `radius` (as written, stretched like gun ranges),
   * itself included, recharge their shields `regen` faster (1: twice as fast), on top of everything
   * else that speeds them. Auras don't stack: a ship near several gets the best one. A ship with
   * shield generators projects only while one of them stands. Ships without shields gain nothing. */
  shieldAura?: { radius: number; regen: number }
  /** An orbital defense station (Galactic conquest, see OrbitalPlan): its level, what each of its
   * slots holds (null: empty), and which of its planet's two defense sites it stands on. */
  orbital?: { level: number; slots: (OrbitalModId | null)[]; i?: number }
  /** A ground battle's unit or building (ground/world.ts): how it stands and moves on the tile
   * grid. Only units with it are in ground battles, and space battles never have them. */
  ground?: GroundSpec
}

/**
 * How a ground unit or building lives on the ground battle's tile grid (32-unit tiles). A vehicle
 * drives (turns towards its next waypoint, then goes) on paths for its size class; a building
 * stamps its footprint on the grid, faces south (its door the middle of its south side) and never
 * turns.
 */
export type GroundSpec = {
  /** Path finding size class: the square of tiles it needs (1 small, 2 vehicle, 3 large). */
  size: 1 | 2 | 3
  /** Body radius in world units: how close other ground units come. */
  radius: number
  /** Acceleration and braking, world units a second squared. */
  accel: number
  /** Sight radius in tiles. */
  sight: number
  /** Buildings: footprint in tiles, columns × rows. */
  foot?: [number, number]
  /** Buildings: credits a second it earns once built (none do on the ground: kyber is gathered). */
  income?: number
  /** Buildings: how many units it supports once built (the side's unit cap is the sum). */
  supply?: number
  /** Buildings: engineers drop off the kyber they gather here (a Command Center). */
  dropOff?: boolean
  /** Buildings: power it makes once built (ground/power.ts), for as long as it can pay its `burn`. */
  power?: number
  /** Buildings: kyber a second it burns to make its power (a generator); with none left it stops. */
  burn?: number
  /** Buildings: power it draws while busy (ground/power.ts busy: training or upgrading, or for a
   * research station, all the time). Construction sites draw SITE_DRAW besides, while being built. */
  draw?: number
  /** Buildings: research points a second it makes while powered (a research station). */
  research?: number
  /** Buildings: what it trains, in card order. Ids the game doesn't know (a unit not added yet) are
   * left out of its cards and can't be ordered. */
  trains?: string[]
  /** Factories: whether it trains foot units (squads) or vehicles; the AI picks its factories by it. */
  factory?: 'foot' | 'vehicle'
  /**
   * Tiers. For a building that trains: the tier it stands at once built (1 when left out; upgrades
   * raise it later). For a unit: the tier its trainer must have reached to train it (1 when left
   * out). Tier 1 units are small and simple, tier 2 medium, tier 3 the big ones.
   */
  tier?: number
  /** Factories: what upgrading to each next tier costs (index 0: to tier 2, 1: to tier 3), in
   * research points and kyber, the seconds it takes and the power it draws while it runs
   * (ground/jobs.ts). */
  tierUp?: { rp: number; cost: number; time: number; draw: number }[]
  /** Engineers: the buildings it puts up, in card order. */
  builds?: string[]
  /** Armour class (ground/combat.ts, GROUND_VS): vehicles light unless they say, buildings structure. */
  armour?: Armour
  /** The ground unit whose model it is drawn with, when not its own (the dev weapon test's units). */
  look?: string
  /**
   * A squad (troopers, battle droids, a pack of bugs): one unit of `n` members in a loose formation
   * `spacing` world units apart, each drawn as model `member` (models/<faction>/ground.ts), `size`
   * world units long, walking. The hull is the squad's: members fall one by one as it drops, and
   * each member left fires the unit's weapons (ground/squad.ts).
   */
  squad?: { n: number; member: string; size: number; spacing: number }
}

export type Ability = { name: string; blurb: string; cooldown: number; duration: number; range?: number }

// --- Ground weapons ---------------------------------------------------------------------------------

/** The seven ground weapons (ground battles only; ground/combat.ts fires them):
 * - pulse: fast bolts, accurate, the all-rounder, good against light armour;
 * - beam: a continuous beam that burns harder the longer it holds one target, short range;
 * - rocket: slow to reload, homing, good against heavy armour and buildings;
 * - shell: a heavy shell, slow, misses fast light units, good against heavy armour;
 * - artillery: a lobbed shell from long range, a minimum range, splash; fires at what allies see;
 * - swarm: a salvo of small rockets with splash, good against light units in groups;
 * - spray: a short cone (flame, gas, acid) that keeps burning, good against light units. */
export type GroundWeaponKind = 'pulse' | 'beam' | 'rocket' | 'shell' | 'artillery' | 'swarm' | 'spray'
export const GROUND_WEAPONS: GroundWeaponKind[] = ['pulse', 'beam', 'rocket', 'shell', 'artillery', 'swarm', 'spray']
/** Ground armour classes: what a ground unit or building is (GroundSpec `armour`). */
export type Armour = 'light' | 'medium' | 'heavy' | 'structure'
export const ARMOURS: Armour[] = ['light', 'medium', 'heavy', 'structure']

/** Damage of each ground weapon against each armour class, as a share of its damage (the ground's
 * own table, beside space's VS: space units never meet these). */
export const GROUND_VS: Record<GroundWeaponKind, Record<Armour, number>> = {
  pulse: { light: 1, medium: 0.7, heavy: 0.35, structure: 0.25 },
  beam: { light: 0.6, medium: 1.1, heavy: 1.3, structure: 0.6 },
  rocket: { light: 0.5, medium: 1, heavy: 1.4, structure: 1.3 },
  shell: { light: 0.6, medium: 1, heavy: 1.4, structure: 0.9 },
  artillery: { light: 0.8, medium: 0.9, heavy: 0.7, structure: 1.5 },
  swarm: { light: 1.3, medium: 0.8, heavy: 0.4, structure: 0.35 },
  spray: { light: 1.4, medium: 0.9, heavy: 0.5, structure: 0.3 },
}
/** Chance a ground weapon's shot connects with each armour class (lighter is faster and harder to
 * hit). A beam and a spray don't miss; artillery and swarm rockets land where they were aimed, give
 * or take a scatter, and hurt what is there. */
export const GROUND_ACC: Record<GroundWeaponKind, Record<Armour, number>> = {
  pulse: { light: 0.9, medium: 0.95, heavy: 1, structure: 1 },
  beam: { light: 1, medium: 1, heavy: 1, structure: 1 },
  rocket: { light: 0.55, medium: 0.85, heavy: 0.95, structure: 1 },
  shell: { light: 0.4, medium: 0.75, heavy: 0.9, structure: 1 },
  artillery: { light: 1, medium: 1, heavy: 1, structure: 1 },
  swarm: { light: 0.85, medium: 0.9, heavy: 0.95, structure: 1 },
  spray: { light: 1, medium: 1, heavy: 1, structure: 1 },
}
/** The space weapon each ground weapon sounds and sparks like. */
const GROUND_LOOK: Record<GroundWeaponKind, WeaponKind> = { pulse: 'laser', beam: 'laser', rocket: 'missile', shell: 'turbo', artillery: 'turbo', swarm: 'missile', spray: 'flak' }
/** Each ground weapon's usual reach and reload, in world units (32 a tile) and seconds. A beam's and
 * a spray's damage is a second's worth, dealt while they hold. */
const GROUND_BASE: Record<GroundWeaponKind, { range: number; cooldown: number; splash?: number; min?: number; burst?: number }> = {
  pulse: { range: 192, cooldown: 0.6 },
  beam: { range: 128, cooldown: 0 },
  rocket: { range: 256, cooldown: 2.6 },
  shell: { range: 256, cooldown: 2.8 },
  artillery: { range: 640, cooldown: 4.5, splash: 64, min: 192 },
  swarm: { range: 256, cooldown: 4, splash: 36, burst: 6 },
  spray: { range: 96, cooldown: 0 },
}
/** A ground weapon of kind `g` doing `damage` (a shot's, or a beam's and a spray's a second), with
 * its kind's usual reach and reload unless `o` says otherwise; `arc` (radians either side of the nose)
 * makes it fixed, so the unit turns to aim it. */
export const groundWeapon = (g: GroundWeaponKind, damage: number, o: Partial<Pick<Weapon, 'range' | 'cooldown' | 'arc' | 'splash' | 'min' | 'burst'>> = {}): Weapon =>
  ({ kind: GROUND_LOOK[g], damage, ground: g, ...GROUND_BASE[g], ...o })

// --- Guns -------------------------------------------------------------------------------------------

export const laser = (damage: number, range = 240, cooldown = 0.5): Weapon => ({ kind: 'laser', damage, range: reach(range), cooldown, arc: 0.35 })
export const flak = (damage: number, range = 320, cooldown = 0.35, burst = 1): Weapon => ({ kind: 'flak', damage, range: reach(range), cooldown, burst })
export const turbo = (damage: number, range = 650, cooldown = 2.2, burst = 2): Weapon => ({ kind: 'turbo', damage, range: reach(range), cooldown, burst })
export const missile = (damage: number, range = 420, cooldown = 4): Weapon => ({ kind: 'missile', damage, range: reach(range), cooldown, burst: 2, arc: 0.6 })
/** Fighters' proton torpedoes: slow to reload, useless against other fighters, deadly to big hulls. */
export const torpedo = (damage: number, range = 280, cooldown = 7): Weapon => ({ kind: 'missile', damage, range: reach(range), cooldown, burst: 2, arc: 0.4 })

/** An ion cannon: a slow, heavy bolt that tears down shields and does next to nothing to a hull. */
export const ion = (damage: number, range = 620, cooldown = 2.4): Weapon => ({ kind: 'ion', damage, range: reach(range), cooldown, burst: 1 })

/** A gun made spinal: fixed along the keel, firing only within `degrees` either side of the nose
 * (the half-angle), so the ship turns to aim it. Any weapon kind; on a hardpoint, as any gun. */
export const spinal = (w: Weapon, degrees: number): Weapon => ({ ...w, arc: (degrees * Math.PI) / 180, spinal: true })

export const P = (kind: HardpointKind, x: number, y: number, hp: number, weapon?: Weapon): Hardpoint => ({ kind, x, y, hp, weapon })
/** A module with a mount of its own, `s` as a share of the ship's longest side. */
export const M = (kind: HardpointKind, art: ModuleArt, x: number, y: number, s: number, hp: number, weapon?: Weapon): Hardpoint => ({ kind, art, x, y, s, hp, weapon })
export const gun = (art: 'turbo' | 'flak' | 'ion', x: number, y: number, s: number, hp: number, weapon: Weapon) => M('turret', art, x, y, s, hp, weapon)

// --- Ground units -----------------------------------------------------------------------------------

/** Ground battle units by role, each faction's written with these (see GroundSpec). Prices are in
 * kyber, which engineers gather from crystal fields (a ground battle's credits), in the space game's
 * ballpark: an engineer squadron there costs 300 for three craft (one vehicle here, 150 or so); a
 * yard costs 900 and a Command Center, a whole new base, 1,200. */
type GroundWritten = Pick<UnitType, 'id' | 'faction' | 'name' | 'blurb' | 'hull' | 'cost' | 'build'> & { sprite: string; pop?: number; ground: Partial<GroundSpec>; speed?: number; turn?: number; aspect?: number; hardpoints?: Hardpoint[] }

/** An engineer: a small unarmed vehicle (size class 1) that gathers kyber, puts up buildings and
 * repairs them. */
export const groundEngineer = (o: GroundWritten & { speed: number; turn: number }): UnitType => ({
  tier: 'vehicle', kind: 'engineer', aspect: 0.8, size: Math.round((o.ground.radius ?? 11) * 2.6), shield: 0, regen: 0, pop: 1, level: 1, squad: 1,
  sensor: (o.ground.sight ?? 8) * 32, weapons: [], hardpoints: [], engines: [],
  role: { role: 'Construction', strong: ['gathering kyber', 'building', 'repairing buildings'], weak: ['anything that shoots'] },
  ...o,
  ground: { size: 1, radius: 11, accel: 220, sight: 8, ...o.ground },
})

/** A Command Center: a 6 × 6 base building that trains engineers, takes in the kyber they gather and
 * supports a few units; it may go up anywhere, to start a new base. */
export const groundCenter = (o: GroundWritten): UnitType => ({
  tier: 'building', aspect: 1, size: 6 * 32, shield: 0, regen: 0, speed: 0, turn: 0, pop: 0, level: 1, squad: 1, sensor: 10 * 32,
  weapons: [], hardpoints: [], engines: [],
  role: { role: 'Base', strong: ['training engineers', 'taking in kyber'], weak: ['being left unguarded'] },
  ...o,
  ground: { size: 3, radius: 96, accel: 0, sight: 10, foot: [6, 6], supply: 5, dropOff: true, power: 6, draw: 2, ...o.ground },
})

/** A power generator: a 2 × 2 plant that makes power for the side's base (ground/power.ts), burning
 * a trickle of kyber to run; with no kyber left it stops. */
export const groundGenerator = (o: GroundWritten): UnitType => ({
  tier: 'building', aspect: 1, size: 2 * 32, shield: 0, regen: 0, speed: 0, turn: 0, pop: 0, level: 1, squad: 1, sensor: 4 * 32,
  weapons: [], hardpoints: [], engines: [],
  role: { role: 'Power', strong: ['powering the base'], weak: ['being left unguarded', 'running out of kyber'] },
  ...o,
  ground: { size: 2, radius: 32, accel: 0, sight: 4, foot: [2, 2], power: 10, burn: 0.25, ...o.ground },
})

/** A research station: a 3 × 3 building that trains nothing but makes research points while it has
 * power (ground/power.ts); more stations make them faster. */
export const groundResearch = (o: GroundWritten): UnitType => ({
  tier: 'building', aspect: 1, size: 3 * 32, shield: 0, regen: 0, speed: 0, turn: 0, pop: 0, level: 1, squad: 1, sensor: 5 * 32,
  weapons: [], hardpoints: [], engines: [],
  role: { role: 'Research', strong: ['research points'], weak: ['being left unguarded', 'a power cut'] },
  ...o,
  ground: { size: 3, radius: 48, accel: 0, sight: 5, foot: [3, 3], draw: 4, research: 0.5, ...o.ground },
})

/** A factory: a building that trains a faction's fighting units, foot units (squads) at a 4 × 4 one
 * and vehicles at a 5 × 5 one, out of a wide door in its south side. It draws power while it trains
 * (ground/power.ts) and stands at tier 1 once built. */
export const groundFactory = (o: GroundWritten & { makes: 'foot' | 'vehicle' }): UnitType => {
  const { makes, ...rest } = o
  const n = makes === 'foot' ? 4 : 5
  return {
    tier: 'building', aspect: 1, size: n * 32, shield: 0, regen: 0, speed: 0, turn: 0, pop: 0, level: 1, squad: 1, sensor: (n + 2) * 32,
    weapons: [], hardpoints: [], engines: [],
    role: makes === 'foot'
      ? { role: 'Infantry', strong: ['training foot squads'], weak: ['being left unguarded', 'a power cut'] }
      : { role: 'Vehicles', strong: ['training vehicles'], weak: ['being left unguarded', 'a power cut'] },
    ...rest,
    ground: {
      size: 3, radius: n * 16, accel: 0, sight: n + 2, foot: [n, n], factory: makes, tier: 1, draw: makes === 'foot' ? 3 : 5,
      tierUp: makes === 'foot'
        ? [{ rp: 100, cost: 250, time: 35, draw: 4 }, { rp: 250, cost: 500, time: 50, draw: 6 }]
        : [{ rp: 150, cost: 350, time: 45, draw: 4 }, { rp: 350, cost: 700, time: 60, draw: 6 }],
      ...rest.ground,
    },
  }
}

/** A supply building: a 3 × 3 store that raises the side's unit cap, as an Age of Empires house does. */
export const groundSupply = (o: GroundWritten): UnitType => ({
  tier: 'building', aspect: 1, size: 3 * 32, shield: 0, regen: 0, speed: 0, turn: 0, pop: 0, level: 1, squad: 1, sensor: 5 * 32,
  weapons: [], hardpoints: [], engines: [],
  role: { role: 'Supply', strong: ['raising the unit cap'], weak: ['being left unguarded'] },
  ...o,
  ground: { size: 3, radius: 48, accel: 0, sight: 5, foot: [3, 3], supply: 10, ...o.ground },
})

/** A Scout: tier 1, small and simple, fast and lightly armoured with long sight, a light weapon fixed
 * along its nose, cheap. Trained at the Command Center. */
export const groundScout = (o: GroundWritten & { speed: number; turn: number; weapons: Weapon[] }): UnitType => ({
  tier: 'vehicle', aspect: 0.75, size: Math.round((o.ground.radius ?? 11) * 2.6), shield: 0, regen: 0, pop: 1, level: 1, squad: 1,
  sensor: (o.ground.sight ?? 12) * 32, hardpoints: [], engines: [],
  role: { role: 'Scout', strong: ['scouting', 'engineers', 'light units'], weak: ['heavy armour', 'buildings'] },
  ...o,
  ground: { size: 1, radius: 11, accel: 320, sight: 12, armour: 'light', ...o.ground },
})

/** A tier 1 vehicle, the fast unit of a vehicle factory: small and simple, light armour, quick,
 * a light weapon or two (on a turret, or fixed along its nose); cheap. */
export const groundFast = (o: GroundWritten & { speed: number; turn: number; weapons: Weapon[]; role: UnitType['role'] }): UnitType => ({
  tier: 'vehicle', aspect: 0.75, size: Math.round((o.ground.radius ?? 13) * 2.6), shield: 0, regen: 0, pop: 1, level: 1, squad: 1,
  sensor: (o.ground.sight ?? 9) * 32, hardpoints: [], engines: [],
  ...o,
  ground: { size: 1, radius: 13, accel: 260, sight: 9, armour: 'light', tier: 1, ...o.ground },
})

/** A tier 3 unit, the heavy unit of a factory (Menno: "tier 3 is the big boys"): a big hull on size
 * class 2 or 3, heavy armour, slow, a heavy main gun or several turrets that turn on their own; about
 * four times a tier 1 unit's price, build time and pop. */
export const groundHeavy = (o: GroundWritten & { speed: number; turn: number; weapons: Weapon[]; role: UnitType['role'] }): UnitType => ({
  tier: 'vehicle', aspect: 0.8, size: Math.round((o.ground.radius ?? 32) * 2.6), shield: 0, regen: 0, pop: 4, level: 1, squad: 1,
  sensor: (o.ground.sight ?? 10) * 32, hardpoints: [], engines: [],
  ...o,
  ground: { size: 2, radius: 32, accel: 110, sight: 10, armour: 'heavy', tier: 3, ...o.ground },
})

/**
 * Spread out (a squad's ability, a toggle; ground/squad.ts and ground/combat.ts): its members walk
 * out to `spacing` times their usual spacing; incoming hits miss it by weapon (`evade`: the chance a
 * shot or splash misses it, or for a beam or spray the share of its damage it escapes, burns too),
 * most against splash and sprays; while spread it moves at `speed` of its pace and its members reload
 * `reload` times slower.
 */
export const SPREAD = {
  spacing: 2.6,
  speed: 0.7,
  reload: 1.2,
  evade: { pulse: 0.1, beam: 0.1, rocket: 0.1, shell: 0.1, artillery: 0.4, swarm: 0.4, spray: 0.3 } as Record<GroundWeaponKind, number>,
}

/** A tier 1 squad, the fast unit of a foot factory: a few members on foot (GroundSpec `squad`),
 * one unit with one hull, light armour, each member firing the squad's weapons; cheap. Drawn as its
 * members (the member's model). */
export const groundSquad = (o: GroundWritten & { speed: number; turn: number; weapons: Weapon[]; role: UnitType['role']; squad: NonNullable<GroundSpec['squad']> }): UnitType => {
  const { squad, ...rest } = o
  return {
    tier: 'vehicle', aspect: 1, size: 36, shield: 0, regen: 0, pop: 1, level: 1, squad: 1, ability: 'spreadOut',
    sensor: (o.ground.sight ?? 8) * 32, hardpoints: [], engines: [],
    ...rest,
    ground: { size: 1, radius: 14, accel: 200, sight: 8, armour: 'light', tier: 1, look: squad.member, squad, ...o.ground },
  }
}

/** A tier 2 unit, the anti-swarm unit of a factory: medium size and armour, more parts, usually a
 * turret that turns on its own, weapons that hurt groups (splash, salvos, sprays); about twice a
 * tier 1 unit's cost, time and pop. (A tier 2 squad is a groundSquad with `tier: 2`: squads stay
 * light.) */
export const groundMedium = (o: GroundWritten & { speed: number; turn: number; weapons: Weapon[]; role: UnitType['role'] }): UnitType => ({
  tier: 'vehicle', aspect: 0.8, size: Math.round((o.ground.radius ?? 19) * 2.5), shield: 0, regen: 0, pop: 2, level: 1, squad: 1,
  sensor: (o.ground.sight ?? 9) * 32, hardpoints: [], engines: [],
  ...o,
  ground: { size: 2, radius: 19, accel: 180, sight: 9, armour: 'medium', tier: 2, ...o.ground },
})

// --- Stations ---------------------------------------------------------------------------------------

/**
 * A station grows with its level: a small core at level 1, a hub at 2, arms at 3 and the full
 * structure at 4, each stage its own look (<faction>-station-<level>). All four share one frame,
 * as the pictures they were first drawn from did: `box` is where a stage sits in it, and its model
 * and modules are placed in its pixels. A module appears at its `level`, or once its `tech` is
 * researched, and keeps its place (and damage) as the station grows around it.
 */
export type StationModule = { key: string; kind: HardpointKind; art: ModuleArt; x: number; y: number; s: number; hp: number; weapon?: Weapon; level?: number; tech?: string }
export type StationPlan = {
  id: string
  name: string
  blurb: string
  /** World units per frame pixel. */
  perPx: number
  regen: number
  /** One per level: `name` is what the station goes by at that level (the HUD and the Codex show it). */
  stages: { name: string; box: [number, number, number, number]; hull: number; shield: number }[]
  modules: StationModule[]
  /** A station that launches strike craft by itself, as a carrier does (see UnitType `carrier`),
   * once it has grown to `level`. Off when left out. */
  carrier?: { unit: string; every: number; max: number; level: number }
  /** Its hull grows back out of combat from this level on (see UnitType `regrow`). Off when left out. */
  regrow?: { rate: number; delay: number; level: number }
}

export const stationGun = (art: 'turbo' | 'flak') => (art === 'turbo' ? turbo(48, 800) : flak(7, 380, 0.35))
export const sGun = (key: string, art: 'turbo' | 'flak', x: number, y: number, level: number): StationModule =>
  ({ key, kind: 'turret', art, x, y, s: art === 'turbo' ? 110 : 90, hp: art === 'turbo' ? 900 : 500, weapon: stationGun(art), level })
export const sPart = (key: string, kind: HardpointKind, art: ModuleArt, x: number, y: number, s: number, hp: number, at: { level?: number; tech?: string }): StationModule => ({ key, kind, art, x, y, s, hp, ...at })

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

// --- Orbital defense stations (Galactic conquest) ---------------------------------------------------

/**
 * What one slot of an orbital defense station can hold: the same five kinds for every faction, each
 * in its own way (data/<faction>.ts names them, arms them and picks the mount drawn on it). A
 * battery against warships, flak against strike craft, a launcher whose missiles go through shields,
 * a shield generator (the Swarm grows a regeneration pool instead: more hull, regrowing faster), and
 * a hangar that keeps a squadron of the faction's interceptors in the air.
 */
export type OrbitalModId = 'battery' | 'flak' | 'launcher' | 'shield' | 'hangar'
export const ORBITAL_MODS: OrbitalModId[] = ['battery', 'flak', 'launcher', 'shield', 'hangar']
/**
 * One slot's module, as a faction has it: price and seconds on the galaxy clock, its hardpoint (kind,
 * mount art and look, `hp` before TOUGHNESS, `s` its mount's radius in frame units) and what it adds:
 * a gun (`weapon`), shields (`shield`, with `regen`), hull (`hull`: a share, 0.2 is 20% more), faster
 * regrowth (`regrow`: a share added to the rate), or a squadron of `carrier` in the air.
 */
export type OrbitalModule = {
  id: OrbitalModId; name: string; blurb: string; cost: number; time: number
  kind: HardpointKind; art: ModuleArt; look?: MountExtra; hp: number; r: number
  weapon?: Weapon; shield?: number; regen?: number; hull?: number; regrow?: number; carrier?: string
}
/** One level of a defense station: the name it goes by, its hull and shields as built (modules add
 * to them), and what reaching it costs (built for level 1, an upgrade for 2 and 3), how long it takes
 * on the galaxy clock and the Command Station level it needs. */
export type OrbitalStage = { name: string; hull: number; shield: number; cost: number; time: number; station: number }
/**
 * A faction's orbital defense station: three levels on one frame (ORBITAL_FRAME), each with more
 * module slots (1, 2 and 4). `name` is what the station is called whatever its level ("Bastion
 * defense station"), `regen` its shields' recharge, `regrow` its living hull (the Swarm's).
 */
export type OrbitalPlan = {
  name: string; blurb: string; stages: [OrbitalStage, OrbitalStage, OrbitalStage]; regen: number
  regrow?: { rate: number; delay: number }; modules: OrbitalModule[]
}
/**
 * The frame every faction's defense station is drawn on, in frame units (the model's units: one is
 * `perUnit` world units): each level's box round the middle, and where each slot sits, the same at
 * every level so a module keeps its place as the station grows round it (level 1 has slot 0, level 2
 * slots 0 and 1, level 3 all four).
 */
export const ORBITAL_FRAME = {
  boxes: [[-22, -22, 22, 22], [-46, -26, 46, 26], [-50, -50, 50, 50]] as [number, number, number, number][],
  slots: [[0, 0], [-32, 0], [32, 0], [0, -33]] as [number, number][],
  counts: [1, 2, 4],
  perUnit: 3.2,
}

// --- Research ---------------------------------------------------------------------------------------

/**
 * What a piece of research changes, as fractions: hull 0.25 is +25% hull, cooldown -0.15 fires 15%
 * faster. On the unit type it is `for`:
 * - hull, shield, regen, damage, speed, cooldown, range, build: its own numbers (build -0.2: built 20%
 *   faster); hangar: one more squadron out (carriers); repair: its repairs (support ships).
 * - shieldDamage: its guns hit shields this much harder (0.25: +25% against shields; the hull damage
 *   after the shields go is the same).
 * - aura: added to its fire-control bonus (0.05: a 15% aura becomes 20%); auraRadius: its reach
 *   (0.2: 20% further).
 * - regrow: its living hull grows back this much faster (0.5: half as fast again); regrowDelay: its
 *   wait out of combat before it does (-0.3: 30% shorter).
 * - drain: its drain aura bites this much harder (0.25); drainHeal: it heals this much more of what
 *   it drains (0.5: half as much again); drainTargets: it bites this many more enemies at once (1).
 * - shieldAura: added to its shield-projector aura's `regen` (0.5: a +100% aura becomes +150%);
 *   auraRadius widens a shield-projector aura as it does a fire-control one.
 * On the station (`for` its station id): mines (the refinery's income), repair (its repair dock),
 * fleetBuild: every ship of the faction is built this much faster (-0.1: 10%), on top of each
 * ship's own build research; and regrow and regrowDelay, for every living hull of the side (ships
 * and structures), on top of each one's own.
 */
export type TechEffect = Partial<Record<'hull' | 'shield' | 'regen' | 'damage' | 'speed' | 'cooldown' | 'range' | 'build' | 'hangar' | 'repair' | 'mines' | 'shieldDamage' | 'aura' | 'auraRadius' | 'regrow' | 'regrowDelay' | 'drain' | 'drainHeal' | 'drainTargets' | 'shieldAura' | 'fleetBuild', number>>
/**
 * `for` is the unit type it upgrades, or the station (which also covers the economy). `requires`
 * lists research that has to come first, on top of the station level: that is what makes it a
 * tree rather than a shopping list. `icon`: the research whose picture it borrows (public/games/
 * empires/tech/<id>.webp), while it has none of its own.
 */
export type Tech = { id: string; faction: FactionId; for: string; name: string; blurb: string; cost: number; time: number; level: number; effect: TechEffect; requires?: string[]; icon?: string }

export const tech = (faction: FactionId, forId: string, id: string, name: string, blurb: string, cost: number, time: number, level: number, effect: TechEffect, requires?: string[]): Tech => ({
  id, faction, for: forId, name, blurb, cost, time, level, effect, requires,
})

// --- A faction ------------------------------------------------------------------------------------

/** How a faction looks and sounds outside its models: its colours, emblem and voices. */
export type FactionInfo = {
  name: string
  long: string
  blurb: string
  /** Its colour on the HUD, in the lobbies and on the galaxy map. */
  color: string
  /** Its bolts and muzzle flashes, and the glow of its jumps and shield hits. */
  bolt: string
  glow: string
  /** The letter its unit and research ids start with (r-fighter, d-st-guns). */
  prefix: string
  /** Its working light, as "r,g,b": yard sites going up, a rushed ship's scaffolding. */
  work: string
  /** Its engineers' welding beams: the glow, the bright core, and the halo's middle and edge. */
  weld: { glow: string; core: string; mid: string; edge: string }
  /** Flecks of debris when one of its units we weren't following breaks up. */
  debris: string
  /** Its emblem (lobbies, scoreboard, HUD, galaxy). */
  emblem: string
  /** The side a Galactic Conquest pits it against unless the player picks another. */
  rival: FactionId
  /** How it sounds: how high its heavy guns ring (`turbo`, 1 as written). Everything else about its
   * sound is its sound set, picked by faction id in sound.ts: its guns, hits and deaths (SET) and its
   * crews' voices (VOICE: the Republic's clone radio, the Confederacy's command net of relay clacks
   * and data bursts, the Swarm's chitter). */
  sound: { turbo: number }
  /** What it calls the things every faction shares, where its own name differs (see FactionNames). */
  names?: FactionNames
}

/**
 * A faction's own names for shared things, each falling back to the shared name when left out
 * (icons.ts hpName, codexInfo.ts weaponName, data.ts abilityOf): only the words change, never what
 * the thing does.
 */
export type FactionNames = {
  /** Its guns by kind, in the Codex's weapon lists ('Heavy cannons' rather than 'Turbolaser'). */
  weapon?: Partial<Record<WeaponKind, string>>
  /** A turret by the gun on it, where the hardpoint has no `look` of its own ('Tendril lance'). */
  mount?: Partial<Record<WeaponKind, string>>
  /** Its other hardpoints by kind ('Brood chamber' for a hangar). */
  part?: Partial<Record<HardpointKind, string>>
  /** Its extra mount designs (Hardpoint `look`). */
  look?: Partial<Record<MountExtra, string>>
  /** Its mining platform's upgrades (data.ts SITE_UPGRADES), where they are something else for it:
   * the Swarm's "Shield generator" is a hardened carapace (its FactionData shieldedMine). */
  site?: Partial<Record<'yield' | 'armor' | 'shield', { name: string; blurb: string }>>
  /** Its abilities' names, and their blurbs where the words differ too. */
  ability?: Partial<Record<AbilityId, { name: string; blurb?: string }>>
}

/**
 * The sockets on a faction's platform hulls, on the 0-10 grid. A defense deck has a big socket in
 * the middle, four at its corners and two small ones at its sides; a mining deck two drill wells
 * and a small socket in the middle.
 */
export type Deck = { centre: [number, number]; corners: [number, number][]; sides: [number, number][]; wells: [number, number][]; core: [number, number]; pd: [number, number]; pad: [number, number] }
/** The three defense platforms, each the same deck with different guns on it: flak against
 * fighters, heavy cannons against warships, or a little of both for a little less. */
export type DefenseKind = 'balanced' | 'flak' | 'gun'

/** A yard's berth, in its model's units (the box 100 long, nose up): half its width and where it
 * runs from the mouth (y0) to the stern (y1). */
export type Berth = { hw: number; y0: number; y1: number }
/** Where a warship carries its hardpoints at its size (models/sizes.ts sized): one entry per
 * hardpoint, in order, on the 0-10 grid, with each one's size `s` as a share of the ship's length. */
export type Layout = { x: number; y: number; s?: number }[]

/** Everything one faction brings, as written (before TOUGHNESS and sizes: data.ts finishes it). */
export type FactionData = {
  id: FactionId
  info: FactionInfo
  /** Its ships, in the order the build menus list them at one level and price. */
  ships: UnitType[]
  /** Its Command Station, at every level. */
  station: StationPlan
  /** Its structures: the mining platform, the three defense platforms, the Frigate Yard and the
   * Capital Yard, in that order. */
  structures: UnitType[]
  /** Its mining platform with the Shield generator fitted. */
  shieldedMine: UnitType
  /** Its research; prerequisites always come earlier in the list, so the tree can be laid out in
   * one pass. */
  techs: Tech[]
  /** The research that allows a rush launch from its Capital Yard. */
  rushTech: string
  /** Its mining platform's point defence. */
  mineFlak: Weapon
  /** The module sockets on its Frigate Yard and its Capital Yard (0-10 grid, as hardpoints). */
  yardSockets: [number, number][]
  cyardSockets: [number, number][]
  /** Its yards' berths, by yard id (sim.ts launchFrom, render.ts). */
  berths: Record<string, Berth>
  /** Where the gantry cranes or ring frames span each of its yards' berths, by yard id, in the
   * berths' units: the welding beams come down from them onto the ship being built. */
  gantries: Record<string, number[]>
  /** Its warships' hardpoints at their size, by unit id (see Layout). */
  layout: Record<string, Layout>
  /** Its orbital defense station (Galactic conquest). */
  orbital: OrbitalPlan
  /** Its ground battle units and buildings (UnitType `ground`): the Engineer, the Command Center and the supply building. */
  ground: UnitType[]
}
