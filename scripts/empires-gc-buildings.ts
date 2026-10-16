// Checks the buildings of Galactic conquest (hybrid bases on the galaxy map), headless: yards and
// expansions built through a planet's queue (prices, times, ruins, refunds), which ships each planet
// can build, the Second slip, a battle at a planet starting with the planet's real buildings at the
// same spots every time, what a battle leaves of them written back to the planet (a destroyed yard
// a ruin, its expansions gone), auto-resolved battles fought with them, what a captured planet
// keeps, campaigns saved before there were buildings, and the galaxy AI planning its planets by its
// profile over long campaigns without ever running out of ways to build ships. Also the rush launch
// on the galaxy map: the button's gating, rushed ships in the fleet inventory, finishing over galaxy
// time at a Capital Yard or Drydock planet only, a battle spawning a rushed ship and writing its
// progress back, auto-resolve counting its built share, the AI rushing under threat, and old saves.
//
//   node scripts/empires-gc-buildings.ts [weeks]
//
// Every check prints a line; it exits with 1 if any of them failed.

import { generateMap, DEFAULT_RULES } from '../src/apps/games/empires/maps.ts'
import { BUILD_RADIUS, MODULE, REBUILD, UNIT, yardOf, type ModuleId } from '../src/apps/games/empires/data.ts'
import { PROFILES, fleetThink, newBrain } from '../src/apps/games/empires/ai.ts'
import { resultOf } from '../src/apps/games/empires/result.ts'
import { STEP, baseLeft, cantBuild, cmdDeploy, cmdExpand, newFleetBattle, placement, tick, type FleetSide, type World } from '../src/apps/games/empires/sim.ts'
import * as G from '../src/apps/games/empires/galaxy.ts'
import type { Galaxy, Planet } from '../src/apps/games/empires/galaxy.ts'

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
let seed = 4242
Math.random = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed / 2147483648
}

let failed = 0
const check = (what: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `: ${detail}` : ''}`)
  if (!ok) failed++
}
const campaign = (credits = 20000) => {
  const g = G.newGalaxy({ choice: { kind: 'rim' }, size: 'standard', faction: 'republic', difficulty: 'medium', credits })
  // (The AI sits these out unless a check wants it.)
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

// --- Building yards and expansions through the planet's queue ---------------------------------------
{
  const { g, cap, outpost } = campaign()
  check('a new campaign: the capital has a level 3 station and a Frigate Yard, nothing else', cap.base.yards.yard === 'up' && !cap.base.yards.cyard && !cap.base.mods.length)
  check('an outpost has nothing round its station', !outpost.base.yards.yard && !outpost.base.mods.length)
  check('a Frigate Yard needs station level 2', G.cantWork(g, 0, outpost.id, 'yard') === 'Needs station level 2')
  check('a yard expansion needs its yard', G.cantWork(g, 0, outpost.id, 'secondSlip') === 'Needs a Frigate Yard here')
  check('the Capital slip needs station level 4', G.cantWork(g, 0, cap.id, 'cyard') === null && (G.workLock(g, 0, cap.id, 'capitalSlip') ?? '').startsWith('Needs a Capital Yard'))
  const before = credits(g)
  const cyard = yardOf('republic', 'cyard')
  check('the Capital Yard queues at its skirmish price', G.buildWork(g, 0, cap.id, 'cyard') === null && credits(g) === before - cyard.cost, `${before} -> ${credits(g)}`)
  check('its build time is its skirmish time on the galaxy clock', cap.queue[0].unit === 'cyard' && cap.queue[0].total === cyard.build * G.WORKS_TIME, `${cap.queue[0].total} s`)
  check('it can only be queued once', G.cantWork(g, 0, cap.id, 'cyard') === 'Already being built')
  check('its expansions wait for it', (G.cantWork(g, 0, cap.id, 'fighterWing') ?? '').includes('wait for it'))
  check('cruisers wait for it too', (G.cantBuildAt(g, 0, cap.id, 'r-cruiser') ?? '').includes('wait for it'))
  const c0 = credits(g)
  G.cancelBuild(g, 0, cap.id, 0)
  check('cancelling refunds it in full', credits(g) === c0 + cyard.cost && !cap.queue.length)
  check('an expansion queues on a standing yard', G.buildWork(g, 0, cap.id, 'drydock') === null && G.buildWork(g, 0, cap.id, 'shieldCore') === null)
  G.buildWork(g, 0, cap.id, 'cyard')
  const events: string[] = []
  for (let t = 0; t < 400 && cap.queue.length; t += 0.5) {
    G.tickGalaxy(g, 0.5)
    for (const e of g.events) if (e.k === 'works') events.push(e.what)
    g.events.length = 0
  }
  check('they are built one after another', events.join() === 'drydock,shieldCore,cyard' && cap.base.mods.includes('drydock') && cap.base.mods.includes('shieldCore') && cap.base.yards.cyard === 'up', events.join())
  check('then the Capital Yard takes its own expansions', G.cantWork(g, 0, cap.id, 'fighterWing') === null)
  // A ruin is rebuilt at half price.
  cap.base.yards.yard = 'ruin'
  const yard = yardOf('republic', 'yard')
  const c1 = credits(g)
  check('a ruined yard is rebuilt for half', G.workCost(g, 0, cap, 'yard') === Math.round(yard.cost * REBUILD) && G.buildWork(g, 0, cap.id, 'yard') === null && credits(g) === c1 - Math.round(yard.cost * REBUILD))
  G.cancelBuild(g, 0, cap.id, 0)
  check('and a cancelled rebuild gives back what it cost', credits(g) === c1)
  check('nothing on the queue past its size', (() => {
    for (let i = 0; i < 6; i++) G.buildAt(g, 0, cap.id, 'r-fighter')
    return G.cantWork(g, 0, cap.id, 'yard') === 'Shipyard queue full'
  })())
}

// --- Which ships each planet builds ---------------------------------------------------------------
{
  const { g, cap, outpost } = campaign()
  outpost.station = 4
  const why = (p: Planet, id: string) => G.cantBuildAt(g, 0, p.id, id)
  check('strike craft and gunships come from the station alone', why(outpost, 'r-fighter') === null && why(outpost, 'r-gunship') === null && why(outpost, 'r-repair') === null)
  check('frigates and corvettes need a Frigate Yard', why(outpost, 'r-frigate') === 'Needs a Frigate Yard here' && why(outpost, 'r-corvette') === 'Needs a Frigate Yard here')
  check('the capital has one', why(cap, 'r-frigate') === null && why(cap, 'r-corvette') === null)
  check('cruisers need a Capital Yard', why(outpost, 'r-cruiser') === 'Needs a Capital Yard here' && why(cap, 'r-cruiser') === 'Needs a Capital Yard here')
  outpost.base.yards.cyard = 'up'
  check('with one, cruisers', why(outpost, 'r-cruiser') === null)
  check('flagships need its Capital slip too', (why(outpost, 'r-capital') ?? '').startsWith('Needs the Capital slip'))
  outpost.base.mods.push('capitalSlip')
  check('and station level 4', why(outpost, 'r-capital') === null && (why(cap, 'r-capital') ?? '').startsWith('Needs station level 4'))
  check('bombers need the Strike hangar', (why(outpost, 'r-bomber') ?? '').startsWith('Needs the Strike hangar'))
  outpost.base.mods.push('strikeHangar')
  check('with it, bombers', why(outpost, 'r-bomber') === null)
  check('a ruin builds nothing', (() => {
    outpost.base.yards.cyard = 'ruin'
    return why(outpost, 'r-cruiser') === 'Needs a Capital Yard here'
  })())
  // The droids too: the ion frigate is a frigate.
  const g2 = G.newGalaxy({ choice: { kind: 'rim' }, size: 'standard', faction: 'droid', difficulty: 'medium', credits: 20000 })
  const out2 = g2.planets.find((p) => p.owner === 0 && p.station === 1)!
  out2.station = 3
  check('the droid frigates need a yard as well', G.cantBuildAt(g2, 0, out2.id, 'd-ion') === 'Needs a Frigate Yard here' && G.cantBuildAt(g2, 0, out2.id, 'd-frigate') === 'Needs a Frigate Yard here')
}

// --- The Second slip ---------------------------------------------------------------------------------
{
  const timeFor = (slip: boolean) => {
    const { g, cap } = campaign()
    if (slip) cap.base.mods.push('secondSlip')
    G.buildAt(g, 0, cap.id, 'r-frigate')
    G.buildAt(g, 0, cap.id, 'r-frigate')
    const start = g.time
    run(g, 400, () => !cap.queue.length)
    return g.time - start
  }
  const one = timeFor(false)
  const two = timeFor(true)
  const frigate = UNIT['r-frigate'].build * G.SHIP_TIME
  check('without a Second slip two frigates take twice as long as one', Math.abs(one - frigate * 2) <= 1, `${one} s`)
  check('with it they are built at once', Math.abs(two - frigate) <= 1, `${two} s`)
  const { g, cap } = campaign()
  cap.base.mods.push('secondSlip')
  G.buildAt(g, 0, cap.id, 'r-frigate')
  G.buildWork(g, 0, cap.id, 'cyard')
  G.tickGalaxy(g, 2)
  check('a building in the queue still goes on its own', cap.queue[0].left === cap.queue[0].total - 2 && cap.queue[1].left === cap.queue[1].total)
}

// --- A battle at a planet starts with its buildings ---------------------------------------------------
const battleAt = (base: G.PlanetBase, station = 3, attackers: string[] = ['d-frigate', 'd-frigate']) => {
  const map = generateMap({ ...DEFAULT_RULES, seed: 11, players: 2, size: 'small', beacons: 0, wrecks: 'none' })
  const sides: FleetSide[] = [
    { faction: 'republic', team: 0, ships: ['r-frigate', 'r-gunship'], station, yards: G.YARD_KINDS.filter((k) => base.yards[k] === 'up'), exp: [...base.mods] },
    { faction: 'droid', team: 1, ships: attackers },
  ]
  return { w: newFleetBattle(map, sides, { seed: 11 }), map }
}
{
  const base: G.PlanetBase = { yards: { yard: 'up', cyard: 'up' }, mods: ['shieldCore', 'sensorArray', 'secondSlip', 'drydock', 'fighterWing'] }
  const { w, map } = battleAt(base)
  const st = w.byId.get(w.players[0].station)!
  const yards = w.units.filter((u) => u.t.tier === 'yard')
  const spots = (x: World) => x.units.filter((u) => u.t.tier === 'yard').map((u) => `${u.t.id}@${u.x.toFixed(2)},${u.y.toFixed(2)},${u.a.toFixed(3)}`).join(' ')
  check('the battle has hybrid bases', !!w.hybrid && !!w.fleet)
  check('both yards stand round the station', yards.length === 2 && yards.every((u) => u.owner === 0 && !u.site && Array.isArray(u.yq)), yards.map((u) => u.t.id).join())
  check('inside the build radius', yards.every((u) => Math.hypot(u.x - st.x, u.y - st.y) <= BUILD_RADIUS))
  const att = map.spawns[1]
  check('on the side away from the attackers', yards.every((u) => Math.hypot(u.x - att.x, u.y - att.y) > Math.hypot(st.x - att.x, st.y - att.y) - 200), yards.map((u) => Math.round(Math.hypot(u.x - att.x, u.y - att.y) - Math.hypot(st.x - att.x, st.y - att.y))).join(','))
  check('at the same spots every time', spots(w) === spots(battleAt(base).w), spots(w))
  check('a placement there would have been allowed', yards.every((u) => {
    // (Checked as a skirmish would, with the yard itself out of the way.)
    const copy = { ...w, fleet: undefined, units: w.units.filter((x) => x !== u) } as World
    copy.players = w.players.map((p) => ({ ...p, credits: 1e6, level: 4 }))
    return !placement(copy, 0, u.t.id, u.x, u.y, u.a).why || placement(copy, 0, u.t.id, u.x, u.y, u.a).why === 'We already have a ' + u.t.name
  }))
  check('the station carries its expansions', JSON.stringify(st.xm) === JSON.stringify(['sensorArray', 'shieldCore']) && st.t.hardpoints.filter((h) => h.exp).length === 2)
  const fy = yards.find((u) => u.t.id === 'r-yard')!
  const cy = yards.find((u) => u.t.id === 'r-cyard')!
  check('and each yard its own', JSON.stringify(fy.xm) === JSON.stringify(['secondSlip', 'drydock']) && JSON.stringify(cy.xm) === JSON.stringify(['fighterWing']))
  check('the Fighter wing flies', w.units.some((u) => u.t.kind === 'wing' && u.parent === cy.id))
  check('nothing is built during the battle', cantBuild(w, 0, 'r-engineer') !== null && cmdExpand(w, 0, st.id, 'strikeHangar') !== null)
  const empty = battleAt(G.emptyBase()).w
  check('a planet with no buildings: just the station (hybrid, nothing round it)', !!empty.hybrid && !empty.units.some((u) => u.t.tier === 'yard'))
  check('a battle without them stays a plain fleet battle', !newFleetBattle(map, [{ faction: 'republic', team: 0, ships: ['r-frigate'], station: 2 }, { faction: 'droid', team: 1, ships: ['d-frigate'] }], { seed: 11 }).hybrid)
  // The battle is fought: the same start plays out the same, and whatever falls is written back.
  const fight = (x: World) => {
    const brains = [newBrain(0, 'hard', 'balanced'), newBrain(1, 'hard', 'offensive')]
    for (let i = 0; i < 300 / STEP && x.winner === -1; i++) {
      for (const b of brains) fleetThink(x, b, STEP)
      tick(x)
    }
    return x
  }
  const big = Array(10).fill('d-cruiser')
  const a = fight(battleAt(base, 3, big).w)
  const b = fight(battleAt(base, 3, big).w)
  check('a battle at a planet plays out the same from the same start', a.time === b.time && a.units.length === b.units.length && a.units.every((u, i) => u.x === b.units[i].x && u.hull === b.units[i].hull), `${a.time.toFixed(1)} s`)
  const left = baseLeft(a, 0, base.mods)
  console.log(`     after ${a.time.toFixed(0)} s against ten cruisers: yards standing ${left.yards.join(',') || 'none'}, expansions ${left.mods.join(',') || 'none'}`)
}

// --- What a battle leaves, written back to the planet --------------------------------------------------
{
  const { g, cap } = campaign()
  cap.base = { yards: { yard: 'up', cyard: 'up' }, mods: ['shieldCore', 'secondSlip', 'drydock', 'fighterWing'] }
  G.buildWork(g, 0, cap.id, 'armourWorks')
  const enemy = g.fleets.find((f) => f.owner === 1)!
  enemy.planet = cap.id
  enemy.system = cap.system
  enemy.leg = null
  enemy.route = []
  const c = G.clashAt(g, cap.id)!
  check('the clash carries the planet\'s buildings', !!c.base && c.base.yards.yard === 'up' && c.base.mods.length === 4)
  // Fought in the battle view: the Frigate Yard fell, the Shield core was shot off.
  const { w } = battleAt(c.base!)
  const fy = w.units.find((u) => u.t.id === 'r-yard')!
  fy.dead = true
  const st = w.byId.get(w.players[0].station)!
  st.t.hardpoints.forEach((h, i) => h.exp === 'shieldCore' && (st.hps[i].hp = 0))
  const c0 = credits(g)
  G.applyBattle(g, c, { winner: 0, survivors: { 0: c.holderShips, 1: [] }, escaped: { 0: [], 1: [] }, stationLeft: true, base: baseLeft(w, 0, c.base!.mods) }, false)
  check('a destroyed yard is a ruin now', cap.base.yards.yard === 'ruin' && cap.base.yards.cyard === 'up')
  check('its expansions are gone with it, and one shot off is lost', JSON.stringify(cap.base.mods) === JSON.stringify(['fighterWing']), cap.base.mods.join())
  check('an expansion queued for it is refunded', !cap.queue.some((q) => q.unit === 'armourWorks') && credits(g) === c0 + MODULE.armourWorks.cost)
  check('frigates wait for the yard to be rebuilt', G.cantBuildAt(g, 0, cap.id, 'r-frigate') === 'Needs a Frigate Yard here' && G.workCost(g, 0, cap, 'yard') === Math.round(yardOf('republic', 'yard').cost * REBUILD))
  // The station falls: the whole base with it.
  // (The same clash again: the attackers' fleet is gone from the last one.)
  const c2: G.Clash = { ...c, base: G.copyBase(cap.base) }
  G.applyBattle(g, c2, { winner: 1, survivors: { 0: [], 1: c2.attackerShips }, escaped: { 0: [], 1: [] }, stationLeft: false, base: { yards: ['cyard'], mods: ['fighterWing'] } }, false)
  check('a base falls with its station: yards to ruins, expansions gone', cap.station === 0 && cap.base.yards.yard === 'ruin' && cap.base.yards.cyard === 'ruin' && !cap.base.mods.length)
}

// --- Auto-resolve fights with the buildings -------------------------------------------------------------
{
  const { g, cap } = campaign()
  // Three cruisers and escorts against a level 3 station with two frigates and a gunship: the
  // buildings round it tip the fight, by about what a cruiser more would (G.AUTO_YARD).
  const attack = ['d-cruiser', 'd-cruiser', 'd-cruiser', 'd-frigate', 'd-frigate', 'd-frigate', 'd-gunship', 'd-gunship']
  const clash = (base?: G.PlanetBase, extra: string[] = []): G.Clash => ({ planet: cap.id, holder: 0, attacker: 1, station: 3, holderShips: ['r-frigate', 'r-frigate', 'r-gunship', ...extra], holderHeld: [], attackerShips: attack, attackerHeld: [], ...(base ? { base } : {}) })
  let bare = 0
  let built = 0
  let ruined = 0
  let kept = 0
  const plus = [0, 0, 0]
  const full: G.PlanetBase = { yards: { yard: 'up', cyard: 'up' }, mods: ['shieldCore', 'armourWorks', 'drydock'] }
  for (let s = 1; s <= 40; s++) {
    const r0 = G.autoResolve(g, clash(), s)
    const r1 = G.autoResolve(g, clash(full), s)
    if (r0.winner === 0) bare++
    if (r1.winner === 0) built++
    if (r1.winner === 1) {
      if (r1.base!.yards.length === 0 && r1.base!.mods.length === 0) ruined++
    } else if (r1.base!.yards.length) kept++
    for (const k of [1, 2]) if (G.autoResolve(g, clash(undefined, Array(k).fill('r-cruiser')), s).winner === 0) plus[k]++
  }
  check('yards and a Shield core make a planet harder to take', built > bare, `holder won ${bare}/40 bare, ${built}/40 with its buildings`)
  check('a whole base counts for about a cruiser more, short of two', plus[1] * 0.75 <= built && built < plus[2], `holder won ${plus[1]}/40 bare with a cruiser more, ${plus[2]}/40 with two`)
  check('a defender beaten in auto-resolve loses its yards and expansions', ruined === 40 - built, `${ruined} of ${40 - built}`)
  check('one that holds keeps the yards that stood', kept > 0, `${kept} kept some`)
  const res = G.autoResolve(g, clash(full), 3)
  check('auto-resolve says what stands, and only the holder\'s buildings', !!res.base && res.survivors[0].every((id) => UNIT[id]) && !res.survivors[0].includes('yard'))
  check('a battle without buildings has no word of them', G.autoResolve(g, clash(), 3).base === undefined)
  // Written back through the clock: an AI attack on a planet, auto-resolved.
  cap.base = copy(full)
  const r = G.autoResolve(g, clash(cap.base), 5)
  G.applyBattle(g, clash(cap.base), r, true)
  check('auto-resolved losses are written back', G.YARD_KINDS.every((k) => (r.base!.yards.includes(k) ? cap.base.yards[k] === 'up' : cap.base.yards[k] === 'ruin')), JSON.stringify(cap.base))
}
function copy(b: G.PlanetBase): G.PlanetBase {
  return { yards: { ...b.yards }, mods: [...b.mods] }
}

// --- Capture -------------------------------------------------------------------------------------------
{
  const { g, cap } = campaign()
  // Beaten: the station is gone (so the base with it), and an enemy fleet holds the orbit.
  cap.station = 0
  cap.base = { yards: { yard: 'ruin', cyard: 'ruin' }, mods: [] }
  for (const pid of g.systems[cap.system].planets) if (pid !== cap.id) g.planets[pid].owner = -1
  g.fleets = g.fleets.filter((f) => f.planet !== cap.id)
  const raider = g.fleets.find((f) => f.owner === 1)!
  raider.planet = cap.id
  raider.system = cap.system
  raider.leg = null
  raider.route = []
  run(g, 30, () => cap.owner === 1)
  check('a captured planet changes hands with its ruins', cap.owner === 1 && cap.base.yards.yard === 'ruin' && cap.base.yards.cyard === 'ruin' && !cap.base.mods.length && !cap.queue.length)
  cap.station = 3
  check('the new owner rebuilds them at half price', G.workCost(g, 1, cap, 'cyard') === Math.round(yardOf('droid', 'cyard').cost * REBUILD) && G.cantWork(g, 1, cap.id, 'cyard') === null)
  check('the old owner saw it go, ruins and all', G.known(g, 0, cap).owner === 1 && G.known(g, 0, cap).base.yards.yard === 'ruin')
}

// --- Intel: another side's buildings are known only by looking ------------------------------------------
{
  const { g } = campaign()
  const theirs = g.planets.find((p) => p.owner === 1 && p.station === 3)!
  check('the pre-war charts show their capital\'s Frigate Yard', !G.known(g, 0, theirs).live && G.known(g, 0, theirs).base.yards.yard === 'up')
  theirs.base.yards.cyard = 'up'
  theirs.base.mods.push('shieldCore')
  G.updateSight(g)
  check('what they build out of sight stays hidden', !G.known(g, 0, theirs).base.yards.cyard && !G.known(g, 0, theirs).base.mods.length)
  const scout = g.fleets.find((f) => f.owner === 0)!
  scout.planet = g.systems[theirs.system].planets[1]
  scout.system = theirs.system
  G.updateSight(g)
  check('a fleet there sees it', G.known(g, 0, theirs).live && G.known(g, 0, theirs).base.yards.cyard === 'up' && G.known(g, 0, theirs).base.mods.includes('shieldCore'))
  scout.planet = g.planets.find((p) => p.owner === 0)!.id
  scout.system = g.planets[scout.planet].system
  theirs.base.yards.cyard = 'ruin'
  G.updateSight(g)
  check('gone again, it remembers what it saw', !G.known(g, 0, theirs).live && G.known(g, 0, theirs).base.yards.cyard === 'up')
  // A Sensor array sees the systems next door.
  const home = g.planets.find((p) => p.owner === 0 && p.station === 3)!
  const next = G.neighbours(g, home.system).find((s) => !G.sees(g, 0, s))
  home.base.mods.push('sensorArray')
  G.updateSight(g)
  check('a Sensor array sees the systems next door', next !== undefined && G.sees(g, 0, next))
}

// --- Saves from before planets had buildings -----------------------------------------------------------
{
  const { g } = campaign()
  const old = JSON.parse(JSON.stringify({ ...g, events: [] })) as Record<string, unknown> & Galaxy
  ;(old as { v: number }).v = 1
  for (const p of old.planets) delete (p as Partial<Planet>).base
  for (const s of old.sides) for (const i of s.intel ?? []) delete i.base
  // A level 2 outpost, a level 4 one and a queued old-style upgrade.
  const lv2 = old.planets.find((p) => p.owner === 0 && p.station === 1)!
  lv2.station = 2
  const lv4 = old.planets.find((p) => p.owner === 1 && p.station === 1)!
  lv4.station = 4
  lv2.queue = [{ unit: 'station', left: 10, total: 50 }, { unit: 'r-gunship', left: 21, total: 21 }]
  store.set('mvlos.empires.save.old1', JSON.stringify(old))
  const back = G.loadSave('old1')
  check('an old save loads', !!back && back.v === 5)
  const at = (id: number) => back!.planets[id]
  check('a level 3 capital gets both yards it used to build from', at(g.planets.find((p) => p.owner === 0 && p.station === 3)!.id).base.yards.yard === 'up' && at(g.planets.find((p) => p.owner === 0 && p.station === 3)!.id).base.yards.cyard === 'up')
  check('level 2: a Frigate Yard; level 4: both; level 1: none', at(lv2.id).base.yards.yard === 'up' && !at(lv2.id).base.yards.cyard && at(lv4.id).base.yards.cyard === 'up' && G.YARD_KINDS.every((k) => !back!.planets.find((p) => p.station === 1)?.base.yards[k]))
  check('no expansions, and unowned planets have nothing', back!.planets.every((p) => !p.base.mods.length) && back!.planets.filter((p) => p.owner < 0).every((p) => !Object.keys(p.base.yards).length))
  check('so it still builds what it could', G.cantBuildAt(back!, 0, at(lv2.id).id, 'r-frigate') !== 'Needs a Frigate Yard here' && (G.cantBuildAt(back!, 0, at(lv2.id).id, 'r-frigate') ?? '').indexOf('Yard') < 0)
  check('the queue is kept', back!.planets[lv2.id].queue.map((q) => q.unit).join() === 'station,r-gunship')
  check('old intel gets what that station level had', back!.sides[0].intel!.every((i, pid) => !!i.base && (i.station >= 2 && back!.planets[pid].owner >= 0 ? i.base.yards.yard === 'up' : true)))
  // Broken buildings in a save never crash it.
  const bad = JSON.parse(JSON.stringify(old)) as Galaxy
  ;(bad as { v: number }).v = 2
  bad.planets[0].base = { yards: { yard: 'rubble' as 'up', cyard: 'ruin' }, mods: ['nonsense' as ModuleId, 'drydock', 'drydock'] }
  bad.planets[1].base = 7 as unknown as G.PlanetBase
  bad.planets[2].queue = [{ unit: 'secondSlip', left: 3, total: 9, paid: 1000 }, { unit: 'gone-ship', left: 1, total: 1 }]
  store.set('mvlos.empires.save.bad1', JSON.stringify(bad))
  const b2 = G.loadSave('bad1')
  check('broken buildings are cleaned up', !!b2 && JSON.stringify(b2.planets[0].base) === JSON.stringify({ yards: { cyard: 'ruin' }, mods: ['drydock'] }) && JSON.stringify(b2.planets[1].base) === JSON.stringify(G.emptyBase()) && b2.planets[2].queue.map((q) => q.unit).join() === 'secondSlip')
  let ok = true
  try {
    run(b2!, 120)
    run(back!, 120)
  } catch (e) {
    ok = false
    console.error(e)
  }
  check('and both play on', ok)
  check('a save round trip keeps the buildings', (() => {
    G.saveGalaxy(back!)
    const again = G.loadSave(back!.save.id)!
    return JSON.stringify(again.planets.map((p) => p.base)) === JSON.stringify(back!.planets.map((p) => p.base))
  })())
}

// --- The galaxy AI plans its planets ---------------------------------------------------------------------
//
// AI against AI (side 0 handed to an AI as well) on a few galaxies, battles auto-resolved, for a long
// campaign. Per side: its profile, how many of its planets have each yard, the expansions standing,
// and the ships it built (frigates and up, which need a yard). It must have built warships from its
// yards, never have gone a third of the campaign without finishing a ship while it still held a
// station, and plan the expansions its profile asks for.
{
  const weeks = Number(process.argv[2] ?? 30)
  console.log(`\nAI campaigns: ${weeks} weeks each, AI against AI`)
  console.log('galaxy        side  profile    planets  yard  cyard  ruins  expansions                                                   built(all/warships)  longest gap')
  let stuck = 0
  let noWarships = 0
  let profiled = 0
  const plans = { yard: 0, cyard: 0, mods: 0 }
  for (const choice of [{ kind: 'rim' }, { kind: 'generated', seed: 11 }, { kind: 'generated', seed: 23 }, { kind: 'generated', seed: 41 }, { kind: 'generated', seed: 77 }] as G.GalaxyChoice[]) {
    seed = 777
    const g = G.newGalaxy({ choice, size: 'standard', faction: 'republic', difficulty: 'medium', credits: 2000 })
    g.sides[0].ai = 'medium'
    const built = [0, 0]
    const war = [0, 0]
    const last = [0, 0]
    const gap = [0, 0]
    const end = weeks * G.WEEK * G.DAY
    while (g.time < end && g.winner === -1) {
      if (g.pending >= 0) G.settlePending(g, 'auto')
      G.tickGalaxy(g, 0.5)
      for (const e of g.events)
        if (e.k === 'built') {
          built[e.owner]++
          if (['frigate', 'cruiser', 'capital'].includes(UNIT[e.unit].tier) || UNIT[e.unit].kind === 'support') war[e.owner]++
          last[e.owner] = g.time
        }
      g.events.length = 0
      for (const o of [0, 1]) if (g.planets.some((p) => p.owner === o && p.station > 0)) gap[o] = Math.max(gap[o], g.time - last[o])
    }
    for (const o of [0, 1]) {
      const prof = G.galaxyProfile(g, o)
      const ps = g.planets.filter((p) => p.owner === o)
      const mods = ps.flatMap((p) => p.base.mods)
      const counts = Object.entries(mods.reduce<Record<string, number>>((m, id) => ((m[id] = (m[id] ?? 0) + 1), m), {})).map(([id, n]) => `${id}${n > 1 ? `x${n}` : ''}`).join(',')
      const yard = ps.filter((p) => p.base.yards.yard === 'up').length
      const cyard = ps.filter((p) => p.base.yards.cyard === 'up').length
      const ruins = ps.reduce((n, p) => n + G.YARD_KINDS.filter((k) => p.base.yards[k] === 'ruin').length, 0)
      console.log(`${(choice.kind === 'rim' ? 'rim' : `gen ${choice.seed}`).padEnd(13)} ${String(o).padStart(4)}  ${prof.padEnd(10)} ${String(ps.length).padStart(7)} ${String(yard).padStart(5)} ${String(cyard).padStart(6)} ${String(ruins).padStart(6)}  ${(counts || '-').padEnd(60)} ${`${built[o]}/${war[o]}`.padStart(19)}  ${gap[o].toFixed(0).padStart(5)} s${g.sides[o].alive ? '' : ' (beaten)'}`)
      if (!g.sides[o].alive) continue
      if (gap[o] > end / 3) stuck++
      if (!war[o]) noWarships++
      plans.yard += yard
      plans.cyard += cyard
      plans.mods += mods.length
      // The first expansion its profile lists is among what it built (if it built any).
      const first = PROFILES[prof].modules[0]
      if (mods.length && (mods.includes(first) || g.planets.some((p) => p.owner === o && p.queue.some((q) => q.unit === first)))) profiled++
      else if (mods.length) console.log(`     (side ${o} never built ${first}, its profile's first expansion)`)
    }
  }
  check('no AI went a third of a campaign without finishing a ship', !stuck, `${stuck} stuck`)
  check('every AI built warships from its yards', !noWarships, `${noWarships} without`)
  check('the AIs built yards and expansions', plans.yard > 0 && plans.cyard > 0 && plans.mods > 0, JSON.stringify(plans))
  check('they started with the expansion their profile puts first', profiled > 0, `${profiled} did`)
}

// --- Rush launch on the galaxy map ----------------------------------------------------------------------
{
  const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol
  /** A campaign whose capital has a Capital Yard and a cruiser at 62% in its queue. */
  const rushCampaign = (share = 0.62) => {
    const c = campaign()
    c.cap.base = { yards: { yard: 'up', cyard: 'up' }, mods: [] }
    G.buildAt(c.g, 0, c.cap.id, 'r-cruiser')
    c.cap.queue[0].left = c.cap.queue[0].total * (1 - share)
    return c
  }
  const items = (g: Galaxy, planet: number, owner = 0) => G.fleetsHere(g, owner, planet).flatMap((f) => f.items)
  const rushed = (g: Galaxy, planet: number, owner = 0) => items(g, planet, owner).filter((i) => i.rush)
  const cruiserTotal = UNIT['r-cruiser'].build * G.SHIP_TIME

  // The button's gating: a Capital Yard, station level 3, a Capital Yard ship at least half built, no cooldown.
  {
    const { g, cap } = rushCampaign(0.3)
    check('under 50% built: no rush, and it says how far along', /^Not 50% built yet \(30%\)/.test(G.cantRushAt(g, 0, cap.id) ?? ''), String(G.cantRushAt(g, 0, cap.id)))
    check('the button shows for it all the same (disabled)', G.rushOffered(cap))
    cap.queue[0].left = cap.queue[0].total * 0.38
    check('at 62% built it can rush', G.cantRushAt(g, 0, cap.id) === null && near(G.queueShare(cap.queue[0]), 0.62, 0.001))
    check('the enemy can\'t rush our planet\'s ship', G.cantRushAt(g, 1, cap.id) === 'Not our planet')
    delete cap.base.yards.cyard
    check('no Capital Yard: no rush, no button', G.cantRushAt(g, 0, cap.id) === 'Needs a Capital Yard here' && !G.rushOffered(cap))
    cap.base.yards.cyard = 'ruin'
    check('a ruined Capital Yard is none', G.cantRushAt(g, 0, cap.id) === 'Needs a Capital Yard here')
    cap.base.yards.cyard = 'up'
    cap.station = 2
    check('station below level 3: no rush, no button', G.cantRushAt(g, 0, cap.id) === `Needs station level ${G.RUSH_GC.station}` && !G.rushOffered(cap))
    cap.station = 3
    cap.queue.unshift({ unit: 'r-frigate', left: 5, total: 10 })
    check('a Frigate Yard ship is not rushable, and offers no button', G.cantRushAt(g, 0, cap.id) === 'No Capital Yard ship being built' && !G.rushOffered(cap))
    cap.queue.shift()
    cap.queue.unshift({ unit: 'drydock', left: 5, total: 10 })
    check('nor is a building going up', G.cantRushAt(g, 0, cap.id) === 'No Capital Yard ship being built')
    cap.queue.shift()
    check('standing again, the same ship can rush', G.cantRushAt(g, 0, cap.id) === null)
  }

  // Launching it: the ship joins the fleet in orbit with its state; the planet gets a cooldown and a slowdown.
  {
    const { g, cap } = rushCampaign()
    G.buildAt(g, 0, cap.id, 'r-cruiser')
    const total = cap.queue[0].total
    const left = cap.queue[0].left
    const fleet = G.fleetsHere(g, 0, cap.id)[0]
    const before = fleet.ships.length
    check('rush works', G.rushLaunch(g, 0, cap.id) === null && cap.queue.length === 1)
    const it = rushed(g, cap.id)[0]
    check('the ship is in a fleet at the planet, rushed', !!it && it.unit === 'r-cruiser' && G.fleetsHere(g, 0, cap.id).reduce((n, f) => n + f.ships.length, 0) === before + 1)
    check('it carries what was built and what was left', !!it && near(it.rush!.done, 0.62, 0.001) && near(it.rush!.left, left, 1e-6), JSON.stringify(it?.rush))
    check('its build time is the skirmish time on the galaxy clock', near(total, cruiserTotal, 1e-6) && near(G.rushDone('r-cruiser', left), 0.62, 0.001))
    check('the cooldown is the skirmish cooldown on the galaxy clock', near(cap.rushAt! - g.time, G.RUSH_GC.cooldown, 1e-6) && G.RUSH_GC.cooldown === 120 * G.SHIP_TIME, `${G.RUSH_GC.cooldown} s`)
    check('the next Capital Yard ship in its queue builds slower', cap.queue[0].slow === true)
    const q = cap.queue[0]
    const l0 = q.left
    G.tickGalaxy(g, 10)
    check('25% slower', near(l0 - q.left, 10 / (1 + G.RUSH_GC.slowdown), 1e-6), `${(l0 - q.left).toFixed(3)} s of work in 10 s`)
    q.left = q.total * 0.2
    check('on cooldown, no rush (and the time left shows)', /^Ready again in \d+ s/.test(G.cantRushAt(g, 0, cap.id) ?? '') && !G.rushOffered(cap) === false, String(G.cantRushAt(g, 0, cap.id)))
    g.time += G.RUSH_GC.cooldown
    check('the cooldown runs out', G.cantRushAt(g, 0, cap.id) === null)
    // With nothing else queued the slowdown waits for the next ship.
    const { g: g2, cap: c2 } = rushCampaign()
    G.rushLaunch(g2, 0, c2.id)
    check('with nothing else queued, the next ship it queues is the slow one', c2.slowNext === true && !c2.queue.length && (G.buildAt(g2, 0, c2.id, 'r-cruiser'), c2.queue[0].slow === true && !c2.slowNext))
    check('a ship not from the Capital Yard is not slowed', (() => {
      const { g: g3, cap: c3 } = rushCampaign()
      G.rushLaunch(g3, 0, c3.id)
      G.buildAt(g3, 0, c3.id, 'r-frigate')
      return !c3.queue[0].slow && c3.slowNext === true
    })())
    check('every fleet full: no rush (the ship would have nowhere to go)', (() => {
      const { g: g4, cap: c4 } = rushCampaign()
      g4.fleets = g4.fleets.filter((f) => !(f.owner === 0 && f.planet === c4.id))
      for (let i = 0; i < G.MAX_FLEETS; i++) g4.fleets.push({ id: g4.nextId++, owner: 0, ships: Array(6).fill('r-cruiser'), items: [], planet: c4.id, system: c4.system, from: c4.id, leg: null, route: [], waypoints: [], arrived: g4.time })
      G.layoutFleets(g4)
      return G.fleetsHere(g4, 0, c4.id).length === G.MAX_FLEETS && G.cantRushAt(g4, 0, c4.id) === 'Every fleet here is full'
    })())
  }

  // The state lives in the inventory and travels with the ship.
  {
    const { g, cap } = rushCampaign()
    G.rushLaunch(g, 0, cap.id)
    const f = G.fleetsHere(g, 0, cap.id).find((x) => x.items.some((i) => i.rush))!
    const it = f.items.find((i) => i.rush)!
    const state = { ...it.rush! }
    const moved = G.moveItem(g, 0, { fleet: f.id, x: it.x, y: it.y }, { fleet: 'new' })
    check('moving it to a new fleet takes its state along', typeof moved !== 'string' && moved.items.length === 1 && JSON.stringify(moved.items[0].rush) === JSON.stringify(state), typeof moved === 'string' ? moved : '')
    const nf = typeof moved === 'string' ? f : moved
    check('the flat ship list is unchanged by it', nf.ships.length === 1 && nf.ships[0] === 'r-cruiser')
    const back = G.mergeFleets(g, 0, nf.id, f.id)
    check('merging fleets keeps it', typeof back !== 'string' && G.fleetsHere(g, 0, cap.id).flatMap((x) => x.items).filter((i) => i.rush).length === 1)
    const fl = G.fleetsHere(g, 0, cap.id).find((x) => x.items.some((i) => i.rush))!
    check('arranging a fleet keeps it', G.arrangeFleet(g, 0, fl.id) !== 'Not our fleet')
    const arranged = G.fleetsHere(g, 0, cap.id).flatMap((x) => x.items).filter((i) => i.rush)
    check('still one rushed ship, same state', arranged.length === 1 && JSON.stringify(arranged[0].rush) === JSON.stringify(state))
    const { g: g2, cap: c2 } = rushCampaign()
    G.buildAt(g2, 0, c2.id, 'r-cruiser')
    c2.queue[0].left = 0
    G.tickGalaxy(g2, 0.1)
    c2.queue[0].left = c2.queue[0].total * 0.38
    G.rushLaunch(g2, 0, c2.id)
    const all = G.fleetsHere(g2, 0, c2.id).flatMap((x) => x.items)
    check('a rushed cruiser sits beside a plain one as its own item', all.filter((i) => i.unit === 'r-cruiser').length === 2 && all.filter((i) => i.unit === 'r-cruiser' && i.rush).length === 1 && all.every((i) => !i.rush || i.n === 1))
  }

  // Finishing over galaxy time: parked at a planet of ours with a Capital Yard or a Drydock, at the normal pace; never elsewhere.
  {
    const { g, cap, outpost } = rushCampaign()
    G.rushLaunch(g, 0, cap.id)
    const left0 = rushed(g, cap.id)[0].rush!.left
    G.tickGalaxy(g, 10)
    const r1 = rushed(g, cap.id)[0].rush!
    check('at the Capital Yard planet it finishes over galaxy time, at the build pace', near(r1.left, left0 - 10, 1e-6) && near(r1.done, G.rushDone('r-cruiser', r1.left), 1e-6) && r1.done > 0.62, `${left0.toFixed(1)} -> ${r1.left.toFixed(1)} s, ${(r1.done * 100).toFixed(1)}%`)
    // It never finishes sooner than building it normally would have.
    const total = cruiserTotal
    check('what is left is what the build had left (never sooner)', near(left0, total * 0.38, 1e-6) && r1.left > 0)
    const f = G.fleetsHere(g, 0, cap.id).find((x) => x.items.some((i) => i.rush))!
    // Away at a planet without a yard or a Drydock: nothing happens.
    outpost.base = G.emptyBase()
    const lone = G.moveItem(g, 0, { fleet: f.id, x: f.items.find((i) => i.rush)!.x, y: f.items.find((i) => i.rush)!.y }, { fleet: 'new' })
    const rf = typeof lone === 'string' ? f : lone
    rf.planet = outpost.id
    rf.system = outpost.system
    rf.from = outpost.id
    outpost.owner = 0
    const l1 = rf.items[0].rush!.left
    G.tickGalaxy(g, 20)
    check('at a planet with neither, it does not progress', near(rf.items[0].rush!.left, l1, 1e-9))
    outpost.base.mods.push('drydock')
    G.tickGalaxy(g, 5)
    check('a Drydock alone finishes it too', near(rf.items[0].rush!.left, l1 - 5, 1e-6))
    outpost.base.mods = []
    outpost.base.yards.cyard = 'ruin'
    G.tickGalaxy(g, 5)
    check('a ruined Capital Yard does not', near(rf.items[0].rush!.left, l1 - 5, 1e-6))
    outpost.base.yards.cyard = 'up'
    outpost.owner = 1
    G.tickGalaxy(g, 5)
    check('a yard that is not ours does not either', near(rf.items[0].rush!.left, l1 - 5, 1e-6))
    outpost.owner = 0
    // Flying: nothing.
    const dest = g.planets.find((p) => p.owner === 0 && p.id !== outpost.id && p.id !== cap.id)
    const target = dest ?? cap
    const before = rf.items[0].rush!.left
    check('sent off', G.moveFleet(g, 0, rf.id, target.id) === null && !!rf.leg)
    g.aiT[1] = 1e9
    G.tickGalaxy(g, 3)
    check('while flying, it does not progress', !!rf.leg && near(rf.items[0].rush!.left, before, 1e-9), `${before.toFixed(2)} -> ${rf.items[0].rush!.left.toFixed(2)}`)
    // And it's done with at the yard: the state clears.
    const { g: g2, cap: c2 } = rushCampaign()
    G.rushLaunch(g2, 0, c2.id)
    const left = rushed(g2, c2.id)[0].rush!.left
    let steps = 0
    for (; steps < 400 && rushed(g2, c2.id).length; steps++) G.tickGalaxy(g2, 0.5)
    check('it is finished when its time is up, not sooner', !rushed(g2, c2.id).length && near(steps * 0.5, Math.ceil(left / 0.5) * 0.5, 0.51), `${(steps * 0.5).toFixed(1)} s for ${left.toFixed(1)} s`)
    check('a finished ship is a plain ship in the fleet', items(g2, c2.id).some((i) => i.unit === 'r-cruiser' && !i.rush))
  }

  // A battle at the planet: the rushed ship spawns rushed (hull = share built, missing parts uninstalled), finishes beside a
  // Drydock, and what it got done is written back to the fleet.
  {
    const { g, cap } = rushCampaign()
    cap.base = { yards: { yard: 'up', cyard: 'up' }, mods: ['drydock'] }
    G.rushLaunch(g, 0, cap.id)
    const spare = G.fleetsHere(g, 0, cap.id)[0]
    g.fleets.push({ id: g.nextId++, owner: 1, ships: ['d-frigate'], items: [], planet: cap.id, system: cap.system, from: cap.id, leg: null, route: [], waypoints: [], arrived: g.time })
    G.layoutFleets(g)
    const c = G.clashAt(g, cap.id)!
    const rs = c.holderRush ?? []
    check('the clash knows the rushed ship', rs.length === 1 && rs[0].unit === 'r-cruiser' && near(rs[0].done, 0.62, 0.001) && !c.attackerRush && c.holderShips.includes('r-cruiser'), JSON.stringify(rs))
    const map = generateMap({ ...DEFAULT_RULES, seed: 11, players: 2, size: 'small', beacons: 0, wrecks: 'none' })
    const side = (cl: G.Clash): FleetSide[] => [
      { faction: 'republic', team: 0, ships: G.withoutShips(cl.holderShips, cl.holderHeld), reserve: cl.holderHeld, rushed: G.rushIntoBattle(cl.holderRush), station: cl.station, yards: G.YARD_KINDS.filter((k) => cl.base!.yards[k] === 'up'), exp: [...cl.base!.mods] },
      { faction: 'droid', team: 1, ships: G.withoutShips(cl.attackerShips, cl.attackerHeld), reserve: cl.attackerHeld, rushed: G.rushIntoBattle(cl.attackerRush) },
    ]
    const w = newFleetBattle(map, side(c), { seed: 11 })
    const u = w.units.find((x) => x.rush && x.owner === 0)!
    check('it spawns as a skirmish rushed ship', !!u && u.t.id === 'r-cruiser')
    check('its hull is the share that was built', near(u.hull / u.hullMax, 0.62, 0.01), `${((u.hull / u.hullMax) * 100).toFixed(1)}%`)
    const parts = u.t.hardpoints.filter((h) => h.kind !== 'engine').length
    check('its unbuilt turrets are uninstalled (scaffolding, they don\'t fire)', u.rush!.parts.length === Math.round(parts * 0.38) && u.rush!.parts.every((i) => u.hps[i].hp === 0), `${u.rush!.parts.length} of ${parts}`)
    check('with the battle\'s seconds of work left (the galaxy\'s over the ship build ratio)', near(u.rush!.left, rs[0].left / G.SHIP_TIME, 1e-6), `${u.rush!.left.toFixed(1)} s`)
    check('only that cruiser is rushed (the others are whole)', w.units.filter((x) => x.rush).length === 1)
    // Beside its Drydock, a few seconds of work.
    const dd = w.units.find((x) => x.t.tier === 'yard' && x.t.id === 'r-yard')!
    const stand = () => {
      u.x = dd.x + 150
      u.y = dd.y
      u.v = 0
    }
    stand()
    const l0 = u.rush!.left
    for (let i = 0; i < 6 / STEP; i++) {
      stand()
      tick(w)
      w.events.length = 0
    }
    check('a Drydock finishes it during the battle', !!u.rush && near(l0 - u.rush.left, 6, 0.3), `${(l0 - u.rush.left).toFixed(2)} s done`)
    w.winner = 0
    const res = resultOf(w, c, 0, false)
    const listed = res.rushed?.[0]?.[0]
    check('what is left of its build is in the result', !!listed && listed.unit === 'r-cruiser' && near(listed.left, u.rush!.left * G.SHIP_TIME, 1e-6) && listed.done > 0.62, JSON.stringify(listed))
    G.applyBattle(g, c, res, false)
    const back = rushed(g, cap.id)
    check('written back to the fleet', back.length === 1 && near(back[0].rush!.left, u.rush!.left * G.SHIP_TIME, 1e-6) && near(back[0].rush!.done, G.rushDone('r-cruiser', back[0].rush!.left), 1e-6), JSON.stringify(back[0]?.rush))
    check('the fleet\'s other ships are untouched', items(g, cap.id).filter((i) => !i.rush).every((i) => !i.rush))
    void spare
    // A second battle: it gets finished in the battle, so it comes back a plain ship.
    g.fleets.push({ id: g.nextId++, owner: 1, ships: ['d-frigate'], items: [], planet: cap.id, system: cap.system, from: cap.id, leg: null, route: [], waypoints: [], arrived: g.time })
    G.layoutFleets(g)
    const c2 = G.clashAt(g, cap.id)!
    const w2 = newFleetBattle(map, side(c2), { seed: 11 })
    const u2 = w2.units.find((x) => x.rush && x.owner === 0)!
    const dd2 = w2.units.find((x) => x.t.tier === 'yard' && x.t.id === 'r-yard')!
    for (let i = 0; i < 200 / STEP && u2.rush; i++) {
      u2.x = dd2.x + 150
      u2.y = dd2.y
      u2.v = 0
      tick(w2)
      w2.events.length = 0
    }
    check('finished in the battle', !u2.rush && u2.hull >= u2.hullMax * 0.99)
    w2.winner = 0
    const res2 = resultOf(w2, c2, 0, false)
    G.applyBattle(g, c2, res2, false)
    check('it comes back a plain ship', !rushed(g, cap.id).length && items(g, cap.id).some((i) => i.unit === 'r-cruiser'))
    // A rushed ship held back in the reserve: called in still unfinished.
    const { g: g3, cap: c3 } = rushCampaign()
    c3.base = { yards: { yard: 'up', cyard: 'up' }, mods: [] }
    G.rushLaunch(g3, 0, c3.id)
    const held = G.fleetsHere(g3, 0, c3.id).find((f) => f.items.some((i) => i.rush))!
    G.holdFleet(g3, 0, held.id, true)
    g3.fleets.push({ id: g3.nextId++, owner: 1, ships: ['d-frigate'], items: [], planet: c3.id, system: c3.system, from: c3.id, leg: null, route: [], waypoints: [], arrived: g3.time })
    G.layoutFleets(g3)
    const c4 = G.clashAt(g3, c3.id)!
    check('a held back rushed ship is listed as held', !!c4.holderRush?.[0]?.held)
    const w3 = newFleetBattle(map, side({ ...c4, base: c4.base ?? { yards: {}, mods: [] } }), { seed: 11 })
    check('it waits in the reserve, rushed', !w3.units.some((x) => x.rush) && w3.players[0].reserve.includes('r-cruiser') && (w3.players[0].rushRes ?? []).length === 1)
    const dep = w3.players[0]
    const stt = w3.byId.get(dep.station)!
    const why = cmdDeploy(w3, 0, 'r-cruiser', stt.x + 700, stt.y, 0)
    for (let i = 0; i < 20 / STEP; i++) tick(w3)
    check('calling it in brings it in unfinished', !why && w3.units.some((x) => x.rush && x.owner === 0 && !x.dead && x.t.id === 'r-cruiser' && x.hull < x.hullMax), String(why))
  }

  // Auto-resolve: a rushed ship counts at its built share of strength; unfinished ones come through unfinished.
  {
    const { g, cap } = rushCampaign()
    const mk = (done: number): G.Clash => ({ planet: cap.id, holder: 0, attacker: 1, station: 0, holderShips: ['r-cruiser', 'r-cruiser'], holderHeld: [], attackerShips: ['d-cruiser', 'd-cruiser'], attackerHeld: [], ...(done < 1 ? { holderRush: [{ unit: 'r-cruiser', done, left: 40 }] } : {}) })
    let whole = 0
    let half = 0
    let thin = 0
    const trials = 40
    for (let s = 0; s < trials; s++) {
      if (G.autoResolve(g, mk(1), 100 + s).winner === 0) whole++
      if (G.autoResolve(g, mk(0.5), 100 + s).winner === 0) half++
      if (G.autoResolve(g, mk(0.05), 100 + s).winner === 0) thin++
    }
    check('a rushed ship counts for less in an auto-resolved battle', whole > half && half >= thin && whole - thin >= 3, `wins of ${trials}: whole ${whole}, 50% ${half}, 5% ${thin}`)
    const weak: G.Clash = { planet: cap.id, holder: 0, attacker: 1, station: 0, holderShips: ['r-cruiser', 'r-cruiser', 'r-cruiser'], holderHeld: [], attackerShips: ['d-gunship'], attackerHeld: [], holderRush: [{ unit: 'r-cruiser', done: 0.6, left: 33 }] }
    const r = G.autoResolve(g, weak, 5)
    check('it comes through still rushed, as far along as it was', r.winner === 0 && r.survivors[0].length === 3 && r.rushed?.[0]?.length === 1 && r.rushed[0][0].done === 0.6 && r.rushed[0][0].left === 33, JSON.stringify(r.rushed))
    // Applied to the galaxy (through a real clash).
    const { g: g2, cap: c2 } = rushCampaign()
    G.rushLaunch(g2, 0, c2.id)
    g2.fleets.push({ id: g2.nextId++, owner: 1, ships: ['d-gunship'], items: [], planet: c2.id, system: c2.system, from: c2.id, leg: null, route: [], waypoints: [], arrived: g2.time })
    G.layoutFleets(g2)
    const clash = G.clashAt(g2, c2.id)!
    const res = G.autoResolve(g2, clash, 9)
    G.applyBattle(g2, clash, res, true)
    check('auto-resolved, the survivor stays rushed in its fleet', res.winner === 0 && rushed(g2, c2.id).length === 1 && near(rushed(g2, c2.id)[0].rush!.done, 0.62, 0.001))
  }

  // The galaxy AI rushes under threat: an enemy fleet it sees in the system or next door, worth more than its garrison.
  {
    const aiSetup = () => {
      const c = campaign()
      const g = c.g
      g.sides[1].credits = 30000
      const home = g.planets.find((p) => p.owner === 1 && p.station === 3)!
      home.base = { yards: { yard: 'up', cyard: 'up' }, mods: [] }
      for (const f of [...g.fleets]) if (f.owner === 1 && f.planet === home.id) f.items = []
      g.fleets = g.fleets.filter((f) => f.items.length || f.owner !== 1 || f.planet !== home.id)
      g.sides[1].credits -= 0
      G.buildAt(g, 1, home.id, 'd-cruiser')
      home.queue[0].left = home.queue[0].total * 0.38
      return { g, home }
    }
    const fleetOf = (g: Galaxy, owner: number, planet: number, ships: string[]) => {
      g.fleets.push({ id: g.nextId++, owner, ships, items: [], planet, system: g.planets[planet].system, from: planet, leg: null, route: [], waypoints: [], arrived: g.time })
      G.layoutFleets(g)
    }
    const think = (g: Galaxy) => {
      g.sides[1].mind = undefined
      G.updateSight(g)
      for (let i = 0; i < 3; i++) {
        g.time += 5
        G.thinkAi(g, 1)
      }
    }
    {
      const { g, home } = aiSetup()
      think(g)
      check('with nobody near, the AI does not rush', !G.fleetsHere(g, 1, home.id).some((f) => f.items.some((i) => i.rush)) && home.queue.some((q) => q.unit === 'd-cruiser'))
    }
    {
      const { g, home } = aiSetup()
      fleetOf(g, 0, home.id, Array(6).fill('r-cruiser'))
      think(g)
      const rushedHere = G.fleetsHere(g, 1, home.id).flatMap((f) => f.items).filter((i) => i.rush)
      check('an enemy fleet at its planet, stronger than the garrison: the AI rushes its cruiser', rushedHere.length === 1 && rushedHere[0].unit === 'd-cruiser' && near(rushedHere[0].rush!.done, 0.62, 0.02), JSON.stringify(rushedHere.map((i) => i.rush)))
      check('and its planet is on cooldown now', !!home.rushAt && home.rushAt > g.time)
    }
    {
      const { g, home } = aiSetup()
      fleetOf(g, 0, home.id, ['r-fighter'])
      think(g)
      check('a weak enemy (the garrison holds): no rush', !G.fleetsHere(g, 1, home.id).some((f) => f.items.some((i) => i.rush)))
    }
    {
      // Next door and seen: a system the AI holds a planet in. Unseen next door: it can't know.
      const { g, home } = aiSetup()
      const sys = g.systems[home.system]
      const next = G.neighbours(g, sys.id)
      let seenDoor = -1
      let blind = -1
      G.updateSight(g)
      for (const n of next) {
        const pid = g.systems[n].planets[0]
        if (G.sees(g, 1, n)) seenDoor = seenDoor < 0 ? pid : seenDoor
        else blind = blind < 0 ? pid : blind
      }
      if (blind >= 0) {
        const b = aiSetup()
        const bp = b.g.systems[g.planets[blind].system].planets[0]
        fleetOf(b.g, 0, bp, Array(6).fill('r-cruiser'))
        think(b.g)
        check('an enemy fleet next door that the AI cannot see: no rush (fog of war)', !G.fleetsHere(b.g, 1, b.home.id).some((f) => f.items.some((i) => i.rush)) && !G.sees(b.g, 1, b.g.planets[bp].system))
      } else check('(no unseen neighbour system to test the fog with here)', true)
      if (seenDoor >= 0) {
        const b = aiSetup()
        fleetOf(b.g, 0, seenDoor, Array(6).fill('r-cruiser'))
        b.g.fleets[b.g.fleets.length - 1].arrived = b.g.time
        think(b.g)
        check('an enemy fleet next door that the AI sees: it rushes', G.fleetsHere(b.g, 1, b.home.id).some((f) => f.items.some((i) => i.rush)))
      } else check('(no seen neighbour system to test next-door threats with here)', true)
    }
  }

  // Saves: old ones load as normal ships; the new shape survives a save; broken rush state is dropped.
  {
    const { g, cap } = rushCampaign()
    G.rushLaunch(g, 0, cap.id)
    g.sides[0].credits = 1
    check('a save is version 5', G.saveGalaxy(g) && g.v === 5)
    const key = `mvlos.empires.save.${g.save.id}`
    const loaded = G.loadSave(g.save.id)!
    const it = loaded.fleets.flatMap((f) => f.items).find((i) => i.rush)
    check('a rushed ship and the planet\'s cooldown survive a save', !!it && near(it.rush!.done, 0.62, 0.001) && loaded.planets[cap.id].rushAt === cap.rushAt && loaded.v === 5, JSON.stringify(it?.rush))
    const old = JSON.parse(store.get(key)!) as Galaxy & { v: number }
    old.v = 2
    for (const f of old.fleets) for (const i of f.items) delete i.rush
    for (const p of old.planets) {
      delete p.rushAt
      delete p.slowNext
    }
    store.set(key, JSON.stringify(old))
    const o = G.loadSave(g.save.id)!
    check('a version 2 save loads, every ship a normal ship', !!o && o.v === 5 && o.fleets.every((f) => f.items.every((i) => !i.rush)) && o.fleets.reduce((n, f) => n + f.ships.length, 0) === g.fleets.reduce((n, f) => n + f.ships.length, 0))
    const ok = G.autoResolve(o, { planet: cap.id, holder: 0, attacker: 1, station: 0, holderShips: ['r-cruiser'], holderHeld: [], attackerShips: ['d-gunship'], attackerHeld: [] }, 3)
    check('and plays (a battle without rushed ships has no word of them)', ok.rushed === undefined)
    const bad = JSON.parse(store.get(key)!) as Galaxy & { v: number }
    bad.v = 3
    const cruiserItem = bad.fleets.flatMap((f) => f.items).find((i) => i.unit === 'r-cruiser')!
    cruiserItem.rush = { done: Number.NaN, left: 5 }
    store.set(key, JSON.stringify(bad))
    check('a rushed ship with a broken state loads as a normal ship', !G.loadSave(g.save.id)!.fleets.flatMap((f) => f.items).some((i) => i.rush))
    const stack = JSON.parse(store.get(key)!) as Galaxy & { v: number }
    const fighter = stack.fleets.flatMap((f) => f.items).find((i) => i.unit === 'r-fighter')
    if (fighter) fighter.rush = { done: 0.5, left: 5 }
    store.set(key, JSON.stringify(stack))
    check('and a strike craft stack can\'t carry one', !G.loadSave(g.save.id)!.fleets.flatMap((f) => f.items).some((i) => i.rush && i.unit === 'r-fighter'))
  }
}

console.log(failed ? `${failed} check(s) failed` : 'All galactic conquest building checks passed')
if (failed) process.exit(1)
