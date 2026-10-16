import { along, box, capsule, circle, ngon, part, rimFacets, sym, treads } from '../kit.ts'
import type { GroundModels } from '../ground.ts'
import type { Pt } from '../types.ts'

// The Confederacy's ground units, seen from straight above, light from the top left, in the space
// fleet's steel, gunmetal and burnt orange (plan D10: one look across modes). The Command Hub is an
// eight-sided industrial deck round a sphere core, as its space station is, with antenna spires, a
// cargo crane and its door to the south; the Forger builder droid hovers (its shadow falls further
// off) on a round body with two cutting arms and a rack of plates.

const OCT = Math.PI / 8

export const GROUND: GroundModels = {
  'd-g-center': {
    w: 100,
    h: 100,
    spec: () => {
      const rim = ngon(0, 0, 50, 8, OCT)
      return {
        breakStyle: 'ring',
        core: { x: 0, y: -2, r: 19 },
        parts: [
          // The deck's sloped rim, each of its eight sides lit for the way it faces.
          part('deck', rim, 'hull2', 1, { lift: 3, facets: rimFacets(rim, 0, 0, 0.86) }),
          // The deck plating, with panel lines and orange hazard markings on the diagonals.
          part('plates', ngon(0, 0, 43, 8, OCT), 'hull', 2, {
            lift: 1,
            details: [
              ...[0, 1, 2, 3].map((i) => ({ k: 'line' as const, pts: [ngon(0, 0, 43, 8, OCT + (i * Math.PI) / 4)[0], ngon(0, 0, 43, 8, OCT + (i * Math.PI) / 4)[4]], minPx: 60 })),
              ...[1, 3, 5, 7].map((i) => {
                const a = (i * Math.PI) / 4
                const c: Pt = [Math.cos(a) * 36, Math.sin(a) * 36]
                return { k: 'shape' as const, pts: ngon(c[0], c[1], 5, 4, a), tone: 'accent' as const }
              }),
              { k: 'lights', pts: ngon(0, 0, 40, 8, 0), r: 1.4, tone: 'glass', minPx: 60 },
            ],
          }),
          // The collar round the core and the core itself, a steel sphere with a teal sensor band.
          part('collar', circle(0, -2, 25, 24), 'metal', 3, { lift: 4, details: [{ k: 'line', pts: circle(0, -2, 22, 24) }] }),
          part('core', circle(0, -2, 19, 28), 'hull', 4, {
            lift: 12,
            sphere: true,
            details: [
              { k: 'line', pts: Array.from({ length: 13 }, (_, i) => [-19 + (38 * i) / 12, -2 + Math.sin((i / 12) * Math.PI) * 4] as Pt) },
              { k: 'lights', pts: [[-9, 2], [0, 4], [9, 2]], r: 1.6, tone: 'glass' },
              { k: 'shape', pts: box(0, -12, 10, 3), tone: 'accent' },
            ],
          }),
          // Antenna spires on the two north corners and the south-west one.
          ...sym(part('spire', capsule([-27, -27], [-34, -36], 2.6, 1.2), 'metal', 5, { lift: 18, details: [{ k: 'lights', pts: [[-34, -36]], r: 1.3, tone: 'trim' }] })),
          part('spireS', capsule([-27, 27], [-33, 34], 2.2, 1), 'metal', 5, { lift: 14 }),
          // The cargo crane on the east side, its jib over the deck, with a crate on the hook.
          part('craneBase', box(35, 12, 10, 18), 'metal', 3, { lift: 6, details: treads(31, 39, 4, 20, 3) }),
          part('jib', capsule([35, 6], [22, 28], 2.2, 1.6), 'hull2', 6, { lift: 16, details: [{ k: 'shape', pts: box(28, 18, 4, 3), tone: 'accent' }] }),
          part('crate', box(20, 31, 8, 7), 'accent', 3, { lift: 3, details: [{ k: 'line', pts: [[16, 31], [24, 31]] }] }),
          // The door on the south side, under its orange guide lights.
          part('door', box(0, 42, 24, 7), 'dark', 3, {
            lift: 1,
            details: [
              { k: 'line', pts: [[0, 39], [0, 45]] },
              { k: 'lights', pts: along([-10, 37], [10, 37], 4), r: 1.2, tone: 'trim' },
            ],
          }),
        ],
      }
    },
  },
  'd-g-engineer': {
    w: 84,
    h: 100,
    spec: () => ({
      breakStyle: 'bands',
      parts: [
        // Cutting arms, upper and fore, with glowing cutters at their tips.
        ...sym(part('armUpper', capsule([-16, -4], [-32, -26], 4, 3), 'metal', 1, { lift: 12 })),
        ...sym(part('armFore', capsule([-32, -26], [-22, -44], 3, 2), 'metal', 2, { lift: 12, details: [{ k: 'shape', pts: box(-28, -35, 3, 3), tone: 'accent' }] })),
        ...sym(part('cutter', [[-24, -44], [-18, -50], [-20, -42]] as Pt[], 'trim', 3, { lift: 12, glow: true })),
        // The plate rack slung behind the body.
        part('rack', box(0, 30, 32, 16), 'hull2', 2, {
          lift: 10,
          details: [...treads(-15, 15, 22, 38, 4), { k: 'shape', pts: box(0, 30, 32, 3), tone: 'accent' }],
        }),
        // Side thrusters that keep it up, their glow on the ground side.
        ...sym(part('thruster', circle(-25, 12, 7, 14), 'dark', 2, { lift: 12, details: [{ k: 'lights', pts: [[-25, 12]], r: 3, tone: 'glow' }] })),
        // The body: a round steel shell with orange markings and a teal sensor eye.
        part('body', circle(0, 4, 25, 28, 26), 'hull', 4, {
          lift: 14,
          sphere: true,
          details: [
            { k: 'line', pts: circle(0, 4, 18, 24, 19), minPx: 50 },
            { k: 'shape', pts: box(0, 18, 20, 4), tone: 'accent' },
          ],
        }),
        part('eye', circle(0, -14, 6, 14), 'glass', 5, { lift: 15, details: [{ k: 'lights', pts: [[0, -14]], r: 2.2, tone: 'glow' }] }),
        part('aerial', capsule([10, -8], [16, -22], 1.1, 0.8), 'metal', 5, { lift: 16 }),
      ],
    }),
  },
}
