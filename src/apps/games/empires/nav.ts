// Path finding round the rocks. Rocks never move, so each ship size gets one grid of blocked
// cells, built the first time a ship that size needs a path. A path is found on the grid, then
// pulled tight so ships fly straight lines from one rock's edge to the next.

import type { Pt } from './maps'
export type { Pt }
type Circle = { x: number; y: number; r: number }

/** Grid cell size in world units. */
const CELL = 80

export type NavGrid = { cols: number; rows: number; blocked: Uint8Array }

/** Cells a ship needing `clear` units round every rock can't sit in. */
export function navGrid(rocks: Circle[], w: number, h: number, clear: number): NavGrid {
  const cols = Math.ceil(w / CELL)
  const rows = Math.ceil(h / CELL)
  const blocked = new Uint8Array(cols * rows)
  // Keep paths off the map's edge too, where ships can't swing wide round a rock.
  const edge = Math.max(CELL * 0.5, clear * 0.6)
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const x = (c + 0.5) * CELL
      const y = (r + 0.5) * CELL
      if (x < edge || y < edge || x > w - edge || y > h - edge) blocked[r * cols + c] = 1
    }
  for (const k of rocks) {
    const R = k.r + clear
    const c0 = Math.max(0, Math.floor((k.x - R) / CELL))
    const c1 = Math.min(cols - 1, Math.floor((k.x + R) / CELL))
    const r0 = Math.max(0, Math.floor((k.y - R) / CELL))
    const r1 = Math.min(rows - 1, Math.floor((k.y + R) / CELL))
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++) {
        const x = (c + 0.5) * CELL
        const y = (r + 0.5) * CELL
        if ((x - k.x) ** 2 + (y - k.y) ** 2 < R * R) blocked[r * cols + c] = 1
      }
  }
  return { cols, rows, blocked }
}

/** True when a ship needing `clear` units round rocks can fly straight from a to b. */
export function clearLine(rocks: Circle[], ax: number, ay: number, bx: number, by: number, clear: number) {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy || 1
  for (const k of rocks) {
    const t = Math.max(0, Math.min(1, ((k.x - ax) * dx + (k.y - ay) * dy) / len2))
    const R = k.r + clear
    if ((ax + dx * t - k.x) ** 2 + (ay + dy * t - k.y) ** 2 < R * R) return false
  }
  return true
}

/** The free cell nearest `i`, searching outwards; `i` itself when it's free. */
function nearestFree(g: NavGrid, i: number) {
  if (!g.blocked[i]) return i
  const seen = new Uint8Array(g.blocked.length)
  const queue = [i]
  seen[i] = 1
  for (let q = 0; q < queue.length; q++) {
    const j = queue[q]
    if (!g.blocked[j]) return j
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
  return i
}

/** Waypoints from a to b round the rocks, ending at b; empty when the way is straight. */
export function findPath(g: NavGrid, rocks: Circle[], clear: number, ax: number, ay: number, bx: number, by: number): Pt[] {
  if (clearLine(rocks, ax, ay, bx, by, clear)) return []
  const { cols, rows, blocked } = g
  const cell = (x: number, y: number) => Math.min(rows - 1, Math.max(0, Math.floor(y / CELL))) * cols + Math.min(cols - 1, Math.max(0, Math.floor(x / CELL)))
  const start = nearestFree(g, cell(ax, ay))
  const goal = nearestFree(g, cell(bx, by))
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
        const g2 = cost[i] + (dc && dr ? 1.414 : 1)
        if (g2 < cost[n]) {
          cost[n] = g2
          from[n] = i
          push(g2 + h(n), n)
        }
      }
  }
  if (!found) return []
  const cells: Pt[] = []
  for (let i = goal; i !== start && i >= 0; i = from[i]) {
    const c = i % cols
    cells.push({ x: (c + 0.5) * CELL, y: ((i - c) / cols + 0.5) * CELL })
  }
  cells.reverse()
  cells.push({ x: bx, y: by })
  // Pull the path tight: from each point, jump to the furthest one in plain view.
  const out: Pt[] = []
  let at: Pt = { x: ax, y: ay }
  let k = 0
  while (k < cells.length) {
    let j = cells.length - 1
    while (j > k && !clearLine(rocks, at.x, at.y, cells[j].x, cells[j].y, clear)) j--
    out.push(cells[j])
    at = cells[j]
    k = j + 1
  }
  return out
}
