import { circle, part, spline } from './kit.ts'
import type { GroundModel } from './ground.ts'
import type { Part, Pt, Tone } from './types.ts'

// Kyber crystal clusters, the ground battle's one resource, in the parts-and-vectors style of the
// units: orange and dark-orange shards leaning out of a dark rock base, seen from straight above,
// each crystal cut into facets (its two long sides and its cap) that the cel shading lights or shades (light
// from the top left), with a bold outline and a glowing heart. A few shapes, so a field of them
// doesn't repeat. Painted in the Confederacy's palette, whose accent, trim and ember roles are the
// burnt oranges the crystals are (models/droid/palette.ts); they belong to nobody.

/** A crystal from (x, y) leaning out towards angle `a` (radians, 0 = right, y down), seen from above
 * as a long six-sided prism: `len` long, `wid` wide across. Three facets: its two long sides, each lit
 * or shaded for the way it faces, and the cap at its point, facing the way it leans. */
function shard(id: string, x: number, y: number, len: number, wid: number, a: number, tone: Tone, z: number): Part {
  const dx = Math.cos(a)
  const dy = Math.sin(a)
  const px = -dy
  const py = dx
  const at = (t: number, s: number): Pt => [x + dx * len * t + px * wid * s, y + dy * len * t + py * wid * s]
  const base = at(-0.12, 0)
  const tip = at(1, 0)
  const neck = at(0.78, 0)
  const outline = [base, at(0, 0.55), at(0.22, 1), at(0.78, 0.9), tip, at(0.78, -0.9), at(0.22, -1), at(0, -0.55)]
  return part(id, outline, tone, z, {
    lift: 5 + len * 0.16,
    facets: [
      { pts: [base, at(0, 0.55), at(0.22, 1), at(0.78, 0.9), neck], slope: [px * 0.85, py * 0.85] },
      { pts: [base, neck, at(0.78, -0.9), at(0.22, -1), at(0, -0.55)], slope: [-px * 0.85, -py * 0.85] },
      { pts: [at(0.78, 0.9), tip, at(0.78, -0.9), neck], slope: [dx * 0.9, dy * 0.9] },
    ],
    details: [{ k: 'line', pts: [base, neck], w: 0.6, minPx: 40 }],
  })
}

/** A cluster: shards (x, y, length, width, angle in degrees, tone) round a rock base and a glow. */
function cluster(base: Pt[], shards: [number, number, number, number, number, Tone][], glow: Pt): GroundModel {
  return {
    w: 100,
    h: 100,
    spec: () => ({
      breakStyle: 'pie',
      parts: [
        part('rock', spline(base, 3, true), 'hull2', 1, { lift: 2 }),
        ...shards.map(([x, y, len, wid, deg, tone], i) => {
          const a = (deg * Math.PI) / 180
          return shard(`shard${i}`, x, y, len, wid, a, tone, 2 + (Math.sin(a) + 1) + i * 0.01)
        }),
        part('heart', circle(glow[0], glow[1], 7, 14), 'ember', 6, { glow: true, noOutline: true }),
      ],
    }),
  }
}

/** The shapes, by number (World `crystals` shape). Crystals lean every way, most of them back (up the
 * screen), the bright ember and trim ones catching the light. */
export const KYBER: GroundModel[] = [
  // A crown of five round one heart.
  cluster(
    [[-28, 8], [-16, -10], [6, -14], [26, 0], [22, 20], [-2, 26], [-24, 22]],
    [
      [0, 8, 44, 12, -95, 'ember'],
      [4, 8, 34, 11, -40, 'trim'],
      [-4, 8, 34, 11, -145, 'accent'],
      [4, 10, 24, 9, 20, 'accent'],
      [-4, 10, 22, 9, 165, 'trim'],
    ],
    [0, 8],
  ),
  // One tall crystal leaning back, smaller ones round its foot.
  cluster(
    [[-24, 12], [-18, -8], [4, -14], [24, -2], [24, 20], [0, 28], [-20, 24]],
    [
      [-2, 12, 50, 14, -82, 'trim'],
      [6, 12, 30, 10, -25, 'ember'],
      [-8, 12, 28, 10, -135, 'ember'],
      [4, 14, 20, 8, 45, 'accent'],
      [-6, 14, 18, 7, 140, 'accent'],
    ],
    [-1, 12],
  ),
  // Two clumps side by side.
  cluster(
    [[-34, 8], [-26, -10], [-4, -6], [12, -10], [34, 6], [28, 24], [2, 22], [-22, 26]],
    [
      [-14, 10, 38, 12, -105, 'ember'],
      [-14, 10, 26, 10, -45, 'accent'],
      [-14, 12, 22, 9, -165, 'trim'],
      [14, 12, 34, 11, -72, 'trim'],
      [14, 12, 24, 9, -10, 'ember'],
      [14, 14, 18, 8, 135, 'accent'],
    ],
    [0, 10],
  ),
]
