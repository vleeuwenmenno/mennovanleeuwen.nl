import type { Brain } from '../ai.ts'
import { UNIT } from '../data.ts'
import { cmdBuild, cmdCancelSite, cmdConstruct, cmdPlace, cantBuild, type Unit, type World } from '../sim.ts'
import { TILE, type Pt } from './types.ts'
import { groundIds, groundPlacement, knownBuildings } from './world.ts'

// The AI's decisions in a ground battle: a branch of ai.ts's think (same brain, clock and random
// stream), passive for now: on its seat it trains a few engineers, expands with a second Command
// Center somewhere sensible (beside a crystal field on its own side of the map), finishes its sites
// and repairs its buildings, and builds nothing hostile. It reads only what its team knows (its own
// units, the land, which every side sees from orbit, and the enemy buildings it remembers) and gives
// the same orders a player does, so every copy of a battle makes the same choices.

/** Engineers it keeps: with one Command Center, and with more. */
const ENGINEERS = [2, 4]
/** Command Centers it wants: its own and one expansion. */
const CENTERS = 2
/** Engineers on one site at most. */
const CREW = 2
/** Seconds a site may wait for work to start before it is called off (refunded in full). */
const SITE_PATIENCE = 90
/** How far from a crystal field's middle it puts an expansion's middle, in tiles, and the ways it tries. */
const BESIDE = 8
const AROUND: [number, number][] = [[0, 1], [1, 0], [0, -1], [-1, 0], [1, 1], [-1, 1], [1, -1], [-1, -1]]

const d2 = (a: Pt, b: Pt) => (a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y)
const wants = (u: Unit) => !!u.site || u.hull < u.hullMax - 0.5

/** Its decisions when its turn to think comes (ai.ts think, in a battle with terrain). */
export function groundThink(w: World, b: Brain) {
  const o = b.o
  const p = w.players[o]
  const ids = groundIds(p.faction)
  const mine = w.units.filter((u) => !u.dead && u.owner === o)
  const centers = mine.filter((u) => u.t.id === ids.center)
  const standing = centers.filter((u) => !u.site)
  const engineers = mine.filter((u) => u.t.id === ids.engineer)
  if (!standing.length && !engineers.length) return
  const idle = engineers.filter((u) => u.order.k === 'idle' && !u.queue.length)
  const crewOf = (s: Unit) => engineers.filter((u) => [u.order, ...u.queue].some((x) => x.k === 'construct' && x.id === s.id)).length

  // 1. Engineers: a few, trained one at a time at a Command Center with nothing queued.
  const queued = standing.reduce((n, c) => n + (c.yq?.length ?? 0), 0)
  const want = ENGINEERS[Math.min(ENGINEERS.length - 1, standing.length - 1)] ?? ENGINEERS[0]
  const saving = centers.length < CENTERS && engineers.length >= ENGINEERS[0]
  if (engineers.length + queued < want && !saving) {
    const at = standing.find((c) => !c.yq?.length && !cantBuild(w, o, ids.engineer, false, c.id))
    if (at) cmdBuild(w, o, ids.engineer, false, at.id)
  }

  // 2. Sites and repairs: idle engineers go to what needs work, nearest first.
  for (const s of mine.filter((u) => !!u.foot && wants(u))) {
    if (!idle.length) break
    if (crewOf(s) >= (s.site ? CREW : 1)) continue
    idle.sort((a, c) => d2(a, s) - d2(c, s) || a.id - c.id)
    cmdConstruct(w, o, [idle.shift()!.id], s.id)
  }
  // A site that nobody gets started (its way blocked, an enemy parked on it) is called off.
  const waiting = centers.find((c) => c.site && !c.site.started)
  if (!waiting) b.gSite = 0
  else if (b.gSite !== waiting.id) {
    b.gSite = waiting.id
    b.gSiteAt = w.time
  } else if (w.time - (b.gSiteAt ?? w.time) > SITE_PATIENCE) cmdCancelSite(w, o, waiting.id)

  // 3. Expanding: a second Command Center beside a crystal field on its own side, once it can pay.
  if (centers.length >= CENTERS || !standing.length || centers.some((c) => c.site)) return
  const cost = UNIT[ids.center].cost
  if (p.credits < cost) return
  const spot = expansionSpot(w, o, ids.center, standing[0])
  if (!spot) return
  const free = engineers.filter((u) => ![u.order, ...u.queue].some((x) => x.k === 'construct'))
  const builder = (free.length ? free : engineers).slice().sort((a, c) => d2(a, spot) - d2(c, spot) || a.id - c.id)[0]
  if (builder) cmdPlace(w, o, [builder.id], ids.center, spot.x, spot.y)
}

/** Where to put a new Command Center: beside the crystal fields nearer home than any enemy building
 * it knows of, nearest home first, the first spot the placement accepts. */
function expansionSpot(w: World, o: number, type: string, home: Unit): Pt | null {
  const enemies = knownBuildings(w, o).map((k) => {
    const [fw, fh] = UNIT[k.unit].ground!.foot!
    return { x: (k.tc + fw / 2) * TILE, y: (k.tr + fh / 2) * TILE }
  })
  const fields = w.ground!.map.deposits
    .map((d, i) => ({ d, i, far: d2(d, home) }))
    .filter(({ d, far }) => enemies.every((e) => d2(d, e) > far))
    .sort((a, c) => a.far - c.far || a.i - c.i)
  for (const { d } of fields)
    for (const [dx, dy] of AROUND) {
      const k = BESIDE / Math.sqrt(dx * dx + dy * dy)
      const at = { x: d.x + dx * k * TILE, y: d.y + dy * k * TILE }
      if (!groundPlacement(w, o, type, at.x, at.y).why) return at
    }
  return null
}
