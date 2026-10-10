import { ABILITIES, LEVEL_UP, MAX_LEVEL, UPGRADES, buildable, isShip, techsFor, unitOf, type Tier } from './data'
import { inside } from './maps'
import { cantBuild, cantResearch, cmdAbility, cmdAttack, cmdBuild, cmdMove, cmdRally, cmdResearch, cmdSite, fleet, foes, near, sees, shieldMax, type Owner, type Unit, type World } from './sim'

// The enemy admiral. Every second or two it looks at the battle and decides: claim ore, upgrade
// the station, queue ships that counter what it has seen, defend what's under attack, grab
// beacons, and once the fleet is big enough, go after the player's mines and station. The
// headless sims run one on each side.

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
}

export const DIFFICULTY: Record<Difficulty, Level> = {
  veryEasy: {
    name: 'Very easy', blurb: 'A sleepy recruit: earns little, never researches, and leaves you alone for the first ten minutes.',
    income: 0.55, think: 3.5, wave: 5000, mines: 2, focus: false, calm: 600, research: false, abilities: false, defenses: false,
  },
  easy: {
    name: 'Easy', blurb: 'Slow to react and slow to grow. No attacks for the first six minutes.',
    income: 0.68, think: 3, wave: 4200, mines: 3, focus: false, calm: 360, research: true, abilities: false, defenses: false,
  },
  medium: {
    name: 'Medium', blurb: 'A fair fight. It leaves you about two and a half minutes to settle in.',
    income: 1, think: 1.5, wave: 2500, mines: 4, focus: true, calm: 150, research: true, abilities: true, defenses: true,
  },
  hard: {
    name: 'Hard', blurb: 'Quick, greedy, aggressive from the start, and it goes for your shield generators.',
    income: 1.25, think: 0.8, wave: 2000, mines: 5, focus: true, calm: 0, research: true, abilities: true, defenses: true,
  },
}

export type Brain = { o: Owner; diff: Difficulty; t: number; wave: number; attacking: boolean; peak: number; scouts: Set<number>; want: string | null; lastWave: number }

export const newBrain = (o: Owner, diff: Difficulty): Brain => ({ o, diff, t: 2, wave: DIFFICULTY[diff].wave, attacking: false, peak: 0, scouts: new Set(), want: null, lastWave: 0 })

const value = (us: Unit[]) => us.reduce((s, u) => s + (u.t.cost / u.t.squad) * (0.3 + 0.7 * (u.hull / u.hullMax)), 0)
const d2 = (a: { x: number; y: number }, b: { x: number; y: number }) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2

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
  const a0 = Math.atan2(y - st.y, x - st.x)
  const d0 = Math.hypot(x - st.x, y - st.y)
  for (const d of [d0, d0 * 0.7, d0 * 1.4])
    for (const da of [0.35, -0.35, 0.7, -0.7, 1.05, -1.05, 1.4, -1.4]) {
      const px = Math.min(w.w - 80, Math.max(80, st.x + Math.cos(a0 + da) * d))
      const py = Math.min(w.h - 80, Math.max(80, st.y + Math.sin(a0 + da) * d))
      if (!bad(px, py)) return { x: px, y: py }
    }
  return { x, y }
}

/** What the enemy has (that we can see) around a spot. */
const threatAt = (w: World, o: Owner, x: number, y: number, r = 900) => value(visibleEnemies(w, o, x, y, r))

/** What to save up for next: weighted towards ships that counter what we've seen. */
function pickShip(w: World, b: Brain): string | null {
  const p = w.players[b.o]
  const seen = w.units.filter((u) => foes(w, u.owner, b.o) && sees(w, b.o, u) && isShip(u.t))
  const small = seen.filter((u) => u.t.tier === 'fighter' || u.t.tier === 'gunship').length
  const big = seen.length - small
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
  const total = options.reduce((s, t) => s + (weights[t.tier] ?? 1), 0)
  let r = Math.random() * total
  for (const t of options) {
    r -= weights[t.tier] ?? 1
    if (r <= 0) return t.id
  }
  return options[options.length - 1].id
}

export function think(w: World, b: Brain, dt: number) {
  b.t -= dt
  if (b.t > 0 || w.winner !== -1) return
  const D = DIFFICULTY[b.diff]
  b.t = D.think * (0.8 + Math.random() * 0.4)
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
  const ad = Math.hypot(aim.x - st.x, aim.y - st.y) || 1
  const rally = clearSpot(w, st, st.x + ((aim.x - st.x) / ad) * 560, st.y + ((aim.y - st.y) / ad) * 560)
  cmdRally(w, o, rally.x, rally.y)

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
    if (mines < D.mines && p.credits >= 500) cmdSite(w, o, ours[0].id, 'mine')
    else if (D.defenses && mines >= Math.min(3, D.mines) && p.credits >= 650 + 600) cmdSite(w, o, ours[0].id, 'defense')
  }

  const army = fleet(w, o).filter((u) => !u.parent)
  const armyValue = value(army)

  // Station upgrades once there's a fleet to protect the investment: save for them first.
  const next = UPGRADES[p.level + 1]
  const leveling = p.research.some((r) => r.id === LEVEL_UP)
  const upgradeDue = p.level < MAX_LEVEL && !leveling && !!next && armyValue >= p.level * 700 && w.time > p.level * 140
  if (upgradeDue && p.credits >= next!.cost) cmdResearch(w, o, LEVEL_UP)

  // Research for what we fly most, once the yard is busy and there's money to spare.
  if (D.research && !upgradeDue && p.queue.length >= 2 && p.research.length === 0 && p.credits > (b.diff === 'hard' ? 600 : 1000)) {
    const counts = new Map<string, number>()
    for (const u of army) counts.set(u.t.id, (counts.get(u.t.id) ?? 0) + 1 / u.t.squad)
    const options = [...counts.entries()]
      .filter(([, n]) => n >= 2)
      .flatMap(([id]) => techsFor(id))
      .concat(techsFor(unitOf(p.faction, 'station').id))
      .filter((t) => !cantResearch(w, o, t.id))
    if (options.length) cmdResearch(w, o, options[Math.floor(Math.random() * options.length)].id)
  }

  // Keep two orders in the yard, saving up for the one we picked rather than buying whatever's cheap.
  if (p.queue.length < (savingForMine ? 1 : 2) && !upgradeDue && !(savingForMine && p.credits < 500)) {
    if (b.want && cantBuild(w, o, b.want) && cantBuild(w, o, b.want) !== 'Not enough credits') b.want = null
    b.want ??= pickShip(w, b)
    if (b.want && !cmdBuild(w, o, b.want)) b.want = null
  }

  // Abilities, when they'd help.
  for (const u of army) {
    if (!D.abilities || !u.t.ability || u.abilityCd > 0) continue
    const foes = visibleEnemies(w, o, u.x, u.y, ABILITIES[u.t.ability].range ?? 650)
    if (!foes.length) continue
    const ok =
      // A nebula would drain a boost straight away.
      u.t.ability === 'shieldBoost' ? u.shield < shieldMax(u) * 0.4 && !u.nebula : u.t.ability === 'repairSwarm' ? u.hull < u.hullMax * 0.65 : u.t.ability === 'flakBarrage' ? foes.some((f) => f.t.tier === 'fighter') : true
    if (ok) cmdAbility(w, o, [u.id])
  }

  // Defend: anything hitting our station or mines gets the whole home fleet.
  const assets = w.units.filter((u) => u.owner === o && (u.t.tier === 'station' || u.t.tier === 'mine' || u.t.tier === 'defense'))
  let threat: Unit | undefined
  for (const a of assets) {
    const foes = visibleEnemies(w, o, a.x, a.y, 1000)
    if (foes.length) {
      threat = foes[0]
      break
    }
  }
  if (threat && !b.attacking) {
    const home = army.filter((u) => d2(u, st) < 2200 ** 2)
    cmdMove(w, o, home.filter((u) => u.order.k !== 'attack').map((u) => u.id), threat.x, threat.y, true)
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
    const f = army.find((u) => u.t.tier === 'fighter' && !b.scouts.has(u.id))
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
    if (threatAt(w, o, s.x, s.y, 700) > scoutValue * 1.3 && d2(s, st) > 1500 ** 2) {
      cmdMove(w, o, [s.id], p.rally.x, p.rally.y)
      continue
    }
    // Each scout (or squadron) takes a different goal.
    const slot = [...new Set(scouts.map((x) => x.squad || x.id))].indexOf(s.squad || s.id)
    const goal = wanted[slot % Math.max(1, wanted.length)]
    if (goal && s.order.k === 'idle') cmdMove(w, o, [s.id], goal.x + (Math.random() - 0.5) * 160, goal.y + (Math.random() - 0.5) * 160, !calm)
  }

  // Attack waves.
  const main = army.filter((u) => !b.scouts.has(u.id))
  const mainValue = value(main)
  // Waves go out once the fleet is big enough, or the yard is full, or (so poor maps don't stall)
  // after four quiet minutes with at least half a wave ready.
  const restless = w.time - Math.max(b.lastWave, D.calm) > 240 && mainValue >= b.wave * 0.5
  // An ally already pushing into enemy space: go with them rather than one wave at a time.
  const pushing: Unit[] = []
  for (const u of w.units) {
    if (u.dead || u.owner === o || foes(w, u.owner, o) || !isShip(u.t) || u.order.k !== 'move' || !u.order.attack) continue
    const home = w.byId.get(w.players[u.owner].station)
    if (home && d2(u, home) > 2200 ** 2) pushing.push(u)
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
  const outgunned = threatAt(w, o, cxm, cym, 1100) > mainValue * 1.5 && d2({ x: cxm, y: cym }, st) > 1800 ** 2
  if (b.attacking && (mainValue < b.peak * 0.35 || outgunned)) {
    b.attacking = false
    b.wave = Math.min(9000, b.wave * 1.15)
    cmdMove(w, o, main.map((u) => u.id), p.rally.x, p.rally.y)
    return
  }
  if (!b.attacking) {
    const loose = main.filter((u) => u.order.k === 'idle' && d2(u, p.rally) > 700 ** 2)
    if (loose.length) cmdMove(w, o, loose.map((u) => u.id), p.rally.x, p.rally.y)
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
        if (hp >= 0) {
          cmdAttack(w, o, [u.id], e.id, hp)
          continue
        }
      }
    }
    if (u.order.k === 'idle' || (u.order.k === 'move' && d2(u.order, goal) > 400 ** 2)) cmdMove(w, o, [u.id], goal.x + (Math.random() - 0.5) * 300, goal.y + (Math.random() - 0.5) * 300, true)
  }
}
