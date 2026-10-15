import { box, chamfer, circle, part, rounded, sym, turn } from '../kit.ts'
import type { MountLook } from '../mounts.ts'
import type { Detail, Part, Pt } from '../types.ts'

// The Republic's mounts, after the "Turret & module studies" on its reference sheet: off-white
// armoured housings on round or octagonal grey rings, dark graphite barrels, a red stripe down the
// middle. What sits on a hardpoint is drawn on a mount of radius 1 with its guns pointing up
// (negative y), then scaled to the hardpoint's size (models/mounts.ts builds and caches them).
//
// Every weapon reads differently at a glance: the flak turret has tall slim twin barrels on a round
// ring, the turbolaser heavier and shorter twin barrels on a broader housing, the heavy capital
// turbolaser a great armoured housing with banded barrels and muzzle brakes, point defence short
// stubby barrels on an octagonal ring, and the torpedo launcher a boxy rack of four tubes with red
// warhead caps. The shield generator is a white dome banded in red with a small blue light; engine
// pods are parts of the hull (an engine hardpoint has no mount of its own).
//
// Each design has a broken version: guns stripped and bent, plating burnt black with embers in the
// cracks, for a module that was shot up but stays on the hull; and a burnt socket ('crater') for one
// that was blown clean off.
//
// The designs are looked up by name, so a design id the shared MountDesign doesn't have yet ('pd',
// 'heavy', 'torpedo') is drawn as soon as a hardpoint asks for it. Until then the torpedo launcher
// stands in for 'ion' (no Republic ship carries an ion cannon), and the other two wait.

/** Ember glints in a broken module's cracks: a part with no body of its own, only its lights. */
const embers = (pts: Pt[]): Part => part('embers', [], 'ember', 9, { glow: true, noOutline: true, details: [{ k: 'lights', pts, r: 0.07, tone: 'ember' }] })

/** An octagon of half-width `r` round (x, y), flat side up: point defence and torpedo rings. */
const octagon = (x: number, y: number, r: number): Pt[] => chamfer(x, y, r * 2, r * 2, r * 0.58)

/** The grey ring every Republic turret turns on: a raised rim with a scribed groove, two small
 * blue status lights on its rear quarter. Round, or octagonal for point defence. */
function ring(round = true): Part {
  return part('ring', round ? circle(0, 0, 1, 24) : octagon(0, 0, 1), 'metal', 0, {
    lift: 0.1,
    details: [{ k: 'line', pts: round ? circle(0, 0, 0.88, 22) : octagon(0, 0, 0.88) }, { k: 'lights', pts: [[-0.56, 0.68], [0.56, 0.68]], r: 0.055, tone: 'glass' }],
  })
}

/** The off-white turntable inside the ring, a red stripe running back from the guns. */
function deck(round = true, stripe = 0.22): Part {
  return part('deck', round ? circle(0, 0, 0.84, 22) : octagon(0, 0, 0.84), 'hull', 0.5, {
    details: [{ k: 'shape', pts: box(0, 0.42, stripe, 0.8), tone: 'accent' }],
  })
}

/** A pair of barrels, `w` thick, from the housing at `y0` forward to `y1`, `gap` apart, each with a
 * metal muzzle collar; `band`: a red band round them a little behind the muzzle (the heavy guns). */
function barrels(gap: number, w: number, y0: number, y1: number, band = false): Part[] {
  const len = y0 - y1
  const out: Part[] = [
    ...sym(part('barrel', box(-gap / 2, (y0 + y1) / 2, w, len), 'dark', 3, { details: [{ k: 'line', pts: [[-gap / 2, y0 - len * 0.1], [-gap / 2, y1 + len * 0.12]], w: 0.6 }] })),
    ...sym(part('muzzle', box(-gap / 2, y1 + w * 0.35, w * 1.3, w * 0.7), 'metal', 3.2)),
  ]
  if (band) out.push(...sym(part('barrelBand', box(-gap / 2, y1 + len * 0.3, w * 1.15, w * 0.5), 'accent', 3.1, { noOutline: true })))
  return out
}

const flak = (): Part[] => [
  ring(),
  deck(),
  // A narrow housing rising to the guns, red down its back.
  part('housing', [[-0.3, -0.38], [0.3, -0.38], [0.42, -0.1], [0.42, 0.62], [0.26, 0.78], [-0.26, 0.78], [-0.42, 0.62], [-0.42, -0.1]], 'hull', 1, {
    lift: 0.16,
    facets: [{ pts: [[-0.42, -0.1], [-0.3, -0.38], [-0.18, -0.38], [-0.18, 0.78], [-0.26, 0.78], [-0.42, 0.62]], slope: [-0.5, 0] }],
    details: [{ k: 'shape', pts: box(0, 0.3, 0.16, 0.9), tone: 'accent' }, { k: 'line', pts: [[-0.42, 0.2], [0.42, 0.2]] }],
  }),
  // Tall slim twin barrels.
  ...barrels(0.3, 0.12, -0.32, -1.22),
]

const turbo = (): Part[] => [
  ring(),
  deck(true, 0.3),
  // A broad armoured housing, chamfered at the front, a wide red stripe down its middle.
  part('housing', [[-0.36, -0.42], [0.36, -0.42], [0.62, -0.12], [0.62, 0.5], [0.42, 0.74], [-0.42, 0.74], [-0.62, 0.5], [-0.62, -0.12]], 'hull', 1, {
    lift: 0.18,
    facets: [{ pts: [[-0.62, -0.12], [-0.36, -0.42], [-0.3, -0.42], [-0.3, 0.74], [-0.42, 0.74], [-0.62, 0.5]], slope: [-0.5, 0] }, { pts: [[0.62, -0.12], [0.36, -0.42], [0.3, -0.42], [0.3, 0.74], [0.42, 0.74], [0.62, 0.5]], slope: [0.5, 0] }],
    details: [{ k: 'shape', pts: box(0, 0.24, 0.3, 0.98), tone: 'accent' }, { k: 'line', pts: [[-0.6, 0.28], [-0.18, 0.28]] }, { k: 'line', pts: [[0.18, 0.28], [0.6, 0.28]] }],
  }),
  // Heavier twin barrels, shorter than the flak's.
  ...barrels(0.36, 0.17, -0.38, -1.14),
]

const heavy = (): Part[] => [
  ring(),
  deck(true, 0.34),
  // The capital battery: a great armoured housing with cheek plates either side of the guns, an
  // observation slit across its front, the red stripe down its spine.
  ...sym(part('cheek', [[-0.7, -0.18], [-0.5, -0.5], [-0.38, -0.5], [-0.38, 0.6], [-0.7, 0.42]], 'hull', 1.2, { lift: 0.14, slope: [-0.5, 0] })),
  part('housing', chamfer(0, 0.1, 0.84, 1.24, 0.22), 'hull', 1, {
    lift: 0.22,
    details: [{ k: 'shape', pts: box(0, 0.24, 0.26, 0.98), tone: 'accent' }, { k: 'shape', pts: box(0, -0.3, 0.6, 0.08), tone: 'glass' }, { k: 'line', pts: [[-0.42, 0.4], [0.42, 0.4]] }],
  }),
  ...barrels(0.42, 0.2, -0.44, -1.24, true),
]

const pd = (): Part[] => [
  ring(false),
  deck(false, 0.2),
  // A low U-shaped cradle round short stubby barrels.
  part('housing', [[-0.46, -0.3], [-0.24, -0.3], [-0.24, 0.24], [0.24, 0.24], [0.24, -0.3], [0.46, -0.3], [0.46, 0.5], [0.3, 0.64], [-0.3, 0.64], [-0.46, 0.5]], 'hull', 1, {
    lift: 0.14,
    details: [{ k: 'shape', pts: box(0, 0.44, 0.16, 0.36), tone: 'accent' }],
  }),
  part('breech', box(0, -0.02, 0.44, 0.48), 'dark', 1.5, {}),
  ...barrels(0.22, 0.13, -0.18, -0.82),
]

/** The torpedo launcher: fixed forward on its ring (a missile hardpoint aims with the ship), a boxy
 * armoured rack with four launch tubes in its face, red warhead caps showing in them. */
const torpedo = (): Part[] => [
  ring(false),
  part('rack', chamfer(0, 0.08, 1.3, 1.5, 0.24), 'hull', 1, {
    lift: 0.2,
    facets: [{ pts: [[-0.65, -0.43], [-0.41, -0.67], [-0.36, -0.67], [-0.36, 0.83], [-0.41, 0.83], [-0.65, 0.59]], slope: [-0.5, 0] }],
    details: [
      { k: 'shape', pts: box(0, 0.5, 1.3, 0.16), tone: 'accent' },
      { k: 'shape', pts: box(0, 0.5, 0.2, 0.62), tone: 'accent' },
      { k: 'line', pts: [[-0.64, 0.22], [0.64, 0.22]] },
    ],
  }),
  // The tubes: dark bores with red caps, in two rows across the face.
  part('tubes', chamfer(0, -0.32, 1.02, 0.66, 0.12), 'dark', 2, {
    details: [-0.27, 0.27].flatMap((x): Detail[] => [-0.48, -0.16].map((y): Detail => ({ k: 'shape', pts: circle(x, y, 0.12, 10), tone: 'accent' }))),
  }),
  part('tubeLip', box(0, -0.68, 1.06, 0.1), 'metal', 2.2, {}),
]

const shield = (): Part[] => [
  part('ring', circle(0, 0, 1, 24), 'metal', 0, { lift: 0.1, details: [{ k: 'line', pts: circle(0, 0, 0.9, 22) }] }),
  part('ball', circle(0, 0, 0.86, 26), 'hull', 1, {
    sphere: true,
    details: [
      { k: 'shape', pts: box(0, 0.06, 1.8, 0.24), tone: 'accent' },
      { k: 'shape', pts: box(0, -0.5, 0.26, 0.24), tone: 'dark' },
      { k: 'lights', pts: [[0, -0.5]], r: 0.08, tone: 'glow' },
      { k: 'lights', pts: [[0, 0.56]], r: 0.05, tone: 'glass' },
    ],
  }),
]

/** Each working design, by name. */
const WHOLE: Record<string, () => Part[]> = { flak, turbo, heavy, pd, torpedo, ion: torpedo, shield }

/** A shot-up gun: the housing burnt dark and cracked, a stub or two of barrel bent askew. */
function brokenGun(round: boolean): Part[] {
  return [
    part('base', round ? circle(0, 0, 1) : octagon(0, 0, 1), 'char', 0, { lift: 0.08 }),
    part('housing', rounded(0.04, 0.12, 1.05, 0.95, 0.2), 'dark', 1, { details: [{ k: 'line', pts: [[-0.45, -0.1], [0.05, 0.25], [0.4, 0.05]] }] }),
    part('stub1', turn(box(-0.2, -0.5, 0.17, 0.75), 0.42, -0.2, -0.15), 'metal', 2),
    part('stub2', turn(box(0.24, -0.42, 0.15, 0.42), -0.3, 0.24, -0.2), 'metal', 2),
    embers([[-0.4, 0.4], [0.35, 0.35], [0.05, -0.05], [0.5, -0.2]]),
  ]
}

export function build(design: MountLook, broken: boolean): Part[] {
  switch (design) {
    case 'crater':
      return [
        part('scar', circle(0, 0, 0.95, 11).map(([x, y], i) => [x * (i % 2 ? 0.86 : 1), y * (i % 2 ? 0.86 : 1)] as Pt), 'char', 0, { noOutline: true }),
        part('pit', circle(0.05, 0.05, 0.55, 9), 'dark', 1, { noOutline: true }),
        embers([[-0.3, -0.25], [0.4, 0.1], [-0.1, 0.45], [0.2, -0.45]]),
      ]
    case 'shield':
      if (broken)
        return [
          part('ball', circle(0, 0, 0.92, 22), 'char', 0, { sphere: true, details: [{ k: 'shape', pts: [[-0.6, -0.5], [-0.1, -0.2], [0.2, -0.7], [0.5, -0.1], [0.1, 0.3], [-0.3, 0.1]], tone: 'dark' }] }),
          embers([[-0.2, -0.3], [0.3, -0.35], [0.05, 0.15], [-0.45, 0.25], [0.5, 0.3]]),
        ]
      return shield()
    case 'hangar':
      return [
        part('frame', chamfer(0, 0, 1.8, 1.35, 0.3), broken ? 'char' : 'hull', 0, { lift: 0.08, details: broken ? [] : [{ k: 'shape', pts: box(0, -0.57, 1.2, 0.16), tone: 'accent' }] }),
        part('bay', box(0, 0.08, 1.3, 0.78), 'dark', 1, {
          details: broken ? [{ k: 'line', pts: [[-0.5, -0.2], [0.1, 0.2], [0.5, -0.1]] }] : [{ k: 'line', pts: [[0, -0.3], [0, 0.46]] }, { k: 'lights', pts: [-0.52, -0.26, 0, 0.26, 0.52].map((x) => [x, 0.42] as Pt), r: 0.05, tone: 'glow' }],
        }),
        ...(broken ? [embers([[-0.4, 0.1], [0.3, 0.25], [0.6, -0.4]])] : []),
      ]
    case 'sensor':
      // A targeting array: a dish in a grey ring, its feed horn on struts, a red beacon.
      return [
        part('dish', circle(0, 0, 0.95, 20), broken ? 'char' : 'hull', 0, { lift: 0.1, details: [{ k: 'line', pts: circle(0, 0, 0.66, 16) }, { k: 'shape', pts: box(0, 0.8, 0.4, 0.16), tone: 'accent' }] }),
        part('bowl', circle(0, 0, 0.62, 18), broken ? 'dark' : 'hull2', 1, { slope: [0.4, 0.4] }),
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
        part('pad', box(0, 0.1, 1.5, 1.2), broken ? 'char' : 'dark', 0, { details: broken ? [] : [{ k: 'lights', pts: [[-0.6, 0.6], [0.6, 0.6], [-0.6, -0.4], [0.6, -0.4]], r: 0.06, tone: 'glow' }] }),
        ...sym(part('arm', [[-0.95, -0.85], [-0.6, -0.85], [-0.6, 0.85], [-0.95, 0.65]], broken ? 'dark' : 'hull', 1, { lift: 0.15, slope: [-0.3, 0] })),
        part('crane', box(0, -0.7, 1.3, 0.22), broken ? 'dark' : 'hull2', 2, { lift: 0.2, details: broken ? [] : [{ k: 'shape', pts: box(0, -0.7, 0.3, 0.22), tone: 'accent' }] }),
        ...(broken ? [embers([[0, 0], [0.4, 0.3]])] : []),
      ]
    case 'drill':
      return [
        part('well', circle(0, 0, 0.95, 16), broken ? 'char' : 'dark', 0, {}),
        part('bit', circle(0, 0, 0.55, 8), broken ? 'dark' : 'hull2', 1, { lift: 0.2, details: broken ? [] : [{ k: 'shape', pts: box(0, 0, 0.9, 0.16), tone: 'accent' }] }),
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
    default: {
      // The guns, by name (see WHOLE): flak, turbolaser, and the designs still to come.
      const name: string = design
      if (broken) return brokenGun(name !== 'pd' && name !== 'torpedo' && name !== 'ion')
      return (WHOLE[name] ?? turbo)()
    }
  }
}
