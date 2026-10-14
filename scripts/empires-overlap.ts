// Checks how Empires At War ships of very different sizes pass over each other, and escorts: headless,
// deterministic battles on an empty patch of space.
//
//   node scripts/empires-overlap.ts
//
// 1. A gunship flies straight across a parked flagship: neither is moved aside by the other.
// 2. An enemy gunship does the same over our flagship: friend or foe, the same.
// 3. A frigate against a cruiser is still solid: it keeps the hull gap and goes round, and the
//    cruiser isn't moved. Two gunships sent to one spot keep the hull gap too (same class).
// 4. Escorts (a Mercy corvette and two gunships guarding a flagship) take slots of their own over
//    its hull, and keep them as it flies off and turns.
// 5. An enemy coming within reach of the flagship is engaged by the escorts, which come back to their
//    slots once it is gone; one far off is left alone.
// 6. A repair escort mends the ship it escorts first, even with a worse hurt ship next to it.
// 7. When the flagship is lost, its escorts wait where they are.
// 8. The same escort battle run twice, and once frozen to a snapshot and thawed midway, ends on the
//    same state hash: what multiplayer needs.

import { MAPS } from '../src/apps/games/empires/maps.ts'
import { UNIT, type UnitType } from '../src/apps/games/empires/data.ts'
import { STEP, cmdGuard, cmdMove, damage, escortSlot, escortsOf, radius, spawn, stateHash, tick, wardOf, type Unit, type World, newWorld } from '../src/apps/games/empires/sim.ts'
import { restoreWorld, snapshotWorld } from '../src/apps/games/empires/snapshot.ts'

let failed = false
const check = (what: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}${detail ? ` (${detail})` : ''}`)
  if (!ok) failed = true
}
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y)

/** An empty battlefield: the two-player map with its stations, rocks, fields and nebulas taken away. */
function field(seed = 7): World {
  const map = MAPS.find((m) => m.spawns.length === 2) ?? MAPS[0]
  const w = newWorld(map, [{ faction: 'republic', team: 0, spawn: 0 }, { faction: 'droid', team: 1, spawn: 1 }], { seed })
  w.units = []
  w.byId.clear()
  w.arrivals = []
  w.rocks = []
  w.wrecks = []
  w.nav.clear()
  w.map = { ...w.map, fields: [], nebulas: [] }
  return w
}

/** A ship with no guns, so nothing gets shot while the hulls are measured. */
function unarmed(w: World, id: string, owner: number, x: number, y: number, a: number): Unit {
  const real = UNIT[id]
  const t: UnitType = { ...real, weapons: [], hardpoints: real.hardpoints.map((h) => ({ ...h, weapon: undefined })), carrier: undefined, support: undefined }
  const u = spawn(w, id, owner, x, y, a)
  u.t = t
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

// --- 1 and 2. Straight across a parked flagship ---------------------------------------------------------

for (const owner of [0, 1]) {
  const w = field()
  const cap = unarmed(w, 'r-capital', 0, 3000, 2300, -Math.PI / 2)
  const gun = unarmed(w, owner ? 'd-gunship' : 'r-gunship', owner, 2300, 2300, 0)
  cmdMove(w, owner, [gun.id], 3700, 2300)
  let off = 0
  let over = false
  run(w, 30, () => {
    off = Math.max(off, Math.abs(gun.y - 2300))
    if (dist(gun, cap) < radius(cap.t) * 0.3) over = true
  })
  const who = owner ? 'an enemy gunship' : 'a gunship'
  check(`${who} flies straight across a parked flagship`, off === 0 && over, `strayed ${off.toFixed(2)} off its line, crossed the middle: ${over}`)
  check(`${who} got to the far side`, dist(gun, { x: 3700, y: 2300 }) < 40, `${dist(gun, { x: 3700, y: 2300 }).toFixed(0)} short`)
  check(`the flagship under ${who} wasn't moved`, cap.x === 3000 && cap.y === 2300, `at ${cap.x.toFixed(2)}, ${cap.y.toFixed(2)}`)
}

// --- 3. Still solid ---------------------------------------------------------------------------------------

{
  const w = field()
  const cru = unarmed(w, 'r-cruiser', 0, 3000, 2300, -Math.PI / 2)
  const fr = unarmed(w, 'r-frigate', 0, 2300, 2300, 0)
  cmdMove(w, 0, [fr.id], 3700, 2300)
  let gap = Infinity
  let off = 0
  run(w, 40, () => {
    gap = Math.min(gap, dist(fr, cru) - radius(fr.t) - radius(cru.t))
    off = Math.max(off, Math.abs(fr.y - 2300))
  })
  check('the frigate went round the cruiser', off > radius(cru.t) * 0.5, `strayed ${off.toFixed(0)} off its line`)
  // (Pressing into a hull it is pushed back out over a few ticks: a little overlap on the way, never
  // a quarter of the way in, which is what ships passing over each other do.)
  check('a frigate against a cruiser keeps clear of its hull', gap > -(radius(fr.t) + radius(cru.t)) * 0.1, `closest gap ${gap.toFixed(1)}`)
  check('the frigate still got past', dist(fr, { x: 3700, y: 2300 }) < 60, `${dist(fr, { x: 3700, y: 2300 }).toFixed(0)} short`)
  check('the cruiser wasn\'t moved by the frigate', cru.x === 3000 && cru.y === 2300, `at ${cru.x.toFixed(2)}, ${cru.y.toFixed(2)}`)
}
{
  const w = field()
  const a = unarmed(w, 'r-gunship', 0, 2600, 2200, 0)
  const b = unarmed(w, 'r-gunship', 0, 2600, 2400, 0)
  cmdMove(w, 0, [a.id], 3200, 2300)
  cmdMove(w, 0, [b.id], 3200, 2300)
  run(w, 30)
  const gap = dist(a, b) - radius(a.t) - radius(b.t)
  check('two gunships sent to one spot keep the hull gap', gap >= 0, `gap ${gap.toFixed(1)}`)
}

// --- 4. Escort slots ---------------------------------------------------------------------------------------

/** Our flagship (unarmed) with a Mercy corvette and two gunships escorting it. */
function escorted(seed = 7) {
  const w = field(seed)
  const cap = unarmed(w, 'r-capital', 0, 2600, 2300, 0)
  const escorts = [spawn(w, 'r-corvette', 0, 2200, 2000, 0), spawn(w, 'r-gunship', 0, 2200, 2600, 0), spawn(w, 'r-gunship', 0, 2100, 2300, 0)]
  const why = cmdGuard(w, 0, escorts.map((u) => u.id), cap.id)
  return { w, cap, escorts, why }
}
/** How far each escort is from its own slot. */
const offSlots = (cap: Unit, escorts: Unit[]) => escorts.map((u, i) => dist(u, escortSlot(cap, i, escorts.length)))

{
  const { w, cap, escorts, why } = escorted()
  check('guarding a flagship two classes bigger is accepted', why === null, why ?? '')
  run(w, 25)
  check('all three escort the flagship', escorts.every((u) => wardOf(w, u) === cap) && escortsOf(w, cap).length === 3)
  let off = offSlots(cap, escorts)
  check('parked: each escort sits on its own slot', off.every((d) => d < 25), off.map((d) => d.toFixed(0)).join(', '))
  let apart = Infinity
  for (let i = 0; i < escorts.length; i++) for (let j = i + 1; j < escorts.length; j++) apart = Math.min(apart, dist(escorts[i], escorts[j]) - radius(escorts[i].t) - radius(escorts[j].t))
  check('the escorts don\'t stack', apart >= 0, `closest gap ${apart.toFixed(0)}`)
  check('their slots are over the flagship\'s hull', escorts.every((u) => dist(u, cap) < radius(cap.t)), escorts.map((u) => dist(u, cap).toFixed(0)).join(', '))
  // Fly off and turn: a long leg east, then north.
  cmdMove(w, 0, [cap.id], 4200, 2300)
  let worst = 0
  run(w, 50, () => {
    worst = Math.max(worst, ...offSlots(cap, escorts))
  })
  check('flying off: the escorts keep close to their slots', worst < 160, `worst ${worst.toFixed(0)}`)
  cmdMove(w, 0, [cap.id], 4400, 1000)
  run(w, 70)
  const turned = Math.abs(cap.a - -Math.PI / 2) < 0.6
  check('the flagship turned north', turned, `heading ${((cap.a * 180) / Math.PI).toFixed(0)} degrees`)
  run(w, 15)
  off = offSlots(cap, escorts)
  check('after the turn the escorts re-formed on their slots', off.every((d) => d < 30), off.map((d) => d.toFixed(0)).join(', '))
  check('and face the way the flagship does', escorts.every((u) => Math.abs(Math.atan2(Math.sin(u.a - cap.a), Math.cos(u.a - cap.a))) < 0.2), escorts.map((u) => (((u.a - cap.a) * 180) / Math.PI).toFixed(0)).join(', '))
}

// --- 5. Engaging, and coming back -----------------------------------------------------------------------------

{
  const { w, cap, escorts } = escorted()
  run(w, 25)
  // A droid gunship turns up within reach of the flagship, and another far off.
  const near = spawn(w, 'd-gunship', 1, cap.x + 550, cap.y + 200, Math.PI)
  near.stance = 'hold'
  const far = spawn(w, 'd-gunship', 1, cap.x - 2600, cap.y, 0)
  far.stance = 'hold'
  let engaged = false
  let farEngaged = false
  run(w, 6, () => {
    if (escorts.some((u) => u.target === near.id)) engaged = true
    if (escorts.some((u) => u.target === far.id)) farEngaged = true
  })
  check('an enemy within reach of the flagship is engaged', engaged)
  check('one far off is left alone', !farEngaged)
  const wentOut = Math.max(...offSlots(cap, escorts))
  run(w, 40, () => {
    if (escorts.some((u) => u.target === far.id)) farEngaged = true
  })
  check('the enemy near the flagship was destroyed', near.dead)
  check('the far one was still left alone', !farEngaged)
  run(w, 25)
  const off = offSlots(cap, escorts)
  check('the escorts went out to fight and came back to their slots', wentOut > 60 && off.every((d) => d < 30), `went out ${wentOut.toFixed(0)}, back within ${Math.max(...off).toFixed(0)}`)
  check('they still escort it', escorts.every((u) => wardOf(w, u) === cap))
}

// --- 6. Repair escorts -------------------------------------------------------------------------------------------

{
  const w = field()
  const cap = unarmed(w, 'r-capital', 0, 2600, 2300, 0)
  const crew = spawn(w, 'r-repair', 0, 2200, 2300, 0)
  const sick = unarmed(w, 'r-frigate', 0, 2600, 2900, 0)
  cmdGuard(w, 0, [crew.id], cap.id)
  run(w, 3)
  cap.hull = cap.hullMax * 0.8
  sick.hull = sick.hullMax * 0.3
  let first = 0
  run(w, 4, () => {
    if (!first && crew.aid) first = crew.aid
  })
  check('a repair escort mends the flagship first, though a frigate next to it is worse hurt', first === cap.id, first ? `went to ${w.byId.get(first)?.t.name}` : 'mended nothing')
  const before = cap.hull
  run(w, 10)
  check('the flagship is being mended', cap.hull > before, `${before.toFixed(0)} to ${cap.hull.toFixed(0)}`)

  const w2 = field()
  const cap2 = unarmed(w2, 'r-capital', 0, 2600, 2300, 0)
  const merc = spawn(w2, 'r-corvette', 0, 2200, 2300, 0)
  cmdGuard(w2, 0, [merc.id], cap2.id)
  run(w2, 20)
  cap2.hull = cap2.hullMax * 0.6
  const h0 = cap2.hull
  run(w2, 5)
  check('a Mercy corvette escort patches the flagship\'s hull', cap2.hull > h0 && merc.mending[0] === cap2.id, `${h0.toFixed(0)} to ${cap2.hull.toFixed(0)}`)
}

// --- 7. The flagship is lost ------------------------------------------------------------------------------------

{
  const { w, cap, escorts } = escorted()
  run(w, 25)
  const at = escorts.map((u) => ({ x: u.x, y: u.y }))
  damage(w, cap, 1e9, 'turbo', -1, cap.x + 500, cap.y, 1)
  run(w, 8)
  check('the flagship was destroyed', cap.dead)
  check('its escorts wait where they are', escorts.every((u, i) => !u.dead && u.order.k === 'idle' && dist(u, at[i]) < 120), escorts.map((u, i) => `${u.order.k} ${dist(u, at[i]).toFixed(0)}`).join(', '))
}

// --- 8. Determinism ----------------------------------------------------------------------------------------------

function escortBattle(seed: number, freezeAt = -1): number[] {
  let { w, cap } = escorted(seed)
  // Armed, and an enemy pair to fight: shots and targets in the hash too.
  const foes = [spawn(w, 'd-gunship', 1, 3600, 2500, Math.PI), spawn(w, 'd-frigate', 1, 3900, 2000, Math.PI)]
  cmdMove(w, 1, foes.map((u) => u.id), 2600, 2300, true)
  cmdMove(w, 0, [cap.id], 3400, 1800)
  const hashes: number[] = []
  for (let s = 1; s <= 40; s++) {
    run(w, 1)
    hashes.push(stateHash(w))
    if (s === freezeAt) {
      w = restoreWorld(snapshotWorld(w))!
      cap = w.byId.get(cap.id)!
    }
  }
  return hashes
}
{
  const a = escortBattle(11)
  const b = escortBattle(11)
  const c = escortBattle(11, 15)
  check('the same escort battle twice hashes the same every second', a.every((h, i) => h === b[i]))
  check('frozen to a snapshot and thawed midway, it keeps the same hashes', a.every((h, i) => h === c[i]), `final ${a.at(-1)!.toString(16)} / ${c.at(-1)!.toString(16)}`)
}

console.log(failed ? 'FAILED' : 'all passed')
process.exit(failed ? 1 : 0)
