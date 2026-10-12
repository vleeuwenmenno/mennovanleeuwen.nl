// Checks the fleet inventory of Galactic conquest, headless: ship footprints on a fleet's grid
// (sizes by tier, stacking strike craft, placing, turning and moving items, full fleets), moves
// between fleets at a planet (whole items, parts of stacks, into new fleets), the cap of MAX_FLEETS
// fleets a side keeps at one planet (on arrival, from the shipyard, Gather and old saves) and what
// happens when the fleets there are full, ships held back in the reserve and how they reach a fleet
// battle and an auto-resolved one, fleets keeping their layout through a battle, and old saves
// (stacks without spots) laid out on load.
//
//   node scripts/empires-fleets.ts
//
// Every check prints a line; it exits with 1 if any of them failed.

import { generateMap, DEFAULT_RULES } from '../src/apps/games/empires/maps.ts'
import { newFleetBattle, type FleetSide } from '../src/apps/games/empires/sim.ts'
import * as G from '../src/apps/games/empires/galaxy.ts'
import type { Fleet, Galaxy, Item } from '../src/apps/games/empires/galaxy.ts'

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
const CELLS = G.GRID_W * G.GRID_H
/** Whether a fleet's layout is sound: inside the grid, nothing overlapping, stacks within STACK and
 * only of strike craft, footprints the right size, and Fleet.ships the same ships. */
function sound(f: Fleet) {
  const cells = new Set<string>()
  for (const i of f.items) {
    const foot = G.footprint(i.unit)
    if (!((i.w === foot.w && i.h === foot.h) || (i.w === foot.h && i.h === foot.w))) return `${i.unit} is ${i.w}x${i.h}`
    if (i.x < 0 || i.y < 0 || i.x + i.w > G.GRID_W || i.y + i.h > G.GRID_H) return `${i.unit} off the grid`
    if (i.n < 1 || i.n > (G.stacks(i.unit) ? G.STACK : 1)) return `${i.unit} stack of ${i.n}`
    for (let y = i.y; y < i.y + i.h; y++)
      for (let x = i.x; x < i.x + i.w; x++) {
        if (cells.has(`${x},${y}`)) return `overlap at ${x},${y}`
        cells.add(`${x},${y}`)
      }
  }
  const flat = f.items.flatMap((i) => Array<string>(i.n).fill(i.unit)).sort()
  const ships = [...f.ships].sort()
  if (flat.join() !== ships.join()) return 'ships and items disagree'
  return ''
}
/** A fleet's ships set from outside, laid out by the galaxy as the next tick would. */
const setShips = (g: Galaxy, f: Fleet, ships: string[]) => {
  f.ships = ships
  G.layoutFleets(g)
}
/** The most fleets any side has at any one planet right now. */
const most = (g: Galaxy) => {
  const m = new Map<string, number>()
  for (const f of g.fleets) if (!f.leg && !f.route.length && f.planet >= 0) m.set(`${f.owner}:${f.planet}`, (m.get(`${f.owner}:${f.planet}`) ?? 0) + 1)
  return Math.max(0, ...m.values())
}

/** A fresh campaign with the player's starting fleet swapped for 12 ships: a cruiser, a frigate,
 * 4 gunships and 6 fighter squadrons, at its capital. */
function campaign() {
  const g = G.newGalaxy({ choice: { kind: 'rim' }, size: 'standard', faction: 'republic', difficulty: 'easy', credits: 3000 })
  const f = g.fleets.find((x) => x.owner === 0)!
  setShips(g, f, ['r-cruiser', 'r-frigate', ...Array(4).fill('r-gunship'), ...Array(6).fill('r-fighter')])
  return { g, f, cap: f.planet }
}
const find = (f: Fleet, unit: string, held = false) => f.items.find((i) => i.unit === unit && !!i.held === held)!
const ref = (f: Fleet, i: Item) => ({ fleet: f.id, x: i.x, y: i.y })

// --- Footprints --------------------------------------------------------------------------------------
{
  const size = (u: string) => `${G.footprint(u).w}x${G.footprint(u).h}`
  const want: Record<string, string> = { 'r-fighter': '1x1', 'r-bomber': '1x1', 'r-repair': '1x1', 'r-gunship': '1x1', 'r-corvette': '1x2', 'r-frigate': '1x2', 'r-cruiser': '2x2', 'r-capital': '2x3', 'd-fighter': '1x1', 'd-gunship': '1x1', 'd-ion': '1x2', 'd-frigate': '1x2', 'd-cruiser': '2x2', 'd-capital': '2x3' }
  const wrong = Object.entries(want).filter(([u, s]) => size(u) !== s)
  check('footprints by tier (corvette as long as a frigate)', !wrong.length, wrong.map(([u]) => `${u} ${size(u)}`).join(', '))
  check('only strike craft stack', G.stacks('r-fighter') && G.stacks('r-bomber') && G.stacks('d-repair') && !G.stacks('r-gunship') && !G.stacks('r-frigate'))
  const full = G.pack([...Array(3).fill({ unit: 'r-capital' }), ...Array(18).fill({ unit: 'r-fighter' })])
  check('three dreadnoughts and six fighter stacks fill a fleet exactly', !full.rest.length && full.items.reduce((s, i) => s + i.w * i.h, 0) === CELLS)
  check('a fourth dreadnought finds no room', G.pack(Array(4).fill({ unit: 'r-capital' })).rest.length === 1)
  check('twelve frigates fill a fleet, a thirteenth does not fit', G.pack(Array(13).fill({ unit: 'r-frigate' })).rest.length === 1)
  const fighters = G.pack(Array(7).fill({ unit: 'd-fighter' }))
  check('fighters stack three to a cell', fighters.items.map((i) => i.n).join() === '3,3,1')
  check('frigates do not stack', G.pack(Array(3).fill({ unit: 'r-frigate' })).items.length === 3)
}

// --- Placing and moving items ----------------------------------------------------------------------------
{
  const { g, f, cap } = campaign()
  check('setup: the starting layout is sound', !sound(f) && f.items.length === 1 + 1 + 4 + 2, sound(f) || f.items.map((i) => `${i.unit}x${i.n}@${i.x},${i.y}`).join(' '))
  const fr = find(f, 'r-frigate')
  const freeSpot = G.spotFor(f.items, 1, 2)!
  const moved = G.moveItem(g, 0, ref(f, fr), { fleet: f.id, x: freeSpot.x, y: freeSpot.y })
  check('an item moves to a free spot', typeof moved !== 'string' && fr.x === freeSpot.x && fr.y === freeSpot.y && !sound(f))
  const cr = find(f, 'r-cruiser')
  const clash = G.moveItem(g, 0, ref(f, fr), { fleet: f.id, x: cr.x, y: cr.y })
  check('no spot that overlaps another ship', clash === 'No room there', String(clash))
  check('no spot off the grid', G.moveItem(g, 0, ref(f, fr), { fleet: f.id, x: G.GRID_W - 1, y: G.GRID_H - 1 }) === 'No room there')
  const side = G.spotFor(f.items, 2, 1)!
  const turned = G.moveItem(g, 0, ref(f, fr), { fleet: f.id, x: side.x, y: side.y, w: 2, h: 1 })
  check('a frigate turns on its side', typeof turned !== 'string' && fr.w === 2 && fr.h === 1 && !sound(f))
  check('no stretched footprints', G.moveItem(g, 0, ref(f, fr), { fleet: f.id, x: 0, y: 0, w: 2, h: 2 }) === "It doesn't fit that way")

  // Into a new fleet, and parts of stacks.
  const st = find(f, 'r-fighter')
  const nf = G.moveItem(g, 0, ref(f, st), { fleet: 'new' }, 2) as Fleet
  check('two squadrons of a stack make a new fleet', typeof nf !== 'string' && count(nf.ships, 'r-fighter') === 2 && count(f.ships, 'r-fighter') === 4 && here(g, 0, cap).length === 2)
  const back = G.moveItem(g, 0, ref(nf, nf.items[0]), { fleet: f.id, x: st.x, y: st.y }, 1)
  check('one squadron dropped on its stack joins it', typeof back !== 'string' && st.n === 2 && count(nf.ships, 'r-fighter') === 1)
  const other = f.items.find((i) => i.unit === 'r-fighter' && i !== st)!
  check('a full stack takes no more', other.n === 3 && G.moveItem(g, 0, ref(nf, nf.items[0]), { fleet: f.id, x: other.x, y: other.y }) === 'That stack is full')
  const gone = G.moveItem(g, 0, ref(nf, nf.items[0]), { fleet: f.id })
  check('a fleet that gives away its last ship is gone', typeof gone !== 'string' && !g.fleets.includes(nf) && here(g, 0, cap).length === 1 && st.n === 3)
  for (const unit of ['r-cruiser', 'r-frigate', 'r-gunship']) G.moveItem(g, 0, ref(f, find(f, unit)), { fleet: 'new' })
  check('four fleets at one planet', here(g, 0, cap).length === 4)
  const fifth = G.moveItem(g, 0, ref(f, find(f, 'r-gunship')), { fleet: 'new' })
  check('no fifth fleet', typeof fifth === 'string' && fifth.includes(`${G.MAX_FLEETS}`), String(fifth))
  check('ships kept count through the moves', total(here(g, 0, cap)) === 12 && here(g, 0, cap).every((x) => !sound(x)))

  // A full fleet.
  const big = here(g, 0, cap).find((x) => x.ships.includes('r-cruiser'))!
  setShips(g, big, Array(6).fill('r-cruiser'))
  check('setup: six cruisers fill a fleet', G.cellsUsed(big) === CELLS && !sound(big))
  const refused = G.moveItem(g, 0, ref(f, find(f, 'r-gunship')), { fleet: big.id })
  check('a full fleet takes nothing more', typeof refused === 'string' && refused.startsWith('No room'), String(refused))
  const merge = G.mergeFleets(g, 0, f.id, big.id)
  check('merging into a full fleet is refused', typeof merge === 'string' && merge.includes('full'), JSON.stringify(merge))

  // A fleet in flight keeps its ships to itself (but may change what it holds back).
  const flier = here(g, 0, cap).find((x) => x.ships.includes('r-frigate'))!
  G.moveFleet(g, 0, flier.id, g.planets.find((p) => p.system === g.planets[cap].system && p.id !== cap)!.id)
  const flying = G.moveItem(g, 0, ref(flier, flier.items[0]), { fleet: f.id })
  check('no moves out of a fleet in flight', typeof flying === 'string', String(flying))
  check('a fleet in flight can hold ships back', G.holdItem(g, 0, ref(flier, flier.items[0]), true) === null && G.heldOf(flier, 'r-frigate') === 1)
}

// --- Merging and arranging ---------------------------------------------------------------------------------
{
  const { g, f, cap } = campaign()
  const a = G.moveItem(g, 0, ref(f, find(f, 'r-cruiser')), { fleet: 'new' }) as Fleet
  setShips(g, a, [...Array(5).fill('r-cruiser')])
  // f: frigate, 4 gunships, 6 fighters = 2 + 4 + 2 = 8 cells; a: 5 cruisers = 20 cells, room for 4.
  const r = G.mergeFleets(g, 0, f.id, a.id)
  check('a merge moves what fits and leaves the rest', typeof r !== 'string' && r.left > 0 && g.fleets.includes(f) && G.cellsUsed(a) === CELLS, JSON.stringify(r))
  check('no ship lost in a part merge', total(here(g, 0, cap)) === 5 + 11 && here(g, 0, cap).every((x) => !sound(x)))
  // Arrange packs a messy layout.
  const { g: g2, f: f2 } = campaign()
  for (const i of f2.items) Object.assign(i, { x: -1 })
  f2.items = []
  setShips(g2, f2, ['r-frigate', 'r-frigate', 'r-cruiser', 'r-fighter'])
  const fr = f2.items.find((i) => i.unit === 'r-frigate')!
  G.moveItem(g2, 0, ref(f2, fr), { fleet: f2.id, ...G.spotFor(f2.items, 1, 2, fr)!, w: 1, h: 2 })
  check('arrange lays a fleet out afresh, biggest first', G.arrangeFleet(g2, 0, f2.id) === null && f2.items[0].unit === 'r-cruiser' && f2.items[0].x === 0 && f2.items[0].y === 0 && !sound(f2))
}

// --- Holding back, into a battle ---------------------------------------------------------------------
{
  const { g, f, cap } = campaign()
  G.holdItem(g, 0, ref(f, find(f, 'r-gunship')), true)
  G.holdItem(g, 0, ref(f, f.items.filter((i) => i.unit === 'r-gunship')[1]), true)
  for (const i of f.items.filter((x) => x.unit === 'r-fighter')) G.holdItem(g, 0, ref(f, i), true)
  check('held back counts', G.heldOf(f, 'r-gunship') === 2 && G.heldOf(f, 'r-fighter') === 6 && G.heldShips(f).length === 8)

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
  check('held back ships come in when nothing else is left', G.autoResolve(g, weak, 7).winner === 1)

  // After the battle the fleets keep their layout and what they hold back.
  const b = G.moveItem(g, 0, ref(f, find(f, 'r-cruiser')), { fleet: 'new' }) as Fleet
  const spots = f.items.map((i) => `${i.unit}@${i.x},${i.y}${i.held ? 'h' : ''}`).sort().join(' ')
  const c2 = G.clashAt(g, cap)!
  G.applyBattle(g, c2, { winner: 0, survivors: { 0: G.withoutShips(c2.holderShips, ['r-gunship', 'r-gunship']), 1: [] }, escaped: { 0: [], 1: [] }, stationLeft: true }, true)
  const after = f.items.map((i) => `${i.unit}@${i.x},${i.y}${i.held ? 'h' : ''}`).sort().join(' ')
  check('fleets come out of a battle as they went in', g.fleets.includes(f) && g.fleets.includes(b) && count(b.ships, 'r-cruiser') === 1 && count(f.ships, 'r-fighter') === 6 && G.heldOf(f, 'r-gunship') === 2 && count(f.ships, 'r-gunship') === 2)
  check('on the same spots of their grids (held back ones came through first)', after.split(' ').every((x) => spots.includes(x)) && !sound(f), after)
}

// --- The cap and full fleets: arrivals, the shipyard, Gather -------------------------------------------
{
  const { g, f, cap } = campaign()
  for (const id of ['r-cruiser', 'r-frigate', 'r-gunship']) G.moveItem(g, 0, ref(f, find(f, id)), { fleet: 'new' })
  check('setup: four fleets at the capital', here(g, 0, cap).length === 4)
  // A fifth flies in from the next planet over: it fits, so it folds in.
  const other = g.planets.find((p) => p.owner === 0 && p.id !== cap)!
  const fifth: Fleet = { id: g.nextId++, owner: 0, ships: ['r-frigate', 'r-frigate'], items: [], planet: other.id, system: other.system, from: other.id, leg: null, route: [], arrived: 0 }
  g.fleets.push(fifth)
  G.layoutFleets(g)
  G.moveFleet(g, 0, fifth.id, cap)
  for (let t = 0; t < 200 && g.fleets.includes(fifth); t += 0.5) G.tickGalaxy(g, 0.5)
  const fs = here(g, 0, cap)
  check('a fleet flying in to four joins those there when it fits', !g.fleets.includes(fifth) && fs.length === 4 && total(fs) === 14 && fs.every((x) => !sound(x)), fs.map((x) => x.ships.length).join(','))

  // Every fleet there full: a big fleet flying in stays a fleet of its own (over the cap).
  for (const x of fs) setShips(g, x, Array(6).fill('r-cruiser'))
  const sixth: Fleet = { id: g.nextId++, owner: 0, ships: Array(6).fill('r-cruiser'), items: [], planet: other.id, system: other.system, from: other.id, leg: null, route: [], arrived: 0 }
  g.fleets.push(sixth)
  G.layoutFleets(g)
  G.moveFleet(g, 0, sixth.id, cap)
  for (let t = 0; t < 200 && (sixth.leg || sixth.route.length); t += 0.5) G.tickGalaxy(g, 0.5)
  check('one that fits nowhere stays apart, past the cap', g.fleets.includes(sixth) && sixth.planet === cap && here(g, 0, cap).length === 5)
  check('no new fleet from the inventory while over the cap', typeof G.moveItem(g, 0, ref(sixth, sixth.items[0]), { fleet: 'new' }) === 'string' || here(g, 0, cap).length === 5)

  // The shipyard: with every fleet full and the cap reached, the finished ship waits on its slip.
  g.sides[0].credits = 20000
  check('the yard has no room', !G.yardRoom(g, 0, cap, 'r-fighter'))
  G.buildAt(g, 0, cap, 'r-fighter')
  G.buildAt(g, 0, cap, 'r-gunship')
  const yard = g.planets[cap]
  const events: string[] = []
  for (let t = 0; t < 60; t += 0.5) {
    G.tickGalaxy(g, 0.5)
    for (const e of g.events) events.push(e.k)
    g.events.length = 0
  }
  check('the finished ship waits on its slip, holding up the queue', yard.queue.length === 2 && yard.queue[0].full === true && yard.queue[0].left === 0 && here(g, 0, cap).length === 5 && total(here(g, 0, cap)) === 30)
  check('the player is told once', events.filter((k) => k === 'yardFull').length === 1)
  // A fleet leaves: the ship comes off the slip into the room it left.
  G.moveFleet(g, 0, sixth.id, other.id)
  const leaver = here(g, 0, cap).find((x) => x.ships.length === 6)!
  G.moveFleet(g, 0, leaver.id, other.id)
  for (let t = 0; t < 120 && yard.queue.length; t += 0.5) G.tickGalaxy(g, 0.5)
  const after = here(g, 0, cap)
  check('once there is room the yard carries on', !yard.queue.length && after.length === 4 && count(after.flatMap((x) => x.ships), 'r-fighter') === 1 && count(after.flatMap((x) => x.ships), 'r-gunship') === 1)

  // Ships from the yard join a fleet with room before making a new one.
  const { g: g3, f: f3, cap: cap3 } = campaign()
  g3.sides[0].credits = 10000
  G.buildAt(g3, 0, cap3, 'r-fighter')
  for (let t = 0; t < 100 && g3.planets[cap3].queue.length; t += 0.5) G.tickGalaxy(g3, 0.5)
  check('ships from the yard join a fleet there', here(g3, 0, cap3).length === 1 && count(f3.ships, 'r-fighter') === 7 && !sound(f3))
  setShips(g3, f3, Array(6).fill('r-cruiser'))
  G.buildAt(g3, 0, cap3, 'r-frigate')
  for (let t = 0; t < 100 && g3.planets[cap3].queue.length; t += 0.5) G.tickGalaxy(g3, 0.5)
  check('a full fleet there: the new ship starts a fleet of its own', here(g3, 0, cap3).length === 2 && G.cellsUsed(f3) === CELLS)

  // Gather: fleets meet and join up as far as there's room.
  const { g: g4, f: f4, cap: cap4 } = campaign()
  const parts = ['r-cruiser', 'r-frigate', 'r-gunship'].map((id) => G.moveItem(g4, 0, ref(f4, find(f4, id)), { fleet: 'new' }) as Fleet)
  for (const x of parts) {
    G.moveFleet(g4, 0, x.id, cap4)
    x.join = f4.id
  }
  G.tickGalaxy(g4, 0.5)
  check('Gather joins them up', here(g4, 0, cap4).length === 1 && total(here(g4, 0, cap4)) === 12)
  setShips(g4, f4, [...Array(5).fill('r-cruiser')])
  const extra = G.moveItem(g4, 0, ref(f4, f4.items[0]), { fleet: 'new' }) as Fleet
  setShips(g4, extra, [...Array(3).fill('r-cruiser'), 'r-frigate'])
  extra.join = f4.id
  G.tickGalaxy(g4, 0.5)
  check('Gather into a fleet without room for all: the rest stays a fleet', here(g4, 0, cap4).length === 2 && G.cellsUsed(f4) === CELLS && extra.join === undefined && total(here(g4, 0, cap4)) === 4 + 4)

  // Splits: held back ships go last, and keep their spots.
  const { g: g5, f: f5 } = campaign()
  const gs = f5.items.filter((i) => i.unit === 'r-gunship')
  G.holdItem(g5, 0, ref(f5, gs[0]), true)
  G.moveFleet(g5, 0, f5.id, other.id, ['r-gunship', 'r-gunship'])
  const sent = g5.fleets.find((x) => x.owner === 0 && x.leg)!
  check('a split takes ships that jump in first', !!sent && count(sent.ships, 'r-gunship') === 2 && G.heldOf(sent, 'r-gunship') === 0 && G.heldOf(f5, 'r-gunship') === 1 && !sound(sent) && !sound(f5))
}

// --- Old saves: stacks without spots ----------------------------------------------------------------------
{
  const { g, f, cap } = campaign()
  const sys = g.planets[cap].system
  // As saved before the grid: ships as a list, held back counts by type, no items.
  const raw = JSON.parse(JSON.stringify(g)) as Galaxy & { fleets: (Fleet & { items?: Item[] })[] }
  const old = raw.fleets.find((x) => x.id === f.id)!
  delete old.items
  old.ships = [...Array(4).fill('r-capital'), ...Array(5).fill('r-fighter')]
  old.reserve = { 'r-fighter': 2 }
  for (let i = 0; i < 5; i++) raw.fleets.push({ id: raw.nextId++, owner: 0, ships: ['r-gunship'], planet: cap, system: sys, from: cap, leg: null, route: [], arrived: i, ...(i === 0 ? { waypoints: [g.planets.find((p) => p.owner < 0)!.id] } : {}) } as Fleet)
  for (const s of raw.sides) delete s.intel
  store.set(`mvlos.empires.save.${g.save.id}`, JSON.stringify(raw))
  const back = G.loadSave(g.save.id)!
  const fs = here(back, 0, cap)
  const ships = fs.flatMap((x) => x.ships)
  check('an old save loads with every ship laid out', !!back && count(ships, 'r-capital') === 4 && count(ships, 'r-fighter') === 5 && count(ships, 'r-gunship') === 5 && fs.every((x) => !sound(x)), fs.map((x) => sound(x) || x.ships.length).join(','))
  check('held back counts become held back items', fs.reduce((n, x) => n + G.heldOf(x, 'r-fighter'), 0) === 2)
  check('the dreadnought that did not fit is a fleet of its own', fs.some((x) => x.ships.length === 1 && x.ships[0] === 'r-capital'))
  check('the fleet with orders is kept', fs.some((x) => x.waypoints?.length === 1))
  check('spare fleets fold in down to the cap where they fit', fs.length === G.MAX_FLEETS, `${fs.length} fleets`)
  check('the old save gets charts for the fog of war', back.sides.every((s) => Array.isArray(s.intel) && s.intel.length === back.planets.length && Array.isArray(s.sight)))
}

// --- The AI keeps to the grid and the cap over a whole campaign ------------------------------------------------
{
  for (const difficulty of ['easy', 'hard'] as const) {
    const g = G.newGalaxy({ choice: { kind: 'generated', seed: 23 }, size: 'standard', faction: 'republic', difficulty, credits: 3000 })
    let worst = 0
    let bad = ''
    let waits = 0
    for (let t = 0; t < 12 * G.WEEK * G.DAY && g.winner === -1; t += 0.5) {
      if (g.pending >= 0) G.settlePending(g, 'auto')
      G.tickGalaxy(g, 0.5)
      worst = Math.max(worst, most(g))
      for (const f of g.fleets) bad ||= sound(f)
      waits += g.events.filter((e) => e.k === 'yardFull' && e.owner === 1).length
      g.events.length = 0
    }
    check(`every fleet stays on its grid (${difficulty} AI, 12 weeks)`, !bad, bad)
    check(`no side ever has more than ${G.MAX_FLEETS} fleets at a planet (${difficulty} AI)`, worst <= G.MAX_FLEETS, `most: ${worst}`)
    check(`the AI doesn't build into full fleets (${difficulty} AI)`, waits === 0, `${waits} ships waited on a slip`)
  }
}

if (failed) {
  console.error(`${failed} check${failed > 1 ? 's' : ''} failed`)
  process.exit(1)
}
console.log('All fleet inventory checks passed')
