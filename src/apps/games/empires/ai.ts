import { ABILITIES, LEVEL_UP, MAX_LEVEL, UNIT, UPGRADES, buildable, isShip, techsFor, unitOf, type Tier } from './data.ts'
import { inside } from './maps.ts'
import { mapDist, rangeDist } from './scale.ts'
import { canRetreat, cantBuild, cantMend, cantRepair, cantResearch, cantUpgradeSite, cmdUpgradeSite, cmdAbility, cmdAttack, cmdBuild, cmdDeploy, cmdGuard, cmdMove, cmdRally, cmdRepair, cmdResearch, cmdRetreat, cmdSite, fleet, foes, near, rand, sees, shieldMax, type Owner, type Unit, type World } from './sim.ts'
import * as M from './detmath.ts'
import { sq } from './detmath.ts'

// The enemy admiral. Every second or two it looks at the battle and decides: claim ore, upgrade
// the station, queue ships that counter what it has seen, defend what's under attack, grab
// beacons, and once the fleet is big enough, go after the player's mines and station. The
// headless sims run one on each side. It has a person's hands: only so many actions a minute (each
// command is one, a move for a whole group included), and it notices an attack on its base a
// moment late. All of it runs on the world's clock and dice, so every copy of a multiplayer battle
// makes the same choices.

export type Difficulty = 'veryEasy' | 'easy' | 'medium' | 'hard'

type Level = {
  name: string
  blurb: string
  /** Income multiplier. */
  income: number
  /** Seconds between decisions. */
  think: number
  /** Fleet value it waits for before its first attack. */
  wave: number
  mines: number
  /** Aims heavy guns at shield generators. */
  focus: boolean
  /** Seconds before it attacks anything of ours; its scouts only take neutral ore and beacons until then. */
  calm: number
  research: boolean
  abilities: boolean
  defenses: boolean
  /** Actions a minute at most (commands: a move for a group of ships is one). */
  apm: number
  /** Seconds before it notices something attacking its station or platforms. */
  react: number
  /** Chance, each time it thinks it over, that it unlocks repair craft once it has warships to mend. */
  menders: number
}

export const DIFFICULTY: Record<Difficulty, Level> = {
  veryEasy: {
    name: 'Very easy', blurb: 'A sleepy recruit: earns little, never researches, and leaves you alone for the first ten minutes.',
    income: 0.55, think: 3.5, wave: 5000, mines: 2, focus: false, calm: 600, research: false, abilities: false, defenses: false, apm: 25, react: 6, menders: 0,
  },
  easy: {
    name: 'Easy', blurb: 'Slow to react and slow to grow. No attacks for the first six minutes.',
    income: 0.68, think: 3, wave: 4200, mines: 3, focus: false, calm: 360, research: true, abilities: false, defenses: false, apm: 35, react: 4, menders: 0.03,
  },
  medium: {
    name: 'Medium', blurb: 'A fair fight. It leaves you about two and a half minutes to settle in.',
    income: 1, think: 1.5, wave: 2500, mines: 4, focus: true, calm: 150, research: true, abilities: true, defenses: true, apm: 60, react: 2, menders: 0.08,
  },
  hard: {
    name: 'Hard', blurb: 'Quick, greedy, aggressive from the start, and it goes for your shield generators.',
    income: 1.25, think: 0.8, wave: 2000, mines: 5, focus: true, calm: 0, research: true, abilities: true, defenses: true, apm: 100, react: 1, menders: 0.16,
  },
}

export type Brain = {
  o: Owner
  diff: Difficulty
  t: number
  wave: number
  attacking: boolean
  peak: number
  scouts: Set<number>
  want: string | null
  lastWave: number
  /** Actions it can take right now (refilling at its APM, a few seconds' worth at most), and how
   * many it has taken. */
  hands: number
  acts: number
  /** When it first saw something attacking its base (-1: nothing is). */
  alarm: number
}

/** The most actions it can save up: a few seconds' worth. */
const handsMax = (D: Level) => Math.max(3, D.apm / 12)

export const newBrain = (o: Owner, diff: Difficulty): Brain => ({ o, diff, t: 2, wave: DIFFICULTY[diff].wave, attacking: false, peak: 0, scouts: new Set(), want: null, lastWave: 0, hands: handsMax(DIFFICULTY[diff]), acts: 0, alarm: -1 })

/** Its hands free up again with time (every tick, thinking or not). */
function rest(b: Brain, dt: number) {
  const D = DIFFICULTY[b.diff]
  // A brain saved before it had hands starts with them free.
  b.hands = Math.min(handsMax(D), (b.hands ?? handsMax(D)) + (dt * D.apm) / 60)
  b.acts ??= 0
  b.alarm ??= -1
}
/** Take an action if its hands are free; it counts only when the command went through (a refusal,
 * which comes back as a string, costs nothing). A `spare` action (the economy) leaves one free for
 * the fighting. */
function act(b: Brain, command: () => unknown, spare = false) {
  if (b.hands < (spare ? 2 : 1)) return false
  if (typeof command() === 'string') return false
  b.hands--
  b.acts++
  return true
}

const value = (us: Unit[]) => us.reduce((s, u) => s + (u.t.cost / u.t.squad) * (0.3 + 0.7 * (u.hull / u.hullMax)), 0)
const d2 = (a: { x: number; y: number }, b: { x: number; y: number }) => sq(a.x - b.x) + sq(a.y - b.y)

function visibleEnemies(w: World, o: Owner, x: number, y: number, r: number) {
  const out: Unit[] = []
  near(w, x, y, r, (u) => {
    if (foes(w, u.owner, o) && sees(w, o, u) && isShip(u.t)) out.push(u)
  })
  return out
}

/**
 * A spot near (x, y) at about the same distance from the station, clear of nebulas and asteroid
 * fields: a fleet gathering inside a nebula would sit there without shields and half blind, and
 * one in a field would grind on rocks every time it shuffles about. The map is no secret, so this
 * doesn't peek at anything the player can't see.
 */
function clearSpot(w: World, st: Unit, x: number, y: number) {
  const bad = (px: number, py: number) => inside(w.map.nebulas, px, py, 250) || inside(w.map.fields, px, py, 200)
  if (!bad(x, y)) return { x, y }
  const a0 = M.atan2(y - st.y, x - st.x)
  const d0 = M.hypot(x - st.x, y - st.y)
  for (const d of [d0, d0 * 0.7, d0 * 1.4])
    for (const da of [0.35, -0.35, 0.7, -0.7, 1.05, -1.05, 1.4, -1.4]) {
      const px = Math.min(w.w - 80, Math.max(80, st.x + M.cos(a0 + da) * d))
      const py = Math.min(w.h - 80, Math.max(80, st.y + M.sin(a0 + da) * d))
      if (!bad(px, py)) return { x: px, y: py }
    }
  return { x, y }
}

/** What the enemy has (that we can see) around a spot. */
const threatAt = (w: World, o: Owner, x: number, y: number, r = rangeDist(900)) => value(visibleEnemies(w, o, x, y, r))

/** What to save up for next: weighted towards ships that counter what we've seen. */
function pickShip(w: World, b: Brain): string | null {
  const p = w.players[b.o]
  const seen = w.units.filter((u) => foes(w, u.owner, b.o) && sees(w, b.o, u) && isShip(u.t))
  // A squadron counts once: five droid fighters are one threat, not five.
  const small = seen.filter((u) => u.t.tier === 'fighter' || u.t.tier === 'gunship').reduce((n, u) => n + 1 / u.t.squad, 0)
  const big = seen.filter((u) => u.t.tier !== 'fighter' && u.t.tier !== 'gunship').length
  const weights: Partial<Record<Tier, number>> = { fighter: 2, gunship: 3, frigate: 3.5, cruiser: 3, capital: 6 }
  if (small > big * 3) {
    weights.gunship! *= 2
    weights.frigate! *= 1.6
  }
  if (big > 2) {
    weights.cruiser! *= 1.6
    weights.frigate! *= 1.3
    weights.fighter! *= 0.5
  }
  const options = buildable(p.faction).filter((t) => {
    const why = cantBuild(w, b.o, t.id)
    return !why || why === 'Not enough credits'
  })
  if (!options.length) return null
  // Specialists by what they're for: bombers and ion ships once there are big shielded hulls to
  // break, a repair tender once there's a fleet worth mending (and not a second one too early).
  const army = fleet(w, b.o).filter((u) => !u.parent)
  const tenders = army.filter((u) => u.t.kind === 'support').length
  // Repair craft: a couple of squadrons once there are warships to look after, and no more.
  const menders = army.filter((u) => u.t.kind === 'repair').length / 2
  const warships = army.filter((u) => u.t.tier === 'frigate' || u.t.tier === 'cruiser' || u.t.tier === 'capital').length
  const weight = (t: (typeof options)[number]) =>
    t.kind === 'bomber' ? 0.6 + Math.min(3, big * 0.5)
      : t.kind === 'ion' ? (big >= 2 ? 2.4 : 0.5)
        : t.kind === 'support' ? (army.length >= 6 && tenders < 1 + army.length / 10 ? 1.8 : 0.1)
          : t.kind === 'repair' ? (menders < Math.min(2, 0.5 + warships / 2) ? 2 : 0.05)
            : (weights[t.tier] ?? 1)
  const total = options.reduce((s, t) => s + weight(t), 0)
  let r = rand(w) * total
  for (const t of options) {
    r -= weight(t)
    if (r <= 0) return t.id
  }
  return options[options.length - 1].id
}

export function think(w: World, b: Brain, dt: number) {
  rest(b, dt)
  b.t -= dt
  if (b.t > 0 || w.winner !== -1) return
  const D = DIFFICULTY[b.diff]
  b.t = D.think * (0.8 + rand(w) * 0.4)
  const o = b.o
  const p = w.players[o]
  const st = w.byId.get(p.station)
  if (!st || st.dead) return
  const team = p.team
  // The nearest enemy station still standing.
  const enemySt = w.players
    .filter((q) => q.alive && q.team !== team)
    .map((q) => w.byId.get(q.station))
    .filter((u): u is Unit => !!u && !u.dead)
    .sort((a, c) => d2(a, st) - d2(c, st))[0]
  // Rally in front of the station, towards the nearest enemy (or the middle of the map), out of
  // any nebula or asteroid field.
  const aim = enemySt ?? { x: w.w / 2, y: w.h / 2 }
  const ad = M.hypot(aim.x - st.x, aim.y - st.y) || 1
  const rally = clearSpot(w, st, st.x + ((aim.x - st.x) / ad) * mapDist(560), st.y + ((aim.y - st.y) / ad) * mapDist(560))
  // (Only when it has moved: leaving it where it is takes no hands.)
  if (d2(rally, p.rally) > sq(60)) act(b, () => cmdRally(w, o, rally.x, rally.y), true)

  // Ore first: build on what we've surveyed, nearest the station first. Once the economy is up,
  // spare surveyed ore gets a defense platform instead.
  const mines = w.units.filter((u) => u.owner === o && u.t.tier === 'mine').length
  // Ore counts as ours to take when it's nearer to us than to any enemy station, and nearer to us
  // than to an ally's, so allies don't take each other's.
  const enemyStations = w.players.filter((q) => q.alive && q.team !== team).map((q) => w.byId.get(q.station)).filter((u): u is Unit => !!u)
  const allyStations = w.players.filter((q) => q.alive && q.team === team && q !== p).map((q) => w.byId.get(q.station)).filter((u): u is Unit => !!u)
  const nearerUs = (n: { x: number; y: number }) => allyStations.every((a) => d2(n, st) <= d2(n, a))
  const mineToTake = (n: { x: number; y: number }) => enemyStations.every((e) => d2(n, st) < d2(n, e) * 1.05) && nearerUs(n)
  // Build on our team's claims nearest us; an ally's own patch is theirs (unless they're gone).
  const ours = w.nodes.filter((n) => n.owner === team && !n.site && nearerUs(n)).sort((a, c) => d2(a, st) - d2(c, st))
  // Surveyed ore with nothing on it is money left on the table: save for a mine before more ships.
  const savingForMine = !!ours[0] && mines < D.mines
  if (ours[0]) {
    const node = ours[0].id
    if (mines < D.mines && p.credits >= 500) act(b, () => cmdSite(w, o, node, unitOf(p.faction, 'mine').id), true)
    else if (D.defenses && mines >= Math.min(3, D.mines) && p.credits >= 700 + 600) act(b, () => cmdSite(w, o, node, defenseFor(w, o)), true)
  }

  // Spare money deepens the drills: a mining platform pays its upgrades back within minutes.
  if (p.credits > 1400) {
    const site = w.units.find((u) => u.owner === o && !u.dead && u.t.tier === 'mine' && !cantUpgradeSite(w, o, u, 'yield'))
    if (site) act(b, () => cmdUpgradeSite(w, o, site.id, 'yield'), true)
  }
  // Richer still, platforms get shield generators.
  if (p.credits > 1900) {
    const site = w.units.find((u) => u.owner === o && !u.dead && u.t.tier === 'mine' && !cantUpgradeSite(w, o, u, 'shield'))
    if (site) act(b, () => cmdUpgradeSite(w, o, site.id, 'shield'), true)
  }
  // Badly damaged structures get a repair crew when there's money to spare.
  for (const u of w.units) {
    if (u.owner !== o || u.dead || (u.t.tier !== 'station' && u.t.tier !== 'mine' && u.t.tier !== 'defense')) continue
    if (u.hull < u.hullMax * 0.6 || u.hps.some((h) => h.hp <= 0)) if (!cantRepair(w, o, u) && p.credits > 900) act(b, () => cmdRepair(w, o, u.id), true)
  }

  const army = fleet(w, o).filter((u) => !u.parent)
  const armyValue = value(army)

  // Station upgrades once there's a fleet to protect the investment: save for them first.
  const next = UPGRADES[p.level + 1]
  const leveling = p.research.some((r) => r.id === LEVEL_UP)
  const upgradeDue = p.level < MAX_LEVEL && !leveling && !!next && armyValue >= p.level * 700 && w.time > p.level * 140
  if (upgradeDue && p.credits >= next!.cost) act(b, () => cmdResearch(w, o, LEVEL_UP), true)

  // Research for what we fly most, once the yard is busy and there's money to spare.
  if (D.research && !upgradeDue && p.queue.length >= 2 && p.research.length === 0 && p.credits > (b.diff === 'hard' ? 600 : 1000)) {
    const counts = new Map<string, number>()
    for (const u of army) counts.set(u.t.id, (counts.get(u.t.id) ?? 0) + 1 / u.t.squad)
    const options = [...counts.entries()]
      .filter(([, n]) => n >= 2)
      .flatMap(([id]) => techsFor(id))
      .concat(techsFor(unitOf(p.faction, 'station').id))
      .filter((t) => !cantResearch(w, o, t.id))
    if (options.length) {
      const pick = options[Math.floor(rand(w) * options.length)].id
      act(b, () => cmdResearch(w, o, pick), true)
    }
  }

  // Repair craft are a cheap unlock, worth having once there are warships (or a battered station) to
  // mend. Harder admirals get round to it sooner.
  const mender = buildable(p.faction).find((t) => t.kind === 'repair' && t.tech)
  if (mender && D.menders && !upgradeDue && p.research.length === 0 && p.credits > 600 && !cantResearch(w, o, mender.tech!)) {
    const due = army.some((u) => u.t.tier === 'frigate' || u.t.tier === 'cruiser' || u.t.tier === 'capital') || st.hull < st.hullMax * 0.8
    if (due && rand(w) < D.menders) act(b, () => cmdResearch(w, o, mender.tech!), true)
  }

  // Keep two orders in the yard, saving up for the one we picked rather than buying whatever's cheap.
  if (p.queue.length < (savingForMine ? 1 : 2) && !upgradeDue && !(savingForMine && p.credits < 500)) {
    if (b.want && cantBuild(w, o, b.want) && cantBuild(w, o, b.want) !== 'Not enough credits') b.want = null
    b.want ??= pickShip(w, b)
    const want = b.want
    if (want && act(b, () => cmdBuild(w, o, want), true)) b.want = null
  }

  // Abilities, when they'd help.
  for (const u of army) {
    if (!D.abilities || !u.t.ability || u.abilityCd > 0 || u.t.ability === 'fieldRepair') continue
    const foes = visibleEnemies(w, o, u.x, u.y, ABILITIES[u.t.ability].range ?? rangeDist(650))
    if (!foes.length) continue
    const ok =
      // A nebula would drain a boost straight away.
      u.t.ability === 'shieldBoost' ? u.shield < shieldMax(u) * 0.4 && !u.nebula : u.t.ability === 'repairSwarm' ? u.hull < u.hullMax * 0.65 : u.t.ability === 'flakBarrage' ? foes.some((f) => f.t.tier === 'fighter') : true
    if (ok) act(b, () => cmdAbility(w, o, [u.id]))
  }

  mend(w, b, army, st)

  // Defend: anything hitting our station or mines gets the whole home fleet, once it has noticed
  // (ships already heading there to fight need no new order).
  const assets = w.units.filter((u) => u.owner === o && (u.t.tier === 'station' || u.t.tier === 'mine' || u.t.tier === 'defense'))
  let threat: Unit | undefined
  for (const a of assets) {
    const foes = visibleEnemies(w, o, a.x, a.y, rangeDist(1000))
    if (foes.length) {
      threat = foes[0]
      break
    }
  }
  if (!threat) b.alarm = -1
  else if (b.alarm < 0) b.alarm = w.time
  if (threat && !b.attacking && w.time - b.alarm >= D.react) {
    const at = threat
    const home = army.filter((u) => u.t.kind !== 'repair' && d2(u, st) < sq(mapDist(2200)) && u.order.k !== 'attack' && !(u.order.k === 'move' && u.order.attack && d2(u.order, at) < sq(500)))
    if (home.length) act(b, () => cmdMove(w, o, home.map((u) => u.id), at.x, at.y, true))
    return
  }

  // Scouts: a couple of fast ships keep the beacons ours.
  b.scouts = new Set([...b.scouts].filter((id) => w.byId.get(id)))
  if (!b.attacking && b.scouts.size < 2) {
    const spare = army.find((u) => (u.t.tier === 'gunship' || u.t.tier === 'frigate') && !b.scouts.has(u.id))
    if (spare) b.scouts.add(spare.id)
  }
  // Early on, before there are spare warships, the starting fighters do the surveying.
  if (!b.attacking && b.scouts.size < 2 && w.time < 240) {
    const f = army.find((u) => u.t.tier === 'fighter' && u.t.kind !== 'repair' && !b.scouts.has(u.id))
    if (f) for (const id of army.filter((u) => u.squad && u.squad === f.squad).map((u) => u.id)) b.scouts.add(id)
  }
  // They pick beacons they can hold, and come home from fights they'd lose.
  const scouts = [...b.scouts].map((id) => w.byId.get(id)!)
  const scoutValue = value(scouts)
  // Unsurveyed ore on our half comes first, then beacons.
  // While calm, only neutral ones: nothing the player already holds.
  const calm = w.time < D.calm
  // Ore nearer to us than to any enemy station, so allies don't race each other for it.
  const ore = w.nodes.filter((n) => !n.site && n.owner !== team && (!calm || n.owner === -1) && mineToTake(n))
  // Wrecks on our side of the map are free credits for a parked scout.
  const hulks = w.wrecks.filter((h) => h.left > 200 && h.team !== team && mineToTake(h))
  const wanted = [...ore, ...hulks, ...w.beacons.filter((bc) => bc.owner !== team && (!calm || bc.owner === -1))]
    .filter((g) => threatAt(w, o, g.x, g.y) < scoutValue * 0.9)
    .sort((a, c) => d2(a, st) - d2(c, st))
  for (const s of scouts) {
    if (threatAt(w, o, s.x, s.y, rangeDist(700)) > scoutValue * 1.3 && d2(s, st) > sq(mapDist(1500))) {
      if (!(s.order.k === 'move' && d2(s.order, p.rally) < sq(300))) act(b, () => cmdMove(w, o, [s.id], p.rally.x, p.rally.y))
      continue
    }
    // Each scout (or squadron) takes a different goal.
    const slot = [...new Set(scouts.map((x) => x.squad || x.id))].indexOf(s.squad || s.id)
    const goal = wanted[slot % Math.max(1, wanted.length)]
    if (goal && s.order.k === 'idle') {
      const x = goal.x + (rand(w) - 0.5) * 160
      const y = goal.y + (rand(w) - 0.5) * 160
      act(b, () => cmdMove(w, o, [s.id], x, y, !calm))
    }
  }

  // Attack waves.
  // Repair craft keep to their own work (see mend), out of the waves.
  const main = army.filter((u) => !b.scouts.has(u.id) && u.t.kind !== 'repair')
  const mainValue = value(main)
  // Waves go out once the fleet is big enough, or the yard is full, or (so poor maps don't stall)
  // after four quiet minutes with at least half a wave ready.
  const restless = w.time - Math.max(b.lastWave, D.calm) > 240 && mainValue >= b.wave * 0.5
  // An ally already pushing into enemy space: go with them rather than one wave at a time.
  const pushing: Unit[] = []
  for (const u of w.units) {
    if (u.dead || u.owner === o || foes(w, u.owner, o) || !isShip(u.t) || u.order.k !== 'move' || !u.order.attack) continue
    const home = w.byId.get(w.players[u.owner].station)
    if (home && d2(u, home) > sq(mapDist(2200))) pushing.push(u)
  }
  const push = value(pushing) > 1200 ? { x: pushing.reduce((s, u) => s + u.x, 0) / pushing.length, y: pushing.reduce((s, u) => s + u.y, 0) / pushing.length } : null
  const joinAlly = !!push && mainValue >= b.wave * 0.3
  if (!b.attacking && !calm && (mainValue >= b.wave || p.pop >= p.popCap - 2 || restless || joinAlly)) {
    b.attacking = true
    b.lastWave = w.time
    b.peak = mainValue
  }
  const cxm = main.reduce((s, u) => s + u.x, 0) / Math.max(1, main.length)
  const cym = main.reduce((s, u) => s + u.y, 0) / Math.max(1, main.length)
  const outgunned = threatAt(w, o, cxm, cym, rangeDist(1100)) > mainValue * 1.5 && d2({ x: cxm, y: cym }, st) > sq(mapDist(1800))
  if (b.attacking && (mainValue < b.peak * 0.35 || outgunned)) {
    b.attacking = false
    b.wave = Math.min(9000, b.wave * 1.15)
    act(b, () => cmdMove(w, o, main.map((u) => u.id), p.rally.x, p.rally.y))
    return
  }
  if (!b.attacking) {
    const loose = main.filter((u) => u.order.k === 'idle' && d2(u, p.rally) > sq(700))
    if (loose.length) act(b, () => cmdMove(w, o, loose.map((u) => u.id), p.rally.x, p.rally.y), true)
    return
  }
  // Pick a goal: enemy mines nearest our fleet (or the ally we're backing up), then beacons, then the station.
  const c = push ?? { x: cxm, y: cym }
  const targets = [
    ...w.units.filter((u) => foes(w, u.owner, o) && (u.t.tier === 'mine' || u.t.tier === 'defense') && sees(w, o, u)),
    ...w.beacons.filter((bc) => bc.owner !== -1 && bc.owner !== team),
  ].sort((a, z) => d2(a, c) - d2(z, c))
  const goal = targets[0] ?? enemySt
  if (!goal) return
  // The ships not yet on their way there go together, as one order.
  const go: number[] = []
  for (const u of main) {
    if (u.order.k === 'attack') continue
    // Heavy ships aim for shield generators, then turrets.
    if (D.focus && u.target && (u.t.tier === 'cruiser' || u.t.tier === 'capital' || u.t.tier === 'frigate')) {
      const e = w.byId.get(u.target)
      // Only aim at hardpoints of a ship we can actually see right now.
      if (e && e.hps.length && sees(w, o, e)) {
        const gen = e.t.hardpoints.findIndex((h, i) => h.kind === 'shield' && e.hps[i].hp > 0)
        const gun = e.t.hardpoints.findIndex((h, i) => h.kind === 'turret' && e.hps[i].hp > 0)
        const hp = gen >= 0 ? gen : gun
        if (hp >= 0 && act(b, () => cmdAttack(w, o, [u.id], e.id, hp))) continue
      }
    }
    if (u.order.k === 'idle' || (u.order.k === 'move' && d2(u.order, goal) > sq(400))) go.push(u.id)
  }
  if (go.length) {
    const x = goal.x + (rand(w) - 0.5) * 300
    const y = goal.y + (rand(w) - 0.5) * 300
    act(b, () => cmdMove(w, o, go, x, y, true))
  }
}

/** The ship or station of ours most worth a Field repair near (x, y): the most damaged, weighted by
 * what it's worth, so a battered flagship or station comes before a scratched gunship. */
function patient(w: World, o: Owner, x: number, y: number, r: number): Unit | undefined {
  let best: Unit | undefined
  let score = 0
  for (const t of w.units) {
    if (t.dead || cantMend(w, o, t) || d2(t, { x, y }) > sq(r)) continue
    const need = 1 - t.hull / t.hullMax
    if (need < 0.15) continue
    const s = need * Math.sqrt(t.t.cost || 3000)
    if (s > score) {
      score = s
      best = t
    }
  }
  return best
}

/**
 * Repair craft: each squadron with its ability ready goes to the ship or station that needs it most
 * (Admirals that use abilities only; the sim's idle crews still help themselves). Between runs a
 * squadron guards the fleet's most valuable warship, or the station, so it's at hand when that one
 * gets hurt.
 */
function mend(w: World, b: Brain, army: Unit[], st: Unit) {
  const o = b.o
  const D = DIFFICULTY[b.diff]
  const ward = army.filter((u) => u.t.tier === 'frigate' || u.t.tier === 'cruiser' || u.t.tier === 'capital').sort((a, c) => c.t.cost - a.t.cost || a.id - c.id)[0] ?? st
  const squads = new Map<number, Unit[]>()
  for (const u of army) if (u.t.kind === 'repair') squads.set(u.squad || -u.id, [...(squads.get(u.squad || -u.id) ?? []), u])
  for (const crew of squads.values()) {
    const lead = crew[0]
    if (lead.aid) continue
    const ids = crew.map((u) => u.id)
    const sick = D.abilities && lead.abilityCd <= 0 ? patient(w, o, lead.x, lead.y, ABILITIES.fieldRepair.range!) : undefined
    if (sick) {
      act(b, () => cmdAbility(w, o, ids, sick.id) || 'nothing to mend')
      continue
    }
    if (!(lead.order.k === 'guard' && lead.order.id === ward.id)) act(b, () => cmdGuard(w, o, ids, ward.id), true)
  }
}

/** The defense platform to build against what the enemy has been flying: flak against a swarm
 * of strike craft, heavy guns against warships, else the balanced one. */
function defenseFor(w: World, o: Owner): string {
  const p = w.players[o]
  let small = 0
  let big = 0
  for (const u of w.units) {
    if (u.dead || !foes(w, u.owner, o) || !sees(w, o, u) || !isShip(u.t)) continue
    if (u.t.tier === 'fighter' || u.t.tier === 'gunship') small += u.t.pop / u.t.squad
    else big += u.t.pop
  }
  const id = small > big * 1.6 ? 'defense-flak' : big > small * 1.6 ? 'defense-gun' : 'defense'
  return `${p.faction === 'republic' ? 'r' : 'd'}-${id}`
}

// --- Fleet battles ---------------------------------------------------------------------------------

/**
 * The admiral in a galactic conquest fleet battle: no economy, only the fleet. It keeps the field
 * topped up from the ships waiting in orbit, sends idle ships at the nearest enemy (the side holding
 * the planet waits by its station until the attackers come close), fires abilities, and an attacker
 * that is clearly losing pulls its fleet out rather than lose it all.
 */
export function fleetThink(w: World, b: Brain, dt: number) {
  rest(b, dt)
  b.t -= dt
  const f = w.fleet
  if (!f || b.t > 0 || w.winner !== -1) return
  const D = DIFFICULTY[b.diff]
  b.t = Math.min(1.5, D.think) * (0.8 + rand(w) * 0.4)
  const o = b.o
  const p = w.players[o]
  const mine = fleet(w, o).filter((u) => !u.parent && u.retreat <= 0)
  const st = w.byId.get(p.station)
  const holder = !!st && !st.dead
  const entry = f.entry[o]
  const mid = { x: w.w / 2, y: w.h / 2 }

  // Reinforcements: keep the field at the battle's fleet size.
  let onField = mine.reduce((s, u) => s + u.t.pop / u.t.squad, 0) + w.arrivals.filter((a) => a.owner === o).reduce((s, a) => s + UNIT[a.unit].pop, 0)
  for (const id of [...p.reserve].sort((a, c) => UNIT[c].pop - UNIT[a].pop)) {
    if (onField + UNIT[id].pop > f.cap && onField > 0) continue
    const toMid = M.atan2(mid.y - entry.y, mid.x - entry.x)
    for (let i = 0; i < 12; i++) {
      const a = toMid + (rand(w) - 0.5) * 1.8
      const d = 200 + rand(w) * (entry.r - 350)
      const x = entry.x + M.cos(a) * d
      const y = entry.y + M.sin(a) * d
      if (act(b, () => cmdDeploy(w, o, id, x, y, toMid))) {
        onField += UNIT[id].pop
        break
      }
      if (b.hands < 1) break
    }
  }

  // The enemy, as far as we can see; or where they came in, if we can't see any.
  const foesSeen = w.units.filter((u) => !u.dead && foes(w, u.owner, o) && sees(w, o, u) && u.retreat <= 0)
  const theirValue = value(foesSeen.filter((u) => isShip(u.t))) + w.players.filter((_, i) => foes(w, i, o)).reduce((s, q) => s + q.reserve.reduce((v, id) => v + UNIT[id].cost, 0), 0)
  const ourValue = value(mine) + p.reserve.reduce((v, id) => v + UNIT[id].cost, 0)
  // A beaten attacker jumps out: whatever escapes goes back to its fleet.
  if (!holder && b.diff !== 'veryEasy' && w.time > 30 && ourValue < theirValue * 0.3) {
    const out = mine.filter(canRetreat)
    if (out.length) act(b, () => cmdRetreat(w, o, out.map((u) => u.id)))
    p.reserve.length = 0
    return
  }
  const nearest = (u: Unit) => foesSeen.reduce<Unit | null>((best, e) => (!best || d2(e, u) < d2(best, u) ? e : best), null)
  const enemyEntry = f.entry.find((_, i) => foes(w, i, o)) ?? mid
  // Idle ships go at the enemy nearest them: those after the same one go together, as one order.
  const groups = new Map<Unit | null, number[]>()
  for (const u of mine) {
    const busy = u.order.k !== 'idle' || u.target
    if (D.abilities && u.t.ability === 'fieldRepair' && u.abilityCd <= 0 && !u.aid) {
      const sick = patient(w, o, u.x, u.y, ABILITIES.fieldRepair.range!)
      if (sick) act(b, () => cmdAbility(w, o, [u.id], sick.id))
    } else if (D.abilities && u.t.ability && u.abilityCd <= 0 && threatAt(w, o, u.x, u.y, rangeDist(700)) > 0) act(b, () => cmdAbility(w, o, [u.id]))
    if (busy) continue
    const e = nearest(u)
    // The holder keeps the line by the station until they come within reach of it.
    if (holder && !(e && d2(e, st!) < sq(mapDist(2600)))) continue
    groups.set(e, [...(groups.get(e) ?? []), u.id])
  }
  for (const [e, ids] of groups) {
    const to = e ?? enemyEntry
    if (!act(b, () => cmdMove(w, o, ids, to.x, to.y, true))) break
  }
}
