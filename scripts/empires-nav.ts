// Checks that the biggest warships of every faction can get everywhere that matters on every map:
// headless, no browser, no server.
//
//   node scripts/empires-nav.ts          (add --verbose for every map's numbers)
//
// 1. Reachability: on every built-in map (with its own seed and a few match seeds, since a match
//    scatters its rocks from the match's seed) and a few dozen generated maps of every player
//    count and size, the biggest hull of each faction can reach every spawn, beacon and ore from
//    every spawn, on the path finding's own grid for that hull. Rocks are the only walls: asteroid
//    fields and nebulas cost extra to cross but never block.
// 2. Routes: on Twin Reefs (four corners, rocks round the middle, fields and nebulas in every
//    quarter), a flagship of each faction flown from every spawn to the spawns beside and across
//    from it arrives, by a sensible route (flown distance against the straight line).
// 3. A ship sent somewhere it can't get to (a spot walled in by rocks) stops at the nearest point
//    it can reach rather than flying at the rocks for good.
// 4. Path finding stays cheap: the time per path and per grid on the biggest map.

import { FACTION_IDS, UNITS, isShip, type UnitType } from '../src/apps/games/empires/data.ts'
import { MAP, MAPS, PLAYER_COUNTS, generateMap, inside, type MapDef, type MapRules, type MapSize } from '../src/apps/games/empires/maps.ts'
import * as S from '../src/apps/games/empires/sim.ts'
import { STEP, cmdMove, newWorld, radius, spawn, tick, type World } from '../src/apps/games/empires/sim.ts'
import { findPath, navGrid, type NavGrid } from '../src/apps/games/empires/nav.ts'

const verbose = process.argv.includes('--verbose')
let failed = false
const check = (what: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}${detail ? ` (${detail})` : ''}`)
  if (!ok) failed = true
}

type Circle = { x: number; y: number; r: number }
// What the sim's path finding works with. Read from the sim when it says (so this checks the real
// thing); the old fixed values otherwise, so the check can be run against an older sim too.
const sim = S as unknown as { navClear?: (t: UnitType) => number; navRocks?: (w: World) => Circle[] }
const clearOf = (t: UnitType) => (sim.navClear ? sim.navClear(t) : Math.ceil((radius(t) * 0.7 + 20) / 20) * 20)
const rocksOf = (w: World): Circle[] => (sim.navRocks ? sim.navRocks(w) : w.rocks)

/** The biggest warship of each faction: the hull that has the hardest time getting through. */
const BIG = FACTION_IDS.map((f) => UNITS.filter((t) => t.faction === f && isShip(t) && t.tier !== 'fighter').sort((a, b) => radius(b) - radius(a))[0])

function worldOf(map: MapDef, seed?: number): World {
  return newWorld(map, map.spawns.map((_, i) => ({ faction: FACTION_IDS[i % FACTION_IDS.length], team: i, spawn: i })), { seed })
}

/** Labels each free cell with the connected piece of open space it belongs to (8-way, no cutting
 * corners past a blocked cell, as the path finding moves). */
function pieces(g: NavGrid) {
  const { cols, rows, blocked } = g
  const label = new Int32Array(cols * rows).fill(-1)
  let n = 0
  const stack: number[] = []
  for (let s = 0; s < label.length; s++) {
    if (blocked[s] || label[s] >= 0) continue
    label[s] = n
    stack.push(s)
    while (stack.length) {
      const i = stack.pop()!
      const c = i % cols
      const r = (i - c) / cols
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          const nc = c + dc
          const nr = r + dr
          if ((!dc && !dr) || nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue
          const j = nr * cols + nc
          if (blocked[j] || label[j] >= 0) continue
          if (dc && dr && (blocked[r * cols + nc] || blocked[nr * cols + c])) continue
          label[j] = n
          stack.push(j)
        }
    }
    n++
  }
  return label
}

/** The piece of open space nearest (x, y) within `tol`, or -1. */
function pieceNear(g: NavGrid, label: Int32Array, cell: number, x: number, y: number, tol: number, want?: number) {
  let best = -1
  let bestD = tol * tol
  for (let i = 0; i < label.length; i++) {
    if (label[i] < 0 || (want !== undefined && label[i] !== want)) continue
    const c = i % g.cols
    const cx = (c + 0.5) * cell
    const cy = ((i - c) / g.cols + 0.5) * cell
    const d = (cx - x) ** 2 + (cy - y) ** 2
    if (d <= bestD) {
      bestD = d
      best = label[i]
    }
  }
  return best
}

type Problem = string
/** Every spawn, beacon and ore a big hull can't reach from some spawn on this world. */
function unreachable(w: World): Problem[] {
  const out: Problem[] = []
  const rocks = rocksOf(w)
  const seen = new Set<number>()
  for (const t of BIG) {
    const clear = clearOf(t)
    if (seen.has(clear)) continue
    seen.add(clear)
    const g = navGrid(rocks, w.w, w.h, clear)
    const cell = w.w / g.cols
    const label = pieces(g)
    const targets = [
      ...w.map.spawns.map((p, i) => ({ ...p, what: `spawn ${i + 1}`, tol: 700 })),
      ...w.map.beacons.map((p, i) => ({ ...p, what: `beacon ${i + 1}`, tol: 350 })),
      ...w.map.ore.map((p, i) => ({ ...p, what: `ore ${i + 1}`, tol: 350 })),
    ]
    w.map.spawns.forEach((s, si) => {
      const from = pieceNear(g, label, cell, s.x, s.y, 700)
      if (from < 0) {
        out.push(`${t.name} can't leave spawn ${si + 1}`)
        return
      }
      for (const p of targets) if (pieceNear(g, label, cell, p.x, p.y, p.tol, from) < 0) out.push(`${t.name}: spawn ${si + 1} to ${p.what}`)
    })
  }
  return [...new Set(out)]
}

// --- 1. Reachability ---------------------------------------------------------------------------------

const MATCH_SEEDS = [11, 4242, 90001]
const builtIn: [string, World][] = []
for (const m of MAPS) {
  builtIn.push([`${m.name} (own seed)`, worldOf(m)])
  for (const s of MATCH_SEEDS) builtIn.push([`${m.name} (match seed ${s})`, worldOf(m, s)])
}
const SIZES: MapSize[] = ['small', 'medium', 'large']
const generated: [string, World][] = []
for (let seed = 1; seed <= 12; seed++)
  for (const players of PLAYER_COUNTS) {
    const amount = (['none', 'few', 'many'] as const)[seed % 3]
    const rules: MapRules = { seed, players, size: SIZES[(seed + players) % 3], resources: (['scarce', 'normal', 'rich'] as const)[seed % 3], beacons: 'auto', asteroidFields: amount, nebulas: (['many', 'few', 'none'] as const)[seed % 3], wrecks: 'few' }
    generated.push([`generated ${players}p ${rules.size} seed ${seed}`, worldOf(generateMap(rules))])
  }

let bad = 0
for (const [name, w] of [...builtIn, ...generated]) {
  const p = unreachable(w)
  if (p.length) {
    bad++
    console.log(`  ${name}: ${p.length} unreachable, e.g. ${p.slice(0, 3).join('; ')}`)
  } else if (verbose) console.log(`  ${name}: all reachable`)
}
check(`biggest hulls reach every spawn, beacon and ore on ${builtIn.length} built-in and ${generated.length} generated battles`, bad === 0, `${bad} with gaps`)

// --- 2. Routes on Twin Reefs ---------------------------------------------------------------------------

/** Flies `t` from spawn `a` towards spawn `b` on an empty copy of the map (rocks, fields and nebulas
 * kept, nothing else): seconds taken (or -1), flown distance over the straight line. */
function fly(map: MapDef, id: string, a: number, b: number) {
  const w = worldOf(map)
  w.units = []
  w.byId.clear()
  w.arrivals = []
  const s = map.spawns[a]
  const e = map.spawns[b]
  const c = { x: map.w / 2, y: map.h / 2 }
  // Start just out from the station, towards the middle, where a flagship comes off its yard.
  const toward = (p: { x: number; y: number }, q: { x: number; y: number }, d: number) => {
    const l = Math.hypot(q.x - p.x, q.y - p.y) || 1
    return { x: p.x + ((q.x - p.x) / l) * d, y: p.y + ((q.y - p.y) / l) * d }
  }
  const from = toward(s, c, 500)
  const to = toward(e, c, 500)
  const u = spawn(w, id, 0, from.x, from.y, Math.atan2(to.y - from.y, to.x - from.x))
  cmdMove(w, 0, [u.id], to.x, to.y)
  const straight = Math.hypot(u.order.k === 'move' ? u.order.x - u.x : 0, u.order.k === 'move' ? u.order.y - u.y : 0)
  let flown = 0
  let px = u.x
  let py = u.y
  let field = 0
  const limit = Math.round((straight / Math.max(1, S.speedOf(u)) * 4 + 30) / STEP)
  for (let i = 0; i < limit; i++) {
    tick(w)
    w.events.length = 0
    flown += Math.hypot(u.x - px, u.y - py)
    px = u.x
    py = u.y
    if (inside(map.fields, u.x, u.y)) field += STEP
    if (u.order.k === 'idle') return { secs: i * STEP, ratio: flown / straight, field }
  }
  return { secs: -1, ratio: flown / straight, field }
}

const reefs = MAP.reefs
const pairs: [number, number][] = [[0, 1], [0, 2], [0, 3], [1, 2], [3, 0], [2, 1]]
let worst = 0
let stuck = 0
let sum = 0
let n = 0
for (const t of BIG) {
  const line: string[] = []
  for (const [a, b] of pairs) {
    const r = fly(reefs, t.id, a, b)
    if (r.secs < 0) stuck++
    worst = Math.max(worst, r.ratio)
    sum += r.ratio
    n++
    line.push(`${a + 1}>${b + 1} ${r.secs < 0 ? 'STUCK' : `${Math.round(r.secs)}s`} x${r.ratio.toFixed(2)}${r.field ? ` (${Math.round(r.field)}s in fields)` : ''}`)
  }
  console.log(`  ${t.name}: ${line.join(', ')}`)
}
check('flagships cross Twin Reefs to every other spawn', stuck === 0, `${stuck} of ${n} didn't arrive`)
check('by a sensible route', worst < 1.6, `flown/straight mean ${(sum / n).toFixed(2)}, worst ${worst.toFixed(2)}`)

// --- 3. Somewhere it can't get to ----------------------------------------------------------------------

{
  const w = worldOf(reefs)
  w.units = []
  w.byId.clear()
  w.arrivals = []
  // A ring of rocks round an empty spot, far too tight for a flagship.
  const at = { x: reefs.w / 2, y: reefs.h * 0.3 }
  w.rocks = Array.from({ length: 10 }, (_, i) => ({ x: at.x + Math.cos(i * 0.628) * 420, y: at.y + Math.sin(i * 0.628) * 420, r: 130, rot: 0, spin: 0, kind: 0 }))
  w.nav.clear()
  w.map = { ...w.map, fields: [], nebulas: [] }
  const u = spawn(w, BIG[0].id, 0, at.x - 2200, at.y, 0)
  cmdMove(w, 0, [u.id], at.x, at.y)
  let done = -1
  let inside = 0
  for (let i = 0; i < Math.round(90 / STEP); i++) {
    tick(w)
    w.events.length = 0
    for (const k of w.rocks) if (Math.hypot(u.x - k.x, u.y - k.y) < k.r * 0.8 + radius(u.t) * 0.3) inside++
    if (u.order.k === 'idle' && done < 0) done = i * STEP
  }
  const off = Math.hypot(u.x - at.x, u.y - at.y)
  check('a flagship sent into a walled-in spot stops outside the wall', done >= 0 && off < 1400 && u.v < 5, `${done < 0 ? 'still going' : `stopped after ${Math.round(done)}s`}, ${Math.round(off)} from the spot`)
  check('without ploughing into the rocks', inside === 0, `${inside} ticks deep in a rock`)
}

// --- 4. Cost ---------------------------------------------------------------------------------------------

{
  const big = [...MAPS].sort((a, b) => b.w * b.h - a.w * a.h)[0]
  const w = worldOf(big)
  const rocks = rocksOf(w)
  const clear = clearOf(BIG[0])
  let t0 = performance.now()
  const grids = 20
  for (let i = 0; i < grids; i++) navGrid(rocks, w.w, w.h, clear)
  const gridMs = (performance.now() - t0) / grids
  const g = navGrid(rocks, w.w, w.h, clear)
  const pts = [...big.spawns, ...big.beacons, ...big.ore]
  t0 = performance.now()
  let paths = 0
  for (const a of pts)
    for (const b of pts) {
      if (a === b) continue
      findPath(g, rocks, clear, a.x, a.y, b.x, b.y)
      paths++
    }
  const pathMs = (performance.now() - t0) / paths
  console.log(`  ${big.name} (${w.w}x${w.h}, ${w.rocks.length} rocks): grid ${gridMs.toFixed(2)} ms, path ${pathMs.toFixed(3)} ms (${paths} paths)`)
  check('path finding stays cheap', gridMs < 20 && pathMs < 5, `grid ${gridMs.toFixed(2)} ms, path ${pathMs.toFixed(3)} ms`)
}

console.log(failed ? 'FAILED' : 'all passed')
process.exit(failed ? 1 : 0)
