// Checks ground battles, which run in the space game's sim (sim.ts, with the terrain layer of
// ground/world.ts): headless, no browser, no server.
//
//   node scripts/empires-ground.ts [seconds]
//
// 1. The ground code uses no Math.random, Date, clock, DOM or engine-dependent maths.
// 2. Placement on Dustfall Ridge: every rule refuses somewhere with its own reason (unbuildable, a
//    crystal field, uneven ground, built on, blocking a building's exit, too near the enemy (any building), enemy units on it, no room for its own exit, credits), the ghost checks every tile, an
//    order to place there is refused with the same reason, and a building hidden in the fog doesn't
//    stop a placement.
// 3. A building battle on Dustfall Ridge, seat 0 scripted (Republic) and seat 1 a peaceful AI (Swarm: no fighters), two
//    copies side by side, a third thawed from a snapshot midway, and a replay from the logged
//    inputs, all hashing the same every second. Seat 0 trains engineers at its Command Center
//    (one cancelled and refunded), places Command Centers and builds them with a growing crew, calls
//    one off before work starts (full refund) and one some way in (the space game's site refund), has
//    a unit standing on a site pushed off when work starts, repairs a damaged building, sets a rally
//    point, and loses a building (its stamp freed). The AI must train engineers and expand.
// 3b. An economy battle on Ashwater Crossing, seat 0 scripted (Republic) and seat 1 the AI
//    (Confederacy), checked the same way: seat 0 trains up to its unit cap (the next one refused with
//    the supply reason), sends four engineers to gather the crystal field by its base, builds a Supply
//    Depot and trains on past the old cap, and a field's clusters run nearly dry (as a dev cheat would)
//    run out one by one: each mined-out cluster's stamp comes off the nav grid, its engineers move on
//    to the next cluster in the field, and once the field is dry to the nearest other field. The
//    clusters are laid out the same in every copy, each field holding FIELD_KYBER, and block their
//    tiles. All along, the kyber gone from the fields is
//    exactly what was dropped off plus what is being carried, no load is over the carry size, and
//    several engineers mine one field at once. The AI must keep its engineers gathering, build supply
//    before it reaches its cap, and never train past it.
// 5. Combat: a Scout battle (eight Pathfinders against three Probe droids and the Command Hub's
//    turret) in step across two copies, a snapshot thaw and a replay, ending with every enemy
//    building destroyed and a win, its stamp freed; artillery holds fire at what its team can't see,
//    fires past its own sight at what an ally sees, and never closer than its minimum range; a shot
//    lands as its damage times GROUND_VS for the armour; the dev weapon test fires all seven weapons.
// 3d. A power battle on Ashwater Crossing, seat 0 scripted (Republic), seat 1 the AI (Confederacy),
//    checked the same way: the base starts on its Command Center's power alone; training and two
//    research stations draw more than it makes, and then training, research points and a site going
//    up all run at made / used of their speed, to the tick; a power generator puts it right, burning
//    its kyber every tick; with no kyber left it stops, and the shortage is back. The AI builds a
//    generator and a research station and banks research points.
// 3e. A factory battle on Ashwater Crossing, seat 0 scripted (Republic), seat 1 the AI (Confederacy),
//    checked the same way: an engineer builds a Barracks; a Vehicle Factory (raised) takes five
//    units in a queue, one cancelled and refunded in full; they roll out of its door one by one and
//    drive to its rally point; it draws its power only while its queue isn't empty, and short of
//    power its training runs at made / used of its speed, to the tick; a unit needing tier 2 is
//    refused at a tier 1 factory, and an id the game doesn't know is refused, not trained. The
//    factories' tier 1 units are stand-ins until they are added (ground-test-units.ts). Then a longer
//    AI run: it builds a foot and a vehicle factory, keeps its power up and trains a mix of both.
// 3f. An upgrade battle on Ashwater Crossing, seat 0 scripted (Republic), seat 1 the AI, checked
//    the same way: a unit needing tier 2 and research needing tier 2 are refused at a tier 1
//    Vehicle Factory; its upgrade to tier 2 is paid in research points and kyber, draws its power
//    only while it runs, and is called off with both refunded in full; started again while power is
//    short it runs at made / used of its speed, to the tick; done, the factory stands at tier 2 with
//    more hull and trains the tier 2 unit; research there (weapons) reaches the unit already out and
//    the one trained after. Then a long AI run: it upgrades a factory and takes research.
// 3g. An orders battle on Ashwater Crossing, seat 0 scripted (Republic), seat 1 the AI, checked the
//    same way: one engineer is given a move, then Shift-queued a gather and two sites: it drives
//    there, builds the two sites one after the other (a queued order goes before gathering, which
//    never ends), then gathers. Another engineer is assisted by a third (Order `assist`) through a
//    build, a repair and gathering: the helper works the same site, mends the same building and
//    mines the same field, following it from job to job.
// 3h. A drop-off battle on Ashwater Crossing, seat 0 scripted (Republic), seat 1 a peaceful AI,
//    checked the same way: four engineers mine the far field on our side and haul to the Command
//    Center; a Supply Depot site beside the field, not built, is ignored; a finished depot there
//    takes their loads (kyber a minute measured before and after); destroyed while engineers carry
//    to it, they re-route to the Command Center. Then an AI run with the fields by its start mined out:
//    the AI puts a supply building beside the further field it mines.
// 6. Squads: a battle of the dev test squads (troopers and a walker against battle droids) in step
//    across two copies, a snapshot thaw and a replay, squads losing members one by one as their hull
//    drops, never fewer than one while alive, and the count in the hash; a squad fires one shot per
//    member standing, each on its own reload and at a target of its own, from where it stands, so fewer
//    members fire fewer shots; standing members shuffle, and crossing a river they file through the
//    crossing and gather again on the far side. The six tier 1 units
//    (each faction's foot squad and fast vehicle) fight each other in step the same way, every one
//    of them firing; and the six tier 2 units (anti-swarm) against a crowd of tier 1 twice their
//    number, all six firing, splash catching several at once, the anti-swarm side ahead.
// 7. Spread out: a squad spreads at once (its members walking out wider) or, Shift-queued, after its
//    move, and closes up again, in step across two copies, a snapshot thaw and a replay, the flag in
//    the hash; spread out it takes clearly less from splash and moves at SPREAD.speed of its pace.
// 4. A crowd battle on Test Mesa (ground/testmaps.ts) with vehicles of every size class, many move
//    orders (queued and not, and stops) and buildings put up and destroyed mid-battle, some right on
//    top of units: two copies, a snapshot thaw and a replay in step for several thousand ticks; no
//    unit stays where it can't stand, none leaves the map or turns NaN.

import { readFileSync, readdirSync } from 'node:fs'
import { UNIT, UNITS } from '../src/apps/games/empires/data.ts'
import { newBrain, think, type Brain } from '../src/apps/games/empires/ai.ts'
import { cleanCmd, cmd, runCmd, type Cmd } from '../src/apps/games/empires/commands.ts'
import { restoreBrain, restoreWorld, snapBrain, snapshotWorld } from '../src/apps/games/empires/snapshot.ts'
import { SITE_DRAW, powerReport } from '../src/apps/games/empires/ground/power.ts'
import { cantJob } from '../src/apps/games/empires/ground/jobs.ts'
import { STEP, cantBuild, damage, newWorld, siteRefund, spawn, speedOf, stateHash, tick, type Seat, type Unit, type World } from '../src/apps/games/empires/sim.ts'
import { squadReach } from '../src/apps/games/empires/ground/squad.ts'
import { SPREAD } from '../src/apps/games/empires/data.ts'
import { anchorAt, footprintOpen, stands, standsAt } from '../src/apps/games/empires/ground/nav.ts'
import { MESA } from '../src/apps/games/empires/ground/testmaps.ts'
import { CARRY, CLUSTERS_MAX, CLUSTERS_MIN, CREW_RATE, FIELD_KYBER, REACH, crystalAt, fieldLeft, footDist, groundMapDef, groundPlacement, raiseBuilding } from '../src/apps/games/empires/ground/world.ts'
import { TILE } from '../src/apps/games/empires/ground/types.ts'
import { GROUND_VS, GROUND_WEAPONS } from '../src/apps/games/empires/data/kit.ts'
import { armourOf } from '../src/apps/games/empires/ground/combat.ts'
import { TEST_WALKER, TIER1, TIER2, TIER3, registerWalkerTest, registerWeaponTest, spawnWeaponTest, testWeaponId } from '../src/apps/games/empires/ground/testWeapons.ts'

const seconds = Number(process.argv[2] ?? 150)
let failed = false
const check = (what: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}${detail ? ` (${detail})` : ''}`)
  if (!ok) failed = true
}

// The checks' own test units (a vehicle of each size class, a small building).
import { TIER1 as TIER1_PAIRS, TIER2_TEST } from './ground-test-units.ts'

// --- 1. Sources -------------------------------------------------------------------------------------

{
  const dir = new URL('../src/apps/games/empires/ground/', import.meta.url)
  const sim = ['world.ts', 'nav.ts', 'fog.ts', 'think.ts', 'power.ts', 'jobs.ts']
  const bad: string[] = []
  const banned = /Math\.(random|sin|cos|tan|atan2?|hypot|exp|pow|log)\b|\bDate\b|performance\.|\bdocument\b|\bwindow\b|localStorage|requestAnimationFrame|\*\*/
  for (const f of readdirSync(dir).filter((f) => sim.includes(f)))
    readFileSync(new URL(f, dir), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        // Code only: comment lines and trailing comments left out.
        const code = /^\s*(\/\/|\/\*|\*)/.test(line) ? '' : line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '')
        if (banned.test(code)) bad.push(`${f}:${i + 1}: ${line.trim()}`)
      })
  check('the ground code uses no Math.random, Date, clock, DOM or engine-dependent maths', !bad.length, bad.slice(0, 3).join(' | '))
}

// --- Helpers ----------------------------------------------------------------------------------------

const dustfall = groundMapDef('dustfall-ridge')!
const mesa = groundMapDef('test-mesa')!
const ashwater = groundMapDef('ashwater-crossing')!
const R = { engineer: 'r-g-engineer', center: 'r-g-center', supply: 'r-g-supply', generator: 'r-g-generator', research: 'r-g-research', barracks: 'r-g-barracks', vfactory: 'r-g-vfactory' }
const S = { engineer: 's-g-engineer', center: 's-g-center', supply: 's-g-supply' }
const D = { engineer: 'd-g-engineer', center: 'd-g-center', supply: 'd-g-supply' }

/** Every position on the map (a tile's middle), nearest `near` first, where `type` placed by `owner`
 * gets `why` (null: accepted). */
function find(w: World, owner: number, type: string, why: string | null, near: { x: number; y: number }) {
  const g = w.ground!.map.grid
  const all: { x: number; y: number; d: number }[] = []
  for (let r = 0; r < g.rows; r++)
    for (let c = 0; c < g.cols; c++) {
      const x = (c + 0.5) * TILE
      const y = (r + 0.5) * TILE
      all.push({ x, y, d: (x - near.x) ** 2 + (y - near.y) ** 2 })
    }
  all.sort((a, b) => a.d - b.d)
  for (const p of all) if (groundPlacement(w, owner, type, p.x, p.y).why === why) return p
  return null
}

const kill = (w: World, u: Unit) => damage(w, u, 1e9, 'turbo', -1, u.x, u.y, (u.owner + 1) % w.players.length)
const seat = (faction: Seat['faction'], team: number, spawn: number): Seat => ({ faction, team, spawn })
const FACTION_LIST = ['republic', 'droid', 'swarm'] as const

// --- 2. Placement rules -------------------------------------------------------------------------------

{
  const w = newWorld(dustfall, [seat('republic', 0, 0), seat('droid', 1, 1)], { seed: 7, credits: 5000 })
  for (let t = 0; t < 3; t++) tick(w)
  const home = w.units.find((u) => u.owner === 0 && u.t.id === R.center)!
  const expect = (rule: string, type: string, why: string) => {
    const at = find(w, 0, type, why, home)
    check(`placement refuses with "${why}" (${rule})`, !!at)
    if (at) check('  ...and checks every tile of the footprint', groundPlacement(w, 0, type, at.x, at.y).tiles.length === UNIT[type].ground!.foot![0] * UNIT[type].ground!.foot![1])
  }
  expect('terrain', R.center, 'Not on buildable ground')
  expect('crystal field', 'test-block', 'A deposit is in the way')
  expect('built on', R.center, 'Something is built there')
  expect('exit blocked', R.center, "It would block a building's exit")
  expect('enemy near, any building', 'test-block', 'Too close to an enemy building (keep 20 tiles away)')
  {
    // No command range: a small building as far from our Command Center as the map allows (and still
    // away from the enemy) may go up.
    const far = find(w, 0, 'test-block', null, { x: home.x < w.w / 2 ? w.w : 0, y: home.y < w.h / 2 ? w.h * 0.5 : w.h * 0.5 })
    const tiles = far ? Math.hypot(far.x - home.x, far.y - home.y) / TILE : 0
    check('a building may go up far from our Command Centers (no command range)', !!far && tiles > 40, `${tiles.toFixed(0)} tiles out`)
  }
  expect('enemy near', R.center, 'Too close to an enemy building (keep 20 tiles away)')
  expect('own exit', R.center, 'No room for its exit: the row in front of its door must stay clear')
  {
    // Exits only where units come out: a Command Center and a factory have one, a power generator,
    // a research station and a supply building none, and nothing keeps the row in front of theirs clear.
    const exit = (type: string) => groundPlacement(w, 0, type, home.x, home.y + 14 * TILE).door.length
    check('a building that trains has an exit (the row in front of its door), one that trains nothing has none',
      exit(R.center) === 6 && exit(R.vfactory) === 5 && exit(R.barracks) === 4 && exit(R.generator) === 0 && exit(R.research) === 0 && exit(R.supply) === 0,
      [R.center, R.vfactory, R.barracks, R.generator, R.research, R.supply].map((t) => `${t} ${exit(t)}`).join(', '))
    const at = find(w, 0, R.supply, null, { x: home.x - 14 * TILE, y: home.y + 10 * TILE })!
    const pl = groundPlacement(w, 0, R.supply, at.x, at.y)
    const depot = raiseBuilding(w, UNIT[R.supply], 0, pl.tc, pl.tr)
    tick(w)
    // A generator right against the depot's south side, where a door row would be.
    const why = groundPlacement(w, 0, R.generator, (pl.tc + 1) * TILE, (pl.tr + 4) * TILE).why
    check('a building may stand right in front of one that trains nothing', why !== "It would block a building's exit", String(why))
    kill(w, depot)
    tick(w)
  }
  {
    const p = groundPlacement(w, 0, R.center, home.x + 3 * TILE, home.y)
    const red = p.tiles.filter((t) => !t.ok).length
    check('a ghost half over a building shows those tiles red and the rest green', red > 0 && red < p.tiles.length, `${red} of ${p.tiles.length} red`)
  }
  {
    // Uneven ground: one tile of a good spot raised a level (the map is shared, so it goes back).
    const g = w.ground!.map.grid
    const at = find(w, 0, R.center, null, home)!
    const p = groundPlacement(w, 0, R.center, at.x, at.y)
    const i = p.tr * g.cols + p.tc
    const was = g.height[i]
    g.height[i] = (was + 1) % 3
    const why = groundPlacement(w, 0, R.center, at.x, at.y).why
    g.height[i] = was
    check('placement refuses with "The ground must be level" (one tile raised)', why === 'The ground must be level', String(why))
  }
  {
    // Enemy units we see on it.
    const at = find(w, 0, R.center, null, home)!
    const foe = spawn(w, 'd-g-engineer', 1, at.x, at.y, 0)
    const eye = spawn(w, R.engineer, 0, at.x + TILE * 4, at.y, 0)
    for (let t = 0; t < 8; t++) tick(w)
    const why = groundPlacement(w, 0, R.center, foe.x, foe.y).why
    check('placement refuses with "Enemy units are in the way" (one we see)', why === 'Enemy units are in the way', String(why))
    const credits = w.players[0].credits
    const r = runCmd(w, 0, cmd('place', [eye.id], R.center, foe.x, foe.y, false, NaN))
    check('an order to place there is refused with the same reason and costs nothing', r === why && w.players[0].credits === credits, String(r))
    kill(w, foe)
    kill(w, eye)
    tick(w)
  }
  {
    const at = find(w, 0, R.center, null, home)!
    w.players[0].credits = 100
    const why = groundPlacement(w, 0, R.center, at.x, at.y).why
    w.players[0].credits = 5000
    check('placement refuses with "Not enough kyber"', why === 'Not enough kyber', String(why))
    check('and accepts a good spot with enough credits', groundPlacement(w, 0, R.center, at.x, at.y).why === null)
  }
  {
    // Placement goes only by what the team knows: a building hidden in the fog doesn't refuse it.
    const at = find(w, 1, 'd-g-center', null, { x: w.w / 2, y: w.h / 2 })!
    const p = groundPlacement(w, 1, 'd-g-center', at.x, at.y)
    const hidden = raiseBuilding(w, UNIT['d-g-center'], 1, p.tc, p.tr)
    for (let t = 0; t < 8; t++) tick(w)
    const mine = groundPlacement(w, 0, R.center, at.x, at.y).why
    check('a building hidden in the fog does not refuse a placement (the site is lost later)', !hidden.seen[0] && mine !== 'Something is built there', String(mine))
  }
}

// --- Lockstep -------------------------------------------------------------------------------------

/** One input to a battle: an order from a seat (as sent on the wire), a building's hull set (as the
 * dev cheats do), a building put up, a unit destroyed, or a crystal field's kyber set (a cheat too). */
type Input =
  | { t: number; k: 'cmd'; owner: number; json: string }
  | { t: number; k: 'hull'; id: number; share: number }
  | { t: number; k: 'add'; unit: string; owner: number; c: number; r: number }
  | { t: number; k: 'kill'; id: number }
  | { t: number; k: 'kyber'; f: number; each: number }
  | { t: number; k: 'spawn'; unit: string; owner: number; x: number; y: number }
  | { t: number; k: 'credits'; owner: number; value: number }
  | { t: number; k: 'rp'; owner: number; value: number }

function apply(w: World, x: Input): unknown {
  if (x.k === 'cmd') {
    const c = cleanCmd(JSON.parse(x.json), w)
    return c ? runCmd(w, x.owner, c) : 'junk'
  }
  if (x.k === 'add') return raiseBuilding(w, UNIT[x.unit], x.owner, x.c, x.r)
  if (x.k === 'spawn') return spawn(w, x.unit, x.owner, x.x, x.y, 0)
  if (x.k === 'credits') return void (w.players[x.owner].credits = x.value)
  if (x.k === 'rp') return void (w.players[x.owner].rp = x.value)
  if (x.k === 'kyber') {
    for (const c of w.crystals!) if (c.f === x.f && c.left > 0) c.left = Math.min(c.left, x.each)
    return
  }
  const u = w.byId.get(x.id)
  if (!u || u.dead) return
  if (x.k === 'hull') u.hull = u.hullMax * x.share
  else kill(w, u)
}

type Copy = { w: World; brains: Brain[] }
const step = (c: Copy) => {
  for (const b of c.brains) think(c.w, b, STEP)
  tick(c.w)
}
const thaw = (c: Copy): Copy => ({ w: restoreWorld(snapshotWorld(c.w))!, brains: c.brains.map((b) => restoreBrain(JSON.parse(JSON.stringify(snapBrain(b))))) })

/**
 * Runs a battle on copies `a` and `b` for `ticks`, the inputs from `script` (which reads copy a)
 * given to both at the same tick, with a third copy thawed from a snapshot of a at `freeze` and
 * stepped alongside; then a fourth rebuilt from `make` and the logged inputs alone. Says where any
 * of them drifted.
 */
function lockstep(label: string, make: () => Copy, ticks: number, script: (a: Copy, t: number, say: (x: Input) => unknown) => void, freeze = Math.floor(ticks / 2)) {
  const a = make()
  const b = make()
  let c: Copy | null = null
  const inputs: Input[] = []
  const hashes: number[] = []
  let drift = ''
  const started = performance.now()
  for (let t = 0; t < ticks; t++) {
    script(a, t, (x) => {
      inputs.push(x)
      const r = apply(a.w, x)
      apply(b.w, x)
      if (c) apply(c.w, x)
      return r
    })
    for (const x of c ? [a, b, c] : [a, b]) step(x)
    if (t + 1 === freeze) c = thaw(a)
    if ((t + 1) % 30 === 0) {
      const h = stateHash(a.w)
      hashes.push(h)
      if (!drift && stateHash(b.w) !== h) drift = `two fresh copies apart by tick ${t + 1}`
      if (!drift && c && stateHash(c.w) !== h) drift = `the copy thawed at tick ${freeze} apart by tick ${t + 1}`
    }
    for (const x of c ? [b, c] : [b]) x.w.events.length = 0
  }
  const ms = performance.now() - started
  check(`${label}: two copies and one thawed from a snapshot stay in step for ${ticks} ticks`, !drift, drift || `final hash ${hashes[hashes.length - 1].toString(16)}, ${(ms / ticks / 2.5).toFixed(3)} ms a tick`)
  const r = make()
  let q = 0
  let first = -1
  for (let t = 0; t < ticks; t++) {
    while (q < inputs.length && inputs[q].t === t) apply(r.w, inputs[q++])
    step(r)
    r.w.events.length = 0
    if ((t + 1) % 30 === 0 && first < 0 && stateHash(r.w) !== hashes[(t + 1) / 30 - 1]) first = (t + 1) / 30
  }
  check(`${label}: a copy rebuilt from the ${inputs.length} logged inputs matches every second`, first < 0, first < 0 ? '' : `differs at second ${first}`)
  return a
}

// --- 3. The building battle -----------------------------------------------------------------------

{
  const make = (): Copy => ({ w: newWorld(dustfall, [seat('republic', 0, 0), seat('swarm', 1, 1)], { seed: 99, credits: 6000 }), brains: [{ ...newBrain(1, 'medium'), peaceful: true }] })
  const ticks = Math.round(seconds / STEP)
  const got: Record<string, [boolean, string]> = {}
  const pass = (k: string, ok: boolean, detail = '') => (got[k] ??= [ok, detail])
  let home: Unit | undefined
  let first: Unit | undefined
  let siteA = 0
  let siteB = 0
  let siteC = 0
  let parked = 0
  let parkAt = { x: 0, y: 0 }
  let onSite = false
  let crewSent = false
  let damagedAt = -1
  let repairedAt = -1
  let builtA = -1
  let startedA = -1
  let cRefund = 0
  let rallyAt: { x: number; y: number } | null = null
  let rallyUnit = 0
  let rallyOff = -1
  let removedFoot: { c: number; r: number } | null = null
  const rates = new Map<number, number>()
  const events: Record<string, number> = {}
  const final = lockstep('building battle', make, ticks, ({ w }, t, say) => {
    home ??= w.units.find((u) => u.owner === 0 && u.t.id === R.center)!
    first ??= w.units.find((u) => u.owner === 0 && u.t.id === R.engineer)!
    // What happened last tick.
    for (const e of w.events) {
      events[e.k] = (events[e.k] ?? 0) + 1
      if (e.k === 'built' && e.unit === R.center && builtA < 0 && w.byId.get(siteA) && !w.byId.get(siteA)!.site) builtA = t
      if (e.k === 'trained' && e.from === home.id && rallyAt && !rallyUnit) rallyUnit = w.units.filter((u) => u.owner === 0 && u.t.id === e.unit).reduce((a, u) => (u.id > a ? u.id : a), 0)
    }
    w.events.length = 0
    const order = (c: Cmd) => say({ t, k: 'cmd', owner: 0, json: JSON.stringify(c) })
    const credits = () => w.players[0].credits
    const engs = () => w.units.filter((u) => !u.dead && u.owner === 0 && u.t.id === R.engineer)
    const before = credits()
    // 1 s: engineers up to the cap (the Command Center supports 5: one is out, four more fit);
    // 1.5 s: the fourth cancelled.
    if (t === 30) {
      for (let i = 0; i < 5; i++) order(cmd('build', R.engineer, false, home.id))
      pass('engineers queue up to the unit cap, the next refused for supply', home.yq!.length === 4 && before - credits() === 4 * UNIT[R.engineer].cost && /^Needs more supply: build a Supply Depot/.test(cantBuild(w, 0, R.engineer, false, home.id) ?? ''), `queue ${home.yq!.length}, paid ${before - credits()}, ${cantBuild(w, 0, R.engineer, false, home.id)}`)
    }
    if (t === 45) {
      order(cmd('cancel', 3, home.id))
      pass('a cancelled queue item is refunded in full', home.yq!.length === 3 && credits() - before === UNIT[R.engineer].cost)
    }
    // Just after: a Supply Depot beside the Command Center, after the first site (so the rally test
    // later has room to train).
    if (t === 61) {
      const at = find(w, 0, R.supply, null, { x: home.x - 8 * TILE, y: home.y })
      if (at) order(cmd('place', [first.id], R.supply, at.x, at.y, true, NaN))
    }
    // 2 s: a Command Center on the nearest good spot, built by the first engineer.
    if (t === 60) {
      const at = find(w, 0, R.center, null, home)!
      const id = w.nextId
      order(cmd('place', [first.id], R.center, at.x, at.y, false, NaN))
      siteA = w.byId.get(id)?.site ? id : 0
      pass('placing pays for the site', siteA > 0 && before - credits() === 1200)
    }
    // 3 s: another queued after it, then called off before work starts.
    if (t === 90) {
      const at = find(w, 0, R.center, null, home)!
      const id = w.nextId
      order(cmd('place', [first.id], R.center, at.x, at.y, true, NaN))
      siteB = w.byId.get(id)?.site ? id : 0
    }
    if (t === 120 && siteB) {
      order(cmd('cancelSite', siteB))
      pass('a site called off before work starts is refunded in full', credits() - before === 1200 && !w.byId.get(siteB), `${credits() - before}`)
    }
    // As engineers roll out: the first two join the first site's crew.
    const rolled = engs().filter((u) => u.id !== first!.id)
    if (siteA && rolled.length >= 2 && !crewSent) {
      order(cmd('construct', rolled.slice(0, 2).map((u) => u.id), siteA, false))
      crewSent = true
    }
    // The third parks on a good spot, and another places a Command Center right on it.
    if (rolled.length >= 3 && !parked && t > 60) {
      parkAt = find(w, 0, R.center, null, { x: home.x, y: home.y + 20 * TILE })!
      parked = rolled[2].id
      order(cmd('move', [parked], parkAt.x, parkAt.y, false, false))
    }
    const pk = w.byId.get(parked)
    if (pk && !siteC && pk.order.k === 'idle' && Math.hypot(pk.x - parkAt.x, pk.y - parkAt.y) < TILE) {
      const free = rolled.find((u) => u.id !== parked && u.order.k === 'idle')
      if (free) {
        const id = w.nextId
        order(cmd('place', [free.id], R.center, pk.x, pk.y, false, NaN))
        siteC = w.byId.get(id)?.site ? id : 0
      }
    }
    // Site C some way built: called off, refunded as a space site is (siteRefund).
    const sc = w.byId.get(siteC)
    if (sc?.site?.started && sc.building <= sc.t.build * 0.7 && !cRefund) {
      cRefund = siteRefund(sc)
      const was = credits()
      order(cmd('cancelSite', siteC))
      pass('a site called off some way in refunds as a space site does', Math.abs(credits() - was - cRefund) < 1e-6 && !w.byId.get(siteC), `${cRefund} credits back`)
    }
    // The first site built: damaged (as the dev cheat panel would) and repaired by two engineers.
    const sa = w.byId.get(siteA)
    if (sa && !sa.site && damagedAt < 0 && builtA >= 0 && t > builtA + 30) {
      say({ t, k: 'hull', id: siteA, share: 0.4 })
      damagedAt = t
    }
    // (Not the first engineer: it has the Supply Depot to build.)
    if (damagedAt >= 0 && t === damagedAt + 15) order(cmd('construct', engs().filter((u) => u.id !== first!.id).slice(0, 2).map((u) => u.id), siteA, false))
    // 80 s, the queue long empty: a rally point, then one more engineer, which drives there.
    if (t === 2400) {
      rallyAt = find(w, 0, R.center, null, { x: home.x + 8 * TILE, y: home.y + 6 * TILE })!
      order(cmd('rally', rallyAt.x, rallyAt.y, home.id))
      order(cmd('build', R.engineer, false, home.id))
    }
    // Late on, the first Command Center built is destroyed: its stamp comes off the grid.
    if (t === ticks - 90 && sa && !sa.dead) {
      removedFoot = { c: sa.foot!.c, r: sa.foot!.r }
      say({ t, k: 'kill', id: siteA })
    }
    // Junk an honest server cleans away.
    if (t % 211 === 0) say({ t, k: 'cmd', owner: 0, json: JSON.stringify({ f: 'place', a: [[1], 'no-such-type', 1, 1] }) })
    const ru = w.byId.get(rallyUnit)
    if (ru && rallyAt && rallyOff < 0 && ru.order.k === 'idle') rallyOff = Math.hypot(ru.x - rallyAt.x, ru.y - rallyAt.y)
    // Site A: how much it grew last tick for the engineers at it.
    const sA = w.byId.get(siteA)
    if (sA?.site?.started) {
      if (startedA < 0) startedA = t
      const crew = w.units.filter((u) => !u.dead && u.gm?.busy === siteA).length
      const last = rates.get(-1)
      if (crew && last !== undefined && last !== sA.building) rates.set(crew, last - sA.building)
      rates.set(-1, sA.building)
    }
    // Whole as the sim counts it (within half a point: engineers stop there).
    if (sA && damagedAt >= 0 && repairedAt < 0 && sA.hull >= sA.hullMax - 0.5) repairedAt = t
    const sB = w.byId.get(siteB)
    if (sB?.site && !sB.site.started) pass('an unstarted site has no stamp, sees nothing and is hidden from the enemy', !sB.foot!.on && !sB.eye && !sB.seen[1])
    const sC = w.byId.get(siteC)
    if (sC?.site && !sC.site.started && pk && footDist(sC, pk.x, pk.y) < pk.t.ground!.radius) onSite = true
    if (onSite && sC?.site?.started && pk && sC.building < sC.t.build * 0.9) pass('a unit standing on a site is pushed off when work starts', footDist(sC, pk.x, pk.y) >= pk.t.ground!.radius - 1, `${(footDist(sC, pk.x, pk.y) / TILE).toFixed(2)} tiles off`)
  })
  const w = final.w
  for (const [k, [ok, detail]] of Object.entries(got)) check(`building battle: ${k}`, ok, detail)
  const crews = [...rates.keys()].filter((k) => k > 0).sort()
  const rateOk = crews.length >= 2 && crews.every((n) => Math.abs(rates.get(n)! - STEP * CREW_RATE[Math.min(n, 4)]) < 1e-9)
  check('building battle: a site gets built, as fast as its crew (1, 1.7, 2.2, 2.5 times)', builtA > 0 && rateOk, `${((builtA - startedA) * STEP).toFixed(1)} s; crews seen: ${crews.join(', ')}`)
  check('building battle: a damaged building is repaired to a whole hull', damagedAt > 0 && repairedAt > damagedAt, `${((repairedAt - damagedAt) * STEP).toFixed(1)} s from 40%`)
  check('building battle: a site was called off some way in', cRefund > 0)
  check('building battle: a unit stood on a site before work started', onSite)
  check('building battle: a unit trained after a rally point is set drives to it', rallyOff >= 0 && rallyOff < TILE, rallyOff >= 0 ? `arrived ${(rallyOff / TILE).toFixed(2)} tiles from it` : 'never arrived')
  check('building battle: a destroyed building frees its stamp', !!removedFoot && footprintOpen(w.ground!.nav, removedFoot.c, removedFoot.r, 6, 6))
  const supply = 5 * w.units.filter((u) => u.owner === 0 && u.t.id === R.center && !u.site).length + 10 * w.units.filter((u) => u.owner === 0 && u.t.id === R.supply && !u.site).length
  check('building battle: no income trickles in, and the unit cap is the buildings\' supply', w.players[0].income === 0 && w.players[0].popCap === supply, `income ${w.players[0].income}/s, cap ${w.players[0].popCap} of ${supply}`)
  const ai = w.units.filter((u) => u.owner === 1)
  const aiCenters = ai.filter((u) => u.t.id === S.center && !u.site).length
  const aiEngs = ai.filter((u) => u.t.id === S.engineer).length
  check('building battle: the AI trained engineers and expanded to a second Command Center', aiCenters >= 2 && aiEngs >= 3, `${aiCenters} Hive Nexuses, ${aiEngs} Shaper drones`)
  check('building battle: the AI built nothing but engineers, Command Centers, supply, power, research, factories and their units, and Scouts', ai.every((u) => [S.center, S.engineer, S.supply, 's-g-generator', 's-g-research', 's-g-scout', 's-g-brood', 's-g-nest', ...TIER1_PAIRS.swarm].includes(u.t.id)))
  check('building battle: each side knows where the other started', !!w.known?.[0].some((k) => k.owner === 1) && !!w.known?.[1].some((k) => k.owner === 0))
  console.log(`  events: ${Object.entries(events).map(([k, n]) => `${n} ${k}`).join(', ')}`)
}

// --- 3b. The economy battle ------------------------------------------------------------------------------

{
  const make = (): Copy => ({ w: newWorld(ashwater, [seat('republic', 0, 0), seat('droid', 1, 1)], { seed: 31, credits: 1600 }), brains: [newBrain(1, 'medium')] })
  const ticks = Math.round(Math.max(seconds, 180) / STEP)
  const got: Record<string, [boolean, string]> = {}
  const pass = (k: string, ok: boolean, detail = '') => (got[k] ??= [ok, detail])
  let home: Unit | undefined
  let field = -1
  let sentFour = false
  let supplyAt = -1
  let supplier = 0
  let cappedAt = -1
  let dryAt = -1
  let dryField = -1
  let cheatGap = 0
  let startOk = ''
  const emptiedAt = new Map<number, number>()
  let freed = 0
  let stillStamped = 0
  let nextCluster = 0
  const lastCl = new Map<number, number>()
  let moved = -1
  let lostKyber = 0
  // Kyber in the hold of an engineer that was destroyed goes with it (the AI's Scouts raid).
  const holds = new Map<number, Unit>()
  let sunk = 0
  let overCarry = 0
  let mostMiners = 0
  let drops = 0
  let aiOverCap = 0
  let aiCapped = 0
  let aiCapSupply = 0
  let aiGatherMax = 0
  const events: Record<string, number> = {}
  const final = lockstep('economy battle', make, ticks, ({ w }, t, say) => {
    home ??= w.units.find((u) => u.owner === 0 && u.t.id === R.center)!
    const fields = w.ground!.fields
    const nav = w.ground!.nav
    const tileOf = (c: { c: number; r: number }) => c.r * nav.cols + c.c
    // At the start: every field's clusters hold FIELD_KYBER between them, CLUSTERS_MIN to CLUSTERS_MAX of
    // them, and (once the first stamps are down) each blocks its tile.
    if (t === 1) {
      const bad = fields.map((_, f) => {
        const cs = w.crystals!.filter((c) => c.f === f)
        return cs.length < CLUSTERS_MIN || cs.length > CLUSTERS_MAX || cs.reduce((n, c) => n + c.left, 0) !== FIELD_KYBER ? `field ${f}: ${cs.length} clusters, ${cs.reduce((n, c) => n + c.left, 0)}` : cs.some((c) => !c.on || nav.bld[tileOf(c)] === 0 || stands(nav, 1, tileOf(c))) ? `field ${f}: a cluster not on the grid` : ''
      }).filter(Boolean)
      startOk = bad.join('; ')
      pass(`every field's clusters hold ${FIELD_KYBER} kyber and block their tiles`, !bad.length, bad.length ? startOk : `${w.crystals!.length} clusters on ${fields.length} fields: ${fields.map((_, f) => w.crystals!.filter((c) => c.f === f).length).join(', ')}`)
    }
    if (field < 0) field = fields.map((f, i) => ({ i, d: (f.x - home!.x) ** 2 + (f.y - home!.y) ** 2 })).sort((a, b) => a.d - b.d)[0].i
    for (const e of w.events) {
      events[e.k] = (events[e.k] ?? 0) + 1
      if (e.k === 'dry' && e.field === dryField && dryAt < 0) dryAt = t
    }
    w.events.length = 0
    const order = (c: Cmd) => say({ t, k: 'cmd', owner: 0, json: JSON.stringify(c) })
    const engs = () => w.units.filter((u) => !u.dead && u.owner === 0 && u.t.id === R.engineer)
    const p = w.players[0]
    // 0.5 s: engineers up to the cap; the next one is refused for supply.
    if (t === 15) {
      for (let i = 0; i < 5; i++) order(cmd('build', R.engineer, false, home.id))
      pass('training stops at the unit cap with the supply reason', home.yq!.length === 4 && /^Needs more supply/.test(cantBuild(w, 0, R.engineer, false, home.id) ?? ''), `queue ${home.yq!.length}: ${cantBuild(w, 0, R.engineer, false, home.id)}`)
    }
    // Once four are out: all four gather the field by the base (as a right-click there orders it).
    const es = engs()
    // Where to right-click to gather a field: one of its clusters with kyber left.
    const clusterIn = (f: number) => {
      const c = w.crystals!.find((x) => x.f === f && x.left > 0)
      return c ? crystalAt(c) : fields[f]
    }
    if (!sentFour && es.length >= 4) {
      const f = clusterIn(field)
      order(cmd('gather', es.slice(0, 4).map((u) => u.id), f.x, f.y, false))
      sentFour = true
    }
    // With 100 kyber in hand, one of the gatherers (mid-run: it leaves its field for this) puts up a
    // Supply Depot; idle ones go back to gathering.
    if (sentFour && supplyAt < 0 && p.credits >= 100 && es[0].gm?.spot) {
      const builder = es[0]
      const at = find(w, 0, R.supply, null, { x: home.x - 9 * TILE, y: home.y - 2 * TILE })
      if (at && builder) {
        order(cmd('place', [builder.id], R.supply, at.x, at.y, false, NaN))
        supplyAt = t
        supplier = builder.id
      }
    }
    // Two seconds after the depot is up, its builder is back at its field.
    if (p.popCap >= 15 && cappedAt < 0) cappedAt = t
    if (cappedAt >= 0 && t === cappedAt + 60) pass('the engineer that built it goes back to gathering', w.byId.get(supplier)?.order.k === 'gather', w.byId.get(supplier)?.order.k)
    const idle = es.filter((u) => u.order.k === 'idle' && !u.queue.length)
    if (sentFour && idle.length && t % 30 === 0 && dryAt < 0) {
      const f = clusterIn(field)
      order(cmd('gather', idle.map((u) => u.id), f.x, f.y, false))
    }
    // With supply built, training carries on past the old cap.
    if (p.popCap >= 15 && !got['a Supply Depot (built by an engineer taken off gathering) raises the cap and training goes on'] && !home.yq!.length) {
      order(cmd('build', R.engineer, false, home.id))
      order(cmd('build', R.engineer, false, home.id))
      pass('a Supply Depot (built by an engineer taken off gathering) raises the cap and training goes on', home.yq!.length === 2 && p.popCap === 15, `cap ${p.popCap}, queue ${home.yq!.length}`)
    }
    // 60 s: the base's field's clusters nearly emptied (a cheat: 50 left in each), so they run out one
    // by one with its engineers on them.
    if (t === 1800) {
      dryField = field
      const before = fieldLeft(w, field)
      say({ t, k: 'kyber', f: field, each: 50 })
      cheatGap = before - fieldLeft(w, field)
    }
    // A mined-out cluster: off the grid at the next flush (two ticks on, the tile is open again).
    w.crystals!.forEach((c, i) => {
      if (c.left > 0) return
      const at = emptiedAt.get(i)
      if (at === undefined) emptiedAt.set(i, t)
      else if (t === at + 2) {
        if (!c.on && nav.bld[tileOf(c)] === 0 && stands(nav, 1, tileOf(c))) freed++
        else stillStamped++
      }
    })
    // Its engineers go to the next cluster in the same field.
    for (const u of engs()) {
      const was = lastCl.get(u.id)
      const now = u.gm?.cl
      if (was !== undefined && now !== undefined && now !== was && w.crystals![was].left === 0 && w.crystals![was].f === dryField && w.crystals![now].f === dryField) nextCluster++
      if (now !== undefined) lastCl.set(u.id, now)
    }
    if (dryAt >= 0 && moved < 0 && t > dryAt + 600) {
      const on = engs().filter((u) => u.order.k === 'gather')
      moved = on.length && on.every((u) => u.order.k === 'gather' && u.order.f !== dryField && fieldLeft(w, u.order.f) > 0) ? on.length : 0
    }
    // Kyber is neither made nor lost: what left the fields was dropped off or is being carried.
    const inFields = w.crystals!.reduce((a, c) => a + c.left, 0)
    const carried = w.units.reduce((a, u) => a + (u.dead ? 0 : (u.carry ?? 0)), 0)
    for (const [id, u] of holds) if (u.dead) (sunk += u.carry ?? 0), holds.delete(id)
    for (const u of w.units) if (!u.dead && u.carry) holds.set(u.id, u)
    const dropped = w.players.reduce((a, q) => a + q.earnedBy.mines, 0)
    lostKyber = Math.max(lostKyber, Math.abs(FIELD_KYBER * fields.length - cheatGap - inFields - carried - dropped - sunk))
    for (const u of w.units) if ((u.carry ?? 0) > CARRY + 1e-9) overCarry++
    const miners = new Map<number, number>()
    for (const u of w.units) if (!u.dead && u.gm?.mine && u.order.k === 'gather') miners.set(u.order.f, (miners.get(u.order.f) ?? 0) + 1)
    mostMiners = Math.max(mostMiners, ...miners.values(), 0)
    drops = p.earnedBy.mines
    // The AI on seat 1.
    const q = w.players[1]
    const aiQueued = w.units.filter((u) => !u.dead && u.owner === 1 && u.yq).reduce((n, u) => n + u.yq!.length, 0)
    if (q.pop + aiQueued > q.popCap) aiOverCap++
    if (q.pop >= q.popCap) {
      aiCapped++
      if (w.units.some((u) => !u.dead && u.owner === 1 && u.t.id === D.supply && u.site)) aiCapSupply++
    }
    aiGatherMax = Math.max(aiGatherMax, w.units.filter((u) => !u.dead && u.owner === 1 && u.order.k === 'gather').length)
  })
  const w = final.w
  for (const [k, [ok, detail]] of Object.entries(got)) check(`economy battle: ${k}`, ok, detail)
  check('economy battle: four engineers gathered and dropped kyber off at the Command Center', sentFour && drops > 0, `${Math.round(drops)} kyber dropped off by seat 0`)
  check('economy battle: kyber is never made or lost (fields = dropped off + carried + lost with destroyed engineers)', lostKyber < 1e-6, `largest gap ${lostKyber}`)
  check('economy battle: no engineer carries more than a load', !overCarry, `${CARRY} a load`)
  check('economy battle: several engineers mine one field at once without jamming', mostMiners >= 3, `${mostMiners} at once`)
  check('economy battle: a field runs dry and its engineers move on to the nearest other field', dryAt > 0 && moved > 0, dryAt > 0 ? `dry at ${(dryAt * STEP).toFixed(0)} s, ${moved} moved on` : 'never ran dry')
  check('economy battle: the dry field is empty', fieldLeft(w, dryField) === 0 && w.crystals!.filter((c) => c.f === dryField).every((c) => !c.on))
  check('economy battle: a mined-out cluster\'s stamp comes off the grid at the next flush', freed >= 3 && !stillStamped, `${freed} freed, ${stillStamped} still stamped`)
  check('economy battle: engineers move on to the next cluster in the same field', nextCluster > 0, `${nextCluster} moves`)
  check('economy battle: the AI kept its engineers gathering', w.players[1].earnedBy.mines > 0 && aiGatherMax >= 4, `${Math.round(w.players[1].earnedBy.mines)} kyber gathered, up to ${aiGatherMax} gathering at once`)
  check('economy battle: the AI builds supply before its cap and never trains past it', !aiOverCap && w.units.some((u) => !u.dead && u.owner === 1 && u.t.id === D.supply) && aiCapped <= aiCapSupply + 30 * 10, `cap ${w.players[1].popCap}, at the cap ${(aiCapped * STEP).toFixed(1)} s (${(aiCapSupply * STEP).toFixed(1)} s of it with supply going up)`)
  console.log(`  events: ${Object.entries(events).map(([k, n]) => `${n} ${k}`).join(', ')}; kyber left by field ${w.ground!.fields.map((_, f) => Math.round(fieldLeft(w, f))).join(', ')}`)
}

// --- 3d. The power battle -------------------------------------------------------------------------------

{
  const make = (): Copy => ({ w: newWorld(ashwater, [seat('republic', 0, 0), seat('droid', 1, 1)], { seed: 57, credits: 3000 }), brains: [newBrain(1, 'medium')] })
  const ticks = Math.round(Math.max(seconds, 180) / STEP)
  const got: Record<string, [boolean, string]> = {}
  const pass = (k: string, ok: boolean, detail = '') => (got[k] ??= [ok, detail])
  const bad: Record<string, number> = {}
  const miss = (k: string) => (bad[k] = (bad[k] ?? 0) + 1)
  let home: Unit | undefined
  let first: Unit | undefined
  let prev: { rp: number; burnt: number; credits: number; q?: { item: object; left: number }; site?: { id: number; building: number; crew: number } } | null = null
  let short = 0
  let siteShort = 0
  let trainShort = 0
  let burns = 0
  let siteId = 0
  let stopped = 0
  let restored = 0
  const ccPower = UNIT[R.center].ground!.power!
  const genPower = UNIT[R.generator].ground!.power!
  const burn = UNIT[R.generator].ground!.burn!
  const rate = UNIT[R.research].ground!.research!
  lockstep('power battle', make, ticks, ({ w }, t, say) => {
    home ??= w.units.find((u) => u.owner === 0 && u.t.id === R.center)!
    first ??= w.units.find((u) => u.owner === 0 && u.t.id === R.engineer)!
    w.events.length = 0
    const p = w.players[0]
    const pw = p.power
    const order = (c: Cmd) => say({ t, k: 'cmd', owner: 0, json: JSON.stringify(c) })
    if (t === 1) pass('a new base runs on its Command Center\'s power alone', !!pw && pw.made === ccPower && pw.used === 0 && pw.ratio === 1, JSON.stringify(pw))
    // Last tick, as the power said: training, research, a site and the generators' burn.
    if (prev && pw) {
      const labs = w.units.filter((u) => !u.dead && u.owner === 0 && u.t.id === R.research && !u.site).length
      if (Math.abs(p.rp! - prev.rp - labs * rate * pw.ratio * STEP) > 1e-9) miss('research')
      const q = home.yq?.[0]
      if (q && prev.q && prev.q.item === q && Math.abs(prev.q.left - q.left - STEP * pw.ratio) > 1e-9 && q.left > 0) miss('training')
      if (q && prev.q && prev.q.item === q && pw.ratio < 1) trainShort++
      const gens = w.units.filter((u) => !u.dead && u.owner === 0 && u.t.id === R.generator && !u.site).length
      const paid = prev.credits >= burn * STEP
      if (gens && paid) {
        if (Math.abs((p.burnt ?? 0) - prev.burnt - gens * burn * STEP) > 1e-9) miss('burn')
        else burns++
      }
      if (gens && prev.credits < burn * STEP) {
        if (pw.made === ccPower) stopped++
        else miss('stop')
      }
      if (gens && paid && pw.made === ccPower + gens * genPower) restored++
      const site = prev.site && w.byId.get(prev.site.id)
      if (site?.site?.started && prev.site!.crew > 0) {
        const want = Math.min(prev.site!.building, STEP * CREW_RATE[Math.min(prev.site!.crew, 4)] * pw.ratio)
        if (Math.abs(prev.site!.building - site.building - want) > 1e-9) miss('site')
        else if (pw.ratio < 1) siteShort++
      }
      if (pw.ratio < 1) short++
    }
    // 1/3 s: three engineers queued (the Command Center draws while it trains).
    if (t === 10) for (let i = 0; i < 3; i++) order(cmd('build', R.engineer, false, home.id))
    // 2/3 s: two research stations, finished (as the dev cheats raise them): more draw than it makes.
    if (t === 20)
      for (let k = 0; k < 2; k++) {
        const at = find(w, 0, R.research, null, { x: home.x + (k ? 9 : -9) * TILE, y: home.y })!
        const pl = groundPlacement(w, 0, R.research, at.x, at.y)
        say({ t, k: 'add', unit: R.research, owner: 0, c: pl.tc, r: pl.tr })
      }
    // 13 s: a Supply Depot, built by the first engineer while power is short.
    if (t === 400) {
      const at = find(w, 0, R.supply, null, { x: home.x, y: home.y + 9 * TILE })!
      const id = w.nextId
      order(cmd('place', [first.id], R.supply, at.x, at.y, false, NaN))
      siteId = w.byId.get(id)?.site ? id : 0
    }
    // 30 s: a power generator, finished: enough power again, its kyber burnt every tick.
    if (t === 900) {
      const at = find(w, 0, R.generator, null, { x: home.x, y: home.y - 9 * TILE })!
      const pl = groundPlacement(w, 0, R.generator, at.x, at.y)
      say({ t, k: 'add', unit: R.generator, owner: 0, c: pl.tc, r: pl.tr })
    }
    // 40 s: no kyber left (a cheat): the generator stops; 50 s: kyber back, it runs again.
    if (t === 1200) say({ t, k: 'credits', owner: 0, value: 0 })
    if (t === 1500) say({ t, k: 'credits', owner: 0, value: 2000 })
    const site = w.byId.get(siteId)
    const q = home.yq?.[0]
    prev = {
      rp: p.rp ?? 0, burnt: p.burnt ?? 0, credits: p.credits,
      q: q ? { item: q, left: q.left } : undefined,
      site: site ? { id: site.id, building: site.building, crew: w.units.filter((u) => !u.dead && u.gm?.busy === site.id).length } : undefined,
    }
  })
  for (const [k, [ok, detail]] of Object.entries(got)) check(`power battle: ${k}`, ok, detail)
  check('power battle: short of power, training and research run at made / used of their speed, to the tick', short > 0 && trainShort > 0 && !bad.research && !bad.training, `${short} short ticks, ${trainShort} training; misses ${JSON.stringify(bad)}`)
  check('power battle: a site going up while power is short is slowed by the same share', siteShort > 0 && !bad.site, `${siteShort} ticks`)
  check('power battle: a generator burns its kyber every tick and puts the power right', burns > 0 && restored > 0 && !bad.burn, `${burns} ticks burnt, ${restored} with full power`)
  check('power battle: with no kyber left the generator stops', stopped > 0 && !bad.stop, `${stopped} ticks`)
  console.log(`  power: research ${UNIT[R.research].ground!.draw} draw, ${rate}/s; generator +${genPower} for ${burn} kyber/s; Command Center +${ccPower}, ${UNIT[R.center].ground!.draw} while training; a site ${SITE_DRAW} while being built`)
}
{
  // The AI's power and research, over a longer battle against nobody in a hurry.
  const w = newWorld(ashwater, [seat('republic', 0, 0), seat('droid', 1, 1)], { seed: 58, credits: 1600 })
  const brains = [newBrain(1, 'medium')]
  for (let t = 0; t < Math.round(360 / STEP); t++) {
    for (const b of brains) think(w, b, STEP)
    tick(w)
    w.events.length = 0
  }
  const ai = w.units.filter((u) => !u.dead && u.owner === 1)
  const gens = ai.filter((u) => u.t.id === 'd-g-generator' && !u.site).length
  const labs = ai.filter((u) => u.t.id === 'd-g-research' && !u.site).length
  const pw = w.players[1].power!
  check('the AI builds power generators and a research station, and banks research points', gens >= 1 && labs >= 1 && (w.players[1].rp ?? 0) > 0, `${gens} generators, ${labs} research stations, ${Math.round(w.players[1].rp ?? 0)} points, power ${pw.made}/${pw.used}`)
  check('the AI keeps power ahead of what it uses', pw.ratio === 1, `${pw.made} made, ${pw.used} used`)
}

// --- 3e. The factory battle -----------------------------------------------------------------------------

{
  const make = (): Copy => ({ w: newWorld(ashwater, [seat('republic', 0, 0), seat('droid', 1, 1)], { seed: 61, credits: 5000 }), brains: [newBrain(1, 'medium')] })
  const ticks = Math.round(Math.max(seconds, 150) / STEP)
  const got: Record<string, [boolean, string]> = {}
  const pass = (k: string, ok: boolean, detail = '') => (got[k] ??= [ok, detail])
  const bad: Record<string, number> = {}
  const miss = (k: string) => (bad[k] = (bad[k] ?? 0) + 1)
  const [, raider] = TIER1_PAIRS.republic
  const vt = UNIT[R.vfactory]
  // For the tier rule and unknown ids: a tier 2 unit and an id nobody defines, on the factory's list.
  const trainsWas = vt.ground!.trains!
  vt.ground!.trains = [...trainsWas, TIER2_TEST, 'r-g-no-such-unit']
  let home: Unit | undefined
  let first: Unit | undefined
  let fac: Unit | undefined
  let barracksSite = 0
  let barracksBuilt = -1
  let rallyAt: { x: number; y: number } | null = null
  let prev: { q?: { item: object; left: number }; ratio: number } | null = null
  let trained = 0
  let outDoor = 0
  let arrived = 0
  let drawn = 0
  let idle = 0
  let short = 0
  const draw = vt.ground!.draw!
  lockstep('factory battle', make, ticks, ({ w }, t, say) => {
    home ??= w.units.find((u) => u.owner === 0 && u.t.id === R.center)!
    first ??= w.units.find((u) => u.owner === 0 && u.t.id === R.engineer)!
    const order = (c: Cmd) => say({ t, k: 'cmd', owner: 0, json: JSON.stringify(c) })
    const p = w.players[0]
    for (const e of w.events) {
      if (e.k === 'built' && e.unit === R.barracks && barracksBuilt < 0) barracksBuilt = t
      if (e.k === 'trained' && fac && e.from === fac.id) {
        trained++
        // Out of its door: the middle of the factory's south side, just beyond it.
        const [fw, fh] = vt.ground!.foot!
        const bottom = (fac.foot!.r + fh) * TILE
        if (e.y > bottom && e.y < bottom + 2 * TILE && Math.abs(e.x - (fac.foot!.c + fw / 2) * TILE) < TILE * 1.5) outDoor++
      }
    }
    w.events.length = 0
    // Last tick's training at the factory, as the power said.
    const pw = p.power
    if (fac && pw && prev) {
      const q = fac.yq![0]
      if (q && prev.q && prev.q.item === q && q.left > 0 && Math.abs(prev.q.left - q.left - STEP * pw.ratio) > 1e-9) miss('training')
      if (q && prev.q && prev.q.item === q && pw.ratio < 1) short++
    }
    // 1/3 s: a Supply Depot and the Vehicle Factory, finished (as the dev cheats raise them).
    if (t === 10) {
      for (const [type, dx, dy] of [[R.supply, -9, 0], [R.vfactory, 10, 2]] as const) {
        const at = find(w, 0, type, null, { x: home.x + dx * TILE, y: home.y + dy * TILE })!
        const pl = groundPlacement(w, 0, type, at.x, at.y)
        say({ t, k: 'add', unit: type, owner: 0, c: pl.tc, r: pl.tr })
      }
      fac = w.units.find((u) => u.owner === 0 && u.t.id === R.vfactory)
    }
    // 2/3 s: the first engineer puts up a Barracks.
    if (t === 20) {
      const at = find(w, 0, R.barracks, null, { x: home.x, y: home.y - 10 * TILE })!
      const id = w.nextId
      const before = p.credits
      order(cmd('place', [first.id], R.barracks, at.x, at.y, false, NaN))
      barracksSite = w.byId.get(id)?.site ? id : 0
      pass('placing a Barracks pays for its site', barracksSite > 0 && before - p.credits === UNIT[R.barracks].cost, `${before - p.credits}`)
    }
    // 1 s: the factory idle draws nothing; a rally point, then five vehicles queued (shift-click).
    if (t === 30 && fac) {
      pass('an idle factory draws no power', pw!.used === 0, `${pw!.used} used`)
      pass('a unit needing tier 2 is refused at a tier 1 factory', /tier 2/.test(cantBuild(w, 0, TIER2_TEST, false, fac.id) ?? ''), `${cantBuild(w, 0, TIER2_TEST, false, fac.id)}`)
      const before = p.credits
      order(cmd('build', 'r-g-no-such-unit', false, fac.id))
      pass('an id the game doesn\'t know is refused, nothing paid or queued', fac.yq!.length === 0 && p.credits === before && !!cantBuild(w, 0, 'r-g-no-such-unit', false, fac.id))
      rallyAt = find(w, 0, R.vfactory, null, { x: fac.x + 6 * TILE, y: fac.y + 9 * TILE })!
      order(cmd('rally', rallyAt.x, rallyAt.y, fac.id))
      for (let i = 0; i < 5; i++) order(cmd('build', raider, false, fac.id))
      pass('five units queue at the factory, each paid', fac.yq!.length === 5 && before - p.credits === 5 * UNIT[raider].cost, `queue ${fac.yq!.length}, paid ${before - p.credits}`)
    }
    if (t === 31 && fac) pass('a busy factory draws its power', pw!.used >= draw, `${pw!.used} used, ${draw} its draw`)
    // 1.5 s: the last one cancelled, refunded in full.
    if (t === 45 && fac) {
      const before = p.credits
      order(cmd('cancel', 4, fac.id))
      pass('a unit cancelled at the factory is refunded in full', fac.yq!.length === 4 && p.credits - before === UNIT[raider].cost, `${p.credits - before}`)
    }
    // 3 s to 15 s: two research stations raised: the base is short of power while the factory trains.
    if (t === 90)
      for (let k = 0; k < 2; k++) {
        const at = find(w, 0, R.research, null, { x: home.x + (k ? -6 : 6) * TILE, y: home.y + 12 * TILE })!
        const pl = groundPlacement(w, 0, R.research, at.x, at.y)
        say({ t, k: 'add', unit: R.research, owner: 0, c: pl.tc, r: pl.tr })
      }
    if (fac && pw) {
      if (fac.yq!.length) drawn++
      else if (t > 60) idle++
    }
    // Units trained there that reached the rally point.
    if (rallyAt) arrived = Math.max(arrived, w.units.filter((u) => !u.dead && u.owner === 0 && u.t.id === raider && u.order.k === 'idle' && Math.hypot(u.x - rallyAt!.x, u.y - rallyAt!.y) < 3 * TILE).length)
    const q = fac?.yq?.[0]
    prev = { q: q ? { item: q, left: q.left } : undefined, ratio: pw?.ratio ?? 1 }
  })
  vt.ground!.trains = trainsWas
  for (const [k, [ok, detail]] of Object.entries(got)) check(`factory battle: ${k}`, ok, detail)
  check('factory battle: an engineer builds a Barracks', barracksBuilt > 0, barracksBuilt > 0 ? `${(barracksBuilt * STEP).toFixed(1)} s in` : 'never built')
  check('factory battle: the four left are trained, each out of the factory\'s door', trained === 4 && outDoor === 4, `${trained} trained, ${outDoor} by the door`)
  check('factory battle: they drive to the factory\'s rally point', arrived >= 3, `${arrived} there`)
  check('factory battle: short of power, the factory trains at made / used of its speed, to the tick', short > 0 && !bad.training, `${short} short ticks; misses ${JSON.stringify(bad)}`)
  console.log(`  factories: Barracks ${UNIT[R.barracks].cost} kyber, ${UNIT[R.barracks].build} s, draws ${UNIT[R.barracks].ground!.draw}; Vehicle Factory ${vt.cost} kyber, ${vt.build} s, draws ${draw}; ${drawn} ticks busy, ${idle} idle`)
}
{
  // The AI's factories, over a longer battle against nobody in a hurry.
  const w = newWorld(ashwater, [seat('republic', 0, 0), seat('droid', 1, 1)], { seed: 62, credits: 1600 })
  const brains = [newBrain(1, 'medium')]
  let worst = 1
  for (let t = 0; t < Math.round(480 / STEP); t++) {
    for (const b of brains) think(w, b, STEP)
    tick(w)
    w.events.length = 0
    if (t > 240 / STEP) worst = Math.min(worst, w.players[1].power?.ratio ?? 1)
  }
  const ai = w.units.filter((u) => !u.dead && u.owner === 1)
  const [foot, vehicle] = TIER1_PAIRS.droid
  const n = (id: string) => ai.filter((u) => u.t.id === id && !u.site).length
  check('the AI builds a foot factory and a vehicle factory', n('d-g-botfactory') >= 1 && n('d-g-foundry') >= 1, `${n('d-g-botfactory')} Bot Factories, ${n('d-g-foundry')} Vehicle Foundries`)
  check('the AI trains a mix of both factories\' units', n(foot) >= 1 && n(vehicle) >= 1, `${n(foot)} ${foot}, ${n(vehicle)} ${vehicle}`)
  check('the AI keeps its power up while its factories train', worst >= 0.75, `worst ratio after 4 min ${worst.toFixed(2)}, power now ${w.players[1].power!.made}/${w.players[1].power!.used}`)
}

// --- 3f. The upgrade battle -----------------------------------------------------------------------------

{
  const make = (): Copy => ({ w: newWorld(ashwater, [seat('republic', 0, 0), seat('droid', 1, 1)], { seed: 63, credits: 6000 }), brains: [newBrain(1, 'medium')] })
  const ticks = Math.round(Math.max(seconds, 200) / STEP)
  const got: Record<string, [boolean, string]> = {}
  const pass = (k: string, ok: boolean, detail = '') => (got[k] ??= [ok, detail])
  const bad: Record<string, number> = {}
  const miss = (k: string) => (bad[k] = (bad[k] ?? 0) + 1)
  const [, raider] = TIER1_PAIRS.republic
  const vt = UNIT[R.vfactory]
  const trainsWas = vt.ground!.trains!
  vt.ground!.trains = [...trainsWas, TIER2_TEST]
  const up = vt.ground!.tierUp![0]
  const weapons = `${R.vfactory}-weapons`
  let home: Unit | undefined
  let fac: Unit | undefined
  let prev: { left: number; job: object } | null = null
  let short = 0
  let tierAt = -1
  let techAt = -1
  let first = 0
  let after = 0
  let afterQueued = false
  const final = lockstep('upgrade battle', make, ticks, ({ w }, t, say) => {
    home ??= w.units.find((u) => u.owner === 0 && u.t.id === R.center)!
    const order = (c: Cmd) => say({ t, k: 'cmd', owner: 0, json: JSON.stringify(c) })
    const p = w.players[0]
    for (const e of w.events) {
      if (e.k === 'tierUp' && e.owner === 0 && tierAt < 0) tierAt = t
      if (e.k === 'tech' && e.owner === 0 && e.id === weapons && techAt < 0) techAt = t
      if (e.k === 'trained' && e.owner === 0 && e.unit === raider) {
        const id = w.units.filter((u) => u.owner === 0 && u.t.id === raider).reduce((a, u) => (u.id > a ? u.id : a), 0)
        if (!first) first = id
        else if (techAt >= 0 && !after) after = id
      }
    }
    w.events.length = 0
    // Last tick's job, as the power said.
    const pw = p.power
    if (fac?.gj && prev && prev.job === fac.gj && pw && fac.gj.left > 0) {
      if (Math.abs(prev.left - fac.gj.left - STEP * pw.ratio) > 1e-9) miss('job')
      else if (pw.ratio < 1) short++
    }
    // 1/3 s: a Supply Depot and the Vehicle Factory, raised; research points to spend (a cheat).
    if (t === 10) {
      for (const [type, dx, dy] of [[R.supply, -9, 0], [R.vfactory, 10, 2]] as const) {
        const at = find(w, 0, type, null, { x: home.x + dx * TILE, y: home.y + dy * TILE })!
        const pl = groundPlacement(w, 0, type, at.x, at.y)
        say({ t, k: 'add', unit: type, owner: 0, c: pl.tc, r: pl.tr })
      }
      say({ t, k: 'rp', owner: 0, value: 1000 })
      fac = w.units.find((u) => u.owner === 0 && u.t.id === R.vfactory)
    }
    if (!fac) return
    // 1/2 s: one vehicle trained before any research.
    if (t === 15) order(cmd('build', raider, false, fac.id))
    // 2/3 s: the tier gate; then the upgrade, paid.
    if (t === 20) {
      pass('a unit needing tier 2 is refused at a tier 1 factory', /tier 2/.test(cantBuild(w, 0, TIER2_TEST, false, fac.id) ?? ''), `${cantBuild(w, 0, TIER2_TEST, false, fac.id)}`)
      pass('research needing tier 2 is refused at a tier 1 factory', /tier 2/.test(cantJob(w, 0, fac, `${R.vfactory}-speed`) ?? ''), `${cantJob(w, 0, fac, `${R.vfactory}-speed`)}`)
      const rp = p.rp!
      const kyber = p.credits
      order(cmd('groundJob', fac.id, 'tier'))
      pass('the upgrade to tier 2 is paid in research points and kyber', fac.gj?.id === 'tier' && rp - p.rp! === up.rp && kyber - p.credits === up.cost, `${rp - p.rp!} points, ${kyber - p.credits} kyber`)
      pass('a second job at a busy factory is refused', !!cantJob(w, 0, fac, weapons))
    }
    if (t === 21) pass('an upgrade under way draws its power', powerReport(w, 0).upgrades === up.draw, `${powerReport(w, 0).upgrades} drawn for upgrades`)
    // 1.3 s: called off, both refunded in full.
    if (t === 40) {
      const rp = p.rp!
      const kyber = p.credits
      order(cmd('cancelGroundJob', fac.id))
      pass('an upgrade called off refunds its research points and kyber in full', !fac.gj && p.rp! - rp === up.rp && p.credits - kyber === up.cost, `${p.rp! - rp} points, ${p.credits - kyber} kyber`)
    }
    if (t === 41) pass('a factory with no job draws nothing for upgrades', powerReport(w, 0).upgrades === 0)
    // 1.7 s: started again, and a research station raised: short of power while it runs.
    if (t === 50) {
      order(cmd('groundJob', fac.id, 'tier'))
      const at = find(w, 0, R.research, null, { x: home.x, y: home.y + 10 * TILE })!
      const pl = groundPlacement(w, 0, R.research, at.x, at.y)
      say({ t, k: 'add', unit: R.research, owner: 0, c: pl.tc, r: pl.tr })
    }
    // Done: tier 2, more hull, the tier 2 unit allowed; then the weapons research.
    if (tierAt >= 0 && t === tierAt + 1) {
      pass('the upgrade done, the factory stands at tier 2 with more hull', fac.t.ground!.tier === 2 && fac.hullMax > vt.hull * 1.2, `tier ${fac.t.ground!.tier}, hull ${Math.round(fac.hullMax)} of ${vt.hull} at tier 1`)
      pass('at tier 2 it trains the tier 2 unit', !/tier/.test(cantBuild(w, 0, TIER2_TEST, false, fac.id) ?? ''), `${cantBuild(w, 0, TIER2_TEST, false, fac.id)}`)
      pass('at tier 2 the tier 2 research is open', !/tier/.test(cantJob(w, 0, fac, `${R.vfactory}-speed`) ?? ''))
      order(cmd('groundJob', fac.id, weapons))
    }
    // The research done: one more vehicle.
    if (techAt >= 0 && !afterQueued) {
      afterQueued = true
      const u = w.byId.get(first)
      pass('research done reaches the units of that factory already out', !!u && Math.abs(u.mods.damage - 1.15) < 1e-9, `damage x${u?.mods.damage}`)
      order(cmd('build', raider, false, fac.id))
    }
    prev = fac.gj ? { left: fac.gj.left, job: fac.gj } : null
  })
  vt.ground!.trains = trainsWas
  for (const [k, [ok, detail]] of Object.entries(got)) check(`upgrade battle: ${k}`, ok, detail)
  check('upgrade battle: short of power, the upgrade runs at made / used of its speed, to the tick', short > 0 && !bad.job, `${short} short ticks; misses ${JSON.stringify(bad)}`)
  check('upgrade battle: the upgrade and the research were done', tierAt > 0 && techAt > 0, `tier 2 at ${(tierAt * STEP).toFixed(1)} s, weapons at ${(techAt * STEP).toFixed(1)} s`)
  const late = final.w.byId.get(after)
  check('upgrade battle: a unit trained after the research has it too', !!late && Math.abs(late.mods.damage - 1.15) < 1e-9, late ? `damage x${late.mods.damage}` : 'none trained')
}
{
  // The AI's factory upgrades and research, over a long battle against nobody in a hurry.
  const w = newWorld(ashwater, [seat('republic', 0, 0), seat('droid', 1, 1)], { seed: 62, credits: 1600 })
  const brains = [newBrain(1, 'medium')]
  let tiers = 0
  let techs = 0
  for (let t = 0; t < Math.round(900 / STEP); t++) {
    for (const b of brains) think(w, b, STEP)
    tick(w)
    for (const e of w.events) if (e.owner === 1 && e.k === 'tierUp') tiers++
    else if (e.k === 'tech' && e.owner === 1) techs++
    w.events.length = 0
  }
  check('the AI upgrades a factory and takes research there', tiers >= 1 && techs >= 1, `${tiers} tier upgrades, ${techs} research done in 15 min`)
}

// --- 3g. The orders battle ------------------------------------------------------------------------------

{
  const make = (): Copy => ({ w: newWorld(ashwater, [seat('republic', 0, 0), seat('droid', 1, 1)], { seed: 64, credits: 6000 }), brains: [{ ...newBrain(1, 'medium'), peaceful: true }] })
  const ticks = Math.round(Math.max(seconds, 240) / STEP)
  const got: Record<string, [boolean, string]> = {}
  const pass = (k: string, ok: boolean, detail = '') => (got[k] ??= [ok, detail])
  let home: Unit | undefined
  let a = 0
  let b = 0
  let c = 0
  let spot = { x: 0, y: 0 }
  let site1 = 0
  let site2 = 0
  let site3 = 0
  const built: number[] = []
  const builtAt = new Map<number, number>()
  let arrived = -1
  let started1 = -1
  let started2 = -1
  let gatherAt = -1
  let phase = 0
  let phaseAt = 0
  let helped = { build: 0, repair: 0, gather: 0, followed: 0 }
  lockstep('orders battle', make, ticks, ({ w }, t, say) => {
    home ??= w.units.find((u) => u.owner === 0 && u.t.id === R.center)!
    const order = (x: Cmd) => say({ t, k: 'cmd', owner: 0, json: JSON.stringify(x) })
    for (const e of w.events) if (e.k === 'built' && e.owner === 0) {
      const s = w.units.find((u) => u.owner === 0 && u.t.id === e.unit && Math.abs(u.x - e.x) < 1 && Math.abs(u.y - e.y) < 1)
      if (s) {
        built.push(s.id)
        builtAt.set(s.id, t)
      }
    }
    w.events.length = 0
    const A = w.byId.get(a)
    const B = w.byId.get(b)
    const C = w.byId.get(c)
    // 1/6 s: two more engineers.
    if (t === 5) {
      a = w.units.find((u) => u.owner === 0 && u.t.id === R.engineer)!.id
      b = w.nextId
      say({ t, k: 'spawn', unit: R.engineer, owner: 0, x: home.x + 2 * TILE, y: home.y + 4.5 * TILE })
      c = w.nextId
      say({ t, k: 'spawn', unit: R.engineer, owner: 0, x: home.x - 2 * TILE, y: home.y + 4.5 * TILE })
    }
    // 1/3 s: A moves, then (Shift) gathers, then (Shift) puts up two sites.
    if (t === 10 && A) {
      spot = find(w, 0, R.supply, null, { x: home.x + 9 * TILE, y: home.y + 9 * TILE })!
      order(cmd('move', [a], spot.x, spot.y, false, false))
      const cl = w.crystals!.find((k) => k.left > 0 && w.ground!.fields[k.f] && Math.hypot(crystalAt(k).x - home!.x, crystalAt(k).y - home!.y) < 20 * TILE) ?? w.crystals!.find((k) => k.left > 0)!
      order(cmd('gather', [a], crystalAt(cl).x, crystalAt(cl).y, true))
      const s1 = find(w, 0, R.supply, null, { x: home.x - 9 * TILE, y: home.y + 8 * TILE })!
      site1 = w.nextId
      order(cmd('place', [a], R.supply, s1.x, s1.y, true, NaN))
      const s2 = find(w, 0, R.generator, null, { x: home.x - 10 * TILE, y: home.y - 8 * TILE })!
      site2 = w.nextId
      order(cmd('place', [a], R.generator, s2.x, s2.y, true, NaN))
      pass('Shift-queued orders go before gathering: move, the two sites, then gather', A.order.k === 'move' && A.queue.map((q) => q.k).join(',') === 'construct,construct,gather', `${A.order.k}; ${A.queue.map((q) => q.k).join(', ')}`)
    }
    if (A && arrived < 0 && t > 10 && A.order.k === 'construct') arrived = Math.hypot(A.x - spot.x, A.y - spot.y) < 3 * TILE ? t : -2
    const S1 = w.byId.get(site1)
    const S2 = w.byId.get(site2)
    if (started1 < 0 && S1?.site?.started) started1 = t
    if (started2 < 0 && S2?.site?.started) started2 = t
    if (A && gatherAt < 0 && A.order.k === 'gather' && built.includes(site2)) gatherAt = t
    // B and C: C assists B through a build, a repair and gathering.
    if (!B || !C) return
    const job = C.order.k === 'assist' ? C.order.job : undefined
    if (phase === 0 && t === 15) {
      const s3 = find(w, 0, R.research, null, { x: home.x + 10 * TILE, y: home.y - 9 * TILE })!
      site3 = w.nextId
      order(cmd('place', [b], R.research, s3.x, s3.y, false, NaN))
      order(cmd('assist', [c], b, false))
      phase = 1
    }
    if (phase === 1) {
      if (job?.k === 'construct' && job.id === site3 && C.gm?.busy === site3 && B.gm?.busy === site3) helped.build++
      if (built.includes(site3)) {
        // The Command Center damaged (as the dev cheats would): B repairs it.
        say({ t, k: 'hull', id: home.id, share: 0.5 })
        order(cmd('construct', [b], home.id, false))
        phase = 2
        phaseAt = t
      }
    } else if (phase === 2) {
      if (job?.k === 'construct' && job.id === home.id && C.gm?.busy === home.id) helped.repair++
      if (home.hull >= home.hullMax - 0.5 || t > phaseAt + 1800) {
        const cl = w.crystals!.find((k) => k.left > 0)!
        order(cmd('gather', [b], crystalAt(cl).x, crystalAt(cl).y, false))
        phase = 3
        phaseAt = t
      }
    } else if (phase === 3) {
      if (job?.k === 'gather' && B.order.k === 'gather' && job.f === B.order.f && (C.gm?.mine || C.gm?.drop)) helped.gather++
      if (t > phaseAt + 900) {
        // B drives off: C follows.
        const far = find(w, 0, R.supply, null, { x: home.x - 14 * TILE, y: home.y })!
        order(cmd('move', [b], far.x, far.y, false, false))
        phase = 4
        phaseAt = t
      }
    } else if (phase === 4 && B.order.k === 'idle' && Math.hypot(C.x - B.x, C.y - B.y) <= 4 * TILE && C.order.k === 'assist') helped.followed++
  })
  for (const [k, [ok, detail]] of Object.entries(got)) check(`orders battle: ${k}`, ok, detail)
  check('orders battle: the queued engineer drives to its move first', arrived > 0, arrived > 0 ? `there at ${(arrived * STEP).toFixed(1)} s` : 'not there when it started building')
  const done1 = builtAt.get(site1) ?? -1
  check('orders battle: then builds the two sites one after the other', started1 >= arrived && done1 > 0 && started2 >= done1 && (builtAt.get(site2) ?? -1) > done1, `site 1 started ${(started1 * STEP).toFixed(1)} s, built ${(done1 * STEP).toFixed(1)} s; site 2 started ${(started2 * STEP).toFixed(1)} s, built ${((builtAt.get(site2) ?? 0) * STEP).toFixed(1)} s`)
  check('orders battle: and gathers once the second is built', gatherAt > 0, gatherAt > 0 ? `${(gatherAt * STEP).toFixed(1)} s` : 'never')
  check('orders battle: an assisting engineer builds the same site', helped.build > 30, `${helped.build} ticks working it together`)
  check('orders battle: ...repairs the same building', helped.repair > 30, `${helped.repair} ticks`)
  check('orders battle: ...gathers the same field', helped.gather > 30, `${helped.gather} ticks`)
  check('orders battle: ...and follows it when it moves on', helped.followed > 0, `${helped.followed} ticks beside it`)
}

// --- 3h. The drop-off battle ----------------------------------------------------------------------------

{
  const make = (): Copy => ({ w: newWorld(ashwater, [seat('republic', 0, 0), seat('droid', 1, 1)], { seed: 65, credits: 3000 }), brains: [{ ...newBrain(1, 'medium'), peaceful: true }] })
  const ticks = Math.round(Math.max(seconds, 240) / STEP)
  const got: Record<string, [boolean, string]> = {}
  const pass = (k: string, ok: boolean, detail = '') => (got[k] ??= [ok, detail])
  let home: Unit | undefined
  let crew: number[] = []
  let field = -1
  let site = 0
  let depot = 0
  let placer = 0
  const drops = { cc: 0, depot: 0, site: 0, afterKill: 0 }
  let carried = new Map<number, number>()
  let k0 = 0
  let k1 = 0
  let rateBefore = 0
  let rateWith = 0
  let killedAt = -1
  let rerouted = 0
  let wasHeading = 0
  const depotSpot = (w: World, at: { x: number; y: number }, avoid = 0, from = 4) => {
    for (let r = from; r < 14; r++)
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2 + avoid
        const pl = groundPlacement(w, 0, R.supply, at.x + Math.cos(a) * r * TILE, at.y + Math.sin(a) * r * TILE)
        if (!pl.why) return pl
      }
    return null
  }
  lockstep('drop-off battle', make, ticks, ({ w }, t, say) => {
    home ??= w.units.find((u) => u.owner === 0 && u.t.id === R.center)!
    w.events.length = 0
    const order = (c: Cmd) => say({ t, k: 'cmd', owner: 0, json: JSON.stringify(c) })
    // 1/6 s: four engineers (three more raised) on the far field of our side.
    if (t === 5) {
      const foe = w.units.find((u) => u.owner === 1 && u.foot)!
      const fields = w.ground!.fields.map((f, i) => ({ f, i, d: Math.hypot(f.x - home!.x, f.y - home!.y) })).filter((x) => x.d < Math.hypot(x.f.x - foe.x, x.f.y - foe.y)).sort((a, b) => a.d - b.d || a.i - b.i)
      field = fields[fields.length - 1].i
      const first = w.units.find((u) => u.owner === 0 && u.t.id === R.engineer)!
      crew = [first.id]
      for (let i = 0; i < 4; i++) {
        crew.push(w.nextId)
        say({ t, k: 'spawn', unit: R.engineer, owner: 0, x: home.x + (i - 1.5) * 2 * TILE, y: home.y + 4.5 * TILE })
      }
      placer = crew.pop()!
    }
    if (t === 10) {
      const cl = w.crystals!.find((c) => c.f === field && c.left > 0)!
      order(cmd('gather', crew, crystalAt(cl).x, crystalAt(cl).y, false))
      // A depot site beside the field that nobody builds: the placer is sent off elsewhere at once.
      const pl = depotSpot(w, w.ground!.fields[field])!
      site = w.nextId
      order(cmd('place', [placer], R.supply, pl.x, pl.y, false, NaN))
      order(cmd('move', [placer], home.x - 8 * TILE, home.y, false, false))
    }
    // Who dropped where: a load that went from carried to nothing next to a drop-off.
    for (const id of crew) {
      const u = w.byId.get(id)
      if (!u || u.dead) continue
      const before = carried.get(id) ?? 0
      if (before > 0 && (u.carry ?? 0) === 0) {
        const at = [home, depot ? w.byId.get(depot) : undefined, site ? w.byId.get(site) : undefined].find((s) => s && !s.dead && !!s.foot && footDist(s, u.x, u.y) <= REACH + TILE)
        if (at === home) (killedAt >= 0 ? drops.afterKill++ : drops.cc++)
        else if (at && at.id === depot) drops.depot++
        else if (at && at.id === site) drops.site++
      }
      carried.set(id, u.carry ?? 0)
      if (site && u.gm?.home === site) drops.site++
    }
    const s = w.byId.get(site)
    if (t === 60 / STEP) pass('an unfinished supply building beside the field takes no kyber', !!s?.site && drops.site === 0 && drops.cc > 0, `${drops.cc} loads to the Command Center, ${drops.site} to the site`)
    // 60 s: kyber a minute so far (after the walk out); a finished depot raised beside the field.
    if (t === 30 / STEP) k0 = w.players[0].credits
    if (t === 90 / STEP) {
      rateBefore = (w.players[0].credits - k0) / 1
      // (A few tiles out, so a haul to it takes a while: the kill below catches one on its way.)
      const pl = depotSpot(w, w.ground!.fields[field], Math.PI, 7)!
      depot = w.nextId
      say({ t, k: 'add', unit: R.supply, owner: 0, c: pl.tc, r: pl.tr })
    }
    if (t === 120 / STEP) k1 = w.players[0].credits
    if (t === 180 / STEP) rateWith = (w.players[0].credits - k1) / 1
    // 3 min on: the depot destroyed while an engineer carries to it.
    if (killedAt < 0 && t > 180 / STEP) {
      const heading = crew.map((id) => w.byId.get(id)).find((u) => u && u.gm?.drop && u.gm.home === depot)
      if (heading) {
        wasHeading = heading.id
        say({ t, k: 'kill', id: depot })
        killedAt = t
      }
    }
    if (killedAt >= 0 && t === killedAt + 2) {
      const u = w.byId.get(wasHeading)
      if (u && u.gm?.home === home.id) rerouted++
    }
  })
  for (const [k, [ok, detail]] of Object.entries(got)) check(`drop-off battle: ${k}`, ok, detail)
  check('drop-off battle: a finished supply building beside the field takes the loads', drops.depot > 0, `${drops.depot} loads to the depot, ${drops.cc} to the Command Center before it`)
  check('drop-off battle: with the depot the far field gives much more kyber', rateWith > rateBefore * 2, `${Math.round(rateBefore)} kyber a minute to the Command Center, ${Math.round(rateWith)} with the depot`)
  check('drop-off battle: the depot destroyed, an engineer carrying to it re-routes to the Command Center', killedAt > 0 && rerouted > 0 && drops.afterKill > 0, `${drops.afterKill} loads to the Command Center after`)
}
{
  // The AI on Ashwater Crossing with the fields by its start nearly mined out (a cheat), so it mines
  // one further off: it puts a supply building beside it.
  const w = newWorld(ashwater, [seat('republic', 0, 0), seat('droid', 1, 1)], { seed: 66, credits: 1600 })
  const brains = [{ ...newBrain(1, 'medium'), peaceful: true }]
  tick(w)
  const hub = w.units.find((u) => u.owner === 1 && u.foot)!
  for (const c of w.crystals!) {
    const f = w.ground!.fields[c.f]
    if (Math.hypot(f.x - hub.x, f.y - hub.y) < 20 * TILE) c.left = Math.min(c.left, 40)
  }
  for (let t = 0; t < Math.round(300 / STEP); t++) {
    for (const b of brains) think(w, b, STEP)
    tick(w)
    w.events.length = 0
  }
  const depots = w.units.filter((u) => !u.dead && u.owner === 1 && u.t.id === D.supply && !u.site)
  const near = depots.filter((d) => w.ground!.fields.some((f) => Math.hypot(f.x - d.x, f.y - d.y) < 10 * TILE))
  check('the AI puts a supply building beside a far field it mines', near.length > 0, `${depots.length} supply buildings, ${near.length} beside a field`)
}

// --- 4. The crowd battle -------------------------------------------------------------------------------

{
  const ARMY = ['test-scout', 'test-scout', 'test-scout', 'test-rover', 'test-rover', 'test-rover', 'test-rover', 'test-crawler', 'test-crawler', 'test-scout', 'test-rover', 'test-crawler']
  const starts = [{ c: 10, r: 14 }, { c: 40, r: 30 }]
  const make = (): Copy => {
    const w = newWorld(mesa, [seat('republic', 0, 0), seat('republic', 1, 1)], { seed: 4242, credits: 1000 })
    w.players.forEach((_, o) => {
      const s = starts[o]
      ARMY.forEach((id, i) => spawn(w, id, o, (s.c + 0.5) * TILE + ((i % 4) - 1.5) * 48, (s.r + 0.5) * TILE + (Math.floor(i / 4) - 1) * 48, (o * Math.PI) / 2))
    })
    return { w, brains: [] }
  }
  const ticks = Math.round(Math.max(seconds, 200) / STEP)
  let s = 20261018
  const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296)
  let sent = 0
  let stops = 0
  let ended = 0
  let added = 0
  let destroyed = 0
  const prev = new Map<number, string>()
  const bad = new Map<number, number>()
  let worst = 0
  let worstAt = ''
  let offMap = 0
  let nan = 0
  const final = lockstep('crowd battle', make, ticks, ({ w }, t, say) => {
    w.events.length = 0
    const mobile = w.units.filter((u) => !u.dead && u.t.tier === 'vehicle' && u.t.id.startsWith('test-'))
    for (const u of mobile) {
      if (prev.get(u.id) === 'move' && u.order.k === 'idle') ended++
      prev.set(u.id, u.order.k)
      if (!Number.isFinite(u.x) || !Number.isFinite(u.y) || !Number.isFinite(u.a) || !Number.isFinite(u.v)) nan++
      if (u.x < 0 || u.y < 0 || u.x > w.w || u.y > w.h) offMap++
      const k = u.t.ground!.size
      const n = stands(w.ground!.nav, k, anchorAt(w.ground!.nav, k, u.x, u.y)) ? 0 : (bad.get(u.id) ?? 0) + 1
      bad.set(u.id, n)
      if (n > worst) {
        worst = n
        worstAt = `${u.t.id} ${u.id} at ${(u.x / TILE).toFixed(1)}, ${(u.y / TILE).toFixed(1)}, tick ${t}`
      }
    }
    if (t % 10 === 0) {
      const owner = Math.floor(rnd() * 2)
      const ids = mobile.filter((u) => u.owner === owner && rnd() < 0.5).map((u) => u.id)
      if (ids.length) {
        const c = sent++ % 7 === 6 ? (stops++, cmd('stop', ids)) : cmd('move', ids, rnd() * w.w, rnd() * w.h, false, rnd() < 0.3)
        say({ t, k: 'cmd', owner, json: JSON.stringify(c) })
      }
    }
    // Buildings: every 4 seconds one goes up, half the time right on top of a unit; from 20 seconds
    // on, every 6 seconds the oldest test block standing is destroyed.
    if (t > 0 && t % 120 === 0) {
      const owner = Math.floor(rnd() * 2)
      for (let tries = 0; tries < 40; tries++) {
        const on = rnd() < 0.5 ? mobile[Math.floor(rnd() * mobile.length)] : null
        const c = on ? Math.floor(on.x / TILE) - 1 : Math.floor(rnd() * MESA.cols)
        const r = on ? Math.floor(on.y / TILE) - 1 : Math.floor(rnd() * MESA.rows)
        if (!footprintOpen(w.ground!.nav, c, r, 3, 3)) continue
        say({ t, k: 'add', unit: 'test-block', owner, c, r })
        added++
        break
      }
    }
    if (t >= 600 && t % 180 === 90) {
      const oldest = w.units.find((u) => !u.dead && u.t.id === 'test-block')
      if (oldest) {
        say({ t, k: 'kill', id: oldest.id })
        destroyed++
      }
    }
    // Junk an honest server cleans away.
    if (t % 97 === 0) say({ t, k: 'cmd', owner: 0, json: JSON.stringify([{ f: 'move', a: [[1], 'x', 3] }, { f: 'nuke', a: [] }, { f: 'move', a: [[-5], 1, 1] }][t % 3]) })
  })
  console.log(`  ${sent} orders (${stops} stops), ${ended} moves ended; ${added} buildings up, ${destroyed} destroyed; ${final.w.units.length} units at the end`)
  check('crowd battle: no unit stays where it can\'t stand for more than 3 s', worst <= 90, worst ? `longest ${(worst * STEP).toFixed(2)} s: ${worstAt}` : '')
  check('crowd battle: nothing leaves the map or turns NaN', !offMap && !nan, `${offMap} off the map, ${nan} NaN`)
  check('crowd battle: move orders end', ended > 100, `${ended}`)
  check('crowd battle: buildings went up and were destroyed', added >= 10 && destroyed >= 5)
}

// --- 5. Combat ------------------------------------------------------------------------------------------

{
  // A Scout battle won by destroying every building: eight Pathfinders against three Probe droids and
  // the Command Hub's turret, in step across two copies, a snapshot thaw and a replay.
  const make = (): Copy => ({ w: newWorld(dustfall, [seat('republic', 0, 0), seat('droid', 1, 1)], { seed: 21, credits: 3000 }), brains: [] })
  const ticks = Math.round(150 / STEP)
  let hub: Unit | undefined
  let hubFoot: { c: number; r: number } | null = null
  let turret = false
  const events: Record<string, number> = {}
  const final = lockstep('combat battle', make, ticks, ({ w }, t, say) => {
    hub ??= w.units.find((u) => u.owner === 1 && u.t.id === 'd-g-center')!
    hubFoot ??= { ...hub.foot! }
    const home = w.units.find((u) => u.owner === 0 && u.t.id === 'r-g-center')!
    for (const e of w.events) events[e.k] = (events[e.k] ?? 0) + 1
    w.events.length = 0
    if (hub.guns.some((g) => g.target)) turret = true
    if (t === 1) {
      for (let i = 0; i < 8; i++) say({ t, k: 'spawn', unit: 'r-g-scout', owner: 0, x: home.x + 160 + (i % 4) * 30, y: home.y + 140 + Math.floor(i / 4) * 30 })
      for (let i = 0; i < 3; i++) say({ t, k: 'spawn', unit: 'd-g-scout', owner: 1, x: hub.x - 200 - i * 30, y: hub.y - 160 })
    }
    // The Hub weakened (as a dev cheat would), then everything of ours sent at it, attack-moving:
    // they take on the Probes on the way, then the Hub.
    if (t === 30) say({ t, k: 'hull', id: hub.id, share: 0.08 })
    if (t === 40) {
      const ids = w.units.filter((u) => u.owner === 0 && u.t.id === 'r-g-scout').map((u) => u.id)
      say({ t, k: 'cmd', owner: 0, json: JSON.stringify(cmd('move', ids, hub.x, hub.y, true, false)) })
    }
  }, 1350)
  const w = final.w
  console.log(`  events: ${Object.entries(events).map(([k, n]) => `${n} ${k}`).join(', ')}; won at ${w.winner === 0 ? `${Math.round(w.time)} s` : 'never'}`)
  check('combat battle: Scouts fire, hit and die', (events.fire ?? 0) > 20 && (events.hit ?? 0) > 10 && (events.boom ?? 0) >= 2, `${events.fire ?? 0} shots, ${events.boom ?? 0} destroyed`)
  check("combat battle: the Command Hub's turret fires", turret)
  check('combat battle: a side whose every building is destroyed is out, and the other wins', w.winner === 0 && !w.players[1].alive && w.players[0].alive)
  // (The battle stops ticking once it is won, so the stamp may still wait for its flush.)
  const nav = w.ground!.nav
  const freed = !!hubFoot && (nav.pending.some((p) => p.d === -1 && p.c === hubFoot!.c && p.r === hubFoot!.r) || [0, 1, 2, 3, 4, 5].every((dr) => [0, 1, 2, 3, 4, 5].every((dc) => nav.bld[(hubFoot!.r + dr) * nav.cols + hubFoot!.c + dc] === 0)))
  check('combat battle: a destroyed building frees its stamp', freed)
  check('combat battle: experience from kills', w.units.some((u) => u.owner === 0 && u.kills > 0))
}

{
  // Fog: a unit fires only at what its team sees; artillery at what an ally sees, past its own sight;
  // never closer than its minimum range. Armour: a shot lands as its damage times GROUND_VS.
  registerWeaponTest()
  const field = groundMapDef('test-field')!
  const fresh = () => newWorld(field, [seat('republic', 0, 0), seat('droid', 1, 1)], { seed: 5, credits: 0 })
  const run = (w: World, s: number) => {
    let shots = 0
    for (let t = 0; t < s * 30; t++) {
      tick(w)
      shots += w.events.filter((e) => e.k === 'fire').length
      w.events.length = 0
    }
    return shots
  }
  const cy = field.h / 2
  {
    const w = fresh()
    const art = spawn(w, testWeaponId('republic', 'artillery'), 0, field.w * 0.3, cy, 0)
    art.stance = 'hold'
    const foe = spawn(w, 'd-g-engineer', 1, art.x + 16 * TILE, cy, 0)
    const blind = run(w, 3)
    const eye = spawn(w, 'r-g-scout', 0, foe.x - 3 * TILE, cy - 2 * TILE, 0)
    eye.stance = 'hold'
    eye.guns.length = 0
    const seen = run(w, 4)
    check("artillery doesn't fire at what its team can't see", blind === 0 && !(w.gshots ?? []).some((x) => x.from === art.id && x.age > 3.5), `${blind} shots`)
    check('artillery fires past its own sight at what an ally sees', seen > 0 && (foe.dead || foe.hull < foe.hullMax), `${seen} shots`)
  }
  {
    const w = fresh()
    // (Out of reach of our Command Center's turret.)
    const art = spawn(w, testWeaponId('republic', 'artillery'), 0, field.w * 0.45, cy, 0)
    art.stance = 'hold'
    spawn(w, 'd-g-engineer', 1, art.x + 4 * TILE, cy, 0)
    check('artillery never fires closer than its minimum range', run(w, 4) === 0)
  }
  {
    // One pulse bolt on a building: its damage times the pulse's share against structures.
    const w = fresh()
    const gun = spawn(w, testWeaponId('republic', 'pulse'), 0, field.w * 0.5, cy, 0)
    gun.stance = 'hold'
    const block = raiseBuilding(w, UNIT['d-g-supply'], 1, Math.floor(gun.x / TILE) + 3, Math.floor(cy / TILE) - 1)
    let first = 0
    for (let t = 0; t < 120 && !first; t++) {
      tick(w)
      first = block.hullMax - block.hull
    }
    const want = 10 * GROUND_VS.pulse[armourOf(block.t)]
    check('a shot lands as its damage times its share against the armour', Math.abs(first - want) < 1e-9, `${first} against ${want} (pulse on structure)`)
  }
  {
    // The weapon test: every one of the seven ground weapons fires, and both sides lose units.
    const w = newWorld(dustfall, [seat('republic', 0, 0), seat('swarm', 1, 1)], { seed: 9 })
    const us = spawnWeaponTest(w, 0, 1, w.w * 0.45, w.h * 0.55)
    const fired = new Set<string>()
    for (let t = 0; t < 40 * 30; t++) {
      tick(w)
      w.events.length = 0
      for (const x of w.gshots ?? []) fired.add(x.g)
      for (const u of w.units) for (const g of u.guns) if (g.hold) fired.add(g.w.ground!)
    }
    const missing = GROUND_WEAPONS.filter((k) => !fired.has(k))
    check('weapon test: all seven ground weapons fire', !missing.length, missing.length ? `never: ${missing.join(', ')}` : '')
    check('weapon test: both sides lose units', us.some((u) => u.owner === 0 && u.dead) && us.some((u) => u.owner === 1 && u.dead), `${us.filter((u) => u.dead).length} of ${us.length} destroyed`)
  }
}

// --- 6. Squads -----------------------------------------------------------------------------------------

{
  // Three trooper squads and the walker against three battle droid squads, attack-moving at each
  // other on the low ground of Dustfall Ridge.
  registerWalkerTest()
  const make = (): Copy => ({ w: newWorld(dustfall, [seat('republic', 0, 0), seat('droid', 1, 1)], { seed: 33, credits: 0 }), brains: [] })
  const ticks = Math.round(80 / STEP)
  const seen = new Map<number, number[]>()
  let walked = false
  const final = lockstep('squad battle', make, ticks, ({ w }, t, say) => {
    const x = w.w * 0.45
    const y = w.h * 0.55
    if (t === 1) {
      for (let i = 0; i < 3; i++) say({ t, k: 'spawn', unit: TIER1.republic.foot, owner: 0, x: x - 7 * TILE, y: y + (i - 1) * 2.2 * TILE })
      say({ t, k: 'spawn', unit: TEST_WALKER, owner: 0, x: x - 8 * TILE, y: y + 3.3 * TILE })
      for (let i = 0; i < 3; i++) say({ t, k: 'spawn', unit: TIER1.droid.foot, owner: 1, x: x + 7 * TILE, y: y + (i - 1) * 2.2 * TILE })
    }
    if (t === 2)
      for (const o of [0, 1]) {
        const ids = w.units.filter((u) => u.owner === o && (u.t.ground?.squad || u.t.id === TEST_WALKER)).map((u) => u.id)
        say({ t, k: 'cmd', owner: o, json: JSON.stringify(cmd('move', ids, o ? x - 4 * TILE : x + 4 * TILE, y, true, false)) })
      }
    for (const u of w.units) {
      if (!u.t.ground?.squad || u.members === undefined) continue
      const list = seen.get(u.id) ?? []
      if (list[list.length - 1] !== u.members) list.push(u.members)
      seen.set(u.id, list)
    }
    for (const u of w.units) if (u.t.id === TEST_WALKER && u.v > 10) walked = true
    w.events.length = 0
  })
  const counts = [...seen.values()]
  const lost = counts.filter((c) => c.length > 1).length
  console.log(`  members standing over the battle: ${counts.map((c) => c.join('>')).join(', ')}`)
  check('squad battle: squads lose members as their hull drops', lost >= 3, `${lost} of ${counts.length} squads lost some`)
  check('squad battle: members only fall, never below one while the squad lives', counts.every((c) => c.every((n, i) => n >= 1 && (i === 0 || n < c[i - 1]))))
  check('squad battle: members fall one at a time', counts.every((c) => c.every((n, i) => i === 0 || c[i - 1] - n === 1)), counts.map((c) => c.join('>')).join(', '))
  check('squad battle: a squad is destroyed in the end', final.w.units.some((u) => u.t.ground?.squad && u.dead) || [...seen.keys()].some((id) => !final.w.byId.get(id)))
  check('squad battle: the walker walks', walked)
  // The count is in the hash.
  const sq = final.w.units.find((u) => !u.dead && u.t.ground?.squad)
  if (sq) {
    const h = stateHash(final.w)
    const was = sq.members
    sq.members = (was ?? 1) + 1
    check("a squad's member count is in the hash", stateHash(final.w) !== h)
    sq.members = was
  }
}

{
  // The six tier 1 units (every faction's foot squad and fast vehicle), the same six a side, fighting
  // across the low ground: in step across two copies, a snapshot thaw and a replay.
  const six = (['republic', 'droid', 'swarm'] as const).flatMap((f) => [TIER1[f].foot, TIER1[f].vehicle])
  const make = (): Copy => ({ w: newWorld(dustfall, [seat('republic', 0, 0), seat('swarm', 1, 1)], { seed: 44, credits: 0 }), brains: [] })
  const fired = new Set<string>()
  const spawned = new Map<number, number>()
  const final = lockstep('tier 1 battle', make, Math.round(90 / STEP), ({ w }, t, say) => {
    const x = w.w * 0.45
    const y = w.h * 0.55
    if (t === 1)
      for (const o of [0, 1])
        six.forEach((id, i) => say({ t, k: 'spawn', unit: id, owner: o, x: x + (o ? 7 : -7) * TILE, y: y + (i - 2.5) * 2.2 * TILE }))
    if (t === 2)
      for (const o of [0, 1]) {
        const ids = w.units.filter((u) => u.owner === o && six.includes(u.t.id)).map((u) => u.id)
        for (const id of ids) spawned.set(id, o)
        say({ t, k: 'cmd', owner: o, json: JSON.stringify(cmd('move', ids, x + (o ? -4 : 4) * TILE, y, true, false)) })
      }
    for (const s of w.gshots ?? []) {
      const u = w.byId.get(s.from)
      if (u) fired.add(u.t.id)
    }
    w.events.length = 0
  })
  const quiet = six.filter((id) => !fired.has(id))
  check('tier 1 battle: all six tier 1 units fire', !quiet.length, quiet.length ? `never: ${quiet.join(', ')}` : '')
  const gone = [...spawned].filter(([id]) => !final.w.byId.get(id) || final.w.byId.get(id)!.dead)
  check('tier 1 battle: units die on both sides', gone.some(([, o]) => o === 0) && gone.some(([, o]) => o === 1), `${gone.length} of ${spawned.size} destroyed`)
  check('tier 1 units are tier 1, light armour, in the Codex lists', six.every((id) => UNIT[id].ground?.tier === 1 && UNIT[id].ground?.armour === 'light' && UNITS.includes(UNIT[id])))
}

{
  // The six tier 2 units (the anti-swarm ones) against a crowd of tier 1 units twice their number:
  // in step across two copies, a snapshot thaw and a replay; all six fire, splash catches several
  // units at once, and the anti-swarm side comes out ahead.
  const tier2 = (['republic', 'droid', 'swarm'] as const).flatMap((f) => [TIER2[f].foot, TIER2[f].vehicle])
  const crowd = (['republic', 'droid', 'swarm'] as const).flatMap((f) => [TIER1[f].foot, TIER1[f].vehicle])
  const make = (): Copy => ({ w: newWorld(dustfall, [seat('droid', 0, 0), seat('swarm', 1, 1)], { seed: 55, credits: 0 }), brains: [] })
  const fired = new Set<string>()
  const spawned = new Map<number, number>()
  const start = new Map<number, number>()
  let multi = 0
  const hullAt = new Map<number, number>()
  const final = lockstep('tier 2 battle', make, Math.round(90 / STEP), ({ w }, t, say) => {
    const x = w.w * 0.45
    const y = w.h * 0.55
    if (t === 1) {
      tier2.forEach((id, i) => say({ t, k: 'spawn', unit: id, owner: 0, x: x - 7 * TILE, y: y + (i - 2.5) * 2.4 * TILE }))
      for (const dx of [7, 9]) crowd.forEach((id, i) => say({ t, k: 'spawn', unit: id, owner: 1, x: x + dx * TILE, y: y + (i - 2.5) * 2.2 * TILE + (dx - 8) * TILE }))
    }
    if (t === 2)
      for (const o of [0, 1]) {
        const ids = w.units.filter((u) => u.owner === o && (tier2.includes(u.t.id) || crowd.includes(u.t.id))).map((u) => u.id)
        for (const id of ids) spawned.set(id, o)
        start.set(o, ids.reduce((n, id) => n + w.byId.get(id)!.t.cost, 0))
        say({ t, k: 'cmd', owner: o, json: JSON.stringify(cmd('move', ids, x + (o ? -4 : 4) * TILE, y, true, false)) })
      }
    for (const s of w.gshots ?? []) {
      const u = w.byId.get(s.from)
      if (u) fired.add(u.t.id)
    }
    for (const u of w.units) for (const g of u.guns) if (g.hold && tier2.includes(u.t.id)) fired.add(u.t.id)
    // A splash that hurt more than one of the crowd this tick.
    for (const e of w.events) {
      if (e.k !== 'splash' || e.owner !== 0) continue
      const hit = w.units.filter((u) => u.owner === 1 && (hullAt.get(u.id) ?? u.hull) > u.hull + 1e-9 && Math.hypot(u.x - e.x, u.y - e.y) < e.r + 40).length
      if (hit > 1) multi++
    }
    hullAt.clear()
    for (const u of w.units) hullAt.set(u.id, u.hull)
    w.events.length = 0
  })
  const quiet = tier2.filter((id) => !fired.has(id))
  check('tier 2 battle: all six tier 2 units fire', !quiet.length, quiet.length ? `never: ${quiet.join(', ')}` : '')
  check('tier 2 battle: splash catches several units at once', multi > 3, `${multi} splashes hurt more than one`)
  // The share of each side's kyber still standing.
  const cost = (id: number) => final.w.byId.get(id)?.t.cost ?? 0
  const share = (o: number) => {
    const ids = [...spawned].filter(([, q]) => q === o).map(([id]) => id)
    return ids.filter((id) => final.w.byId.get(id) && !final.w.byId.get(id)!.dead).reduce((n, id) => n + cost(id), 0) / (start.get(o) ?? 1)
  }
  check('tier 2 battle: the anti-swarm side comes out ahead of the crowd', share(0) > share(1), `kyber still standing: tier 2 ${Math.round(share(0) * 100)}%, tier 1 ${Math.round(share(1) * 100)}%`)
  check('tier 2 units are tier 2, the squads light and the rest medium armour', tier2.every((id) => UNIT[id].ground?.tier === 2 && UNIT[id].ground?.armour === (UNIT[id].ground?.squad ? 'light' : 'medium') && UNITS.includes(UNIT[id])))
}

{
  // The six tier 3 units (every faction's heavy foot and vehicle unit), the same six a side,
  // fighting across the low ground: in step across two copies, a snapshot thaw and a replay. Big
  // hulls are spawned where their size class stands.
  const six = (['republic', 'droid', 'swarm'] as const).flatMap((f) => [TIER3[f].foot, TIER3[f].vehicle])
  const make = (): Copy => ({ w: newWorld(dustfall, [seat('republic', 0, 0), seat('swarm', 1, 1)], { seed: 45, credits: 0 }), brains: [] })
  const fired = new Set<string>()
  const spawned = new Map<number, number>()
  const final = lockstep('tier 3 battle', make, Math.round(90 / STEP), ({ w }, t, say) => {
    const x = w.w * 0.45
    const y = w.h * 0.55
    if (t === 1)
      for (const o of [0, 1])
        six.forEach((id, i) => {
          const k = UNIT[id].ground!.size
          let px = x + (o ? 9 : -9) * TILE
          let py = y + (i - 2.5) * 3.4 * TILE
          for (let s = 0; s < 12 && !standsAt(w.ground!.nav, k, px, py); s++) px += (o ? 1 : -1) * TILE
          say({ t, k: 'spawn', unit: id, owner: o, x: px, y: py })
        })
    if (t === 2)
      for (const o of [0, 1]) {
        const ids = w.units.filter((u) => u.owner === o && six.includes(u.t.id)).map((u) => u.id)
        for (const id of ids) spawned.set(id, o)
        say({ t, k: 'cmd', owner: o, json: JSON.stringify(cmd('move', ids, x + (o ? -4 : 4) * TILE, y, true, false)) })
      }
    for (const s of w.gshots ?? []) {
      const u = w.byId.get(s.from)
      if (u) fired.add(u.t.id)
    }
    // A beam makes no shots: it fires while it holds a target.
    for (const u of w.units) if (!u.dead && six.includes(u.t.id) && u.guns.some((g) => (g.hold ?? 0) > 0)) fired.add(u.t.id)
    w.events.length = 0
  })
  const quiet = six.filter((id) => !fired.has(id))
  check('tier 3 battle: all six tier 3 units fire', !quiet.length, quiet.length ? `never: ${quiet.join(', ')}` : '')
  const gone = [...spawned].filter(([id]) => !final.w.byId.get(id) || final.w.byId.get(id)!.dead)
  check('tier 3 battle: units die on both sides', gone.some(([, o]) => o === 0) && gone.some(([, o]) => o === 1), `${gone.length} of ${spawned.size} destroyed`)
  // The tier rule and the price: tier 3, heavy armour (the Lancer team stays light), pop 4, about
  // four times the tier 1 unit of the same factory in kyber and build time.
  const bad = (['republic', 'droid', 'swarm'] as const).flatMap((f) =>
    (['foot', 'vehicle'] as const).flatMap((k) => {
      const t3 = UNIT[TIER3[f][k]]
      const t1 = UNIT[TIER1[f][k]]
      const armour = t3.ground?.squad ? 'light' : 'heavy'
      const ok = t3.ground?.tier === 3 && t3.ground.armour === armour && t3.pop === 4 && t3.cost >= t1.cost * 3.5 && t3.cost <= t1.cost * 4.5 && t3.build >= t1.build * 3.5 && t3.build <= t1.build * 4.5 && UNITS.includes(t3)
      return ok ? [] : [t3.id]
    }),
  )
  check('tier 3 units are tier 3, heavy armour (the squad light), pop 4, about four times tier 1 in kyber and build time, in the Codex lists', !bad.length, bad.join(', '))
  // Size: a tier 3 vehicle is about two to three times a tier 1 vehicle, on size class 2 or 3.
  const small = FACTION_LIST.map((f) => [UNIT[TIER3[f].vehicle], UNIT[TIER1[f].vehicle]] as const).filter(([a, b]) => a.size < b.size * 2 || a.size > b.size * 3.2 || a.ground!.size < 2)
  check('tier 3 vehicles are two to three times a tier 1 vehicle\'s size, on size class 2 or 3', !small.length, small.map(([a]) => a.id).join(', '))
}

{
  // The counter loop's heavy end: massed tier 1 Racers (fast, spine darts against armour) beat any
  // tier 3 unit at equal kyber, on the flat test field.
  const field = groundMapDef('test-field')!
  const lost: string[] = []
  for (const f of FACTION_LIST)
    for (const k of ['foot', 'vehicle'] as const) {
      const id = TIER3[f][k]
      const w = newWorld(field, [seat('republic', 0, 0), seat('swarm', 1, 1)], { seed: 9, credits: 0 })
      const cx = field.w / 2
      const cy = field.h / 2
      const budget = UNIT[id].cost * 2
      const heavy = [0, 1].map((i) => spawn(w, id, 0, cx - 11 * TILE, cy + (i - 0.5) * 4 * TILE, 0).id)
      const n = Math.round(budget / UNIT['s-g-racer'].cost)
      const racers = Array.from({ length: n }, (_, i) => spawn(w, 's-g-racer', 1, cx + (11 + Math.floor(i / 4) * 1.5) * TILE, cy + ((i % 4) - 1.5) * 1.5 * TILE, Math.PI).id)
      runCmd(w, 0, cmd('move', heavy, cx + 12 * TILE, cy, true, false))
      runCmd(w, 1, cmd('move', racers, cx - 12 * TILE, cy, true, false))
      for (let t = 0; t < 120 / STEP && heavy.some((h) => !w.byId.get(h)?.dead); t++) {
        tick(w)
        w.events.length = 0
      }
      if (heavy.some((h) => w.byId.get(h) && !w.byId.get(h)!.dead)) lost.push(id)
    }
  check('two of any tier 3 unit lose to equal kyber of massed Racers (fast, anti-armour)', !lost.length, lost.length ? `still standing: ${lost.join(', ')}` : '')
}

{
  // Members fire on their own: a full squad's first shots come over several ticks, each from where a
  // member stands, spread over the targets in reach; with half its hull gone three members are left
  // and it fires about three fifths as often.
  const field = groundMapDef('test-field')!
  const w = newWorld(field, [seat('republic', 0, 0), seat('droid', 1, 1)], { seed: 7, credits: 0 })
  const cy = field.h / 2
  const squad = spawn(w, TIER1.republic.foot, 0, field.w * 0.4, cy, 0)
  squad.stance = 'hold'
  for (const dy of [-1.5, 0, 1.5]) {
    const e = spawn(w, 'd-g-engineer', 1, squad.x + 4 * TILE, cy + dy * TILE, Math.PI)
    e.hull = e.hullMax = 1e6
  }
  const run = (seconds: number) => {
    const shots: { t: number; target: number; member: boolean }[] = []
    for (let t = 0; t < seconds * 30; t++) {
      tick(w)
      w.events.length = 0
      for (const x of w.gshots ?? [])
        if (x.from === squad.id && x.age < STEP * 1.01) shots.push({ t, target: x.target, member: (squad.crew ?? []).some((m) => Math.abs(m.x - x.sx) < 1e-6 && Math.abs(m.y - x.sy) < 1e-6) })
    }
    return shots
  }
  const full = run(10)
  const first = new Set(full.slice(0, 5).map((x) => x.t)).size
  check("a squad's members fire on their own timing", first >= 3, `its first 5 shots over ${first} different ticks`)
  check('each shot comes from where a member stands', full.length > 0 && full.every((x) => x.member))
  const spread = new Set(full.map((x) => x.target)).size
  check('a squad spreads its fire over the targets in reach', spread >= 2, `${spread} of 3 targets shot at`)
  squad.hull = squad.hullMax * 0.5
  run(1)
  const half = run(10)
  const ratio = half.length / full.length
  check('with half its hull gone, three members are left and fire about three fifths as often', squad.members === 3 && ratio > 0.4 && ratio < 0.8, `${squad.members} members, ${half.length} shots against ${full.length}`)
}

{
  // Loose, not a grid: standing still, members shuffle; sent across the river on Ashwater Crossing,
  // they file through the crossing and all arrive, gathered round the squad again.
  const w = newWorld(ashwater, [seat('republic', 0, 0), seat('droid', 1, 1)], { seed: 8, credits: 0 })
  const [a, b] = w.ground!.map.spawns
  const squad = spawn(w, TIER1.republic.foot, 0, a.x + 6 * TILE, a.y, 0)
  const s = squad.t.ground!.squad!.spacing
  const step = (seconds: number, each?: () => void) => {
    for (let t = 0; t < seconds * 30; t++) {
      tick(w)
      w.events.length = 0
      each?.()
    }
  }
  step(3)
  const before = (squad.crew ?? []).map((m) => ({ x: m.x, y: m.y }))
  step(8)
  const shuffled = (squad.crew ?? []).filter((m, i) => Math.hypot(m.x - before[i].x, m.y - before[i].y) > 2).length
  check('standing still, members shuffle now and then', shuffled >= 2, `${shuffled} of ${squad.crew?.length} moved`)
  runCmd(w, 0, cmd('move', [squad.id], b.x, b.y, false, false))
  step(150)
  const far = Math.max(...(squad.crew ?? []).map((m) => Math.hypot(m.x - squad.x, m.y - squad.y)))
  check('sent across the river, it arrives with every member gathered round it again', Math.hypot(squad.x - b.x, squad.y - b.y) < 6 * TILE && far < 3 * TILE, `${Math.round(Math.hypot(squad.x - b.x, squad.y - b.y))} from its goal, members within ${Math.round(far)}`)
}

{
  // Through a gap one tile wide (a wall of buildings): the squad squeezes through in file, every
  // member gets through, and it fans out again in the open beyond.
  const field = groundMapDef('test-field')!
  const w = newWorld(field, [seat('republic', 0, 0), seat('droid', 1, 1)], { seed: 9, credits: 0 })
  const c0 = Math.floor(field.w / TILE / 2)
  const r0 = Math.floor(field.h / TILE / 2)
  // Depots three tiles high, stacked down the middle of the field, leaving one row open at r0.
  for (const r of [r0 - 12, r0 - 9, r0 - 6, r0 - 3, r0 + 1, r0 + 4, r0 + 7, r0 + 10]) raiseBuilding(w, UNIT['r-g-supply'], 0, c0, r)
  const y = (r0 + 0.5) * TILE
  const squad = spawn(w, TIER1.republic.foot, 0, (c0 - 8) * TILE, y, 0)
  const s = squad.t.ground!.squad!.spacing
  for (let t = 0; t < 60; t++) tick(w)
  runCmd(w, 0, cmd('move', [squad.id], (c0 + 12) * TILE, y, false, false))
  let inGap = 0
  let gapWidest = 0
  let beyond = 0
  for (let t = 0; t < 30 * 30; t++) {
    tick(w)
    w.events.length = 0
    const crew = squad.crew ?? []
    const ys = crew.map((m) => m.y)
    const width = Math.max(...ys) - Math.min(...ys)
    // Members inside the wall's columns.
    if (crew.some((m) => m.x > c0 * TILE && m.x < (c0 + 3) * TILE)) {
      inGap++
      gapWidest = Math.max(gapWidest, ...crew.filter((m) => m.x > c0 * TILE && m.x < (c0 + 3) * TILE).map((m) => Math.abs(m.y - y)))
    }
    if (crew.every((m) => m.x > (c0 + 4) * TILE)) beyond = Math.max(beyond, width)
  }
  const through = (squad.crew ?? []).every((m) => m.x > (c0 + 3) * TILE)
  check('through a gap one tile wide, the squad files through and every member gets past', inGap > 10 && gapWidest <= TILE / 2 + 1 && through, `${inGap} ticks in the gap, ${Math.round(gapWidest)} from its middle at most, ${through ? 'all' : 'not all'} through`)
  check('beyond the gap the squad fans out again', beyond > s * 1.5, `${Math.round(beyond)} wide`)
}

{
  // The same gap with the squad spread out: it still files through, every member gets past, and
  // fans out again (wider) beyond.
  const field = groundMapDef('test-field')!
  const w = newWorld(field, [seat('republic', 0, 0), seat('droid', 1, 1)], { seed: 9, credits: 0 })
  const c0 = Math.floor(field.w / TILE / 2)
  const r0 = Math.floor(field.h / TILE / 2)
  // Depots three tiles high, stacked down the middle of the field, leaving one row open at r0.
  for (const r of [r0 - 12, r0 - 9, r0 - 6, r0 - 3, r0 + 1, r0 + 4, r0 + 7, r0 + 10]) raiseBuilding(w, UNIT['r-g-supply'], 0, c0, r)
  const y = (r0 + 0.5) * TILE
  const squad = spawn(w, TIER1.republic.foot, 0, (c0 - 8) * TILE, y, 0)
  squad.spread = true
  const s = squad.t.ground!.squad!.spacing
  for (let t = 0; t < 60; t++) tick(w)
  runCmd(w, 0, cmd('move', [squad.id], (c0 + 12) * TILE, y, false, false))
  let inGap = 0
  let gapWidest = 0
  let beyond = 0
  for (let t = 0; t < 45 * 30; t++) {
    tick(w)
    w.events.length = 0
    const crew = squad.crew ?? []
    const ys = crew.map((m) => m.y)
    const width = Math.max(...ys) - Math.min(...ys)
    // Members inside the wall's columns.
    if (crew.some((m) => m.x > c0 * TILE && m.x < (c0 + 3) * TILE)) {
      inGap++
      gapWidest = Math.max(gapWidest, ...crew.filter((m) => m.x > c0 * TILE && m.x < (c0 + 3) * TILE).map((m) => Math.abs(m.y - y)))
    }
    if (crew.every((m) => m.x > (c0 + 4) * TILE)) beyond = Math.max(beyond, width)
  }
  const through = (squad.crew ?? []).every((m) => m.x > (c0 + 3) * TILE)
  check('spread out, through a gap one tile wide, the squad still files through and every member gets past', inGap > 10 && gapWidest <= TILE / 2 + 1 && through, `${inGap} ticks in the gap, ${Math.round(gapWidest)} from its middle at most, ${through ? 'all' : 'not all'} through`)
  check('spread out, beyond the gap it fans out again, wider', beyond > s * 2.5, `${Math.round(beyond)} wide`)
}

// --- 7. Spread out --------------------------------------------------------------------------------------

{
  // Two trooper squads: one spreads out at once, the other Shift-queues it behind a move; later the
  // first closes up. In step across two copies, a snapshot thaw and a replay.
  const make = (): Copy => ({ w: newWorld(groundMapDef('test-field')!, [seat('republic', 0, 0), seat('droid', 1, 1)], { seed: 71, credits: 0 }), brains: [] })
  const ids: number[] = []
  const at: Record<string, number> = {}
  let reachShut = 0
  let reachOpen = 0
  let waited = false
  const final = lockstep('spread battle', make, Math.round(40 / STEP), ({ w }, t, say) => {
    const x = w.w * 0.4
    const y = w.h / 2
    if (t === 1) {
      say({ t, k: 'spawn', unit: TIER1.republic.foot, owner: 0, x, y: y - 3 * TILE })
      say({ t, k: 'spawn', unit: TIER1.republic.foot, owner: 0, x, y: y + 3 * TILE })
    }
    if (t === 2) ids.push(...w.units.filter((u) => u.owner === 0 && u.t.ground?.squad).map((u) => u.id))
    if (t === 90) {
      reachShut = squadReach(w.byId.get(ids[0])!)
      say({ t, k: 'cmd', owner: 0, json: JSON.stringify(cmd('spread', [ids[0]], true, false)) })
      say({ t, k: 'cmd', owner: 0, json: JSON.stringify(cmd('move', [ids[1]], x + 8 * TILE, y + 3 * TILE, false, false)) })
      say({ t, k: 'cmd', owner: 0, json: JSON.stringify(cmd('spread', [ids[1]], true, true)) })
    }
    const b = w.byId.get(ids[1])
    if (t > 90 && b && b.order.k === 'move' && !b.spread) waited = true
    if (b?.spread && at.queued === undefined) at.queued = t
    if (t === 330) reachOpen = squadReach(w.byId.get(ids[0])!)
    if (t === 900) say({ t, k: 'cmd', owner: 0, json: JSON.stringify(cmd('spread', [ids[0]], false, false)) })
    w.events.length = 0
  })
  const a = final.w.byId.get(ids[0])!
  const b = final.w.byId.get(ids[1])!
  check('spread out: the squad spreads at once, its members walking out much wider, still together as one squad', reachOpen > reachShut * 2 && reachOpen < 2.5 * TILE, `members within ${Math.round(reachShut)} closed, ${Math.round(reachOpen)} spread`)
  check('spread out: Shift-queued behind a move, it waits for the move, then spreads', waited && !!b.spread && at.queued > 90, `spread at tick ${at.queued}`)
  check('spread out: used again it closes up, members back to their usual spacing', !a.spread && squadReach(a) < reachOpen * 0.8, `members within ${Math.round(squadReach(a))}`)
  // The spread flag is in the hash.
  const h = stateHash(final.w)
  b.spread = !b.spread
  check("spread out is in the hash", stateHash(final.w) !== h)
  b.spread = !b.spread
}

{
  // Evasion: the same artillery barrage on a squad spread out and on one closed up; the spread one
  // takes clearly less. Spread out it moves at SPREAD.speed of its pace.
  registerWeaponTest()
  const field = groundMapDef('test-field')!
  const taken = (spread: boolean) => {
    const w = newWorld(field, [seat('republic', 0, 0), seat('droid', 1, 1)], { seed: 72, credits: 0 })
    const cy = field.h / 2
    const sq = spawn(w, TIER1.republic.foot, 0, field.w * 0.5, cy, 0)
    sq.hull = sq.hullMax = 1e6
    sq.stance = 'hold'
    sq.guns.length = 0
    sq.spread = spread
    const art = spawn(w, testWeaponId('droid', 'artillery'), 1, field.w * 0.5 + 12 * TILE, cy, Math.PI)
    art.stance = 'hold'
    const swarm = spawn(w, testWeaponId('droid', 'swarm'), 1, field.w * 0.5 + 6 * TILE, cy + 2 * TILE, Math.PI)
    swarm.stance = 'hold'
    for (let t = 0; t < 60 * 30; t++) {
      tick(w)
      w.events.length = 0
    }
    return { lost: sq.hullMax - sq.hull, speed: speedOf(sq) }
  }
  const shut = taken(false)
  const open = taken(true)
  check('spread out: a squad spread out takes clearly less from splash', open.lost < shut.lost * 0.8 && shut.lost > 0, `${Math.round(open.lost)} against ${Math.round(shut.lost)} closed up`)
  check('spread out: it moves at its share of its pace', Math.abs(open.speed / shut.speed - SPREAD.speed) < 1e-9, `${(open.speed / shut.speed).toFixed(2)}`)
}

if (failed) {
  console.log('ground check FAILED')
  process.exit(1)
}
console.log('ground check passed: in sync')
