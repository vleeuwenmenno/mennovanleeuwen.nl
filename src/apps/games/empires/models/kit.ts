import type { Detail, Part, Pt, Tone } from './types.ts'

// The building blocks models are made of: polygon geometry, parametric shapes (wedge hulls,
// tapered sections, wings, engine pods, rings, chamfered blocks), mirroring, seeded variation,
// and each faction's palette. Pure maths, so it runs in Node as well as the browser.

const TAU = Math.PI * 2

// --- Geometry ------------------------------------------------------------------------------------

/** Polygon area (positive for either winding). */
export function area(pts: Pt[]) {
  let a = 0
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1])
  return Math.abs(a / 2)
}

export function inPoly(pts: Pt[], x: number, y: number) {
  let c = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]
    const [xj, yj] = pts[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c
  }
  return c
}

/** Inside a part: in its outline and not in one of its holes. */
export const inPart = (p: Part, x: number, y: number) => inPoly(p.pts, x, y) && !(p.holes ?? []).some((h) => inPoly(h, x, y))

export function bounds(pts: Pt[]) {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const [x, y] of pts) {
    if (x < x0) x0 = x
    if (y < y0) y0 = y
    if (x > x1) x1 = x
    if (y > y1) y1 = y
  }
  return { x0, y0, x1, y1 }
}

export const centroid = (pts: Pt[]): Pt => {
  let x = 0
  let y = 0
  for (const p of pts) {
    x += p[0]
    y += p[1]
  }
  return [x / pts.length, y / pts.length]
}

export const flipX = (pts: Pt[]): Pt[] => pts.map(([x, y]) => [-x, y] as Pt).reverse()
export const move = (pts: Pt[], dx: number, dy: number): Pt[] => pts.map(([x, y]) => [x + dx, y + dy] as Pt)
export const scale = (pts: Pt[], k: number, ky = k): Pt[] => pts.map(([x, y]) => [x * k, y * ky] as Pt)
export function turn(pts: Pt[], a: number, cx = 0, cy = 0): Pt[] {
  const c = Math.cos(a)
  const s = Math.sin(a)
  return pts.map(([x, y]) => [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c] as Pt)
}

/** A seeded random number source in [0, 1) (mulberry32, as maps.ts uses). */
export function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Mixes numbers into one well-spread 32-bit hash, with integer maths only, so every JavaScript
 * engine gets the same answer (multiplayer clients must agree on how a wreck broke). */
export function hash(...vals: number[]) {
  let h = 0x9e3779b9
  for (const v of vals) {
    h = Math.imul(h ^ (v | 0), 0x85ebca6b)
    h ^= h >>> 13
    h = Math.imul(h, 0xc2b2ae35)
    h ^= h >>> 16
  }
  return h >>> 0
}

/** A name as a number, for seeding. */
export function seedOf(text: string) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
  return h >>> 0
}

// --- Shapes ----------------------------------------------------------------------------------------

/** A circle (or ellipse) as a polygon of `n` points. */
export function circle(x: number, y: number, r: number, n = 24, ry = r): Pt[] {
  const out: Pt[] = []
  for (let i = 0; i < n; i++) out.push([x + Math.cos((i / n) * TAU) * r, y + Math.sin((i / n) * TAU) * ry])
  return out
}

/** Part of a ring between radii r0 and r1, from angle a0 to a1 (radians, 0 = right, clockwise
 * on screen since y points down). */
export function arcBand(x: number, y: number, r0: number, r1: number, a0: number, a1: number, n = 12): Pt[] {
  const out: Pt[] = []
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n
    out.push([x + Math.cos(a) * r1, y + Math.sin(a) * r1])
  }
  for (let i = n; i >= 0; i--) {
    const a = a0 + ((a1 - a0) * i) / n
    out.push([x + Math.cos(a) * r0, y + Math.sin(a) * r0])
  }
  return out
}

export const rect = (x: number, y: number, w: number, h: number): Pt[] => [
  [x, y],
  [x + w, y],
  [x + w, y + h],
  [x, y + h],
]
/** A box centred on (x, y). */
export const box = (x: number, y: number, w: number, h: number) => rect(x - w / 2, y - h / 2, w, h)

/** A box with its corners cut off by `c`: the angular plating the Republic builds with. */
export function chamfer(x: number, y: number, w: number, h: number, c: number): Pt[] {
  const l = x - w / 2
  const r = x + w / 2
  const t = y - h / 2
  const b = y + h / 2
  return [
    [l + c, t],
    [r - c, t],
    [r, t + c],
    [r, b - c],
    [r - c, b],
    [l + c, b],
    [l, b - c],
    [l, t + c],
  ]
}

/** A rounded box, corners of radius `rr`. */
export function rounded(x: number, y: number, w: number, h: number, rr: number, n = 4): Pt[] {
  const out: Pt[] = []
  const corners: [number, number, number][] = [
    [x + w / 2 - rr, y - h / 2 + rr, -Math.PI / 2],
    [x + w / 2 - rr, y + h / 2 - rr, 0],
    [x - w / 2 + rr, y + h / 2 - rr, Math.PI / 2],
    [x - w / 2 + rr, y - h / 2 + rr, Math.PI],
  ]
  for (const [cx, cy, a0] of corners) for (let i = 0; i <= n; i++) out.push([cx + Math.cos(a0 + (i / n) * (Math.PI / 2)) * rr, cy + Math.sin(a0 + (i / n) * (Math.PI / 2)) * rr])
  return out
}

/** A section centred on x = 0 that tapers from half-width w0 at y0 to w1 at y1. */
export const taper = (y0: number, w0: number, y1: number, w1: number, x = 0): Pt[] => [
  [x - w0, y0],
  [x + w0, y0],
  [x + w1, y1],
  [x - w1, y1],
]

/**
 * A dagger hull from the nose (y0) to its widest point (y1, half-width w), its sides bowed out by
 * `bow` (0 straight, 0.3 a fuller ogive), then a trailing edge in to half-width `tw` at `ty`.
 * Returns the left half and the right half separately, so each can be its own lit facet.
 */
export function wedgeHalves(y0: number, y1: number, w: number, ty: number, tw: number, bow = 0.2, n = 8): [Pt[], Pt[]] {
  const side: Pt[] = []
  for (let i = 0; i <= n; i++) {
    const t = i / n
    side.push([-w * Math.pow(t, 1 - bow), y0 + (y1 - y0) * t])
  }
  const left: Pt[] = [[0, y0], ...side.slice(1), [-tw, ty], [0, ty]]
  return [left, flipX(left)]
}

/**
 * A swept wing on the right side: from its root on the hull (root x, leading-edge y, chord) out to
 * a tip `span` further out and `sweep` further back, with a tip chord of its own.
 */
export function wing(rx: number, ry: number, chord: number, span: number, sweep: number, tipChord: number): Pt[] {
  return [
    [rx, ry],
    [rx + span, ry + sweep],
    [rx + span, ry + sweep + tipChord],
    [rx, ry + chord],
  ]
}

/** An engine pod seen from above: a rounded body with a flared nozzle at the back (positive y). */
export function pod(x: number, y0: number, y1: number, w: number): Pt[] {
  const r = w / 2
  return [...rounded(x, (y0 + y1) / 2, w, y1 - y0, Math.min(r, (y1 - y0) / 2) * 0.6)]
}

/** A jagged line from a to b: `steps` segments, each point pushed sideways by up to `amp`. Used
 * for break lines and scorch edges. */
export function jagged(a: Pt, b: Pt, steps: number, amp: number, r: () => number): Pt[] {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len = Math.hypot(dx, dy) || 1
  const nx = -dy / len
  const ny = dx / len
  const out: Pt[] = [a]
  for (let i = 1; i < steps; i++) {
    const t = i / steps
    const off = (r() - 0.5) * 2 * amp
    out.push([a[0] + dx * t + nx * off, a[1] + dy * t + ny * off])
  }
  out.push(b)
  return out
}

/** A blob for a scorch mark: a lumpy circle. */
export function blob(x: number, y: number, r: number, r0: () => number, n = 9): Pt[] {
  const out: Pt[] = []
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU
    const k = 0.55 + r0() * 0.6
    out.push([x + Math.cos(a) * r * k, y + Math.sin(a) * r * k])
  }
  return out
}

// --- Parts -----------------------------------------------------------------------------------------

/** A part, with the less common fields left to `more`. */
export const part = (id: string, pts: Pt[], tone: Tone, z: number, more: Partial<Part> = {}): Part => ({ id, pts, tone, z, ...more })

function mirrorDetail(d: Detail): Detail {
  if (d.k === 'line') return { ...d, pts: d.pts.map(([x, y]) => [-x, y] as Pt) }
  if (d.k === 'lights') return { ...d, pts: d.pts.map(([x, y]) => [-x, y] as Pt) }
  return { ...d, pts: flipX(d.pts) }
}

/** A part mirrored across the centre line: x flipped, its facet facing the other way. */
export function mirror(p: Part, id = p.id.endsWith('L') ? `${p.id.slice(0, -1)}R` : `${p.id}R`, more: Partial<Part> = {}): Part {
  return {
    ...p,
    id,
    pts: flipX(p.pts),
    holes: p.holes?.map(flipX),
    slope: p.slope ? [-p.slope[0], p.slope[1]] : undefined,
    facets: p.facets?.map((f) => ({ pts: flipX(f.pts), slope: [-f.slope[0], f.slope[1]] as Pt })),
    details: p.details?.map(mirrorDetail),
    ...more,
  }
}

/** A part and its mirror image: ids end in L and R. `right` overrides fields on the mirrored one
 * (a wing tip that breaks off at another hull share, an engine glow with another index). */
export function sym(p: Part, right: Partial<Part> = {}): Part[] {
  const left = { ...p, id: `${p.id}L` }
  return [left, mirror(left, `${p.id}R`, right)]
}

/** Panel lines along a polygon's edge, inset by `d` (rough: towards its middle). */
export function inset(pts: Pt[], d: number): Pt[] {
  const [cx, cy] = centroid(pts)
  return pts.map(([x, y]) => {
    const dx = cx - x
    const dy = cy - y
    const l = Math.hypot(dx, dy) || 1
    return [x + (dx / l) * d, y + (dy / l) * d] as Pt
  })
}

// --- Palettes and style kits ------------------------------------------------------------------------

/** Three cel tones per colour role: lit, base, shadow. */
export type Palette = Record<Tone, [string, string, string]> & { outline: string; smoke: string; debris: string }

/**
 * Taken from the faction sprites, so the models still read as the same sides: Republic warships are
 * off-white with deep red bands, grey machinery and blue engine light; droid ships bone tan with
 * violet accents and violet glow. Shadows lean cool, the way the cartoon shades them.
 */
export const PALETTES: Record<'republic' | 'droid', Palette> = {
  republic: {
    hull: ['#f7f3ea', '#e0dacd', '#a4a3ad'],
    hull2: ['#ebe5d8', '#cdc6b8', '#8e8c94'],
    accent: ['#e5483e', '#b7222b', '#6e1a24'],
    metal: ['#9599a2', '#6e727c', '#464a54'],
    dark: ['#50545e', '#373a42', '#22242b'],
    glass: ['#9fd8ff', '#3a6f9e', '#1c3550'],
    glow: ['#d8f3ff', '#6ad0ff', '#2a86d6'],
    char: ['#4a3d34', '#2e2520', '#1a1411'],
    ember: ['#ffe29a', '#ff8a3a', '#c4401a'],
    outline: '#15171d',
    smoke: 'rgba(52,52,60,1)',
    debris: '#d8d2c8',
  },
  droid: {
    hull: ['#f6e7c6', '#d9c095', '#9a8263'],
    hull2: ['#e5cfa6', '#bea57a', '#7c684d'],
    accent: ['#c9a0ff', '#8c55d6', '#4c2c7c'],
    metal: ['#86766a', '#5e5248', '#3a322c'],
    dark: ['#4e4038', '#332822', '#1e1814'],
    glass: ['#f0d6ff', '#a070ff', '#4e3290'],
    glow: ['#f4e2ff', '#c890ff', '#8a50d0'],
    char: ['#4a3d34', '#2e2520', '#1a1411'],
    ember: ['#ffe29a', '#ff8a3a', '#c4401a'],
    outline: '#1b130d',
    smoke: 'rgba(58,52,48,1)',
    debris: '#c8b48c',
  },
}

/** The world's light: from the top left of the screen, whichever way a ship points. A unit vector
 * pointing towards the light, in screen space (y down). */
export const LIGHT: Pt = [-Math.SQRT1_2, -Math.SQRT1_2]

/** The light as seen from a model turned by `rot` (radians, as drawn): the world light turned the
 * other way. */
export function lightFor(rot: number): Pt {
  const c = Math.cos(-rot)
  const s = Math.sin(-rot)
  return [LIGHT[0] * c - LIGHT[1] * s, LIGHT[0] * s + LIGHT[1] * c]
}

/** How a facet facing `slope` is lit by `light`: 0 lit, 1 base, 2 shadow. Hard steps, no blend:
 * that is what makes it cel shading. */
export function toneIndex(slope: Pt | undefined, light: Pt) {
  if (!slope) return 1
  const d = slope[0] * light[0] + slope[1] * light[1]
  return d > 0.16 ? 0 : d < -0.16 ? 2 : 1
}
