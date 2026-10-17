// Building and training in ground battles, part of check:ground (scripts/empires-ground.ts runs it).
//
// 1. Placement: on Dustfall Ridge, every placement rule refuses somewhere with its own reason
//    (unbuildable, a deposit, uneven ground, built on, blocking a door, outside the
//    command range, too near the enemy, enemy units on it, no room at its own door, credits), the
//    failing tiles show red, and an order to place there is refused with the same reason.
// 2. A scripted battle, two copies side by side plus a replay from the logged inputs, all hashing
//    the same every second. Seat 0 (scripted, Republic) trains engineers (five with shift, one
//    cancelled and refunded), places Command Centers and builds them with a growing crew, cancels a
//    site before work starts (full refund) and one halfway (the unbuilt share back), has a unit
//    standing on a site pushed off when work starts, repairs a damaged building, sets a rally
//    point, and loses a building (its stamp freed). Seat 1 is the passive AI (Swarm): it must train
//    engineers and expand to a second Command Center.

import { buildGroundMap } from '../src/apps/games/empires/ground/terrain.ts'
import { GROUND_MAP } from '../src/apps/games/empires/ground/maps.ts'
import { startGroundBattle, stepGround, type GroundBattle } from '../src/apps/games/empires/ground/match.ts'
import { SLICE_IDS, cmdPlace, placement, queueOf, siteProgress } from '../src/apps/games/empires/ground/build.ts'
import { cleanGroundCmd, groundCmd, type GroundCmd } from '../src/apps/games/empires/ground/commands.ts'
import { CREW_RATE, GROUND_UNIT, STEP, addStructure, footDist, removeUnit, spawnUnit, stateHash, tick, typeOf, type GroundSeat, type GroundWorld } from '../src/apps/games/empires/ground/sim.ts'
import { footprintOpen } from '../src/apps/games/empires/ground/nav.ts'
import { TILE, type GroundMap } from '../src/apps/games/empires/ground/types.ts'

type Check = (what: string, ok: boolean, detail?: string) => void

const R = SLICE_IDS.republic
const dustfall = () => buildGroundMap(GROUND_MAP['dustfall-ridge'])

/** Every position on the map (a tile's middle) nearest `near` first where `type` placed by
 * `owner` gets `why` (null: accepted). */
function find(w: GroundWorld, owner: number, type: string, why: string | null, near = { x: w.w / 2, y: w.h / 2 }) {
  const { cols, rows } = w.map.grid
  const all: { x: number; y: number; d: number }[] = []
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const x = (c + 0.5) * TILE
      const y = (r + 0.5) * TILE
      all.push({ x, y, d: (x - near.x) * (x - near.x) + (y - near.y) * (y - near.y) })
    }
  all.sort((a, b) => a.d - b.d)
  for (const p of all) if (placement(w, owner, type, p.x, p.y).why === why) return p
  return null
}

// --- 1. Placement rules -----------------------------------------------------------------------------

function placementRules(check: Check) {
  const seats: GroundSeat[] = [{ faction: 'republic', team: 0 }, { faction: 'droid', team: 1 }]
  const { world: w } = startGroundBattle(dustfall(), seats, { credits: 5000 })
  for (let t = 0; t < 3; t++) tick(w)
  const home = w.units.find((u) => u.owner === 0 && u.type === R.center)!
  const homeAt = { x: home.x, y: home.y }
  const results: string[] = []
  const expect = (rule: string, type: string, why: string, prep?: () => void) => {
    prep?.()
    const at = find(w, 0, type, why, homeAt)
    results.push(`${rule}: ${at ? 'ok' : 'none found'}`)
    check(`placement refuses with "${why}" (${rule})`, !!at)
    if (!at) return
    const p = placement(w, 0, type, at.x, at.y)
    // The ghost: every tile checked, and red ones only for the rules about tiles.
    check(`  ...and checks every tile of the footprint`, p.tiles.length === GROUND_UNIT[type].foot![0] * GROUND_UNIT[type].foot![1])
  }
  expect('terrain', R.center, 'Not on buildable ground')
  expect('deposit', 'test-block', 'A deposit is in the way')
  expect('built on', R.center, 'Something is built there')
  expect('door blocked', R.center, "It would block a building's door")
  expect('command range', 'test-block', 'Outside the command range of your buildings')
  expect('enemy near', R.center, 'Too close to an enemy building (keep 20 tiles away)')
  expect('own door', R.center, 'No room in front of its door')
  // The tiles of a footprint over a building are red, the rest green.
  {
    const p = placement(w, 0, R.center, home.x + 3 * TILE, home.y)
    const red = p.tiles.filter((t) => !t.ok).length
    check('a ghost half over a building shows those tiles red and the rest green', red > 0 && red < p.tiles.length, `${red} of ${p.tiles.length} red`)
  }
  // Uneven ground: one tile of a good spot raised a level.
  {
    const at = find(w, 0, R.center, null, homeAt)!
    const p = placement(w, 0, R.center, at.x, at.y)
    const i = p.tr * w.map.grid.cols + p.tc
    const was = w.map.grid.height[i]
    w.map.grid.height[i] = (was + 1) % 3
    const why = placement(w, 0, R.center, at.x, at.y).why
    w.map.grid.height[i] = was
    check('placement refuses with "The ground must be level" (one tile raised)', why === 'The ground must be level', String(why))
  }
  // Enemy units we see on it.
  {
    const at = find(w, 0, R.center, null, homeAt)!
    const foe = spawnUnit(w, 'd-g-engineer', 1, at.x, at.y)
    const eye = spawnUnit(w, R.engineer, 0, at.x + TILE * 4, at.y)
    // Fog refreshes four times a second: run to the next refresh.
    for (let t = 0; t < 8; t++) tick(w)
    const why = placement(w, 0, R.center, foe.x, foe.y).why
    check('placement refuses with "Enemy units are in the way" (one we see)', why === 'Enemy units are in the way', String(why))
    // An order to place there is refused with the same reason, and costs nothing.
    const credits = w.players[0].credits
    const r = cmdPlace(w, 0, [eye.id], R.center, foe.x, foe.y, false)
    check('an order to place there is refused with the same reason and costs nothing', r === why && w.players[0].credits === credits, String(r))
    removeUnit(w, foe)
    removeUnit(w, eye)
    tick(w)
  }
  // Credits.
  {
    const at = find(w, 0, R.center, null, homeAt)!
    w.players[0].credits = 100
    const why = placement(w, 0, R.center, at.x, at.y).why
    w.players[0].credits = 5000
    check('placement refuses with "Not enough credits"', why === 'Not enough credits', String(why))
    check('and accepts a good spot with enough credits', placement(w, 0, R.center, at.x, at.y).why === null)
  }
  // Placement only goes by what the team knows: a building in the fog doesn't refuse it.
  {
    const enemyAt = find(w, 1, 'd-g-center', null, { x: w.w / 2, y: w.h / 2 })!
    const p = placement(w, 1, 'd-g-center', enemyAt.x, enemyAt.y)
    // Team 1 puts a Command Hub there out of team 0's sight (hand-placed, started, stamped).
    const hidden = addStructure(w, 'd-g-center', 1, p.tc, p.tr)
    tick(w)
    const mine = placement(w, 0, R.center, enemyAt.x, enemyAt.y).why
    check('a building hidden in the fog does not refuse a placement (the site is lost later)', mine !== 'Something is built there', String(mine))
    removeUnit(w, hidden)
    tick(w)
  }
}

// --- 2. The scripted building battle -------------------------------------------------------------

type Input =
  | { t: number; k: 'cmd'; owner: number; json: string }
  | { t: number; k: 'hull'; id: number; share: number }
  | { t: number; k: 'remove'; id: number }

function apply(b: GroundBattle, x: Input, orders: [number, GroundCmd][]) {
  const w = b.world
  if (x.k === 'cmd') {
    const c = cleanGroundCmd(JSON.parse(x.json), w)
    if (c) orders.push([x.owner, c])
  } else if (x.k === 'hull') {
    const u = w.byId.get(x.id)
    if (u) u.hull = typeOf(u).hull * x.share
  } else {
    const u = w.byId.get(x.id)
    if (u) removeUnit(w, u)
  }
}

const SEATS: GroundSeat[] = [{ faction: 'republic', team: 0 }, { faction: 'swarm', team: 1, ai: true }]
const start = (map: GroundMap) => startGroundBattle(map, SEATS, { seed: 99, credits: 6000 })

function buildingBattle(check: Check, seconds: number) {
  const a = start(dustfall())
  const b = start(dustfall())
  const w = a.world
  const ticks = Math.round(seconds / STEP)
  const inputs: Input[] = []
  const hashes: number[] = []
  let drift = -1
  const home = w.units.find((u) => u.owner === 0 && u.type === R.center)!
  const first = w.units.find((u) => u.owner === 0 && u.type === R.engineer)!
  const notes: string[] = []
  const got: Record<string, boolean> = {}
  const pass = (k: string, ok: boolean, detail = '') => {
    if (got[k] !== undefined) return
    got[k] = ok
    if (detail) notes.push(`${k}: ${detail}`)
  }
  let siteA = 0
  let siteB = 0
  let siteC = 0
  let parked = 0
  let parkAt = { x: 0, y: 0 }
  let onSite = false
  let repairedAt = -1
  // How fast site A grew with each crew size: [crew, share a tick] seen.
  const rates = new Map<number, number>()
  let rallyAt: { x: number; y: number } | null = null
  let rallyUnit = 0
  let rallyOff = -1
  let damagedAt = -1
  let cRefund = 0
  let removedFoot: { tc: number; tr: number } | null = null
  let builtA = -1
  let startedA = -1
  const events: Record<string, number> = {}
  for (let t = 0; t < ticks; t++) {
    const now: Input[] = []
    const say = (c: GroundCmd) => now.push({ t, k: 'cmd', owner: 0, json: JSON.stringify(c) })
    const mine = () => w.units.filter((u) => !u.dead && u.owner === 0)
    const engs = () => mine().filter((u) => u.type === R.engineer)
    // 1 s: five engineers with shift; 1.5 s: the fifth cancelled.
    if (t === 30) say(groundCmd('train', home.id, R.engineer, 5))
    if (t === 45) say(groundCmd('cancel', home.id, 4))
    // 2 s: a Command Center on the nearest good spot, built by the first engineer.
    if (t === 60) {
      const at = find(w, 0, R.center, null, home)!
      say(groundCmd('place', [first.id], R.center, at.x, at.y, false))
    }
    // 3 s: another one queued after it, then called off before work starts.
    if (t === 90) {
      const at = find(w, 0, R.center, null, home)!
      say(groundCmd('place', [first.id], R.center, at.x, at.y, true))
    }
    if (t === 120 && siteB) say(groundCmd('cancel', siteB, -1))
    // As engineers roll out: the first two join the first site's crew.
    const rolled = engs().filter((u) => u.id !== first.id)
    if (siteA && rolled.length >= 2 && !got.crew) {
      say(groundCmd('construct', rolled.slice(0, 2).map((u) => u.id), siteA, false))
      got.crew = true
    }
    // The third parks on a good spot, and the fourth places a Command Center right on it.
    if (rolled.length >= 4 && !parked && t > 60) {
      parkAt = find(w, 0, R.center, null, { x: home.x, y: home.y + 20 * TILE })!
      parked = rolled[2].id
      say(groundCmd('move', [parked], parkAt.x, parkAt.y, false))
    }
    const parkedU = w.byId.get(parked)
    if (parkedU && !siteC && !parkedU.orders.length && Math.hypot(parkedU.x - parkAt.x, parkedU.y - parkAt.y) < TILE) {
      const free = rolled.find((u) => u.id !== parked && !u.orders.length)
      if (free) say(groundCmd('place', [free.id], R.center, parkedU.x, parkedU.y, false))
    }
    // Site C halfway built: called off, the unbuilt share refunded.
    const sc = w.byId.get(siteC)
    if (sc && sc.site?.started && sc.site.work >= 0.3 && !cRefund) {
      cRefund = 1200 * (1 - sc.site.work)
      say(groundCmd('cancel', siteC, -1))
    }
    // The first site built: damaged (as the dev cheat panel would) and repaired by two engineers.
    const sa = w.byId.get(siteA)
    if (sa && !sa.site && damagedAt < 0 && t > builtA + 30 && builtA >= 0) {
      now.push({ t, k: 'hull', id: siteA, share: 0.4 })
      damagedAt = t
    }
    if (damagedAt >= 0 && t === damagedAt + 15) say(groundCmd('construct', engs().slice(0, 2).map((u) => u.id), siteA, false))
    // A rally point, then one more engineer, which drives there.
    if (t === 900) {
      // A spot on the plateau a few tiles from the door, where a placement would be good.
      rallyAt = find(w, 0, R.center, null, { x: home.x + 8 * TILE, y: home.y + 6 * TILE })!
      say(groundCmd('rally', home.id, rallyAt.x, rallyAt.y))
      say(groundCmd('train', home.id, R.engineer, 1))
    }
    // Late on, the first Command Center built is destroyed: its stamp comes off the grid.
    if (t === ticks - 90 && sa && !sa.dead) {
      removedFoot = { tc: sa.tc, tr: sa.tr }
      now.push({ t, k: 'remove', id: siteA })
    }
    // Junk an honest server cleans away.
    if (t % 211 === 0) now.push({ t, k: 'cmd', owner: 0, json: JSON.stringify({ f: 'place', a: [[1], 'no-such-type', 1, 1] }) })

    const before = w.players[0].credits
    const oa: [number, GroundCmd][] = []
    const ob: [number, GroundCmd][] = []
    for (const x of now) {
      apply(a, x, oa)
      apply(b, x, ob)
      inputs.push(x)
    }
    const nextId = w.nextId
    stepGround(a, oa, (seat, c, r) => {
      if (seat !== 0) return
      if (c.f === 'train' && t === 30) pass('train five with shift', r === null && home.queue.length === 5 && before - w.players[0].credits === 750, `queue ${home.queue.length}, paid ${before - w.players[0].credits}`)
      if (c.f === 'cancel' && t === 45) pass('a cancelled queue item is refunded in full', r === null && home.queue.length === 4 && w.players[0].credits - before === 150)
      if (c.f === 'place' && r === null) {
        const id = nextId
        if (!siteA) siteA = id
        else if (!siteB) siteB = id
        else if (!siteC) siteC = id
        if (id === siteA) pass('placing pays for the site', before - w.players[0].credits === 1200)
      }
      if (c.f === 'cancel' && c.a[0] === siteC && siteC) pass('a site called off halfway refunds the share not built', r === null && Math.abs(w.players[0].credits - before - cRefund) < 1e-6, `${Math.round(cRefund)} credits back`)
      if (c.f === 'cancel' && t === 120) pass('a site called off before work starts is refunded in full', r === null && w.players[0].credits - before === 1200, `${w.players[0].credits - before}`)
    })
    stepGround(b, ob)
    for (const e of w.events) {
      events[e.k] = (events[e.k] ?? 0) + 1
      if (e.k === 'started' && e.id === siteA) startedA = t
      if (e.k === 'built' && e.id === siteA) builtA = t
      if (e.k === 'trained' && e.from === home.id && rallyAt && !rallyUnit && t > 900) rallyUnit = e.id
      if (e.k === 'arrived' && e.id === rallyUnit && rallyAt && rallyOff < 0) {
        const u = w.byId.get(e.id)!
        rallyOff = Math.hypot(u.x - rallyAt.x, u.y - rallyAt.y)
      }
    }
    w.events.length = 0
    b.world.events.length = 0
    // While a site isn't started, only its owner sees it: it has no eye and no stamp.
    // Site A: how much it grew this tick for the engineers on it.
    const sA = w.byId.get(siteA)
    if (sA?.site) pass("siteProgress reports a site's share built", siteProgress(sA) === sA.site.work)
    if (sA?.site?.started) {
      const crew = w.units.filter((u) => u.busy === siteA).length
      const share = sA.site.work - (rates.get(-1) ?? 0)
      if (crew && sA.site.work > 0 && (rates.get(-1) ?? 0) > 0) rates.set(crew, share)
      rates.set(-1, sA.site.work)
    }
    if (sA && damagedAt >= 0 && repairedAt < 0 && sA.hull === typeOf(sA).hull) repairedAt = t
    const sB = w.byId.get(siteB)
    if (sB && sB.site && !sB.site.started) pass('an unstarted site has no stamp and sees nothing', !sB.stamped && !sB.eye)
    // The unit parked on site C is off its footprint within four seconds of the engineer arriving.
    const sC = w.byId.get(siteC)
    const pk = w.byId.get(parked)
    if (sC?.site && !sC.site.started && pk && footDist(sC, pk.x, pk.y) < typeOf(pk).radius) onSite = true
    if (onSite && sC?.site?.started && pk && sC.site.work > 0.1) pass('a unit standing on a site is pushed off when work starts', footDist(sC, pk.x, pk.y) >= typeOf(pk).radius - 1, `${(footDist(sC, pk.x, pk.y) / TILE).toFixed(2)} tiles off`)
    if ((t + 1) % 30 === 0) {
      const h = stateHash(w)
      hashes.push(h)
      if (drift < 0 && h !== stateHash(b.world)) drift = t + 1
    }
  }
  check(`building battle: two copies stay in step for ${ticks} ticks`, drift < 0, drift < 0 ? `final hash ${hashes[hashes.length - 1].toString(16)}` : `drifted by tick ${drift}`)
  // A replay from the inputs alone.
  {
    const c = start(dustfall())
    let q = 0
    let first = -1
    for (let t = 0; t < ticks; t++) {
      const oc: [number, GroundCmd][] = []
      while (q < inputs.length && inputs[q].t === t) apply(c, inputs[q++], oc)
      stepGround(c, oc)
      c.world.events.length = 0
      if ((t + 1) % 30 === 0 && first < 0 && stateHash(c.world) !== hashes[(t + 1) / 30 - 1]) first = (t + 1) / 30
    }
    check(`building battle: a copy rebuilt from the ${inputs.length} logged inputs matches every second`, first < 0, first < 0 ? '' : `differs at second ${first}`)
  }
  for (const [k, ok] of Object.entries(got)) if (k !== 'crew') check(`building battle: ${k}`, ok, notes.filter((n) => n.startsWith(k)).map((n) => n.slice(k.length + 2)).join('; '))
  const crews = [...rates.keys()].filter((k) => k > 0).sort()
  const rateOk = crews.length >= 2 && crews.every((n) => Math.abs(rates.get(n)! - (STEP * CREW_RATE[Math.min(n, 4)]) / 60) < 1e-9)
  check('building battle: a site gets built, as fast as its crew (1, 1.7, 2.2, 2.5 times)', builtA > 0 && rateOk, `${((builtA - startedA) * STEP).toFixed(1)} s; crews seen: ${crews.join(', ')}`)
  check('building battle: a damaged building is repaired to a whole hull', damagedAt > 0 && repairedAt > damagedAt, `${((repairedAt - damagedAt) * STEP).toFixed(1)} s from 40%`)
  check('building battle: a site was called off halfway', cRefund > 0 && !w.byId.get(siteC))
  check('building battle: a unit stood on a site before work started', onSite)
  check('building battle: a unit trained after a rally point is set drives to it', rallyOff >= 0 && rallyOff < TILE, rallyOff >= 0 ? `arrived ${(rallyOff / TILE).toFixed(2)} tiles from it` : 'never arrived')
  check('building battle: a destroyed building frees its stamp', !!removedFoot && footprintOpen(w.nav, removedFoot.tc, removedFoot.tr, 6, 6))
  check('building battle: a queue reports its progress', queueOf(home).progress >= 0 && queueOf(home).progress <= 1)
  // Income: a Command Center pays 6 a second.
  check('building battle: income counts each standing Command Center', w.players[0].income === 6 * w.units.filter((u) => u.owner === 0 && u.type === R.center && !u.site).length, `${w.players[0].income}/s`)
  // The AI on seat 1.
  const ai = w.units.filter((u) => u.owner === 1)
  const aiCenters = ai.filter((u) => u.type === SLICE_IDS.swarm.center && !u.site).length
  const aiEngs = ai.filter((u) => u.type === SLICE_IDS.swarm.engineer).length
  check('building battle: the passive AI trained engineers and expanded to a second Command Center', aiCenters >= 2 && aiEngs >= 3, `${aiCenters} Hive Nexuses, ${aiEngs} Shaper drones`)
  check('building battle: the AI built nothing but engineers and Command Centers', ai.every((u) => u.type === SLICE_IDS.swarm.center || u.type === SLICE_IDS.swarm.engineer))
  console.log(`  events: ${Object.entries(events).map(([k, n]) => `${n} ${k}`).join(', ')}`)
}

export function checkBuilding(check: Check, seconds = 150) {
  placementRules(check)
  buildingBattle(check, seconds)
}
