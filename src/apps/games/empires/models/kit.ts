import type { Detail, Part, Pt, Tone } from './types.ts'

// The building blocks models are made of: polygon geometry, parametric shapes (wedge hulls,
// tapered sections, wings, engine pods, rings, chamfered blocks), mirroring, seeded variation,
// and what a palette is (each faction's own is in models/<faction>/palette.ts). Pure maths, so it runs in Node as well as the browser.

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

/** A rounded bar from a to b, `r0` thick at a and `r1` at b, with round ends: a strut, a droid's
 * limb segment, a boom. */
export function capsule(a: Pt, b: Pt, r0: number, r1 = r0, n = 5): Pt[] {
  const ang = Math.atan2(b[1] - a[1], b[0] - a[0])
  const out: Pt[] = []
  for (let i = 0; i <= n; i++) {
    const t = ang - Math.PI / 2 + (i / n) * Math.PI
    out.push([b[0] + Math.cos(t) * r1, b[1] + Math.sin(t) * r1])
  }
  for (let i = 0; i <= n; i++) {
    const t = ang + Math.PI / 2 + (i / n) * Math.PI
    out.push([a[0] + Math.cos(t) * r0, a[1] + Math.sin(t) * r0])
  }
  return out
}

/**
 * A smooth curve through points (Catmull-Rom), `n` steps between each pair: how the droids' organic
 * outlines are drawn from a handful of control points. `closed` joins the last point to the first.
 */
export function spline(pts: Pt[], n = 4, closed = false): Pt[] {
  const out: Pt[] = []
  const len = pts.length
  const at = (i: number) => (closed ? pts[((i % len) + len) % len] : pts[Math.max(0, Math.min(len - 1, i))])
  const segs = closed ? len : len - 1
  for (let i = 0; i < segs; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)]
    for (let k = 0; k < n; k++) {
      const t = k / n
      const t2 = t * t
      const t3 = t2 * t
      const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3)
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])])
    }
  }
  if (!closed) out.push(pts[len - 1])
  return out
}

/** A band along a polyline, `w0` thick at its start tapering to `w1` at its end: a limb, a spar, a
 * strand of web. */
export function thick(pts: Pt[], w0: number, w1 = w0): Pt[] {
  const n = pts.length
  const left: Pt[] = []
  const right: Pt[] = []
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)]
    const b = pts[Math.min(n - 1, i + 1)]
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const l = Math.hypot(dx, dy) || 1
    const w = (w0 + (w1 - w0) * (i / Math.max(1, n - 1))) / 2
    left.push([pts[i][0] - (dy / l) * w, pts[i][1] + (dx / l) * w])
    right.push([pts[i][0] + (dy / l) * w, pts[i][1] - (dx / l) * w])
  }
  return [...left, ...right.reverse()]
}

/** The left half of a hull from its outline, as (y, half-width) rows from nose to tail, closed down
 * the centre line, so it can be mirrored into the right half (sym) and each half lit on its own. */
export const halfHull = (rows: [number, number][]): Pt[] => [[0, rows[0][0]], ...rows.map(([y, w]) => [-w, y] as Pt), [0, rows[rows.length - 1][0]]]
/** A whole outline from (y, half-width) rows, both sides in one polygon. */
export const fullHull = (rows: [number, number][]): Pt[] => [...rows.map(([y, w]) => [-w, y] as Pt), ...rows.map(([y, w]) => [w, y] as Pt).reverse()]

/** Evenly spaced points from a to b, both ends included: rows of windows and running lights. */
export function along(a: Pt, b: Pt, n: number): Pt[] {
  return Array.from({ length: n }, (_, i) => {
    const t = n === 1 ? 0.5 : i / (n - 1)
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t] as Pt
  })
}

/** A part turned by `a` round (cx, cy), its facets, slope and details turned with it. */
export function turnPart(p: Part, a: number, cx = 0, cy = 0): Part {
  const c = Math.cos(a)
  const s = Math.sin(a)
  const tp = (pts: Pt[]) => turn(pts, a, cx, cy)
  const ts = (v: Pt): Pt => [v[0] * c - v[1] * s, v[0] * s + v[1] * c]
  return {
    ...p,
    pts: tp(p.pts),
    holes: p.holes?.map(tp),
    slope: p.slope ? ts(p.slope) : undefined,
    facets: p.facets?.map((f) => ({ pts: tp(f.pts), slope: ts(f.slope) })),
    details: p.details?.map((d) => ({ ...d, pts: tp(d.pts) })),
  }
}

/** The four bevelled edges of a box centred on (x, y), `b` wide, as facets facing up, right, down
 * and left: how a ground building's armoured block or a vehicle's hull is cel shaded from above. */
export function bevel(x: number, y: number, w: number, h: number, b: number, k = 0.8): { pts: Pt[]; slope: Pt }[] {
  const l = x - w / 2
  const r = x + w / 2
  const t = y - h / 2
  const d = y + h / 2
  return [
    { pts: [[l, t], [r, t], [r - b, t + b], [l + b, t + b]], slope: [0, -k] },
    { pts: [[r, t], [r, d], [r - b, d - b], [r - b, t + b]], slope: [k, 0] },
    { pts: [[r, d], [l, d], [l + b, d - b], [r - b, d - b]], slope: [0, k] },
    { pts: [[l, d], [l, t], [l + b, t + b], [l + b, d - b]], slope: [-k, 0] },
  ]
}

/** A regular polygon of `n` sides round (x, y), radius `r` to its corners, the first corner at
 * angle `a0`: an eight-sided deck, a hex pad. */
export function ngon(x: number, y: number, r: number, n: number, a0 = 0): Pt[] {
  return Array.from({ length: n }, (_, i) => [x + Math.cos(a0 + (i / n) * TAU) * r, y + Math.sin(a0 + (i / n) * TAU) * r] as Pt)
}

/** Facets between an outline and a smaller copy of it scaled towards (x, y) by `inner` (0 a cone to
 * the middle): each side's band faces outwards, so a deck's rim or a mound is cel shaded round. */
export function rimFacets(outline: Pt[], x: number, y: number, inner: number, k = 0.8): { pts: Pt[]; slope: Pt }[] {
  const n = outline.length
  const inPt = ([px, py]: Pt): Pt => [x + (px - x) * inner, y + (py - y) * inner]
  return outline.map((a, i) => {
    const b = outline[(i + 1) % n]
    const mx = (a[0] + b[0]) / 2 - x
    const my = (a[1] + b[1]) / 2 - y
    const l = Math.hypot(mx, my) || 1
    return { pts: [a, b, inPt(b), inPt(a)], slope: [(mx / l) * k, (my / l) * k] as Pt }
  })
}

/** Track or tread lines across a band from (x0, y0) to (x1, y1), `n` of them evenly spaced down it:
 * the treads of a tracked vehicle seen from above. */
export function treads(x0: number, x1: number, y0: number, y1: number, n: number): Detail[] {
  return Array.from({ length: n }, (_, i) => {
    const y = y0 + ((y1 - y0) * (i + 0.5)) / n
    return { k: 'line' as const, pts: [[x0, y], [x1, y]] as Pt[] }
  })
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
export type Palette = Record<Tone, [string, string, string]> & { outline: string; smoke: string; debris: string; /** Engine light, for the glow drawn behind the nozzles. */ engine: string }

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
