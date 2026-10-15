import type { Piece } from './index.ts'
import { stateKey } from './index.ts'
import { blob, bounds, centroid, lightFor, rng, toneIndex, type Palette } from './kit.ts'
import { PALETTES } from './palettes.ts'
import { mountParts, type AnyLook } from './mounts.ts'
import type { HullState, Model, Part, Pt } from './types.ts'

// Painting procedural models on a canvas, cel-shaded: flat fills in three hard tones per colour,
// the tone of each facet picked by how it faces the light (from the top left of the screen, so it
// is worked out again for every heading), hard drop shadows under raised parts, a lit rim and a
// shadow rim on each raised plate, a heavy dark outline round the silhouette and finer ones
// inside, then panel lines, stripes and lights.
//
// Painting is too slow to repeat for every ship every frame, so a unit's hull is painted once into
// a small bitmap per size bucket (steps of √2, roughly the size it shows at), per light bucket
// (64 headings on mid-sized bitmaps, 32 on small ones and phones, 16 on the biggest, painted as
// ships turn to them; the bitmap is turned to the exact heading when drawn, and the two nearest
// headings are crossfaded so the shading doesn't snap, see drawLit) and per part shot off, and kept
// in one shared cache with a memory budget. A live hull's scorch marks don't depend on the light, so
// they are one more bitmap drawn over it (see drawHull). Turrets get bitmaps of their own, since
// they turn to aim. Only a hull (or a wreck's piece) shown more than one step past the biggest
// bitmap (see bigK) is painted straight onto the screen, with exact light; turret bitmaps are capped
// at memTuning.mount pixels.
//
// Level of detail (Lod in types.ts): a part or a detail with `minPx` is only painted once the whole
// thing it belongs to is at least that many device pixels across: a hull's long side (paintModel,
// thumbnails, a piece of a broken hull at its hull's scale) or a mount's diameter (turrets and
// modules, painted on a mount of radius 1). So a design can carry dense detail for the big bitmaps
// and keep small ones to silhouette and colour, e.g.
//
//   part('vent', pts, 'metal', 6, { minPx: 140 })                    // a greeble from 140 px up
//   { k: 'line', pts, minPx: 90 }                                     // a panel line from 90 px
//   { k: 'lights', pts, r: 0.3, tone: 'glow', minPx: 200 }            // window rows from 200 px
//
// Good thresholds: 60-90 px for raised plates and big stripes, 120-180 for panel lines and small
// lights, 220+ for the finest. (Panel lines already need ppu 0.9, about 90 px on a ship.) Only the
// painting looks at it, and every cached bitmap is painted for one size bucket at a fixed ppu, so
// the cache keys stay right as they are: a bucket either has the detail or doesn't.

const TAU = Math.PI * 2
/** A mount is drawn on radius 1: two units across (what its parts' `minPx` is measured against). */
const MOUNT_SPAN = 2
/** Whether a part or detail with level of detail `minPx` shows on something `px` pixels across. */
const shows = (minPx: number | undefined, px: number) => minPx === undefined || px >= minPx

/**
 * When a hull or a turret is painted live (straight onto the screen) instead of from cached
 * bitmaps, and how big a turret's bitmap may get. A hull whose bitmap would be bigger than `hull`
 * pixels on its long side gets a bitmap one step (√2) bigger than that, 16 headings of it, drawn
 * up to one more step bigger than it is (about 1.2 times at most), and is painted live past that:
 * one heading of a flagship at that size is about half a megabyte, and it is shown that big only
 * zoomed in, or for the biggest ships, so few are on screen at once. A turret's bitmap is at most
 * `mount` pixels across, drawn larger if need be up to `mountLive` pixels on screen, and painted
 * live past that. `legacy` puts back the old rule (live only past 720 pixels on screen, turret
 * bitmaps up to 512), to measure against. Phones, with their smaller budget, step down a size.
 */
export const memTuning = { hull: typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches ? 256 : 362, mount: 128, mountLive: 192, legacy: false }
/** Before memTuning: above this many device pixels across, a hull was painted live. */
const LIVE = 720

// --- Paths -------------------------------------------------------------------------------------------

const paths = new WeakMap<object, Path2D>()
function polyPath(pts: Pt[], p = new Path2D()) {
  if (pts.length < 2) return p
  p.moveTo(pts[0][0], pts[0][1])
  for (let i = 1; i < pts.length; i++) p.lineTo(pts[i][0], pts[i][1])
  p.closePath()
  return p
}
function pathOf(part: Part) {
  let p = paths.get(part)
  if (!p) {
    p = polyPath(part.pts)
    for (const h of part.holes ?? []) polyPath(h, p)
    paths.set(part, p)
  }
  return p
}
const shifted = (p: Path2D, dx: number, dy: number) => {
  const out = new Path2D()
  out.addPath(p)
  out.addPath(p, new DOMMatrix([1, 0, 0, 1, dx, dy]))
  return out
}

// --- Painting ----------------------------------------------------------------------------------------

/**
 * Paints parts in order, in model units (the context already scaled so one unit is `ppu` device
 * pixels). `light` points towards the light in model space. `lightsOut`: a dead hulk, its windows
 * and engine lights dark (embers in its wreckage still glow). `span`: how many model units the whole
 * thing is across (a hull's long side; a mount's two units, the default), for the level of detail:
 * parts and details whose `minPx` is more than `span * ppu` are left out.
 */
export function paintParts(g: CanvasRenderingContext2D, all: Part[], pal: Palette, light: Pt, ppu: number, debug = false, lightsOut = false, span = MOUNT_SPAN) {
  const px = span * ppu
  const parts = all.some((p) => p.minPx !== undefined) ? all.filter((p) => shows(p.minPx, px)) : all
  // Outline widths in device pixels, thicker on big bitmaps, never under one pixel.
  const ow = Math.min(2.6, Math.max(1, 0.8 + ppu * 0.32)) / ppu
  const fine = ppu >= 0.9
  g.lineJoin = 'round'
  g.lineCap = 'round'
  // The silhouette outline: every part stroked thick first, so the fills on top leave only its
  // outer half showing round the edge of the whole shape.
  g.strokeStyle = pal.outline
  g.lineWidth = ow * 2.3
  for (const p of parts) if (!p.noOutline && p.pts.length >= 3) g.stroke(pathOf(p))
  const under = new Path2D()
  let any = false
  for (const p of parts) {
    if (p.pts.length >= 3) {
      const path = pathOf(p)
      const tones = pal[p.tone]
      const ti = p.glow ? 1 : toneIndex(p.slope, light)
      // A raised part's hard shadow falls on whatever is under it, never out into space.
      if (p.lift && any && !p.glow) {
        g.save()
        g.clip(under)
        g.translate(-light[0] * p.lift, -light[1] * p.lift)
        g.fillStyle = 'rgba(10,12,24,0.34)'
        g.fill(path, 'evenodd')
        g.restore()
      }
      g.save()
      g.clip(path, 'evenodd')
      if (p.sphere) {
        // A ball: shadow tone all over, the base tone on a disc shifted towards the light, and a
        // lit spot nearer still, each edge hard.
        const b = bounds(p.pts)
        const cx = (b.x0 + b.x1) / 2
        const cy = (b.y0 + b.y1) / 2
        const r = (b.x1 - b.x0) / 2
        g.fillStyle = tones[2]
        g.fill(path)
        g.fillStyle = tones[1]
        g.beginPath()
        g.arc(cx + light[0] * r * 0.32, cy + light[1] * r * 0.32, r * 0.92, 0, TAU)
        g.fill()
        g.fillStyle = tones[0]
        g.beginPath()
        g.arc(cx + light[0] * r * 0.5, cy + light[1] * r * 0.5, r * 0.36, 0, TAU)
        g.fill()
      } else {
        g.fillStyle = tones[ti]
        g.fill(path)
        for (const f of p.facets ?? []) {
          g.fillStyle = tones[toneIndex(f.slope, light)]
          g.fill(polyPath(f.pts))
        }
      }
      for (const d of p.details ?? []) {
        if (d.minPx !== undefined && px < d.minPx) continue
        if (d.k === 'shape') {
          g.fillStyle = pal[d.tone][p.glow ? 1 : ti]
          g.fill(polyPath(d.pts))
        } else if (d.k === 'line' && fine) {
          g.strokeStyle = 'rgba(18,20,30,0.36)'
          g.lineWidth = Math.min(1.5, Math.max(0.6, ppu * 0.32 * (d.w ?? 1))) / ppu
          const lp = new Path2D()
          lp.moveTo(d.pts[0][0], d.pts[0][1])
          for (let i = 1; i < d.pts.length; i++) lp.lineTo(d.pts[i][0], d.pts[i][1])
          g.stroke(lp)
        }
      }
      // Rims: a band of shadow along the side away from the light and a band of light along the
      // side facing it, as wide as the part is raised (the region between the part and itself
      // shifted, filled even-odd).
      const rim = p.lift && !p.glow && !p.sphere ? Math.min(p.lift * 0.55, 3) : 0
      if (rim * ppu >= 0.7) {
        g.fillStyle = 'rgba(14,18,40,0.32)'
        g.fill(shifted(path, light[0] * rim, light[1] * rim), 'evenodd')
        g.fillStyle = 'rgba(255,250,236,0.26)'
        g.fill(shifted(path, -light[0] * rim * 0.7, -light[1] * rim * 0.7), 'evenodd')
      }
      g.restore()
      if (!p.noOutline) {
        g.strokeStyle = pal.outline
        g.lineWidth = ow * 0.75
        g.stroke(path)
      }
      under.addPath(path)
      any = true
    }
    // Lights glow on their own: drawn over everything, unclipped, at least a pixel big.
    for (const d of p.details ?? []) {
      if (d.k !== 'lights' || (lightsOut && d.tone !== 'ember') || (d.minPx !== undefined && px < d.minPx)) continue
      const t = pal[d.tone ?? 'glow']
      const r = Math.max(d.r, 0.55 / ppu)
      g.fillStyle = t[1]
      for (const [x, y] of d.pts) g.fillRect(x - r, y - r, r * 2, r * 2)
      if (r * ppu > 1.6) {
        g.fillStyle = t[0]
        for (const [x, y] of d.pts) g.fillRect(x - r * 0.45, y - r * 0.45, r * 0.9, r * 0.9)
      }
    }
  }
  if (debug) {
    g.lineWidth = 1.2 / ppu
    g.setLineDash([4 / ppu, 3 / ppu])
    for (const p of all) {
      if (p.pts.length < 3) continue
      g.strokeStyle = p.detach ? '#ffa040' : p.engine !== undefined ? '#5fd0ff' : p.glow ? '#ffe060' : 'rgba(120,255,200,0.75)'
      g.stroke(pathOf(p))
    }
    g.setLineDash([])
  }
}

/** The hull's solid outline (what scorch marks and stumps are clipped to). */
function silhouette(parts: Part[]) {
  const p = new Path2D()
  for (const q of parts) if (q.pts.length >= 3 && !q.glow) p.addPath(pathOf(q))
  return p
}

const outlines = new WeakMap<Model, { solid: Path2D; frame: Path2D }>()
/**
 * A model's whole silhouette and its wireframe (every solid part's outline), in model units, made
 * once per model: what a structure going up is clipped to and drawn as, and the frame of a ship
 * taking shape in a yard's berth.
 */
export function outlineOf(m: Model) {
  let o = outlines.get(m)
  if (!o) {
    const frame = new Path2D()
    for (const q of m.parts) if (q.pts.length >= 3 && !q.glow && !q.id.startsWith('socket')) frame.addPath(pathOf(q))
    outlines.set(m, (o = { solid: silhouette(m.parts), frame }))
  }
  return o
}

export type PaintOpts = {
  /** Towards the light, in model space. */
  light: Pt
  /** Device pixels per model unit. */
  ppu: number
  state: HullState
  /** A wreck: every mount painted on, wrecked (or a burnt socket where it blew off). */
  wreckMounts?: boolean
  /** One piece of a broken hull: only this region, its break lines burnt along the edge. */
  region?: Pt[]
  cuts?: Pt[][]
  /** Workshop mode: every part outlined, coloured by what it is. */
  debug?: boolean
}

/** The parts still on a hull in this state. */
function partsLeft(m: Model, state: HullState) {
  if (!state.detached) return m.parts
  const gone = new Set<number>()
  for (let i = 0; i < m.detachable.length; i++) if (state.detached & (1 << i)) gone.add(m.detachable[i])
  return m.parts.filter((_, i) => !gone.has(i))
}

/**
 * A hull's burns, clipped to `sil` (its silhouette as it is now): a burnt patch beside each part
 * that came off, and scorch marks, lumpy burns from light damage on, more of them as it gets
 * worse; at the worst, some burn through into holes with glowing edges. None of it depends on the
 * light, which is what lets a cached hull carry its burns as one bitmap over every heading.
 */
function paintBurns(g: CanvasRenderingContext2D, m: Model, state: HullState, sil: Path2D, ppu: number) {
  if (!(state.scorch > 0 || state.detached)) return
  g.save()
  g.clip(sil)
  for (let i = 0; i < m.detachable.length; i++) {
    if (!(state.detached & (1 << i))) continue
    const pi = m.detachable[i]
    const p = m.parts[pi]
    if (p.pts.length < 3 || p.scar === false) continue
    const b = bounds(p.pts)
    const [cx, cy] = centroid(p.pts)
    const r = Math.max(b.x1 - b.x0, b.y1 - b.y0) * 0.55
    const rr = rng(m.seed + pi * 97)
    g.fillStyle = 'rgba(30,22,16,0.62)'
    g.fill(polyPath(blob(cx, cy, r, rr)))
  }
  for (const s of m.scorch) {
    if (s.level > state.scorch) continue
    const rr = rng(s.seed + state.variant * 7919)
    const x = s.x + (rr() - 0.5) * s.r * 1.6
    const y = s.y + (rr() - 0.5) * s.r * 1.6
    g.fillStyle = 'rgba(34,26,20,0.42)'
    g.fill(polyPath(blob(x, y, s.r, rr)))
    g.fillStyle = 'rgba(22,16,12,0.5)'
    g.fill(polyPath(blob(x, y, s.r * 0.55, rr)))
    if (state.scorch >= 3 && s.level === 3 && s.seed % 3 === 0) {
      const hole = polyPath(blob(x, y, s.r * 0.42, rr, 7))
      g.fillStyle = '#0c0907'
      g.fill(hole)
      g.strokeStyle = 'rgba(255,146,60,0.95)'
      g.lineWidth = Math.max(0.8, ppu * 0.5) / ppu
      g.stroke(hole)
    }
  }
  g.restore()
}

/** A hull in its damage state: the parts still on it, scorch marks, burnt stumps where parts came
 * off, and for a wreck its wrecked mounts and break lines. `burns: false` leaves the scorch marks
 * and stumps off, for a cached hull that carries them as a bitmap of their own (see drawHull). */
export function paintModel(g: CanvasRenderingContext2D, m: Model, o: PaintOpts & { burns?: boolean }) {
  const pal = PALETTES[m.faction]
  const parts = partsLeft(m, o.state)
  g.save()
  if (o.region) g.clip(polyPath(o.region))
  paintParts(g, parts, pal, o.light, o.ppu, o.debug, o.wreckMounts, m.long)
  const sil = silhouette(parts)
  if (o.burns !== false) paintBurns(g, m, o.state, sil, o.ppu)
  if (o.wreckMounts) {
    for (const mt of m.mounts) {
      if (mt.design === 'engine') continue
      g.save()
      g.translate(mt.x, mt.y)
      g.scale(mt.r, mt.r)
      paintParts(g, mountParts(mt.detach ? 'crater' : mt.design, m.faction, true), pal, o.light, o.ppu * mt.r)
      g.restore()
    }
  }
  if (o.wreckMounts) {
    // A dead hulk: its lights out and the whole of it dimmed and browned, so it never reads as a
    // live ship.
    g.save()
    g.clip(sil)
    g.fillStyle = 'rgba(26,18,14,0.5)'
    g.fillRect(-m.w, -m.h, m.w * 2, m.h * 2)
    g.restore()
  }
  if (o.cuts?.length) {
    // The break: charred plating along the torn edge, with a line of embers right at it.
    g.save()
    g.clip(sil)
    const torn = new Path2D()
    for (const c of o.cuts) {
      torn.moveTo(c[0][0], c[0][1])
      for (let i = 1; i < c.length; i++) torn.lineTo(c[i][0], c[i][1])
    }
    g.lineJoin = 'round'
    g.strokeStyle = 'rgba(28,20,14,0.85)'
    g.lineWidth = m.long * 0.05
    g.stroke(torn)
    g.strokeStyle = 'rgba(70,40,24,0.9)'
    g.lineWidth = m.long * 0.022
    g.stroke(torn)
    g.strokeStyle = 'rgba(255,150,64,0.95)'
    g.lineWidth = Math.max(1, m.long * 0.007 * o.ppu) / o.ppu
    g.stroke(torn)
    g.restore()
  }
  g.restore()
}

// --- The bitmap cache --------------------------------------------------------------------------------

/** What a cached bitmap is of, for the numbers (cacheBreakdown). */
type Kind = 'hulls' | 'burns' | 'mounts' | 'pieces' | 'parts'
/**
 * One look of something at one size: its bitmaps, one per light heading (or one alone), painted as
 * they're asked for. Looked up once per thing drawn (by numbers, not by building a string key), and
 * then each heading is an array index.
 */
type Run = { s: (Entry | undefined)[]; parts?: Part[] }
type Entry = { c: HTMLCanvasElement; used: number; bytes: number; kind: Kind; run: Run; i: number }

/** Every painted bitmap, and how many bytes they hold. */
const entries = new Set<Entry>()
let bytes = 0
/** Counts up on every use: an entry's `used` says how recently it was drawn. */
let clock = 0
// Phones get a smaller budget: their browsers cap how much canvas memory a page may hold.
const PHONE = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
const BUDGET = (PHONE ? 48 : 112) * 1024 * 1024

/**
 * Painting new bitmaps is the expensive part: a fleet turning at once could ask for hundreds in a
 * frame. Each frame (anything within 12 ms) gets PAINT_MS of painting; past that, drawLit makes do
 * with a nearby heading that is already painted, and the rest get painted in the frames after.
 */
const PAINT_MS = 3
let frameT = 0
let spent = 0
function mayPaint() {
  const now = performance.now()
  if (now - frameT > 12) {
    frameT = now
    spent = 0
  }
  return spent < PAINT_MS
}

/** Over budget: the least recently drawn bitmaps go, down to 85% of it, so this (a sort of every
 * entry) runs once in a while rather than for every bitmap painted. */
function evict() {
  if (bytes <= BUDGET) return
  const list = [...entries].sort((a, b) => a.used - b.used)
  for (const e of list) {
    if (bytes <= BUDGET * 0.85) break
    made.evicted++
    entries.delete(e)
    bytes -= e.bytes
    if (e.run.s[e.i] === e) e.run.s[e.i] = undefined
  }
}

function slot(run: Run, i: number, kind: Kind, w: number, h: number, paint: (g: CanvasRenderingContext2D) => void): HTMLCanvasElement
function slot(run: Run, i: number, kind: Kind, w: number, h: number, paint: (g: CanvasRenderingContext2D) => void, may: boolean): HTMLCanvasElement | null
/** Bitmap `i` of a run, painted now if it isn't there (unless `may` is false: then null). */
function slot(run: Run, i: number, kind: Kind, w: number, h: number, paint: (g: CanvasRenderingContext2D) => void, may = true) {
  const hit = run.s[i]
  if (hit) {
    hit.used = ++clock
    return hit.c
  }
  if (!may) return null
  const t0 = performance.now()
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.ceil(w))
  c.height = Math.max(1, Math.ceil(h))
  const g = c.getContext('2d')!
  paint(g)
  spent += performance.now() - t0
  made[kind]++
  const e: Entry = { c, used: ++clock, bytes: c.width * c.height * 4, kind, run, i }
  run.s[i] = e
  entries.add(e)
  bytes += e.bytes
  evict()
  return c
}

const runIn = <K>(map: Map<K, Run>, key: K) => {
  let r = map.get(key)
  if (!r) map.set(key, (r = { s: [] }))
  return r
}
/** A model's runs, by a number made of its look and size (see drawHull). */
const modelRuns = (store: WeakMap<Model, Map<number, Run>>, m: Model) => {
  let r = store.get(m)
  if (!r) store.set(m, (r = new Map()))
  return r
}
const hullRuns = new WeakMap<Model, Map<number, Run>>()
const burnRuns = new WeakMap<Model, Map<number, Run>>()
/** Turret runs: by faction, then look, then a number for broken, size and headings. */
const mountRuns = new Map<string, Map<string, Map<number, Run>>>()
/** Wreck pieces and parts shot off, rarer: by a string key. */
const otherRuns = new Map<string, Run>()

/** How much the model bitmaps hold now, for the Codex's numbers. */
/** How many bitmaps of each kind have been painted, and dropped for the budget, since the page
 * loaded: for measuring how much a battle keeps painting. */
export const made = { hulls: 0, burns: 0, mounts: 0, pieces: 0, parts: 0, evicted: 0 }
export const cacheStats = () => ({ bitmaps: entries.size, mb: bytes / 1048576 })
/** Empties the cache, for measuring how much one scene fills it from nothing. */
export function clearCache() {
  for (const e of entries) e.run.s[e.i] = undefined
  entries.clear()
  bytes = 0
}
/** The same, split by what the bitmaps are of (hulls, their burns, turrets, wreck and fragment
 * pieces, parts shot off), for measuring a big battle. */
export function cacheBreakdown() {
  const out: Record<string, { bitmaps: number; mb: number }> = {}
  for (const e of entries) {
    const o = (out[e.kind] ??= { bitmaps: 0, mb: 0 })
    o.bitmaps++
    o.mb += e.bytes / 1048576
  }
  return out
}

/**
 * The size bucket for something `px` device pixels across: steps of √2 (32, 45, 64, 91, 128, 181,
 * 256…), so a bitmap is never much more than half as big again as it shows. Steps of two left a
 * cruiser just past one step painted at nearly twice its size, four times the memory, and a big
 * mixed battle seen up close overran the cache with them. `bucketK` gives the step's number.
 */
const BUCKETS = Array.from({ length: 11 }, (_, k) => Math.round(32 * Math.SQRT2 ** k))
function bucketK(px: number) {
  let k = 0
  while (32 * Math.SQRT2 ** k < px * 1.15 && k < 10) k++
  return k
}
const bucket = (px: number) => BUCKETS[bucketK(px)]
/** The step of the biggest bitmaps: one past memTuning.hull. A hull or piece that would want a
 * bitmap bigger than memTuning.hull uses one of this size, drawn up to one step (√2) bigger than
 * it is; past that it is painted live. */
const bigK = () => bucketK(memTuning.hull / 1.15) + 1
/**
 * How many light headings a bitmap `b` pixels across is painted for. A turning ship steps from
 * one to the next: 64 (under 6° apart) at the sizes frigates and stations show at in a battle;
 * 32 for specks of 64 px or less, where a step can't be seen, and for the few big ones (zoomed
 * right in), and on phones, to keep memory down; the crossfade below hides the steps. Each
 * heading is only painted when a ship first turns to it. The biggest bitmaps (see bigK) get
 * lightTuning.big.
 */
const headings = (b: number) => (lightTuning.coarse ? 16 : PHONE || b <= 64 || b > 256 ? 32 : 64)
/**
 * How two neighbouring headings are blended as a ship turns between them (a setting object so a
 * test can compare them side by side). 'window' draws the
 * nearer heading alone for most of the way and crossfades only over the middle 40% of each step
 * (smoothstep): the cel tones stay crisp, with no doubled edges most of the time, and a facet
 * flipping from lit to shadow dissolves over a couple of degrees instead of snapping. 'linear'
 * (always blending by the fraction) was tried as well: smoother still, but every frame draws two
 * bitmaps and the slightly doubled outlines read as soft. 'none' is the old snap. `big`: how many
 * headings the biggest bitmaps get, and `bigBlend` how they blend (they step further apart).
 */
export const lightTuning: { blend: 'window' | 'linear' | 'none'; /** The old 16 headings, to compare. */ coarse: boolean; big: number; bigBlend: 'window' | 'linear' } = {
  blend: 'window',
  coarse: false,
  big: 16,
  bigBlend: 'window',
}
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
/**
 * Draws a cached bitmap lit for heading `rot` out of `n` headings: the heading just below it, then
 * the one above faded in over it (see lightTuning). `bitmap(step)` gives the bitmap for a heading and
 * `place` draws it. A see-through unit (alpha under 1) gets the nearest heading alone, since two
 * see-through layers would add up darker; so does anything drawn with `blend` off. `stand(step)`
 * may offer a bitmap of a look that is nearly the same (the hull a moment ago, before the part it
 * just lost came off), for when this frame has no time left to paint the new look.
 */
function drawLit(ctx: CanvasRenderingContext2D, rot: number, n: number, bitmap: (step: number, may: boolean) => HTMLCanvasElement | null, place: (c: HTMLCanvasElement) => void, blend = true, stand?: (step: number) => HTMLCanvasElement | null, mode = lightTuning.blend) {
  const pos = ((((rot / TAU) * n) % n) + n) % n
  const i0 = Math.floor(pos)
  const i1 = (i0 + 1) % n
  const f = pos - i0
  const w = mode === 'linear' ? f : mode === 'window' ? smooth(0.3, 0.7, f) : f < 0.5 ? 0 : 1
  // A heading's bitmap: painted if this frame still has time for it, else the nearest one that is
  // painted already; `must` paints it anyway when there is none (something has to be drawn).
  const pick = (i: number, must: boolean) => {
    const hit = bitmap(i, false)
    if (hit) return hit
    if (mayPaint()) return bitmap(i, true)
    for (let d = 1; d <= n / 8; d++) {
      const near = bitmap((i + d) % n, false) ?? bitmap((i - d + n) % n, false)
      if (near) return near
    }
    if (must) return stand?.(i) ?? bitmap(i, true)
    return null
  }
  const main = w < 0.5 ? i0 : i1
  const first = pick(main, true)!
  if (!blend || ctx.globalAlpha < 0.999 || w < 0.01 || w > 0.99) return place(first)
  // Under the blend: the lower heading, then the upper one faded in by `w`.
  const lo = main === i0 ? first : pick(i0, false)
  const hi = main === i1 ? first : pick(i1, false)
  if (!lo || !hi) return place(first)
  place(lo)
  const a = ctx.globalAlpha
  ctx.globalAlpha = a * w
  place(hi)
  ctx.globalAlpha = a
}

/** A shadow cast under the hull onto whatever is below it: shifted (dx, dy) world units, at `alpha`. */
export type Shadow = { dx: number; dy: number; alpha: number }
export type DrawOpts = { alpha?: number; debug?: boolean; wreck?: boolean; /** Light it as if turned this way (default: as drawn). */ lightRot?: number
  /** Its soft shadow first, on the hull it flies over (see drawShadow): drawn in the hull's own
   * save and restore, so it costs one drawImage. */
  shadow?: Shadow | null }

/** A clean hull's look, for painting a cached hull without its burns. */
const UNBURNT = { scorch: 0, variant: 0 }

/**
 * A hull at (x, y) turned by `rot` (nose up at 0), `size` world units on its long side,
 * on a context scaled by `zdpr` device pixels per world unit.
 *
 * A live ship's hull bitmaps are painted clean (only the parts it has lost change them), and its
 * burns, which don't depend on the light, are one more bitmap of their own drawn over whatever
 * heading shows: so a fleet taking damage doesn't need every heading painted again for every scorch
 * level and burn layout. Specks (64 px or less) carry their burns in the hull bitmap instead (one
 * draw rather than two), in three levels and one layout, too small to tell apart. A wreck's hull
 * carries its burns too: it never changes.
 */
export function drawHull(ctx: CanvasRenderingContext2D, m: Model, x: number, y: number, rot: number, size: number, zdpr: number, state: HullState, o: DrawOpts = {}) {
  const px = size * zdpr
  if (px < 1.5) return
  const lr = o.lightRot ?? rot
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(rot)
  if (o.alpha !== undefined && o.alpha < 1) ctx.globalAlpha *= o.alpha
  if (o.shadow) drawShadow(ctx, m, rot, size, o.shadow)
  let k = bucketK(px)
  const big = !memTuning.legacy && BUCKETS[k] > memTuning.hull
  if (big && k <= bigK() + 1) k = bigK()
  if ((memTuning.legacy ? px > LIVE : big && k > bigK()) || o.debug) {
    const kk = size / m.long
    ctx.scale(kk, kk)
    paintModel(ctx, m, { light: lightFor(lr), ppu: px / m.long, state, debug: o.debug, wreckMounts: o.wreck })
  } else {
    const b = BUCKETS[k]
    const n = big ? lightTuning.big : headings(b)
    const ppu = b / m.long
    const pad = 4 + b * 0.05
    const cw = Math.ceil(m.w * ppu + pad * 2)
    const ch = Math.ceil(m.h * ppu + pad * 2)
    const s = size / b
    const wreck = !!o.wreck
    // Burns baked in (wrecks, specks), or drawn over (see above).
    const baked = wreck || b <= 64
    const sc = !baked ? 0 : wreck ? state.scorch : state.scorch === 1 ? 2 : state.scorch
    const va = wreck ? state.variant : 0
    // The model's runs by look and size, as one number: what's come off, burns (when baked in),
    // wreck or not, size step, headings.
    const runs = modelRuns(hullRuns, m)
    const keyOf = (det: number) => ((((det * 4 + sc) * 4 + va) * 2 + (wreck ? 1 : 0)) * 16 + k) * 128 + n
    const look = (det: number) => runs.get(keyOf(det))
    const run = runIn(runs, keyOf(state.detached))
    const paintAs: HullState = baked ? { detached: state.detached, scorch: sc, variant: va } : { detached: state.detached, ...UNBURNT }
    const place = (c: HTMLCanvasElement) => ctx.drawImage(c, (-cw / 2) * s, (-ch / 2) * s, cw * s, ch * s)
    drawLit(
      ctx,
      lr,
      n,
      (ls, may) =>
        slot(
          run,
          ls,
          'hulls',
          cw,
          ch,
          (g) => {
            g.translate(cw / 2, ch / 2)
            g.scale(ppu, ppu)
            paintModel(g, m, { light: lightFor((ls / n) * TAU), ppu, state: paintAs, wreckMounts: wreck, burns: baked })
          },
          may,
        ),
      place,
      true,
      // In a big fight hulls lose a part every few frames, and each new look would have to be
      // painted at once, budget or not. The look it had a moment ago (with the part it just lost)
      // stands in until a frame has time to paint the new one.
      (ls) => {
        for (let i = 0; i < m.detachable.length; i++) {
          if (!(state.detached & (1 << i))) continue
          const alt = look(state.detached & ~(1 << i))
          if (!alt) continue
          for (let d = 0; d <= n / 8; d++) {
            const hit = alt.s[(ls + d) % n] ?? alt.s[(ls - d + n) % n]
            if (hit) return hit.c
          }
        }
        return null
      },
      big ? lightTuning.bigBlend : lightTuning.blend,
    )
    if (!baked && (state.scorch > 0 || state.detached)) {
      const burns = runIn(modelRuns(burnRuns, m), ((state.detached * 4 + state.scorch) * 4 + state.variant) * 16 + k)
      place(
        slot(burns, 0, 'burns', cw, ch, (g) => {
          g.translate(cw / 2, ch / 2)
          g.scale(ppu, ppu)
          paintBurns(g, m, state, silhouette(partsLeft(m, state)), ppu)
        }),
      )
    }
  }
  ctx.restore()
}

/**
 * A ship's soft shadow, for where it flies over a bigger hull: its silhouette in black, painted once
 * per model into a small bitmap (SHADOW_PX on its long side) as a few overlapping fills a pixel or
 * two apart, so its edge is soft, and stretched to the ship's size when drawn, which softens it more.
 * No blur filter, no gradient: one bitmap per model, one drawImage per shadow.
 */
const SHADOW_PX = 48
const shadows = new WeakMap<Model, HTMLCanvasElement>()
function shadowOf(m: Model) {
  let c = shadows.get(m)
  if (!c) {
    const ppu = SHADOW_PX / m.long
    const pad = 4
    c = document.createElement('canvas')
    c.width = Math.ceil(m.w * ppu + pad * 2)
    c.height = Math.ceil(m.h * ppu + pad * 2)
    const g = c.getContext('2d')!
    g.translate(c.width / 2, c.height / 2)
    g.scale(ppu, ppu)
    const sil = outlineOf(m).solid
    g.fillStyle = 'rgba(0,0,0,0.2)'
    const r = 1.6 / ppu
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU
      g.save()
      g.translate(Math.cos(a) * r, Math.sin(a) * r)
      g.fill(sil)
      g.restore()
    }
    g.fillStyle = 'rgba(0,0,0,0.5)'
    g.fill(sil)
    shadows.set(m, c)
  }
  return c
}

/** The model's shadow, on a context already moved to the hull and turned by `rot` (see drawHull):
 * `size` world units long, shifted by `shadow.dx, dy` in world space, at `shadow.alpha`. */
function drawShadow(ctx: CanvasRenderingContext2D, m: Model, rot: number, size: number, shadow: Shadow) {
  const c = shadowOf(m)
  const k = size / SHADOW_PX
  const cs = Math.cos(rot)
  const sn = Math.sin(rot)
  const lx = shadow.dx * cs + shadow.dy * sn
  const ly = shadow.dy * cs - shadow.dx * sn
  const a = ctx.globalAlpha
  ctx.globalAlpha = a * shadow.alpha
  ctx.drawImage(c, lx - (c.width / 2) * k, ly - (c.height / 2) * k, c.width * k, c.height * k)
  ctx.globalAlpha = a
}

/** The run of turret bitmaps for one look at one size. */
function mountRun(faction: Model['faction'], look: AnyLook, broken: boolean, k: number, n: number) {
  let byLook = mountRuns.get(faction)
  if (!byLook) mountRuns.set(faction, (byLook = new Map()))
  let runs = byLook.get(look)
  if (!runs) byLook.set(look, (runs = new Map()))
  const run = runIn(runs, ((broken ? 1 : 0) * 16 + k) * 128 + n)
  run.parts ??= mountParts(look, faction, broken)
  return run
}

/** Turrets smaller than this many device pixels across aren't drawn: a speck on the hull. */
const MOUNT_MIN = 4
/** Turrets smaller than this show their nearest light heading alone, without the crossfade. */
const MOUNT_BLEND = 24

/** A turret from its cached bitmaps, `px` device pixels across (no more than memTuning.mountLive),
 * centred on the origin and turned by `rot` already, its light worked out for heading `rot`. */
function drawMountCached(ctx: CanvasRenderingContext2D, faction: Model['faction'], look: AnyLook, broken: boolean, rot: number, r: number, px: number) {
  const k0 = bucketK(px)
  const k = memTuning.legacy ? k0 : Math.min(k0, bucketK(memTuning.mount / 1.15))
  const b = BUCKETS[k]
  // A big turret bitmap gets 32 headings: a turret is small next to its hull, and the crossfade
  // hides the steps.
  const n = memTuning.legacy || b <= 64 ? headings(b) : Math.min(32, headings(b))
  const run = mountRun(faction, look, broken, k, n)
  const parts = run.parts!
  if (!parts.length) return
  const pal = PALETTES[faction]
  const ppu = b / 2.4
  const cw = Math.ceil(b * 1.1 + 4)
  const s = (r * 2.4) / b
  drawLit(
    ctx,
    rot,
    n,
    (ls, may) =>
      slot(
        run,
        ls,
        'mounts',
        cw,
        cw,
        (g) => {
          g.translate(cw / 2, cw / 2)
          g.scale(ppu, ppu)
          paintParts(g, parts, pal, lightFor((ls / n) * TAU), ppu)
        },
        may,
      ),
    (c) => ctx.drawImage(c, (-cw / 2) * s, (-cw / 2) * s, cw * s, cw * s),
    px >= MOUNT_BLEND,
  )
}

/** One mount (turret, shield generator, module) at (x, y), `r` world units in radius, turned by
 * `rot`: intact, broken, or a burnt socket ('crater'). */
export function drawMount(ctx: CanvasRenderingContext2D, faction: Model['faction'], look: AnyLook, broken: boolean, x: number, y: number, rot: number, r: number, zdpr: number, alpha = 1) {
  const px = r * 2 * zdpr
  if (px < 2) return
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(rot)
  if (alpha < 1) ctx.globalAlpha *= alpha
  if (memTuning.legacy ? px > LIVE / 2 : px > memTuning.mountLive) {
    const parts = mountParts(look, faction, broken)
    if (parts.length) {
      ctx.scale(r, r)
      paintParts(ctx, parts, PALETTES[faction], lightFor(rot), r * zdpr)
    }
  } else drawMountCached(ctx, faction, look, broken, rot, r, px)
  ctx.restore()
}

/** One part on its own (a wing tip or engine pod blown off), centred on its middle. */
export function drawPart(ctx: CanvasRenderingContext2D, m: Model, index: number, x: number, y: number, rot: number, size: number, zdpr: number, alpha = 1) {
  const p = m.parts[index]
  if (p.pts.length < 3) return
  const b0 = bounds(p.pts)
  const [cx, cy] = centroid(p.pts)
  const span = Math.max(b0.x1 - b0.x0, b0.y1 - b0.y0, 1)
  const k = size / m.long
  const px = span * k * zdpr
  if (px < 1.5) return
  const b = bucket(px)
  // Tumbling debris: the nearest of 8 headings is plenty, nobody can follow its light (and a burst
  // of parts would otherwise paint every heading of each one as it spins).
  const ls = ((Math.round((rot / TAU) * 8) % 8) + 8) % 8
  const ppu = b / span
  const pad = 3 + b * 0.06
  const cw = Math.ceil((b0.x1 - b0.x0) * ppu + pad * 2)
  const ch = Math.ceil((b0.y1 - b0.y0) * ppu + pad * 2)
  const c = slot(runIn(otherRuns, `${m.key}|p|${index}|${b}`), ls, 'parts', cw, ch, (g) => {
    g.translate(pad - b0.x0 * ppu, pad - b0.y0 * ppu)
    g.scale(ppu, ppu)
    paintParts(g, [p], PALETTES[m.faction], lightFor((ls / 8) * TAU), ppu, false, true, m.long)
    // Torn off: burnt across.
    g.globalCompositeOperation = 'source-atop'
    g.fillStyle = 'rgba(30,20,14,0.35)'
    g.fillRect(b0.x0 - 5, b0.y0 - 5, b0.x1 - b0.x0 + 10, b0.y1 - b0.y0 + 10)
  })
  const s = k / ppu
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(rot)
  if (alpha < 1) ctx.globalAlpha *= alpha
  ctx.drawImage(c, (b0.x0 - cx) * k - pad * s, (b0.y0 - cy) * k - pad * s, cw * s, ch * s)
  ctx.restore()
}

/**
 * One piece of a broken hull, its middle at (x, y), turned by `rot`. `key` names the break (the
 * wreck and the way it broke), since every break cuts its own pieces. `tumble`: a fragment spinning
 * away, lit from the nearest of 8 headings with no crossfade, since nobody can follow the light on
 * it, and a burst of them would otherwise fill the cache with every heading of every fragment. A
 * big piece seen close up gets the biggest bitmaps, like a big hull (see drawHull), and past that
 * is painted live.
 */
export function drawPiece(ctx: CanvasRenderingContext2D, m: Model, piece: Piece, key: string, state: HullState, x: number, y: number, rot: number, size: number, zdpr: number, alpha = 1, tumble = false) {
  const k = size / m.long
  const span = Math.max(piece.x1 - piece.x0, piece.y1 - piece.y0)
  const px = span * k * zdpr
  if (px < 1.5) return
  let bk = bucketK(px)
  const big = !memTuning.legacy && BUCKETS[bk] > memTuning.hull
  if (big && bk <= bigK() + 1) bk = bigK()
  if (big && bk > bigK()) {
    // A big piece seen close up: painted live, like a big hull.
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(rot)
    if (alpha < 1) ctx.globalAlpha *= alpha
    ctx.scale(k, k)
    ctx.translate(-piece.cx, -piece.cy)
    paintModel(ctx, m, { light: lightFor(rot), ppu: k * zdpr, state, wreckMounts: true, region: piece.region, cuts: piece.cuts })
    ctx.restore()
    return
  }
  const b = BUCKETS[bk]
  const n = tumble ? 8 : big ? lightTuning.big : headings(b)
  const ppu = b / span
  const pad = 3 + b * 0.04
  const cw = Math.ceil((piece.x1 - piece.x0) * ppu + pad * 2)
  const ch = Math.ceil((piece.y1 - piece.y0) * ppu + pad * 2)
  // A tumbling fragment is burnt through and gone in a moment: drawn as if nothing had come off the
  // craft first, so every craft of a type shares its fragments rather than each one painting its own.
  const st = tumble ? { detached: 0, scorch: state.scorch, variant: 0 } : state
  const run = runIn(otherRuns, `${m.key}|x|${key}|${stateKey(st)}|${n}|${b}`)
  const s = k / ppu
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(rot)
  if (alpha < 1) ctx.globalAlpha *= alpha
  drawLit(
    ctx,
    rot,
    n,
    (ls, may) =>
      slot(
        run,
        ls,
        'pieces',
        cw,
        ch,
        (g) => {
          g.translate(pad - piece.x0 * ppu, pad - piece.y0 * ppu)
          g.scale(ppu, ppu)
          paintModel(g, m, { light: lightFor((ls / n) * TAU), ppu, state: st, wreckMounts: true, region: piece.region, cuts: piece.cuts })
        },
        may,
      ),
    (c) => ctx.drawImage(c, (piece.x0 - piece.cx) * k - pad * s, (piece.y0 - piece.cy) * k - pad * s, cw * s, ch * s),
    !tumble,
    undefined,
    big ? lightTuning.bigBlend : lightTuning.blend,
  )
  ctx.restore()
}

/**
 * A modelled unit's mounts, each on its hardpoint: whole ones turned to `aim(i)` (a world angle, as
 * drawn), wrecked ones left where they last pointed, blown-off ones a burnt socket on the hull; the
 * hardpoints in `skip` left bare. Specks under MOUNT_MIN pixels are left off. Each one is placed
 * with one setTransform from the unit's own (no save and restore per turret).
 */
export function drawMounts(ctx: CanvasRenderingContext2D, m: Model, x: number, y: number, rot: number, size: number, zdpr: number, hps: readonly { hp: number }[], aim: (i: number) => number, alpha = 1, skip?: readonly number[]) {
  const k = size / m.long
  const c = Math.cos(rot)
  const s = Math.sin(rot)
  let base: DOMMatrix | null = null
  const a0 = ctx.globalAlpha
  for (const mt of m.mounts) {
    // (A rush-launched ship's parts not yet installed: the battle draws their scaffolding.)
    if (mt.design === 'engine' || skip?.includes(mt.hp)) continue
    const r = mt.r * k
    const px = r * 2 * zdpr
    if (px < MOUNT_MIN) continue
    const wx = x + (mt.x * c - mt.y * s) * k
    const wy = y + (mt.x * s + mt.y * c) * k
    const dead = (hps[mt.hp]?.hp ?? 1) <= 0
    const look: AnyLook = dead && mt.detach ? 'crater' : mt.design
    const a = dead && mt.detach ? rot : mt.turns ? aim(mt.hp) : rot
    if (memTuning.legacy || px > memTuning.mountLive) {
      // Painted live, from the unit's own transform and alpha.
      if (base) {
        ctx.setTransform(base)
        ctx.globalAlpha = a0
      }
      drawMount(ctx, m.faction, look, dead, wx, wy, a, r, zdpr, alpha)
      continue
    }
    base ??= ctx.getTransform()
    ctx.globalAlpha = a0 * alpha
    // The unit's transform, moved to the hardpoint and turned to the turret's heading.
    const ca = Math.cos(a)
    const sa = Math.sin(a)
    const { a: ta, b: tb, c: tc, d: td, e: te, f: tf } = base
    ctx.setTransform(ta * ca + tc * sa, tb * ca + td * sa, tc * ca - ta * sa, td * ca - tb * sa, ta * wx + tc * wy + te, tb * wx + td * wy + tf)
    drawMountCached(ctx, m.faction, look, dead, a, r, px)
  }
  if (base) {
    ctx.setTransform(base)
    ctx.globalAlpha = a0
  }
}

// --- Thumbnails --------------------------------------------------------------------------------------

const thumbs = new Map<string, { url: string; pad: number }>()
const FRESH: HullState = { detached: 0, scorch: 0, variant: 0 }
/**
 * A small still picture of a unit for the menus, cards and tiles: its hull nose up under the world's
 * light, every mount on it pointing forward (wrecked, or a burnt socket where it blew off, for each
 * hardpoint `dead` marks). `px` is its long side in pixels. Returned as a data URL for an <img> or an
 * SVG <image>, with `pad`: the margin painted round the unit's box (in model units, each side), so
 * outlines aren't cut and the box can still be lined up with the hardpoints. Painted once per look
 * and kept, so a card can ask for it on every render.
 */
export function thumbnail(m: Model, px: number, dead?: readonly boolean[]) {
  const key = `${m.key}|${px}|${dead?.map((d) => (d ? 1 : 0)).join('') ?? ''}`
  const hit = thumbs.get(key)
  if (hit) {
    thumbs.delete(key)
    thumbs.set(key, hit)
    return hit
  }
  const pad = m.long * 0.04
  const ppu = px / (m.long + pad * 2)
  const c = document.createElement('canvas')
  c.width = Math.ceil((m.w + pad * 2) * ppu)
  c.height = Math.ceil((m.h + pad * 2) * ppu)
  const g = c.getContext('2d')!
  g.translate(c.width / 2, c.height / 2)
  g.scale(ppu, ppu)
  const light = lightFor(0)
  paintModel(g, m, { light, ppu, state: FRESH })
  const pal = PALETTES[m.faction]
  for (const mt of m.mounts) {
    if (mt.design === 'engine') continue
    const gone = !!dead?.[mt.hp]
    g.save()
    g.translate(mt.x, mt.y)
    g.scale(mt.r, mt.r)
    paintParts(g, mountParts(gone && mt.detach ? 'crater' : mt.design, m.faction, gone), pal, light, ppu * mt.r)
    g.restore()
  }
  const out = { url: c.toDataURL('image/png'), pad }
  thumbs.set(key, out)
  // A few hundred is far more than any screen shows at once.
  for (const k of thumbs.keys()) {
    if (thumbs.size <= 400) break
    thumbs.delete(k)
  }
  return out
}

/**
 * A small still picture of one expansion module on its own (the parts of model `m` that go with
 * hardpoint `hp`), nose up, `px` on its long side, as a data URL: for the queues and cards that show
 * a module being built. Painted once per look and kept with the other thumbnails.
 */
export function moduleThumbnail(m: Model, hp: number, px: number) {
  const key = `${m.key}|x${hp}|${px}`
  const hit = thumbs.get(key)
  if (hit) return hit.url
  const parts = m.parts.filter((p) => p.detach?.hp === hp && p.pts.length >= 3)
  if (!parts.length) return ''
  const b = bounds(parts.flatMap((p) => p.pts))
  const span = Math.max(b.x1 - b.x0, b.y1 - b.y0)
  const pad = span * 0.06
  const ppu = px / (span + pad * 2)
  const c = document.createElement('canvas')
  c.width = Math.ceil((b.x1 - b.x0 + pad * 2) * ppu)
  c.height = Math.ceil((b.y1 - b.y0 + pad * 2) * ppu)
  const g = c.getContext('2d')!
  g.scale(ppu, ppu)
  g.translate(pad - b.x0, pad - b.y0)
  paintParts(g, parts, PALETTES[m.faction], lightFor(0), ppu, false, false, m.long)
  const url = c.toDataURL('image/png')
  thumbs.set(key, { url, pad })
  return url
}

/** Which of a unit's engine glows still burn: an engine part that came off takes its glow along. */
export function liveEngines(m: Model, state: HullState) {
  const out = m.engines.map(() => true)
  m.detachable.forEach((pi, i) => {
    const e = m.parts[pi].engine
    if (e !== undefined && state.detached & (1 << i)) out[e] = false
  })
  return out
}
