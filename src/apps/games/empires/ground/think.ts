import type { Brain } from '../ai.ts'
import * as M from '../detmath.ts'
import { UNIT } from '../data.ts'
import { cmdBuild, cmdCancelSite, cmdConstruct, cmdGather, cmdPlace, cantBuild, type Unit, type World } from '../sim.ts'
import { TILE, type Pt } from './types.ts'
import { POP_MAX, groundIds, groundPlacement, knownBuildings } from './world.ts'

// The AI's decisions in a ground battle: a branch of ai.ts's think (same brain, clock and random
// stream), passive for now: on its seat it keeps its engineers gathering kyber, puts up supply before
// it reaches its unit cap, trains more engineers, expands with a second Command Center towards the
// crystal fields on its own side of the map, finishes its sites and repairs its buildings, and builds
// nothing hostile. It reads only what its team knows (its own units, the land and its crystal fields,
// which every side sees from orbit, and the enemy buildings it remembers) and gives the same orders a
// player does, so every copy of a battle makes the same choices.

/** Engineers it keeps for each standing Command Center, and at most. */
const ENGINEERS_PER_CENTER = 7
const ENGINEERS_MAX = 14
/** Room it keeps under the unit cap: it builds supply once fewer than this many more fit. */
const SUPPLY_ROOM = 3
/** Command Centers it wants: its own and one expansion. */
const CENTERS = 2
/** Engineers it has before it saves up for the expansion. */
const EXPAND_AT = 6
/** Engineers on one site at most. */
const CREW = 2
/** Seconds a site may wait for work to start before it is called off (refunded in full). */
const SITE_PATIENCE = 90
/** How far from a crystal field's middle it puts an expansion's middle, in tiles, and the ways it tries. */
const BESIDE = 8
const AROUND: [number, number][] = [[0, 1], [1, 0], [0, -1], [-1, 0], [1, 1], [-1, 1], [1, -1], [-1, -1]]
/** A crystal field this near (tiles) one of its Command Centers is already served by it. */
const SERVED = 13

const d2 = (a: Pt, b: Pt) => (a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y)
const wants = (u: Unit) => !!u.site || u.hull < u.hullMax - 0.5
const plans = (u: Unit) => [u.order, ...u.queue]

/** Its decisions when its turn to think comes (ai.ts think, in a battle with terrain). */
export function groundThink(w: World, b: Brain) {
  const o = b.o
  const p = w.players[o]
  const ids = groundIds(p.faction)
  const mine = w.units.filter((u) => !u.dead && u.owner === o)
  const centers = mine.filter((u) => u.t.id === ids.center)
  const standing = centers.filter((u) => !u.site)
  const supplies = mine.filter((u) => u.t.id === ids.supply)
  const engineers = mine.filter((u) => u.t.id === ids.engineer)
  if (!standing.length && !engineers.length) return
  const building = (u: Unit) => plans(u).some((x) => x.k === 'construct')
  const crewOf = (s: Unit) => engineers.filter((u) => plans(u).some((x) => x.k === 'construct' && x.id === s.id)).length
  const idle = engineers.filter((u) => u.order.k === 'idle' && !u.queue.length)
  /** An engineer to take off its work for a job at `at`: an idle one, else the nearest gatherer. */
  const spare = (at: Pt) => {
    const pool = idle.length ? idle : engineers.filter((u) => !building(u))
    return pool.slice().sort((a, c) => d2(a, at) - d2(c, at) || a.id - c.id)[0]
  }
  const queued = standing.reduce((n, c) => n + (c.yq ?? []).reduce((k, q) => k + UNIT[q.unit].pop, 0), 0)
  const room = p.popCap - p.pop - queued

  // 1. Supply before the cap: one building at a time, beside a Command Center.
  const supplyCost = UNIT[ids.supply].cost
  if (room < SUPPLY_ROOM && p.popCap < POP_MAX && !supplies.some((u) => u.site) && standing.length && p.credits >= supplyCost) {
    const spot = supplySpot(w, o, ids.supply, standing[0])
    const who = spot && spare(spot)
    if (spot && who) cmdPlace(w, o, [who.id], ids.supply, spot.x, spot.y)
  }

  // 2. Engineers: up to a few a Command Center, trained where the queue is shortest, unless it is
  // saving for the expansion.
  const centerCost = UNIT[ids.center].cost
  const want = Math.min(ENGINEERS_MAX, ENGINEERS_PER_CENTER * Math.max(1, standing.length))
  const saving = centers.length < CENTERS && engineers.length >= EXPAND_AT && p.credits < centerCost + UNIT[ids.engineer].cost
  if (engineers.length + queued < want && room > 0 && !saving) {
    const at = standing
      .filter((c) => (c.yq?.length ?? 0) < 2 && !cantBuild(w, o, ids.engineer, false, c.id))
      .sort((a, c) => (a.yq?.length ?? 0) - (c.yq?.length ?? 0) || a.id - c.id)[0]
    if (at) cmdBuild(w, o, ids.engineer, false, at.id)
  }

  // 3. Sites and repairs: idle engineers (or, for a site nobody is building, a gatherer) go to what
  // needs work, nearest first.
  for (const s of mine.filter((u) => !!u.foot && wants(u))) {
    const crew = crewOf(s)
    if (crew >= (s.site ? CREW : 1)) continue
    const who = idle.length ? idle.sort((a, c) => d2(a, s) - d2(c, s) || a.id - c.id)[0] : crew ? undefined : spare(s)
    if (!who) continue
    if (idle.includes(who)) idle.splice(idle.indexOf(who), 1)
    cmdConstruct(w, o, [who.id], s.id)
  }
  // A site that nobody gets started (its way blocked, an enemy parked on it) is called off.
  const waiting = mine.find((c) => c.site && !c.site.started)
  if (!waiting) b.gSite = 0
  else if (b.gSite !== waiting.id) {
    b.gSite = waiting.id
    b.gSiteAt = w.time
  } else if (w.time - (b.gSiteAt ?? w.time) > SITE_PATIENCE) cmdCancelSite(w, o, waiting.id)

  // 4. Gathering: every idle engineer to the crystal field nearest one of our Command Centers
  // (the nearest the engineer on a tie), all of them in one order a field.
  if (idle.length && standing.length) {
    const byField = new Map<number, Unit[]>()
    for (const u of idle) {
      const f = fieldFor(w, standing, u)
      if (f < 0) continue
      const list = byField.get(f)
      if (list) list.push(u)
      else byField.set(f, [u])
    }
    for (const [f, us] of byField) {
      const field = w.ground!.fields[f]
      cmdGather(w, o, us.map((u) => u.id), field.x, field.y)
    }
  }

  // 5. Expanding: a second Command Center beside a crystal field on its own side that none of ours
  // serves yet, once it can pay for it.
  if (centers.length >= CENTERS || !standing.length || centers.some((c) => c.site) || engineers.length < EXPAND_AT) return
  if (p.credits < centerCost) return
  const spot = expansionSpot(w, o, ids.center, standing)
  if (!spot) return
  const who = spare(spot)
  if (who) cmdPlace(w, o, [who.id], ids.center, spot.x, spot.y)
}

/** The crystal field with kyber left nearest one of `centers` (the nearest `u` on a tie), or -1. */
function fieldFor(w: World, centers: Unit[], u: Unit): number {
  let best = -1
  let bestD = Infinity
  let bestU = Infinity
  w.ground!.fields.forEach((f, i) => {
    if (!((w.kyber?.[i] ?? 0) > 0)) return
    const d = Math.min(...centers.map((c) => d2(f, c)))
    const du = d2(f, u)
    // Fields about as near home count the same: then the one nearer the engineer.
    if (d < bestD - TILE * TILE * 16 || (d < bestD + TILE * TILE * 16 && du < bestU)) {
      best = i
      bestD = Math.min(bestD, d)
      bestU = du
    }
  })
  return best
}

/** Where a supply building goes beside Command Center `home`: rings round it from 6 to 12 tiles out,
 * the spots away from the crystal fields first (so it doesn't stand in the engineers' way), the first
 * the placement accepts. */
function supplySpot(w: World, o: number, type: string, home: Unit): Pt | null {
  const fields = w.ground!.fields
  const tries: { at: Pt; score: number; k: number }[] = []
  for (let r = 6; r <= 12; r += 2)
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2
      const at = { x: home.x + M.cos(a) * r * TILE, y: home.y + M.sin(a) * r * TILE }
      const near = fields.length ? Math.min(...fields.map((f) => Math.sqrt(d2(f, at)))) : 0
      tries.push({ at, score: r * TILE - Math.min(near, TILE * 12) * 0.6, k: tries.length })
    }
  tries.sort((a, c) => a.score - c.score || a.k - c.k)
  for (const t of tries) {
    const pl = groundPlacement(w, o, type, t.at.x, t.at.y)
    if (!pl.why) return { x: pl.x, y: pl.y }
  }
  return null
}

/** Where to put a new Command Center: beside the crystal fields with kyber left, nearer home than
 * any enemy building it knows of and not served by one of ours yet, nearest home first, the first
 * spot the placement accepts. */
function expansionSpot(w: World, o: number, type: string, centers: Unit[]): Pt | null {
  const home = centers[0]
  const enemies = knownBuildings(w, o).map((k) => {
    const [fw, fh] = UNIT[k.unit].ground!.foot!
    return { x: (k.tc + fw / 2) * TILE, y: (k.tr + fh / 2) * TILE }
  })
  const served = SERVED * TILE
  const fields = w.ground!.map.deposits
    .map((d, i) => ({ d, i, far: d2(d, home) }))
    .filter(({ d, i, far }) => (w.kyber?.[i] ?? 0) > 0 && enemies.every((e) => d2(d, e) > far) && centers.every((c) => d2(d, c) > served * served))
    .sort((a, c) => a.far - c.far || a.i - c.i)
  for (const { d } of fields)
    for (const [dx, dy] of AROUND) {
      const k = BESIDE / Math.sqrt(dx * dx + dy * dy)
      const at = { x: d.x + dx * k * TILE, y: d.y + dy * k * TILE }
      if (!groundPlacement(w, o, type, at.x, at.y).why) return at
    }
  return null
}
