// Checks Galactic conquest's defense stations and the layout round a planet, headless: ordering a
// defense station in a planet's queue (prices, times, station levels, the two sites, refunds), its
// three levels and their module slots (1, 2 and 4), fitting and swapping modules and what each does
// to the station's type, ruins after a lost battle (and with a lost station) and their cheaper
// rebuild, auto-resolved battles counting them, fleet battles spawning them with their modules where
// the planet's layout has them (and the yards too), what a battle leaves of them written back, moving
// structures round a planet, the galaxy AI building and arming them, and old saves without them.
//
//   node scripts/empires-gc-defense.ts
//
// Every check prints a line; it exits with 1 if any of them failed.

import { generateMap, DEFAULT_RULES } from '../src/apps/games/empires/maps.ts'
import { BUILD_RADIUS, ORBITALS, ORBITAL_MAX, REBUILD, UNIT, orbitalKey, orbitalMod, orbitalSlots, orbitalType, type FactionId, type OrbitalModId } from '../src/apps/games/empires/data.ts'
import { modelFor } from '../src/apps/games/empires/models/index.ts'
import { baseLeft, layoutPoint, newFleetBattle, type FleetSide } from '../src/apps/games/empires/sim.ts'
import * as G from '../src/apps/games/empires/galaxy.ts'
import type { Galaxy, OrbitalWork, PlanetBase } from '../src/apps/games/empires/galaxy.ts'

// Saves go to localStorage, which Node only has with a file behind it: a plain map does here.
const store = new Map<string, string>()
;(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size
  },
} as Storage
// The same campaigns every time, even where the game itself rolls dice.
let seed = 777
Math.random = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed / 2147483648
}

let failed = 0
const check = (what: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `: ${detail}` : ''}`)
  if (!ok) failed++
}
const campaign = (faction: FactionId = 'republic', credits = 30000) => {
  const g = G.newGalaxy({ choice: { kind: 'rim' }, size: 'standard', faction, difficulty: 'medium', credits })
  g.aiT[1] = 1e9
  const cap = g.planets.find((p) => p.owner === 0 && p.station === 3)!
  const outpost = g.planets.find((p) => p.owner === 0 && p.station === 1)!
  return { g, cap, outpost }
}
/** Run the galaxy until `done` (or `max` seconds), battles auto-resolved. */
const run = (g: Galaxy, max: number, done: () => boolean = () => false) => {
  for (let t = 0; t < max && !done(); t += 0.5) {
    if (g.pending >= 0) G.settlePending(g, 'auto')
    G.tickGalaxy(g, 0.5)
  }
}
const credits = (g: Galaxy) => g.sides[0].credits
const build = (i: number): OrbitalWork => ({ k: 'build', i })
const up = (i: number): OrbitalWork => ({ k: 'up', i })
const mod = (i: number, slot: number, m: OrbitalModId): OrbitalWork => ({ k: 'mod', i, slot, mod: m })

// --- Ordering a defense station in the planet's queue ------------------------------------------------
{
  const { g, cap, outpost } = campaign()
  const st = ORBITALS.republic.stages
  check('a new campaign has no defense stations', g.planets.every((p) => !G.orbitalsUp(p.base).length))
  const c0 = credits(g)
  check('a defense station queues at its first level\'s price', G.orderOrbital(g, 0, cap.id, build(0)) === null && credits(g) === c0 - st[0].cost, `${c0} -> ${credits(g)}`)
  check('its build time is its own on the galaxy clock', cap.queue[0].unit === 'orb0' && cap.queue[0].total === st[0].time && cap.queue[0].lv === 1)
  check('it counts as work on the buildings, not a ship', G.isWork('orb0') && G.isWork('orbup1') && G.isWork('orbm0.3.flak') && !G.isWork('orbm0.4.flak') && !G.isWork('orbm0.0.laser'))
  check('it can only be queued once', G.cantOrbital(g, 0, cap.id, build(0)) === 'Already being built')
  check('its modules wait for it', G.cantOrbital(g, 0, cap.id, mod(0, 0, 'battery')) === 'Being built: wait for it')
  G.cancelBuild(g, 0, cap.id, 0)
  check('cancelling refunds it in full', credits(g) === c0 && !cap.queue.length)
  check('only two sites a planet', ORBITAL_MAX === 2 && G.orbitalLock(g, 0, cap.id, build(2)) === 'No such defense site' && G.orbitalLock(g, 0, cap.id, build(-1)) === 'No such defense site')
  check('not on a planet without a station', G.orbitalLock(g, 0, g.planets.find((p) => p.owner === 0 && !p.station)?.id ?? outpost.id, build(0)) === (g.planets.some((p) => p.owner === 0 && !p.station) ? 'Needs a station' : null))
  check('not on an enemy planet', G.orbitalLock(g, 0, g.planets.find((p) => p.owner === 1)!.id, build(0)) === 'Not our planet')
  G.orderOrbital(g, 0, cap.id, build(0))
  G.orderOrbital(g, 0, cap.id, build(1))
  const events: string[] = []
  for (let t = 0; t < 200 && cap.queue.length; t += 0.5) {
    G.tickGalaxy(g, 0.5)
    for (const e of g.events) if (e.k === 'orbital') events.push(`${e.i}:${e.text}`)
    g.events.length = 0
  }
  const o0 = G.orbitalAt(cap, 0)
  check('both are built, one after the other', events.join('|') === '0:Bastion Watchpost built|1:Bastion Watchpost built' && G.orbitalsUp(cap.base).length === 2, events.join('|'))
  check('level 1 has one empty slot', !!o0 && o0.level === 1 && o0.mods.length === 1 && o0.mods[0] === null)
  check('a third can\'t be built', G.orbitalsUp(cap.base).length === ORBITAL_MAX && [0, 1].every((i) => G.orbitalLock(g, 0, cap.id, build(i)) === 'Already built'))
  // The levels: 1, 2 and 4 slots, each upgrade at its price and its station level.
  check('slots per level are 1, 2 and 4', orbitalSlots(1) === 1 && orbitalSlots(2) === 2 && orbitalSlots(3) === 4)
  check('a level 2 slot waits for the upgrade', G.orbitalLock(g, 0, cap.id, mod(0, 1, 'flak')) === 'Needs level 2')
  const c1 = credits(g)
  check('an upgrade queues at the next level\'s price', G.orderOrbital(g, 0, cap.id, up(0)) === null && credits(g) === c1 - st[1].cost && cap.queue[0].total === st[1].time)
  check('a slot it will have waits for it', G.orbitalLock(g, 0, cap.id, mod(0, 1, 'flak')) === 'Needs the upgrade: wait for it' && G.orbitalLock(g, 0, cap.id, mod(0, 2, 'flak')) === 'Needs level 3')
  run(g, 120, () => !cap.queue.length)
  check('level 2 has two slots', G.orbitalAt(cap, 0)!.level === 2 && G.orbitalAt(cap, 0)!.mods.length === 2)
  G.orderOrbital(g, 0, cap.id, up(0))
  run(g, 120, () => !cap.queue.length)
  check('level 3 has four', G.orbitalAt(cap, 0)!.level === 3 && G.orbitalAt(cap, 0)!.mods.length === 4)
  check('and no level past it', G.orbitalLock(g, 0, cap.id, up(0)) === 'At its highest level')
  // Station levels: an outpost (level 1) builds the first level, needs level 2 and 3 for the rest.
  check('an outpost can build one', G.cantOrbital(g, 0, outpost.id, build(0)) === null)
  outpost.base.orb = [{ level: 1, mods: [null] }, null]
  check('the upgrade needs station level 2', G.orbitalLock(g, 0, outpost.id, up(0)) === 'Needs station level 2')
  outpost.station = 2
  outpost.base.orb = [{ level: 2, mods: [null, null] }, null]
  check('and level 3 needs station level 3', G.orbitalLock(g, 0, outpost.id, up(0)) === 'Needs station level 3')
  // A defense station's work takes the planet's queue on its own (a Second slip doesn't share it).
  cap.base.mods.push('secondSlip')
  G.orderOrbital(g, 0, cap.id, mod(1, 0, 'flak'))
  G.buildAt(g, 0, cap.id, 'r-fighter')
  check('it goes on its own in the queue', G.activeSlots(cap) === 1)
  check('its queue entry is named for it', G.queueName(g, 0, cap, cap.queue[0]) === 'Flak battery (defense site 2, slot 1)', G.queueName(g, 0, cap, cap.queue[0]))
}

// --- Modules: fitting, swapping, what each does ------------------------------------------------------------
{
  const { g, cap } = campaign()
  cap.base.orb = [{ level: 3, mods: [null, null, null, null] }, null]
  const c0 = credits(g)
  check('a module queues at its price and time', G.orderOrbital(g, 0, cap.id, mod(0, 0, 'battery')) === null && credits(g) === c0 - orbitalMod('republic', 'battery').cost && cap.queue[0].total === orbitalMod('republic', 'battery').time)
  check('one module at a time into a slot', G.orbitalLock(g, 0, cap.id, mod(0, 0, 'flak')) === 'A module is already being fitted there')
  check('but other slots take theirs', G.orderOrbital(g, 0, cap.id, mod(0, 1, 'flak')) === null && G.orderOrbital(g, 0, cap.id, mod(0, 2, 'shield')) === null && G.orderOrbital(g, 0, cap.id, mod(0, 3, 'hangar')) === null)
  run(g, 200, () => !cap.queue.length)
  check('they are fitted into their slots', JSON.stringify(G.orbitalAt(cap, 0)!.mods) === JSON.stringify(['battery', 'flak', 'shield', 'hangar']), JSON.stringify(G.orbitalAt(cap, 0)!.mods))
  check('the same module again is refused', G.orbitalLock(g, 0, cap.id, mod(0, 0, 'battery')) === 'Already fitted')
  G.orderOrbital(g, 0, cap.id, mod(0, 0, 'launcher'))
  run(g, 100, () => !cap.queue.length)
  check('another one replaces it', G.orbitalAt(cap, 0)!.mods[0] === 'launcher')
  const bare = orbitalType('republic', 3, [null, null, null, null])
  const full = orbitalType('republic', 3, ['battery', 'flak', 'shield', 'hangar'])
  check('each module is a part of its own on the station', bare.hardpoints.length === 0 && full.hardpoints.length === 4 && full.hardpoints.every((h, s) => h.key === orbitalKey(s, (['battery', 'flak', 'shield', 'hangar'] as const)[s])))
  check('guns arm it', !!full.hardpoints[0].weapon && full.hardpoints[0].weapon.kind === 'turbo' && full.hardpoints[1].weapon?.kind === 'flak')
  check('a shield generator gives it shields', bare.shield === 0 && full.shield > 1000)
  check('a hangar keeps a squadron in the air', !bare.carrier && full.carrier?.unit === 'r-fighter' && full.carrier.max === 1)
  const pool = orbitalType('swarm', 2, ['shield', 'battery'])
  const plain = orbitalType('swarm', 2, ['battery', null])
  check('the Swarm grows no shields: its pool gives hull and faster regrowth', pool.shield === 0 && pool.hull > plain.hull && (pool.regrow?.rate ?? 0) > (plain.regrow?.rate ?? 0))
  check('each level is bigger and tougher', [1, 2, 3].every((lv) => lv === 1 || orbitalType('droid', lv, []).hull > orbitalType('droid', lv - 1, []).hull))
  check('every faction has a model at every level, with or without modules', (['republic', 'droid', 'swarm'] as FactionId[]).every((f) => [1, 2, 3].every((lv) => {
    const a = modelFor(orbitalType(f, lv, []))
    const b = modelFor(orbitalType(f, lv, ['battery', 'flak', 'launcher', 'hangar']))
    return !!a && !!b && a.key !== b.key && b.mounts.length === orbitalSlots(lv) && a.parts.some((p) => /port|bud/i.test(p.id))
  })))
}

// --- Ruins, rebuilding, a lost station ---------------------------------------------------------------------
{
  const { g, cap } = campaign()
  cap.station = 4
  cap.base.orb = [{ level: 3, mods: ['battery', 'flak', null, null] }, { level: 2, mods: ['flak', 'battery'] }]
  G.orderOrbital(g, 0, cap.id, mod(0, 2, 'shield'))
  const enemy = g.fleets.find((f) => f.owner === 1)!
  Object.assign(enemy, { planet: cap.id, system: cap.system, leg: null, route: [] })
  const c = G.clashAt(g, cap.id)!
  check('the clash carries the defense stations', JSON.stringify(c.base?.orb) === JSON.stringify(cap.base.orb) && !!c.spots && c.spots.def0.d > 0)
  const c0 = credits(g)
  // The battle: site 1 destroyed, site 2's battery shot off.
  G.applyBattle(g, c, { winner: 0, survivors: { 0: c.holderShips, 1: [] }, escaped: { 0: [], 1: [] }, stationLeft: true, base: { yards: ['yard'], mods: [], orb: [null, ['flak', null]] } }, false)
  check('a destroyed defense station is a ruin at its level', JSON.stringify(G.orbitalAt(cap, 0)) === JSON.stringify({ level: 3, mods: [], ruin: true }))
  check('one that came through loses what was shot off', JSON.stringify(G.orbitalAt(cap, 1)) === JSON.stringify({ level: 2, mods: ['flak', null] }))
  check('a module queued for the ruin is refunded', !cap.queue.some((q) => q.unit.startsWith('orbm0')) && credits(g) === c0 + orbitalMod('republic', 'shield').cost)
  const st = ORBITALS.republic.stages
  const all = st.reduce((s, x) => s + x.cost, 0)
  check('a ruin is rebuilt at its level for REBUILD of what the levels cost', G.rebuildLevel(g, 0, cap, 0) === 3 && G.orbitalCost(g, 0, cap, build(0)) === Math.round(all * REBUILD), `${G.orbitalCost(g, 0, cap, build(0))}`)
  cap.station = 2
  check('as far as the station allows', G.rebuildLevel(g, 0, cap, 0) === 2 && G.orbitalCost(g, 0, cap, build(0)) === Math.round((st[0].cost + st[1].cost) * REBUILD))
  cap.station = 4
  const c1 = credits(g)
  G.orderOrbital(g, 0, cap.id, build(0))
  G.orderOrbital(g, 0, cap.id, mod(1, 1, 'battery'))
  check('the rebuild is paid for', credits(g) === c1 - Math.round(all * REBUILD) - orbitalMod('republic', 'battery').cost)
  run(g, 200, () => !cap.queue.length)
  check('and comes back at its level, its slots empty', JSON.stringify(G.orbitalAt(cap, 0)) === JSON.stringify({ level: 3, mods: [null, null, null, null] }))
  // A station lost: everything round it is a ruin, the layout stays the holder's until it's taken.
  cap.layout = { def0: { a: 0.5, d: 2.2 } }
  g.fleets.push({ id: g.nextId++, owner: 1, ships: ['d-cruiser', 'd-frigate'], items: [], planet: cap.id, system: cap.system, from: -1, leg: null, route: [], arrived: g.time })
  G.layoutFleets(g)
  const c2 = G.clashAt(g, cap.id)!
  G.applyBattle(g, c2, { winner: 1, survivors: { 0: [], 1: c2.attackerShips }, escaped: { 0: [], 1: [] }, stationLeft: false, base: { yards: [], mods: [] } }, false)
  check('with the station lost, the defense stations are ruins too', cap.station === 0 && G.orbitalsUp(cap.base).length === 0 && cap.base.orb!.every((o) => o?.ruin))
  run(g, 60, () => cap.owner === 1)
  check('a captured planet keeps the ruins, and its new owner its own layout', cap.owner === 1 && cap.base.orb!.every((o) => o?.ruin) && !cap.layout)
}

// --- Auto-resolve counts them ----------------------------------------------------------------------------
{
  const { g, cap } = campaign()
  cap.station = 2
  cap.base = { yards: {}, mods: [] }
  const clash = (orb?: PlanetBase['orb']): G.Clash => ({
    planet: cap.id, holder: 0, attacker: 1, station: 2, holderShips: ['r-frigate'], holderHeld: [], attackerShips: ['d-cruiser', 'd-cruiser', 'd-frigate', 'd-frigate', 'd-fighter', 'd-fighter'], attackerHeld: [],
    base: { yards: {}, mods: [], ...(orb ? { orb } : {}) }, spots: G.layoutOf(cap),
  })
  const strong: PlanetBase['orb'] = [{ level: 3, mods: ['battery', 'battery', 'flak', 'shield'] }, { level: 3, mods: ['battery', 'launcher', 'flak', 'hangar'] }]
  let without = 0
  let withThem = 0
  let lostOne = 0
  for (let i = 0; i < 12; i++) {
    if (G.autoResolve(g, clash(), 100 + i * 7.3).winner === 0) without++
    const r = G.autoResolve(g, clash(strong), 100 + i * 7.3)
    if (r.winner === 0) withThem++
    if (r.base?.orb?.some((x) => x === null)) lostOne++
  }
  check('two armed defense stations turn a lost planet into a held one', without <= 2 && withThem >= 8, `held ${without}/12 without, ${withThem}/12 with`)
  check('the result says which came through', (() => {
    const r = G.autoResolve(g, clash(strong), 3)
    return Array.isArray(r.base?.orb) && r.base!.orb!.length === 2 && r.base!.orb!.every((x) => x === null || Array.isArray(x))
  })(), `${lostOne}/12 battles lost one`)
  check('a ruin doesn\'t fight', G.autoResolve(g, clash([{ level: 3, mods: [], ruin: true }, null]), 5).base?.orb?.[0] === undefined)
}

// --- Fleet battles: spawned with their modules where the layout has them --------------------------------
{
  const map = generateMap({ ...DEFAULT_RULES, seed: 11, players: 2, size: 'small', beacons: 0, wrecks: 'none' })
  const planet = { kind: 'city', x: map.w / 2 + (map.spawns[0].x - map.w / 2) * 0.5, y: map.h / 2 + 1875, r: 560 }
  const spotsOf = (layout: G.Planet['layout']) => G.layoutOf({ layout })
  const battle = (layout: G.Planet['layout'], orbitals: NonNullable<FleetSide['orbitals']>) => {
    const sides: FleetSide[] = [
      { faction: 'republic', team: 0, ships: ['r-frigate'], station: 3, yards: ['yard', 'cyard'], exp: [], orbitals, spots: spotsOf(layout) },
      { faction: 'droid', team: 1, ships: ['d-frigate', 'd-frigate'] },
    ]
    return newFleetBattle({ ...map, planet }, sides, { seed: 5 })
  }
  const orbitals = [{ i: 0, level: 3, mods: ['battery', 'flak', 'shield', 'hangar'] as (OrbitalModId | null)[] }, { i: 1, level: 1, mods: ['flak'] as (OrbitalModId | null)[] }]
  const w = battle(undefined, orbitals)
  const st = w.byId.get(w.players[0].station)!
  const orbs = w.units.filter((u) => u.t.orbital)
  check('both defense stations stand in the battle, ours', orbs.length === 2 && orbs.every((u) => u.owner === 0 && u.t.tier === 'defense'))
  const big = orbs.find((u) => u.t.orbital!.i === 0)!
  check('with their levels and modules as parts', big.t.orbital!.level === 3 && big.t.hardpoints.length === 4 && big.hps.length === 4 && big.t.carrier?.unit === 'r-fighter' && big.shield > 0)
  const near = (u: { x: number; y: number }, p: { x: number; y: number } | null) => !!p && Math.hypot(u.x - p.x, u.y - p.y) < 1000
  check('where the planet\'s layout has them round the station', orbs.every((u) => near(u, layoutPoint(w, st, spotsOf(undefined), u.t.orbital!.i ? 'def1' : 'def0'))) && orbs.every((u) => Math.hypot(u.x - st.x, u.y - st.y) <= BUILD_RADIUS))
  const yard = w.units.find((u) => u.t.id === 'r-yard')!
  check('and the yards too', near(yard, layoutPoint(w, st, spotsOf(undefined), 'yard')))
  // Moved round the planet: they stand somewhere else.
  const moved = battle({ def0: { a: 1.6, d: 2.6 }, yard: { a: -1.6, d: 2.6 } }, orbitals)
  const st2 = moved.byId.get(moved.players[0].station)!
  const big2 = moved.units.find((u) => u.t.orbital?.i === 0)!
  const yard2 = moved.units.find((u) => u.t.id === 'r-yard')!
  const want = layoutPoint(moved, st2, spotsOf({ def0: { a: 1.6, d: 2.6 } }), 'def0')!
  check('moved in the layout, they stand where it puts them', Math.hypot(big2.x - big.x, big2.y - big.y) > 400 && Math.hypot(big2.x - want.x, big2.y - want.y) < 1000 && Math.hypot(yard2.x - yard.x, yard2.y - yard.y) > 400, `moved ${Math.round(Math.hypot(big2.x - big.x, big2.y - big.y))}`)
  const pos = (x: typeof w) => x.units.filter((u) => u.t.orbital || u.t.tier === 'yard').map((u) => `${u.t.id}@${u.x.toFixed(2)},${u.y.toFixed(2)}`).join(' ')
  check('at the same spots every time', pos(battle(undefined, orbitals)) === pos(w))
  // What the battle leaves of them, written back.
  big.hps[1].hp = 0
  orbs.find((u) => u.t.orbital!.i === 1)!.dead = true
  const left = baseLeft(w, 0, [], [0, 1])
  check('the battle says what came through, by site', JSON.stringify(left.orb) === JSON.stringify([['battery', null, 'shield', 'hangar'], null]), JSON.stringify(left.orb))
  check('a site that didn\'t fight is left out', baseLeft(w, 0, [], [1]).orb?.[0] === undefined)
}

// --- The layout round a planet --------------------------------------------------------------------------------
{
  const { g, cap } = campaign()
  check('every structure has its own spot, clear of the others', G.STRUCTS.every((id) => G.spotProblem('republic', cap, id, G.spotOf(cap, id)) === null))
  check('a structure moves where there is room', G.moveStruct(g, 0, cap.id, 'def0', -1.6, 2.0) === null && G.spotOf(cap, 'def0').a === -1.6 && G.spotOf(cap, 'def0').d === 2)
  check('kept out of the planet and within reach', G.moveStruct(g, 0, cap.id, 'def1', 2.2, 9) === null && G.spotOf(cap, 'def1').d === G.SPOT_D.max && G.moveStruct(g, 0, cap.id, 'def1', 2.2, 0.2) === null && G.spotOf(cap, 'def1').d === G.SPOT_D.min)
  const yard = G.spotOf(cap, 'yard')
  G.moveStruct(g, 0, cap.id, 'cyard', yard.a, yard.d)
  const cy = G.spotOf(cap, 'cyard')
  check('dropped onto another, it is nudged round to the nearest clear spot', G.spotProblem('republic', cap, 'cyard', cy) === null && cy.a !== yard.a && Math.abs(Math.atan2(Math.sin(cy.a - yard.a), Math.cos(cy.a - yard.a))) < Math.PI / 2)
  check('not on someone else\'s planet', G.moveStruct(g, 0, g.planets.find((p) => p.owner === 1)!.id, 'station', 0, 2) === 'Not our planet')
  check('reset puts them all back', G.resetLayout(g, 0, cap.id) === null && !cap.layout && G.STRUCTS.every((id) => JSON.stringify(G.spotOf(cap, id)) === JSON.stringify(G.AUTO_SPOT[id])))
}

// --- The galaxy AI builds and arms them -----------------------------------------------------------------------
{
  const results: string[] = []
  let built = 0
  let armed = 0
  for (const [faction, s] of [['republic', 3], ['droid', 9], ['swarm', 21]] as [FactionId, number][]) {
    seed = s
    const g = G.newGalaxy({ choice: { kind: 'rim' }, size: 'standard', faction, difficulty: 'hard', credits: 6000 })
    g.sides[0].ai = 'hard'
    for (let week = 0; week < 10; week++) run(g, G.DAY * G.WEEK)
    for (const o of [0, 1]) {
      const st = g.planets.filter((p) => p.owner === o).flatMap((p) => G.orbitalsUp(p.base).map((x) => x.o))
      built += st.length
      armed += st.filter((x) => x.mods.some(Boolean)).length
      results.push(`${g.sides[o].faction}: ${st.length} (${st.map((x) => `L${x.level}:${x.mods.map((m) => m ?? '-').join('/')}`).join(' ')})`)
    }
  }
  console.log(`     after ten weeks of AI against AI: ${results.join('; ')}`)
  check('the galaxy AI builds defense stations', built >= 3, `${built}`)
  check('and fits modules into them', armed >= 2, `${armed}`)
}

// --- Saves --------------------------------------------------------------------------------------------------
{
  const { g, cap } = campaign()
  cap.base.orb = [{ level: 2, mods: ['battery', null] }, null]
  cap.layout = { def0: { a: 1, d: 2.4 } }
  G.orderOrbital(g, 0, cap.id, mod(0, 1, 'flak'))
  check('a save is version 4', G.saveGalaxy(g) && g.v === 4)
  const back = G.loadSave(g.save.id)!
  check('defense stations, their work and the layout survive a save', JSON.stringify(G.orbitalAt(back.planets[cap.id], 0)) === JSON.stringify({ level: 2, mods: ['battery', null] }) && back.planets[cap.id].queue.some((q) => q.unit === 'orbm0.1.flak') && back.planets[cap.id].layout?.def0?.a === 1)
  // A version 3 save, from before: no defense stations, no layout.
  const key = `mvlos.empires.save.${g.save.id}`
  const old = JSON.parse(store.get(key)!) as Galaxy & { v: number }
  old.v = 3
  for (const p of old.planets) {
    delete p.base.orb
    delete p.layout
    p.queue = p.queue.filter((q) => !q.unit.startsWith('orb'))
  }
  for (const s of old.sides) for (const i of s.intel ?? []) if (i.base) delete i.base.orb
  store.set(key, JSON.stringify(old))
  const o = G.loadSave(g.save.id)!
  check('an old save loads, with no defense stations and every structure on its own spot', !!o && o.v === 4 && o.planets.every((p) => !p.base.orb && !p.layout && G.orbitalAt(p, 0) === null) && G.spotOf(o.planets[cap.id], 'def0') === G.AUTO_SPOT.def0)
  check('and plays on', (() => {
    run(o, 30)
    return G.cantOrbital(o, 0, cap.id, build(0)) === null
  })())
  // A save with nonsense in it is made sound.
  const bad = JSON.parse(store.get(key)!) as Galaxy & { v: number }
  bad.v = 4
  ;(bad.planets[cap.id].base as unknown as { orb: unknown }).orb = [{ level: 9, mods: ['battery', 'laser', null, 'flak', 'flak'] }, 'x', { level: 1, mods: [] }]
  ;(bad.planets[cap.id] as unknown as { layout: unknown }).layout = { def0: { a: 'x', d: 2 }, station: { a: 0.2, d: 99 }, nope: { a: 0, d: 2 } }
  store.set(key, JSON.stringify(bad))
  const b = G.loadSave(g.save.id)!
  check('a broken save is made sound', JSON.stringify(b.planets[cap.id].base.orb) === JSON.stringify([{ level: 3, mods: ['battery', null, null, 'flak'] }, null]) && JSON.stringify(b.planets[cap.id].layout) === JSON.stringify({ station: { a: 0.2, d: G.SPOT_D.max } }), JSON.stringify([b.planets[cap.id].base.orb, b.planets[cap.id].layout]))
}

// (Every unit the battles above can bring stands in UNIT; the defense stations are types of their own.)
check('defense stations are not in the skirmish\'s unit list', !Object.keys(UNIT).some((id) => id.endsWith('-orbital')))

if (failed) {
  console.log(`${failed} check(s) failed`)
  process.exit(1)
}
console.log('all defense station checks passed')
