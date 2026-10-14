import { box, chamfer, circle, part, rounded, sym, turn } from '../kit.ts'
import type { MountLook } from '../mounts.ts'
import type { Part, Pt } from '../types.ts'

// The Swarm's mounts: rounder and plainer than the others' (for now its concept's). What sits on a
// hardpoint, drawn on a mount of radius 1 with its guns pointing up (negative y), then scaled to
// the hardpoint's size (models/mounts.ts builds and caches them). Each design has a broken version:
// guns stripped and bent, plating burnt black with embers in the cracks, for a module that was shot
// up but stays on the hull; and a burnt socket ('crater') for one that was blown clean off.

/** Ember glints in a broken module's cracks: a part with no body of its own, only its lights. */
const embers = (pts: Pt[]): Part => part('embers', [], 'ember', 9, { glow: true, noOutline: true, details: [{ k: 'lights', pts, r: 0.07, tone: 'ember' }] })

export function build(design: MountLook, broken: boolean): Part[] {
  // `round`: the Swarm's rounder, plainer look; `boxed`: the droid navy's box turret, gunmetal under
  // sand with red lights; neither: the Republic's plated look banded in red. (The three were drawn
  // by one function once; each faction's copy keeps its own look switched on.)
  const round: boolean = true
  const boxed: boolean = false
  const plate = round ? circle(0, 0, 1, 20) : chamfer(0, 0, 2, 2, 0.55)
  switch (design) {
    case 'crater':
      return [
        part('scar', circle(0, 0, 0.95, 11).map(([x, y], i) => [x * (i % 2 ? 0.86 : 1), y * (i % 2 ? 0.86 : 1)] as Pt), 'char', 0, { noOutline: true }),
        part('pit', circle(0.05, 0.05, 0.55, 9), 'dark', 1, { noOutline: true }),
        embers([[-0.3, -0.25], [0.4, 0.1], [-0.1, 0.45], [0.2, -0.45]]),
      ]
    case 'flak': {
      if (broken)
        return [
          part('base', circle(0, 0, 1), 'char', 0, { lift: 0.08 }),
          part('housing', circle(0.05, 0.1, 0.6, 10), 'dark', 1, { details: [{ k: 'line', pts: [[-0.4, -0.2], [0, 0.1], [0.3, 0.45]] }] }),
          part('stub1', turn(box(-0.25, -0.55, 0.15, 0.55), 0.5, -0.25, -0.3), 'metal', 2),
          part('stub2', turn(box(0.3, -0.5, 0.15, 0.35), -0.3, 0.3, -0.3), 'metal', 2),
          embers([[-0.5, 0.3], [0.45, 0.4], [0.1, -0.1], [-0.2, 0.6]]),
        ]
      const barrels: Part[] = []
      for (const x of [-0.42, -0.15, 0.15, 0.42]) {
        barrels.push(part(`barrel${x}`, box(x, -0.62, 0.15, 0.95), 'dark', 3))
        barrels.push(part(`tip${x}`, box(x, -1.06, 0.2, 0.16), 'metal', 4))
      }
      return [
        part('base', round ? circle(0, 0, 1) : plate, round ? 'hull2' : boxed ? 'metal' : 'hull', 0, {
          lift: 0.1,
          details: round ? [{ k: 'shape', pts: circle(0, 0.62, 0.22, 10), tone: 'accent' }] : [{ k: 'shape', pts: box(0, 0.72, 0.5, 0.3), tone: 'accent' }, { k: 'line', pts: circle(0, 0, 0.8, 16) }],
        }),
        part('housing', round ? circle(0, 0.08, 0.6, 16) : chamfer(0, 0.05, 1.15, 1.05, 0.3), round || boxed ? 'hull' : 'hull2', 1, {
          lift: 0.12,
          details: round ? [] : [{ k: 'shape', pts: box(0, 0.05, 0.22, 0.75), tone: 'accent' }],
        }),
        ...barrels,
      ]
    }
    case 'turbo':
    case 'ion': {
      if (broken)
        return [
          part('base', circle(0, 0, 1), 'char', 0, { lift: 0.08 }),
          part('housing', rounded(0, 0.15, 1.1, 0.95, 0.2), 'dark', 1, { details: [{ k: 'line', pts: [[-0.45, -0.1], [0.05, 0.25], [0.4, 0.05]] }] }),
          part('barrel', turn(box(-0.22, -0.55, 0.2, 0.9), 0.35, -0.22, -0.1), 'metal', 2),
          embers([[-0.4, 0.4], [0.35, 0.35], [0.05, -0.05], [0.5, -0.2]]),
        ]
      if (design === 'ion')
        return [
          part('base', circle(0, 0, 1), 'hull2', 0, { lift: 0.1 }),
          part('coil', circle(0, 0.05, 0.72, 18), 'hull', 1, { lift: 0.1, details: [{ k: 'line', pts: circle(0, 0.05, 0.5, 14) }] }),
          part('barrel', box(0, -0.6, 0.42, 1.0), 'dark', 2, { details: [{ k: 'shape', pts: box(0, -0.6, 0.16, 0.8), tone: 'glow' }] }),
          part('eye', circle(0, 0.1, 0.24, 12), 'glass', 3, { details: [{ k: 'lights', pts: [[0, 0.1]], r: 0.1 }] }),
        ]
      return [
        part('base', round ? circle(0, 0, 1) : plate, round ? 'hull2' : boxed ? 'metal' : 'hull', 0, {
          lift: 0.1,
          details: [{ k: 'line', pts: circle(0, 0, 0.82, 16) }, ...(round ? [] : [{ k: 'lights' as const, pts: [[-0.62, 0.55], [0.62, 0.55], [-0.75, 0.1], [0.75, 0.1]] as Pt[], r: 0.06, tone: boxed ? ('glass' as const) : undefined }])],
        }),
        part('housing', rounded(0, 0.18, 1.15, 1.05, 0.22), round || boxed ? 'hull' : 'hull2', 1, {
          lift: 0.14,
          details: round ? [{ k: 'shape', pts: circle(0, 0.3, 0.18, 10), tone: 'accent' }] : [{ k: 'shape', pts: box(-0.28, 0.2, 0.2, 0.85), tone: 'accent' }, { k: 'shape', pts: box(0.28, 0.2, 0.2, 0.85), tone: 'accent' }],
        }),
        ...sym(part('barrel', box(-0.22, -0.58, 0.17, 1.05), 'dark', 2)),
        ...sym(part('muzzle', box(-0.22, -1.12, 0.22, 0.14), 'metal', 3)),
      ]
    }
    case 'shield':
      if (broken)
        return [
          part('ball', circle(0, 0, 0.95, 22), 'char', 0, { sphere: true, details: [{ k: 'shape', pts: [[-0.6, -0.5], [-0.1, -0.2], [0.2, -0.7], [0.5, -0.1], [0.1, 0.3], [-0.3, 0.1]], tone: 'dark' }] }),
          embers([[-0.2, -0.3], [0.3, -0.35], [0.05, 0.15], [-0.45, 0.25], [0.5, 0.3]]),
        ]
      return [
        part('ball', circle(0, 0, 0.95, 22), boxed ? 'hull2' : 'hull', 0, {
          sphere: true,
          details: [
            { k: 'shape', pts: box(0, 0.02, 2, 0.24), tone: 'accent' },
            { k: 'lights', pts: [-0.6, -0.36, -0.12, 0.12, 0.36, 0.6].map((x) => [x, 0.2] as Pt), r: 0.06 },
            { k: 'shape', pts: box(0, -0.64, 0.34, 0.2), tone: 'dark' },
            { k: 'shape', pts: box(0, 0.66, 0.34, 0.2), tone: 'dark' },
          ],
        }),
      ]
    case 'hangar':
      return [
        part('frame', chamfer(0, 0, 1.8, 1.35, 0.3), broken ? 'char' : 'hull', 0, { lift: 0.08, details: broken ? [] : [{ k: 'shape', pts: box(0, -0.57, 1.2, 0.16), tone: 'accent' }] }),
        part('bay', box(0, 0.08, 1.3, 0.78), 'dark', 1, {
          details: broken ? [{ k: 'line', pts: [[-0.5, -0.2], [0.1, 0.2], [0.5, -0.1]] }] : [{ k: 'line', pts: [[0, -0.3], [0, 0.46]] }, { k: 'lights', pts: [-0.52, -0.26, 0, 0.26, 0.52].map((x) => [x, 0.42] as Pt), r: 0.05 }],
        }),
        ...(broken ? [embers([[-0.4, 0.1], [0.3, 0.25], [0.6, -0.4]])] : []),
      ]
    case 'sensor':
      return [
        part('dish', circle(0, 0, 0.95, 20), broken ? 'char' : 'hull2', 0, { lift: 0.1, details: [{ k: 'line', pts: circle(0, 0, 0.66, 16) }] }),
        part('bowl', circle(0, 0, 0.62, 18), broken ? 'dark' : 'metal', 1, { slope: [0.4, 0.4] }),
        ...(broken
          ? [embers([[-0.3, 0.2], [0.35, -0.2], [0.1, 0.4]])]
          : [part('feed', circle(0, 0, 0.18, 10), 'dark', 2, { lift: 0.25 }), part('struts', [[-0.03, -0.6], [0.03, -0.6], [0.03, 0], [-0.03, 0]], 'dark', 2, { noOutline: true }), part('beacon', circle(0, 0, 0.08, 6), 'accent', 3, { glow: true, noOutline: true })]),
      ]
    case 'refinery':
      return [
        part('deck', chamfer(0, 0, 1.8, 1.6, 0.35), broken ? 'char' : 'metal', 0, { lift: 0.06 }),
        ...sym(part('tank', rounded(-0.42, 0, 0.66, 1.3, 0.3), broken ? 'dark' : 'hull', 1, { lift: 0.2, details: broken ? [] : [{ k: 'shape', pts: box(-0.42, -0.15, 0.66, 0.16), tone: 'accent' }] })),
        part('pipe', box(0, 0.1, 0.4, 0.18), 'dark', 2),
        ...(broken ? [embers([[-0.4, 0.3], [0.45, -0.2]])] : []),
      ]
    case 'dock':
      return [
        part('pad', box(0, 0.1, 1.5, 1.2), broken ? 'char' : 'dark', 0, { details: broken ? [] : [{ k: 'lights', pts: [[-0.6, 0.6], [0.6, 0.6], [-0.6, -0.4], [0.6, -0.4]], r: 0.06 }] }),
        ...sym(part('arm', [[-0.95, -0.85], [-0.6, -0.85], [-0.6, 0.85], [-0.95, 0.65]], broken ? 'dark' : 'hull', 1, { lift: 0.15, slope: [-0.3, 0] })),
        part('crane', box(0, -0.7, 1.3, 0.22), broken ? 'dark' : 'metal', 2, { lift: 0.2, details: broken ? [] : [{ k: 'shape', pts: box(0, -0.7, 0.3, 0.22), tone: 'accent' }] }),
        ...(broken ? [embers([[0, 0], [0.4, 0.3]])] : []),
      ]
    case 'drill':
      return [
        part('well', circle(0, 0, 0.95, 16), broken ? 'char' : 'dark', 0, {}),
        part('bit', circle(0, 0, 0.55, 8), broken ? 'dark' : 'metal', 1, { lift: 0.2, details: broken ? [] : [{ k: 'shape', pts: box(0, 0, 0.9, 0.16), tone: 'accent' }] }),
      ]
    case 'collar':
      // An expansion module's socket: the module itself is parts of the hull (base.ts), so nothing
      // shows here until it is shot off, and then a torn, burnt stump with embers in it.
      if (!broken) return []
      return [
        part('stump', circle(0, 0, 0.42, 10).map(([x, y], i) => [x * (i % 2 ? 0.8 : 1), y * (i % 2 ? 0.8 : 1)] as Pt), 'char', 0, { lift: 0.06 }),
        part('pit', circle(0.03, 0.04, 0.24, 9), 'dark', 1, { noOutline: true }),
        part('spar', turn(box(0.18, -0.3, 0.1, 0.36), 0.6, 0.18, -0.15), 'metal', 2),
        embers([[-0.2, -0.12], [0.22, 0.1], [-0.06, 0.24]]),
      ]
    case 'engine':
      return []
  }
}
