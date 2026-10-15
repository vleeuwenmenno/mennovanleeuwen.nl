import { along, box, chamfer, circle, part } from '../kit.ts'
import type { BuildCtx } from '../spec.ts'
import type { Detail, Part, Pt, Tone } from '../types.ts'

// The Republic's construction kit, shared by its ships, platforms, yards and station: the engine
// pod and turret seats from its reference sheet, red edge bands, window rows and raised blocks.
//
// Fine detail (panel lines) is drawn as 'line' details, which the painter leaves off small bitmaps
// (models/paint.ts draws them only from about one device pixel per model unit up), so a ship far
// out keeps its silhouette and colours and the detail comes in as it grows on screen. Windows, masts
// and dishes carry a `minPx` of their own for the same reason.

/** Where hardpoint `i` sits in model units, or null if the unit type has no such hardpoint (a
 * battle saved before a redesign keeps its old types, with their own hardpoints). */
export function hpAt(c: BuildCtx, i: number): Pt | null {
  const h = c.t.hardpoints[i]
  return h ? [(h.x / 10 - 0.5) * c.w, (h.y / 10 - 0.5) * c.h] : null
}

/** A mount's radius in model units on hardpoint `i` (0 if there is none). */
export const hpR = (c: BuildCtx, i: number) => ((c.t.hardpoints[i]?.s ?? 0) * Math.max(c.w, c.h)) / 2

/**
 * An engine pod after the sheet's thruster module: a grey housing, chamfered at the front and shaded
 * as a cylinder (two facets), a red band round it, a small blue light on top, and at the back a
 * square cyan nozzle in a dark frame. `w` wide, from y0 (front) to y1 (the nozzle), centred on x.
 * `engine`: the engine glow it carries (it goes dark with it).
 */
export function enginePod(id: string, x: number, y0: number, y1: number, w: number, engine: number | undefined, z: number, more: Partial<Part> = {}, band: Tone = 'accent'): Part {
  const h = w / 2
  const len = y1 - y0
  const c = Math.min(h * 0.6, len * 0.25)
  const half = (s: number): Pt[] => [[x, y0], [x + s * (h - c), y0], [x + s * h, y0 + c], [x + s * h, y1 - c * 0.5], [x + s * (h - c * 0.5), y1], [x, y1]]
  const n = Math.min(w * 0.5, len * 0.32)
  const details: Detail[] = [
    { k: 'shape', pts: box(x, y0 + len * 0.3, w, Math.max(0.6, len * 0.13)), tone: band },
    { k: 'line', pts: [[x - h, y0 + len * 0.55], [x + h, y0 + len * 0.55]] },
    { k: 'line', pts: [[x, y0 + c], [x, y0 + len * 0.22]] },
    { k: 'shape', pts: box(x, y1 - n * 0.62, n * 1.25, n * 1.05), tone: 'dark' },
    { k: 'lights', pts: [[x, y0 + len * 0.12]], r: Math.max(0.25, w * 0.05), tone: 'glass' },
  ]
  if (engine !== undefined) details.push({ k: 'lights', pts: [[x, y1 - n * 0.62]], r: n * 0.4, tone: 'glow' })
  return part(id, [...half(-1), ...half(1).reverse()], 'hull2', z, { lift: 1, engine, facets: [{ pts: half(-1), slope: [-0.5, 0] }, { pts: half(1), slope: [0.5, 0] }], details, ...more })
}

/**
 * A turret's seat on hardpoint `i`: a raised pad a little wider than the turret under it, a ring
 * scribed round it. `heavy`: an armoured barbette, banded in red at its back, under a big gun;
 * `oct`: an octagonal pad (point defence, torpedo racks). Nothing if the hardpoint isn't there.
 */
export function seat(id: string, c: BuildCtx, i: number, k: number, z: number, look: 'pad' | 'heavy' | 'oct' = 'pad'): Part[] {
  const at = hpAt(c, i)
  if (!at) return []
  const [x, y] = at
  const r = hpR(c, i) * k
  const pts = look === 'oct' ? chamfer(x, y, r * 2, r * 2, r * 0.58) : circle(x, y, r, look === 'heavy' ? 22 : 18)
  return [
    part(id, pts, look === 'heavy' ? 'metal' : 'hull2', z, {
      lift: look === 'heavy' ? 1 : 0.6,
      details: [
        { k: 'line', pts: look === 'oct' ? chamfer(x, y, r * 1.7, r * 1.7, r * 0.5) : circle(x, y, r * 0.86, 18) },
        ...(look === 'heavy' ? [{ k: 'shape' as const, pts: box(x, y + r * 0.8, r * 0.9, r * 0.24), tone: 'accent' as const }] : []),
      ],
    }),
  ]
}

/** A red band along the left edge of a hull from its (y, half-width) rows, `d` thick. */
export const edgeBand = (rows: [number, number][], d: number): Pt[] => [...rows.map(([y, w]) => [-w, y] as Pt), ...rows.map(([y, w]) => [-w + d, y + d * 0.2] as Pt).reverse()]

/** How big (device pixels, the hull's long side) a hull is drawn before its rows of windows and its
 * masts and dishes show: below it they would only be specks. */
const WINDOWS_PX = 130
const GREEBLE_PX = 90

/** A row of small windows or running lights from a to b (only on a hull drawn big enough). */
export const windows = (a: Pt, b: Pt, n: number, r: number, tone: Tone = 'glass'): Detail => ({ k: 'lights', pts: along(a, b, n), r, tone, minPx: WINDOWS_PX })

/**
 * One raised block of a superstructure or spine: a chamfered grey block with a red band across it,
 * a blue light on top and a panel seam, `w` by `h` round (x, y).
 */
export function block(id: string, x: number, y: number, w: number, h: number, z: number, more: Partial<Part> = {}, tone: Tone = 'hull2'): Part {
  return part(id, chamfer(x, y, w, h, Math.min(w, h) * 0.22), tone, z, {
    lift: 1.2,
    facets: [{ pts: [[x - w / 2, y - h / 2 + Math.min(w, h) * 0.22], [x - w / 2 + Math.min(w, h) * 0.22, y - h / 2], [x - w * 0.3, y - h / 2], [x - w * 0.3, y + h / 2], [x - w / 2 + Math.min(w, h) * 0.22, y + h / 2], [x - w / 2, y + h / 2 - Math.min(w, h) * 0.22]], slope: [-0.5, 0] }],
    details: [
      { k: 'shape', pts: box(x, y + h * 0.22, w, h * 0.16), tone: 'accent' },
      { k: 'lights', pts: [[x, y - h * 0.18]], r: Math.min(w, h) * 0.11, tone: 'glass' },
      { k: 'line', pts: [[x - w / 2, y - h * 0.02], [x + w / 2, y - h * 0.02]] },
    ],
    ...more,
  })
}

/** A sensor mast: a thin dark spar with a red light at its tip, shot off as the hull is battered. */
export const mast = (id: string, x: number, y: number, len: number, z: number, at: number, w = 0.8): Part =>
  part(id, box(x, y, w, len), 'dark', z, { minPx: GREEBLE_PX, detach: { hull: at }, details: [{ k: 'lights', pts: [[x, y - len / 2 + w * 0.6]], r: w * 0.55, tone: 'accent' }] })

/** A small dish antenna, shot off as the hull is battered. */
export const dish = (id: string, x: number, y: number, r: number, z: number, at: number, slope: Pt = [-0.3, 0.3]): Part =>
  part(id, circle(x, y, r, 14), 'hull2', z, { minPx: GREEBLE_PX, lift: r * 0.4, slope, detach: { hull: at }, details: [{ k: 'shape', pts: circle(x + slope[0] * r * 0.4, y + slope[1] * r * 0.4, r * 0.55, 10), tone: 'metal' }, { k: 'shape', pts: circle(x, y, r * 0.22, 8), tone: 'dark' }] })

// --- Station modules ----------------------------------------------------------------------------------
//
// The five standard modules from the sheet's station design, which the Command Station, the
// platforms and the yards are assembled from: the core (command module), the truss (structural
// girder), the habitat (crew and services), the docking module (shipyard) and the defense module
// (a turret's drum). Each is drawn round a point in whatever units the model uses, sized by its
// arguments, so the same module reads the same on a platform and on the station.

/**
 * A core command module: an octagonal hull shaded as a drum, a red band across its middle with rows
 * of blue windows either side, end caps top and bottom, and a blue glass dome on top.
 */
export function coreModule(id: string, x: number, y: number, r: number, z: number, dome = true): Part[] {
  const c = r * 0.42
  const out: Part[] = [
    part(`${id}Cap`, box(x, y, r * 0.7, r * 2.24), 'hull2', z - 0.1, { lift: r * 0.05, details: [{ k: 'lights', pts: [[x, y - r * 1.04], [x, y + r * 1.04]], r: r * 0.05, tone: 'glass' }] }),
    part(id, chamfer(x, y, r * 2, r * 2, c), 'hull', z, {
      lift: r * 0.07,
      facets: [
        { pts: [[x - r, y - r + c], [x - r + c, y - r], [x - r * 0.5, y - r], [x - r * 0.5, y + r], [x - r + c, y + r], [x - r, y + r - c]], slope: [-0.5, 0] },
        { pts: [[x + r, y - r + c], [x + r - c, y - r], [x + r * 0.5, y - r], [x + r * 0.5, y + r], [x + r - c, y + r], [x + r, y + r - c]], slope: [0.5, 0] },
      ],
      details: [
        { k: 'shape', pts: box(x, y, r * 2, r * 0.28), tone: 'accent' },
        windows([x - r * 0.62, y - r * 0.46], [x + r * 0.62, y - r * 0.46], 5, r * 0.055),
        windows([x - r * 0.62, y + r * 0.46], [x + r * 0.62, y + r * 0.46], 5, r * 0.055),
        { k: 'line', pts: [[x - r * 0.5, y - r], [x - r * 0.5, y + r]] },
        { k: 'line', pts: [[x + r * 0.5, y - r], [x + r * 0.5, y + r]] },
        { k: 'line', pts: [[x - r, y - r * 0.72], [x + r, y - r * 0.72]] },
        { k: 'line', pts: [[x - r, y + r * 0.72], [x + r, y + r * 0.72]] },
      ],
    }),
  ]
  if (dome)
    out.push(
      part(`${id}DomeRing`, circle(x, y, r * 0.42, 20), 'hull2', z + 0.2, { lift: r * 0.04, details: [{ k: 'line', pts: circle(x, y, r * 0.38, 18) }] }),
      part(`${id}Dome`, circle(x, y, r * 0.34, 22), 'glass', z + 0.3, { sphere: true, details: [{ k: 'shape', pts: [[x - r * 0.2, y - r * 0.1], [x + r * 0.1, y - r * 0.3], [x + r * 0.14, y - r * 0.24], [x - r * 0.16, y - r * 0.04]], tone: 'glow' }] }),
    )
  return out
}

/** A truss: a grey girder from a to b, `w` wide, two rails and the cross bracing between them
 * scribed on it, a light at each end. */
export function truss(id: string, a: Pt, b: Pt, w: number, z: number, more: Partial<Part> = {}): Part {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len = Math.hypot(dx, dy) || 1
  const nx = (-dy / len) * (w / 2)
  const ny = (dx / len) * (w / 2)
  const at = (t: number, s: number): Pt => [a[0] + dx * t + nx * s, a[1] + dy * t + ny * s]
  const n = Math.max(2, Math.round(len / (w * 1.4)))
  const zig: Pt[] = Array.from({ length: n + 1 }, (_, i) => at(i / n, i % 2 ? 0.5 : -0.5))
  return part(id, [at(0, -1), at(1, -1), at(1, 1), at(0, 1)], 'metal', z, {
    lift: w * 0.14,
    details: [
      { k: 'line', pts: [at(0, -0.55), at(1, -0.55)] },
      { k: 'line', pts: [at(0, 0.55), at(1, 0.55)] },
      { k: 'line', pts: zig, w: 1.4 },
      { k: 'lights', pts: [at(0.04, 0), at(0.96, 0)], r: w * 0.09, tone: 'glass' },
    ],
    ...more,
  })
}

/** A habitat: a boxy crew block `w` by `h` round (x, y), panelled in a grid with a blue window in
 * each panel. */
export function habitat(id: string, x: number, y: number, w: number, h: number, z: number, more: Partial<Part> = {}): Part {
  const m = Math.min(w, h)
  const c = m * 0.16
  const cols = Math.max(2, Math.round(w / (m * 0.45)))
  const rows = Math.max(2, Math.round(h / (m * 0.45)))
  const details: Detail[] = []
  for (let i = 1; i < cols; i++) details.push({ k: 'line', pts: [[x - w / 2 + (w * i) / cols, y - h / 2], [x - w / 2 + (w * i) / cols, y + h / 2]] })
  for (let j = 1; j < rows; j++) details.push({ k: 'line', pts: [[x - w / 2, y - h / 2 + (h * j) / rows], [x + w / 2, y - h / 2 + (h * j) / rows]] })
  for (let j = 0; j < rows; j++) details.push(windows([x - w / 2 + w / cols / 2, y - h / 2 + (h * (j + 0.5)) / rows], [x + w / 2 - w / cols / 2, y - h / 2 + (h * (j + 0.5)) / rows], cols, m * 0.04))
  return part(id, chamfer(x, y, w, h, c), 'hull', z, {
    lift: m * 0.08,
    facets: [{ pts: [[x - w / 2, y - h / 2 + c], [x - w / 2 + c, y - h / 2], [x - w / 2 + c * 1.6, y - h / 2], [x - w / 2 + c * 1.6, y + h / 2], [x - w / 2 + c, y + h / 2], [x - w / 2, y + h / 2 - c]], slope: [-0.5, 0] }],
    details,
    ...more,
  })
}

/**
 * A docking module: a drum `len` long along its axis (across, or up and down when not `across`) and
 * `wid` thick, a red band round its middle, red-ringed collars at both ends with dark docking ports
 * in them, guide lights at the ports.
 */
export function dockingModule(id: string, x: number, y: number, len: number, wid: number, z: number, across = true): Part[] {
  const L = len / 2
  const W = wid / 2
  // Drawn across, then turned a quarter round its middle when it runs up and down.
  const r = (pts: Pt[]) => (across ? pts : pts.map(([px, py]) => [x + (py - y), y + (px - x)] as Pt))
  const bx = (cx: number, cy: number, w: number, h: number) => r(box(cx, cy, w, h))
  const out: Part[] = [
    part(id, r(chamfer(x, y, len * 0.72, wid, W * 0.3)), 'hull', z, {
      lift: wid * 0.08,
      details: [
        { k: 'shape', pts: bx(x, y, len * 0.12, wid), tone: 'accent' },
        { k: 'lights', pts: r([[x - L * 0.42, y - W * 0.5], [x - L * 0.22, y - W * 0.5], [x + L * 0.22, y - W * 0.5], [x + L * 0.42, y - W * 0.5], [x - L * 0.42, y + W * 0.5], [x + L * 0.42, y + W * 0.5]]), r: wid * 0.035, tone: 'glass' },
        { k: 'line', pts: r([[x - L * 0.3, y - W], [x - L * 0.3, y + W]]) },
        { k: 'line', pts: r([[x + L * 0.3, y - W], [x + L * 0.3, y + W]]) },
      ],
    }),
  ]
  for (const s of [-1, 1]) {
    const cx = x + s * L * 0.8
    const side = s < 0 ? 'L' : 'R'
    out.push(
      part(`${id}Collar${side}`, r(chamfer(cx, y, len * 0.2, wid * 0.86, wid * 0.14)), 'hull2', z + 0.1, {
        lift: wid * 0.1,
        details: [{ k: 'shape', pts: bx(cx - s * len * 0.065, y, len * 0.05, wid * 0.86), tone: 'accent' }],
      }),
      part(`${id}Port${side}`, bx(x + s * L * 0.96, y, len * 0.07, wid * 0.46), 'dark', z + 0.2, { details: [{ k: 'lights', pts: r([[x + s * L * 0.96, y - wid * 0.14], [x + s * L * 0.96, y + wid * 0.14]]), r: wid * 0.035, tone: 'glow' }] }),
    )
  }
  return out
}

/** A defense module: the round drum a turret stands on, ringed in red with four lights round it. */
export function defensePod(id: string, x: number, y: number, r: number, z: number, more: Partial<Part> = {}): Part {
  return part(id, circle(x, y, r, 24), 'hull', z, {
    lift: r * 0.12,
    details: [
      { k: 'shape', pts: circle(x, y, r * 0.93, 24), tone: 'accent' },
      { k: 'shape', pts: circle(x, y, r * 0.8, 22), tone: 'hull' },
      { k: 'line', pts: circle(x, y, r * 0.66, 20) },
      { k: 'lights', pts: [[x - r * 0.86, y], [x + r * 0.86, y], [x, y - r * 0.86], [x, y + r * 0.86]], r: r * 0.045, tone: 'glass' },
    ],
    ...more,
  })
}
