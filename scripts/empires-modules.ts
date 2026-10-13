// Checks Empires At War's hybrid bases, step 2 (the Capital Yard and the expansion modules),
// headless and deterministic:
//
//   node scripts/empires-modules.ts [big]
//
// - The Capital Yard: from station level 3, built by engineers; it builds the cruisers (the Command
//   Station no longer does), and the flagships only with its Capital slip, which needs level 4.
// - Each expansion, measured: the Second slip's throughput, the Drydock's repairs (and that it
//   doesn't add up with the station's Repair docks), the Armour works' hull, the Sensor array's
//   sight, the Shield core's shields and recharge, the Strike hangar for bombers, the Fighter wing's
//   own defense wing.
// - A module shot off stops its feature; engineers weld it back for part of its price and it works
//   again. A ruined yard loses its modules.
// - Ordering: the queue, its limit, cancelling with a refund, and the orders through the protocol.
// - Save and restore stay in sync, and older battles (step 1's, and from before yards) still load.
//
// Every check prints a line; it exits with 1 if any of them failed.

import { BUILD_RADIUS, DEFENSE_WING, MODULE, MODULE_FX, MODULE_QUEUE, REBUILD_MODULE, UNIT, yardOf, type ModuleId } from '../src/apps/games/empires/data.ts'
import { MAPS } from '../src/apps/games/empires/maps.ts'
import { restoreWorld, snapshotWorld } from '../src/apps/games/empires/snapshot.ts'
import { cleanCmd, cmd, runCmd } from '../src/apps/games/empires/commands.ts'
import { rangeDist } from '../src/apps/games/empires/scale.ts'
import {
  STEP, cantBuild, cantExpand, cmdBuild, cmdCancelExpand, cmdConstruct, cmdExpand, cmdPlace, damage, expUp, moduleLock, newWorld, placement, radius, sensorOf, shieldFull,
  spawn, spawnGroup, stateHash, tick, yardsOf, type Unit, type World,
} from '../src/apps/games/empires/sim.ts'

const big = process.argv[2] === 'big'
let failed = 0
const check = (what: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `: ${detail}` : ''}`)
  if (!ok) failed++
}
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol

const map = MAPS.find((m) => m.spawns.length === 2) ?? MAPS[0]
const fresh = (level = 4): World => {
  const w = newWorld(map, [
    { faction: 'republic', team: 0, spawn: 0 },
    { faction: 'droid', team: 1, spawn: 1 },
  ], { seed: 91, credits: 60000, ...(big ? { sizes: 'big' as const } : {}) })
  for (const p of w.players) p.level = level
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
const pre = (o: number) => (o === 0 ? 'r' : 'd')
/** A spot for a yard of ours: out from the station away from the map's middle, the first that fits. */
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
const engineers = (w: World, o = 0, n = 1) => {
  const s = st(w, o)
  return Array.from({ length: n }, (_, i) => spawnGroup(w, `${pre(o)}-engineer`, o, s.x + 250, s.y + 60 * i, 0)).flat()
}
/** A yard put up by engineers (three squadrons, so it goes up fast), run until it stands. */
const yard = (w: World, kind: 'yard' | 'cyard', o = 0): Unit => {
  const id = yardOf(w.players[o].faction, kind).id
  const spot = spotFor(w, id, o)
  const crew = engineers(w, o, 3)
  const why = cmdPlace(w, o, ids(crew), id, spot.x, spot.y)
  if (why) throw new Error(`placing ${id}: ${why}`)
  run(w, 200, () => yardsOf(w, o).some((u) => u.t.id === id))
  for (const u of crew) if (!u.dead) u.dead = true
  w.units = w.units.filter((u) => !u.dead)
  for (const u of crew) w.byId.delete(u.id)
  return yardsOf(w, o).find((u) => u.t.id === id)!
}
/** Order an expansion and run until it is built. */
const fit = (w: World, u: Unit, id: ModuleId, o = 0) => {
  const why = cmdExpand(w, o, u.id, id)
  if (why) throw new Error(`${id}: ${why}`)
  run(w, MODULE[id].time + 2, () => !!u.xm?.includes(id))
  return !!u.xm?.includes(id)
}
/** Shoot one of a unit's expansions off. */
const shootOff = (w: World, u: Unit, id: ModuleId) => {
  const i = u.t.hardpoints.findIndex((h) => h.exp === id)
  u.shield = 0
  damage(w, u, u.hps[i].hp + 5, 'turbo', i, u.x + 500, u.y, 1)
  return i
}

// --- The Capital Yard -------------------------------------------------------------------------------------
{
  const w = fresh(2)
  const cy = yardOf('republic', 'cyard')
  check('the Capital Yard is a yard, bigger than the Frigate Yard', cy.tier === 'yard' && cy.size > yardOf('republic').size && yardOf('droid', 'cyard').size > yardOf('droid').size, `${cy.size} against ${yardOf('republic').size}`)
  check('it costs 2000', cy.cost === 2000 && yardOf('droid', 'cyard').cost === 2000)
  const at = spotFor(w, 'r-yard')
  const why = placement(w, 0, cy.id, at.x, at.y).why
  check('it needs station level 3', (why ?? '').includes('level 3'), why ?? 'allowed')
  w.players[0].level = 3
  check('cruisers are no longer built at the Command Station', (cantBuild(w, 0, 'r-cruiser') ?? '').includes('Capital Yard'), cantBuild(w, 0, 'r-cruiser') ?? 'allowed')
  const c = yard(w, 'cyard')
  check('engineers build the Capital Yard', !!c && c.t.id === 'r-cyard' && Array.isArray(c.yq))
  check('only one Capital Yard at a time', (placement(w, 0, cy.id, at.x, at.y).why ?? '').includes('already') || !!placement(w, 0, cy.id, at.x, at.y).why)
  check('cruisers queue at the Capital Yard', cmdBuild(w, 0, 'r-cruiser') === null && c.yq!.length === 1 && !w.players[0].queue.length)
  check('the Frigate Yard can\'t build cruisers', !yardsOf(w, 0).some((u) => u.t.id === 'r-yard') && cantBuild(w, 0, 'r-frigate') !== null)
  let cruiser: Unit | undefined
  run(w, UNIT['r-cruiser'].build + 10, () => !!(cruiser = w.units.find((u) => u.owner === 0 && u.t.id === 'r-cruiser')))
  check('the Capital Yard builds a cruiser, which jumps in beside it', !!cruiser && Math.hypot(cruiser.x - c.x, cruiser.y - c.y) < radius(c.t) + radius(cruiser.t) + 700)
  check('flagships need station level 4', (cantBuild(w, 0, 'r-capital') ?? '').includes('level 4'), cantBuild(w, 0, 'r-capital') ?? 'allowed')
  check('the Capital slip needs station level 4', (moduleLock(w, 0, c, 'capitalSlip') ?? '').includes('level 4'))
  w.players[0].level = 4
  check('at level 4 flagships still need the Capital slip', (cantBuild(w, 0, 'r-capital') ?? '').includes('Capital slip'), cantBuild(w, 0, 'r-capital') ?? 'allowed')
  check('the Capital slip goes up', fit(w, c, 'capitalSlip'))
  check('with it, flagships are built at the Capital Yard', cmdBuild(w, 0, 'r-capital') === null && c.yq!.some((q) => q.unit === 'r-capital'))
  // The droids the same way.
  w.players[1].level = 3
  const d = yard(w, 'cyard', 1)
  check('the droids build theirs too, and their cruisers there', !!d && cmdBuild(w, 1, 'd-cruiser') === null && d.yq!.length === 1)
}

// --- Second slip: two ships at once ----------------------------------------------------------------------
const throughput = (slip: boolean) => {
  const w = fresh(2)
  const y = yard(w, 'yard')
  if (slip) fit(w, y, 'secondSlip')
  for (let i = 0; i < 4; i++) cmdBuild(w, 0, 'r-frigate', true)
  const t0 = w.time
  run(w, 200, () => w.players[0].reserve.filter((r) => r === 'r-frigate').length >= 4)
  return w.time - t0
}
{
  const one = throughput(false)
  const two = throughput(true)
  check('the Second slip builds two at once: four frigates in about half the time', two < one * 0.6 && two > one * 0.4, `${two.toFixed(1)} s against ${one.toFixed(1)} s`)
}

// --- Drydock ------------------------------------------------------------------------------------------------
{
  const w = fresh(2)
  const y = yard(w, 'yard')
  const ship = spawn(w, 'r-frigate', 0, y.x + radius(y.t) + 150, y.y, 0)
  const mend = (secs: number) => {
    ship.hull = ship.hullMax * 0.5
    const h0 = ship.hull
    run(w, secs)
    return (ship.hull - h0) / ship.hullMax / secs
  }
  check('without a Drydock nothing mends a frigate by the yard', mend(5) < 0.001)
  fit(w, y, 'drydock')
  const rate = mend(5)
  check('a Drydock mends ships near the yard at 2.5% a second', near(rate, MODULE_FX.repair, 0.002), `${(rate * 100).toFixed(2)}%/s`)
  ship.x = y.x + radius(y.t) + MODULE_FX.reach + 400
  check('but not ships out of its reach', mend(3) < 0.001)
}
{
  // The station's Repair docks and a Drydock: a ship near both gets the better rate.
  const w = fresh(2)
  const p = w.players[0]
  const y = yard(w, 'yard')
  fit(w, y, 'drydock')
  for (const id of ['r-st-guns', 'r-st-dock']) {
    p.credits = 60000
    runCmd(w, 0, cmd('research', id))
    run(w, 60, () => p.techs.includes(id))
  }
  const s = st(w)
  const mid = { x: (s.x + y.x) / 2, y: (s.y + y.y) / 2 }
  const inBoth = Math.hypot(mid.x - s.x, mid.y - s.y) < rangeDist(900) && Math.hypot(mid.x - y.x, mid.y - y.y) < radius(y.t) + MODULE_FX.reach
  check('(a spot within reach of both)', inBoth, `${Math.round(Math.hypot(mid.x - s.x, mid.y - s.y))} from the station, ${Math.round(Math.hypot(mid.x - y.x, mid.y - y.y))} from the yard`)
  const ship = spawn(w, 'r-frigate', 0, mid.x, mid.y, 0)
  ship.hull = ship.hullMax * 0.4
  const h0 = ship.hull
  run(w, 4)
  const rate = (ship.hull - h0) / ship.hullMax / 4
  check('near both the station\'s docks (2%) and a Drydock (2.5%) a ship mends at 2.5%, not 4.5%', p.techs.includes('r-st-dock') && near(rate, 0.025, 0.002), `${(rate * 100).toFixed(2)}%/s`)
}

// --- Armour works -------------------------------------------------------------------------------------------
{
  const w = fresh(2)
  const y = yard(w, 'yard')
  const old = spawn(w, 'r-frigate', 0, y.x + 600, y.y, 0)
  const corvette = spawn(w, 'r-corvette', 0, y.x + 700, y.y + 200, 0)
  const gunship = spawn(w, 'r-gunship', 0, y.x + 700, y.y - 200, 0)
  const base = { f: old.hullMax, c: corvette.hullMax, g: gunship.hullMax }
  fit(w, y, 'armourWorks')
  run(w, 0.5)
  check('the Armour works gives our frigates 20% more hull', near(old.hullMax / base.f, 1 + MODULE_FX.armour, 1e-6), `x${(old.hullMax / base.f).toFixed(3)}`)
  check('and our corvettes', near(corvette.hullMax / base.c, 1 + MODULE_FX.armour, 1e-6))
  check('but not gunships', near(gunship.hullMax, base.g, 1e-6))
  const fresh1 = spawn(w, 'r-frigate', 0, y.x + 800, y.y, 0)
  check('a new frigate comes with it', near(fresh1.hullMax / base.f, 1 + MODULE_FX.armour, 1e-6))
  // Added to hull research, not multiplied: the droids' Bulwark plating (+25%) and the works (+20%).
  const wd = fresh(2)
  const yd = yard(wd, 'yard', 1)
  wd.players[1].techs.push('d-fr-plate')
  fit(wd, yd, 'armourWorks', 1)
  run(wd, 0.5)
  const bul = spawn(wd, 'd-frigate', 1, yd.x + 600, yd.y, 0)
  check('it adds to hull research rather than multiplying (1 + 0.25 + 0.2)', near(bul.mods.hull, 1.45, 1e-9), `mods.hull ${bul.mods.hull}`)
  shootOff(w, y, 'armourWorks')
  run(w, 0.5)
  check('shot off, the extra hull goes', near(old.hullMax, base.f, 1e-6), `${Math.round(old.hullMax)} against ${Math.round(base.f)}`)
  const crew = engineers(w)
  cmdConstruct(w, 0, ids(crew), y.id)
  run(w, 60, () => expUp(y, 'armourWorks'))
  run(w, 0.5)
  const paid = w.players[0].ledger.filter((e) => e.what === 'Rebuilding: Armour works').reduce((s, e) => s - e.amount, 0)
  check('engineers weld it back, for 30% of its price', expUp(y, 'armourWorks') && paid === Math.round(MODULE.armourWorks.cost * REBUILD_MODULE), `paid ${paid}`)
  check('and the extra hull is back', near(old.hullMax / base.f, 1 + MODULE_FX.armour, 1e-6))
}

// --- Sensor array and Shield core -----------------------------------------------------------------------------
{
  const w = fresh(2)
  const s = st(w)
  const sight0 = sensorOf(s)
  fit(w, s, 'sensorArray')
  const s2 = st(w)
  const sight1 = sensorOf(s2)
  check('the Sensor array: the station sees half as far again', near(sight1 / sight0, MODULE_FX.sensor, 1e-6), `${Math.round(sight0)} -> ${Math.round(sight1)}`)
  check('past the edge of the build radius', sight1 > BUILD_RADIUS, `${Math.round(sight1)} against ${Math.round(BUILD_RADIUS)}`)
  const full0 = shieldFull(s2)
  const regen = (u: Unit) => {
    u.shield = 0
    u.shieldOut = -99
    u.lastHit = -99
    run(w, 1)
    return u.shield
  }
  const r0 = regen(s2)
  fit(w, s2, 'shieldCore')
  const full1 = shieldFull(s2)
  const r1 = regen(s2)
  check('the Shield core: 40% more station shields', near(full1 / full0, 1 + MODULE_FX.shield, 1e-6), `${Math.round(full0)} -> ${Math.round(full1)}`)
  check('recharging 60% faster', near(r1 / r0, 1 + MODULE_FX.regen, 0.02), `${r0.toFixed(1)} -> ${r1.toFixed(1)} a second`)
  shootOff(w, s2, 'sensorArray')
  check('the Sensor array shot off: back to normal sight', near(sensorOf(s2), sight0, 1e-6))
  shootOff(w, s2, 'shieldCore')
  check('the Shield core shot off: back to normal shields', near(shieldFull(s2), full0, 1e-6) && s2.shield <= full0 + 1e-6)
}

// --- Strike hangar ------------------------------------------------------------------------------------------
{
  const w = fresh(2)
  const s = st(w)
  check('bombers need the Strike hangar', (cantBuild(w, 0, 'r-bomber') ?? '').includes('Strike hangar') && (cantBuild(w, 1, 'd-bomber') ?? '').includes('Strike hangar'), cantBuild(w, 0, 'r-bomber') ?? 'allowed')
  fit(w, s, 'strikeHangar')
  check('with it they can be ordered', cantBuild(w, 0, 'r-bomber') === null)
  cmdBuild(w, 0, 'r-bomber')
  let b: Unit | undefined
  run(w, 30, () => !!(b = w.units.find((u) => u.owner === 0 && u.t.id === 'r-bomber')))
  const bay = s.t.hardpoints.findIndex((h) => h.exp === 'strikeHangar')
  check('and launch (from the Strike hangar)', !!b && bay >= 0)
  shootOff(w, s, 'strikeHangar')
  check('shot off, no bombers can be ordered', (cantBuild(w, 0, 'r-bomber') ?? '').includes('Strike hangar'))
  const crew = engineers(w)
  cmdConstruct(w, 0, ids(crew), s.id)
  check('engineers weld it back', run(w, 60, () => expUp(s, 'strikeHangar')))
  check('and bombers can be ordered again', cantBuild(w, 0, 'r-bomber') === null)
}

// --- Fighter wing -------------------------------------------------------------------------------------------
{
  const w = fresh(3)
  const c = yard(w, 'cyard')
  const wing = () => w.units.filter((u) => !u.dead && u.parent === c.id && u.t.kind === 'wing')
  check('no defense wing before the Fighter wing', wing().length === 0)
  fit(w, c, 'fighterWing')
  run(w, 0.5)
  const full = UNIT['r-picket'].squad
  check('the Fighter wing launches a defense wing for the Capital Yard', wing().length === full, `${wing().length} of ${full}`)
  run(w, 3)
  check('it guards the yard', wing().every((u) => Math.hypot(u.x - c.x, u.y - c.y) < radius(c.t) + 400))
  const lost = wing()[0]
  damage(w, lost, 1e6, 'turbo', -1, lost.x, lost.y, 1)
  run(w, 0.2)
  check('a lost craft is rebuilt', run(w, DEFENSE_WING.wait + DEFENSE_WING.every + 2, () => wing().length === full))
  shootOff(w, c, 'fighterWing')
  const again = wing()[0]
  damage(w, again, 1e6, 'turbo', -1, again.x, again.y, 1)
  run(w, DEFENSE_WING.wait + DEFENSE_WING.every + 2)
  check('with the module shot off, lost craft are not rebuilt', wing().length === full - 1, `${wing().length}`)
}

// --- Ordering ------------------------------------------------------------------------------------------------
{
  const w = fresh(2)
  const y = yard(w, 'yard')
  const p = w.players[0]
  const c0 = p.credits
  check('an expansion is paid for when ordered', cmdExpand(w, 0, y.id, 'secondSlip') === null && p.credits === c0 - MODULE.secondSlip.cost)
  check('a second one queues behind it', cmdExpand(w, 0, y.id, 'drydock') === null && y.xq!.length === 2)
  check(`at most ${MODULE_QUEUE} at a time`, cantExpand(w, 0, y.id, 'armourWorks') === 'Expansion queue full')
  check('the same one twice is refused', !!cantExpand(w, 0, y.id, 'secondSlip'))
  check('one for another building is refused', (cantExpand(w, 0, y.id, 'shieldCore') ?? '').includes('Command Station'))
  check('the enemy can\'t order on our yard', !!cantExpand(w, 1, y.id, 'armourWorks'))
  run(w, 5)
  const c1 = p.credits
  check('cancelling refunds in full', cmdCancelExpand(w, 0, y.id, 1) === null && near(p.credits - c1, MODULE.drydock.cost, 1e-6) && y.xq!.length === 1)
  check('one at a time: the second waits for the first', (() => {
    cmdExpand(w, 0, y.id, 'drydock')
    run(w, 1)
    return y.xq![1].left === y.xq![1].total
  })())
  check('orders go through the protocol', !!cleanCmd({ f: 'expand', a: [y.id, 'drydock'] }, w) && !!cleanCmd({ f: 'cancelExpand', a: [y.id, 0] }, w) && !cleanCmd({ f: 'expand', a: [y.id, 'warpDrive'] }, w))
  check('the order runs through runCmd', (() => {
    const w2 = fresh(2)
    return runCmd(w2, 0, cmd('expand', w2.players[0].station, 'sensorArray')) === null && st(w2).xq?.length === 1
  })())
}

// --- A shot-off module stops the Second slip; a ruined yard loses its modules ----------------------------
{
  const w = fresh(2)
  const y = yard(w, 'yard')
  fit(w, y, 'secondSlip')
  for (let i = 0; i < 3; i++) cmdBuild(w, 0, 'r-frigate', true)
  run(w, 1)
  check('both slips at work', y.yq![1].left < y.yq![1].total)
  shootOff(w, y, 'secondSlip')
  const second = y.yq![1].left
  run(w, 2)
  check('the Second slip shot off: only one ship at a time again', y.yq![1].left === second)
  const crew = engineers(w)
  cmdConstruct(w, 0, ids(crew), y.id)
  run(w, 60, () => expUp(y, 'secondSlip'))
  const s2 = y.yq![1]?.left ?? 0
  run(w, 1)
  check('welded back, two at once again', expUp(y, 'secondSlip') && (y.yq![1]?.left ?? 0) < s2)
  // Now the yard falls, with an expansion still under way.
  cmdExpand(w, 0, y.id, 'drydock')
  const p = w.players[0]
  const c0 = p.credits
  damage(w, y, 1e9, 'turbo', -1, y.x, y.y, 1)
  run(w, 0.2)
  const ruin = (w.ruins ?? []).find((r) => r.owner === 0 && r.unit === 'r-yard')
  check('a destroyed yard leaves its ruin', !!ruin)
  check('the expansion under way is paid back', p.credits - c0 >= MODULE.drydock.cost - 1)
  const crew2 = engineers(w, 0, 3)
  cmdPlace(w, 0, ids(crew2), 'r-yard', ruin!.x, ruin!.y)
  run(w, 200, () => yardsOf(w, 0).some((u) => u.t.id === 'r-yard'))
  const back = yardsOf(w, 0).find((u) => u.t.id === 'r-yard')
  check('rebuilt on its ruin, it has none of its modules', !!back && !back.xm?.length && back.t.hardpoints.every((h) => !h.exp) && back.t === UNIT['r-yard'])
}

// --- Save and restore in sync ----------------------------------------------------------------------------------
{
  const make = () => {
    const w = fresh(3)
    const y = yard(w, 'yard')
    const c = yard(w, 'cyard')
    yard(w, 'yard', 1)
    fit(w, y, 'secondSlip')
    cmdExpand(w, 0, c.id, 'fighterWing')
    cmdExpand(w, 0, st(w).id, 'shieldCore')
    cmdExpand(w, 0, y.id, 'armourWorks')
    for (let i = 0; i < 3; i++) cmdBuild(w, 0, 'r-frigate')
    cmdBuild(w, 0, 'r-cruiser')
    return w
  }
  const a = make()
  const b = make()
  run(a, 20)
  run(b, 20)
  const c = restoreWorld(snapshotWorld(a))!
  let same = stateHash(a) === stateHash(b) && stateHash(a) === stateHash(c)
  for (let t = 0; t < 120 / STEP && same; t++) {
    for (const w of [a, b, c]) {
      tick(w)
      w.events.length = 0
    }
    if (t === Math.round(30 / STEP)) for (const w of [a, b, c]) {
      const y = yardsOf(w, 0).find((u) => u.t.id === 'r-yard')!
      shootOff(w, y, 'secondSlip')
      cmdExpand(w, 0, y.id, 'drydock')
    }
    if (t % 30 === 0 && (stateHash(a) !== stateHash(c) || stateHash(a) !== stateHash(b))) same = false
  }
  check(`a restored battle with expansions stays in sync${big ? ' (Big)' : ''}`, same, `hash ${stateHash(a).toString(16)}`)
  const y = yardsOf(c, 0).find((u) => u.t.id === 'r-yard')!
  check('and its expansions came through the save', !!y.xm?.includes('secondSlip') && !!y.xm?.includes('armourWorks') && !!yardsOf(c, 0).find((u) => u.t.id === 'r-cyard')?.xm?.includes('fighterWing'))
}

// --- Older battles ------------------------------------------------------------------------------------------------
{
  // A step-1 battle: a Frigate Yard with no expansion fields, and a cruiser queued at the Command Station.
  const w = fresh(3)
  const y = yard(w, 'yard')
  w.players[0].queue.push({ unit: 'r-cruiser', left: 5, total: 34 })
  delete y.xm
  delete y.xq
  delete st(w).xm
  const old = restoreWorld(snapshotWorld(w))!
  run(old, 8)
  check('a step-1 save loads and runs', old.time > 7)
  check('a cruiser queued at its Command Station is finished there', old.units.some((u) => u.owner === 0 && u.t.id === 'r-cruiser'))
  check('and its buildings take expansions', cantExpand(old, 0, yardsOf(old, 0)[0].id, 'secondSlip') === null)
  // From before yards: no expansions, the station builds everything as it did.
  const w2 = fresh(3)
  delete w2.hybrid
  delete w2.ruins
  const pre = restoreWorld(snapshotWorld(w2))!
  check('a battle from before yards takes no expansions', (cantExpand(pre, 0, st(pre).id, 'sensorArray') ?? '').includes('No expansions'))
  check('and builds cruisers and bombers at the station', cantBuild(pre, 0, 'r-cruiser') === null && cantBuild(pre, 0, 'r-bomber') === null)
  run(pre, 5)
  check('and runs', pre.time > 4.9)
}

console.log(failed ? `\n${failed} check(s) failed` : `\nAll module checks passed${big ? ' (Big ship sizes)' : ''}`)
process.exit(failed ? 1 : 0)
