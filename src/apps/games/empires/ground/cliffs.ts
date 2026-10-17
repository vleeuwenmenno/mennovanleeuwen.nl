import { rng } from '../maps.ts'
import { rampsOf, valueNoise } from './terrain.ts'
import { LEVELS, TF, TILE, type GroundMap } from './types.ts'

// Cliffs drawn from rock, not from images: render-only, nothing here changes the map.
//
// 1. The height contours are traced over the tile centres (marching squares, once per level), with
//    the high ground on the left, smoothed and resampled. No cliff runs across a ramp; a drop of two
//    levels is traced once. Each ramp also gets a line down the inside of each wall.
// 2. Along every line, seeded rock chunks are set down overlapping each other: a main row whose face
//    is tall where the line looks south and sinks to a low lip where it looks north (the camera sees
//    south faces), a smaller front row breaking up the foot, now and then a rock breaking the rim,
//    and rubble thinning out into the low ground. The face height changes smoothly with the line's
//    direction, so outer and inner corners and ramp walls come out of the same rule with no seams.
// 3. A rock is an irregular polygon (its top) pushed down into a prism: the sides that face the
//    camera show as facets shaded by which way they face the light (top left), the top is split
//    into a lit and a shaded half, with a bold dark outline and a lit lip on its top left edges, as
//    the ship models are painted (models/paint.ts). Each shape is painted once per size step into a
//    small bitmap and stamped, so a chunk's cliffs cost a few hundred drawImage calls.

/** A traced cliff line: points every few units as x, y, then the low side's normal nx, ny; `jump`
 * is the drop in levels; `taper` (0 to 1 per point), if given, scales the rock down (ramp walls). */
export type CliffRun = { pts: Float64Array; jump: number; taper?: Float32Array }

/** A rock set down on the map: its top's middle and radius in world units, its shape, how tall its
 * face is (an index into the style's face heights) and which painted size it uses. */
export type Rock = { x: number; y: number; r: number; shape: number; face: number; small: boolean; bottom: number; sy: number }

/** How the rocks are laid: chunk sizes, spacing, face heights (in rock radii, lip to tall). */
export type CliffStyle = {
  name: string
  /** Main row rock radius, smallest and largest, in world units. */
  size: [number, number]
  /** Distance between main rocks, in radii. */
  spacing: number
  /** Face heights in radii: lip, low, mid, tall. */
  faces: [number, number, number, number]
  /** Chance of a smaller rock in front of each main one where the face shows. */
  front: number
  /** Rubble stones per main rock, at most. */
  rubble: number
  /** Height of the cliff's body under the rocks where it looks south, in world units per level. */
  body: number
}

export const CLIFF_STYLES: Record<string, CliffStyle> = {
  // Many smaller chunks, tall faces: a broken basalt wall.
  dense: { name: 'dense', size: [12, 19], spacing: 0.75, faces: [0.3, 0.8, 1.5, 2.3], front: 0.85, rubble: 6, body: 40 },
  // Fewer, bigger blocks, lower faces: a ledge of boulders.
  blocks: { name: 'blocks', size: [18, 29], spacing: 0.95, faces: [0.22, 0.5, 0.9, 1.3], front: 0.6, rubble: 3, body: 28 },
}
export const DEFAULT_CLIFF = 'dense'

/** The biome's rock: top lit and shaded, faces lit, middle and dark, outline, and the lit lip. */
export const ROCK = { top: '#a68f75', topShade: '#8b7660', faceLit: '#7c6855', face: '#614f40', faceDark: '#45382d', line: '#1d1611', lip: 'rgba(240, 222, 188, 0.85)' }

/** Painted shapes per size: enough that neighbours rarely repeat. */
export const SHAPES = 12
/** Top polygons are flattened by this much: seen from above at a slant. */
const FLAT = 0.78
/** The radius, in world units, each painted size is drawn for (rocks are stamped scaled from it). */
export const PAINT_R = { big: 24, small: 8 }

// --- Tracing -------------------------------------------------------------------------------------

export function cliffRuns(map: GroundMap): CliffRun[] {
  const g = map.grid
  const { cols, rows } = g
  const isRamp = (t: number) => (g.flags[t] & TF.ramp) !== 0
  const ramps = rampsOf(map)
  const rampHi = new Uint8Array(cols * rows)
  for (const r of ramps) for (let y = r.r0; y <= r.r1; y++) for (let x = r.c0; x <= r.c1; x++) rampHi[y * cols + x] = r.hi
  const out: CliffRun[] = []
  const wob = valueNoise(map.def.seed * 13 + 1)
  for (let L = 1; L < LEVELS; L++) {
    const high = (t: number) => (isRamp(t) ? rampHi[t] : g.height[t]) >= L
    // Segments: from edge id `a` to edge id `b`, high ground on the left. Edge ids: the lattice edge
    // from node (c, r) to (c + 1, r) is 2 (r cols + c); to (c, r + 1) it is that plus 1.
    const segA: number[] = [], segB: number[] = [], segSkip: number[] = [], segJump: number[] = []
    const hE = (c: number, r: number) => (r * cols + c) * 2
    const vE = (c: number, r: number) => (r * cols + c) * 2 + 1
    for (let r = 0; r < rows - 1; r++)
      for (let c = 0; c < cols - 1; c++) {
        const tl = r * cols + c, tr = tl + 1, bl = tl + cols, br = bl + 1
        const m = (high(tl) ? 8 : 0) | (high(tr) ? 4 : 0) | (high(br) ? 2 : 0) | (high(bl) ? 1 : 0)
        if (m === 0 || m === 15) continue
        const top = hE(c, r), bottom = hE(c, r + 1), left = vE(c, r), right = vE(c + 1, r)
        const pairs: number[] = []
        switch (m) {
          case 1: case 14: pairs.push(left, bottom); break
          case 2: case 13: pairs.push(bottom, right); break
          case 3: case 12: pairs.push(left, right); break
          case 4: case 11: pairs.push(top, right); break
          case 5: pairs.push(top, right, left, bottom); break
          case 6: case 9: pairs.push(top, bottom); break
          case 7: case 8: pairs.push(left, top); break
          case 10: pairs.push(left, top, bottom, right); break
        }
        for (let i = 0; i < pairs.length; i += 2) {
          let a = pairs[i], b = pairs[i + 1]
          // Orient: the high node of edge a must lie left of a → b (right of travel, y down, is (-dy, dx)).
          const [ax, ay] = edgePoint(a, cols), [bx, by] = edgePoint(b, cols)
          const [h0, h1] = edgeNodes(a, cols)
          const hn = high(h0) ? h0 : h1
          const hx = ((hn % cols) + 0.5) * TILE, hy = (Math.floor(hn / cols) + 0.5) * TILE
          if ((hx - ax) * -(by - ay) + (hy - ay) * (bx - ax) > 0) [a, b] = [b, a]
          let skip = 0, hiH = 0, loH = LEVELS
          for (const e of [a, b])
            for (const t of edgeNodes(e, cols)) {
              if (isRamp(t) || (g.flags[t] & TF.water && !high(t))) skip = 1
              if (high(t)) hiH = Math.max(hiH, g.height[t])
              else loH = Math.min(loH, g.height[t])
            }
          if (hiH !== L) skip = 1
          segA.push(a), segB.push(b), segSkip.push(skip), segJump.push(Math.max(1, hiH - loH))
        }
      }
    // Chain the segments into lines.
    const startAt = new Map<number, number>()
    const endAt = new Set<number>()
    for (let i = 0; i < segA.length; i++) startAt.set(segA[i], i), endAt.add(segB[i])
    const used = new Uint8Array(segA.length)
    const follow = (first: number) => {
      const chain: number[] = []
      for (let s: number | undefined = first; s !== undefined && !used[s]; s = startAt.get(segB[s])) used[s] = 1, chain.push(s)
      return chain
    }
    const chains: number[][] = []
    for (let i = 0; i < segA.length; i++) if (!used[i] && !endAt.has(segA[i])) chains.push(follow(i))
    for (let i = 0; i < segA.length; i++) if (!used[i]) chains.push(follow(i))
    for (const chain of chains) {
      let run: number[] = []
      const flush = () => {
        if (run.length >= 1) {
          const pts: number[] = []
          for (const s of run) pts.push(...edgePoint(segA[s], cols))
          pts.push(...edgePoint(segB[run[run.length - 1]], cols))
          const r = smoothRun(pts, wob)
          if (r) out.push({ pts: r, jump: segJump[run[0]] })
        }
        run = []
      }
      for (const s of chain) {
        if (segSkip[s] || (run.length && segJump[s] !== segJump[run[0]])) flush()
        if (!segSkip[s]) run.push(s)
      }
      flush()
    }
  }
  // Ramp walls: a line down the inside of each wall, the rocks growing from nothing at the top to
  // full size at the bottom, run a little past the foot so they meet the cliff round the corner.
  for (const r of ramps) {
    const wall = (c: number, rr: number) => c >= 0 && rr >= 0 && c < cols && rr < rows && (g.flags[rr * cols + c] & TF.blocked) !== 0
    const lines: [number, number, number, number, number, number][] = [] // x0 y0 x1 y1 nx ny (from the top end)
    const x0 = r.c0 * TILE, y0 = r.r0 * TILE, x1 = (r.c1 + 1) * TILE, y1 = (r.r1 + 1) * TILE
    const past = 20
    if (r.dx === 0) {
      const ya = r.dy < 0 ? y0 : y1, yb = r.dy < 0 ? y1 + past : y0 - past
      if (wall(r.c0, r.r0) && wall(r.c0, r.r1)) lines.push([x0 + TILE, ya, x0 + TILE, yb, 1, 0])
      if (wall(r.c1, r.r0) && wall(r.c1, r.r1)) lines.push([x1 - TILE, ya, x1 - TILE, yb, -1, 0])
    } else {
      const xa = r.dx < 0 ? x0 : x1, xb = r.dx < 0 ? x1 + past : x0 - past
      if (wall(r.c0, r.r0) && wall(r.c1, r.r0)) lines.push([xa, y0 + TILE, xb, y0 + TILE, 0, 1])
      if (wall(r.c0, r.r1) && wall(r.c1, r.r1)) lines.push([xa, y1 - TILE, xb, y1 - TILE, 0, -1])
    }
    for (const [ax, ay, bx, by, nx, ny] of lines) {
      const len = Math.hypot(bx - ax, by - ay)
      const n = Math.max(2, Math.ceil(len / 4) + 1)
      const pts = new Float64Array(n * 4)
      const taper = new Float32Array(n)
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1)
        pts[i * 4] = ax + (bx - ax) * t
        pts[i * 4 + 1] = ay + (by - ay) * t
        pts[i * 4 + 2] = nx
        pts[i * 4 + 3] = ny
        taper[i] = Math.min(1, (t * len) / (len - past))
      }
      out.push({ pts, jump: r.hi - r.lo, taper })
    }
  }
  return out
}

function edgePoint(e: number, cols: number): [number, number] {
  const n = e >> 1, c = n % cols, r = (n - c) / cols
  return e & 1 ? [(c + 0.5) * TILE, (r + 1) * TILE] : [(c + 1) * TILE, (r + 0.5) * TILE]
}
function edgeNodes(e: number, cols: number): [number, number] {
  const n = e >> 1
  return e & 1 ? [n, n + cols] : [n, n + 1]
}

/** Chaikin twice (ends kept), resampled every 4 units, with the normal towards the low side and a
 * nudge of ±3 units by noise. */
function smoothRun(src: number[], wob: (x: number, y: number) => number): Float64Array | null {
  let pts = src
  for (let it = 0; it < 2; it++) {
    const next = [pts[0], pts[1]]
    for (let i = 0; i + 3 < pts.length; i += 2) {
      const x0 = pts[i], y0 = pts[i + 1], x1 = pts[i + 2], y1 = pts[i + 3]
      next.push(x0 * 0.75 + x1 * 0.25, y0 * 0.75 + y1 * 0.25, x0 * 0.25 + x1 * 0.75, y0 * 0.25 + y1 * 0.75)
    }
    next.push(pts[pts.length - 2], pts[pts.length - 1])
    pts = next
  }
  const STEP = 4
  const res: number[] = []
  let carry = 0
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const x0 = pts[i], y0 = pts[i + 1], dx = pts[i + 2] - x0, dy = pts[i + 3] - y0
    const len = Math.hypot(dx, dy)
    if (len < 1e-6) continue
    for (let d = carry; d < len; d += STEP) res.push(x0 + (dx * d) / len, y0 + (dy * d) / len)
    carry = (carry - len) % STEP
    if (carry < 0) carry += STEP
  }
  res.push(pts[pts.length - 2], pts[pts.length - 1])
  const n = res.length / 2
  if (n < 2) return null
  const xs = new Float64Array(n * 4)
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 2), b = Math.min(n - 1, i + 2)
    const tx = res[b * 2] - res[a * 2], ty = res[b * 2 + 1] - res[a * 2 + 1]
    const tl = Math.hypot(tx, ty) || 1
    const nx = -ty / tl, ny = tx / tl
    const nudge = (wob(res[i * 2] / 40, res[i * 2 + 1] / 40) - 0.5) * 6
    xs[i * 4] = res[i * 2] + nx * nudge
    xs[i * 4 + 1] = res[i * 2 + 1] + ny * nudge
    xs[i * 4 + 2] = nx
    xs[i * 4 + 3] = ny
  }
  return xs
}

// --- Laying the rocks ----------------------------------------------------------------------------

const smooth = (a: number, b: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** The rocks along every cliff line, sorted by their bottom edge so nearer rocks overlap farther ones. */
export function layRocks(map: GroundMap, runs: CliffRun[], style: CliffStyle): Rock[] {
  const rand = rng(map.def.seed * 17 + 5)
  const rocks: Rock[] = []
  const faceOf = (i: number) => style.faces[Math.max(0, Math.min(3, i))]
  const add = (x: number, y: number, r: number, face: number, small: boolean) => {
    if (r < 1.5) return
    // Stretched up or down a little each, so neighbouring columns never stand the same height.
    const sy = 0.85 + rand() * 0.4
    rocks.push({ x, y, r, shape: Math.floor(rand() * SHAPES), face, small, sy, bottom: y + r * (FLAT + faceOf(face)) * sy })
  }
  for (const run of runs) {
    const p = run.pts
    const n = p.length / 4
    // Walk the line, a main rock every spacing × radius (jittered).
    let i = 0
    let along = 0
    let next = 0
    let prevX = p[0], prevY = p[1]
    while (i < n) {
      const x = p[i * 4], y = p[i * 4 + 1]
      along += Math.hypot(x - prevX, y - prevY)
      prevX = x
      prevY = y
      if (along < next) {
        i++
        continue
      }
      const nx = p[i * 4 + 2], ny = p[i * 4 + 3]
      const tx = ny, ty = -nx // along the line
      const taper = run.taper ? run.taper[i] : 1
      // 0 where the line looks north (the face is hidden: a lip), 1 where it looks south (a tall face).
      const south = smooth(-0.65, 0.65, ny) * (0.35 + 0.65 * taper)
      const big = run.jump > 1 ? 1.3 : 1
      const r = (style.size[0] + (style.size[1] - style.size[0]) * rand()) * big * (0.6 + 0.4 * taper)
      const face = south > 0.7 ? 3 : south > 0.42 ? 2 : south > 0.15 ? 1 : 0
      // The top sits on the rim, a little out over the low side where the face shows less.
      const out = r * (0.1 + 0.45 * (1 - south)) + (rand() - 0.5) * r * 0.3
      add(x + nx * out + tx * (rand() - 0.5) * r * 0.4, y + ny * out + ty * (rand() - 0.5) * r * 0.4, r, face, false)
      // Often a rock set back on the rim, so the edge is a band of rock rather than one row.
      if (rand() < 0.5) add(x - nx * r * 0.5 + tx * (rand() - 0.5) * r, y - ny * r * 0.5 + ty * (rand() - 0.5) * r, r * (0.55 + rand() * 0.3), 0, false)
      // Where the face is tall, a second tier stacked below the first, so the wall looks built up.
      if (south > 0.55 && rand() < 0.8) {
        const d = r * faceOf(face) * 0.75
        add(x + tx * (rand() - 0.5) * r * 0.8, y + d + r * 0.2, r * (0.7 + rand() * 0.25), 2, false)
      }
      // A smaller rock in front of the face, so the foot isn't one straight line.
      if (south > 0.2 && rand() < style.front) {
        const fr = r * (0.45 + rand() * 0.3)
        const d = r * (0.5 + faceOf(face) * 0.55)
        add(x + nx * d + tx * (rand() - 0.5) * r * 0.9, y + ny * d + ty * (rand() - 0.5) * r * 0.9, fr, Math.max(0, face - 1), fr < 9)
      }
      // Rubble thinning out into the low ground, farther below a tall face.
      const stones = Math.floor(rand() * (style.rubble + 1) * (0.4 + 0.6 * taper))
      for (let s = 0; s < stones; s++) {
        const far = rand()
        const d = r * (1 + faceOf(face) * 0.8) + far * far * (22 + 40 * south)
        const sr = (2.2 + rand() * 4.5) * (1 - far * 0.5)
        add(x + nx * d + tx * (rand() - 0.5) * r * 2.2, y + ny * d + ty * (rand() - 0.5) * r * 2.2, sr, rand() < 0.5 ? 1 : 0, true)
      }
      next = along + r * style.spacing * (0.8 + rand() * 0.4)
      i++
    }
  }
  rocks.sort((a, b) => a.bottom - b.bottom || a.x - b.x)
  return rocks
}

/** The box a rock covers when drawn, in world units: x0, y0, x1, y1. */
/** The cliff's body along a run: the band from the rim down to where its rocks stand, drawn dark
 * under them so no ground shows between the chunks. Tall where the line looks south, a thin strip
 * where it looks north. Returns the band's lower edge as x, y pairs, one per point of the run. */
export function bodyEdge(run: CliffRun, style: CliffStyle): Float64Array {
  const p = run.pts
  const n = p.length / 4
  const out = new Float64Array(n * 2)
  for (let i = 0; i < n; i++) {
    const nx = p[i * 4 + 2], ny = p[i * 4 + 3]
    const taper = run.taper ? run.taper[i] : 1
    const south = smooth(-0.65, 0.65, ny)
    const big = run.jump > 1 ? 1.3 : 1
    const across = (8 + 10 * (1 - south)) * big * (0.4 + 0.6 * taper)
    const down = style.body * south * big * taper
    out[i * 2] = p[i * 4] + nx * across
    out[i * 2 + 1] = p[i * 4 + 1] + ny * across + down
  }
  return out
}

export function rockBox(rock: Rock): [number, number, number, number] {
  const pad = rock.r * 0.15
  return [rock.x - rock.r - pad, rock.y - rock.r * FLAT * rock.sy - pad, rock.x + rock.r + pad, rock.bottom + pad]
}

// --- Painting a rock -----------------------------------------------------------------------------

/** The unit top polygon of shape `s`: 5 to 9 corners, jittered, flattened. Seeded by the shape. */
function shapePolygon(s: number): number[] {
  const rand = rng(9173 + s * 101)
  const m = 5 + Math.floor(rand() * 5)
  const start = rand() * Math.PI * 2
  const pts: number[] = []
  for (let i = 0; i < m; i++) {
    const a = start + ((i + (rand() - 0.5) * 0.6) / m) * Math.PI * 2
    const rr = 0.74 + rand() * 0.26
    pts.push(Math.cos(a) * rr, Math.sin(a) * rr * FLAT)
  }
  return pts
}

/**
 * Paints one rock shape: radius `R` pixels, face `h` pixels tall. Returns the bitmap and where the
 * top's middle sits in it. Sides facing the camera become facets shaded by how they face the light;
 * the top is split into a lit and a shaded half; outlined bold, with a lit lip on the top left.
 * `grain`, if given, is a pattern laid faintly over it for the rock's texture.
 */
export function paintRock(shape: number, R: number, h: number, grain: CanvasPattern | null): { canvas: HTMLCanvasElement; cx: number; cy: number } {
  const ow = Math.max(1, R * 0.085)
  const pad = Math.ceil(ow * 1.5 + 1)
  const unit = shapePolygon(shape)
  const m = unit.length / 2
  const cx = pad + R, cy = pad + R * FLAT
  const top: number[] = []
  for (let i = 0; i < m; i++) top.push(cx + unit[i * 2] * R, cy + unit[i * 2 + 1] * R)
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(2 * R + 2 * pad)
  canvas.height = Math.ceil(2 * R * FLAT + h + 2 * pad)
  const x = canvas.getContext('2d')!
  x.lineJoin = 'round'
  x.lineCap = 'round'
  // The sides the camera sees: edges whose outward normal points down the screen.
  type Side = { a: number; b: number; nx: number; ny: number }
  const sides: Side[] = []
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m
    const ex = top[j * 2] - top[i * 2], ey = top[j * 2 + 1] - top[i * 2 + 1]
    const el = Math.hypot(ex, ey) || 1
    let nx = ey / el, ny = -ex / el
    const mx = (top[i * 2] + top[j * 2]) / 2 - cx, my = (top[i * 2 + 1] + top[j * 2 + 1]) / 2 - cy
    if (nx * mx + ny * my < 0) (nx = -nx), (ny = -ny)
    if (ny > 0.02) sides.push({ a: i, b: j, nx, ny })
  }
  const topPath = () => {
    x.beginPath()
    for (let i = 0; i < m; i++) i ? x.lineTo(top[i * 2], top[i * 2 + 1]) : x.moveTo(top[0], top[1])
    x.closePath()
  }
  const sidePath = (s: Side) => {
    x.beginPath()
    x.moveTo(top[s.a * 2], top[s.a * 2 + 1])
    x.lineTo(top[s.b * 2], top[s.b * 2 + 1])
    x.lineTo(top[s.b * 2], top[s.b * 2 + 1] + h)
    x.lineTo(top[s.a * 2], top[s.a * 2 + 1] + h)
    x.closePath()
  }
  // The bold outline: every piece stroked fat in the line colour first, then filled over.
  x.fillStyle = ROCK.line
  x.strokeStyle = ROCK.line
  x.lineWidth = ow * 2
  topPath()
  x.fill()
  x.stroke()
  for (const s of sides) {
    sidePath(s)
    x.fill()
    x.stroke()
  }
  // Faces: lit facing left (towards the light), dark facing right, middle between.
  for (const s of sides) {
    x.fillStyle = s.nx < -0.3 ? ROCK.faceLit : s.nx > 0.35 ? ROCK.faceDark : ROCK.face
    sidePath(s)
    x.fill()
  }
  // Top: lit, with its lower right half (beyond a ridge from top right to bottom left) shaded.
  x.fillStyle = ROCK.top
  topPath()
  x.fill()
  let a = 0, b = 0
  for (let i = 0; i < m; i++) {
    const px = top[i * 2] - cx, py = top[i * 2 + 1] - cy
    if (px - py > top[a * 2] - cx - (top[a * 2 + 1] - cy)) a = i
    if (py - px > top[b * 2 + 1] - cy - (top[b * 2] - cx)) b = i
  }
  x.save()
  topPath()
  x.clip()
  x.fillStyle = ROCK.topShade
  x.beginPath()
  x.moveTo(top[a * 2], top[a * 2 + 1])
  x.lineTo(top[b * 2], top[b * 2 + 1])
  x.lineTo(cx + R * 2, cy + R * 2)
  x.closePath()
  x.fill()
  x.restore()
  // Grain: the rocky ground's texture, faintly, over top and faces.
  if (grain) {
    x.save()
    x.globalAlpha = 0.28
    x.globalCompositeOperation = 'overlay'
    x.fillStyle = grain
    topPath()
    x.fill()
    for (const s of sides) {
      sidePath(s)
      x.fill()
    }
    x.restore()
  }
  // Inner lines: where faces meet each other and the top.
  x.strokeStyle = ROCK.line
  x.lineWidth = ow * 0.7
  x.beginPath()
  for (const s of sides) {
    x.moveTo(top[s.a * 2], top[s.a * 2 + 1])
    x.lineTo(top[s.b * 2], top[s.b * 2 + 1])
    x.moveTo(top[s.a * 2], top[s.a * 2 + 1])
    x.lineTo(top[s.a * 2], top[s.a * 2 + 1] + h)
  }
  x.stroke()
  // The lit lip along the top's edges that face the light.
  x.strokeStyle = ROCK.lip
  x.lineWidth = ow * 0.85
  x.beginPath()
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m
    const ex = top[j * 2] - top[i * 2], ey = top[j * 2 + 1] - top[i * 2 + 1]
    const mx = (top[i * 2] + top[j * 2]) / 2 - cx, my = (top[i * 2 + 1] + top[j * 2 + 1]) / 2 - cy
    let nx = ey, ny = -ex
    if (nx * mx + ny * my < 0) (nx = -nx), (ny = -ny)
    if (nx + ny < -0.2 * Math.hypot(ex, ey)) {
      // Inset a touch, so the outline still frames it.
      const ix = -nx / Math.hypot(nx, ny) * ow * 0.9, iy = -ny / Math.hypot(nx, ny) * ow * 0.9
      x.moveTo(top[i * 2] + ix, top[i * 2 + 1] + iy)
      x.lineTo(top[j * 2] + ix, top[j * 2 + 1] + iy)
    }
  }
  x.stroke()
  return { canvas, cx, cy }
}
