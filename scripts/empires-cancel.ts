// Checks Empires At War's upgrade cancelling, headless and deterministic:
//
//   node scripts/empires-cancel.ts
//
// Everything upgrade-like can be called off while queued or under way, for its whole price:
// research and station levels, expansions on the Command Station and the yards, and a mining
// platform's own upgrades. For each kind: the full refund, nothing of it applied, the next one in
// the queue starts, a `cancelled` event for the UI. And the rules around it: only your own, only
// what is really there (the sim answers 'Nothing to cancel'), the orders through the protocol, and
// a saved battle (or a second copy) staying in sync after cancels.
//
// Every check prints a line; it exits with 1 if any of them failed.

import { BUILD_RADIUS, LEVEL_UP, MODULE, SITE_UPGRADES, TECH, UPGRADES, yardOf, type ModuleId } from '../src/apps/games/empires/data.ts'
import { MAPS } from '../src/apps/games/empires/maps.ts'
import { restoreWorld, snapshotWorld } from '../src/apps/games/empires/snapshot.ts'
import { cleanCmd, cmd, runCmd } from '../src/apps/games/empires/commands.ts'
import {
  STEP, cmdExpand, cmdPlace, cmdResearch, cmdUpgradeSite, newWorld, placement, siteUpgradeNext, spawn, spawnGroup, stateHash, tick, yardOffer, yardsOf, type Unit, type World,
} from '../src/apps/games/empires/sim.ts'

let failed = 0
const check = (what: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `: ${detail}` : ''}`)
  if (!ok) failed++
}
const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol

const map = MAPS.find((m) => m.spawns.length === 2) ?? MAPS[0]
const fresh = (level = 3): World => {
  const w = newWorld(map, [
    { faction: 'republic', team: 0, spawn: 0 },
    { faction: 'droid', team: 1, spawn: 1 },
  ], { seed: 77, credits: 60000 })
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
const spotFor = (w: World, id: string) => {
  const s = st(w)
  const away = Math.atan2(s.y - w.h / 2, s.x - w.w / 2)
  for (let d = 500; d < BUILD_RADIUS; d += 100)
    for (const off of [0, 0.5, -0.5, 1, -1, 1.5, -1.5, 2, -2, 2.6, -2.6, 3.1]) {
      const x = s.x + Math.cos(away + off) * d
      const y = s.y + Math.sin(away + off) * d
      if (!placement(w, 0, id, x, y).why) return { x, y }
    }
  throw new Error(`no spot for ${id}`)
}
/** A Frigate Yard put up by three squadrons of engineers, run until it stands. */
const yard = (w: World): Unit => {
  const id = yardOf('republic', 'yard').id
  const spot = spotFor(w, id)
  const s = st(w)
  const crew = Array.from({ length: 3 }, (_, i) => spawnGroup(w, 'r-engineer', 0, s.x + 250, s.y + 60 * i, 0)).flat()
  const why = cmdPlace(w, 0, ids(crew), id, spot.x, spot.y)
  if (why) throw new Error(why)
  run(w, 200, () => yardsOf(w, 0).some((u) => u.t.id === id))
  for (const u of crew) {
    u.dead = true
    w.byId.delete(u.id)
  }
  w.units = w.units.filter((u) => !u.dead)
  return yardsOf(w, 0).find((u) => u.t.id === id)!
}
const mine = (w: World, o = 0): Unit => {
  const s = st(w, o)
  const m = spawn(w, o === 0 ? 'r-mine' : 'd-mine', o, s.x + 400, s.y + 400, 0)
  m.building = 0
  return m
}
const lastCancelled = (w: World) => w.events.filter((e) => e.k === 'cancelled').at(-1)

// --- Research, and the station's levels --------------------------------------------------------------------
{
  const w = fresh(2)
  const p = w.players[0]
  const techs = Object.values(TECH).filter((t) => t.faction === 'republic' && t.level <= 2 && !t.requires?.length)
  const a = techs[0].id
  const b = techs[1].id
  const c0 = p.credits
  check('research is paid when ordered', cmdResearch(w, 0, a) === null && cmdResearch(w, 0, b) === null && near(c0 - p.credits, TECH[a].cost + TECH[b].cost))
  run(w, 3)
  const spent = p.spentBy.research
  const c1 = p.credits
  w.events.length = 0
  check('cancelling the one under way: nothing to refuse', runCmd(w, 0, cmd('cancelResearch', 0)) === null)
  check('...refunds it in full', near(p.credits - c1, TECH[a].cost), `+${p.credits - c1}`)
  check('...no effect applied', !p.techs.includes(a) && p.research.length === 1 && p.research[0].id === b)
  check('...the ledger takes it off what was spent on research', near(p.spentBy.research, spent - TECH[a].cost))
  const ev = lastCancelled(w)
  check('...a cancelled event tells the UI the refund', !!ev && ev.k === 'cancelled' && ev.owner === 0 && near(ev.amount, TECH[a].cost))
  const left0 = p.research[0].left
  run(w, 2)
  check('the next one starts', p.research[0].left < left0 - 1.9)
  const c2 = p.credits
  cmdResearch(w, 0, a)
  check('cancelling one still queued refunds it in full', runCmd(w, 0, cmd('cancelResearch', 1)) === null && near(p.credits - c2, 0) && p.research.length === 1)
  // A station level, while it is being researched.
  const lv = p.level
  const c3 = p.credits
  cmdResearch(w, 0, LEVEL_UP)
  run(w, 4)
  check('a station level under way...', p.research.some((r) => r.id === LEVEL_UP))
  const i = p.research.findIndex((r) => r.id === LEVEL_UP)
  w.events.length = 0
  const c3b = p.credits
  runCmd(w, 0, cmd('cancelResearch', i))
  check('...is refunded in full and the level is unchanged', near(p.credits - c3b, UPGRADES[lv + 1]!.cost) && p.level === lv && c3 > 0)
  check('...with a refund event', near((lastCancelled(w) as { amount: number } | undefined)?.amount ?? -1, UPGRADES[lv + 1]!.cost))
  check('nothing to cancel past the queue', runCmd(w, 0, cmd('cancelResearch', 5)) === 'Nothing to cancel' && runCmd(w, 0, cmd('cancelResearch', -1)) === 'Nothing to cancel')
}

// --- Expansions: the Command Station and a yard ------------------------------------------------------------
{
  const w = fresh(3)
  const y = yard(w)
  const p = w.players[0]
  for (const [where, u, first, second] of [
    ['the Command Station', st(w), 'sensorArray', 'shieldCore'],
    ['a yard', y, 'secondSlip', 'drydock'],
  ] as [string, Unit, ModuleId, ModuleId][]) {
    const s0 = p.spentBy.structures
    cmdExpand(w, 0, u.id, first)
    cmdExpand(w, 0, u.id, second)
    run(w, 4)
    const spent = p.spentBy.structures
    const c1 = p.credits
    w.events.length = 0
    check(`${where}: cancel the expansion under way`, runCmd(w, 0, cmd('cancelExpand', u.id, 0)) === null)
    check('...refunded in full', near(p.credits - c1, MODULE[first].cost), `+${p.credits - c1}`)
    check('...nothing applied', !u.xm?.includes(first) && u.xq!.length === 1 && u.xq![0].id === second)
    check('...the ledger takes it off', near(p.spentBy.structures, spent - MODULE[first].cost))
    check('...with a refund event', near((lastCancelled(w) as { amount: number } | undefined)?.amount ?? -1, MODULE[first].cost))
    const left = u.xq![0].left
    run(w, 3)
    check('...the next one starts', u.xq![0].left < left - 2.9 && u.xq![0].left < u.xq![0].total)
    cmdExpand(w, 0, u.id, first)
    const c2 = p.credits
    check('a queued one is refunded in full', runCmd(w, 0, cmd('cancelExpand', u.id, 1)) === null && near(p.credits - c2, MODULE[first].cost) && u.xq!.length === 1)
    check('and only what was queued is ever built', (() => {
      runCmd(w, 0, cmd('cancelExpand', u.id, 0))
      run(w, MODULE[second].time + MODULE[first].time + 5)
      return !u.xm?.length
    })())
    check(`${where}: all cancelled, the books are even`, near(p.spentBy.structures, s0) && u.xq!.length === 0, `${p.spentBy.structures} against ${s0}`)
  }
}

// --- A mining platform's upgrades ----------------------------------------------------------------------------
{
  const w = fresh(3)
  const m = mine(w)
  const p = w.players[0]
  for (const up of SITE_UPGRADES) {
    const next = siteUpgradeNext(m, up.id)!
    const c0 = p.credits
    const spent = p.spentBy.structures
    const type = m.t
    const hull = m.hullMax
    check(`${up.name}: ordered and paid`, cmdUpgradeSite(w, 0, m.id, up.id) === null && near(c0 - p.credits, next.cost) && m.upgrading?.id === up.id)
    // Queued is the same as under way for a platform: it fits one at a time, from the moment it is ordered.
    run(w, up.time / 2)
    w.events.length = 0
    const before = p.credits
    check('...cancelled while being fitted', runCmd(w, 0, cmd('cancelUpgradeSite', m.id)) === null && m.upgrading === null)
    check('...refunded in full', near(p.credits - before, next.cost), `+${p.credits - before}`)
    check('...nothing applied: level, model and hull as before', !m.upg[up.id] && m.t === type && m.hullMax === hull && m.shield === 0)
    check('...the ledger is even', near(p.spentBy.structures, spent))
    const ev = lastCancelled(w)
    check('...with a refund event', !!ev && ev.k === 'cancelled' && near(ev.amount, next.cost))
    run(w, up.time)
    check('...and it never completes afterwards', !m.upg[up.id])
    check('...so it can be ordered again', cmdUpgradeSite(w, 0, m.id, up.id) === null)
    runCmd(w, 0, cmd('cancelUpgradeSite', m.id))
  }
  // The second level of the drills is refunded at its own price.
  cmdUpgradeSite(w, 0, m.id, 'yield')
  run(w, SITE_UPGRADES[0].time + 1)
  check('level 1 of Deeper drills fitted', m.upg.yield === 1 && !m.upgrading)
  cmdUpgradeSite(w, 0, m.id, 'yield')
  run(w, 5)
  const before = p.credits
  runCmd(w, 0, cmd('cancelUpgradeSite', m.id))
  check('level 2 is refunded at the level 2 price and level 1 stays', near(p.credits - before, SITE_UPGRADES[0].cost[1]) && m.upg.yield === 1)
  check('nothing to cancel with nothing being fitted', runCmd(w, 0, cmd('cancelUpgradeSite', m.id)) === 'Nothing to cancel')
}

// --- Only your own, only what is there; through the protocol ---------------------------------------------
{
  const w = fresh(3)
  const m = mine(w)
  const y = yard(w)
  const p0 = w.players[0]
  const p1 = w.players[1]
  cmdUpgradeSite(w, 0, m.id, 'shield')
  cmdExpand(w, 0, y.id, 'secondSlip')
  cmdResearch(w, 0, Object.values(TECH).find((t) => t.faction === 'republic' && t.level <= 3 && !t.requires?.length)!.id)
  const c0 = p0.credits
  const e0 = p1.credits
  check('the enemy can\'t cancel our platform upgrade', runCmd(w, 1, cmd('cancelUpgradeSite', m.id)) === 'Nothing to cancel' && !!m.upgrading && p1.credits === e0)
  check('the enemy can\'t cancel our expansion', runCmd(w, 1, cmd('cancelExpand', y.id, 0)) === 'Nothing to cancel' && y.xq!.length === 1 && p1.credits === e0)
  check('the enemy\'s research index is its own queue, not ours', runCmd(w, 1, cmd('cancelResearch', 0)) === 'Nothing to cancel' && p0.research.length === 1)
  check('an id that doesn\'t exist, or isn\'t a platform', runCmd(w, 0, cmd('cancelUpgradeSite', 999999)) === 'Nothing to cancel' && runCmd(w, 0, cmd('cancelUpgradeSite', y.id)) === 'Nothing to cancel')
  check('an expansion that isn\'t queued', runCmd(w, 0, cmd('cancelExpand', y.id, 1)) === 'Nothing to cancel' && runCmd(w, 0, cmd('cancelExpand', st(w).id, 0)) === 'Nothing to cancel')
  check('none of those moved our credits', p0.credits === c0)
  check('the orders pass the protocol', !!cleanCmd({ f: 'cancelUpgradeSite', a: [m.id] }, w) && !!cleanCmd({ f: 'cancelExpand', a: [y.id, 0] }, w) && !!cleanCmd({ f: 'cancelResearch', a: [0] }, w))
  check('and a malformed one doesn\'t', !cleanCmd({ f: 'cancelUpgradeSite', a: ['x'] }, w) && !cleanCmd({ f: 'cancelUpgradeSite', a: [1, 2] }, w) && !cleanCmd({ f: 'cancelUpgradeSite', a: [-5] }, w))
  check('the order name is not the enemy\'s to give for us: it is the sender\'s seat that runs', (() => {
    const c = cleanCmd({ f: 'cancelUpgradeSite', a: [m.id], o: 0 }, w)
    return !!c && runCmd(w, 1, c) === 'Nothing to cancel' && !!m.upgrading
  })())
}

// --- Save and restore, and two copies, in sync after cancels ------------------------------------------------
{
  const make = () => {
    const w = fresh(3)
    const m = mine(w)
    const y = yard(w)
    cmdUpgradeSite(w, 0, m.id, 'armor')
    cmdExpand(w, 0, y.id, 'secondSlip')
    cmdExpand(w, 0, y.id, 'drydock')
    cmdExpand(w, 0, st(w).id, 'shieldCore')
    cmdResearch(w, 0, Object.values(TECH).filter((t) => t.faction === 'republic' && t.level <= 3 && !t.requires?.length)[0].id)
    cmdResearch(w, 0, LEVEL_UP)
    return { w, m, y }
  }
  const A = make()
  const B = make()
  run(A.w, 10)
  run(B.w, 10)
  const C = restoreWorld(snapshotWorld(A.w))!
  const cm = C.units.find((u) => u.t.tier === 'mine' && u.owner === 0)!
  const cy = yardsOf(C, 0)[0]
  let same = stateHash(A.w) === stateHash(B.w) && stateHash(A.w) === stateHash(C)
  const cancels = (w: World, m: Unit, y: Unit) => {
    runCmd(w, 0, cmd('cancelUpgradeSite', m.id))
    runCmd(w, 0, cmd('cancelExpand', y.id, 0))
    runCmd(w, 0, cmd('cancelExpand', st(w).id, 0))
    runCmd(w, 0, cmd('cancelResearch', 0))
  }
  for (let t = 0; t < 90 / STEP && same; t++) {
    for (const w of [A.w, B.w, C]) {
      tick(w)
      w.events.length = 0
    }
    if (t === Math.round(5 / STEP)) {
      cancels(A.w, A.m, A.y)
      cancels(B.w, B.m, B.y)
      cancels(C, cm, cy)
    }
    if (t % 25 === 0 && (stateHash(A.w) !== stateHash(C) || stateHash(A.w) !== stateHash(B.w))) same = false
  }
  check('a restored battle and a second copy stay in sync through cancels', same, `hash ${stateHash(A.w).toString(16)}`)
  const mid = restoreWorld(snapshotWorld(A.w))!
  check('a battle saved after cancelling restores with the same hash', stateHash(mid) === stateHash(A.w))
  check('the cancelled upgrades never arrived', !A.m.upg.armor && !A.y.xm?.includes('secondSlip') && !st(A.w).xm?.length)
}

// --- The engineers' Build section: what the yard cards show ----------------------------------------------------
{
  const w = fresh(1)
  const p = w.players[0]
  const fy = yardOf('republic', 'yard')
  const cy = yardOf('republic', 'cyard')
  const a = yardOffer(w, 0, fy, 3)
  check('one squadron takes the yard\'s build time', a.secs === fy.build && a.cost === fy.cost && !a.ours && !a.ruin)
  check('two squadrons go in half the time, three in a third', yardOffer(w, 0, fy, 6).secs === Math.ceil(fy.build / 2) && yardOffer(w, 0, fy, 9).secs === Math.ceil(fy.build / 3))
  check('more than three squadrons add nothing', yardOffer(w, 0, fy, 30).secs === yardOffer(w, 0, fy, 9).secs)
  check('a yard above the station level is locked, with the reason', (() => {
    const o = yardOffer(w, 0, fy.level > 1 ? fy : cy, 3)
    return o.locked && o.why === `Needs station level ${(fy.level > 1 ? fy : cy).level}`
  })())
  p.level = 4
  p.credits = 10
  check('short of credits: not locked, the reason is credits', (() => {
    const o = yardOffer(w, 0, fy, 3)
    return !o.locked && o.poor && !!o.why?.startsWith('Not enough credits')
  })())
  p.credits = 60000
  check('affordable and unlocked: no reason', (() => {
    const o = yardOffer(w, 0, cy, 3)
    return !o.locked && !o.poor && o.why === null
  })())
  const y = yard(w)
  const o = yardOffer(w, 0, fy, 3)
  check('a yard we have shows as ours, with no reason', o.ours === y && o.why === null)
  w.ruins = [{ id: 1, owner: 0, unit: cy.id, x: y.x + 900, y: y.y, a: 0 } as never]
  const r = yardOffer(w, 0, cy, 3)
  check('a ruin shows the cheaper rebuild price', r.ruin && r.cost < cy.cost, `${r.cost} against ${cy.cost}`)
}

// --- The AI copes with a cancelled upgrade of its own ------------------------------------------------------------
{
  // The AI never cancels, but should an upgrade of its own vanish (a cancel in a battle with seats
  // run by it), it just orders again: the platform's state is plain data, nothing waits on it.
  const w = fresh(3)
  const m = mine(w, 1)
  const p = w.players[1]
  const c0 = p.credits
  cmdUpgradeSite(w, 1, m.id, 'yield')
  runCmd(w, 1, cmd('cancelUpgradeSite', m.id))
  check('an AI seat\'s platform upgrade can be cancelled and re-ordered', p.credits === c0 && cmdUpgradeSite(w, 1, m.id, 'yield') === null && m.upgrading?.id === 'yield')
}

console.log(failed ? `\n${failed} check${failed === 1 ? '' : 's'} failed` : '\nall checks passed')
process.exit(failed ? 1 : 0)
