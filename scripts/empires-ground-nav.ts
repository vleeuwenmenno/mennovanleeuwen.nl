// Checks the ground battle's path finding and fog: headless, no browser, no server.
//
//   node scripts/empires-ground-nav.ts
//
// On Test Mesa (ground/testmaps.ts: a plateau with one ramp, a knoll with its own, a lake, pockets
// behind a 1-tile and a 2-tile gap, a walled-in ring):
// 1. Clearance: every spot a unit of each size class can stand on has that many tiles square of open
//    ground with no cliff through it, worked out here apart from nav.ts; vehicles (2 tiles) stay out
//    of the pocket behind the 1-tile gap and get into the one behind the 2-tile gap, which the large
//    class (3) can't.
// 2. Ramps and cliffs: paths from low ground onto the plateau and the knoll, for every class, go up
//    the ramps and never step across a cliff, a blocked tile or water; a rover driven up in the sim
//    gets there without ever crossing a cliff between two ticks.
// 3. Buildings: a footprint stamped over the ramp's foot cuts the plateau off (once flushed, not
//    before), and taking it off opens the way again.
// 4. A walled-in goal: the way ends at the reachable spot nearest it, and no reachable spot is nearer.
// 5. Fog: the height rule (low ground sees the plateau's edge row but not past it, the plateau sees
//    the knoll's edge, a ramp sees from its top), explored memory, and eyes back to zero.
// 6. Path finding stays cheap: time per path on the test map.
// Then, when the terrain generator is in (ground/terrain.ts), every ground map: each size class gets
// from every spawn to every other spawn and deposit.

import { TF, TILE, type GroundMap, type TileGrid } from '../src/apps/games/empires/ground/types.ts'
import { MESA, testMesa } from '../src/apps/games/empires/ground/testmaps.ts'
import { NAV_CLASSES, anchorAt, findPath, flushStamps, lineOk, newNav, spotOf, stampFootprint, stands, type GroundNav, type NavClass } from '../src/apps/games/empires/ground/nav.ts'
import { dropEye, explored, newFog, placeEye, sees, type Eye } from '../src/apps/games/empires/ground/fog.ts'
import { STEP, cmdMove, newGroundWorld, spawnUnit, tick } from '../src/apps/games/empires/ground/sim.ts'

let failed = false
const check = (what: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}${detail ? ` (${detail})` : ''}`)
  if (!ok) failed = true
}

const at = (c: number, r: number) => ({ x: (c + 0.5) * TILE, y: (r + 0.5) * TILE })
const idx = (g: TileGrid, c: number, r: number) => r * g.cols + c
const ramp = (g: TileGrid, i: number) => (g.flags[i] & TF.ramp) !== 0
const blocked = (g: TileGrid, i: number) => (g.flags[i] & TF.blocked) !== 0
/** Two side-by-side tiles a unit may cross between: neither blocked, one height or one a ramp. */
const joined = (g: TileGrid, a: number, b: number) => !blocked(g, a) && !blocked(g, b) && (g.height[a] === g.height[b] || ramp(g, a) || ramp(g, b))

/** The tiles a class-`k` unit with its anchor on `i` covers. */
function block(g: TileGrid, k: number, i: number) {
  const c0 = i % g.cols
  const r0 = (i - c0) / g.cols
  const out: number[] = []
  for (let r = r0; r < r0 + k; r++) for (let c = c0; c < c0 + k; c++) out.push(c < g.cols && r < g.rows ? idx(g, c, r) : -1)
  return out
}

/** Whether a class-`k` unit's square on anchor `i` is open ground with no cliff inside, worked out
 * from the tiles alone. */
function blockOk(nav: GroundNav, g: TileGrid, k: number, i: number) {
  const tiles = block(g, k, i)
  if (tiles.some((t) => t < 0 || blocked(g, t) || nav.bld[t])) return false
  for (const t of tiles) {
    const c = t % g.cols
    if (tiles.includes(t + 1) && c + 1 < g.cols && !joined(g, t, t + 1)) return false
    if (tiles.includes(t + g.cols) && !joined(g, t, t + g.cols)) return false
  }
  return true
}

/**
 * Follows a path's legs in steps of an eighth of a tile and says what's wrong, if anything: a step
 * across a cliff, onto a blocked tile, or a jump of more than one tile, for the tile under the
 * unit's centre and every tile its square covers.
 */
function walk(nav: GroundNav, g: TileGrid, k: NavClass, from: { x: number; y: number }, pts: { x: number; y: number }[]) {
  let prev = anchorAt(nav, k, from.x, from.y)
  let ramps = 0
  let a = from
  for (const b of pts) {
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (TILE / 8)))
    for (let s = 1; s <= n; s++) {
      const x = a.x + ((b.x - a.x) * s) / n
      const y = a.y + ((b.y - a.y) * s) / n
      const i = anchorAt(nav, k, x, y)
      if (i === prev) continue
      if (!blockOk(nav, g, k, i)) return { bad: `square on (${i % g.cols}, ${Math.floor(i / g.cols)}) not open`, ramps }
      const pc = prev % g.cols
      const c = i % g.cols
      if (Math.abs(pc - c) > 1 || Math.abs(Math.floor(prev / g.cols) - Math.floor(i / g.cols)) > 1) return { bad: 'jumped', ramps }
      // The anchor tiles themselves and, for a diagonal, the tiles beside it.
      if (!joined(g, prev, i)) return { bad: `cliff between (${pc}, ${Math.floor(prev / g.cols)}) and (${c}, ${Math.floor(i / g.cols)})`, ramps }
      if (block(g, k, i).some((t) => t >= 0 && ramp(g, t))) ramps++
      prev = i
    }
    a = b
  }
  return { bad: '', ramps }
}

// --- 1. Clearance ---------------------------------------------------------------------------------

const map = testMesa()
const g = map.grid
const nav = newNav(map)
{
  const wrong: string[] = []
  for (const k of NAV_CLASSES)
    for (let i = 0; i < g.cols * g.rows; i++) {
      const ok = blockOk(nav, g, k, i)
      if (stands(nav, k, i) !== ok) wrong.push(`class ${k} at (${i % g.cols}, ${Math.floor(i / g.cols)}): nav ${stands(nav, k, i)}, tiles ${ok}`)
    }
  check('every class stands exactly where its square of tiles is open with no cliff inside', !wrong.length, wrong.slice(0, 3).join('; '))
  const gapA = idx(g, MESA.pocketA.gap.c, MESA.pocketA.gap.r)
  const coversGap = NAV_CLASSES.filter((k) => k > 1).some((k) => {
    for (let i = 0; i < g.cols * g.rows; i++) if (stands(nav, k, i) && block(g, k, i).includes(gapA)) return true
    return false
  })
  check('no vehicle or large unit fits in the 1-tile gap', !coversGap)
  const from = at(20, 14)
  const inA = at(3, 4)
  const inB = at(12, 4)
  const r1 = findPath(nav, 1, from.x, from.y, inA.x, inA.y)
  const r2 = findPath(nav, 2, from.x, from.y, inA.x, inA.y)
  const end2 = r2.pts[r2.pts.length - 1]
  check('a small unit gets into the pocket behind the 1-tile gap', !r1.short && r1.pts.length > 0)
  const inPocketA = (q: { x: number; y: number }) => q.x < (MESA.pocketA.c1 + 1) * TILE && q.y < (MESA.pocketA.r1 + 1) * TILE
  check('a vehicle can\'t, and stops outside it', r2.short && !!end2 && !inPocketA(end2), end2 ? `ends at ${(end2.x / TILE).toFixed(1)}, ${(end2.y / TILE).toFixed(1)}` : 'no path')
  const b2 = findPath(nav, 2, from.x, from.y, inB.x, inB.y)
  const b3 = findPath(nav, 3, from.x, from.y, inB.x, inB.y)
  check('a vehicle gets into the pocket behind the 2-tile gap', !b2.short && walk(nav, g, 2, from, b2.pts).bad === '')
  check('a large unit can\'t', b3.short)
}

// --- 2. Ramps and cliffs ------------------------------------------------------------------------------

{
  const low = at(MESA.low.c, MESA.low.r)
  const goals = [
    { what: 'plateau', p: at(38, 22), ramps: 1 },
    { what: 'knoll', p: at(39, 11), ramps: 2 },
  ]
  for (const k of NAV_CLASSES)
    for (const goal of goals) {
      // The knoll is 6 × 6: every class fits on it.
      const p = findPath(nav, k, low.x, low.y, goal.p.x, goal.p.y)
      const w = walk(nav, g, k, low, p.pts)
      check(`class ${k} from low ground onto the ${goal.what}: reaches it, up the ramp${goal.ramps > 1 ? 's' : ''}, never across a cliff`, !p.short && w.bad === '' && w.ramps > 0, w.bad || `${p.pts.length} waypoints`)
    }
  // Many random pairs, seeded: every leg of every path is a legal walk.
  let s = 7
  const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296)
  let bad = ''
  let n = 0
  for (let q = 0; q < 300 && !bad; q++) {
    const k = NAV_CLASSES[q % 3]
    // A start where the unit can stand; the goal anywhere.
    let a = { x: 0, y: 0 }
    for (let tries = 0; tries < 50 && !stands(nav, k, anchorAt(nav, k, a.x, a.y)); tries++) a = { x: rnd() * map.grid.cols * TILE, y: rnd() * map.grid.rows * TILE }
    const b = { x: rnd() * map.grid.cols * TILE, y: rnd() * map.grid.rows * TILE }
    const p = findPath(nav, k, a.x, a.y, b.x, b.y)
    for (let j = 1; j < p.pts.length; j++) if (!lineOk(nav, k, p.pts[j - 1].x, p.pts[j - 1].y, p.pts[j].x, p.pts[j].y)) bad = `leg ${j} not straight-walkable`
    const w = walk(nav, g, k, a, p.pts)
    if (w.bad) bad = `class ${k}: ${w.bad}`
    n++
  }
  check(`${n} random paths: every step legal (no cliffs, water or rocks)`, !bad, bad)
  // A rover in the sim, driven from low ground onto the plateau.
  const w = newGroundWorld(testMesa(), [{ faction: 'republic', team: 0 }])
  const u = spawnUnit(w, 'test-rover', 0, low.x, low.y)
  cmdMove(w, 0, [u.id], 38 * TILE, 22 * TILE)
  let jump = ''
  let arrived = -1
  let prevTile = Math.floor(u.y / TILE) * g.cols + Math.floor(u.x / TILE)
  for (let t = 0; t < 30 * 60 && arrived < 0; t++) {
    tick(w)
    const tile = Math.floor(u.y / TILE) * g.cols + Math.floor(u.x / TILE)
    if (tile !== prevTile && !joined(g, prevTile, tile) && !jump) jump = `tick ${t}: (${prevTile % g.cols}, ${Math.floor(prevTile / g.cols)}) to (${tile % g.cols}, ${Math.floor(tile / g.cols)})`
    prevTile = tile
    for (const e of w.events) if (e.k === 'arrived') arrived = t
    w.events.length = 0
  }
  check('a rover driven up the ramp in the sim arrives on the plateau, never crossing a cliff', arrived > 0 && !jump && g.height[prevTile] === 1, jump || (arrived > 0 ? `${(arrived * STEP).toFixed(1)} s` : 'never arrived'))
}

// --- 3. Buildings ---------------------------------------------------------------------------------

{
  const n = newNav(testMesa())
  const low = at(MESA.low.c, MESA.low.r)
  const top = at(38, 22)
  const before = findPath(n, 2, low.x, low.y, top.x, top.y)
  // A footprint over the ramp and the ground in front of it (as a nav stamp; whether
  // a building may go there is placement's business).
  const r = MESA.ramp
  stampFootprint(n, r.c0 - 3, r.r0 - 2, 5, r.r1 - r.r0 + 5, 1)
  const pending = findPath(n, 2, low.x, low.y, top.x, top.y)
  check('a stamp changes nothing until the flush', !pending.short && n.ver === 0)
  flushStamps(n)
  const cut = findPath(n, 2, low.x, low.y, top.x, top.y)
  const cutEnd = cut.pts[cut.pts.length - 1]
  check('a building over the ramp cuts the plateau off: the way stops short, on low ground', !before.short && cut.short && !!cutEnd && g.height[anchorAt(n, 2, cutEnd.x, cutEnd.y)] === 0 && n.ver === 1)
  const small = findPath(n, 1, low.x, low.y, top.x, top.y)
  check('...for every class', small.short)
  stampFootprint(n, r.c0 - 3, r.r0 - 2, 5, r.r1 - r.r0 + 5, -1)
  flushStamps(n)
  const open = findPath(n, 2, low.x, low.y, top.x, top.y)
  check('taking it off opens the way again', !open.short && walk(n, g, 2, low, open.pts).bad === '' && n.ver === 2)
}

// --- 4. A walled-in goal -------------------------------------------------------------------------------

{
  const ring = MESA.ring
  const inside = at((ring.c0 + ring.c1) >> 1, (ring.r0 + ring.r1) >> 1)
  const from = at(20, 14)
  for (const k of NAV_CLASSES) {
    const p = findPath(nav, k, from.x, from.y, inside.x, inside.y)
    const end = p.pts[p.pts.length - 1]
    // No spot reachable from the start (its piece) nearer the goal than where the way ends.
    const piece = nav.piece[k - 1]
    const startPiece = piece[anchorAt(nav, k, from.x, from.y)]
    let nearest = Infinity
    for (let i = 0; i < piece.length; i++) {
      if (piece[i] !== startPiece) continue
      const s = spotOf(nav, k, i)
      nearest = Math.min(nearest, Math.hypot(s.x - inside.x, s.y - inside.y))
    }
    const d = end ? Math.hypot(end.x - inside.x, end.y - inside.y) : Infinity
    const outside = end && !(end.x > ring.c0 * TILE && end.x < (ring.c1 + 1) * TILE && end.y > ring.r0 * TILE && end.y < (ring.r1 + 1) * TILE)
    check(`class ${k}: a goal walled in ends at the nearest reachable spot, outside the ring`, p.short && !!outside && Math.abs(d - nearest) < 1e-9 && walk(nav, g, k, from, p.pts).bad === '', end ? `${(d / TILE).toFixed(2)} tiles off` : 'no path')
  }
}

// --- 5. Fog -------------------------------------------------------------------------------------

{
  const fog = newFog(g, 2)
  const T = (c: number, r: number) => idx(g, c, r)
  const lowEye: { eye?: Eye } = {}
  placeEye(fog, lowEye, 0, T(24, 20), 10)
  check('low ground sees low ground in range', sees(fog, 0, T(20, 20)) && sees(fog, 0, T(24, 28)))
  check('low ground sees the plateau\'s edge row', sees(fog, 0, T(28, 20)) && sees(fog, 0, T(28, 24)))
  check('...but not past it', !sees(fog, 0, T(29, 20)) && !sees(fog, 0, T(31, 18)))
  check('nothing out of range', !sees(fog, 0, T(24, 31)) && !sees(fog, 0, T(13, 20)))
  const highEye: { eye?: Eye } = {}
  placeEye(fog, highEye, 1, T(31, 20), 10)
  check('the plateau sees down onto low ground and across the plateau', sees(fog, 1, T(24, 20)) && sees(fog, 1, T(38, 22)))
  check('the plateau sees the knoll\'s edge but not its top', sees(fog, 1, T(36, 11)) && !sees(fog, 1, T(38, 11)))
  const rampEye: { eye?: Eye } = {}
  placeEye(fog, rampEye, 0, T(26, 15), 6)
  check('a ramp sees from its top: onto the plateau', sees(fog, 0, T(31, 15)))
  // Moving an eye: the old disc comes off, explored stays.
  placeEye(fog, lowEye, 0, T(10, 5), 4)
  check('a moved eye stops seeing where it was; explored remembers', !sees(fog, 0, T(20, 28)) && explored(fog, 0, T(20, 28)) && sees(fog, 0, T(10, 5)))
  check('teams are apart', !explored(fog, 1, T(10, 5)) && !sees(fog, 0, T(38, 22)))
  for (const e of [lowEye, highEye, rampEye]) dropEye(fog, e)
  const left = fog.eyes.reduce((s, a) => s + a.reduce((x, y) => x + y, 0), 0)
  check('every eye dropped: nothing seen, explored kept', left === 0 && explored(fog, 1, T(38, 22)))
}

// --- 6. Cost ----------------------------------------------------------------------------------------

{
  let s = 11
  const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296)
  const t0 = performance.now()
  let n = 0
  for (let q = 0; q < 600; q++) {
    const k = NAV_CLASSES[q % 3]
    findPath(nav, k, rnd() * g.cols * TILE, rnd() * g.rows * TILE, rnd() * g.cols * TILE, rnd() * g.rows * TILE)
    n++
  }
  const per = (performance.now() - t0) / n
  const t1 = performance.now()
  for (let q = 0; q < 50; q++) {
    stampFootprint(nav, 20, 20, 3, 3, q % 2 ? -1 : 1)
    flushStamps(nav)
  }
  const flush = (performance.now() - t1) / 50
  console.log(`  ${per.toFixed(3)} ms a path, ${flush.toFixed(3)} ms a grid rebuild (${g.cols} × ${g.rows} tiles)`)
  check('paths and grid rebuilds stay cheap', per < 2 && flush < 10)
}

// --- Generated maps ------------------------------------------------------------------------------------

/** The ground maps, built by the terrain generator, when it's there. */
async function groundMaps(): Promise<GroundMap[] | null> {
  try {
    const terrain = (await import('../src/apps/games/empires/ground/terrain.ts')) as Record<string, unknown>
    const maps = (await import('../src/apps/games/empires/ground/maps.ts')) as Record<string, unknown>
    const build = terrain.buildGroundMap as ((d: unknown) => GroundMap) | undefined
    if (!build) return null
    const defs = Object.values(maps).flatMap((v) => (Array.isArray(v) ? v : [v])).filter((d): d is { id: string; sketch: string[] } => !!d && typeof d === 'object' && Array.isArray((d as { sketch?: unknown }).sketch))
    const seen = new Set<string>()
    return defs.filter((d) => !seen.has(d.id) && seen.add(d.id)).map(build)
  } catch {
    return null
  }
}

const built = await groundMaps()
if (!built) console.log('SKIP generated ground maps (ground/terrain.ts and ground/maps.ts not in yet)')
else
  for (const m of built) {
    const n = newNav(m)
    const misses: string[] = []
    const t0 = performance.now()
    let paths = 0
    for (const k of NAV_CLASSES)
      m.spawns.forEach((a, i) => {
        for (const [j, b] of [...m.spawns.map((p, j) => [`spawn ${j}`, p] as const).filter((_, j) => j !== i), ...m.deposits.map((p, j) => [`deposit ${j}`, p] as const)]) {
          const p = findPath(n, k, a.x, a.y, b.x, b.y)
          paths++
          const w = walk(n, m.grid, k, a, p.pts)
          // A deposit is reached when the way ends within 3 tiles (an Extractor goes on top of it).
          const end = p.pts[p.pts.length - 1] ?? a
          const near = Math.hypot(end.x - b.x, end.y - b.y) <= TILE * 3
          if (w.bad || !near) misses.push(`class ${k} spawn ${i} to ${j}: ${w.bad || 'not reached'}`)
        }
      })
    check(`${m.def.name}: every class gets from every spawn to every spawn and deposit`, !misses.length, misses.length ? misses.slice(0, 3).join('; ') : `${paths} paths, ${((performance.now() - t0) / paths).toFixed(2)} ms each`)
  }

if (failed) {
  console.log('ground nav check FAILED')
  process.exit(1)
}
console.log('ground nav check passed')
