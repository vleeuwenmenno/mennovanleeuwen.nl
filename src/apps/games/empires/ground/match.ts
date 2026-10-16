import { groundThink, newGroundBrain, type GroundBrain } from './ai.ts'
import { SLICE_IDS } from './build.ts'
import { runGroundCmd, type GroundCmd } from './commands.ts'
import { nearestStand, spotOf } from './nav.ts'
import { GROUND_UNIT, STEP, addStructure, newGroundWorld, spawnUnit, teamOf, tick, type GroundSeat, type GroundWorld, type Owner } from './sim.ts'
import { TILE, type GroundMap } from './types.ts'
import { GROUND_START_CREDITS } from './units.ts'

// Starting a ground battle and moving it on a tick, as the space game's match.ts does: each seat
// gets its Command Center on its spawn's plateau and one Engineer in front of its door, the starting
// credits, and (an AI seat) a brain; every team knows where the others start. A turn runs the
// players' orders, then the AI, then the sim.

export type GroundBattle = { world: GroundWorld; brains: GroundBrain[] }

/** A new battle on `map` for `seats` (seat i starts on spawn i), with `credits` each (the space
 * game's 1,600 when left out). */
export function startGroundBattle(map: GroundMap, seats: GroundSeat[], opts: { seed?: number; credits?: number } = {}): GroundBattle {
  if (seats.length > map.spawns.length) throw new Error(`${map.def.name} has room for ${map.spawns.length} players, not ${seats.length}`)
  const w = newGroundWorld(map, seats, { seed: opts.seed, credits: opts.credits ?? GROUND_START_CREDITS })
  const nav = w.nav
  seats.forEach((s, o) => {
    const ids = SLICE_IDS[s.faction]
    const sp = map.spawns[o]
    const [fw, fh] = GROUND_UNIT[ids.center].foot!
    // The Command Center in the middle of the spawn's build area, its door to the south.
    const tc = Math.round(sp.x / TILE) - (fw >> 1)
    const tr = Math.round(sp.y / TILE) - (fh >> 1)
    addStructure(w, ids.center, o, tc, tr)
    // The engineer a row beyond the door row (its stamp lands at the first tick, so keep off it).
    const k = GROUND_UNIT[ids.engineer].size
    const at = nearestStand(nav, k, (tr + fh + 1) * nav.cols + tc + (fw >> 1))
    const p = at >= 0 ? spotOf(nav, k, at) : { x: sp.x, y: (tr + fh + 1.5) * TILE }
    spawnUnit(w, ids.engineer, o, p.x, p.y, Math.PI / 2)
  })
  // Enemy start spots are marked from the first second: each team knows the others' Command Centers.
  for (const u of w.units) {
    if (!u.stamped) continue
    for (let team = 0; team < w.memory.length; team++)
      if (team !== teamOf(w, u.owner)) w.memory[team].set(u.id, { id: u.id, type: u.type, owner: u.owner, tc: u.tc, tr: u.tr })
  }
  const brains = seats.flatMap((s, o) => (s.ai ? [newGroundBrain(o)] : []))
  return { world: w, brains }
}

/** Moves a battle one tick on: the turn's orders (seat, order) in the order given, then each AI,
 * then the sim. `onRun` hears what each order answered (a refusal's reason, for a toast). */
export function stepGround(b: GroundBattle, orders: [Owner, GroundCmd][], onRun?: (seat: Owner, c: GroundCmd, result: unknown) => void) {
  for (const [seat, c] of orders) {
    const r = runGroundCmd(b.world, seat, c)
    onRun?.(seat, c, r)
  }
  for (const brain of b.brains) groundThink(b.world, brain, STEP)
  tick(b.world)
}
