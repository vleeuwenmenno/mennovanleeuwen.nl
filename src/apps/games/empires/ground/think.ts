import type { Brain } from '../ai.ts'
import * as M from '../detmath.ts'
import { GROUND_TECH, UNIT, groundTechsFor } from '../data.ts'
import { cmdBuild, cmdGroundJob, cmdCancelSite, cmdConstruct, cmdGather, cmdPlace, cantBuild, type Unit, type World } from '../sim.ts'
import { TILE, type Pt } from './types.ts'
import { armyThink } from './army.ts'
import { SITE_DRAW } from './power.ts'
import { TIER_MAX, cantJob, jobCost } from './jobs.ts'
import { POP_MAX, crystalAt, fieldLeft, groundIds, groundPlacement, knownBuildings, tierNeeded, tierOf, trainsOf } from './world.ts'

// The AI's decisions in a ground battle: a branch of ai.ts's think (same brain, clock and random
// stream): on its seat it keeps its engineers gathering kyber, puts up supply before it reaches its
// unit cap, builds power generators to keep power ahead of what it needs, a foot factory, a vehicle
// factory and a research station or two, upgrades its factories' tiers and takes a research or two
// there, trains more engineers and a mix of the factories' units, expands with a second Command Center towards the crystal fields on
// its own side of the map, finishes its sites and repairs its buildings, and fields a few Scouts that
// scout, defend its buildings and raid the enemy's engineers and buildings (army.ts). It reads only
// what its team knows (its own units, the land and its crystal fields, which every side sees from
// orbit, the enemy it sees and the enemy buildings it remembers) and gives the same orders a player
// does, so every copy of a battle makes the same choices.

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
/** Engineers it has before it builds its first generator, and before its research stations. */
const POWER_AT = 3
const RESEARCH_AT = 5
/** Research stations it keeps: one a standing Command Center, at most this many. */
const LABS_MAX = 2
/** Engineers it has before it builds its foot factory, and before its vehicle factory (which also
 * waits for a generator to run). */
const BARRACKS_AT = 4
const VFACTORY_AT = 6
/** Fighting units (from the factories) it keeps, and more once it is rich; kyber it keeps back from
 * them for engineers. */
const ARMY = 6
const ARMY_RICH = 12
/** Units of each factory it trains even while saving for its expansion. */
const ARMY_MIN = 1
const RICH = 900
const ARMY_RESERVE = 150
/** Research it takes at its factories (on top of their tier upgrades), and kyber it keeps back from
 * upgrades. */
const AI_TECHS = 2
const JOB_RESERVE = 300
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
  // Units waiting in any of its queues (Command Centers and factories) count against the cap.
  const queued = mine.reduce((n, c) => n + (c.yq ?? []).reduce((k, q) => k + UNIT[q.unit].pop, 0), 0)
  const room = p.popCap - p.pop - queued

  // 1. Supply before the cap: one building at a time, beside a Command Center.
  const supplyCost = UNIT[ids.supply].cost
  if (room < SUPPLY_ROOM && p.popCap < POP_MAX && !supplies.some((u) => u.site) && standing.length && p.credits >= supplyCost) {
    const spot = supplySpot(w, o, ids.supply, standing[0])
    const who = spot && spare(spot)
    if (spot && who) cmdPlace(w, o, [who.id], ids.supply, spot.x, spot.y)
  }

  // 1b. Power ahead of what it needs (a site going up, and the next building that draws power it
  // wants), one generator at a time; then, one site at a time, its foot factory, its vehicle factory
  // (once a generator runs) and a research station a Command Center (two at most).
  const gens = mine.filter((u) => u.t.id === ids.generator)
  const labs = mine.filter((u) => u.t.id === ids.research)
  const barracks = mine.filter((u) => u.t.id === ids.barracks)
  const vfactories = mine.filter((u) => u.t.id === ids.vfactory)
  const pw = p.power ?? { made: 0, used: 0, ratio: 1 }
  const wantLabs = Math.min(LABS_MAX, standing.length)
  const running = gens.some((u) => !u.site)
  const next =
    ids.barracks && !barracks.length && engineers.length >= BARRACKS_AT ? ids.barracks
    : ids.vfactory && !vfactories.length && running && engineers.length >= VFACTORY_AT ? ids.vfactory
    : ids.research && labs.length < wantLabs && running && engineers.length >= RESEARCH_AT ? ids.research
    : ''
  const drawOf = (id: string) => (id ? (UNIT[id].ground!.draw ?? 0) : 0)
  const ahead = SITE_DRAW + drawOf(next || (labs.length < wantLabs ? ids.research : ''))
  const raising = [...barracks, ...vfactories, ...labs].some((u) => u.site)
  if (ids.generator && standing.length && engineers.length >= POWER_AT && !gens.some((u) => u.site) && (pw.ratio < 1 || pw.made - pw.used < ahead) && p.credits >= UNIT[ids.generator].cost) {
    const spot = supplySpot(w, o, ids.generator, standing[0])
    const who = spot && spare(spot)
    if (spot && who) cmdPlace(w, o, [who.id], ids.generator, spot.x, spot.y)
  } else if (next && !raising && standing.length && p.credits >= UNIT[next].cost) {
    const home = next === ids.research ? standing[labs.length % standing.length] : standing[0]
    const spot = supplySpot(w, o, next, home)
    const who = spot && spare(spot)
    if (spot && who) cmdPlace(w, o, [who.id], next, spot.x, spot.y)
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
      // At one of the field's clusters with kyber left (the order finds the field from it).
      const at = (w.crystals ?? []).find((c) => c.f === f && c.left > 0)
      if (at) cmdGather(w, o, us.map((u) => u.id), crystalAt(at).x, crystalAt(at).y)
    }
  }

  // 4b. Its factories: a mix of the units they train, the kind it has fewest of first, one at a time
  // a factory, keeping a little kyber back for engineers (and, past the first few, for the expansion
  // it saves up for).
  const made = new Set([ids.barracks, ids.vfactory].flatMap((id) => (id ? trainsOf(UNIT[id]).map((t) => t.id) : [])))
  const fighters = mine.filter((u) => made.has(u.t.id))
  const keepArmy = p.credits >= RICH ? ARMY_RICH : ARMY
  const inQueue = [...barracks, ...vfactories].reduce((n, f) => n + (f.yq?.length ?? 0), 0)
  if (fighters.length + inQueue < keepArmy && room > 0) {
    for (const f of [...barracks, ...vfactories]) {
      if (f.site || (f.yq?.length ?? 0) >= 1) continue
      const kinds = trainsOf(f).filter((t) => tierNeeded(t) <= tierOf(f))
      if (saving && fighters.filter((u) => kinds.some((t) => t.id === u.t.id)).length >= ARMY_MIN) continue
      const have = (id: string) => mine.filter((u) => u.t.id === id).length
      const pick = kinds.slice().sort((a, c) => have(a.id) - have(c.id))[0]
      if (pick && p.credits >= pick.cost + ARMY_RESERVE && !cantBuild(w, o, pick.id, false, f.id)) cmdBuild(w, o, pick.id, false, f.id)
    }
  }

  // 4c. Upgrades at its factories, one job a factory: the next tier when it can pay for it (research
  // points, and kyber with some kept back), then a research or two for their units.
  const researched = p.techs.filter((id) => GROUND_TECH[id]).length + mine.filter((u) => u.gj && u.gj.id !== 'tier').length
  for (const f of [...barracks, ...vfactories]) {
    if (f.site || f.gj) continue
    const options = [...((f.t.ground!.tier ?? 1) < TIER_MAX ? ['tier'] : []), ...(researched < AI_TECHS ? groundTechsFor(f.t.id).map((t) => t.id) : [])]
    for (const job of options) {
      const c = jobCost(f, job)
      if (!c || p.credits < c.cost + JOB_RESERVE || cantJob(w, o, f, job)) continue
      cmdGroundJob(w, o, f.id, job)
      break
    }
  }

  // 5. Its Scouts: training, scouting, defending, raiding (army.ts).
  armyThink(w, b, mine)

  // 6. Expanding: a second Command Center beside a crystal field on its own side that none of ours
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
    if (!(fieldLeft(w, i) > 0)) return
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
    .filter(({ d, i, far }) => fieldLeft(w, i) > 0 && enemies.every((e) => d2(d, e) > far) && centers.every((c) => d2(d, c) > served * served))
    .sort((a, c) => a.far - c.far || a.i - c.i)
  for (const { d } of fields)
    for (const [dx, dy] of AROUND) {
      const k = BESIDE / Math.sqrt(dx * dx + dy * dy)
      const at = { x: d.x + dx * k * TILE, y: d.y + dy * k * TILE }
      if (!groundPlacement(w, o, type, at.x, at.y).why) return at
    }
  return null
}
