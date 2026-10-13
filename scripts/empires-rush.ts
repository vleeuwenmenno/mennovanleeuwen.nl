// Checks Empires At War's rush launch (Rushed construction), headless and deterministic:
//
//   node scripts/empires-rush.ts
//
// - The order is gated: by the research (which needs a Capital Yard), by the ship being built at
//   least RUSH.min, by the yard's cooldown; only a Capital Yard rushes.
// - The rushed ship comes out with its hull at the share that was built, no shields, and the right
//   number of turrets and modules not yet installed, which don't fire.
// - Ordinary repairs mend battle damage but never the unbuilt hull; a Drydock, repair craft or
//   engineers finish it at the build pace (more of them don't make it faster), its parts going on
//   one by one, so rushing never gets a ship out finished sooner.
// - After a rush the yard's next ship builds RUSH.slowdown slower, and the yard can't rush again for
//   RUSH.cooldown; the dev cheats' World.rushTune changes both.
// - The order goes through the protocol; save and restore stay in sync.
// - An AI admiral researches it and rushes when its base is under attack, not otherwise.
//
// Every check prints a line; it exits with 1 if any of them failed.

import { BUILD_RADIUS, RUSH, RUSH_TECH, yardOf, yardType } from '../src/apps/games/empires/data.ts'
import { MAPS } from '../src/apps/games/empires/maps.ts'
import { restoreWorld, snapshotWorld } from '../src/apps/games/empires/snapshot.ts'
import { cleanCmd, cmd, runCmd } from '../src/apps/games/empires/commands.ts'
import { newBrain, think } from '../src/apps/games/empires/ai.ts'
import {
  STEP, cantResearch, cantRush, cmdBuild, cmdConstruct, cmdPlace, cmdRush, hullCap, newWorld, placement, relevantGuns, rushShare, shieldMax, spawn, spawnGroup, stateHash, tick, yardsOf,
  type Unit, type World,
} from '../src/apps/games/empires/sim.ts'

let failed = 0
const check = (what: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `: ${detail}` : ''}`)
  if (!ok) failed++
}
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol

const map = MAPS.find((m) => m.spawns.length === 2) ?? MAPS[0]
const fresh = (): World => {
  const w = newWorld(map, [
    { faction: 'republic', team: 0, spawn: 0 },
    { faction: 'droid', team: 1, spawn: 1 },
  ], { seed: 57, credits: 80000 })
  for (const p of w.players) p.level = 4
  return w
}
const run = (w: World, secs: number, until?: () => boolean) => {
  for (let t = 0; t < secs / STEP; t++) {
    tick(w)
    w.events.length = 0
    if (until?.()) return true
  }
  return false
}
const st = (w: World, o = 0) => w.byId.get(w.players[o].station)!
const ids = (us: Unit[]) => us.map((u) => u.id)
const spotFor = (w: World, id: string, o = 0) => {
  const s = st(w, o)
  const away = Math.atan2(s.y - w.h / 2, s.x - w.w / 2)
  for (let d = 500; d < BUILD_RADIUS; d += 100)
    for (const off of [0, 0.5, -0.5, 1, -1, 1.5, -1.5, 2, -2, 2.6, -2.6, 3.1]) {
      const x = s.x + Math.cos(away + off) * d
      const y = s.y + Math.sin(away + off) * d
      if (!placement(w, o, id, x, y).why) return { x, y }
    }
  throw new Error(`no spot for ${id}`)
}
/** A Capital Yard put up by three squadrons of engineers, run until it stands; the crews kept. */
const capitalYard = (w: World, o = 0): { y: Unit; crew: Unit[] } => {
  const id = yardOf(w.players[o].faction, 'cyard').id
  const spot = spotFor(w, id, o)
  const s = st(w, o)
  const crew = Array.from({ length: 3 }, (_, i) => spawnGroup(w, `${o ? 'd' : 'r'}-engineer`, o, s.x + 250, s.y + 60 * i, 0)).flat()
  const why = cmdPlace(w, o, ids(crew), id, spot.x, spot.y)
  if (why) throw new Error(`placing ${id}: ${why}`)
  run(w, 200, () => yardsOf(w, o).some((u) => u.t.id === id))
  return { y: yardsOf(w, o).find((u) => u.t.id === id)!, crew }
}
const researched = (w: World, o = 0) => {
  const p = w.players[o]
  if (!p.techs.includes(RUSH_TECH[p.faction])) p.techs.push(RUSH_TECH[p.faction])
}
/** Our newest cruiser on the field (the rushed one, once it has jumped in). */
const newest = (w: World, id: string, o = 0) => w.units.filter((u) => !u.dead && u.owner === o && u.t.id === id).sort((a, b) => b.id - a.id)[0]

// --- Gating --------------------------------------------------------------------------------------------------
{
  const w = fresh()
  const p = w.players[0]
  const tech = RUSH_TECH.republic
  check('the research needs a Capital Yard', cantResearch(w, 0, tech) === 'Needs a Capital Yard', String(cantResearch(w, 0, tech)))
  const { y, crew } = capitalYard(w)
  check('with one standing, it can be researched', cantResearch(w, 0, tech) === null, String(cantResearch(w, 0, tech)))
  for (const c of crew) c.dead = true
  check('cruisers can be ordered at the Capital Yard', cmdBuild(w, 0, 'r-cruiser', false, y.id) === null)
  run(w, 1)
  check('without the research, no rush', cantRush(w, 0, y.id) === 'Needs Rushed construction', String(cantRush(w, 0, y.id)))
  p.techs.push(tech)
  check('researched, but under half built: no rush', /^Not 50% built yet/.test(cantRush(w, 0, y.id) ?? ''), String(cantRush(w, 0, y.id)))
  const fyId = yardOf('republic', 'yard').id
  const fy = spawn(w, fyId, 0, y.x + 3000, y.y, 0)
  fy.yq = [{ unit: 'r-frigate', left: 1, total: 22 }]
  check('a Frigate Yard can\'t rush', cantRush(w, 0, fy.id) === 'Only a Capital Yard can rush a launch')
  check('the enemy can\'t rush our yard', cantRush(w, 1, y.id) !== null)
  y.yq![0].left = y.yq![0].total * 0.38
  const share = rushShare(y)
  check('at 62% built it can rush', cantRush(w, 0, y.id) === null && near(share, 0.62, 0.01), `${(share * 100).toFixed(1)}%: ${cantRush(w, 0, y.id)}`)
  // Through the protocol, as a multiplayer order.
  const c = cleanCmd(JSON.parse(JSON.stringify(cmd('rush', y.id))), w)
  check('the order survives the wire', !!c && c.f === 'rush')
  check('a malformed order is refused', cleanCmd({ f: 'rush', a: ['x'] }, w) === null)
  const left = y.yq![0].left
  check('rushing it works', runCmd(w, 0, c!) === null && y.yq!.length === 0)
  check('the yard can\'t rush again at once', /^Nothing being built|^Ready again/.test(cantRush(w, 0, y.id) ?? ''))
  run(w, 8, () => !!newest(w, 'r-cruiser'))
  const u = newest(w, 'r-cruiser')
  check('the rushed cruiser jumps in', !!u)
  if (u) {
    check('its hull is the share that was built', near(u.hull / u.hullMax, share, 0.01), `${((u.hull / u.hullMax) * 100).toFixed(1)}%`)
    check('its shields start empty', u.shield < shieldMax(u) * 0.1, `${u.shield.toFixed(0)} of ${shieldMax(u).toFixed(0)}`)
    const parts = u.t.hardpoints.filter((h) => h.kind !== 'engine').length
    const off = u.rush?.parts.length ?? 0
    check('the unbuilt share of its turrets and modules is not yet installed', off === Math.round(parts * (1 - share)), `${off} of ${parts}`)
    check('they don\'t fire', u.rush!.parts.every((i) => u.hps[i].hp === 0) && relevantGuns(u, 'cruiser').every((g) => !u.rush!.parts.includes(g.hp)))
    check('its finishing takes what was left of its build', near(u.rush!.total, left, 0.05), `${u.rush!.total.toFixed(1)} s`)
    // Nobody working on it: nothing happens.
    const h0 = u.hull
    run(w, 5)
    check('left alone, it is not finished', u.rush!.left === u.rush!.total && u.hull === h0)
  }
  // The cooldown and the slowdown.
  check('a ship ordered after the rush builds slower', cmdBuild(w, 0, 'r-cruiser', false, y.id) === null)
  run(w, 10)
  const q = y.yq![0]
  const done = q.total - q.left
  check('it is marked slow and goes 25% slower', !!q.slow && near(done, 10 / (1 + RUSH.slowdown), 0.2), `${done.toFixed(2)} s of work in 10 s`)
  run(w, q.total, () => rushShare(y) >= 0.5)
  check('at 50% again, the cooldown still holds', /^Ready again in/.test(cantRush(w, 0, y.id) ?? ''), String(cantRush(w, 0, y.id)))
  // Kept half built (a long build), until the cooldown has run out.
  y.yq = [{ unit: 'r-cruiser', left: 1e5, total: 2e5 }]
  run(w, RUSH.cooldown, () => cantRush(w, 0, y.id) === null)
  check('after the cooldown it can rush again', cantRush(w, 0, y.id) === null, String(cantRush(w, 0, y.id)))
  // The dev cheats' numbers.
  w.rushTune = { min: 0.9, cooldown: 10, slowdown: 1 }
  check('the dev cheats\' minimum applies', /^Not 90% built yet/.test(cantRush(w, 0, y.id) ?? ''), String(cantRush(w, 0, y.id)))
}

// --- Repairs and finishing ----------------------------------------------------------------------------------
/** A world with a Capital Yard (a Drydock fitted when asked) and a cruiser rushed out of it at `share`. */
const rushed = (share = 0.5, drydock = false) => {
  const w = fresh()
  const { y, crew } = capitalYard(w)
  for (const c of crew) c.dead = true
  researched(w)
  if (drydock) {
    // The Frigate Yard's Drydock, beside the Capital Yard.
    const fy = spawn(w, yardOf('republic', 'yard').id, 0, y.x, y.y + 900, 0)
    fy.yq = []
    fy.xm = ['drydock']
    fy.t = yardType(fy.t.id, fy.xm)
    fy.hps = fy.t.hardpoints.map((h) => ({ hp: h.hp, max: h.hp }))
  }
  cmdBuild(w, 0, 'r-cruiser', false, y.id)
  run(w, 1)
  y.yq![0].left = y.yq![0].total * (1 - share)
  cmdRush(w, 0, y.id)
  run(w, 8, () => !!newest(w, 'r-cruiser'))
  return { w, y, u: newest(w, 'r-cruiser') }
}
{
  // Ordinary repairs: a support corvette mends battle damage, never the unbuilt hull.
  const { w, u } = rushed(0.6)
  const cap = hullCap(u)
  check('its hull cap is the built share', near(cap / u.hullMax, 0.6, 0.01), `${((cap / u.hullMax) * 100).toFixed(1)}%`)
  u.hull = cap * 0.7
  spawn(w, 'r-corvette', 0, u.x + 120, u.y, 0)
  run(w, 60)
  check('a repair tender mends it up to the cap and no further', near(u.hull, cap, 1) && !!u.rush, `${u.hull.toFixed(0)} of cap ${cap.toFixed(0)}`)
  check('and doesn\'t finish it', u.rush!.left === u.rush!.total)
}
{
  // Engineers finish it at the build pace; three squadrons are no faster than one.
  const one = rushed(0.5)
  const three = rushed(0.5)
  const crewOf = (x: typeof one, n: number) => Array.from({ length: n }, (_, i) => spawnGroup(x.w, 'r-engineer', 0, x.u.x + 200, x.u.y + 50 * i, 0)).flat()
  const c1 = crewOf(one, 1)
  const c3 = crewOf(three, 3)
  check('engineers take the order', cmdConstruct(one.w, 0, ids(c1), one.u.id) === null && cmdConstruct(three.w, 0, ids(c3), three.u.id) === null)
  const total = one.u.rush!.total
  const parts0 = one.u.rush!.parts.length
  let firstPart = -1
  const t0 = one.w.time
  run(one.w, total * 3, () => {
    if (firstPart < 0 && (one.u.rush?.parts.length ?? 0) < parts0) firstPart = one.w.time - t0
    return !one.u.rush
  })
  const t1 = one.w.time - t0
  const t3s = three.w.time
  run(three.w, total * 3, () => !three.u.rush)
  const t3 = three.w.time - t3s
  check('engineers finish it', !one.u.rush && one.u.hull >= one.u.hullMax - 1 && one.u.hps.every((h) => h.hp > 0), `${one.u.hull.toFixed(0)} of ${one.u.hullMax.toFixed(0)}`)
  check('in about its remaining build time, plus the flight over', t1 >= total && t1 <= total + 20, `${t1.toFixed(1)} s for ${total.toFixed(1)} s of build`)
  check('three squadrons are no faster than one', Math.abs(t3 - t1) < 8, `${t3.toFixed(1)} s vs ${t1.toFixed(1)} s`)
  check('its parts go on one by one as it is finished', firstPart > 0 && firstPart < t1 - 1, `first after ${firstPart.toFixed(1)} s`)
}
{
  // A Drydock finishes it too, at the build pace, and its 2.5%/s never fills the unbuilt hull.
  const { w, u } = rushed(0.5, true)
  const fy = w.units.find((x) => x.t.id === 'r-yard')!
  u.x = fy.x + 200
  u.y = fy.y
  u.order = { k: 'idle' }
  const total = u.rush!.total
  const h0 = u.hull
  const gap0 = u.rush!.gap
  run(w, 4)
  check('in the Drydock it gets on with being finished', u.rush!.left < total - 3 && u.rush!.left > total - 5, `${(total - u.rush!.left).toFixed(1)} s done in 4 s`)
  check('its hull grows by the share of its build finished, and no more', near(u.hull - h0, (gap0 * 4) / total, 15), `+${(u.hull - h0).toFixed(0)}, ${((gap0 * 4) / total).toFixed(0)} of build`)
  run(w, total + 5, () => !u.rush)
  check('the Drydock finishes it', !u.rush && u.hps.every((h) => h.hp > 0))
}
{
  // Repair craft (Field repair) finish it as well.
  const { w, u } = rushed(0.5)
  researched(w)
  w.players[0].techs.push('r-re-wing')
  const crew = spawnGroup(w, 'r-repair', 0, u.x + 100, u.y, 0)
  const total = u.rush!.total
  run(w, 3)
  check('idle repair craft pick it up and finish it', u.rush ? u.rush.left < total : true, u.rush ? `${(total - u.rush.left).toFixed(1)} s done` : 'finished')
  for (const c of crew) c.dead = true
}

// --- Save and restore -------------------------------------------------------------------------------------
{
  const a = rushed(0.55).w
  const u = newest(a, 'r-cruiser')
  spawnGroup(a, 'r-engineer', 0, u.x + 200, u.y, 0).forEach((e) => (e.order = { k: 'construct', id: u.id }))
  run(a, 5)
  const b = restoreWorld(snapshotWorld(a))!
  run(a, 20)
  run(b, 20)
  check('a battle with a rushed ship restores and stays in sync', stateHash(a) === stateHash(b), stateHash(a).toString(16))
}

// --- The AI -----------------------------------------------------------------------------------------------
{
  // An AI with a Capital Yard, the research and a cruiser over half built: it doesn't rush in peace...
  const peace = fresh()
  const { y } = capitalYard(peace, 1)
  for (const c of peace.units.filter((u) => u.owner === 1 && u.t.kind === 'engineer')) c.dead = true
  researched(peace, 1)
  const b = newBrain(1, 'hard', 'defensive')
  peace.players[1].credits = 0
  y.yq = [{ unit: 'd-cruiser', left: 10, total: 33 }]
  for (let i = 0; i < 6 / STEP; i++) {
    think(peace, b, STEP)
    tick(peace)
    peace.events.length = 0
  }
  check('in peace the AI lets its cruiser finish', !peace.units.some((u) => u.t.id === 'd-cruiser' && u.rush) && (y.yq?.length === 0 || (y.yq?.[0].left ?? 0) < 10))
  // ...but with enemy warships at its base, it rushes it out.
  const war = fresh()
  const z = capitalYard(war, 1).y
  for (const c of war.units.filter((u) => u.owner === 1 && u.t.kind === 'engineer')) c.dead = true
  researched(war, 1)
  war.players[1].credits = 0
  z.yq = [{ unit: 'd-cruiser', left: 15, total: 33 }]
  const s1 = st(war, 1)
  for (let i = 0; i < 4; i++) spawn(war, 'r-cruiser', 0, s1.x + 700 + i * 200, s1.y + 300, Math.PI)
  const b2 = newBrain(1, 'hard', 'balanced')
  let rushedIt = false
  for (let i = 0; i < 10 / STEP && !rushedIt; i++) {
    think(war, b2, STEP)
    tick(war)
    rushedIt = war.events.some((e) => e.k === 'rushed' && e.owner === 1) || war.arrivals.some((a) => a.owner === 1 && !!a.rush)
    war.events.length = 0
  }
  check('under attack at its base, the AI rushes its cruiser out', rushedIt)
}

console.log(failed ? `\n${failed} check(s) failed` : '\nAll rush launch checks passed')
if (failed) process.exit(1)
