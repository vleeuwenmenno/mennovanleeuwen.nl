// Path finding on the ground battle's tile grid. The same ideas as space's nav.ts (A* on a grid,
// paths pulled tight, connected pieces so an unreachable goal turns into the nearest reachable
// spot), on the terrain's own tiles: cliffs, water and blocking props are walls through canStep
// (types.ts), and buildings stamp the tiles under them while they stand.
//
// Size classes. A unit needs a square of open tiles: small 1 × 1, vehicle 2 × 2, large 3 × 3. Each
// tile knows the biggest open square with its top-left corner on it (the clearance map), so a
// unit's path is found for that corner tile, its anchor, and a vehicle never squeezes through a
// one-tile gap. A square counts as open only when every tile in it is open and joined to its
// neighbours (no cliff runs through it).
//
// Lockstep: integer step costs, a fixed neighbour order and fixed tie-breaks, no floats in the
// search. Buildings never change the grid in the middle of a tick: a stamp waits in `pending`
// until flushStamps, which the sim calls at the start of every tick, so every copy of the battle
// sees the same grid at the same moment. Nothing here touches the DOM: the server runs it too.

import { canStep, TF, TILE, type GroundMap, type Pt, type TileGrid } from './types.ts'

/** A size class: the side of the square of tiles a unit needs (1 small, 2 vehicle, 3 large). */
export type NavClass = 1 | 2 | 3
export const NAV_CLASSES: readonly NavClass[] = [1, 2, 3]
const MAX_CLASS = 3

/** Step costs: a straight step 10, a diagonal 14 (√2, in whole numbers). */
const STRAIGHT = 10
const DIAG = 14
/** Heap keys pack the cost above the tile index: key = f * IDX + tile. */
const IDX = 1 << 20

/** A building's footprint stamped on (d 1) or off (-1), waiting for the next flush. */
type Stamp = { c: number; r: number; w: number; h: number; d: 1 | -1 }

export type GroundNav = {
  grid: TileGrid
  cols: number
  rows: number
  /** How many buildings stand on each tile. */
  bld: Uint8Array
  /** The side of the biggest open square whose top-left tile this is, 0 to 3. */
  clr: Uint8Array
  /** Per class (index class - 1): which connected piece each anchor tile is in, -1 where the class
   * can't stand. */
  piece: Int32Array[]
  /** Stamps placed since the last flush. */
  pending: Stamp[]
  /** Goes up at each flush that changed the grid: a path found on an older grid is found again. */
  ver: number
  // Search scratch, reused between searches.
  cost: Int32Array
  from: Int32Array
  mark: Uint32Array
  done: Uint32Array
  round: number
  heap: Float64Array
}

export function newNav(map: GroundMap): GroundNav {
  const g = map.grid
  const n = g.cols * g.rows
  const nav: GroundNav = {
    grid: g, cols: g.cols, rows: g.rows, bld: new Uint8Array(n), clr: new Uint8Array(n), piece: [], pending: [], ver: 0,
    cost: new Int32Array(n), from: new Int32Array(n), mark: new Uint32Array(n), done: new Uint32Array(n), round: 0, heap: new Float64Array(n * 8 + 16),
  }
  rebuild(nav)
  return nav
}

// --- The grid -----------------------------------------------------------------------------------

/** Open: no terrain wall and no building. */
const open = (nav: GroundNav, i: number) => (nav.grid.flags[i] & TF.blocked) === 0 && nav.bld[i] === 0

/** canStep with buildings: neither tile, nor a corner a diagonal squeezes past, under a building. */
function step(nav: GroundNav, a: number, b: number) {
  if (!canStep(nav.grid, a, b) || nav.bld[a] || nav.bld[b]) return false
  const cols = nav.cols
  const ac = a % cols
  const bc = b % cols
  if (ac === bc || a - ac === b - bc) return true
  return !nav.bld[a - ac + bc] && !nav.bld[b - bc + ac]
}

/** Whether a unit of class `k` can stand with its anchor (top-left tile) on `i`. */
export const stands = (nav: GroundNav, k: NavClass, i: number) => i >= 0 && i < nav.clr.length && nav.clr[i] >= k

/** Whether a unit of class `k` can move its anchor from `a` to the neighbouring tile `b`. */
export function moves(nav: GroundNav, k: NavClass, a: number, b: number) {
  if (!stands(nav, k, b) || !step(nav, a, b)) return false
  if (k === 1) return true
  const cols = nav.cols
  const ac = a % cols
  const bc = b % cols
  if (ac === bc || a - ac === b - bc) return true
  // A diagonal: the squares beside it must hold the unit too, or it cuts a corner.
  return stands(nav, k, a - ac + bc) && stands(nav, k, b - bc + ac)
}

/** Works out the clearance map and the connected pieces again (after stamps changed). */
function rebuild(nav: GroundNav) {
  const { cols, rows, clr } = nav
  for (let r = rows - 1; r >= 0; r--)
    for (let c = cols - 1; c >= 0; c--) {
      const i = r * cols + c
      if (!open(nav, i)) clr[i] = 0
      else if (c === cols - 1 || r === rows - 1) clr[i] = 1
      else if (step(nav, i, i + 1) && step(nav, i, i + cols) && step(nav, i, i + cols + 1))
        clr[i] = Math.min(MAX_CLASS, 1 + Math.min(clr[i + 1], clr[i + cols], clr[i + cols + 1]))
      else clr[i] = 1
    }
  nav.piece = NAV_CLASSES.map((k) => label(nav, k))
}

/** Labels each anchor tile of class `k` with the piece of ground it's in, moving as paths do. */
function label(nav: GroundNav, k: NavClass) {
  const { cols, rows } = nav
  const piece = new Int32Array(cols * rows).fill(-1)
  const stack: number[] = []
  let id = 0
  for (let s = 0; s < piece.length; s++) {
    if (piece[s] >= 0 || !stands(nav, k, s)) continue
    piece[s] = id
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
          if (piece[j] < 0 && moves(nav, k, i, j)) {
            piece[j] = id
            stack.push(j)
          }
        }
    }
    id++
  }
  return piece
}

/** Stamps a building's footprint (`w` × `h` tiles from tile `c`, `r`) on (`d` 1) or off (-1). The
 * grid changes at the next flushStamps, not now. */
export function stampFootprint(nav: GroundNav, c: number, r: number, w: number, h: number, d: 1 | -1) {
  nav.pending.push({ c, r, w, h, d })
}

/** Applies the stamps placed since the last flush, in the order they were placed. The sim calls it
 * at one fixed point in the tick. True when the grid changed. */
export function flushStamps(nav: GroundNav) {
  if (!nav.pending.length) return false
  for (const s of nav.pending)
    for (let r = Math.max(0, s.r); r < Math.min(nav.rows, s.r + s.h); r++)
      for (let c = Math.max(0, s.c); c < Math.min(nav.cols, s.c + s.w); c++) {
        const i = r * nav.cols + c
        nav.bld[i] = Math.max(0, nav.bld[i] + s.d)
      }
  nav.pending.length = 0
  rebuild(nav)
  nav.ver++
  return true
}

/** Whether a `w` × `h` footprint from tile (`c`, `r`) lies on the map, on open buildable ground of one
 * height, with no building on it yet (stamps still pending count too). */
export function footprintOpen(nav: GroundNav, c: number, r: number, w: number, h: number) {
  if (c < 0 || r < 0 || c + w > nav.cols || r + h > nav.rows) return false
  const g = nav.grid
  const level = g.height[r * nav.cols + c]
  for (let y = r; y < r + h; y++)
    for (let x = c; x < c + w; x++) {
      const i = y * nav.cols + x
      if (!open(nav, i) || g.flags[i] & (TF.noBuild | TF.ramp) || g.height[i] !== level) return false
    }
  for (const s of nav.pending) if (s.d > 0 && s.c < c + w && c < s.c + s.w && s.r < r + h && r < s.r + s.h) return false
  return true
}

// --- Positions ------------------------------------------------------------------------------------

/** How far a class-`k` unit's centre sits from its anchor tile's centre, on each axis. */
const offset = (k: NavClass) => ((k - 1) * TILE) / 2

/** The tile under a world point, clamped onto the map. */
export function tileAt(nav: GroundNav, x: number, y: number) {
  const c = Math.min(nav.cols - 1, Math.max(0, Math.floor(x / TILE)))
  const r = Math.min(nav.rows - 1, Math.max(0, Math.floor(y / TILE)))
  return r * nav.cols + c
}

/** The anchor tile of a class-`k` unit whose centre is at (x, y). */
export function anchorAt(nav: GroundNav, k: NavClass, x: number, y: number) {
  const o = offset(k)
  return tileAt(nav, x - o, y - o)
}

/** Where a class-`k` unit's centre is when its anchor sits square on tile `i`. */
export function spotOf(nav: GroundNav, k: NavClass, i: number): Pt {
  const c = i % nav.cols
  const o = offset(k)
  return { x: (c + 0.5) * TILE + o, y: ((i - c) / nav.cols + 0.5) * TILE + o }
}

/** (x, y) moved onto the map far enough for a class-`k` unit's square to lie on it. */
export function onMap(nav: GroundNav, k: NavClass, x: number, y: number): Pt {
  const lo = (k * TILE) / 2
  return { x: Math.min(nav.cols * TILE - lo, Math.max(lo, x)), y: Math.min(nav.rows * TILE - lo, Math.max(lo, y)) }
}

/** Whether a class-`k` unit can stand with its centre at (x, y). */
export const standsAt = (nav: GroundNav, k: NavClass, x: number, y: number) => stands(nav, k, anchorAt(nav, k, x, y))

/** Whether a class-`k` unit can move its centre from one point to another a short way off (at most
 * one tile on each axis), as movement does each tick. */
export function movesTo(nav: GroundNav, k: NavClass, ax: number, ay: number, bx: number, by: number) {
  const a = anchorAt(nav, k, ax, ay)
  const b = anchorAt(nav, k, bx, by)
  if (a === b) return stands(nav, k, b)
  const ac = a % nav.cols
  const bc = b % nav.cols
  if (Math.abs(ac - bc) > 1 || Math.abs((a - ac) / nav.cols - (b - bc) / nav.cols) > 1) return lineOk(nav, k, ax, ay, bx, by)
  return moves(nav, k, a, b)
}

/** The tile nearest `i` (searching outwards, 4 ways) where a class-`k` unit can stand, or -1. */
export function nearestStand(nav: GroundNav, k: NavClass, i: number) {
  if (stands(nav, k, i)) return i
  const { cols, rows } = nav
  const seen = new Uint8Array(cols * rows)
  const queue = [i]
  seen[i] = 1
  for (let q = 0; q < queue.length; q++) {
    const j = queue[q]
    if (stands(nav, k, j)) return j
    const c = j % cols
    const r = (j - c) / cols
    if (c > 0 && !seen[j - 1]) (seen[j - 1] = 1), queue.push(j - 1)
    if (c < cols - 1 && !seen[j + 1]) (seen[j + 1] = 1), queue.push(j + 1)
    if (r > 0 && !seen[j - cols]) (seen[j - cols] = 1), queue.push(j - cols)
    if (r < rows - 1 && !seen[j + cols]) (seen[j + cols] = 1), queue.push(j + cols)
  }
  return -1
}

/** The anchor tile in piece `p` (of class `k`) whose spot is nearest (x, y); the first such tile
 * on a tie. -1 when the piece is empty. */
function nearestIn(nav: GroundNav, k: NavClass, p: number, x: number, y: number) {
  const piece = nav.piece[k - 1]
  const o = offset(k)
  let best = -1
  let bestD = Infinity
  for (let i = 0; i < piece.length; i++) {
    if (piece[i] !== p) continue
    const c = i % nav.cols
    const dx = (c + 0.5) * TILE + o - x
    const dy = ((i - c) / nav.cols + 0.5) * TILE + o - y
    const d = dx * dx + dy * dy
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  return best
}

/** Whether a class-`k` unit can drive in a straight line from a to b (centre points): every anchor
 * tile the line crosses holds it, and every step between them is one it may take. */
export function lineOk(nav: GroundNav, k: NavClass, ax: number, ay: number, bx: number, by: number) {
  const o = offset(k)
  const x0 = (ax - o) / TILE
  const y0 = (ay - o) / TILE
  const dx = (bx - o) / TILE - x0
  const dy = (by - o) / TILE - y0
  // Clamped onto the map, as anchorAt is.
  const at = (x: number, y: number) => Math.min(nav.rows - 1, Math.max(0, Math.floor(y))) * nav.cols + Math.min(nav.cols - 1, Math.max(0, Math.floor(x)))
  let prev = at(x0, y0)
  if (!stands(nav, k, prev)) return false
  // Samples a quarter tile apart: between two samples the anchor moves at most one tile each way,
  // and a diagonal move checks both tiles beside it.
  const n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) * 4))
  for (let s = 1; s <= n; s++) {
    const i = at(x0 + (dx * s) / n, y0 + (dy * s) / n)
    if (i === prev) continue
    if (!moves(nav, k, prev, i)) return false
    prev = i
  }
  return true
}

// --- Finding a way ----------------------------------------------------------------------------------

/** A way found: waypoints (unit centres) in order, the last the destination itself unless `short`. */
export type GroundPath = {
  pts: Pt[]
  /** The destination can't be reached (walled in, or no room for this class): the path ends at the
   * nearest spot that can be. */
  short: boolean
}

/**
 * Waypoints for a class-`k` unit from its centre (ax, ay) to (bx, by), round cliffs, water, props
 * and buildings, pulled tight. When the destination can't be reached, the way ends at the reachable
 * spot nearest it (`short`). No waypoints at all when the unit has nowhere it can stand.
 */
export function findPath(nav: GroundNav, k: NavClass, ax: number, ay: number, tx: number, ty: number): GroundPath {
  // A destination too near the map's edge for the unit's square: as near as fits.
  const { x: bx, y: by } = onMap(nav, k, tx, ty)
  const here = anchorAt(nav, k, ax, ay)
  const start = nearestStand(nav, k, here)
  if (start < 0) return { pts: [], short: true }
  const piece = nav.piece[k - 1]
  let goal = anchorAt(nav, k, bx, by)
  const exact = stands(nav, k, goal) && piece[goal] === piece[start]
  if (!exact) goal = nearestIn(nav, k, piece[start], bx, by)
  const end = exact ? { x: bx, y: by } : spotOf(nav, k, goal)
  // Where the search starts from: the unit itself, or the nearest spot it can stand on.
  const from = start === here ? { x: ax, y: ay } : spotOf(nav, k, start)
  if (start === goal || lineOk(nav, k, from.x, from.y, end.x, end.y)) return { pts: start === here ? [end] : [from, end], short: !exact }
  const cells = search(nav, k, start, goal)
  if (!cells) return { pts: start === here ? [] : [from], short: true }
  // The anchor tiles' spots from the start's own, then the destination itself: each point a legal
  // straight drive from the one before (the unit stands in its start tile, the destination lies in
  // the goal's).
  const spots = [spotOf(nav, k, start), ...cells.map((i) => spotOf(nav, k, i))]
  if (exact) spots.push(end)
  // Pull the path tight: from each point, jump to the furthest one in plain view.
  const out: Pt[] = start === here ? [] : [from]
  let at = from
  let i = start === here ? 0 : 1
  while (i < spots.length) {
    let j = spots.length - 1
    while (j > i && !lineOk(nav, k, at.x, at.y, spots[j].x, spots[j].y)) j--
    out.push(spots[j])
    at = spots[j]
    i = j + 1
  }
  return { pts: out, short: !exact }
}

/** A* from anchor `start` to anchor `goal` for class `k`: the anchor tiles after the start, in
 * order, or null when there is no way. Integer costs; the heap orders by cost, then tile index. */
function search(nav: GroundNav, k: NavClass, start: number, goal: number): number[] | null {
  const { cols, rows, cost, from, mark, done } = nav
  if (++nav.round === 0xffffffff) {
    mark.fill(0)
    done.fill(0)
    nav.round = 1
  }
  const round = nav.round
  const gc = goal % cols
  const gr = (goal - gc) / cols
  const h = (i: number) => {
    const c = i % cols
    const dx = Math.abs(c - gc)
    const dy = Math.abs((i - c) / cols - gr)
    return dx > dy ? STRAIGHT * dx + (DIAG - STRAIGHT) * dy : STRAIGHT * dy + (DIAG - STRAIGHT) * dx
  }
  let heap = nav.heap
  let size = 0
  const push = (key: number) => {
    if (size === heap.length) {
      const more = new Float64Array(heap.length * 2)
      more.set(heap)
      heap = nav.heap = more
    }
    let q = size++
    while (q > 0) {
      const p = (q - 1) >> 1
      if (heap[p] <= key) break
      heap[q] = heap[p]
      q = p
    }
    heap[q] = key
  }
  const pop = () => {
    const top = heap[0]
    const last = heap[--size]
    let q = 0
    for (;;) {
      const l = q * 2 + 1
      if (l >= size) break
      const m = l + 1 < size && heap[l + 1] < heap[l] ? l + 1 : l
      if (heap[m] >= last) break
      heap[q] = heap[m]
      q = m
    }
    heap[q] = last
    return top
  }
  cost[start] = 0
  from[start] = -1
  mark[start] = round
  push(h(start) * IDX + start)
  while (size) {
    const key = pop()
    const i = key % IDX
    if (done[i] === round) continue
    done[i] = round
    if (i === goal) {
      const out: number[] = []
      for (let j = goal; j !== start; j = from[j]) out.push(j)
      return out.reverse()
    }
    const c = i % cols
    const r = (i - c) / cols
    for (let dr = -1; dr <= 1; dr++)
      for (let dc = -1; dc <= 1; dc++) {
        if (!dc && !dr) continue
        const nc = c + dc
        const nr = r + dr
        if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue
        const j = nr * cols + nc
        if (done[j] === round || !moves(nav, k, i, j)) continue
        const g2 = cost[i] + (dc && dr ? DIAG : STRAIGHT)
        if (mark[j] !== round || g2 < cost[j]) {
          mark[j] = round
          cost[j] = g2
          from[j] = i
          push((g2 + h(j)) * IDX + j)
        }
      }
  }
  return null
}
