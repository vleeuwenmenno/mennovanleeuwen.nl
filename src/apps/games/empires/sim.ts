import { inside, mirrored, rng, type MapDef } from './maps'
import {
  ABILITIES, BASE_POP, BEACON_INCOME, BEACON_POP, LEVEL_UP, MAX_CAPITALS, MAX_LEVEL, MAX_QUEUE, MAX_RESEARCH, MINE_INCOME, POP_PER_LEVEL, START_CREDITS, STATION_INCOME,
  STATION_LEVEL_BONUS, SURVEY_RADIUS, SURVEY_TIME, TECH, UNIT, UPGRADES, accuracy, dims, effect, isShip, unitOf, type AbilityId, type FactionId, type TechEffect, type Tier, type UnitType, type Weapon,
  type WeaponKind,
} from './data'

// The battle itself, with no DOM: ships, orders, steering, guns, shields and hardpoints, the
// economy and capture beacons. The game screen and the headless balance sims both drive it by
// calling `tick` at a fixed step and reading `events` for sound and effects.

export const STEP = 1 / 30
/** A player's index in `world.players`. Players on the same team share vision and win together. */
export type Owner = number
/** Whether two players are on opposite sides. */
export const foes = (w: World, a: Owner, b: Owner) => w.players[a].team !== w.players[b].team
export const teamOf = (w: World, o: Owner) => w.players[o].team
/** Whether player `o`'s team can see unit `u`. */
export const sees = (w: World, o: Owner, u: Unit) => u.seen[w.players[o].team]

export type Order =
  | { k: 'idle' }
  /** `attack`: attack-move, engaging whatever turns up on the way. `speed` keeps a group together. */
  | { k: 'move'; x: number; y: number; attack: boolean; speed: number }
  /** Back and forth between (x, y), where it is heading, and (bx, by), fighting what it meets. */
  | { k: 'patrol'; x: number; y: number; bx: number; by: number; speed: number }
  /** `hp`: the hardpoint to aim at, or -1 for the ship as a whole. */
  | { k: 'attack'; id: number; hp: number }

/** Research multipliers for one ship, 1 meaning unchanged. */
export type Mods = { hull: number; shield: number; regen: number; damage: number; speed: number; cooldown: number; range: number }

export type Gun = { w: Weapon; hp: number; cd: number; burst: number; burstT: number; target: number; aim: number }

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
  mods: Mods
  /** Hold position: fight from where it stands, never chase. */
  hold: boolean
  /** Inside a nebula: no shields, short sensors. Refreshed every tick. */
  nebula: boolean
}

export type QueueItem = { unit: string; left: number; total: number }
/** Research in progress: a tech id, or LEVEL_UP for the next station level. */
export type ResearchItem = { id: string; left: number; total: number }
export type Player = {
  faction: FactionId
  team: number
  /** Which of the map's spawn points this player started at. */
  spawn: number
  /** Still has a station. */
  alive: boolean
  credits: number
  income: number
  incomeMul: number
  level: number
  station: number
  queue: QueueItem[]
  research: ResearchItem[]
  techs: string[]
  rally: { x: number; y: number }
  pop: number
  popCap: number
  lastAlarm: number
  stats: { built: number; lost: number; killed: number; earned: number }
}
/** Something teams take by parking ships at it. `owner` is the team holding it (-1 for nobody);
 * `claim` is the team the progress bar (0 to 1) belongs to. */
export type Claimable = { owner: number; claim: number; progress: number }
/** An ore asteroid. `site` is the structure on it (0 if none); `owner` is the team that surveyed it. */
export type OreNode = { id: number; x: number; y: number; r: number; rot: number; site: number } & Claimable
export type Beacon = { id: number; x: number; y: number } & Claimable
export type Rock = { x: number; y: number; r: number; rot: number; spin: number; kind: number }
export type Shot = {
  x: number; y: number; vx: number; vy: number; left: number; kind: WeaponKind; owner: Owner; target: number; hp: number; dmg: number; hit: boolean; sx: number; sy: number; age: number; from: number
}

export type SimEvent =
  | { k: 'fire'; kind: WeaponKind; x: number; y: number; owner: Owner }
  | { k: 'hit'; kind: WeaponKind; x: number; y: number; shield: boolean; owner: Owner }
  | { k: 'boom'; x: number; y: number; tier: Tier; owner: Owner; size: number }
  | { k: 'hpdown'; x: number; y: number; owner: Owner; what: string }
  | { k: 'built'; owner: Owner; unit: string; x: number; y: number }
  /** `owner` and `prev` are teams here. */
  | { k: 'beacon'; owner: number; prev: number; x: number; y: number }
  | { k: 'survey'; owner: number; prev: number; node: number; x: number; y: number }
  | { k: 'out'; owner: Owner }
  | { k: 'alarm'; owner: Owner; x: number; y: number; what: string }
  | { k: 'level'; owner: Owner; level: number }
  | { k: 'tech'; owner: Owner; id: string }
  | { k: 'ability'; owner: Owner; id: AbilityId; x: number; y: number }
  | { k: 'launch'; owner: Owner; x: number; y: number }

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
  shots: Shot[]
  events: SimEvent[]
  nextId: number
  /** The winning team, or -1 while the battle goes on. */
  winner: number
  grid: Map<number, Unit[]>
  seenT: number
}

// --- Helpers ----------------------------------------------------------------------------------------

const TAU = Math.PI * 2
const wrap = (a: number) => ((a + Math.PI) % TAU + TAU) % TAU - Math.PI
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
const d2 = (ax: number, ay: number, bx: number, by: number) => (ax - bx) ** 2 + (ay - by) ** 2

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
  const c = Math.cos(u.a)
  const s = Math.sin(u.a)
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
const DPS = new Map<string, Record<string, number>>()
function dpsVs(t: UnitType, tier: Tier) {
  let row = DPS.get(t.id)
  if (!row) {
    row = {}
    const ws = [...t.weapons, ...t.hardpoints.flatMap((h) => (h.weapon ? [h.weapon] : []))]
    for (const tr of ['fighter', 'gunship', 'frigate', 'cruiser', 'capital', 'station', 'mine', 'defense'] as Tier[])
      row[tr] = ws.reduce((s, w) => s + (w.damage * (w.burst ?? 1) * effect(w.kind, tr) * accuracy(w.kind, tr)) / w.cooldown, 0)
    DPS.set(t.id, row)
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

export function spawn(w: World, id: string, owner: Owner, x: number, y: number, a: number, squad = 0): Unit {
  const t = UNIT[id]
  const lvl = t.tier === 'station' ? w.players[owner].level : 1
  const mods = modsFor(w.players[owner], t)
  const hullMax = t.hull * (1 + STATION_LEVEL_BONUS * (lvl - 1)) * mods.hull
  const u: Unit = {
    id: w.nextId++, t, owner, x, y, a, v: 0, hull: hullMax, hullMax, shield: t.shield * mods.shield, mods,
    hps: t.hardpoints.map((h) => ({ hp: h.hp, max: h.hp })),
    guns: [...t.weapons.map((wp) => ({ w: wp, hp: -1 })), ...t.hardpoints.flatMap((h, i) => (h.weapon ? [{ w: h.weapon, hp: i }] : []))].map((g) => ({
      ...g, cd: Math.random() * g.w.cooldown, burst: 0, burstT: 0, target: 0, aim: 0,
    })),
    order: { k: 'idle' }, ax: x, ay: y, squad, parent: 0, target: 0, retarget: Math.random() * 0.5, lastHit: -99, shieldHit: -99, hitAngle: 0,
    abilityCd: 0, abilityOn: 0, slow: 0, hangarT: 0, building: 0, node: -1, dead: false, born: w.time, kills: 0, hold: false, nebula: false,
    seen: Array.from({ length: w.teams }, (_, t) => t === w.players[owner].team),
  }
  w.units.push(u)
  w.byId.set(u.id, u)
  return u
}

let squadSeq = 1
/** A whole order's worth: one ship, or a squadron of fighters in a loose vee. */
export function spawnGroup(w: World, id: string, owner: Owner, x: number, y: number, a: number) {
  const t = UNIT[id]
  const squad = t.squad > 1 ? squadSeq++ : 0
  const out: Unit[] = []
  for (let i = 0; i < t.squad; i++) {
    const row = Math.ceil(i / 2)
    const side = i === 0 ? 0 : i % 2 ? -1 : 1
    const back = row * 26
    const off = side * row * 24
    out.push(spawn(w, id, owner, x - Math.cos(a) * back - Math.sin(a) * off, y - Math.sin(a) * back + Math.cos(a) * off, a, squad))
  }
  return out
}

/** One player at the start of a battle. */
export type Seat = { faction: FactionId; team: number; spawn: number; incomeMul?: number }

export function newWorld(map: MapDef, seats: Seat[], opts: { seed?: number; credits?: number } = {}): World {
  const r = rng(opts.seed ?? map.seed)
  const W = map.w
  const H = map.h
  const c = { x: W / 2, y: H / 2 }
  const teams = Math.max(...seats.map((s) => s.team)) + 1
  const w: World = {
    w: W, h: H, time: 0, units: [], byId: new Map(), players: [], teams, map, nodes: [], beacons: [], rocks: [], shots: [], events: [],
    nextId: 1, winner: -1, grid: new Map(), seenT: 0,
  }
  w.players = seats.map((s) => {
    const sp = map.spawns[s.spawn]
    const d = Math.hypot(c.x - sp.x, c.y - sp.y) || 1
    return {
      faction: s.faction, team: s.team, spawn: s.spawn, alive: true, credits: opts.credits ?? START_CREDITS, income: 0, incomeMul: s.incomeMul ?? 1, level: 1, station: 0,
      queue: [], research: [], techs: [], rally: { x: sp.x + ((c.x - sp.x) / d) * 600, y: sp.y + ((c.y - sp.y) / d) * 600 }, pop: 0, popCap: BASE_POP, lastAlarm: -99,
      stats: { built: 0, lost: 0, killed: 0, earned: 0 },
    }
  })
  const claim = { owner: -1, claim: -1, progress: 0 }
  w.nodes = map.ore.map((p, id) => ({ id, x: p.x, y: p.y, r: 75, rot: r() * TAU, site: 0, ...claim }))
  w.beacons = map.beacons.map((p, id) => ({ id, x: p.x, y: p.y, ...claim }))
  // Scattered rocks: each one is copied to every side by the map's symmetry, so nobody gets the
  // better lanes. They keep clear of stations, ore, beacons, asteroid fields and the lanes into the
  // middle.
  const keepClear = [...w.nodes.map((n) => [n.x, n.y, 260]), ...w.beacons.map((b) => [b.x, b.y, 330]), ...map.spawns.map((p) => [p.x, p.y, 700])]
  const inLane = (x: number, y: number, rad: number) =>
    map.spawns.some((p) => {
      // Distance from the point to the segment between this spawn and the centre.
      const vx = c.x - p.x
      const vy = c.y - p.y
      const t = clamp(((x - p.x) * vx + (y - p.y) * vy) / (vx * vx + vy * vy), 0, 1)
      return d2(x, y, p.x + vx * t, p.y + vy * t) < (240 + rad) ** 2
    })
  let tries = 0
  while (w.rocks.length < map.rocks && tries++ < 4000) {
    const cx = 250 + r() * (W - 500)
    const cy = 200 + r() * (H - 400)
    const rad = 30 + r() ** 2 * 110
    const copies = mirrored(map, { x: cx, y: cy })
    const ok = copies.every(
      (p) =>
        p.x > 150 && p.y > 150 && p.x < W - 150 && p.y < H - 150 &&
        !keepClear.some(([x, y, cc]) => d2(p.x, p.y, x, y) < (cc + rad) ** 2) &&
        !inLane(p.x, p.y, rad) &&
        !inside(map.fields, p.x, p.y, rad + 60) &&
        !w.rocks.some((k) => d2(p.x, p.y, k.x, k.y) < (k.r + rad + 40) ** 2),
    )
    if (!ok) continue
    const kind = r() < 0.5 ? 0 : 1
    const rot = r() * TAU
    const spin = (r() - 0.5) * 0.1
    copies.forEach((p, i) => w.rocks.push({ x: p.x, y: p.y, r: rad, rot: rot + i * 2.1, spin, kind }))
  }
  // Stations, facing the middle, and a starting patrol in front of each. Ore has to be surveyed
  // before anything is built on it.
  w.players.forEach((p, o) => {
    const sp = map.spawns[p.spawn]
    const face = Math.atan2(c.y - sp.y, c.x - sp.x)
    const fx = Math.cos(face)
    const fy = Math.sin(face)
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

const commandable = (u: Unit | undefined, owner: Owner): u is Unit => !!u && !u.dead && u.owner === owner && isShip(u.t)

/** Spread a group's destinations around (x, y), keeping its shape (squeezed if it's spread out). */
function formation(w: World, owner: Owner, ids: number[], x: number, y: number, give: (u: Unit, tx: number, ty: number, pace: number) => void) {
  const us = ids.map((i) => w.byId.get(i)).filter((u) => commandable(u, owner))
  if (!us.length) return
  const cx = us.reduce((s, u) => s + u.x, 0) / us.length
  const cy = us.reduce((s, u) => s + u.y, 0) / us.length
  const spread = Math.max(1, ...us.map((u) => Math.hypot(u.x - cx, u.y - cy)))
  const fit = Math.min(1, (90 + Math.sqrt(us.length) * 70) / spread)
  // A group keeps the pace of its slowest ship.
  const pace = us.length > 1 ? Math.min(...us.map((u) => speedOf(u))) : Infinity
  for (const u of us) {
    give(u, clamp(x + (u.x - cx) * fit, 40, w.w - 40), clamp(y + (u.y - cy) * fit, 40, w.h - 40), pace)
    u.target = 0
    u.parent = 0
    u.hold = false
  }
}

export function cmdMove(w: World, owner: Owner, ids: number[], x: number, y: number, attack = false) {
  formation(w, owner, ids, x, y, (u, tx, ty, speed) => (u.order = { k: 'move', x: tx, y: ty, attack, speed }))
}

export function cmdPatrol(w: World, owner: Owner, ids: number[], x: number, y: number) {
  formation(w, owner, ids, x, y, (u, tx, ty, speed) => (u.order = { k: 'patrol', x: tx, y: ty, bx: u.x, by: u.y, speed }))
}

/** Stop where they are and stay there, shooting whatever comes into range. */
export function cmdHold(w: World, owner: Owner, ids: number[]) {
  for (const i of ids) {
    const u = w.byId.get(i)
    if (!commandable(u, owner)) continue
    u.order = { k: 'idle' }
    u.ax = u.x
    u.ay = u.y
    u.target = 0
    u.hold = true
  }
}

export function cmdAttack(w: World, owner: Owner, ids: number[], target: number, hp = -1) {
  const t = w.byId.get(target)
  if (!t || t.dead || !foes(w, t.owner, owner)) return
  for (const i of ids) {
    const u = w.byId.get(i)
    if (!commandable(u, owner)) continue
    u.order = { k: 'attack', id: target, hp: hp >= 0 && hp < t.hps.length ? hp : -1 }
    u.target = target
    u.parent = 0
    u.hold = false
  }
}

export function cmdStop(w: World, owner: Owner, ids: number[]) {
  for (const i of ids) {
    const u = w.byId.get(i)
    if (!commandable(u, owner)) continue
    u.order = { k: 'idle' }
    u.ax = u.x
    u.ay = u.y
    u.target = 0
    u.hold = false
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
      for (const e of w.units) if (!e.dead && foes(w, e.owner, owner) && isShip(e.t) && d2(e.x, e.y, u.x, u.y) < ab.range! ** 2) e.slow = ab.duration
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
  w.units.filter((u) => !u.dead && u.owner === o && u.t.tier === 'capital').length + w.players[o].queue.filter((q) => UNIT[q.unit].tier === 'capital').length

/** Why a ship can't be ordered right now, or null if it can. */
export function cantBuild(w: World, owner: Owner, id: string): string | null {
  const p = w.players[owner]
  const t = UNIT[id]
  if (!w.byId.get(p.station) || w.byId.get(p.station)!.dead) return 'No station'
  if (t.level > p.level) return `Needs station level ${t.level}`
  if (t.tier === 'capital' && capitals(w, owner) >= MAX_CAPITALS) return 'One flagship at a time'
  if (p.queue.length >= MAX_QUEUE) return 'Queue full'
  if (p.pop + queuedPop(p) + t.pop > p.popCap) return 'Fleet at its limit: capture beacons or upgrade the station'
  if (p.credits < t.cost) return 'Not enough credits'
  return null
}

export function cmdBuild(w: World, owner: Owner, id: string) {
  const why = cantBuild(w, owner, id)
  if (why) return why
  const p = w.players[owner]
  const t = UNIT[id]
  p.credits -= t.cost
  const time = t.build * (1 + (techBonus(p, id).build ?? 0))
  p.queue.push({ unit: id, left: time, total: time })
  return null
}

export function cmdCancel(w: World, owner: Owner, index: number) {
  const p = w.players[owner]
  const q = p.queue[index]
  if (!q) return
  p.credits += UNIT[q.unit].cost
  p.queue.splice(index, 1)
}

/** What a piece of research (or the next station level) costs. */
export function researchCost(p: Player, id: string) {
  if (id === LEVEL_UP) return UPGRADES[p.level + 1] ?? null
  const t = TECH[id]
  return t ? { cost: t.cost, time: t.time } : null
}

/** Why something can't be researched right now, or null if it can. */
export function cantResearch(w: World, owner: Owner, id: string): string | null {
  const p = w.players[owner]
  const st = w.byId.get(p.station)
  if (!st || st.dead) return 'No station'
  if (id === LEVEL_UP) {
    if (p.level >= MAX_LEVEL) return 'Fully upgraded'
  } else {
    const t = TECH[id]
    if (!t || t.faction !== p.faction) return 'Unknown research'
    if (p.techs.includes(id)) return 'Already researched'
    if (t.level > p.level) return `Needs station level ${t.level}`
  }
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
  p.credits -= c.cost
  p.research.push({ id, left: c.time, total: c.time })
  return null
}

export function cmdCancelResearch(w: World, owner: Owner, index: number) {
  const p = w.players[owner]
  const r = p.research[index]
  if (!r) return
  p.credits += r.id === LEVEL_UP ? UPGRADES[p.level + 1]!.cost : TECH[r.id].cost
  p.research.splice(index, 1)
}

/** Research is done: apply it to every ship of that type already flying. */
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
  }
  w.events.push({ k: 'tech', owner: o, id })
}

/** Why a structure (mining or defense platform) can't go on this ore, or null if it can. */
export function cantSite(w: World, owner: Owner, node: number, tier: 'mine' | 'defense'): string | null {
  const n = w.nodes[node]
  const p = w.players[owner]
  if (!n) return 'No ore there'
  if (n.site) return 'Something is already built here'
  if (n.owner !== p.team) return 'Survey it first: keep ships near it for a few seconds'
  if (w.units.some((u) => !u.dead && foes(w, u.owner, owner) && isShip(u.t) && u.t.tier !== 'fighter' && d2(u.x, u.y, n.x, n.y) < SURVEY_RADIUS ** 2)) return 'Enemy ships are in the way'
  if (p.credits < unitOf(p.faction, tier).cost) return 'Not enough credits'
  return null
}

export function cmdSite(w: World, owner: Owner, node: number, tier: 'mine' | 'defense') {
  const why = cantSite(w, owner, node, tier)
  if (why) return why
  const p = w.players[owner]
  const n = w.nodes[node]
  const t = unitOf(p.faction, tier)
  p.credits -= t.cost
  const m = spawn(w, t.id, owner, n.x, n.y, tier === 'mine' ? n.rot : 0)
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
    let mines = 0
    for (const u of w.units) {
      if (u.dead || u.owner !== o) continue
      if (!u.parent) pop += u.t.pop / u.t.squad
      if (u.t.tier === 'mine' && !building(u)) mines++
    }
    const beacons = w.beacons.filter((b) => b.owner === p.team).length
    p.pop = Math.round(pop)
    p.popCap = BASE_POP + (p.level - 1) * POP_PER_LEVEL + beacons * BEACON_POP
    const ore = MINE_INCOME * (1 + (techBonus(p, stationOf(p)).mines ?? 0))
    p.income = (STATION_INCOME[p.level] + mines * ore + beacons * BEACON_INCOME) * p.incomeMul
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
  const bay = hpPos(carrier, bays[Math.floor(Math.random() * bays.length)])
  for (const f of spawnGroup(w, c.unit, carrier.owner, bay.x, bay.y, carrier.a)) {
    f.parent = carrier.id
    f.v = f.t.speed * 0.6
  }
  w.events.push({ k: 'launch', owner: carrier.owner, x: bay.x, y: bay.y })
}

function kill(w: World, u: Unit, by: Owner | -1) {
  if (u.dead) return
  u.dead = true
  w.events.push({ k: 'boom', x: u.x, y: u.y, tier: u.t.tier, owner: u.owner, size: u.t.size })
  w.players[u.owner].stats.lost++
  if (by !== -1) w.players[by].stats.killed++
  if (u.node >= 0 && w.nodes[u.node].site === u.id) w.nodes[u.node].site = 0
  if (u.t.tier === 'station') {
    // A player whose station falls is out; the last team with a station standing wins.
    w.players[u.owner].alive = false
    w.events.push({ k: 'out', owner: u.owner })
    const standing = new Set(w.players.filter((p) => p.alive).map((p) => p.team))
    if (standing.size === 1 && w.winner === -1) w.winner = [...standing][0]
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
  u.lastHit = w.time
  alarm(w, u)
  let rest = dmg
  if (u.shield > 0) {
    const onShield = kind === 'missile' ? dmg * 0.35 : dmg
    const soaked = Math.min(u.shield, onShield)
    u.shield -= soaked
    rest -= soaked
    u.shieldHit = w.time
    u.hitAngle = Math.atan2(fromY - u.y, fromX - u.x)
  }
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
    kill(w, u, by)
    const killer = w.byId.get(shooter)
    if (killer && !killer.dead) killer.kills++
  }
}

function valid(w: World, id: number, owner: Owner) {
  const t = w.byId.get(id)
  return t && !t.dead && foes(w, t.owner, owner) && sees(w, owner, t) ? t : undefined
}

/** The best thing for a ship to shoot within `r`: what its guns hurt most, nearest first. */
function pickTarget(w: World, u: Unit, r: number) {
  let best: Unit | undefined
  let score = 0
  near(w, u.x, u.y, r, (e, dd) => {
    if (!foes(w, e.owner, u.owner) || !sees(w, u.owner, e)) return
    const s = (dpsVs(u.t, e.t.tier) + 0.01) / (Math.sqrt(dd) + 250) * (e.t.tier === 'mine' ? 0.6 : 1)
    if (s > score) {
      score = s
      best = e
    }
  })
  return best
}

function steer(u: Unit, tx: number, ty: number, want: number, dt: number, inPlace = false) {
  const turn = u.t.turn * (u.slow > 0 ? 0.5 : 1)
  const ang = Math.atan2(ty - u.y, tx - u.x)
  const diff = wrap(ang - u.a)
  u.a = wrap(u.a + clamp(diff, -turn * dt, turn * dt))
  // Big ships slow right down to turn; fighters bank through it.
  const fighter = u.t.tier === 'fighter'
  const align = fighter ? 0.55 + 0.45 * Math.max(0, Math.cos(diff)) : Math.max(inPlace ? 0 : 0.15, Math.cos(diff))
  const target = want * align
  const acc = u.t.speed * (fighter ? 1.6 : 0.6)
  u.v += clamp(target - u.v, -acc * dt * 1.5, acc * dt)
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

  // Who are we fighting? Explicit attack orders stick; otherwise look around now and then.
  u.retarget -= dt
  if (u.order.k === 'attack') {
    const tgt = valid(w, u.order.id, u.owner)
    if (!tgt) {
      u.order = { k: 'idle' }
      u.ax = u.x
      u.ay = u.y
    } else u.target = tgt.id
  } else if (u.retarget <= 0) {
    u.retarget = 0.4 + Math.random() * 0.3
    const engage = u.order.k === 'idle' || u.order.k === 'patrol' || (u.order.k === 'move' && u.order.attack)
    const cur = valid(w, u.target, u.owner)
    // Holding ships only look as far as their guns reach (fighters a little further).
    const look = u.hold ? (fighter ? 450 : fightRange(t) * u.mods.range + 100) : Math.min(sensorOf(u), fighter ? 900 : 800)
    const leash = u.hold ? look : fighter ? 1100 : 700
    if (!engage) u.target = 0
    else if (cur && d2(cur.x, cur.y, u.ax, u.ay) < leash ** 2 && d2(cur.x, cur.y, u.x, u.y) < (sensorOf(u) * 1.1) ** 2) u.target = cur.id
    else u.target = pickTarget(w, u, look)?.id ?? 0
  }
  const tgt = u.target ? w.byId.get(u.target) : undefined

  const fighting = !!tgt && !tgt.dead && (u.order.k !== 'move' || u.order.attack)
  if (fighting) {
    const e = tgt!
    if (fighter) {
      // Dogfight: chase with a little lead, overshoot, loop back round.
      const lead = Math.hypot(e.x - u.x, e.y - u.y) / 700
      const ex = e.x + Math.cos(e.a) * e.v * lead
      const ey = e.y + Math.sin(e.a) * e.v * lead
      const close = d2(u.x, u.y, e.x, e.y) < (radius(e.t) + 45) ** 2
      if (close) steer(u, u.x + Math.cos(u.a) * 100, u.y + Math.sin(u.a) * 100, max, dt)
      else steer(u, ex + ((u.id % 7) - 3) * 8, ey + ((u.id % 5) - 2) * 8, max, dt)
    } else if (u.hold) {
      steer(u, e.x, e.y, 0, dt, true)
    } else {
      // Close to fighting range, then hold there and swing round to face the enemy.
      // Brake in time to stop at range rather than ramming them.
      const want = fightRange(t) * u.mods.range * 0.8 + radius(e.t) * 0.5
      const dist = Math.hypot(e.x - u.x, e.y - u.y)
      const brake = Math.sqrt(2 * t.speed * 0.9 * Math.max(0, dist - want))
      steer(u, e.x, e.y, dist > want ? Math.min(max, brake) : 0, dt, dist <= want)
    }
  } else if (u.order.k === 'move' || u.order.k === 'patrol') {
    const o = u.order
    const dist = Math.hypot(o.x - u.x, o.y - u.y)
    const pace = Math.min(max, o.speed)
    if (dist < (fighter ? 60 : 24 + radius(t) * 0.2)) {
      if (o.k === 'patrol') u.order = { ...o, x: o.bx, y: o.by, bx: o.x, by: o.y }
      else {
        u.order = { k: 'idle' }
        u.ax = o.x
        u.ay = o.y
      }
    } else steer(u, o.x, o.y, fighter ? pace : Math.min(pace, dist * 0.9 + 12), dt)
  } else {
    // Idle: fighters circle their spot, everything else drifts back to it and waits.
    const dist = Math.hypot(u.ax - u.x, u.ay - u.y)
    if (fighter) {
      const ang = w.time * 0.9 + u.id
      const r = 70 + (u.id % 4) * 18
      steer(u, u.ax + Math.cos(ang) * r, u.ay + Math.sin(ang) * r, max * 0.65, dt)
    } else if (dist > 30 + radius(t) * 0.3) steer(u, u.ax, u.ay, Math.min(max, dist * 0.8 + 10), dt)
    else u.v = Math.max(0, u.v - t.speed * dt)
  }

  u.x += Math.cos(u.a) * u.v * dt
  u.y += Math.sin(u.a) * u.v * dt

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
      const nx = d > 1 ? (u.x - o.x) / d : Math.cos(u.id)
      const ny = d > 1 ? (u.y - o.y) / d : Math.sin(u.id)
      u.x += nx * push
      u.y += ny * push
    })
  u.x = clamp(u.x, 20, w.w - 20)
  u.y = clamp(u.y, 20, w.h - 20)
}

const BOLT_SPEED: Record<WeaponKind, number> = { laser: 1100, flak: 1250, turbo: 850, missile: 480 }

function fire(w: World, u: Unit, g: Gun, e: Unit) {
  const from = g.hp >= 0 ? hpPos(u, g.hp) : u.t.tier === 'fighter' ? { x: u.x + Math.cos(u.a) * 10, y: u.y + Math.sin(u.a) * 10 } : shipPoint(u, 3 + Math.random() * 4, 2 + Math.random() * 6)
  // Aim: the hardpoint we were told to hit, or (for heavy guns) whatever hardpoint faces us.
  let hp = -1
  const forced = u.order.k === 'attack' && u.order.id === e.id ? u.order.hp : -1
  if (forced >= 0 && alive(e, forced)) hp = forced
  else if (e.hps.length && Math.random() < 0.6) {
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
  const aim = hp >= 0 ? hpPos(e, hp) : { x: e.x + (Math.random() - 0.5) * radius(e.t) * 0.8, y: e.y + (Math.random() - 0.5) * radius(e.t) * 0.8 }
  const speed = BOLT_SPEED[g.w.kind]
  let t = Math.hypot(aim.x - from.x, aim.y - from.y) / speed
  let ax = aim.x + Math.cos(e.a) * e.v * t
  let ay = aim.y + Math.sin(e.a) * e.v * t
  const hit = Math.random() < accuracy(g.w.kind, e.t.tier) * (e.slow > 0 ? 1.2 : 1)
  if (!hit) {
    const off = radius(e.t) * (0.8 + Math.random()) + 20
    const side = Math.random() < 0.5 ? -1 : 1
    const ang = Math.atan2(ay - from.y, ax - from.x) + side * Math.PI / 2
    ax += Math.cos(ang) * off
    ay += Math.sin(ang) * off
  }
  t = Math.hypot(ax - from.x, ay - from.y) / speed
  const p = w.players[u.owner]
  let dmg = g.w.damage * effect(g.w.kind, e.t.tier)
  if (u.t.tier === 'station') dmg *= 1 + STATION_LEVEL_BONUS * (p.level - 1)
  if (u.abilityOn > 0 && u.t.ability === 'broadside' && g.w.kind === 'turbo') dmg *= 1.6
  dmg *= u.mods.damage
  w.shots.push({
    x: from.x, y: from.y, vx: (ax - from.x) / Math.max(t, 0.001), vy: (ay - from.y) / Math.max(t, 0.001), left: hit ? t : t * 1.6,
    kind: g.w.kind, owner: u.owner, target: e.id, hp, dmg, hit, sx: from.x, sy: from.y, age: 0, from: u.id,
  })
  w.events.push({ k: 'fire', kind: g.w.kind, x: from.x, y: from.y, owner: u.owner })
}

function shoot(w: World, u: Unit, dt: number) {
  if (building(u) || !u.guns.length) return
  const primary = u.target ? w.byId.get(u.target) : undefined
  for (const g of u.guns) {
    if (g.hp >= 0 && !alive(u, g.hp)) continue
    g.cd -= dt
    if (g.burst > 0) {
      g.burstT -= dt
      if (g.burstT <= 0) {
        const e = valid(w, g.target, u.owner)
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
      if (g.w.arc && Math.abs(wrap(Math.atan2(e.y - u.y, e.x - u.x) - u.a)) > g.w.arc) return false
      return true
    }
    let e: Unit | undefined
    if (primary && !primary.dead && foes(w, primary.owner, u.owner) && sees(w, u.owner, primary) && effect(g.w.kind, primary.t.tier) >= 0.3 && inReach(primary)) e = primary
    else {
      let score = 0
      near(w, from.x, from.y, g.w.range + 200, (o, dd) => {
        if (!foes(w, o.owner, u.owner) || !sees(w, u.owner, o) || !inReach(o)) return
        const s = (effect(g.w.kind, o.t.tier) * accuracy(g.w.kind, o.t.tier)) / (Math.sqrt(dd) + 200)
        if (s > score) {
          score = s
          e = o
        }
      })
    }
    if (!e) {
      g.cd = 0.15
      continue
    }
    g.target = e.id
    g.aim = Math.atan2(e.y - from.y, e.x - from.x)
    fire(w, u, g, e)
    const barrage = u.abilityOn > 0 && u.t.ability === 'flakBarrage' && g.w.kind === 'flak' ? 0.5 : 1
    g.cd = g.w.cooldown * barrage * u.mods.cooldown * (0.9 + Math.random() * 0.2)
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
        const sp = Math.hypot(s.vx, s.vy)
        const ang = Math.atan2(e.y - s.y, e.x - s.x)
        const cur = Math.atan2(s.vy, s.vx)
        const na = cur + clamp(wrap(ang - cur), -3 * dt, 3 * dt)
        s.vx = Math.cos(na) * sp
        s.vy = Math.sin(na) * sp
        s.left = Math.max(s.left, Math.hypot(e.x - s.x, e.y - s.y) / sp)
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
    const r = p.research[0]
    if (r) {
      r.left -= dt
      if (r.left <= 0) {
        p.research.shift()
        if (r.id === LEVEL_UP) {
          p.level++
          const grow = (1 + STATION_LEVEL_BONUS * (p.level - 1)) / (1 + STATION_LEVEL_BONUS * (p.level - 2))
          st.hullMax *= grow
          st.hull *= grow
          w.events.push({ k: 'level', owner: o, level: p.level })
        } else finishResearch(w, o, r.id)
      }
    }
    // Repair docks mend our ships parked near the station.
    const repair = techBonus(p, st.t.id).repair
    if (repair)
      near(w, st.x, st.y, 900, (u) => {
        if (u.owner === o && isShip(u.t) && u.hull < u.hullMax) u.hull = Math.min(u.hullMax, u.hull + u.hullMax * repair * dt)
      })
    const q = p.queue[0]
    if (q) {
      q.left -= dt * (hangarsUp(st) ? 1 : 0.5)
      if (q.left <= 0) {
        p.queue.shift()
        const bay = st.t.hardpoints.findIndex((h) => h.kind === 'hangar')
        const from = bay >= 0 ? hpPos(st, bay) : st
        const a = Math.atan2(p.rally.y - from.y, p.rally.x - from.x)
        const group = spawnGroup(w, q.unit, o, from.x, from.y, a)
        for (const u of group) u.v = u.t.speed * 0.5
        cmdMove(w, o, group.map((u) => u.id), p.rally.x, p.rally.y, true)
        p.stats.built++
        w.events.push({ k: 'built', owner: o, unit: q.unit, x: from.x, y: from.y })
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
function claim(c: Claimable, power: number[], rate: number, drift: number): number | null {
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
    const home = c.owner !== -1 ? 1 : 0
    if (c.owner !== -1) c.claim = c.owner
    c.progress += clamp(home - c.progress, -drift, drift)
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

/** Surveying ore: our ships near an empty asteroid, with no enemy ships there, claim it in
 * SURVEY_TIME seconds; taking one from the enemy means undoing their claim first. */
function survey(w: World, dt: number) {
  for (const n of w.nodes) {
    if (n.site) continue
    const power = new Array(w.teams).fill(0)
    near(w, n.x, n.y, SURVEY_RADIUS, (u) => {
      if (isShip(u.t)) power[w.players[u.owner].team] = 1
    })
    const prev = claim(n, power, dt / SURVEY_TIME, dt / 30)
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
  beacons(w, dt)
  survey(w, dt)
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
    // Shields recharge, faster once out of the fight for a few seconds; terrain can stop that.
    if (!terrain(w, u, dt)) {
      const smax = shieldMax(u)
      if (u.shield < smax) u.shield = Math.min(smax, u.shield + u.t.regen * u.mods.regen * dt * (w.time - u.lastHit > 6 ? 2 : 1))
    }
    if (u.t.carrier) {
      u.hangarT += dt
      if (u.hangarT >= u.t.carrier.every * (techBonus(w.players[u.owner], u.t.id).hangar ? 0.7 : 1)) {
        u.hangarT = 0
        launch(w, u)
      }
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
}

/** Ships a player owns, for selection helpers and the AI. */
export const fleet = (w: World, o: Owner) => w.units.filter((u) => !u.dead && u.owner === o && isShip(u.t))
