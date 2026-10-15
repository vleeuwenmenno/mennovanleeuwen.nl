// Checks the repair order in Empires At War (a right-click on a damaged ship of ours or an ally's
// with repair ships selected).
//
//   1. A Mercy corvette told to repair a damaged frigate of ours far off flies to it, patches it
//      whole, and then waits.
//   2. One escorting a flagship, told to repair an ally's frigate, patches that first and then goes
//      back to escorting the flagship.
//   3. An enemy's ship is refused (and so is a ship with nothing to repair); the selection keeps
//      its orders.
//   4. In a mixed selection only the repair ships take the order: the warships are left alone (the
//      game gives them their own move).
//   5. A Field repair craft told to repair an ally's frigate runs out to it and welds it back.
//   6. Engineers told to repair an ally's damaged station weld it, paying for nothing.
//   7. The order goes through the protocol's cleaning; the same repair battle run twice, and once
//      frozen to a snapshot and thawed midway, ends on the same state hash.
//
//   node scripts/empires-heal.ts
//
// Exits 1 on any failure.

import { cleanCmd, runCmd } from '../src/apps/games/empires/commands.ts'
import { MAPS } from '../src/apps/games/empires/maps.ts'
import { STEP, cantHeal, cantMendOn, cmdGuard, cmdMend, hullCap, newWorld, spawn, stateHash, tick, wardOf, type Unit, type World } from '../src/apps/games/empires/sim.ts'
import { restoreWorld, snapshotWorld } from '../src/apps/games/empires/snapshot.ts'

let failed = false
const check = (what: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}${detail ? ` (${detail})` : ''}`)
  if (!ok) failed = true
}
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y)

const map = MAPS.find((m) => m.spawns.length === 4) ?? MAPS[0]
/** Seats 0 and 1 (Republic) against 2 and 3 (droids). */
const seats = [0, 1, 2, 3].map((i) => ({ faction: i < 2 ? ('republic' as const) : ('droid' as const), team: i < 2 ? 0 : 1, spawn: i }))

/** An empty battlefield (no stations, rocks, fields or nebulas), or the map as it starts with `keep`. */
function field(seed = 7, keep = false): World {
  const w = newWorld(map, seats, { seed })
  if (keep) return w
  w.units = []
  w.byId.clear()
  w.arrivals = []
  w.rocks = []
  w.wrecks = []
  w.nav.clear()
  w.map = { ...w.map, fields: [], nebulas: [] }
  return w
}

/** A ship with no guns, so nothing gets shot while the repairs are measured. */
function unarmed(w: World, id: string, owner: number, x: number, y: number, a = 0): Unit {
  const u = spawn(w, id, owner, x, y, a)
  u.guns = []
  u.stance = 'hold'
  return u
}

function run(w: World, secs: number, each?: () => void) {
  const n = Math.round(secs / STEP)
  for (let i = 0; i < n; i++) {
    tick(w)
    w.events.length = 0
    each?.()
  }
}

// --- 1. A Mercy repairs a frigate of ours ------------------------------------------------------------------

{
  const w = field()
  const merc = unarmed(w, 'r-corvette', 0, 2000, 2300)
  const fr = unarmed(w, 'r-frigate', 0, 3400, 2300, Math.PI)
  fr.hull = fr.hullMax * 0.4
  const why = cmdMend(w, 0, [merc.id], fr.id)
  check('a Mercy can be told to repair a damaged frigate of ours', why === null && merc.order.k === 'mend', why ?? merc.order.k)
  let closest = Infinity
  let healed = false
  run(w, 90, () => {
    closest = Math.min(closest, dist(merc, fr))
    if (fr.hull >= hullCap(fr) - 0.5) healed = true
  })
  check('it flew over to the frigate, into reach', closest < merc.t.support!.range * 0.7, `closest ${closest.toFixed(0)}`)
  check('and patched it whole', healed, `${fr.hull.toFixed(0)} of ${fr.hullMax}`)
  check('then it waits where it is', merc.order.k === 'idle', merc.order.k)
}

// --- 2. An escort repairs an ally's frigate and comes back --------------------------------------------------

{
  const w = field()
  const cap = unarmed(w, 'r-capital', 0, 2400, 2300)
  const merc = unarmed(w, 'r-corvette', 0, 2200, 2300)
  cmdGuard(w, 0, [merc.id], cap.id)
  run(w, 20)
  check('the Mercy escorts the flagship', wardOf(w, merc) === cap)
  const ally = unarmed(w, 'r-frigate', 1, 4200, 2300, Math.PI)
  ally.hull = ally.hullMax * 0.5
  check('an ally\'s damaged frigate is a valid patient', cantHeal(w, 0, merc, ally) === null && cantMendOn(w, 0, ally.id) === null)
  const why = cmdMend(w, 0, [merc.id], ally.id)
  check('the repair order on the ally\'s frigate is taken', why === null && merc.order.k === 'mend' && merc.order.back === cap.id, why ?? '')
  let mended = false
  run(w, 90, () => {
    if (merc.mending[0] === ally.id) mended = true
  })
  check('the Mercy patched the ally\'s frigate', mended && ally.hull >= hullCap(ally) - 0.5, `${ally.hull.toFixed(0)} of ${ally.hullMax}`)
  check('and went back to escorting the flagship', merc.order.k === 'guard' && merc.order.id === cap.id, merc.order.k)
  run(w, 40)
  check('it is back over the flagship', wardOf(w, merc) === cap && dist(merc, cap) < 450, `${dist(merc, cap).toFixed(0)} away`)
}

// --- 3. Refusals ------------------------------------------------------------------------------------------

{
  const w = field()
  const merc = unarmed(w, 'r-corvette', 0, 2000, 2300)
  const crew = unarmed(w, 'r-repair', 0, 2000, 2500)
  const foe = unarmed(w, 'd-frigate', 2, 3000, 2300, Math.PI)
  foe.hull = foe.hullMax * 0.3
  const whole = unarmed(w, 'r-frigate', 1, 3000, 2600)
  const r1 = cmdMend(w, 0, [merc.id, crew.id], foe.id)
  check('a repair order on an enemy is refused', !!r1 && /allies/.test(r1) && merc.order.k === 'idle' && crew.order.k === 'idle', r1 ?? 'taken')
  check('so is one on an enemy for the referee', !!cantMendOn(w, 0, foe.id))
  const r2 = cmdMend(w, 0, [merc.id], whole.id)
  check('and one on a ship with nothing to repair', r2 === 'Nothing to repair' && merc.order.k === 'idle', r2 ?? 'taken')
  const r3 = cmdMend(w, 1, [merc.id], whole.id)
  check('nobody orders another player\'s repair ships', !!r3 && merc.order.k === 'idle', r3 ?? 'taken')
}

// --- 4. A mixed selection ------------------------------------------------------------------------------------

{
  const w = field()
  const merc = unarmed(w, 'r-corvette', 0, 2000, 2300)
  const gun = unarmed(w, 'r-gunship', 0, 2000, 2500)
  const fr = unarmed(w, 'r-frigate', 0, 2800, 2300)
  fr.hull = fr.hullMax * 0.5
  const why = cmdMend(w, 0, [merc.id, gun.id], fr.id)
  check('in a Mercy and gunship selection only the Mercy takes the repair order', why === null && merc.order.k === 'mend' && gun.order.k === 'idle', `${merc.order.k}, ${gun.order.k}`)
  // A tender can't fix structures; a Field repair craft mends gunships and up, not strike craft.
  const fighter = unarmed(w, 'r-fighter', 0, 2600, 2700)
  fighter.hull = fighter.hullMax * 0.5
  const crew = unarmed(w, 'r-repair', 0, 2000, 2700)
  check('a Field repair craft passes on strike craft', !!cantHeal(w, 0, crew, fighter))
  check('a Mercy patches strike craft', cantHeal(w, 0, merc, fighter) === null)
}

// --- 5. Field repair on an ally's frigate ------------------------------------------------------------------------

{
  const w = field()
  const crew = [unarmed(w, 'r-repair', 0, 2000, 2300), unarmed(w, 'r-repair', 0, 2000, 2340)]
  const ally = unarmed(w, 'r-frigate', 1, 3600, 2300, Math.PI)
  ally.hull = ally.hullMax * 0.6
  const h0 = ally.hull
  const why = cmdMend(w, 0, crew.map((u) => u.id), ally.id)
  check('repair craft take the order on an ally\'s frigate', why === null && crew.every((u) => u.order.k === 'mend'), why ?? '')
  let ran = false
  run(w, 20, () => {
    if (crew.some((u) => u.aid === ally.id)) ran = true
  })
  check('they start a Field repair run on it', ran)
  check('and weld it back', ally.hull > h0 + 50, `${h0.toFixed(0)} to ${ally.hull.toFixed(0)}`)
}

// --- 6. Engineers on an ally's station --------------------------------------------------------------------------

{
  const w = field(7, true)
  const st = w.units.find((u) => u.owner === 1 && u.t.tier === 'station')!
  st.hull = st.hullMax * 0.7
  const eng = [0, 1, 2].map((k) => unarmed(w, 'r-engineer', 0, st.x + 500, st.y + k * 40))
  const credits = w.players[1].credits
  const why = cmdMend(w, 0, eng.map((u) => u.id), st.id)
  check('engineers take a repair order on an ally\'s station (as a construct order)', why === null && eng.every((u) => u.order.k === 'construct'), why ?? '')
  const h0 = st.hull
  run(w, 20)
  check('and weld it', st.hull > h0, `${h0.toFixed(0)} to ${st.hull.toFixed(0)}`)
  check('without spending the ally\'s credits', w.players[1].credits >= credits)
  const enemy = w.units.find((u) => u.owner === 2 && u.t.tier === 'station')!
  enemy.hull = enemy.hullMax * 0.5
  check('an enemy station is refused', !!cmdMend(w, 0, eng.map((u) => u.id), enemy.id))
}

// --- 7. The protocol, and determinism --------------------------------------------------------------------------

{
  const w = field()
  const merc = unarmed(w, 'r-corvette', 0, 2000, 2300)
  const fr = unarmed(w, 'r-frigate', 1, 2800, 2300)
  fr.hull = fr.hullMax * 0.5
  const c = cleanCmd({ f: 'mend', a: [[merc.id], fr.id, false] }, w)
  check('the order goes through the protocol', !!c && runCmd(w, 0, c) === null && merc.order.k === 'mend')
  check('a broken one does not', cleanCmd({ f: 'mend', a: [[merc.id], 'x'] }, w) === null && cleanCmd({ f: 'mend', a: [merc.id, fr.id] }, w) === null)
}

function healBattle(seed: number, freezeAt = -1): number[] {
  let w = field(seed)
  const cap = spawn(w, 'r-capital', 0, 2400, 2300, 0)
  const merc = spawn(w, 'r-corvette', 0, 2200, 2300, 0)
  const crew = [spawn(w, 'r-repair', 0, 2000, 2300, 0), spawn(w, 'r-repair', 0, 2000, 2340, 0)]
  const ally = spawn(w, 'r-frigate', 1, 3600, 2300, Math.PI)
  ally.hull = ally.hullMax * 0.4
  cap.hull = cap.hullMax * 0.7
  cmdGuard(w, 0, [merc.id], cap.id)
  const foes = [spawn(w, 'd-gunship', 2, 4400, 2500, Math.PI), spawn(w, 'd-gunship', 3, 4500, 2100, Math.PI)]
  const hashes: number[] = []
  for (let s = 1; s <= 40; s++) {
    if (s === 3) cmdMend(w, 0, [merc.id], ally.id)
    if (s === 4) cmdMend(w, 0, crew.map((u) => u.id), cap.id)
    if (s === 6) for (const f of foes) f.order = { k: 'move', x: 2600, y: 2300, attack: true, speed: Infinity }
    run(w, 1)
    hashes.push(stateHash(w))
    if (s === freezeAt) w = restoreWorld(snapshotWorld(w))!
  }
  return hashes
}
{
  const a = healBattle(11)
  const b = healBattle(11)
  const c = healBattle(11, 15)
  check('the same repair battle twice hashes the same every second', a.every((h, i) => h === b[i]))
  check('frozen to a snapshot and thawed midway, it keeps the same hashes', a.every((h, i) => h === c[i]), `final ${a.at(-1)!.toString(16)} / ${c.at(-1)!.toString(16)}`)
}

console.log(failed ? 'FAILED' : 'all passed')
process.exit(failed ? 1 : 0)
