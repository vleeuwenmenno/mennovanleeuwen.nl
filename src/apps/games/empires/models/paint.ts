import type { Piece } from './index.ts'
import { stateKey } from './index.ts'
import { PALETTES, blob, bounds, centroid, lightFor, rng, toneIndex, type Palette } from './kit.ts'
import { mountParts, type MountLook } from './mounts.ts'
import type { HullState, Model, Part, Pt } from './types.ts'

// Painting procedural models on a canvas, cel-shaded: flat fills in three hard tones per colour,
// the tone of each facet picked by how it faces the light (from the top left of the screen, so it
// is worked out again for every heading), hard drop shadows under raised parts, a lit rim and a
// shadow rim on each raised plate, a heavy dark outline round the silhouette and finer ones
// inside, then panel lines, stripes and lights.
//
// Painting is too slow to repeat for every ship every frame, so a unit's hull is painted once into
// a small bitmap per size bucket (powers of two, roughly the size it shows at), per light bucket
// (64 headings on small bitmaps, 32 on big ones, painted as ships turn to them; the bitmap is
// turned to the exact heading when drawn, and the two nearest headings are crossfaded so the
// shading doesn't snap, see drawLit) and per damage state, and kept in one shared cache with a memory budget. Turrets
// get bitmaps of their own, since they turn to aim. Only a hull (or a wreck's piece) whose bitmap
// would be bigger than memTuning.hull pixels, where few can fit on screen, is painted straight onto
// the screen, with exact light; turret bitmaps are capped at memTuning.mount pixels.

const TAU = Math.PI * 2

/**
 * When a hull or a turret is painted live (straight onto the screen) instead of from cached
 * bitmaps, and how big a turret's bitmap may get. A hull whose bitmap would be bigger than `hull`
 * pixels on its long side (one heading of a flagship at that size is about half a megabyte, and a
 * full turn paints 32 of them) is painted live: it is shown that big only zoomed in, or for the
 * biggest ships, so few are on screen at once. A turret's bitmap is at most `mount` pixels across,
 * drawn larger if need be up to `mountLive` pixels on screen, and painted live past that. `legacy`
 * puts back the old rule (live only past 720 pixels on screen, turret bitmaps up to 512), to
 * measure against. Phones, with their smaller budget, paint hulls live from 256 pixels.
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
 * and engine lights dark (embers in its wreckage still glow).
 */
export function paintParts(g: CanvasRenderingContext2D, parts: Part[], pal: Palette, light: Pt, ppu: number, debug = false, lightsOut = false) {
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
      if (d.k !== 'lights' || (lightsOut && d.tone !== 'ember')) continue
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
    for (const p of parts) {
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

/** A hull in its damage state: the parts still on it, scorch marks, burnt stumps where parts came
 * off, and for a wreck its wrecked mounts and break lines. */
export function paintModel(g: CanvasRenderingContext2D, m: Model, o: PaintOpts) {
  const pal = PALETTES[m.faction]
  const gone = new Set<number>()
  for (let i = 0; i < m.detachable.length; i++) if (o.state.detached & (1 << i)) gone.add(m.detachable[i])
  const parts = m.parts.filter((_, i) => !gone.has(i))
  g.save()
  if (o.region) g.clip(polyPath(o.region))
  paintParts(g, parts, pal, o.light, o.ppu, o.debug, o.wreckMounts)
  const sil = silhouette(parts)
  if (o.state.scorch > 0 || gone.size) {
    g.save()
    g.clip(sil)
    // Where a part came off: a burnt patch on the hull beside it.
    for (const i of gone) {
      const p = m.parts[i]
      if (p.pts.length < 3 || p.scar === false) continue
      const b = bounds(p.pts)
      const [cx, cy] = centroid(p.pts)
      const r = Math.max(b.x1 - b.x0, b.y1 - b.y0) * 0.55
      const rr = rng(m.seed + i * 97)
      g.fillStyle = 'rgba(30,22,16,0.62)'
      g.fill(polyPath(blob(cx, cy, r, rr)))
    }
    // Scorch marks: lumpy burns from light damage on, more of them as it gets worse; at the worst,
    // some burn through into holes with glowing edges.
    for (const s of m.scorch) {
      if (s.level > o.state.scorch) continue
      const rr = rng(s.seed + o.state.variant * 7919)
      const x = s.x + (rr() - 0.5) * s.r * 1.6
      const y = s.y + (rr() - 0.5) * s.r * 1.6
      g.fillStyle = 'rgba(34,26,20,0.42)'
      g.fill(polyPath(blob(x, y, s.r, rr)))
      g.fillStyle = 'rgba(22,16,12,0.5)'
      g.fill(polyPath(blob(x, y, s.r * 0.55, rr)))
      if (o.state.scorch >= 3 && s.level === 3 && s.seed % 3 === 0) {
        const hole = polyPath(blob(x, y, s.r * 0.42, rr, 7))
        g.fillStyle = '#0c0907'
        g.fill(hole)
        g.strokeStyle = 'rgba(255,146,60,0.95)'
        g.lineWidth = Math.max(0.8, o.ppu * 0.5) / o.ppu
        g.stroke(hole)
      }
    }
    g.restore()
  }
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
    // A dead hulk: its lights out and the whole of it dimmed and browned, as the sprites' wrecks
    // are, so it never reads as a live ship.
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

/** Every painted bitmap, least recently used first, and how many bytes they hold. */
const store = new Map<string, HTMLCanvasElement>()
let bytes = 0
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

function cached(key: string, w: number, h: number, paint: (g: CanvasRenderingContext2D) => void): HTMLCanvasElement
function cached(key: string, w: number, h: number, paint: (g: CanvasRenderingContext2D) => void, may: boolean): HTMLCanvasElement | null
/** A bitmap from the cache, painted now if it isn't there (unless `may` is false: then null). */
function cached(key: string, w: number, h: number, paint: (g: CanvasRenderingContext2D) => void, may = true) {
  const hit = store.get(key)
  if (hit) {
    store.delete(key)
    store.set(key, hit)
    return hit
  }
  if (!may) return null
  const t0 = performance.now()
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.ceil(w))
  c.height = Math.max(1, Math.ceil(h))
  const g = c.getContext('2d')!
  paint(g)
  spent += performance.now() - t0
  store.set(key, c)
  bytes += c.width * c.height * 4
  for (const [k, old] of store) {
    if (bytes <= BUDGET) break
    store.delete(k)
    bytes -= old.width * old.height * 4
  }
  return c
}
/** How much the model bitmaps hold now, for the Codex's numbers. */
export const cacheStats = () => ({ bitmaps: store.size, mb: bytes / 1048576 })
/** Empties the cache, for measuring how much one scene fills it from nothing. */
export function clearCache() {
  store.clear()
  bytes = 0
}
/** The same, split by what the bitmaps are of (hulls, turrets, wreck and fragment pieces, parts shot
 * off), for measuring a big battle. */
export function cacheBreakdown() {
  const out: Record<string, { bitmaps: number; mb: number }> = {}
  for (const [k, c] of store) {
    const kind = k.startsWith('m|') ? 'mounts' : k.includes('|h|') ? 'hulls' : k.includes('|x|') ? 'pieces' : 'parts'
    const o = (out[kind] ??= { bitmaps: 0, mb: 0 })
    o.bitmaps++
    o.mb += (c.width * c.height * 4) / 1048576
  }
  return out
}

/**
 * The size bucket for something `px` device pixels across: steps of √2 (32, 45, 64, 91, 128, 181,
 * 256…), so a bitmap is never much more than half as big again as it shows. Steps of two left a
 * cruiser just past one step painted at nearly twice its size, four times the memory, and a big
 * mixed battle seen up close overran the cache with them.
 */
function bucket(px: number) {
  let k = 0
  while (32 * Math.SQRT2 ** k < px * 1.15 && k < 10) k++
  return Math.round(32 * Math.SQRT2 ** k)
}
/**
 * How many light headings a bitmap `b` pixels across is painted for. A turning ship steps from
 * one to the next: 64 (under 6° apart) at the sizes frigates and stations show at in a battle;
 * 32 for specks of 64 px or less, where a step can't be seen, and for the few big ones (zoomed
 * right in), and on phones, to keep memory down; the crossfade below hides the steps. Each
 * heading is only painted when a ship first turns to it.
 */
const headings = (b: number) => (lightTuning.coarse ? 16 : PHONE || b <= 64 || b > 256 ? 32 : 64)
/**
 * How two neighbouring headings are blended as a ship turns between them (a setting object so a
 * test can compare them side by side). 'window' draws the
 * nearer heading alone for most of the way and crossfades only over the middle 40% of each step
 * (smoothstep): the cel tones stay crisp, with no doubled edges most of the time, and a facet
 * flipping from lit to shadow dissolves over a couple of degrees instead of snapping. 'linear'
 * (always blending by the fraction) was tried as well: smoother still, but every frame draws two
 * bitmaps and the slightly doubled outlines read as soft. 'none' is the old snap.
 */
export const lightTuning: { blend: 'window' | 'linear' | 'none'; /** The old 16 headings, to compare. */ coarse: boolean } = { blend: 'window', coarse: false }
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
/**
 * Draws a cached bitmap lit for heading `rot` out of `n` headings: the heading just below it, then
 * the one above faded in over it (see lightTuning). `bitmap(step)` gives the bitmap for a heading and
 * `place` draws it. A see-through unit (alpha under 1) gets the nearest heading alone, since two
 * see-through layers would add up darker; so does anything drawn with `blend` off. `stand(step)`
 * may offer a bitmap of a look that is nearly the same (the hull a moment ago, before its latest
 * scorch mark or lost part), for when this frame has no time left to paint the new look.
 */
function drawLit(ctx: CanvasRenderingContext2D, rot: number, n: number, bitmap: (step: number, may: boolean) => HTMLCanvasElement | null, place: (c: HTMLCanvasElement) => void, blend = true, stand?: (step: number) => HTMLCanvasElement | null) {
  const pos = ((((rot / TAU) * n) % n) + n) % n
  const i0 = Math.floor(pos)
  const i1 = (i0 + 1) % n
  const f = pos - i0
  const b = lightTuning.blend
  const w = b === 'linear' ? f : b === 'window' ? smooth(0.3, 0.7, f) : f < 0.5 ? 0 : 1
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

export type DrawOpts = { alpha?: number; debug?: boolean; wreck?: boolean; /** Light it as if turned this way (default: as drawn). */ lightRot?: number }

/**
 * A hull at (x, y) turned by `rot` (nose up at 0, as sprites), `size` world units on its long side,
 * on a context scaled by `zdpr` device pixels per world unit.
 */
export function drawHull(ctx: CanvasRenderingContext2D, m: Model, x: number, y: number, rot: number, size: number, zdpr: number, state: HullState, o: DrawOpts = {}) {
  const px = size * zdpr
  if (px < 1.5) return
  const lr = o.lightRot ?? rot
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(rot)
  if (o.alpha !== undefined && o.alpha < 1) ctx.globalAlpha *= o.alpha
  if ((memTuning.legacy ? px > LIVE : bucket(px) > memTuning.hull) || o.debug) {
    const k = size / m.long
    ctx.scale(k, k)
    paintModel(ctx, m, { light: lightFor(lr), ppu: px / m.long, state, debug: o.debug, wreckMounts: o.wreck })
  } else {
    const b = bucket(px)
    const n = headings(b)
    const ppu = b / m.long
    const pad = 4 + b * 0.05
    const cw = Math.ceil(m.w * ppu + pad * 2)
    const ch = Math.ceil(m.h * ppu + pad * 2)
    const s = size / b
    const keyOf = (st: HullState, ls: number) => `${m.key}|h|${stateKey(st)}|${o.wreck ? 'w' : ''}|${ls}/${n}|${b}`
    drawLit(
      ctx,
      lr,
      n,
      (ls, may) =>
        cached(
          keyOf(state, ls),
          cw,
          ch,
          (g) => {
            g.translate(cw / 2, ch / 2)
            g.scale(ppu, ppu)
            paintModel(g, m, { light: lightFor((ls / n) * TAU), ppu, state, wreckMounts: o.wreck })
          },
          may,
        ),
      (c) => ctx.drawImage(c, (-cw / 2) * s, (-ch / 2) * s, cw * s, ch * s),
      true,
      // In a big fight hulls take a new scorch mark or lose a part every few frames, and each new look
      // would have to be painted at once, budget or not. The look it had a moment ago stands in (one
      // scorch level less, or with the part it just lost) until a frame has time to paint the new one.
      (ls) => {
        const alts: HullState[] = []
        if (state.scorch > 0) alts.push({ ...state, scorch: state.scorch - 1 })
        for (let i = 0; i < m.detachable.length; i++) if (state.detached & (1 << i)) alts.push({ ...state, detached: state.detached & ~(1 << i) })
        for (const alt of alts)
          for (let d = 0; d <= n / 8; d++) {
            const hit = cached(keyOf(alt, (ls + d) % n), cw, ch, () => {}, false) ?? cached(keyOf(alt, (ls - d + n) % n), cw, ch, () => {}, false)
            if (hit) return hit
          }
        return null
      },
    )
  }
  ctx.restore()
}

/** One mount (turret, shield generator, module) at (x, y), `r` world units in radius, turned by
 * `rot`: intact, broken, or a burnt socket ('crater'). */
export function drawMount(ctx: CanvasRenderingContext2D, faction: Model['faction'], look: MountLook, broken: boolean, x: number, y: number, rot: number, r: number, zdpr: number, alpha = 1) {
  const px = r * 2 * zdpr
  if (px < 2) return
  const parts = mountParts(look, faction, broken)
  if (!parts.length) return
  const pal = PALETTES[faction]
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(rot)
  if (alpha < 1) ctx.globalAlpha *= alpha
  if (memTuning.legacy ? px > LIVE / 2 : px > memTuning.mountLive) {
    ctx.scale(r, r)
    paintParts(ctx, parts, pal, lightFor(rot), r * zdpr)
  } else {
    const b = memTuning.legacy ? bucket(px) : Math.min(bucket(px), memTuning.mount)
    // A big turret bitmap gets 32 headings: a turret is small next to its hull, and the crossfade
    // hides the steps.
    const n = memTuning.legacy || b <= 64 ? headings(b) : Math.min(32, headings(b))
    const ppu = b / 2.4
    const cw = Math.ceil(b * 1.1 + 4)
    const s = (r * 2.4) / b
    drawLit(
      ctx,
      rot,
      n,
      (ls, may) =>
        cached(
          `m|${faction}|${look}|${broken ? 1 : 0}|${ls}/${n}|${b}`,
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
    )
  }
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
  // Tumbling debris: the nearest of 16 headings is plenty, nobody can follow its light.
  const ls = ((Math.round((rot / TAU) * 16) % 16) + 16) % 16
  const ppu = b / span
  const pad = 3 + b * 0.06
  const cw = Math.ceil((b0.x1 - b0.x0) * ppu + pad * 2)
  const ch = Math.ceil((b0.y1 - b0.y0) * ppu + pad * 2)
  const c = cached(`${m.key}|p|${index}|${ls}|${b}`, cw, ch, (g) => {
    g.translate(pad - b0.x0 * ppu, pad - b0.y0 * ppu)
    g.scale(ppu, ppu)
    paintParts(g, [p], PALETTES[m.faction], lightFor((ls / 16) * TAU), ppu, false, true)
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
 * it, and a burst of them would otherwise fill the cache with every heading of every fragment.
 */
export function drawPiece(ctx: CanvasRenderingContext2D, m: Model, piece: Piece, key: string, state: HullState, x: number, y: number, rot: number, size: number, zdpr: number, alpha = 1, tumble = false) {
  const k = size / m.long
  const span = Math.max(piece.x1 - piece.x0, piece.y1 - piece.y0)
  const px = span * k * zdpr
  if (px < 1.5) return
  const b = bucket(px)
  if (!memTuning.legacy && b > memTuning.hull) {
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
  const n = tumble ? 8 : headings(b)
  const ppu = b / span
  const pad = 3 + b * 0.04
  const cw = Math.ceil((piece.x1 - piece.x0) * ppu + pad * 2)
  const ch = Math.ceil((piece.y1 - piece.y0) * ppu + pad * 2)
  const sk = stateKey(state)
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
      cached(
        `${m.key}|x|${key}|${sk}|${ls}/${n}|${b}`,
        cw,
        ch,
        (g) => {
          g.translate(pad - piece.x0 * ppu, pad - piece.y0 * ppu)
          g.scale(ppu, ppu)
          paintModel(g, m, { light: lightFor((ls / n) * TAU), ppu, state, wreckMounts: true, region: piece.region, cuts: piece.cuts })
        },
        may,
      ),
    (c) => ctx.drawImage(c, (piece.x0 - piece.cx) * k - pad * s, (piece.y0 - piece.cy) * k - pad * s, cw * s, ch * s),
    !tumble,
  )
  ctx.restore()
}

/**
 * A modelled unit's mounts, each on its hardpoint: whole ones turned to `aim(i)` (a world angle, as
 * drawn), wrecked ones left where they last pointed, blown-off ones a burnt socket on the hull.
 */
export function drawMounts(ctx: CanvasRenderingContext2D, m: Model, x: number, y: number, rot: number, size: number, zdpr: number, hps: readonly { hp: number }[], aim: (i: number) => number, alpha = 1) {
  const k = size / m.long
  const c = Math.cos(rot)
  const s = Math.sin(rot)
  for (const mt of m.mounts) {
    if (mt.design === 'engine') continue
    const r = mt.r * k
    if (r * 2 * zdpr < 2) continue
    const wx = x + (mt.x * c - mt.y * s) * k
    const wy = y + (mt.x * s + mt.y * c) * k
    const dead = (hps[mt.hp]?.hp ?? 1) <= 0
    if (!dead) drawMount(ctx, m.faction, mt.design, false, wx, wy, mt.turns ? aim(mt.hp) : rot, r, zdpr, alpha)
    else if (mt.detach) drawMount(ctx, m.faction, 'crater', true, wx, wy, rot, r, zdpr, alpha)
    else drawMount(ctx, m.faction, mt.design, true, wx, wy, mt.turns ? aim(mt.hp) : rot, r, zdpr, alpha)
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

/** Which of a unit's engine glows still burn: an engine part that came off takes its glow along. */
export function liveEngines(m: Model, state: HullState) {
  const out = m.engines.map(() => true)
  m.detachable.forEach((pi, i) => {
    const e = m.parts[pi].engine
    if (e !== undefined && state.detached & (1 << i)) out[e] = false
  })
  return out
}
