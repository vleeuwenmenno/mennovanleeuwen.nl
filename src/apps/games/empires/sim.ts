import * as M from './detmath.ts'
import { sq } from './detmath.ts'
import { inside, mirrored, rng, type MapDef, type Pt } from './maps.ts'
import { clearLine, findPath, navGrid, type NavGrid } from './nav.ts'
import { mapDist, rangeDist } from './scale.ts'
import { BIG_SPREAD, sizeClass } from './models/sizes.ts'
import {
  ABILITIES, FACTIONS, moduleFits, siteUpgradeOf, YARD_BERTHS, MODULE, MODULE_FX, MODULE_QUEUE, REBUILD_MODULE, RUSH, RUSH_TECH, WORKS_NAME, needsModule, worksOf, yardOf, yardType, type ModuleId, ARMOR_BONUS, BASE_POP, BUILD_RADIUS, DEFENSE_WING, ENGINEERS, FIELD_REPAIR, MENDABLE, REBUILD, SITE_REFUND, YARD_MAX, builtAt, isEngineer, mineType, STATIONS, wingOf, type SiteUpgradeId, BEACON_INCOME, SITE_UPGRADES, YIELD_PER_LEVEL, BEACON_POP, LEVEL_UP, MAX_CAPITALS, MAX_LEVEL, MAX_QUEUE, MAX_RESEARCH, MINE_INCOME, POP_PER_LEVEL, START_CREDITS, STATION_INCOME,
  SURVEY_RADIUS, SURVEY_TIME, TECH, UNIT, UNITS, UPGRADES, accuracy, dims, effect, isShip, stationType, unitOf, type AbilityId, type FactionId, type TechEffect, type Tier, type UnitType, type Weapon,
  type WeaponKind,
} from './data.ts'

// The battle itself, with no DOM: ships, orders, steering, guns, shields and hardpoints, the
// economy and capture beacons. The game screen and the headless balance sims both drive it by
// calling `tick` at a fixed step and reading `events` for sound and effects.

export const STEP = 1 / 30
/** Fleet size each side starts a fleet battle with on the field; the rest waits in orbit. */
export const FLEET_CAP = 40
/** A player's index in `world.players`. Players on the same team share vision and win together. */
export type Owner = number
/** Whether two players are on opposite sides. */
export const foes = (w: World, a: Owner, b: Owner) => w.players[a].team !== w.players[b].team
export const teamOf = (w: World, o: Owner) => w.players[o].team
/** Whether player `o`'s team can see unit `u`. */
export const sees = (w: World, o: Owner, u: Unit) => u.seen[w.players[o].team]

/**
 * How a ship answers enemies when it isn't told what to attack (after Beyond All Reason):
 * - hold: never leaves its spot or its path; shoots whatever comes within reach of its guns.
 * - maneuver: fires back and gives chase, but only so far (a leash) from where the fight started,
 *   then comes back or carries on with its orders. Stops it being lured into a stronger fleet.
 * - roam: chases anything it can see, as far as it goes.
 */
export type Stance = 'hold' | 'maneuver' | 'roam'
export const STANCES: Stance[] = ['hold', 'maneuver', 'roam']
/** How far Maneuver ships chase from where a fight started (it goes with how far guns reach). */
export const LEASH = { fighter: rangeDist(1100), ship: rangeDist(800) }

export type Order =
  | { k: 'idle' }
  /** `attack`: attack-move, engaging whatever turns up on the way. `speed` keeps a group together. */
  | { k: 'move'; x: number; y: number; attack: boolean; speed: number; /** The heading to turn to on arrival (right-drag), in radians. */ face?: number }
  /** Back and forth between (x, y), where it is heading, and (bx, by), fighting what it meets. */
  /** Back and forth: heading for (x, y), then (bx, by), swapping at each end. `sx, sy` and `ex, ey`
   * are where the patrol was ordered from and to, which stay put, for showing its start and end. */
  | { k: 'patrol'; x: number; y: number; bx: number; by: number; speed: number; sx?: number; sy?: number; ex?: number; ey?: number }
  /** `hp`: the hardpoint to aim at, or -1 for the ship as a whole. */
  | { k: 'attack'; id: number; hp: number }
  /** Attack everything inside the circle at (x, y), the ships sharing out the targets between them. */
  | { k: 'area'; x: number; y: number; r: number }
  /** Stay with a friendly ship or structure and fight off whatever comes near it. */
  | { k: 'guard'; id: number }
  /** Engineers: build a construction site of ours, or weld one of our structures back together. */
  | { k: 'construct'; id: number }
  /** Repair ships (tenders and Field repair craft): repair a damaged ship or station of ours or an
   * ally's until it is whole or lost (see cmdMend). `back`: the ship or structure it was guarding
   * (or escorting) when told, which it goes back to afterwards; 0 for none. */
  | { k: 'mend'; id: number; back: number }

/** Research multipliers for one ship, 1 meaning unchanged. */
export type Mods = {
  hull: number; shield: number; regen: number; damage: number; speed: number; cooldown: number; range: number
  // From research for the faction mechanics (TechEffect), each a multiplier, there only when some
  // research changes it (and absent in units saved before them): damage to shields, a fire-control
  // aura's bonus (added) and reach, a living hull's regrowth and its wait, a drain's bite and heal,
  // a shield-projector aura's regen (added; its reach is auraRadius), a drain's extra targets (added).
  shieldDamage?: number; aura?: number; auraRadius?: number; regrow?: number; regrowDelay?: number; drain?: number; drainHeal?: number; drainTargets?: number; shieldAura?: number
}

/** A gun: its weapon, the hardpoint it sits on (-1 for the hull), reload, and what it shoots at.
 * `focus` is a target this one gun was told to fire on first. */
export type Gun = { w: Weapon; hp: number; cd: number; burst: number; burstT: number; target: number; aim: number; focus: number }

export type Unit = {
  id: number
  t: UnitType
  owner: Owner
  x: number
  y: number
  a: number
  v: number
  hull: number
  hullMax: number
  shield: number
  /** Its modules (one per hardpoint): `fix` is how far a Field repair has got rebuilding a shot-off
   * station module, in seconds of one craft's welding (see FIELD_REPAIR.rebuild). */
  hps: { hp: number; max: number; fix?: number }[]
  guns: Gun[]
  order: Order
  /** Idle ships drift back here after chasing something. */
  ax: number
  ay: number
  squad: number
  /** Fighters launched by a carrier stay with it. */
  parent: number
  target: number
  retarget: number
  lastHit: number
  /** When rocks in an asteroid field last hit it (see terrain): not an attack, but a living hull
   * waits from it as from a hit. Absent until it first flies through a field. */
  scraped?: number
  /** Shield shimmer: time of the last shield hit and where it came from. */
  shieldHit: number
  /** When the shields last failed: they stay down for SHIELD_REBOOT seconds before recharging. */
  shieldOut: number
  hitAngle: number
  abilityCd: number
  abilityOn: number
  slow: number
  /** Carriers: seconds since the last launch. Stations: seconds until the hangar sends out the next
   * defense wing craft (see wings). */
  hangarT: number
  /** A station that launches strike craft as a carrier does (StationPlan carrier): seconds since
   * its last brood (its hangarT is the defense wing's). Absent until it first has one. */
  broodT?: number
  /** Seconds left on construction (mining platforms). */
  building: number
  node: number
  dead: boolean
  /** Visible to each team, refreshed a few times a second. */
  seen: boolean[]
  born: number
  kills: number
  /** Credits' worth of enemies destroyed: experience. */
  xp: number
  /** Veterancy: 0 green, 1 veteran, 2 elite, 3 ace. */
  rank: number
  mods: Mods
  /** How it answers enemies: see Stance. Kept until changed, whatever the orders. */
  stance: Stance
  /** Where the current fight started: Maneuver ships give chase only so far from here. */
  gx: number
  gy: number
  /** Who shot at it last, so it can answer fire from beyond its usual look. */
  hitBy: number
  /** Inside a nebula: no shields, short sensors. Refreshed every tick. */
  nebula: boolean
  /** Orders given with Shift, taken one at a time once the current one is done. */
  queue: Order[]
  /** Support ships: the ships they're repairing right now, for the repair beams. */
  mending: number[]
  /** Drain ships: the enemies they bit this tick, for the tendrils. Absent until one first drains. */
  drained?: number[]
  /** A repair craft on a Field repair run: the ship or station it is mending (0 when none). */
  aid: number
  /** Strike craft on a strafing run: pulling away after a pass, until far enough out to turn. */
  breakOff: boolean
  /** Waypoints round the rocks to where the ship is going (x, y), found when it set off (from fx,
   * fy; found again from where it is when it was pushed off its line, see waypoint). */
  route: { x: number; y: number; pts: Pt[]; obs: { x: number; y: number; r: number }[]; fx?: number; fy?: number } | null
  /** The heading an idle ship turns to at its spot, from a move given one; null to stay as it is. */
  face: number | null
  /** Seconds left on a structure's repair, 0 when none is under way. */
  repair: number
  /** Seconds until a retreating warship jumps out, 0 when it isn't retreating. */
  retreat: number
  /** A structure's focus: the enemy all its guns fire on first, while they can reach and hurt it. */
  focus: number
  /** This structure's own upgrades, by id: levels bought (mining platforms; lost with it). */
  upg: Partial<Record<SiteUpgradeId, number>>
  /** The upgrade being fitted, and seconds left. */
  upgrading: { id: SiteUpgradeId; left: number; total: number } | null
  /** Its place on the arc a group of warships forms round the target they're all attacking (see
   * attackSpots), or null while it has none. */
  slot: Slot | null
  /** A defense wing craft's parking slot round its station while it guards it (see guardSlot),
   * handed out the first time it guards; absent until then, and in battles saved before slots. */
  post?: number
  /** A warship that has reached its firing spot: it keeps its heading there, its turrets doing the
   * turning, for as long as any gun that counts can bear on what it fights (see closeIn). Absent
   * (and in battles saved before it) until it first settles. */
  settled?: boolean
  /** How hard it is to shove aside, overriding its class's (see pushClass): the hook for an
   * ability that lets a ship push bigger hulls. Absent: its class's. */
  pushClass?: number
  /** How high it flies over other ships, overriding its class's (see heightOf). Absent: its class's. */
  height?: number
  /** A yard's own build queue and rally point, once it is built. */
  yq?: QueueItem[]
  yr?: Pt
  /** A construction site (a yard placed by engineers, until it is finished): what was paid for it
   * (for a refund if it is cancelled), the ruin it went up on (given back if it is), and whether
   * building has started. Until it has, only its owner knows it is there. */
  site?: { paid: number; started: boolean; ruin?: Ruin }
  /** A Command Station's or a yard's expansions (hybrid bases): the ones built onto it (its type
   * carries their hardpoints), and the ones ordered, the first under way. Absent until it has any,
   * and in battles saved before expansions. */
  xm?: ModuleId[]
  xq?: ModuleJob[]
  /** A warship rush-launched unfinished (see Rush). Absent once it is finished, and on every other unit. */
  rush?: Rush
  /** A yard that rush-launched: when it may rush again (World time). */
  rushAt?: number
  /** A yard that rush-launched with nothing else in its queue: the next ship it starts goes slower. */
  slowNext?: boolean
  /** A new ship flying out of the yard's berth or the station's hangar door (see Launch). Absent once
   * it is out, and on every other unit. */
  launch?: Launch
}

/**
 * A new ship leaving where it was built: it sits at (x0, y0) facing `a` while its engines spool up
 * and the docking lights blink (`spool` seconds), then slides out along `a` to (x1, y1) in `slide`
 * seconds, and flies on under its own power. `t` is the seconds it has been at it; `wait` the seconds
 * it has held back because the way out was blocked (see LAUNCH.wait). `from`: the yard or station.
 * `end`: its speed as it comes clear, in units a second.
 */
export type Launch = { from: number; t: number; wait: number; spool: number; slide: number; x0: number; y0: number; x1: number; y1: number; a: number; end: number }

/**
 * A rush-launched warship still to be finished (data.ts RUSH): `left` seconds of its build still to
 * do (of `total` when it launched), done only while a Drydock, repair craft or engineers work on it
 * (`work`, set by them in the tick), at the build pace however many there are. `gap`: hull still
 * unbuilt, which ordinary repairs can't mend (see hullCap). `parts`: its hardpoints not yet installed
 * (hp 0: they don't fire or work), in the order they go on, `n` of them at launch.
 */
/** A fleet battle's ship that was rush-launched in the galaxy: `built` of it done, `left` seconds of its build still
 * to do (the battle's seconds), `held`: it waits in the fleet's reserve. */
export type RushedIn = { unit: string; built: number; left: number; held?: boolean }
export type Rush = { left: number; total: number; gap: number; parts: number[]; n: number; work: boolean }

/** An expansion being built onto its building: seconds left of its time. */
export type ModuleJob = { id: ModuleId; left: number; total: number }

/** Where a yard was destroyed: its owner's engineers can rebuild it there for REBUILD of its price. */
export type Ruin = { id: number; owner: Owner; unit: string; x: number; y: number; a: number }

/**
 * A warship's place round its target when several of its side's warships fight the same one: `a`
 * is the bearing from the target to the spot, `inset` how much nearer than its own stopping
 * distance it sits (a second row). `t` is the target it was worked out for, `key` a fingerprint of
 * the group and `at` when, so it is worked out again only when the group changes or it has gone
 * stale. `held`: the ship reached its spot and stays there until the spot or the target moves
 * well away.
 */
export type Slot = { t: number; key: number; at: number; a: number; inset: number; held: boolean }

/** A ship being built. `reserve`: it goes to the fleet reserve when done instead of jumping in. */
/** `slow`: the ship a yard started after a rush launch, built RUSH.slowdown slower. */
/** `paid`: what it cost, when that isn't its plain price (a reinforcement's surcharge), for a refund. */
export type QueueItem = { unit: string; left: number; total: number; reserve?: boolean; slow?: boolean; paid?: number }
/** A ship on its way in from hyperspace: it drops out at (x, y), facing `a`, once the clock
 * reaches `at`. `rally`: a new ship from the shipyard, sent on to the rally point. */
export type Arrival = { unit: string; owner: Owner; x: number; y: number; a: number; at: number; rally: boolean; /** From a yard: its rally point (else the station's). */ rx?: number; ry?: number
  /** Rush-launched: the share of it that was built, and the seconds of its build left (see Rush). */
  rush?: { built: number; left: number }
}
/** Research in progress: a tech id, or LEVEL_UP for the next station level. */
export type ResearchItem = { id: string; left: number; total: number }
export type Player = {
  faction: FactionId
  team: number
  /** Which of the map's spawn points this player started at. */
  spawn: number
  /** Where the station was placed: the spawn point, or a spot picked in the start area. */
  start: Pt
  /** Still has a station. */
  alive: boolean
  credits: number
  income: number
  incomeMul: number
  level: number
  station: number
  queue: QueueItem[]
  /** Ships bought and waiting in hyperspace, to be called in anywhere the fleet can see. */
  reserve: string[]
  research: ResearchItem[]
  techs: string[]
  rally: { x: number; y: number }
  pop: number
  popCap: number
  lastAlarm: number
  stats: { built: number; lost: number; killed: number; earned: number }
  /** Where the income comes from right now, in credits a second (together, `income`). */
  incomeParts: Record<'station' | 'mines' | 'beacons', number>
  /** Credits earned this battle, by source. */
  earnedBy: Record<EarnSource, number>
  /** Credits spent this battle, by what on (refunded cancellations taken off again). */
  spentBy: Record<SpendKind, number>
  /** The latest purchases and one-off payouts, newest last (the last LEDGER_SIZE). */
  ledger: LedgerEntry[]
  /** Refunds from retreated ships, paid once their time comes. */
  refunds: { at: number; amount: number; unit: string }[]
  /** Credits and income every HISTORY_STEP seconds, for the economy chart. */
  history: { t: number; credits: number; income: number }[]
  /** Fleet battles: ships that jumped out alive, back to the fleet they came from. */
  escaped: string[]
  /** Fleet battles: ships of ours rush-launched unfinished that are waiting in the reserve (called in
   * still unfinished: see cmdDeploy), and the ones that jumped out unfinished (state kept for the fleet). */
  rushRes?: RushedIn[]
  escapedRush?: RushedIn[]
  /** Hybrid bases: whether an Armour works of ours stands, as last applied to our frigates' and
   * corvettes' hull (see armourWorks). Absent: no. */
  armour?: boolean
  /** Credits between allies: when this player last sent some (the battle clock), and how many it
   * sent and got in all. Absent until the first gift. */
  lastGift?: number
  gave?: number
  got?: number
}
export type EarnSource = 'station' | 'mines' | 'beacons' | 'salvage' | 'refunds'
export type SpendKind = 'ships' | 'research' | 'structures' | 'repairs'
/** One line in the economy log: + for money in, - for money out. */
export type LedgerEntry = { t: number; amount: number; what: string; kind: SpendKind | 'salvage' | 'refund' | 'cancel' | 'gift'
  /** A gift: the ally it went to or came from. */
  seat?: Owner
}
const LEDGER_SIZE = 40
export const HISTORY_STEP = 5
/** Seconds after a retreated ship jumps out before its refund arrives. */
export const REFUND_DELAY = 15

function note(w: World, p: Player, amount: number, kind: LedgerEntry['kind'], what: string, seat?: Owner) {
  p.ledger.push({ t: w.time, amount, kind, what, ...(seat !== undefined ? { seat } : {}) })
  if (p.ledger.length > LEDGER_SIZE) p.ledger.shift()
}
/** Pay for something: taken off the credits, counted under its kind, and logged. */
function spend(w: World, p: Player, amount: number, kind: SpendKind, what: string) {
  p.credits -= amount
  p.spentBy[kind] += amount
  note(w, p, -amount, kind, what)
}
/** Money back for something cancelled before it was done. */
function giveBack(w: World, p: Player, amount: number, kind: SpendKind, what: string) {
  p.credits += amount
  p.spentBy[kind] -= amount
  note(w, p, amount, 'cancel', what)
}
/** An upgrade called off: its whole price back, and an event so the player sees the refund. */
function cancelUpgrade(w: World, p: Player, amount: number, kind: SpendKind, what: string) {
  giveBack(w, p, amount, kind, `Cancelled: ${what}`)
  w.events.push({ k: 'cancelled', owner: w.players.indexOf(p), amount, what })
}
/** Something teams take by parking ships at it. `owner` is the team holding it (-1 for nobody);
 * `claim` is the team the progress bar (0 to 1) belongs to. */
export type Claimable = { owner: number; claim: number; progress: number }
/** An ore asteroid. `site` is the structure on it (0 if none); `owner` is the team that surveyed it. */
export type OreNode = { id: number; x: number; y: number; r: number; rot: number; site: number } & Claimable
export type Beacon = { id: number; x: number; y: number } & Claimable
export type Rock = { x: number; y: number; r: number; rot: number; spin: number; kind: number }
/** A derelict hulk to strip for credits. `left` counts down as it's salvaged; battle wrecks also
 * drift off after `decay` seconds. `team` is who's salvaging it right now (-1 for nobody). */
export type Wreck = {
  id: number; x: number; y: number; value: number; left: number; sprite: string; size: number; rot: number; decay: number; team: number
}
/** How close (from the hulk's centre) a ship must park to salvage, and credits a second per ship (up to three). */
export const SALVAGE_RANGE = 240
/** Seconds failed shields stay down before they start to recharge. */
export const SHIELD_REBOOT = 2
export const SALVAGE_RATE = 30
export type Shot = {
  x: number; y: number; vx: number; vy: number; left: number; kind: WeaponKind; owner: Owner; target: number; hp: number; dmg: number; hit: boolean; sx: number; sy: number; age: number; from: number
  /** How much harder it hits shields than its damage says (research, TechEffect shieldDamage): 1 when left out. */
  sh?: number
}

export type SimEvent =
  | { k: 'fire'; kind: WeaponKind; x: number; y: number; owner: Owner; light: boolean }
  | { k: 'hit'; kind: WeaponKind; x: number; y: number; shield: boolean; owner: Owner }
  | { k: 'boom'; x: number; y: number; tier: Tier; owner: Owner; size: number }
  | { k: 'hpdown'; x: number; y: number; owner: Owner; what: string; /** An expansion module was shot off. */ exp?: ModuleId }
  | { k: 'built'; owner: Owner; unit: string; x: number; y: number }
  /** `owner` and `prev` are teams here. */
  | { k: 'beacon'; owner: number; prev: number; x: number; y: number }
  | { k: 'survey'; owner: number; prev: number; node: number; x: number; y: number; /** The platform on it was destroyed */ razed?: boolean }
  | { k: 'out'; owner: Owner }
  | { k: 'alarm'; owner: Owner; x: number; y: number; what: string }
  | { k: 'level'; owner: Owner; level: number }
  | { k: 'tech'; owner: Owner; id: string }
  | { k: 'ability'; owner: Owner; id: AbilityId; x: number; y: number }
  | { k: 'launch'; owner: Owner; x: number; y: number }
  | { k: 'shieldsDown'; owner: Owner; x: number; y: number }
  | { k: 'salvaged'; owner: Owner; value: number; x: number; y: number }
  | { k: 'rankUp'; owner: Owner; unit: number; rank: number; x: number; y: number }
  /** A jump started: the ship drops out at (x, y) after `delay` seconds. */
  | { k: 'warp'; owner: Owner; unit: string; x: number; y: number; a: number; delay: number }
  /** It dropped out; `field`: into an asteroid field, and took the damage. */
  | { k: 'arrived'; owner: Owner; unit: string; x: number; y: number; a: number; field: boolean }
  /** A ship finished for the reserve. */
  | { k: 'reserved'; owner: Owner; unit: string }
  /** An upgrade (research, an expansion or a platform upgrade) was cancelled: `amount` credits came back in full. */
  | { k: 'cancelled'; owner: Owner; amount: number; what: string }
  /** A platform finished fitting an upgrade. */
  | { k: 'upgraded'; owner: Owner; unit: number; id: SiteUpgradeId; level: number }
  /** A structure's repair crew finished. */
  | { k: 'repaired'; owner: Owner; unit: number; x: number; y: number }
  /** A warship started charging its drive to retreat; it jumps out after `secs`. */
  | { k: 'retreating'; owner: Owner; unit: string; x: number; y: number; secs: number }
  /** A retreated ship's refund arrived. */
  | { k: 'refunded'; owner: Owner; unit: string; amount: number }
  /** It jumped out; `refund` credits follow in REFUND_DELAY seconds. */
  | { k: 'retreated'; owner: Owner; unit: string; x: number; y: number; a: number; refund: number }
  /** An expansion was finished on one of our buildings (`unit`). */
  | { k: 'expanded'; owner: Owner; unit: number; id: ModuleId; x: number; y: number }
  /** A rush launch from a yard (at the yard); a rushed ship's part going on, and it finished. */
  | { k: 'rushed'; owner: Owner; unit: string; x: number; y: number }
  | { k: 'installed'; owner: Owner; unit: number; x: number; y: number }
  | { k: 'finished'; owner: Owner; unit: number; x: number; y: number }
  /** Credits sent from one ally to another. */
  | { k: 'gift'; from: Owner; to: Owner; amount: number }

export type World = {
  w: number
  h: number
  time: number
  units: Unit[]
  byId: Map<number, Unit>
  players: Player[]
  teams: number
  map: MapDef
  nodes: OreNode[]
  beacons: Beacon[]
  rocks: Rock[]
  wrecks: Wreck[]
  shots: Shot[]
  events: SimEvent[]
  nextId: number
  /** Ids for the next squadron and the next battle wreck. */
  squadSeq: number
  wreckSeq: number
  /** The battle's random numbers come from here (see `rand`), never from Math.random: kept in the
   * world, every player's copy of a multiplayer battle draws the same ones. */
  rs: number
  /** The winning team, or -1 while the battle goes on. */
  winner: number
  grid: Map<number, Unit[]>
  seenT: number
  /** Path finding grids, one per ship size and set of fields and nebulas to keep out of. */
  nav: Map<string, NavGrid>
  /** Ships jumping in, oldest first. */
  arrivals: Arrival[]
  /** A galactic conquest fleet battle: no mining or building, only the fleets (and the defender's
   * station). A side is beaten once it has nothing left on the field or waiting in orbit. */
  fleet?: FleetRules
  /** Hybrid bases: the station is a Command Station and engineers build the yards round it (see
   * BUILD_RADIUS). Battles saved before there were yards, and galactic conquest's fleet battles,
   * don't have it: their station is the whole shipyard, as it always was. */
  hybrid?: boolean
  /** Ruined yards, where they were destroyed. */
  ruins?: Ruin[]
  /** Dev cheats only (a local battle): the rush launch's numbers, tried out in place of RUSH. */
  rushTune?: typeof RUSH
  /** New ships fly out of the yards (and the station's hangar), and calling one in from hyperspace
   * as a reinforcement is a paid extra, by these rules (see Reinforce). Absent in a battle saved
   * before that (and in fleet battles, which build nothing): new ships jump in beside their yard, as
   * they always did there, and the reserve costs nothing extra. */
  reinforce?: Reinforce
}

/**
 * Reinforcements, a battle's rules set in the lobby: whether strike craft (fighter-class: fighters,
 * bombers, repair craft, engineers) and warships (gunships and up) may be bought as reinforcements
 * (built, then waiting in the reserve to be called in anywhere the fleet can see), and what that
 * costs on top of the plain price, in percent (0 to 50, in steps of 5).
 */
export type Reinforce = { strike: boolean; ships: boolean; surcharge: number }
export const REINFORCE: Reinforce = { strike: true, ships: true, surcharge: 15 }
export const SURCHARGE_MAX = 50
/** Lobby rules as received (old matches have none, a tampered client anything): the defaults for
 * what is missing, a surcharge brought onto the 5% steps between 0 and SURCHARGE_MAX. */
export function cleanReinforce(raw: unknown): Reinforce {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof Reinforce, unknown>>
  const pct = typeof o.surcharge === 'number' && Number.isFinite(o.surcharge) ? Math.round(clamp(o.surcharge, 0, SURCHARGE_MAX) / 5) * 5 : REINFORCE.surcharge
  return { strike: typeof o.strike === 'boolean' ? o.strike : REINFORCE.strike, ships: typeof o.ships === 'boolean' ? o.ships : REINFORCE.ships, surcharge: pct }
}
/** What calling a ship in as a reinforcement costs on top of its price: the surcharge's share of it,
 * rounded to 5 credits, and at least 25 (none at 0%). Old battles (no rules): nothing. */
export function surcharge(w: World, id: string) {
  const pct = w.reinforce?.surcharge ?? 0
  if (pct <= 0) return 0
  return Math.max(25, Math.round((UNIT[id].cost * pct) / 100 / 5) * 5)
}
/** What a ship costs: as a reinforcement (`reserve`), with the surcharge. */
export const shipPrice = (w: World, id: string, reserve = false) => UNIT[id].cost + (reserve ? surcharge(w, id) : 0)
/** Why a ship can't be bought as a reinforcement in this battle (its class is off in the lobby), or
 * null. Battles from before the rules: strike craft can't, as then. */
export function cantReinforce(w: World, id: string): string | null {
  const t = UNIT[id]
  const strike = t.tier === 'fighter'
  const r = w.reinforce
  if (!r) return strike ? 'Strike craft launch from the hangar' : null
  if (strike && !r.strike) return 'Reinforcements for strike craft are off in this battle'
  if (!strike && !r.ships) return 'Reinforcements for warships are off in this battle'
  return null
}
/** Whether new ships fly out of their yard (or the station's hangar) rather than jump in beside it. */
export const launches = (w: World) => !!w.hybrid && !!w.reinforce && !w.fleet

export type FleetRules = {
  /** Where each player's reinforcements may jump in, whether or not the fleet can see it. */
  entry: { x: number; y: number; r: number }[]
  /** Fleet size the battle starts with on the field; the rest waits in orbit. */
  cap: number
  /** The team that holds the planet: it keeps it if both sides are wiped out. */
  holder: number
  endT: number
}

// --- Helpers ----------------------------------------------------------------------------------------

const TAU = Math.PI * 2
/** The battle's next random number in [0, 1): mulberry32, like `rng`, with its state in the world. */
export function rand(w: World) {
  w.rs = (w.rs + 0x6d2b79f5) >>> 0
  let t = w.rs
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const wrap = (a: number) => ((a + Math.PI) % TAU + TAU) % TAU - Math.PI
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
const d2 = (ax: number, ay: number, bx: number, by: number) => sq(ax - bx) + sq(ay - by)

/** How much further apart a group of ships keeps: the size class of its biggest ship that needs room
 * of its own, at least BIG_SPREAD (models/sizes.ts). A ship needs room when the group has another
 * ship it can't fly over (see overlaps): a lone flagship among gunships doesn't, since they cross
 * its hull, so it no longer spreads the whole group out as wide as two flagships would need. */
const spreadOf = (us: Unit[]) => {
  let s = BIG_SPREAD
  for (const u of us) {
    const c = sizeClass(u.t)
    if (c > s && us.some((o) => o !== u && !overlaps(u, o))) s = c
  }
  return s
}
/** How hard a ship speeds up and brakes, before its tier's factor (see steer). */
const accOf = (t: UnitType) => t.speed * (t.accel ?? 1)

/**
 * How hard a hull is to shove aside, by class. Where two hulls press into each other, the one of
 * the lower class gives way entirely and steers round the other, which isn't moved at all; two of
 * the same class share the push. Structures never move. A unit's own `pushClass` overrides its
 * class's: the hook for an ability (a ram, a heavy tractor) that lets a ship push bigger ones.
 * Tractor lock only slows ships, so it doesn't touch this.
 */
export const PUSH_CLASS: Record<Tier, number> = { fighter: 0, gunship: 1, frigate: 2, cruiser: 3, capital: 4, station: 10, mine: 10, defense: 10, yard: 10 }
export const pushClass = (u: Unit) => (isShip(u.t) ? (u.pushClass ?? PUSH_CLASS[u.t.tier]) : Infinity)

/**
 * How high a ship flies over the others: its class, in PUSH_CLASS's order (fighter 0 to capital 4),
 * or its own `height` (the hook for something that changes that). Ships OVERLAP_GAP or more apart
 * pass over each other, friend or foe, as fighters always have over everything: a gunship or a
 * corvette over a cruiser or a flagship, a frigate over a flagship. Neither keeps the hull gap from
 * the other nor pushes it (see the end of moveUnit), so small ships no longer pile up round a big
 * hull or get shoved about by it. Closer classes and the same class stay solid; so do structures,
 * for everything but fighters.
 */
export const heightOf = (u: Unit) => u.height ?? PUSH_CLASS[u.t.tier]
export const OVERLAP_GAP = 2
/** Whether two ships pass over each other (see heightOf). */
export const overlaps = (a: Unit, b: Unit) => isShip(a.t) && isShip(b.t) && Math.abs(heightOf(a) - heightOf(b)) >= OVERLAP_GAP
/** Whether `u` guarding `g` escorts it: `g` is a ship at least OVERLAP_GAP classes bigger, which
 * `u` keeps station over (see escortSlot). Guarding anything else is the plain guard. */
export const escorts = (u: Unit, g: Unit) => isShip(u.t) && isShip(g.t) && heightOf(g) - heightOf(u) >= OVERLAP_GAP

/** Rough body radius, for spacing, clicking and collisions. */
export const radius = (t: UnitType) => {
  const [w, h] = dims(t)
  return (w + h) * 0.25
}

/** World position of a point on the sprite's 0-10 grid. */
export function shipPoint(u: Unit, gx: number, gy: number) {
  const [w, h] = dims(u.t)
  const side = (gx / 10 - 0.5) * w
  const fwd = (0.5 - gy / 10) * h
  const c = M.cos(u.a)
  const s = M.sin(u.a)
  return { x: u.x + c * fwd - s * side, y: u.y + s * fwd + c * side }
}
export const hpPos = (u: Unit, i: number) => shipPoint(u, u.t.hardpoints[i].x, u.t.hardpoints[i].y)
const alive = (u: Unit, i: number) => u.hps[i].hp > 0

/** The share of a unit's own modules of a kind still standing (expansions don't count: each does
 * its own thing, see expUp). */
function share(u: Unit, kind: string) {
  const all = u.t.hardpoints.map((h, i) => (h.kind === kind && !h.exp ? i : -1)).filter((i) => i >= 0)
  if (!all.length) return 1
  return all.filter((i) => alive(u, i)).length / all.length
}
/** Whether expansion `id` stands on `u`: built, and not shot off. */
export const expUp = (u: Unit | undefined, id: ModuleId) => !!u && !u.dead && u.t.hardpoints.some((h, i) => h.exp === id && u.hps[i].hp > 0)
/** The Command Station's Shield core, while it stands: more shields, recharging faster. */
const coreUp = (u: Unit) => u.t.tier === 'station' && expUp(u, 'shieldCore')
/** Shields with every generator up. */
export const shieldFull = (u: Unit) => u.t.shield * u.mods.shield * (coreUp(u) ? 1 + MODULE_FX.shield : 1)
export const shieldMax = (u: Unit) => shieldFull(u) * share(u, 'shield')
/** How far a unit sees: half as far while building or inside a nebula; a Command Station with its
 * Sensor array standing half as far again. */
export const sensorOf = (u: Unit) =>
  planned(u) ? 0 : u.t.sensor * (u.building > 0 ? 0.5 : 1) * (u.nebula ? NEBULA_SENSOR : 1) * (u.t.tier === 'station' && expUp(u, 'sensorArray') ? MODULE_FX.sensor : 1)
/** A construction site nobody has started on yet: only its owner knows it is there, nothing bumps
 * into it, and it sees nothing. */
export const planned = (u: Unit) => !!u.site && !u.site.started
export const speedOf = (u: Unit) => u.t.speed * u.mods.speed * (0.25 + 0.75 * share(u, 'engine')) * (u.slow > 0 ? 0.33 : 1)

/** Everything a player has researched for one unit type (or for its station), added up. */
export function techBonus(p: Player, unitId: string): TechEffect {
  const out: TechEffect = {}
  for (const id of p.techs) {
    const t = TECH[id]
    if (t?.for !== unitId) continue
    for (const [k, v] of Object.entries(t.effect) as [keyof TechEffect, number][]) out[k] = (out[k] ?? 0) + v
  }
  return out
}
/** Whether the Armour works' extra hull goes to ships of this type: the ships the Frigate Yard builds. */
const plated = (t: UnitType) => t.tier === 'frigate' || t.kind === 'support'
function modsFor(p: Player, t: UnitType): Mods {
  const e = techBonus(p, t.id)
  // The Armour works adds its plate to the hull research, rather than multiplying it.
  const plate = p.armour && plated(t) ? MODULE_FX.armour : 0
  const mods: Mods = { hull: 1 + (e.hull ?? 0) + plate, shield: 1 + (e.shield ?? 0), regen: 1 + (e.regen ?? 0), damage: 1 + (e.damage ?? 0), speed: 1 + (e.speed ?? 0), cooldown: 1 + (e.cooldown ?? 0), range: 1 + (e.range ?? 0) }
  // The faction mechanics' research: set only when some research changes them.
  if (e.shieldDamage) mods.shieldDamage = 1 + e.shieldDamage
  if (e.aura) mods.aura = e.aura
  if (e.auraRadius) mods.auraRadius = 1 + e.auraRadius
  // Living hulls also take the station's regrowth research, which is for every unit of the side.
  const st = t.id === stationOf(p) ? {} : techBonus(p, stationOf(p))
  const regrow = (e.regrow ?? 0) + (st.regrow ?? 0)
  const regrowDelay = (e.regrowDelay ?? 0) + (st.regrowDelay ?? 0)
  if (regrow) mods.regrow = 1 + regrow
  if (regrowDelay) mods.regrowDelay = Math.max(0, 1 + regrowDelay)
  if (e.drain) mods.drain = 1 + e.drain
  if (e.drainHeal) mods.drainHeal = 1 + e.drainHeal
  if (e.drainTargets) mods.drainTargets = e.drainTargets
  if (e.shieldAura) mods.shieldAura = e.shieldAura
  return mods
}
/** A fire-control aura as it stands for `u`: its type's, with its research (TechEffect aura and
 * auraRadius). Null for a unit without one. */
export function auraOf(u: Unit): { radius: number; bonus: number } | null {
  const f = u.t.fireControl
  if (!f) return null
  return { radius: f.radius * (u.mods.auraRadius ?? 1), bonus: f.bonus + (u.mods.aura ?? 0) }
}
/** A shield-projector aura as it stands for `u`: its type's, with its research (TechEffect
 * shieldAura, added to its regen, and auraRadius). Null for a unit without one. */
export function shieldAuraOf(u: Unit): { radius: number; regen: number } | null {
  const s = u.t.shieldAura
  if (!s) return null
  return { radius: s.radius * (u.mods.auraRadius ?? 1), regen: s.regen + (u.mods.shieldAura ?? 0) }
}
/** Whether a shield projector is projecting: built, alive, and (if it has shield generators) with
 * one of them standing. */
export const projecting = (u: Unit) => !!u.t.shieldAura && !u.dead && !building(u) && !u.site && !u.launch && share(u, 'shield') > 0
/** A living hull's regrowth as it stands for `u`, with its research (TechEffect regrow and
 * regrowDelay). Null for a unit without one. */
export function regrowOf(u: Unit): { rate: number; delay: number } | null {
  const g = u.t.regrow
  if (!g) return null
  return { rate: g.rate * (u.mods.regrow ?? 1), delay: g.delay * (u.mods.regrowDelay ?? 1) }
}
/** Seconds since anything last hurt `u`: an enemy's hit, or rocks in an asteroid field. A living
 * hull grows back only once this is past its wait. */
export const calm = (w: World, u: Unit) => w.time - Math.max(u.lastHit, u.scraped ?? -99)
/** A drain aura as it stands for `u`, with its research (TechEffect drain, drainHeal and
 * drainTargets, which adds to how many enemies it bites at once). */
export function drainOf(u: Unit): { radius: number; dps: number; heal: number; targets: number } | null {
  const d = u.t.drain
  if (!d) return null
  return { radius: d.radius, dps: d.dps * (u.mods.drain ?? 1), heal: d.heal * (u.mods.drainHeal ?? 1), targets: d.targets + (u.mods.drainTargets ?? 0) }
}
const stationOf = (p: Player) => unitOf(p.faction, 'station').id
/** Whether one of a unit's own hangars stands (a Strike hangar doesn't count: it only launches bombers). */
const hangarsUp = (u: Unit) => u.t.hardpoints.some((h, i) => h.kind === 'hangar' && !h.exp && alive(u, i))
export const building = (u: Unit) => u.building > 0

/** Damage per second a type deals to each tier: for picking targets. */
const DPS = new WeakMap<UnitType, Record<string, number>>()
export function dpsVs(t: UnitType, tier: Tier) {
  let row = DPS.get(t)
  if (!row) {
    row = {}
    const ws = [...t.weapons, ...t.hardpoints.flatMap((h) => (h.weapon ? [h.weapon] : []))]
    for (const tr of ['fighter', 'gunship', 'frigate', 'cruiser', 'capital', 'station', 'mine', 'defense'] as Tier[])
      row[tr] = ws.reduce((s, w) => s + (w.damage * (w.burst ?? 1) * effect(w.kind, tr) * accuracy(w.kind, tr)) / w.cooldown, 0)
    DPS.set(t, row)
  }
  return row[tier]
}
/** The range a ship closes to before it stops and fights. */
function fightRange(t: UnitType) {
  const ws = [...t.weapons, ...t.hardpoints.flatMap((h) => (h.weapon ? [h.weapon] : []))]
  if (!ws.length) return 0
  const best = ws.reduce((a, b) => (b.damage / b.cooldown > a.damage / a.cooldown ? b : a))
  return best.range
}

/** How much nearer than the shortest of its guns' reach a warship stops, so a target edging
 * away or a nudge from a neighbour doesn't put it out of range at once. */
const STOP_MARGIN = 0.92

/** A gun's damage a second against a tier, counting only weapons it would actually fire at it
 * (the same lower limit `shoot` uses for a ship's target). */
function gunDps(g: Gun, tier: Tier) {
  const eff = effect(g.w.kind, tier)
  return eff < 0.3 ? 0 : (g.w.damage * (g.w.burst ?? 1) * eff * accuracy(g.w.kind, tier)) / g.w.cooldown
}

/**
 * The guns worth closing in for against a tier: working ones it would fire at it that add real
 * damage next to the best of them (a fifth of it or more). So flak doesn't count against a
 * capital ship or a station, nor a cruiser's slow flak against a frigate, but a gunship's flak
 * does against fighters and gunships, and a flagship's flak and turbolasers both do against
 * fighters. Empty when nothing it carries is any use against that tier.
 */
export function relevantGuns(u: Unit, tier: Tier): Gun[] {
  const live = u.guns.filter((g) => g.hp < 0 || alive(u, g.hp))
  const best = live.reduce((m, g) => Math.max(m, gunDps(g, tier)), 0)
  return best > 0 ? live.filter((g) => gunDps(g, tier) >= best * 0.2) : []
}

/** How far a gun reaches measured from the ship's centre: its range, less how far its hardpoint
 * sits out to the side or behind the centre. A ship at its spot turns its nose to the target, so
 * a gun further forward is never further away; one aft or out on a wing may be. */
function gunReach(u: Unit, g: Gun) {
  const r = g.w.range * u.mods.range
  if (g.hp < 0) return r
  const [w, h] = dims(u.t)
  const p = u.t.hardpoints[g.hp]
  return r - M.hypot((p.x / 10 - 0.5) * w, Math.max(0, (p.y / 10 - 0.5) * h))
}

/**
 * Where a warship attacking `e` stops, as a distance between their centres: as soon as every gun
 * that counts against it (see relevantGuns) reaches, with a little to spare. A gun reaches a
 * target once its centre is within range plus half the target's radius (see `shoot`), so that is
 * measured the same way. `reach` is where the shortest of those guns stops reaching. A ship with
 * nothing that counts closes to its best gun's range, as before.
 */
export function stopDistance(u: Unit, e: Unit): { stop: number; reach: number } {
  const guns = relevantGuns(u, e.t.tier)
  const half = radius(e.t) * 0.5
  if (!guns.length) {
    const stop = fightRange(u.t) * u.mods.range * 0.8 + half
    return { stop, reach: stop / 0.8 }
  }
  const short = Math.max(20, Math.min(...guns.map((g) => gunReach(u, g))))
  return { stop: short * STOP_MARGIN + half, reach: short + half }
}

// --- Setup -----------------------------------------------------------------------------------------

/** A unit's guns: its own weapons, then one per armed hardpoint. */
const gunsOf = (w: World, t: UnitType): Gun[] =>
  [...t.weapons.map((wp) => ({ w: wp, hp: -1 })), ...t.hardpoints.flatMap((h, i) => (h.weapon ? [{ w: h.weapon, hp: i }] : []))].map((g) => ({
    ...g, cd: rand(w) * g.w.cooldown, burst: 0, burstT: 0, target: 0, aim: 0, focus: 0,
  }))

export function spawn(w: World, id: string, owner: Owner, x: number, y: number, a: number, squad = 0): Unit {
  const p = w.players[owner]
  const t = UNIT[id].tier === 'station' ? stationType(p.faction, p.level, p.techs) : UNIT[id]
  const mods = modsFor(p, t)
  const hullMax = t.hull * mods.hull
  const u: Unit = {
    id: w.nextId++, t, owner, x, y, a, v: 0, hull: hullMax, hullMax, shield: t.shield * mods.shield, mods,
    hps: t.hardpoints.map((h) => ({ hp: h.hp, max: h.hp })),
    guns: gunsOf(w, t),
    order: { k: 'idle' }, ax: x, ay: y, squad, parent: 0, target: 0, retarget: rand(w) * 0.5, lastHit: -99, shieldHit: -99, shieldOut: -99, hitAngle: 0,
    abilityCd: 0, abilityOn: 0, slow: 0, hangarT: 0, building: 0, node: -1, dead: false, born: w.time, kills: 0, xp: 0, rank: 0, stance: 'maneuver', gx: x, gy: y, hitBy: 0, nebula: false, route: null, queue: [], mending: [], aid: 0, breakOff: false, face: null, repair: 0, retreat: 0, focus: 0, upg: {}, upgrading: null, slot: null,
    seen: Array.from({ length: w.teams }, (_, t) => t === w.players[owner].team),
  }
  w.units.push(u)
  w.byId.set(u.id, u)
  return u
}

/** A whole order's worth: one ship, or a squadron of fighters in a loose vee. */
export function spawnGroup(w: World, id: string, owner: Owner, x: number, y: number, a: number) {
  const t = UNIT[id]
  const squad = t.squad > 1 ? w.squadSeq++ : 0
  const out: Unit[] = []
  for (let i = 0; i < t.squad; i++) {
    const row = Math.ceil(i / 2)
    const side = i === 0 ? 0 : i % 2 ? -1 : 1
    const back = row * 26
    const off = side * row * 24
    out.push(spawn(w, id, owner, x - M.cos(a) * back - M.sin(a) * off, y - M.sin(a) * back + M.cos(a) * off, a, squad))
  }
  return out
}

/** One player at the start of a battle. */
/** `at` is where the station goes; the map's spawn point when left out. */
export type Seat = { faction: FactionId; team: number; spawn: number; incomeMul?: number; at?: Pt }

/** Why a station can't start at (x, y), or null when it can: it needs open space, clear of rocks,
 * fields, ore, beacons, wrecks and the other stations (`others`). Rocks don't depend on where
 * stations start, so any world on the map will do for checking. */
export function startProblem(w: World, x: number, y: number, others: Pt[]): string | null {
  if (x < 350 || y < 350 || x > w.w - 350 || y > w.h - 350) return 'Too close to the edge of the map'
  if (others.some((o) => d2(x, y, o.x, o.y) < sq(mapDist(1400)))) return 'Too close to another station'
  if (w.rocks.some((k) => d2(x, y, k.x, k.y) < sq(k.r + 380))) return 'Too close to the rocks'
  if (inside(w.map.fields, x, y, 300)) return 'Inside an asteroid field'
  if (w.nodes.some((n) => d2(x, y, n.x, n.y) < sq(450))) return 'Too close to an ore asteroid'
  if (w.beacons.some((b) => d2(x, y, b.x, b.y) < sq(500))) return 'Too close to a beacon'
  if (w.wrecks.some((h) => d2(x, y, h.x, h.y) < sq(h.size * 0.6 + 300))) return 'Too close to a wreck'
  return null
}

/** Where an AI (or a player who doesn't pick) starts in its area: the map's spawn point when it's
 * in the area and free, otherwise the open spot with the most ore within reach. */
export function autoStart(w: World, area: { x: number; y: number; w: number; h: number }, spawnAt: Pt, others: Pt[]): Pt {
  const inArea = (p: Pt) => p.x >= area.x && p.y >= area.y && p.x <= area.x + area.w && p.y <= area.y + area.h
  if (inArea(spawnAt) && !startProblem(w, spawnAt.x, spawnAt.y, others)) return { ...spawnAt }
  const mid = { x: area.x + area.w / 2, y: area.y + area.h / 2 }
  const diag = M.hypot(area.w, area.h) || 1
  let best: Pt | null = null
  let bestScore = -Infinity
  const N = 14
  for (let i = 0; i <= N; i++)
    for (let j = 0; j <= N; j++) {
      const p = { x: area.x + (area.w * i) / N, y: area.y + (area.h * j) / N }
      if (startProblem(w, p.x, p.y, others)) continue
      const ore = w.nodes.reduce((sum, n) => sum + M.exp(-M.hypot(n.x - p.x, n.y - p.y) / mapDist(1100)), 0)
      const score = ore - (M.hypot(p.x - mid.x, p.y - mid.y) / diag) * 0.6
      if (score > bestScore) {
        bestScore = score
        best = p
      }
    }
  return best ?? mid
}

/** `reinforce`: the lobby's reinforcement rules (REINFORCE when left out). */
export function newWorld(map: MapDef, seats: Seat[], opts: { seed?: number; credits?: number; fleet?: boolean; reinforce?: Reinforce } = {}): World {
  const r = rng(opts.seed ?? map.seed)
  const W = map.w
  const H = map.h
  const c = { x: W / 2, y: H / 2 }
  const teams = Math.max(...seats.map((s) => s.team)) + 1
  const w: World = {
    w: W, h: H, time: 0, units: [], byId: new Map(), players: [], teams, map, nodes: [], beacons: [], rocks: [], wrecks: [], shots: [], events: [],
    nextId: 1, squadSeq: 1, wreckSeq: 1000, rs: ((opts.seed ?? map.seed) ^ 0x9e3779b9) >>> 0, winner: -1, grid: new Map(), seenT: 0, nav: new Map(), arrivals: [],
    // Skirmishes and multiplayer battles have hybrid bases; galactic conquest's fleet battles don't.
    // New ships fly out of the yards, and reinforcements cost extra (see Reinforce).
    ...(opts.fleet ? {} : { hybrid: true, ruins: [], reinforce: cleanReinforce(opts.reinforce) }),
  }
  w.players = seats.map((s) => {
    const sp = s.at ?? map.spawns[s.spawn]
    const d = M.hypot(c.x - sp.x, c.y - sp.y) || 1
    return {
      faction: s.faction, team: s.team, spawn: s.spawn, start: { x: sp.x, y: sp.y }, alive: true, credits: opts.credits ?? START_CREDITS, income: 0, incomeMul: s.incomeMul ?? 1, level: 1, station: 0,
      queue: [], reserve: [], research: [], techs: [], rally: { x: sp.x + ((c.x - sp.x) / d) * mapDist(600), y: sp.y + ((c.y - sp.y) / d) * mapDist(600) }, pop: 0, popCap: BASE_POP, lastAlarm: -99,
      stats: { built: 0, lost: 0, killed: 0, earned: 0 },
      incomeParts: { station: 0, mines: 0, beacons: 0 },
      earnedBy: { station: 0, mines: 0, beacons: 0, salvage: 0, refunds: 0 },
      spentBy: { ships: 0, research: 0, structures: 0, repairs: 0 },
      ledger: [],
      refunds: [],
      history: [],
      escaped: [],
    }
  })
  const claim = { owner: -1, claim: -1, progress: 0 }
  w.nodes = map.ore.map((p, id) => ({ id, x: p.x, y: p.y, r: 75, rot: r() * TAU, site: 0, ...claim }))
  w.beacons = map.beacons.map((p, id) => ({ id, x: p.x, y: p.y, ...claim }))
  // Scattered rocks: each one is copied to every side by the map's symmetry, so nobody gets the
  // better lanes. They keep clear of ore, beacons, asteroid fields and the lanes into the middle
  // (wide enough for the biggest flagship to fly down, with a cell of the path finding's grid to
  // spare: without them a Big flagship often found no way through at all and sat at the first
  // gap too narrow for it), and of the ground round each station's start where its yards go up
  // (the build radius).
  // Map wrecks: the big hulks of earlier battles, Republic or droid as the seed falls.
  w.wrecks = map.wrecks.map((h, i) => {
    const big = h.value >= 900
    const side = r() < 0.5 ? 'republic' : 'droid'
    return { id: i + 1, x: h.x, y: h.y, value: h.value, left: h.value, sprite: `${side}-${big ? 'capital' : 'cruiser'}`, size: big ? 340 : 220, rot: r() * TAU, decay: Infinity, team: -1 }
  })
  const keepClear = [...w.wrecks.map((h) => [h.x, h.y, h.size * 0.6]), ...w.nodes.map((n) => [n.x, n.y, 260]), ...w.beacons.map((b) => [b.x, b.y, 330]), ...map.spawns.map((p) => [p.x, p.y, BUILD_RADIUS])]
  const lane = Math.max(240, ...UNITS.filter(isShip).map((t) => navClear(t) + 100))
  const inLane = (x: number, y: number, rad: number) =>
    map.spawns.some((p) => {
      // Distance from the point to the segment between this spawn and the centre.
      const vx = c.x - p.x
      const vy = c.y - p.y
      const t = clamp(((x - p.x) * vx + (y - p.y) * vy) / (vx * vx + vy * vy), 0, 1)
      return d2(x, y, p.x + vx * t, p.y + vy * t) < sq(lane + rad)
    })
  let tries = 0
  while (w.rocks.length < map.rocks && tries++ < 4000) {
    const cx = 250 + r() * (W - 500)
    const cy = 200 + r() * (H - 400)
    const rad = 30 + sq(r()) * 110
    const copies = mirrored(map, { x: cx, y: cy })
    const ok = copies.every(
      (p) =>
        p.x > 150 && p.y > 150 && p.x < W - 150 && p.y < H - 150 &&
        !keepClear.some(([x, y, cc]) => d2(p.x, p.y, x, y) < sq(cc + rad)) &&
        !inLane(p.x, p.y, rad) &&
        !inside(map.fields, p.x, p.y, rad + 60) &&
        !w.rocks.some((k) => d2(p.x, p.y, k.x, k.y) < sq(k.r + rad + 40)),
    )
    if (!ok) continue
    const kind = r() < 0.5 ? 0 : 1
    const rot = r() * TAU
    const spin = (r() - 0.5) * 0.1
    copies.forEach((p, i) => w.rocks.push({ x: p.x, y: p.y, r: rad, rot: rot + i * 2.1, spin, kind }))
  }
  // Stations, facing the middle, and a starting patrol in front of each. Ore has to be surveyed
  // before anything is built on it.
  if (!opts.fleet) w.players.forEach((p, o) => {
    const sp = p.start
    const face = M.atan2(c.y - sp.y, c.x - sp.x)
    const fx = M.cos(face)
    const fy = M.sin(face)
    const at = (ahead: number, side: number) => ({ x: sp.x + fx * ahead - fy * side, y: sp.y + fy * ahead + fx * side })
    const st = spawn(w, unitOf(p.faction, 'station').id, o, sp.x, sp.y, face - Math.PI / 2)
    p.station = st.id
    spawnWing(w, st)
    const f1 = at(420, -120)
    const g1 = at(380, 140)
    const g2 = at(470, 230)
    spawnGroup(w, unitOf(p.faction, 'fighter').id, o, f1.x, f1.y, face)
    spawn(w, unitOf(p.faction, 'gunship').id, o, g1.x, g1.y, face)
    spawn(w, unitOf(p.faction, 'gunship').id, o, g2.x, g2.y, face)
  })
  refreshPlayers(w)
  return w
}

// --- Orders ------------------------------------------------------------------------------------------

/** A ship that takes orders: ours, and not spooling up to jump out. */
const commandable = (u: Unit | undefined, owner: Owner): u is Unit => !!u && !u.dead && u.owner === owner && isShip(u.t) && u.retreat <= 0

/**
 * A spot a ship can actually reach: moved out to the edge of any rock it falls inside, and clear of
 * every structure (station, platform), which never budge while a warship keeps HULL_GAP clear of
 * every hull: a spot overlapping one could never be reached, and the ship would be pushed back from
 * it for ever. Big hulls made that easy to run into. Two passes, for a spot between two.
 */
function offRocks(w: World, u: Unit, x: number, y: number): Pt {
  if (u.t.tier === 'fighter') return { x, y }
  const away = (cx: number, cy: number, R: number) => {
    const dd = d2(x, y, cx, cy)
    if (dd >= R * R) return
    const d = Math.sqrt(dd)
    // Dead centre: come out on the side the ship is coming from.
    const nx = d > 1 ? (x - cx) / d : (u.x - cx) / (M.hypot(u.x - cx, u.y - cy) || 1)
    const ny = d > 1 ? (y - cy) / d : (u.y - cy) / (M.hypot(u.x - cx, u.y - cy) || 1)
    x = cx + nx * R
    y = cy + ny * R
  }
  const clear = radius(u.t) * 0.7 + 10
  for (const k of w.rocks) away(k.x, k.y, k.r + clear)
  const r0 = radius(u.t)
  for (let pass = 0; pass < 2; pass++)
    for (const o of w.units) if (!o.dead && !isShip(o.t) && !planned(o)) away(o.x, o.y, r0 + radius(o.t) + HULL_GAP + 6)
  return { x: clamp(x, 40, w.w - 40), y: clamp(y, 40, w.h - 40) }
}

/** Give a ship an order now, or, queued, after the ones it already has (straight away if it has
 * none). An order given now drops anything queued. */
function issue(u: Unit, o: Order, queued = false) {
  if (queued && (u.order.k !== 'idle' || u.queue.length)) {
    u.queue.push(o)
    return
  }
  u.order = o
  u.queue = []
  u.target = o.k === 'attack' ? o.id : 0
  // Carrier fighters given orders go their own way; a defense wing stays its station's, and
  // comes home once its orders are done.
  if (u.t.kind !== 'wing') u.parent = 0
  u.face = null
  // New orders call off a Field repair run.
  u.aid = 0
}

/** Where a ship will be once its current and queued orders are done: where a queued patrol starts. */
export function lastStop(w: World, u: Unit): Pt {
  for (const o of [...u.queue].reverse().concat(u.order)) {
    if (o.k === 'move' || o.k === 'patrol' || o.k === 'area') return { x: o.x, y: o.y }
    if (o.k === 'guard' || o.k === 'construct' || o.k === 'mend') {
      const t = w.byId.get(o.id)
      if (t && !t.dead) return { x: t.x, y: t.y }
    }
    if (o.k === 'attack') {
      const t = w.byId.get(o.id)
      if (t && !t.dead) return { x: t.x, y: t.y }
    }
  }
  return { x: u.x, y: u.y }
}

/** The current order is done: on to the next queued one, or wait at (x, y). */
function nextOrder(u: Unit, x: number, y: number, face: number | null = null) {
  const o = u.queue.shift()
  if (o) {
    u.order = o
    u.target = o.k === 'attack' ? o.id : 0
    return
  }
  u.order = { k: 'idle' }
  u.ax = x
  u.ay = y
  u.face = face
}

function formation(w: World, owner: Owner, ids: number[], x: number, y: number, give: (u: Unit, tx: number, ty: number, pace: number) => void) {
  const us = ids.map((i) => w.byId.get(i)).filter((u) => commandable(u, owner))
  if (!us.length) return
  const cx = us.reduce((s, u) => s + u.x, 0) / us.length
  const cy = us.reduce((s, u) => s + u.y, 0) / us.length
  const spread = Math.max(1, ...us.map((u) => M.hypot(u.x - cx, u.y - cy)))
  const fit = Math.min(1, ((90 + Math.sqrt(us.length) * 70) * spreadOf(us)) / spread)
  // A group keeps the pace of its slowest ship.
  const pace = us.length > 1 ? Math.min(...us.map((u) => speedOf(u))) : Infinity
  for (const u of us) {
    const p = offRocks(w, u, clamp(x + (u.x - cx) * fit, 40, w.w - 40), clamp(y + (u.y - cy) * fit, 40, w.h - 40))
    give(u, p.x, p.y, pace)
  }
}

export function cmdMove(w: World, owner: Owner, ids: number[], x: number, y: number, attack = false, queued = false) {
  formation(w, owner, ids, x, y, (u, tx, ty, speed) => issue(u, { k: 'move', x: tx, y: ty, attack, speed }, queued))
}

/** A drawn line that comes back round to where it started: ships spread round it as a ring. */
export function closedLoop(path: Pt[]) {
  if (path.length < 4) return false
  let len = 0
  for (let i = 1; i < path.length; i++) len += M.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y)
  const a = path[0]
  const b = path[path.length - 1]
  return len > 500 && M.hypot(b.x - a.x, b.y - a.y) < Math.max(160, len * 0.15)
}

/** `n` spots spread evenly along a drawn line, from one end to the other (one ship: the middle),
 * or evenly round it when it's a closed loop. */
export function spreadAlong(path: Pt[], n: number): Pt[] {
  const ring = closedLoop(path)
  if (ring) path = [...path, path[0]]
  const cum = [0]
  for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + M.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y))
  const total = cum[cum.length - 1]
  const at = (d: number): Pt => {
    let i = 1
    while (i < path.length - 1 && cum[i] < d) i++
    const seg = cum[i] - cum[i - 1] || 1
    const t = clamp((d - cum[i - 1]) / seg, 0, 1)
    return { x: path[i - 1].x + (path[i].x - path[i - 1].x) * t, y: path[i - 1].y + (path[i].y - path[i - 1].y) * t }
  }
  return Array.from({ length: n }, (_, i) => at(ring ? (total * i) / n : n === 1 ? total / 2 : (total * i) / (n - 1)))
}

/** What gets one spot on a line: each ship, except that a fighter squadron shares one. */
export function lineGroups(w: World, owner: Owner, ids: number[]): Unit[][] {
  const groups = new Map<string, Unit[]>()
  for (const i of ids) {
    const u = w.byId.get(i)
    if (!commandable(u, owner)) continue
    const k = u.squad ? `s${u.squad}` : `u${u.id}`
    const g = groups.get(k)
    if (g) g.push(u)
    else groups.set(k, [u])
  }
  return [...groups.values()]
}

/**
 * Spots for a squadron round (x, y), facing `heading`: the first in front, the rest paired off in
 * a vee behind it, centred on (x, y), `gap` apart.
 */
export function veeSpots(n: number, x: number, y: number, heading: number, gap: number): Pt[] {
  const fx = M.cos(heading)
  const fy = M.sin(heading)
  const off = Array.from({ length: n }, (_, i) => {
    const row = Math.ceil(i / 2)
    const side = i === 0 ? 0 : i % 2 ? -1 : 1
    return { back: row * gap * 0.75, lat: side * row * gap }
  })
  const mb = off.reduce((s, o) => s + o.back, 0) / n
  return off.map((o) => ({ x: x - fx * (o.back - mb) - fy * o.lat, y: y - fy * (o.back - mb) + fx * o.lat }))
}
const squadGap = (u: Unit) => radius(u.t) * 2 + 18

/** Where each ship of a group goes: one ship to the spot, a squadron to its own places in a vee
 * round it, each fighter to the place on its own side so their paths don't cross. */
function groupSpots(w: World, g: Unit[], x: number, y: number, heading: number): { u: Unit; x: number; y: number }[] {
  if (g.length === 1) {
    const p = offRocks(w, g[0], clamp(x, 40, w.w - 40), clamp(y, 40, w.h - 40))
    return [{ u: g[0], x: p.x, y: p.y }]
  }
  const lat = (p: Pt) => -M.sin(heading) * p.x + M.cos(heading) * p.y
  const spots = veeSpots(g.length, x, y, heading, squadGap(g[0]))
  const ships = [...g].sort((a, b) => lat(a) - lat(b))
  const places = spots.map((p, i) => ({ p, i })).sort((a, b) => lat(a.p) - lat(b.p))
  return ships.map((u, i) => {
    const p = offRocks(w, u, clamp(places[i].p.x, 40, w.w - 40), clamp(places[i].p.y, 40, w.h - 40))
    return { u, x: p.x, y: p.y }
  })
}

/**
 * Where each ship goes for a line the player drew: groups (a ship, or a squadron) spread evenly
 * along it, handed out in the order they stand across it so they don't cross each other's paths,
 * and round it when it's a closed loop. The order preview draws these same spots.
 */
export function lineTargets(w: World, owner: Owner, ids: number[], path: Pt[]): { u: Unit; x: number; y: number }[] {
  const groups = lineGroups(w, owner, ids)
  if (!groups.length || path.length < 2) return []
  let spots = spreadAlong(path, groups.length)
  const a = path[0]
  const b = path[path.length - 1]
  const dx = b.x - a.x
  const dy = b.y - a.y
  const mid = (g: Unit[]) => ({ x: g.reduce((s, u) => s + u.x, 0) / g.length, y: g.reduce((s, u) => s + u.y, 0) / g.length })
  let order = groups.map((g) => ({ g, c: mid(g) })).sort((p, q) => (p.c.x - q.c.x) * dx + (p.c.y - q.c.y) * dy)
  if (closedLoop(path)) {
    // Round a ring: ships in order of their bearing from its middle, spots likewise, turned to
    // whichever start makes the shortest trip overall.
    const cx = spots.reduce((s, p) => s + p.x, 0) / spots.length
    const cy = spots.reduce((s, p) => s + p.y, 0) / spots.length
    const bearing = (p: Pt) => M.atan2(p.y - cy, p.x - cx)
    order = groups.map((g) => ({ g, c: mid(g) })).sort((p, q) => bearing(p.c) - bearing(q.c))
    const round = [...spots].sort((p, q) => bearing(p) - bearing(q))
    let best = 0
    let bestD = Infinity
    for (let k = 0; k < round.length; k++) {
      const d = order.reduce((s, o, i) => s + M.hypot(o.c.x - round[(i + k) % round.length].x, o.c.y - round[(i + k) % round.length].y), 0)
      if (d < bestD) {
        bestD = d
        best = k
      }
    }
    spots = order.map((_, i) => round[(i + best) % round.length])
  }
  // A squadron's vee points the way it flies there.
  return order.flatMap(({ g, c }, i) => groupSpots(w, g, spots[i].x, spots[i].y, M.atan2(spots[i].y - c.y, spots[i].x - c.x)))
}

/** Spread ships evenly along a line the player drew (see lineTargets). */
export function cmdLine(w: World, owner: Owner, ids: number[], path: Pt[], attack = false, queued = false) {
  const targets = lineTargets(w, owner, ids, path)
  // A line keeps the pace of its slowest ship, like any group.
  const pace = targets.length > 1 ? Math.min(...targets.map((p) => speedOf(p.u))) : Infinity
  for (const p of targets) issue(p.u, { k: 'move', x: p.x, y: p.y, attack, speed: pace }, queued)
}

/**
 * Where ships go for a move that ends facing `face`: one ship or squadron straight to the spot (a
 * squadron's vee turned that way); a bigger selection keeps its formation, turned as a whole so
 * its front faces that way.
 */
export function faceTargets(w: World, owner: Owner, ids: number[], x: number, y: number, face: number) {
  const groups = lineGroups(w, owner, ids)
  if (groups.length <= 1) return groups.flatMap((g) => groupSpots(w, g, x, y, face))
  const all = groups.flat()
  const cx = all.reduce((s, u) => s + u.x, 0) / all.length
  const cy = all.reduce((s, u) => s + u.y, 0) / all.length
  const spread = Math.max(1, ...all.map((u) => M.hypot(u.x - cx, u.y - cy)))
  const fit = Math.min(1, ((90 + Math.sqrt(all.length) * 70) * spreadOf(all)) / spread)
  // Turned from the way it would fly there to the way it should face.
  const turn = face - M.atan2(y - cy, x - cx)
  const c = M.cos(turn)
  const sn = M.sin(turn)
  return groups.flatMap((g) => {
    const gx = (g.reduce((s, u) => s + u.x, 0) / g.length - cx) * fit
    const gy = (g.reduce((s, u) => s + u.y, 0) / g.length - cy) * fit
    return groupSpots(w, g, x + gx * c - gy * sn, y + gx * sn + gy * c, face)
  })
}

/** Move to (x, y) and turn to `face` there: what dragging with the right button does for one ship
 * or one squadron. */
export function cmdFace(w: World, owner: Owner, ids: number[], x: number, y: number, face: number, attack = false, queued = false) {
  const targets = faceTargets(w, owner, ids, x, y, face)
  const pace = targets.length > 1 ? Math.min(...targets.map((p) => speedOf(p.u))) : Infinity
  for (const p of targets) issue(p.u, { k: 'move', x: p.x, y: p.y, attack, speed: pace, face }, queued)
}

export function cmdPatrol(w: World, owner: Owner, ids: number[], x: number, y: number, queued = false) {
  formation(w, owner, ids, x, y, (u, tx, ty, speed) => {
    // A queued patrol runs between where the earlier orders leave the ship and here.
    const from = queued ? lastStop(w, u) : u
    issue(u, { k: 'patrol', x: tx, y: ty, bx: from.x, by: from.y, speed, sx: from.x, sy: from.y, ex: tx, ey: ty }, queued)
  })
}

/** Whether an enemy is inside an area order's circle (any part of its hull counts). */
const inArea = (o: { x: number; y: number; r: number }, e: Unit) => d2(e.x, e.y, o.x, o.y) < sq(o.r + radius(e.t) * 0.5)

/**
 * The target a ship takes under an area order: the enemy in the circle its guns hurt most, made
 * less attractive by the firepower already on it from the rest of the order, measured against how
 * much it can take. So the ships spread over the targets in proportion instead of all piling onto
 * one, and a ship that's already on a target keeps it unless something is clearly better.
 */
function areaTarget(w: World, u: Unit, o: { x: number; y: number; r: number }, cur: Unit | undefined): Unit | undefined {
  const onIt = new Map<number, number>()
  for (const m of w.units) {
    if (m === u || m.dead || m.owner !== u.owner || m.order.k !== 'area' || !m.target) continue
    const e = w.byId.get(m.target)
    if (e) onIt.set(e.id, (onIt.get(e.id) ?? 0) + dpsVs(m.t, e.t.tier))
  }
  let best: Unit | undefined
  let score = 0
  for (const e of w.units) {
    if (e.dead || !foes(w, e.owner, u.owner) || !sees(w, u.owner, e) || !inArea(o, e)) continue
    const mine = dpsVs(u.t, e.t.tier)
    if (mine <= 0) continue
    // Seconds the target would last against what's already on it: the longer, the more it needs us.
    const toughness = e.hull + e.shield + 1
    const covered = (onIt.get(e.id) ?? 0) / toughness
    const near = 1 / (1 + M.hypot(e.x - u.x, e.y - u.y) / 1500)
    const sc = (mine / (1 + covered * 30)) * near * (e === cur ? 1.25 : 1)
    if (sc > score) {
      score = sc
      best = e
    }
  }
  return best
}

/** Attack everything inside the circle at (x, y): every selected ship takes a share of the targets. */
export function cmdArea(w: World, owner: Owner, ids: number[], x: number, y: number, r: number, queued = false) {
  for (const id of ids) {
    const u = w.byId.get(id)
    if (commandable(u, owner)) issue(u, { k: 'area', x, y, r }, queued)
  }
}

/** Structures that can be told what to fire on: ours, armed, built. */
const focusable = (u: Unit | undefined, owner: Owner): u is Unit => !!u && !u.dead && u.owner === owner && !isShip(u.t) && !building(u) && u.guns.length > 0

/**
 * Tell structures what to fire on first: every gun, or with `hp` just the gun on that hardpoint of
 * the one structure. Guns that can't reach or can't hurt it keep choosing for themselves. A target
 * of 0 clears the focus.
 */
export function cmdFocus(w: World, owner: Owner, ids: number[], target: number, hp = -1, force = false): string | null {
  if (target && !valid(w, target, owner, force)) return 'Pick an enemy we can see'
  const structures = ids.map((i) => w.byId.get(i)).filter((u) => focusable(u, owner) && u!.id !== target) as Unit[]
  if (!structures.length) return 'Nothing selected has guns to aim'
  if (hp >= 0) {
    const g = structures[0].guns.find((x) => x.hp === hp)
    if (!g) return 'That part has no gun'
    g.focus = target
    return null
  }
  for (const u of structures) {
    u.focus = target
    // A new order for the whole structure overrides what single guns were told.
    for (const g of u.guns) g.focus = 0
  }
  return null
}

/** Guard a friendly ship or structure: the ships stay with it and fight off what comes near. */
export function cmdGuard(w: World, owner: Owner, ids: number[], id: number): string | null {
  const g = w.byId.get(id)
  if (!g || g.dead || foes(w, g.owner, owner)) return 'Pick one of our ships or structures to guard'
  let n = 0
  for (const i of ids) {
    const u = w.byId.get(i)
    if (u === g || !commandable(u, owner)) continue
    issue(u, { k: 'guard', id })
    n++
  }
  return n ? null : 'Nothing selected can guard'
}

/** Set how the ships answer enemies (see Stance). */
export function cmdStance(w: World, owner: Owner, ids: number[], stance: Stance) {
  for (const i of ids) {
    const u = w.byId.get(i)
    if (!commandable(u, owner)) continue
    u.stance = stance
    // Holding drops a chase at once; the others pick their fights again on the next look round.
    if (stance === 'hold' && u.order.k !== 'attack') u.target = 0
  }
}

/** Attack one target. `force` allows one of our own (the attack key or button, never a plain right-click). */
export function cmdAttack(w: World, owner: Owner, ids: number[], target: number, hp = -1, queued = false, force = false) {
  const t = w.byId.get(target)
  if (!t || t.dead || !(foes(w, t.owner, owner) || force)) return
  for (const i of ids) {
    const u = w.byId.get(i)
    if (u === t || !commandable(u, owner)) continue
    issue(u, { k: 'attack', id: target, hp: hp >= 0 && hp < t.hps.length ? hp : -1 }, queued)
  }
}

export function cmdStop(w: World, owner: Owner, ids: number[]) {
  for (const i of ids) {
    // Structures stop by dropping their focus: every gun picks its own targets again.
    const st = w.byId.get(i)
    if (focusable(st, owner)) {
      st.focus = 0
      for (const g of st.guns) {
        g.focus = 0
        g.target = 0
        g.burst = 0
      }
      continue
    }
    const u = w.byId.get(i)
    if (!commandable(u, owner)) continue
    u.order = { k: 'idle' }
    u.queue = []
    u.ax = u.x
    u.ay = u.y
    u.target = 0
    u.aid = 0
    for (const g of u.guns) {
      g.target = 0
      g.burst = 0
    }
  }
}

/**
 * Fire the abilities of a group's ships that are ready. `target` is a friendly ship or station for
 * Field repair (the one under the cursor); when it can't be mended, or none is given, repair craft
 * pick the most damaged one in reach themselves, and hold their ability when there is none.
 * Answers how many fired.
 */
export function cmdAbility(w: World, owner: Owner, ids: number[], target = 0) {
  let used = 0
  // The craft of one squadron go to the same patient.
  const bySquad = new Map<number, Unit | undefined>()
  for (const i of ids) {
    const u = w.byId.get(i)
    if (!u || u.dead || u.owner !== owner || !u.t.ability || u.abilityCd > 0) continue
    const ab = ABILITIES[u.t.ability]
    if (u.t.ability === 'fieldRepair') {
      if (building(u)) continue
      const given = w.byId.get(target)
      let to = given && !cantMend(w, owner, given) && d2(given.x, given.y, u.x, u.y) < sq(ab.range!) ? given : undefined
      if (!to) {
        if (!u.squad || !bySquad.has(u.squad)) bySquad.set(u.squad || -u.id, mendPick(w, u, ab.range!, 0))
        to = bySquad.get(u.squad || -u.id)
      }
      if (!to) continue
      startMend(w, u, to)
      used++
      continue
    }
    u.abilityCd = ab.cooldown
    u.abilityOn = ab.duration
    if (u.t.ability === 'shieldBoost') u.shield = Math.min(shieldMax(u), u.shield + shieldMax(u) * 0.5)
    if (u.t.ability === 'tractor')
      for (const e of w.units) if (!e.dead && foes(w, e.owner, owner) && isShip(e.t) && d2(e.x, e.y, u.x, u.y) < sq(ab.range!)) e.slow = ab.duration
    if (u.t.ability === 'launchSwarm') for (let k = 0; k < 2; k++) launch(w, u, true)
    w.events.push({ k: 'ability', owner, id: u.t.ability, x: u.x, y: u.y })
    used++
  }
  return used
}

/** Set where new ships gather: the station's rally point, or with `at` one of our yards'. */
export function cmdRally(w: World, owner: Owner, x: number, y: number, at = 0) {
  const to = { x: clamp(x, 40, w.w - 40), y: clamp(y, 40, w.h - 40) }
  if (!at) {
    w.players[owner].rally = to
    return
  }
  const yard = w.byId.get(at)
  if (yard && !yard.dead && yard.owner === owner && yard.yq) yard.yr = to
}

/** A player's yards that are built and working, oldest first. */
export const yardsOf = (w: World, o: Owner) => w.units.filter((u) => !u.dead && u.owner === o && u.t.tier === 'yard' && !building(u) && !!u.yq)
/** Everything a player has queued: at the station, then at each of its yards. */
export const allQueued = (w: World, o: Owner): QueueItem[] => [...w.players[o].queue, ...yardsOf(w, o).flatMap((y) => y.yq ?? [])]
const queuedPop = (w: World, o: Owner) => allQueued(w, o).reduce((s, q) => s + UNIT[q.unit].pop, 0)
const capitals = (w: World, o: Owner) =>
  w.units.filter((u) => !u.dead && u.owner === o && u.t.tier === 'capital').length +
  [...allQueued(w, o).map((q) => q.unit), ...w.players[o].reserve, ...w.arrivals.filter((a) => a.owner === o).map((a) => a.unit)].filter((id) => UNIT[id].tier === 'capital').length

/** How much of its income a mining platform brings in, from its working drill rigs and silo. */
export function mineOutput(u: Unit) {
  const parts = u.hps.length ? u.t.hardpoints.reduce((s, h, i) => s + (u.hps[i].hp > 0 ? (h.kind === 'drill' ? 0.4 : h.kind === 'refinery' ? 0.2 : 0) : 0), 0) : 1
  return parts * (1 + YIELD_PER_LEVEL * (u.upg.yield ?? 0))
}

// --- Platform upgrades --------------------------------------------------------------------------------

/** The next level of an upgrade for this structure: its price and time, or null when it's done. */
export function siteUpgradeNext(u: Unit, id: SiteUpgradeId) {
  const up = SITE_UPGRADES.find((x) => x.id === id)!
  const have = u.upg[id] ?? 0
  return have >= up.levels ? null : { level: have + 1, cost: up.cost[have], time: up.time }
}

export function cantUpgradeSite(w: World, owner: Owner, u: Unit | undefined, id: SiteUpgradeId): string | null {
  if (!u || u.dead || u.owner !== owner || u.t.tier !== 'mine') return 'Only our mining platforms take these upgrades'
  if (building(u)) return 'Still under construction'
  if (u.upgrading) return 'Already fitting an upgrade'
  const next = siteUpgradeNext(u, id)
  if (!next) return 'Fully upgraded'
  if (w.players[owner].credits < next.cost) return 'Not enough credits'
  return null
}

/** Fit an upgrade to one mining platform: paid now, done after its time. */
export function cmdUpgradeSite(w: World, owner: Owner, unitId: number, id: SiteUpgradeId): string | null {
  const u = w.byId.get(unitId)
  const why = cantUpgradeSite(w, owner, u, id)
  if (why) return why
  const next = siteUpgradeNext(u!, id)!
  const up = siteUpgradeOf(id, w.players[owner].faction)
  spend(w, w.players[owner], next.cost, 'structures', `${up.name}${up.levels > 1 ? ` ${next.level}` : ''}: ${u!.t.name}`)
  u!.upgrading = { id, left: next.time, total: next.time }
  return null
}

/** The upgrade being fitted to a platform, called off: what it cost comes back in full, nothing of it is applied. */
export function cmdCancelSiteUpgrade(w: World, owner: Owner, unitId: number): string | null {
  const u = w.byId.get(unitId)
  if (!u || u.dead || u.owner !== owner || !u.upgrading) return 'Nothing to cancel'
  const up = siteUpgradeOf(u.upgrading.id, w.players[owner].faction)
  const level = (u.upg[up.id] ?? 0) + 1
  cancelUpgrade(w, w.players[owner], up.cost[level - 1], 'structures', `${up.name}${up.levels > 1 ? ` ${level}` : ''}: ${u.t.name}`)
  u.upgrading = null
  return null
}

function siteUpgrades(w: World, dt: number) {
  for (const u of w.units) {
    if (u.dead || !u.upgrading) continue
    u.upgrading.left -= dt
    if (u.upgrading.left > 0) continue
    const id = u.upgrading.id
    u.upgrading = null
    u.upg[id] = (u.upg[id] ?? 0) + 1
    if (id === 'shield') {
      // The dome goes on (as tough as the platform's armour makes it); the shields charge from empty.
      retype(w, u, mineType(u.t.faction, true), u.upg.armor ? 1 + ARMOR_BONUS : 1)
      u.shield = 0
    }
    if (id === 'armor') {
      // The extra plating arrives whole: hull and every part grow, damage stays as it was.
      const k = 1 + ARMOR_BONUS
      u.hull += u.hullMax * (k - 1)
      u.hullMax *= k
      for (const h of u.hps) {
        h.hp += h.max * (k - 1)
        h.max *= k
      }
    }
    w.events.push({ k: 'upgraded', owner: u.owner, unit: u.id, id, level: u.upg[id]! })
  }
}

// --- Credits between allies -------------------------------------------------------------------------

/** The fewest seconds between two gifts from the same player, so a gift can't be spammed. */
export const GIFT_COOLDOWN = 1
/** The most one gift can carry: a sanity limit for what comes over the wire. */
export const GIFT_MAX = 10_000_000

/** Why `owner` can't send `amount` credits to `to` right now, or null when it can: only whole
 * credits above 0, only to a teammate still in the battle, at most what we have, and not again
 * within GIFT_COOLDOWN of the last one. Fleet battles (galactic conquest) have no allies. */
export function cantGive(w: World, owner: Owner, to: Owner, amount: number): string | null {
  const from = w.players[owner]
  const them = w.players[to]
  if (!Number.isInteger(amount) || amount <= 0 || amount > GIFT_MAX) return 'Send a whole number of credits, more than 0'
  if (!from || !them || to === owner || w.fleet) return 'Pick an ally to send credits to'
  if (foes(w, owner, to)) return 'Credits can only go to an ally'
  if (!them.alive) return 'That ally is out of the battle'
  if (amount > Math.floor(from.credits)) return `Not enough credits: you have ${Math.floor(from.credits).toLocaleString('en-US')}`
  if (from.lastGift !== undefined && w.time - from.lastGift < GIFT_COOLDOWN) return 'Wait a moment before sending more credits'
  return null
}

/** Send `amount` credits to the ally in seat `to`. */
export function cmdGive(w: World, owner: Owner, to: Owner, amount: number): string | null {
  const why = cantGive(w, owner, to, amount)
  if (why) return why
  const from = w.players[owner]
  const them = w.players[to]
  from.credits -= amount
  them.credits += amount
  from.lastGift = w.time
  from.gave = (from.gave ?? 0) + amount
  them.got = (them.got ?? 0) + amount
  note(w, from, -amount, 'gift', 'Sent to an ally', to)
  note(w, them, amount, 'gift', 'From an ally', owner)
  w.events.push({ k: 'gift', from: owner, to, amount })
  return null
}

// --- Repairs ---------------------------------------------------------------------------------------

/** Seconds a repair crew takes to make a structure whole again. */
export const REPAIR_TIME = 20
const REPAIRABLE: Tier[] = ['station', 'mine', 'defense', 'yard']
/** What a structure is worth when working out a repair's price (the station has no build cost). */
const worth = (u: Unit) => u.t.cost || 2500

/** How much of a unit is missing: hull and every module, as a share of the whole. */
function wear(u: Unit) {
  const max = u.hullMax + u.hps.reduce((s, h) => s + h.max, 0)
  const has = u.hull + u.hps.reduce((s, h) => s + Math.max(0, h.hp), 0)
  return max > 0 ? Math.max(0, 1 - has / max) : 0
}
/** Credits to repair a structure: 60% of its worth for what's missing. */
export const repairCost = (u: Unit) => Math.ceil(worth(u) * wear(u) * 0.6)

export function cantRepair(w: World, owner: Owner, u: Unit | undefined): string | null {
  if (!u || u.dead || u.owner !== owner) return 'Not ours'
  if (!REPAIRABLE.includes(u.t.tier)) return 'Only structures can be repaired here'
  if (building(u)) return 'Still under construction'
  if (u.repair > 0) return 'Already being repaired'
  if (wear(u) < 0.005) return 'Nothing to repair'
  if (w.players[owner].credits < repairCost(u)) return 'Not enough credits'
  return null
}

/** Send a repair crew: it mends the hull and every module, rebuilding the ones shot off, over
 * REPAIR_TIME seconds, under fire or not. */
export function cmdRepair(w: World, owner: Owner, id: number): string | null {
  const u = w.byId.get(id)
  const why = cantRepair(w, owner, u)
  if (why) return why
  spend(w, w.players[owner], repairCost(u!), 'repairs', `Repairs: ${u!.t.name}`)
  u!.repair = REPAIR_TIME
  return null
}

function repairs(w: World, dt: number) {
  for (const u of w.units) {
    if (u.dead || u.repair <= 0) continue
    u.repair -= dt
    const k = dt / REPAIR_TIME
    u.hull = Math.min(u.hullMax, u.hull + u.hullMax * k)
    u.hps.forEach((h) => (h.hp = Math.min(h.max, h.hp + h.max * k)))
    if (u.repair <= 0 || wear(u) < 0.001) {
      // Done: whatever rounding left over is made good.
      u.repair = 0
      u.hull = u.hullMax
      for (const h of u.hps) h.hp = h.max
      w.events.push({ k: 'repaired', owner: u.owner, unit: u.id, x: u.x, y: u.y })
    }
  }
}

// --- Retreat --------------------------------------------------------------------------------------

/** Seconds a warship's hyperspace drive takes to charge for a retreat, by class. */
export const RETREAT_TIME: Partial<Record<Tier, number>> = { gunship: 6, frigate: 8, cruiser: 10, capital: 12 }
/** What a retreat pays back: this share of the ship's cost at full health, less as it's damaged. */
export const RETREAT_REFUND = 0.5

export const canRetreat = (u: Unit) => !u.dead && isShip(u.t) && !u.parent && RETREAT_TIME[u.t.tier] !== undefined
/** Credits a ship would bring back by retreating now: half its cost, times its hull's health, and
 * up to a further 30% off for modules shot off or damaged. A wreck limping out brings back next to
 * nothing. */
export function retreatRefund(u: Unit) {
  const max = u.hps.reduce((s, h) => s + h.max, 0)
  const modules = max ? u.hps.reduce((s, h) => s + Math.max(0, h.hp), 0) / max : 1
  return Math.round((u.t.cost / u.t.squad) * RETREAT_REFUND * (u.hull / u.hullMax) * (0.7 + 0.3 * modules))
}

/**
 * Retreat: the selected gunships and bigger charge their hyperspace drives, holding still while
 * they do (their guns keep firing), then jump out and pay back part of their cost, freeing their
 * fleet space. If every one of them is already charging, the retreat is called off.
 */
export function cmdRetreat(w: World, owner: Owner, ids: number[]) {
  const ships = ids.map((i) => w.byId.get(i)).filter((u): u is Unit => !!u && u.owner === owner && canRetreat(u))
  if (!ships.length) return 'Fighters and bombers can\'t retreat: they have no hyperspace drive'
  if (ships.every((u) => u.retreat > 0)) {
    for (const u of ships) u.retreat = 0
    return null
  }
  for (const u of ships) {
    if (u.retreat > 0) continue
    u.retreat = RETREAT_TIME[u.t.tier]!
    u.order = { k: 'idle' }
    u.queue = []
    u.ax = u.x
    u.ay = u.y
    w.events.push({ k: 'retreating', owner, unit: u.t.id, x: u.x, y: u.y, secs: u.retreat })
  }
  return null
}

/** A charging warship: it slows to a stop and fires at what it can; when the drive is ready it's
 * gone, with its refund paid. No wreck, no kill for anyone. */
function retreating(w: World, u: Unit, dt: number) {
  u.retreat -= dt
  u.v = Math.max(0, u.v - u.t.speed * 0.8 * dt)
  if (u.retreat > 0) return
  u.retreat = 0
  const p = w.players[u.owner]
  // In a fleet battle the ship itself is saved: it rejoins its fleet.
  const refund = w.fleet ? 0 : retreatRefund(u)
  if (w.fleet) {
    p.escaped.push(u.t.id)
    if (u.rush) (p.escapedRush ??= []).push({ unit: u.t.id, built: 1 - u.rush.left / u.t.build, left: u.rush.left })
  }
  if (refund > 0) p.refunds.push({ at: w.time + REFUND_DELAY, amount: refund, unit: u.t.id })
  u.dead = true
  w.events.push({ k: 'retreated', owner: u.owner, unit: u.t.id, x: u.x, y: u.y, a: u.a, refund })
}

/** Strike craft launch from the station's hangar; everything bigger is built in the yards and
 * comes in from hyperspace. */
export const fromHangar = (t: UnitType) => t.tier === 'fighter'
/** Seconds from a jump starting to the ship dropping out: from the shipyard, and called in from
 * the reserve (a longer trip, and the warning the enemy gets). */
export const WARP_YARD = 1.6
export const WARP_RESERVE = 2.4
/** Share of its hull a ship loses dropping out inside an asteroid field (its shields go too). */
export const FIELD_DAMAGE = 0.4

/**
 * The queue a ship is built in: the station's, or with hybrid bases a yard's for the ships built at
 * one (`at`, or the player's first yard); or why there is none.
 */
function queueFor(w: World, owner: Owner, id: string, at: number): { q: QueueItem[]; yard?: Unit } | string {
  const p = w.players[owner]
  if (!w.hybrid) return at ? 'No yards in this battle' : { q: p.queue }
  const where = builtAt(UNIT[id])
  if (where === 'station') return at ? 'Built at the Command Station' : { q: p.queue }
  const given = at ? w.byId.get(at) : undefined
  const fits = (y: Unit) => !y.dead && y.owner === owner && y.t.tier === 'yard' && !!y.yq && worksOf(y.t) === where
  const yard = at ? (given && fits(given) ? given : undefined) : yardsOf(w, owner).find(fits)
  if (!yard) return at ? 'That yard can\'t build it' : `Needs a ${WORKS_NAME[where]}: build one with engineers`
  return { q: yard.yq!, yard }
}

/** Why a ship can't be ordered right now, or null if it can. `at`: the yard to build it at (0: the
 * station, or for a ship that is built at a yard, our first one). */
export function cantBuild(w: World, owner: Owner, id: string, reserve = false, at = 0): string | null {
  const p = w.players[owner]
  const t = UNIT[id]
  if (w.fleet) return 'No shipyard work during a fleet battle'
  if (reserve) {
    const why = cantReinforce(w, id)
    if (why) return why
  }
  if (!w.byId.get(p.station) || w.byId.get(p.station)!.dead) return 'No station'
  if (isEngineer(t) && !w.hybrid) return 'No engineers in this battle'
  if (t.level > p.level) return `Needs station level ${t.level}`
  if (t.tech && !p.techs.includes(t.tech)) return `Needs research: ${TECH[t.tech].name}`
  const where = queueFor(w, owner, id, at)
  if (typeof where === 'string') return where
  // Hybrid bases: bombers need the Command Station's Strike hangar, flagships the Capital slip.
  const need = w.hybrid ? needsModule(t) : null
  if (need && !expUp(where.yard ?? w.byId.get(p.station), need)) return `Needs the ${MODULE[need].name}: an expansion of the ${WORKS_NAME[MODULE[need].on]}`
  if (t.tier === 'capital' && capitals(w, owner) >= MAX_CAPITALS) return 'One flagship at a time'
  if (where.q.length >= MAX_QUEUE) return 'Queue full'
  if (p.pop + queuedPop(w, owner) + t.pop > p.popCap) return 'Fleet at its limit: capture beacons or upgrade the station'
  if (p.credits < shipPrice(w, id, reserve)) return 'Not enough credits'
  return null
}

/** Order a ship: when done it flies out of the yard that builds it (or the station's hangar), or in
 * a battle from before that jumps in beside it; with `reserve` it is a reinforcement, waiting in the
 * fleet reserve until called in, for the surcharge on top. `at`: as for cantBuild. */
export function cmdBuild(w: World, owner: Owner, id: string, reserve = false, at = 0) {
  const why = cantBuild(w, owner, id, reserve, at)
  if (why) return why
  const p = w.players[owner]
  const t = UNIT[id]
  const queue = (queueFor(w, owner, id, at) as { q: QueueItem[] }).q
  const price = shipPrice(w, id, reserve)
  spend(w, p, price, 'ships', reserve && price > t.cost ? `${t.name} (reinforcement)` : t.name)
  // Its own research, and the station's that speeds up every ship (TechEffect fleetBuild).
  const time = t.build * Math.max(0.2, 1 + (techBonus(p, id).build ?? 0) + (techBonus(p, stationOf(p)).fleetBuild ?? 0))
  queue.push({ unit: id, left: time, total: time, ...(reserve ? { reserve: true } : {}), ...(price !== t.cost ? { paid: price } : {}) })
  return null
}

/** Whether a team can see a point: any of its ships or structures has it in sensor range. */
export function canSee(w: World, team: number, x: number, y: number) {
  return w.units.some((u) => !u.dead && w.players[u.owner].team === team && d2(u.x, u.y, x, y) < sq(sensorOf(u)))
}

/**
 * Why a ship can't jump in at (x, y), or null when it can: it must be on the map, somewhere our
 * fleet can see, and clear of rocks, ore, other ships and structures, and other ships jumping in.
 * Asteroid fields and nebulas are allowed (a field costs hull on arrival).
 */
export function cantWarp(w: World, owner: Owner, id: string, x: number, y: number): string | null {
  const t = UNIT[id]
  const r = radius(t)
  if (x < r + 40 || y < r + 40 || x > w.w - r - 40 || y > w.h - r - 40) return 'Off the map'
  const entry = w.fleet?.entry[owner]
  const atEntry = !!entry && d2(x, y, entry.x, entry.y) < sq(entry.r)
  if (!atEntry && !canSee(w, w.players[owner].team, x, y)) return w.fleet ? 'Out of sight: ships jump in where the fleet can see, or at our entry point' : 'Out of sight: ships can only jump in where the fleet can see'
  if (w.rocks.some((k) => d2(x, y, k.x, k.y) < sq(k.r + r))) return 'An asteroid is in the way'
  if (w.nodes.some((n) => d2(x, y, n.x, n.y) < sq(n.r + r))) return 'An ore asteroid is in the way'
  // (Another side's yard nobody has started on isn't there yet, as far as we know.)
  if (w.units.some((u) => !u.dead && u.t.tier !== 'fighter' && !(planned(u) && u.owner !== owner) && d2(x, y, u.x, u.y) < sq((radius(u.t) + r) * 0.85))) return 'Something is in the way'
  if (w.arrivals.some((a) => d2(x, y, a.x, a.y) < sq(radius(UNIT[a.unit]) + r))) return 'Another ship is jumping in there'
  return null
}

function warpIn(w: World, owner: Owner, unit: string, x: number, y: number, a: number, delay: number, rally: boolean, to?: Pt, rush?: Arrival['rush']) {
  w.arrivals.push({ unit, owner, x, y, a, at: w.time + delay, rally, ...(to ? { rx: to.x, ry: to.y } : {}), ...(rush ? { rush } : {}) })
  w.events.push({ k: 'warp', owner, unit, x, y, a, delay })
}

/** Call a ship in from the reserve to (x, y), facing `a`. */
export function cmdDeploy(w: World, owner: Owner, id: string, x: number, y: number, a: number): string | null {
  const p = w.players[owner]
  const i = p.reserve.indexOf(id)
  if (i < 0) return 'None of those in reserve'
  const why = cantWarp(w, owner, id, x, y)
  if (why) return why
  p.reserve.splice(i, 1)
  // A ship that was rush-launched in the galaxy comes in still unfinished.
  const ri = p.rushRes?.findIndex((r) => r.unit === id) ?? -1
  const rush = ri >= 0 ? p.rushRes!.splice(ri, 1)[0] : undefined
  warpIn(w, owner, id, x, y, a, WARP_RESERVE, false, undefined, rush ? { built: rush.built, left: rush.left } : undefined)
  return null
}

/** Where a new ship from the shipyard drops out: beside the station, towards the rally point, on
 * the first clear spot round it. */
function yardSpot(w: World, o: Owner, st: Unit, id: string, rally: Pt = w.players[o].rally) {
  const t = UNIT[id]
  const toward = M.atan2(rally.y - st.y, rally.x - st.x)
  const reach = radius(st.t) + radius(t) + 70
  for (let ring = 0; ring < 4; ring++)
    for (const off of [0, 0.45, -0.45, 0.9, -0.9, 1.4, -1.4, 2, -2, 2.6, -2.6, Math.PI]) {
      const ang = toward + off
      const d = reach + ring * radius(t) * 1.6
      const x = st.x + M.cos(ang) * d
      const y = st.y + M.sin(ang) * d
      const blocked =
        w.rocks.some((k) => d2(x, y, k.x, k.y) < sq(k.r + radius(t))) ||
        w.units.some((u) => !u.dead && u !== st && u.t.tier !== 'fighter' && d2(x, y, u.x, u.y) < sq(radius(u.t) + radius(t))) ||
        w.arrivals.some((a) => d2(x, y, a.x, a.y) < sq(radius(UNIT[a.unit]) + radius(t)))
      if (!blocked) return { x: clamp(x, 60, w.w - 60), y: clamp(y, 60, w.h - 60), a: toward }
    }
  return { x: st.x + M.cos(toward) * reach, y: st.y + M.sin(toward) * reach, a: toward }
}

// --- Launch ------------------------------------------------------------------------------------------

/**
 * A new ship's way out, in seconds: its engines spool up (the docking lights blinking) before it
 * moves; then it slides out of a yard's berth in `slide` plus `perUnit` for every unit of the way
 * out, at most `slideMax`, or out of the station's hangar door (`hangarSpool`, `hangar`). With
 * something solid in the way out it holds back, but no longer than `wait`. `gap`: room it leaves
 * past the mouth. `end`: its share of its top speed as it comes clear. `stagger`: between the craft
 * of a squadron.
 */
export const LAUNCH = { spool: 0.8, slide: 1.1, perUnit: 1 / 800, slideMax: 2.1, hangarSpool: 0.35, hangar: 0.9, stagger: 0.15, wait: 6, gap: 30, end: 0.7 }

/** The middle of a yard's berth, and how far out along its heading the mouth is from there. */
export function berthOf(y: Unit): { x: number; y: number; mouth: number } {
  const b = YARD_BERTHS[y.t.id] ?? { hw: 15, y0: -45, y1: 25 }
  const k = y.t.size / 100
  const mid = (-(b.y0 + b.y1) / 2) * k
  return { x: y.x + M.cos(y.a) * mid, y: y.y + M.sin(y.a) * mid, mouth: -b.y0 * k - mid }
}

/** Where a station's ship leaves from: the bay of its hangar (the Strike hangar's for bombers, while
 * it stands), and the heading out of it, away from the station's middle (towards the rally point
 * when the bay is in the middle). */
function hangarDoor(st: Unit, id: string, rally: Pt) {
  const strike = UNIT[id].kind === 'bomber' && expUp(st, 'strikeHangar')
  const bay = st.t.hardpoints.findIndex((h) => (strike ? h.exp === 'strikeHangar' : h.kind === 'hangar' && !h.exp))
  const from = bay >= 0 ? hpPos(st, bay) : { x: st.x, y: st.y }
  const off = M.hypot(from.x - st.x, from.y - st.y)
  const a = off > 8 ? M.atan2(from.y - st.y, from.x - st.x) : M.atan2(rally.y - st.y, rally.x - st.x)
  return { x: from.x, y: from.y, a, off }
}

/**
 * A finished ship (or squadron) flies out of where it was built: a yard's ship from the middle of its
 * berth out through the mouth, a station's out of its hangar door, then on to `rally` (attack-move,
 * as a new ship always went). Fighters of a squadron leave one after another. `rush`: a rush launch,
 * unfinished (see Rush).
 */
function launchFrom(w: World, o: Owner, id: string, from: Unit, rally: Pt, rush?: { built: number; left: number }): Unit[] {
  const t = UNIT[id]
  const yard = from.t.tier === 'yard'
  const len = dims(t)[1] / 2
  let x0: number, y0: number, a: number, dist: number
  if (yard) {
    const b = berthOf(from)
    x0 = b.x
    y0 = b.y
    a = from.a
    dist = b.mouth + len + LAUNCH.gap
  } else {
    const d = hangarDoor(from, id, rally)
    x0 = d.x
    y0 = d.y
    a = d.a
    dist = Math.max(0, radius(from.t) - d.off) + len + LAUNCH.gap
  }
  const group = spawnGroup(w, id, o, x0, y0, a)
  group.forEach((u, i) => {
    if (rush) unfinished(u, rush.built, rush.left)
    const sx = u.x
    const sy = u.y
    u.launch = {
      from: from.id, t: -i * LAUNCH.stagger, wait: 0,
      spool: yard ? LAUNCH.spool : LAUNCH.hangarSpool,
      slide: yard ? Math.min(LAUNCH.slideMax, LAUNCH.slide + dist * LAUNCH.perUnit) : LAUNCH.hangar,
      x0: sx, y0: sy, x1: sx + M.cos(a) * dist, y1: sy + M.sin(a) * dist, a,
      end: speedOf(u) * LAUNCH.end,
    }
  })
  cmdMove(w, o, group.map((u) => u.id), rally.x, rally.y, true)
  w.events.push({ k: 'built', owner: o, unit: id, x: x0, y: y0 })
  return group
}

/** Whether something solid is in a launching ship's way out: where it comes clear, or half way there;
 * or a ship that left the same place before it is still on its way out. Fighters fly over
 * everything, and a ship over one two classes away (see overlaps). */
function launchBlocked(w: World, u: Unit) {
  const L = u.launch!
  if (u.t.tier === 'fighter') return false
  const r = radius(u.t)
  const mx = (L.x0 + L.x1) / 2
  const my = (L.y0 + L.y1) / 2
  for (const o of w.units) {
    if (o === u || o.dead || o.id === L.from || o.t.tier === 'fighter' || planned(o) || overlaps(u, o)) continue
    if (o.launch && o.launch.from === L.from) {
      if (o.id < u.id) return true
      continue
    }
    const min = sq((r + radius(o.t)) * 0.8)
    if (d2(o.x, o.y, L.x1, L.y1) < min || d2(o.x, o.y, mx, my) < min) return true
  }
  return false
}

/** Where along its way out a launching ship is at `s` (0 to 1) of the time, and its speed there (as
 * shares of the way over the time): a smooth start from rest, leaving at `m` in the same terms. */
const launchCurve = (s: number, m: number) => ({ p: s * s * (3 - 2 * s) + m * (s * s * s - s * s), v: 6 * s * (1 - s) + m * (3 * s * s - 2 * s) })

/** A ship on its way out (see Launch): held in place while it spools up or waits for the way to
 * clear, then slid out; it neither steers nor fires until it is clear. If where it was built is
 * destroyed, it is clear at once. */
function launching(w: World, u: Unit, dt: number) {
  const L = u.launch!
  const from = w.byId.get(L.from)
  if (!from || from.dead) return launched(u)
  u.a = L.a
  if (L.t < L.spool || (L.t === L.spool && L.wait < LAUNCH.wait && launchBlocked(w, u))) {
    if (L.t === L.spool) L.wait += dt
    L.t = Math.min(L.spool, L.t + dt)
    u.x = L.x0
    u.y = L.y0
    u.v = 0
    return
  }
  L.t += dt
  const dist = M.hypot(L.x1 - L.x0, L.y1 - L.y0) || 1
  const s = Math.min(1, (L.t - L.spool) / L.slide)
  const c = launchCurve(s, (L.end * L.slide) / dist)
  u.x = L.x0 + (L.x1 - L.x0) * c.p
  u.y = L.y0 + (L.y1 - L.y0) * c.p
  u.v = (c.v * dist) / L.slide
  if (s >= 1) launched(u)
}

/** Out and clear: it flies on under its own power. */
function launched(u: Unit) {
  const L = u.launch!
  delete u.launch
  u.v = L.end
  u.ax = u.x
  u.ay = u.y
}

/** Ships whose jump is done drop out of hyperspace; into an asteroid field, they pay for it. */
function arrivals(w: World) {
  if (!w.arrivals.length) return
  const keep: Arrival[] = []
  for (const a of w.arrivals) {
    if (a.at > w.time) {
      keep.push(a)
      continue
    }
    const p = w.players[a.owner]
    if (!p.alive) continue
    const field = inside(w.map.fields, a.x, a.y)
    const group = spawnGroup(w, a.unit, a.owner, a.x, a.y, a.a)
    for (const u of group) {
      u.v = u.t.speed * 0.6
      if (a.rush) unfinished(u, a.rush.built, a.rush.left)
      if (field) {
        u.hull = Math.max(1, u.hull - u.hullMax * FIELD_DAMAGE)
        u.shield = 0
        u.shieldOut = w.time
        u.lastHit = w.time
      }
    }
    if (a.rally) {
      cmdMove(w, a.owner, group.map((u) => u.id), a.rx ?? p.rally.x, a.ry ?? p.rally.y, true)
      w.events.push({ k: 'built', owner: a.owner, unit: a.unit, x: a.x, y: a.y })
    }
    w.events.push({ k: 'arrived', owner: a.owner, unit: a.unit, x: a.x, y: a.y, a: a.a, field })
  }
  w.arrivals = keep
}

/** Cancel a ship in the station's queue, or with `at` in one of our yards' (refunded in full). */
export function cmdCancel(w: World, owner: Owner, index: number, at = 0) {
  const p = w.players[owner]
  const yard = at ? w.byId.get(at) : undefined
  const queue = !at ? p.queue : yard && !yard.dead && yard.owner === owner ? yard.yq : undefined
  const q = queue?.[index]
  if (!q) return
  giveBack(w, p, q.paid ?? UNIT[q.unit].cost, 'ships', `Cancelled: ${UNIT[q.unit].name}`)
  queue!.splice(index, 1)
}

/** What a piece of research (or the next station level) costs. */
export function researchCost(p: Player, id: string) {
  if (id === LEVEL_UP) return UPGRADES[p.level + 1] ?? null
  const t = TECH[id]
  return t ? { cost: t.cost, time: t.time } : null
}

/**
 * What rules a piece of research out regardless of credits and queue space: it's done, or the
 * station level or a prerequisite is missing. The tech tree shows these as locked.
 */
export function researchLock(p: Player, id: string): string | null {
  if (id === LEVEL_UP) return p.level >= MAX_LEVEL ? 'Fully upgraded' : null
  const t = TECH[id]
  if (!t || t.faction !== p.faction) return 'Unknown research'
  if (p.techs.includes(id)) return 'Already researched'
  if (t.level > p.level) return `Needs station level ${t.level}`
  // A prerequisite already in the queue is enough: the queue runs in order, so it finishes first.
  const missing = (t.requires ?? []).filter((r) => !p.techs.includes(r) && !p.research.some((q) => q.id === r))
  if (missing.length) return `Needs ${missing.map((r) => TECH[r].name).join(' and ')} first`
  return null
}

/** Why something can't be researched right now, or null if it can. */
export function cantResearch(w: World, owner: Owner, id: string): string | null {
  const p = w.players[owner]
  const st = w.byId.get(p.station)
  if (!st || st.dead) return 'No station'
  const lock = researchLock(p, id)
  if (lock) return lock
  // Research for a yard (Rushed construction) needs that yard standing.
  const yard = id === LEVEL_UP ? undefined : UNIT[TECH[id].for]
  if (yard?.tier === 'yard' && !w.units.some((u) => !u.dead && u.owner === owner && u.t.id === yard.id && !u.site)) return `Needs a ${WORKS_NAME[worksOf(yard)!]}`
  if (p.research.some((r) => r.id === id)) return 'Already in the queue'
  if (p.research.length >= MAX_RESEARCH) return 'Research queue full'
  if (p.credits < researchCost(p, id)!.cost) return 'Not enough credits'
  return null
}

export function cmdResearch(w: World, owner: Owner, id: string) {
  const why = cantResearch(w, owner, id)
  if (why) return why
  const p = w.players[owner]
  const c = researchCost(p, id)!
  spend(w, p, c.cost, 'research', id === LEVEL_UP ? `Station level ${p.level + 1}` : TECH[id].name)
  p.research.push({ id, left: c.time, total: c.time })
  return null
}

export function cmdCancelResearch(w: World, owner: Owner, index: number): string | null {
  const p = w.players[owner]
  const r = p.research[index]
  if (!r) return 'Nothing to cancel'
  cancelUpgrade(w, p, r.id === LEVEL_UP ? UPGRADES[p.level + 1]!.cost : TECH[r.id].cost, 'research', r.id === LEVEL_UP ? `Station level ${p.level + 1}` : TECH[r.id].name)
  p.research.splice(index, 1)
  // Whatever was queued on the strength of it can never start now: cancel and refund that too.
  // Back to front, so a cascade only ever removes entries we've already looked at.
  for (let i = p.research.length - 1; i >= index; i--) {
    const q = p.research[i]
    if (q && q.id !== LEVEL_UP && TECH[q.id].requires?.includes(r.id)) cmdCancelResearch(w, owner, i)
  }
  return null
}

/** Research is done: apply it to every ship of that type already flying. */
/**
 * Rebuilds a station for its owner's level and research: the stage it has reached and the modules
 * built so far. Modules it already had keep their damage and reload; new ones arrive whole, and so
 * does the extra hull.
 */
function restation(w: World, u: Unit) {
  const p = w.players[u.owner]
  const t = stationType(p.faction, p.level, p.techs, u.xm ?? [])
  if (t === u.t) return
  retype(w, u, t)
  const max = t.hull * u.mods.hull
  u.hull += max - u.hullMax
  u.hullMax = max
  u.shield = Math.min(u.shield, shieldMax(u))
}

/** Swap a unit to another form of its type (a grown station, a platform with a part added): parts
 * it already had, matched by key, keep their damage and reload; new ones arrive whole, scaled by
 * `scale` (a platform's armour). Its hull is left to the caller. */
function retype(w: World, u: Unit, t: UnitType, scale = 1) {
  const old = new Map(u.t.hardpoints.map((h, i) => [h.key, i]))
  const hps = t.hardpoints.map((h) => {
    const i = old.get(h.key)
    return i === undefined ? { hp: h.hp * scale, max: h.hp * scale } : u.hps[i]
  })
  const guns = gunsOf(w, t).map((g) => {
    const i = old.get(t.hardpoints[g.hp]?.key)
    const had = i === undefined ? undefined : u.guns.find((x) => x.hp === i)
    return had ? { ...had, hp: g.hp } : g
  })
  u.t = t
  u.hps = hps
  u.guns = guns
}
/** Whether a station module of this kind stands: research that built one only helps while it does. */
export const moduleUp = (u: Unit | undefined, kind: string) => !!u && !u.dead && u.t.hardpoints.some((h, i) => h.kind === kind && !h.exp && u.hps[i].hp > 0)

function finishResearch(w: World, o: Owner, id: string) {
  const p = w.players[o]
  p.techs.push(id)
  const forId = TECH[id].for
  // The station's regrowth research reaches every living hull of the side (see modsFor).
  const fx = TECH[id].effect
  const wide = forId === stationOf(p) && !!(fx.regrow || fx.regrowDelay)
  for (const u of w.units) {
    if (u.dead || u.owner !== o || (u.t.id !== forId && !(wide && u.t.regrow))) continue
    remod(w, u)
    if (u.t.tier === 'station') restation(w, u)
  }
  w.events.push({ k: 'tech', owner: o, id })
}

/** A unit's bonuses worked out again (research done, the Armour works up or down): hull and shields
 * grow or shrink with them, keeping the share it has. */
function remod(w: World, u: Unit) {
  const next = modsFor(w.players[u.owner], u.t)
  const grow = next.hull / u.mods.hull
  const shields = next.shield / u.mods.shield
  u.hullMax *= grow
  u.hull *= grow
  if (u.rush) u.rush.gap *= grow
  u.mods = next
  u.shield = Math.min(shieldMax(u), u.shield * shields)
}

/** Why a structure (a mining or defense platform, by type id) can't go on this ore, or null if it can. */
export function cantSite(w: World, owner: Owner, node: number, id: string): string | null {
  const n = w.nodes[node]
  const p = w.players[owner]
  if (!n) return 'No ore there'
  if (n.site) return 'Something is already built here'
  if (n.owner !== p.team) return 'Survey it first: keep ships near it for a few seconds'
  // Only enemies we can see stop us: the check must not give away ships hidden in the fog.
  if (w.units.some((u) => !u.dead && foes(w, u.owner, owner) && sees(w, owner, u) && isShip(u.t) && u.t.tier !== 'fighter' && d2(u.x, u.y, n.x, n.y) < sq(SURVEY_RADIUS))) return 'Enemy ships are in the way'
  const t = UNIT[id]
  if (!t || t.faction !== p.faction || (t.tier !== 'mine' && t.tier !== 'defense')) return 'That can\'t be built on ore'
  if (p.credits < t.cost) return 'Not enough credits'
  return null
}

export function cmdSite(w: World, owner: Owner, node: number, id: string) {
  const why = cantSite(w, owner, node, id)
  if (why) return why
  const p = w.players[owner]
  const n = w.nodes[node]
  const t = UNIT[id]
  spend(w, p, t.cost, 'structures', t.name)
  const m = spawn(w, t.id, owner, n.x, n.y, t.tier === 'mine' ? n.rot : 0)
  m.building = t.build
  m.hull = m.hullMax * 0.25
  m.shield = 0
  m.node = n.id
  n.site = m.id
  return null
}

// --- Hybrid bases: yards and engineers ------------------------------------------------------------------

/** Where a yard would go and what it would cost: the spot (snapped onto our own ruin of it, when the
 * point is on one), the way it faces (its slipway opening away from the station, or as the ruin
 * lay), and why it can't go there, if it can't. The ghost under the cursor shows this. */
export type Placement = { why: string | null; x: number; y: number; a: number; cost: number; ruin?: Ruin }

/** An angle brought into (-PI, PI]. Plain arithmetic, so every copy of a battle gets the same one. */
export const wrapAngle = (a: number) => a - Math.PI * 2 * Math.floor((a + Math.PI) / (Math.PI * 2))

/** A yard's footprint: half its length along the way it faces (the slipway's axis) and half its width across. */
export const yardBox = (t: UnitType): { hl: number; hw: number } => {
  const [w, h] = dims(t)
  return { hl: h / 2, hw: w / 2 }
}

/** How far a point is from a box (centre cx, cy; half sizes hl along the heading a, hw across): 0 inside. */
function boxGap(px: number, py: number, cx: number, cy: number, a: number, hl: number, hw: number) {
  const c = M.cos(a)
  const s = M.sin(a)
  const dx = px - cx
  const dy = py - cy
  const along = Math.max(0, Math.abs(dx * c + dy * s) - hl)
  const across = Math.max(0, Math.abs(-dx * s + dy * c) - hw)
  return M.hypot(along, across)
}

/** Whether two boxes come within `margin` of each other (separating axis test). */
function boxesNear(ax: number, ay: number, aa: number, ahl: number, ahw: number, bx: number, by: number, ba: number, bhl: number, bhw: number, margin: number) {
  const dx = bx - ax
  const dy = by - ay
  const axes = [aa, aa + Math.PI / 2, ba, ba + Math.PI / 2]
  for (const t of axes) {
    const nx = M.cos(t)
    const ny = M.sin(t)
    const ra = ahl * Math.abs(nx * M.cos(aa) + ny * M.sin(aa)) + ahw * Math.abs(-nx * M.sin(aa) + ny * M.cos(aa))
    const rb = bhl * Math.abs(nx * M.cos(ba) + ny * M.sin(ba)) + bhw * Math.abs(-nx * M.sin(ba) + ny * M.cos(ba))
    if (Math.abs(dx * nx + dy * ny) - ra - rb >= margin) return false
  }
  return true
}

/** `facing`: the way the yard faces, if its owner chose one (else away from the Command Station, as
 * the AI's always do); a ruin keeps the way it lay. The overlap checks use the yard's box at that angle. */
export function placement(w: World, owner: Owner, unitId: string, x: number, y: number, facing?: number): Placement {
  const p = w.players[owner]
  const t = UNIT[unitId]
  const st = w.byId.get(p.station)
  const ruin = t && (w.ruins ?? []).find((r) => r.owner === owner && r.unit === unitId && d2(x, y, r.x, r.y) < sq(radius(t) * 0.8))
  if (ruin) {
    x = ruin.x
    y = ruin.y
  }
  const a = ruin ? ruin.a : facing !== undefined && Number.isFinite(facing) ? wrapAngle(facing) : st ? M.atan2(y - st.y, x - st.x) : 0
  const cost = t ? (ruin ? Math.round(t.cost * REBUILD) : t.cost) : 0
  const out = (why: string | null): Placement => ({ why, x, y, a, cost, ...(ruin ? { ruin } : {}) })
  if (!w.hybrid || w.fleet) return out('No yards in this battle')
  if (!t || t.tier !== 'yard' || t.faction !== p.faction) return out('That can\'t be built here')
  if (!st || st.dead) return out('No station')
  if (t.level > p.level) return out(`Needs station level ${t.level}`)
  if (w.units.filter((u) => !u.dead && u.owner === owner && u.t.id === unitId).length >= YARD_MAX) return out(`We already have a ${t.name}`)
  const why = siteProblem(w, owner, t, st, x, y, a, ruin)
  if (why) return out(why)
  if (p.credits < cost) return out('Not enough credits')
  return out(null)
}

/** Why yard `t` can't stand at (x, y) facing `a` round station `st`, or null when it can: inside the
 * build radius, clear of the map's edge, rocks, fields, ore, beacons, wrecks, other structures and
 * ruins (but `ruin`, the one it goes up on). */
function siteProblem(w: World, owner: Owner, t: UnitType, st: Unit, x: number, y: number, a: number, ruin?: Ruin): string | null {
  const r = radius(t)
  const { hl, hw } = yardBox(t)
  const gap = (px: number, py: number) => boxGap(px, py, x, y, a, hl, hw)
  if (d2(x, y, st.x, st.y) > sq(BUILD_RADIUS)) return 'Outside the build radius: keep it near the Command Station'
  const ex = Math.abs(M.cos(a)) * hl + Math.abs(M.sin(a)) * hw
  const ey = Math.abs(M.sin(a)) * hl + Math.abs(M.cos(a)) * hw
  if (x < ex + 120 || y < ey + 120 || x > w.w - ex - 120 || y > w.h - ey - 120) return 'Too close to the edge of the map'
  if (w.rocks.some((k) => gap(k.x, k.y) < k.r + 30)) return 'An asteroid is in the way'
  if (inside(w.map.fields, x, y, r)) return 'Inside an asteroid field'
  if (w.nodes.some((n) => gap(n.x, n.y) < n.r + 140)) return 'Too close to an ore asteroid'
  if (w.beacons.some((b) => gap(b.x, b.y) < 240)) return 'Too close to a beacon'
  if (w.wrecks.some((h) => gap(h.x, h.y) < h.size * 0.6)) return 'A wreck is in the way'
  // Kept clear of other structures: a yard by its box, the rest by their longest side, a station by the size it grows to.
  const half = (o: UnitType) => Math.max(...dims(o.tier === 'station' ? stationType(o.faction, MAX_LEVEL, []) : o)) * 0.5
  const crowded = (u: Unit) => {
    if (u.t.tier === 'yard') {
      const b = yardBox(u.t)
      return boxesNear(x, y, a, hl, hw, u.x, u.y, u.a, b.hl, b.hw, 60)
    }
    return gap(u.x, u.y) < half(u.t) + 60
  }
  if (w.units.some((u) => !u.dead && !isShip(u.t) && !(planned(u) && u.owner !== owner) && crowded(u))) return 'Too close to another structure'
  if ((w.ruins ?? []).some((q) => q !== ruin && d2(x, y, q.x, q.y) < sq(r * 2))) return 'A ruin is in the way'
  return null
}

/**
 * Engineers put up a yard: it is paid for now and its site marked out; the engineers among `ids`
 * fly there and build it (with `queued`, once their other orders are done). Placed on our own ruin
 * of it, it costs REBUILD of the price.
 */
export function cmdPlace(w: World, owner: Owner, ids: number[], unitId: string, x: number, y: number, queued = false, facing = NaN): string | null {
  const crew = ids.map((i) => w.byId.get(i)).filter((u): u is Unit => commandable(u, owner) && isEngineer(u.t))
  if (!crew.length) return 'Select engineers to build it'
  const pl = placement(w, owner, unitId, x, y, facing)
  if (pl.why) return pl.why
  const t = UNIT[unitId]
  spend(w, w.players[owner], pl.cost, 'structures', pl.ruin ? `Rebuilding: ${t.name}` : t.name)
  const site = spawn(w, unitId, owner, pl.x, pl.y, pl.a)
  site.building = t.build
  site.hull = site.hullMax * 0.1
  site.shield = 0
  site.site = { paid: pl.cost, started: false, ...(pl.ruin ? { ruin: pl.ruin } : {}) }
  if (pl.ruin) w.ruins = (w.ruins ?? []).filter((r) => r !== pl.ruin)
  for (const u of crew) issue(u, { k: 'construct', id: site.id }, queued)
  return null
}

/** Why engineers of `owner` can't work on `t`, or null when they can: a construction site of ours,
 * or one of our (or an ally's) finished structures with something to mend. An ally's sites and
 * rush-launched ships are theirs to finish. */
export function cantConstruct(w: World, owner: Owner, t: Unit | undefined): string | null {
  if (!t || t.dead || foes(w, t.owner, owner) || w.byId.get(t.id) !== t) return 'Pick one of our structures'
  if (t.owner !== owner) {
    if (isShip(t.t) || t.site || building(t)) return 'Pick one of our structures, or a damaged one of an ally\'s'
    return wear(t) < 0.002 ? 'Nothing to repair' : null
  }
  // A rush-launched warship: engineers finish it (see finishing).
  if (isShip(t.t)) return t.rush ? null : 'Pick one of our structures'
  if (t.site) return null
  if (building(t)) return 'It is building itself'
  if (wear(t) < 0.002) return 'Nothing to repair'
  return null
}

/** Engineers build a construction site of ours, or weld one of our structures back together. */
export function cmdConstruct(w: World, owner: Owner, ids: number[], id: number, queued = false): string | null {
  const t = w.byId.get(id)
  const why = cantConstruct(w, owner, t)
  if (why) return why
  const crew = ids.map((i) => w.byId.get(i)).filter((u): u is Unit => commandable(u, owner) && isEngineer(u.t))
  if (!crew.length) return 'Only engineers build and repair structures'
  for (const u of crew) issue(u, { k: 'construct', id }, queued)
  return null
}

/** Whether a unit type repairs others: a support tender (the Mercy corvette), a Field repair craft
 * or an engineer. */
export const isRepairer = (t: UnitType) => !!t.support || t.ability === 'fieldRepair' || isEngineer(t)

/**
 * Why repair ship `u` of `owner` can't be sent to repair `t`, or null when it can. Tenders patch
 * the hulls of ships, Field repair craft mend stations and ships of gunship class and up (see
 * cantMend), engineers structures (see cantConstruct); ours or an ally's, never an enemy's, and only
 * when there is something to repair.
 */
export function cantHeal(w: World, owner: Owner, u: Unit, t: Unit | undefined): string | null {
  if (!t || t.dead || t === u || w.byId.get(t.id) !== t) return 'Pick one of our ships or an ally\'s'
  if (foes(w, t.owner, owner)) return 'Only our own and our allies\' ships can be repaired'
  if (isEngineer(u.t)) return cantConstruct(w, owner, t)
  if (u.t.ability === 'fieldRepair') return cantMend(w, owner, t)
  if (u.t.support) {
    if (!isShip(t.t)) return 'Repair tenders patch up ships, not structures'
    return t.hull >= hullCap(t) - 0.5 ? 'Nothing to repair' : null
  }
  return 'Only repair ships can repair'
}

/**
 * Repair one ship or structure of ours or an ally's: the repair ships among `ids` that can mend it
 * go to it and repair it until it is whole or lost, then go back to what they were guarding or
 * escorting (or wait where they are; queued orders come first). Engineers take it as a construct
 * order. A Field repair craft already on a run switches it to the new patient; otherwise it starts
 * one once its ability is ready, and stays with the patient between runs. Ships that can't repair
 * it are left alone: the caller gives them their own order. Answers why none could, or null.
 */
export function cmdMend(w: World, owner: Owner, ids: number[], id: number, queued = false): string | null {
  const refused = cantMendOn(w, owner, id)
  if (refused) return refused
  const t = w.byId.get(id)!
  let n = 0
  let why: string | null = null
  for (const i of ids) {
    const u = w.byId.get(i)
    if (!commandable(u, owner) || !isRepairer(u.t)) continue
    const no = cantHeal(w, owner, u, t)
    if (no) {
      why ??= no
      continue
    }
    n++
    if (isEngineer(u.t)) {
      issue(u, { k: 'construct', id }, queued)
      continue
    }
    const back = queued ? 0 : u.order.k === 'guard' ? u.order.id : u.order.k === 'mend' ? u.order.back : 0
    const run = u.aid && u.abilityOn > 0
    issue(u, { k: 'mend', id, back }, queued)
    if (run && u.order.k === 'mend' && u.order.id === id) u.aid = id
  }
  return n ? null : why ?? 'Nothing selected can repair it'
}

/** Why `owner` can't send repair ships to `id` at all: it is gone, or an enemy's (the server
 * referee refuses those orders before they reach anyone, and the sim again). */
export function cantMendOn(w: World, owner: Owner, id: number): string | null {
  const t = w.byId.get(id)
  if (!t || t.dead) return 'Pick one of our ships or an ally\'s'
  return foes(w, t.owner, owner) ? 'Only our own and our allies\' ships can be repaired' : null
}

/** A repair order is done: on to the next queued order, else back to guarding (or escorting) what it
 * was, else wait where it is. */
function mendDone(w: World, u: Unit) {
  const back = u.order.k === 'mend' ? u.order.back : 0
  const g = back && !u.queue.length ? w.byId.get(back) : undefined
  if (g && !g.dead && g !== u && !foes(w, g.owner, u.owner)) {
    u.order = { k: 'guard', id: g.id }
    u.target = 0
    return
  }
  nextOrder(u, u.x, u.y)
}

/**
 * What a yard card in the engineers' Build section shows for yard type `t` and `craft` selected
 * engineer craft (three to a squadron): what it costs (less on our ruin of it), the station level
 * it needs, the reason it can't be started (a locked level, or credits), whether we already have
 * it (standing, or going up), and how many seconds the selected crew take (a squadron welds at the
 * yard's build time, up to ENGINEERS.crew craft on one job).
 */
export function yardOffer(w: World, owner: Owner, t: UnitType, craft: number) {
  const p = w.players[owner]
  const ours = w.units.find((u) => !u.dead && u.owner === owner && u.t.id === t.id)
  const ruin = (w.ruins ?? []).find((r) => r.owner === owner && r.unit === t.id)
  const cost = ruin ? Math.round(t.cost * REBUILD) : t.cost
  const locked = !ours && t.level > p.level
  const poor = !ours && !locked && p.credits < cost
  const why = ours ? null : locked ? `Needs station level ${t.level}` : poor ? `Not enough credits: ${Math.ceil(cost - p.credits)} more` : null
  const secs = Math.ceil(t.build / (Math.min(Math.max(craft, 1), ENGINEERS.crew) / 3))
  return { ours, ruin: !!ruin, cost, locked, poor, why, secs }
}

/** What cancelling a construction site gives back now: all of it before work has started, then
 * less the further along it is (see SITE_REFUND). */
export const siteRefund = (u: Unit) =>
  !u.site ? 0 : !u.site.started ? u.site.paid : Math.round(u.site.paid * (SITE_REFUND.start - SITE_REFUND.wear * (1 - u.building / u.t.build)))

/** Call off a yard still being built: refunded (see siteRefund), and the ruin it stood on is back. */
export function cmdCancelSite(w: World, owner: Owner, id: number): string | null {
  const u = w.byId.get(id)
  if (!u || u.dead || u.owner !== owner || !u.site) return 'Nothing to cancel'
  giveBack(w, w.players[owner], siteRefund(u), 'structures', `Cancelled: ${u.t.name}`)
  if (u.site.ruin) (w.ruins ??= []).push(u.site.ruin)
  u.dead = true
  w.byId.delete(u.id)
  return null
}

/** A yard finished: its queue opens, its rally point out in front of its slipway. */
function finishSite(w: World, t: Unit) {
  t.building = 0
  delete t.site
  t.yq = []
  const d = radius(t.t) + 280
  t.yr = { x: clamp(t.x + M.cos(t.a) * d, 40, w.w - 40), y: clamp(t.y + M.sin(t.a) * d, 40, w.h - 40) }
  w.events.push({ k: 'built', owner: t.owner, unit: t.t.id, x: t.x, y: t.y })
}

/** Something for an idle engineer to do by itself near where it is: a site of ours being built (or a
 * rush-launched warship of ours to finish), else the most worn of our structures (a twentieth of it missing or more). Never where enemy
 * warships or strike craft are in sight round it: unarmed crews don't fly into a fight unasked. */
function jobNear(w: World, u: Unit): Unit | undefined {
  let best: Unit | undefined
  let score = 0
  const hot = (t: Unit) => {
    let found = false
    near(w, t.x, t.y, radius(t.t) + rangeDist(800), (e) => {
      if (!found && isShip(e.t) && foes(w, e.owner, u.owner) && sees(w, u.owner, e)) found = true
    })
    return found
  }
  for (const t of w.units) {
    if (t.dead || t.owner !== u.owner || (isShip(t.t) && !t.rush)) continue
    const dd = d2(t.x, t.y, u.x, u.y)
    let s = 0
    // A site, or a rush-launched warship to finish, first; then the most worn structure.
    if (t.site || t.rush) s = dd < sq(rangeDist(1400)) ? 2 : 0
    else if (!building(t) && dd < sq(rangeDist(900))) {
      const need = wear(t)
      s = need >= 0.05 ? need : 0
    }
    s /= 1 + Math.sqrt(dd) / 1000
    if (s > score && !hot(t)) {
      score = s
      best = t
    }
  }
  return best
}

/**
 * Engineers at work: each one within reach of its job welds, up to ENGINEERS.crew of them on one
 * structure. A site goes up at one squadron's pace per three craft, its hull growing with it, and
 * opens for work when done; a finished structure gets its hull and damaged modules mended (and a
 * station's or yard's shot-off modules rebuilt, one at a time). Idle engineers look round now and
 * then for a site or a worn structure of ours nearby and get on with it by themselves.
 */
function construction(w: World, dt: number) {
  const look = Math.round(w.time / STEP) % Math.round(MEND_LOOK / STEP) === 0
  const crews = new Map<number, number>()
  // Who is welding each structure (the first crew's owner), who pays for what they rebuild.
  const payers = new Map<number, Owner>()
  for (const u of w.units) {
    if (u.dead || !isEngineer(u.t)) continue
    u.mending = []
    if (u.order.k === 'construct') {
      const t = w.byId.get(u.order.id)
      if (cantConstruct(w, u.owner, t)) {
        // Done (built, rebuilt or mended whole) with nothing queued after it: stay by the structure, on
        // guard, which keeps them mending it and the ones near it when they are hurt (see jobNear).
        // Unarmed, they never chase anyone from there.
        const stay = !u.queue.length && !!t && !t.dead && t.owner === u.owner && !isShip(t.t)
        nextOrder(u, u.x, u.y)
        if (stay) issue(u, { k: 'guard', id: t!.id })
        continue
      }
      if (d2(t!.x, t!.y, u.x, u.y) > sq(radius(t!.t) + ENGINEERS.reach)) continue
      crews.set(t!.id, (crews.get(t!.id) ?? 0) + 1)
      if (!payers.has(t!.id)) payers.set(t!.id, u.owner)
      u.mending.push(t!.id)
      continue
    }
    if (!look || (u.order.k !== 'idle' && u.order.k !== 'guard') || u.queue.length) continue
    const job = jobNear(w, u)
    if (job) issue(u, { k: 'construct', id: job.id })
  }
  for (const [id, n] of crews) {
    const t = w.byId.get(id)!
    if (t.rush) {
      t.rush.work = true
      continue
    }
    const k = Math.min(n, ENGINEERS.crew)
    if (t.site) {
      t.site.started = true
      const step = Math.min(t.building, (dt * k) / 3)
      t.building -= step
      t.hull = Math.min(t.hullMax, t.hull + (t.hullMax * 0.9 * step) / t.t.build)
      if (t.building <= 1e-9) finishSite(w, t)
      continue
    }
    t.hull = Math.min(t.hullMax, t.hull + (ENGINEERS.flat + ENGINEERS.share * t.hullMax) * k * dt)
    for (const h of t.hps) if (h.hp > 0 && h.hp < h.max) h.hp = Math.min(h.max, h.hp + h.max * ENGINEERS.share * k * dt)
    if (t.t.tier === 'station' || t.t.tier === 'yard') for (let i = 0; i < k; i++) rebuildModule(w, t, dt, payers.get(id))
  }
}

// --- Rush launch ------------------------------------------------------------------------------------------

/** The rush launch's numbers in this battle: RUSH, or the dev cheats' (a local battle only). */
export const rushRules = (w: World) => w.rushTune ?? RUSH

/** How much of the ship a yard is working on is built (0-1), or -1 with nothing under way. */
export const rushShare = (y: Unit) => (y.yq?.length ? Math.max(0, 1 - y.yq[0].left / Math.max(0.001, y.yq[0].total)) : -1)

/** The most a unit's hull mends to: all of it, less what a rush launch left unbuilt (see Rush). */
export const hullCap = (u: Unit) => u.hullMax - (u.rush?.gap ?? 0)

/** Why yard `uid` can't rush-launch its ship now, or null when it can. */
export function cantRush(w: World, owner: Owner, uid: number): string | null {
  const y = w.byId.get(uid)
  const p = w.players[owner]
  if (!y || y.dead || y.owner !== owner || worksOf(y.t) !== 'cyard') return 'Only a Capital Yard can rush a launch'
  if (!p.techs.includes(RUSH_TECH[p.faction])) return `Needs ${TECH[RUSH_TECH[p.faction]].name}`
  if (y.site || building(y) || !y.yq?.length) return 'Nothing being built'
  if (y.yq[0].reserve) return 'Built for the fleet inventory: it can\'t be rushed'
  const rules = rushRules(w)
  const share = rushShare(y)
  if (share < rules.min) return `Not ${Math.round(rules.min * 100)}% built yet (${Math.floor(share * 100)}%)`
  if ((y.rushAt ?? -Infinity) > w.time) return `Ready again in ${Math.ceil((y.rushAt ?? 0) - w.time)} s`
  return null
}

/**
 * Rush launch: the ship yard `uid` is building jumps out now, unfinished (see Rush and data.ts RUSH).
 * The yard can't rush again for RUSH.cooldown seconds, and the next ship it starts goes slower.
 */
export function cmdRush(w: World, owner: Owner, uid: number): string | null {
  const why = cantRush(w, owner, uid)
  if (why) return why
  const y = w.byId.get(uid)!
  const p = w.players[owner]
  const q = y.yq!.shift()!
  const rules = rushRules(w)
  const built = rushShare({ ...y, yq: [q] } as Unit)
  p.stats.built++
  y.rushAt = w.time + rules.cooldown
  if (y.yq!.length) y.yq![0].slow = true
  else y.slowNext = true
  const rally = y.yr ?? p.rally
  // What was left of its build, at the yard's full pace. It flies out of the berth, scaffolding and
  // all (or in a battle from before launches, jumps in beside the yard).
  if (launches(w)) launchFrom(w, owner, q.unit, y, rally, { built, left: Math.max(0, q.left) })
  else {
    const at = yardSpot(w, owner, y, q.unit, rally)
    warpIn(w, owner, q.unit, at.x, at.y, at.a, WARP_YARD, true, rally, { built, left: Math.max(0, q.left) })
  }
  w.events.push({ k: 'rushed', owner, unit: q.unit, x: y.x, y: y.y })
  return null
}

/** A rush-launched ship as it drops out: `built` of its hull, no shields, and as many of its turrets
 * and modules as are unbuilt not yet installed, the ones furthest aft first (they go on bow first). */
function unfinished(u: Unit, built: number, left: number) {
  const parts = u.t.hardpoints
    .map((h, i) => ({ i, h }))
    .filter(({ h }) => h.kind !== 'engine')
    .sort((a, b) => b.h.y - a.h.y || a.h.x - b.h.x || a.i - b.i)
  const n = Math.min(parts.length, Math.round(parts.length * (1 - built)))
  const off = parts.slice(0, n).map((p) => p.i)
  for (const i of off) u.hps[i].hp = 0
  u.hull = Math.max(1, u.hullMax * built)
  u.shield = 0
  if (left <= 0) return
  u.rush = { left, total: left, gap: u.hullMax - u.hull, parts: off.reverse(), n, work: false }
}

/**
 * Rush-launched ships being finished: one with a Drydock, repair craft or engineers on it this tick
 * gets on with its build at the build pace (however many of them there are), its unbuilt hull
 * filling in as it goes and its parts going on one by one (whole); the rest wait. Finished, it is a
 * ship like any other.
 */
function finishing(w: World, dt: number) {
  for (const u of w.units) {
    const r = u.rush
    if (!r || u.dead) continue
    if (!r.work) continue
    r.work = false
    const step = Math.min(r.left, dt)
    const give = r.gap * (step / Math.max(step, r.left))
    r.gap -= give
    u.hull = Math.min(u.hullMax, u.hull + give)
    r.left -= step
    const still = r.left <= 1e-9 ? 0 : Math.ceil(r.n * (r.left / r.total))
    while (r.parts.length > still) {
      const i = r.parts.shift()!
      u.hps[i].hp = u.hps[i].max
      w.events.push({ k: 'installed', owner: u.owner, unit: u.id, x: u.x, y: u.y })
    }
    if (r.left <= 1e-9) {
      u.hull = Math.min(u.hullMax, u.hull + r.gap)
      delete u.rush
      w.events.push({ k: 'finished', owner: u.owner, unit: u.id, x: u.x, y: u.y })
    }
  }
}

// --- Hybrid bases: expansions ---------------------------------------------------------------------------

/**
 * What rules an expansion out on building `u` regardless of credits and queue space (the panels show
 * these as locked): no expansions in this battle, not one of our buildings, the wrong building for
 * it, still going up, already built or queued there, or the station level is short.
 */
export function moduleLock(w: World, owner: Owner, u: Unit | undefined, id: ModuleId): string | null {
  const m = MODULE[id]
  if (!w.hybrid || w.fleet) return 'No expansions in this battle'
  if (!m) return 'Unknown expansion'
  if (!moduleFits(id, w.players[owner].faction)) return `The ${FACTIONS[w.players[owner].faction].name} has no use for it`
  if (!u || u.dead || u.owner !== owner || worksOf(u.t) !== m.on) return `It goes on our ${WORKS_NAME[m.on]}`
  if (u.site || building(u)) return 'Still under construction'
  if (u.xm?.includes(id)) return 'Already built'
  if (u.xq?.some((j) => j.id === id)) return 'Already in the queue'
  if (m.level > w.players[owner].level) return `Needs station level ${m.level}`
  return null
}

/** Why an expansion can't be ordered on building `uid` right now, or null if it can. */
export function cantExpand(w: World, owner: Owner, uid: number, id: ModuleId): string | null {
  const u = w.byId.get(uid)
  const lock = moduleLock(w, owner, u, id)
  if (lock) return lock
  if ((u!.xq?.length ?? 0) >= MODULE_QUEUE) return 'Expansion queue full'
  if (w.players[owner].credits < MODULE[id].cost) return 'Not enough credits'
  return null
}

/** Order an expansion: paid now, built by the building itself after its time (one at a time). */
export function cmdExpand(w: World, owner: Owner, uid: number, id: ModuleId): string | null {
  const why = cantExpand(w, owner, uid, id)
  if (why) return why
  const u = w.byId.get(uid)!
  const m = MODULE[id]
  spend(w, w.players[owner], m.cost, 'structures', m.name)
  ;(u.xq ??= []).push({ id, left: m.time, total: m.time })
  return null
}

/** Call off an expansion ordered on building `uid` (refunded in full). */
export function cmdCancelExpand(w: World, owner: Owner, uid: number, index: number): string | null {
  const u = w.byId.get(uid)
  const j = u && !u.dead && u.owner === owner ? u.xq?.[index] : undefined
  if (!j) return 'Nothing to cancel'
  cancelUpgrade(w, w.players[owner], MODULE[j.id].cost, 'structures', MODULE[j.id].name)
  u!.xq!.splice(index, 1)
  return null
}

/** What welding a shot-off expansion back costs. */
export const moduleRebuildCost = (id: ModuleId) => Math.round(MODULE[id].cost * REBUILD_MODULE)

/** An expansion done: it goes onto its building (a type of its own, like a grown station), whole. */
function finishModule(w: World, u: Unit, id: ModuleId) {
  ;(u.xm ??= []).push(id)
  if (u.t.tier === 'station') restation(w, u)
  else retype(w, u, yardType(u.t.id, u.xm))
  if (id === 'fighterWing') spawnWing(w, u)
  w.events.push({ k: 'expanded', owner: u.owner, unit: u.id, id, x: u.x, y: u.y })
}

/**
 * The buildings work on their expansions, one at a time each; and the Armour works' plate goes on
 * (or comes off) our frigates and corvettes as it stands or falls.
 */
function expansions(w: World, dt: number) {
  const armour = w.players.map(() => false)
  for (const u of w.units) {
    if (u.dead || (u.t.tier !== 'station' && u.t.tier !== 'yard')) continue
    if (u.t.tier === 'yard' && expUp(u, 'armourWorks')) armour[u.owner] = true
    const j = u.xq?.[0]
    if (!j) continue
    j.left -= dt
    if (j.left > 0) continue
    u.xq!.shift()
    finishModule(w, u, j.id)
  }
  w.players.forEach((p, o) => {
    if (!!p.armour === armour[o]) return
    if (armour[o]) p.armour = true
    else delete p.armour
    for (const u of w.units) if (!u.dead && u.owner === o && plated(u.t)) remod(w, u)
  })
}

// --- Simulation -----------------------------------------------------------------------------------

const CELL = 320
const key = (cx: number, cy: number) => cx + cy * 1000

function buildGrid(w: World) {
  w.grid.clear()
  for (const u of w.units) {
    if (u.dead) continue
    const k = key(Math.floor(u.x / CELL), Math.floor(u.y / CELL))
    let c = w.grid.get(k)
    if (!c) w.grid.set(k, (c = []))
    c.push(u)
  }
}

export function near(w: World, x: number, y: number, r: number, fn: (u: Unit, dd: number) => void) {
  const x0 = Math.floor((x - r) / CELL)
  const x1 = Math.floor((x + r) / CELL)
  const y0 = Math.floor((y - r) / CELL)
  const y1 = Math.floor((y + r) / CELL)
  const rr = r * r
  for (let cy = y0; cy <= y1; cy++)
    for (let cx = x0; cx <= x1; cx++) {
      const c = w.grid.get(key(cx, cy))
      if (!c) continue
      for (const u of c) {
        if (u.dead) continue
        const dd = d2(u.x, u.y, x, y)
        if (dd <= rr) fn(u, dd)
      }
    }
}

function refreshPlayers(w: World) {
  for (let o = 0; o < w.players.length; o++) {
    const p = w.players[o]
    let pop = 0
    // Mining platforms, counted by their working parts: each drill rig 40%, the silo 20%.
    let mines = 0
    for (const u of w.units) {
      if (u.dead || u.owner !== o) continue
      if (!u.parent) pop += u.t.pop / u.t.squad
      if (u.t.tier === 'mine' && !building(u)) mines += mineOutput(u)
    }
    for (const id of p.reserve) pop += UNIT[id].pop
    for (const a of w.arrivals) if (a.owner === o) pop += UNIT[a.unit].pop
    const beacons = w.beacons.filter((b) => b.owner === p.team).length
    p.pop = Math.round(pop)
    p.popCap = BASE_POP + (p.level - 1) * POP_PER_LEVEL + beacons * BEACON_POP
    const ore = MINE_INCOME * (1 + (moduleUp(w.byId.get(p.station), 'refinery') ? (techBonus(p, stationOf(p)).mines ?? 0) : 0))
    p.incomeParts = { station: STATION_INCOME[p.level] * p.incomeMul, mines: mines * ore * p.incomeMul, beacons: beacons * BEACON_INCOME * p.incomeMul }
    p.income = p.incomeParts.station + p.incomeParts.mines + p.incomeParts.beacons
  }
}

function launch(w: World, carrier: Unit, extra = false) {
  const c = carrier.t.carrier
  if (!c || !hangarsUp(carrier)) return
  if (!extra) {
    // (A station's defense wing is its own: only its brood counts here.)
    const out = new Set(w.units.filter((u) => !u.dead && u.parent === carrier.id && u.t.kind !== 'wing').map((u) => u.squad))
    if (out.size >= c.max + (techBonus(w.players[carrier.owner], carrier.t.id).hangar ?? 0)) return
  }
  const bays = carrier.t.hardpoints.map((h, i) => (h.kind === 'hangar' && alive(carrier, i) ? i : -1)).filter((i) => i >= 0)
  const bay = hpPos(carrier, bays[Math.floor(rand(w) * bays.length)])
  for (const f of spawnGroup(w, c.unit, carrier.owner, bay.x, bay.y, carrier.a)) {
    f.parent = carrier.id
    f.v = f.t.speed * 0.6
  }
  w.events.push({ k: 'launch', owner: carrier.owner, x: bay.x, y: bay.y })
}

/** Warships leave a hulk worth part of their cost, for whoever holds the field to strip. */
function leaveWreck(w: World, u: Unit) {
  if (u.t.tier !== 'frigate' && u.t.tier !== 'cruiser' && u.t.tier !== 'capital') return
  const value = Math.round((u.t.cost * 0.3) / 10) * 10
  w.wrecks.push({ id: w.wreckSeq++, x: u.x, y: u.y, value, left: value, sprite: u.t.sprite, size: u.t.size, rot: u.a + Math.PI / 2, decay: 180, team: -1 })
}

/**
 * Salvage: non-fighter ships parked by a hulk strip it, the credits going to whoever's ships are
 * there; contested hulks give nothing. Battle wrecks drift away after a while.
 */
function salvage(w: World, dt: number) {
  for (const h of w.wrecks) {
    h.decay -= dt
    const crews = new Map<Owner, number>()
    const teams = new Set<number>()
    near(w, h.x, h.y, SALVAGE_RANGE + h.size * 0.25, (u) => {
      if (!isShip(u.t) || u.t.tier === 'fighter') return
      crews.set(u.owner, (crews.get(u.owner) ?? 0) + 1)
      teams.add(w.players[u.owner].team)
    })
    h.team = teams.size === 1 ? [...teams][0] : -1
    if (h.team === -1) continue
    for (const [o, n] of crews) {
      const take = Math.min(h.left, SALVAGE_RATE * Math.min(3, n) * dt)
      if (take <= 0) break
      h.left -= take
      const p = w.players[o]
      p.credits += take
      p.stats.earned += take
      p.earnedBy.salvage += take
      if (h.left <= 0) {
        note(w, p, h.value, 'salvage', 'Wreck salvaged')
        w.events.push({ k: 'salvaged', owner: o, value: h.value, x: h.x, y: h.y })
      }
    }
  }
  if (w.wrecks.some((h) => h.left <= 0 || h.decay <= 0)) w.wrecks = w.wrecks.filter((h) => h.left > 0 && h.decay > 0)
}

function kill(w: World, u: Unit, by: Owner | -1) {
  if (u.dead) return
  u.dead = true
  w.events.push({ k: 'boom', x: u.x, y: u.y, tier: u.t.tier, owner: u.owner, size: u.t.size })
  w.players[u.owner].stats.lost++
  if (by !== -1) w.players[by].stats.killed++
  // A lost defense wing craft: its station's hangar starts on a new one after a while.
  if (u.t.kind === 'wing' && u.parent) {
    const st = w.byId.get(u.parent)
    if (st && !st.dead) st.hangarT = Math.max(st.hangarT || 0, DEFENSE_WING.wait)
  }
  if (u.node >= 0 && w.nodes[u.node].site === u.id) {
    // A destroyed platform takes its claim with it: the ore is open again and has to be surveyed
    // anew, so a lost platform can't simply be put straight back up under the attacker's guns.
    const n = w.nodes[u.node]
    const prev = n.owner
    n.site = 0
    n.owner = -1
    n.claim = -1
    n.progress = 0
    if (prev !== -1) w.events.push({ k: 'survey', owner: -1, prev, node: n.id, x: n.x, y: n.y, razed: true })
  }
  leaveWreck(w, u)
  if (u.t.tier === 'yard') {
    // A yard leaves its ruin, for its owner to rebuild at half price (its expansions are lost with
    // it); ships still in its queue, and expansions not yet finished, are paid back.
    const p = w.players[u.owner]
    for (const q of u.yq ?? []) giveBack(w, p, q.paid ?? UNIT[q.unit].cost, 'ships', `Lost with the yard: ${UNIT[q.unit].name}`)
    for (const j of u.xq ?? []) giveBack(w, p, MODULE[j.id].cost, 'structures', `Lost with the yard: ${MODULE[j.id].name}`)
    u.yq = []
    u.xq = []
    ;(w.ruins ??= []).push({ id: w.wreckSeq++, owner: u.owner, unit: u.t.id, x: u.x, y: u.y, a: u.a })
  }
  if (u.t.tier === 'station' && !w.fleet) {
    // A player whose station falls is out; the last team with a station standing wins.
    w.players[u.owner].alive = false
    w.events.push({ k: 'out', owner: u.owner })
    const standing = new Set(w.players.filter((p) => p.alive).map((p) => p.team))
    if (standing.size === 1 && w.winner === -1) w.winner = [...standing][0]
  }
}

// --- Veterancy --------------------------------------------------------------------------------------

export const RANKS = ['Recruit', 'Veteran', 'Elite', 'Ace'] as const
/** Experience needed for each rank, as multiples of the ship's own cost. */
const RANK_AT = [0, 1, 3, 6]
/** Damage, hull and shield recharge gained per rank. */
export const RANK_BONUS = 0.1

/** A ship that destroys enemies worth its own cost becomes a veteran; three times, elite; six, an ace.
 * Each rank adds damage and hull (the extra hull arrives repaired) and faster shields. */
function gainXp(w: World, u: Unit, amount: number) {
  // A free defense wing craft has no price to measure its kills against: it never ranks up.
  if (!isShip(u.t) || !u.t.cost) return
  u.xp += amount
  const own = u.t.cost / u.t.squad
  while (u.rank < 3 && u.xp >= own * RANK_AT[u.rank + 1]) {
    u.rank++
    const grow = (1 + RANK_BONUS * u.rank) / (1 + RANK_BONUS * (u.rank - 1))
    u.hullMax *= grow
    if (u.rush) u.rush.gap *= grow
    u.hull = Math.min(hullCap(u), u.hull * grow + u.hullMax * 0.1)
    w.events.push({ k: 'rankUp', owner: u.owner, unit: u.id, rank: u.rank, x: u.x, y: u.y })
  }
}

function alarm(w: World, u: Unit) {
  const p = w.players[u.owner]
  if (w.time - p.lastAlarm < 20) return
  if (u.t.tier !== 'station' && u.t.tier !== 'mine' && u.t.tier !== 'defense' && u.t.tier !== 'yard' && u.t.tier !== 'capital') return
  p.lastAlarm = w.time
  w.events.push({ k: 'alarm', owner: u.owner, x: u.x, y: u.y, what: u.t.name })
}

/** One bolt landing. Shields soak it first (missiles slip most of it past), then the hardpoint it
 * was aimed at takes it, with half spilling into the hull; or the hull takes it all. */
export function damage(w: World, u: Unit, dmg: number, kind: WeaponKind, hp: number, fromX: number, fromY: number, by: Owner, shooter = 0, shieldMul = 1) {
  if (u.dead) return
  // Shot by our own side (on orders): no alarm, and nobody to shoot back at.
  const own = !foes(w, by, u.owner)
  if (!own) {
    u.lastHit = w.time
    if (shooter) u.hitBy = shooter
    alarm(w, u)
  }
  let rest = dmg
  if (u.shield > 0) {
    // Missiles slip most of it past the shields; ion bites twice as deep into them.
    // (`shieldMul`: research that hits shields harder, TechEffect shieldDamage.)
    const per = (kind === 'missile' ? 0.35 : kind === 'ion' ? 2 : 1) * shieldMul
    const onShield = dmg * per
    const soaked = Math.min(u.shield, onShield)
    u.shield -= soaked
    if (u.shield <= 0) {
      u.shieldOut = w.time
      // Shields of a warship giving out are worth hearing.
      if (u.t.tier === 'frigate' || u.t.tier === 'cruiser' || u.t.tier === 'capital' || u.t.tier === 'station' || u.t.tier === 'defense')
        w.events.push({ k: 'shieldsDown', owner: u.owner, x: u.x, y: u.y })
    }
    // What the shields took used up that much of the shot (a missile's mostly slips past them).
    rest -= kind === 'missile' ? soaked : soaked / (per || 1)
    u.shieldHit = w.time
    u.hitAngle = M.atan2(fromY - u.y, fromX - u.x)
  }
  // Ion does next to nothing to bare armour.
  if (kind === 'ion') rest *= 0.1
  if (rest <= 0) return
  if (hp >= 0 && alive(u, hp)) {
    const h = u.hps[hp]
    h.hp -= rest
    u.hull -= rest * 0.5
    if (h.hp <= 0) {
      h.hp = 0
      const p = hpPos(u, hp)
      const kindName = u.t.hardpoints[hp].kind
      const exp = u.t.hardpoints[hp].exp
      w.events.push({ k: 'hpdown', x: p.x, y: p.y, owner: u.owner, what: kindName, ...(exp ? { exp } : {}) })
      if (kindName === 'shield') u.shield = Math.min(u.shield, shieldMax(u))
    }
  } else u.hull -= rest
  if (u.hull <= 0) hullGone(w, u, own, by, shooter)
}

/** A unit whose hull has run out: destroyed, and the kill counted for whoever did it. */
function hullGone(w: World, u: Unit, own: boolean, by: Owner, shooter: number) {
  u.hull = 0
  // Our own side's kills don't count, and earn no experience.
  kill(w, u, own ? -1 : by)
  const killer = own ? undefined : w.byId.get(shooter)
  if (killer && !killer.dead) {
    killer.kills++
    gainXp(w, killer, u.t.cost / u.t.squad)
  }
}

/** A target worth shooting at: an enemy we can see, or with `friendly`, one of our own (only
 * ever on an explicit order: friendly fire never happens by itself). */
function valid(w: World, id: number, owner: Owner, friendly = false) {
  const t = w.byId.get(id)
  return t && !t.dead && (foes(w, t.owner, owner) || friendly) && sees(w, owner, t) ? t : undefined
}

/** The best thing for a ship to shoot within `r`: what its guns hurt most, nearest first. */
function pickTarget(w: World, u: Unit, r: number, ok: (e: Unit) => boolean = () => true) {
  let best: Unit | undefined
  let score = 0
  near(w, u.x, u.y, r, (e, dd) => {
    if (!foes(w, e.owner, u.owner) || !sees(w, u.owner, e) || !ok(e)) return
    // Ion ships go for shields that are still up.
    const ionPick = u.t.kind === 'ion' ? (e.shield > 0 ? 1.6 : 0.25) : 1
    const s = (dpsVs(u.t, e.t.tier) + 0.01) / (Math.sqrt(dd) + 250) * (e.t.tier === 'mine' ? 0.6 : 1) * ionPick
    if (s > score) {
      score = s
      best = e
    }
  })
  return best
}

function steer(u: Unit, tx: number, ty: number, want: number, dt: number, inPlace = false) {
  const turn = u.t.turn * (u.slow > 0 ? 0.5 : 1)
  const ang = M.atan2(ty - u.y, tx - u.x)
  const diff = wrap(ang - u.a)
  u.a = wrap(u.a + clamp(diff, -turn * dt, turn * dt))
  // Big ships slow right down to turn; fighters bank through it.
  const fighter = u.t.tier === 'fighter'
  const align = fighter ? 0.55 + 0.45 * Math.max(0, M.cos(diff)) : Math.max(inPlace ? 0 : 0.15, M.cos(diff))
  const target = want * align
  const acc = accOf(u.t) * (fighter ? 1.6 : 0.6)
  u.v += clamp(target - u.v, -acc * dt * 1.5, acc * dt)
}

/** Where to head for on the way to (tx, ty): straight there, or round the first rock in the way,
 * on whichever side of it the ship already is. Without this, a ship aimed through the middle of
 * a big rock is pushed straight back out and sits there. */
function detour(w: World, u: Unit, tx: number, ty: number) {
  const dx = tx - u.x
  const dy = ty - u.y
  const len = M.hypot(dx, dy)
  if (len < 1) return { x: tx, y: ty }
  const ux = dx / len
  const uy = dy / len
  const clear = radius(u.t) * 0.7 + 30
  let best: Rock | undefined
  let first = Infinity
  let side = 0
  for (const k of w.rocks) {
    const rx = k.x - u.x
    const ry = k.y - u.y
    const along = rx * ux + ry * uy
    const R = k.r + clear
    if (along < -R * 0.2 || along - R > len) continue
    const off = rx * uy - ry * ux
    if (Math.abs(off) >= R || along >= first) continue
    first = along
    best = k
    side = off
  }
  if (!best) return { x: tx, y: ty }
  // Pass on our side of the rock: perpendicular to our line, a little beyond the rock's edge.
  // Dead centre, pick a side by id.
  let s = Math.abs(side) > 4 ? Math.sign(side) : u.id % 2 ? 1 : -1
  const R = best.r + clear + 40
  // No room between the rock and the map's edge: go round the other way.
  const px = best.x - uy * s * R
  const py = best.y + ux * s * R
  if (px < clear || py < clear || px > w.w - clear || py > w.h - clear) s = -s
  return { x: best.x - uy * s * R, y: best.y + ux * s * R }
}

/** How far a ship moves from where it last found its way before it may look for it again. */
const REPATH = 80
/** How far a ship's path keeps from rocks (its hull may graze one by a third of its radius), sized
 * to 20-unit steps so similar ships share a grid. */
const navClear = (t: UnitType) => Math.ceil((radius(t) * 0.7 + 20) / 20) * 20

/**
 * Where to head for next on the way to (tx, ty): the next waypoint round the rocks, found once per
 * destination and dropped as each one comes into view. Asteroid fields and nebulas are steered
 * round too, as if they were rocks, except one the ship was sent into (its destination is inside)
 * or is in already: going through one has to be asked for.
 */
function waypoint(w: World, u: Unit, tx: number, ty: number): Pt {
  const patches = [...w.map.fields, ...w.map.nebulas]
  if ((!w.rocks.length && !patches.length) || u.t.tier === 'fighter') return { x: tx, y: ty }
  const clear = navClear(u.t)
  // Pushed off its line (by other hulls, or round a rock) with rocks in the way of where it heads
  // next now: the way is found again from here, once it has moved on from where it was last found.
  // (Else it flew straight at the rocks and sat there for good.)
  const next = u.route?.pts[0] ?? { x: tx, y: ty }
  const lost = !!u.route && d2(u.x, u.y, u.route.fx ?? -1e6, u.route.fy ?? -1e6) > sq(REPATH) && !clearLine(u.route.obs, u.x, u.y, next.x, next.y, clear)
  if (!u.route || u.route.x !== tx || u.route.y !== ty || lost) {
    const within = (p: { x: number; y: number; r: number }, x: number, y: number) => sq(x - p.x) + sq(y - p.y) < sq(p.r)
    const keepOut = patches.map((p, i) => (within(p, tx, ty) || within(p, u.x, u.y) ? -1 : i)).filter((i) => i >= 0)
    const find = (out: number[]) => {
      const obs = [...w.rocks, ...out.map((i) => patches[i])]
      const key = `${clear}:${out.join(',')}`
      let g = w.nav.get(key)
      if (!g) w.nav.set(key, (g = navGrid(obs, w.w, w.h, clear)))
      return { pts: findPath(g, obs, clear, u.x, u.y, tx, ty), obs }
    }
    let way = find(keepOut)
    // No way round the fields and nebulas for a hull this big: through them, rather than straight
    // at the rocks.
    if (!way.pts.length && keepOut.length && !clearLine(way.obs, u.x, u.y, tx, ty, clear)) way = find([])
    u.route = { x: tx, y: ty, ...way, fx: u.x, fy: u.y }
  }
  const { pts, obs } = u.route
  while (pts.length > 1 && (d2(u.x, u.y, pts[0].x, pts[0].y) < sq(60) || clearLine(obs, u.x, u.y, pts[1].x, pts[1].y, clear))) pts.shift()
  return pts.length ? pts[0] : { x: tx, y: ty }
}

// --- Attack spots ----------------------------------------------------------------------------------

/** The widest arc a group spreads over round its target (120 degrees): more ships than fit form a
 * second row rather than surrounding it. */
const ARC_MAX = (Math.PI * 2) / 3
/** Seconds before a group's spots are worked out again even though the group stayed the same, so
 * they follow a target that moves round. */
const RESLOT = 4
/** The least room between two warships' hulls (see the end of moveUnit). */
export const HULL_GAP = 8
/**
 * How far round itself a warship looks for hulls to keep clear of, on top of its own radius: at
 * least the biggest hull there can be (and the gap), so a small ship sees a big one coming as much
 * as the big one sees it; otherwise a gunship would never make way for a Big flagship, and the
 * flagship would be pushed back off it for ever.
 */
let bigReach = 0
const keepApartReach = () => {
  if (!bigReach) bigReach = Math.max(240, ...UNITS.map((t) => radius(t) + HULL_GAP + 4))
  return bigReach
}
/** Room a warship leaves either side of itself on the arc, on top of its hull. */
const arcGap = (r: number) => 14 + r * 0.2

/** Whether a warship fights its target from a spot: it closes in and stops at range, unlike
 * strike craft on their runs or ships holding still. Matches the branches in moveUnit. */
const closesIn = (u: Unit, e: Unit | undefined) =>
  !!e && !e.dead && u.t.tier !== 'fighter' && (u.order.k !== 'move' || (u.order.attack && u.stance !== 'hold')) && !(u.stance === 'hold' && u.order.k !== 'area')

/**
 * Warships closing in on each target, by owner and target, for this tick: worked out afresh at the
 * start of every tick from the world itself, so it carries nothing from one tick to the next (and
 * nothing a snapshot would miss). Strike craft and fighter targets are left out: fighters dart
 * about too much for an arc round them to mean anything.
 */
let spotGroups = new Map<string, Unit[]>()
function findSpotGroups(w: World) {
  spotGroups = new Map()
  for (const u of w.units) {
    if (u.dead || !isShip(u.t) || building(u) || u.retreat > 0 || !u.target) continue
    const e = w.byId.get(u.target)
    if (!e || e.t.tier === 'fighter' || !closesIn(u, e)) continue
    const k = `${u.owner}:${e.id}`
    const g = spotGroups.get(k)
    if (g) g.push(u)
    else spotGroups.set(k, [u])
  }
}

/** The ships of `u`'s side closing in on `e` right now, `u` among them, in id order. */
function spotGroup(u: Unit, e: Unit): Unit[] {
  const g = (spotGroups.get(`${u.owner}:${e.id}`) ?? []).filter((m) => m.target === e.id && !m.dead)
  if (!g.includes(u)) g.push(u)
  return g.sort((a, b) => a.id - b.id)
}

const groupKey = (g: Unit[]) => g.reduce((h, m) => Math.imul(h ^ m.id, 0x01000193), 0x811c9dc5 ^ g.length) >>> 0

/**
 * Hand out spots round `e` to a group of warships attacking it together: an arc on the side they
 * come from, centred on their average bearing, each ship given as much of it as its hull needs
 * (its width and a gap either side) at its own stopping distance, so long guns hold further back.
 * The arc grows with the group up to ARC_MAX; ships that don't fit form another row nearer in
 * (still within reach), the longest guns taking the outer row. Within a row the ships are placed
 * in the order they stand round the target, so nobody has to cross anyone else's path.
 */
function attackSpots(w: World, e: Unit, g: Unit[], key: number) {
  let sx = 0
  let sy = 0
  for (const m of g) {
    const d = M.hypot(m.x - e.x, m.y - e.y) || 1
    sx += (m.x - e.x) / d
    sy += (m.y - e.y) / d
  }
  const mid = Math.abs(sx) + Math.abs(sy) > 1e-6 ? M.atan2(sy, sx) : M.atan2(g[0].y - e.y, g[0].x - e.x)
  const bearing = (m: Unit) => wrap(M.atan2(m.y - e.y, m.x - e.x) - mid)
  const ships = g.map((m) => ({ m, stop: stopDistance(m, e).stop, r: radius(m.t) })).sort((a, b) => b.stop - a.stop || a.m.id - b.m.id)
  const inner = radius(e.t) * 0.5 + 20
  // How far out the next row may sit: the previous row's nearest spot, less the widest hull in it.
  let limit = Infinity
  let i = 0
  while (i < ships.length) {
    const row: { m: Unit; d: number; r: number; need: number; inset: number }[] = []
    let width = 0
    while (i < ships.length) {
      const s = ships[i]
      const d = Math.max(inner + s.r, Math.min(s.stop, limit))
      const need = (s.r * 2 + arcGap(s.r) * 2) / d
      if (row.length && width + need > ARC_MAX) break
      row.push({ m: s.m, d, r: s.r, need, inset: Math.max(0, s.stop - d) })
      width += need
      i++
    }
    row.sort((a, b) => bearing(a.m) - bearing(b.m) || a.m.id - b.m.id)
    let at = mid - width / 2
    for (const s of row) {
      // The spot is kept as an inset from the ship's own stopping distance, which changes as its
      // guns are shot off: 0 on the outer row.
      const held = s.m.slot?.t === e.id && s.m.slot.held
      s.m.slot = { t: e.id, key, at: w.time, a: wrap(at + s.need / 2), inset: s.inset, held }
      at += s.need
    }
    limit = Math.min(...row.map((s) => s.d)) - Math.max(...row.map((s) => s.r * 2 + arcGap(s.r)))
  }
}

/** Whether one gun can fire on `e` from where the ship is, as it is turned now: in reach from its
 * hardpoint, and inside its arc for a gun fixed to the hull (the same test `shoot` makes). Turrets
 * turn all the way round. */
function gunBears(u: Unit, g: Gun, e: Unit) {
  const from = g.hp >= 0 ? hpPos(u, g.hp) : u
  const rr = g.w.range * u.mods.range + radius(e.t) * 0.5
  if (d2(e.x, e.y, from.x, from.y) > rr * rr) return false
  return !g.w.arc || Math.abs(wrap(M.atan2(e.y - u.y, e.x - u.x) - u.a)) <= g.w.arc
}

/**
 * How a warship's guns that count against `e` (see relevantGuns) bear on it right now: `any` of
 * them, `all` of them, and whether one of them is `fixed` to the hull (only fires inside an arc
 * off the nose), so the hull has to keep pointing at the target. A ship with nothing that counts
 * goes by its stopping distance's reach.
 */
export function bearing(u: Unit, e: Unit): { any: boolean; all: boolean; fixed: boolean } {
  const guns = relevantGuns(u, e.t.tier)
  if (!guns.length) {
    const near = M.hypot(e.x - u.x, e.y - u.y) <= stopDistance(u, e).reach
    return { any: near, all: near, fixed: false }
  }
  let any = false
  let all = true
  let fixed = false
  for (const g of guns) {
    if (g.w.arc) fixed = true
    if (gunBears(u, g, e)) any = true
    else all = false
  }
  return { any, all, fixed }
}

/** Come to a stop where it is, keeping its heading. */
function holdStill(u: Unit, dt: number) {
  u.v = Math.max(0, u.v - accOf(u.t) * 0.9 * dt)
}

/**
 * At its firing spot: it settles there once every gun that counts bears on the target (coming in
 * nose first, that's at once), or once it faces it. Until then it swings round on the spot, which
 * is the only turning it does there: from then on the turrets follow the fight (see closeIn).
 */
function arrive(u: Unit, e: Unit, b: { all: boolean; fixed: boolean }, dt: number) {
  if (b.all && !b.fixed) {
    u.settled = true
    holdStill(u, dt)
    return
  }
  steer(u, e.x, e.y, 0, dt, true)
  if (Math.abs(wrap(M.atan2(e.y - u.y, e.x - u.x) - u.a)) < 0.05) u.settled = true
}

/** Which way along the axis (ax, ay) the vector (px, py) leans: 1 or -1, and by the unit's id when
 * it hardly leans either way, so every copy of a battle picks the same. */
const sideOf = (px: number, py: number, ax: number, ay: number, id: number) => {
  const dot = px * ax + py * ay
  return dot > 1e-3 ? 1 : dot < -1e-3 ? -1 : id % 2 ? 1 : -1
}

/** A ship that sets off somewhere leaves its firing spot behind. */
const unsettle = (u: Unit) => {
  if (u.settled) u.settled = false
}

/**
 * Close in on `e` and fight it from a spot: alone, straight at it until every gun that counts is
 * in reach; with others of its side on the same target, to its own place on their arc (see
 * attackSpots), then hold there facing it until the spot drifts well away or the target gets out
 * of reach. Brakes in time to stop rather than ram, and steers round rocks on the way.
 */
function closeIn(w: World, u: Unit, e: Unit, max: number, dt: number) {
  const t = u.t
  const { stop, reach } = stopDistance(u, e)
  const dist = M.hypot(e.x - u.x, e.y - u.y)
  const b = bearing(u, e)
  if (u.settled) {
    // At its firing spot the hull stays put and the turrets turn: a new target, or one shifting
    // about, changes nothing while any gun that counts can bear on it. A gun fixed to the nose
    // (a gunship's missiles) keeps the nose on the target instead. Only once nothing bears does
    // it set off again; a fighter darting out of reach is left to come back.
    if (b.fixed && dist <= reach) {
      steer(u, e.x, e.y, 0, dt, true)
      return
    }
    if (!b.fixed && (b.any || e.t.tier === 'fighter')) {
      holdStill(u, dt)
      return
    }
    u.settled = false
  }
  const g = e.t.tier === 'fighter' ? [u] : spotGroup(u, e)
  if (g.length < 2) {
    u.slot = null
    if (dist <= stop) {
      arrive(u, e, b, dt)
      return
    }
    const brake = Math.sqrt(2 * accOf(t) * 0.9 * Math.max(0, dist - stop))
    const p = closingOn(w, u, e.x, e.y, dist - stop)
    steer(u, p.x, p.y, Math.min(max, brake), dt)
    return
  }
  const key = groupKey(g)
  if (!u.slot || u.slot.t !== e.id || u.slot.key !== key || w.time - u.slot.at >= RESLOT) attackSpots(w, e, g, key)
  const s = u.slot!
  const d = Math.max(radius(e.t) * 0.5 + radius(t) + 20, stop - s.inset)
  const px = e.x + M.cos(s.a) * d
  const py = e.y + M.sin(s.a) * d
  const off = M.hypot(px - u.x, py - u.y)
  const r = radius(t)
  if (s.held && (off > 40 + r * 0.6 || dist > (stop + reach) / 2)) s.held = false
  else if (!s.held && off < 10 + r * 0.12) s.held = true
  if (s.held) {
    arrive(u, e, b, dt)
    return
  }
  const brake = Math.sqrt(2 * accOf(t) * 0.9 * off)
  const p = closingOn(w, u, px, py, off)
  steer(u, p.x, p.y, Math.min(max, brake), dt)
}

/** Where a warship closing in on a spot `left` away heads for next: from far off the way round the
 * rocks, as a move goes (to the spot rounded to CLOSE_GRID, so the path found holds while a moving
 * target stays about where it was), near it straight there round the first rock in the way. A
 * fleet sent at a target far behind a cluster of rocks sat on the first of them for ever. */
function closingOn(w: World, u: Unit, x: number, y: number, left: number) {
  if (left > CLOSE_GRID * 3) {
    const wp = waypoint(w, u, Math.round(x / CLOSE_GRID) * CLOSE_GRID, Math.round(y / CLOSE_GRID) * CLOSE_GRID)
    return detour(w, u, wp.x, wp.y)
  }
  return detour(w, u, x, y)
}
const CLOSE_GRID = 160

function moveUnit(w: World, u: Unit, dt: number) {
  const t = u.t
  if (!isShip(t) || building(u)) return
  const max = speedOf(u)
  const fighter = t.tier === 'fighter'
  const parent = u.parent ? w.byId.get(u.parent) : undefined
  if (u.parent && (!parent || parent.dead)) u.parent = 0
  if (parent && u.order.k === 'idle') {
    u.ax = parent.x
    u.ay = parent.y
  }
  // A defense wing craft with no orders of its own guards its station.
  const home = guarded(u, parent)
  if (home && u.post === undefined) u.post = freePost(w, u, home)
  // A repair order ends once the patient is whole or lost (or turned enemy).
  if (u.order.k === 'mend' && cantHeal(w, u.owner, u, w.byId.get(u.order.id))) mendDone(w, u)
  // Escorting a big ship: its slot over the hull is its post (see keepStation).
  const ward = wardOf(w, u)
  if (ward) {
    const s = stationOver(u, ward)
    u.ax = s.x
    u.ay = s.y
  } else if (u.order.k === 'guard') {
    const g = w.byId.get(u.order.id)
    if (!g || g.dead || foes(w, g.owner, u.owner)) nextOrder(u, u.x, u.y)
    else {
      // Each guard keeps its own place round it, just outside its hull.
      const ang = u.id * 2.39996
      const d = radius(g.t) + radius(t) + 60
      u.ax = g.x + M.cos(ang) * d
      u.ay = g.y + M.sin(ang) * d
    }
  }

  // Who are we fighting? Explicit attack orders stick; otherwise look around now and then.
  u.retarget -= dt
  if (u.order.k === 'attack') {
    const tgt = valid(w, u.order.id, u.owner, true)
    if (!tgt) nextOrder(u, u.x, u.y)
    else u.target = tgt.id
  } else if (u.order.k === 'area') {
    const o = u.order
    const cur = valid(w, u.target, u.owner)
    if (!cur || !inArea(o, cur) || u.retarget <= 0) {
      u.retarget = 0.8 + rand(w) * 0.4
      u.target = areaTarget(w, u, o, cur)?.id ?? 0
    }
  } else if (home) {
    // Guarding: anything inside the station's turbolaser reach, chased only a little past it.
    if (u.retarget <= 0) {
      u.retarget = 0.4 + rand(w) * 0.3
      const cur = valid(w, u.target, u.owner)
      u.target = cur && inGuardZone(home, cur, WING_GUARD.leash) ? cur.id : guardPick(w, u, home)?.id ?? 0
    }
  } else if (ward) {
    // Escorting: anything that comes within reach of our guns of the ship we escort, chased only a
    // little past that. Holding escorts never leave their slot: they fire on what their guns reach.
    if (u.retarget <= 0) {
      u.retarget = 0.4 + rand(w) * 0.3
      const cur = valid(w, u.target, u.owner)
      if (isEngineer(t)) u.target = 0
      else if (u.stance === 'hold') {
        const look = fightRange(t) * u.mods.range + (fighter ? 0 : 100)
        u.target = (cur && d2(cur.x, cur.y, u.x, u.y) < sq(look) ? cur : pickTarget(w, u, look))?.id ?? 0
      } else u.target = cur && inEscortZone(u, ward, cur, ESCORT.leash) ? cur.id : escortPick(w, u, ward)?.id ?? 0
    }
  } else if (u.retarget <= 0) {
    u.retarget = 0.4 + rand(w) * 0.3
    const guarding = u.order.k === 'guard'
    // Engineers have no guns: they never pick fights.
    const engage = !isEngineer(t) && (u.order.k === 'idle' || guarding || u.order.k === 'patrol' || (u.order.k === 'move' && u.order.attack))
    const cur = valid(w, u.target, u.owner)
    const hold = u.stance === 'hold'
    const roam = u.stance === 'roam'
    // Holding ships only look as far as their guns reach (fighters a little further); roamers as
    // far as they can see.
    const look = hold ? (fighter ? rangeDist(450) : fightRange(t) * u.mods.range + 100) : roam ? sensorOf(u) : Math.min(sensorOf(u), rangeDist(fighter ? 900 : 800))
    const leash = hold ? look : roam ? Infinity : fighter ? LEASH.fighter : LEASH.ship
    // A fight is measured from where it started: an idle ship's post, or the spot on its way
    // where it turned to fight.
    if (!cur) {
      u.gx = u.order.k === 'idle' || guarding ? u.ax : u.x
      u.gy = u.order.k === 'idle' || guarding ? u.ay : u.y
    }
    const inLeash = (e: Unit) => leash === Infinity || d2(e.x, e.y, u.gx, u.gy) < sq(leash)
    if (!engage) u.target = 0
    else if (cur && inLeash(cur) && d2(cur.x, cur.y, u.x, u.y) < sq(sensorOf(u) * 1.1)) u.target = cur.id
    else {
      // Answer whoever is shooting at us, if they're within the leash; else the best target near.
      const shooter = !hold && w.time - u.lastHit < 3 ? valid(w, u.hitBy, u.owner) : undefined
      u.target = (shooter && inLeash(shooter) ? shooter : pickTarget(w, u, look, inLeash))?.id ?? 0
    }
  }
  // On a Field repair run the patient comes first: no chasing anything.
  // So is an engineer's job.
  const job = u.order.k === 'construct' ? w.byId.get(u.order.id) : undefined
  // A repair order: Field repair craft stay with the patient between runs; tenders keep it in reach.
  const patient = u.order.k === 'mend' ? w.byId.get(u.order.id) : undefined
  const mend = mendTarget(w, u) ?? (job && !job.dead ? job : undefined) ?? (patient && t.ability === 'fieldRepair' ? patient : undefined)
  if (mend) u.target = 0
  const tgt = u.target ? w.byId.get(u.target) : undefined

  // Holding ships on the move keep going, guns firing at whatever they pass.
  const fighting = !!tgt && !tgt.dead && (u.order.k !== 'move' || (u.order.attack && u.stance !== 'hold'))
  if (mend && mend === job && isEngineer(t)) {
    // Engineers at work circle the structure slowly, each craft on its own place round the ring
    // (spread by the golden angle, so a squadron and the next fan out round it): straight to its
    // place from further out, then along the ring with it, welding as they go.
    const R = radius(mend.t) + 70 + (u.id % 3) * 16
    const ang = w.time * ENGINEERS.orbit + u.id * 2.39996
    const sx = mend.x + M.cos(ang) * R
    const sy = mend.y + M.sin(ang) * R
    const d = M.hypot(sx - u.x, sy - u.y)
    const along = d > 90 ? 0 : 0.35
    steer(u, mend.x + M.cos(ang + along) * R, mend.y + M.sin(ang + along) * R, Math.min(max * 0.8, R * ENGINEERS.orbit + d * 1.6), dt)
  } else if (mend) {
    // Circle the patient just outside its hull: aim a little ahead round it from where we are, so
    // the craft orbit rather than ram, and fly straight at it from further out.
    const R = radius(mend.t) + 60 + (u.id % 3) * 15
    const ang = M.atan2(u.y - mend.y, u.x - mend.x) + 0.7
    steer(u, mend.x + M.cos(ang) * R, mend.y + M.sin(ang) * R, max * 0.8, dt)
  } else if (patient && t.support) tendTo(w, u, patient, max, dt)
  else if (fighting && !(ward && u.stance === 'hold')) {
    const e = tgt!
    if (fighter && e.t.tier !== 'fighter') {
      // Strafing runs on anything bigger: dive in guns-first, pull away past the hull, and fly out
      // far enough to turn round and line up again before coming back into range.
      const dist = M.hypot(e.x - u.x, e.y - u.y)
      const r = radius(e.t)
      if (dist < r + 50) u.breakOff = true
      else if (dist > r + rangeDist(320)) u.breakOff = false
      if (u.breakOff) steer(u, u.x + M.cos(u.a) * 100 + ((u.id % 5) - 2) * 20, u.y + M.sin(u.a) * 100, max, dt)
      else steer(u, e.x + ((u.id % 7) - 3) * 6, e.y + ((u.id % 5) - 2) * 6, max, dt)
    } else if (fighter) {
      // Dogfight: chase with a little lead, overshoot, loop back round.
      const lead = M.hypot(e.x - u.x, e.y - u.y) / 700
      const ex = e.x + M.cos(e.a) * e.v * lead
      const ey = e.y + M.sin(e.a) * e.v * lead
      const close = d2(u.x, u.y, e.x, e.y) < sq(radius(e.t) + 45)
      if (close) steer(u, u.x + M.cos(u.a) * 100, u.y + M.sin(u.a) * 100, max, dt)
      else steer(u, ex + ((u.id % 7) - 3) * 8, ey + ((u.id % 5) - 2) * 8, max, dt)
    } else if (u.stance === 'hold' && u.order.k !== 'area') {
      // An area attack was an order to go in: holding ships only hold otherwise. The hull turns
      // only for a gun fixed to the nose, or to bring a gun to bear when none does.
      const b = bearing(u, e)
      if (b.fixed || !b.any) steer(u, e.x, e.y, 0, dt, true)
      else holdStill(u, dt)
    } else closeIn(w, u, e, max, dt)
  } else if (u.order.k === 'area') {
    // Nothing to shoot: done once the circle is in sight (or reached) and empty; until then, close in.
    const o = u.order
    const dist = M.hypot(o.x - u.x, o.y - u.y)
    const clear = !w.units.some((e) => !e.dead && foes(w, e.owner, u.owner) && sees(w, u.owner, e) && inArea(o, e))
    if (clear && (dist < o.r * 0.8 || canSee(w, w.players[u.owner].team, o.x, o.y))) nextOrder(u, u.x, u.y)
    else if (dist > o.r * 0.5) {
      unsettle(u)
      const wp = waypoint(w, u, o.x, o.y)
      const p = detour(w, u, wp.x, wp.y)
      steer(u, p.x, p.y, fighter ? max : Math.min(max, dist * 0.9 + 12), dt)
    } else u.v = Math.max(0, u.v - accOf(t) * dt)
  } else if (u.order.k === 'move' || u.order.k === 'patrol') {
    const o = u.order
    const dist = M.hypot(o.x - u.x, o.y - u.y)
    const pace = Math.min(max, o.speed)
    if (dist < (fighter ? 60 : 24 + radius(t) * 0.2)) {
      if (o.k === 'patrol') u.order = { ...o, x: o.bx, y: o.by, bx: o.x, by: o.y }
      else nextOrder(u, o.x, o.y, o.face ?? null)
    } else {
      unsettle(u)
      const wp = waypoint(w, u, o.x, o.y)
      const p = detour(w, u, wp.x, wp.y)
      steer(u, p.x, p.y, fighter ? pace : Math.min(pace, dist * 0.9 + 12), dt)
    }
  } else if (home) {
    // Guarding with nothing to fight: fly to its slot round the station, slow down, and park
    // there facing out.
    const s = guardSlot(home, u.post ?? 0)
    const dist = M.hypot(s.x - u.x, s.y - u.y)
    if (dist > WING_GUARD.park) {
      // Brake in time to stop on it, and slow right down while not yet pointed at it, so the
      // craft turns in tight and settles instead of looping round the slot.
      const facing = M.cos(wrap(M.atan2(s.y - u.y, s.x - u.x) - u.a))
      steer(u, s.x, s.y, Math.min(max, Math.sqrt(t.speed * 1.2 * dist)) * clamp(facing, 0.1, 1), dt)
    } else steer(u, u.x + M.cos(s.a) * 100, u.y + M.sin(s.a) * 100, 0, dt, true)
  } else if (ward) keepStation(w, u, ward, max, dt)
  else {
    // Idle: fighters circle their spot, everything else drifts back to it and waits.
    const dist = M.hypot(u.ax - u.x, u.ay - u.y)
    if (fighter) {
      const ang = w.time * 0.9 + u.id
      const r = 70 + (u.id % 4) * 18
      steer(u, u.ax + M.cos(ang) * r, u.ay + M.sin(ang) * r, max * 0.65, dt)
    } else if (dist > 30 + radius(t) * 0.3) {
      unsettle(u)
      const wp = waypoint(w, u, u.ax, u.ay)
      const p = detour(w, u, wp.x, wp.y)
      steer(u, p.x, p.y, Math.min(max, dist * 0.8 + 10), dt)
    } else if (u.face !== null && Math.abs(wrap(u.face - u.a)) > 0.01) {
      // Swing round in place to the heading it was told to arrive with.
      steer(u, u.x + M.cos(u.face) * 100, u.y + M.sin(u.face) * 100, 0, dt, true)
    } else u.v = Math.max(0, u.v - accOf(t) * dt)
  }

  u.x += M.cos(u.a) * u.v * dt
  u.y += M.sin(u.a) * u.v * dt

  // Keep clear of rocks, structures and each other (fighters only dodge the big stuff).
  const r0 = radius(t)
  for (const k of w.rocks) {
    const min = k.r + r0 * 0.7
    const dd = d2(u.x, u.y, k.x, k.y)
    if (dd < min * min) {
      const d = Math.sqrt(dd) || 1
      u.x = k.x + ((u.x - k.x) / d) * min
      u.y = k.y + ((u.y - k.y) / d) * min
    }
  }
  if (!fighter) {
    // Warships keep a small gap between hulls rather than overlapping. Inside the gap they ease
    // apart slowly, so a tight group settles instead of jostling; a real overlap (hulls a quarter
    // or more into each other) is pushed out faster, as before.
    // Who gives way goes by class (see pushClass): a smaller hull never moves a bigger one. It
    // takes the whole push itself and slides off round the bigger hull, and a bigger ship coming
    // through moves it aside out of its path rather than shoving it along ahead.
    // Ships two or more classes apart don't touch at all: the small one flies straight across the
    // big hull, and the big one doesn't move it (see overlaps).
    const bx = u.x
    const by = u.y
    const mine = pushClass(u)
    near(w, u.x, u.y, r0 + keepApartReach(), (o, dd) => {
      if (o === u || o.t.tier === 'fighter' || planned(o) || overlaps(u, o)) return
      const touch = r0 + radius(o.t)
      const min = touch + HULL_GAP
      if (dd >= min * min) return
      const theirs = pushClass(o)
      // A smaller hull pressing on us: it makes way (in its own move), we don't.
      if (theirs < mine) return
      // Each of a pair of the same class moves part of the overlap away per tick; the smaller of
      // two ships takes all of it, and against a structure, which doesn't budge, a little more.
      const d = Math.sqrt(dd) || 1
      const rate = d < touch * 0.75 ? 4 : 1.5
      const bigger = isShip(o.t) && theirs > mine
      const push = (min - d) * Math.min(1, rate * dt) * (!isShip(o.t) ? 2.5 : bigger ? 2 : 1)
      const nx = d > 1 ? (u.x - o.x) / d : M.cos(u.id)
      const ny = d > 1 ? (u.y - o.y) / d : M.sin(u.id)
      u.x += nx * push
      u.y += ny * push
      if (!bigger) return
      // Running into the bigger hull: the part of our way that heads into it turns into a slide
      // round it, on the side we're already on (by id when dead centre), so we steer round it.
      const hx = M.cos(u.a)
      const hy = M.sin(u.a)
      const into = -(hx * nx + hy * ny)
      if (u.v > 1 && into > 0) {
        const s = sideOf(hx + into * nx, hy + into * ny, -ny, nx, u.id)
        u.x += -ny * s * into * u.v * dt * 0.6
        u.y += nx * s * into * u.v * dt * 0.6
      }
      // The bigger ship coming our way: step aside out of its path, to the side we're on.
      const ox = M.cos(o.a)
      const oy = M.sin(o.a)
      const ahead = ox * nx + oy * ny
      if (o.v > 1 && ahead > 0) {
        const s = sideOf(nx - ahead * ox, ny - ahead * oy, -oy, ox, u.id)
        u.x += -oy * s * ahead * o.v * dt * 0.8
        u.y += ox * s * ahead * o.v * dt * 0.8
      }
    })
    // A waiting ship that was nudged aside takes the nudge as its new spot, instead of steering
    // back into its neighbour and being nudged out again for ever.
    if (u.order.k === 'idle' && !u.target && !u.parent) {
      u.ax += u.x - bx
      u.ay += u.y - by
    }
  }
  u.x = clamp(u.x, 20, w.w - 20)
  u.y = clamp(u.y, 20, w.h - 20)
}

const BOLT_SPEED: Record<WeaponKind, number> = { laser: 1100, flak: 1250, turbo: 850, missile: 480, ion: 700 }

function fire(w: World, u: Unit, g: Gun, e: Unit) {
  const from = g.hp >= 0 ? hpPos(u, g.hp) : u.t.tier === 'fighter' ? { x: u.x + M.cos(u.a) * 10, y: u.y + M.sin(u.a) * 10 } : shipPoint(u, 3 + rand(w) * 4, 2 + rand(w) * 6)
  // Aim: the hardpoint we were told to hit, or (for heavy guns) whatever hardpoint faces us.
  let hp = -1
  const forced = u.order.k === 'attack' && u.order.id === e.id ? u.order.hp : -1
  if (forced >= 0 && alive(e, forced)) hp = forced
  else if (e.hps.length && rand(w) < 0.6) {
    let bd = Infinity
    e.hps.forEach((h, i) => {
      if (h.hp <= 0) return
      const p = hpPos(e, i)
      const dd = d2(p.x, p.y, from.x, from.y)
      if (dd < bd) {
        bd = dd
        hp = i
      }
    })
  }
  const aim = hp >= 0 ? hpPos(e, hp) : { x: e.x + (rand(w) - 0.5) * radius(e.t) * 0.8, y: e.y + (rand(w) - 0.5) * radius(e.t) * 0.8 }
  const speed = BOLT_SPEED[g.w.kind]
  let t = M.hypot(aim.x - from.x, aim.y - from.y) / speed
  let ax = aim.x + M.cos(e.a) * e.v * t
  let ay = aim.y + M.sin(e.a) * e.v * t
  const hit = rand(w) < accuracy(g.w.kind, e.t.tier) * (e.slow > 0 ? 1.2 : 1)
  if (!hit) {
    const off = radius(e.t) * (0.8 + rand(w)) + 20
    const side = rand(w) < 0.5 ? -1 : 1
    const ang = M.atan2(ay - from.y, ax - from.x) + side * Math.PI / 2
    ax += M.cos(ang) * off
    ay += M.sin(ang) * off
  }
  t = M.hypot(ax - from.x, ay - from.y) / speed
  let dmg = g.w.damage * effect(g.w.kind, e.t.tier)
  if (u.abilityOn > 0 && u.t.ability === 'broadside' && g.w.kind === 'turbo') dmg *= 1.6
  dmg *= (u.t.tier === 'station' && !moduleUp(u, 'sensor') ? 1 : u.mods.damage) * (1 + RANK_BONUS * u.rank)
  if (u.t.kind === 'wing' && !atHome(w, u)) dmg *= DEFENSE_WING.away
  if (e.t.kind === 'wing' && atHome(w, e)) dmg *= DEFENSE_WING.guard
  if (fireControl.length) dmg *= 1 + controlBonus(w, u)
  w.shots.push({
    x: from.x, y: from.y, vx: (ax - from.x) / Math.max(t, 0.001), vy: (ay - from.y) / Math.max(t, 0.001), left: hit ? t : t * 1.6,
    kind: g.w.kind, owner: u.owner, target: e.id, hp, dmg, hit, sx: from.x, sy: from.y, age: 0, from: u.id,
    ...(u.mods.shieldDamage ? { sh: u.mods.shieldDamage } : {}),
  })
  w.events.push({ k: 'fire', kind: g.w.kind, x: from.x, y: from.y, owner: u.owner, light: u.t.tier === 'fighter' })
}

function shoot(w: World, u: Unit, dt: number) {
  if (building(u) || !u.guns.length) return
  // A structure's focus, while it's still there to shoot at; else the ship's own target.
  if (u.focus && !valid(w, u.focus, u.owner, true)) u.focus = 0
  const primary = u.focus ? w.byId.get(u.focus) : u.target ? w.byId.get(u.target) : undefined
  for (const g of u.guns) {
    if (g.hp >= 0 && !alive(u, g.hp)) continue
    g.cd -= dt
    if (g.burst > 0) {
      g.burstT -= dt
      if (g.burstT <= 0) {
        const e = valid(w, g.target, u.owner, true)
        if (e) fire(w, u, g, e)
        g.burst--
        g.burstT = 0.11
      }
      continue
    }
    if (g.cd > 0) continue
    const from = g.hp >= 0 ? hpPos(u, g.hp) : u
    const inReach = (e: Unit) => {
      const rr = g.w.range * u.mods.range + radius(e.t) * 0.5
      if (d2(e.x, e.y, from.x, from.y) > rr * rr) return false
      if (g.w.arc && Math.abs(wrap(M.atan2(e.y - u.y, e.x - u.x) - u.a)) > g.w.arc) return false
      return true
    }
    // First this gun's own focus, then the structure's (or the ship's target): each only while it
    // can reach it and its weapon can hurt it, so a heavy gun told to focus a cruiser doesn't waste
    // shots on fighters, and flak keeps working on the fighters meanwhile.
    // A structure-wide focus is only taken up by guns that are good against it (flak doesn't turn
    // from fighters to plink at a frigate); a gun aimed on its own, or a ship's target, by any gun
    // that does real damage.
    if (g.focus && !valid(w, g.focus, u.owner, true)) g.focus = 0
    // One of our own only when it was ordered: this gun's or the structure's focus, or an attack order.
    const ordered = (o: Unit) => o.id === g.focus || o.id === u.focus || (u.order.k === 'attack' && u.order.id === o.id)
    const usable = (o: Unit | undefined, need = 0.3) => !!o && !o.dead && (foes(w, o.owner, u.owner) || ordered(o)) && sees(w, u.owner, o) && effect(g.w.kind, o.t.tier) >= need && inReach(o)
    const own = g.focus ? w.byId.get(g.focus) : undefined
    let e: Unit | undefined = usable(own) ? own : usable(primary, u.focus ? 0.5 : 0.3) ? primary : undefined
    if (!e) {
      // Left to itself, a gun picks what its weapon is made for (flak the small craft, heavy guns
      // the warships), nearer first, and leans towards finishing off what's already hurt and
      // answering whatever is shooting at us.
      let score = 0
      near(w, from.x, from.y, g.w.range + 200, (o, dd) => {
        if (!foes(w, o.owner, u.owner) || !sees(w, u.owner, o) || !inReach(o)) return
        const hurt = 1 - o.hull / Math.max(1, o.hullMax)
        const threat = o.target === u.id || u.hitBy === o.id ? 1.5 : 1
        const s = ((effect(g.w.kind, o.t.tier) * accuracy(g.w.kind, o.t.tier)) / (Math.sqrt(dd) + 200)) * (1 + 0.6 * hurt) * threat
        if (s > score) {
          score = s
          e = o
        }
      })
      // Nothing it's good against nearby: then the focus after all, if it can do anything to it.
      if (!e && u.focus && usable(primary)) e = primary
    }
    if (!e) {
      // Nothing to shoot: the gun lets go of its last target, so its turret goes back to scanning.
      g.target = 0
      g.cd = 0.15
      continue
    }
    g.target = e.id
    g.aim = M.atan2(e.y - from.y, e.x - from.x)
    fire(w, u, g, e)
    const barrage = u.abilityOn > 0 && u.t.ability === 'flakBarrage' && g.w.kind === 'flak' ? 0.5 : 1
    g.cd = g.w.cooldown * barrage * u.mods.cooldown * (0.9 + rand(w) * 0.2)
    g.burst = (g.w.burst ?? 1) - 1
    g.burstT = 0.11
  }
}

function moveShots(w: World, dt: number) {
  const keep: Shot[] = []
  for (const s of w.shots) {
    s.age += dt
    // Missiles home in; bolts fly straight.
    if (s.kind === 'missile' && s.hit) {
      const e = w.byId.get(s.target)
      if (e && !e.dead) {
        const sp = M.hypot(s.vx, s.vy)
        const ang = M.atan2(e.y - s.y, e.x - s.x)
        const cur = M.atan2(s.vy, s.vx)
        const na = cur + clamp(wrap(ang - cur), -3 * dt, 3 * dt)
        s.vx = M.cos(na) * sp
        s.vy = M.sin(na) * sp
        s.left = Math.max(s.left, M.hypot(e.x - s.x, e.y - s.y) / sp)
      }
    }
    s.x += s.vx * dt
    s.y += s.vy * dt
    s.left -= dt
    if (s.left > 0 && s.age < 4) {
      keep.push(s)
      continue
    }
    if (!s.hit) continue
    const e = w.byId.get(s.target)
    if (!e || e.dead) continue
    const shielded = e.shield > 0
    damage(w, e, s.dmg, s.kind, s.hp, s.sx, s.sy, s.owner, s.from, s.sh ?? 1)
    w.events.push({ k: 'hit', kind: s.kind, x: s.x, y: s.y, shield: shielded && s.kind !== 'missile', owner: e.owner })
  }
  w.shots = keep
}

function economy(w: World, dt: number) {
  for (let o = 0; o < w.players.length; o++) {
    const p = w.players[o]
    const st = w.byId.get(p.station)
    if (!st || st.dead) continue
    p.credits += p.income * dt
    p.stats.earned += p.income * dt
    p.earnedBy.station += p.incomeParts.station * dt
    p.earnedBy.mines += p.incomeParts.mines * dt
    p.earnedBy.beacons += p.incomeParts.beacons * dt
    // Refunds from retreated ships come in once their time is up.
    while (p.refunds.length && p.refunds[0].at <= w.time) {
      const r = p.refunds.shift()!
      p.credits += r.amount
      p.stats.earned += r.amount
      p.earnedBy.refunds += r.amount
      note(w, p, r.amount, 'refund', `Retreat refund: ${UNIT[r.unit].name}`)
      w.events.push({ k: 'refunded', owner: o, unit: r.unit, amount: r.amount })
    }
    // A point for the economy chart every few seconds.
    if (!p.history.length || w.time - p.history[p.history.length - 1].t >= HISTORY_STEP) p.history.push({ t: w.time, credits: p.credits, income: p.income })
    const r = p.research[0]
    if (r) {
      r.left -= dt
      if (r.left <= 0) {
        p.research.shift()
        if (r.id === LEVEL_UP) {
          p.level++
          restation(w, st)
          w.events.push({ k: 'level', owner: o, level: p.level })
        } else finishResearch(w, o, r.id)
      }
    }
    // Repair docks mend our ships parked near the station, and a yard's Drydock those near it; a
    // ship near both gets the better rate, not the two added up.
    const mend = new Map<Unit, number>()
    const dock = (x: number, y: number, r: number, rate: number) =>
      near(w, x, y, r, (u) => {
        if (u.owner === o && isShip(u.t) && u.hull < u.hullMax) mend.set(u, Math.max(mend.get(u) ?? 0, rate))
      })
    const repair = moduleUp(st, 'dock') ? techBonus(p, st.t.id).repair : 0
    if (repair) dock(st.x, st.y, rangeDist(900), repair)
    if (w.hybrid) for (const y of w.units) if (!y.dead && y.owner === o && y.t.tier === 'yard' && expUp(y, 'drydock')) dock(y.x, y.y, radius(y.t) + MODULE_FX.reach, MODULE_FX.repair)
    if (w.hybrid) for (const y of w.units) if (!y.dead && y.owner === o && y.t.tier === 'yard' && expUp(y, 'drydock')) near(w, y.x, y.y, radius(y.t) + MODULE_FX.reach, (u) => u.rush && u.owner === o && (u.rush.work = true))
    for (const [u, rate] of mend) u.hull = Math.min(hullCap(u), u.hull + u.hullMax * rate * dt)
    const q = p.queue[0]
    if (q) {
      q.left -= dt * (hangarsUp(st) ? 1 : 0.5)
      if (q.left <= 0) {
        p.queue.shift()
        p.stats.built++
        if (q.reserve) {
          p.reserve.push(q.unit)
          w.events.push({ k: 'reserved', owner: o, unit: q.unit })
        } else if (launches(w)) launchFrom(w, o, q.unit, st, p.rally)
        else if (fromHangar(UNIT[q.unit])) {
          // Bombers launch from the Strike hangar while it stands.
          const strike = UNIT[q.unit].kind === 'bomber' && expUp(st, 'strikeHangar')
          const bay = st.t.hardpoints.findIndex((h) => (strike ? h.exp === 'strikeHangar' : h.kind === 'hangar' && !h.exp))
          const from = bay >= 0 ? hpPos(st, bay) : st
          const a = M.atan2(p.rally.y - from.y, p.rally.x - from.x)
          const group = spawnGroup(w, q.unit, o, from.x, from.y, a)
          for (const u of group) u.v = u.t.speed * 0.5
          cmdMove(w, o, group.map((u) => u.id), p.rally.x, p.rally.y, true)
          w.events.push({ k: 'built', owner: o, unit: q.unit, x: from.x, y: from.y })
        } else {
          const at = yardSpot(w, o, st, q.unit)
          warpIn(w, o, q.unit, at.x, at.y, at.a, WARP_YARD, true)
        }
      }
    }
    // The yards' own queues: work goes at half speed while a yard's slipway is shot off. A Frigate
    // Yard with its Second slip standing works on the first two ships at once.
    if (w.hybrid) for (const y of w.units) {
      if (y.dead || y.owner !== o || y.t.tier !== 'yard' || !y.yq?.length || building(y)) continue
      const slips = Math.min(y.yq.length, expUp(y, 'secondSlip') ? 2 : 1)
      const pace = dt * (moduleUp(y, 'dock') ? 1 : 0.5)
      // After a rush launch the next ship it starts goes slower (RUSH.slowdown).
      if (y.slowNext) {
        y.yq[0].slow = true
        delete y.slowNext
      }
      for (let i = 0; i < slips; i++) y.yq[i].left -= y.yq[i].slow ? pace / (1 + rushRules(w).slowdown) : pace
      const done = y.yq.slice(0, slips).filter((q) => q.left <= 0)
      if (!done.length) continue
      y.yq = y.yq.filter((q) => !done.includes(q))
      for (const yq of done) {
        p.stats.built++
        if (yq.reserve) {
          p.reserve.push(yq.unit)
          w.events.push({ k: 'reserved', owner: o, unit: yq.unit })
        } else if (launches(w)) launchFrom(w, o, yq.unit, y, y.yr ?? p.rally)
        else {
          const rally = y.yr ?? p.rally
          const at = yardSpot(w, o, y, yq.unit, rally)
          warpIn(w, o, yq.unit, at.x, at.y, at.a, WARP_YARD, true, rally)
        }
      }
    }
  }
}

/**
 * Taking a beacon or surveying ore. With ships of one team alone near it, that team's progress
 * fills up and it becomes theirs; a spot someone else holds (or half-claimed) has to be wound back
 * to nothing first. Contested spots freeze; abandoned ones drift back to whoever holds them.
 * Returns the previous owner when the owner changed.
 */
function claim(c: Claimable, power: number[], rate: number, drift: number, lapse = false): number | null {
  const present = power.map((p, t) => (p > 0 ? t : -1)).filter((t) => t >= 0)
  const prev = c.owner
  if (present.length === 1) {
    const t = present[0]
    const step = rate * Math.min(2, Math.sqrt(power[t]))
    if ((c.owner !== -1 && c.owner !== t) || (c.claim !== t && c.progress > 0)) {
      c.progress = Math.max(0, c.progress - step)
      if (c.progress === 0) {
        c.owner = -1
        c.claim = t
      }
    } else {
      c.claim = t
      c.progress = Math.min(1, c.progress + step)
      if (c.progress === 1) c.owner = t
    }
  } else if (present.length === 0) {
    if (lapse) {
      // A claim nobody builds on or guards fades away, back to open ore.
      c.progress = Math.max(0, c.progress - drift)
      if (c.progress === 0) c.owner = -1
    } else {
      const home = c.owner !== -1 ? 1 : 0
      if (c.owner !== -1) c.claim = c.owner
      c.progress += clamp(home - c.progress, -drift, drift)
    }
  }
  return c.owner !== prev ? prev : null
}

function beacons(w: World, dt: number) {
  for (const b of w.beacons) {
    const power = new Array(w.teams).fill(0)
    near(w, b.x, b.y, 320, (u) => {
      if (isShip(u.t)) power[w.players[u.owner].team] += u.t.tier === 'fighter' ? 0.25 : 1
    })
    const prev = claim(b, power, dt / 14, dt / 40)
    if (prev !== null) w.events.push({ k: 'beacon', owner: b.owner, prev, x: b.x, y: b.y })
  }
}

/** Seconds for an unguarded, unbuilt ore claim to fade back to open ore. */
export const CLAIM_LAPSE = 90

/** Surveying ore: our ships near an empty asteroid, with no enemy ships there, claim it in
 * SURVEY_TIME seconds; taking one from the enemy means undoing their claim first. */
function survey(w: World, dt: number) {
  for (const n of w.nodes) {
    if (n.site) continue
    const power = new Array(w.teams).fill(0)
    near(w, n.x, n.y, SURVEY_RADIUS, (u) => {
      if (isShip(u.t)) power[w.players[u.owner].team] = 1
    })
    // An empty claim lapses in about a minute and a half without ships nearby.
    const prev = claim(n, power, dt / SURVEY_TIME, dt / CLAIM_LAPSE, true)
    if (prev !== null) w.events.push({ k: 'survey', owner: n.owner, prev, node: n.id, x: n.x, y: n.y })
  }
}

/** What each team can see: anything within sensor range of one of its ships or structures. */
function sight(w: World) {
  const eyes: Unit[][] = Array.from({ length: w.teams }, () => [])
  for (const u of w.units) if (!u.dead) eyes[w.players[u.owner].team].push(u)
  for (const u of w.units) {
    if (u.dead) continue
    const own = w.players[u.owner].team
    for (let t = 0; t < w.teams; t++) {
      // Stations are always on the map: everyone knows where they are.
      if (t === own || u.t.tier === 'station') {
        u.seen[t] = true
        continue
      }
      // A yard nobody has started on is only marked out on its owner's maps.
      if (planned(u)) {
        u.seen[t] = false
        continue
      }
      let s = false
      for (const e of eyes[t]) {
        const r = sensorOf(e)
        if (d2(u.x, u.y, e.x, e.y) < r * r) {
          s = true
          break
        }
      }
      u.seen[t] = s
    }
  }
}

// --- Terrain ---------------------------------------------------------------------------------------

/** Sensor range inside a nebula, as a share of the normal range. */
export const NEBULA_SENSOR = 0.5
/** Shields bleed away this share of their full strength per second inside a nebula. */
const NEBULA_DRAIN = 1.5
/** Below this speed a ship is drifting, not ploughing through rocks. */
const FIELD_MIN_SPEED = 10
/** Share of a ship's full shields that rocks knock off per 1000 units flown through a field (a
 * ship with no shields: of half its hull). A big ship crossing a typical field (about 800 units)
 * loses around a quarter of its shields; a Swarm hull, which has none, about an eighth of its hull. */
export const FIELD_WEAR = 0.3
/** Rocks scrape hulls but never finish a ship off: they stop at this share of the hull. */
const FIELD_HULL_FLOOR = 0.15
/** Only big ships are too clumsy to dodge the rocks; fighters and gunships weave through. */
const CLUMSY: Partial<Record<Tier, true>> = { frigate: true, cruiser: true, capital: true }
// --- Defense wings -----------------------------------------------------------------------------------

/** A station's defense wing in a loose ring round it, as its carrier fighters would be: their
 * station is their parent, so idle ones keep to it and they count towards no fleet. */
function spawnWing(w: World, st: Unit) {
  const t = wingOf(st.t.faction)
  const g = spawnGroup(w, t.id, st.owner, st.x + radius(st.t) + 140, st.y, st.a)
  for (const u of g) u.parent = st.id
  st.hangarT = 0
}

/**
 * How a defense wing guards its station: it takes on anything inside the reach of the station's
 * turbolasers, chases it at most `leash` further out, and otherwise waits parked round the station,
 * each craft in its own slot `out` outside the hull (it counts as there within `park`).
 */
const WING_GUARD = { leash: 250, out: 80, park: 8 }

/** The station a defense wing craft is guarding: its own, while it stands and the craft has no
 * orders of its own (none given, or all of them done). */
function guarded(u: Unit, parent: Unit | undefined): Unit | undefined {
  return u.t.kind === 'wing' && parent && !parent.dead && wingHome(parent) && u.order.k === 'idle' && !u.queue.length ? parent : undefined
}

/** Whether a structure keeps a defense wing: every station, and a Capital Yard with its Fighter
 * wing built (shot off or not: the craft already out stay with it). */
const wingHome = (u: Unit) => u.t.tier === 'station' || (u.t.tier === 'yard' && !!u.xm?.includes('fighterWing'))
/** Whether a structure's wing hangar stands, so it can send out new wing craft: the station's own
 * hangars, the Capital Yard's Fighter wing. */
const wingBayUp = (u: Unit) => (u.t.tier === 'station' ? hangarsUp(u) : expUp(u, 'fighterWing'))
/** The hardpoints a structure's wing craft launch from. */
const wingBays = (u: Unit) => u.t.hardpoints.map((h, i) => ((u.t.tier === 'station' ? h.kind === 'hangar' && !h.exp : h.exp === 'fighterWing') && alive(u, i) ? i : -1)).filter((i) => i >= 0)

/** The first parking slot round a station that none of the rest of its wing has taken. */
function freePost(w: World, u: Unit, st: Unit) {
  const taken = new Set<number>()
  for (const o of w.units) if (o !== u && !o.dead && o.parent === st.id && o.t.kind === 'wing' && o.post !== undefined) taken.add(o.post)
  let i = 0
  while (taken.has(i)) i++
  return i
}

/** Where a wing craft parks while guarding: slot `post` of the squadron's, spread evenly round the
 * station just outside its hull, and the heading it faces there (straight out). */
export function guardSlot(st: Unit, post: number) {
  const n = wingOf(st.t.faction).squad
  const a = st.a + ((post % n) + 0.5) * (Math.PI * 2 / n)
  const d = radius(st.t) + WING_GUARD.out
  return { x: st.x + M.cos(a) * d, y: st.y + M.sin(a) * d, a }
}

/** The station's turbolasers as they sit: each mount and how far its gun reaches, research range
 * bonuses counted, the same way `shoot` measures it. Shot-off mounts still count, so the ground
 * the wing holds doesn't shrink as the guns are lost. */
function turboReach(st: Unit): { x: number; y: number; r: number }[] {
  const out: { x: number; y: number; r: number }[] = []
  for (const g of st.guns) {
    if (g.w.kind !== 'turbo') continue
    const p = g.hp >= 0 ? hpPos(st, g.hp) : st
    out.push({ x: p.x, y: p.y, r: g.w.range * st.mods.range })
  }
  if (!out.length) {
    // No turbolasers at all: the plan's, from the middle.
    const plan = STATIONS[st.t.faction].modules.find((m) => m.weapon?.kind === 'turbo')
    out.push({ x: st.x, y: st.y, r: (plan?.weapon?.range ?? 800) * st.mods.range })
  }
  return out
}

/** Whether `e` is inside the station's turbolaser reach (and `extra` more): within range of one of
 * the guns, plus half its own size, as `shoot` measures it. */
export function inGuardZone(st: Unit, e: Unit, extra = 0, guns = turboReach(st)) {
  const half = radius(e.t) * 0.5
  return guns.some((g) => d2(e.x, e.y, g.x, g.y) <= sq(g.r + half + extra))
}

/** The best enemy for a guarding wing craft to take on: one inside the station's turbolaser
 * reach, scored as pickTarget does, and more so if it's going for the station or this craft. */
function guardPick(w: World, u: Unit, st: Unit): Unit | undefined {
  const guns = turboReach(st)
  const span = Math.max(...guns.map((g) => M.hypot(g.x - st.x, g.y - st.y) + g.r)) + 300
  let best: Unit | undefined
  let score = 0
  near(w, st.x, st.y, span, (e) => {
    if (!foes(w, e.owner, u.owner) || !sees(w, u.owner, e) || !inGuardZone(st, e, 0, guns)) return
    const threat = e.target === st.id || e.target === u.id || u.hitBy === e.id ? 1.5 : 1
    const s = ((dpsVs(u.t, e.t.tier) + 0.01) / (Math.sqrt(d2(e.x, e.y, u.x, u.y)) + 250)) * (e.t.tier === 'mine' ? 0.6 : 1) * threat
    if (s > score) {
      score = s
      best = e
    }
  })
  return best
}

/** Whether a defense wing craft is at home: its station stands and it's within reach of it. */
export function atHome(w: World, u: Unit) {
  const st = u.parent ? w.byId.get(u.parent) : undefined
  return !!st && !st.dead && d2(u.x, u.y, st.x, st.y) < sq(DEFENSE_WING.radius)
}

/** A station's defense wing as it stands: craft left, full strength, and seconds to the next one
 * (null while it's whole, Infinity while the hangar is down). */
export function wingState(w: World, st: Unit) {
  let left = 0
  for (const u of w.units) if (!u.dead && u.parent === st.id && u.t.kind === 'wing') left++
  const full = wingOf(st.t.faction).squad
  return { left, full, next: left >= full ? null : wingBayUp(st) ? Math.max(0, st.hangarT || 0) : Infinity }
}

/**
 * Stations rebuild their defense wings: while one is short of craft and its hangar stands, the
 * countdown runs (a loss sets it to at least DEFENSE_WING.wait) and each time it's up one craft
 * launches from a hangar and joins what's left of the squadron, the next DEFENSE_WING.every
 * seconds later. A shot-off hangar holds the countdown where it is until it's mended.
 */
function wings(w: World, dt: number) {
  for (const st of w.units) {
    if (st.dead || !wingHome(st) || building(st)) continue
    const t = wingOf(st.t.faction)
    let left = 0
    let squad = 0
    for (const u of w.units)
      if (!u.dead && u.parent === st.id && u.t.kind === 'wing') {
        left++
        squad = u.squad
      }
    if (left >= t.squad) {
      st.hangarT = 0
      continue
    }
    if (!wingBayUp(st)) continue
    st.hangarT = (st.hangarT || 0) - dt
    if (st.hangarT > 0) continue
    st.hangarT = DEFENSE_WING.every
    const bay = hpPos(st, wingBays(st)[0])
    const u = spawn(w, t.id, st.owner, bay.x, bay.y, st.a, squad || w.squadSeq++)
    u.parent = st.id
    u.v = t.speed * 0.5
    w.events.push({ k: 'launch', owner: st.owner, x: bay.x, y: bay.y })
  }
}

// --- Escorts -----------------------------------------------------------------------------------------

/**
 * Escorts: ships told to guard a friendly ship at least OVERLAP_GAP classes bigger (see escorts),
 * which they fly over. Each keeps station on a slot of its own over the big hull (escortSlot),
 * moving and turning with it. Enemies that come within reach of its guns of the ship it escorts it
 * takes on, chasing them at most `leash` further out, as a defense wing does round its station, and
 * it goes back to its slot once they're dealt with or gone. Repair escorts mend their ship first:
 * Field repair crews start a run on it once it has lost `mend` of itself, and tenders patch it before
 * anyone else. When the ship is lost, its escorts carry on with their next orders, or wait where they
 * are.
 */
export const ESCORT = { leash: 300, mend: 0.03, out: 0.2, gap: 14 }

/** The ship `u` escorts: the one its guard order is on, while that's a friendly ship it escorts. */
export function wardOf(w: World, u: Unit): Unit | undefined {
  if (u.dead || u.order.k !== 'guard') return undefined
  const g = w.byId.get(u.order.id)
  return g && !g.dead && !foes(w, g.owner, u.owner) && escorts(u, g) ? g : undefined
}

/**
 * Every escorted ship's escorts by its id, in id order, which is how they share out the slots:
 * worked out afresh at the start of every tick from the orders themselves, like spotGroups, so it
 * carries nothing from one tick to the next (and nothing a snapshot would miss).
 */
let escortGroups = new Map<number, Unit[]>()
function findEscorts(w: World) {
  escortGroups = new Map()
  for (const u of w.units) {
    const g = wardOf(w, u)
    if (!g) continue
    const list = escortGroups.get(g.id)
    if (list) list.push(u)
    else escortGroups.set(g.id, [u])
  }
  for (const list of escortGroups.values()) list.sort((a, b) => a.id - b.id)
}

/** The ships escorting `g` right now (for the HUD and the map). */
export const escortsOf = (w: World, g: Unit) => w.units.filter((u) => wardOf(w, u) === g)

/**
 * Where escort `i` of `n` keeps station over `g`: down both flanks in turn, spread evenly from
 * just ahead of the middle to well aft, close in to the spine (hulls taper towards the bow, and are
 * widest aft), so it rides over the hull. The slots are fixed to the hull, so they move and turn
 * with it, and the escorts re-form round it as it turns. `er` is the escort's own radius: bigger
 * escorts sit a little further out from the spine (ESCORT.out of it, plus ESCORT.gap), so the
 * two of a pair keep clear of each other and of the hull's middle.
 */
export function escortSlot(g: Unit, i: number, n: number, er = 0): Pt & { a: number } {
  const [gw, gh] = dims(g.t)
  const rows = Math.ceil(n / 2)
  const row = Math.floor(i / 2)
  const side = (i % 2 ? -1 : 1) * (gw * 0.2 + er * ESCORT.out + ESCORT.gap)
  const fwd = gh * (rows > 1 ? 0.1 - (0.4 * row) / (rows - 1) : -0.05)
  const c = M.cos(g.a)
  const s = M.sin(g.a)
  return { x: g.x + c * fwd - s * side, y: g.y + s * fwd + c * side, a: g.a }
}

/** Where `u` keeps station over `g`, by its place among the ship's escorts. */
function stationOver(u: Unit, g: Unit) {
  const list = escortGroups.get(g.id)
  const i = list ? list.indexOf(u) : -1
  const n = list?.length ?? 0
  const er = radius(u.t)
  return i >= 0 ? escortSlot(g, i, n, er) : escortSlot(g, n, n + 1, er)
}

/** How far from the middle of the ship it escorts an escort takes on enemies: its guns' reach from
 * the big hull's edge (its radius), plus half the enemy's own hull, and `extra`. */
function inEscortZone(u: Unit, g: Unit, e: Unit, extra = 0) {
  const r = fightRange(u.t) * u.mods.range + radius(g.t) + radius(e.t) * 0.5 + extra
  return d2(e.x, e.y, g.x, g.y) <= r * r
}

/** The best enemy for an escort to take on: one inside its zone round the ship it escorts, scored
 * as pickTarget does, and more so if it's going for that ship or this one. */
function escortPick(w: World, u: Unit, g: Unit): Unit | undefined {
  let best: Unit | undefined
  let score = 0
  near(w, g.x, g.y, fightRange(u.t) * u.mods.range + radius(g.t) + keepApartReach(), (e) => {
    if (!foes(w, e.owner, u.owner) || !sees(w, u.owner, e) || !inEscortZone(u, g, e)) return
    const threat = e.target === g.id || e.target === u.id || u.hitBy === e.id ? 1.5 : 1
    const s = ((dpsVs(u.t, e.t.tier) + 0.01) / (Math.sqrt(d2(e.x, e.y, u.x, u.y)) + 250)) * (e.t.tier === 'mine' ? 0.6 : 1) * threat
    if (s > score) {
      score = s
      best = e
    }
  })
  return best
}

/**
 * An escort with nothing to fight keeps station on its slot: from further off it flies there flat
 * out, led by how far the ship it escorts will have got meanwhile; on its slot it matches that ship's
 * heading and pace, closing what is left of the gap, and turns with it where it stands. Strike craft
 * can't hover: they circle their slot as it goes.
 */
function keepStation(w: World, u: Unit, g: Unit, max: number, dt: number) {
  const t = u.t
  const s = stationOver(u, g)
  const ca = M.cos(g.a)
  const sa = M.sin(g.a)
  if (t.tier === 'fighter') {
    const ang = w.time * 1.2 + u.id
    const r = 40 + (u.id % 4) * 14
    steer(u, s.x + M.cos(ang) * r + ca * g.v * 0.5, s.y + M.sin(ang) * r + sa * g.v * 0.5, Math.min(max, max * 0.6 + g.v), dt)
    return
  }
  const dx = s.x - u.x
  const dy = s.y - u.y
  const dist = M.hypot(dx, dy)
  const close = 24 + radius(t) * 0.3
  if (g.v < 4) {
    // The ship is waiting: fly to the slot, braking in time to stop on it and slowing right down
    // while not yet pointed at it (so it turns in tight rather than looping round), then turn to
    // the ship's heading where it stands.
    if (dist > close * 0.4) {
      unsettle(u)
      const facing = M.cos(wrap(M.atan2(dy, dx) - u.a))
      steer(u, s.x, s.y, Math.min(max, Math.sqrt(accOf(t) * 1.2 * dist)) * clamp(facing, 0.1, 1), dt)
    } else if (Math.abs(wrap(g.a - u.a)) > 0.01) steer(u, u.x + ca * 100, u.y + sa * 100, 0, dt, true)
    else u.v = Math.max(0, u.v - accOf(t) * dt)
    return
  }
  if (dist > close * 3) {
    unsettle(u)
    const lead = Math.min(2, dist / Math.max(1, max)) * g.v
    const p = detour(w, u, s.x + ca * lead, s.y + sa * lead)
    steer(u, p.x, p.y, Math.min(max, g.v + Math.sqrt(accOf(t) * 1.2 * dist)), dt)
    return
  }
  // On station: the ship's own heading and pace, plus a little to close the gap along it; the aim
  // point well ahead along its heading pulls the escort back onto its line from either side.
  const along = dx * ca + dy * sa
  steer(u, s.x + ca * (120 + g.v), s.y + sa * (120 + g.v), clamp(g.v + along * 1.5, 0, max), dt)
}

/**
 * A tender told to repair `p`: it closes to just outside the patient's hull (well inside its own
 * reach), from further off round the rocks, and keeps there, moving with the patient when it moves.
 * Over a hull two classes bigger it may sit over it, as escorts do.
 */
function tendTo(w: World, u: Unit, p: Unit, max: number, dt: number) {
  const t = u.t
  const want = Math.min(radius(p.t) + radius(t) + 30, t.support!.range * 0.6)
  const dx = u.x - p.x
  const dy = u.y - p.y
  const d = Math.hypot(dx, dy) || 1
  const sx = p.x + (dx / d) * want
  const sy = p.y + (dy / d) * want
  if (d > want + 40) {
    unsettle(u)
    const off = Math.hypot(sx - u.x, sy - u.y)
    const wp = waypoint(w, u, sx, sy)
    const q = detour(w, u, wp.x, wp.y)
    steer(u, q.x, q.y, Math.min(max, p.v + off * 0.9 + 12), dt)
  } else if (p.v > 4) steer(u, sx + M.cos(p.a) * 120, sy + M.sin(p.a) * 120, Math.min(max, p.v), dt)
  else u.v = Math.max(0, u.v - accOf(t) * dt)
}

// --- Field repair ------------------------------------------------------------------------------------

/** How much of a ship's hull is missing, plus a little for modules that are hurt but still standing,
 * and on a station for each shot-off module too (Field repair rebuilds those only on stations). */
function mendNeed(t: Unit) {
  let mods = 0
  let lost = 0
  for (const h of t.hps) {
    if (h.hp <= 0) lost++
    else if (h.hp < h.max) mods += 1 - h.hp / h.max
  }
  const rebuild = t.t.tier === 'station' ? lost * FIELD_REPAIR.lost : 0
  return 1 - t.hull / t.hullMax + (t.hps.length ? (mods / t.hps.length) * 0.5 : 0) + rebuild
}

/**
 * A repair craft's share of rebuilding a station's shot-off modules: one module at a time, the one
 * with the most strength first. That puts the hangar first (it brings the defense wing back), then
 * the shield generators, then the turbolasers, the sensor, refinery and dock, and the flak last,
 * which is the order a station needs them in, without a list of its own to keep up. Equals go by
 * their place on the station, so every machine picks the same one. Progress stays on the module
 * between runs, so a lone craft finishes the job on its next run. Whoever does the welding pays
 * (`payer`): mending an ally's station costs them nothing.
 */
function rebuildModule(w: World, t: Unit, dt: number, payer: Owner = t.owner) {
  const p = w.players[payer]
  let pick = -1
  t.hps.forEach((h, i) => {
    if (h.hp > 0) return
    // A shot-off expansion is welded back for part of its price, paid as the work on it starts;
    // one we can't pay for yet waits.
    const x = t.t.hardpoints[i].exp
    if (x && !h.fix && p.credits < moduleRebuildCost(x)) return
    if (pick < 0 || h.max > t.hps[pick].max) pick = i
  })
  if (pick < 0) return
  const h = t.hps[pick]
  const x = t.t.hardpoints[pick].exp
  if (x && !h.fix) spend(w, p, moduleRebuildCost(x), 'repairs', `Rebuilding: ${MODULE[x].name}`)
  h.fix = (h.fix ?? 0) + dt
  if (h.fix < FIELD_REPAIR.rebuild) return
  h.fix = 0
  h.hp = h.max * FIELD_REPAIR.back
}

/** Why a repair craft of `owner` can't mend `t`, or null when it can: a station, or a ship of
 * gunship class or bigger, on our side, finished, and with something to mend (on a station, a
 * shot-off module counts). */
export function cantMend(w: World, owner: Owner, t: Unit | undefined): string | null {
  if (!t || t.dead || foes(w, t.owner, owner)) return 'Pick one of our ships or stations'
  if (!MENDABLE.includes(t.t.tier)) return 'Field repair works on stations and on gunships and bigger'
  if (building(t)) return 'Still under construction'
  if (mendNeed(t) < 0.002) return 'Nothing to repair'
  return null
}

/** The ship or station a repair craft would go to by itself within `r`: the most damaged (at least
 * `least` of it missing), nearer ones first. Walks every unit rather than the grid, since orders
 * run between ticks, when the grid may not be built (just after a reload). */
function mendPick(w: World, u: Unit, r: number, least: number): Unit | undefined {
  let best: Unit | undefined
  let score = 0
  for (const t of w.units) {
    if (t === u || t.dead || cantMend(w, u.owner, t)) continue
    const dd = d2(t.x, t.y, u.x, u.y)
    if (dd > r * r) continue
    const need = mendNeed(t)
    if (need < least) continue
    const s = need / (1 + Math.sqrt(dd) / r)
    if (s > score) {
      score = s
      best = t
    }
  }
  return best
}

function startMend(w: World, u: Unit, to: Unit) {
  const ab = ABILITIES.fieldRepair
  u.abilityCd = ab.cooldown
  u.abilityOn = ab.duration
  u.aid = to.id
  w.events.push({ k: 'ability', owner: u.owner, id: 'fieldRepair', x: u.x, y: u.y })
}

/** The ship or station a repair craft is mending right now, if it's on a run and it still needs it. */
export function mendTarget(w: World, u: Unit) {
  const t = u.aid && u.abilityOn > 0 ? w.byId.get(u.aid) : undefined
  return t && !t.dead ? t : undefined
}

/** How close (centre to centre, beyond the patient's own body) a repair craft must be to weld. */
export const mendReach = (t: UnitType) => radius(t) + FIELD_REPAIR.reach
/** Seconds between idle repair crews looking round for someone to mend. */
const MEND_LOOK = 0.5
/** How far beyond welding reach a craft told to repair a ship starts its run (the run's clock
 * starts then, so not from across the map). */
const MEND_START = 300

/**
 * Field repair: craft on a run weld their patient while in reach (hull, and modules that still
 * stand, and on a station the shot-off ones too), ending the run early once it's whole or gone. Idle (or guarding) crews with the ability
 * ready look round now and then and start a run on anything nearby that has lost a tenth of itself.
 */
function fieldRepairs(w: World, dt: number) {
  // Counted in ticks: the clock is a sum of floats, and comparing its floors flickers at the edges.
  const look = Math.round(w.time / STEP) % Math.round(MEND_LOOK / STEP) === 0
  for (const u of w.units) {
    if (u.dead || u.t.ability !== 'fieldRepair') continue
    u.mending = []
    if (u.aid) {
      const t = w.byId.get(u.aid)
      if (u.abilityOn <= 0 || cantMend(w, u.owner, t)) {
        u.aid = 0
        u.abilityOn = 0
        continue
      }
      if (d2(t!.x, t!.y, u.x, u.y) > sq(mendReach(t!.t))) continue
      t!.hull = Math.min(hullCap(t!), t!.hull + (FIELD_REPAIR.flat + FIELD_REPAIR.share * t!.hullMax) * dt)
      if (t!.rush) t!.rush.work = true
      for (const h of t!.hps) if (h.hp > 0 && h.hp < h.max) h.hp = Math.min(h.max, h.hp + h.max * FIELD_REPAIR.share * dt)
      // Only the main station gets its shot-off modules rebuilt; ships keep theirs lost for now.
      if (t!.t.tier === 'station') rebuildModule(w, t!, dt, u.owner)
      u.mending.push(t!.id)
      continue
    }
    // Told to repair one: a run on it as soon as the ability is ready and the patient near.
    if (u.order.k === 'mend') {
      const p = w.byId.get(u.order.id)
      if (u.abilityCd <= 0 && !building(u) && p && !cantMend(w, u.owner, p) && d2(p.x, p.y, u.x, u.y) < sq(mendReach(p.t) + MEND_START)) startMend(w, u, p)
      continue
    }
    if (!look || u.abilityCd > 0 || building(u) || (u.order.k !== 'idle' && u.order.k !== 'guard')) continue
    // An escort mends the ship it escorts first, at the first real damage.
    const ward = wardOf(w, u)
    const to = ward && !cantMend(w, u.owner, ward) && mendNeed(ward) >= ESCORT.mend ? ward : mendPick(w, u, rangeDist(900), 0.1)
    if (to) startMend(w, u, to)
  }
}

/** Support ships patch up the hulls of damaged allied ships near them, the most damaged first. */
function tenders(w: World, dt: number) {
  for (const u of w.units) {
    const sp = u.t.support
    if (!sp || u.dead) continue
    u.mending = []
    if (building(u)) continue
    const team = w.players[u.owner].team
    const hurt: Unit[] = []
    near(w, u.x, u.y, sp.range, (o) => {
      if (o !== u && !o.dead && isShip(o.t) && w.players[o.owner].team === team && o.hull < hullCap(o)) hurt.push(o)
    })
    hurt.sort((a, b) => a.hull / a.hullMax - b.hull / b.hullMax)
    // A tender told to repair one patches it first; an escort the ship it escorts.
    const ward = u.order.k === 'mend' ? w.byId.get(u.order.id) : wardOf(w, u)
    const wi = ward ? hurt.indexOf(ward) : -1
    if (wi > 0) hurt.unshift(...hurt.splice(wi, 1))
    const rate = sp.repair * (1 + (techBonus(w.players[u.owner], u.t.id).repair ?? 0)) * dt
    for (const o of hurt.slice(0, sp.max)) {
      o.hull = Math.min(hullCap(o), o.hull + rate)
      u.mending.push(o.id)
    }
  }
}

/**
 * Nebulas and asteroid fields acting on one unit this tick. A nebula drains the shields and keeps
 * them down (and `sensorOf` halves the sensors while `nebula` is set). A big ship moving through
 * an asteroid field takes a steady patter of hits, more the faster it goes: shields first, then
 * hull. Neither counts as being attacked, so no alarms, no kill credit and nobody to shoot back at;
 * but a living hull doesn't grow back while the rocks are hitting it (they set `scraped`, which
 * restarts its wait like a hit: see calm). Returns true while the terrain keeps the shields from
 * recharging.
 */
function terrain(w: World, u: Unit, dt: number) {
  const ship = isShip(u.t)
  u.nebula = ship && w.map.nebulas.length > 0 && inside(w.map.nebulas, u.x, u.y)
  if (u.nebula) {
    u.shield = Math.max(0, u.shield - shieldFull(u) * NEBULA_DRAIN * dt)
    return true
  }
  if (!CLUMSY[u.t.tier] || u.v < FIELD_MIN_SPEED || !w.map.fields.length || !inside(w.map.fields, u.x, u.y)) return false
  let wear = FIELD_WEAR * (shieldFull(u) || u.hullMax * 0.5) * (u.v / 1000) * dt
  const soaked = Math.min(u.shield, wear)
  u.shield -= soaked
  wear -= soaked
  if (wear > 0) u.hull = Math.max(Math.min(u.hull, u.hullMax * FIELD_HULL_FLOOR), u.hull - wear)
  u.scraped = w.time
  return true
}

// --- Faction mechanics -----------------------------------------------------------------------------------
//
// What a unit's type can switch on (data/kit.ts UnitType): living hulls that grow back, a drain aura,
// a fire-control aura, a shield-projector aura. A station that launches strike craft is a carrier (see tick and launch); a
// spinal gun is a hardpoint weapon with an arc (see shoot and bearing). Each is off unless a unit
// sets it, and none of them draws a random number, so every copy of a battle agrees.

/** Living hulls (UnitType regrow): out of the fight for `delay` seconds (nothing has hit it, and no
 * asteroid field's rocks either: see calm), the hull grows back by `rate` of its full hull a
 * second, as far as it can go (a rush-launched ship's unbuilt hull stays unbuilt). Only the hull:
 * modules are mended as ever. */
function regrow(w: World, u: Unit, dt: number) {
  const g = regrowOf(u)!
  if (calm(w, u) < g.delay) return
  const cap = hullCap(u)
  if (u.hull < cap) u.hull = Math.min(cap, u.hull + u.hullMax * g.rate * dt)
}

/**
 * Drain auras (UnitType drain): each one takes `dps` hull points a second off the `targets`
 * nearest enemies it can see within `radius` (nearest first, ties by id, so every copy of the
 * battle picks the same ones), straight off the hull past shields and modules, and gives `heal` of
 * what it took to our damaged ships within `radius` (itself included), shared out evenly. What one
 * can't use (it's mended full) is lost, not passed on.
 */
function drains(w: World, dt: number) {
  const prey: { e: Unit; d: number }[] = []
  for (const u of w.units) {
    const d = u.t.drain ? drainOf(u) : null
    if (!d || u.dead || building(u) || u.site || u.launch) continue
    let took = 0
    prey.length = 0
    u.drained = []
    near(w, u.x, u.y, d.radius, (e, dd) => {
      if (foes(w, e.owner, u.owner) && sees(w, u.owner, e) && !planned(e) && e.hull > 0) prey.push({ e, d: dd })
    })
    prey.sort((a, b) => a.d - b.d || a.e.id - b.e.id)
    for (let i = 0; i < prey.length && i < d.targets; i++) {
      const e = prey[i].e
      const bite = Math.min(e.hull, d.dps * dt)
      if (bite <= 0) continue
      took += bite
      u.drained.push(e.id)
      e.lastHit = w.time
      e.hitBy = u.id
      alarm(w, e)
      e.hull -= bite
      if (e.hull <= 0) hullGone(w, e, false, u.owner, u.id)
    }
    if (took <= 0 || d.heal <= 0) continue
    const hurt: Unit[] = []
    near(w, u.x, u.y, d.radius, (a) => {
      if (!foes(w, a.owner, u.owner) && isShip(a.t) && !a.launch && a.hull < hullCap(a)) hurt.push(a)
    })
    const each = (took * d.heal) / Math.max(1, hurt.length)
    for (const a of hurt) a.hull = Math.min(hullCap(a), a.hull + each)
  }
}

/** The fire-control auras standing this tick (UnitType fireControl): worked out once a tick, so a
 * shot only looks through these few. Only ever read during a tick, which fills it afresh. */
const fireControl: Unit[] = []
/** How much harder `u` hits under fire control: the best aura of its side it is within (auras
 * don't stack), 0 when none. Only ships are directed. */
function controlBonus(w: World, u: Unit) {
  if (!isShip(u.t)) return 0
  let best = 0
  for (const a of fireControl) {
    const f = auraOf(a)!
    if (f.bonus > best && !a.dead && !foes(w, a.owner, u.owner) && d2(a.x, a.y, u.x, u.y) <= f.radius * f.radius) best = f.bonus
  }
  return best
}

/** The shield projectors standing this tick (UnitType shieldAura): worked out once a tick, like
 * fireControl. Only ever read during a tick, which fills it afresh. */
const projectors: Unit[] = []
/** How much faster `u`'s shields recharge under a shield projector: the best aura of its side it
 * is within (auras don't stack), 0 when none. Only ships are covered. */
function projectorBoost(w: World, u: Unit) {
  if (!projectors.length || !isShip(u.t)) return 0
  let best = 0
  for (const a of projectors) {
    const s = shieldAuraOf(a)!
    if (s.regen > best && !foes(w, a.owner, u.owner) && d2(a.x, a.y, u.x, u.y) <= s.radius * s.radius) best = s.regen
  }
  return best
}

export function tick(w: World, dt = STEP) {
  if (w.winner !== -1) return
  w.time += dt
  buildGrid(w)
  w.seenT -= dt
  if (w.seenT <= 0) {
    w.seenT = 0.25
    sight(w)
    refreshPlayers(w)
  }
  economy(w, dt)
  arrivals(w)
  repairs(w, dt)
  siteUpgrades(w, dt)
  beacons(w, dt)
  survey(w, dt)
  salvage(w, dt)
  tenders(w, dt)
  fieldRepairs(w, dt)
  drains(w, dt)
  construction(w, dt)
  finishing(w, dt)
  if (w.hybrid) expansions(w, dt)
  wings(w, dt)
  findSpotGroups(w)
  findEscorts(w)
  fireControl.length = 0
  projectors.length = 0
  for (const u of w.units) {
    if (u.t.fireControl && !u.dead && !building(u) && !u.site) fireControl.push(u)
    if (u.t.shieldAura && projecting(u)) projectors.push(u)
  }
  for (const u of w.units) {
    if (u.dead) continue
    // A yard goes up only as fast as engineers build it (see construction).
    if (u.site) continue
    if (u.building > 0) {
      u.building -= dt
      u.hull = Math.min(u.hullMax, u.hull + (u.hullMax * 0.75 * dt) / u.t.build)
      if (u.building <= 0) {
        u.building = 0
        w.events.push({ k: 'built', owner: u.owner, unit: u.t.id, x: u.x, y: u.y })
      }
      continue
    }
    if (u.abilityCd > 0) u.abilityCd -= dt
    if (u.abilityOn > 0) {
      u.abilityOn -= dt
      if (u.t.ability === 'repairSwarm') u.hull = Math.min(hullCap(u), u.hull + u.hullMax * 0.03 * dt)
    }
    if (u.slow > 0) u.slow -= dt
    // Shields recharge, faster once out of the fight for a few seconds; terrain can stop that, and
    // failed shields take a few seconds to come back at all, rather than flickering on and off.
    if (!terrain(w, u, dt) && w.time - u.shieldOut >= SHIELD_REBOOT) {
      const smax = shieldMax(u)
      if (u.shield < smax) u.shield = Math.min(smax, u.shield + u.t.regen * u.mods.regen * (coreUp(u) ? 1 + MODULE_FX.regen : 1) * (1 + RANK_BONUS * u.rank) * (1 + projectorBoost(w, u)) * dt * (w.time - u.lastHit > 6 ? 2 : 1))
    }
    if (u.t.regrow) regrow(w, u, dt)
    // A new ship on its way out of its yard or the station's hangar: nothing else until it's clear.
    if (u.launch) {
      launching(w, u, dt)
      continue
    }
    if (u.t.carrier) {
      // A station's brood keeps a clock of its own: its hangarT is its defense wing's.
      const every = u.t.carrier.every * (techBonus(w.players[u.owner], u.t.id).hangar ? 0.7 : 1)
      if (u.t.tier === 'station') {
        u.broodT = (u.broodT ?? 0) + dt
        if (u.broodT >= every) {
          u.broodT = 0
          launch(w, u)
        }
      } else {
        u.hangarT += dt
        if (u.hangarT >= every) {
          u.hangarT = 0
          launch(w, u)
        }
      }
    }
    if (u.retreat > 0) {
      retreating(w, u, dt)
      if (!u.dead) shoot(w, u, dt)
      continue
    }
    moveUnit(w, u, dt)
    shoot(w, u, dt)
  }
  moveShots(w, dt)
  if (w.units.some((u) => u.dead)) {
    for (const u of w.units) if (u.dead) w.byId.delete(u.id)
    w.units = w.units.filter((u) => !u.dead)
  }
  for (const r of w.rocks) r.rot += r.spin * dt
  if (w.fleet) fleetEnd(w, dt)
}

/** A fleet battle is over when at most one team still has anything: ships or structures on the
 * field, ships jumping in, or ships waiting in orbit. Ships only jumping out don't count. */
function fleetEnd(w: World, dt: number) {
  const f = w.fleet!
  f.endT -= dt
  if (f.endT > 0) return
  f.endT = 0.5
  const standing = new Set<number>()
  for (const u of w.units) if (!u.dead && u.retreat <= 0 && !u.parent) standing.add(w.players[u.owner].team)
  for (const a of w.arrivals) standing.add(w.players[a.owner].team)
  w.players.forEach((p) => p.reserve.length && standing.add(p.team))
  if (standing.size <= 1) w.winner = standing.size ? [...standing][0] : f.holder
}

/** One side of a fleet battle: its ships (type ids; a fighter id is a whole squadron), and for the
 * side holding the planet, its station's level (0: none). `reserve`: more ships, held back by the
 * fleet's orders: they start in the reserve, to be called in during the battle. `yards` and `exp`:
 * the holder's buildings round its station (a conquest planet's yards and the expansions on them
 * and on the station); given, the battle has hybrid bases (see newFleetBattle). */
export type FleetSide = { faction: FactionId; team: number; ships: string[]; reserve?: string[]; /** Among `ships` and `reserve`, those rush-launched unfinished (see RushedIn); `held`: one of the reserve. */ rushed?: RushedIn[]; station?: number; techs?: string[]; yards?: ('yard' | 'cyard')[]; exp?: ModuleId[] }

/**
 * A galactic conquest battle over a planet. The first side holds it: its station (if any) sits at
 * the first spawn with its fleet in front; the other fleets drop out of hyperspace at the other
 * spawns. Each side starts with up to `cap` fleet size on the field, biggest ships first, and the
 * rest waits in orbit to be called in from the reserve, with any ships its fleets held back.
 *
 * A holder that brings its buildings (FleetSide `yards`, `exp`) fights with hybrid bases: its
 * Command Station carries its expansions and its yards stand round it (see baseSpots) with theirs,
 * so a Drydock mends, an Armour works plates the frigates, a Shield core feeds the station's
 * shields and a Fighter wing flies, as in a skirmish. Nothing is built during the battle: a fleet
 * battle has no economy (cantBuild, placement and moduleLock refuse while `fleet` is set), so a
 * planet fights with what it has, and builds in the galaxy's queue.
 */
export function newFleetBattle(map: MapDef, sides: FleetSide[], opts: { seed?: number; cap?: number } = {}): World {
  const w = newWorld(map, sides.map((s, i) => ({ faction: s.faction, team: s.team, spawn: i, incomeMul: 0 })), { seed: opts.seed, credits: 0, fleet: true })
  const cap = opts.cap ?? FLEET_CAP
  const c = { x: w.w / 2, y: w.h / 2 }
  w.fleet = { entry: sides.map((_, i) => ({ x: map.spawns[i].x, y: map.spawns[i].y, r: mapDist(1300) })), cap, holder: sides[0].team, endT: 3 }
  if (sides[0].station && (sides[0].yards || sides[0].exp)) {
    w.hybrid = true
    w.ruins = []
  }
  sides.forEach((s, o) => {
    const p = w.players[o]
    p.techs = [...(s.techs ?? [])]
    const sp = map.spawns[o]
    const face = M.atan2(c.y - sp.y, c.x - sp.x)
    if (o === 0 && s.station) {
      p.level = s.station
      const st = spawn(w, unitOf(p.faction, 'station').id, o, sp.x, sp.y, face - Math.PI / 2)
      p.station = st.id
      spawnWing(w, st)
      if (w.hybrid) raiseBase(w, st, s.yards ?? [], s.exp ?? [], map.spawns.slice(1, sides.length))
    }
    // Biggest first onto the field, up to the cap; the rest waits in orbit.
    const order = [...s.ships].sort((a, b) => UNIT[b].pop - UNIT[a].pop)
    let used = 0
    const field: string[] = []
    for (const id of order) {
      if (used + UNIT[id].pop <= cap || !field.length) {
        field.push(id)
        used += UNIT[id].pop
      } else p.reserve.push(id)
    }
    p.reserve.push(...(s.reserve ?? []))
    // Rush-launched ships: the ones sent onto the field come out unfinished; the others wait in the reserve as such.
    const pool = (s.rushed ?? []).map((r) => ({ ...r }))
    const takeRush = (id: string, heldBack: boolean) => {
      let i = pool.findIndex((r) => r.unit === id && !!r.held === heldBack)
      if (i < 0) i = pool.findIndex((r) => r.unit === id)
      return i >= 0 ? pool.splice(i, 1)[0] : undefined
    }
    const fieldRush = field.map((id) => takeRush(id, false))
    if (pool.length) p.rushRes = pool
    // A loose block facing the middle: rows across, big ships in the middle rows.
    const fx = M.cos(face)
    const fy = M.sin(face)
    const ahead = o === 0 && s.station ? 650 : 0
    const perRow = 5
    field.forEach((id, i) => {
      const rush = fieldRush[i]
      const row = Math.floor(i / perRow)
      const col = (i % perRow) - (Math.min(perRow, field.length - row * perRow) - 1) / 2
      const gap = Math.max(170, radius(UNIT[id]) * 2.4)
      const x = sp.x + fx * (ahead - row * 260) - fy * col * gap
      const y = sp.y + fy * (ahead - row * 260) + fx * col * gap
      // The holder is already there; the others arrive from hyperspace, a few at a time.
      if (o === 0) {
        const g = spawnGroup(w, id, o, x, y, face)
        for (const u of g) {
          u.stance = 'maneuver'
          if (rush) unfinished(u, rush.built, rush.left)
        }
      } else warpIn(w, o, id, x, y, face, 1 + i * 0.25, false, undefined, rush ? { built: rush.built, left: rush.left } : undefined)
    })
  })
  refreshPlayers(w)
  return w
}

/**
 * Where a conquest planet's yards stand round its station: on the side away from where the
 * attackers come in, inside the build radius, each facing away from the station (as an AI's yards
 * do). Each takes the first clear spot (see siteProblem) from a fixed list of bearings and
 * distances, the Frigate Yard trying one flank first and the Capital Yard the other, so the same
 * planet on the same map always looks the same, and nothing is left to chance (no `rand`).
 */
export function baseSpots(w: World, st: Unit, kinds: ('yard' | 'cyard')[], attackers: Pt[]): { kind: 'yard' | 'cyard'; x: number; y: number; a: number }[] {
  const from = attackers.length ? { x: attackers.reduce((s, q) => s + q.x, 0) / attackers.length, y: attackers.reduce((s, q) => s + q.y, 0) / attackers.length } : { x: w.w / 2, y: w.h / 2 }
  const away = M.atan2(st.y - from.y, st.x - from.x)
  const out: { kind: 'yard' | 'cyard'; x: number; y: number; a: number }[] = []
  const box = (kind: 'yard' | 'cyard') => yardBox(yardOf(st.t.faction, kind))
  for (const kind of kinds) {
    const t = yardOf(st.t.faction, kind)
    const { hl, hw } = box(kind)
    const flank = kind === 'yard' ? 1 : -1
    let spot: { x: number; y: number; a: number } | null = null
    for (const turn of [1.1, 1.45, 0.75, 1.8, 0.4, 1.25, 0.95, 1.6, 0.6, 0.2, 2.2, 2.6, 0])
      for (const side of [flank, -flank])
        for (const d of [mapDist(1150), mapDist(1450), mapDist(900), mapDist(1650), mapDist(1300), mapDist(1000), mapDist(1740)]) {
          if (spot) break
          const b = away + side * turn
          const x = st.x + M.cos(b) * d
          const y = st.y + M.sin(b) * d
          const a = M.atan2(y - st.y, x - st.x)
          // (Clear of the yards placed before it, too.)
          if (siteProblem(w, st.owner, t, st, x, y, a) || out.some((q) => boxesNear(x, y, a, hl, hw, q.x, q.y, q.a, box(q.kind).hl, box(q.kind).hw, 60))) continue
          spot = { x, y, a }
        }
    if (spot) out.push({ kind, ...spot })
  }
  return out
}

/** A conquest planet's base as it stands when the battle starts: the station's expansions, then each
 * yard at its spot, finished, with its own expansions (and a Fighter wing's squadron). */
function raiseBase(w: World, st: Unit, yards: ('yard' | 'cyard')[], exp: ModuleId[], attackers: Pt[]) {
  const ids = Object.keys(MODULE) as ModuleId[]
  const onStation = ids.filter((id) => exp.includes(id) && MODULE[id].on === 'station')
  if (onStation.length) {
    st.xm = onStation
    restation(w, st)
  }
  for (const s of baseSpots(w, st, yards, attackers)) {
    const y = spawn(w, yardOf(st.t.faction, s.kind).id, st.owner, s.x, s.y, s.a)
    // Standing from the start: its queue open, but it says nothing of being built.
    finishSite(w, y)
    w.events.pop()
    const mods = ids.filter((id) => exp.includes(id) && MODULE[id].on === s.kind)
    if (!mods.length) continue
    y.xm = mods
    retype(w, y, yardType(y.t.id, y.xm))
    if (mods.includes('fighterWing')) spawnWing(w, y)
  }
}

/** What of player `o`'s base stands at the end of a battle: its yards, and of the expansions `had`
 * the ones still on a building that stands and not shot off. */
export function baseLeft(w: World, o: Owner, had: readonly ModuleId[]): { yards: ('yard' | 'cyard')[]; mods: ModuleId[] } {
  const st = w.byId.get(w.players[o].station)
  const yards = w.units.filter((u) => !u.dead && u.owner === o && u.t.tier === 'yard' && !u.site)
  const on = (id: ModuleId) => (MODULE[id].on === 'station' ? [st] : yards.filter((u) => worksOf(u.t) === MODULE[id].on))
  return { yards: yards.map((u) => worksOf(u.t) as 'yard' | 'cyard'), mods: had.filter((id) => on(id).some((u) => expUp(u, id))) }
}

/** Ships a player owns, for selection helpers and the AI. */
export const fleet =(w: World, o: Owner) => w.units.filter((u) => !u.dead && u.owner === o && isShip(u.t))

const hashView = new DataView(new ArrayBuffer(8))
/**
 * A fingerprint of the battle: every ship's place, heading, speed, hull, shields and target, the
 * shots in flight, each player's credits, the clock and the random numbers. Multiplayer peers
 * compare these to find out whether their copies of the battle have drifted apart. Numbers go in
 * bit for bit, so the smallest difference shows.
 */
export function stateHash(w: World): number {
  let h = 0x811c9dc5
  const int = (v: number) => {
    h = Math.imul(h ^ (v | 0), 0x01000193)
  }
  const num = (v: number) => {
    hashView.setFloat64(0, v)
    int(hashView.getInt32(0))
    int(hashView.getInt32(4))
  }
  num(w.time)
  int(w.rs)
  int(w.nextId)
  int(w.winner)
  for (const u of w.units) {
    if (u.dead) continue
    int(u.id)
    num(u.x)
    num(u.y)
    num(u.a)
    num(u.v)
    num(u.hull)
    num(u.shield)
    int(u.target)
    if (u.t.tier === 'yard') {
      num(u.building)
      int(u.yq?.length ?? -1)
    }
    // A rush-launched ship still being finished, and a yard's rush cooldown.
    if (u.rush) {
      num(u.rush.left)
      num(u.rush.gap)
      int(u.rush.parts.length)
    }
    if (u.rushAt !== undefined) num(u.rushAt)
    // A new ship on its way out.
    if (u.launch) {
      num(u.launch.t)
      num(u.launch.wait)
    }
    // Expansions built and under way on a Command Station or a yard.
    if (u.xm || u.xq) {
      int(u.xm?.length ?? -1)
      int(u.t.hardpoints.length)
      for (const j of u.xq ?? []) num(j.left)
    }
  }
  int(w.ruins?.length ?? -1)
  int(w.shots.length)
  for (const s of w.shots) {
    num(s.x)
    num(s.y)
  }
  for (const p of w.players) {
    num(p.credits)
    int(p.queue.length)
    int(p.research.length)
    int(p.armour ? 1 : 0)
  }
  return h >>> 0
}
