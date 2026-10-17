import { CLIFF_STYLES, DEFAULT_CLIFF, PAINT_R, ROCK, SHAPES, bodyEdge, cliffRuns, layRocks, paintRock, rockBox, type CliffRun, type CliffStyle, type Rock } from './cliffs.ts'
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
// a faint large-scale tint, a little shade by level and a soft contact shade at cliff feet, the
// ramps, the cliffs (rock chunks drawn in code along the height contours, cliffs.ts), and the props
// that lie flat.
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
  /** How the cliff rocks are laid (CLIFF_STYLES). */
  cliff?: string
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

// --- The renderer --------------------------------------------------------------------------------

type Chunk = { canvas: HTMLCanvasElement; bytes: number; used: number }
type Job = { cx: number; cy: number; k: number; pass: number; canvas: HTMLCanvasElement; sx: number; rock: number }

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
  /** Painted rock shapes by size step, size, shape and face height. */
  private rockSprites = new Map<number, { canvas: HTMLCanvasElement; cx: number; cy: number }>()
  private loaded = false
  readonly ready: Promise<void>
  private runs: CliffRun[]
  private style: CliffStyle
  private rocks: Rock[] = []
  private ramps: GroundRamp[]
  private flats: Prop[]
  private talls: Prop[]
  private tallMax = 0
  /** The trees' sprites and sizes at the step they were last drawn at, so a frame looks nothing up. */
  private tallK = -99
  private tallSprite: (HTMLCanvasElement | null)[] = []
  private tallW = new Float32Array(0)
  private tallH = new Float32Array(0)
  private chunkRocks: number[][] = []
  private chunkRuns: number[][] = []
  private bodies: Float64Array[] = []
  private chunkFlats: number[][]
  private chunkTalls: number[][]
  private chunkRamps: number[][]
  // Blend fields, one value per tile.
  private fGrass: Float32Array
  private fRocky: Float32Array
  private fWater: Float32Array
  private fLevel: Float32Array
  private fFoot: Float32Array
  private fForest: Float32Array
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
    this.runs = cliffRuns(map)
    this.style = CLIFF_STYLES[opts.cliff ?? DEFAULT_CLIFF] ?? CLIFF_STYLES[DEFAULT_CLIFF]
    this.ramps = rampsOf(map)
    // Stone props that only decorate a cliff (on its foot or rim) are left out: the cliff's own rock
    // and rubble take their place.
    const onCliff = (p: Prop) => {
      const c = Math.floor(p.x / TILE), r = Math.floor(p.y / TILE)
      if (p.blocks || !PROP_INFO[p.kind]?.stone || c < 1 || r < 1 || c >= g.cols - 1 || r >= g.rows - 1) return false
      const t = r * g.cols + c
      if (g.flags[t] & TF.blocked) return true
      return g.height[t - 1] < g.height[t] || g.height[t + 1] < g.height[t] || g.height[t - g.cols] < g.height[t] || g.height[t + g.cols] < g.height[t]
    }
    this.flats = map.props.filter((p) => !PROP_INFO[p.kind]?.tall && !onCliff(p))
    this.talls = map.props.filter((p) => PROP_INFO[p.kind]?.tall).sort((a, b) => a.y - b.y)
    for (const p of this.talls) this.tallMax = Math.max(this.tallMax, p.size)
    for (const p of map.props) this.propMax.set(p.kind, Math.max(this.propMax.get(p.kind) ?? 0, p.size))
    // Which pieces, props and ramps touch each chunk (with room for what hangs over its edges).
    const n = this.ccols * this.crows
    const lists = () => Array.from({ length: n }, () => [] as number[])
    this.chunkFlats = lists()
    this.chunkTalls = lists()
    this.chunkRamps = lists()
    const add = (into: number[][], i: number, x0: number, y0: number, x1: number, y1: number) => {
      const a = Math.max(0, Math.floor(x0 / CHUNK)), b = Math.min(this.ccols - 1, Math.floor(x1 / CHUNK))
      const c = Math.max(0, Math.floor(y0 / CHUNK)), d = Math.min(this.crows - 1, Math.floor(y1 / CHUNK))
      for (let y = c; y <= d; y++) for (let x = a; x <= b; x++) into[y * this.ccols + x].push(i)
    }
    this.flats.forEach((p, i) => add(this.chunkFlats, i, p.x - p.size, p.y - p.size, p.x + p.size, p.y + p.size))
    this.talls.forEach((p, i) => add(this.chunkTalls, i, p.x - p.size, p.y - p.size, p.x + p.size, p.y + p.size))
    this.ramps.forEach((r, i) => add(this.chunkRamps, i, r.c0 * TILE - 64, r.r0 * TILE - 64, (r.c1 + 1) * TILE + 64, (r.r1 + 1) * TILE + 64))
    // Blend fields.
    const cells = g.cols * g.rows
    this.fGrass = new Float32Array(cells)
    this.fRocky = new Float32Array(cells)
    this.fWater = new Float32Array(cells)
    this.fLevel = new Float32Array(cells)
    this.fFoot = new Float32Array(cells)
    this.fForest = new Float32Array(cells)
    const GRASS = terrainIndex('grass'), ROCKY = terrainIndex('rocky')
    for (let t = 0; t < cells; t++) {
      this.fGrass[t] = g.terrain[t] === GRASS ? 1 : 0
      this.fRocky[t] = g.terrain[t] === ROCKY ? 1 : 0
      // A bridge's deck shows its road, not the river under it.
      this.fWater[t] = g.flags[t] & TF.water && !(g.flags[t] & TF.bridge) ? 1 : 0
      this.fForest[t] = g.flags[t] & TF.forest ? 1 : 0
      this.fLevel[t] = g.height[t]
    }
    // Contact shade at the foot of each cliff: strongest under faces looking south (the camera sees
    // the face and its shadow), weaker beside east and west faces and under a north lip, and
    // spread a tile further at half strength.
    const foot = new Float32Array(cells)
    for (let t = 0; t < cells; t++) {
      if (g.flags[t] & (TF.ramp | TF.water)) continue
      const c = t % g.cols, r = (t - c) / g.cols
      const up = (nc: number, nr: number, w: number) => {
        if (nc < 0 || nr < 0 || nc >= g.cols || nr >= g.rows) return
        const u = nr * g.cols + nc
        if (!(g.flags[u] & TF.ramp) && g.height[u] > g.height[t]) foot[t] = Math.max(foot[t], w * Math.min(1.4, g.height[u] - g.height[t]))
      }
      up(c, r - 1, 1), up(c - 1, r, 0.7), up(c + 1, r, 0.7), up(c, r + 1, 0.4)
    }
    for (let t = 0; t < cells; t++) {
      const c = t % g.cols, r = (t - c) / g.cols
      let near = 0
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nc = c + dx, nr = r + dy
          if (nc >= 0 && nr >= 0 && nc < g.cols && nr < g.rows && g.height[nr * g.cols + nc] === g.height[t]) near = Math.max(near, foot[nr * g.cols + nc])
        }
      this.fFoot[t] = Math.max(foot[t], near * 0.45)
    }
    this.layCliffs()
    this.noise = Array.from({ length: 10 }, (_, i) => valueNoise(map.def.seed * 31 + 100 + i))
    this.ready = this.load()
  }

  private async load() {
    const b = this.base
    const [texs, props] = await Promise.all([
      Promise.all(TEXTURES.map((t) => loadImage(`${b}terrain/${t}.webp`))),
      Promise.all([...this.propMax.keys()].map((k) => loadImage(`${b}props/${k}.webp`).then((img) => [k, img] as const))),
    ])
    TEXTURES.forEach((t, i) => texs[i] && this.tex.set(t, texs[i]))
    for (const [k, img] of props) if (img) this.propImg.set(k, img)
    this.loaded = true
  }

  /** Lays the cliff rocks for the current style and works out which chunks each one touches. */
  private layCliffs() {
    this.rocks = layRocks(this.map, this.runs, this.style)
    this.bodies = this.runs.map((r) => bodyEdge(r, this.style))
    this.chunkRocks = Array.from({ length: this.ccols * this.crows }, () => [] as number[])
    this.chunkRuns = Array.from({ length: this.ccols * this.crows }, () => [] as number[])
    this.runs.forEach((run, i) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
      const b = this.bodies[i]
      for (let q = 0; q < b.length; q += 2) {
        x0 = Math.min(x0, b[q], run.pts[q * 2]); x1 = Math.max(x1, b[q], run.pts[q * 2])
        y0 = Math.min(y0, b[q + 1], run.pts[q * 2 + 1]); y1 = Math.max(y1, b[q + 1], run.pts[q * 2 + 1])
      }
      const a = Math.max(0, Math.floor((x0 - 8) / CHUNK)), bb = Math.min(this.ccols - 1, Math.floor((x1 + 8) / CHUNK))
      const c = Math.max(0, Math.floor((y0 - 8) / CHUNK)), d = Math.min(this.crows - 1, Math.floor((y1 + 8) / CHUNK))
      for (let y = c; y <= d; y++) for (let x = a; x <= bb; x++) this.chunkRuns[y * this.ccols + x].push(i)
    })
    this.rocks.forEach((rock, i) => {
      const [x0, y0, x1, y1] = rockBox(rock)
      const a = Math.max(0, Math.floor(x0 / CHUNK)), b = Math.min(this.ccols - 1, Math.floor(x1 / CHUNK))
      const c = Math.max(0, Math.floor(y0 / CHUNK)), d = Math.min(this.crows - 1, Math.floor(y1 / CHUNK))
      for (let y = c; y <= d; y++) for (let x = a; x <= b; x++) this.chunkRocks[y * this.ccols + x].push(i)
    })
  }

  /** Switches how the cliffs are laid (dev: comparing CLIFF_STYLES) and drops the baked chunks. */
  setCliffStyle(name: string) {
    const style = CLIFF_STYLES[name]
    if (!style || style === this.style) return
    this.style = style
    this.rockSprites.clear()
    this.layCliffs()
    this.clear()
  }

  /** How many cliff rocks the map has (for measuring). */
  get rockCount() {
    return this.rocks.length
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
        this.job = { cx, cy, k, pass: 0, canvas: newCanvas(CHUNK * sx, CHUNK * sx), sx, rock: 0 }
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
        // The cliffs may take more than one pass: they carry on where they stopped.
        if (!this.drawCliffs(x, j)) j.pass--
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
          // Woods (round 2 maps; this renderer has no canopy of its own): a dark green mass.
          const wood = cl((this.field(this.fForest, qx, qy) - 0.45) * 6)
          if (wood > 0) {
            s[o] = 22; s[o + 1] = 52; s[o + 2] = 20
            s[o + 3] = 255 * Math.max(wood * 0.85, cl(0.2 * n8(wx / 500, wy / 500) + (LEVELS - 1 - lv) * 0.05))
            continue
          }
          const foot = this.field(this.fFoot, qx * 0.5 + wx * 0.5, qy * 0.5 + wy * 0.5)
          s[o + 3] = 255 * cl(0.2 * n8(wx / 500, wy / 500) + (LEVELS - 1 - lv) * 0.05 + foot * (0.28 + 0.16 * n6(wx / 25, wy / 25)))
        }
      }
    names.forEach((name, i) => {
      let c = this.masks[name]
      if (!c) c = this.masks[name] = newCanvas(n, n)
      if (c.width < n || c.height < n) (c.width = n), (c.height = n)
      ctx2d(c).putImageData(data[i], 0, 0)
    })
  }

  /** Ramps: the dirt of the ramp's tiles shaded by its slope, lighter at the top and darker at the
   * foot, in soft bands that fade out at both ends, with faint wheel ruts down it. Its walls are
   * rock, laid with the cliffs. */
  private drawRamps(x: CanvasRenderingContext2D, j: Job) {
    const g = this.map.grid
    const wall = (c: number, rr: number) => (g.flags[rr * g.cols + c] & TF.blocked) !== 0
    for (const i of this.chunkRamps[j.cy * this.ccols + j.cx]) {
      const r = this.ramps[i]
      let x0 = r.c0 * TILE, y0 = r.r0 * TILE, x1 = (r.c1 + 1) * TILE, y1 = (r.r1 + 1) * TILE
      if (r.dx === 0) {
        if (wall(r.c0, r.r0)) x0 += TILE
        if (wall(r.c1, r.r0)) x1 -= TILE
      } else {
        if (wall(r.c0, r.r0)) y0 += TILE
        if (wall(r.c0, r.r1)) y1 -= TILE
      }
      // t runs from the top end (0) to the foot (1), a little past both.
      const along = r.dx !== 0 ? x1 - x0 : y1 - y0
      const BANDS = 18
      const ext = 18
      for (let b = 0; b < BANDS; b++) {
        const t0 = b / BANDS, t1 = (b + 1) / BANDS, t = (t0 + t1) / 2
        const fade = Math.min(1, t / 0.18, (1 - t) / 0.18)
        const light = (0.5 - t) * 2 // 1 at the top, -1 at the foot
        x.fillStyle = light > 0 ? `rgba(255, 236, 200, ${(0.13 * light * fade).toFixed(3)})` : `rgba(26, 18, 10, ${(-0.24 * light * fade).toFixed(3)})`
        const a0 = -ext + (along + ext * 2) * t0, a1 = -ext + (along + ext * 2) * t1
        // Measured from the top end, whichever way the ramp climbs.
        if (r.dx === 0) {
          const ya = r.dy < 0 ? y0 + a0 : y1 - a1
          x.fillRect(x0, ya, x1 - x0, a1 - a0 + 0.5)
        } else {
          const xa = r.dx < 0 ? x0 + a0 : x1 - a1
          x.fillRect(xa, y0, a1 - a0 + 0.5, y1 - y0)
        }
      }
      // Ruts: two pairs of faint lines down the slope, wobbling a little.
      const across = r.dx !== 0 ? y1 - y0 : x1 - x0
      x.lineCap = 'round'
      for (const at of [0.3, 0.36, 0.64, 0.7]) {
        x.strokeStyle = 'rgba(44, 30, 18, 0.16)'
        x.lineWidth = 2.5
        x.beginPath()
        for (let s = 0; s <= 8; s++) {
          const a = -6 + ((along + 12) * s) / 8
          const w = across * at + Math.sin(s * 1.7 + at * 9) * 1.6
          const px = r.dx === 0 ? x0 + w : x0 + a, py = r.dx === 0 ? y0 + a : y0 + w
          s ? x.lineTo(px, py) : x.moveTo(px, py)
        }
        x.stroke()
      }
    }
  }

  /** A painted rock shape at a size step (made once). */
  private rockSprite(k: number, small: boolean, shape: number, face: number, sx: number) {
    const key = (((k - K_MIN) * 2 + (small ? 1 : 0)) * SHAPES + shape) * 4 + face
    let s = this.rockSprites.get(key)
    if (!s) {
      const R = Math.max(2, (small ? PAINT_R.small : PAINT_R.big) * sx)
      s = paintRock(shape, R, R * this.style.faces[face], this.grain(sx))
      this.rockSprites.set(key, s)
    }
    return s
  }

  /** The rocky texture as a pattern in pixels of a bake at scale `sx`, for grain inside rocks. */
  private grain(sx: number) {
    const img = this.tex.get('rocky-a')
    if (!img) return null
    const size = Math.max(4, Math.round(TEX_WORLD * sx))
    const key = `rocky-a@${size}`
    let mip = this.texMips.get(key)
    if (!mip) {
      mip = size >= img.width ? img : shrinkTile(img, img.width, size)
      this.texMips.set(key, mip)
    }
    const s = mip === img ? img.width : size
    const c = this.scratch ?? (this.scratch = newCanvas(4, 4))
    const p = ctx2d(c).createPattern(mip, 'repeat')
    p?.setTransform(new DOMMatrix([(TEX_WORLD * sx) / s, 0, 0, (TEX_WORLD * sx) / s, 0, 0]))
    return p
  }

  /** The cliffs' bodies: a dark band from the rim to the rocks' feet, outlined at the foot, with a
   * lit line along the rim where the plateau's ground meets the rock. */
  private drawBodies(x: CanvasRenderingContext2D, j: Job) {
    x.lineJoin = 'round'
    x.lineCap = 'round'
    for (const i of this.chunkRuns[j.cy * this.ccols + j.cx]) {
      const p = this.runs[i].pts, b = this.bodies[i]
      const n = b.length / 2
      x.beginPath()
      for (let q = 0; q < n; q++) q ? x.lineTo(p[q * 4], p[q * 4 + 1]) : x.moveTo(p[0], p[1])
      for (let q = n - 1; q >= 0; q--) x.lineTo(b[q * 2], b[q * 2 + 1])
      x.closePath()
      x.fillStyle = ROCK.faceDark
      x.fill()
      x.strokeStyle = ROCK.line
      x.lineWidth = 2.2
      x.beginPath()
      for (let q = 0; q < n; q++) q ? x.lineTo(b[q * 2], b[q * 2 + 1]) : x.moveTo(b[0], b[1])
      x.stroke()
    }
  }

  /** The chunk's cliff rocks, back to front, picking up where the last pass stopped. Returns true
   * when they are all down. */
  private drawCliffs(x: CanvasRenderingContext2D, j: Job) {
    const list = this.chunkRocks[j.cy * this.ccols + j.cx]
    const t0 = performance.now()
    x.imageSmoothingEnabled = true
    if (j.rock === 0) this.drawBodies(x, j)
    for (; j.rock < list.length; j.rock++) {
      if ((j.rock & 7) === 7 && performance.now() - t0 > this.bakeMs * 0.8) return false
      const rock = this.rocks[list[j.rock]]
      const s = this.rockSprite(j.k, rock.small, rock.shape, rock.face, j.sx)
      const f = rock.r / ((rock.small ? PAINT_R.small : PAINT_R.big) * j.sx)
      x.drawImage(s.canvas, rock.x - s.cx * f, rock.y - s.cy * f * rock.sy, s.canvas.width * f, s.canvas.height * f * rock.sy)
    }
    return true
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
