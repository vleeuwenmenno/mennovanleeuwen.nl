import { FACTIONS, type FactionId } from './data.ts'
import { hash, rng } from './models/kit.ts'
import { PALETTES } from './models/palettes.ts'

// How each side's ships jump in and out of a battle, drawn on the battle canvas (render.ts calls in
// here). Render only: the battle's timings (sim.ts: the warp delay, the retreat charge) are the same
// for everyone, and only the look differs.
//
// - 'hyperspace' (the Republic): light gathering, a streak in and a snap to a stop. Drawn by
//   render.ts itself (drawWarps, drawCharge, drawDeparts), as it always was.
// - 'wormhole' (the Swarm): a wormhole tears open behind the drop point and the ship shoots out of
//   its mouth; a retreating ship opens one ahead of it, space bending and swirling into it, and
//   flies in before it collapses.
// - 'rift' (the Confederacy): a jagged red crack in space, forced open. The ship is shoved through
//   it with a jolt; a retreating ship tears one open ahead of it, branch by branch, and lurches in
//   before it slams shut.
//
// Everything is cheap enough for a battle-start fleet of 10 to 20 at once: the soft parts are
// sprites painted once per side, the rest a few strokes each, with less of it for one that is small
// on screen. Line widths are in screen pixels at least (`/ z`), so they read at every zoom.

export type WarpStyle = 'hyperspace' | 'wormhole' | 'rift'
/** Each side's look. A new one: add it to WarpStyle, here, and to WarpFx's dispatches below. */
export const WARP_STYLE: Record<FactionId, WarpStyle> = { republic: 'hyperspace', swarm: 'wormhole', droid: 'rift' }

/** Seconds of the streak in before a ship drops out, and of the glow it leaves after. */
export const STREAK = 0.32
export const AFTER = 1.1

/** A ship jumping, on the renderer's clock: in (charging from `start`, dropping out at `at`), or out
 * (gone at `start`). `rift`: its crack's shape, made on first draw. */
export type Jump = { x: number; y: number; a: number; size: number; unit: string; faction: FactionId; start: number; at?: number; rift?: Rift }
/** Draws a ship type whole (render.ts drawShip), optionally stretched across and along its length. */
export type ShipFn = (ctx: CanvasRenderingContext2D, unit: string, x: number, y: number, rot: number, size: number, z: number, alpha: number, stretch?: [number, number]) => void

const TAU = Math.PI * 2
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
const smooth = (v: number) => {
  const k = clamp01(v)
  return k * k * (3 - 2 * k)
}
const easeOut = (v: number) => 1 - (1 - clamp01(v)) ** 3
const easeIn = (v: number) => clamp01(v) ** 3
/** A cheap per-frame hash to 0..1 (for flicker; the shapes use the seeded rng). */
const fh = (n: number) => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return s - Math.floor(s)
}
const rgba = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}

// --- Sprites ----------------------------------------------------------------------------------------

const sprites = new Map<string, HTMLCanvasElement>()
function sprite(key: string, size: number, paint: (g: CanvasRenderingContext2D, r: number) => void) {
  let c = sprites.get(key)
  if (!c) {
    c = document.createElement('canvas')
    c.width = c.height = size
    const g = c.getContext('2d')!
    g.translate(size / 2, size / 2)
    paint(g, size / 2)
    sprites.set(key, c)
  }
  return c
}
/** A radial gradient painted once into a square. */
const radial = (key: string, stops: readonly (readonly [number, string])[]) =>
  sprite(key, 128, (g, r) => {
    const grd = g.createRadialGradient(0, 0, 0, 0, 0, r)
    for (const [at, col] of stops) grd.addColorStop(at, col)
    g.fillStyle = grd
    g.fillRect(-r, -r, r * 2, r * 2)
  })
/** A sprite drawn centred on (x, y) at radius `r`, turned by `rot`. */
function blit(ctx: CanvasRenderingContext2D, img: HTMLCanvasElement, x: number, y: number, r: number, rot = 0) {
  if (!rot) return ctx.drawImage(img, x - r, y - r, r * 2, r * 2)
  ctx.translate(x, y)
  ctx.rotate(rot)
  ctx.drawImage(img, -r, -r, r * 2, r * 2)
  ctx.rotate(-rot)
  ctx.translate(-x, -y)
}

/** A wormhole's colours and sprites, by side: its glow (the rim), its own colour (the deep swirl)
 * and its engines' (a few strands in the swirl). */
type HoleLook = { glow: string; glow0: string; glow6: string; swirl: HTMLCanvasElement; rim: HTMLCanvasElement; core: HTMLCanvasElement; halo: HTMLCanvasElement; flash: HTMLCanvasElement }
const holeLooks = new Map<FactionId, HoleLook>()
function holeLook(f: FactionId): HoleLook {
  let l = holeLooks.get(f)
  if (l) return l
  const glow = FACTIONS[f].glow
  const deep = FACTIONS[f].color
  const accent = PALETTES[f].engine
  // Spiral arms winding in, painted as overlapping soft blobs, brighter and whiter the deeper they go;
  // then the middle cut out (the core goes there) and the edge faded.
  const swirl = sprite(`hole-swirl|${f}`, 256, (g, R) => {
    g.globalCompositeOperation = 'lighter'
    const arms = 7
    for (let arm = 0; arm < arms; arm++) {
      const col = arm === 3 ? accent : arm % 2 ? deep : glow
      for (let j = 0; j <= 110; j++) {
        const s = j / 110
        const r = R * (0.3 + 0.66 * s)
        const th = (arm * TAU) / arms + 3.1 * Math.log(1 + 2.6 * (1 - s))
        const br = R * (0.025 + 0.085 * s)
        const x = Math.cos(th) * r
        const y = Math.sin(th) * r
        const grd = g.createRadialGradient(x, y, 0, x, y, br)
        const a = (1 - s) ** 1.3 * (arm === 3 ? 0.12 : 0.2)
        grd.addColorStop(0, s < 0.25 ? rgba('#ffffff', a) : rgba(col, a))
        grd.addColorStop(0.5, rgba(col, a * 0.6))
        grd.addColorStop(1, rgba(col, 0))
        g.fillStyle = grd
        g.fillRect(x - br, y - br, br * 2, br * 2)
      }
    }
    g.globalCompositeOperation = 'destination-in'
    const mask = g.createRadialGradient(0, 0, 0, 0, 0, R)
    mask.addColorStop(0, 'rgba(0,0,0,0)')
    mask.addColorStop(0.3, 'rgba(0,0,0,0)')
    mask.addColorStop(0.42, 'rgba(0,0,0,1)')
    mask.addColorStop(0.8, 'rgba(0,0,0,0.8)')
    mask.addColorStop(1, 'rgba(0,0,0,0)')
    g.fillStyle = mask
    g.fillRect(-R, -R, R * 2, R * 2)
  })
  l = {
    glow,
    glow0: rgba(glow, 0),
    glow6: rgba(glow, 0.6),
    swirl,
    // The bright rim (peaking at 0.64 of the sprite's radius) and the dark throat inside it.
    rim: radial(`hole-rim|${f}`, [[0, 'rgba(0,0,0,0)'], [0.52, 'rgba(0,0,0,0)'], [0.6, rgba(glow, 0.5)], [0.635, 'rgba(255,255,255,0.9)'], [0.66, glow], [0.76, rgba(deep, 0.35)], [1, 'rgba(0,0,0,0)']]),
    core: radial('hole-core', [[0, 'rgba(0,0,0,1)'], [0.55, 'rgba(3,0,8,0.97)'], [0.8, 'rgba(6,0,14,0.55)'], [1, 'rgba(0,0,0,0)']]),
    halo: radial(`hole-halo|${f}`, [[0, rgba(deep, 0)], [0.35, rgba(deep, 0.3)], [0.6, rgba(glow, 0.1)], [1, 'rgba(0,0,0,0)']]),
    flash: radial(`hole-flash|${f}`, [[0, '#ffffff'], [0.25, glow], [1, 'rgba(0,0,0,0)']]),
  }
  holeLooks.set(f, l)
  return l
}

/** A rift's colours, by side: a deep red outer glow, the side's plasma orange, and a white-hot core. */
type RiftLook = { deep: string; mid: string; hot: string; gap: string; inner: string; glow: HTMLCanvasElement; flash: HTMLCanvasElement }
const riftLooks = new Map<FactionId, RiftLook>()
function riftLook(f: FactionId): RiftLook {
  let l = riftLooks.get(f)
  if (l) return l
  const deep = '#ff3418'
  const mid = FACTIONS[f].bolt
  const hot = FACTIONS[f].weld.core
  l = {
    deep,
    mid,
    hot,
    gap: '#0e0204',
    inner: 'rgba(255,60,25,0.16)',
    glow: radial('rift-glow', [[0, rgba(deep, 0.85)], [0.4, rgba(deep, 0.35)], [1, 'rgba(0,0,0,0)']]),
    flash: radial(`rift-flash|${f}`, [[0, '#ffffff'], [0.2, mid], [0.55, rgba(deep, 0.5)], [1, 'rgba(0,0,0,0)']]),
  }
  riftLooks.set(f, l)
  return l
}

// --- The wormhole ------------------------------------------------------------------------------------

/**
 * A wormhole at (x, y), `r` across its throat: a faint haze, the fabric of space round it bent into
 * it (spokes curling in harder the closer they get, ripples falling inward), the dark throat, two
 * spiral swirls turning at different speeds, a bright rim warbling like something alive, and
 * smears of light racing round its edge. `bend`: how hard the fabric bends (0 none, 1 most). Less
 * of it when small on screen.
 */
function drawWormhole(ctx: CanvasRenderingContext2D, look: HoleLook, x: number, y: number, r: number, bend: number, t: number, z: number, alpha = 1) {
  const px = r * z
  if (px < 0.6) return
  ctx.globalCompositeOperation = 'lighter'
  ctx.globalAlpha = alpha * 0.8
  blit(ctx, look.halo, x, y, r * 2.8)
  if (bend > 0.01 && px > 9) {
    // The fabric: spokes from well outside curling in towards the throat, stroked in one gradient
    // that fades them out with distance, then ripples sinking in.
    const outer = r * 3.2
    const grd = ctx.createRadialGradient(x, y, r * 0.95, x, y, outer)
    grd.addColorStop(0, look.glow6)
    grd.addColorStop(1, look.glow0)
    ctx.strokeStyle = grd
    ctx.lineWidth = Math.max(0.8 / z, r * 0.014)
    ctx.globalAlpha = alpha * bend * 0.85
    const twist = 0.5 + 2.4 * bend + 0.15 * Math.sin(t * 1.7)
    ctx.beginPath()
    const spokes = px > 40 ? 18 : 12
    for (let j = 0; j < spokes; j++) {
      const th0 = (j * TAU) / spokes + t * 0.22
      for (let s = 0; s <= 10; s++) {
        const rr = outer - (outer - r * 1.02) * (s / 10) ** 0.8
        const th = th0 + twist * (r / rr) ** 1.6
        const px2 = x + Math.cos(th) * rr
        const py2 = y + Math.sin(th) * rr
        if (s) ctx.lineTo(px2, py2)
        else ctx.moveTo(px2, py2)
      }
    }
    ctx.stroke()
    for (let i = 0; i < 5; i++) {
      const ph = (((i / 5 - t * 0.35) % 1) + 1) % 1
      const rr = r * (1.08 + 2 * ph)
      const wob = 0.05 * Math.sin(t * 2.3 + i * 1.9)
      ctx.globalAlpha = alpha * bend * Math.sin(Math.PI * ph) * 0.7
      ctx.beginPath()
      ctx.ellipse(x, y, rr * (1 + wob), rr * (1 - wob), t * 0.3 + i, 0, TAU)
      ctx.stroke()
    }
  }
  // The throat, darkening what is behind it.
  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = alpha
  blit(ctx, look.core, x, y, r * 1.15)
  ctx.globalCompositeOperation = 'lighter'
  // The swirl, two layers turning at different speeds.
  ctx.globalAlpha = alpha * 0.95
  blit(ctx, look.swirl, x, y, r * 1.75, t * 1.4)
  if (px > 4) {
    ctx.globalAlpha = alpha * 0.55
    blit(ctx, look.swirl, x, y, r * 1.3, t * 2.6 + 1.3)
  }
  // The rim, pulsing.
  ctx.globalAlpha = alpha * (0.8 + 0.2 * Math.sin(t * 5.3))
  blit(ctx, look.rim, x, y, r / 0.64)
  if (px > 5) {
    // Warbling like a membrane, and smears of light racing round it.
    const wob = 0.045 * Math.sin(t * 3.1)
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = Math.max(1 / z, r * 0.02)
    ctx.globalAlpha = alpha * 0.45
    ctx.beginPath()
    ctx.ellipse(x, y, r * (0.98 + wob), r * (0.98 - wob), t * 0.7, 0, TAU)
    ctx.stroke()
    ctx.lineWidth = Math.max(1.3 / z, r * 0.035)
    ctx.globalAlpha = alpha * 0.75
    ctx.beginPath()
    for (let i = 0; i < 3; i++) {
      const a0 = t * (2.4 + i * 0.35) + (i * TAU) / 3
      ctx.moveTo(x + Math.cos(a0) * r * 1.04, y + Math.sin(a0) * r * 1.04)
      ctx.arc(x, y, r * 1.04, a0, a0 + 0.55 + 0.2 * Math.sin(t * 4 + i))
    }
    ctx.stroke()
  }
  // The very middle, black over the swirl.
  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = alpha
  blit(ctx, look.core, x, y, r * 0.6)
}

/** A wormhole collapsing to nothing: a last flash and a ring thrown out, `age` seconds after. */
function drawPulse(ctx: CanvasRenderingContext2D, look: HoleLook, x: number, y: number, r: number, age: number, z: number) {
  if (age < 0 || age > 0.42) return
  const k = age / 0.42
  ctx.globalCompositeOperation = 'lighter'
  ctx.globalAlpha = (1 - k) ** 2
  blit(ctx, look.flash, x, y, r * (0.6 + 1.2 * k))
  ctx.strokeStyle = look.glow
  ctx.lineWidth = Math.max(1.5 / z, r * 0.06 * (1 - k))
  ctx.globalAlpha = 1 - k
  ctx.beginPath()
  ctx.arc(x, y, r * (0.4 + 2.6 * easeOut(k)), 0, TAU)
  ctx.stroke()
}

/** Strands of light (stuff off the ship, or space itself) spiralling from round (fx, fy) into the
 * hole: short glowing streaks, each along its own curve, brightest midway. One stroke per strand. */
function drawInflow(ctx: CanvasRenderingContext2D, look: HoleLook, fx: number, fy: number, x: number, y: number, r: number, spread: number, k: number, t: number, z: number) {
  const a0 = Math.atan2(fy - y, fx - x)
  const d0 = Math.hypot(fx - x, fy - y)
  const at = (ph: number, off: number, out: number[]) => {
    const d = d0 + (r * 0.8 - d0) * ph ** 0.7
    const th = a0 + off / Math.max(1, d0) + ph * 2.4
    out[0] = x + Math.cos(th) * d
    out[1] = y + Math.sin(th) * d
  }
  ctx.globalCompositeOperation = 'lighter'
  ctx.lineCap = 'round'
  ctx.strokeStyle = look.glow
  const head = INFLOW_PT
  const tail = INFLOW_PT2
  for (let i = 0; i < 12; i++) {
    const ph = (t * 0.5 + i / 12) % 1
    const off = (fh(i * 3.1) - 0.5) * spread
    at(ph, off, head)
    at(Math.max(0, ph - 0.09), off, tail)
    const fade = k * Math.sin(Math.PI * ph)
    ctx.globalAlpha = fade * 0.85
    ctx.lineWidth = Math.max(1.6 / z, r * 0.045) * (1 - ph * 0.5)
    ctx.beginPath()
    ctx.moveTo(tail[0], tail[1])
    ctx.lineTo(head[0], head[1])
    ctx.stroke()
    ctx.globalAlpha = fade
    blit(ctx, look.flash, head[0], head[1], Math.max(2.5 / z, r * 0.08) * (1 - ph * 0.5))
  }
}
const INFLOW_PT = [0, 0]
const INFLOW_PT2 = [0, 0]

// --- The rift ---------------------------------------------------------------------------------------

/**
 * A rift's shape, in units of its size, across x = 0 (x along the ship's heading, y across it): a
 * jagged crack from the middle out to both ends, and branches off it. Each segment carries when it
 * shows (`t`, 0 in the middle to about 1.25 at the last branch tips), so growing it is a matter of
 * how much to draw. `main`: the crack itself, end to end, as x, y, t.
 */
export type Rift = { segs: Float32Array; main: Float32Array; seed: number }
const RIFT_T = 1.25
const RIFT_STEPS = 11
/** How far the crack reaches out to each side, in its sizes. */
const RIFT_HALF = 0.52

export function makeRift(seed: number): Rift {
  const r = rng(seed)
  const segs: number[] = []
  const halves: number[][] = []
  for (const side of [-1, 1]) {
    const pts = [0, 0, 0]
    let x = 0
    for (let i = 1; i <= RIFT_STEPS; i++) {
      x = Math.max(-0.13, Math.min(0.13, x + (r() - 0.5) * 0.1))
      pts.push(x, side * (i / RIFT_STEPS) * RIFT_HALF + (r() - 0.5) * 0.025, i / RIFT_STEPS)
    }
    halves.push(pts)
    for (let i = 0; i < RIFT_STEPS; i++) segs.push(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 3], pts[i * 3 + 4], pts[i * 3 + 2], pts[i * 3 + 5])
  }
  const [A, B] = halves
  const main: number[] = []
  for (let i = RIFT_STEPS; i >= 0; i--) main.push(A[i * 3], A[i * 3 + 1], A[i * 3 + 2])
  for (let i = 1; i <= RIFT_STEPS; i++) main.push(B[i * 3], B[i * 3 + 1], B[i * 3 + 2])
  const branches = 5 + Math.floor(r() * 3)
  for (let b = 0; b < branches; b++) {
    const side = b % 2 ? 1 : -1
    const h = halves[b % 2]
    const i = 1 + Math.floor(r() * (RIFT_STEPS - 2))
    let x = h[i * 3]
    let y = h[i * 3 + 1]
    let t = h[i * 3 + 2]
    // Off the crack at a slant, forward or back, kinking as it goes.
    let ang = (side * Math.PI) / 2 + (r() < 0.5 ? -1 : 1) * (0.55 + r() * 0.7)
    const n = 2 + Math.floor(r() * 3)
    const len = 0.05 + r() * 0.06
    for (let k = 0; k < n; k++) {
      ang += (r() - 0.5) * 0.9
      const nx = x + Math.cos(ang) * len * (1 - k * 0.15)
      const ny = y + Math.sin(ang) * len * (1 - k * 0.15)
      segs.push(x, y, nx, ny, t, t + 0.13)
      x = nx
      y = ny
      t += 0.13
    }
  }
  return { segs: Float32Array.from(segs), main: Float32Array.from(main), seed }
}
/** A rift's shape for a spot, the same every time for the same spot. */
const riftAt = (x: number, y: number) => makeRift(hash(Math.round(x), Math.round(y), 0x7219))

/** Where a point of the crack sits once only `reach` (in t) of it has torn: pulled in towards the
 * middle if it's further out. */
const reachOf = (t: number, reach: number) => (t <= reach || t <= 0 ? 1 : reach / t)

/**
 * A rift `s` long across a ship's heading `a`, its middle at (x, y): grown to `reveal` (0..1), opened
 * `open` (0..1) into a dark gap, burning at `heat` (0..~1.3). It flickers and judders on a stutter
 * (a new jolt 22 times a second), and spits embers off its edges.
 */
function drawRift(ctx: CanvasRenderingContext2D, look: RiftLook, rift: Rift, x: number, y: number, a: number, s: number, reveal: number, open: number, heat: number, now: number, z: number) {
  if (reveal <= 0 || s * z < 1) return
  const reach = reveal * RIFT_T
  const fr = Math.floor(now * 22) + rift.seed % 997
  const flick = 0.72 + 0.28 * fh(fr * 1.7 + 3)
  const jolt = Math.max(1 / z, s * 0.006) * Math.min(1.4, heat)
  ctx.save()
  ctx.translate(x + (fh(fr) - 0.5) * 2 * jolt, y + (fh(fr + 9.3) - 0.5) * 2 * jolt)
  ctx.rotate(a)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'miter'
  const across = RIFT_HALF * s * Math.min(1, reveal / 0.8)
  ctx.globalCompositeOperation = 'lighter'
  ctx.globalAlpha = Math.min(1, heat * 0.8 * flick)
  ctx.drawImage(look.glow, -s * 0.35 * (1 + open), -across * 1.2, s * 0.7 * (1 + open), across * 2.4)
  const main = rift.main
  const n = main.length / 3
  if (open > 0.01) {
    // The gap: the crack pulled apart, widest in the middle, ragged along its edges.
    const w = s * 0.14 * open
    const full = Math.max(0.05, Math.min(1, reach))
    ctx.beginPath()
    for (let pass = 0; pass < 2; pass++) {
      const sign = pass ? -1 : 1
      for (let j = 0; j < n; j++) {
        const i = pass ? n - 1 - j : j
        const t = main[i * 3 + 2]
        const k = reachOf(t, reach)
        const taper = (1 - Math.min(1, t / full)) ** 0.7 * (0.7 + 0.3 * fh(i + (rift.seed % 113)))
        const ex = main[i * 3] * s * k + sign * w * taper
        const ey = main[i * 3 + 1] * s * k
        if (i === 0 && !pass) ctx.moveTo(ex, ey)
        else ctx.lineTo(ex, ey)
      }
    }
    ctx.closePath()
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = Math.min(1, open * 3) * 0.95
    ctx.fillStyle = look.gap
    ctx.fill()
    ctx.globalCompositeOperation = 'lighter'
    ctx.fillStyle = look.inner
    ctx.fill()
    ctx.strokeStyle = look.mid
    ctx.lineWidth = Math.max(1.5 / z, s * 0.01)
    ctx.globalAlpha = flick
    ctx.stroke()
  }
  // The crack and its branches, as far as they have torn: a red glow, the side's orange, a hot core.
  ctx.globalCompositeOperation = 'lighter'
  ctx.beginPath()
  const segs = rift.segs
  for (let i = 0; i < segs.length; i += 6) {
    const t0 = segs[i + 4]
    if (t0 >= reach) continue
    const t1 = segs[i + 5]
    const f = t1 <= reach ? 1 : (reach - t0) / (t1 - t0)
    ctx.moveTo(segs[i] * s, segs[i + 1] * s)
    ctx.lineTo((segs[i] + (segs[i + 2] - segs[i]) * f) * s, (segs[i + 1] + (segs[i + 3] - segs[i + 1]) * f) * s)
  }
  const h = Math.min(1, heat)
  ctx.strokeStyle = look.deep
  ctx.lineWidth = Math.max(9 / z, s * 0.07) * (0.6 + 0.5 * heat)
  ctx.globalAlpha = 0.22 * flick * h
  ctx.stroke()
  ctx.lineWidth = Math.max(4 / z, s * 0.028) * (0.7 + 0.5 * heat)
  ctx.globalAlpha = 0.65 * flick * h
  ctx.stroke()
  ctx.strokeStyle = look.mid
  ctx.lineWidth = Math.max(2 / z, s * 0.011)
  ctx.globalAlpha = 0.9 * flick * Math.min(1, heat + 0.2)
  ctx.stroke()
  if (heat > 0.15) {
    ctx.strokeStyle = look.hot
    ctx.lineWidth = Math.max(1 / z, s * 0.004)
    ctx.globalAlpha = h * flick
    ctx.stroke()
  }
  // Embers spat off it, drifting and dying.
  if (s * z > 12) {
    ctx.fillStyle = look.mid
    const ems = 12
    for (let i = 0; i < ems; i++) {
      const h1 = fh(i * 7.13 + (rift.seed % 101))
      const h2 = fh(i * 3.71 + (rift.seed % 89))
      const ph = (now * (0.6 + h1 * 0.9) + h2) % 1
      const j = Math.floor(h1 * n)
      const t = main[j * 3 + 2]
      if (t > reach) continue
      const ang = h2 * TAU
      const d = ph * s * (0.06 + 0.2 * h1) * (0.5 + h)
      const ex = main[j * 3] * s + Math.cos(ang) * d
      const ey = main[j * 3 + 1] * s + Math.sin(ang) * d
      const sz = Math.max(1.4 / z, s * 0.007) * (1 - ph * 0.6)
      ctx.globalAlpha = (1 - ph) * h * 0.95
      ctx.fillRect(ex - sz / 2, ey - sz / 2, sz, sz)
    }
  }
  ctx.restore()
}

/** A rift slamming shut, `age` seconds after: a red flash and sparks flung out from it. */
function drawSlam(ctx: CanvasRenderingContext2D, look: RiftLook, seed: number, x: number, y: number, s: number, age: number, z: number) {
  if (age < 0 || age > 0.55) return
  const k = age / 0.55
  ctx.globalCompositeOperation = 'lighter'
  ctx.globalAlpha = (1 - k) ** 2
  blit(ctx, look.flash, x, y, s * (0.35 + 0.9 * k))
  ctx.strokeStyle = look.mid
  ctx.lineWidth = Math.max(1.4 / z, s * 0.008)
  ctx.globalAlpha = 1 - k
  ctx.beginPath()
  for (let i = 0; i < 18; i++) {
    const ang = fh(i * 5.3 + (seed % 97)) * TAU
    const v = s * (0.5 + fh(i * 2.9 + (seed % 53)) * 1.1)
    const d = v * age * (1 - age * 0.7)
    const l = s * 0.05 * (1 - k)
    const c = Math.cos(ang)
    const sn = Math.sin(ang)
    ctx.moveTo(x + c * d, y + sn * d)
    ctx.lineTo(x + c * (d + l), y + sn * (d + l))
  }
  ctx.stroke()
}

/** Clip to one side of a rift's crack (`ahead`: the side its x points to), following its jagged line,
 * so a ship on the other side doesn't show. The context is left clipped: restore it after. */
function clipPast(ctx: CanvasRenderingContext2D, rift: Rift, x: number, y: number, a: number, s: number, ahead: boolean) {
  const far = s * 8 * (ahead ? 1 : -1)
  const main = rift.main
  const n = main.length / 3
  ctx.translate(x, y)
  ctx.rotate(a)
  ctx.beginPath()
  ctx.moveTo(main[0] * s, -s * 8)
  for (let i = 0; i < n; i++) ctx.lineTo(main[i * 3] * s, main[i * 3 + 1] * s)
  ctx.lineTo(main[(n - 1) * 3] * s, s * 8)
  ctx.lineTo(far, s * 8)
  ctx.lineTo(far, -s * 8)
  ctx.closePath()
  ctx.clip()
  ctx.rotate(-a)
  ctx.translate(-x, -y)
}

// --- Per side -----------------------------------------------------------------------------------------

/** Where a ship's wormhole or rift sits, in its sizes from its middle along its heading: behind it on
 * the way in, ahead of it on the way out. */
const HOLE_IN = -0.85
const HOLE_OUT = 0.95
const HOLE_R = 0.45
const RIFT_IN = -0.58
const RIFT_OUT = 0.8
const RIFT_S = 0.95

/**
 * The jumps of the sides that don't use hyperspace. render.ts hands each warp, retreat charge and
 * departure of such a ship here, by its side's WarpStyle. Keeps the rifts of ships charging to
 * retreat, so the crack they tear open on the way out is the one they were tearing all along.
 */
export class WarpFx {
  private charging = new Map<number, { rift: Rift; x: number; y: number; seen: number }>()
  constructor(private ship: ShipFn) {}

  /** A ship on its way in (`v.at` set), charging and then dropping out. */
  warp(ctx: CanvasRenderingContext2D, v: Jump, now: number, z: number) {
    const style = WARP_STYLE[v.faction]
    ctx.save()
    if (style === 'wormhole') this.holeIn(ctx, v, now, z)
    else if (style === 'rift') this.riftIn(ctx, v, now, z)
    ctx.restore()
  }

  /** A ship gone at `v.start`, into its wormhole or rift. */
  depart(ctx: CanvasRenderingContext2D, v: Jump, now: number, z: number) {
    const style = WARP_STYLE[v.faction]
    ctx.save()
    if (style === 'wormhole') this.holeOut(ctx, v, now, z)
    else if (style === 'rift') this.riftOut(ctx, v, now, z)
    ctx.restore()
  }

  /** A warship charging to retreat, `k` (0..1) of the way there. */
  charge(ctx: CanvasRenderingContext2D, id: number, faction: FactionId, x: number, y: number, a: number, size: number, k: number, now: number, z: number) {
    const style = WARP_STYLE[faction]
    const dx = Math.cos(a)
    const dy = Math.sin(a)
    ctx.save()
    if (style === 'wormhole') {
      // Space starts bending before the hole opens; then it opens from a pinprick, swirling faster
      // and throbbing harder as the drive comes ready, and stuff streams off the bow into it.
      const look = holeLook(faction)
      const hx = x + dx * size * HOLE_OUT
      const hy = y + dy * size * HOLE_OUT
      const bend = smooth(k * 2.2)
      const open = 0.04 + 0.96 * smooth((k - 0.08) / 0.72)
      const throb = 1 + 0.07 * k * Math.sin(now * (4 + k * 16))
      const r = size * HOLE_R * open * throb
      const t = now * (0.8 + k * 1.6)
      drawWormhole(ctx, look, hx, hy, Math.max(r, 2 / z), bend, t, z, Math.min(1, k * 6))
      if (k > 0.25 && size * z > 30) drawInflow(ctx, look, x + dx * size * 0.45, y + dy * size * 0.45, hx, hy, r, size * 0.5, smooth((k - 0.25) / 0.4), now, z)
    } else if (style === 'rift') {
      // The crack tears across ahead of it, branch by branch, burning hotter and juddering harder,
      // with surges, and starts to gape at the end.
      let c = this.charging.get(id)
      if (!c) this.charging.set(id, (c = { rift: riftAt(x + dx * size, y + dy * size), x, y, seen: now }))
      c.x = x
      c.y = y
      c.seen = now
      const surge = Math.max(0, Math.sin(now * (3 + k * 9))) ** 8
      const heat = (0.3 + 0.8 * k) * (1 + 0.3 * surge)
      const open = k > 0.7 ? ((k - 0.7) / 0.3) * 0.25 : 0
      drawRift(ctx, riftLook(faction), c.rift, x + dx * size * RIFT_OUT, y + dy * size * RIFT_OUT, a, size * RIFT_S, Math.min(1, 0.05 + k * 1.1), open, heat, now, z)
    }
    ctx.restore()
    // Forget ships that stopped charging (called off, or killed) a while ago.
    if (this.charging.size > 48) for (const [i, c] of this.charging) if (now - c.seen > 2 || c.seen > now) this.charging.delete(i)
  }

  /** The rift a ship that just went was tearing open (the nearest one charging there), or a new one. */
  takeRift(x: number, y: number, size: number): Rift {
    let best: number | undefined
    let bd = size * size
    for (const [i, c] of this.charging) {
      const d = (c.x - x) ** 2 + (c.y - y) ** 2
      if (d < bd) {
        bd = d
        best = i
      }
    }
    if (best === undefined) return riftAt(x, y)
    const r = this.charging.get(best)!.rift
    this.charging.delete(best)
    return r
  }

  /** Wormhole in: it tears open behind the drop point while the jump charges, the ship shoots out
   * of its mouth growing to full size, and it collapses behind it with a last pulse. */
  private holeIn(ctx: CanvasRenderingContext2D, v: Jump, now: number, z: number) {
    const at = v.at ?? v.start
    const look = holeLook(v.faction)
    const dx = Math.cos(v.a)
    const dy = Math.sin(v.a)
    const hx = v.x + dx * v.size * HOLE_IN
    const hy = v.y + dy * v.size * HOLE_IN
    const R = v.size * HOLE_R
    if (now < at) {
      const charge = clamp01((now - v.start) / Math.max(0.01, at - STREAK - v.start))
      const open = easeOut(charge * 1.3) * (1 + 0.05 * Math.sin(now * 9))
      drawWormhole(ctx, look, hx, hy, Math.max(R * open, 1.5 / z), charge, now * (1 + charge), z, Math.min(1, charge * 5))
      const p = (now - (at - STREAK)) / STREAK
      if (p > 0) {
        // Out of the mouth, fast at first, stretched, growing as it clears it.
        const e = easeOut(p)
        const sc = 0.25 + 0.75 * e
        const cx = hx + (v.x - hx) * e
        const cy = hy + (v.y - hy) * e
        ctx.globalCompositeOperation = 'source-over'
        this.ship(ctx, v.unit, cx, cy, v.a + Math.PI / 2, v.size, z, 0.5 + 0.5 * e, [sc * (1 - 0.25 * (1 - p)), sc * (1 + 1.3 * (1 - p))])
        // Its throat closing over the tail as it comes out.
        ctx.globalAlpha = 1 - e
        blit(ctx, look.core, hx, hy, R * 0.8)
      }
    } else {
      const age = now - at
      const q = age / AFTER
      const open = 1 - easeIn(q / 0.55)
      if (open > 0) drawWormhole(ctx, look, hx, hy, R * open * (1 + 0.1 * Math.sin(age * 30) * q), 1 - q, now * (1 + 3 * q), z, 1)
      drawPulse(ctx, look, hx, hy, R, age - AFTER * 0.5, z)
    }
  }

  /** Wormhole out: the ship flies into the one it opened ahead of it, shrinking and stretched into the
   * throat, and the hole swells once, collapses, and goes in a pulse. */
  private holeOut(ctx: CanvasRenderingContext2D, v: Jump, now: number, z: number) {
    const look = holeLook(v.faction)
    const dx = Math.cos(v.a)
    const dy = Math.sin(v.a)
    const hx = v.x + dx * v.size * HOLE_OUT
    const hy = v.y + dy * v.size * HOLE_OUT
    const R = v.size * HOLE_R
    const age = now - v.start
    const q = age / AFTER
    const open = q < 0.42 ? 1 + 0.12 * smooth(q / 0.42) : 1.12 * (1 - easeIn((q - 0.42) / 0.2))
    if (open > 0) drawWormhole(ctx, look, hx, hy, R * open, 1, now * (2.4 + q * 4), z, 1)
    const p = q / 0.4
    if (p < 1) {
      const e = easeIn(p) * 0.6 + p * 0.4
      const sc = 1 - 0.88 * e
      ctx.globalCompositeOperation = 'source-over'
      this.ship(ctx, v.unit, v.x + (hx - v.x) * e, v.y + (hy - v.y) * e, v.a + Math.PI / 2, v.size, z, 1 - 0.5 * p, [sc * (1 - 0.3 * p), sc * (1 + 1.6 * p)])
      // Swallowed: the throat darkening over it as it goes in.
      ctx.globalAlpha = smooth(p * 1.2)
      blit(ctx, look.core, hx, hy, R * 0.85 * open)
    }
    drawPulse(ctx, look, hx, hy, R, age - AFTER * 0.6, z)
  }

  /** Rift in: a crack forms behind the drop point while the jump charges; then it splits wide, the
   * ship is shoved out of it with a jolt (overshooting and recoiling), and it snaps shut, leaving
   * fading cracks and embers. */
  private riftIn(ctx: CanvasRenderingContext2D, v: Jump, now: number, z: number) {
    const at = v.at ?? v.start
    const look = riftLook(v.faction)
    const rift = (v.rift ??= riftAt(v.x, v.y))
    const dx = Math.cos(v.a)
    const dy = Math.sin(v.a)
    const s = v.size
    const rx = v.x + dx * s * RIFT_IN
    const ry = v.y + dy * s * RIFT_IN
    if (now < at) {
      const charge = clamp01((now - v.start) / Math.max(0.01, at - STREAK - v.start))
      const p = (now - (at - STREAK)) / STREAK
      const open = p > 0 ? easeOut(p / 0.25) : 0.03 * charge
      drawRift(ctx, look, rift, rx, ry, v.a, s, smooth(charge * 1.15), open, p > 0 ? 1.25 : 0.25 + 0.75 * charge, now, z)
      if (p > 0) {
        // Shoved through to just past its mark, then recoiling back onto it, shaking.
        let along: number
        if (p < 0.5) along = -1.15 + 1.31 * easeOut(p / 0.5)
        else {
          const u = (p - 0.5) / 0.5
          along = 0.16 * (1 - u) ** 2 * Math.cos(u * Math.PI * 2.5)
        }
        const side = Math.sin(p * 40) * (1 - p) * 0.02 * s
        const cx = v.x + dx * along * s - dy * side
        const cy = v.y + dy * along * s + dx * side
        ctx.save()
        clipPast(ctx, rift, rx, ry, v.a, s, true)
        ctx.globalCompositeOperation = 'source-over'
        this.ship(ctx, v.unit, cx, cy, v.a + Math.PI / 2 + Math.sin(p * 31) * (1 - p) * 0.05, s, z, 1)
        ctx.restore()
      }
    } else {
      const age = now - at
      const q = age / AFTER
      drawRift(ctx, look, rift, rx, ry, v.a, s, 1, q < 0.09 ? 1 - q / 0.09 : 0, 1.1 * (1 - q) ** 1.6, now, z)
      if (age < 0.25) {
        ctx.globalCompositeOperation = 'lighter'
        ctx.globalAlpha = 1 - age / 0.25
        blit(ctx, look.flash, rx, ry, s * 0.5)
      }
    }
  }

  /** Rift out: the crack it tore ahead of it gapes open, the ship lurches (a jolt back, then in), and
   * the rift slams shut behind it with a red flash and a burst of sparks. */
  private riftOut(ctx: CanvasRenderingContext2D, v: Jump, now: number, z: number) {
    const look = riftLook(v.faction)
    const rift = (v.rift ??= riftAt(v.x, v.y))
    const dx = Math.cos(v.a)
    const dy = Math.sin(v.a)
    const s = v.size
    const rx = v.x + dx * s * RIFT_OUT
    const ry = v.y + dy * s * RIFT_OUT
    const age = now - v.start
    const q = age / AFTER
    const SHUT = 0.46
    const open = q < 0.12 ? easeOut(q / 0.12) : q < 0.4 ? 1 : q < SHUT ? 1 - (q - 0.4) / (SHUT - 0.4) : 0
    const heat = q < SHUT ? 1.25 : 1.3 * (1 - (q - SHUT) / (1 - SHUT)) ** 2
    drawRift(ctx, look, rift, rx, ry, v.a, s * RIFT_S, 1, open, heat, now, z)
    if (q < 0.42) {
      const along = q < 0.1 ? -0.07 * Math.sin((q / 0.1) * Math.PI) : 1.6 * ((q - 0.1) / 0.32) ** 3
      const side = Math.sin(q * 60) * 0.012 * s
      ctx.save()
      clipPast(ctx, rift, rx, ry, v.a, s * RIFT_S, false)
      ctx.globalCompositeOperation = 'source-over'
      this.ship(ctx, v.unit, v.x + dx * along * s - dy * side, v.y + dy * along * s + dx * side, v.a + Math.PI / 2, s, z, 1, [1, 1 + 0.25 * clamp01((q - 0.1) / 0.32)])
      ctx.restore()
    }
    drawSlam(ctx, look, rift.seed, rx, ry, s, (q - SHUT) * AFTER, z)
  }
}
