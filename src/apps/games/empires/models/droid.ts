import { circle, part, sym } from './kit.ts'
import type { ModelDef } from './spec.ts'
import type { Part, Pt } from './types.ts'

// The droid Confederacy's style kit: organic, insect-like curves instead of plates, bone-tan
// shells with violet accents, a glowing sensor eye and violet engine light. Built from arcs and
// tapering segments rather than wedges.

/**
 * A crescent: points along an elliptical arc (centre cx, cy, radii rx, ry) from angle a0 to a1, and
 * back along a thinner arc inside it, the band tapering from `t0` of the radius at the start to
 * `t1` at the end.
 */
function crescent(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number, t0: number, t1: number, n = 14): Pt[] {
  const outer: Pt[] = []
  const inner: Pt[] = []
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const a = a0 + (a1 - a0) * t
    const k = 1 - (t0 + (t1 - t0) * t)
    outer.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry])
    inner.push([cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k])
  }
  return [...outer, ...inner.reverse()]
}

const deg = (d: number) => (d * Math.PI) / 180

/**
 * Mantis droid fighter: a beaked head with one violet eye, a segmented tail and two hooked claw
 * wings that sweep forward and down. The lower claws snap off as it is shot up.
 */
export const fighter: ModelDef = () => {
  const cx = -3
  const cy = 10
  const R = 41
  const upper = crescent(cx, cy, R, R, deg(-99), deg(-172), 0.34, 0.2, 12)
  const lower = crescent(cx, cy, R, R, deg(-172), deg(-230), 0.2, 0.02, 9)
  // A joint across the claw at angle a: a dark band, as the droids' segmented limbs have.
  const joint = (a: number, k0: number, k1: number): Pt[] => {
    const at = (r: number, d: number): Pt => [cx + Math.cos(deg(a + d)) * r, cy + Math.sin(deg(a + d)) * r]
    return [at(R * 1.01, -1.6), at(R * 1.01, 1.6), at(R * k1, 1.6), at(R * k0, -1.6)]
  }
  const parts: Part[] = [
    ...sym(part('claw', upper, 'hull', 1, {
      slope: [-0.4, -0.1],
      lift: 0.8,
      details: [
        { k: 'shape', pts: crescent(cx, cy, R * 0.88, R * 0.88, deg(-108), deg(-168), 0.05, 0.05, 10), tone: 'accent' },
        { k: 'shape', pts: joint(-128, 0.7, 0.7), tone: 'dark' },
        { k: 'shape', pts: joint(-152, 0.74, 0.74), tone: 'dark' },
      ],
    }), { slope: [0.4, -0.1] }),
    ...sym(part('hook', lower, 'hull2', 1, {
      slope: [-0.4, 0.1],
      lift: 0.8,
      detach: { hull: 0.4 },
      details: [{ k: 'shape', pts: joint(-196, 0.8, 0.8), tone: 'dark' }, { k: 'shape', pts: crescent(cx, cy, R * 0.9, R * 0.9, deg(-176), deg(-212), 0.05, 0.03, 6), tone: 'accent' }],
    }), { slope: [0.4, 0.1], detach: { hull: 0.24 } }),
    // Blaster barrels at the crest of each claw.
    ...sym(part('gun', [[-28.8, -30], [-27.2, -30], [-26.4, -20], [-29.6, -21]], 'dark', 2, { detach: { death: true } })),
    // The shoulder that carries the claws, behind the head.
    ...sym(part('shoulder', [[0, -26], [-11, -30], [-14, -24], [-10, -13], [0, -11]], 'metal', 1.5, { slope: [-0.4, 0], lift: 0.6, details: [{ k: 'line', pts: [[-6, -28], [-6, -12]] }] })),
    ...sym(part('tail', [[0, -6], [-6.5, -4], [-5.2, 12], [-3.4, 26], [-2.2, 33], [0, 34]], 'hull', 2, {
      slope: [-0.5, 0],
      details: [
        { k: 'line', pts: [[0, 4], [-6, 4]] },
        { k: 'line', pts: [[0, 13], [-5.2, 13]] },
        { k: 'line', pts: [[0, 22], [-4, 22]] },
        { k: 'shape', pts: [[-1, 6], [-3, 6], [-2.6, 11], [-1, 11]], tone: 'accent' },
      ],
    })),
    ...sym(part('head', [[0, -50], [-2.6, -41], [-5.6, -28], [-8.5, -17], [-7, -8], [0, -6]], 'hull', 3, {
      slope: [-0.5, 0],
      lift: 1,
      details: [
        { k: 'line', pts: [[-2.4, -38], [-6.5, -20]] },
        { k: 'shape', pts: [[0, -47], [-1.2, -41], [-1.2, -33], [0, -32]], tone: 'hull2' },
      ],
    })),
    part('eye', circle(0, -15, 4, 16), 'glass', 4, { lift: 0.6, details: [{ k: 'lights', pts: [[0, -15]], r: 2 }] }),
    part('engine', circle(0, 33, 3.2, 12), 'dark', 3, { engine: 0, details: [{ k: 'lights', pts: [[0, 33.4]], r: 1.6 }] }),
  ]
  return { parts, breakStyle: 'bands' }
}
