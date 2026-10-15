import { circle, part, spline, sym, thick, turn } from '../kit.ts'
import type { MountExtras, MountLook } from '../mounts.ts'
import type { Detail, Part, Pt, Tone } from '../types.ts'

// The Swarm's weapon nodes and organs: what sits on a hardpoint, drawn on a mount of radius 1 with
// its business end pointing up (negative y), then scaled to the hardpoint's size (models/mounts.ts
// builds and caches them). Every node is grown, not built: a socket of dark tissue ringed in chitin
// (its clear attachment to the hull), a housing of claws round the weapon organ, and the organ itself
// on top, so a turning node still reads as a turret: base, rotating claw assembly, and a profile of
// its own for each weapon.
//
//   turbo     tendril lance: a long violet crystal spike between two hooked claws
//   flak      acid sprayer: a green acid organ in a cup of claws, its nozzle up
//   ion       spore cannon: a great violet spore bulb held in four chitin claws (the Swarm's spore
//             cannons are missiles drawn on the ion mount; it has no ion guns)
//   hangar    brood chamber: a cluster of violet eggs in an open chitin pod (a parasite pod's look)
//   shield    regen node: a green core in a leaf-shaped claw shell (no Swarm unit grows shields;
//             drawn for completeness)
//   sensor    sensory stalk: a ring of eye bulbs round a great violet eye
//   refinery  digestive organ: a swollen green sac held in chitin ribs
//   dock      regeneration pool / brood cord: a basin of green fluid round a violet core
//   drill     feeding maw: a ring of teeth round a dark gullet
//
// Each has a broken version, its organ burst and charred with acid-green embers in the wound, for a
// node that was shot up but stays on the hull; and a burnt socket ('crater') for one blown clean off.

/** Acid-green embers in a broken node's wounds: a part with no body of its own, only its lights. */
const embers = (pts: Pt[]): Part => part('embers', [], 'ember', 9, { glow: true, noOutline: true, details: [{ k: 'lights', pts, r: 0.07, tone: 'ember' }] })

/** A curved chitin claw, as a tapering band along a smooth curve through `pts`. */
const clawBand = (pts: Pt[], w0: number, w1: number): Pt[] => thick(spline(pts, 4), w0, w1)

/**
 * The socket every node grows from: a disc of dark tissue with a ring of chitin round it, cut by
 * dark joints, so the node's attachment to the hull is plain at any size.
 */
function socket(tone: Tone = 'metal', joints = 6): Part[] {
  return [
    part('socket', circle(0, 0, 1, 22), tone, 0, {
      lift: 0.1,
      details: [
        { k: 'shape', pts: circle(0, 0, 0.62, 20), tone: 'dark' },
        ...Array.from({ length: joints }, (_, i): Detail => ({ k: 'shape', pts: turn(thick([[0, -0.98], [0, -0.78]], 0.12), (i / joints) * Math.PI * 2 + Math.PI / joints), tone: 'dark' })),
      ],
    }),
  ]
}

/** A broken node: its socket charred, a burst organ and a stub of what it carried. */
function wreck(stub: Pt[], spots: Pt[]): Part[] {
  return [
    part('socket', circle(0, 0, 1, 18), 'char', 0, { lift: 0.08, details: [{ k: 'shape', pts: circle(0.05, 0.05, 0.62, 12), tone: 'dark' }] }),
    part('burst', circle(0, 0.08, 0.55, 9).map(([x, y], i) => [x * (i % 2 ? 0.7 : 1.05), y * (i % 2 ? 0.7 : 1.05)] as Pt), 'dark', 1, {
      details: [{ k: 'line', pts: [[-0.35, -0.2], [0, 0.1], [0.3, 0.4]] }],
    }),
    part('stub', stub, 'char', 2, { lift: 0.1 }),
    embers(spots),
  ]
}

export function build(design: MountLook, broken: boolean): Part[] {
  switch (design) {
    case 'crater':
      return [
        part('scar', circle(0, 0, 0.95, 11).map(([x, y], i) => [x * (i % 2 ? 0.84 : 1), y * (i % 2 ? 0.84 : 1)] as Pt), 'char', 0, { noOutline: true }),
        part('pit', circle(0.05, 0.05, 0.55, 9), 'dark', 1, { noOutline: true }),
        embers([[-0.3, -0.25], [0.4, 0.1], [-0.1, 0.45], [0.2, -0.45]]),
      ]

    case 'turbo': {
      // Tendril lance: two hooked claws hold a long violet crystal spike, its root sunk in a violet
      // bulb of tissue.
      if (broken) return wreck(turn(thick([[0, 0], [0, -0.75]], 0.22, 0.08), 0.5), [[-0.4, 0.3], [0.35, 0.35], [0.05, -0.1], [0.5, -0.2]])
      return [
        ...socket('metal'),
        ...sym(part('claw', clawBand([[-0.62, 0.62], [-0.9, 0], [-0.66, -0.66], [-0.24, -1.02]], 0.46, 0.06), 'hull', 1, { lift: 0.14, slope: [-0.4, 0] })),
        part('root', circle(0, 0.18, 0.46, 16), 'accent', 1.5, { sphere: true }),
        part('spike', [[0, -1.25], [0.17, -0.6], [0.15, 0.1], [0, 0.32], [-0.15, 0.1], [-0.17, -0.6]], 'glass', 2, {
          lift: 0.12,
          facets: [{ pts: [[0, -1.25], [0, 0.32], [-0.15, 0.1], [-0.17, -0.6]], slope: [-0.5, 0] }],
          details: [{ k: 'lights', pts: [[0, -0.95], [0, -0.45]], r: 0.06, tone: 'glow' }],
        }),
        part('core', circle(0, 0.2, 0.17, 10), 'glow', 3, { glow: true, noOutline: true, details: [{ k: 'lights', pts: [[0, 0.2]], r: 0.08, tone: 'glass' }] }),
      ]
    }

    case 'flak': {
      // Acid sprayer: a green acid organ cupped in claws, a short nozzle and two vent spines.
      if (broken) return wreck(turn(thick([[0, -0.1], [0, -0.6]], 0.3, 0.18), -0.4), [[-0.5, 0.3], [0.45, 0.4], [0.1, -0.1], [-0.2, 0.6]])
      return [
        ...socket('metal', 5),
        ...sym(part('cup', clawBand([[-0.2, 0.7], [-0.78, 0.38], [-0.82, -0.25], [-0.42, -0.78]], 0.42, 0.1), 'hull', 1, { lift: 0.14, slope: [-0.4, 0] })),
        part('organ', circle(0, 0.05, 0.48, 16, 0.55), 'aid', 1.5, { sphere: true, details: [{ k: 'line', pts: [[-0.3, 0.2], [0, 0.3], [0.3, 0.2]] }] }),
        part('nozzle', [[-0.16, -0.38], [-0.1, -1.02], [0.1, -1.02], [0.16, -0.38]], 'metal', 2, { lift: 0.1, details: [{ k: 'lights', pts: [[0, -0.95]], r: 0.08, tone: 'aid' }] }),
        ...sym(part('vent', clawBand([[-0.24, -0.3], [-0.36, -0.7]], 0.12, 0.04), 'hull2', 2.2)),
      ]
    }

    case 'ion': {
      // Spore cannon: a great violet spore bulb held in four chitin claws curling up round it, its
      // mouth at the top.
      if (broken) return wreck(circle(0, -0.1, 0.32, 8), [[-0.4, 0.4], [0.35, 0.35], [0.05, -0.05], [0.5, -0.2]])
      return [
        ...socket('metal'),
        ...sym(part('clawLow', clawBand([[-0.3, 0.86], [-0.86, 0.5], [-0.98, -0.1]], 0.32, 0.08), 'hull2', 1, { lift: 0.12, slope: [-0.4, 0.2] })),
        part('bulb', circle(0, -0.02, 0.62, 20, 0.7), 'glow', 1.5, {
          sphere: true,
          details: [{ k: 'shape', pts: circle(-0.18, -0.12, 0.16, 8), tone: 'glass' }, { k: 'shape', pts: circle(0.2, 0.15, 0.12, 8), tone: 'glass' }],
        }),
        ...sym(part('clawHigh', clawBand([[-0.5, 0.42], [-0.7, -0.2], [-0.45, -0.7], [-0.16, -0.92]], 0.3, 0.06), 'hull', 2, { lift: 0.16, slope: [-0.4, -0.1] })),
        part('mouth', circle(0, -0.66, 0.16, 10), 'dark', 2.5, { details: [{ k: 'lights', pts: [[0, -0.66]], r: 0.07, tone: 'glass' }] }),
      ]
    }

    case 'shield':
      // Regen node: a green core in a leaf-shaped shell of claws.
      if (broken) return wreck(circle(0, 0, 0.3, 7), [[-0.2, -0.3], [0.3, -0.35], [0.05, 0.15], [-0.45, 0.25]])
      return [
        ...socket('metal'),
        ...sym(part('leaf', clawBand([[0, 0.85], [-0.7, 0.4], [-0.72, -0.3], [0, -0.92]], 0.34, 0.04), 'hull', 1, { lift: 0.14, slope: [-0.4, 0] })),
        part('core', circle(0, 0, 0.42, 16, 0.5), 'aid', 2, { sphere: true, details: [{ k: 'lights', pts: [[0, 0]], r: 0.1, tone: 'aid' }] }),
      ]

    case 'hangar':
      // Brood chamber: an open pod of chitin lips round a cluster of violet eggs, a green slit of
      // tissue at its mouth where the brood slips out.
      return [
        part('pod', circle(0, 0, 1, 20, 0.86), broken ? 'char' : 'metal', 0, { lift: 0.1 }),
        ...(broken
          ? [part('gape', circle(0, 0.05, 0.62, 10), 'dark', 1, { details: [{ k: 'line', pts: [[-0.5, -0.2], [0.1, 0.2], [0.5, -0.1]] }] }), embers([[-0.4, 0.1], [0.3, 0.25], [0.6, -0.3]])]
          : [
              ...sym(part('lip', clawBand([[-0.1, 0.82], [-0.82, 0.42], [-0.9, -0.2], [-0.4, -0.78]], 0.34, 0.08), 'hull', 1, { lift: 0.14, slope: [-0.4, 0] })),
              part('bed', circle(0, 0, 0.62, 16, 0.6), 'dark', 1.2),
              ...([[-0.24, -0.16, 0.25], [0.24, -0.14, 0.24], [0, 0.22, 0.26], [-0.04, -0.4, 0.17]] as [number, number, number][]).map(([x, y, r], i) => part(`egg${i}`, circle(x, y, r, 12), 'glow', 2 + i * 0.01, { sphere: true })),
              part('slit', thick([[-0.3, 0.6], [0.3, 0.6]], 0.08), 'aid', 2.5, { glow: true, noOutline: true }),
            ]),
      ]

    case 'sensor':
      // Sensory stalk: a great violet eye in a ring of pale tissue, smaller eye bulbs round it.
      if (broken) return wreck(circle(0, 0, 0.3, 7), [[-0.3, 0.2], [0.35, -0.2], [0.1, 0.4]])
      return [
        ...socket('metal', 5),
        part('ring', circle(0, 0, 0.7, 18), 'hull', 1, { lift: 0.14, slope: [-0.3, -0.3] }),
        ...[0, 1, 2, 3, 4].map((i) => {
          const a = (i / 5) * Math.PI * 2 - Math.PI / 2
          return part(`bulb${i}`, circle(Math.cos(a) * 0.78, Math.sin(a) * 0.78, 0.17, 10), 'glow', 1.5, { sphere: true })
        }),
        part('eye', circle(0, 0, 0.4, 16), 'glass', 2, { sphere: true, details: [{ k: 'shape', pts: circle(0, 0, 0.12, 8, 0.24), tone: 'dark' }] }),
      ]

    case 'refinery':
      // Digestive organ: a swollen green sac in chitin ribs.
      if (broken) return wreck(thick([[-0.3, 0.2], [0.3, -0.2]], 0.2), [[-0.4, 0.3], [0.45, -0.2]])
      return [
        part('base', circle(0, 0, 1, 18, 0.9), 'metal', 0, { lift: 0.08 }),
        part('sac', circle(0, 0, 0.74, 18, 0.66), 'aid', 1, { sphere: true }),
        ...[-0.42, 0, 0.42].map((x, i) => part(`rib${i}`, clawBand([[x * 0.8, -0.8], [x * 1.25, 0], [x * 0.8, 0.8]], 0.16, 0.16), 'hull', 2, { lift: 0.12 })),
      ]

    case 'dock':
      // Regeneration pool, or a yard's brood cord: a chitin-rimmed basin of green fluid round a
      // glowing violet core, small tendrils over its rim.
      if (broken) return wreck(circle(0, 0, 0.3, 7), [[0, 0], [0.4, 0.3], [-0.3, -0.3]])
      return [
        part('rim', circle(0, 0, 1, 22), 'hull', 0, { lift: 0.14, holes: [circle(0, 0, 0.72, 20)] }),
        part('pool', circle(0, 0, 0.74, 20), 'aid', 0.5, { glow: true, noOutline: true, details: [{ k: 'shape', pts: circle(0.1, 0.12, 0.5, 16), tone: 'aid' }] }),
        part('core', circle(0, 0, 0.28, 14), 'glow', 1.5, { sphere: true }),
        ...[0, 1, 2].map((i) => part(`tendril${i}`, turn(clawBand([[0, -0.95], [0.15, -0.62], [0.02, -0.4]], 0.14, 0.04), (i / 3) * Math.PI * 2), 'metal', 2)),
      ]

    case 'drill':
      // Feeding maw: a dark gullet ringed in teeth.
      return [
        part('lip', circle(0, 0, 0.95, 18), broken ? 'char' : 'metal', 0, { lift: 0.1 }),
        part('gullet', circle(0, 0, 0.6, 14), 'dark', 1, { details: broken ? [] : [{ k: 'shape', pts: circle(0, 0, 0.22, 8), tone: 'aid' }] }),
        ...(broken
          ? [embers([[0, 0], [0.3, -0.3]])]
          : Array.from({ length: 8 }, (_, i) => part(`tooth${i}`, turn([[-0.11, -0.86], [0.11, -0.86], [0, -0.48]], (i / 8) * Math.PI * 2), 'hull', 2, { noOutline: true }))),
      ]

    case 'collar':
      // An expansion module's socket: the module itself is parts of the hull (base.ts), so nothing
      // shows here until it is torn off, and then a ragged stump of tissue with embers in it.
      if (!broken) return []
      return [
        part('stump', circle(0, 0, 0.42, 10).map(([x, y], i) => [x * (i % 2 ? 0.8 : 1), y * (i % 2 ? 0.8 : 1)] as Pt), 'char', 0, { lift: 0.06 }),
        part('pit', circle(0.03, 0.04, 0.24, 9), 'dark', 1, { noOutline: true }),
        embers([[-0.2, -0.12], [0.22, 0.1], [-0.06, 0.24]]),
      ]

    case 'engine':
      return []
  }
}

/**
 * A grown engine sac, for the hulls (craft.ts, warships.ts): a ribbed bladder of tissue tapering to a
 * nozzle at the back (positive y), its bioluminescent green light in the mouth. `x` its middle,
 * from `y0` to `y1`, `w` wide; `engine` the glow it carries.
 */
export function engineSac(id: string, x: number, y0: number, y1: number, w: number, engine: number | undefined, z: number, more: Partial<Part> = {}, ribs = true): Part {
  const h = w / 2
  const L = y1 - y0
  const half = (s: number): Pt[] => spline([[x, y0], [x + s * h * 0.7, y0 + L * 0.12], [x + s * h, y0 + L * 0.45], [x + s * h * 0.8, y0 + L * 0.8], [x + s * h * 0.5, y1]], 3)
  const outline = [...half(-1), ...half(1).reverse()]
  const details: Detail[] = [
    ...(ribs ? [0.32, 0.55].map((k): Detail => ({ k: 'line', pts: [[x - h * 0.92, y0 + L * k], [x, y0 + L * (k + 0.05)], [x + h * 0.92, y0 + L * k]] })) : []),
    { k: 'shape', pts: circle(x, y1 - L * 0.14, h * 0.48, 10, L * 0.12), tone: 'aid' },
  ]
  if (engine !== undefined) details.push({ k: 'lights', pts: [[x, y1 - L * 0.12]], r: h * 0.28, tone: 'aid' })
  return part(id, outline, 'hull2', z, { lift: 0.8, engine, facets: [{ pts: half(-1).concat([[x, y1]]), slope: [-0.5, 0] }], details, ...more })
}

/**
 * The Swarm's own looks (Hardpoint `look` in data/swarm.ts), named so the Codex and the hardpoint
 * list call them what they are. The lance, acid sprayer, spore cannon, brood chamber and regen node
 * are the common designs above under their own names; the bio-turret, the parasite pod and the spine
 * are drawn here; an engine sac on a hardpoint is part of the hull (engineSac), so it draws nothing.
 */
export const extras: MountExtras = {
  lance: (broken) => build('turbo', broken),
  acid: (broken) => build('flak', broken),
  spore: (broken) => build('ion', broken),
  broodSac: (broken) => build('hangar', broken),
  regen: (broken) => build('shield', broken),
  engineSac: () => [],
  // Bio-turret: a green core ringed with spines that spit at strike craft, its spines raked forward.
  bioturret: (broken) => {
    if (broken) return wreck(circle(0, 0, 0.28, 7), [[-0.3, 0.3], [0.3, -0.2], [0.1, 0.45]])
    const spines = [-50, -25, 0, 25, 50].map((d, i) =>
      part(`spine${i}`, turn([[-0.12, -0.35], [0.12, -0.35], [0, -1.05 + Math.abs(d) * 0.004]], (d * Math.PI) / 180), 'hull', 1.2, { slope: [Math.sin((d * Math.PI) / 180) * 0.4, -0.3] }),
    )
    return [
      ...socket('metal', 5),
      ...spines,
      part('ring', circle(0, 0.05, 0.5, 14), 'metal', 1.5, { lift: 0.1 }),
      part('core', circle(0, 0.05, 0.34, 12), 'aid', 2, { sphere: true }),
    ]
  },
  // Parasite pod: a cluster of violet eggs in a chitin cup, ready to launch.
  parasite: (broken) => {
    if (broken) return wreck(circle(0, 0, 0.3, 7), [[-0.3, 0.2], [0.35, -0.2], [0.1, 0.4]])
    return [
      ...socket('metal', 5),
      ...sym(part('cup', clawBand([[-0.2, 0.8], [-0.8, 0.3], [-0.7, -0.5], [-0.3, -0.85]], 0.36, 0.08), 'hull', 1, { lift: 0.14, slope: [-0.4, 0] })),
      ...([[-0.2, -0.1, 0.24], [0.2, -0.05, 0.22], [0, 0.3, 0.24], [0, -0.48, 0.2]] as [number, number, number][]).map(([x, y, r], i) => part(`egg${i}`, circle(x, y, r, 12), 'glow', 2 + i * 0.01, { sphere: true })),
    ]
  },
  // Spine: one long, heavy chitin spike in a ring of claws, for a spinal mount.
  spine: (broken) => {
    if (broken) return wreck(turn(thick([[0, 0], [0, -0.7]], 0.24, 0.1), 0.4), [[-0.3, 0.3], [0.3, 0.2]])
    return [
      ...socket('metal'),
      ...sym(part('claw', clawBand([[-0.6, 0.6], [-0.8, -0.1], [-0.4, -0.7]], 0.34, 0.06), 'hull2', 1, { lift: 0.12, slope: [-0.4, 0] })),
      part('spike', [[0, -1.25], [0.2, -0.4], [0.16, 0.4], [-0.16, 0.4], [-0.2, -0.4]], 'hull', 2, { lift: 0.14, facets: [{ pts: [[0, -1.25], [0, 0.4], [-0.16, 0.4], [-0.2, -0.4]], slope: [-0.5, 0] }] }),
    ]
  },
}
