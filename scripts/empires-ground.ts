// Checks ground battles, which run in the space game's sim (sim.ts, with the terrain layer of
// ground/world.ts): headless, no browser, no server.
//
//   node scripts/empires-ground.ts [seconds]
//
// 1. The ground code uses no Math.random, Date, clock, DOM or engine-dependent maths.
// 2. Placement on Dustfall Ridge: every rule refuses somewhere with its own reason (unbuildable, a
//    crystal field, uneven ground, built on, blocking a door, too near the enemy (any building), enemy units on it, no room at its own door, credits), the ghost checks every tile, an
//    order to place there is refused with the same reason, and a building hidden in the fog doesn't
//    stop a placement.
// 3. A building battle on Dustfall Ridge, seat 0 scripted (Republic) and seat 1 the AI (Swarm), two
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
// 4. A crowd battle on Test Mesa (ground/testmaps.ts) with vehicles of every size class, many move
//    orders (queued and not, and stops) and buildings put up and destroyed mid-battle, some right on
//    top of units: two copies, a snapshot thaw and a replay in step for several thousand ticks; no
//    unit stays where it can't stand, none leaves the map or turns NaN.

import { readFileSync, readdirSync } from 'node:fs'
import { UNIT } from '../src/apps/games/empires/data.ts'
import { newBrain, think, type Brain } from '../src/apps/games/empires/ai.ts'
import { cleanCmd, cmd, runCmd, type Cmd } from '../src/apps/games/empires/commands.ts'
import { restoreBrain, restoreWorld, snapBrain, snapshotWorld } from '../src/apps/games/empires/snapshot.ts'
import { STEP, cantBuild, damage, newWorld, siteRefund, spawn, stateHash, tick, type Seat, type Unit, type World } from '../src/apps/games/empires/sim.ts'
import { anchorAt, footprintOpen, stands } from '../src/apps/games/empires/ground/nav.ts'
import { MESA } from '../src/apps/games/empires/ground/testmaps.ts'
import { CARRY, CLUSTERS_MAX, CLUSTERS_MIN, CREW_RATE, FIELD_KYBER, crystalAt, fieldLeft, footDist, groundMapDef, groundPlacement, raiseBuilding } from '../src/apps/games/empires/ground/world.ts'
import { TILE } from '../src/apps/games/empires/ground/types.ts'

const seconds = Number(process.argv[2] ?? 150)
let failed = false
const check = (what: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}${detail ? ` (${detail})` : ''}`)
  if (!ok) failed = true
}

// The checks' own test units (a vehicle of each size class, a small building).
import './ground-test-units.ts'

// --- 1. Sources -------------------------------------------------------------------------------------

{
  const dir = new URL('../src/apps/games/empires/ground/', import.meta.url)
  const sim = ['world.ts', 'nav.ts', 'fog.ts', 'think.ts']
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
const R = { engineer: 'r-g-engineer', center: 'r-g-center', supply: 'r-g-supply' }
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
  expect('door blocked', R.center, "It would block a building's door")
  expect('enemy near, any building', 'test-block', 'Too close to an enemy building (keep 20 tiles away)')
  {
    // No command range: a small building as far from our Command Center as the map allows (and still
    // away from the enemy) may go up.
    const far = find(w, 0, 'test-block', null, { x: home.x < w.w / 2 ? w.w : 0, y: home.y < w.h / 2 ? w.h * 0.5 : w.h * 0.5 })
    const tiles = far ? Math.hypot(far.x - home.x, far.y - home.y) / TILE : 0
    check('a building may go up far from our Command Centers (no command range)', !!far && tiles > 40, `${tiles.toFixed(0)} tiles out`)
  }
  expect('enemy near', R.center, 'Too close to an enemy building (keep 20 tiles away)')
  expect('own door', R.center, 'No room in front of its door')
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

function apply(w: World, x: Input): unknown {
  if (x.k === 'cmd') {
    const c = cleanCmd(JSON.parse(x.json), w)
    return c ? runCmd(w, x.owner, c) : 'junk'
  }
  if (x.k === 'add') return raiseBuilding(w, UNIT[x.unit], x.owner, x.c, x.r)
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
  const make = (): Copy => ({ w: newWorld(dustfall, [seat('republic', 0, 0), seat('swarm', 1, 1)], { seed: 99, credits: 6000 }), brains: [newBrain(1, 'medium')] })
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
      pass('engineers queue up to the unit cap, the next refused for supply', home.yq!.length === 4 && before - credits() === 600 && /^Needs more supply: build a Supply Depot/.test(cantBuild(w, 0, R.engineer, false, home.id) ?? ''), `queue ${home.yq!.length}, paid ${before - credits()}, ${cantBuild(w, 0, R.engineer, false, home.id)}`)
    }
    if (t === 45) {
      order(cmd('cancel', 3, home.id))
      pass('a cancelled queue item is refunded in full', home.yq!.length === 3 && credits() - before === 150)
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
  check('building battle: the AI built nothing but engineers, Command Centers and supply', ai.every((u) => u.t.id === S.center || u.t.id === S.engineer || u.t.id === S.supply))
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
    const dropped = w.players.reduce((a, q) => a + q.earnedBy.mines, 0)
    lostKyber = Math.max(lostKyber, Math.abs(FIELD_KYBER * fields.length - cheatGap - inFields - carried - dropped))
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
  check('economy battle: kyber is never made or lost (fields = dropped off + carried)', lostKyber < 1e-6, `largest gap ${lostKyber}`)
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

if (failed) {
  console.log('ground check FAILED')
  process.exit(1)
}
console.log('ground check passed: in sync')
