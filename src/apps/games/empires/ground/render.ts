import { PROP_INFO, rampsOf, valueNoise, type GroundRamp } from './terrain.ts'
import { LEVELS, TF, TILE, terrainIndex, type GroundMap, type Prop } from './types.ts'

// Draws a ground map on a 2D canvas (plan D8). The terrain is baked into chunks of 16 × 16 tiles at
// the zoom's size step (steps of √2, as ship bitmaps are), kept in an LRU cache with a memory
// budget, and drawn as a handful of drawImage calls a frame. Baking is spread over frames, at most
// about 3 ms a frame; until a chunk is ready at the wanted step, the nearest step already baked
// stands in for it.
//
// A bake, in passes: blend masks for the chunk (from the tile grid plus noise), the ground textures
// as repeating patterns cut by those masks (dirt, grass, rocky, each with a second variant), water,
// a faint large-scale tint and a little shade by level, the ramps, the cliffs (a generated cliff-face
// strip bent along the height contours in thin columns), and the props that lie flat.
//
// Each frame: the chunks, then the screen's ground and unit layers, then the tall props (trees,
// above units), then fog, the debug overlay and the screen's overlay. Hooks are drawn in world
// coordinates (see GroundLayers). Nothing is allocated a frame, and no canvas filters are used.

/** The camera: the world point at the middle of the canvas, CSS pixels per world unit, and the
 * canvas's size in CSS pixels with its device pixel ratio (capped at 2 by the caller). */
export type GroundView = { x: number; y: number; zoom: number; w: number; h: number; dpr: number }

/** What the screen draws into the frame, each called with the world transform set (one unit of the
 * context is one world unit). `ground`: on the ground, under units (selection rings, build ghosts,
 * tracks); `units`: units and buildings; `fog`: over everything in the world, trees included;
 * `overlay`: last. */
export type GroundLayers = {
  ground?: (ctx: CanvasRenderingContext2D) => void
  units?: (ctx: CanvasRenderingContext2D) => void
  fog?: (ctx: CanvasRenderingContext2D) => void
  overlay?: (ctx: CanvasRenderingContext2D) => void
}

export type GroundRendererOptions = {
  /** Memory for baked chunks, in bytes: about 48 MB on desktops, 24 MB on phones. */
  budget?: number
  /** The densest bake, in pixels per world unit (zooming in further scales the chunks up). */
  maxScale?: number
  /** Where the images live. */
  base?: string
  /** Milliseconds of baking a frame, once something is on screen. */
  bakeMs?: number
}

/** World units per chunk side. */
export const CHUNK = 16 * TILE
/** Size steps: a bake at step k is drawn at 2^(k/2) pixels per world unit. */
const K_MIN = -8
/** At this step and below the trees are baked into the ground: units are too small to hide under them. */
const K_FAR = -3
/** Every chunk is also baked at this tiny step (64 pixels a side) when there's time, and kept, so a
 * stand-in is always there wherever the view pans to. */
const K_LOW = -6
const stepScale = (k: number) => Math.pow(2, k / 2)

const TEXTURES = ['dirt-a', 'dirt-b', 'grass-a', 'grass-b', 'rocky-a', 'rocky-b'] as const
type TexName = (typeof TEXTURES)[number]
/** World units one texture repeat covers (8 tiles). */
const TEX_WORLD = 256

/** How the stone props are warmed to sit with the cliff rock, and the lift shadow's colour. */
const STONE_TINT = 'rgba(122, 86, 52, 0.3)'
const SHADOW = '#140e08'
const SHADOW_ALPHA = 0.4
const DIRT_FILL = '#6e5238'

// --- Cliff contours ------------------------------------------------------------------------------

type CliffKind = 0 | 1 | 2 | 3 // south face, north lip, east face, west face
const SOUTH = 0, NORTH = 1, EAST = 2, WEST = 3
/** A stretch of cliff of one kind: points every few units as x, y, then the low side's normal nx, ny. */
type CliffPiece = { kind: CliffKind; jump: number; pts: Float64Array; x0: number; y0: number; x1: number; y1: number }

/**
 * The cliff lines of a map: marching squares over the tile centres, once per height threshold,
 * chained into lines with the high ground on their left, smoothed (Chaikin), resampled, nudged by a
 * little noise, and cut into pieces by which way they face. No cliff is drawn across a ramp, and a
 * drop of two levels is drawn once, taller.
 */
function cliffPieces(map: GroundMap): CliffPiece[] {
  const g = map.grid
  const { cols, rows } = g
  const isRamp = (t: number) => (g.flags[t] & TF.ramp) !== 0
  const rampHi = new Uint8Array(cols * rows)
  for (const r of rampsOf(map)) for (let y = r.r0; y <= r.r1; y++) for (let x = r.c0; x <= r.c1; x++) rampHi[y * cols + x] = r.hi
  const out: CliffPiece[] = []
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
          // Orient: the high node of edge a must lie left of a → b.
          const [ax, ay] = edgePoint(a, cols), [bx, by] = edgePoint(b, cols)
          const [h0, h1] = edgeNodes(a, cols)
          const hn = high(h0) ? h0 : h1
          const hx = ((hn % cols) + 0.5) * TILE, hy = (Math.floor(hn / cols) + 0.5) * TILE
          // Right of travel (y down) is (-dy, dx).
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
      // Runs of drawn segments of one height.
      let run: number[] = []
      const flush = () => {
        if (run.length >= 2) addPieces(out, run, segA, segB, segJump[run[0]], cols, wob)
        run = []
      }
      for (const s of chain) {
        if (segSkip[s] || (run.length && segJump[s] !== segJump[run[0]])) flush()
        if (!segSkip[s]) run.push(s)
      }
      flush()
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

/** Turns a run of segments into smoothed, resampled pieces, one per facing. */
function addPieces(out: CliffPiece[], run: number[], segA: number[], segB: number[], jump: number, cols: number, wob: (x: number, y: number) => number) {
  let pts: number[] = []
  for (const s of run) pts.push(...edgePoint(segA[s], cols))
  pts.push(...edgePoint(segB[run[run.length - 1]], cols))
  // Chaikin, twice, keeping the ends.
  for (let it = 0; it < 2; it++) {
    const next = [pts[0], pts[1]]
    for (let i = 0; i + 3 < pts.length; i += 2) {
      const x0 = pts[i], y0 = pts[i + 1], x1 = pts[i + 2], y1 = pts[i + 3]
      next.push(x0 * 0.75 + x1 * 0.25, y0 * 0.75 + y1 * 0.25, x0 * 0.25 + x1 * 0.75, y0 * 0.25 + y1 * 0.75)
    }
    next.push(pts[pts.length - 2], pts[pts.length - 1])
    pts = next
  }
  // Resample every 4 units, with the normal towards the low side, nudged ±3 units by noise.
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
  if (n < 2) return
  const xs = new Float64Array(n * 4)
  const kinds = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1)
    const tx = res[b * 2] - res[a * 2], ty = res[b * 2 + 1] - res[a * 2 + 1]
    const tl = Math.hypot(tx, ty) || 1
    const nx = -ty / tl, ny = tx / tl
    const nudge = (wob(res[i * 2] / 40, res[i * 2 + 1] / 40) - 0.5) * 6
    xs[i * 4] = res[i * 2] + nx * nudge
    xs[i * 4 + 1] = res[i * 2 + 1] + ny * nudge
    xs[i * 4 + 2] = nx
    xs[i * 4 + 3] = ny
    kinds[i] = ny >= 0.5 ? SOUTH : ny <= -0.5 ? NORTH : nx > 0 ? EAST : WEST
  }
  // Steady the facing along the line (the most common within ±5 points), then cut it into pieces.
  const steady = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    let c0 = 0, c1 = 0, c2 = 0, c3 = 0
    for (let j = Math.max(0, i - 5); j <= Math.min(n - 1, i + 5); j++) {
      const k = kinds[j]
      if (k === 0) c0++
      else if (k === 1) c1++
      else if (k === 2) c2++
      else c3++
    }
    const best = Math.max(c0, c1, c2, c3)
    steady[i] = (best === c0 ? 0 : best === c1 ? 1 : best === c2 ? 2 : 3) as CliffKind
  }
  let start = 0
  for (let i = 1; i <= n; i++) {
    if (i < n && steady[i] === steady[start]) continue
    // Pieces overlap by a point so the joins don't gap.
    const a = Math.max(0, start - 1), b = Math.min(n, i + 1)
    const pts4 = xs.slice(a * 4, b * 4)
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (let j = 0; j < pts4.length; j += 4) {
      x0 = Math.min(x0, pts4[j]); x1 = Math.max(x1, pts4[j]); y0 = Math.min(y0, pts4[j + 1]); y1 = Math.max(y1, pts4[j + 1])
    }
    out.push({ kind: steady[start] as CliffKind, jump, pts: pts4, x0, y0, x1, y1 })
    start = i
  }
}

// --- Images --------------------------------------------------------------------------------------

const newCanvas = (w: number, h: number) => {
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.ceil(w))
  c.height = Math.max(1, Math.ceil(h))
  return c
}
const ctx2d = (c: HTMLCanvasElement) => c.getContext('2d')!

function loadImage(src: string) {
  return new Promise<HTMLImageElement | null>((ok) => {
    const img = new Image()
    img.onload = () => ok(img)
    img.onerror = () => ok(null)
    img.src = src
  })
}

/** A tiling texture shrunk to `size` pixels a side, wrapping at its edges, by halving steps. */
function shrinkTile(src: CanvasImageSource, from: number, size: number) {
  let cur = src
  let s = from
  while (s / 2 >= size) {
    const c = newCanvas(s / 2, s / 2)
    const x = ctx2d(c)
    const p = x.createPattern(cur, 'repeat')!
    p.setTransform(new DOMMatrix([0.5, 0, 0, 0.5, 0, 0]))
    x.fillStyle = p
    x.fillRect(0, 0, s / 2, s / 2)
    cur = c
    s /= 2
  }
  if (s === size) return cur
  const c = newCanvas(size, size)
  const x = ctx2d(c)
  x.imageSmoothingQuality = 'high'
  const p = x.createPattern(cur, 'repeat')!
  p.setTransform(new DOMMatrix([size / s, 0, 0, size / s, 0, 0]))
  x.fillStyle = p
  x.fillRect(0, 0, size, size)
  return c
}

/** Halving copies of an image, the original first, for drawing it small without shimmer. */
function mipChain(img: CanvasImageSource, w: number, h: number) {
  const out: { img: CanvasImageSource; f: number }[] = [{ img, f: 1 }]
  let cur = img, cw = w, ch = h, f = 1
  while (cw > 64 && ch > 32) {
    const c = newCanvas(cw / 2, ch / 2)
    const x = ctx2d(c)
    x.imageSmoothingQuality = 'high'
    x.drawImage(cur, 0, 0, c.width, c.height)
    f /= 2
    cur = c
    cw = c.width
    ch = c.height
    out.push({ img: c, f })
  }
  return out
}
/** The smallest mip still at least `scale` of the original's size. */
const pickMip = (chain: { img: CanvasImageSource; f: number }[], scale: number) => {
  let best = chain[0]
  for (const m of chain) if (m.f >= scale) best = m
  return best
}

// --- The renderer --------------------------------------------------------------------------------

type Chunk = { canvas: HTMLCanvasElement; bytes: number; used: number }
type Job = { cx: number; cy: number; k: number; pass: number; canvas: HTMLCanvasElement; sx: number }

export class GroundRenderer {
  readonly map: GroundMap
  /** Debug overlay switches. */
  debug = { grid: false, heights: false, flags: false }
  private budget: number
  private kMax: number
  private base: string
  private bakeMs: number
  private ccols: number
  private crows: number
  private cache = new Map<number, Chunk>()
  private bytes = 0
  private frame = 0
  private job: Job | null = null
  private tex = new Map<string, HTMLImageElement>()
  private texMips = new Map<string, CanvasImageSource>()
  private propImg = new Map<string, HTMLImageElement>()
  private propCache = new Map<string, HTMLCanvasElement>()
  private propMax = new Map<string, number>()
  private strip: { img: CanvasImageSource; f: number }[] = []
  private stripEast: { img: CanvasImageSource; f: number }[] = []
  private stripWest: { img: CanvasImageSource; f: number }[] = []
  private stripW = 1
  private stripH = 1
  private ewH = 1
  private rampImg: HTMLImageElement | null = null
  private loaded = false
  readonly ready: Promise<void>
  private pieces: CliffPiece[]
  private ramps: GroundRamp[]
  private flats: Prop[]
  private talls: Prop[]
  private tallMax = 0
  /** The trees' sprites and sizes at the step they were last drawn at, so a frame looks nothing up. */
  private tallK = -99
  private tallSprite: (HTMLCanvasElement | null)[] = []
  private tallW = new Float32Array(0)
  private tallH = new Float32Array(0)
  private chunkPieces: number[][]
  private chunkFlats: number[][]
  private chunkTalls: number[][]
  private chunkRamps: number[][]
  // Blend fields, one value per tile.
  private fGrass: Float32Array
  private fRocky: Float32Array
  private fWater: Float32Array
  private fLevel: Float32Array
  private noise: ((x: number, y: number) => number)[]
  // Scratch for baking (one chunk bakes at a time).
  private scratch: HTMLCanvasElement | null = null
  private masks: Record<string, HTMLCanvasElement> = {}
  private maskRect = { x: 0, y: 0, w: 0, h: 0, u: 1 }
  private debugCanvas: HTMLCanvasElement | null = null
  private debugFor = ''
  // Reused each frame: chunks to bake, by priority: in view at the wanted step, every chunk at the
  // tiny step, then the ring just outside the view at the wanted step.
  private wanted: number[] = []
  private wantedLow: number[] = []
  private wantedRing: number[] = []
  /** How long each bake pass took lately (ms), so a pass that won't fit the frame waits for the next. */
  private passCost = new Float64Array(8).fill(1)
  private visibleNoBake = false

  constructor(map: GroundMap, opts: GroundRendererOptions = {}) {
    this.map = map
    this.budget = opts.budget ?? 48 * 1024 * 1024
    this.kMax = Math.round(2 * Math.log2(opts.maxScale ?? 2))
    this.base = opts.base ?? '/games/empires/ground/'
    this.bakeMs = opts.bakeMs ?? 3
    const g = map.grid
    this.ccols = Math.ceil((g.cols * TILE) / CHUNK)
    this.crows = Math.ceil((g.rows * TILE) / CHUNK)
    this.pieces = cliffPieces(map)
    this.ramps = rampsOf(map)
    this.flats = map.props.filter((p) => !PROP_INFO[p.kind]?.tall)
    this.talls = map.props.filter((p) => PROP_INFO[p.kind]?.tall).sort((a, b) => a.y - b.y)
    for (const p of this.talls) this.tallMax = Math.max(this.tallMax, p.size)
    for (const p of map.props) this.propMax.set(p.kind, Math.max(this.propMax.get(p.kind) ?? 0, p.size))
    // Which pieces, props and ramps touch each chunk (with room for what hangs over its edges).
    const n = this.ccols * this.crows
    const lists = () => Array.from({ length: n }, () => [] as number[])
    this.chunkPieces = lists()
    this.chunkFlats = lists()
    this.chunkTalls = lists()
    this.chunkRamps = lists()
    const add = (into: number[][], i: number, x0: number, y0: number, x1: number, y1: number) => {
      const a = Math.max(0, Math.floor(x0 / CHUNK)), b = Math.min(this.ccols - 1, Math.floor(x1 / CHUNK))
      const c = Math.max(0, Math.floor(y0 / CHUNK)), d = Math.min(this.crows - 1, Math.floor(y1 / CHUNK))
      for (let y = c; y <= d; y++) for (let x = a; x <= b; x++) into[y * this.ccols + x].push(i)
    }
    this.pieces.forEach((p, i) => add(this.chunkPieces, i, p.x0 - 120, p.y0 - 120, p.x1 + 120, p.y1 + 120))
    this.flats.forEach((p, i) => add(this.chunkFlats, i, p.x - p.size, p.y - p.size, p.x + p.size, p.y + p.size))
    this.talls.forEach((p, i) => add(this.chunkTalls, i, p.x - p.size, p.y - p.size, p.x + p.size, p.y + p.size))
    this.ramps.forEach((r, i) => add(this.chunkRamps, i, r.c0 * TILE - 64, r.r0 * TILE - 64, (r.c1 + 1) * TILE + 64, (r.r1 + 1) * TILE + 64))
    // Blend fields.
    const cells = g.cols * g.rows
    this.fGrass = new Float32Array(cells)
    this.fRocky = new Float32Array(cells)
    this.fWater = new Float32Array(cells)
    this.fLevel = new Float32Array(cells)
    const GRASS = terrainIndex('grass'), ROCKY = terrainIndex('rocky')
    for (let t = 0; t < cells; t++) {
      this.fGrass[t] = g.terrain[t] === GRASS ? 1 : 0
      this.fRocky[t] = g.terrain[t] === ROCKY ? 1 : 0
      this.fWater[t] = g.flags[t] & TF.water ? 1 : 0
      this.fLevel[t] = g.height[t]
    }
    this.noise = Array.from({ length: 10 }, (_, i) => valueNoise(map.def.seed * 31 + 100 + i))
    this.ready = this.load()
  }

  private async load() {
    const b = this.base
    const [texs, strip, ew, ramp, props] = await Promise.all([
      Promise.all(TEXTURES.map((t) => loadImage(`${b}terrain/${t}.webp`))),
      loadImage(`${b}terrain/cliff-strip.webp`),
      loadImage(`${b}terrain/cliff-strip-ew.webp`),
      loadImage(`${b}terrain/ramp.webp`),
      Promise.all([...this.propMax.keys()].map((k) => loadImage(`${b}props/${k}.webp`).then((img) => [k, img] as const))),
    ])
    TEXTURES.forEach((t, i) => texs[i] && this.tex.set(t, texs[i]))
    for (const [k, img] of props) if (img) this.propImg.set(k, img)
    this.rampImg = ramp
    if (strip) {
      this.stripW = strip.width
      this.stripH = strip.height
      this.strip = mipChain(strip, strip.width, strip.height)
    }
    if (ew) {
      // The east/west strip turned upright: rim on the left for faces looking east (in shade), on
      // the right for faces looking west (in the light).
      const east = newCanvas(ew.height, ew.width)
      const ex = ctx2d(east)
      ex.translate(0, ew.width)
      ex.rotate(-Math.PI / 2)
      ex.drawImage(ew, 0, 0)
      ex.setTransform(1, 0, 0, 1, 0, 0)
      ex.globalCompositeOperation = 'source-atop'
      ex.fillStyle = 'rgba(16, 10, 6, 0.3)'
      ex.fillRect(0, 0, east.width, east.height)
      const west = newCanvas(ew.height, ew.width)
      const wx = ctx2d(west)
      wx.translate(ew.height, 0)
      wx.rotate(Math.PI / 2)
      wx.drawImage(ew, 0, 0)
      this.ewH = ew.width
      this.stripEast = mipChain(east, east.width, east.height)
      this.stripWest = mipChain(west, west.width, west.height)
    }
    this.loaded = true
  }

  /** Bytes held by baked chunks. */
  get cacheBytes() {
    return this.bytes
  }
  /** How many chunk bitmaps are baked. */
  get cacheCount() {
    return this.cache.size
  }

  /** Drops every baked chunk (after a theme or quality change, or to free memory). */
  clear() {
    for (const c of this.cache.values()) c.canvas.width = 0
    this.cache.clear()
    this.bytes = 0
    this.job = null
  }

  /** The size step wanted for a view, lowered until the visible chunks fit the memory budget. */
  private stepFor(view: GroundView) {
    const d = view.zoom * view.dpr
    let k = Math.max(K_MIN, Math.min(this.kMax, Math.floor(2 * Math.log2(d) + 0.25)))
    const wWorld = (view.w * view.dpr) / d, hWorld = (view.h * view.dpr) / d
    const count = (Math.ceil(wWorld / CHUNK) + 1) * (Math.ceil(hWorld / CHUNK) + 1)
    while (k > K_MIN) {
      const px = Math.ceil(CHUNK * stepScale(k))
      if (count * px * px * 4 <= this.budget * 0.7) break
      k--
    }
    return k
  }

  private key(cx: number, cy: number, k: number) {
    return ((k - K_MIN) * 256 + cy) * 256 + cx
  }

  /**
   * Draws a frame. Returns true while chunks are still being baked for this view, so the caller
   * keeps drawing frames until it settles.
   */
  draw(ctx: CanvasRenderingContext2D, view: GroundView, layers?: GroundLayers): boolean {
    this.frame++
    const d = view.zoom * view.dpr
    const W = view.w * view.dpr, H = view.h * view.dpr
    const k = this.stepFor(view)
    const wx0 = view.x - W / 2 / d, wy0 = view.y - H / 2 / d
    const wx1 = view.x + W / 2 / d, wy1 = view.y + H / 2 / d
    const cx0 = Math.max(0, Math.floor(wx0 / CHUNK)), cx1 = Math.min(this.ccols - 1, Math.floor(wx1 / CHUNK))
    const cy0 = Math.max(0, Math.floor(wy0 / CHUNK)), cy1 = Math.min(this.crows - 1, Math.floor(wy1 / CHUNK))
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'low'
    const wanted = this.wanted
    wanted.length = 0
    this.visibleNoBake = false
    for (let cy = cy0; cy <= cy1; cy++)
      for (let cx = cx0; cx <= cx1; cx++) {
        // Whole device pixels, shared by neighbours, so chunks meet without seams.
        const px0 = Math.round((cx * CHUNK - view.x) * d + W / 2), px1 = Math.round(((cx + 1) * CHUNK - view.x) * d + W / 2)
        const py0 = Math.round((cy * CHUNK - view.y) * d + H / 2), py1 = Math.round(((cy + 1) * CHUNK - view.y) * d + H / 2)
        let c = this.cache.get(this.key(cx, cy, k))
        if (!c) {
          wanted.push(this.key(cx, cy, k))
          // The nearest step already baked stands in, finer first.
          for (let j = 1; j <= this.kMax - K_MIN && !c; j++) c = this.cache.get(this.key(cx, cy, k + j)) ?? this.cache.get(this.key(cx, cy, k - j))
        }
        if (c) {
          c.used = this.frame
          ctx.drawImage(c.canvas, px0, py0, px1 - px0, py1 - py0)
        } else {
          this.visibleNoBake = true
          ctx.fillStyle = DIRT_FILL
          ctx.fillRect(px0, py0, px1 - px0, py1 - py0)
        }
      }
    // What to bake when the view is done: the tiny step everywhere, then the ring round the view.
    const low = this.wantedLow, ring = this.wantedRing
    low.length = 0
    ring.length = 0
    for (let cy = 0; cy < this.crows; cy++)
      for (let cx = 0; cx < this.ccols; cx++) {
        if (k !== K_LOW && !this.cache.has(this.key(cx, cy, K_LOW))) low.push(this.key(cx, cy, K_LOW))
        const inRing = cx >= cx0 - 1 && cx <= cx1 + 1 && cy >= cy0 - 1 && cy <= cy1 + 1 && !(cx >= cx0 && cx <= cx1 && cy >= cy0 && cy <= cy1)
        if (inRing && !this.cache.has(this.key(cx, cy, k))) ring.push(this.key(cx, cy, k))
      }
    // The ring only when it fits the budget beside the view.
    const px = Math.ceil(CHUNK * stepScale(k))
    if ((cx1 - cx0 + 3) * (cy1 - cy0 + 3) * px * px * 4 > this.budget * 0.85) ring.length = 0
    ctx.setTransform(d, 0, 0, d, W / 2 - view.x * d, H / 2 - view.y * d)
    layers?.ground?.(ctx)
    layers?.units?.(ctx)
    if (k > K_FAR && this.loaded) this.drawTalls(ctx, k, wx0, wy0, wx1, wy1)
    layers?.fog?.(ctx)
    if (this.debug.grid || this.debug.heights || this.debug.flags) this.drawDebug(ctx, d, wx0, wy0, wx1, wy1)
    layers?.overlay?.(ctx)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    this.pump(view)
    return wanted.length > 0 || low.length > 0 || ring.length > 0 || this.job !== null
  }

  /** Bakes for up to the frame's time budget: the job in hand, then the wanted chunks nearest the
   * middle of the view first. */
  private pump(view: GroundView) {
    if (!this.loaded) return
    const t0 = performance.now()
    const budget = this.visibleNoBake ? 16 : this.bakeMs
    let ran = 0
    for (;;) {
      const spent = performance.now() - t0
      if (spent >= budget) break
      if (!this.job) {
        const key = this.nearestWanted(view)
        if (key < 0) break
        const cx = key % 256, cy = Math.floor(key / 256) % 256, k = Math.floor(key / 65536) + K_MIN
        const sx = Math.ceil(CHUNK * stepScale(k)) / CHUNK
        this.job = { cx, cy, k, pass: 0, canvas: newCanvas(CHUNK * sx, CHUNK * sx), sx }
      }
      // One pass a frame always runs; more only while they fit.
      const pass = Math.min(7, this.job.pass)
      if (ran && spent + this.passCost[pass] > budget) break
      const p0 = performance.now()
      const done = this.bakePass(this.job)
      this.passCost[pass] = this.passCost[pass] * 0.7 + (performance.now() - p0) * 0.3
      ran++
      if (done) {
        const j = this.job
        const bytes = j.canvas.width * j.canvas.height * 4
        this.cache.set(this.key(j.cx, j.cy, j.k), { canvas: j.canvas, bytes, used: this.frame })
        this.bytes += bytes
        this.job = null
        this.evict()
      }
    }
  }

  private nearestWanted(view: GroundView) {
    const a = this.nearestIn(this.wanted, view)
    if (a >= 0) return a
    const b = this.nearestIn(this.wantedLow, view)
    return b >= 0 ? b : this.nearestIn(this.wantedRing, view)
  }

  private nearestIn(list: number[], view: GroundView) {
    let best = -1, bestD = Infinity
    for (const key of list) {
      if (this.cache.has(key)) continue
      const cx = key % 256, cy = Math.floor(key / 256) % 256
      const dx = (cx + 0.5) * CHUNK - view.x, dy = (cy + 0.5) * CHUNK - view.y
      const dd = dx * dx + dy * dy
      if (dd < bestD) (bestD = dd), (best = key)
    }
    return best
  }

  /** Drops the least recently drawn chunks until the cache fits its budget (never this frame's). */
  private evict() {
    while (this.bytes > this.budget) {
      let oldKey = -1, oldest = Infinity
      for (const [key, c] of this.cache) if (c.used < oldest && c.used < this.frame && Math.floor(key / 65536) + K_MIN !== K_LOW) (oldest = c.used), (oldKey = key)
      if (oldKey < 0) return
      const c = this.cache.get(oldKey)!
      this.bytes -= c.bytes
      c.canvas.width = 0
      this.cache.delete(oldKey)
    }
  }

  // --- Baking ---

  /** Runs one pass of a chunk's bake; true when the chunk is done. */
  private bakePass(j: Job): boolean {
    const x = ctx2d(j.canvas)
    const ox = j.cx * CHUNK, oy = j.cy * CHUNK
    const world = (c: CanvasRenderingContext2D) => c.setTransform(j.sx, 0, 0, j.sx, -ox * j.sx, -oy * j.sx)
    world(x)
    switch (j.pass++) {
      case 0:
        this.makeMasks(j, 0)
        return false
      case 1:
        this.makeMasks(j, 1)
        return false
      case 2:
        x.fillStyle = this.pattern(x, 'dirt-a', j.sx)
        x.fillRect(ox, oy, CHUNK, CHUNK)
        this.texLayer(j, 'dirt-b', 'dirtB')
        return false
      case 3:
        this.texLayer(j, 'grass-a', 'grass')
        this.texLayer(j, 'grass-b', 'grassB')
        return false
      case 4:
        this.texLayer(j, 'rocky-a', 'rocky')
        this.texLayer(j, 'rocky-b', 'rockyB')
        return false
      case 5:
        x.imageSmoothingEnabled = true
        this.drawMask(x, 'water')
        this.drawMask(x, 'shade')
        this.drawRamps(x, j)
        return false
      case 6:
        this.drawCliffs(x, j)
        return false
      default:
        this.drawFlatProps(x, j)
        x.setTransform(1, 0, 0, 1, 0, 0)
        return true
    }
  }

  private pattern(x: CanvasRenderingContext2D, name: TexName, sx: number) {
    const img = this.tex.get(name)
    if (!img) return DIRT_FILL
    const size = Math.max(4, Math.round(TEX_WORLD * sx))
    const key = `${name}@${size}`
    let mip = this.texMips.get(key)
    if (!mip) {
      mip = size >= img.width ? img : shrinkTile(img, img.width, size)
      this.texMips.set(key, mip)
    }
    const s = mip === img ? img.width : size
    const p = x.createPattern(mip, 'repeat')!
    p.setTransform(new DOMMatrix([TEX_WORLD / s, 0, 0, TEX_WORLD / s, 0, 0]))
    return p
  }

  /** Fills the scratch canvas with a texture, cuts it by a mask and lays it on the chunk. */
  private texLayer(j: Job, name: TexName, mask: string) {
    const w = j.canvas.width, h = j.canvas.height
    if (!this.scratch) this.scratch = newCanvas(w, h)
    const s = this.scratch
    if (s.width < w || s.height < h) (s.width = Math.max(s.width, w)), (s.height = Math.max(s.height, h))
    const x = ctx2d(s)
    x.setTransform(1, 0, 0, 1, 0, 0)
    x.globalCompositeOperation = 'source-over'
    x.clearRect(0, 0, w, h)
    x.setTransform(j.sx, 0, 0, j.sx, -j.cx * CHUNK * j.sx, -j.cy * CHUNK * j.sx)
    x.fillStyle = this.pattern(x, name, j.sx)
    x.fillRect(j.cx * CHUNK, j.cy * CHUNK, CHUNK, CHUNK)
    x.globalCompositeOperation = 'destination-in'
    x.imageSmoothingEnabled = true
    this.drawMask(x, mask)
    x.globalCompositeOperation = 'source-over'
    const c = ctx2d(j.canvas)
    c.save()
    c.setTransform(1, 0, 0, 1, 0, 0)
    c.drawImage(s, 0, 0, w, h, 0, 0, w, h)
    c.restore()
  }

  private drawMask(x: CanvasRenderingContext2D, name: string) {
    const m = this.masks[name]
    if (!m) return
    const r = this.maskRect
    x.drawImage(m, 0, 0, r.w, r.h, r.x, r.y, r.w * r.u, r.h * r.u)
  }

  /** Bilinear sample of a per-tile field at a world point. */
  private field(f: Float32Array, x: number, y: number) {
    const g = this.map.grid
    let u = x / TILE - 0.5, v = y / TILE - 0.5
    u = u < 0 ? 0 : u > g.cols - 1 ? g.cols - 1 : u
    v = v < 0 ? 0 : v > g.rows - 1 ? g.rows - 1 : v
    const i = Math.min(g.cols - 2, Math.floor(u)), j = Math.min(g.rows - 2, Math.floor(v))
    const fx = u - i, fy = v - j
    const t = j * g.cols + i
    const a = f[t], b = f[t + 1], c = f[t + g.cols], d = f[t + g.cols + 1]
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy
  }

  /**
   * The chunk's blend masks, from the tile grid's terrain smoothed between tile centres and broken
   * up by noise: part 0 the ground layers (grass, rocky, their variants, dirt's variant), part 1
   * water and the shade. Each mask is one pixel per few world units, padded past the chunk's edges
   * so smoothing never shows a seam where chunks meet.
   */
  private makeMasks(j: Job, part: number) {
    const u = Math.max(4, 1 / j.sx) // world units per mask pixel
    const pad = 2
    const n = Math.ceil(CHUNK / u) + pad * 2
    const x0 = j.cx * CHUNK - pad * u, y0 = j.cy * CHUNK - pad * u
    this.maskRect = { x: x0, y: y0, w: n, h: n, u }
    const [n0, n1, n2, n3, n4, n5, n6, n7, n8] = this.noise
    const cl = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
    const names = part === 0 ? ['grass', 'grassB', 'rocky', 'rockyB', 'dirtB'] : ['water', 'shade']
    const data = names.map(() => new ImageData(n, n))
    for (let py = 0; py < n; py++)
      for (let px = 0; px < n; px++) {
        const wx = x0 + (px + 0.5) * u, wy = y0 + (py + 0.5) * u
        const o = (py * n + px) * 4
        // The tile fields are read at a position nudged by noise (up to 26 units), so edges that
        // follow tile lines come out organic, then broken up finer still.
        const qx = wx + (n7(wx / 80 + 9, wy / 80) - 0.5) * 52, qy = wy + (n7(wx / 80, wy / 80 + 9) - 0.5) * 52
        if (part === 0) {
          const gr = cl((this.field(this.fGrass, qx, qy) - 0.5) * 2.6 + (n0(wx / 90, wy / 90) - 0.5) * 1.4 + 0.5)
          const ro = cl((this.field(this.fRocky, qx, qy) - 0.5) * 3 + (n1(wx / 30, wy / 30) - 0.5) * 1.6 + (n2(wx / 11, wy / 11) - 0.5) * 0.5 + 0.5)
          data[0].data[o + 3] = gr * 255
          data[1].data[o + 3] = gr * cl((n3(wx / 260, wy / 260) - 0.4) * 4) * 255
          data[2].data[o + 3] = ro * 255
          data[3].data[o + 3] = ro * cl((n4(wx / 280, wy / 280) - 0.45) * 4) * 255
          data[4].data[o + 3] = cl((n5(wx / 300, wy / 300) - 0.45) * 4) * 255
        } else {
          // Water: a muddy shore, then water darkening towards the middle, with faint glints.
          const w = this.field(this.fWater, qx, qy) + (n6(wx / 40, wy / 40) - 0.5) * 0.3
          if (w > 0.2) {
            const shore = cl((w - 0.2) / 0.2), wet = cl((w - 0.42) / 0.12), deep = cl((w - 0.75) / 0.25)
            const glint = wet * cl((n7(wx / 90 + 31, wy / 22) - 0.74) * 5) * 0.3
            let r = 66 + (40 - 66) * wet, gg = 52 + (72 - 52) * wet, b = 36 + (78 - 36) * wet
            r += (26 - r) * deep; gg += (52 - gg) * deep; b += (60 - b) * deep
            r += (150 - r) * glint; gg += (180 - gg) * glint; b += (175 - b) * glint
            const d = data[0].data
            d[o] = r; d[o + 1] = gg; d[o + 2] = b
            d[o + 3] = 255 * (shore * 0.55 + wet * 0.42)
          }
          // Shade: a faint large-scale tint so the repeats don't line up, and a little darker the
          // lower the ground, so levels read apart.
          const lv = this.field(this.fLevel, wx, wy)
          const s = data[1].data
          s[o] = 30; s[o + 1] = 22; s[o + 2] = 14
          s[o + 3] = 255 * cl(0.2 * n8(wx / 500, wy / 500) + (LEVELS - 1 - lv) * 0.05)
        }
      }
    names.forEach((name, i) => {
      let c = this.masks[name]
      if (!c) c = this.masks[name] = newCanvas(n, n)
      if (c.width < n || c.height < n) (c.width = n), (c.height = n)
      ctx2d(c).putImageData(data[i], 0, 0)
    })
  }

  /** Ramps: the ramp image over each ramp's box, top towards the high end, and the inner faces of
   * its walls, growing from nothing at the top to full height at the bottom. */
  private drawRamps(x: CanvasRenderingContext2D, j: Job) {
    const img = this.rampImg
    for (const i of this.chunkRamps[j.cy * this.ccols + j.cx]) {
      const r = this.ramps[i]
      const x0 = r.c0 * TILE, y0 = r.r0 * TILE, x1 = (r.c1 + 1) * TILE, y1 = (r.r1 + 1) * TILE
      const along = r.dx !== 0 ? x1 - x0 : y1 - y0
      const across = r.dx !== 0 ? y1 - y0 : x1 - x0
      if (img) {
        x.save()
        x.translate((x0 + x1) / 2, (y0 + y1) / 2)
        x.rotate(r.dy < 0 ? 0 : r.dy > 0 ? Math.PI : r.dx > 0 ? Math.PI / 2 : -Math.PI / 2)
        x.imageSmoothingQuality = 'high'
        x.drawImage(img, -across / 2 - 6, -along / 2 - 22, across + 12, along + 44)
        x.restore()
      }
      // Inner wall faces: rows or columns along each walled side, scaled by how far down they are.
      const g = this.map.grid
      const wall = (c: number, rr: number) => (g.flags[rr * g.cols + c] & TF.blocked) !== 0
      const steps = 24
      if (r.dx === 0) {
        for (const side of [0, 1]) {
          const c = side ? r.c1 : r.c0
          if (!wall(c, r.r0) || !wall(c, r.r1)) continue
          const ex = side ? c * TILE : (c + 1) * TILE
          const pts = new Float64Array((steps + 1) * 4)
          for (let s = 0; s <= steps; s++) {
            pts[s * 4] = ex
            pts[s * 4 + 1] = y0 + ((y1 - y0) * s) / steps
            pts[s * 4 + 2] = side ? -1 : 1
          }
          const top = r.dy < 0 ? y0 : y1
          this.ewFace(x, j, pts, side ? WEST : EAST, 1, (_px, py) => Math.min(1, Math.abs(py - top) / (y1 - y0)) * 0.9)
        }
      } else {
        for (const side of [0, 1]) {
          const rr = side ? r.r1 : r.r0
          if (!wall(r.c0, rr) || !wall(r.c1, rr)) continue
          if (side) continue // a wall on the south side faces north: hidden, its lip is the ramp's edge
          const ey = (rr + 1) * TILE
          const pts = new Float64Array((steps + 1) * 4)
          for (let s = 0; s <= steps; s++) {
            pts[s * 4] = x0 + ((x1 - x0) * s) / steps
            pts[s * 4 + 1] = ey
            pts[s * 4 + 3] = 1
          }
          const top = r.dx < 0 ? x0 : x1
          this.southFace(x, j, pts, 1, (px) => Math.min(1, Math.abs(px - top) / (x1 - x0)) * 0.9)
        }
      }
    }
  }

  /** The cliff face's scale (of the strip) along an edge: it swells and shrinks, so some stretches
   * are tall walls and others low steps; a drop of two levels is taller. */
  private faceScale(x: number, y: number, jump: number) {
    return (0.12 + 0.11 * this.noise[9](x / 160, y / 160)) * (jump > 1 ? 1.35 : 1)
  }

  private drawCliffs(x: CanvasRenderingContext2D, j: Job) {
    const list = this.chunkPieces[j.cy * this.ccols + j.cx]
    // Shadows first, cast down and to the right onto the low ground: three overlapping bands of
    // growing reach, so the shadow fades out instead of ending on a hard line.
    x.fillStyle = 'rgba(20, 14, 8, 0.065)'
    for (const i of list) {
      const p = this.pieces[i]
      if (p.kind !== SOUTH && p.kind !== EAST) continue
      const pts = p.pts
      const ox = p.kind === SOUTH ? 8 : 30, oy = p.kind === SOUTH ? 50 : 12
      for (const reach of [0.6, 0.85, 1.1]) {
        const k = (p.jump > 1 ? 1.4 : 1) * reach
        x.beginPath()
        x.moveTo(pts[0], pts[1])
        for (let q = 0; q < pts.length; q += 4) x.lineTo(pts[q] + ox * k, pts[q + 1] + oy * k)
        for (let q = pts.length - 4; q >= 0; q -= 4) x.lineTo(pts[q], pts[q + 1])
        x.fill()
      }
    }
    for (const i of list) {
      const p = this.pieces[i]
      if (p.kind === SOUTH) this.southFace(x, j, p.pts, p.jump)
      else if (p.kind === EAST || p.kind === WEST) this.ewFace(x, j, p.pts, p.kind, p.jump)
      else this.lip(x, j, p.pts)
    }
  }

  /** A face looking south: the strip in thin upright columns, each hung from the rim line where it
   * stands; the strip's position moves on by the local scale, so the rock never stretches. */
  private southFace(x: CanvasRenderingContext2D, j: Job, pts: Float64Array, jump: number, taper?: (x: number, y: number) => number) {
    if (!this.strip.length) return
    const col = 3 / j.sx
    const cx0 = j.cx * CHUNK - 100, cx1 = (j.cx + 1) * CHUNK + 100
    const cy0 = j.cy * CHUNK - 120, cy1 = (j.cy + 1) * CHUNK + 60
    const mip = pickMip(this.strip, 0.2 * j.sx * 1.4)
    const H = this.stripH
    let u = (pts[0] * 7.3) % this.stripW
    let lastX = pts[0]
    walk(pts, col, (px, py) => {
      const dx = px - lastX
      if (dx <= 0.01) return
      let k = this.faceScale(px, py, jump)
      if (taper) k *= taper(px, py)
      const sw = dx / Math.max(0.02, k)
      if (u + sw > this.stripW) u = 0
      if (k > 0.01 && px >= cx0 && lastX <= cx1 && py >= cy0 && py <= cy1)
        x.drawImage(mip.img, u * mip.f, 0, Math.max(1, sw * mip.f), H * mip.f, lastX, py - (14 * k) / 0.17, dx + 0.7 / j.sx, H * k)
      u += sw
      lastX = px
    })
  }

  /** A face looking east or west: the upright east/west strip in thin rows, each set off from the
   * rim line where it lies, the rock tops on the high side and the face on the low. */
  private ewFace(x: CanvasRenderingContext2D, j: Job, pts: Float64Array, kind: CliffKind, jump: number, taper?: (x: number, y: number) => number) {
    const chain = kind === EAST ? this.stripEast : this.stripWest
    if (!chain.length) return
    const row = 3 / j.sx
    const cx0 = j.cx * CHUNK - 140, cx1 = (j.cx + 1) * CHUNK + 140
    const cy0 = j.cy * CHUNK - 40, cy1 = (j.cy + 1) * CHUNK + 40
    const mip = pickMip(chain, 0.2 * j.sx * 1.4)
    const Wd = this.stripH // the upright strip's width is the strip's height
    const L = this.ewH
    let v = (pts[1] * 5.1) % L
    let lastY = pts[1]
    walk(pts, row, (px, py) => {
      const dy = Math.abs(py - lastY)
      if (dy <= 0.01) return
      let k = this.faceScale(px, py, jump) * 0.8
      if (taper) k *= taper(px, py)
      const sh = dy / Math.max(0.02, k)
      if (v + sh > L) v = 0
      const w = Wd * k
      const left = kind === EAST ? px - w * 0.3 : px - w * 0.7
      if (k > 0.01 && py >= cy0 && py <= cy1 && left <= cx1 && left + w >= cx0)
        x.drawImage(mip.img, 0, v * mip.f, Wd * mip.f, Math.max(1, sh * mip.f), left, Math.min(py, lastY), w, dy + 0.7 / j.sx)
      v += sh
      lastY = py
    })
  }

  /** A cliff looking north shows only its rim: a lit edge with a dark drop just beyond it. */
  private lip(x: CanvasRenderingContext2D, j: Job, pts: Float64Array) {
    x.lineJoin = 'round'
    x.lineCap = 'round'
    const line = (off: number, width: number, style: string) => {
      x.strokeStyle = style
      x.lineWidth = width
      x.beginPath()
      for (let q = 0; q < pts.length; q += 4) {
        const px = pts[q] + pts[q + 2] * off, py = pts[q + 1] + pts[q + 3] * off
        if (q === 0) x.moveTo(px, py)
        else x.lineTo(px, py)
      }
      x.stroke()
    }
    line(5, 7, 'rgba(24, 17, 10, 0.28)')
    line(2.5, 2.4, 'rgba(36, 26, 16, 0.6)')
    line(-0.5, Math.max(2, 1.6 / j.sx), 'rgba(222, 202, 164, 0.5)')
  }

  /** Props that lie flat, with their lift shadows, and the trees' shadows (or, far out, the trees). */
  private drawFlatProps(x: CanvasRenderingContext2D, j: Job) {
    const i = j.cy * this.ccols + j.cx
    const far = j.k <= K_FAR
    const talls = this.chunkTalls[i]
    // Tree shadows first: they fall on the ground and on the props beside them.
    for (const t of talls) this.drawProp(x, this.talls[t], j.k, true, false)
    for (const t of this.chunkFlats[i]) this.drawProp(x, this.flats[t], j.k, true, true)
    if (far) for (const t of talls) this.drawProp(x, this.talls[t], j.k, false, true)
  }

  /** A prop's sprite (or shadow) at a size step, made once: tinted if it is stone. */
  private propSprite(kind: string, k: number, shadow: boolean) {
    const key = `${kind}:${k}:${shadow ? 1 : 0}`
    let c = this.propCache.get(key)
    if (c) return c
    const img = this.propImg.get(kind)
    if (!img) return null
    const max = this.propMax.get(kind) ?? 64
    const px = Math.max(4, Math.ceil(max * stepScale(k)))
    const f = px / Math.max(img.width, img.height)
    c = newCanvas(img.width * f, img.height * f)
    const x = ctx2d(c)
    x.imageSmoothingQuality = 'high'
    x.drawImage(img, 0, 0, c.width, c.height)
    x.globalCompositeOperation = 'source-atop'
    if (shadow) {
      x.fillStyle = SHADOW
      x.fillRect(0, 0, c.width, c.height)
    } else if (PROP_INFO[kind]?.stone) {
      x.fillStyle = STONE_TINT
      x.fillRect(0, 0, c.width, c.height)
    }
    this.propCache.set(key, c)
    return c
  }

  private drawProp(x: CanvasRenderingContext2D, p: Prop, k: number, shadow: boolean, body: boolean) {
    const img = this.propImg.get(p.kind)
    if (!img) return
    const f = p.size / Math.max(img.width, img.height)
    const w = img.width * f, h = img.height * f
    const lift = PROP_INFO[p.kind]?.lift ?? 0.1
    if (shadow) {
      const s = this.propSprite(p.kind, k, true)
      if (s) {
        x.globalAlpha = SHADOW_ALPHA
        x.drawImage(s, p.x - w / 2 + p.size * lift * 0.5, p.y - h / 2 + p.size * lift, w, h)
        x.globalAlpha = 1
      }
    }
    if (body) {
      const s = this.propSprite(p.kind, k, false)
      if (s) x.drawImage(s, p.x - w / 2, p.y - h / 2, w, h)
    }
  }

  /** The trees in view, top to bottom, above units. */
  private drawTalls(ctx: CanvasRenderingContext2D, k: number, x0: number, y0: number, x1: number, y1: number) {
    const t = this.talls
    if (this.tallK !== k) {
      this.tallK = k
      this.tallSprite = t.map((p) => this.propSprite(p.kind, k, false))
      this.tallW = new Float32Array(t.length)
      this.tallH = new Float32Array(t.length)
      t.forEach((p, i) => {
        const img = this.propImg.get(p.kind)
        if (!img) return
        const f = p.size / Math.max(img.width, img.height)
        this.tallW[i] = img.width * f
        this.tallH[i] = img.height * f
      })
    }
    const m = this.tallMax
    // First tree that could reach into view (binary search on y).
    let lo = 0, hi = t.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (t[mid].y < y0 - m) lo = mid + 1
      else hi = mid
    }
    for (let i = lo; i < t.length && t[i].y <= y1 + m; i++) {
      const p = t[i]
      const s = this.tallSprite[i]
      if (!s || p.x < x0 - m || p.x > x1 + m) continue
      ctx.drawImage(s, p.x - this.tallW[i] / 2, p.y - this.tallH[i] / 2, this.tallW[i], this.tallH[i])
    }
  }

  // --- Debug overlay ---

  /** Heights and flags as a one-pixel-per-tile picture scaled up sharp, and the tile grid when it's
   * big enough to see. */
  private drawDebug(ctx: CanvasRenderingContext2D, d: number, x0: number, y0: number, x1: number, y1: number) {
    const g = this.map.grid
    const want = `${this.debug.heights ? 1 : 0}${this.debug.flags ? 1 : 0}`
    if ((this.debug.heights || this.debug.flags) && this.debugFor !== want) {
      this.debugFor = want
      const c = this.debugCanvas ?? (this.debugCanvas = newCanvas(g.cols, g.rows))
      const img = new ImageData(g.cols, g.rows)
      for (let t = 0; t < g.cols * g.rows; t++) {
        let r = 0, gg = 0, b = 0, a = 0
        if (this.debug.heights) {
          const h = g.height[t]
          if (h === 1) (r = 60), (gg = 140), (b = 255), (a = 70)
          if (h === 2) (r = 255), (gg = 150), (b = 40), (a = 80)
        }
        if (this.debug.flags) {
          const f = g.flags[t]
          if (f & TF.water) (r = 40), (gg = 90), (b = 255), (a = 150)
          else if (f & TF.blocked) (r = 255), (gg = 40), (b = 40), (a = 140)
          else if (f & TF.ramp) (r = 60), (gg = 255), (b = 90), (a = 130)
          else if (f & TF.deposit) (r = 40), (gg = 240), (b = 255), (a = 160)
          else if (f & TF.noBuild) (r = 255), (gg = 230), (b = 60), (a = 70)
        }
        img.data.set([r, gg, b, a], t * 4)
      }
      ctx2d(c).putImageData(img, 0, 0)
    }
    if ((this.debug.heights || this.debug.flags) && this.debugCanvas) {
      ctx.imageSmoothingEnabled = false
      ctx.drawImage(this.debugCanvas, 0, 0, g.cols * TILE, g.rows * TILE)
      ctx.imageSmoothingEnabled = true
    }
    if (this.debug.grid && TILE * d >= 6) {
      const c0 = Math.max(0, Math.floor(x0 / TILE)), c1 = Math.min(g.cols, Math.ceil(x1 / TILE))
      const r0 = Math.max(0, Math.floor(y0 / TILE)), r1 = Math.min(g.rows, Math.ceil(y1 / TILE))
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)'
      ctx.lineWidth = 1 / d
      ctx.beginPath()
      for (let c = c0; c <= c1; c++) ctx.moveTo(c * TILE, r0 * TILE), ctx.lineTo(c * TILE, r1 * TILE)
      for (let r = r0; r <= r1; r++) ctx.moveTo(c0 * TILE, r * TILE), ctx.lineTo(c1 * TILE, r * TILE)
      ctx.stroke()
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)'
      ctx.beginPath()
      for (let c = Math.ceil(c0 / 16) * 16; c <= c1; c += 16) ctx.moveTo(c * TILE, r0 * TILE), ctx.lineTo(c * TILE, r1 * TILE)
      for (let r = Math.ceil(r0 / 16) * 16; r <= r1; r += 16) ctx.moveTo(c0 * TILE, r * TILE), ctx.lineTo(c1 * TILE, r * TILE)
      ctx.stroke()
    }
  }

  dispose() {
    this.clear()
    this.propCache.clear()
    this.texMips.clear()
  }
}

/** Calls `fn` at points every `step` units along a piece's line. */
function walk(pts: Float64Array, step: number, fn: (x: number, y: number) => void) {
  let carry = 0
  fn(pts[0], pts[1])
  for (let q = 0; q + 7 < pts.length; q += 4) {
    const x0 = pts[q], y0 = pts[q + 1], dx = pts[q + 4] - x0, dy = pts[q + 5] - y0
    const len = Math.hypot(dx, dy)
    if (len < 1e-6) continue
    let d = step - carry
    while (d <= len) {
      fn(x0 + (dx * d) / len, y0 + (dy * d) / len)
      d += step
    }
    carry = len - (d - step)
  }
  fn(pts[pts.length - 4], pts[pts.length - 3])
}
