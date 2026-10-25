import type { Direction } from './spec.ts'

// A small layered ("Sugiyama") layout for the flow and tree visuals: cycles broken, nodes put in
// ranks by longest path, edges that skip ranks routed through dummy points, the order in each rank
// improved by barycenter sweeps (keeping the one with fewest crossings), and positions in a rank
// set by least squares (each node as close as it can be to its neighbours, in order, never
// overlapping). Enough for the few dozen nodes a model draws; no library needed.

export type LayoutNode = { id: string; w: number; h: number }
export type LayoutEdge = { from: string; to: string }
export type Box = { x: number; y: number; w: number; h: number }
/** Centres and sizes of the nodes; per edge (in the order given) the points it runs through. */
export type Layout = { nodes: Map<string, Box>; edges: { points: { x: number; y: number }[]; self: boolean }[]; width: number; height: number }

type Opts = { rankGap?: number; nodeGap?: number }

/** Pool adjacent violators: the non-decreasing sequence closest to `v` (least squares). */
function isotonic(v: number[]): number[] {
  const vals: number[] = []
  const counts: number[] = []
  for (const x of v) {
    vals.push(x)
    counts.push(1)
    while (vals.length > 1 && vals[vals.length - 2] > vals[vals.length - 1]) {
      const c = counts.pop()! + counts[counts.length - 1]
      const s = vals.pop()! * (c - counts[counts.length - 1]) + vals[vals.length - 1] * counts[counts.length - 1]
      vals[vals.length - 1] = s / c
      counts[counts.length - 1] = c
    }
  }
  const out: number[] = []
  vals.forEach((x, i) => {
    for (let k = 0; k < counts[i]; k++) out.push(x)
  })
  return out
}

export function layered(nodes: LayoutNode[], edges: LayoutEdge[], dir: Direction, opts: Opts = {}): Layout {
  const rankGap = opts.rankGap ?? 48
  const nodeGap = opts.nodeGap ?? 24
  const horizontal = dir === 'right' || dir === 'left'
  const N = nodes.length
  const index = new Map(nodes.map((n, i) => [n.id, i]))
  // Vertices: the real nodes, then dummies. breadth: size across a rank; depth: size along it.
  const breadth = nodes.map((n) => (horizontal ? n.h : n.w))
  const depth = nodes.map((n) => (horizontal ? n.w : n.h))

  // 1. Break cycles: an edge back to a node on the DFS stack is turned round for the layout.
  const out: number[][] = nodes.map(() => [])
  const real = edges.map((e) => ({ a: index.get(e.from)!, b: index.get(e.to)! }))
  real.forEach((e, i) => e.a !== e.b && out[e.a].push(i))
  const reversed = new Set<number>()
  const state = new Uint8Array(N) // 0 new, 1 on stack, 2 done
  for (let s = 0; s < N; s++) {
    if (state[s]) continue
    const stack: [number, number][] = [[s, 0]]
    state[s] = 1
    while (stack.length) {
      const top = stack[stack.length - 1]
      const [v, k] = top
      if (k >= out[v].length) {
        state[v] = 2
        stack.pop()
        continue
      }
      top[1]++
      const ei = out[v][k]
      const w = real[ei].b
      if (state[w] === 1) reversed.add(ei)
      else if (state[w] === 0) {
        state[w] = 1
        stack.push([w, 0])
      }
    }
  }
  const dag = real.map((e, i) => (reversed.has(i) ? { a: e.b, b: e.a } : e))

  // 2. Ranks: longest path from the sources, then sources pulled down next to their first child.
  const rank = new Array<number>(N).fill(0)
  const indeg = new Array<number>(N).fill(0)
  const succ: number[][] = nodes.map(() => [])
  dag.forEach((e) => {
    if (e.a === e.b) return
    succ[e.a].push(e.b)
    indeg[e.b]++
  })
  const queue: number[] = []
  for (let i = 0; i < N; i++) if (!indeg[i]) queue.push(i)
  const topo: number[] = []
  const deg = indeg.slice()
  while (queue.length) {
    const v = queue.shift()!
    topo.push(v)
    for (const w of succ[v]) {
      rank[w] = Math.max(rank[w], rank[v] + 1)
      if (!--deg[w]) queue.push(w)
    }
  }
  for (const v of topo.slice().reverse()) if (!indeg[v] && succ[v].length) rank[v] = Math.min(...succ[v].map((w) => rank[w])) - 1
  const minRank = Math.min(0, ...rank)
  for (let i = 0; i < N; i++) rank[i] -= minRank

  // 3. Dummies for edges that skip ranks; each edge's chain of vertices.
  const vRank = rank.slice()
  const vBreadth = breadth.slice()
  const vDepth = depth.slice()
  const up: number[][] = nodes.map(() => [])
  const down: number[][] = nodes.map(() => [])
  const chains: number[][] = dag.map((e) => {
    if (e.a === e.b) return [e.a]
    const chain = [e.a]
    for (let r = rank[e.a] + 1; r < rank[e.b]; r++) {
      const d = vRank.length
      vRank.push(r)
      vBreadth.push(8)
      vDepth.push(0)
      up.push([])
      down.push([])
      chain.push(d)
    }
    chain.push(e.b)
    for (let k = 0; k + 1 < chain.length; k++) {
      down[chain[k]].push(chain[k + 1])
      up[chain[k + 1]].push(chain[k])
    }
    return chain
  })
  const V = vRank.length
  const ranks = Math.max(0, ...vRank) + 1
  let layers: number[][] = Array.from({ length: ranks }, () => [])
  // Start in input order (dummies after the nodes, in edge order): models list nodes in reading order.
  for (let v = 0; v < V; v++) layers[vRank[v]].push(v)

  // 4. Order: barycenter sweeps, keeping the order with the fewest crossings.
  const pos = new Float64Array(V)
  const setPos = (ls: number[][]) => ls.forEach((l) => l.forEach((v, i) => (pos[v] = i)))
  const crossings = (ls: number[][]) => {
    setPos(ls)
    let c = 0
    for (let r = 0; r + 1 < ls.length; r++) {
      const segs: [number, number][] = []
      for (const v of ls[r]) for (const w of down[v]) segs.push([pos[v], pos[w]])
      for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) if ((segs[i][0] - segs[j][0]) * (segs[i][1] - segs[j][1]) < 0) c++
    }
    return c
  }
  const edgeCount = chains.reduce((a, c) => a + c.length - 1, 0)
  const counting = edgeCount < 800
  let best = layers.map((l) => l.slice())
  let bestC = counting ? crossings(best) : 0
  for (let it = 0; it < 8 && (!counting || bestC > 0); it++) {
    setPos(layers)
    const downward = it % 2 === 0
    const order = downward ? [...Array(ranks).keys()].slice(1) : [...Array(ranks).keys()].reverse().slice(1)
    for (const r of order) {
      const l = layers[r]
      const bary = new Map<number, number>()
      for (const v of l) {
        const ns = downward ? up[v] : down[v]
        bary.set(v, ns.length ? ns.reduce((a, w) => a + pos[w], 0) / ns.length : pos[v])
      }
      l.sort((a, b) => bary.get(a)! - bary.get(b)! || pos[a] - pos[b])
      l.forEach((v, i) => (pos[v] = i))
    }
    if (counting) {
      const c = crossings(layers)
      if (c < bestC) {
        bestC = c
        best = layers.map((l) => l.slice())
      }
    } else best = layers.map((l) => l.slice())
  }
  layers = best

  // 5. Positions across the ranks: packed, then pulled toward neighbours by least squares in order.
  const b = new Float64Array(V)
  for (const l of layers) {
    let at = 0
    for (const v of l) {
      b[v] = at + vBreadth[v] / 2
      at += vBreadth[v] + nodeGap
    }
  }
  const gapAfter = (l: number[], i: number) => (vBreadth[l[i]] + vBreadth[l[i + 1]]) / 2 + (l[i] >= N && l[i + 1] >= N ? nodeGap / 3 : nodeGap)
  for (let it = 0; it < 10; it++) {
    const downward = it % 2 === 0
    const order = downward ? [...Array(ranks).keys()] : [...Array(ranks).keys()].reverse()
    for (const r of order) {
      const l = layers[r]
      if (!l.length) continue
      const want = l.map((v) => {
        const ns = it < 2 ? (downward ? up[v] : down[v]) : [...up[v], ...down[v]]
        return ns.length ? ns.reduce((a, w) => a + b[w], 0) / ns.length : b[v]
      })
      // Offsets make "at least the gap apart" into "non-decreasing", which PAV solves.
      const off = [0]
      for (let i = 0; i + 1 < l.length; i++) off.push(off[i] + gapAfter(l, i))
      const fit = isotonic(want.map((w, i) => w - off[i]))
      l.forEach((v, i) => (b[v] = fit[i] + off[i]))
    }
  }
  let lo = Infinity
  let hi = -Infinity
  for (let v = 0; v < V; v++) {
    lo = Math.min(lo, b[v] - vBreadth[v] / 2)
    hi = Math.max(hi, b[v] + vBreadth[v] / 2)
  }
  if (!V) lo = hi = 0

  // 6. Positions along the ranks.
  const rankDepth = new Array<number>(ranks).fill(0)
  for (let v = 0; v < V; v++) rankDepth[vRank[v]] = Math.max(rankDepth[vRank[v]], vDepth[v])
  const rankAt: number[] = []
  let at = 0
  for (let r = 0; r < ranks; r++) {
    rankAt.push(at + rankDepth[r] / 2)
    at += rankDepth[r] + rankGap
  }
  const totalDepth = Math.max(0, at - rankGap)
  const totalBreadth = hi - lo
  const place = (v: number) => {
    const bb = b[v] - lo
    const rr = rankAt[vRank[v]]
    if (dir === 'down') return { x: bb, y: rr }
    if (dir === 'up') return { x: bb, y: totalDepth - rr }
    if (dir === 'right') return { x: rr, y: bb }
    return { x: totalDepth - rr, y: bb }
  }
  const boxes = new Map<string, Box>()
  nodes.forEach((n, i) => boxes.set(n.id, { ...place(i), w: n.w, h: n.h }))

  // 7. Edge points: from the side of a node facing the next rank, through the dummies.
  const forward = { down: { x: 0, y: 1 }, up: { x: 0, y: -1 }, right: { x: 1, y: 0 }, left: { x: -1, y: 0 } }[dir]
  const edgePoints = chains.map((chain, i) => {
    if (chain.length === 1) {
      const p = place(chain[0])
      return { points: [p], self: true }
    }
    const ordered = reversed.has(i) ? chain.slice().reverse() : chain
    const pts = ordered.map(place)
    const first = ordered[0]
    const last = ordered[ordered.length - 1]
    // Which way along the ranks this edge runs (a turned-round edge runs back).
    const sign = vRank[last] > vRank[first] ? 1 : -1
    const half = (v: number) => (v < N ? depth[v] / 2 : 0)
    pts[0] = { x: pts[0].x + forward.x * sign * half(first), y: pts[0].y + forward.y * sign * half(first) }
    const e = pts.length - 1
    pts[e] = { x: pts[e].x - forward.x * sign * half(last), y: pts[e].y - forward.y * sign * half(last) }
    return { points: pts, self: false }
  })
  const width = horizontal ? totalDepth : totalBreadth
  const height = horizontal ? totalBreadth : totalDepth
  return { nodes: boxes, edges: edgePoints, width, height }
}

/** An SVG path through the points, curving along the rank direction between each pair. */
export function edgePath(points: { x: number; y: number }[], dir: Direction): string {
  if (!points.length) return ''
  const r = (n: number) => Math.round(n * 10) / 10
  const vertical = dir === 'down' || dir === 'up'
  let d = `M${r(points[0].x)},${r(points[0].y)}`
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    if (vertical) {
      const my = (a.y + b.y) / 2
      d += ` C${r(a.x)},${r(my)} ${r(b.x)},${r(my)} ${r(b.x)},${r(b.y)}`
    } else {
      const mx = (a.x + b.x) / 2
      d += ` C${r(mx)},${r(a.y)} ${r(mx)},${r(b.y)} ${r(b.x)},${r(b.y)}`
    }
  }
  return d
}

/** Where an edge's label goes: the middle of its middle segment. */
export function edgeMid(points: { x: number; y: number }[]): { x: number; y: number } {
  if (points.length === 1) return points[0]
  const i = Math.max(1, Math.ceil(points.length / 2))
  const a = points[i - 1]
  const b = points[Math.min(i, points.length - 1)]
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}
