import { DIFFICULTY, PROFILES, calmOf, type Brain } from '../ai.ts'
import { UNIT, type UnitType } from '../data.ts'
import { cantBuild, cmdAttack, cmdBuild, cmdMove, cmdSpread, rand, type Unit, type World } from '../sim.ts'
import { TILE, type Pt } from './types.ts'
import { seesAt } from './fog.ts'
import { POP_MAX, knownBuildings, tierNeeded, trainsOf } from './world.ts'

// The AI's army in a ground battle (a part of ground/think.ts's decisions, on the space AI's brain,
// difficulty and style):
// - Scouts: two from the Command Center, one scouting (the enemy's start first, then the map's
//   spawns and crystal fields) and the other raiding enemy engineers, only after its quiet start.
// - Training: what its factories train is picked to counter what it has seen of the enemy (the
//   counter loop: fast units beat heavy ones, heavy beat anti-swarm, anti-swarm beat fast), with a
//   taste for the newest tier it has and some variety (pickFighter, used by think.ts).
// - Waves: the army gathers at a rally point in front of its base and, once its quiet start is over
//   and it is worth enough, attacks the nearest enemy building it knows of with attack-move, its
//   guns on one target at a time on the harder levels; a wave that loses too much comes home and the
//   next waits for more; units trained while a wave is out follow it in groups. Once every enemy
//   building it knows of is down it hunts the map for the rest (the spawns, the crystal fields).
// - Defence: anything that comes near its buildings or engineers, noticed after its reaction time,
//   is met by everything at home, and a wave out is called back if the attack is big enough.
// - Damaged heavies (tier 2 and 3, below its style's share of their hull) are pulled out of a
//   wave and sent home to guard the base.
// - Its squads spread out when an enemy that hurts groups (artillery, swarm rockets, sprays) comes
//   near while they hold or advance, and close up again once it is gone or to chase or fall back.
// Only what its team knows, the world's random stream, the same orders a player gives.

/** Scouts it keeps, and the engineers it has before it trains any. */
const SCOUTS = 2
const SCOUTS_AFTER = 4
/** Seconds between Scouts it trains, and how many it trains in a battle at most. */
const SCOUT_EVERY = 60
const SCOUTS_MAX = 6
/** Kyber it keeps back from Scouts, for an engineer should it lose them all. */
const RESERVE = 200
/** How near its buildings (tiles) an enemy counts as an attack on them. */
const DEFEND = 14
/** The army value of its first wave, as a share of its difficulty's space wave (ground units are
 * cheaper than warships), and how much bigger the next gets after a wave that failed. */
const WAVE = 0.8
const WAVE_GROW = 1.2
/** Seconds of battle over which the army a wave waits for grows by its first wave's worth again. */
const GROW_TIME = 600
/** Seconds between batches of reinforcements sent after a wave, and the least a batch holds. */
const FOLLOW = 25
const FOLLOW_MIN = 3
/** How near (tiles) an enemy that hurts groups makes its squads spread out, and how far it must be
 * before they close up again. */
const SPREAD_NEAR = 14
const SPREAD_CLEAR = 20
/** Its hunt for the last enemy buildings: the grid it looks over (tiles apart), and how long it
 * tries to reach one place before it moves on. */
const HUNT_GRID = 14
const HUNT_PATIENCE = 90
/** Seconds into a battle after which its waves no longer turn back and fewer guards stay home. */
const LATE = 25 * 60
/** The share of its army (in kyber) that stays home when a wave sets out, and at least how many. */
const GUARD = 0.2
const GUARDS = 2
/** How far in front of its base (tiles) the army gathers. */
const RALLY = 9
/** How near the wave's middle (tiles) it looks for something to focus its fire on. */
const FOCUS = 8
/** The least quiet start on the ground at Medium, in seconds: long enough to put up a generator and
 * a factory before anything of its comes calling (Easy and Very easy keep their longer ones). */
const CALM_MEDIUM = 240

/** Its quiet start on the ground: the space AI's (calmOf), at Medium no shorter than CALM_MEDIUM. */
export const groundCalm = (w: World, b: Brain) => Math.max(calmOf(w, b), b.diff === 'medium' ? CALM_MEDIUM : 0)

const d2 = (a: Pt, b: Pt) => (a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y)
const worth = (u: Unit) => u.t.cost * (u.hull / u.hullMax)

/** What a unit is in the counter loop: fast (tier 1 and Scouts), anti-swarm (tier 2) or heavy (tier 3). */
type Role = 'fast' | 'swarm' | 'heavy'
const roleOf = (t: UnitType): Role => ((t.ground?.tier ?? 1) >= 3 ? 'heavy' : (t.ground?.tier ?? 1) === 2 ? 'swarm' : 'fast')
/** What each role beats, and what beats it. */
const BEATS: Record<Role, Role> = { fast: 'heavy', heavy: 'swarm', swarm: 'fast' }
const BEATEN: Record<Role, Role> = { fast: 'swarm', heavy: 'fast', swarm: 'heavy' }

/** Its fighters: what its factories train (not engineers, Scouts or buildings). */
export const isFighter = (u: Unit) => !u.foot && !u.dead && !u.t.ground?.builds?.length && u.t.role?.role !== 'Scout' && u.guns.length > 0

/** The enemy army it has seen, by role, in kyber (remembered on the brain, forgotten as they die). */
function seenFoes(w: World, b: Brain): Record<Role, number> {
  const team = w.players[b.o].team
  const seen = (b.gFoes ??= {})
  for (const u of w.units) if (!u.dead && w.players[u.owner].team !== team && u.seen[team] && isFighter(u)) seen[u.id] = u.t.id
  const out: Record<Role, number> = { fast: 0, swarm: 0, heavy: 0 }
  for (const key of Object.keys(seen)) {
    const id = Number(key)
    const u = w.byId.get(id)
    if (!u || u.dead) {
      delete seen[id]
      continue
    }
    out[roleOf(UNIT[seen[id]])] += UNIT[seen[id]].cost
  }
  return out
}

/**
 * The unit factory `f` should train next, of those it can now: the one that best counters the enemy
 * army it has seen, then the newest tier, then what it has fewest of. Undefined when it can train
 * nothing.
 */
export function pickFighter(w: World, b: Brain, f: Unit, mine: Unit[]): UnitType | undefined {
  const kinds = trainsOf(f).filter((t) => tierNeeded(t) <= (f.t.ground?.tier ?? 1))
  if (!kinds.length) return undefined
  const foes = seenFoes(w, b)
  const total = foes.fast + foes.swarm + foes.heavy
  const have = (id: string) => mine.filter((u) => u.t.id === id).length
  const score = (t: UnitType) => {
    const r = roleOf(t)
    const counter = total ? (foes[BEATS[r]] - foes[BEATEN[r]] * 0.5) / total : 0
    return 1 + counter * 1.5 + (t.ground?.tier ?? 1) * 0.5 - have(t.id) * 0.15
  }
  return kinds.slice().sort((a, c) => score(c) - score(a) || have(a.id) - have(c.id) || (a.id < c.id ? -1 : 1))[0]
}

/** How much its army may be worth at most (the easy levels hold back), in kyber; 0: no limit. */
export const armyCap = (b: Brain) => DIFFICULTY[b.diff].cap * WAVE

/** Its army's turn: Scouts, waves, defence, damaged heavies. `mine`: its units. */
export function armyThink(w: World, b: Brain, mine: Unit[]) {
  if (b.peaceful) return
  const o = b.o
  const p = w.players[o]
  const team = p.team
  const D = DIFFICULTY[b.diff]
  const S = PROFILES[b.profile]
  const calm = w.time < groundCalm(w, b)
  const late = w.time > LATE
  const buildings = mine.filter((u) => !!u.foot)
  const engineers = mine.filter((u) => !!u.t.ground?.builds?.length)
  const home = buildings.find((u) => u.t.ground?.dropOff && !u.site) ?? buildings[0]
  if (!home) return
  const enemy = w.players.find((q) => q.team !== team && q.alive)
  if (!enemy) return

  // Where the army gathers: in front of the base, towards the enemy.
  const away = Math.sqrt(d2(enemy.start, home)) || 1
  const rally = { x: home.x + ((enemy.start.x - home.x) / away) * RALLY * TILE, y: home.y + ((enemy.start.y - home.y) / away) * RALLY * TILE }

  scoutThink(w, b, mine, engineers, calm)
  spreadThink(w, b, mine)

  const army = mine.filter(isFighter)
  const ids = new Set(army.map((u) => u.id))
  const wave = new Set((b.gWave ?? []).filter((id) => ids.has(id)))
  const hurt = new Set((b.gHurt ?? []).filter((id) => ids.has(id)))

  // Defence: the nearest enemy to our buildings or engineers, once it has noticed.
  let threat: Unit | undefined
  let threatWorth = 0
  let td = Infinity
  const guarded = [...buildings, ...engineers]
  for (const e of w.units) {
    if (e.dead || !e.t.ground || w.players[e.owner].team === team || !e.seen[team] || e.foot) continue
    let near = Infinity
    for (const s of guarded) near = Math.min(near, d2(e, s))
    if (near > DEFEND * TILE * DEFEND * TILE) continue
    threatWorth += worth(e)
    if (near < td) {
      td = near
      threat = e
    }
  }
  if (!threat) b.gAlarm = -1
  else if ((b.gAlarm ?? -1) < 0) b.gAlarm = w.time
  const alarmed = !!threat && w.time - (b.gAlarm ?? w.time) >= D.react
  const athome = army.filter((u) => !wave.has(u.id))
  if (alarmed && threat) {
    const free = athome.filter((u) => u.order.k === 'idle' || (u.order.k === 'move' && !u.order.attack))
    if (free.length) cmdMove(w, o, free.map((u) => u.id), threat.x, threat.y, true)
    // A big attack calls the wave home.
    const waveWorth = army.filter((u) => wave.has(u.id)).reduce((n, u) => n + worth(u), 0)
    if (wave.size && threatWorth > waveWorth * S.recall) {
      cmdMove(w, o, [...wave], threat.x, threat.y, true)
      wave.clear()
    }
  }

  // Damaged heavies leave the wave and go home.
  for (const u of army) {
    if (!wave.has(u.id) || (u.t.ground?.tier ?? 1) < 2 || u.hull / u.hullMax >= Math.max(0.3, S.mendAt)) continue
    wave.delete(u.id)
    hurt.add(u.id)
    cmdMove(w, o, [u.id], rally.x, rally.y, false)
  }
  b.gWave = [...wave]
  b.gHurt = [...hurt]

  // The next place to attack: the nearest enemy building it knows of, else (they are all down) the
  // next place on its hunt round the map.
  const known = knownBuildings(w, o).filter((k) => w.players[k.owner].team !== team)
  const from = wave.size ? centre(army.filter((u) => wave.has(u.id))) : rally
  const target: Pt | undefined = known.length
    ? known
        .map((k) => ({ x: (k.tc + UNIT[k.unit].ground!.foot![0] / 2) * TILE, y: (k.tr + UNIT[k.unit].ground!.foot![1] / 2) * TILE, id: k.id }))
        .sort((a, c) => d2(a, from) - d2(c, from) || a.id - c.id)[0]
    : huntSpot(w, b, from)

  // A wave out: it pushes on, focuses its fire, or comes home when it has lost too much.
  if (wave.size) {
    const units = army.filter((u) => wave.has(u.id))
    const now = units.reduce((n, u) => n + worth(u), 0)
    // (Late in a battle its waves fight to the end: someone has to break the deadlock.)
    if (!late && now < (b.gWaveFrom ?? now) * S.regroup) {
      cmdMove(w, o, units.map((u) => u.id), rally.x, rally.y, false)
      b.gWave = []
      b.gWaveV = (b.gWaveV ?? D.wave * S.wave * WAVE) * WAVE_GROW
      b.gWaveAt = w.time
      return
    }
    const idle = units.filter((u) => u.order.k === 'idle')
    if (idle.length && target) cmdMove(w, o, idle.map((u) => u.id), target.x, target.y, true)
    if (D.focus) focusFire(w, b, units)
    // Reinforcements follow in groups.
    // (Leaving its guards home.)
    const spare = athome.filter((u) => !hurt.has(u.id) && u.order.k === 'idle').sort((a, c) => d2(c, home) - d2(a, home) || a.id - c.id).slice(0, Math.max(0, athome.length - GUARDS))
    if (!alarmed && spare.length >= FOLLOW_MIN && w.time - (b.gFollowAt ?? 0) >= FOLLOW && target) {
      b.gFollowAt = w.time
      cmdMove(w, o, spare.map((u) => u.id), target.x, target.y, true)
      b.gWave = [...wave, ...spare.map((u) => u.id)]
      b.gWaveFrom = (b.gWaveFrom ?? 0) + spare.reduce((n, u) => n + worth(u), 0)
    }
    return
  }

  // At home: gather at the rally point, and set out once there is enough of an army.
  const gathering = athome.filter((u) => !hurt.has(u.id))
  const loose = gathering.filter((u) => u.order.k === 'idle' && d2(u, rally) > 5 * TILE * 5 * TILE)
  if (loose.length && !alarmed) cmdMove(w, o, loose.map((u) => u.id), rally.x, rally.y, true)
  const value = gathering.reduce((n, u) => n + worth(u), 0)
  // Each wave waits for a bigger army than the last, and later in the battle for more again.
  const need = (b.gWaveV ?? D.wave * S.wave * WAVE) * (1 + w.time / GROW_TIME)
  const rested = w.time - (b.gWaveAt ?? -1e9) >= S.rest
  // Once it sees nothing of the enemy's army left, a smaller army is enough to go and finish it.
  const beaten = !w.units.some((u) => !u.dead && w.players[u.owner].team !== team && isFighter(u) && u.seen[team])
  // (An army that has filled the unit cap goes, however big a wave it was waiting for.)
  const maxed = p.pop >= Math.min(p.popCap, POP_MAX) - 3 && p.popCap >= POP_MAX * 0.4
  const ready = value >= need || (maxed && value >= need * 0.4) || (beaten && value >= need * 0.4 && w.time > groundCalm(w, b) + 300)
  if (!calm && !alarmed && rested && target && ready && gathering.length) {
    // Some stay home to guard it, the ones nearest home, at least GUARDS of them.
    const keep = new Set<number>()
    let kept = 0
    for (const u of gathering.slice().sort((a, c) => d2(a, home) - d2(c, home) || a.id - c.id)) {
      if (keep.size >= GUARDS && kept >= value * (late ? GUARD / 2 : GUARD)) break
      if (gathering.length - keep.size <= FOLLOW_MIN) break
      keep.add(u.id)
      kept += worth(u)
    }
    const out = gathering.filter((u) => !keep.has(u.id)).map((u) => u.id)
    cmdMove(w, o, out, target.x, target.y, true)
    b.gWave = out
    b.gWaveFrom = value - kept
    b.gWaveV = (b.gWaveV ?? D.wave * S.wave * WAVE) * 1.1
    b.gWaveAt = w.time
    b.gFollowAt = w.time
  }
}

/** Weapons that hurt groups: what a squad spreads out against. */
const SPLASHY = new Set(['artillery', 'swarm', 'spray'])

/** Its squads spread out while an enemy that hurts groups (artillery, swarm rockets, sprays) it sees
 * is within SPREAD_NEAR tiles of them and they hold their ground or advance, and close up once none
 * is within SPREAD_CLEAR, or to chase or fall back (spread out they are slow). */
function spreadThink(w: World, b: Brain, mine: Unit[]) {
  const team = w.players[b.o].team
  const splashers = w.units.filter((e) => !e.dead && w.players[e.owner].team !== team && e.seen[team] && e.guns.some((g) => SPLASHY.has(g.w.ground ?? '')))
  const on: number[] = []
  const off: number[] = []
  for (const u of mine) {
    if (u.t.ability !== 'spreadOut') continue
    const near = (r: number) => splashers.some((e) => d2(e, u) < r * TILE * r * TILE)
    // Spread out only holding ground or advancing (idle, an attack-move, or fighting what is in its
    // reach): it is too slow for a chase or a retreat, so a squad chasing a target or falling back
    // closes up.
    const o = u.order
    const prey = o.k === 'attack' ? w.byId.get(o.id) : undefined
    const reach = Math.max(0, ...u.guns.map((g) => g.w.range)) + 2 * TILE
    const steady = o.k === 'idle' || (o.k === 'move' && o.attack) || (!!prey && d2(prey, u) < reach * reach)
    if (!u.spread && steady && near(SPREAD_NEAR)) on.push(u.id)
    else if (u.spread && (!steady || !near(SPREAD_CLEAR))) off.push(u.id)
  }
  if (on.length) cmdSpread(w, b.o, on, true)
  if (off.length) cmdSpread(w, b.o, off, false)
}

/** The middle of some units. */
function centre(us: Unit[]): Pt {
  let x = 0
  let y = 0
  for (const u of us) {
    x += u.x
    y += u.y
  }
  return { x: x / Math.max(1, us.length), y: y / Math.max(1, us.length) }
}

/** With every enemy building it knew of down: the next place to look for the rest, the nearest it
 * hasn't seen lately of the map's spawns, its crystal fields and a grid over the whole map; a place
 * counts as looked at once its team sees it, or after HUNT_PATIENCE seconds of trying (it may be out
 * of reach). Once it has looked everywhere it starts again. */
function huntSpot(w: World, b: Brain, from: Pt): Pt | undefined {
  const g = w.ground!
  const team = w.players[b.o].team
  const spots: Pt[] = [...g.map.spawns, ...g.map.deposits]
  for (let y = (HUNT_GRID * TILE) / 2; y < w.h; y += HUNT_GRID * TILE) for (let x = (HUNT_GRID * TILE) / 2; x < w.w; x += HUNT_GRID * TILE) spots.push({ x, y })
  const done = new Set(b.gHunted ?? [])
  const cur = b.gHunt ?? -1
  if (cur >= 0 && (seesAt(g.fog, team, spots[cur].x, spots[cur].y) || w.time - (b.gHuntAt ?? w.time) > HUNT_PATIENCE)) {
    done.add(cur)
    b.gHunt = -1
  }
  if ((b.gHunt ?? -1) < 0) {
    let best = -1
    for (let i = 0; i < spots.length; i++) if (!done.has(i) && !seesAt(g.fog, team, spots[i].x, spots[i].y) && (best < 0 || d2(spots[i], from) < d2(spots[best], from))) best = i
    if (best < 0) {
      done.clear()
      best = 0
    }
    b.gHunt = best
    b.gHuntAt = w.time
  }
  b.gHunted = [...done]
  return spots[b.gHunt!]
}

/** A wave's guns on one enemy at a time: the weakest unit it sees near the wave's middle. */
function focusFire(w: World, b: Brain, units: Unit[]) {
  const team = w.players[b.o].team
  const mid = centre(units)
  let best: Unit | undefined
  let score = Infinity
  for (const e of w.units) {
    if (e.dead || !e.t.ground || e.foot || w.players[e.owner].team === team || !e.seen[team]) continue
    if (d2(e, mid) > FOCUS * TILE * FOCUS * TILE) continue
    // The nearest to dying first.
    const s = e.hull / e.hullMax + e.hull / 4000
    if (s < score) {
      score = s
      best = e
    }
  }
  if (!best) return
  const on = units.filter((u) => !(u.order.k === 'attack' && u.order.id === best!.id)).map((u) => u.id)
  if (on.length) cmdAttack(w, b.o, on, best.id)
}

/** Its Scouts: two, one scouting the map, the other raiding enemy engineers it sees once its quiet
 * start is over. */
function scoutThink(w: World, b: Brain, mine: Unit[], engineers: Unit[], calm: boolean) {
  const o = b.o
  const p = w.players[o]
  const team = p.team
  const scoutId = Object.values(UNIT).find((t) => t.faction === p.faction && t.ground && t.role?.role === 'Scout')?.id
  if (!scoutId) return
  const scouts = mine.filter((u) => u.t.id === scoutId)
  const centers = mine.filter((u) => !!u.foot && !u.site && !!u.t.ground?.trains?.includes(scoutId))
  const queued = centers.reduce((n, c) => n + (c.yq ?? []).filter((q) => q.unit === scoutId).length, 0)
  // (A lost one is replaced only after a while, and only so many times.)
  const due = w.time - (b.gScoutAt ?? -1e9) >= SCOUT_EVERY && (b.gScoutsMade ?? 0) < SCOUTS_MAX
  if (due && engineers.length >= SCOUTS_AFTER && scouts.length + queued < SCOUTS && !queued && p.credits >= UNIT[scoutId].cost + RESERVE) {
    const at = centers.find((c) => !cantBuild(w, o, scoutId, false, c.id))
    if (at) {
      cmdBuild(w, o, scoutId, false, at.id)
      b.gScoutAt = w.time
      b.gScoutsMade = (b.gScoutsMade ?? 0) + 1
    }
  }
  if (!scouts.length) return
  const scout = scouts.find((u) => u.id === b.gScout) ?? scouts[0]
  b.gScout = scout.id
  if (scout.order.k === 'idle') {
    const g = w.ground!.map
    // (During its quiet start it keeps to its own half of the map.)
    const enemy = w.players.find((q) => q.team !== team)
    const ours = (x: Pt) => !enemy || d2(x, p.start) < d2(x, enemy.start)
    const spots: Pt[] = calm
      ? g.deposits.filter(ours)
      : [...g.spawns.filter((_, i) => w.players.findIndex((q) => q.spawn === i && q.team !== team) >= 0), ...g.spawns, ...g.deposits]
    const first = (b.gScouted ?? 0) === 0 ? spots[0] : spots[Math.floor(rand(w) * spots.length)]
    b.gScouted = (b.gScouted ?? 0) + 1
    // During its quiet start it only looks: a plain move, firing at nothing on the way.
    if (first) cmdMove(w, o, [scout.id], first.x, first.y, !calm)
  }
  if (calm) return
  const raider = scouts.find((u) => u !== scout && u.order.k === 'idle')
  if (!raider) return
  const prey = w.units
    .filter((e) => !e.dead && e.t.ground && !e.foot && w.players[e.owner].team !== team && e.seen[team] && !!e.t.ground.builds?.length)
    .sort((a, c) => d2(a, raider) - d2(c, raider) || a.id - c.id)[0]
  if (prey) cmdAttack(w, o, [raider.id], prey.id)
}
