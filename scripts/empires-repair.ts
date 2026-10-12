// Checks Empires At War's Field repair on shot-off modules: headless, deterministic battles on the
// two-player map with nothing but the two stations and their defense wings (and the ships a check
// adds), far enough apart that nobody shoots.
//
//   node scripts/empires-repair.ts
//
// 1. A station with its hangar and turbolaser shot off and two defense wing craft lost: a squadron
//    of two repair craft on one run rebuilds the hangar first (the stronger module), within the run,
//    and gets part of the way into the turbolaser. The wing's countdown holds while the hangar is
//    down, runs again once it stands, and a new craft launches.
// 2. A frigate with a turret shot off: the run heals its hull and its damaged shield generator, but
//    the shot-off turret stays lost.
// 3. Defense platforms aren't field repaired at all (only the main station is).
// 4. The station run twice, and once frozen to a snapshot mid-rebuild and thawed, ends the same.

import { MAPS } from '../src/apps/games/empires/maps.ts'
import { DEFENSE_WING, FIELD_REPAIR } from '../src/apps/games/empires/data.ts'
import { STEP, cantMend, cmdAbility, newWorld, radius, spawn, stateHash, tick, wingState, type Unit, type World } from '../src/apps/games/empires/sim.ts'
import { restoreWorld, snapshotWorld } from '../src/apps/games/empires/snapshot.ts'

let failed = false
const check = (what: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}${detail ? ` (${detail})` : ''}`)
  if (!ok) failed = true
}

/** The two-player map with only the stations and their defense wings left on it. */
function field(seed = 11): World {
  const map = MAPS.find((m) => m.spawns.length === 2) ?? MAPS[0]
  const w = newWorld(map, [{ faction: 'republic', team: 0, spawn: 0 }, { faction: 'droid', team: 1, spawn: 1 }], { seed })
  const keep = new Set(w.units.filter((u) => u.t.tier === 'station').map((u) => u.id))
  w.units = w.units.filter((u) => keep.has(u.id) || keep.has(u.parent))
  w.byId = new Map(w.units.map((u) => [u.id, u]))
  w.arrivals = []
  w.wrecks = []
  return w
}

const stationOf = (w: World) => w.units.find((u) => u.owner === 0 && u.t.tier === 'station')!
const hpIndex = (u: Unit, kind: string) => u.t.hardpoints.findIndex((h) => h.kind === kind)

function run(w: World, secs: number, each?: (w: World) => void) {
  const n = Math.round(secs / STEP)
  for (let i = 0; i < n; i++) {
    tick(w)
    w.events.length = 0
    each?.(w)
  }
}

/** Two of our repair craft beside `to`, sent on a Field repair run to it. */
function crew(w: World, to: Unit): Unit[] {
  const r = radius(to.t) + 100
  const craft = [0, 1].map((k) => spawn(w, 'r-repair', 0, to.x + r, to.y + (k - 0.5) * 40, Math.PI, 900))
  check(`both repair craft start a run on the ${to.t.name}`, cmdAbility(w, 0, craft.map((u) => u.id), to.id) === 2)
  return craft
}

// --- 1. A station gets its hangar back ----------------------------------------------------------

/** The station scene: hangar and turbolaser shot off, two wing craft lost, a crew sent. */
function stationScene(seed = 11) {
  const w = field(seed)
  const st = stationOf(w)
  const hangar = hpIndex(st, 'hangar')
  const gun = hpIndex(st, 'turret')
  st.hps[hangar].hp = 0
  st.hps[gun].hp = 0
  const wing = w.units.filter((u) => u.parent === st.id && u.t.kind === 'wing')
  wing.slice(0, 2).forEach((u) => (u.dead = true))
  st.hangarT = DEFENSE_WING.wait
  crew(w, st)
  return { w, st, hangar, gun, full: wing.length }
}

{
  const { w, st, hangar, gun, full } = stationScene()
  const startLeft = wingState(w, st).left
  let rebuiltAt = -1
  let heldWhileDown = true
  let launchedAt = -1
  const watch = (w: World) => {
    const ws = wingState(w, st)
    if (st.hps[hangar].hp <= 0 && (ws.next !== Infinity || st.hangarT !== DEFENSE_WING.wait)) heldWhileDown = false
    if (rebuiltAt < 0 && st.hps[hangar].hp > 0) rebuiltAt = w.time
    if (launchedAt < 0 && ws.left > startLeft) launchedAt = w.time
  }
  // The run, then a while after it.
  run(w, 15, watch)
  check('the turbolaser is still down when the run ends, part of the way rebuilt', st.hps[gun].hp <= 0 && (st.hps[gun].fix ?? 0) > 0, `fix ${(st.hps[gun].fix ?? 0).toFixed(1)} of ${FIELD_REPAIR.rebuild}`)
  run(w, 15, watch)
  const share = st.hps[hangar].hp / st.hps[hangar].max
  check('the hangar (the strongest module) is rebuilt first, within the 15 s run', rebuiltAt > 0 && rebuiltAt < 15, `at ${rebuiltAt.toFixed(1)} s`)
  check('it takes a good part of the run for two craft (more than 8 s)', rebuiltAt > 8, `${rebuiltAt.toFixed(1)} s`)
  check('the rebuilt hangar came back weak and was healed on from there', share > FIELD_REPAIR.back && share < 0.5, `${(share * 100).toFixed(0)}% now`)
  check('its rebuild progress is cleared', !st.hps[hangar].fix)
  check("the wing's countdown held while the hangar was down", heldWhileDown)
  check(`a new wing craft launched once the hangar stood again (${startLeft} of ${full} before)`, launchedAt > rebuiltAt && launchedAt < rebuiltAt + DEFENSE_WING.wait + 1, `at ${launchedAt.toFixed(1)} s`)
}

// --- 2. A frigate's shot-off turret stays lost ----------------------------------------------------

{
  const w = field()
  const st = stationOf(w)
  const f = spawn(w, 'r-frigate', 0, st.x, st.y + radius(st.t) + 500, 0)
  f.stance = 'hold'
  const gun = hpIndex(f, 'turret')
  const gen = hpIndex(f, 'shield')
  f.hps[gun].hp = 0
  f.hps[gen].hp = f.hps[gen].max * 0.5
  f.hull = f.hullMax * 0.5
  crew(w, f)
  run(w, 15)
  check('the frigate hull is mended', f.hull > f.hullMax * 0.55, `${((f.hull / f.hullMax) * 100).toFixed(0)}%`)
  check('its damaged shield generator is mended', f.hps[gen].hp > f.hps[gen].max * 0.55, `${((f.hps[gen].hp / f.hps[gen].max) * 100).toFixed(0)}%`)
  check('its shot-off turret stays lost, with no rebuild under way', f.hps[gun].hp <= 0 && !f.hps[gun].fix)
}

// --- 3. Defense platforms are left to their own crews -----------------------------------------------

{
  const w = field()
  const st = stationOf(w)
  const d = spawn(w, 'r-defense', 0, st.x, st.y - radius(st.t) - 500, 0)
  d.building = 0
  d.hps[0].hp = 0
  check('a defense platform with a shot-off module is refused', cantMend(w, 0, d) !== null, String(cantMend(w, 0, d)))
}

// --- 4. Deterministic through snapshot and restore ------------------------------------------------

{
  const fingerprint = (w: World) => {
    const st = stationOf(w)
    return JSON.stringify({ hash: stateHash(w), hps: st.hps, hangarT: st.hangarT, wing: wingState(w, st).left })
  }
  const a = stationScene(5)
  const b = stationScene(5)
  run(a.w, 30)
  run(b.w, 6)
  const mid = b.st.hps[b.hangar].fix ?? 0
  check('the snapshot is taken mid-rebuild', mid > 0 && b.st.hps[b.hangar].hp <= 0, `fix ${mid.toFixed(1)} of ${FIELD_REPAIR.rebuild}`)
  const c = restoreWorld(snapshotWorld(b.w))
  if (!c) throw new Error('snapshot did not restore')
  check('the snapshot carries the rebuild progress', stationOf(c).hps[b.hangar].fix === mid)
  run(b.w, 24)
  run(c, 24)
  check('two runs of the same scene end the same', fingerprint(a.w) === fingerprint(b.w))
  check('a run thawed from a snapshot mid-rebuild ends the same', fingerprint(a.w) === fingerprint(c))
}

if (failed) process.exit(1)
console.log('repair ok')
