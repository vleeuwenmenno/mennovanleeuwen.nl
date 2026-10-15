import { along, part, rect, thick } from '../kit.ts'
import type { Detail, Part, Pt, Tone } from '../types.ts'

// The Confederacy's style kit (refs/confederacy.webp, "Module library"): aggressive, pragmatic
// military engineering. Ships are built from functional blocks: angular armour blocks bolted onto
// gunmetal frames, an exposed spine with power conduits glowing orange, external engine nacelles
// with square cyan nozzles, side nacelles with an orange light strip, rectangular missile-cell
// arrays, and a recessed bridge core with teal windows. Silhouettes are split and forked: twin
// prongs at the bow, split hulls, booms. Lit from the top left like every model; flat cel tones,
// the depth coming from raised and recessed layers, not textures.
//
// Fine detail is painted only where it shows (level of detail, `minPx` in models/types.ts): panel
// seams from SEAM_PX device pixels along the hull, small windows and status lights from LIGHT_PX,
// recessed panels in armour blocks and missile-cell caps from PANEL_PX. So a strike craft at battle
// zoom keeps its silhouette, its orange marking and its cyan engine, and a flagship zoomed in gets
// every seam and light. Engine nozzles always glow.

/** The hull size (device pixels on its long side) from which each grade of detail is painted. */
export const SEAM_PX = 140
export const LIGHT_PX = 110
export const PANEL_PX = 80

// --- Details ----------------------------------------------------------------------------------------

/** A burnt-orange marking or capacitor inlay, shaded with its part. */
export const mark = (pts: Pt[]): Detail => ({ k: 'shape', pts, tone: 'accent' })
/** A recessed panel in near-black steel. */
export const recess = (pts: Pt[]): Detail => ({ k: 'shape', pts, tone: 'dark' })
/** A panel seam: only drawn on bitmaps big enough to show it. */
export const seam = (...pts: Pt[]): Detail => ({ k: 'line', pts, minPx: SEAM_PX })
/** Orange status lights and capacitor glows. */
export const ambers = (pts: Pt[], r: number): Detail => ({ k: 'lights', pts, r, tone: 'trim', minPx: LIGHT_PX })
/** Teal windows and sensor lights. */
export const windows = (pts: Pt[], r: number): Detail => ({ k: 'lights', pts, r, tone: 'glass', minPx: LIGHT_PX })
/** Cyan running lights, in the engine colour. */
export const lamps = (pts: Pt[], r: number): Detail => ({ k: 'lights', pts, r })

/** A seam across a part from (x0, y) to (x1, y). */
export const across = (x0: number, x1: number, y: number): Detail => seam([x0, y], [x1, y])

// --- Blocks -----------------------------------------------------------------------------------------

/** A box with its front corners cut by `cf` and its back corners by `cb`: the angular armour
 * block every Confederacy hull is built of. */
export function block(x: number, y: number, w: number, h: number, cf: number, cb = cf): Pt[] {
  const l = x - w / 2
  const r = x + w / 2
  const t = y - h / 2
  const b = y + h / 2
  return [[l + cf, t], [r - cf, t], [r, t + cf], [r, b - cb], [r - cb, b], [l + cb, b], [l, b - cb], [l, t + cf]]
}

/**
 * An armour block (module library 2): an angular plate standing proud of the frame, lit as two
 * faces down its ridge, a recessed panel in its middle and an orange band across its back edge.
 * `band` false leaves the band off; `panel` false the recess.
 */
export function armour(id: string, x: number, y: number, w: number, h: number, z: number, o: { tone?: Tone; band?: boolean; panel?: boolean; cut?: number; lift?: number } & Partial<Part> = {}): Part {
  const { tone = 'hull', band = true, panel = true, cut = Math.min(w, h) * 0.28, lift = 1, ...more } = o
  const details: Detail[] = []
  if (panel && w > 3 && h > 3) details.push({ ...recess(block(x, y - h * 0.04, w * 0.36, h * 0.46, cut * 0.3)), minPx: PANEL_PX })
  if (band) details.push(mark(rect(x - w / 2 + cut * 0.4, y + h / 2 - Math.max(0.5, h * 0.14), w - cut * 0.8, Math.max(0.5, h * 0.09))))
  details.push(seam([x - w / 2 + cut * 0.6, y - h * 0.22], [x + w / 2 - cut * 0.6, y - h * 0.22]))
  return part(id, block(x, y, w, h, cut, cut * 0.55), tone, z, {
    lift,
    facets: [{ pts: block(x - w / 4, y, w / 2, h, cut * 0.5, cut * 0.3).map(([px, py]) => [Math.min(px, x), py] as Pt), slope: [-0.5, -0.05] }],
    details,
    ...more,
  })
}

/**
 * An engine module (module library 5): a square nacelle with a deep square nozzle at its back
 * (positive y), its cyan glow in it. Carries engine glow `engine` (it goes dark when that engine
 * is shot out). An orange stripe runs down its outer side.
 */
export function engineModule(id: string, x: number, y0: number, y1: number, w: number, engine: number | undefined, z: number, more: Partial<Part> = {}): Part {
  const h = w / 2
  const l = y1 - y0
  const nz = Math.min(h * 0.62, l * 0.22)
  const details: Detail[] = [
    recess(rect(x - h * 0.72, y1 - nz * 1.9, h * 1.44, nz * 1.6)),
    mark(rect(x - h, y0 + l * 0.2, Math.max(0.5, w * 0.12), l * 0.42)),
    across(x - h, x + h, y0 + l * 0.42),
  ]
  if (engine !== undefined) details.push(lamps([[x, y1 - nz * 1.1]], nz * 0.7))
  return part(id, block(x, (y0 + y1) / 2, w, l, Math.min(h * 0.5, 1.6), Math.min(h * 0.2, 0.8)), 'hull2', z, {
    lift: 1,
    engine,
    facets: [{ pts: rect(x - h, y0, h, l), slope: [-0.5, 0] }],
    details,
    ...more,
  })
}

/**
 * A side nacelle (module library 6): a long armoured pod hung off the hull's flank, an intake
 * grille at its front, an orange light strip down its outer face. `side` -1 for the left one.
 */
export function nacelle(id: string, x: number, y0: number, y1: number, w: number, side: -1 | 1, z: number, more: Partial<Part> = {}): Part {
  const h = w / 2
  const l = y1 - y0
  const outer = x + side * h
  const strip = side < 0 ? rect(outer + w * 0.1, y0 + l * 0.22, Math.max(0.5, w * 0.13), l * 0.56) : rect(outer - w * 0.23, y0 + l * 0.22, Math.max(0.5, w * 0.13), l * 0.56)
  return part(id, block(x, (y0 + y1) / 2, w, l, h * 0.7, h * 0.3), 'hull', z, {
    lift: 1.2,
    facets: [{ pts: rect(x - h, y0, h, l), slope: [-0.5, 0] }],
    details: [
      recess(rect(x - h * 0.5, y0 + l * 0.06, w * 0.5, l * 0.1)),
      { k: 'shape', pts: strip, tone: 'trim' },
      across(x - h, x + h, y0 + l * 0.7),
    ],
    ...more,
  })
}

/**
 * A missile-cell array (module library 4): a raised gunmetal box of `cols` by `rows` cells, each
 * capped in orange, centred on (x, y), each cell `c` across.
 */
export function cells(id: string, x: number, y: number, cols: number, rows: number, c: number, z: number, more: Partial<Part> = {}): Part {
  const gap = c * 0.3
  const W = cols * c + (cols + 1) * gap
  const H = rows * c + (rows + 1) * gap
  const details: Detail[] = [recess(rect(x - W / 2 + gap * 0.5, y - H / 2 + gap * 0.5, W - gap, H - gap))]
  for (let i = 0; i < cols; i++)
    for (let j = 0; j < rows; j++) {
      const cx = x - W / 2 + gap + c / 2 + i * (c + gap)
      const cy = y - H / 2 + gap + c / 2 + j * (c + gap)
      details.push({ ...mark(rect(cx - c / 2, cy - c / 2, c, c)), minPx: PANEL_PX })
    }
  return part(id, block(x, y, W, H, gap, gap), 'hull2', z, { lift: 1.2, details, ...more })
}

/**
 * A bridge core (module library 1): a raised command block with a recessed window band across its
 * front, teal windows in it, an orange status strip under them, two antenna stubs at its back.
 */
export function bridge(id: string, x: number, y: number, w: number, h: number, z: number, more: Partial<Part> = {}): Part {
  const n = Math.max(2, Math.round(w / 2.4))
  return part(id, block(x, y, w, h, w * 0.18, w * 0.08), 'hull', z, {
    lift: 1.6,
    facets: [{ pts: rect(x - w / 2, y - h / 2, w / 2, h), slope: [-0.5, 0] }, { pts: rect(x - w / 2 + w * 0.18, y - h / 2, w * 0.64, h * 0.2), slope: [0, -0.5] }],
    details: [
      recess(rect(x - w * 0.38, y - h * 0.18, w * 0.76, h * 0.22)),
      windows(along([x - w * 0.3, y - h * 0.07], [x + w * 0.3, y - h * 0.07], n), Math.min(0.5, h * 0.05)),
      mark(rect(x - w * 0.3, y + h * 0.16, w * 0.6, Math.max(0.4, h * 0.08))),
      recess(rect(x - w * 0.36, y + h * 0.3, w * 0.12, h * 0.14)),
      recess(rect(x + w * 0.24, y + h * 0.3, w * 0.12, h * 0.14)),
    ],
    ...more,
  })
}

/**
 * An exposed spine (module library: "reinforced central structural spine"): a dark structural
 * keel from y0 to y1, `w` wide, ribbed across, with power conduits glowing orange down it.
 */
export function spine(id: string, x: number, y0: number, y1: number, w: number, z: number, more: Partial<Part> = {}): Part {
  const n = Math.max(3, Math.round((y1 - y0) / 6))
  return part(id, rect(x - w / 2, y0, w, y1 - y0), 'metal', z, {
    lift: 0.6,
    details: [
      ...along([x, y0 + 2], [x, y1 - 2], n).map(([, y]) => across(x - w / 2, x + w / 2, y)),
      { k: 'shape', pts: rect(x - w * 0.12, y0 + 1.5, w * 0.24, y1 - y0 - 3), tone: 'trim' },
    ],
    ...more,
  })
}

/** A sensor or comms mast: a thin dark spar with a teal tip light. */
export const antenna = (id: string, a: Pt, b: Pt, w: number, z: number, more: Partial<Part> = {}): Part =>
  part(id, thick([a, b], w, w * 0.5), 'metal', z, { lift: 1.2, details: [windows([b], w * 0.5)], ...more })
