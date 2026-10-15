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
  | 'spore' | 'acid' | 'lance' | 'bioturret' | 'parasite' | 'regen' | 'engineSac' | 'broodSac' | 'spine'
export type AbilityId = 'flakBarrage' | 'repairSwarm' | 'shieldBoost' | 'tractor' | 'broadside' | 'launchSwarm' | 'fieldRepair'

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

  /** Living hulls: out of combat (`delay` seconds since an enemy last hit it) the hull grows back,
   * `rate` of its full hull a second, up to what it can have (a rush-launched ship's unbuilt hull
   * stays unbuilt). Module damage isn't mended by it. */
  regrow?: { rate: number; delay: number }
  /** A drain aura: every enemy within `radius` (as written, stretched like gun ranges) loses `dps`
   * hull points a second, straight off the hull past any shields, and `heal` of what is drained
   * mends our ships within `radius`, shared out evenly among the damaged ones (itself included). */
  drain?: { radius: number; dps: number; heal: number }
  /** A fire-control aura: our ships within `radius` (as written, stretched like gun ranges), itself
   * included, deal `bonus` more damage (0.15: 15%). Auras don't stack: a ship near several gets the
   * best one. */
  fireControl?: { radius: number; bonus: number }
}

export type Ability = { name: string; blurb: string; cooldown: number; duration: number; range?: number }

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
 *   it drains (0.5: half as much again).
 * On the station (`for` its station id): mines (the refinery's income), repair (its repair dock),
 * fleetBuild: every ship of the faction is built this much faster (-0.1: 10%), on top of each
 * ship's own build research; and regrow and regrowDelay, for every living hull of the side (ships
 * and structures), on top of each one's own.
 */
export type TechEffect = Partial<Record<'hull' | 'shield' | 'regen' | 'damage' | 'speed' | 'cooldown' | 'range' | 'build' | 'hangar' | 'repair' | 'mines' | 'shieldDamage' | 'aura' | 'auraRadius' | 'regrow' | 'regrowDelay' | 'drain' | 'drainHeal' | 'fleetBuild', number>>
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
  /** Its guns by kind, in the Codex's weapon lists ('Plasma cannons' rather than 'Turbolaser'). */
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
}
