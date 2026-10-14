import type { ModuleId, UnitType } from '../data.ts'
import { mirror, move, part, rect, turnPart } from './kit.ts'
import type { Detail, Part, Pt } from './types.ts'

// Expansion modules (hybrid bases) on a Command Station or a yard: where each goes and how it is
// tied to the building, for every faction. What a module looks like is its faction's own (the
// `expansion` in models/<faction>/base.ts).

/** A grid point (0-10, as hardpoints) on a model box w x h. */
export const at = (g: [number, number], w: number, h: number): Pt => [(g[0] / 10 - 0.5) * w, (g[1] / 10 - 0.5) * h]

/**
 * A faction's expansion modules: `pod` is one module's own structure in its local frame (up, -y,
 * away from the building, +x towards the yard's bow, the socket at the origin; `R` its size, half
 * its socket's share of the building; kept within about 1.2 R outward, so it stays inside the
 * building's bitmap), and `strut` the details on the girder that ties it to the hull, `reach` long.
 */
export type Expansion = { pod: (exp: ModuleId, R: number) => Part[]; strut: (R: number, reach: number) => Detail[] }

/**
 * The expansions on a unit (its hardpoints with `exp`), as parts of its structure: each a module of
 * its own shape bolted onto its socket (a berth arm, a repair gantry, a plate press, a hangar, a
 * sensor mast, a shield dome, a launch rack), tied to the hull by a girder, in the faction's
 * colours. Every part of one comes off when its hardpoint is shot off, so a lost module is plain to
 * see: a burnt stump stays on its socket (the hardpoint's mount, see buildModel). On a yard a module
 * lies along the side it is on, square to the hull, its mouth (if it has one) towards the yard's;
 * on the Command Station it reaches out from the corner on a long girder. Drawn on the unit's box in
 * model units (a station's on its frame pixels).
 */
export function expansionParts(t: UnitType, w: number, h: number, kit: Expansion): Part[] {
  const out: Part[] = []
  const long = Math.max(w, h)
  const station = t.tier === 'station'
  t.hardpoints.forEach((hp, i) => {
    if (!hp.exp) return
    const [x, y] = at([hp.x, hp.y], w, h)
    const R = ((hp.s ?? 0.1) * long) / 2
    const dist = Math.hypot(x, y) || 1
    // Drawn facing up (-y), turned so up points away from the middle of the building: on a yard
    // square to its side; drawn with its front (+x) towards the yard's bow, mirrored where turning
    // would point it the other way.
    const out0 = Math.atan2(y, x)
    const turnTo = (station ? out0 : Math.round(out0 / (Math.PI / 2)) * (Math.PI / 2)) + Math.PI / 2
    const flip = Math.sin(turnTo) > 1e-6
    const place = (p: Part): Part => {
      const q = turnPart(flip ? mirror(p, p.id) : p, turnTo)
      return { ...q, pts: move(q.pts, x, y), holes: q.holes?.map((hh) => move(hh, x, y)), facets: q.facets?.map((f) => ({ ...f, pts: move(f.pts, x, y) })), details: q.details?.map((d) => ({ ...d, pts: move(d.pts, x, y) })) }
    }
    const off = { detach: { hp: i } }
    const id = (s: string) => `${s}${hp.exp}`
    // The girder back to the hull: a long one across a station's open corner, a short one on a yard.
    const reach = station ? dist * 0.5 : R * 0.9
    const strut = part(id('strut'), rect(-R * 0.24, R * 0.2, R * 0.48, reach), 'metal', 7.4, {
      lift: 1.4,
      scar: false,
      ...off,
      details: [{ k: 'line', pts: [[0, R * 0.25], [0, R * 0.2 + reach]] }, ...kit.strut(R, reach)],
    })
    out.push(place(strut), ...kit.pod(hp.exp, R).map((p) => place({ ...p, id: id(p.id), z: 7.6 + (p.z - 1) * 0.1, scar: false, ...off })))
  })
  return out
}
