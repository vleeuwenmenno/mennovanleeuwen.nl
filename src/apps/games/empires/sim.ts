import * as M from './detmath.ts'
import { sq } from './detmath.ts'
import { inside, mirrored, rng, type MapDef, type Pt } from './maps.ts'
import { clearLine, findPath, navGrid, type NavGrid } from './nav.ts'
import {
  ABILITIES, ARMOR_BONUS, BASE_POP, mineType, type SiteUpgradeId, BEACON_INCOME, SITE_UPGRADES, YIELD_PER_LEVEL, BEACON_POP, LEVEL_UP, MAX_CAPITALS, MAX_LEVEL, MAX_QUEUE, MAX_RESEARCH, MINE_INCOME, POP_PER_LEVEL, START_CREDITS, STATION_INCOME,
  SURVEY_RADIUS, SURVEY_TIME, TECH, UNIT, UPGRADES, accuracy, dims, effect, isShip, stationType, unitOf, type AbilityId, type FactionId, type TechEffect, type Tier, type UnitType, type Weapon,
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
/** How far Maneuver ships chase from where a fight started. */
export const LEASH = { fighter: 1100, ship: 800 }

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

/** Research multipliers for one ship, 1 meaning unchanged. */
export type Mods = { hull: number; shield: number; regen: number; damage: number; speed: number; cooldown: number; range: number }

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
  hps: { hp: number; max: number }[]
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
  /** Shield shimmer: time of the last shield hit and where it came from. */
  shieldHit: number
  /** When the shields last failed: they stay down for SHIELD_REBOOT seconds before recharging. */
  shieldOut: number
  hitAngle: number
  abilityCd: number
  abilityOn: number
  slow: number
  hangarT: number
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
  /** Strike craft on a strafing run: pulling away after a pass, until far enough out to turn. */
  breakOff: boolean
  /** Waypoints round the rocks to where the ship is going (x, y), found when it set off. */
  route: { x: number; y: number; pts: Pt[]; obs: { x: number; y: number; r: number }[] } | null
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
}

/** A ship being built. `reserve`: it goes to the fleet reserve when done instead of jumping in. */
export type QueueItem = { unit: string; left: number; total: number; reserve?: boolean }
/** A ship on its way in from hyperspace: it drops out at (x, y), facing `a`, once the clock
 * reaches `at`. `rally`: a new ship from the shipyard, sent on to the rally point. */
export type Arrival = { unit: string; owner: Owner; x: number; y: number; a: number; at: number; rally: boolean }
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
}
export type EarnSource = 'station' | 'mines' | 'beacons' | 'salvage' | 'refunds'
export type SpendKind = 'ships' | 'research' | 'structures' | 'repairs'
/** One line in the economy log: + for money in, - for money out. */
export type LedgerEntry = { t: number; amount: number; what: string; kind: SpendKind | 'salvage' | 'refund' | 'cancel' }
const LEDGER_SIZE = 40
export const HISTORY_STEP = 5
/** Seconds after a retreated ship jumps out before its refund arrives. */
export const REFUND_DELAY = 15

function note(w: World, p: Player, amount: number, kind: LedgerEntry['kind'], what: string) {
  p.ledger.push({ t: w.time, amount, kind, what })
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
/** Something teams take by parking ships at it. `owner` is the team holding it (-1 for nobody);
 * `claim` is the team the progress bar (0 to 1) belongs to. */
export type Claimable = { owner: number; claim: number; progress: number }
/** An ore asteroid. `site` is the structure on it (0 if none); `owner` is the team that surveyed it. */
export type OreNode = { id: number; x: number; y: number; r: number; rot: number; site: number } & Claimable
export type Beacon = { id: number; x: number; y: number } & Claimable
export type Rock = { x: number; y: number; r: number; rot: number; spin: number; kind: number }
/** A derelict hulk to strip for credits. `left` counts down as it's salvaged; battle wrecks also
 * drift off after `decay` seconds. `team` is who's salvaging it right now (-1 for nobody). */
export type Wreck = { id: number; x: number; y: number; value: number; left: number; sprite: string; size: number; rot: number; decay: number; team: number }
/** How close (from the hulk's centre) a ship must park to salvage, and credits a second per ship (up to three). */
export const SALVAGE_RANGE = 240
/** Seconds failed shields stay down before they start to recharge. */
export const SHIELD_REBOOT = 2
export const SALVAGE_RATE = 30
export type Shot = {
  x: number; y: number; vx: number; vy: number; left: number; kind: WeaponKind; owner: Owner; target: number; hp: number; dmg: number; hit: boolean; sx: number; sy: number; age: number; from: number
}

export type SimEvent =
  | { k: 'fire'; kind: WeaponKind; x: number; y: number; owner: Owner; light: boolean }
  | { k: 'hit'; kind: WeaponKind; x: number; y: number; shield: boolean; owner: Owner }
  | { k: 'boom'; x: number; y: number; tier: Tier; owner: Owner; size: number }
  | { k: 'hpdown'; x: number; y: number; owner: Owner; what: string }
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
}
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

function share(u: Unit, kind: string) {
  const all = u.t.hardpoints.map((h, i) => (h.kind === kind ? i : -1)).filter((i) => i >= 0)
  if (!all.length) return 1
  return all.filter((i) => alive(u, i)).length / all.length
}
/** Shields with every generator up. */
export const shieldFull = (u: Unit) => u.t.shield * u.mods.shield
export const shieldMax = (u: Unit) => shieldFull(u) * share(u, 'shield')
/** How far a unit sees: half as far while building or inside a nebula. */
export const sensorOf = (u: Unit) => u.t.sensor * (u.building > 0 ? 0.5 : 1) * (u.nebula ? NEBULA_SENSOR : 1)
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
function modsFor(p: Player, t: UnitType): Mods {
  const e = techBonus(p, t.id)
  return { hull: 1 + (e.hull ?? 0), shield: 1 + (e.shield ?? 0), regen: 1 + (e.regen ?? 0), damage: 1 + (e.damage ?? 0), speed: 1 + (e.speed ?? 0), cooldown: 1 + (e.cooldown ?? 0), range: 1 + (e.range ?? 0) }
}
const stationOf = (p: Player) => unitOf(p.faction, 'station').id
const hangarsUp = (u: Unit) => u.t.hardpoints.some((h, i) => h.kind === 'hangar' && alive(u, i))
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
    abilityCd: 0, abilityOn: 0, slow: 0, hangarT: 0, building: 0, node: -1, dead: false, born: w.time, kills: 0, xp: 0, rank: 0, stance: 'maneuver', gx: x, gy: y, hitBy: 0, nebula: false, route: null, queue: [], mending: [], breakOff: false, face: null, repair: 0, retreat: 0, focus: 0, upg: {}, upgrading: null,
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
  if (others.some((o) => d2(x, y, o.x, o.y) < sq(1400))) return 'Too close to another station'
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
      const ore = w.nodes.reduce((sum, n) => sum + M.exp(-M.hypot(n.x - p.x, n.y - p.y) / 1100), 0)
      const score = ore - (M.hypot(p.x - mid.x, p.y - mid.y) / diag) * 0.6
      if (score > bestScore) {
        bestScore = score
        best = p
      }
    }
  return best ?? mid
}

export function newWorld(map: MapDef, seats: Seat[], opts: { seed?: number; credits?: number; fleet?: boolean } = {}): World {
  const r = rng(opts.seed ?? map.seed)
  const W = map.w
  const H = map.h
  const c = { x: W / 2, y: H / 2 }
  const teams = Math.max(...seats.map((s) => s.team)) + 1
  const w: World = {
    w: W, h: H, time: 0, units: [], byId: new Map(), players: [], teams, map, nodes: [], beacons: [], rocks: [], wrecks: [], shots: [], events: [],
    nextId: 1, squadSeq: 1, wreckSeq: 1000, rs: ((opts.seed ?? map.seed) ^ 0x9e3779b9) >>> 0, winner: -1, grid: new Map(), seenT: 0, nav: new Map(), arrivals: [],
  }
  w.players = seats.map((s) => {
    const sp = s.at ?? map.spawns[s.spawn]
    const d = M.hypot(c.x - sp.x, c.y - sp.y) || 1
    return {
      faction: s.faction, team: s.team, spawn: s.spawn, start: { x: sp.x, y: sp.y }, alive: true, credits: opts.credits ?? START_CREDITS, income: 0, incomeMul: s.incomeMul ?? 1, level: 1, station: 0,
      queue: [], reserve: [], research: [], techs: [], rally: { x: sp.x + ((c.x - sp.x) / d) * 600, y: sp.y + ((c.y - sp.y) / d) * 600 }, pop: 0, popCap: BASE_POP, lastAlarm: -99,
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
  // better lanes. They keep clear of stations, ore, beacons, asteroid fields and the lanes into the
  // middle.
  // Map wrecks: the big hulks of earlier battles, Republic or droid as the seed falls.
  w.wrecks = map.wrecks.map((h, i) => {
    const big = h.value >= 900
    const side = r() < 0.5 ? 'republic' : 'droid'
    return { id: i + 1, x: h.x, y: h.y, value: h.value, left: h.value, sprite: `${side}-${big ? 'capital' : 'cruiser'}`, size: big ? 340 : 220, rot: r() * TAU, decay: Infinity, team: -1 }
  })
  const keepClear = [...w.wrecks.map((h) => [h.x, h.y, h.size * 0.6]), ...w.nodes.map((n) => [n.x, n.y, 260]), ...w.beacons.map((b) => [b.x, b.y, 330]), ...map.spawns.map((p) => [p.x, p.y, 700])]
  const inLane = (x: number, y: number, rad: number) =>
    map.spawns.some((p) => {
      // Distance from the point to the segment between this spawn and the centre.
      const vx = c.x - p.x
      const vy = c.y - p.y
      const t = clamp(((x - p.x) * vx + (y - p.y) * vy) / (vx * vx + vy * vy), 0, 1)
      return d2(x, y, p.x + vx * t, p.y + vy * t) < sq(240 + rad)
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

/** Spread a group's destinations around (x, y), keeping its shape (squeezed if it's spread out). */
/** A spot a ship can actually reach: moved out to the edge of any rock it falls inside. */
function offRocks(w: World, u: Unit, x: number, y: number): Pt {
  if (u.t.tier === 'fighter') return { x, y }
  const clear = radius(u.t) * 0.7 + 10
  for (const k of w.rocks) {
    const R = k.r + clear
    const dd = d2(x, y, k.x, k.y)
    if (dd >= R * R) continue
    const d = Math.sqrt(dd)
    // Dead centre: come out on the side the ship is coming from.
    const nx = d > 1 ? (x - k.x) / d : (u.x - k.x) / (M.hypot(u.x - k.x, u.y - k.y) || 1)
    const ny = d > 1 ? (y - k.y) / d : (u.y - k.y) / (M.hypot(u.x - k.x, u.y - k.y) || 1)
    x = k.x + nx * R
    y = k.y + ny * R
  }
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
  u.parent = 0
  u.face = null
}

/** Where a ship will be once its current and queued orders are done: where a queued patrol starts. */
export function lastStop(w: World, u: Unit): Pt {
  for (const o of [...u.queue].reverse().concat(u.order)) {
    if (o.k === 'move' || o.k === 'patrol' || o.k === 'area') return { x: o.x, y: o.y }
    if (o.k === 'guard') {
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
  const fit = Math.min(1, (90 + Math.sqrt(us.length) * 70) / spread)
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
  const fit = Math.min(1, (90 + Math.sqrt(all.length) * 70) / spread)
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
    for (const g of u.guns) {
      g.target = 0
      g.burst = 0
    }
  }
}

/** Which of a group's ships can fire their ability now. */
export function cmdAbility(w: World, owner: Owner, ids: number[]) {
  let used = 0
  for (const i of ids) {
    const u = w.byId.get(i)
    if (!u || u.dead || u.owner !== owner || !u.t.ability || u.abilityCd > 0) continue
    const ab = ABILITIES[u.t.ability]
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

export function cmdRally(w: World, owner: Owner, x: number, y: number) {
  w.players[owner].rally = { x: clamp(x, 40, w.w - 40), y: clamp(y, 40, w.h - 40) }
}

const queuedPop = (p: Player) => p.queue.reduce((s, q) => s + UNIT[q.unit].pop, 0)
const capitals = (w: World, o: Owner) =>
  w.units.filter((u) => !u.dead && u.owner === o && u.t.tier === 'capital').length +
  [...w.players[o].queue.map((q) => q.unit), ...w.players[o].reserve, ...w.arrivals.filter((a) => a.owner === o).map((a) => a.unit)].filter((id) => UNIT[id].tier === 'capital').length

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
  const up = SITE_UPGRADES.find((x) => x.id === id)!
  spend(w, w.players[owner], next.cost, 'structures', `${up.name}${up.levels > 1 ? ` ${next.level}` : ''}: ${u!.t.name}`)
  u!.upgrading = { id, left: next.time, total: next.time }
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

// --- Repairs ---------------------------------------------------------------------------------------

/** Seconds a repair crew takes to make a structure whole again. */
export const REPAIR_TIME = 20
const REPAIRABLE: Tier[] = ['station', 'mine', 'defense']
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
  if (w.fleet) p.escaped.push(u.t.id)
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

/** Why a ship can't be ordered right now, or null if it can. */
export function cantBuild(w: World, owner: Owner, id: string, reserve = false): string | null {
  const p = w.players[owner]
  const t = UNIT[id]
  if (w.fleet) return 'No shipyard work during a fleet battle'
  if (reserve && fromHangar(t)) return 'Strike craft launch from the hangar'
  if (!w.byId.get(p.station) || w.byId.get(p.station)!.dead) return 'No station'
  if (t.level > p.level) return `Needs station level ${t.level}`
  if (t.tier === 'capital' && capitals(w, owner) >= MAX_CAPITALS) return 'One flagship at a time'
  if (p.queue.length >= MAX_QUEUE) return 'Queue full'
  if (p.pop + queuedPop(p) + t.pop > p.popCap) return 'Fleet at its limit: capture beacons or upgrade the station'
  if (p.credits < t.cost) return 'Not enough credits'
  return null
}

/** Order a ship: it jumps in next to the station when done, or with `reserve` waits in the fleet
 * reserve until called in. */
export function cmdBuild(w: World, owner: Owner, id: string, reserve = false) {
  const why = cantBuild(w, owner, id, reserve)
  if (why) return why
  const p = w.players[owner]
  const t = UNIT[id]
  spend(w, p, t.cost, 'ships', t.name)
  const time = t.build * (1 + (techBonus(p, id).build ?? 0))
  p.queue.push({ unit: id, left: time, total: time, ...(reserve ? { reserve: true } : {}) })
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
  if (w.units.some((u) => !u.dead && u.t.tier !== 'fighter' && d2(x, y, u.x, u.y) < sq((radius(u.t) + r) * 0.85))) return 'Something is in the way'
  if (w.arrivals.some((a) => d2(x, y, a.x, a.y) < sq(radius(UNIT[a.unit]) + r))) return 'Another ship is jumping in there'
  return null
}

function warpIn(w: World, owner: Owner, unit: string, x: number, y: number, a: number, delay: number, rally: boolean) {
  w.arrivals.push({ unit, owner, x, y, a, at: w.time + delay, rally })
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
  warpIn(w, owner, id, x, y, a, WARP_RESERVE, false)
  return null
}

/** Where a new ship from the shipyard drops out: beside the station, towards the rally point, on
 * the first clear spot round it. */
function yardSpot(w: World, o: Owner, st: Unit, id: string) {
  const p = w.players[o]
  const t = UNIT[id]
  const toward = M.atan2(p.rally.y - st.y, p.rally.x - st.x)
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
      if (field) {
        u.hull = Math.max(1, u.hull - u.hullMax * FIELD_DAMAGE)
        u.shield = 0
        u.shieldOut = w.time
        u.lastHit = w.time
      }
    }
    if (a.rally) {
      cmdMove(w, a.owner, group.map((u) => u.id), p.rally.x, p.rally.y, true)
      w.events.push({ k: 'built', owner: a.owner, unit: a.unit, x: a.x, y: a.y })
    }
    w.events.push({ k: 'arrived', owner: a.owner, unit: a.unit, x: a.x, y: a.y, a: a.a, field })
  }
  w.arrivals = keep
}

export function cmdCancel(w: World, owner: Owner, index: number) {
  const p = w.players[owner]
  const q = p.queue[index]
  if (!q) return
  giveBack(w, p, UNIT[q.unit].cost, 'ships', `Cancelled: ${UNIT[q.unit].name}`)
  p.queue.splice(index, 1)
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

export function cmdCancelResearch(w: World, owner: Owner, index: number) {
  const p = w.players[owner]
  const r = p.research[index]
  if (!r) return
  giveBack(w, p, r.id === LEVEL_UP ? UPGRADES[p.level + 1]!.cost : TECH[r.id].cost, 'research', `Cancelled: ${r.id === LEVEL_UP ? `Station level ${p.level + 1}` : TECH[r.id].name}`)
  p.research.splice(index, 1)
  // Whatever was queued on the strength of it can never start now: cancel and refund that too.
  // Back to front, so a cascade only ever removes entries we've already looked at.
  for (let i = p.research.length - 1; i >= index; i--) {
    const q = p.research[i]
    if (q && q.id !== LEVEL_UP && TECH[q.id].requires?.includes(r.id)) cmdCancelResearch(w, owner, i)
  }
}

/** Research is done: apply it to every ship of that type already flying. */
/**
 * Rebuilds a station for its owner's level and research: the stage it has reached and the modules
 * built so far. Modules it already had keep their damage and reload; new ones arrive whole, and so
 * does the extra hull.
 */
function restation(w: World, u: Unit) {
  const p = w.players[u.owner]
  const t = stationType(p.faction, p.level, p.techs)
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
export const moduleUp = (u: Unit | undefined, kind: string) => !!u && !u.dead && u.t.hardpoints.some((h, i) => h.kind === kind && u.hps[i].hp > 0)

function finishResearch(w: World, o: Owner, id: string) {
  const p = w.players[o]
  p.techs.push(id)
  const forId = TECH[id].for
  for (const u of w.units) {
    if (u.dead || u.owner !== o || u.t.id !== forId) continue
    const next = modsFor(p, u.t)
    const grow = next.hull / u.mods.hull
    const shields = next.shield / u.mods.shield
    u.hullMax *= grow
    u.hull *= grow
    u.mods = next
    u.shield = Math.min(shieldMax(u), u.shield * shields)
    if (u.t.tier === 'station') restation(w, u)
  }
  w.events.push({ k: 'tech', owner: o, id })
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
    const out = new Set(w.units.filter((u) => !u.dead && u.parent === carrier.id).map((u) => u.squad))
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
  if (!isShip(u.t)) return
  u.xp += amount
  const own = u.t.cost / u.t.squad
  while (u.rank < 3 && u.xp >= own * RANK_AT[u.rank + 1]) {
    u.rank++
    const grow = (1 + RANK_BONUS * u.rank) / (1 + RANK_BONUS * (u.rank - 1))
    u.hullMax *= grow
    u.hull = Math.min(u.hullMax, u.hull * grow + u.hullMax * 0.1)
    w.events.push({ k: 'rankUp', owner: u.owner, unit: u.id, rank: u.rank, x: u.x, y: u.y })
  }
}

function alarm(w: World, u: Unit) {
  const p = w.players[u.owner]
  if (w.time - p.lastAlarm < 20) return
  if (u.t.tier !== 'station' && u.t.tier !== 'mine' && u.t.tier !== 'defense' && u.t.tier !== 'capital') return
  p.lastAlarm = w.time
  w.events.push({ k: 'alarm', owner: u.owner, x: u.x, y: u.y, what: u.t.name })
}

/** One bolt landing. Shields soak it first (missiles slip most of it past), then the hardpoint it
 * was aimed at takes it, with half spilling into the hull; or the hull takes it all. */
export function damage(w: World, u: Unit, dmg: number, kind: WeaponKind, hp: number, fromX: number, fromY: number, by: Owner, shooter = 0) {
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
    const onShield = kind === 'missile' ? dmg * 0.35 : kind === 'ion' ? dmg * 2 : dmg
    const soaked = Math.min(u.shield, onShield)
    u.shield -= soaked
    if (u.shield <= 0) {
      u.shieldOut = w.time
      // Shields of a warship giving out are worth hearing.
      if (u.t.tier === 'frigate' || u.t.tier === 'cruiser' || u.t.tier === 'capital' || u.t.tier === 'station' || u.t.tier === 'defense')
        w.events.push({ k: 'shieldsDown', owner: u.owner, x: u.x, y: u.y })
    }
    rest -= kind === 'ion' ? soaked / 2 : soaked
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
      w.events.push({ k: 'hpdown', x: p.x, y: p.y, owner: u.owner, what: kindName })
      if (kindName === 'shield') u.shield = Math.min(u.shield, shieldMax(u))
    }
  } else u.hull -= rest
  if (u.hull <= 0) {
    u.hull = 0
    // Our own side's kills don't count, and earn no experience.
    kill(w, u, own ? -1 : by)
    const killer = own ? undefined : w.byId.get(shooter)
    if (killer && !killer.dead) {
      killer.kills++
      gainXp(w, killer, u.t.cost / u.t.squad)
    }
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
  const acc = u.t.speed * (fighter ? 1.6 : 0.6)
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

/**
 * Where to head for next on the way to (tx, ty): the next waypoint round the rocks, found once per
 * destination and dropped as each one comes into view. Asteroid fields and nebulas are steered
 * round too, as if they were rocks, except one the ship was sent into (its destination is inside)
 * or is in already: going through one has to be asked for.
 */
function waypoint(w: World, u: Unit, tx: number, ty: number): Pt {
  const patches = [...w.map.fields, ...w.map.nebulas]
  if ((!w.rocks.length && !patches.length) || u.t.tier === 'fighter') return { x: tx, y: ty }
  // Sized to 20-unit steps so similar ships share a grid.
  const clear = Math.ceil((radius(u.t) * 0.7 + 20) / 20) * 20
  if (!u.route || u.route.x !== tx || u.route.y !== ty) {
    const within = (p: { x: number; y: number; r: number }, x: number, y: number) => sq(x - p.x) + sq(y - p.y) < sq(p.r)
    const keepOut = patches.map((p, i) => (within(p, tx, ty) || within(p, u.x, u.y) ? -1 : i)).filter((i) => i >= 0)
    const obs = [...w.rocks, ...keepOut.map((i) => patches[i])]
    const key = `${clear}:${keepOut.join(',')}`
    let g = w.nav.get(key)
    if (!g) w.nav.set(key, (g = navGrid(obs, w.w, w.h, clear)))
    u.route = { x: tx, y: ty, pts: findPath(g, obs, clear, u.x, u.y, tx, ty), obs }
  }
  const { pts, obs } = u.route
  while (pts.length > 1 && (d2(u.x, u.y, pts[0].x, pts[0].y) < sq(60) || clearLine(obs, u.x, u.y, pts[1].x, pts[1].y, clear))) pts.shift()
  return pts.length ? pts[0] : { x: tx, y: ty }
}

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
  if (u.order.k === 'guard') {
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
  } else if (u.retarget <= 0) {
    u.retarget = 0.4 + rand(w) * 0.3
    const guarding = u.order.k === 'guard'
    const engage = u.order.k === 'idle' || guarding || u.order.k === 'patrol' || (u.order.k === 'move' && u.order.attack)
    const cur = valid(w, u.target, u.owner)
    const hold = u.stance === 'hold'
    const roam = u.stance === 'roam'
    // Holding ships only look as far as their guns reach (fighters a little further); roamers as
    // far as they can see.
    const look = hold ? (fighter ? 450 : fightRange(t) * u.mods.range + 100) : roam ? sensorOf(u) : Math.min(sensorOf(u), fighter ? 900 : 800)
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
  const tgt = u.target ? w.byId.get(u.target) : undefined

  // Holding ships on the move keep going, guns firing at whatever they pass.
  const fighting = !!tgt && !tgt.dead && (u.order.k !== 'move' || (u.order.attack && u.stance !== 'hold'))
  if (fighting) {
    const e = tgt!
    if (fighter && e.t.tier !== 'fighter') {
      // Strafing runs on anything bigger: dive in guns-first, pull away past the hull, and fly out
      // far enough to turn round and line up again before coming back into range.
      const dist = M.hypot(e.x - u.x, e.y - u.y)
      const r = radius(e.t)
      if (dist < r + 50) u.breakOff = true
      else if (dist > r + 320) u.breakOff = false
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
      // An area attack was an order to go in: holding ships only hold otherwise.
      steer(u, e.x, e.y, 0, dt, true)
    } else {
      // Close to fighting range, then hold there and swing round to face the enemy.
      // Brake in time to stop at range rather than ramming them.
      const want = fightRange(t) * u.mods.range * 0.8 + radius(e.t) * 0.5
      const dist = M.hypot(e.x - u.x, e.y - u.y)
      const brake = Math.sqrt(2 * t.speed * 0.9 * Math.max(0, dist - want))
      const p = dist > want ? detour(w, u, e.x, e.y) : e
      steer(u, p.x, p.y, dist > want ? Math.min(max, brake) : 0, dt, dist <= want)
    }
  } else if (u.order.k === 'area') {
    // Nothing to shoot: done once the circle is in sight (or reached) and empty; until then, close in.
    const o = u.order
    const dist = M.hypot(o.x - u.x, o.y - u.y)
    const clear = !w.units.some((e) => !e.dead && foes(w, e.owner, u.owner) && sees(w, u.owner, e) && inArea(o, e))
    if (clear && (dist < o.r * 0.8 || canSee(w, w.players[u.owner].team, o.x, o.y))) nextOrder(u, u.x, u.y)
    else if (dist > o.r * 0.5) {
      const wp = waypoint(w, u, o.x, o.y)
      const p = detour(w, u, wp.x, wp.y)
      steer(u, p.x, p.y, fighter ? max : Math.min(max, dist * 0.9 + 12), dt)
    } else u.v = Math.max(0, u.v - t.speed * dt)
  } else if (u.order.k === 'move' || u.order.k === 'patrol') {
    const o = u.order
    const dist = M.hypot(o.x - u.x, o.y - u.y)
    const pace = Math.min(max, o.speed)
    if (dist < (fighter ? 60 : 24 + radius(t) * 0.2)) {
      if (o.k === 'patrol') u.order = { ...o, x: o.bx, y: o.by, bx: o.x, by: o.y }
      else nextOrder(u, o.x, o.y, o.face ?? null)
    } else {
      const wp = waypoint(w, u, o.x, o.y)
      const p = detour(w, u, wp.x, wp.y)
      steer(u, p.x, p.y, fighter ? pace : Math.min(pace, dist * 0.9 + 12), dt)
    }
  } else {
    // Idle: fighters circle their spot, everything else drifts back to it and waits.
    const dist = M.hypot(u.ax - u.x, u.ay - u.y)
    if (fighter) {
      const ang = w.time * 0.9 + u.id
      const r = 70 + (u.id % 4) * 18
      steer(u, u.ax + M.cos(ang) * r, u.ay + M.sin(ang) * r, max * 0.65, dt)
    } else if (dist > 30 + radius(t) * 0.3) {
      const wp = waypoint(w, u, u.ax, u.ay)
      const p = detour(w, u, wp.x, wp.y)
      steer(u, p.x, p.y, Math.min(max, dist * 0.8 + 10), dt)
    } else if (u.face !== null && Math.abs(wrap(u.face - u.a)) > 0.01) {
      // Swing round in place to the heading it was told to arrive with.
      steer(u, u.x + M.cos(u.face) * 100, u.y + M.sin(u.face) * 100, 0, dt, true)
    } else u.v = Math.max(0, u.v - t.speed * dt)
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
  if (!fighter)
    near(w, u.x, u.y, r0 + 240, (o, dd) => {
      if (o === u || o.t.tier === 'fighter') return
      const min = (r0 + radius(o.t)) * 0.75
      if (dd >= min * min) return
      // Each of the pair moves part of the overlap away per tick; a structure doesn't budge, so the ship takes all of it.
      const d = Math.sqrt(dd) || 1
      const push = (min - d) * Math.min(1, 4 * dt) * (isShip(o.t) ? 1 : 2.5)
      const nx = d > 1 ? (u.x - o.x) / d : M.cos(u.id)
      const ny = d > 1 ? (u.y - o.y) / d : M.sin(u.id)
      u.x += nx * push
      u.y += ny * push
    })
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
  w.shots.push({
    x: from.x, y: from.y, vx: (ax - from.x) / Math.max(t, 0.001), vy: (ay - from.y) / Math.max(t, 0.001), left: hit ? t : t * 1.6,
    kind: g.w.kind, owner: u.owner, target: e.id, hp, dmg, hit, sx: from.x, sy: from.y, age: 0, from: u.id,
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
    damage(w, e, s.dmg, s.kind, s.hp, s.sx, s.sy, s.owner, s.from)
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
    // Repair docks mend our ships parked near the station.
    const repair = moduleUp(st, 'dock') ? techBonus(p, st.t.id).repair : 0
    if (repair)
      near(w, st.x, st.y, 900, (u) => {
        if (u.owner === o && isShip(u.t) && u.hull < u.hullMax) u.hull = Math.min(u.hullMax, u.hull + u.hullMax * repair * dt)
      })
    const q = p.queue[0]
    if (q) {
      q.left -= dt * (hangarsUp(st) ? 1 : 0.5)
      if (q.left <= 0) {
        p.queue.shift()
        p.stats.built++
        if (fromHangar(UNIT[q.unit])) {
          const bay = st.t.hardpoints.findIndex((h) => h.kind === 'hangar')
          const from = bay >= 0 ? hpPos(st, bay) : st
          const a = M.atan2(p.rally.y - from.y, p.rally.x - from.x)
          const group = spawnGroup(w, q.unit, o, from.x, from.y, a)
          for (const u of group) u.v = u.t.speed * 0.5
          cmdMove(w, o, group.map((u) => u.id), p.rally.x, p.rally.y, true)
          w.events.push({ k: 'built', owner: o, unit: q.unit, x: from.x, y: from.y })
        } else if (q.reserve) {
          p.reserve.push(q.unit)
          w.events.push({ k: 'reserved', owner: o, unit: q.unit })
        } else {
          const at = yardSpot(w, o, st, q.unit)
          warpIn(w, o, q.unit, at.x, at.y, at.a, WARP_YARD, true)
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
/** Share of a ship's full shields that rocks knock off per 1000 units flown through a field. A
 * capital crossing a typical field (about 800 units) loses around an eighth of its shields. */
const FIELD_WEAR = 0.15
/** Rocks scrape hulls but never finish a ship off: they stop at this share of the hull. */
const FIELD_HULL_FLOOR = 0.15
/** Only big ships are too clumsy to dodge the rocks; fighters and gunships weave through. */
const CLUMSY: Partial<Record<Tier, true>> = { frigate: true, cruiser: true, capital: true }

/**
 * Nebulas and asteroid fields acting on one unit this tick. A nebula drains the shields and keeps
 * them down (and `sensorOf` halves the sensors while `nebula` is set). A big ship moving through
 * an asteroid field takes a steady patter of hits, more the faster it goes: shields first, then
 * hull. Neither counts as being attacked, so no alarms and no kill credit. Returns true while the
 * terrain keeps the shields from recharging.
 */
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
      if (o !== u && !o.dead && isShip(o.t) && w.players[o.owner].team === team && o.hull < o.hullMax) hurt.push(o)
    })
    hurt.sort((a, b) => a.hull / a.hullMax - b.hull / b.hullMax)
    const rate = sp.repair * (1 + (techBonus(w.players[u.owner], u.t.id).repair ?? 0)) * dt
    for (const o of hurt.slice(0, sp.max)) {
      o.hull = Math.min(o.hullMax, o.hull + rate)
      u.mending.push(o.id)
    }
  }
}

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
  return true
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
  for (const u of w.units) {
    if (u.dead) continue
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
      if (u.t.ability === 'repairSwarm') u.hull = Math.min(u.hullMax, u.hull + u.hullMax * 0.03 * dt)
    }
    if (u.slow > 0) u.slow -= dt
    // Shields recharge, faster once out of the fight for a few seconds; terrain can stop that, and
    // failed shields take a few seconds to come back at all, rather than flickering on and off.
    if (!terrain(w, u, dt) && w.time - u.shieldOut >= SHIELD_REBOOT) {
      const smax = shieldMax(u)
      if (u.shield < smax) u.shield = Math.min(smax, u.shield + u.t.regen * u.mods.regen * (1 + RANK_BONUS * u.rank) * dt * (w.time - u.lastHit > 6 ? 2 : 1))
    }
    if (u.t.carrier) {
      u.hangarT += dt
      if (u.hangarT >= u.t.carrier.every * (techBonus(w.players[u.owner], u.t.id).hangar ? 0.7 : 1)) {
        u.hangarT = 0
        launch(w, u)
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
 * fleet's orders: they start in the reserve, to be called in during the battle. */
export type FleetSide = { faction: FactionId; team: number; ships: string[]; reserve?: string[]; station?: number; techs?: string[] }

/**
 * A galactic conquest battle over a planet. The first side holds it: its station (if any) sits at
 * the first spawn with its fleet in front; the other fleets drop out of hyperspace at the other
 * spawns. Each side starts with up to `cap` fleet size on the field, biggest ships first, and the
 * rest waits in orbit to be called in from the reserve, with any ships its fleets held back.
 */
export function newFleetBattle(map: MapDef, sides: FleetSide[], opts: { seed?: number; cap?: number } = {}): World {
  const w = newWorld(map, sides.map((s, i) => ({ faction: s.faction, team: s.team, spawn: i, incomeMul: 0 })), { seed: opts.seed, credits: 0, fleet: true })
  const cap = opts.cap ?? FLEET_CAP
  const c = { x: w.w / 2, y: w.h / 2 }
  w.fleet = { entry: sides.map((_, i) => ({ x: map.spawns[i].x, y: map.spawns[i].y, r: 1300 })), cap, holder: sides[0].team, endT: 3 }
  sides.forEach((s, o) => {
    const p = w.players[o]
    p.techs = [...(s.techs ?? [])]
    const sp = map.spawns[o]
    const face = M.atan2(c.y - sp.y, c.x - sp.x)
    if (o === 0 && s.station) {
      p.level = s.station
      const st = spawn(w, unitOf(p.faction, 'station').id, o, sp.x, sp.y, face - Math.PI / 2)
      p.station = st.id
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
    // A loose block facing the middle: rows across, big ships in the middle rows.
    const fx = M.cos(face)
    const fy = M.sin(face)
    const ahead = o === 0 && s.station ? 650 : 0
    const perRow = 5
    field.forEach((id, i) => {
      const row = Math.floor(i / perRow)
      const col = (i % perRow) - (Math.min(perRow, field.length - row * perRow) - 1) / 2
      const gap = Math.max(170, radius(UNIT[id]) * 2.4)
      const x = sp.x + fx * (ahead - row * 260) - fy * col * gap
      const y = sp.y + fy * (ahead - row * 260) + fx * col * gap
      // The holder is already there; the others arrive from hyperspace, a few at a time.
      if (o === 0) {
        const g = spawnGroup(w, id, o, x, y, face)
        for (const u of g) u.stance = 'maneuver'
      } else warpIn(w, o, id, x, y, face, 1 + i * 0.25, false)
    })
  })
  refreshPlayers(w)
  return w
}

/** Ships a player owns, for selection helpers and the AI. */
export const fleet = (w: World, o: Owner) => w.units.filter((u) => !u.dead && u.owner === o && isShip(u.t))

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
  }
  int(w.shots.length)
  for (const s of w.shots) {
    num(s.x)
    num(s.y)
  }
  for (const p of w.players) {
    num(p.credits)
    int(p.queue.length)
    int(p.research.length)
  }
  return h >>> 0
}
