// Path finding round the rocks. Rocks never move, so each ship size gets one grid of blocked
// cells, built the first time a ship that size needs a path. A path is found on the grid, then
// pulled tight so ships fly straight lines from one rock's edge to the next.
//
// Rocks are the only walls. Asteroid fields and nebulas are soft ground: crossing a cell in one
// costs more than open space (see Soft), so a path goes round one when that's not much further
// and straight through when going round would take far longer.
//
// Each grid also knows which pieces of open space connect, so a spot no path can reach (walled in
// by rocks, or inside one) is swapped for the nearest spot that can be reached: the ship goes as
// near as it can get and stops there, rather than flying straight at the rocks.

import { sq } from './detmath.ts'
import type { Pt } from './maps.ts'
export type { Pt }
type Circle = { x: number; y: number; r: number }

/** Grid cell size in world units. */
const CELL = 80
export const NAV_CELL = CELL

/**
 * How big a rock is to the ships, as a share of its drawn radius. The rocks are lumpy, longer one
 * way than the other, and their outline sits at about 0.7 to 1.15 of that radius (0.85 on
 * average): a circle at the full radius walled off gaps you could see open space through.
 */
export const ROCK_HIT = 0.8

/** A piece of open space smaller than this many cells is a nook between rocks, no place to start a
 * path from (see nearestOpen). */
const NOOK = 6

export type NavGrid = {
  cols: number
  rows: number
  blocked: Uint8Array
  /** Which piece of connected open space each free cell is in (-1 for blocked cells). */
  piece: Int32Array
  /** Cells in each piece. */
  size: Int32Array
  /** Cost grids built on this grid, by which patches they price (see navCost). */
  costs: Map<string, Float32Array>
}

/** Calls `fn` with every cell whose centre a ship needing `clear` round rock `k` can't sit on. */
function cellsUnder(k: Circle, clear: number, cols: number, rows: number, fn: (i: number) => void) {
  const R = k.r + clear
  const c0 = Math.max(0, Math.floor((k.x - R) / CELL))
  const c1 = Math.min(cols - 1, Math.floor((k.x + R) / CELL))
  const r0 = Math.max(0, Math.floor((k.y - R) / CELL))
  const r1 = Math.min(rows - 1, Math.floor((k.y + R) / CELL))
  for (let r = r0; r <= r1; r++)
    for (let c = c0; c <= c1; c++) {
      const x = (c + 0.5) * CELL
      const y = (r + 0.5) * CELL
      if (sq(x - k.x) + sq(y - k.y) < R * R) fn(r * cols + c)
    }
}

/** The cells along the map's edge a ship needing `clear` keeps off, where it can't swing wide
 * round a rock. */
function edgeCells(w: number, h: number, clear: number, cols: number, rows: number, fn: (i: number) => void) {
  const edge = Math.max(CELL * 0.5, clear * 0.6)
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const x = (c + 0.5) * CELL
      const y = (r + 0.5) * CELL
      if (x < edge || y < edge || x > w - edge || y > h - edge) fn(r * cols + c)
    }
}

/** Labels each free cell with the piece of open space it's in: 8-way, never cutting a corner past
 * a blocked cell, as paths move. */
function label(cols: number, rows: number, blocked: Uint8Array) {
  const piece = new Int32Array(cols * rows).fill(-1)
  const sizes: number[] = []
  const stack: number[] = []
  for (let s = 0; s < piece.length; s++) {
    if (blocked[s] || piece[s] >= 0) continue
    const id = sizes.length
    let n = 0
    piece[s] = id
    stack.push(s)
    while (stack.length) {
      const i = stack.pop()!
      n++
      const c = i % cols
      const r = (i - c) / cols
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          const nc = c + dc
          const nr = r + dr
          if ((!dc && !dr) || nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue
          const j = nr * cols + nc
          if (blocked[j] || piece[j] >= 0) continue
          if (dc && dr && (blocked[r * cols + nc] || blocked[nr * cols + c])) continue
          piece[j] = id
          stack.push(j)
        }
    }
    sizes.push(n)
  }
  return { piece, size: Int32Array.from(sizes) }
}

/** Cells a ship needing `clear` units round every rock can't sit in. */
export function navGrid(rocks: Circle[], w: number, h: number, clear: number): NavGrid {
  const cols = Math.ceil(w / CELL)
  const rows = Math.ceil(h / CELL)
  const blocked = new Uint8Array(cols * rows)
  const set = (i: number) => (blocked[i] = 1)
  edgeCells(w, h, clear, cols, rows, set)
  for (const k of rocks) cellsUnder(k, clear, cols, rows, set)
  return { cols, rows, blocked, ...label(cols, rows, blocked), costs: new Map() }
}

/** True when a ship needing `clear` units round rocks can fly straight from a to b. */
export function clearLine(rocks: Circle[], ax: number, ay: number, bx: number, by: number, clear: number) {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy || 1
  for (const k of rocks) {
    const t = Math.max(0, Math.min(1, ((k.x - ax) * dx + (k.y - ay) * dy) / len2))
    const R = k.r + clear
    if (sq(ax + dx * t - k.x) + sq(ay + dy * t - k.y) < R * R) return false
  }
  return true
}

// --- Soft ground ----------------------------------------------------------------------------------------

/** A patch a path may cross at a price: each unit flown inside it counts as `cost` units. */
export type Soft = Circle & { cost: number }

/** How far round a soft patch its price reaches, so a path doesn't skim the edge. */
const SOFT_PAD = CELL * 0.5

/** The price of each cell (1 for open space) under these patches; the dearest patch counts where
 * they overlap. Cached on the grid under `key`. */
export function navCost(g: NavGrid, soft: Soft[], key: string): Float32Array {
  let cost = g.costs.get(key)
  if (cost) return cost
  cost = new Float32Array(g.cols * g.rows).fill(1)
  for (const p of soft)
    cellsUnder({ x: p.x, y: p.y, r: p.r + SOFT_PAD }, 0, g.cols, g.rows, (i) => {
      if (cost![i] < p.cost) cost![i] = p.cost
    })
  g.costs.set(key, cost)
  return cost
}

/** Whether the straight line from a to b crosses any of the patches (with their pad). */
export function crosses(soft: Circle[], ax: number, ay: number, bx: number, by: number) {
  return soft.length > 0 && !clearLine(soft, ax, ay, bx, by, SOFT_PAD)
}

/** The price of flying straight from a to b over `cost`, in cells. */
function lineCost(g: NavGrid, cost: Float32Array, ax: number, ay: number, bx: number, by: number) {
  const len = Math.hypot(bx - ax, by - ay)
  const n = Math.max(1, Math.ceil(len / (CELL * 0.25)))
  const step = len / n / CELL
  let sum = 0
  for (let k = 0; k < n; k++) {
    const t = (k + 0.5) / n
    const c = Math.min(g.cols - 1, Math.max(0, Math.floor((ax + (bx - ax) * t) / CELL)))
    const r = Math.min(g.rows - 1, Math.max(0, Math.floor((ay + (by - ay) * t) / CELL)))
    sum += cost[r * g.cols + c] * step
  }
  return sum
}

// --- Finding a way --------------------------------------------------------------------------------------

/** The free cell nearest `i` in a real piece of open space (not a nook between rocks), searching
 * outwards; any free cell when there is no such piece, and `i` itself when nothing is free. */
function nearestOpen(g: NavGrid, i: number) {
  const ok = (j: number) => !g.blocked[j] && g.size[g.piece[j]] >= NOOK
  if (ok(i)) return i
  const seen = new Uint8Array(g.blocked.length)
  const queue = [i]
  seen[i] = 1
  let any = -1
  for (let q = 0; q < queue.length; q++) {
    const j = queue[q]
    if (ok(j)) return j
    if (any < 0 && !g.blocked[j]) any = j
    const c = j % g.cols
    const r = (j - c) / g.cols
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nc = c + dc
      const nr = r + dr
      if (nc < 0 || nr < 0 || nc >= g.cols || nr >= g.rows) continue
      const n = nr * g.cols + nc
      if (!seen[n]) {
        seen[n] = 1
        queue.push(n)
      }
    }
  }
  return any >= 0 ? any : i
}

/** The cell of piece `p` nearest (x, y), or -1. */
function nearestIn(g: NavGrid, p: number, x: number, y: number) {
  let best = -1
  let bestD = Infinity
  for (let i = 0; i < g.piece.length; i++) {
    if (g.piece[i] !== p) continue
    const c = i % g.cols
    const d = sq((c + 0.5) * CELL - x) + sq(((i - c) / g.cols + 0.5) * CELL - y)
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  return best
}

/** A way found: waypoints in order, the last one the destination itself unless `short`. */
export type Path = {
  pts: Pt[]
  /** The destination can't be reached (rocks wall it in): the path ends as near it as a ship can
   * get. */
  short: boolean
}

/**
 * Waypoints from a to b round the rocks; none when the way is straight. With `soft`, crossing its
 * patches costs extra (see Soft): the way goes round them when that's cheaper. When b can't be
 * reached, the way ends at the nearest spot that can (see Path).
 */
export function findPath(g: NavGrid, rocks: Circle[], clear: number, ax: number, ay: number, bx: number, by: number, soft?: { cost: Float32Array; patches: Circle[] }): Path {
  if (clearLine(rocks, ax, ay, bx, by, clear) && !(soft && crosses(soft.patches, ax, ay, bx, by))) return { pts: [], short: false }
  const { cols, rows, blocked } = g
  const cell = (x: number, y: number) => Math.min(rows - 1, Math.max(0, Math.floor(y / CELL))) * cols + Math.min(cols - 1, Math.max(0, Math.floor(x / CELL)))
  const centre = (i: number): Pt => {
    const c = i % cols
    return { x: (c + 0.5) * CELL, y: ((i - c) / cols + 0.5) * CELL }
  }
  const start = nearestOpen(g, cell(ax, ay))
  if (blocked[start]) return { pts: [], short: false }
  // The destination's cell when a path can get there; else the nearest one that can, and the
  // destination itself is only flown to when it's that close (inside a rock's margin, say).
  let goal = cell(bx, by)
  if (blocked[goal] || g.piece[goal] !== g.piece[start]) goal = nearestIn(g, g.piece[start], bx, by)
  const end = centre(goal)
  const exact = sq(end.x - bx) + sq(end.y - by) <= sq(CELL * 1.5)
  const price = soft?.cost
  const gc = goal % cols
  const gr = (goal - gc) / cols
  const h = (i: number) => {
    const c = i % cols
    const dx = Math.abs(c - gc)
    const dy = Math.abs((i - c) / cols - gr)
    return Math.max(dx, dy) + 0.414 * Math.min(dx, dy)
  }
  const cost = new Float32Array(cols * rows).fill(Infinity)
  const from = new Int32Array(cols * rows).fill(-1)
  const closed = new Uint8Array(cols * rows)
  // Binary heap of [f, cell].
  const heap: [number, number][] = []
  const push = (f: number, i: number) => {
    heap.push([f, i])
    let k = heap.length - 1
    while (k > 0) {
      const p = (k - 1) >> 1
      if (heap[p][0] <= heap[k][0]) break
      ;[heap[p], heap[k]] = [heap[k], heap[p]]
      k = p
    }
  }
  const pop = () => {
    const top = heap[0]
    const last = heap.pop()!
    if (heap.length) {
      heap[0] = last
      let k = 0
      for (;;) {
        const l = k * 2 + 1
        const r = l + 1
        let m = k
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r
        if (m === k) break
        ;[heap[m], heap[k]] = [heap[k], heap[m]]
        k = m
      }
    }
    return top[1]
  }
  cost[start] = 0
  push(h(start), start)
  let found = false
  while (heap.length) {
    const i = pop()
    if (closed[i]) continue
    closed[i] = 1
    if (i === goal) {
      found = true
      break
    }
    const c = i % cols
    const r = (i - c) / cols
    for (let dr = -1; dr <= 1; dr++)
      for (let dc = -1; dc <= 1; dc++) {
        if (!dc && !dr) continue
        const nc = c + dc
        const nr = r + dr
        if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue
        const n = nr * cols + nc
        if (blocked[n] || closed[n]) continue
        // No cutting corners past a blocked cell.
        if (dc && dr && (blocked[r * cols + nc] || blocked[nr * cols + c])) continue
        const step = dc && dr ? 1.414 : 1
        const g2 = cost[i] + (price ? step * (price[i] + price[n]) * 0.5 : step)
        if (g2 < cost[n]) {
          cost[n] = g2
          from[n] = i
          push(g2 + h(n), n)
        }
      }
  }
  if (!found) return { pts: [], short: false }
  // The cells in order, each with what the path cost to get there.
  const cells: Pt[] = []
  const spent: number[] = []
  for (let i = goal; i !== start && i >= 0; i = from[i]) {
    cells.push(centre(i))
    spent.push(cost[i])
  }
  cells.reverse()
  spent.reverse()
  if (exact) {
    cells.push({ x: bx, y: by })
    spent.push(cost[goal] + (Math.hypot(end.x - bx, end.y - by) / CELL) * (price ? price[goal] : 1))
  } else if (!cells.length) {
    // Already as near as it gets.
    return { pts: [end], short: true }
  }
  // Pull the path tight: from each point, jump to the furthest one in plain view, and, over soft
  // ground, only where the straight line costs no more than the path it cuts short (else it would
  // pull a line straight back through the field the path went round).
  const cheap = (from: Pt, paid: number, j: number) =>
    !price || !crosses(soft!.patches, from.x, from.y, cells[j].x, cells[j].y) || lineCost(g, price, from.x, from.y, cells[j].x, cells[j].y) <= (spent[j] - paid) * 1.02 + 0.75
  const out: Pt[] = []
  let at: Pt = { x: ax, y: ay }
  let paid = 0
  let k = 0
  while (k < cells.length) {
    let j = cells.length - 1
    while (j > k && !(clearLine(rocks, at.x, at.y, cells[j].x, cells[j].y, clear) && cheap(at, paid, j))) j--
    out.push(cells[j])
    at = cells[j]
    paid = spent[j]
    k = j + 1
  }
  return { pts: out, short: !exact }
}

// --- Placing rocks --------------------------------------------------------------------------------------

/** The open space a hull needing `clear` has while a map's rocks are scattered one by one: how many
 * rocks cover each cell, so a rock that walls something off can be taken back off. */
export type RockStamp = { w: number; h: number; cols: number; rows: number; clear: number; count: Uint16Array }

export function rockStamp(w: number, h: number, clear: number): RockStamp {
  const cols = Math.ceil(w / CELL)
  const rows = Math.ceil(h / CELL)
  const count = new Uint16Array(cols * rows)
  edgeCells(w, h, clear, cols, rows, (i) => (count[i] = 1))
  return { w, h, cols, rows, clear, count }
}

/** Puts a rock on (`d` 1) or takes it off (-1). Returns how many cells it closed or opened. */
export function stampRock(s: RockStamp, k: Circle, d: 1 | -1) {
  let changed = 0
  cellsUnder(k, s.clear, s.cols, s.rows, (i) => {
    if (d < 0 ? s.count[i] === 1 : s.count[i] === 0) changed++
    s.count[i] += d
  })
  return changed
}

/**
 * A test of whether, with the rocks stamped so far, a ship at `from` can get within `tol` of each
 * target, moving as paths do (8 ways, never cutting a corner past a blocked cell, which joins up
 * the same cells as moving 4 ways). `test` is whether it reaches them all, `reached` which ones.
 * Each call floods out from `from` until it has found them all.
 */
export function reachCheck(s: RockStamp, from: Pt, targets: (Pt & { tol: number })[]) {
  const { cols, rows, count } = s
  const cells = cols * rows
  // Which targets each cell is near enough to, as lists packed end to end: cell i's run from
  // first[i] to first[i + 1].
  const lists = new Map<number, number[]>()
  targets.forEach((t, k) => {
    const n = Math.ceil(t.tol / CELL)
    const c0 = Math.floor(t.x / CELL)
    const r0 = Math.floor(t.y / CELL)
    for (let r = Math.max(0, r0 - n); r <= Math.min(rows - 1, r0 + n); r++)
      for (let c = Math.max(0, c0 - n); c <= Math.min(cols - 1, c0 + n); c++) {
        if (sq((c + 0.5) * CELL - t.x) + sq((r + 0.5) * CELL - t.y) > sq(t.tol)) continue
        const i = r * cols + c
        const l = lists.get(i)
        if (l) l.push(k)
        else lists.set(i, [k])
      }
  })
  const first = new Int32Array(cells + 1)
  for (let i = 0; i < cells; i++) first[i + 1] = first[i] + (lists.get(i)?.length ?? 0)
  const which = new Int32Array(first[cells])
  for (const [i, l] of lists) l.forEach((k, j) => (which[first[i] + j] = k))
  const start = Math.min(rows - 1, Math.max(0, Math.floor(from.y / CELL))) * cols + Math.min(cols - 1, Math.max(0, Math.floor(from.x / CELL)))
  const seen = new Uint32Array(cells)
  const found = new Uint32Array(targets.length)
  const queue = new Int32Array(cells)
  let round = 0
  const flood = () => {
    round++
    if (count[start]) return 0
    let got = 0
    let head = 0
    let tail = 0
    seen[start] = round
    queue[tail++] = start
    const visit = (j: number) => {
      if (count[j] || seen[j] === round) return
      seen[j] = round
      queue[tail++] = j
    }
    while (head < tail && got < targets.length) {
      const i = queue[head++]
      for (let q = first[i]; q < first[i + 1]; q++)
        if (found[which[q]] !== round) {
          found[which[q]] = round
          got++
        }
      const c = i % cols
      if (c > 0) visit(i - 1)
      if (c < cols - 1) visit(i + 1)
      if (i >= cols) visit(i - cols)
      if (i + cols < cells) visit(i + cols)
    }
    return got
  }
  return {
    test: () => flood() === targets.length,
    reached: () => {
      flood()
      return targets.map((_, k) => found[k] === round)
    },
  }
}
