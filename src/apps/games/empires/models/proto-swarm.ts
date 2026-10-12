import { circle, halfHull, part, spline, sym, thick } from './kit.ts'
import { calm, seat, type SeatLook } from './proto.ts'
import type { ModelDef, ModelSpec } from './spec.ts'
import * as classic from './swarm.ts'
import { blobby, eye, thruster, vertebra } from './swarm.ts'
import type { Part, Pt } from './types.ts'

// The Swarm's concept ships as they would be under Big ship sizes (sizes.ts), shown only in the
// Codex: the same organic, insect-like shapes, calmer, with fewer and longer segments, one violet
// band where there were several, and one gun per hardpoint in its own fleshy socket. They stand on
// the droid units' Big layouts (BIG_LAYOUT), as the Classic concepts stand on their hardpoints.

/** Swarm seats: a shell-coloured socket, a heavier bone collar with a violet band. */
const SWARM_SEAT: SeatLook = { pad: 'hull2', heavy: 'hull', band: 'accent' }

/** Trident gunship at 1.15×: the same three-armed star, its surface quietened. */
export const gunship: ModelDef = (c) => calm(classic.gunship(c))

/**
 * Disruptor frigate at 1.4×: a lance of five long armoured vertebrae on a dark cord, its ion
 * projector in a heavy collar on the forward one between the two mandible prongs at the nose, the
 * shield generator and the flak further back, two pairs of short spines that snap off, two engines.
 */
export const ion: ModelDef = (c): ModelSpec => {
  const parts: Part[] = [
    part('cord', [[-3.4, -38], [3.4, -38], [3, 42], [-3, 42]], 'dark', 0),
    ...sym(part('prong', [[-2, -35], [-8.2, -38], [-8.6, -45], [-5.4, -50], [-4.2, -45], [-3, -40]], 'hull2', 1, {
      slope: [-0.45, -0.1],
      lift: 1.2,
      details: [{ k: 'shape', pts: [[-6.6, -40], [-7.6, -44], [-5.6, -47.4], [-5, -45], [-5.6, -41]], tone: 'accent' }],
    })),
    part('focus', [[0, -38], [1.6, -42], [0, -49], [-1.6, -42]], 'glow', 1.1, { glow: true, noOutline: true, details: [{ k: 'lights', pts: [[0, -43]], r: 0.9 }] }),
  ]
  const segs: [number, number, number][] = [[-26, 10.6, 18], [-9, 8.4, 14], [5, 9, 13], [18.5, 8, 13], [31, 7, 11]]
  segs.forEach(([y, w, h], i) => parts.push(...vertebra(`seg${i}`, y, h, w, i % 2 ? 'hull2' : 'hull', 2 + (i % 2) * 0.1, {}, i !== 0)))
  for (const [j, y] of [-2, 25].entries())
    parts.push(...sym(part(`spine${j}`, [[-7.4, y - 1.4], [-11, y + 1.4], [-10.8, y + 3], [-7.4, y + 1.6]], 'dark', 1.5, { detach: { hull: 0.5 - j * 0.14 } }), { detach: { hull: 0.42 - j * 0.14 } }))
  parts.push(
    thruster('podL', -6, 35, 48.6, 5.6, 0, 1.6, { detach: { hull: 0.16 } }),
    thruster('podR', 5.7, 35, 48.6, 5.6, 1, 1.6, { detach: { hull: 0.1 } }),
    seat('collar', c, 0, 7.4, 2.4, true, SWARM_SEAT),
    seat('cup', c, 1, 4.4, 2.4, false, SWARM_SEAT),
    seat('cupAft', c, 2, 3.6, 2.4, false, SWARM_SEAT),
    eye('eye', 0, -37, 2.2, 3),
  )
  return { parts, breakStyle: 'bands' }
}

/**
 * Scarab frigate at 1.4×: a beetle with a broad thorax carrying its twin prong cannons, the shield
 * generator in a socket where the two great shell cases meet, the flak on the shells, one violet band
 * curving down each; a small horned head, short legs under the shell and three engines. Antennae,
 * legs, horns and the outer engines come away as it is battered.
 */
export const frigate: ModelDef = (c): ModelSpec => {
  const elytron = blobby([[-1.3, -12], [-11, -13.6], [-18.6, -5], [-20.8, 8], [-20, 22], [-16, 34], [-8.6, 41], [-1.3, 40.4], [-1.3, 12]], 5)
  const parts: Part[] = [
    ...[0, 22].flatMap((y, j) => sym(part(`leg${j}`, thick([[-14, y], [-20.4, y - 4], [-21, y - 9]], 2.6, 1.4), 'dark', 0.5, { detach: { hull: 0.55 - j * 0.14 } }), { detach: { hull: 0.48 - j * 0.14 } })),
    ...sym(part('antenna', thick([[-3, -47], [-8, -49], [-13, -48]], 1.1, 0.6), 'dark', 0.6, { detach: { hull: 0.62 } }), { detach: { hull: 0.5 } }),
    part('seam', [[-1.6, -13], [1.6, -13], [1.6, 41], [-1.6, 41]], 'dark', 0.8),
    thruster('pod0', -9.1, 36, 48.4, 6.4, 0, 1, { detach: { hull: 0.16 } }),
    thruster('pod1', -0.2, 37, 49.6, 6.4, 1, 1),
    thruster('pod2', 8.4, 36, 48.4, 6.4, 2, 1, { detach: { hull: 0.1 } }),
    ...sym(part('shell', elytron, 'hull', 2, {
      slope: [-0.5, 0.05],
      lift: 2,
      details: [
        { k: 'shape', pts: thick(spline([[-5, -9], [-13.6, -2], [-16.4, 10], [-15.4, 26], [-9, 36]], 4), 2, 1.2), tone: 'accent' },
        { k: 'line', pts: spline([[-2, 30], [-11, 31], [-17, 27]], 3) },
      ],
    }), { slope: [0.5, 0.05] }),
    ...sym(part('thorax', halfHull([[-44, 6], [-40, 11.4], [-32, 14], [-22, 14.8], [-14, 12], [-10, 6]]), 'hull2', 3, {
      slope: [-0.4, -0.2],
      lift: 1.6,
      details: [{ k: 'shape', pts: [[-11.6, -26], [-13.6, -22], [-13.4, -16], [-11.2, -14.4]], tone: 'accent' }, { k: 'line', pts: [[0, -28], [-14.6, -28]] }],
    })),
    ...sym(part('head', halfHull([[-50, 1], [-48, 4], [-44, 6.6], [-42, 6]]), 'hull', 3.5, { slope: [-0.4, -0.3], lift: 1.2 })),
    ...sym(part('horn', [[-3, -46], [-4.4, -51], [-6.2, -50], [-7, -45]], 'hull2', 3.6, { slope: [-0.4, -0.2], lift: 1, detach: { hull: 0.28 } }), { slope: [0.4, -0.2], detach: { hull: 0.2 } }),
    ...sym(seat('collar', c, 0, 3.7, 3.4, true, SWARM_SEAT)),
    seat('cup', c, 2, 4, 3.4, false, SWARM_SEAT),
    ...sym(seat('cupAft', c, 3, 3.1, 2.4, false, SWARM_SEAT)),
    eye('eye', 0, -46, 2, 4),
  ]
  return { parts, breakStyle: 'bands', mount: (i) => ({ detach: i >= 3 }) }
}

/**
 * Manta cruiser at 1.7×: a manta ray. Broad crescent wings, each a heavy leading spar carrying, from
 * the root out, its light gun, its shield generator and its heavy gun, a dark membrane behind it on
 * two ribs; a segmented body with the tractor projector glowing on its head; the wing tips curl back
 * into hooks. The two engines at its tail are shot off with their hardpoints.
 */
export const cruiser: ModelDef = (c): ModelSpec => {
  const H = c.h / 2
  const spar: Pt[] = [[-6, -13.4], [-16, -5.6], [-28.5, -0.6], [-41, 6.4], [-47, 15]]
  const parts: Part[] = [
    ...sym(part('web', [[-8, -6], [-16, 0], [-28, 5], [-40, 12], [-45.6, 18], [-40, 21], [-31, 17.6], [-20, 15.6], [-9, 18]], 'dark', 0, {
      details: [{ k: 'line', pts: [[-12, 6], [-34, 13]] }, { k: 'lights', pts: [[-24, 11], [-36, 15]], r: 0.5, tone: 'glow' }],
    })),
    ...sym(part('rib', thick([[-9, 4], [-22, 9], [-36, 14]], 2.2, 1.4), 'hull2', 0.6, { lift: 0.6 })),
    ...sym(part('trail', thick([[-9, 17], [-22, 15.2], [-33, 17.4], [-43, 20]], 2.8, 1.8), 'hull2', 0.7, { lift: 0.6 })),
    ...sym(part('spar', thick(spline(spar, 4), 11, 6), 'hull', 1, {
      slope: [-0.35, -0.35],
      lift: 2,
      details: [{ k: 'shape', pts: thick(spline([[-9, -14.6], [-17, -9.4], [-28.6, -4.6], [-40.6, 2.4], [-46, 10]], 4), 1.6, 1), tone: 'accent' }],
    }), { slope: [0.35, -0.35] }),
    ...sym(part('hook', thick([[-46.4, 13], [-49.4, 22], [-47.6, 29.6], [-44, H - 0.6]], 4.6, 1.4), 'hull2', 1.2, { lift: 1, detach: { hull: 0.3 } }), { detach: { hull: 0.2 } }),
    thruster('podL', -5.3, 18, H - 0.4, 6.4, 0, 1.4, { detach: { hp: 6 } }),
    thruster('podR', 5.2, 18, H - 0.4, 6.4, 1, 1.4, { detach: { hp: 7 } }),
    ...sym(part('body', halfHull([[-30, 1], [-26, 5.6], [-18, 9], [-8, 10.2], [4, 9.6], [14, 8], [22, 5.6], [28, 3]]), 'hull', 2, {
      slope: [-0.5, 0],
      lift: 1.4,
      details: [{ k: 'line', pts: [[0, -4], [-10, -4]] }, { k: 'shape', pts: [[-3, -2], [-6.6, -2], [-6.4, 10], [-3, 10]], tone: 'accent' }],
    })),
    ...sym(part('head', [[0, -H], [-2.6, -31], [-6.6, -24], [-6.4, -17], [0, -15]], 'hull2', 3, { slope: [-0.45, -0.15], lift: 1.4 })),
    part('tractor', circle(0, -27.6, 2.6, 14), 'glow', 3.2, { glow: true, details: [{ k: 'lights', pts: [[0, -27.6]], r: 1.3 }] }),
    eye('eye', 0, -20.6, 2.6, 3.4),
    ...sym(seat('collar', c, 0, 3.4, 2.4, true, SWARM_SEAT)),
    ...sym(seat('cup', c, 2, 2.8, 2.4, false, SWARM_SEAT)),
    ...sym(seat('cupMid', c, 4, 3.1, 2.4, false, SWARM_SEAT)),
    ...sym(part('fin', [[-1.2, 20], [-3.6, 22], [-2.6, 30], [-1.2, 29]], 'hull2', 2.4, { detach: { hull: 0.45 } }), { detach: { hull: 0.35 } }),
  ]
  return { parts, breakStyle: 'bands', mount: (i) => ({ detach: i === 2 || i === 3 }) }
}

/**
 * Hive carrier at 2.5×: a flying foundry. A spine of five long vertebrae carrying two heavy guns and
 * the shield generators, a beaked head, a swollen abdomen over four engines, and two great curved arms
 * folded forward like a mantis's forelegs, carrying the other two heavy guns at their elbows and the
 * flak along them; between each arm and the spine a hive sac with a hangar in it. The arm tips,
 * antennae and outer engines come away as it is battered.
 */
export const capital: ModelDef = (c): ModelSpec => {
  const bone = spline([[-11, 6], [-22, 7.5], [-28.4, 4.6], [-30.6, -6], [-29.4, -17], [-26.2, -27.6], [-21, -34.4], [-16.9, -37.4], [-11, -44]], 3)
  const parts: Part[] = [
    ...sym(part('sac', blobby([[-14, -33], [-21.6, -30], [-23, -20], [-18, -14], [-11.5, -15], [-10.5, -26]]), 'hull2', 0.8, { lift: 1.4, details: [{ k: 'shape', pts: circle(-16.6, -18.4, 2, 6), tone: 'hull' }, { k: 'shape', pts: circle(-20, -30.4, 1.6, 6), tone: 'hull' }] })),
    ...sym(part('arm', thick(bone, 9.4, 5), 'hull', 1, {
      slope: [-0.4, -0.15],
      lift: 2.4,
      details: [{ k: 'shape', pts: thick(spline([[-24, 10.6], [-32, 4], [-34.4, -8], [-33, -20], [-29.6, -30]], 3), 1.6, 1.2), tone: 'accent' }],
    }), { slope: [0.4, -0.15] }),
    ...sym(part('claw', blobby([[-13, -45.6], [-9.6, -49.6], [-5, -49], [-8.6, -44.2]]), 'hull2', 1.2, { lift: 1.2, detach: { hull: 0.3 } }), { detach: { hull: 0.2 } }),
    thruster('pod0', -9.9, 37, 47.6, 5.6, 0, 1, { detach: { hull: 0.16 } }),
    thruster('pod1', -3.6, 39, 49.8, 5.6, 1, 1),
    thruster('pod2', 3.2, 39, 49.8, 5.6, 2, 1),
    thruster('pod3', 9.7, 37, 47.6, 5.6, 3, 1, { detach: { hull: 0.1 } }),
    ...sym(part('abdomen', halfHull([[22, 9], [27, 14], [32, 16.4], [37, 15.4], [41, 11.4], [44, 5]]), 'hull', 2, {
      slope: [-0.5, 0.1],
      lift: 1.6,
      details: [{ k: 'shape', pts: thick(spline([[-4, 26], [-10, 29], [-13, 34], [-11, 39]], 3), 1.8), tone: 'accent' }],
    })),
    ...sym(part('fin', [[-11, 34], [-17.6, 32], [-19.6, 37], [-13, 39]], 'hull2', 2.2, { detach: { hull: 0.4 } }), { detach: { hull: 0.32 } }),
  ]
  const segs: [number, number, number][] = [[-38, 8, 10], [-26, 10.4, 14], [-10, 12.8, 18], [8, 13, 18], [24, 11, 14]]
  segs.forEach(([y, w, h], i) => parts.push(...vertebra(`seg${i}`, y, h, w, i % 2 ? 'hull2' : 'hull', 3 + (i % 2) * 0.1, {}, i === 1 || i === 4)))
  parts.push(
    ...sym(part('head', [[0, -50], [-3.4, -46.4], [-7, -40], [-6.4, -34], [0, -32.6]], 'hull2', 4, { slope: [-0.45, -0.2], lift: 1.6 })),
    ...sym(part('antenna', thick([[-4, -44], [-8, -48.6], [-12, -49.4]], 1.1, 0.6), 'dark', 4.2, { detach: { hull: 0.6 } }), { detach: { hull: 0.48 } }),
    eye('eye', 0, -41, 2.8, 4.4),
    ...sym(seat('collar', c, 0, 3.3, 3.6, true, SWARM_SEAT)),
    ...sym(seat('collarArm', c, 2, 3.3, 2.6, true, SWARM_SEAT)),
    ...sym(seat('cup', c, 8, 3.5, 3.6, false, SWARM_SEAT)),
    ...sym(seat('cupFore', c, 4, 2.7, 2.6, false, SWARM_SEAT)),
    ...sym(seat('cupArm', c, 6, 2.7, 2.6, false, SWARM_SEAT)),
    ...sym(seat('launchPad', c, 11, 4.6, 1, false, SWARM_SEAT)),
  )
  return { parts, breakStyle: 'bands', cuts: 3 }
}
