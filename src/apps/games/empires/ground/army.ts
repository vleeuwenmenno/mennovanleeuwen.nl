import type { Brain } from '../ai.ts'
import { UNIT } from '../data.ts'
import { cantBuild, cmdAttack, cmdBuild, cmdMove, rand, type Unit, type World } from '../sim.ts'
import { TILE, type Pt } from './types.ts'
import { knownBuildings } from './world.ts'

// The AI's fighters in a ground battle (a part of ground/think.ts's decisions): it trains a few
// Scouts once its economy is going, sends one off to scout (the enemy's start first, then the map's
// spawns and crystal fields), turns them all on anything that comes near its buildings, and with the
// rest goes after the enemy engineers it sees and the enemy buildings it knows of, unarmed ones first.
// Only what its team knows, the world's random stream, the same orders a player gives.

/** Scouts it keeps (more once it is rich), and the engineers it has before it trains any. */
const SCOUTS = 3
const SCOUTS_RICH = 6
const RICH = 700
const SCOUTS_AFTER = 4
/** Kyber it keeps back from Scouts, for an engineer should it lose them all. */
const RESERVE = 200
/** How near its buildings (tiles) an enemy counts as an attack on them. */
const DEFEND = 12
/** Scouts it raids with at once; with this many it takes on armed buildings too. */
const RAID = 2
const STORM = 4

const d2 = (a: Pt, b: Pt) => (a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y)

/** Its fighters' turn: training, scouting, defending, raiding. `mine`: its units. */
export function armyThink(w: World, b: Brain, mine: Unit[]) {
  if (b.peaceful) return
  const o = b.o
  const p = w.players[o]
  const team = p.team
  const scoutId = Object.values(UNIT).find((t) => t.faction === p.faction && t.ground && t.tier === 'vehicle' && t.role?.role === 'Scout')?.id
  if (!scoutId) return
  const scouts = mine.filter((u) => u.t.id === scoutId)
  const engineers = mine.filter((u) => !!u.t.ground?.builds?.length)
  const buildings = mine.filter((u) => !!u.foot)
  const centers = buildings.filter((u) => !u.site && !!u.t.ground?.trains?.includes(scoutId))

  // 1. A few Scouts once there are engineers enough, one at a time.
  const queued = centers.reduce((n, c) => n + (c.yq ?? []).filter((q) => q.unit === scoutId).length, 0)
  const keep = p.credits >= RICH ? SCOUTS_RICH : SCOUTS
  if (engineers.length >= SCOUTS_AFTER && scouts.length + queued < keep && !queued && p.credits >= UNIT[scoutId].cost + RESERVE) {
    const at = centers.find((c) => !cantBuild(w, o, scoutId, false, c.id))
    if (at) cmdBuild(w, o, scoutId, false, at.id)
  }
  if (!scouts.length) return

  // 2. Defence: every Scout on the enemy nearest our buildings or engineers, when one comes near.
  let threat: Unit | undefined
  let td = Infinity
  const guarded = [...buildings, ...engineers]
  for (const e of w.units) {
    if (e.dead || !e.t.ground || w.players[e.owner].team === team || !e.seen[team] || e.foot) continue
    for (const s of guarded) {
      const d = d2(e, s)
      if (d < (DEFEND * TILE) ** 2 && d < td) {
        td = d
        threat = e
      }
    }
  }
  if (threat) {
    const free = scouts.filter((u) => !(u.order.k === 'attack' && u.order.id === threat!.id))
    if (free.length) cmdAttack(w, o, free.map((u) => u.id), threat.id)
    return
  }

  // 3. Scouting: the first Scout goes round the map, the enemy's start first.
  const scout = scouts.find((u) => u.id === b.gScout) ?? scouts[0]
  b.gScout = scout.id
  if (scout.order.k === 'idle') {
    const g = w.ground!.map
    const spots: Pt[] = [...g.spawns.filter((_, i) => w.players.findIndex((q) => q.spawn === i && q.team !== team) >= 0), ...g.spawns, ...g.deposits]
    const first = (b.gScouted ?? 0) === 0 ? spots[0] : spots[Math.floor(rand(w) * spots.length)]
    b.gScouted = (b.gScouted ?? 0) + 1
    if (first) cmdMove(w, o, [scout.id], first.x, first.y, true)
  }

  // 4. Raids: the rest after enemy engineers we see, else the enemy buildings we know of.
  const raiders = scouts.filter((u) => u !== scout && u.order.k === 'idle')
  if (raiders.length < RAID) return
  const home = buildings[0] ?? raiders[0]
  const prey = w.units
    .filter((e) => !e.dead && e.t.ground && !e.foot && w.players[e.owner].team !== team && e.seen[team] && !!e.t.ground.builds?.length)
    .sort((a, c) => d2(a, home) - d2(c, home) || a.id - c.id)[0]
  if (prey) return void cmdAttack(w, o, raiders.map((u) => u.id), prey.id)
  const storm = raiders.length >= STORM
  const target = knownBuildings(w, o)
    .map((k) => ({ k, at: { x: (k.tc + UNIT[k.unit].ground!.foot![0] / 2) * TILE, y: (k.tr + UNIT[k.unit].ground!.foot![1] / 2) * TILE }, armed: UNIT[k.unit].hardpoints.some((h) => h.weapon) }))
    .filter((x) => storm || !x.armed)
    .sort((a, c) => d2(a.at, home) - d2(c.at, home) || a.k.id - c.k.id)[0]
  if (target) cmdMove(w, o, raiders.map((u) => u.id), target.at.x, target.at.y, true)
}
