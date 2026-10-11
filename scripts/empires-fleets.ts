// Checks the fleet inventory of Galactic conquest, headless: ships moved between fleets at a
// planet (whole stacks, parts of them, into new fleets), the cap of MAX_FLEETS fleets a side keeps
// at one planet (on arrival, from the shipyard, and on old saves), ships held back in the reserve
// and how they reach a fleet battle and an auto-resolved one, and fleets keeping their make-up
// through a battle.
//
//   node scripts/empires-fleets.ts
//
// Every check prints a line; it exits with 1 if any of them failed.

import { generateMap, DEFAULT_RULES } from '../src/apps/games/empires/maps.ts'
import { newFleetBattle, type FleetSide } from '../src/apps/games/empires/sim.ts'
import * as G from '../src/apps/games/empires/galaxy.ts'
import type { Fleet, Galaxy } from '../src/apps/games/empires/galaxy.ts'

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

let failed = 0
const check = (what: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `: ${detail}` : ''}`)
  if (!ok) failed++
}
const count = (ships: string[], id: string) => ships.filter((x) => x === id).length
const here = (g: Galaxy, o: number, planet: number) => G.fleetsHere(g, o, planet)
const total = (fs: Fleet[]) => fs.reduce((n, f) => n + f.ships.length, 0)
/** The most fleets any side has at any one planet right now. */
const most = (g: Galaxy) => {
  const m = new Map<string, number>()
  for (const f of g.fleets) if (!f.leg && !f.route.length && f.planet >= 0) m.set(`${f.owner}:${f.planet}`, (m.get(`${f.owner}:${f.planet}`) ?? 0) + 1)
  return Math.max(0, ...m.values())
}

/** A fresh campaign with the player's starting fleet swapped for the one in the screenshot: 12
 * ships, a cruiser, a frigate, 4 gunships and 6 fighter squadrons, at its capital. */
function campaign() {
  const g = G.newGalaxy({ choice: { kind: 'rim' }, size: 'standard', faction: 'republic', difficulty: 'easy', credits: 3000 })
  const f = g.fleets.find((x) => x.owner === 0)!
  f.ships = ['r-cruiser', 'r-frigate', ...Array(4).fill('r-gunship'), ...Array(6).fill('r-fighter')]
  return { g, f, cap: f.planet }
}

// --- Moving ships between fleets ---------------------------------------------------------------------
{
  const { g, f, cap } = campaign()
  const a = G.shiftShips(g, 0, { fleet: f.id, held: false }, { fleet: 'new', held: false }, 'r-fighter', 3)
  check('a part of a stack makes a new fleet', typeof a !== 'string' && a.ships.length === 3 && count(f.ships, 'r-fighter') === 3 && here(g, 0, cap).length === 2)
  const b = a as Fleet
  G.shiftShips(g, 0, { fleet: f.id, held: false }, { fleet: b.id, held: false }, 'r-fighter', 99)
  check('a whole stack moves and stacks with the same kind there', count(b.ships, 'r-fighter') === 6 && count(f.ships, 'r-fighter') === 0)
  G.shiftShips(g, 0, { fleet: f.id, held: false }, { fleet: b.id, held: false }, 'r-gunship', Math.ceil(4 / 2))
  check('half a stack moves', count(b.ships, 'r-gunship') === 2 && count(f.ships, 'r-gunship') === 2)
  const c = G.shiftShips(g, 0, { fleet: f.id, held: false }, { fleet: 'new', held: false }, 'r-cruiser', 1) as Fleet
  const d = G.shiftShips(g, 0, { fleet: f.id, held: false }, { fleet: 'new', held: false }, 'r-frigate', 1) as Fleet
  check('four fleets at one planet', here(g, 0, cap).length === 4 && typeof c !== 'string' && typeof d !== 'string')
  const e = G.shiftShips(g, 0, { fleet: b.id, held: false }, { fleet: 'new', held: false }, 'r-fighter', 1)
  check('no fifth fleet', typeof e === 'string' && e.includes(`${G.MAX_FLEETS}`), String(e))
  check('ships kept count through the moves', total(here(g, 0, cap)) === 12)
  const r = G.shiftShips(g, 0, { fleet: c.id, held: false }, { fleet: d.id, held: false }, 'r-cruiser', 1)
  check('a fleet that gives away its last ship is gone', typeof r !== 'string' && !g.fleets.includes(c) && here(g, 0, cap).length === 3)
  check('merging joins two fleets whole', G.mergeFleets(g, 0, d.id, f.id) === null && !g.fleets.includes(d) && count(f.ships, 'r-cruiser') === 1 && here(g, 0, cap).length === 2)

  // A fleet in flight keeps its ships to itself (but may change what it holds back).
  G.moveFleet(g, 0, b.id, g.planets.find((p) => p.system === g.planets[cap].system && p.id !== cap)!.id)
  const flying = G.shiftShips(g, 0, { fleet: b.id, held: false }, { fleet: f.id, held: false }, 'r-fighter', 1)
  check('no moves out of a fleet in flight', typeof flying === 'string', String(flying))
  check('a fleet in flight can hold ships back', G.holdBack(g, 0, b.id, 'r-fighter', 2) === null && G.heldOf(b, 'r-fighter') === 2)
}

// --- Holding back, into a battle ---------------------------------------------------------------------
{
  const { g, f, cap } = campaign()
  G.shiftShips(g, 0, { fleet: f.id, held: false }, { fleet: f.id, held: true }, 'r-gunship', 2)
  G.holdBack(g, 0, f.id, 'r-fighter', 6)
  check('held back counts', G.heldOf(f, 'r-gunship') === 2 && G.heldOf(f, 'r-fighter') === 6 && G.heldShips(f).length === 8)
  check('never more held back than there are', G.holdBack(g, 0, f.id, 'r-frigate', 5) === null && G.heldOf(f, 'r-frigate') === 1)
  G.holdBack(g, 0, f.id, 'r-frigate', 0)

  // An enemy fleet arrives: the battle's sides hold the held back ships apart.
  const enemy = g.fleets.find((x) => x.owner === 1)!
  enemy.planet = cap
  enemy.system = g.planets[cap].system
  enemy.arrived = g.time + 1
  const c = G.clashAt(g, cap)!
  check('the battle knows what we hold back', !!c && c.holder === 0 && c.holderHeld.length === 8 && c.holderShips.length === 12 && c.attackerHeld.length === 0)
  const sides: FleetSide[] = [
    { faction: 'republic', team: 0, ships: G.withoutShips(c.holderShips, c.holderHeld), reserve: c.holderHeld, station: c.station },
    { faction: 'droid', team: 1, ships: G.withoutShips(c.attackerShips, c.attackerHeld), reserve: c.attackerHeld },
  ]
  const map = generateMap({ ...DEFAULT_RULES, seed: 5, players: 2, size: 'small', beacons: 0, wrecks: 'none' })
  const w = newFleetBattle(map, sides, { seed: 5 })
  const reserve = w.players[0].reserve
  const fieldIds = w.units.filter((u) => u.owner === 0 && u.t.tier !== 'station' && !u.parent).map((u) => u.t.id)
  check('held back ships start in the battle reserve', count(reserve, 'r-gunship') === 2 && count(reserve, 'r-fighter') === 6, reserve.join(' '))
  check('the rest jump in', fieldIds.includes('r-cruiser') && fieldIds.includes('r-frigate') && !fieldIds.includes('r-fighter') && count(fieldIds, 'r-gunship') === 2, fieldIds.join(' '))

  // Auto-resolve: held back ships count, but come in late.
  const res = G.autoResolve(g, c, 3)
  check('auto-resolve settles a battle with ships held back', res.winner === 0 || res.winner === 1)
  const strong: G.Clash = { planet: cap, holder: 0, attacker: 1, station: 3, holderShips: [...Array(6).fill('r-cruiser'), 'r-frigate', 'r-frigate'], holderHeld: ['r-frigate', 'r-frigate'], attackerShips: ['d-fighter'], attackerHeld: [] }
  const quick = G.autoResolve(g, strong, 7)
  check('held back ships stay out of a battle won before they are called in', quick.winner === 0 && count(quick.survivors[0], 'r-frigate') === 2)
  const weak: G.Clash = { ...strong, holderShips: ['r-fighter', 'r-frigate'], holderHeld: ['r-frigate'], station: 0, attackerShips: Array(6).fill('d-cruiser') }
  const late = G.autoResolve(g, weak, 7)
  check('held back ships come in when nothing else is left', late.winner === 1)
  let held = 0
  let all = 0
  const even: G.Clash = { planet: cap, holder: 0, attacker: 1, station: 0, holderShips: ['r-cruiser', 'r-frigate', 'r-frigate', ...Array(4).fill('r-gunship')], holderHeld: [], attackerShips: ['d-cruiser', 'd-frigate', 'd-frigate', ...Array(4).fill('d-gunship')], attackerHeld: [] }
  for (let i = 0; i < 40; i++) {
    if (G.autoResolve(g, even, i * 3.1).winner === 0) all++
    if (G.autoResolve(g, { ...even, holderHeld: ['r-frigate', 'r-frigate'] }, i * 3.1).winner === 0) held++
  }
  check('holding back costs a little in auto-resolve, not everything', held <= all && held > 0, `won ${all}/40 deploying all, ${held}/40 holding 2 frigates back`)

  // After the battle the fleets keep their make-up and what they hold back.
  const b = G.shiftShips(g, 0, { fleet: f.id, held: false }, { fleet: 'new', held: false }, 'r-cruiser', 1) as Fleet
  const c2 = G.clashAt(g, cap)!
  G.applyBattle(g, c2, { winner: 0, survivors: { 0: G.withoutShips(c2.holderShips, ['r-fighter', 'r-fighter']), 1: [] }, escaped: { 0: [], 1: [] }, stationLeft: true }, true)
  check('fleets come out of a battle as they went in', g.fleets.includes(f) && g.fleets.includes(b) && count(b.ships, 'r-cruiser') === 1 && count(f.ships, 'r-fighter') === 4 && G.heldOf(f, 'r-fighter') === 4 && G.heldOf(f, 'r-gunship') === 2)
}

// --- The cap: arrivals, the shipyard, Gather -------------------------------------------------------
{
  const { g, f, cap } = campaign()
  for (const id of ['r-cruiser', 'r-frigate', 'r-gunship']) G.shiftShips(g, 0, { fleet: f.id, held: false }, { fleet: 'new', held: false }, id, 99)
  check('setup: four fleets at the capital', here(g, 0, cap).length === 4)
  // A fifth flies in from the next planet over.
  const other = g.planets.find((p) => p.owner === 0 && p.id !== cap)!
  const fifth: Fleet = { id: g.nextId++, owner: 0, ships: ['r-frigate', 'r-frigate'], planet: other.id, system: other.system, from: other.id, leg: null, route: [], arrived: 0 }
  g.fleets.push(fifth)
  G.moveFleet(g, 0, fifth.id, cap)
  for (let t = 0; t < 200 && g.fleets.includes(fifth); t++) G.tickGalaxy(g, 0.5)
  const fs = here(g, 0, cap)
  check('a fleet flying in to four joins the biggest', !g.fleets.includes(fifth) && fs.length === 4 && total(fs) === 14 && count(f.ships, 'r-frigate') === 2, fs.map((x) => x.ships.length).join(','))
  // The shipyard adds to a fleet already there.
  g.sides[0].credits = 10000
  G.buildAt(g, 0, cap, 'r-fighter')
  for (let t = 0; t < 100 && g.planets[cap].queue.length; t++) G.tickGalaxy(g, 0.5)
  check('ships from the yard join a fleet there', here(g, 0, cap).length === 4 && total(here(g, 0, cap)) === 15)
  // Gather: the fleets meet and join up.
  const ours = here(g, 0, cap)
  for (const x of ours.slice(1)) {
    G.moveFleet(g, 0, x.id, cap)
    x.join = ours[0].id
  }
  G.tickGalaxy(g, 0.5)
  check('Gather joins them up', here(g, 0, cap).length === 1 && total(here(g, 0, cap)) === 15)
  // A split off part that would stay where it is makes no new fleet.
  G.moveFleet(g, 0, ours[0].id, cap, ['r-fighter'])
  check('no split that stays put', here(g, 0, cap).length === 1)
  // A split sent off takes held back ships last, and keeps them held back.
  G.holdBack(g, 0, ours[0].id, 'r-gunship', 3)
  G.moveFleet(g, 0, ours[0].id, other.id, ['r-gunship', 'r-gunship'])
  const sent = g.fleets.find((x) => x.owner === 0 && x.leg)!
  check('a split takes ships that jump in first', !!sent && count(sent.ships, 'r-gunship') === 2 && G.heldOf(sent, 'r-gunship') === 1 && G.heldOf(ours[0], 'r-gunship') === 2)
}

// --- Old saves with more fleets than the cap ------------------------------------------------------------
{
  const { g, f, cap } = campaign()
  const sys = g.planets[cap].system
  for (let i = 0; i < 5; i++) g.fleets.push({ id: g.nextId++, owner: 0, ships: ['r-gunship'], planet: cap, system: sys, from: cap, leg: null, route: [], arrived: i, ...(i === 0 ? { waypoints: [g.planets.find((p) => p.owner < 0)!.id] } : {}) })
  const withOrders = g.fleets[g.fleets.length - 5]
  check('setup: six fleets at the capital', here(g, 0, cap).length === 6)
  G.saveGalaxy(g)
  const back = G.loadSave(g.save.id)!
  const fs = here(back, 0, cap)
  check('an old save merges down to four', fs.length === G.MAX_FLEETS && total(fs) === 17, fs.map((x) => x.ships.length).join(','))
  check('the fleet with orders is kept', fs.some((x) => x.id === withOrders.id && x.waypoints?.length === 1))
  check('the biggest fleet takes the spare ships', fs.some((x) => x.id === f.id && x.ships.length > 12))
}

// --- The AI keeps to the cap over a whole campaign ------------------------------------------------------------
{
  for (const difficulty of ['easy', 'hard'] as const) {
    const g = G.newGalaxy({ choice: { kind: 'generated', seed: 23 }, size: 'standard', faction: 'republic', difficulty, credits: 3000 })
    let worst = 0
    for (let t = 0; t < 12 * G.WEEK * G.DAY && g.winner === -1; t += 0.5) {
      if (g.pending >= 0) G.settlePending(g, 'auto')
      G.tickGalaxy(g, 0.5)
      worst = Math.max(worst, most(g))
    }
    check(`no side ever has more than ${G.MAX_FLEETS} fleets at a planet (${difficulty} AI, 12 weeks)`, worst <= G.MAX_FLEETS, `most: ${worst}`)
  }
}

if (failed) {
  console.error(`${failed} check${failed > 1 ? 's' : ''} failed`)
  process.exit(1)
}
console.log('All fleet inventory checks passed')
