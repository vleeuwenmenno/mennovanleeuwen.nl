import { ABILITIES, MAX_LEVEL, UPGRADES, buildable, isShip, type Tier } from './data'
import { cantBuild, cmdAbility, cmdAttack, cmdBuild, cmdMine, cmdMove, cmdRally, cmdUpgrade, fleet, near, other, shieldMax, type Owner, type Unit, type World } from './sim'

// The enemy admiral. Every second or two it looks at the battle and decides: claim ore, upgrade
// the station, queue ships that counter what it has seen, defend what's under attack, grab
// beacons, and once the fleet is big enough, go after the player's mines and station. The
// headless sims run one on each side.

export type Difficulty = 'easy' | 'normal' | 'hard'

export const DIFFICULTY: Record<Difficulty, { name: string; blurb: string; income: number; think: number; wave: number; mines: number; focus: boolean }> = {
  easy: { name: 'Cadet', blurb: 'Slow to react, attacks late, ignores hardpoints.', income: 0.8, think: 2.6, wave: 3200, mines: 3, focus: false },
  normal: { name: 'Commander', blurb: 'A fair fight.', income: 1, think: 1.5, wave: 2500, mines: 4, focus: true },
  hard: { name: 'Admiral', blurb: 'Quick, greedy and it goes for your shield generators.', income: 1.25, think: 0.8, wave: 2000, mines: 5, focus: true },
}

export type Brain = { o: Owner; diff: Difficulty; t: number; wave: number; attacking: boolean; peak: number; scouts: Set<number>; want: string | null }

export const newBrain = (o: Owner, diff: Difficulty): Brain => ({ o, diff, t: 2, wave: DIFFICULTY[diff].wave, attacking: false, peak: 0, scouts: new Set(), want: null })

const value = (us: Unit[]) => us.reduce((s, u) => s + (u.t.cost / u.t.squad) * (0.3 + 0.7 * (u.hull / u.hullMax)), 0)
const d2 = (a: { x: number; y: number }, b: { x: number; y: number }) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2

function visibleEnemies(w: World, o: Owner, x: number, y: number, r: number) {
  const out: Unit[] = []
  near(w, x, y, r, (u) => {
    if (u.owner !== o && u.seen[o] && isShip(u.t)) out.push(u)
  })
  return out
}

/** What to save up for next: weighted towards ships that counter what we've seen. */
/** What the enemy has (that we can see) around a spot. */
const threatAt = (w: World, o: Owner, x: number, y: number, r = 900) => value(visibleEnemies(w, o, x, y, r))

function pickShip(w: World, b: Brain): string | null {
  const p = w.players[b.o]
  const seen = w.units.filter((u) => u.owner !== b.o && u.seen[b.o] && isShip(u.t))
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
  const enemySt = w.byId.get(w.players[other(o)].station)
  const toward = enemySt ? Math.sign(enemySt.x - st.x) || 1 : 1
  cmdRally(w, o, st.x + toward * 520, st.y)

  // Ore first: the nearest free asteroids on our half and in the middle.
  const mines = w.units.filter((u) => u.owner === o && u.t.tier === 'mine').length
  if (mines < D.mines && p.credits >= 500 + (p.queue.length ? 0 : 150)) {
    const free = w.nodes
      .filter((n) => !n.mine && (!enemySt || d2(n, st) < d2(n, enemySt) * 1.05))
      .sort((a, c) => d2(a, st) - d2(c, st))
    if (free[0]) cmdMine(w, o, free[0].id)
  }

  const army = fleet(w, o).filter((u) => !u.parent)
  const armyValue = value(army)

  // Station upgrades once there's a fleet to protect the investment: save for them first.
  const next = UPGRADES[p.level + 1]
  const upgradeDue = p.level < MAX_LEVEL && !p.upgrade && !!next && armyValue >= p.level * 700 && w.time > p.level * 140
  if (upgradeDue && p.credits >= next!.cost) cmdUpgrade(w, o)

  // Keep two orders in the yard, saving up for the one we picked rather than buying whatever's cheap.
  if (p.queue.length < 2 && !upgradeDue) {
    if (b.want && cantBuild(w, o, b.want) && cantBuild(w, o, b.want) !== 'Not enough credits') b.want = null
    b.want ??= pickShip(w, b)
    if (b.want && !cmdBuild(w, o, b.want)) b.want = null
  }

  // Abilities, when they'd help.
  for (const u of army) {
    if (!u.t.ability || u.abilityCd > 0) continue
    const foes = visibleEnemies(w, o, u.x, u.y, ABILITIES[u.t.ability].range ?? 650)
    if (!foes.length) continue
    const ok =
      u.t.ability === 'shieldBoost' ? u.shield < shieldMax(u) * 0.4 : u.t.ability === 'repairSwarm' ? u.hull < u.hullMax * 0.65 : u.t.ability === 'flakBarrage' ? foes.some((f) => f.t.tier === 'fighter') : true
    if (ok) cmdAbility(w, o, [u.id])
  }

  // Defend: anything hitting our station or mines gets the whole home fleet.
  const assets = w.units.filter((u) => u.owner === o && (u.t.tier === 'station' || u.t.tier === 'mine'))
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
  // They pick beacons they can hold, and come home from fights they'd lose.
  const scouts = [...b.scouts].map((id) => w.byId.get(id)!)
  const scoutValue = value(scouts)
  const wanted = w.beacons.filter((bc) => bc.owner !== o && threatAt(w, o, bc.x, bc.y) < scoutValue * 0.9).sort((a, c) => d2(a, st) - d2(c, st))
  for (const s of scouts) {
    if (threatAt(w, o, s.x, s.y, 700) > scoutValue * 1.3 && d2(s, st) > 1500 ** 2) {
      cmdMove(w, o, [s.id], p.rally.x, p.rally.y)
      continue
    }
    const goal = wanted[0]
    if (goal && s.order.k === 'idle') cmdMove(w, o, [s.id], goal.x + (Math.random() - 0.5) * 200, goal.y + (Math.random() - 0.5) * 200, true)
  }

  // Attack waves.
  const main = army.filter((u) => !b.scouts.has(u.id))
  const mainValue = value(main)
  if (!b.attacking && (mainValue >= b.wave || p.pop >= p.popCap - 2)) {
    b.attacking = true
    b.peak = mainValue
  }
  const cxm = main.reduce((s, u) => s + u.x, 0) / Math.max(1, main.length)
  const cym = main.reduce((s, u) => s + u.y, 0) / Math.max(1, main.length)
  const outgunned = threatAt(w, o, cxm, cym, 1100) > mainValue * 1.5 && d2({ x: cxm, y: cym }, st) > 1800 ** 2
  if (b.attacking && (mainValue < b.peak * 0.35 || outgunned)) {
    b.attacking = false
    b.wave = Math.min(14000, b.wave * 1.3)
    cmdMove(w, o, main.map((u) => u.id), p.rally.x, p.rally.y)
    return
  }
  if (!b.attacking) {
    const loose = main.filter((u) => u.order.k === 'idle' && d2(u, p.rally) > 700 ** 2)
    if (loose.length) cmdMove(w, o, loose.map((u) => u.id), p.rally.x, p.rally.y)
    return
  }
  // Pick a goal: enemy mines nearest our fleet, then beacons, then the station.
  const c = { x: cxm, y: cym }
  const targets = [
    ...w.units.filter((u) => u.owner !== o && u.t.tier === 'mine' && u.seen[o]),
    ...w.beacons.filter((bc) => bc.owner === other(o)),
  ].sort((a, z) => d2(a, c) - d2(z, c))
  const goal = targets[0] ?? enemySt
  if (!goal) return
  for (const u of main) {
    if (u.order.k === 'attack') continue
    // Heavy ships aim for shield generators, then turrets.
    if (D.focus && u.target && (u.t.tier === 'cruiser' || u.t.tier === 'capital' || u.t.tier === 'frigate')) {
      const e = w.byId.get(u.target)
      if (e && e.hps.length) {
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
