import { area, along, box, circle, part } from './kit.ts'
import type { BuildCtx, ModelSpec } from './spec.ts'
import type { Detail, Part, Pt, Tone } from './types.ts'

// What the warships drawn at their size (sizes.ts) are built with, for every faction: hull plates
// along an edge, turret seats on the hardpoints (each faction's own look), and `calm`, which quietens
// a small ship's design for its bigger size. Shared by every faction's warships (models/<faction>/
// warships.ts); a faction that wants a plate or a seat of another kind makes its own there.

/** Half-width of a hull at `y`, from its (y, half-width) rows. */
export function widthAt(rows: [number, number][], y: number) {
  if (y <= rows[0][0]) return rows[0][1]
  for (let i = 1; i < rows.length; i++) {
    const [y0, w0] = rows[i - 1]
    const [y1, w1] = rows[i]
    if (y <= y1) return w0 + ((w1 - w0) * (y - y0)) / (y1 - y0)
  }
  return rows[rows.length - 1][1]
}

/** A point `d` in from the left edge of a hull at `y`. */
export const edgeAt = (rows: [number, number][], y: number, d: number): Pt => [-(widthAt(rows, y) - d), y]

/** A long armour plate on the left side of a hull, laid along its edge between `in0` and `in1` in
 * from it, from y0 to y1: one seam across the middle and a pair of running lights. */
export function plate(id: string, rows: [number, number][], y0: number, y1: number, in0: number, in1: number, z: number, more: Partial<Part> = {}): Part {
  const e = (y: number, d: number) => edgeAt(rows, y, d)
  const pts: Pt[] = [e(y0, in0), e(y0 + 0.8, in1), e(y1 - 0.8, in1), e(y1, in0)]
  const mid = (y0 + y1) / 2
  const c = (in0 + in1) / 2
  return part(id, pts, 'hull2', z, {
    slope: [-0.55, 0.05],
    lift: 0.7,
    details: [
      { k: 'line', pts: [e(mid, in0 + 0.6), e(mid, in1 - 0.4)] },
      { k: 'lights', pts: [e(y0 + 2, c), e(y1 - 2, c)], r: 0.3, tone: 'dark' },
    ],
    ...more,
  })
}

/** A panel line following the left edge of a hull `d` in from it, from y0 to y1. */
export const edgeLine = (rows: [number, number][], y0: number, y1: number, d: number): Detail => ({ k: 'line', pts: along([0, y0], [0, y1], 6).map(([, y]) => edgeAt(rows, y, d)) })

/** Where hardpoint `i` sits in model units. */
export const hpAt = (c: BuildCtx, i: number): Pt => [(c.t.hardpoints[i].x / 10 - 0.5) * c.w, (c.t.hardpoints[i].y / 10 - 0.5) * c.h]

/** How a faction's turret seats look: the pad under a light gun, the barbette under a heavy one,
 * and the band across a barbette's back. */
export type SeatLook = { pad: Tone; heavy: Tone; band: Tone }
export const REPUBLIC_SEAT: SeatLook = { pad: 'hull2', heavy: 'metal', band: 'accent' }

/** A turret's seat: a raised round pad (a barbette for a heavy gun) under hardpoint `i`, a little
 * wider than the turret, with a ring scribed round it. */
export function seat(id: string, c: BuildCtx, i: number, r: number, z: number, heavy: boolean, look: SeatLook = REPUBLIC_SEAT): Part {
  const [x, y] = hpAt(c, i)
  return part(id, circle(x, y, r, heavy ? 20 : 16), heavy ? look.heavy : look.pad, z, {
    lift: heavy ? 0.9 : 0.5,
    details: [{ k: 'line', pts: [...circle(x, y, r * 0.86, 18), circle(x, y, r * 0.86, 18)[0]] }, ...(heavy ? [{ k: 'shape' as const, pts: box(x, y + r * 0.78, r * 0.9, r * 0.22), tone: look.band }] : [])],
  })
}

/**
 * Quietens a design for its Big size: rows of lights thinned (at most about `lights` a row), and
 * small greebles (dark or metal patches under `greeble` square units) left out. For the small ships
 * that are only a little bigger than written: their shape stays, their surface calms down.
 */
export function calm(spec: ModelSpec, lights = 4, greeble = 6): ModelSpec {
  const quiet = (d: Detail): Detail | null => {
    if (d.k === 'lights' && d.pts.length > lights) {
      const step = Math.ceil(d.pts.length / lights)
      return { ...d, pts: d.pts.filter((_, i) => i % step === 0) }
    }
    if (d.k === 'shape' && (d.tone === 'dark' || d.tone === 'metal') && Math.abs(area(d.pts)) < greeble) return null
    return d
  }
  return { ...spec, parts: spec.parts.map((p) => (p.details ? { ...p, details: p.details.map(quiet).filter((d): d is Detail => !!d) } : p)) }
}
