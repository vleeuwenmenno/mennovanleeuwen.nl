// Checks Empires At War's hybrid bases (step 1: the Command Station, engineer squadrons and the
// Frigate Yard), headless and deterministic:
//
//   node scripts/empires-yards.ts [big]
//
// - Placement: inside the build radius and clear of everything it may go; outside the radius, on
//   the station, on ore, at the map's edge, before station level 2 or a second one, it may not.
// - Engineers build a yard, and two squadrons build it faster than one.
// - The yard produces a frigate (its own queue, its own rally point); the Command Station can't.
// - A destroyed yard leaves a ruin, and rebuilding on it costs half.
// - Cancelling a site: a full refund before work starts, a partial one after.
// - A battle saved and restored mid-construction stays in step with the one that wasn't.
// - Battles from before yards (no `hybrid`) keep the station as the whole shipyard.
//
// Every check prints a line; it exits with 1 if any of them failed.

import { BUILD_RADIUS, REBUILD, SITE_REFUND, UNIT, yardOf } from '../src/apps/games/empires/data.ts'
import { MAPS } from '../src/apps/games/empires/maps.ts'
import { restoreWorld, snapshotWorld } from '../src/apps/games/empires/snapshot.ts'
import { cleanCmd, cmd, runCmd } from '../src/apps/games/empires/commands.ts'
import {
  STEP, allQueued, cantBuild, cmdBuild, cmdCancelSite, cmdConstruct, cmdPlace, damage, newWorld, placement, radius, siteRefund, spawnGroup, stateHash, tick, yardBox, yardsOf,
  type Unit, type Wreck, type World,
} from '../src/apps/games/empires/sim.ts'

const big = process.argv[2] === 'big'
let failed = 0
const check = (what: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `: ${detail}` : ''}`)
  if (!ok) failed++
}

const map = MAPS.find((m) => m.spawns.length === 2) ?? MAPS[0]
const fresh = (): World => {
  const w = newWorld(map, [
    { faction: 'republic', team: 0, spawn: 0 },
    { faction: 'droid', team: 1, spawn: 1 },
  ], { seed: 77, credits: 20000, ...(big ? { sizes: 'big' as const } : {}) })
  for (const p of w.players) p.level = 2
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
/** A spot for a yard: out from the station away from the map's middle, the first that fits. */
const spotFor = (w: World, o = 0) => {
  const s = st(w, o)
  const away = Math.atan2(s.y - w.h / 2, s.x - w.w / 2)
  for (let d = 500; d < BUILD_RADIUS; d += 100)
    for (const off of [0, 0.5, -0.5, 1, -1, 1.5, -1.5, 2, -2, 2.6, -2.6, 3.1]) {
      const x = s.x + Math.cos(away + off) * d
      const y = s.y + Math.sin(away + off) * d
      if (!placement(w, o, yardOf(w.players[o].faction).id, x, y).why) return { x, y }
    }
  throw new Error('no spot for a yard')
}
const engineers = (w: World, o = 0, n = 1) => {
  const s = st(w, o)
  const id = o === 0 ? 'r-engineer' : 'd-engineer'
  return Array.from({ length: n }, (_, i) => spawnGroup(w, id, o, s.x + 250, s.y + 60 * i, 0)).flat()
}
const ids = (us: Unit[]) => us.map((u) => u.id)
const yardOn = (w: World, o = 0) => w.units.find((u) => !u.dead && u.owner === o && u.t.tier === 'yard')
const RY = 'r-yard'

// --- The Command Station builds engineers, not frigates ------------------------------------------------
{
  const w = fresh()
  check('the world has hybrid bases', !!w.hybrid && Array.isArray(w.ruins))
  check('the station builds engineers', cantBuild(w, 0, 'r-engineer') === null)
  check('the station builds gunships and fighters', cantBuild(w, 0, 'r-gunship') === null && cantBuild(w, 0, 'r-fighter') === null)
  const why = cantBuild(w, 0, 'r-frigate')
  check('the station can no longer build frigates', !!why && why.includes('Frigate Yard'), why ?? 'allowed')
  check('nor corvettes', !!cantBuild(w, 0, 'r-corvette'))
  check('frigates refused at the station by id', cmdBuild(w, 0, 'r-frigate', false, 0) !== null && !w.players[0].queue.length)
  check('an engineer squadron is three craft', UNIT['r-engineer'].squad === 3 && UNIT['d-engineer'].squad === 3)
  cmdBuild(w, 0, 'r-engineer')
  run(w, 20, () => w.units.some((u) => u.owner === 0 && u.t.id === 'r-engineer'))
  check('engineers launch from the station', w.units.filter((u) => u.owner === 0 && u.t.id === 'r-engineer').length === 3)
}

// --- Placement --------------------------------------------------------------------------------------------
{
  const w = fresh()
  const s = st(w)
  const ok = spotFor(w)
  check('a spot inside the radius is valid', placement(w, 0, RY, ok.x, ok.y).why === null)
  const far = { x: s.x + (ok.x - s.x) * ((BUILD_RADIUS + 300) / Math.hypot(ok.x - s.x, ok.y - s.y)), y: s.y + (ok.y - s.y) * ((BUILD_RADIUS + 300) / Math.hypot(ok.x - s.x, ok.y - s.y)) }
  check('outside the radius is refused', (placement(w, 0, RY, far.x, far.y).why ?? '').includes('build radius'), placement(w, 0, RY, far.x, far.y).why ?? 'allowed')
  check('on the station is refused', (placement(w, 0, RY, s.x + 40, s.y).why ?? '').includes('structure'), placement(w, 0, RY, s.x + 40, s.y).why ?? 'allowed')
  // An ore asteroid where the yard would go.
  w.nodes.push({ ...w.nodes[0], id: w.nodes.length, x: ok.x + 60, y: ok.y })
  check('on ore is refused', (placement(w, 0, RY, ok.x, ok.y).why ?? '').includes('ore'), placement(w, 0, RY, ok.x, ok.y).why ?? 'allowed')
  w.nodes.pop()
  check('at the map edge is refused', !!placement(w, 0, RY, 30, 30).why)
  w.players[0].level = 1
  check('before station level 2 it is refused', (placement(w, 0, RY, ok.x, ok.y).why ?? '').includes('level 2'))
  w.players[0].level = 2
  check('the enemy can\'t build in our radius', !!placement(w, 1, 'd-yard', ok.x, ok.y).why)
  check('placing needs engineers', cmdPlace(w, 0, [st(w).id], RY, ok.x, ok.y) !== null && !yardOn(w))
  const eng = engineers(w)
  const c0 = w.players[0].credits
  check('engineers place a yard', cmdPlace(w, 0, ids(eng), RY, ok.x, ok.y) === null && !!yardOn(w))
  check('it is paid for when placed', w.players[0].credits === c0 - UNIT[RY].cost, `${c0} -> ${w.players[0].credits}`)
  check('only one Frigate Yard at a time', (placement(w, 0, RY, ok.x, ok.y).why ?? '').includes('already'), placement(w, 0, RY, ok.x, ok.y).why ?? 'allowed')
  run(w, 0.5)
  const site = yardOn(w)!
  check('the enemy can\'t see a site nobody has started', !site.seen[1])
  check('the order goes into the engineers\' order queue with Shift', (() => {
    const w2 = fresh()
    const e2 = engineers(w2)
    runCmd(w2, 0, cmd('move', ids(e2), st(w2).x + 600, st(w2).y, false, false))
    const spot = spotFor(w2)
    runCmd(w2, 0, cmd('place', ids(e2), RY, spot.x, spot.y, true))
    return e2.every((u) => u.order.k === 'move' && u.queue.length === 1 && u.queue[0].k === 'construct')
  })())
  check('orders go through the protocol', !!cleanCmd({ f: 'place', a: [ids(eng), RY, ok.x, ok.y, false] }, w) && !!cleanCmd({ f: 'construct', a: [ids(eng), site.id] }, w) && !!cleanCmd({ f: 'cancelSite', a: [site.id] }, w) && !!cleanCmd({ f: 'build', a: ['r-frigate', true, site.id] }, w))
  check('old orders still pass (no yard argument)', !!cleanCmd({ f: 'build', a: ['r-fighter', false] }, w) && !!cleanCmd({ f: 'cancel', a: [0] }, w) && !!cleanCmd({ f: 'rally', a: [100, 100] }, w))
}

// --- Engineers build it; two squadrons faster -----------------------------------------------------------
const buildTime = (squads: number) => {
  const w = fresh()
  const eng = engineers(w, 0, squads)
  const spot = spotFor(w)
  cmdPlace(w, 0, ids(eng), RY, spot.x, spot.y)
  const t0 = w.time
  const done = run(w, 240, () => yardsOf(w, 0).length > 0)
  return { done, secs: w.time - t0, w }
}
{
  const one = buildTime(1)
  const two = buildTime(2)
  check('one engineer squadron builds the yard', one.done, `${one.secs.toFixed(1)} s`)
  check('two squadrons build it faster', two.done && two.secs < one.secs - 5, `${two.secs.toFixed(1)} s against ${one.secs.toFixed(1)} s`)
  const y = yardsOf(one.w, 0)[0]
  check('a finished yard has its own queue and rally point', !!y && Array.isArray(y.yq) && !!y.yr)
  check('it is at full strength', !!y && y.hull > y.hullMax * 0.95, y ? `${Math.round(y.hull)} / ${Math.round(y.hullMax)}` : '')

  // The yard produces a frigate, jumping in beside it and heading for its own rally point.
  const w = one.w
  const p = w.players[0]
  check('frigates queue at the yard', cmdBuild(w, 0, 'r-frigate') === null && y.yq!.length === 1 && !p.queue.length)
  check('corvettes too', cmdBuild(w, 0, 'r-corvette', false, y.id) === null && y.yq!.length === 2)
  check('the station still builds at the same time', cmdBuild(w, 0, 'r-fighter') === null && p.queue.length === 1 && allQueued(w, 0).length === 3)
  check('a yard refuses what it doesn\'t build', cmdBuild(w, 0, 'r-fighter', false, y.id) !== null)
  y.yr = { x: y.x + 900, y: y.y }
  let arrived: Unit | undefined
  run(w, 60, () => !!(arrived = w.units.find((u) => u.owner === 0 && u.t.id === 'r-frigate')))
  check('the yard produces a frigate', !!arrived)
  check('it jumps in beside the yard', !!arrived && Math.hypot(arrived.x - y.x, arrived.y - y.y) < radius(y.t) + radius(arrived.t) + 600)
  check('and heads for the yard\'s rally point', !!arrived && arrived.order.k === 'move' && Math.hypot(arrived.order.x - y.yr.x, arrived.order.y - y.yr.y) < 400)
  check('frigates bought for the fleet inventory go there', cmdBuild(w, 0, 'r-frigate', true, y.id) === null && run(w, 40, () => p.reserve.includes('r-frigate')))

  // A destroyed yard leaves its ruin; rebuilding costs half.
  const before = p.credits
  cmdBuild(w, 0, 'r-frigate', false, y.id)
  const paid = p.credits
  damage(w, y, 1e9, 'turbo', -1, y.x, y.y, 1)
  run(w, 0.2)
  const ruin = (w.ruins ?? []).find((r) => r.owner === 0)
  check('a destroyed yard leaves a ruin where it stood', !!ruin && Math.abs(ruin.x - y.x) < 1 && Math.abs(ruin.y - y.y) < 1)
  const back = p.ledger.find((e) => e.what.startsWith('Lost with the yard'))
  check('ships still queued in it are paid back', paid < before && !!back && back.amount === UNIT['r-frigate'].cost, back ? `+${back.amount}` : 'no refund')
  const pl = placement(w, 0, RY, ruin!.x + 20, ruin!.y - 20)
  check('placing on the ruin snaps to it and costs half', !pl.why && pl.x === ruin!.x && pl.cost === Math.round(UNIT[RY].cost * REBUILD), `${pl.why ?? ''} cost ${pl.cost}`)
  check('the enemy can\'t rebuild our ruin', placement(w, 1, 'd-yard', ruin!.x, ruin!.y).why !== null)
  const eng = w.units.filter((u) => u.owner === 0 && u.t.id === 'r-engineer')
  const c1 = p.credits
  check('engineers rebuild it', cmdPlace(w, 0, ids(eng), RY, ruin!.x, ruin!.y) === null && p.credits === c1 - Math.round(UNIT[RY].cost * REBUILD) && !(w.ruins ?? []).length)
  check('the rebuilt yard goes up', run(w, 240, () => yardsOf(w, 0).length > 0))
  check('its modules are lost with the old one (fresh yard, empty queue)', yardsOf(w, 0)[0]?.yq?.length === 0)
}

// --- Cancelling a site -------------------------------------------------------------------------------------
{
  const w = fresh()
  const p = w.players[0]
  const spot = spotFor(w)
  // Engineers far away, so the work hasn't started yet when it's cancelled.
  const eng = engineers(w)
  for (const u of eng) u.x = Math.max(60, u.x - 1500)
  cmdPlace(w, 0, ids(eng), RY, spot.x, spot.y)
  run(w, 1)
  const site = yardOn(w)!
  const c0 = p.credits
  check('a site not started refunds in full', !site.site?.started && siteRefund(site) === UNIT[RY].cost && cmdCancelSite(w, 0, site.id) === null && p.credits === c0 + UNIT[RY].cost)
  run(w, 0.2)
  check('the site is gone and the engineers stand down', !yardOn(w) && eng.every((u) => u.order.k !== 'construct'))
  const eng2 = engineers(w)
  cmdPlace(w, 0, ids(eng2), RY, spot.x, spot.y)
  const site2 = yardOn(w)!
  run(w, 60, () => !!site2.site?.started && site2.building < site2.t.build * 0.5)
  const progress = 1 - site2.building / site2.t.build
  const want = Math.round(UNIT[RY].cost * (SITE_REFUND.start - SITE_REFUND.wear * progress))
  const c1 = p.credits
  check('a site under way refunds part', site2.site?.started === true && siteRefund(site2) === want && want < UNIT[RY].cost, `${Math.round(progress * 100)}% built, refund ${want}`)
  cmdCancelSite(w, 0, site2.id)
  check('the partial refund is paid', Math.abs(p.credits - (c1 + want)) < 1e-6)
  check('the enemy can\'t cancel our site', (() => {
    const e3 = engineers(w)
    cmdPlace(w, 0, ids(e3), RY, spot.x, spot.y)
    return cmdCancelSite(w, 1, yardOn(w)!.id) !== null
  })())
}

// --- Engineers repair structures --------------------------------------------------------------------------
{
  const w = fresh()
  const s = st(w)
  s.hull = s.hullMax * 0.5
  const eng = engineers(w)
  check('engineers take a repair order on the station', cmdConstruct(w, 0, ids(eng), s.id) === null)
  const h0 = s.hull
  run(w, 30)
  check('and weld it back up', s.hull > h0 + s.hullMax * 0.05, `${Math.round(h0)} -> ${Math.round(s.hull)}`)
  check('they don\'t fight', eng.every((u) => !u.target))
}

// --- Save and restore mid-construction stays in sync ---------------------------------------------------
{
  const a = fresh()
  const b = fresh()
  const spot = spotFor(a)
  for (const w of [a, b]) {
    const e = engineers(w, 0, 2)
    cmdPlace(w, 0, ids(e), RY, spot.x, spot.y)
    const e1 = engineers(w, 1)
    const s1 = st(w, 1)
    const away = Math.atan2(s1.y - w.h / 2, s1.x - w.w / 2)
    for (let d = 500; d < BUILD_RADIUS; d += 100) {
      const x = s1.x + Math.cos(away) * d
      const y = s1.y + Math.sin(away) * d
      if (cmdPlace(w, 1, ids(e1), 'd-yard', x, y) === null) break
    }
  }
  run(a, 8)
  run(b, 8)
  const site = yardOn(a)!
  check('mid-construction when saved', !!site.site?.started && site.building > 0, `${Math.round((1 - site.building / site.t.build) * 100)}% built`)
  const c = restoreWorld(snapshotWorld(a))!
  let same = true
  for (let t = 0; t < 120 / STEP; t++) {
    for (const w of [a, b, c]) {
      tick(w)
      w.events.length = 0
    }
    if (t % 30 === 0 && (stateHash(a) !== stateHash(c) || stateHash(a) !== stateHash(b))) {
      same = false
      break
    }
    if (t === Math.round(40 / STEP)) for (const w of [a, c, b]) cmdBuild(w, 0, 'r-frigate')
  }
  check('a restored battle stays in sync through the yard going up', same, `hash ${stateHash(a).toString(16)}`)
  check('and the yards finished in both', yardsOf(a, 0).length === 1 && yardsOf(c, 0).length === 1 && yardsOf(a, 1).length === 1)
}

// --- Engineers guard what they built ----------------------------------------------------------------------
{
  const w = fresh()
  const spot = spotFor(w)
  const eng = engineers(w)
  check('engineers place a yard', cmdPlace(w, 0, ids(eng), RY, spot.x, spot.y) === null)
  check('the yard goes up', run(w, 240, () => yardsOf(w, 0).length > 0))
  run(w, 1)
  const y = yardsOf(w, 0)[0]
  check('the squad that finished it is on guard at it', eng.every((u) => u.order.k === 'guard' && u.order.id === y.id), eng.map((u) => u.order.k).join(','))
  check('and unarmed engineers pick no fights', eng.every((u) => !u.target))
  // Damaged, it is mended by the guards.
  y.hull = y.hullMax * 0.6
  run(w, 3)
  const hurt = y.hull
  run(w, 30)
  check('a guard squad mends the yard after it takes damage', y.hull > hurt + 1, `${Math.round(hurt)} to ${Math.round(y.hull)} of ${Math.round(y.hullMax)}`)
  check('and goes back on guard afterwards', run(w, 60, () => eng.every((u) => u.order.k === 'guard')))
  // An enemy warship nearby doesn't draw them off.
  const foe = spawnGroup(w, 'd-gunship', 1, y.x + 400, y.y, Math.PI)[0]
  run(w, 10)
  check('engineers do not go off to fight', eng.every((u) => (u.order.k === 'guard' || u.order.k === 'construct') && !u.target), eng.map((u) => u.order.k).join(','))
  foe.dead = true

  // Orders queued after the building still win: guard only once the queue is empty.
  const w2 = fresh()
  const spot2 = spotFor(w2)
  const eng2 = engineers(w2)
  cmdPlace(w2, 0, ids(eng2), RY, spot2.x, spot2.y)
  const away = { x: st(w2).x - 300, y: st(w2).y }
  runCmd(w2, 0, cmd('move', ids(eng2), away.x, away.y, false, true))
  run(w2, 240, () => yardsOf(w2, 0).length > 0)
  run(w2, 1)
  check('a queued move after the build is taken instead of guarding', eng2.every((u) => u.order.k === 'move' || u.order.k === 'idle'), eng2.map((u) => u.order.k).join(','))
}

// --- Free rotation -----------------------------------------------------------------------------------------
{
  const w = fresh()
  const s = st(w)
  const ok = spotFor(w)
  const auto = Math.atan2(ok.y - s.y, ok.x - s.x)
  const wrap = (a: number) => a - Math.PI * 2 * Math.floor((a + Math.PI) / (Math.PI * 2))
  const near = (a: number, b: number) => Math.abs(wrap(a - b)) < 1e-9
  check('with no angle a yard faces away from the station, as before', near(placement(w, 0, RY, ok.x, ok.y).a, auto))
  check('a chosen angle is the ghost\'s angle', near(placement(w, 0, RY, ok.x, ok.y, 1.0).a, 1.0) && near(placement(w, 0, RY, ok.x, ok.y, 1.0 + 7 * Math.PI).a, wrap(1.0 + 7 * Math.PI)))

  // The footprint is the rotated box: a hulk just off the yard's long end blocks it, off its short side doesn't.
  const { hl, hw } = yardBox(UNIT[RY])
  check('the yard is longer one way than the other', Math.abs(hl - hw) > 10, `half length ${hl.toFixed(0)}, half width ${hw.toFixed(0)}`)
  const size = 100
  const D = Math.max(hl, hw) + size * 0.6 - 5
  const hulk: Wreck = { id: 9001, x: ok.x + D, y: ok.y, value: 0, left: 99, sprite: 'x', size, rot: 0, decay: 0, team: 0 }
  w.wrecks.push(hulk)
  // Facing 0 has the length along x (towards the hulk); a quarter turn has the width there.
  const long = hl >= hw ? 0 : Math.PI / 2
  const blocked = placement(w, 0, RY, ok.x, ok.y, long)
  const clear = placement(w, 0, RY, ok.x, ok.y, long + Math.PI / 2)
  check('a long end towards a hulk is blocked', (blocked.why ?? '').includes('wreck'), blocked.why ?? 'allowed')
  check('the same yard turned a quarter is clear', clear.why === null, clear.why ?? '')
  check('turning it all the way round blocks it again', (placement(w, 0, RY, ok.x, ok.y, long + Math.PI).why ?? '').includes('wreck'))
  w.wrecks.pop()

  // The order carries the angle, and the yard goes up at it.
  const eng = engineers(w)
  const turn = 2.2
  check('engineers place a yard at a chosen angle', cmdPlace(w, 0, ids(eng), RY, ok.x, ok.y, false, turn) === null)
  const site = yardOn(w)!
  check('the site faces the chosen angle', near(site.a, turn), `${site.a.toFixed(3)} vs ${turn}`)
  check('and the finished yard keeps it', run(w, 240, () => yardsOf(w, 0).length > 0) && near(yardsOf(w, 0)[0].a, turn))

  // A ruin keeps the way it lay, whatever the rebuild order says.
  const y = yardsOf(w, 0)[0]
  damage(w, y, 1e9, 'turbo', -1, y.x, y.y, 1)
  run(w, 0.2)
  const ruin = (w.ruins ?? []).find((r) => r.owner === 0)
  check('the ruin remembers the angle', !!ruin && near(ruin.a, turn))
  w.players[0].credits = 20000
  check('rebuilding a ruin ignores a new angle', near(placement(w, 0, RY, ruin!.x, ruin!.y, -1).a, turn))
  check('and the rebuilt yard faces as the ruin did', cmdPlace(w, 0, ids(eng), RY, ruin!.x, ruin!.y, false, -1) === null && near(yardOn(w)!.a, turn))

  // The protocol: an angle is optional, must be a finite number, and is brought into (-PI, PI].
  const base = [ids(eng), RY, ok.x, ok.y, false]
  const clean = (...a: unknown[]) => cleanCmd({ f: 'place', a: [...base, ...a] }, w)
  check('an order without an angle is accepted (old orders)', !!cleanCmd({ f: 'place', a: base }, w) && Number.isNaN(cleanCmd({ f: 'place', a: base }, w)!.a[5] as number))
  check('a null angle (NaN on the wire) means the old default', Number.isNaN(clean(null)!.a[5] as number))
  check('a finite angle is accepted and normalised', near(clean(9.5)!.a[5] as number, wrap(9.5)))
  check('a string, Infinity or an object is refused', clean('1') === null && clean({}) === null && clean(Infinity) === null)
  const w2 = fresh()
  const e2 = engineers(w2)
  const spot2 = spotFor(w2)
  runCmd(w2, 0, cmd('place', ids(e2), RY, spot2.x, spot2.y, false, 0.5))
  check('a command with an angle runs the same way', near(yardOn(w2)!.a, 0.5))
  runCmd(w2, 1, cmd('place', ids(e2), 'd-yard', spot2.x, spot2.y, false))
  check('and a shorter one still works', true)

  // Both copies of a battle agree after a rotated yard (and its snapshot).
  const w3 = fresh()
  const e3 = engineers(w3)
  cmdPlace(w3, 0, ids(e3), RY, spotFor(w3).x, spotFor(w3).y, false, 2.0)
  run(w3, 10)
  const copy = restoreWorld(snapshotWorld(w3))!
  run(w3, 20)
  run(copy, 20)
  check('a restored battle with a rotated yard stays in sync', stateHash(w3) === stateHash(copy), `hash ${stateHash(w3).toString(16)}`)
}

// --- Battles from before yards -----------------------------------------------------------------------------
{
  const w = fresh()
  delete w.hybrid
  delete w.ruins
  const old = restoreWorld(snapshotWorld(w))!
  check('an old battle builds frigates at the station', cantBuild(old, 0, 'r-frigate') === null && cmdBuild(old, 0, 'r-frigate') === null && old.players[0].queue.length === 1)
  check('and has no engineers or yards', cantBuild(old, 0, 'r-engineer') !== null && placement(old, 0, RY, st(old).x + 700, st(old).y).why !== null)
  run(old, 5)
  check('and runs', old.time > 4.9)
}

console.log(failed ? `\n${failed} check(s) failed` : '\nAll yard checks passed')
process.exit(failed ? 1 : 0)
