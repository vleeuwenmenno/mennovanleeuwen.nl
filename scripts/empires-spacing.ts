// Checks how Empires At War warships line up when they attack: headless, deterministic battles on
// an empty patch of space against stand-in targets that don't move or shoot back (unless a check
// moves them on purpose).
//
//   node scripts/empires-spacing.ts
//
// 1. Six gunships ordered onto one cruiser (and onto a station) spread over an arc on the side they
//    came from: no two hulls overlap, every gun that counts reaches, none of them hugs the target,
//    and the arc spans more than 30 degrees but not much more than 120.
// 2. A lone gunship stops where its shortest gun that counts reaches.
// 3. A flagship with turbolasers and flak stops at turbolaser range against a capital ship (flak
//    doesn't count there), but closes to flak range against fighters.
// 4. A mixed group of cruisers and frigates on a flagship keeps clear of each other too, and a
//    group too big for one arc forms a second row nearer in, still within reach.
// 5. When the target flies off, the group follows and settles round it again.
// 6. The same battle run twice, and once frozen to a snapshot and thawed midway, ends on the same
//    state hash: what multiplayer needs.

import { MAPS } from '../src/apps/games/empires/maps.ts'
import { UNIT, type UnitType } from '../src/apps/games/empires/data.ts'
import { STEP, cmdAttack, cmdMove, hpPos, radius, relevantGuns, spawn, stateHash, stopDistance, tick, type Unit, type World, newWorld } from '../src/apps/games/empires/sim.ts'
import { restoreWorld, snapshotWorld } from '../src/apps/games/empires/snapshot.ts'

let failed = false
const check = (what: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}${detail ? ` (${detail})` : ''}`)
  if (!ok) failed = true
}
const deg = (r: number) => (r * 180) / Math.PI
const wrap = (a: number) => ((((a + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) - Math.PI

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

/** A stand-in target: the real hull and size, no guns, and it never moves unless `speed` is given. */
function dummy(w: World, id: string, x: number, y: number, speed = 0): Unit {
  const real = UNIT[id]
  const t: UnitType = { ...real, speed, weapons: [], hardpoints: real.hardpoints.map((h) => ({ ...h, weapon: undefined })), carrier: undefined }
  const u = spawn(w, id, 1, x, y, Math.PI)
  u.t = t
  u.guns = []
  u.hull = u.hullMax = 1e9
  u.stance = 'hold'
  return u
}

function run(w: World, secs: number) {
  const n = Math.round(secs / STEP)
  for (let i = 0; i < n; i++) {
    tick(w)
    w.events.length = 0
  }
}

/** Ships of ours lined up side by side at (x, y), noses towards +x, `gap` apart. */
function line(w: World, id: string, n: number, x: number, y: number, gap: number): Unit[] {
  return Array.from({ length: n }, (_, i) => spawn(w, id, 0, x, y + (i - (n - 1) / 2) * gap, 0))
}

/** The shortest reach of the guns that count against `e`, as written (with research). */
const shortest = (u: Unit, e: Unit) => Math.min(...relevantGuns(u, e.t.tier).map((g) => g.w.range * u.mods.range))

/** Whether every gun that counts against `e` reaches it from where it sits, the way `shoot` measures it. */
function allReach(u: Unit, e: Unit) {
  return relevantGuns(u, e.t.tier).every((g) => {
    const from = g.hp >= 0 ? hpPos(u, g.hp) : u
    return Math.hypot(e.x - from.x, e.y - from.y) <= g.w.range * u.mods.range + radius(e.t) * 0.5
  })
}

/** The checks on a group that has settled round its target. */
/** `rows`: a group too big for one arc, whose inner row sits nearer than 70%: that check is left out. */
function settled(name: string, ships: Unit[], e: Unit, arc = true, rows = false) {
  let overlap = Infinity
  for (let i = 0; i < ships.length; i++)
    for (let j = i + 1; j < ships.length; j++) {
      const a = ships[i]
      const b = ships[j]
      overlap = Math.min(overlap, Math.hypot(a.x - b.x, a.y - b.y) - radius(a.t) - radius(b.t))
    }
  if (ships.length > 1) check(`${name}: no two hulls overlap`, overlap >= 0, `closest gap ${overlap.toFixed(1)}`)
  const reach = ships.every((u) => allReach(u, e))
  check(`${name}: every gun that counts reaches`, reach)
  const share = ships.map((u) => (Math.hypot(e.x - u.x, e.y - u.y) - radius(e.t)) / shortest(u, e))
  if (!rows) check(
    `${name}: distance to the target's hull is 70-100% of the shortest gun that counts`,
    share.every((s) => s >= 0.7 && s <= 1),
    `from ${(Math.min(...share) * 100).toFixed(0)}% to ${(Math.max(...share) * 100).toFixed(0)}%`,
  )
  check(`${name}: they have stopped`, ships.every((u) => Math.abs(u.v) < 3), `fastest ${Math.max(...ships.map((u) => Math.abs(u.v))).toFixed(1)}`)
  if (!arc) return
  const ang = ships.map((u) => Math.atan2(u.y - e.y, u.x - e.x))
  const mid = Math.atan2(ang.reduce((s, a) => s + Math.sin(a), 0), ang.reduce((s, a) => s + Math.cos(a), 0))
  const rel = ang.map((a) => wrap(a - mid))
  const spread = deg(Math.max(...rel) - Math.min(...rel))
  check(`${name}: spread over an arc of 30-125 degrees`, spread > 30 && spread <= 125, `${spread.toFixed(0)} degrees`)
}

// --- 1. Six gunships on a cruiser, and on a station --------------------------------------------------

function gunshipsOnCruiser(seed = 7, freezeAt = -1): { w: World; ships: Unit[]; e: Unit; hashes: number[] } {
  let w = field(seed)
  const e = dummy(w, 'd-cruiser', 3800, 2300)
  const ships = line(w, 'r-gunship', 6, 3150, 2300, 70)
  cmdAttack(w, 0, ships.map((u) => u.id), e.id)
  const hashes: number[] = []
  for (let s = 1; s <= 40; s++) {
    run(w, 1)
    hashes.push(stateHash(w))
    if (s === freezeAt) w = restoreWorld(snapshotWorld(w))!
  }
  return { w, ships: ships.map((u) => w.byId.get(u.id)!), e: w.byId.get(e.id)!, hashes }
}
{
  const { ships, e } = gunshipsOnCruiser()
  settled('6 gunships on a cruiser', ships, e)
}
{
  const w = field()
  const e = dummy(w, 'd-station', 3800, 2300)
  const ships = line(w, 'r-gunship', 6, 2500, 2000, 80)
  cmdAttack(w, 0, ships.map((u) => u.id), e.id)
  run(w, 40)
  settled('6 gunships on a station', ships, e)
}

// --- 2. A lone gunship ---------------------------------------------------------------------------------

{
  const w = field()
  const e = dummy(w, 'd-cruiser', 3800, 2300)
  const [u] = line(w, 'r-gunship', 1, 3150, 2400, 0)
  cmdAttack(w, 0, [u.id], e.id)
  run(w, 25)
  settled('a lone gunship', [u], e, false)
  const want = stopDistance(u, e).stop
  const got = Math.hypot(e.x - u.x, e.y - u.y)
  check('a lone gunship stops at its stopping distance', Math.abs(got - want) < 15, `${got.toFixed(0)} from the centre, wanted ${want.toFixed(0)}`)
}

// --- 3. Long guns and flak -------------------------------------------------------------------------------

{
  const w = field()
  const e = dummy(w, 'd-capital', 4200, 2300)
  const [u] = line(w, 'r-capital', 1, 2900, 2300, 0)
  const flak = u.guns.filter((g) => g.w.kind === 'flak')
  check('flak does not count against a capital ship', relevantGuns(u, 'capital').every((g) => g.w.kind === 'turbo'))
  cmdAttack(w, 0, [u.id], e.id)
  run(w, 70)
  settled('a flagship on a capital ship', [u], e, false)
  const d = Math.hypot(e.x - u.x, e.y - u.y)
  const flakReach = flak[0].w.range + radius(e.t) * 0.5
  check('a flagship holds at turbolaser range, outside its flak range', d > flakReach + 150, `${d.toFixed(0)} from the centre, flak reaches ${flakReach.toFixed(0)}`)
}
{
  const w = field()
  const e = dummy(w, 'd-fighter', 3600, 2300)
  const [u] = line(w, 'r-capital', 1, 2900, 2300, 0)
  check('flak counts against fighters', relevantGuns(u, 'fighter').some((g) => g.w.kind === 'flak'))
  cmdAttack(w, 0, [u.id], e.id)
  run(w, 60)
  settled('a flagship on a fighter', [u], e, false)
  const d = Math.hypot(e.x - u.x, e.y - u.y)
  const flakReach = 340 + radius(e.t) * 0.5
  check('a flagship closes to flak range on a fighter', d <= flakReach, `${d.toFixed(0)} from the centre, flak reaches ${flakReach.toFixed(0)}`)
}

// --- 4. A mixed group -------------------------------------------------------------------------------------

{
  const w = field()
  const e = dummy(w, 'd-capital', 4300, 2300)
  const ships = [...line(w, 'r-cruiser', 3, 3500, 2300, 260), ...line(w, 'r-frigate', 3, 3400, 2300, 200)]
  cmdAttack(w, 0, ships.map((u) => u.id), e.id)
  run(w, 120)
  settled('3 cruisers and 3 frigates on a capital ship', ships, e)
}

{
  // Too many for 120 degrees: the rest form a second row nearer in, still in reach.
  const w = field()
  const e = dummy(w, 'd-station', 4300, 2300)
  const ships = [...line(w, 'r-cruiser', 4, 3500, 2300, 260), ...line(w, 'r-frigate', 6, 3350, 2300, 180)]
  cmdAttack(w, 0, ships.map((u) => u.id), e.id)
  run(w, 150)
  settled('4 cruisers and 6 frigates on a station (two rows)', ships, e, true, true)
  const rows = new Set(ships.map((u) => (u.slot?.inset ?? 0) > 0))
  check('4 cruisers and 6 frigates on a station: they formed a second row', rows.size === 2)
}

// --- 5. The target flies off ---------------------------------------------------------------------------

{
  const w = field()
  const e = dummy(w, 'd-cruiser', 3800, 2300, 45)
  const ships = line(w, 'r-gunship', 6, 3150, 2300, 70)
  cmdAttack(w, 0, ships.map((u) => u.id), e.id)
  run(w, 35)
  const before = { x: e.x, y: e.y }
  cmdMove(w, 1, [e.id], 5200, 3200)
  run(w, 60)
  const moved = Math.hypot(e.x - before.x, e.y - before.y)
  check('the target flew off', moved > 1200, `${moved.toFixed(0)} away`)
  run(w, 30)
  settled('6 gunships after following the target', ships, e)
}

// --- 6. Determinism -------------------------------------------------------------------------------------

{
  const a = gunshipsOnCruiser(11)
  const b = gunshipsOnCruiser(11)
  const c = gunshipsOnCruiser(11, 12)
  const same = a.hashes.every((h, i) => h === b.hashes[i])
  check('the same battle twice hashes the same every second', same)
  const thawed = a.hashes.every((h, i) => h === c.hashes[i])
  check('frozen to a snapshot and thawed midway, it keeps the same hashes', thawed, `final ${a.hashes.at(-1)!.toString(16)} / ${c.hashes.at(-1)!.toString(16)}`)
}

console.log(failed ? 'FAILED' : 'all passed')
process.exit(failed ? 1 : 0)
