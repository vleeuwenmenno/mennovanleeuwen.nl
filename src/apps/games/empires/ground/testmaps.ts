// Small ground maps built tile by tile, for the sim's checks (check:ground, check:ground-nav), so
// they don't depend on the terrain generator. Not for play.

import { TF, TILE, terrainIndex, type GroundMap, type TileGrid } from './types.ts'

/** A map being drawn: set tiles by rectangle. */
function canvas(cols: number, rows: number) {
  const n = cols * rows
  const grid: TileGrid = { cols, rows, terrain: new Uint8Array(n).fill(terrainIndex('dirt')), height: new Uint8Array(n), flags: new Uint8Array(n) }
  /** Calls `fn` with each tile index of the rectangle from (c0, r0) to (c1, r1), both included. */
  const rect = (c0: number, r0: number, c1: number, r1: number, fn: (i: number) => void) => {
    for (let r = Math.max(0, r0); r <= Math.min(rows - 1, r1); r++) for (let c = Math.max(0, c0); c <= Math.min(cols - 1, c1); c++) fn(r * cols + c)
  }
  const height = (c0: number, r0: number, c1: number, r1: number, h: number) => rect(c0, r0, c1, r1, (i) => (grid.height[i] = h))
  const flag = (c0: number, r0: number, c1: number, r1: number, f: number) => rect(c0, r0, c1, r1, (i) => (grid.flags[i] |= f))
  const unflag = (c0: number, r0: number, c1: number, r1: number, f: number) => rect(c0, r0, c1, r1, (i) => (grid.flags[i] &= ~f))
  const terrain = (c0: number, r0: number, c1: number, r1: number, t: Parameters<typeof terrainIndex>[0]) => rect(c0, r0, c1, r1, (i) => (grid.terrain[i] = terrainIndex(t)))
  return { grid, height, flag, unflag, terrain }
}

const centre = (c: number, r: number) => ({ x: (c + 0.5) * TILE, y: (r + 0.5) * TILE })

/** Where things are on Test Mesa, in tiles, for the checks. */
export const MESA = {
  cols: 48,
  rows: 36,
  /** The plateau (height 1). */
  plateau: { c0: 28, r0: 6, c1: 43, r1: 25 },
  /** The ramp from low ground onto the plateau, 2 × 4 tiles. */
  ramp: { c0: 26, r0: 14, c1: 27, r1: 17 },
  /** A knoll on the plateau (height 2), and the ramp up to it from the plateau. */
  knoll: { c0: 36, r0: 8, c1: 41, r1: 13 },
  knollRamp: { c0: 34, r0: 9, c1: 35, r1: 12 },
  /** A lake: water. */
  lake: { c0: 8, r0: 25, c1: 14, r1: 31 },
  /** Pocket A, open to the rest only through a gap 1 tile wide; pocket B through one 2 tiles wide. */
  pocketA: { c0: 0, r0: 0, c1: 6, r1: 9, gap: { c: 3, r: 10 } },
  pocketB: { c0: 9, r0: 0, c1: 15, r1: 9, gap: { c: 12, r: 10 } },
  /** A ring of rock with nothing able to get inside. */
  ring: { c0: 2, r0: 17, c1: 8, r1: 23 },
  /** Start spots: on low ground, and on the plateau. */
  low: { c: 20, r: 31 },
  high: { c: 33, r: 20 },
}

/**
 * Test Mesa, 48 × 36 tiles. Flat low ground (height 0) with a plateau (height 1) reached by one
 * ramp on its west side, a knoll (height 2) on the plateau with a ramp of its own, a lake, a
 * pocket behind a 1-tile gap and one behind a 2-tile gap, a ring of rock walled in on every side,
 * and a few single blocking rocks.
 */
export function testMesa(): GroundMap {
  const M = MESA
  const { grid, height, flag, unflag, terrain } = canvas(M.cols, M.rows)
  const p = M.plateau
  height(p.c0, p.r0, p.c1, p.r1, 1)
  terrain(p.c0, p.r0, p.c1, p.r1, 'rocky')
  const k = M.knoll
  height(k.c0, k.r0, k.c1, k.r1, 2)
  // Ramps: the low one at height 0 joining the plateau; the knoll's at height 1 joining the knoll.
  const r = M.ramp
  flag(r.c0, r.r0, r.c1, r.r1, TF.ramp | TF.noBuild)
  const kr = M.knollRamp
  flag(kr.c0, kr.r0, kr.c1, kr.r1, TF.ramp | TF.noBuild)
  // Water.
  const l = M.lake
  flag(l.c0, l.r0, l.c1, l.r1, TF.water | TF.blocked | TF.noBuild)
  terrain(l.c0 - 1, l.r0 - 1, l.c1 + 1, l.r1 + 1, 'grass')
  // Pocket A: a wall along its bottom and right side, with a 1-tile gap.
  const a = M.pocketA
  flag(a.c0, a.r1 + 1, a.c1 + 1, a.r1 + 1, TF.blocked | TF.noBuild)
  flag(a.c1 + 1, a.r0, a.c1 + 1, a.r1 + 1, TF.blocked | TF.noBuild)
  unflag(a.gap.c, a.gap.r, a.gap.c, a.gap.r, TF.blocked)
  // Pocket B: walls on three sides, with a 2-tile gap in the bottom one.
  const b = M.pocketB
  flag(b.c0 - 1, b.r1 + 1, b.c1 + 1, b.r1 + 1, TF.blocked | TF.noBuild)
  flag(b.c0 - 1, b.r0, b.c0 - 1, b.r1 + 1, TF.blocked | TF.noBuild)
  flag(b.c1 + 1, b.r0, b.c1 + 1, b.r1 + 1, TF.blocked | TF.noBuild)
  unflag(b.gap.c, b.gap.r, b.gap.c + 1, b.gap.r, TF.blocked)
  // The ring: a closed square of rock.
  const g = M.ring
  flag(g.c0, g.r0, g.c1, g.r0, TF.blocked)
  flag(g.c0, g.r1, g.c1, g.r1, TF.blocked)
  flag(g.c0, g.r0, g.c0, g.r1, TF.blocked)
  flag(g.c1, g.r0, g.c1, g.r1, TF.blocked)
  // Single rocks.
  for (const [c, rr] of [[20, 27], [21, 27], [24, 30], [18, 4], [45, 30], [32, 15], [40, 21]]) flag(c, rr, c, rr, TF.blocked | TF.noBuild)
  // No building on the map's edge.
  flag(0, 0, M.cols - 1, 0, TF.noBuild)
  flag(0, M.rows - 1, M.cols - 1, M.rows - 1, TF.noBuild)
  flag(0, 0, 0, M.rows - 1, TF.noBuild)
  flag(M.cols - 1, 0, M.cols - 1, M.rows - 1, TF.noBuild)
  return {
    def: { id: 'test-mesa', name: 'Test Mesa', blurb: 'A fixture for the ground sim checks.', cols: M.cols, rows: M.rows, cell: 1, sym: 'none', seed: 1234, sketch: [], biome: 'temperate' },
    grid,
    props: [],
    spawns: [centre(M.low.c, M.low.r), centre(M.high.c, M.high.r)],
    deposits: [],
  }
}

/** Open Field: flat ground with nothing on it, `cols` × `rows` tiles, for crowds. */
export function testField(cols = 40, rows = 30): GroundMap {
  const { grid } = canvas(cols, rows)
  return {
    def: { id: 'test-field', name: 'Test Field', blurb: 'Flat and open.', cols, rows, cell: 1, sym: 'none', seed: 99, sketch: [], biome: 'temperate' },
    grid,
    props: [],
    spawns: [centre(4, rows >> 1), centre(cols - 5, rows >> 1)],
    deposits: [],
  }
}
