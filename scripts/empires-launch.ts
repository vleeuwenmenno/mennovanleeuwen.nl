// Checks Empires At War's new ships flying out of the yards, and reinforcements, headless and
// deterministic:
//
//   node scripts/empires-launch.ts
//
// - A finished ship flies out of where it was built: frigates and corvettes from the Frigate Yard,
//   cruisers from the Capital Yard (out of the berth, through the mouth), strike craft, gunships and
//   engineers from the Command Station's hangar door; a rush-launched cruiser too, unfinished. It
//   spools up, slides out in a few seconds, then flies to the yard's rally point and gets there.
// - A way out blocked by something solid holds it back until it clears, but never longer than
//   LAUNCH.wait; a ship two classes smaller flies out over a big one without waiting.
// - A reinforcement costs the surcharge on top (15% by default, rounded to 5 credits, at least 25),
//   is refunded in full when cancelled, goes to the reserve when done, and is called in anywhere the
//   fleet can see (not out of sight). Strike craft can be reinforcements too.
// - The lobby's rules: a 0% surcharge, strike craft off, warships off (the order refused, and
//   dropped by the server's order cleaning); cleanReinforce clamps tampered values onto the steps.
// - A match without rules gets the defaults; a battle saved before them keeps the old ways (new
//   ships jump in beside the yard, the reserve costs nothing extra, no strike craft in it).
// - Save and restore mid-launch stays in step with the battle that wasn't saved.
// - The AI buys a reinforcement for a far mine under attack, and calls it in near it.
//
// Every check prints a line; it exits with 1 if any of them failed.

import { UNIT, yardOf } from '../src/apps/games/empires/data.ts'
import { MAPS } from '../src/apps/games/empires/maps.ts'
import { restoreWorld, snapshotWorld } from '../src/apps/games/empires/snapshot.ts'
import { cleanCmd, cmd } from '../src/apps/games/empires/commands.ts'
import { matchWorld, type MatchInfo } from '../src/apps/games/empires/match.ts'
import { newBrain, think, REINFORCE_AI } from '../src/apps/games/empires/ai.ts'
import { DEFAULT_RULES } from '../src/apps/games/empires/maps.ts'
import {
  LAUNCH, REINFORCE, STEP, allQueued, berthOf, cantBuild, cleanReinforce, cmdBuild, cmdCancel, cmdDeploy, cmdRally, cmdRush, launches, newWorld, overlaps, shipPrice, spawn, stateHash, surcharge, tick,
  type Reinforce, type SimEvent, type Unit, type World,
} from '../src/apps/games/empires/sim.ts'
import { RUSH_TECH } from '../src/apps/games/empires/data.ts'

let failed = 0
const check = (what: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `: ${detail}` : ''}`)
  if (!ok) failed++
}

const map = MAPS.find((m) => m.spawns.length === 2) ?? MAPS[0]
const fresh = (reinforce?: Partial<Reinforce>): World => {
  const w = newWorld(map, [
    { faction: 'republic', team: 0, spawn: 0 },
    { faction: 'droid', team: 1, spawn: 1 },
  ], { seed: 31, credits: 60000, ...(reinforce ? { reinforce: { ...REINFORCE, ...reinforce } } : {}) })
  for (const p of w.players) p.level = 4
  return w
}
/** Runs the battle, keeping its events (for the checks) until `until` says stop. */
const run = (w: World, secs: number, until?: () => boolean, events?: SimEvent[]) => {
  for (let t = 0; t < secs / STEP; t++) {
    tick(w)
    if (events) events.push(...w.events)
    w.events.length = 0
    if (until?.()) return true
  }
  return false
}
const st = (w: World, o = 0) => w.byId.get(w.players[o].station)!
/** A finished yard of ours, out from the station towards the middle (`turn` off that), facing away
 * from the station. */
const yard = (w: World, kind: 'yard' | 'cyard', o = 0, turn = 0) => {
  const s = st(w, o)
  const away = Math.atan2(w.h / 2 - s.y, w.w / 2 - s.x) + turn
  const d = kind === 'cyard' ? 1500 : 1000
  const y = spawn(w, yardOf(w.players[o].faction, kind).id, o, s.x + Math.cos(away) * d, s.y + Math.sin(away) * d, away)
  y.yq = []
  return y
}
const newest = (w: World, id: string, o = 0) => w.units.filter((u) => !u.dead && u.owner === o && u.t.id === id).sort((a, b) => b.id - a.id)[0] as Unit | undefined
const along = (u: { x: number; y: number }, from: { x: number; y: number }, a: number) => (u.x - from.x) * Math.cos(a) + (u.y - from.y) * Math.sin(a)
const hyperspace = (ev: SimEvent[]) => ev.some((e) => e.k === 'warp' || e.k === 'arrived')
/** The tick count to finish the yard's ship now: its build time set to one tick. */
const finishNow = (q: { left: number } | undefined) => q && (q.left = STEP / 2)

// --- Defaults -----------------------------------------------------------------------------------------
{
  const w = fresh()
  check('a new skirmish has the default rules: strike craft and warships on, +15%', w.reinforce?.strike === true && w.reinforce.ships === true && w.reinforce.surcharge === 15)
  check('new ships fly out of the yards there', launches(w))
}

// --- A frigate from the Frigate Yard --------------------------------------------------------------------
{
  const w = fresh()
  const fy = yard(w, 'yard')
  const rally = { x: fy.x + Math.cos(fy.a) * 1600 + Math.sin(fy.a) * 300, y: fy.y + Math.sin(fy.a) * 1600 - Math.cos(fy.a) * 300 }
  cmdRally(w, 0, rally.x, rally.y, fy.id)
  check('a frigate is ordered at the Frigate Yard', cmdBuild(w, 0, 'r-frigate', false, fy.id) === null)
  finishNow(fy.yq![0])
  const ev: SimEvent[] = []
  run(w, 1, () => !!newest(w, 'r-frigate'), ev)
  const u = newest(w, 'r-frigate')!
  const b = berthOf(fy)
  check('it appears in the yard\'s berth, on its way out', !!u?.launch && u.launch.from === fy.id && Math.hypot(u.x - b.x, u.y - b.y) < 30, u ? `${Math.hypot(u.x - b.x, u.y - b.y).toFixed(0)} from the berth` : 'none')
  check('facing out of the mouth', !!u && Math.abs(Math.atan2(Math.sin(u.a - fy.a), Math.cos(u.a - fy.a))) < 0.01)
  check('no hyperspace jump', !hyperspace(ev) && !w.arrivals.length)
  run(w, LAUNCH.spool * 0.8, undefined, ev)
  check('it holds still while its engines spool up', Math.hypot(u.x - b.x, u.y - b.y) < 1 && u.v === 0)
  const t0 = w.time
  run(w, 5, () => !u.launch, ev)
  const took = w.time - t0 + LAUNCH.spool * 0.8
  check('it slides out in about 2 to 3 s', took >= 1.8 && took <= 3.2, `${took.toFixed(2)} s`)
  check('clear of the mouth when it is out', along(u, fy, fy.a) > b.mouth + Math.hypot(b.x - fy.x, b.y - fy.y), `${along(u, fy, fy.a).toFixed(0)} out, mouth at ${(b.mouth + Math.hypot(b.x - fy.x, b.y - fy.y)).toFixed(0)}`)
  check('then it flies under its own power, to the rally point', u.order.k === 'move' && Math.hypot(u.order.x - rally.x, u.order.y - rally.y) < 200 && u.v > 0)
  run(w, 90, () => Math.hypot(u.x - rally.x, u.y - rally.y) < 160)
  check('it reaches the rally point', Math.hypot(u.x - rally.x, u.y - rally.y) < 160, `${Math.hypot(u.x - rally.x, u.y - rally.y).toFixed(0)} away after ${(w.time - t0).toFixed(0)} s`)
  check('still no hyperspace', !hyperspace(ev))
}

// --- Corvettes, cruisers, station craft, rushed ships ------------------------------------------------
{
  const w = fresh()
  const fy = yard(w, 'yard')
  const cy = yard(w, 'cyard', 0, 1.2)
  cmdBuild(w, 0, 'r-corvette', false, fy.id)
  cmdBuild(w, 0, 'r-cruiser', false, cy.id)
  finishNow(fy.yq![0])
  finishNow(cy.yq![0])
  run(w, 0.2)
  const cv = newest(w, 'r-corvette')
  const cr = newest(w, 'r-cruiser')
  check('a corvette flies out of the Frigate Yard', cv?.launch?.from === fy.id)
  check('a cruiser flies out of the Capital Yard', cr?.launch?.from === cy.id, cr?.launch ? `from ${cr.launch.from}` : 'none')
  run(w, 5, () => !cr?.launch)
  const cb = berthOf(cy)
  check('the cruiser comes out through the Capital Yard\'s mouth', !!cr && !cr.launch && along(cr, cy, cy.a) > cb.mouth + Math.hypot(cb.x - cy.x, cb.y - cy.y))

  const s = st(w)
  w.players[0].techs.push(UNIT['r-repair'].tech!)
  for (const id of ['r-fighter', 'r-gunship', 'r-engineer', 'r-repair']) {
    w.players[0].queue = []
    const why = cmdBuild(w, 0, id)
    if (why) {
      check(`${UNIT[id].name} ordered at the station`, false, why)
      continue
    }
    finishNow(w.players[0].queue[0])
    const ev: SimEvent[] = []
    run(w, 0.2, undefined, ev)
    const craft = w.units.filter((u) => !u.dead && u.t.id === id && u.launch?.from === s.id)
    check(`${UNIT[id].name}: the whole ${craft.length > 1 ? 'squadron' : 'craft'} flies out of the station's hangar`, craft.length === UNIT[id].squad && !hyperspace(ev), `${craft.length} of ${UNIT[id].squad}`)
    run(w, 4, () => craft.every((u) => !u.launch))
    check(`${UNIT[id].name}: out and clear of the station within a few seconds`, craft.every((u) => !u.launch && Math.hypot(u.x - s.x, u.y - s.y) > 60))
  }

  // Rushed: out of the berth, scaffolding and all.
  const p = w.players[0]
  p.techs.push(RUSH_TECH.republic)
  cmdBuild(w, 0, 'r-cruiser', false, cy.id)
  run(w, 0.2)
  cy.yq![0].left = cy.yq![0].total * 0.4
  cy.rushAt = undefined
  const ev: SimEvent[] = []
  check('a rush launch goes through', cmdRush(w, 0, cy.id) === null, String(cantRush(w)))
  run(w, 0.1, undefined, ev)
  const rushed = w.units.find((u) => !u.dead && u.t.id === 'r-cruiser' && !!u.rush)
  check('the rushed cruiser flies out of the berth, unfinished', !!rushed?.launch && rushed.launch.from === cy.id && !hyperspace(ev))
}
function cantRush(w: World) {
  return w.events.map((e) => e.k).join(',')
}

// --- A blocked mouth ----------------------------------------------------------------------------------
{
  const w = fresh()
  const fy = yard(w, 'yard')
  cmdBuild(w, 0, 'r-frigate', false, fy.id)
  finishNow(fy.yq![0])
  run(w, 0.1)
  const u = newest(w, 'r-frigate')!
  const L = u.launch!
  // Another frigate (solid to it: the same class) parked where it would come clear.
  const block = spawn(w, 'r-frigate', 0, L.x1, L.y1, 0)
  block.stance = 'hold'
  run(w, LAUNCH.spool + 1.5)
  check('with a frigate in the way out it waits in the berth', !!u.launch && u.launch.wait > 1 && Math.hypot(u.x - L.x0, u.y - L.y0) < 1, `waited ${u.launch?.wait.toFixed(1)} s`)
  // It moves off: out comes the new one.
  block.x += 2000
  block.ax = block.x
  const t0 = w.time
  run(w, 4, () => !u.launch)
  check('once the way is clear it launches', !u.launch && w.time - t0 < 3, `${(w.time - t0).toFixed(1)} s after`)

  // Kept blocked: it goes anyway after LAUNCH.wait.
  const w2 = fresh()
  const fy2 = yard(w2, 'yard')
  cmdBuild(w2, 0, 'r-frigate', false, fy2.id)
  finishNow(fy2.yq![0])
  run(w2, 0.1)
  const u2 = newest(w2, 'r-frigate')!
  const b2 = spawn(w2, 'r-frigate', 0, u2.launch!.x1, u2.launch!.y1, 0)
  b2.stance = 'hold'
  // Pinned there (its own push would ease it off a little).
  const L2 = u2.launch!
  const t2 = w2.time
  run(w2, LAUNCH.spool + LAUNCH.wait + 4, () => {
    b2.x = L2.x1
    b2.y = L2.y1
    b2.v = 0
    return !u2.launch
  })
  const waited = w2.time - t2
  check(`never held back longer than ${LAUNCH.wait} s`, !u2.launch && waited <= LAUNCH.spool + LAUNCH.wait + LAUNCH.slideMax + 0.2 && waited >= LAUNCH.spool + LAUNCH.wait, `${waited.toFixed(1)} s`)

  // A gunship out of the station's hangar flies over a cruiser parked in its way (two classes apart).
  const w3 = fresh()
  w3.players[0].queue = []
  cmdBuild(w3, 0, 'r-gunship')
  finishNow(w3.players[0].queue[0])
  run(w3, 0.1)
  const g = newest(w3, 'r-gunship')!
  const big = spawn(w3, 'r-cruiser', 0, g.launch!.x1, g.launch!.y1, 0)
  big.stance = 'hold'
  check('a cruiser and a gunship are two classes apart', overlaps(g, big))
  const t3 = w3.time
  run(w3, 4, () => !g.launch)
  check('the gunship flies out over the cruiser without waiting', !g.launch && w3.time - t3 < LAUNCH.hangarSpool + LAUNCH.hangar + 0.3, `${(w3.time - t3).toFixed(1)} s`)

  // Two from a Frigate Yard's second slip at once: the second waits for the first.
  const w4 = fresh()
  const fy4 = yard(w4, 'yard')
  fy4.yq = [{ unit: 'r-frigate', left: STEP / 2, total: 22 }]
  run(w4, 0.1)
  fy4.yq = [{ unit: 'r-frigate', left: STEP / 2, total: 22 }]
  run(w4, 0.1)
  const both = w4.units.filter((u) => u.t.id === 'r-frigate' && u.launch?.from === fy4.id).sort((a, b) => a.id - b.id)
  run(w4, LAUNCH.spool + 0.5)
  check('two finished together leave one after the other', both.length === 2 && both[1].launch !== undefined && Math.hypot(both[1].x - both[1].launch.x0, both[1].y - both[1].launch.y0) < 1 && Math.hypot(both[0].x - both[0].launch!.x0, both[0].y - both[0].launch!.y0) > 5)
}

// --- Reinforcements -----------------------------------------------------------------------------------
{
  const w = fresh()
  const p = w.players[0]
  const fy = yard(w, 'yard')
  const extra = surcharge(w, 'r-frigate')
  check('a frigate\'s surcharge is 15% rounded to 5 credits', extra === Math.round((820 * 0.15) / 5) * 5 && extra === 125, `${extra}`)
  check('a fighter squadron\'s: 15% of 260 is 39, so 40', surcharge(w, 'r-fighter') === 40, `${surcharge(w, 'r-fighter')}`)
  check('its price as a reinforcement', shipPrice(w, 'r-frigate', true) === 945 && shipPrice(w, 'r-frigate') === 820)
  const c0 = p.credits
  check('a frigate reinforcement is ordered', cmdBuild(w, 0, 'r-frigate', true, fy.id) === null)
  check('it costs 945 credits (820 + 15%)', c0 - p.credits === 945, `${c0 - p.credits}`)
  cmdCancel(w, 0, 0, fy.id)
  check('cancelled, all 945 come back', p.credits === c0, `${p.credits - c0}`)
  cmdBuild(w, 0, 'r-frigate', true, fy.id)
  finishNow(fy.yq![0])
  const ev: SimEvent[] = []
  run(w, 0.5, undefined, ev)
  check('done, it goes to the reserve: nothing flies out', p.reserve.includes('r-frigate') && !newest(w, 'r-frigate') && ev.some((e) => e.k === 'reserved'))
  // Called in where the fleet can see, and refused where it can't.
  const far = { x: w.w - st(w, 0).x, y: w.h - st(w, 0).y }
  check('out of sight it is refused', /Out of sight/.test(cmdDeploy(w, 0, 'r-frigate', far.x, far.y, 0) ?? ''))
  const s = st(w)
  const here = { x: s.x + Math.cos(fy.a + 1.5) * 700, y: s.y + Math.sin(fy.a + 1.5) * 700 }
  check('in sight it jumps in', cmdDeploy(w, 0, 'r-frigate', here.x, here.y, 0) === null && w.arrivals.length === 1)
  run(w, 3)
  const f = newest(w, 'r-frigate')
  check('and drops out where it was called to', !!f && Math.hypot(f.x - here.x, f.y - here.y) < 80 && !f.launch)
  // Strike craft too.
  p.queue = []
  check('strike craft can be reinforcements', cmdBuild(w, 0, 'r-fighter', true) === null && p.queue[0]?.reserve === true)
  finishNow(p.queue[0])
  run(w, 0.2)
  check('a fighter squadron goes to the reserve', p.reserve.includes('r-fighter') && !w.units.some((u) => u.t.id === 'r-fighter' && u.launch))
  check('called in, the whole squadron drops out', cmdDeploy(w, 0, 'r-fighter', here.x + 300, here.y, 0) === null && (run(w, 3), w.units.filter((u) => !u.dead && u.t.id === 'r-fighter' && Math.hypot(u.x - here.x - 300, u.y - here.y) < 200).length === UNIT['r-fighter'].squad))
}

// --- The lobby's variants ------------------------------------------------------------------------------
{
  const free = fresh({ surcharge: 0 })
  const fy = yard(free, 'yard')
  const c0 = free.players[0].credits
  cmdBuild(free, 0, 'r-frigate', true, fy.id)
  check('at 0% a reinforcement costs its plain price', c0 - free.players[0].credits === 820 && surcharge(free, 'r-frigate') === 0)
  const five = fresh({ surcharge: 5 })
  check('at 5% the surcharge is at least 25 credits', surcharge(five, 'r-fighter') === 25 && surcharge(five, 'r-frigate') === 40, `${surcharge(five, 'r-fighter')}, ${surcharge(five, 'r-frigate')}`)
  const fifty = fresh({ surcharge: 50 })
  check('at 50% a frigate reinforcement is 1230', shipPrice(fifty, 'r-frigate', true) === 1230)

  const noStrike = fresh({ strike: false })
  check('strike craft off: refused', /strike craft are off/.test(cantBuild(noStrike, 0, 'r-fighter', true) ?? ''), String(cantBuild(noStrike, 0, 'r-fighter', true)))
  check('strike craft off: the server drops the order', cleanCmd(JSON.parse(JSON.stringify(cmd('build', 'r-fighter', true, 0))), noStrike) === null)
  check('strike craft off: launching one still works', cleanCmd(cmd('build', 'r-fighter', false, 0), noStrike) !== null && cantBuild(noStrike, 0, 'r-fighter') === null)
  const fyN = yard(noStrike, 'yard')
  check('strike craft off: warships still can be', cantBuild(noStrike, 0, 'r-frigate', true, fyN.id) === null)

  const noShips = fresh({ ships: false })
  const fyS = yard(noShips, 'yard')
  check('warships off: refused', /warships are off/.test(cantBuild(noShips, 0, 'r-frigate', true, fyS.id) ?? ''))
  check('warships off: gunships too', !!cantBuild(noShips, 0, 'r-gunship', true))
  check('warships off: the server drops the order', cleanCmd(cmd('build', 'r-frigate', true, fyS.id), noShips) === null)
  check('warships off: a tampered order run anyway is refused by the sim, nothing paid', (() => {
    const c = noShips.players[0].credits
    return typeof cmdBuild(noShips, 0, 'r-frigate', true, fyS.id) === 'string' && noShips.players[0].credits === c && !fyS.yq!.length
  })())
  check('warships off: strike craft still can be', cantBuild(noShips, 0, 'r-fighter', true) === null)

  check('cleanReinforce: over 50% becomes 50%', cleanReinforce({ surcharge: 999 }).surcharge === 50)
  check('cleanReinforce: negative becomes 0%', cleanReinforce({ surcharge: -20 }).surcharge === 0)
  check('cleanReinforce: onto the 5% steps', cleanReinforce({ surcharge: 13 }).surcharge === 15 && cleanReinforce({ surcharge: 12 }).surcharge === 10)
  check('cleanReinforce: junk gets the defaults', JSON.stringify(cleanReinforce({ strike: 'no', ships: 1, surcharge: NaN })) === JSON.stringify(REINFORCE))
  check('cleanReinforce: nothing at all gets the defaults', JSON.stringify(cleanReinforce(undefined)) === JSON.stringify(REINFORCE))
}

// --- Matches, and battles from before -----------------------------------------------------------------
{
  const info: MatchInfo = {
    id: 'x', seed: 9, map: map.id, gen: { ...DEFAULT_RULES }, credits: 5000,
    seats: [
      { kind: 'human', player: 'a', name: 'A', faction: 'republic', team: 0, spawn: 0, difficulty: 'medium' },
      { kind: 'human', player: 'b', name: 'B', faction: 'droid', team: 1, spawn: 1, difficulty: 'medium' },
    ],
  }
  const old = matchWorld(info)
  check('a match from before the rules gets the defaults', JSON.stringify(old.reinforce) === JSON.stringify(REINFORCE) && launches(old))
  const set = matchWorld({ ...info, reinforce: { strike: false, ships: true, surcharge: 30 } })
  check('a match with rules plays by them', set.reinforce?.strike === false && set.reinforce.surcharge === 30)
  const tampered = matchWorld({ ...info, reinforce: { strike: true, ships: true, surcharge: -100 } })
  check('a match\'s rules are cleaned too', tampered.reinforce?.surcharge === 0)

  // A battle saved mid-fight before the rules: its snapshot has no `reinforce`.
  const w = fresh()
  const fy = yard(w, 'yard')
  const snap = JSON.parse(snapshotWorld(w))
  delete snap.reinforce
  const back = restoreWorld(JSON.stringify(snap))!
  check('an old save loads', !!back && back.units.length === w.units.length)
  check('it keeps the old ways: no launches', !back.reinforce && !launches(back))
  const by = back.byId.get(fy.id)!
  const c0 = back.players[0].credits
  cmdBuild(back, 0, 'r-frigate', true, by.id)
  check('its reserve costs nothing extra', c0 - back.players[0].credits === 820)
  check('no strike craft in its reserve, as before', cantBuild(back, 0, 'r-fighter', true) === 'Strike craft launch from the hangar')
  back.byId.get(fy.id)!.yq = []
  cmdBuild(back, 0, 'r-frigate', false, by.id)
  finishNow(by.yq![0])
  const ev: SimEvent[] = []
  run(back, 0.2, undefined, ev)
  check('a new ship jumps in beside the yard, as it did', hyperspace(ev) || back.arrivals.length > 0)
}

// --- Save and restore mid-launch --------------------------------------------------------------------------
{
  const w = fresh()
  const fy = yard(w, 'yard')
  const cy = yard(w, 'cyard', 0, 1.2)
  cmdBuild(w, 0, 'r-frigate', false, fy.id)
  cmdBuild(w, 0, 'r-cruiser', false, cy.id)
  cmdBuild(w, 0, 'r-fighter')
  finishNow(fy.yq![0])
  finishNow(cy.yq![0])
  finishNow(w.players[0].queue[0])
  run(w, LAUNCH.spool + 0.4)
  const mid = w.units.filter((u) => u.launch).length
  const back = restoreWorld(snapshotWorld(w))!
  check('saved with ships half way out', mid >= 3, `${mid} launching`)
  let same = true
  for (let i = 0; i < 300; i++) {
    tick(w)
    tick(back)
    w.events.length = 0
    back.events.length = 0
    if (stateHash(w) !== stateHash(back)) {
      same = false
      break
    }
  }
  check('restored, it stays in step for 10 s', same && !w.units.some((u) => u.launch))
}

// --- The AI -------------------------------------------------------------------------------------------------
{
  const w = fresh()
  const o = 1
  const p = w.players[o]
  const s = st(w, o)
  yard(w, 'yard', o)
  // A mine of the AI's far out from home, and our frigates on it, in its sight.
  const toMid = Math.atan2(w.h / 2 - s.y, w.w / 2 - s.x)
  const d = REINFORCE_AI.far + 600
  const mx = s.x + Math.cos(toMid) * d
  const my = s.y + Math.sin(toMid) * d
  const mine = spawn(w, 'd-mine', o, mx, my, 0)
  for (let i = 0; i < 3; i++) spawn(w, 'r-frigate', 0, mx + 300 + i * 150, my + 200, Math.PI)
  const b = newBrain(o, 'hard', 'balanced')
  let bought = false
  for (let i = 0; i < 30 * 20 && !bought; i++) {
    think(w, b, STEP)
    tick(w)
    w.events.length = 0
    bought = allQueued(w, o).some((q) => q.reserve)
    mine.hull = mine.hullMax
  }
  check('the AI buys a reinforcement for a far mine under attack', bought)
  // Finish it, and see where it goes.
  // (It and whatever is ahead of it in the yard's queue.)
  const all = allQueued(w, o)
  const qi = all.findIndex((x) => x.reserve)
  for (let i = 0; i <= qi; i++) all[i].left = STEP / 2
  let called = false
  for (let i = 0; i < 30 * 20 && !called; i++) {
    think(w, b, STEP)
    tick(w)
    w.events.length = 0
    mine.hull = mine.hullMax
    called = w.arrivals.some((a) => a.owner === o) || w.units.some((u) => !u.dead && u.owner === o && u.born > 1 && Math.hypot(u.x - mx, u.y - my) < 900 && !!UNIT[u.t.id] && u.t.tier !== 'fighter' && u.t.tier !== 'mine')
  }
  const near = w.arrivals.filter((a) => a.owner === o).every((a) => Math.hypot(a.x - mx, a.y - my) < 1000)
  if (!called || !near || p.reserve.length) console.log('  ai:', JSON.stringify({ reserve: p.reserve, q: allQueued(w, o), arrivals: w.arrivals, hands: b.hands, credits: p.credits }))
  check('and calls it in near the mine', called && near && !p.reserve.length)
  const quiet = fresh()
  const qb = newBrain(1, 'hard', 'balanced')
  for (let i = 0; i < 30 * 60; i++) {
    think(quiet, qb, STEP)
    tick(quiet)
    quiet.events.length = 0
  }
  check('with nothing far under attack it buys none in its first minute', !allQueued(quiet, 1).some((x) => x.reserve) && !quiet.players[1].reserve.length)
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall launch checks passed')
process.exit(failed ? 1 : 0)
