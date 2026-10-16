import { SLICE_IDS, cantTrain, placement } from './build.ts'
import { groundCmd, runGroundCmd, type GroundCmd } from './commands.ts'
import { GROUND_UNIT, needsWork, rand, teamOf, type GroundUnit, type GroundWorld, type Owner } from './sim.ts'
import { TILE, type Pt } from './types.ts'

// The ground battle's AI, passive for the slice (plan D11): on its seat it trains a few engineers,
// expands with a second Command Center somewhere sensible (beside a deposit on its own side of the
// map, scouting the ground there first), finishes its sites and repairs its buildings, and builds
// nothing hostile. It reads only what its team knows (its own units, its explored ground and the
// enemy buildings it remembers; placement goes by the same fog), takes its timing from the world's
// clock and random stream, and gives every order through the order table, as the space AI does, so
// every copy of a battle makes the same choices.

export type GroundBrain = {
  o: Owner
  /** Seconds to its next decision. */
  t: number
  /** The engineer it sent to scout an expansion spot (0: none). */
  scout: number
  /** The site it is waiting on, and since when (world seconds): one that never gets started is
   * called off. */
  site: number
  siteAt: number
}

export const newGroundBrain = (o: Owner): GroundBrain => ({ o, t: 1.5, scout: 0, site: 0, siteAt: 0 })

/** Seconds between decisions (give or take a fifth). */
const THINK = 2
/** Engineers it keeps: with one Command Center, and with more. */
const ENGINEERS = [2, 4]
/** Command Centers it wants: its own and one expansion. */
const CENTERS = 2
/** Engineers on one site at most (more only cost it nothing, but it keeps one free). */
const CREW = 2
/** Seconds a site may wait for work to start before it is called off (refunded in full). */
const SITE_PATIENCE = 90
/** How far from a deposit's middle it puts an expansion's middle, in tiles, and the directions it tries. */
const BESIDE = 8
const AROUND: [number, number][] = [[0, 1], [1, 0], [0, -1], [-1, 0], [1, 1], [-1, 1], [1, -1], [-1, -1]]

const d2 = (a: Pt, b: Pt) => (a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y)

/** Its turn to think, every tick: does something only when its timer runs out. */
export function groundThink(w: GroundWorld, b: GroundBrain, dt: number) {
  b.t -= dt
  if (b.t > 0 || w.winner !== -1) return
  b.t = THINK * (0.8 + rand(w) * 0.4)
  const o = b.o
  const p = w.players[o]
  if (!p) return
  const ids = SLICE_IDS[p.faction]
  const say = (c: GroundCmd) => runGroundCmd(w, o, c)
  const mine = w.units.filter((u) => !u.dead && u.owner === o)
  const centers = mine.filter((u) => u.type === ids.center)
  const standing = centers.filter((u) => !u.site)
  const engineers = mine.filter((u) => u.type === ids.engineer)
  if (!standing.length && !engineers.length) return
  const idle = engineers.filter((u) => !u.orders.length)
  const crewOf = (s: GroundUnit) => engineers.filter((u) => u.orders.some((x) => x.k === 'build' && x.id === s.id)).length

  // 1. Engineers: a few, trained one at a time at a Command Center with nothing queued.
  const queued = standing.reduce((n, c) => n + c.queue.length, 0)
  const want = ENGINEERS[Math.min(ENGINEERS.length - 1, standing.length - 1)] ?? ENGINEERS[0]
  const saving = centers.length < CENTERS && engineers.length >= ENGINEERS[0]
  if (engineers.length + queued < want && !saving) {
    const at = standing.find((c) => !c.queue.length && !cantTrain(w, o, c.id, ids.engineer))
    if (at) say(groundCmd('train', at.id, ids.engineer, 1))
  }

  // 2. Sites and repairs: idle engineers go to what needs work, nearest first.
  for (const s of mine.filter(needsWork)) {
    if (!idle.length) break
    if (crewOf(s) >= (s.site ? CREW : 1)) continue
    idle.sort((a, c) => d2(a, s) - d2(c, s) || a.id - c.id)
    say(groundCmd('construct', [idle.shift()!.id], s.id, false))
  }
  // A site that nobody gets started (its way blocked, an enemy parked on it) is called off.
  const waiting = centers.find((c) => c.site && !c.site.started)
  if (!waiting) b.site = 0
  else if (b.site !== waiting.id) {
    b.site = waiting.id
    b.siteAt = w.time
  } else if (w.time - b.siteAt > SITE_PATIENCE) say(groundCmd('cancel', waiting.id, -1))

  // 3. Expanding: a second Command Center beside a deposit on its own side, once it can pay for it.
  if (centers.length >= CENTERS || !standing.length || centers.some((c) => c.site)) return
  const cost = GROUND_UNIT[ids.center].cost ?? 0
  if (p.credits < cost * 0.6) return
  const { spot, scout } = expansionSpot(w, o, ids.center, standing[0])
  const free = engineers.filter((u) => !u.orders.some((x) => x.k === 'build'))
  if (spot && p.credits >= cost) {
    const builder = (free.length ? free : engineers).slice().sort((a, c) => d2(a, spot) - d2(c, spot) || a.id - c.id)[0]
    if (builder) say(groundCmd('place', [builder.id], ids.center, spot.x, spot.y, false))
    b.scout = 0
    return
  }
  // Nowhere it knows of yet: send one engineer to look at the best spot.
  const scouting = w.byId.get(b.scout)
  if (scout && (!scouting || scouting.dead || !scouting.orders.length)) {
    const who = free.sort((a, c) => d2(a, scout) - d2(c, scout) || a.id - c.id)[0]
    if (who) {
      say(groundCmd('move', [who.id], scout.x, scout.y, false))
      b.scout = who.id
    }
  }
}

/**
 * Where to put a new Command Center: beside the deposits nearer home than any enemy building it
 * knows of, nearest home first, the first spot the placement accepts. `scout`: the first spot it
 * can't judge because the ground there is unexplored.
 */
function expansionSpot(w: GroundWorld, o: Owner, type: string, home: GroundUnit): { spot: Pt | null; scout: Pt | null } {
  const enemies = [...(w.memory[teamOf(w, o)]?.values() ?? [])].map((k) => {
    const [fw, fh] = GROUND_UNIT[k.type].foot!
    return { x: (k.tc + fw / 2) * TILE, y: (k.tr + fh / 2) * TILE }
  })
  const deposits = w.map.deposits
    .map((d, i) => ({ d, i, far: d2(d, home) }))
    .filter(({ d, far }) => enemies.every((e) => d2(d, e) > far))
    .sort((a, c) => a.far - c.far || a.i - c.i)
  let scout: Pt | null = null
  for (const { d } of deposits)
    for (const [dx, dy] of AROUND) {
      const k = BESIDE / Math.sqrt(dx * dx + dy * dy)
      const at = { x: d.x + dx * k * TILE, y: d.y + dy * k * TILE }
      const pl = placement(w, o, type, at.x, at.y)
      if (!pl.why) return { spot: at, scout }
      if (!scout && pl.why === 'Unexplored ground') scout = at
    }
  return { spot: null, scout }
}
