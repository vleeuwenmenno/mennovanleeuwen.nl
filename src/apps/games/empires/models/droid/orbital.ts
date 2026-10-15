import { ORBITAL_FRAME } from '../../data.ts'
import { along, circle, part, rect, thick } from '../kit.ts'
import type { ModelDef } from '../spec.ts'
import type { Part, Pt } from '../types.ts'
import { across, ambers, antenna, armour, block, cells, mark, recess, seam } from './parts.ts'

// The Bulwark defense station (Galactic conquest): weaponized infrastructure in the Dominion's
// armoured blocks, on the shared defense station frame (ORBITAL_FRAME, frame units round the
// middle). Level 1 is a heavy angular gun hub; level 2 bolts a gun sponson on a girder to its west
// and a block of resource tanks to its east; level 3 rings it all in an armoured frame on four
// girders, with sponsons north and east and a hangar block of missile cells to the south. Each slot
// is an angular sponson; an empty one shows its open port, ringed in amber lights.

/** A charcoal girder from a to b, `w` wide, a seam down its middle and amber lights at its ends. */
const girder = (id: string, a: Pt, b: Pt, w: number, z: number): Part =>
  part(id, thick([a, b], w), 'metal', z, { lift: 1.2, details: [seam(a, b), ambers([a, b], w * 0.12)] })

/** An empty module port: a dark well in an angular collar, amber lights at its corners. */
function port(id: string, [x, y]: Pt, r: number, z: number): Part {
  return part(id, block(x, y, r * 2, r * 2, r * 0.5), 'hull2', z, {
    lift: 0.8,
    details: [
      recess(block(x, y, r * 1.4, r * 1.4, r * 0.32)),
      { k: 'line', pts: circle(x, y, r * 0.42, 12) },
      { k: 'lights', pts: [[x - r * 0.72, y - r * 0.72], [x + r * 0.72, y - r * 0.72], [x + r * 0.72, y + r * 0.72], [x - r * 0.72, y + r * 0.72]], r: r * 0.09, tone: 'trim' },
    ],
  })
}

export const orbital: ModelDef = ({ t, level }) => {
  const S = ORBITAL_FRAME.slots
  const filled = t.orbital?.slots ?? []
  const parts: Part[] = []
  if (level >= 3) {
    // The armoured frame: four walls with cut corners, on girders from the hub's corners.
    const R = 44
    const frame: Pt[] = [[-R + 12, -R], [R - 12, -R], [R, -R + 12], [R, R - 12], [R - 12, R], [-R + 12, R], [-R, R - 12], [-R, -R + 12]]
    parts.push(part('wallFrame', frame, 'metal', 0.8, { lift: 2, holes: [[[-R + 17, -R + 6], [R - 17, -R + 6], [R - 6, -R + 17], [R - 6, R - 17], [R - 17, R - 6], [-R + 17, R - 6], [-R + 6, R - 17], [-R + 6, -R + 17]]], details: [mark(rect(-10, -R, 20, 2)), mark(rect(-10, R - 2, 20, 2))] }))
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4
      parts.push(girder(`girder${i}`, [Math.cos(a) * 18, Math.sin(a) * 18], [Math.cos(a) * 46, Math.sin(a) * 46], 4.4, 0.9))
    }
    parts.push(girder('armN', [0, -18], [0, S[3][1] + 10], 8, 1.1), girder('armE', [18, 0], [S[2][0] - 10, 0], 8, 1.1), girder('armS', [0, 18], [0, 30], 8, 1.1))
    // The hangar block to the south: missile cells over a launch bay.
    parts.push(armour('hangarBlock', 0, 36, 30, 14, 1.8, { tone: 'hull2', cut: 4, lift: 2.4 }), cells('cellsS', 0, 36, 4, 1, 4.2, 2.2))
    parts.push(antenna('mast', [-24, 34], [-32, 44], 2, 2.6, { detach: { hull: 0.4 } }))
  }
  if (level >= 2) {
    parts.push(girder('armW', [-18, 0], [S[1][0] + 10, 0], 8, 1.1))
    if (level === 2) {
      parts.push(girder('armE', [18, 0], [26, 0], 8, 1.1), armour('store', 35, 0, 18, 22, 2, { tone: 'hull2', cut: 4, lift: 2.4 }), cells('tanks', 35, 0, 2, 3, 4, 2.3))
      parts.push(antenna('mast', [26, -12], [32, -24], 2, 2.6, { detach: { hull: 0.4 } }))
    }
  }
  // The hub: a heavy angular block, armour plates on its corners, a reactor ring under its gun.
  if (level === 1) for (const [i, [x, y]] of ([[-17, -17], [17, -17], [-17, 17], [17, 17]] as Pt[]).entries()) parts.push(armour(`block${i}`, x, y, 10, 10, 1.6, { tone: 'hull2', cut: 3, lift: 1.4, band: false }))
  parts.push(armour('hub', 0, 0, 38, 38, 2, { tone: 'hull', cut: 10, lift: 3 }))
  parts.push(part('reactor', circle(0, 0, 12, 24), 'metal', 2.4, { lift: 1.2, details: [{ k: 'shape', pts: circle(0, 0, 10, 22), tone: 'accent' }, { k: 'shape', pts: circle(0, 0, 8, 20), tone: 'dark' }] }))
  parts.push(part('hubTrim', rect(-17, 15, 34, 2.4), 'accent', 2.2, { details: [across(-17, 17, 16)] }))
  parts.push(part('hubLights', [], 'hull', 2.3, { details: [ambers([...along([-13, -15.5], [13, -15.5], 4)], 0.7)] }))
  // Each slot: its gun sponson, and an open port where no module is fitted yet.
  for (let s = 0; s < ORBITAL_FRAME.counts[level - 1]; s++) {
    const [x, y] = S[s]
    if (s > 0) parts.push(armour(`sponson${s}`, x, y, 22, 22, 2.5, { tone: 'hull', cut: 6, lift: 2.6 }))
    if (!filled[s]) parts.push(port(`port${s}`, [x, y], s ? 8.4 : 9, 3))
  }
  return { parts, breakStyle: 'pie' }
}
