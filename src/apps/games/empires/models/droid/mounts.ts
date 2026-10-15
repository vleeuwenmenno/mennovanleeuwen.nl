import { arcBand, box, chamfer, circle, part, rect, rounded, sym, turn } from '../kit.ts'
import type { MountExtras, MountLook } from '../mounts.ts'
import type { Detail, Part, Pt } from '../types.ts'
import { block } from './parts.ts'

// The Confederacy's mounts (refs/confederacy.webp, "Turret designs (modular)"): heavy, exposed,
// intimidating. Every turret is a dark armoured housing on a round rotating base ring banded in
// burnt orange, with near-black barrels and orange capacitor details, and each weapon has a
// silhouette of its own: three long barrels on the triple cannon, two heavy ones on the dual, three
// short ones in an octagonal housing on the flak, a 2x2 block of orange cells on the missile
// turret, a single barrel and a teal sensor light on the point defence, an angled rack on the
// strike launcher. Drawn on a mount of radius 1 with the guns pointing up (negative y), then
// scaled to the hardpoint's size (models/mounts.ts builds and caches them). Each design has a
// broken version: barrels stripped and bent, housing burnt black with embers in the cracks; and a
// burnt socket ('crater') for one blown clean off.
//
// Which design a hardpoint gets: 'turbo' is the dual cannon (the line's general gun), 'flak' the
// flak turret, 'ion' an ion emitter; the extras (a hardpoint's `look` in data/droid.ts) are the
// triple cannon for heavy batteries ('triple'), the missile turret ('missileBox'), the point
// defence ('pd') and the strike launcher ('strike'). The Breaker's ion lance is part of its hull,
// its hardpoint a collar.

/** Every design drawn here, the shared ones and the extras. */
type Look = MountLook | 'triple' | 'missileBox' | 'pd' | 'strike'

/** Ember glints in a broken module's cracks: a part with no body of its own, only its lights. */
const embers = (pts: Pt[]): Part => part('embers', [], 'ember', 9, { glow: true, noOutline: true, details: [{ k: 'lights', pts, r: 0.07, tone: 'ember' }] })

/** The rotating base ring every turret sits on: charcoal, an orange identification arc round
 * its back, a dark seam. */
const ring = (r = 1): Part =>
  part('base', circle(0, 0, r, 22), 'metal', 0, {
    lift: 0.1,
    details: [{ k: 'shape', pts: arcBand(0, 0, r * 0.8, r * 0.92, Math.PI * 0.2, Math.PI * 0.8, 8), tone: 'accent' }, { k: 'line', pts: circle(0, 0, r * 0.7, 16) }],
  })

/** A wrecked turret: its base burnt, the housing cracked, one barrel stub bent. */
const wreck = (housing: Pt[], stub: Pt[]): Part[] => [
  part('base', circle(0, 0, 1, 18), 'char', 0, { lift: 0.08 }),
  part('housing', housing, 'dark', 1, { details: [{ k: 'line', pts: [[-0.45, -0.1], [0.05, 0.25], [0.4, 0.05]] }] }),
  part('stub', stub, 'metal', 2),
  embers([[-0.4, 0.4], [0.35, 0.35], [0.05, -0.05], [0.5, -0.2]]),
]

/** A barrel from y0 forward to y1 (y1 < y0) at x, `w` thick, with a muzzle brake at its tip. */
const barrel = (id: string, x: number, y0: number, y1: number, w: number): Part[] => [
  part(id, rect(x - w / 2, y1, w, y0 - y1), 'dark', 3, { details: [{ k: 'line', pts: [[x, y1 + 0.1], [x, y0 - 0.05]] }] }),
  part(`${id}Muzzle`, rect(x - w * 0.7, y1 - 0.06, w * 1.4, 0.16), 'metal', 3.2),
]

/** Orange capacitor plates on a housing's flanks. */
const caps = (x: number, y: number, h: number): Detail[] => [
  { k: 'shape', pts: rect(-x - 0.07, y - h / 2, 0.14, h), tone: 'accent' },
  { k: 'shape', pts: rect(x - 0.07, y - h / 2, 0.14, h), tone: 'accent' },
]

function draw(design: Look, broken: boolean): Part[] {
  switch (design) {
    case 'crater':
      return [
        part('scar', circle(0, 0, 0.95, 11).map(([x, y], i) => [x * (i % 2 ? 0.86 : 1), y * (i % 2 ? 0.86 : 1)] as Pt), 'char', 0, { noOutline: true }),
        part('pit', circle(0.05, 0.05, 0.55, 9), 'dark', 1, { noOutline: true }),
        embers([[-0.3, -0.25], [0.4, 0.1], [-0.1, 0.45], [0.2, -0.45]]),
      ]
    case 'triple': {
      // A. Triple cannon turret: a squat rounded housing across the base, three long barrels.
      if (broken) return wreck(rounded(0, 0.15, 1.3, 0.95, 0.24), turn(box(-0.3, -0.55, 0.18, 0.8), 0.4, -0.3, -0.15))
      return [
        ring(),
        part('housing', block(0, 0.12, 1.42, 1.08, 0.32, 0.18), 'hull2', 1, {
          lift: 0.16,
          facets: [{ pts: rect(-0.71, -0.42, 0.71, 1.08), slope: [-0.5, 0] }],
          details: [...caps(0.58, 0.2, 0.5), { k: 'shape', pts: rect(-0.3, 0.38, 0.6, 0.2), tone: 'dark' }, { k: 'line', pts: [[-0.7, -0.1], [0.7, -0.1]] }],
        }),
        part('mantlet', rect(-0.5, -0.5, 1, 0.24), 'metal', 2, { lift: 0.06 }),
        ...barrel('barrelL', -0.32, -0.42, -1.12, 0.17),
        ...barrel('barrelC', 0, -0.42, -1.2, 0.19),
        ...barrel('barrelR', 0.32, -0.42, -1.12, 0.17),
      ]
    }
    case 'turbo': {
      // B. Dual cannon turret: a tall angular housing, two heavy barrels.
      if (broken) return wreck(block(0, 0.12, 1.1, 1.1, 0.3), turn(box(-0.22, -0.55, 0.22, 0.85), 0.35, -0.22, -0.1))
      return [
        ring(),
        part('housing', block(0, 0.1, 1.15, 1.2, 0.36, 0.2), 'hull2', 1, {
          lift: 0.16,
          facets: [{ pts: rect(-0.58, -0.5, 0.58, 1.2), slope: [-0.5, 0] }],
          details: [...caps(0.46, 0.25, 0.45), { k: 'shape', pts: box(0, 0.42, 0.42, 0.18), tone: 'dark' }],
        }),
        ...barrel('barrelL', -0.24, -0.45, -1.16, 0.24),
        ...barrel('barrelR', 0.24, -0.45, -1.16, 0.24),
      ]
    }
    case 'flak': {
      // C. Flak turret: an octagonal housing, three short barrels.
      if (broken) return wreck(chamfer(0.05, 0.1, 1.15, 1.1, 0.32), turn(box(-0.25, -0.5, 0.16, 0.5), 0.5, -0.25, -0.3))
      return [
        ring(),
        part('housing', chamfer(0, 0.08, 1.3, 1.3, 0.38), 'hull2', 1, {
          lift: 0.14,
          facets: [{ pts: rect(-0.65, -0.57, 0.65, 1.3), slope: [-0.5, 0] }],
          details: [{ k: 'shape', pts: chamfer(0, 0.08, 0.7, 0.7, 0.2), tone: 'metal' }, { k: 'shape', pts: rect(-0.42, 0.5, 0.84, 0.14), tone: 'accent' }],
        }),
        ...barrel('barrelL', -0.28, -0.45, -0.92, 0.16),
        ...barrel('barrelC', 0, -0.45, -0.98, 0.16),
        ...barrel('barrelR', 0.28, -0.45, -0.92, 0.16),
      ]
    }
    case 'ion':
      // An ion emitter: a round coil housing with a short cyan-glowing focusing barrel.
      if (broken) return wreck(circle(0, 0.1, 0.6, 14), turn(box(0, -0.5, 0.3, 0.6), 0.4, 0, -0.2))
      return [
        ring(),
        part('coil', circle(0, 0.08, 0.68, 18), 'hull2', 1, { lift: 0.14, details: [{ k: 'shape', pts: circle(0, 0.08, 0.5, 16), tone: 'accent' }, { k: 'shape', pts: circle(0, 0.08, 0.36, 14), tone: 'dark' }] }),
        part('barrel', rect(-0.2, -1.05, 0.4, 0.75), 'dark', 2, { details: [{ k: 'lights', pts: [[0, -0.95]], r: 0.12, tone: 'glow' }] }),
      ]
    case 'missileBox': {
      // D. Missile turret: a box launcher with a 2x2 block of orange cells, no barrels.
      if (broken) return wreck(block(0, 0, 1.2, 1.2, 0.2), turn(box(0.3, -0.3, 0.3, 0.3), 0.3, 0.3, -0.3))
      const cell = (x: number, y: number): Detail => ({ k: 'shape', pts: rect(x - 0.2, y - 0.2, 0.4, 0.4), tone: 'accent' })
      return [
        ring(),
        part('housing', block(0, -0.05, 1.36, 1.36, 0.2, 0.14), 'hull2', 1, {
          lift: 0.2,
          facets: [{ pts: rect(-0.68, -0.73, 0.68, 1.36), slope: [-0.5, 0] }],
          details: [{ k: 'shape', pts: rect(-0.56, -0.62, 1.12, 1.12), tone: 'dark' }, cell(-0.26, -0.32), cell(0.26, -0.32), cell(-0.26, 0.2), cell(0.26, 0.2), { k: 'lights', pts: [[-0.26, -0.32], [0.26, -0.32], [-0.26, 0.2], [0.26, 0.2]], r: 0.07, tone: 'trim' }],
        }),
      ]
    }
    case 'pd': {
      // E. Point defence turret: a compact housing, one barrel, a teal sensor light.
      if (broken) return wreck(rounded(0, 0.15, 0.9, 0.9, 0.25), turn(box(0, -0.5, 0.14, 0.6), 0.4, 0, -0.2))
      return [
        ring(0.85),
        part('housing', rounded(0, 0.1, 0.95, 0.95, 0.3), 'hull2', 1, { lift: 0.14, facets: [{ pts: rect(-0.48, -0.38, 0.48, 0.95), slope: [-0.5, 0] }], details: [{ k: 'lights', pts: [[0.28, 0.2]], r: 0.12, tone: 'glass' }] }),
        ...barrel('barrel', 0, -0.35, -1.05, 0.16),
      ]
    }
    case 'strike': {
      // F. Strike launcher: an angled rack of three launch rails on a heavy cradle.
      if (broken) return wreck(block(0, 0.2, 1.2, 0.9, 0.2), turn(box(0, -0.4, 0.3, 0.6), 0.5, 0, -0.2))
      return [
        ring(),
        part('cradle', block(0, 0.3, 1.3, 0.8, 0.2), 'hull2', 1, { lift: 0.12, details: [{ k: 'shape', pts: rect(-0.5, 0.48, 1, 0.14), tone: 'accent' }] }),
        ...[-0.34, 0, 0.34].map((x, i) => part(`rail${i}`, [[x - 0.13, 0.2], [x + 0.13, 0.2], [x + 0.1, -0.95], [x - 0.1, -0.95]], 'dark', 2 + i * 0.01, { lift: 0.1, details: [{ k: 'shape', pts: rect(x - 0.07, -0.9, 0.14, 0.22), tone: 'accent' }] })),
      ]
    }
    case 'shield':
      // A shield generator: a gunmetal dome with an orange band and teal emitters round its waist.
      if (broken)
        return [
          part('ball', circle(0, 0, 0.95, 22), 'char', 0, { sphere: true, details: [{ k: 'shape', pts: [[-0.6, -0.5], [-0.1, -0.2], [0.2, -0.7], [0.5, -0.1], [0.1, 0.3], [-0.3, 0.1]], tone: 'dark' }] }),
          embers([[-0.2, -0.3], [0.3, -0.35], [0.05, 0.15], [-0.45, 0.25], [0.5, 0.3]]),
        ]
      return [
        part('collar', chamfer(0, 0, 2, 2, 0.6), 'metal', 0, { lift: 0.06 }),
        part('ball', circle(0, 0, 0.82, 22), 'hull2', 1, {
          sphere: true,
          details: [
            { k: 'shape', pts: box(0, 0.06, 1.64, 0.2), tone: 'accent' },
            { k: 'lights', pts: [-0.5, -0.17, 0.17, 0.5].map((x) => [x, -0.22] as Pt), r: 0.07, tone: 'glass' },
            { k: 'shape', pts: box(0, -0.52, 0.3, 0.16), tone: 'dark' },
          ],
        }),
      ]
    case 'hangar':
      return [
        part('frame', block(0, 0, 1.8, 1.4, 0.32, 0.2), broken ? 'char' : 'hull', 0, { lift: 0.08, details: broken ? [] : [{ k: 'shape', pts: box(0, -0.58, 1.2, 0.14), tone: 'accent' }] }),
        part('bay', box(0, 0.06, 1.3, 0.8), 'dark', 1, {
          details: broken
            ? [{ k: 'line', pts: [[-0.5, -0.2], [0.1, 0.2], [0.5, -0.1]] }]
            : [
                ...[-0.45, -0.15, 0.15, 0.45].map((x): Detail => ({ k: 'shape', pts: [[x - 0.08, 0.3], [x + 0.04, 0.3], [x + 0.12, 0.44], [x, 0.44]], tone: 'accent' })),
                { k: 'lights', pts: [-0.5, -0.25, 0, 0.25, 0.5].map((x) => [x, -0.24] as Pt), r: 0.05 },
              ],
        }),
        ...(broken ? [embers([[-0.4, 0.1], [0.3, 0.25], [0.6, -0.4]])] : []),
      ]
    case 'sensor':
      return [
        part('dish', circle(0, 0, 0.95, 20), broken ? 'char' : 'hull2', 0, { lift: 0.1, details: [{ k: 'line', pts: circle(0, 0, 0.66, 16) }] }),
        part('bowl', circle(0, 0, 0.62, 18), broken ? 'dark' : 'hull', 1, { slope: [0.4, 0.4] }),
        ...(broken
          ? [embers([[-0.3, 0.2], [0.35, -0.2], [0.1, 0.4]])]
          : [part('feed', circle(0, 0, 0.18, 10), 'dark', 2, { lift: 0.25 }), part('struts', [[-0.03, -0.6], [0.03, -0.6], [0.03, 0], [-0.03, 0]], 'dark', 2, { noOutline: true }), part('beacon', circle(0, 0, 0.08, 6), 'glass', 3, { glow: true, noOutline: true })]),
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
        part('pad', box(0, 0.1, 1.5, 1.2), broken ? 'char' : 'dark', 0, { details: broken ? [] : [{ k: 'lights', pts: [[-0.6, 0.6], [0.6, 0.6], [-0.6, -0.4], [0.6, -0.4]], r: 0.06, tone: 'trim' }] }),
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
      // An expansion module's socket, or the Breaker's ion lance (part of its hull): nothing shows
      // here until it is shot off, and then a torn, burnt stump with embers in it.
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

/** The common designs (see models/mounts.ts). */
export const build = (design: MountLook, broken: boolean): Part[] => draw(design, broken)

/** The Confederacy's own designs, picked by a hardpoint's `look`. */
export const extras: MountExtras = {
  triple: (broken) => draw('triple', broken),
  missileBox: (broken) => draw('missileBox', broken),
  pd: (broken) => draw('pd', broken),
  strike: (broken) => draw('strike', broken),
}
